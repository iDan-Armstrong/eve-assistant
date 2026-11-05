const test = require("node:test");
const assert = require("node:assert");
const S = require("../../web/sell_core.js");

const ord = (type_id, price, volume_remain, location_id, system_id, min_volume = 1) =>
  ({ type_id, price, volume_remain, location_id, system_id, min_volume });

test("paste: list view rows, blank quantity means one, unknown names reported", () => {
  const ids = { "Tritanium": 34, "Pyerite": 35, "Damage Control II": 2048 };
  const text = "Tritanium\t12,500\tMineral\t\t\t125 m3\t62,500.00 ISK\n" +
               "Damage Control II\t\tDamage Control\tModule\tLow\t5 m3\n" +
               "Pyerite\t1 000\tMineral\nMystery Box\t3\n\nTritanium\t500\tMineral";
  const r = S.parseCargoPaste(text, n => ids[n]);
  assert.deepStrictEqual([...r.items], [[34, 13000], [2048, 1], [35, 1000]]);
  assert.deepStrictEqual(r.unknown, ["Mystery Box"]);
});

test("assets: only holds of this ship, nested containers included, fitted modules not", () => {
  const SHIP = 900;
  const assets = [
    { item_id: SHIP, location_id: 60003760, type_id: 648, location_flag: "Hangar", quantity: 1 },
    { item_id: 1, location_id: SHIP, type_id: 34, location_flag: "Cargo", quantity: 100 },
    { item_id: 2, location_id: SHIP, type_id: 2048, location_flag: "LoSlot0", quantity: 1 },
    { item_id: 3, location_id: SHIP, type_id: 3467, location_flag: "Cargo", quantity: 1 },     // container
    { item_id: 4, location_id: 3, type_id: 34, location_flag: "Unlocked", quantity: 50 },
    { item_id: 5, location_id: SHIP, type_id: 1230, location_flag: "SpecializedOreHold", quantity: 7 },
    { item_id: 6, location_id: 60003760, type_id: 34, location_flag: "Hangar", quantity: 9999 },
  ];
  assert.deepStrictEqual([...S.cargoFromAssets(assets, SHIP)].sort((a, b) => a[0] - b[0]),
    [[34, 150], [1230, 7], [3467, 1]]);
});

test("allocate: best price first, volume and minimum volume respected", () => {
  const items = new Map([[34, 100]]);
  const sorted = S.sortOrders([ord(34, 5, 30, 1, 10), ord(34, 6, 50, 2, 20, 60), ord(34, 4, 1000, 3, 30)]);
  const a = S.allocate(items, sorted, null);
  // the 6 ISK order wants at least 60 units but only has 50 left to fill: skipped
  assert.strictEqual(a.byStation.get(2), undefined);
  assert.strictEqual(a.byStation.get(1).lines[0].qty, 30);
  assert.strictEqual(a.byStation.get(3).lines[0].qty, 70);
  assert.strictEqual(a.gross, 30 * 5 + 70 * 4);
  assert.strictEqual(a.left.size, 0);
});

test("plan: a stop worth less than the threshold is folded into the others", () => {
  const items = new Map([[34, 100], [35, 10]]);
  const orders = [
    ord(34, 10, 100, 1, 10),            // big buyer at station 1
    ord(34, 10.5, 2, 2, 20),            // tiny better buyer at station 2 (1 ISK more total)
    ord(35, 100, 10, 1, 10),
  ];
  const p = S.planSale({ items, orders, tax: 0.05, minStop: 50 });
  assert.deepStrictEqual(p.stops.map(s => s.station), [1]);
  assert.strictEqual(p.gross, 100 * 10 + 10 * 100);
  assert.strictEqual(Math.round(p.net), Math.round(2000 * 0.95));
  const keep = S.planSale({ items, orders, tax: 0.05, minStop: 0 });
  assert.deepStrictEqual(keep.stops.map(s => s.station).sort(), [1, 2]);
});

test("plan: unsellable items are left over, and maxStops caps the stops", () => {
  const items = new Map([[34, 3], [99, 4]]);
  const orders = [ord(34, 30, 1, 1, 10), ord(34, 20, 1, 2, 20), ord(34, 10, 1, 3, 30)];
  const p = S.planSale({ items, orders, maxStops: 2 });
  assert.strictEqual(p.stops.length, 2);
  assert.deepStrictEqual([...p.left].sort(), [[34, 1], [99, 4]]);
});

test("order: nearest stop next, drop-off where it adds the fewest jumps", () => {
  const pos = { 10: 0, 20: 5, 30: 2, 30000142: 1, 40: 9 };
  const dist = (a, b) => Math.abs(pos[a] - pos[b]);
  const stops = [{ station: 2, system: 20 }, { station: 3, system: 30 }, { station: S.JITA.station, system: S.JITA.system }];
  // Jita sits on the way to the first stop: no extra jumps there
  const r = S.orderStops(stops, 10, dist, S.JITA);
  assert.deepStrictEqual(r.stops.map(s => s.station), [S.JITA.station, 3, 2]);
  assert.strictEqual(r.jumps, 1 + 1 + 3);
  // Jita beyond the last stop: it goes last
  pos[30000142] = 20;
  const r2 = S.orderStops([{ station: 3, system: 30 }, { station: 4, system: 40 }], 10, dist, S.JITA);
  assert.deepStrictEqual(r2.stops.map(s => s.station), [3, 4, S.JITA.station]);
  assert.strictEqual(r2.jumps, 2 + 7 + 11);
  // no sale at Jita: the drop-off stop is added with no lines
  const r4 = S.orderStops([{ station: 3, system: 30 }], 30, dist, S.JITA);
  assert.deepStrictEqual(r4.stops.map(s => s.station), [3, S.JITA.station]);
  assert.deepStrictEqual(r4.stops[1].lines, []);
});

test("plan: free stations (drop-off, where you are) are kept however small", () => {
  const items = new Map([[34, 10]]);
  const orders = [ord(34, 1, 10, S.JITA.station, S.JITA.system)];
  assert.strictEqual(S.planSale({ items, orders, minStop: 1e6 }).stops.length, 0);
  const p = S.planSale({ items, orders, minStop: 1e6, free: new Set([S.JITA.station]) });
  assert.deepStrictEqual(p.stops.map(s => s.station), [S.JITA.station]);
  assert.strictEqual(p.left.size, 0);
});
