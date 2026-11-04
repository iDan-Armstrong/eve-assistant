import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../web/survey/chain_core.mjs";
import * as S from "../../web/survey/survey_core.mjs";

const H = C.HOUR;
const HOME = 30000142, J1 = 31000005, J2 = 31000006, J3 = 31000007;
const WH = { B274: { to: 7, life: 24, jump: 375e6 }, N110: { to: 7, life: 24, jump: 62e6 }, K162: { exit: true } };
const SCAN = { 587: ["Rifter", "Frigate", "S"], 12011: ["Proteus", "Strategic Cruiser", "S"],
               35832: ["Astrahus", "Citadel", "U"], 16213: ["Caldari Control Tower", "Control Tower", "P"],
               17167: ["Small Pulse Laser Battery", "Energy Weapon Battery", "P"] };

test("the router tells probe scans, d-scans and Show Info apart, and ignores other text", () => {
  assert.equal(S.classifyPaste("ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU").kind, "sigs");
  assert.equal(S.classifyPaste("35832\tHome Sweet Home\tAstrahus\t1,234 km\n587\tBob's Rifter\tRifter\t-").kind, "dscan");
  assert.equal(S.classifyPaste("This wormhole is reaching the end of its natural lifetime.").kind, "showinfo");
  assert.equal(S.classifyPaste("my bank password is hunter2"), null);
  assert.equal(S.classifyPaste("Bob\nAlice\nCarol"), null);
});

test("d-scan distances read in m, km and AU, with thousands separators", () => {
  assert.equal(S.parseDist("1,234 km"), 1234);
  assert.equal(S.parseDist("1.234 km"), 1234);
  assert.equal(S.parseDist("2,5 km"), 2.5);
  assert.equal(S.parseDist("500 m"), 0.5);
  assert.ok(Math.abs(S.parseDist("1 AU") - 1.495978707e8) < 1);
  assert.equal(S.parseDist("-"), null);
});

test("d-scan summary counts ships, structures and holes, with or without type ids", () => {
  const rows = S.parseDscan([
    "35832\tHome Sweet Home\tAstrahus\t1,234 km",
    "587\tBob's Rifter\tRifter\t-",
    "12011\tTengu thing\tProteus\t2.1 AU",
    "Some Tower\tCaldari Control Tower\t-",
    "30583\tUnstable Wormhole\tWormhole B274\t-",
    "17167\tSmall Pulse Laser Battery\tSmall Pulse Laser Battery\t-",
  ].join("\n"));
  assert.equal(rows.length, 6);
  const byName = new Map(Object.entries(SCAN).map(([id, v]) => [v[0].toLowerCase(), +id]));
  const s = S.summarizeDscan(rows, SCAN, byName);
  assert.equal(s.total, 6);
  assert.equal(s.posModules, 1, "POS modules are counted, not listed as structures");
  assert.equal(s.cats.S, 2);
  assert.deepEqual(s.structures, [["Astrahus", "Home Sweet Home"], ["Caldari Control Tower", "Some Tower"]]);
  assert.equal(s.holes, 1);
  assert.equal(s.groups["Strategic Cruiser"], 1);
  assert.equal(s.onGrid, 1);
});

test("life bounds: Show Info sets the guaranteed time, the type sets the latest", () => {
  const base = { code: "B274", first: 0, expires: 24 * H };
  assert.deepEqual(S.lifeBounds(base, WH), { lo: null, hi: 24 * H });
  assert.equal(S.lifeBounds({ ...base, life: "eol", lifeAt: 10 * H }, WH).lo, 10 * H);
  assert.equal(S.lifeBounds({ ...base, life: "decay", lifeAt: 2 * H }, WH).lo, 6 * H);
  assert.equal(S.lifeBounds({ ...base, life: "fresh", lifeAt: 1 * H, expires: 48 * H }, WH).lo, 25 * H);
  assert.equal(S.lifeBounds({ ...base, life: "fresh", lifeAt: 1 * H }, WH).lo, 24 * H, "never past the latest close");
});

test("the way home finds the weakest hole and flags unknown ages and crit mass", () => {
  const c = C.emptyChain();
  C.applyOp(c, C.newLink(HOME, J1, 0, "A", { life: "fresh", lifeAt: 0 }), WH);
  C.applyOp(c, C.newLink(J1, J2, 0, "A", { life: "decay", lifeAt: 0, mass: "crit" }), WH);
  C.applyOp(c, C.newLink(J2, J3, 0, "A"), WH);
  const w = S.wayHome(c, J3, HOME, WH, 1 * H);
  assert.equal(w.jumps, 3);
  assert.equal(w.lo, 4 * H);
  assert.equal(w.left, 3 * H);
  assert.equal(w.weakest, C.linkKey(J1, J2));
  assert.deepEqual(w.unknown, [C.linkKey(J2, J3)]);
  assert.deepEqual(w.crit, [C.linkKey(J1, J2)]);
  assert.equal(S.wayHome(c, 31000099, HOME, WH, 0).connected, false);
});

test("knowledge base: first visits, statics seen twice, new structures, capped d-scan history", () => {
  const kb = {};
  assert.deepEqual(S.applyKbOp(kb, { kind: "visit", system: J1, by: "A" }, 0).events.map(e => e.a), ["first_visit", "arrive"]);
  assert.deepEqual(S.applyKbOp(kb, { kind: "visit", system: J1, by: "B" }, 1).events.map(e => e.a), ["arrive"]);
  assert.deepEqual(S.applyKbOp(kb, { kind: "static", system: J1, code: "B274" }, 0).events.map(e => e.a), ["static_found"]);
  S.applyKbOp(kb, { kind: "static", system: J1, code: "B274" }, 2 * H);
  S.applyKbOp(kb, { kind: "static", system: J1, code: "K162" }, 3 * H);
  assert.deepEqual(S.staticsOf(kb[J1]), [{ code: "B274", n: 2, sure: true }]);
  const sum = { total: 1, structures: [["Astrahus", "Home"]] };
  assert.deepEqual(S.applyKbOp(kb, { kind: "dscan", system: J1, sum }, 0).events.map(e => e.a), ["dscan", "structure_new"]);
  assert.deepEqual(S.applyKbOp(kb, { kind: "dscan", system: J1, sum }, H).events.map(e => e.a), ["dscan"]);
  for (let i = 0; i < 50; i++) S.applyKbOp(kb, { kind: "dscan", system: J1, sum: { total: 0, structures: [] } }, 2 * H + i);
  assert.equal(kb[J1].dscans.length, S.DSCAN_KEEP);
});

test("chain events: flown links, confirmations, typing, Show Info, new sigs, first notes", () => {
  const c = C.emptyChain();
  const op = C.newLink(J1, J2, 0, "", { source: "jump" });
  assert.deepEqual(S.chainEvents(c, op), [{ a: "jump_link" }]);
  C.applyOp(c, op, WH);
  const key = C.linkKey(J1, J2);
  assert.deepEqual(S.chainEvents(c, { kind: "link", key, rec: { code: "B274" } }), [{ a: "hole_typed" }]);
  assert.deepEqual(S.chainEvents(c, { kind: "link", key, rec: { life: "eol", lifeAt: 5 } }), [{ a: "hole_status" }]);
  assert.deepEqual(S.chainEvents(c, C.newLink(HOME, J3, 0, "", { source: "jump", confirmed: false })), []);
  const sigs = C.parseSigs("ABC-123\tCosmic Signature\t\t\t1%\t1 AU\nDEF-456\tCosmic Signature\t\t\t1%\t1 AU");
  assert.deepEqual(S.chainEvents(c, { kind: "sigs", system: J1, parsed: sigs }), [{ a: "new_sigs", n: 2 }]);
  C.applyOp(c, { kind: "sigs", system: J1, parsed: sigs, at: 1 }, WH);
  assert.deepEqual(S.chainEvents(c, { kind: "sigs", system: J1, parsed: sigs }), []);
  assert.deepEqual(S.chainEvents(c, { kind: "note", system: J1, text: "Astrahus here" }), [{ a: "note" }]);
});

test("points add up, daily caps hold, badges and ranks unlock", () => {
  const L = {};
  const classOf = id => ({ [J1]: "C5", [J2]: "C2" })[id];
  let r = S.award(L, "1", "Dan", [{ a: "jump_link" }, { a: "first_visit" }, { a: "arrive", system: J1 }], Date.UTC(2026, 10, 4, 12), { classOf });
  assert.equal(r.points, 35);
  assert.deepEqual(r.badges.sort(), ["deep_diver", "first_light"]);
  r = S.award(L, "1", "Dan", Array.from({ length: 10 }, () => ({ a: "new_sigs", n: 50 })), Date.UTC(2026, 10, 4, 13));
  assert.equal(r.points, 80, "daily cap on new signatures");
  r = S.award(L, "1", "Dan", [{ a: "new_sigs", n: 3 }], Date.UTC(2026, 10, 5, 2));
  assert.equal(r.points, 6, "a new day, a new cap");
  assert.equal(L["1"].night, 1);
  assert.equal(S.rankOf(L["1"].pts).name, "Surveyor");
  assert.equal(S.rankOf(4999).next.name, "Survey Master");
  for (let d = 0; d < 7; d++) S.award(L, "2", "Bo", [{ a: "dscan" }], Date.UTC(2026, 10, 1 + d, 12));
  assert.ok(L["2"].badges.streak_7);
  assert.deepEqual(S.leaderboard(L).map(x => x.name), ["Dan", "Bo"]);
});

test("survey batch: nearest unscanned systems in visiting order, skipping fresh scans and others' claims", () => {
  // a line of systems 1-2-3-4-5-6-7 plus a lowsec spur 3-9
  const gates = { 1: [2], 2: [1, 3], 3: [2, 4, 9], 4: [3, 5], 5: [4, 6], 6: [5, 7], 7: [6], 9: [3] };
  const sec = { 1: 0.9, 2: 0.9, 3: 0.8, 4: 0.7, 5: 0.6, 6: 0.5, 7: 0.5, 9: 0.2 };
  const now = 100 * H;
  const kb = { 2: { probedAt: now - 2 * H }, 4: { claim: { by: "Other", until: now + H } }, 5: { claim: { by: "Me", until: now + H } } };
  const b = S.surveyBatch({ from: 1, gates, secOf: id => sec[id], kb, now, me: "Me", n: 4 });
  assert.deepEqual(b.systems, [1, 3, 5, 6], "1 itself, then 3 (2 is fresh), 5 (4 claimed by another, own claim ok), 6");
  assert.deepEqual(b.route, [1, 2, 3, 4, 5, 6]);
  const low = S.surveyBatch({ from: 3, gates, secOf: id => sec[id], kb: {}, now, me: "Me", n: 2, highsecOnly: false });
  assert.deepEqual(low.systems, [3, 2], "lowsec allowed when asked; ties go to either neighbour");
  const kb2 = { 1: { probedAt: now - 30 * H } };
  assert.equal(S.surveyBatch({ from: 1, gates, secOf: id => sec[id], kb: kb2, now, me: "Me", n: 1 }).systems[0], 1, "a stale scan is due again");
});

test("knowledge base records probe scans and claims", () => {
  const kb = {};
  S.applyKbOp(kb, { kind: "probe", system: 30000142, by: "A" }, 5);
  S.applyKbOp(kb, { kind: "claim", system: 30000142, by: "A", until: 99 }, 5);
  assert.equal(kb[30000142].probedAt, 5);
  assert.deepEqual(kb[30000142].claim, { by: "A", until: 99 });
  S.applyKbOp(kb, { kind: "claim", system: 30000142, by: "A", until: null }, 6);
  assert.equal(kb[30000142].claim, undefined);
});
