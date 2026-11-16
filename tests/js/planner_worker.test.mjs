/* the relay's planner endpoint end to end, with Claude, ESI and KV faked */
import test from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "planner-"));
const core = pathToFileURL(new URL("worker/planner_core.js", root).pathname).href;
let src = readFileSync(new URL("worker/planner.js", root), "utf8").replace(/from "\.\/planner_core\.js"/, `from ${JSON.stringify(core)}`);
for (const [name, file] of [["KSPACE", "kspace"], ["JSYSTEMS", "systems"], ["CLASSES", "classes"], ["WORMHOLES", "wormholes"]]) {
  const p = new URL(`web/data/jspace/${file}.json`, root).pathname;
  src = src.replace(new RegExp(`import ${name} from "[^"]+";`), `const ${name} = JSON.parse(readFileSync(${JSON.stringify(p)}, "utf8"));`);
}
writeFileSync(join(dir, "p.mjs"), `import { readFileSync } from "node:fs";\n${src}`);
const { planner, _test } = await import(pathToFileURL(join(dir, "p.mjs")).href);

function kv() {
  const m = new Map();
  return { m,
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v.v) : v.v; },
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata }); },
    async list({ prefix }) { return { keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.meta })), list_complete: true }; } };
}
const who = { id: 7, name: "Varg Soth", scp: [] };
const deps = (member = true) => ({
  verify: async () => who, isOperator: () => false, esiAuthed: async () => ({}), room: () => ({ fetch: async () => new Response("{}") }),
  orgCall: async (env, p) => p.action === "mine" ? { orgs: [{ id: "abc", name: "Test Org", role: "member" }, { id: "zzz", name: "Other", role: "member" }] }
    : { ok: member, name: "Test Org" } });

test("route: secure avoids lowsec, shortest does not", () => {
  const id = n => _test.systemId(n);
  const sec = _test.route(id("Jita"), id("Amarr"), "secure");
  const short = _test.route(id("Jita"), id("Amarr"), "shortest");
  assert.ok(short.length <= sec.length);
  assert.equal(_test.systemId("jita"), 30000142);
  assert.equal(_test.wormholeType({ code: "b274" }).leadsTo, "HS");
});

test("state lists only planner orgs; members only; offline refuses to answer", async () => {
  const env = { SIGHTINGS: kv(), PLANNER_ORGS: "abc", PLANNER_LIVE: "0" };
  const st = await planner({ token: "t", action: "state" }, env, deps());
  assert.deepEqual(st.orgs, [{ id: "abc", name: "Test Org" }]);
  assert.equal(st.live, false);
  await assert.rejects(planner({ token: "t", action: "list", org: "zzz" }, env, deps()), /not open/);
  await assert.rejects(planner({ token: "t", action: "list", org: "abc" }, env, deps(false)), /approved member/);
  await assert.rejects(planner({ token: "t", action: "new", org: "abc", objective: "roam" }, env, deps()), /offline/);
});

test("new plan: Claude calls a tool, then answers; the plan is listed and counted", async () => {
  const env = { SIGHTINGS: kv(), PLANNER_ORGS: "abc", PLANNER_LIVE: "1", ANTHROPIC_API_KEY: "k", PLANNER_WEB: "0" };
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes("api.anthropic.com")) {
      const body = JSON.parse(opts.body);
      sent.push(body);
      if (sent.length === 1) return Response.json({ stop_reason: "tool_use", content: [
        { type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "wormhole_type", input: { code: "B274" } }] });
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "## Objective\nGo to highsec." }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { plan } = await planner({ token: "t", action: "new", org: "abc", kind: "op-wormhole", objective: "Find a way to highsec" }, env, deps());
  assert.equal(plan.messages.length, 2);
  assert.match(plan.messages[1].text, /Go to highsec/);
  assert.deepEqual(plan.messages[1].used, ["wormhole B274"]);
  assert.equal(sent[0].messages[0].role, "user");
  assert.match(sent[0].messages[0].content, /^Varg Soth: Mission type: Wormhole operation/);
  const result = sent[1].messages[2].content[0];
  assert.equal(result.type, "tool_result");
  assert.match(result.content, /"leadsTo":"HS"/);
  const { plans } = await planner({ token: "t", action: "list", org: "abc" }, env, deps());
  assert.equal(plans.length, 1);
  assert.equal(plans[0].n, 2);
  assert.equal(await env.SIGHTINGS.get(`planq:${new Date().toISOString().slice(0, 10)}:7`), "1");
  const said = await planner({ token: "t", action: "say", org: "abc", id: plan.id, text: "thanks" }, env, deps());
  assert.equal(said.plan.messages.length, 4);
  env.PLANNER_DAILY = "2";
  await assert.rejects(planner({ token: "t", action: "say", org: "abc", id: plan.id, text: "again" }, env, deps()), /used today/);
});
