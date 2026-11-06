import test from "node:test";
import assert from "node:assert";
import * as O from "../../worker/org_core.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const D = O.DAY;
const ME = { id: 1, name: "Varg Soth" }, A = { id: 2, name: "Admin Two" }, B = { id: 3, name: "Admin Three" }, M = { id: 4, name: "Member Four" };

function org() {
  const o = O.newOrg({ id: "x1", name: "Wormhole Wanderers", creator: ME, now: T0 });
  for (const p of [A, B, M]) O.join(o, p, T0);
  for (const p of [A, B, M]) O.adminAction(o, ME, "approve", p.id, T0);
  O.adminAction(o, ME, "promote", A.id, T0);
  O.adminAction(o, ME, "promote", B.id, T0);
  return o;
}

test("create: the creator is admin and Master Admin; bad names refused", () => {
  const o = O.newOrg({ id: "x1", name: "Wormhole Wanderers", creator: ME, now: T0 });
  assert.strictEqual(O.roleOf(o, 1), "admin");
  assert.ok(O.isMaster(o, 1));
  assert.throws(() => O.newOrg({ id: "x2", name: "<script>", creator: ME, now: T0 }));
  assert.throws(() => O.newOrg({ id: "x2", name: "ab", creator: ME, now: T0 }));
});

test("join is pending until approved; admins approve, promote and boot members", () => {
  const o = O.newOrg({ id: "x1", name: "Wanderers", creator: ME, now: T0 });
  assert.strictEqual(O.join(o, M, T0), "pending");
  assert.strictEqual(O.touch(o, M.id, null, T0), false);               // pending pilots get nothing
  assert.throws(() => O.adminAction(o, M, "approve", M.id, T0), /Admins only/);
  O.adminAction(o, ME, "approve", M.id, T0);
  assert.strictEqual(O.roleOf(o, M.id), "member");
  O.adminAction(o, ME, "promote", M.id, T0);
  assert.strictEqual(O.roleOf(o, M.id), "admin");
});

test("only the Master Admin demotes or boots admins, changes passwords, passes Master Admin on", () => {
  const o = org();
  assert.throws(() => O.adminAction(o, A, "demote", B.id, T0), /Only the Master Admin/);
  assert.throws(() => O.adminAction(o, A, "boot", B.id, T0), /Only the Master Admin boots admins/);
  assert.throws(() => O.adminAction(o, A, "passwords", null, T0), /Only the Master Admin/);
  assert.strictEqual(O.adminAction(o, A, "boot", M.id, T0), "removed");    // admins boot members
  assert.throws(() => O.adminAction(o, A, "boot", ME.id, T0), /cannot be booted/);
  O.adminAction(o, ME, "demote", B.id, T0);
  assert.strictEqual(O.roleOf(o, B.id), "member");
  assert.throws(() => O.adminAction(o, ME, "master", B.id, T0), /admin first/);
  O.adminAction(o, ME, "master", A.id, T0);
  assert.ok(O.isMaster(o, A.id));
  assert.ok(!O.isMaster(o, ME.id));
  assert.strictEqual(O.roleOf(o, ME.id), "admin");                          // the old master stays admin
  assert.throws(() => O.leave(o, A.id, T0), /Pass Master Admin/);
});

test("Master Admin quiet 30 days: most active admin holds it; master returns; or it becomes permanent", () => {
  const o = org();
  // A is busier than B over the month
  for (let d = 1; d <= 20; d++) O.touch(o, A.id, null, T0 + d * D);
  for (let d = 1; d <= 5; d++) O.touch(o, B.id, null, T0 + d * D);
  assert.strictEqual(O.settleMaster(o, T0 + 29 * D), false);
  assert.strictEqual(O.settleMaster(o, T0 + 31 * D), true);
  assert.deepStrictEqual(o.temp, { id: A.id, since: T0 + 31 * D });
  assert.ok(O.isMaster(o, A.id));
  assert.strictEqual(O.adminAction(o, A, "demote", B.id, T0 + 32 * D), "demoted");   // temp has the powers

  // the master logs back in: holds it again at once
  O.touch(o, ME.id, null, T0 + 40 * D);
  O.settleMaster(o, T0 + 40 * D);
  assert.strictEqual(o.temp, null);
  assert.ok(O.isMaster(o, ME.id));

  // goes quiet again; temp for 30 more days without the master: permanent
  for (let d = 41; d <= 75; d++) O.touch(o, A.id, null, T0 + d * D);
  O.settleMaster(o, T0 + 71 * D);
  assert.strictEqual(o.temp.id, A.id);
  O.settleMaster(o, T0 + 101 * D);
  assert.strictEqual(o.master, A.id);
  assert.strictEqual(o.temp, null);
  assert.ok(O.isMaster(o, A.id));
});

test("no active admin: nobody takes over", () => {
  const o = org();
  assert.strictEqual(O.settleMaster(o, T0 + 45 * D), false);     // approval is not activity: no admin was active
  assert.strictEqual(o.temp, null);
  const o2 = O.newOrg({ id: "x3", name: "Quiet Org", creator: ME, now: T0 });
  O.join(o2, A, T0); O.adminAction(o2, ME, "approve", A.id, T0); O.adminAction(o2, ME, "promote", A.id, T0);
  assert.strictEqual(O.settleMaster(o2, T0 + 45 * D), false);
  assert.strictEqual(o2.temp, null);
});

test("operator: reset, appoint any member Master Admin, remove even the Master Admin", () => {
  const o = org();
  const op = { id: 999, name: "Varg Soth" };
  assert.strictEqual(O.adminAction(o, op, "passwords", null, T0, { operator: true }), "passwords");
  O.adminAction(o, op, "master", M.id, T0, { operator: true });
  assert.ok(O.isMaster(o, M.id));
  assert.strictEqual(O.roleOf(o, M.id), "admin");
  O.adminAction(o, op, "boot", M.id, T0, { operator: true });
  assert.strictEqual(O.roleOf(o, M.id), null);
  assert.ok(O.isAdmin(o, O.effectiveMaster(o)));                   // another admin inherits
});

test("password tries: five an hour", () => {
  const o = org();
  for (let i = 0; i < 5; i++) O.noteTry(o, 7, false, T0 + i);
  assert.ok(O.tooManyTries(o, 7, T0 + 10));
  assert.ok(!O.tooManyTries(o, 7, T0 + 3601e3));
  O.noteTry(o, 7, true, T0 + 20);
  assert.ok(!O.tooManyTries(o, 7, T0 + 30));
});

test("activity marks: at most one per 10 minutes, last 30 days only", () => {
  const o = org();
  const before = O.activity(o.members[A.id], T0);
  O.touch(o, A.id, null, T0 + 60e3);
  O.touch(o, A.id, null, T0 + 5 * 60e3);                          // within 10 minutes: no new mark
  assert.strictEqual(O.activity(o.members[A.id], T0 + 5 * 60e3), before + 1);
  O.touch(o, A.id, null, T0 + 11 * 60e3);
  assert.strictEqual(O.activity(o.members[A.id], T0 + 11 * 60e3), before + 2);
  assert.strictEqual(O.activity(o.members[A.id], T0 + 40 * D), 0);
});

test("rename: Master Admin (or temporary holder) and the operator only, same name rules", () => {
  const o = org();
  assert.throws(() => O.adminAction(o, A, "rename", null, T0, { name: "New Name" }), /Only the Master Admin renames/);
  assert.throws(() => O.adminAction(o, ME, "rename", null, T0, { name: "<b>" }), /Org names/);
  O.adminAction(o, ME, "rename", null, T0, { name: "  Deep Divers  " });
  assert.strictEqual(o.name, "Deep Divers");
  O.adminAction(o, { id: 999, name: "Op" }, "rename", null, T0, { operator: true, name: "Op Named" });
  assert.strictEqual(o.name, "Op Named");
});

test("J-Space sharing: Org only by default, the Master Admin switches it", () => {
  const o = org();
  assert.strictEqual(O.jspaceOf(o), "org");
  assert.strictEqual(O.jspaceOf({}), "org");
  assert.throws(() => O.adminAction(o, A, "jspace", null, T0, { value: "public" }), /Only the Master Admin sets/);
  assert.throws(() => O.adminAction(o, ME, "jspace", null, T0, { value: "everyone" }), /org or public/);
  O.adminAction(o, ME, "jspace", null, T0, { value: "public" });
  assert.strictEqual(O.adminView(o, T0).jspace, "public");
  assert.match(o.log.at(-1).what, /Public/);
});
