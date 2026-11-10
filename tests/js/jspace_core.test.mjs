import test from "node:test";
import assert from "node:assert";
import * as J from "../../web/survey/jspace_core.mjs";

test("resolution: Planetology plus Advanced Planetology", () => {
  assert.strictEqual(J.resolutionOf([{ skill_id: 2406, active_skill_level: 5 }, { skill_id: 2403, active_skill_level: 3 },
    { skill_id: 13279, active_skill_level: 5 }]), 8);
  assert.strictEqual(J.resolutionOf([]), 0);
});

test("planet kinds and their resources", () => {
  assert.strictEqual(J.planetKind("Planet (Storm)"), "Storm");
  assert.deepStrictEqual(J.resourcesOf("Planet (Storm)"),
    ["Aqueous Liquids", "Base Metals", "Ionic Solutions", "Noble Gas", "Suspended Plasma"]);
  assert.strictEqual(J.roman(14), "XIV");
  assert.strictEqual(J.fromRoman("III"), 3);
  assert.strictEqual(J.fromRoman("IIII"), 0);
});

test("reading a capture: text as the recognition returned it from a real scan", () => {
  const text = `Search for anything\n® J170949\n#® J170949 Ill\nScan\nAqueous Liquids Raw Resource\nNo\nfilter\n` +
    `Resource Density: 58%\nAqueaus Liquids QD .-\nRequired For\ng: Base Metals\nWater Tier 1\nIonic Solutions\nNoble Gas`;
  assert.deepStrictEqual(J.parseScanText(text), { system: "J170949", index: 3, resource: "Aqueous Liquids", density: 58 });
  assert.strictEqual(J.parseScanText("Nobie Gas Raw Resource\nResource Density: 1O%").resource, "Noble Gas");
  assert.strictEqual(J.parseScanText("Nobie Gas Raw Resource\nResource Density: 1O%").density, 10);
  assert.strictEqual(J.matchResource("Non-CS Crystais"), "Non-CS Crystals");
  // as the browser's recognition read the same picture: no "Raw Resource", planet misread
  const web = J.parseScanText("+ J179949\n4 J178949 III\nAqueous Liquids\nResource Density: 58%\nAqueous Liquids CC] N");
  assert.deepStrictEqual([web.resource, web.density], ["Aqueous Liquids", 58]);
  assert.strictEqual(J.parseScanText("#: J170949 Xx :\n2 J170949 Ill x\n4 al Aqueous Liquids =. ©... a\nNo filter Resource Density: 58%").resource, "Aqueous Liquids");
  assert.strictEqual(J.matchResource("Search for anything"), null);
});

test("replacing: higher resolution, or the same and newer; lower never", () => {
  const st = {};
  const op = (res, at, d = 50, by = "A") => ({ system: 31000001, planet: 40000001, resource: "Base Metals", d, res, by, at, shot: `k${at}` });
  assert.strictEqual(J.applyScan(st, op(6, 100)).applied, true);
  const low = J.applyScan(st, op(4, 200));
  assert.deepStrictEqual([low.applied, low.reason], [false, "stored scan has a higher resolution (6)"]);
  const same = J.applyScan(st, op(6, 300, 61));
  assert.deepStrictEqual([same.applied, same.replaced.shot], [true, "k100"]);
  assert.strictEqual(J.applyScan(st, op(9, 50)).applied, true);           // higher wins even if older
  assert.strictEqual(st["31000001"]["40000001"]["Base Metals"].res, 9);
  assert.strictEqual(J.applyScan(st, { ...op(9, 400), resource: "Gold" }).applied, false);
  assert.strictEqual(J.applyScan(st, op(11, 500)).applied, false);
});

test("merging public and org copies keeps the better scan per resource", () => {
  const a = { 1: { 2: { "Base Metals": { d: 40, res: 5, at: 1 }, "Noble Gas": { d: 10, res: 8, at: 1 } } } };
  const b = { 1: { 2: { "Base Metals": { d: 45, res: 7, at: 0 }, "Noble Gas": { d: 12, res: 3, at: 9 } } } };
  const m = J.mergeStores(a, b);
  assert.deepStrictEqual([m[1][2]["Base Metals"].d, m[1][2]["Noble Gas"].d], [45, 10]);
});
