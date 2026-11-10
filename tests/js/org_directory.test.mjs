/* the relay's OrgDirectory Durable Object, run against an in-memory storage */
import test from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// load worker/index.js without its JSON and survey imports: only the org parts are under test
const src = readFileSync(new URL("../../worker/index.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "")
  .replace("export default {", "const _unused = {");
const dir = mkdtempSync(join(tmpdir(), "orgdir-"));
const core = pathToFileURL(new URL("../../worker/org_core.js", import.meta.url).pathname).href;
writeFileSync(join(dir, "w.mjs"), `import * as Org from ${JSON.stringify(core)};\n` +
  `const ACTIVE_MINUTES=0, diffLedger=0, freshPresence=0, mergeSightings=0, prune=0, reserveRows=0, applyOp=0, emptyChain=0, pruneChain=0, applyKbOp=0, award=0, chainEvents=0, leaderboard=0, applyScan=0, mergeStores=0, resolutionOf=0, WORMHOLES={}, JSYSTEMS={}, CLASSES={};\n` + src);
const { OrgDirectory } = await import(pathToFileURL(join(dir, "w.mjs")).href);

function directory() {
  const mem = new Map();
  const storage = { get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); },
                    delete: async k => { mem.delete(k); } };
  const d = new OrgDirectory({ storage });
  return { mem, call: async body => { const r = await d.fetch(new Request("https://orgs/", { method: "POST", body: JSON.stringify(body) }));
    const j = await r.json(); return r.ok ? j : { error: j.error }; } };
}
const VARG = { id: 1, name: "Varg Soth" }, ANN = { id: 2, name: "Ann" }, BOB = { id: 3, name: "Bob" };

test("create, join, approve, check, admin view, operator", async () => {
  const { call, mem } = directory();
  const made = await call({ action: "create", who: VARG, name: "Deep Divers", adminPassword: "admin-secret", memberPassword: "member-secret" });
  assert.strictEqual(made.role, "admin");
  const org = made.id;
  assert.match((await call({ action: "create", who: ANN, name: "deep divers", adminPassword: "aaaaaa", memberPassword: "bbbbbb" })).error, /taken/);
  assert.match((await call({ action: "create", who: ANN, name: "Same Pw", adminPassword: "aaaaaa", memberPassword: "aaaaaa" })).error, /differ/);
  // passwords are stored only as hashes
  const stored = JSON.stringify(mem.get(`org:${org}`));
  assert.ok(!stored.includes("admin-secret") && !stored.includes("member-secret"));

  assert.match((await call({ action: "join", who: ANN, org, password: "wrong!" })).error, /Wrong password/);
  assert.strictEqual((await call({ action: "join", who: ANN, org, password: "member-secret" })).role, "pending");
  assert.deepStrictEqual(await call({ action: "check", who: ANN, org }), { ok: false });     // pending sees nothing

  assert.match((await call({ action: "admin", who: VARG, org, adminPassword: "member-secret", op: "view" })).error, /Wrong password/);
  const view = await call({ action: "admin", who: VARG, org, adminPassword: "admin-secret", op: "approve", target: ANN.id });
  assert.strictEqual(view.members.find(m => m.id === ANN.id).role, "member");
  assert.deepStrictEqual(await call({ action: "check", who: ANN, org }), { ok: true, name: "Deep Divers", role: "member", jspace: "org" });
  assert.match((await call({ action: "admin", who: ANN, org, adminPassword: "admin-secret", op: "view" })).error, /Admins only/);

  const mine = await call({ action: "mine", who: ANN });
  assert.deepStrictEqual(mine.orgs.map(o => [o.name, o.role]), [["Deep Divers", "member"]]);
  assert.deepStrictEqual((await call({ action: "list", who: BOB })).orgs, [{ id: org, name: "Deep Divers", members: 2 }]);

  // operator resets the member password; the old one stops working
  assert.match((await call({ action: "operator", who: BOB, isOperator: false, org, op: "passwords", newMember: "x" })).error, /Operator only/);
  await call({ action: "operator", who: VARG, isOperator: true, org, op: "passwords", newMember: "fresh-member-pw" });
  assert.match((await call({ action: "join", who: BOB, org, password: "member-secret" })).error, /Wrong password/);
  assert.strictEqual((await call({ action: "join", who: BOB, org, password: "fresh-member-pw" })).role, "pending");

  // five wrong admin passwords lock that pilot out for the hour
  for (let i = 0; i < 5; i++) await call({ action: "admin", who: VARG, org, adminPassword: "nope", op: "view" });
  assert.match((await call({ action: "admin", who: VARG, org, adminPassword: "admin-secret", op: "view" })).error, /Too many/);
});

test("leaving: the Master Admin must hand over first; the last one out removes the org", async () => {
  const { call } = directory();
  const { id: org } = await call({ action: "create", who: VARG, name: "Solo Org", adminPassword: "adminpw1", memberPassword: "memberpw1" });
  await call({ action: "join", who: ANN, org, password: "memberpw1" });
  await call({ action: "admin", who: VARG, org, adminPassword: "adminpw1", op: "approve", target: ANN.id });
  assert.match((await call({ action: "leave", who: VARG, org })).error, /Pass Master Admin/);
  await call({ action: "leave", who: ANN, org });
  await call({ action: "leave", who: VARG, org });
  assert.deepStrictEqual((await call({ action: "list", who: BOB })).orgs, []);
});

test("rename keeps names unique and updates the list", async () => {
  const { call } = directory();
  const { id: a } = await call({ action: "create", who: VARG, name: "Alpha Org", adminPassword: "adminpw1", memberPassword: "memberpw1" });
  await call({ action: "create", who: ANN, name: "Beta Org", adminPassword: "adminpw2", memberPassword: "memberpw2" });
  assert.match((await call({ action: "admin", who: VARG, org: a, adminPassword: "adminpw1", op: "rename", name: "beta org" })).error, /taken/);
  assert.strictEqual((await call({ action: "admin", who: VARG, org: a, adminPassword: "adminpw1", op: "rename", name: "Gamma Org" })).name, "Gamma Org");
  assert.deepStrictEqual((await call({ action: "list", who: BOB })).orgs.map(o => o.name), ["Beta Org", "Gamma Org"]);
  assert.strictEqual((await call({ action: "mine", who: VARG })).orgs[0].name, "Gamma Org");
});

test("J-Space sharing shows in mine and check", async () => {
  const { call } = directory();
  const { id: org } = await call({ action: "create", who: VARG, name: "Js Org", adminPassword: "adminpw1", memberPassword: "memberpw1" });
  assert.strictEqual((await call({ action: "mine", who: VARG })).orgs[0].jspace, "org");
  await call({ action: "admin", who: VARG, org, adminPassword: "adminpw1", op: "jspace", value: "public" });
  assert.strictEqual((await call({ action: "check", who: VARG, org })).jspace, "public");
});

test("the operator holds Master Admin standing in every org, without being a member", async () => {
  const { call } = directory();
  const { id: org } = await call({ action: "create", who: ANN, name: "Anns Org", adminPassword: "adminpw1", memberPassword: "memberpw1" });
  const mine = await call({ action: "mine", who: VARG, isOperator: true });
  assert.deepStrictEqual(mine.orgs.map(o => [o.name, o.role, o.master, o.operator]), [["Anns Org", "admin", true, true]]);
  assert.strictEqual((await call({ action: "check", who: VARG, org, isOperator: true })).ok, true);
  assert.strictEqual((await call({ action: "check", who: VARG, org })).ok, false);      // not an operator: no access
  const v = await call({ action: "operator", who: VARG, isOperator: true, org, op: "jspace", value: "public" });
  assert.strictEqual(v.jspace, "public");
  assert.ok(!v.members.some(m => m.id === VARG.id));                                     // never added as a member
  assert.strictEqual(String(v.master), String(ANN.id));                                  // the org's own Master Admin stays
});
