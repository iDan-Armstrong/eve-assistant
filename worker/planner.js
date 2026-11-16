/* Mission planner, the relay side: org-only endpoints, the calls to Claude
   (Anthropic Messages API) and the read-only tools Claude may use.

   POST /planner  body {"token", "action", ...}
     state                          -> {live, ready, orgs: [{id, name}], daily, usedToday}
     list    {org}                  -> {plans: [{id, title, kind, by, updated, status, n}]}
     get     {org, id}              -> {plan}
     new     {org, kind, title, objective, where, who, when, risk} -> {plan}
     say     {org, id, text}        -> {plan}
     archive {org, id}              -> {plan}

   Who may use it: approved members of the orgs named in PLANNER_ORGS (comma
   separated org ids). The Atlas operator may use it in those orgs too.
   PLANNER_LIVE = "1" switches it on; ANTHROPIC_API_KEY (a Worker secret)
   must be set for it to answer. PLANNER_MODEL picks the Claude model,
   PLANNER_DAILY the replies each pilot may ask for per day (default 40),
   PLANNER_WEB = "0" turns off Claude's web search.

   Plans are kept in KV under plan:<org>:<id>, a year at most. The pilot's
   EVE token is used only during the request, for the my_pilot tool, and
   is never stored or sent to Claude. */

import { KINDS, MAX_TEXT, MAX_ROUNDS, TOOLS, WEB_SEARCH, briefText, clean, listMeta, makeBrief, newId,
         quotaKey, replyText, systemPrompt, toApiMessages } from "./planner_core.js";
import KSPACE from "../web/data/jspace/kspace.json";
import JSYSTEMS from "../web/data/jspace/systems.json";
import CLASSES from "../web/data/jspace/classes.json";
import WORMHOLES from "../web/data/jspace/wormholes.json";

const ESI = "https://esi.evetech.net";
const UA = "eve-assistant New Eden Atlas relay (+https://github.com/iDan-Armstrong/eve-assistant)";
const ESI_H = { "X-Compatibility-Date": "2025-09-30", "User-Agent": UA };
const SITE = "https://idan-armstrong.github.io/eve-assistant/";
const PLAN_TTL = 365 * 86400;
const BUSY_MS = 150000;
const DEFAULT_MODEL = "claude-sonnet-5-5";

const HUBS = {
  Jita: { region: 10000002, station: 60003760 }, Amarr: { region: 10000043, station: 60008494 },
  Dodixie: { region: 10000032, station: 60011866 }, Rens: { region: 10000030, station: 60004588 },
  Hek: { region: 10000042, station: 60005686 },
};

/* ---- names and static facts --------------------------------------------- */
let byName = null;
function systemId(name) {
  if (!byName) {
    byName = new Map();
    for (const [id, v] of Object.entries(KSPACE.s)) byName.set(v[0].toLowerCase(), +id);
    for (const [id, v] of Object.entries(JSYSTEMS)) byName.set(v[0].toLowerCase(), +id);
  }
  const id = byName.get(String(name || "").trim().toLowerCase());
  if (!id) throw new Error(`no solar system called "${name}"`);
  return id;
}
const sysName = id => (KSPACE.s[id] || JSYSTEMS[id] || [`system ${id}`])[0];
const secOf = id => (KSPACE.s[id] ? KSPACE.s[id][1] : null);
const band = s => (s === null ? "wormhole" : s >= 0.45 ? "highsec" : s > 0 ? "lowsec" : "nullsec");

async function esi(path, opts = {}) {
  const r = await fetch(`${ESI}${path}`, { headers: { ...ESI_H, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    method: opts.body ? "POST" : "GET", body: opts.body ? JSON.stringify(opts.body) : undefined,
    cf: opts.body ? undefined : { cacheTtl: opts.ttl ?? 300 } });
  if (!r.ok) throw new Error(`ESI ${path}: ${r.status}`);
  return r.json();
}
async function names(ids) {
  const out = {};
  const list = [...new Set(ids.filter(Boolean).map(Number))];
  for (let i = 0; i < list.length; i += 900) {
    for (const n of await esi("/universe/names", { body: list.slice(i, i + 900) }).catch(() => [])) out[n.id] = n.name;
  }
  return out;
}
const siteJson = (path, ttl = 900) => fetch(SITE + path, { cf: { cacheTtl: ttl } }).then(r => (r.ok ? r.json() : null)).catch(() => null);

let lastHour = null;
async function lastHourCounts() {
  if (lastHour && Date.now() - lastHour.at < 300000) return lastHour;
  const [kills, jumps] = await Promise.all([esi("/universe/system_kills"), esi("/universe/system_jumps")]);
  const k = {}, j = {};
  for (const r of kills) k[r.system_id] = [r.ship_kills || 0, r.pod_kills || 0, r.npc_kills || 0];
  for (const r of jumps) j[r.system_id] = r.ship_jumps || 0;
  lastHour = { at: Date.now(), k, j };
  return lastHour;
}

/* ---- the tools ---------------------------------------------------------- */
const hourList = (arr, pick) => arr.map((v, h) => [h, v]).filter(([, v]) => v !== null)
  .sort((a, b) => pick * (a[1] - b[1])).slice(0, 3).map(([h]) => `${String(h).padStart(2, "0")}:00`);

async function lookupSystem({ name }) {
  const id = systemId(name);
  if (JSYSTEMS[id]) {
    const [n, cls, effect, , , planets, moons] = JSYSTEMS[id];
    const out = { name: n, id, space: "wormhole", class: CLASSES[cls] || String(cls), effect: effect || "none",
                  planets, moons, note: "CCP publishes no jumps or NPC kills for wormhole space." };
    const act = await siteJson("data/live/wormhole_activity.json", 3600);
    const a = act && act.systems[id];
    out.activity30d = a ? { playerKills: a.t[0], structuresKilled: a.t[1], pods: a.t[2], lostToNpcs: a.t[3], lastKill: a.last,
                            busiestHoursUtc: hourList(a.h, -1), victimCorps: a.victims, hunterCorps: a.hunters }
                        : "no killmails in the last 30 days";
    return out;
  }
  const [n, sec, region] = KSPACE.s[id];
  const lh = await lastHourCounts().catch(() => null);
  const out = { name: n, id, security: sec, space: band(sec), region,
                neighbours: (KSPACE.g[id] || []).map(x => `${sysName(x)} (${secOf(x)})`) };
  if (lh) out.lastHour = { jumps: lh.j[id] || 0, shipKills: (lh.k[id] || [0])[0], podKills: (lh.k[id] || [0, 0])[1], npcKills: (lh.k[id] || [0, 0, 0])[2] };
  if (band(sec) === "lowsec") {
    const doc = await siteJson("data/live/lowsec_traffic.json", 3600);
    const s = doc && doc.systems[id];
    if (s && doc.hoursHeld) {
      out.traffic = { hoursRecorded: doc.hoursHeld, jumpsPerDay: Math.round(s.t[0] / doc.hoursHeld * 24),
                      pilotKillsPerWeek: +(s.t[1] / doc.hoursHeld * 168).toFixed(1), asteroidBelts: s.b, nocxiumOres: s.o,
                      quietestHoursUtc: hourList(s.h, 1), busiestHoursUtc: hourList(s.h, -1) };
    }
  }
  return out;
}

/* Dijkstra over the stargate graph; CCP-style weights for secure / insecure */
function route(from, to, prefer = "shortest") {
  const cost = id => {
    const hs = (secOf(id) ?? 0) >= 0.45;
    return prefer === "secure" ? (hs ? 1 : 50000) : prefer === "insecure" ? (hs ? 50000 : 1) : 1;
  };
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const queue = [[0, from]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const v of KSPACE.g[u] || []) {
      const nd = d + cost(v);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); queue.push([nd, v]); }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}

async function planRoute({ from, to, prefer }) {
  const a = systemId(from), b = systemId(to);
  if (!KSPACE.s[a] || !KSPACE.s[b]) return { error: "Routes are for known space; wormhole travel depends on the current chain (see org_chain)." };
  const path = route(a, b, prefer);
  if (!path) return { error: "no gate route between those systems" };
  const lh = await lastHourCounts().catch(() => null);
  const steps = path.map(id => {
    const k = lh ? (lh.k[id] || [0, 0]) : null;
    return `${sysName(id)} ${secOf(id)}` + (k && (k[0] || k[1]) ? ` [${k[0]} ships, ${k[1]} pods killed last hour]` : "");
  });
  const bands = path.map(id => band(secOf(id)));
  return { jumps: path.length - 1, prefer: prefer || "shortest", lowsecSystems: bands.filter(x => x === "lowsec").length,
           nullsecSystems: bands.filter(x => x === "nullsec").length, route: steps };
}

async function recentKills({ system, hours = 24 }) {
  const id = systemId(system);
  const secs = Math.min(168, Math.max(1, Math.round(hours))) * 3600;
  const r = await fetch(`https://zkillboard.com/api/kills/systemID/${id}/pastSeconds/${secs}/`,
    { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" }, cf: { cacheTtl: 300 } });
  if (!r.ok) return { error: `zKillboard answered ${r.status}` };
  const list = (await r.json()).slice(0, 12);
  if (!list.length) return { system: sysName(id), hours, kills: 0 };
  const kms = (await Promise.all(list.map(k => esi(`/killmails/${k.killmail_id}/${k.zkb.hash}/`, { ttl: 86400 })
    .then(km => ({ km, zkb: k.zkb })).catch(() => null)))).filter(Boolean);
  const ids = [];
  for (const { km } of kms) {
    ids.push(km.victim.ship_type_id, km.victim.corporation_id, km.victim.alliance_id);
    for (const a of km.attackers.slice(0, 3)) ids.push(a.ship_type_id, a.corporation_id);
  }
  const nm = await names(ids);
  return { system: sysName(id), hours, shown: kms.length, kills: kms.map(({ km, zkb }) => ({
    at: km.killmail_time, ship: nm[km.victim.ship_type_id], victimCorp: nm[km.victim.corporation_id],
    victimAlliance: nm[km.victim.alliance_id], valueIsk: Math.round(zkb.totalValue || 0), npcKill: !!zkb.npc,
    attackers: km.attackers.length,
    topAttackers: km.attackers.slice(0, 3).map(a => `${nm[a.ship_type_id] || "?"} (${nm[a.corporation_id] || "NPC"})`) })) };
}

async function marketPrices({ items, hub = "Jita" }) {
  const h = HUBS[hub] || HUBS.Jita;
  const ids = await esi("/universe/ids", { body: (items || []).slice(0, 10).map(String) });
  const types = ids.inventory_types || [];
  const out = { hub, prices: {}, unknown: (items || []).filter(n => !types.some(t => t.name.toLowerCase() === String(n).toLowerCase())) };
  await Promise.all(types.map(async t => {
    const orders = await esi(`/markets/${h.region}/orders?order_type=all&type_id=${t.id}`, { ttl: 600 }).catch(() => []);
    const here = orders.filter(o => o.location_id === h.station);
    const sells = here.filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price);
    const buys = here.filter(o => o.is_buy_order).sort((a, b) => b.price - a.price);
    out.prices[t.name] = { bestSell: sells[0]?.price ?? null, sellVolume: sells.slice(0, 5).reduce((s, o) => s + o.volume_remain, 0),
                           bestBuy: buys[0]?.price ?? null, buyVolume: buys.slice(0, 5).reduce((s, o) => s + o.volume_remain, 0) };
  }));
  return out;
}

function wormholeType({ code }) {
  const c = String(code || "").trim().toUpperCase();
  const w = WORMHOLES[c];
  if (!w) return { error: `unknown wormhole code ${c}` };
  return { code: c, leadsTo: CLASSES[w.to] || String(w.to), lifetimeHours: w.life, totalMassKg: w.mass,
           maxJumpMassKg: w.jump, massRegenKg: w.regen || 0 };
}

async function myPilot({ skills }, ctx) {
  const { who, token, authed } = ctx;
  const out = { name: who.name };
  const has = s => who.scp.includes(s);
  const ids = [];
  if (has("esi-location.read_location.v1")) {
    const loc = await authed(`/characters/${who.id}/location`, token).catch(() => null);
    if (loc) { out.system = sysName(loc.solar_system_id); out.security = secOf(loc.solar_system_id); out.docked = !!(loc.station_id || loc.structure_id); }
  }
  if (has("esi-location.read_ship_type.v1")) {
    const ship = await authed(`/characters/${who.id}/ship`, token).catch(() => null);
    if (ship) { ids.push(ship.ship_type_id); out.shipTypeId = ship.ship_type_id; out.shipName = ship.ship_name; }
  }
  let sk = null;
  if (skills && has("esi-skills.read_skills.v1")) {
    sk = await authed(`/characters/${who.id}/skills`, token).catch(() => null);
    if (sk) ids.push(...sk.skills.map(s => s.skill_id));
  } else if (skills) out.skills = "this pilot's Atlas login does not include the skills scope";
  const nm = await names(ids);
  if (out.shipTypeId) { out.ship = nm[out.shipTypeId]; delete out.shipTypeId; }
  if (sk) {
    out.totalSp = sk.total_sp;
    out.skills = sk.skills.filter(s => s.active_skill_level > 0).map(s => `${nm[s.skill_id] || s.skill_id} ${s.active_skill_level}`).sort();
  }
  return out;
}

async function orgChain(_, ctx) {
  const r = await ctx.room(ctx.env, `org:${ctx.org}`).fetch("https://room/chain-get",
    { method: "POST", body: JSON.stringify({ ops: [] }) });
  const { chain } = await r.json();
  const now = Date.now();
  const links = Object.values(chain.links || {}).filter(l => !l.expires || l.expires > now).map(l => ({
    between: [sysName(l.a), sysName(l.b)], code: l.code || "unknown", sigs: [l.sigA, l.sigB],
    size: l.size || undefined, mass: l.mass || undefined, life: l.life || undefined,
    hoursLeft: l.expires ? Math.round((l.expires - now) / 36e5) : undefined }));
  const notes = Object.fromEntries(Object.entries(chain.notes || {}).map(([s, n]) => [sysName(+s), n.text]));
  const text = JSON.stringify({ links, notes });
  return text.length > 9000 ? { links: links.slice(0, 60), truncated: true } : JSON.parse(text);
}

async function jspaceScans({ system }, ctx) {
  const id = systemId(system);
  if (!JSYSTEMS[id]) return { error: "J-Space Survey scans are for wormhole systems" };
  const r = await ctx.room(ctx.env, `org:${ctx.org}`).fetch("https://room/jp-get",
    { method: "POST", body: JSON.stringify({ systems: [id] }) });
  const store = (await r.json())[id] || {};
  const bodies = await siteJson(`data/jspace/bodies/${id % 16}.json`, 86400);
  const planets = (bodies && bodies[id] && bodies[id].planets) || [];
  const roman = n => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"][n] || String(n);
  const label = pid => { const p = planets.find(x => String(x[0]) === String(pid)); return p ? `${sysName(id)} ${roman(p[1])}` : `planet ${pid}`; };
  const out = {};
  for (const [pid, res] of Object.entries(store)) {
    out[label(pid)] = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, `${v.d}% (resolution ${v.res}, by ${v.by})`]));
  }
  return { system: sysName(id), planets: Object.keys(out).length ? out : "no planets scanned yet" };
}

const RUN = { lookup_system: lookupSystem, plan_route: planRoute, recent_kills: recentKills, market_prices: marketPrices,
              wormhole_type: wormholeType, my_pilot: myPilot, org_chain: orgChain, jspace_scans: jspaceScans };

/* a short line for the page: what Claude checked */
function usedLabel(name, input) {
  const i = input || {};
  switch (name) {
    case "lookup_system": return `system ${i.name}`;
    case "plan_route": return `route ${i.from} to ${i.to}`;
    case "recent_kills": return `kills in ${i.system}`;
    case "market_prices": return `prices (${(i.items || []).length} items)`;
    case "wormhole_type": return `wormhole ${i.code}`;
    case "my_pilot": return "your pilot";
    case "org_chain": return "org chain";
    case "jspace_scans": return `scans of ${i.system}`;
    case "web_search": return `web: ${i.query || ""}`;
    default: return name;
  }
}

/* ---- Claude ------------------------------------------------------------- */
async function askClaude(env, system, messages, ctx) {
  const tools = env.PLANNER_WEB === "0" ? TOOLS : [...TOOLS, WEB_SEARCH];
  const convo = messages.map(m => ({ ...m }));
  const used = [];
  for (let round = 0; round < MAX_ROUNDS + 2; round++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.PLANNER_MODEL || DEFAULT_MODEL, max_tokens: 3000, system, messages: convo,
                             tools: round >= MAX_ROUNDS ? tools.filter(t => t.type) : tools }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Claude: ${data.error?.message || r.status}`);
    for (const b of data.content || []) {
      if (b.type === "server_tool_use" || b.type === "tool_use") used.push(usedLabel(b.name, b.input));
    }
    if (data.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: data.content }); continue; }
    if (data.stop_reason !== "tool_use") return { text: replyText(data.content) || "(no answer)", used };
    convo.push({ role: "assistant", content: data.content });
    const results = [];
    for (const b of data.content.filter(x => x.type === "tool_use")) {
      let content;
      try { content = JSON.stringify(await RUN[b.name](b.input || {}, ctx)); }
      catch (e) { content = JSON.stringify({ error: e.message }); }
      results.push({ type: "tool_result", tool_use_id: b.id, content: content.slice(0, 20000) });
    }
    convo.push({ role: "user", content: results });
  }
  throw new Error("Claude kept calling tools without answering; try asking again.");
}

/* ---- the endpoint ------------------------------------------------------- */
const plannerOrgs = env => (env.PLANNER_ORGS || "").split(",").map(s => s.trim()).filter(Boolean);
const daily = env => +env.PLANNER_DAILY || 40;

async function gate(env, d, who, org) {
  if (!plannerOrgs(env).includes(String(org))) throw new Error("The mission planner is not open to that org.");
  const c = await d.orgCall(env, { action: "check", org: String(org), who: { id: who.id, name: who.name }, isOperator: d.isOperator(who, env) });
  if (!c.ok) throw new Error("Not an approved member of that org.");
  return c;
}
const planKey = (org, id) => `plan:${org}:${id}`;
async function loadPlan(env, org, id) {
  const p = await env.SIGHTINGS.get(planKey(org, String(id).replace(/[^a-z0-9]/g, "")), "json");
  if (!p) throw new Error("That plan does not exist.");
  return p;
}
const savePlan = (env, p) => env.SIGHTINGS.put(planKey(p.org, p.id), JSON.stringify(p), { expirationTtl: PLAN_TTL, metadata: listMeta(p) });

async function reply(env, d, plan, who, token, orgName) {
  if (env.PLANNER_LIVE !== "1") throw new Error("The mission planner is offline right now.");
  if (!env.ANTHROPIC_API_KEY) throw new Error("The mission planner has no Claude API key yet.");
  const qk = quotaKey(who.id);
  const usedToday = +(await env.SIGHTINGS.get(qk)) || 0;
  if (usedToday >= daily(env)) throw new Error(`You have used today's ${daily(env)} planner replies; more tomorrow (UTC).`);
  if (plan.busyUntil && plan.busyUntil > Date.now()) throw new Error("The planner is still answering the last message in this plan.");
  plan.busyUntil = Date.now() + BUSY_MS;
  await savePlan(env, plan);
  try {
    const system = systemPrompt({ org: orgName, today: new Date().toISOString().slice(0, 10), pilot: who.name });
    const ctx = { env, who, token, org: plan.org, room: d.room, authed: d.esiAuthed };
    const { text, used } = await askClaude(env, system, toApiMessages(plan.messages), ctx);
    plan.messages.push({ role: "assistant", by: "Planner", text, at: new Date().toISOString(), used: [...new Set(used)].slice(0, 20) });
    await env.SIGHTINGS.put(qk, String(usedToday + 1), { expirationTtl: 2 * 86400 });
  } finally {
    plan.busyUntil = 0;
    plan.updated = new Date().toISOString();
    await savePlan(env, plan);
  }
  return plan;
}

export async function planner(body, env, d) {
  const who = await d.verify(body.token, env);
  const token = body.token;
  switch (body.action) {
    case "state": {
      const mine = (await d.orgCall(env, { action: "mine", who: { id: who.id, name: who.name }, isOperator: d.isOperator(who, env) })).orgs || [];
      const allowed = plannerOrgs(env);
      return { live: env.PLANNER_LIVE === "1", ready: !!env.ANTHROPIC_API_KEY,
               orgs: mine.filter(o => allowed.includes(String(o.id)) && o.role !== "pending").map(o => ({ id: o.id, name: o.name })),
               daily: daily(env), usedToday: +(await env.SIGHTINGS.get(quotaKey(who.id))) || 0,
               kinds: Object.entries(KINDS).map(([k, v]) => ({ id: k, ...v })) };
    }
    case "list": {
      await gate(env, d, who, body.org);
      const plans = [];
      let cursor;
      do {
        const page = await env.SIGHTINGS.list({ prefix: `plan:${body.org}:`, cursor });
        for (const k of page.keys) {
          const m = k.metadata || {};
          plans.push({ id: k.name.split(":").pop(), title: m.t, kind: m.k, by: m.b, updated: m.u, status: m.s, n: m.n });
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      plans.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      return { plans };
    }
    case "get": {
      await gate(env, d, who, body.org);
      return { plan: await loadPlan(env, body.org, body.id) };
    }
    case "new": {
      const c = await gate(env, d, who, body.org);
      const { kind, title, brief } = makeBrief(body);
      const now = new Date().toISOString();
      const plan = { id: newId(), org: String(body.org), kind, title, by: who.name, created: now, updated: now, status: "open",
                     brief, messages: [{ role: "user", by: who.name, text: briefText(kind, brief), at: now }] };
      return { plan: await reply(env, d, plan, who, token, c.name) };
    }
    case "say": {
      const c = await gate(env, d, who, body.org);
      const plan = await loadPlan(env, body.org, body.id);
      const text = clean(body.text, MAX_TEXT);
      if (!text) throw new Error("Write something first.");
      if (plan.status !== "open") throw new Error("This plan is archived.");
      plan.messages.push({ role: "user", by: who.name, text, at: new Date().toISOString() });
      return { plan: await reply(env, d, plan, who, token, c.name) };
    }
    case "archive": {
      await gate(env, d, who, body.org);
      const plan = await loadPlan(env, body.org, body.id);
      if (plan.by !== who.name && !d.isOperator(who, env)) throw new Error("Only the pilot who started a plan can archive it.");
      plan.status = body.reopen ? "open" : "archived";
      plan.updated = new Date().toISOString();
      await savePlan(env, plan);
      return { plan };
    }
    default:
      throw new Error("Unknown planner action.");
  }
}

export const _test = { route, systemId, usedLabel, wormholeType };
