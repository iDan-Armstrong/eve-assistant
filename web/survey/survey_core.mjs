/* N-Space Survey: pastes, directional scans, hole life, the way home, the
   lasting knowledge base, and surveyor points and badges.

   Pure functions (no DOM, no network), imported by the survey page, by the
   Atlas relay (worker/index.js) and by `node --test`. The relay awards points
   from the same functions using the verified pilot, so a browser cannot
   grant itself points on the corp board. */
import { HOUR, isJ, linkKey, parseShowInfo, parseSigs } from "./chain_core.mjs";

const DAY = 24 * HOUR;

/* ---- paste router -------------------------------------------------------
   One paste box (and the Survey Link helper) take whatever the pilot copied
   and work out what it is. Anything that is not one of these is ignored. */
const SIG_ROW = /(^|\t)[A-Z]{3}-\d{3}\t/m;
const DIST = /^(-|[\d.,\s ]+\s?(m|km|AU))$/;
export function classifyPaste(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (SIG_ROW.test(t)) {
    const sigs = parseSigs(t);
    if (sigs.length) return { kind: "sigs", sigs };
  }
  const rows = parseDscan(t);
  if (rows.length && rows.length >= Math.ceil(t.split(/\r?\n/).filter(Boolean).length * 0.6)) {
    return { kind: "dscan", rows };
  }
  if (/wormhole/i.test(t) && /(reliable lifetime|mass stability|maximum ship size|natural lifetime|cycle of decay|stability|ships can pass|smallest ships)/i.test(t)) {
    const info = parseShowInfo(t);
    if (Object.keys(info).length) return { kind: "showinfo", info };
  }
  return null;
}

/* ---- directional scan ---------------------------------------------------
   Copying the d-scan window gives one tab separated row per object:
     typeID  Name  Type  Distance        (current client)
     Name  Type  Distance                (older copies)
   Distance is "-" when the object is out of range of the readout. */
export function parseDist(s) {
  const t = String(s || "").replace(/ /g, " ").trim();
  const m = t.match(/^([\d.,\s]+)\s?(m|km|AU)$/);
  if (!m) return null;
  let num = m[1].replace(/\s/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(num)) num = num.replace(/[.,]/g, "");   // 1,234 or 1.234 thousands
  else num = num.replace(",", ".");
  const v = parseFloat(num);
  if (!Number.isFinite(v)) return null;
  return m[2] === "m" ? v / 1000 : m[2] === "AU" ? v * 1.495978707e8 : v;   // km
}
export function parseDscan(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const c = raw.split("\t").map(x => x.trim());
    if (c.length < 3 || !DIST.test(c[c.length - 1])) continue;
    const hasId = c.length >= 4 && /^\d+$/.test(c[0]);
    const [typeId, name, type] = hasId ? [+c[0], c[1], c[2]] : [null, c[0], c[1]];
    out.push({ typeId, name, type, km: parseDist(c[c.length - 1]) });
  }
  return out;
}

/* summary kept in history: counts by kind, ship types, structures, holes.
   scanTypes: {typeId: [name, group, cat]}; typeByName: Map(lowercase name -> typeId) */
export function summarizeDscan(rows, scanTypes, typeByName) {
  const s = { total: rows.length, cats: {}, groups: {}, ships: {}, structures: [], holes: 0, onGrid: 0 };
  for (const r of rows) {
    const id = r.typeId ?? typeByName?.get(String(r.type).toLowerCase()) ?? null;
    const info = id != null ? scanTypes[id] : null;
    if (r.km != null && r.km < 10000) s.onGrid++;
    if (/^wormhole\b/i.test(r.type) || /wormhole/i.test(r.name) && !info) { s.holes++; continue; }
    if (!info) { s.cats.other = (s.cats.other || 0) + 1; continue; }
    const [tname, group, cat] = info;
    s.cats[cat] = (s.cats[cat] || 0) + 1;
    if (cat === "S") {
      s.ships[tname] = (s.ships[tname] || 0) + 1;
      s.groups[group] = (s.groups[group] || 0) + 1;
    } else if (cat === "U" || (cat === "P" && group === "Control Tower")) {
      s.structures.push([tname, r.name]);       // citadels and other Upwell structures, POS towers
    } else if (cat === "P") {
      s.posModules = (s.posModules || 0) + 1;   // batteries, arrays, hangars: part of a tower
    }
  }
  return s;
}

/* ---- hole life: what is guaranteed, and the latest it can last -----------
   Show Info gives a band, read when it was pasted (lifeAt):
     fresh  "has not yet begun its natural cycle of decay" : at least ~24 h left
     decay  "beginning to decay"                           : 4 h to 24 h left
     eol    "reaching the end of its natural lifetime"     : under 4 h left
   lo = the time it is guaranteed open until (null = unknown, check Show Info)
   hi = the latest it can still be open (also used to expire the link). */
export function lifeBounds(link, wormholes) {
  const typeLife = link.code && wormholes?.[link.code]?.life;
  const at = link.lifeAt;
  const known = at !== null && at !== undefined;
  let lo = null;
  if (known && link.life === "eol") lo = at;
  else if (known && link.life === "decay") lo = at + 4 * HOUR;
  else if (known && link.life === "fresh") lo = at + (typeLife && typeLife < 24 ? 4 : 24) * HOUR;
  const hi = link.expires ?? null;
  if (lo != null && hi != null && lo > hi) lo = hi;
  return { lo, hi };
}

/* the way from `from` to `to`: wormhole links of the chain plus, when given,
   known-space stargates ({id: [ids]}). Returns the steps as link keys, with
   null for a gate jump, or null when there is no way (breadth first) */
export function pathBetween(chain, from, to, gates = null) {
  if (from === to) return [];
  const adj = new Map();
  const add = (x, y, key) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push([y, key]); };
  for (const [key, l] of Object.entries(chain.links)) { add(l.a, l.b, key); add(l.b, l.a, key); }
  const prev = new Map([[from, null]]), q = [from];
  for (let i = 0; i < q.length; i++) {
    const v = q[i];
    const next = [...(adj.get(v) || []), ...((gates && gates[String(v)]) || []).map(w => [w, null])];
    for (const [y, key] of next) {
      if (prev.has(y)) continue;
      prev.set(y, [v, key]);
      if (y === to) {
        const keys = [];
        for (let cur = to; prev.get(cur); cur = prev.get(cur)[0]) keys.unshift(prev.get(cur)[1]);
        return keys;
      }
      q.push(y);
    }
  }
  return null;
}

/* the way home: the weakest guaranteed life among the wormholes on the path,
   holes whose age is unknown, and holes at critical mass. Gate jumps (when
   gates are given) count as jumps but never close */
export function wayHome(chain, here, home, wormholes, now, gates = null) {
  const steps = pathBetween(chain, here, home, gates);
  if (steps === null) return { connected: false };
  const keys = steps.filter(k => k !== null);
  let lo = Infinity, weakest = null;
  const unknown = [], crit = [];
  for (const k of keys) {
    const l = chain.links[k];
    const b = lifeBounds(l, wormholes);
    if (b.lo == null) unknown.push(k);
    else if (b.lo < lo) { lo = b.lo; weakest = k; }
    if (l.mass === "crit") crit.push(k);
  }
  return { connected: true, keys, jumps: steps.length, gateJumps: steps.length - keys.length,
           lo: keys.length && lo !== Infinity ? lo : null, left: lo !== Infinity ? lo - now : null,
           weakest, unknown, crit };
}

/* ---- knowledge base: what stays true about a system ---------------------
   kb: {systemId: {visit: {at, by}, statics: {CODE: {n, first, last, by}},
                   structures: {"type|name": {type, name, first, last, by}},
                   dscans: [{at, by, sum}]}}                                   */
export const DSCAN_KEEP = 40;
export const DSCAN_DAYS = 30;
export const STATIC_SURE = 2;          // seen this many times: treat as the system's static

export function applyKbOp(kb, op, now = op.at ?? Date.now()) {
  const sys = String(op.system);
  const rec = kb[sys] = kb[sys] || { statics: {}, structures: {}, dscans: [] };
  rec.statics = rec.statics || {}; rec.structures = rec.structures || {}; rec.dscans = rec.dscans || [];
  const events = [];
  if (op.kind === "probe") {
    rec.probedAt = now;                       // a probe scan of the whole system
    rec.probedBy = op.by || "";
  } else if (op.kind === "claim") {
    rec.claim = op.until ? { by: op.by || "", until: op.until } : undefined;   // reserved in a survey batch
  } else if (op.kind === "visit") {
    if (!rec.visit) { rec.visit = { at: now, by: op.by || "" }; if (isJ(+sys)) events.push({ a: "first_visit" }); }
    events.push({ a: "arrive", system: +sys });
  } else if (op.kind === "static") {
    const code = String(op.code || "").toUpperCase();
    if (!code || code === "K162") return { kb, events };
    const s = rec.statics[code];
    if (!s) { rec.statics[code] = { n: 1, first: now, last: now, by: op.by || "" }; events.push({ a: "static_found" }); }
    else if (now - s.last > HOUR) { s.n++; s.last = now; }
  } else if (op.kind === "dscan") {
    const sum = op.sum || { total: 0, structures: [] };
    let fresh = 0;
    for (const [type, name] of sum.structures || []) {
      const k = `${type}|${name}`;
      if (!rec.structures[k]) { rec.structures[k] = { type, name, first: now, last: now, by: op.by || "" }; fresh++; }
      else rec.structures[k].last = now;
    }
    rec.dscans.unshift({ at: now, by: op.by || "", sum });
    rec.dscans = rec.dscans.filter(d => now - d.at < DSCAN_DAYS * DAY).slice(0, DSCAN_KEEP);
    events.push({ a: "dscan" });
    if (fresh) events.push({ a: "structure_new", n: fresh });
  }
  return { kb, events };
}

/* statics: codes seen leading out of a system, most seen first */
export function staticsOf(kbRec) {
  return Object.entries(kbRec?.statics || {}).sort((a, b) => b[1].n - a[1].n)
    .map(([code, s]) => ({ code, n: s.n, sure: s.n >= STATIC_SURE }));
}

/* ---- points and badges ---------------------------------------------------- */
export const POINTS = {
  jump_link: 10,       // a new wormhole connection found by flying it
  confirm: 5,          // confirming a gate-less move was a wormhole
  first_visit: 25,     // first time anyone in the corp surveyed this J-system
  new_sigs: 2,         // per signature not seen before in that system
  hole_typed: 5,       // naming a hole's type
  hole_status: 3,      // a Show Info read (age, mass, size)
  static_found: 15,    // first record of a static for a system
  dscan: 3,            // a directional scan saved to history
  structure_new: 10,   // per structure seen in a system for the first time
  note: 2,             // the first note on a system
};
export const PER_PASTE_CAP = { new_sigs: 10 };                   // count cap per event
export const DAILY_CAP = { new_sigs: 80, dscan: 45, hole_status: 30, note: 10 };   // points per day
const SCAN_ACTIONS = new Set(["new_sigs", "dscan"]);

/* events a chain op would earn, worked out BEFORE it is applied */
export function chainEvents(chain, op) {
  const ev = [];
  if (op.kind === "link") {
    const key = op.key || linkKey(op.rec.a, op.rec.b);
    const old = chain.links[key];
    if (!old && op.rec?.source === "jump" && op.rec?.confirmed !== false) ev.push({ a: "jump_link" });
    if (old && !old.confirmed && op.rec?.confirmed === true) ev.push({ a: "confirm" });
    if (op.rec?.code && op.rec.code !== "K162" && !old?.code) ev.push({ a: "hole_typed" });
    if (old && (op.rec?.life || op.rec?.mass) && (op.rec.life !== old.life || op.rec.mass !== old.mass
        || (op.rec.lifeAt && op.rec.lifeAt - (old.lifeAt || 0) > HOUR))) ev.push({ a: "hole_status" });
  } else if (op.kind === "sigs") {
    const known = chain.sigs[String(op.system)] || {};
    const n = (op.parsed || []).filter(p => !known[p.id]).length;
    if (n) ev.push({ a: "new_sigs", n });
  } else if (op.kind === "note") {
    if (!chain.notes[String(op.system)]?.text && String(op.text || "").trim()) ev.push({ a: "note" });
  }
  return ev;
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/* add events to one pilot's record in the ledger. ctx.classOf(systemId) gives
   the class label for visit badges. Returns {points, badges: [new badge ids]} */
export function award(ledger, pilot, name, events, now, ctx = {}) {
  const r = ledger[pilot] = ledger[pilot] || { name, pts: 0, counts: {}, classes: {}, days: [], night: 0, badges: {} };
  r.name = name || r.name;
  const today = dayOf(now);
  if (!r.day || r.day.date !== today) r.day = { date: today, pts: {} };
  let gained = 0;
  for (const e of events) {
    if (e.a === "arrive") {
      const cls = ctx.classOf ? ctx.classOf(e.system) : null;
      if (cls) r.classes[cls] = 1;
      continue;
    }
    const n = Math.min(e.n || 1, PER_PASTE_CAP[e.a] || Infinity);
    let pts = (POINTS[e.a] || 0) * n;
    const cap = DAILY_CAP[e.a];
    if (cap != null) pts = Math.max(0, Math.min(pts, cap - (r.day.pts[e.a] || 0)));
    r.counts[e.a] = (r.counts[e.a] || 0) + (e.n || 1);
    r.day.pts[e.a] = (r.day.pts[e.a] || 0) + pts;
    r.pts += pts;
    gained += pts;
    if (SCAN_ACTIONS.has(e.a) && new Date(now).getUTCHours() < 6) r.night++;
  }
  if (events.some(e => e.a !== "arrive") && r.days[r.days.length - 1] !== today) r.days = [...r.days, today].slice(-60);
  r.last = now;
  const fresh = [];
  for (const b of BADGES) if (!r.badges[b.id] && b.test(r)) { r.badges[b.id] = now; fresh.push(b.id); }
  return { points: gained, badges: fresh };
}

function streak(days) {
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev && Date.parse(d) - Date.parse(prev) === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}
const c = (r, a) => r.counts[a] || 0;
export const BADGES = [
  { id: "first_light", short: "FL", name: "First Light", desc: "Map your first wormhole by flying it", test: r => c(r, "jump_link") >= 1 },
  { id: "cartographer_1", short: "C1", name: "Cartographer I", desc: "10 wormholes mapped", test: r => c(r, "jump_link") >= 10 },
  { id: "cartographer_2", short: "C2", name: "Cartographer II", desc: "50 wormholes mapped", test: r => c(r, "jump_link") >= 50 },
  { id: "cartographer_3", short: "C3", name: "Cartographer III", desc: "200 wormholes mapped", test: r => c(r, "jump_link") >= 200 },
  { id: "signal_hunter", short: "SIG", name: "Signal Hunter", desc: "100 new signatures recorded", test: r => c(r, "new_sigs") >= 100 },
  { id: "typecaster", short: "TYP", name: "Typecaster", desc: "25 holes identified by type", test: r => c(r, "hole_typed") >= 25 },
  { id: "static_mind", short: "STA", name: "Static Mind", desc: "10 statics found", test: r => c(r, "static_found") >= 10 },
  { id: "eyes_on", short: "EYE", name: "Eyes On", desc: "25 directional scans saved", test: r => c(r, "dscan") >= 25 },
  { id: "structure_spotter", short: "STR", name: "Structure Spotter", desc: "5 structures found", test: r => c(r, "structure_new") >= 5 },
  { id: "hole_keeper", short: "HK", name: "Hole Keeper", desc: "20 Show Info checks", test: r => c(r, "hole_status") >= 20 },
  { id: "deep_diver", short: "DD", name: "Deep Diver", desc: "Survey a C5 or C6", test: r => !!(r.classes.C5 || r.classes.C6) },
  { id: "full_spectrum", short: "1-6", name: "Full Spectrum", desc: "Survey every class from C1 to C6",
    test: r => ["C1", "C2", "C3", "C4", "C5", "C6"].every(k => r.classes[k]) },
  { id: "thera_traveler", short: "THR", name: "Thera Traveler", desc: "Pass through Thera", test: r => !!r.classes.Thera },
  { id: "shattered", short: "SHT", name: "Shattered", desc: "Survey a shattered frigate system", test: r => !!r.classes.C13 },
  { id: "drifter_seeker", short: "DRF", name: "Drifter Seeker", desc: "Find a Drifter system", test: r => !!r.classes.Drifter },
  { id: "night_shift", short: "NGT", name: "Night Shift", desc: "10 scans between 00:00 and 06:00 EVE time", test: r => r.night >= 10 },
  { id: "streak_7", short: "7D", name: "Seven Days Out", desc: "Survey seven days in a row", test: r => streak(r.days) >= 7 },
];
export const RANKS = [[0, "Cadet"], [100, "Surveyor"], [500, "Senior Surveyor"], [1500, "Chief Surveyor"], [5000, "Survey Master"]];
export function rankOf(pts) {
  let cur = RANKS[0], next = null;
  for (const r of RANKS) { if (pts >= r[0]) cur = r; else { next = r; break; } }
  return { name: cur[1], next: next ? { name: next[1], at: next[0] } : null };
}

/* the corp board: highest points first */
export function leaderboard(ledger) {
  return Object.entries(ledger).map(([id, r]) => ({ id, name: r.name, pts: r.pts, rank: rankOf(r.pts).name,
    badges: Object.keys(r.badges).length })).sort((a, b) => b.pts - a.pts);
}

/* ---- survey batches -------------------------------------------------------
   The next N known-space systems to probe-scan, in visiting order: nearest
   first, then nearest to that one (gate jumps), from systems nobody has
   probe-scanned within freshHours and nobody else has claimed.
   gates: {id: [ids]}; secOf(id) -> security; kb: knowledge base records */
export const BATCH_FRESH_H = 24;
export function surveyBatch({ from, gates, secOf, kb, now, me, n = 5, highsecOnly = true,
                              freshHours = BATCH_FRESH_H, maxJumps = 20 }) {
  const ok = id => {
    const sec = secOf(id);
    if (sec == null || (highsecOnly && sec < 0.45)) return false;
    const r = kb[id] || kb[String(id)];
    if (r?.probedAt && now - r.probedAt < freshHours * HOUR) return false;
    if (r?.claim && r.claim.until > now && r.claim.by !== me) return false;
    return true;
  };
  const bfs = start => {
    const dist = new Map([[start, 0]]), prev = new Map(), q = [start];
    for (let i = 0; i < q.length; i++) {
      const v = q[i];
      if (dist.get(v) >= maxJumps) continue;
      for (const w of gates[String(v)] || []) {
        if (dist.has(w)) continue;
        if (highsecOnly && (secOf(w) ?? 0) < 0.45) continue;
        dist.set(w, dist.get(v) + 1); prev.set(w, v); q.push(w);
      }
    }
    return { dist, prev };
  };
  const pathTo = (t, to) => { const p = [to]; while (t.prev.has(p[0])) p.unshift(t.prev.get(p[0])); return p; };
  const picked = [], legs = [];
  const taken = new Set();
  let cur = from;
  if (ok(cur)) { picked.push(cur); taken.add(cur); legs.push([cur]); }
  while (picked.length < n) {
    const t = bfs(cur);
    let best = null;
    for (const [id, d] of t.dist) {
      if (taken.has(id) || id === cur || !ok(id)) continue;
      const age = kb[id]?.probedAt ? now - kb[id].probedAt : Infinity;      // never scanned beats stale
      if (!best || d < best.d || (d === best.d && age > best.age)) best = { id, d, age };
    }
    if (!best) break;
    picked.push(best.id); taken.add(best.id);
    legs.push(pathTo(t, best.id).slice(1));
    cur = best.id;
  }
  const route = legs.flat();
  return { systems: picked, route, jumps: route.length - (picked[0] === from ? 1 : 0) };
}
