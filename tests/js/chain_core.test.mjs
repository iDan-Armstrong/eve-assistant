import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../web/survey/chain_core.mjs";

const H = C.HOUR;
const J1 = 31000005, J2 = 31000006, JITA = 30000142, PERIMETER = 30000144, AMARR = 30002187;
const gates = { [JITA]: [PERIMETER], [PERIMETER]: [JITA] };
const WH = { B274: { to: 7, life: 24, mass: 2e9, jump: 375e6 }, K162: { life: 24 } };

test("probe scanner paste parses tab separated rows and skips junk", () => {
  const text = [
    "ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU",
    "DEF-456\tCosmic Signature\t\t\t12,5%\t20 AU",
    "not a row",
    "GHI-789\tCosmic Signature\tData Site\tUnsecured Perimeter Amplifier\t100.0%\t8 AU",
  ].join("\r\n");
  const s = C.parseSigs(text);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { id: "ABC-123", group: "Cosmic Signature", type: "Wormhole",
                           name: "Unstable Wormhole", pct: 100 });
  assert.equal(s[1].pct, 12.5);
  assert.equal(s[1].type, "");
});

test("a full paste keeps first-seen, upgrades detail and removes vanished sigs", () => {
  const first = C.mergeSigs({}, C.parseSigs("ABC-123\tCosmic Signature\t\t\t10%\t1 AU\nOLD-111\tCosmic Signature\t\t\t5%\t1 AU"), 1000);
  const second = C.mergeSigs(first.sigs, C.parseSigs("ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100%\t1 AU"), 2000);
  assert.equal(second.sigs["ABC-123"].first, 1000);
  assert.equal(second.sigs["ABC-123"].type, "Wormhole");
  assert.deepEqual(second.removed, ["OLD-111"]);
  const partial = C.mergeSigs(first.sigs, [], 3000, false);
  assert.equal(Object.keys(partial.sigs).length, 2);
});

test("show info text reads life, mass, size and destination", () => {
  const r = C.parseShowInfo(
    "This wormhole is reaching the end of its natural lifetime. " +
    "Its stability has been critically disrupted by the mass of numerous ships passing through. " +
    "Larger ships can pass through this wormhole. It seems to lead into high security space.");
  assert.deepEqual(r, { life: "eol", mass: "crit", size: "L", dest: "HS" });
  assert.equal(C.parseShowInfo("has not yet begun its natural cycle of decay").life, "fresh");
});

test("size classes follow the jump mass limits", () => {
  assert.equal(C.sizeFromJump(5e6), "S");
  assert.equal(C.sizeFromJump(62e6), "M");
  assert.equal(C.sizeFromJump(375e6), "L");
  assert.equal(C.sizeFromJump(2e9), "XL");
});

test("moves are classified: gate, wormhole, unsure, pod", () => {
  assert.equal(C.classifyMove(JITA, PERIMETER, gates), "gate");
  assert.equal(C.classifyMove(JITA, J1, gates), "wormhole");
  assert.equal(C.classifyMove(J1, J2, gates), "wormhole");
  assert.equal(C.classifyMove(JITA, AMARR, gates), "unsure");
  assert.equal(C.classifyMove(J1, JITA, gates, { dockedOnArrival: true }), "unsure");
  assert.equal(C.classifyMove(J1, JITA, gates, { becameCapsule: true }), "pod");
  assert.equal(C.classifyMove(JITA, JITA, gates), "none");
});

test("links expire on their type's lifetime, sooner once marked end of life", () => {
  const c = C.emptyChain();
  C.applyOp(c, C.newLink(JITA, J1, 0, "Dan"), WH);
  const key = C.linkKey(JITA, J1);
  assert.equal(c.links[key].expires, 24 * H);
  C.applyOp(c, { kind: "link", key, rec: { code: "B274", life: "eol", lifeAt: 10 * H }, at: 10 * H }, WH);
  assert.equal(c.links[key].expires, 14 * H);
  C.prune(c, 15 * H);
  assert.equal(c.links[key], undefined);
});

test("older writes lose, deletes stick, merges agree", () => {
  const a = C.emptyChain(), b = C.emptyChain();
  const op = C.newLink(J1, J2, 100, "A");
  C.applyOp(a, op, WH);
  C.applyOp(b, op, WH);
  const key = C.linkKey(J1, J2);
  C.applyOp(a, { kind: "link", key, rec: { mass: "crit" }, at: 300 }, WH);
  C.applyOp(a, { kind: "link", key, rec: { mass: "stable" }, at: 200 }, WH);
  assert.equal(a.links[key].mass, "crit");
  C.applyOp(b, { kind: "del", what: "link", key, at: 400 }, WH);
  const m = C.mergeChains(a, b);
  assert.equal(m.links[key], undefined, "the later delete wins over the earlier edit");
  C.applyOp(m, C.newLink(J1, J2, 350, "late copy"), WH);
  assert.equal(m.links[key], undefined, "a stale re-add cannot undo the delete");
});

test("tree layout walks out from the root and keeps loops as cross links", () => {
  const c = C.emptyChain();
  for (const [x, y] of [[JITA, J1], [J1, J2], [J1, 31000007], [J2, 31000007]]) C.applyOp(c, C.newLink(x, y, 1), WH);
  const t = C.layoutTree(c, JITA);
  assert.equal(t.nodes[0].id, JITA);
  assert.equal(t.nodes.find(n => n.id === J2).depth, 2);
  assert.equal(t.edges.length, 3);
  assert.equal(t.cross.length, 1);
  assert.equal(t.rows, 2);
  assert.deepEqual([...C.kspaceExits(c).keys()], [JITA]);
});
