const test = require("node:test");
const assert = require("node:assert");
const C = require("../../web/contract_core.js");

const NOW = Date.parse("2026-11-05T12:00:00Z");
const LATER = "2026-11-08T12:00:00Z", GONE = "2026-11-05T11:00:00Z";
const CIT = 1035466617946, CIT2 = 1035466617947;
// a line of systems 1..9; system 7 is lowsec (no highsec path through it)
const pos = { 1: 0, 2: 2, 3: 4, 4: 6, 5: 8, 9: 12 };
const ctx = {
  jumpsFrom: sys => (pos[sys] !== undefined && pos[sys] <= 8 ? pos[sys] : undefined),
  path: (a, b) => (pos[a] === undefined || pos[b] === undefined ? Infinity : Math.abs(pos[a] - pos[b])),
  access: loc => (loc === CIT ? true : loc === CIT2 ? false : null),
  sysOf: loc => ({ [CIT]: 3, 60003760: 1, 60008494: 5 }[loc] || 0),
};

test("couriers: ranked by reward per jump including the trip to the pickup", () => {
  const rows = [
    [1, 60000001, 1, 60000005, 5, 8e6, 1e8, 10000, 3, LATER],      // 0 + 8 jumps: 1M a jump
    [2, 60000002, 2, 60000003, 3, 4e6, 5e7, 5000, 3, LATER],       // 2 + 2 jumps: 1M a jump, less reward
    [3, 60000003, 3, CIT, 0, 9e6, 1e7, 900, 1, LATER],             // 4 + 0: 2.25M a jump, sys from access check
    [4, 60000001, 1, CIT2, 3, 9e9, 0, 1, 1, LATER],                // refused at the drop-off
    [5, 60000009, 9, 60000001, 1, 9e9, 0, 1, 1, LATER],            // pickup out of reach
    [6, 60000001, 1, 60000002, 2, 9e9, 0, 1, 1, GONE],             // expired
    [7, 60000001, 1, 60000099, 0, 9e9, 0, 1, 1, LATER],            // drop-off not placed
    [8, 60000001, 1, 60000002, 2, 9e9, 0, 400000, 1, LATER],       // too big
  ];
  const r = C.rankCouriers(rows, ctx, { maxVolume: 60000 }, NOW);
  assert.deepStrictEqual(r.map(c => c.cid), [3, 1, 2]);
  assert.deepStrictEqual([r[0].toPickup, r[0].haul, r[0].to.sys, r[0].to.access], [4, 0, 3, true]);
  assert.deepStrictEqual(C.rankCouriers(rows, ctx, { maxVolume: 60000, maxCollateral: 6e7 }, NOW).map(c => c.cid), [3, 2]);
});

test("deals: profit after the pilot's tax, budget and sort", () => {
  const rows = [
    [11, 60000002, 2, 3e6, 5e6, 60003760, 10000, 2, [[34, 1e6]], 0, LATER],     // profit 2e6 - tax
    [12, 60000003, 3, 1e7, 1.5e7, 60008494, 500, 5, [[35, 10]], 3, LATER],    // bigger profit, farther
    [13, CIT2, 3, 1e6, 9e6, 60003760, 1, 1, [], 0, LATER],                     // refused station
    [14, 60000002, 2, 1e6, 9e6, 60003760, 1, 1, [], 0, GONE],
  ];
  const r = C.rankDeals(rows, ctx, { tax: 0.05 }, NOW);
  assert.deepStrictEqual(r.map(d => d.cid), [12, 11]);
  assert.strictEqual(r[0].profit, 1.5e7 * 0.95 - 1e7);
  assert.deepStrictEqual([r[0].toPickup, r[0].toHub], [4, 4]);
  assert.deepStrictEqual(C.rankDeals(rows, ctx, { tax: 0.05, sort: "margin" }, NOW).map(d => d.cid), [11, 12]);
  assert.deepStrictEqual(C.rankDeals(rows, ctx, { tax: 0.05, budget: 5e6 }, NOW).map(d => d.cid), [11]);
  assert.deepStrictEqual(C.rankDeals(rows, ctx, { tax: 0.05, minProfit: 2e6 }, NOW).map(d => d.cid), [12]);
});

test("time left", () => {
  assert.strictEqual(C.timeLeft(LATER, NOW), "3d 0h");
  assert.strictEqual(C.timeLeft("2026-11-05T17:30:00Z", NOW), "5h");
  assert.strictEqual(C.timeLeft(GONE, NOW), "0m");
});
