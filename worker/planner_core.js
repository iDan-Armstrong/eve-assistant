/* Mission planner: the pure half (no network), shared by the relay and
   `node --test`. The relay's planner endpoints, the calls to Claude and the
   tools Claude may use live in worker/planner.js.

   A plan is one conversation inside one org:
     { id, org, kind, title, by, created, updated, status: "open"|"archived",
       brief: {objective, where, who, when, risk},
       messages: [{ role: "user"|"assistant", by, text, at, used? }] }
   Every member of the org can read every plan and add to it, so a plan is
   worked out together. Only the latest messages go to Claude. */

export const KINDS = {
  "op-mining": { group: "Org operations", label: "Mining operation" },
  "op-wormhole": { group: "Org operations", label: "Wormhole operation (rolling, scouting, eviction defence)" },
  "op-haul": { group: "Org operations", label: "Hauling run" },
  "op-roam": { group: "Org operations", label: "PvP roam or gatecamp" },
  "op-structure": { group: "Org operations", label: "Structure work (anchoring, fuel, defence, timers)" },
  "pve-agent": { group: "PvE", label: "Agent missions (security, distribution, mining)" },
  "pve-sites": { group: "PvE", label: "Combat sites and anomalies (ratting, wormhole sites, Abyssal)" },
  "explore": { group: "Exploration", label: "Exploration (data, relic, gas, ore sites)" },
  "industry": { group: "Industry", label: "Industry or PI campaign (a build, a fund, a chain)" },
  "other": { group: "Other", label: "Something else" },
};

export const MAX_TEXT = 4000;          // characters in one member message
export const MAX_TITLE = 80;
export const HISTORY = 24;             // messages sent to Claude
export const MAX_ROUNDS = 8;           // tool rounds in one reply

export function newId(now = Date.now(), rand = Math.random) {
  return now.toString(36) + rand().toString(36).slice(2, 6);
}

export const clean = (s, max) => String(s ?? "").replace(/\r/g, "").trim().slice(0, max);

/* the member's form -> a validated brief and title */
export function makeBrief(body) {
  const kind = KINDS[body.kind] ? body.kind : "other";
  const objective = clean(body.objective, MAX_TEXT);
  if (objective.length < 3) throw new Error("Say what the mission is for.");
  const brief = { objective, where: clean(body.where, 120), who: clean(body.who, 400),
                  when: clean(body.when, 120), risk: ["low", "medium", "high"].includes(body.risk) ? body.risk : "" };
  const title = clean(body.title, MAX_TITLE) || objective.split("\n")[0].slice(0, MAX_TITLE);
  return { kind, title, brief };
}

/* the opening message, written for Claude from the brief */
export function briefText(kind, brief) {
  const lines = [`Mission type: ${KINDS[kind].label}`, `Objective: ${brief.objective}`];
  if (brief.where) lines.push(`Where: ${brief.where}`);
  if (brief.who) lines.push(`Pilots and ships: ${brief.who}`);
  if (brief.when) lines.push(`When: ${brief.when}`);
  if (brief.risk) lines.push(`Risk we will accept: ${brief.risk}`);
  return lines.join("\n");
}

/* stored messages -> Claude's alternating user/assistant turns. Several
   members writing in a row become one user turn, each line signed. */
export function toApiMessages(messages, keep = HISTORY) {
  const recent = messages.slice(-keep);
  while (recent.length && recent[0].role !== "user") recent.shift();
  const out = [];
  for (const m of recent) {
    const text = m.role === "user" ? `${m.by}: ${m.text}` : m.text;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  return out;
}

/* the short record KV keeps beside each plan, for the list */
export const listMeta = p => ({ t: p.title, k: p.kind, b: p.by, u: p.updated, s: p.status, n: p.messages.length });

export function systemPrompt({ org, today, pilot }) {
  return `You are the mission planner for "${org}", an EVE Online player organization, working inside the New Eden Atlas web app. Members bring you a goal and you help them turn it into a plan they can fly. ${pilot} is the member who wrote the latest message. Today is ${today} (EVE time is UTC).

How to work:
- Ground the plan in facts. Use your tools for anything about the current game state: systems, routes, recent kills, traffic, prices, the org's wormhole chain and planet scans, and the member's own pilot. Use web search for game mechanics that may have changed recently (site contents, mission details, expansion changes); prefer EVE University wiki, CCP and EVE Ref. Never invent numbers you could look up, and say so when you could not check something.
- If key details are missing, give your best draft anyway and end with at most three short questions.
- Several members may write in one plan; each line is signed with the pilot's name. Address them by name when it helps.
- Write in Markdown. When there is enough to go on, keep the whole current plan in one reply under these headings, each only when it has something useful:
  ## Objective
  ## Intel (what the tools showed, with the system names)
  ## Fleet and fits (roles, ships, key modules, skills that matter)
  ## Route and staging
  ## Steps (a numbered list, checkboxes "- [ ]" for prep items)
  ## Risks and fallbacks (what goes wrong, how to bail, safe spots, who calls it)
  ## Atlas tools to use
  ## Expected payout or cost (ISK figures from the market tool)
  Later replies can show only what changed when the plan is long.
- Keep it practical and specific to how EVE plays now. Be honest about danger: say plainly when a plan is likely to get ships killed.
- Only plan legitimate gameplay. Decline anything that breaks the EULA (botting, real-money trading, exploits); scams and ganks inside the game's rules are fair to discuss.

New Eden Atlas tools members can open (Tools menu): Route planner (safest or shortest, sends waypoints to the game), N-Space Survey (shared wormhole chain map), J-Space Survey (planet scans of wormhole systems, 3D system view), Find item (markets and contracts), Round trips, Sell my cargo, Courier jobs, Contract deals, Fit shopper, Blueprint finder, Asset clean-up, Traffic and activity (30-day lowsec jumps and kills by hour; wormhole kills and residents). Map overlays: PvP, ratting, faction war, market, security, ice fields, Jove observatories, entry systems and chokepoints, Thera and Turnur holes, the org's survey chain, corp mates' positions.`;
}

/* the tools Claude may call (worker/planner.js runs them) */
export const TOOLS = [
  { name: "lookup_system",
    description: "Facts about one solar system by name: security, region, wormhole class and effect, neighbouring systems, jumps and kills in the last hour, and for lowsec the 30-day traffic pattern, for wormhole systems the 30-day killmail activity.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "System name, e.g. Jita, Huna, J170949" } }, required: ["name"] } },
  { name: "plan_route",
    description: "Gate route between two known-space systems, with each system's security and the kills on the way in the last hour.",
    input_schema: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" },
      prefer: { type: "string", enum: ["shortest", "secure", "insecure"], description: "secure = highsec where possible" } },
      required: ["from", "to"] } },
  { name: "recent_kills",
    description: "Recent killmails in a system (zKillboard and ESI): ship lost, when, attackers, value. Use it to judge who is active there.",
    input_schema: { type: "object", properties: { system: { type: "string" },
      hours: { type: "integer", minimum: 1, maximum: 168, description: "how far back, default 24" } }, required: ["system"] } },
  { name: "market_prices",
    description: "Best sell and buy prices at a trade hub for up to 10 items (exact item names).",
    input_schema: { type: "object", properties: {
      items: { type: "array", items: { type: "string" }, maxItems: 10 },
      hub: { type: "string", enum: ["Jita", "Amarr", "Dodixie", "Rens", "Hek"], description: "default Jita" } },
      required: ["items"] } },
  { name: "wormhole_type",
    description: "A wormhole type by its code (e.g. B274, K162): where it leads, lifetime, total and per-jump mass.",
    input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { name: "my_pilot",
    description: "The member who wrote the latest message: where they are, what they fly, and their trained skills (only what their Atlas login lets the planner read).",
    input_schema: { type: "object", properties: { skills: { type: "boolean", description: "include the skill list" } } } },
  { name: "org_chain",
    description: "The org's shared N-Space Survey wormhole chain: known connections, signatures and notes.",
    input_schema: { type: "object", properties: {} } },
  { name: "jspace_scans",
    description: "The org's J-Space Survey planet scans for one wormhole system: resource density per planet and resource.",
    input_schema: { type: "object", properties: { system: { type: "string" } }, required: ["system"] } },
];

export const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 4 };

/* pilots get a number of replies a day, so one member cannot run up the bill */
export const quotaKey = (pilotId, now = new Date()) => `planq:${now.toISOString().slice(0, 10)}:${pilotId}`;

/* the text of Claude's final turn */
export const replyText = content => (content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
