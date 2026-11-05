const test = require("node:test");
const assert = require("node:assert");
const B = require("../../web/bpo_core.js");

const CIT = 1035466617946, CIT2 = 1035466617947;
const bps = {
  691: ["Rifter Blueprint", 587, 6, 25],
  692: ["Slasher Blueprint", 585, 6, 25],
  2047: ["Damage Control I Blueprint", 2046, 7, 60],
  3000: ["Rare Blueprint", 2999, 7, 61],
};
const index = {
  sell: {
    691: [[60000001, 1, 1_000_000, 1], [60000002, 2, 900_000, 1]],      // cheaper one is out of reach
    692: [[60000003, 3, 500_000, 2]],
    2047: [[60000001, 1, 2_000_000, 5]],
  },
  st: {
    692: [[CIT, 1, 450_000, 1], [CIT2, 1, 100_000, 1]],                  // CIT2: no docking access
  },
  ct: {
    2047: [[555, 60000003, 3, 1_500_000, 10, 20], [556, CIT2, 0, 10, 0, 0]],
    3000: [[557, CIT, 0, 70_000_000, 8, 16]],                           // system learned from the access check
  },
  avg: { 691: 1_250_000, 692: 400_000, 2047: 2_000_000 },
};
const jumpsTo = { 1: 3, 3: 7, 9: 12 };
const jumps = sys => jumpsTo[sys];
const access = id => B.isNpcStation(id) || id === CIT;
const sysOf = id => (id === CIT ? 9 : 0);

test("owned originals: blueprints that are not copies", () => {
  const assets = [{ type_id: 691 }, { type_id: 692, is_blueprint_copy: true }, { type_id: 34 }, { type_id: 2047, is_blueprint_copy: false }];
  assert.deepStrictEqual([...B.ownedOriginals(assets, t => !!bps[t])].sort((a, b) => a - b), [691, 2047]);
});

test("player stations to ask about: structure sellers and contracts in structures", () => {
  assert.deepStrictEqual(B.structuresIn(index).sort(), [CIT, CIT2].sort());
});

test("offers: NPC market, docked player stations and contracts; refused stations left out", () => {
  const o = B.offersFor("692", index, access, sysOf);
  assert.deepStrictEqual(o.map(x => [x.kind, x.loc, x.price]), [["npc", 60000003, 500_000], ["player", CIT, 450_000]]);
  const c = B.offersFor("3000", index, access, sysOf);
  assert.deepStrictEqual(c, [{ kind: "contract", cid: 557, loc: CIT, sys: 9, price: 70_000_000, me: 8, te: 16 }]);
});

test("rows: owned left out, cheapest usable offer within reach, price against average", () => {
  const rows = B.buildRows(bps, index, new Set([691]), jumps, access, sysOf);
  assert.deepStrictEqual(rows.map(r => r.tid).sort(), [2047, 3000, 692]);
  const slasher = rows.find(r => r.tid === 692);
  assert.strictEqual(slasher.best.kind, "player");
  assert.strictEqual(slasher.best.price, 450_000);
  assert.strictEqual(Math.round(slasher.vsAvg), 13);
  const dc = rows.find(r => r.tid === 2047);
  assert.deepStrictEqual([dc.best.kind, dc.best.cid, dc.best.me, dc.jumps], ["contract", 555, 10, 7]);
  assert.strictEqual(Math.round(dc.vsAvg), -25);
  const npcOnly = B.buildRows(bps, index, new Set(), jumps);
  assert.strictEqual(npcOnly.find(r => r.tid === 692).best.kind, "npc");
  assert.strictEqual(npcOnly.find(r => r.tid === 3000).best, null);
});

test("filters: kind, group, name words, reach, below and above average", () => {
  const rows = B.buildRows(bps, index, new Set(), jumps, access, sysOf);
  const ids = f => B.filterRows(rows, f).map(r => r.tid).sort();
  assert.deepStrictEqual(ids({ cat: "6" }), [691, 692]);
  assert.deepStrictEqual(ids({ group: "60" }), [2047]);
  assert.deepStrictEqual(ids({ text: "control blue" }), [2047]);
  assert.deepStrictEqual(ids({ inReach: true }), [2047, 3000, 691, 692]);
  assert.deepStrictEqual(ids({ mode: "below", pct: 20 }), [2047]);              // 25% under
  assert.deepStrictEqual(ids({ mode: "above", pct: 0 }), [2047, 691]);           // at or under average
  assert.deepStrictEqual(ids({ mode: "above", pct: 15 }), [2047, 691, 692]);     // Slasher 12.5% over
  assert.deepStrictEqual(B.sortRows(B.filterRows(rows, { mode: "above", pct: 15 }), "deal").map(r => r.tid), [2047, 691, 692]);
});

test("purchase: cheapest offer of any kind within reach, grouped by station", () => {
  const o = (type_id, price, location_id, system_id, extra = {}) =>
    ({ type_id, price, location_id, system_id, volume_remain: 1, min_volume: 1, ...extra });
  const live = [
    o(691, 990_000, 60000001, 1),
    o(691, 800_000, 60000002, 2),                   // out of reach
    o(692, 450_000, 60000001, 1),
    o(2047, 1_900_000, 60000003, 3, { min_volume: 2 }),
  ];
  const offers = [...B.npcOffers(live),
    ...B.offersFor("692", index, access, sysOf).map(x => ({ ...x, type_id: 692 })),
    ...B.offersFor("2047", index, access, sysOf).map(x => ({ ...x, type_id: 2047 }))];
  const p = B.pickPurchases([691, 692, 2047, 3000], offers, jumps);
  assert.deepStrictEqual(p.stops.map(s => [s.station, s.lines.map(l => [l.type_id, l.kind])]),
    [[60000001, [[691, "npc"], [692, "npc"]]], [60000003, [[2047, "contract"]]]]);
  assert.strictEqual(p.stops[1].lines[0].cid, 555);
  assert.deepStrictEqual(p.missing, [3000]);
  assert.strictEqual(p.total, 990_000 + 450_000 + 1_500_000);
});

test("research: minimum ME/TE drops weaker offers; a researched alternative is offered", () => {
  const rows = B.buildRows(bps, index, new Set(), jumps, access, sysOf);
  const dc = rows.find(r => r.tid === 2047);
  assert.strictEqual(dc.best.cid, 555);                     // already researched: no alternative
  assert.strictEqual(dc.alt, null);
  const idx2 = { ...index, ct: { ...index.ct, 691: [[600, 60000001, 1, 3_000_000, 10, 20]] } };
  const rifter = B.buildRows(bps, idx2, new Set(), jumps, access, sysOf).find(r => r.tid === 691);
  assert.deepStrictEqual([rifter.best.kind, rifter.alt.cid], ["npc", 600]);
  const min = B.buildRows(bps, idx2, new Set(), jumps, access, sysOf, { minMe: 5 });
  assert.deepStrictEqual(min.find(r => r.tid === 691).best.cid, 600);
  assert.strictEqual(min.find(r => r.tid === 692).best, null);   // only unresearched market offers
  assert.strictEqual(B.researched({ me: 10, te: 18 }, { minMe: 10, minTe: 20 }), false);
  assert.deepStrictEqual(B.sortRows(min.filter(r => r.best), "me").map(r => r.tid), [2047, 691, 3000]);
});
