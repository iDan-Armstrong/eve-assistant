const test = require("node:test");
const assert = require("node:assert");
const A = require("../../web/asset_core.js");

const JITA = 60003760, AMARR = 60008494, CIT = 1035466617946;
const cats = { 587: 6, 648: 6, 34: 4, 2046: 7, 3467: 2 };
const catOf = t => cats[t] || 0;

test("stacks: hangar items and container contents; ships, fitted and assembled things left out", () => {
  const assets = [
    { item_id: 1, location_id: JITA, location_flag: "Hangar", type_id: 34, quantity: 1000 },
    { item_id: 2, location_id: JITA, location_flag: "Hangar", type_id: 34, quantity: 500 },
    { item_id: 3, location_id: JITA, location_flag: "Hangar", type_id: 587, quantity: 1, is_singleton: true },  // assembled ship
    { item_id: 4, location_id: 3, location_flag: "LoSlot0", type_id: 2046, quantity: 1, is_singleton: true },  // fitted
    { item_id: 5, location_id: 3, location_flag: "Cargo", type_id: 34, quantity: 99 },                         // in a ship
    { item_id: 6, location_id: AMARR, location_flag: "Hangar", type_id: 3467, quantity: 1, is_singleton: true }, // container
    { item_id: 7, location_id: 6, location_flag: "Unlocked", type_id: 2046, quantity: 3 },
    { item_id: 8, location_id: CIT, location_flag: "Hangar", type_id: 587, quantity: 2 },                      // packaged ships
    { item_id: 9, location_id: AMARR, location_flag: "Deliveries", type_id: 34, quantity: 7 },
    { item_id: 10, location_id: 30000142, location_flag: "AutoFit", type_id: 34, quantity: 1 },              // in space
  ];
  const s = A.stacksFrom(assets, catOf).map(x => [x.loc, x.type_id, x.qty, x.inContainer]);
  assert.deepStrictEqual(s, [[JITA, 34, 1500, false], [AMARR, 2046, 3, true], [CIT, 587, 2, false]]);
});

test("cargo in use: the active ship's holds only", () => {
  const assets = [{ location_id: 900, location_flag: "Cargo", type_id: 34, quantity: 100 },
                  { location_id: 900, location_flag: "SpecializedOreHold", type_id: 34, quantity: 10 },
                  { location_id: 900, location_flag: "HiSlot0", type_id: 2046, quantity: 1 },
                  { location_id: 901, location_flag: "Cargo", type_id: 34, quantity: 5000 }];
  assert.strictEqual(A.cargoUsed(assets, 900, t => (t === 34 ? 0.01 : 5)), 1.1);
});

// systems on a line; jumps = distance
const pos = { 1: 0, 2: 2, 3: 5, 4: 9 };
const dist = (a, b) => (pos[a] === undefined || pos[b] === undefined ? Infinity : Math.abs(pos[a] - pos[b]));
const st = (loc, sys, type_id, qty, vol, value) => ({ loc, sys, type_id, qty, vol, value });

test("sell: most ISK per jump first, best ISK per m3 first, partial stack when full", () => {
  const stacks = [
    st(101, 2, 34, 1000, 1, 10),        // 10,000 ISK in 1,000 m3
    st(101, 2, 35, 10, 10, 1000),       // 10,000 ISK in 100 m3: taken first
    st(102, 3, 36, 5, 10, 100000),      // 500,000 ISK in 50 m3, 5 jumps
    st(103, 4, 37, 1, 1, 5),            // worth 5: under minStop
    st(104, 9, 38, 1, 1, 1e9),          // unreachable
  ];
  const p = A.planPickups(stacks, { mode: "sell", capacity: 600, origin: 1, dist, minStop: 100 });
  assert.deepStrictEqual(p.stops.map(s => s.loc), [102, 101]);
  assert.deepStrictEqual(p.stops[1].take.map(t => [t.type_id, t.qty]), [[35, 10], [34, 450]]);
  assert.strictEqual(p.m3, 600);
  assert.strictEqual(p.value, 500000 + 10000 + 4500);
  assert.deepStrictEqual([...p.carried], [[36, 5], [35, 10], [34, 450]]);
  assert.strictEqual(p.jumps, 5 + 3);
});

test("consolidate: clears the most stacks per jump, skips the destination, ends with a drop", () => {
  const stacks = [
    st(101, 2, 34, 10, 1, 0), st(101, 2, 35, 10, 1, 0), st(101, 2, 36, 10, 1, 0),   // 3 small stacks, 2 jumps
    st(102, 3, 37, 1, 500, 0),                                                         // one huge stack
    st(103, 4, 38, 1, 1, 0),                                                           // one tiny stack, far
    st(900, 1, 39, 99, 1, 0),                                                          // already at the destination
  ];
  const p = A.planPickups(stacks, { mode: "consolidate", capacity: 100, origin: 1, dist, dest: { loc: 900, sys: 1 } });
  assert.deepStrictEqual(p.stops.map(s => [s.kind, s.loc]), [["pickup", 101], ["pickup", 103], ["drop", 900]]);
  assert.deepStrictEqual(p.stops[2].take.map(t => t.type_id).sort(), [34, 35, 36, 38]);
  assert.strictEqual(p.stops[2].jumps, 9);
  assert.strictEqual(p.stacksLeft, 1);                       // the 500 m3 stack does not fit
  assert.deepStrictEqual(A.suggestDest([st(1, 1, 34, 10, 1, 5), st(2, 2, 34, 1, 1, 5), st(1, 1, 35, 1, 1, 1)]).loc, 1);
});
