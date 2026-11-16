import test from "node:test";
import assert from "node:assert";
import { KINDS, TOOLS, briefText, makeBrief, toApiMessages, listMeta, replyText, quotaKey, systemPrompt } from "../../worker/planner_core.js";

test("brief: kind falls back to other, title from the objective, risk checked", () => {
  const { kind, title, brief } = makeBrief({ kind: "nope", objective: "  Mine Hedbergite in Huna\nwith two Ventures ", risk: "extreme" });
  assert.equal(kind, "other");
  assert.equal(title, "Mine Hedbergite in Huna");
  assert.equal(brief.risk, "");
  assert.throws(() => makeBrief({ objective: " " }), /Say what/);
  const t = briefText("op-mining", { objective: "x", where: "Huna", who: "", when: "", risk: "low" });
  assert.match(t, /Mining operation/);
  assert.match(t, /Where: Huna/);
  assert.doesNotMatch(t, /Pilots/);
});

test("history: members in a row become one signed turn, starts with a user turn", () => {
  const msgs = [
    { role: "assistant", by: "Planner", text: "stray" },
    { role: "user", by: "Varg Soth", text: "plan a roam" },
    { role: "assistant", by: "Planner", text: "draft" },
    { role: "user", by: "Varg Soth", text: "add logi" },
    { role: "user", by: "Serving Purpose", text: "I can fly a Scythe" },
  ];
  const out = toApiMessages(msgs);
  assert.deepEqual(out.map(m => m.role), ["user", "assistant", "user"]);
  assert.equal(out[2].content, "Varg Soth: add logi\n\nServing Purpose: I can fly a Scythe");
  assert.equal(toApiMessages(msgs, 2).length, 1);
});

test("tools are well formed and every kind has a label", () => {
  for (const t of TOOLS) { assert.ok(t.name && t.description && t.input_schema.type === "object"); }
  for (const k of Object.values(KINDS)) assert.ok(k.label && k.group);
  assert.match(systemPrompt({ org: "Atlas Test Org", today: "2026-11-15", pilot: "Varg Soth" }), /Atlas Test Org/);
});

test("meta, reply text, quota key", () => {
  const p = { title: "t", kind: "explore", by: "a", updated: "u", status: "open", messages: [1, 2] };
  assert.deepEqual(listMeta(p), { t: "t", k: "explore", b: "a", u: "u", s: "open", n: 2 });
  assert.equal(replyText([{ type: "text", text: "a" }, { type: "server_tool_use" }, { type: "text", text: "b" }]), "ab");
  assert.equal(quotaKey(5, new Date("2026-11-15T23:00:00Z")), "planq:2026-11-15:5");
});
