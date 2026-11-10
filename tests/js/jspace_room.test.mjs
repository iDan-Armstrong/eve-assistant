/* the relay's room paths for J-Space planet scans, against an in-memory storage */
import test from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const src = readFileSync(new URL("../../worker/index.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "")
  .replace("export default {", "const _unused = {");
const dir = mkdtempSync(join(tmpdir(), "jroom-"));
const core = pathToFileURL(new URL("../../web/survey/jspace_core.mjs", import.meta.url).pathname).href;
writeFileSync(join(dir, "w.mjs"), `import { applyScan, mergeStores, resolutionOf } from ${JSON.stringify(core)};\n` +
  `const Org={}, ACTIVE_MINUTES=0, diffLedger=0, freshPresence=0, mergeSightings=0, prune=0, reserveRows=0, applyOp=0, emptyChain=0, pruneChain=0, applyKbOp=0, award=0, chainEvents=0, leaderboard=0, WORMHOLES={}, JSYSTEMS={}, CLASSES={};\n` +
  src + "\nexport { scanRoom, readRooms };");
const { CorpRoom, scanRoom, readRooms } = await import(pathToFileURL(join(dir, "w.mjs")).href);

function roomOf() {
  const mem = new Map();
  const storage = { get: async k => structuredClone(mem.get(k)), put: async (k, v) => { mem.set(k, structuredClone(v)); },
                    delete: async k => { mem.delete(k); }, list: async () => new Map() };
  const r = new CorpRoom({ storage });
  return async (path, body) => (await r.fetch(new Request(`https://room${path}`, { method: "POST", body: JSON.stringify(body) }))).json();
}

test("scans are stored per system and replaced by the rules", async () => {
  const call = roomOf();
  const op = (res, at, d) => ({ system: 31000001, planet: 40000001, resource: "Noble Gas", d, res, by: "Varg Soth", at, shot: `s${at}` });
  assert.strictEqual((await call("/jp-scan", { op: op(8, 1, 40) })).applied, true);
  assert.strictEqual((await call("/jp-scan", { op: op(5, 2, 90) })).applied, false);
  const r = await call("/jp-scan", { op: op(8, 3, 44) });
  assert.deepStrictEqual([r.applied, r.replaced.shot], [true, "s1"]);
  const got = await call("/jp-get", { systems: [31000001, 31000002] });
  assert.deepStrictEqual(Object.keys(got), ["31000001"]);
  assert.strictEqual(got["31000001"]["40000001"]["Noble Gas"].d, 44);
});

test("rooms: scans stay in their own org; readers add every org that is Public now", async () => {
  assert.strictEqual(scanRoom({ key: "org:a", org: { jspace: "public" } }), "org:a");
  assert.strictEqual(scanRoom({ key: "98000001", org: null }), "98000001");
  const env = { ORGS: { idFromName: () => 1, get: () => ({ fetch: async () => new Response(JSON.stringify({ orgs: ["b", "a"] })) }) } };
  assert.deepStrictEqual(await readRooms({ key: "org:a" }, env), ["org:a", "org:b"]);
  assert.deepStrictEqual(await readRooms({ key: "98000001" }, env), ["98000001", "org:b", "org:a"]);
});
