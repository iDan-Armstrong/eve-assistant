import test from "node:test";
import assert from "node:assert";
import { diffLedger, mergeSightings, prune, reserveRows } from "../../worker/sightings_core.js";

const ledger = [
  { date: "2026-11-03", solar_system_id: 30002509, type_id: 92568, quantity: 1000 },   // Kangite, Odatrik
  { date: "2026-11-03", solar_system_id: 30000142, type_id: 1230, quantity: 50 },      // Veldspar: ignored
  { date: "2026-10-26", solar_system_id: 30002055, type_id: 92568, quantity: 400 },
];

test("only reserve ores are kept", () => {
  assert.deepEqual(reserveRows(ledger).map(r => r.system), [30002509, 30002055]);
});

test("first read sets a baseline; growth later marks active", () => {
  const rows = reserveRows(ledger);
  const first = diffLedger(null, rows);
  assert.equal(first.grew.length, 0);
  const later = rows.map(r => r.system === 30002509 ? { ...r, qty: 1500 } : r);
  const second = diffLedger(first.snapshot, later);
  assert.deepEqual(second.grew, [{ system: 30002509, ore: 92568, date: "2026-11-03" }]);
  const third = diffLedger(second.snapshot, later);
  assert.equal(third.grew.length, 0);                      // no change, not active
});

test("merge records confirmation dates and today's activity only", () => {
  const rows = reserveRows(ledger);
  const grew = [{ system: 30002509, ore: 92568, date: "2026-11-03" },
                { system: 30002055, ore: 92568, date: "2026-10-26" }];
  const out = mergeSightings({}, rows, grew, "2026-11-03T22:00:00Z", "2026-11-03");
  assert.equal(out[30002509].lastActive, "2026-11-03T22:00:00Z");
  assert.equal(out[30002509].lastConfirmed, "2026-11-03");
  assert.equal(out[30002055].lastActive, undefined);       // old growth is not "now"
  assert.equal(out[30002055].lastConfirmed, "2026-10-26");
});

test("prune forgets sightings older than the window", () => {
  const out = prune({ 1: { lastConfirmed: "2026-09-01" }, 2: { lastConfirmed: "2026-11-01" } }, "2026-11-03");
  assert.deepEqual(Object.keys(out), ["2"]);
});
