const test = require("node:test");
const assert = require("node:assert");
const B = require("../../web/bpo_core.js");

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
  avg: { 691: 1_250_000, 692: 400_000, 2047: 2_000_000 },
};
const jumpsTo = { 1: 3, 3: 7 };
const jumps = sys => jumpsTo[sys];

test("owned originals: blueprints that are not copies", () => {
  const assets = [{ type_id: 691 }, { type_id: 692, is_blueprint_copy: true }, { type_id: 34 }, { type_id: 2047, is_blueprint_copy: false }];
  assert.deepStrictEqual([...B.ownedOriginals(assets, t => !!bps[t])].sort((a, b) => a - b), [691, 2047]);
});

test("rows: owned left out, cheapest seller within reach, price against average", () => {
  const rows = B.buildRows(bps, index, new Set([2047]), jumps);
  assert.deepStrictEqual(rows.map(r => r.tid).sort(), [3000, 691, 692]);
  const rifter = rows.find(r => r.tid === 691);
  assert.deepStrictEqual(rifter.best, [60000001, 1, 1_000_000, 1]);
  assert.strictEqual(rifter.jumps, 3);
  assert.strictEqual(Math.round(rifter.vsAvg), -20);
  assert.deepStrictEqual(rifter.anywhere, [60000002, 2, 900_000, 1]);
  const rare = rows.find(r => r.tid === 3000);
  assert.strictEqual(rare.best, null);
  assert.strictEqual(rare.vsAvg, null);
});

test("filters: kind, group, name words, reach, below and above average", () => {
  const rows = B.buildRows(bps, index, new Set(), jumps);
  const ids = f => B.filterRows(rows, f).map(r => r.tid).sort();
  assert.deepStrictEqual(ids({ cat: "6" }), [691, 692]);
  assert.deepStrictEqual(ids({ group: "60" }), [2047]);
  assert.deepStrictEqual(ids({ text: "control blue" }), [2047]);
  assert.deepStrictEqual(ids({ inReach: true }), [2047, 691, 692]);
  assert.deepStrictEqual(ids({ mode: "below", pct: 10 }), [691]);                 // 20% under
  assert.deepStrictEqual(ids({ mode: "above", pct: 0 }), [2047, 691]);            // at or under average
  assert.deepStrictEqual(ids({ mode: "above", pct: 30 }), [2047, 691, 692]);      // Slasher is 25% over
  assert.deepStrictEqual(B.sortRows(B.filterRows(rows, { inReach: true }), "deal").map(r => r.tid), [691, 2047, 692]);
});

test("purchase: cheapest live NPC seller within reach per blueprint, grouped by station", () => {
  const o = (type_id, price, location_id, system_id, extra = {}) =>
    ({ type_id, price, location_id, system_id, volume_remain: 1, min_volume: 1, ...extra });
  const orders = [
    o(691, 990_000, 60000001, 1),
    o(691, 800_000, 60000002, 2),                   // out of reach
    o(691, 700_000, 1_000_000_000_001, 1),         // player station
    o(692, 450_000, 60000001, 1),
    o(692, 450_000, 60000003, 3),                   // same price, farther
    o(2047, 1_900_000, 60000003, 3, { min_volume: 2 }),
  ];
  const p = B.pickPurchases([691, 692, 2047], orders, jumps);
  assert.deepStrictEqual(p.stops.map(s => [s.station, s.lines.map(l => l.type_id)]), [[60000001, [691, 692]]]);
  assert.deepStrictEqual(p.missing, [2047]);
  assert.strictEqual(p.total, 1_440_000);
});
