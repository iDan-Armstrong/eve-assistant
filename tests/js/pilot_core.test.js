const test = require("node:test");
const assert = require("node:assert");
const P = require("../../web/pilot_core.js");

const STATION = 60003760, SYSTEM = 30000142, CITADEL = 1035466617946, SAFETY = 2004;
const assets = [
  { item_id: 1, location_id: STATION, type_id: 648, quantity: 1 },          // Badger in Jita 4-4
  { item_id: 2, location_id: 1, type_id: 34, quantity: 1000 },               // Tritanium in its hold
  { item_id: 3, location_id: 2000, type_id: 35, quantity: 5 },               // container in container? parent unknown item
  { item_id: 4, location_id: CITADEL, type_id: 34, quantity: 10 },
  { item_id: 5, location_id: 4, type_id: 35, quantity: 2 },
  { item_id: 6, location_id: SYSTEM, type_id: 33475, quantity: 1 },          // deployed in space
  { item_id: 7, location_id: SAFETY, type_id: 34, quantity: 7 },
  { item_id: 8, location_id: STATION, type_id: 999, quantity: 1, is_blueprint_copy: true },
];

test("items roll up through containers to their root place", () => {
  const roots = P.rootLocations(assets);
  assert.equal(roots.get(2), STATION);
  assert.equal(roots.get(5), CITADEL);
  assert.equal(roots.get(6), SYSTEM);
  assert.deepEqual(P.unknownStructures(roots, new Map()), [CITADEL]);
});

test("rollup joins places to systems and values items", () => {
  const roots = P.rootLocations(assets);
  const stations = new Map([[STATION, SYSTEM]]);
  const structures = new Map([[CITADEL, { system: 30002187, name: "Fort" }]]);
  const prices = new Map([[648, 1e6], [34, 4], [35, 10], [999, 5e8]]);
  const { bySystem, unplaced } = P.rollup(assets, roots, stations, structures, prices);
  const jita = bySystem.get(SYSTEM);
  assert.equal(jita.items, 1 + 1000 + 1 + 1);
  assert.equal(jita.value, 1e6 + 4000);                    // the BPC counts as zero
  assert.deepEqual(jita.top[0], [648, 1, 1e6]);
  assert.equal(bySystem.get(30002187).value, 40 + 20);
  assert.equal(unplaced.items, 5 + 7);                     // unknown parent + asset safety
});

test("mining ledger sums per system and ore", () => {
  const m = P.miningBySystem([
    { solar_system_id: 1, type_id: 1230, quantity: 100, date: "2026-10-30" },
    { solar_system_id: 1, type_id: 1230, quantity: 50, date: "2026-11-01" },
    { solar_system_id: 2, type_id: 1228, quantity: 9 }]);
  assert.equal(m.get(1).qty, 150);
  assert.equal(m.get(1).types.get(1230), 150);
  assert.equal(m.get(1).last.get(1230), "2026-11-01");
});
