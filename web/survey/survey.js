/* J-Space Survey: wormhole chain mapper that feeds the New Eden Atlas.

   - Logins are the Atlas's own (shared localStorage on this origin); CCP
     returns to the Atlas page, which hands the pilot back here.
   - Where the surveyor is comes from three places: Survey Link (the helper
     reads Local chat logs, about a second after a jump), CCP's location API
     every 10 seconds, and the Root box. A move with no stargate between the
     systems becomes a link: in wormhole space at once, between two known-space
     systems only after the pilot confirms it.
   - Copies from EVE arrive through Survey Link (no click needed) or a paste
     anywhere on the page, and are routed by what they are: probe scan,
     directional scan, wormhole Show Info.
   - The chain, the knowledge base and points live in this browser. With
     "share map with corp" ticked they merge with the corp's copy on the Atlas
     relay, readable only by verified members of the same corporation, and the
     relay awards points to the verified pilot.
   - Rules for merging, expiry, parsing, life bounds and points live in
     chain_core.mjs and survey_core.mjs, shared with the relay and tested. */
import * as C from "./chain_core.mjs";
import * as X from "./survey_core.mjs";

/* In development: the page asks for a password first. A soft gate on a
   public site, not security; only a hash of the password is in the code. */
const GATE_HASH = "939c2a01242240f3140e9b33ef9791957361435131a8d544cc0a2cca4224c876";
const GATE_KEY = "atlas.survey.unlocked";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private mode */ } },
};
const K_CHAIN = "atlas.survey.chain", K_ROOT = "atlas.survey.root", K_HOME = "atlas.survey.home",
      K_SHARE = "atlas.survey.share", K_TRACK = "atlas.survey.track", K_KB = "atlas.survey.kb",
      K_SCORE = "atlas.survey.score", K_VIEW = "atlas.survey.view", K_HERE = "atlas.survey.here",
      K_PIN = "atlas.survey.pin";
const CAPSULES = new Set([670, 33328]);
const POLL_MS = 10e3, SYNC_MS = 15e3;
const LINK_URL = "http://localhost:47321/events";
const ALARMS = [[30 * 60e3, "30 minutes"], [10 * 60e3, "10 minutes"], [0, "now"]];

const S = {
  J: {}, K: { s: {}, g: {} }, WH: {}, CL: {}, ST: {}, typeByName: new Map(),
  byName: new Map(),
  chain: C.prune(store.get(K_CHAIN, C.emptyChain()), Date.now()),
  kb: store.get(K_KB, {}),
  ledger: store.get(K_SCORE, {}),
  board: [], me: null,
  pending: [], relay: "", corp: null,
  track: store.get(K_TRACK, {}),          // pilotId -> bool (default on)
  where: {},                               // pilotId -> {system, ship, docked, online, name}
  logWhere: {},                            // character name -> system id, from Survey Link
  here: store.get(K_HERE, null),           // {system, by, at}: where the surveyor is
  pin: store.get(K_PIN, ""),               // character the view follows ("" = whoever jumps)
  auto: null,                              // in auto mode, the last character seen jumping
  root: store.get(K_ROOT, null), sel: null,
  view: store.get(K_VIEW, "surveyor"),
  feed: [], alerted: new Set(), pendingInfo: null,
  link: { ok: false, seq: 0, next: 0, err: "", logs: false },
  syncing: false, lastSync: null, syncErr: "",
};

/* ---- reference data ----------------------------------------------------- */
function label(id) {
  if (C.isJ(id)) {
    const j = S.J[id];
    return j ? { name: j[0], cls: S.CL[j[1]] || `Class ${j[1]}`, sub: j[2] || "no effect", tone: classTone(j[1]) }
             : { name: `J-space ${id}`, cls: "?", sub: "", tone: "var(--sp)" };
  }
  const k = S.K.s[id];
  if (!k) return { name: String(id), cls: "?", sub: "", tone: "var(--ink-dim)" };
  const sec = k[1], cls = sec >= 0.45 ? "HS" : sec > 0 ? "LS" : "NS";
  return { name: k[0], cls: `${cls} ${sec.toFixed(1)}`, sub: k[2], tone: `var(--${cls.toLowerCase()})` };
}
const classTone = c => (c >= 1 && c <= 6 ? `var(--c${c})` : "var(--sp)");
const nameOf = id => label(id).name;
const classLabelOf = id => { const j = S.J[id]; return j ? S.CL[j[1]] || null : null; };

async function loadData() {
  const get = p => fetch(p).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  [S.J, S.K, S.WH, S.CL, S.ST] = await Promise.all([get("../data/jspace/systems.json"), get("../data/jspace/kspace.json"),
    get("../data/jspace/wormholes.json"), get("../data/jspace/classes.json"), get("../data/jspace/scan_types.json")]);
  for (const [id, v] of Object.entries(S.J)) S.byName.set(v[0].toLowerCase(), +id);
  for (const [id, v] of Object.entries(S.K.s)) S.byName.set(v[0].toLowerCase(), +id);
  for (const [id, v] of Object.entries(S.ST)) S.typeByName.set(v[0].toLowerCase(), +id);
}

/* ---- who is surveying ------------------------------------------------------- */
const pilots = () => (window.EveSSO && EveSSO.configured() ? EveSSO.pilots() : []);
const tracked = id => S.track[id] !== false;
function surveyor() {
  const p = pilots().find(x => tracked(x.id)) || pilots()[0];
  return p ? { id: String(p.id), name: p.name } : { id: "local", name: S.here?.by || "You" };
}

/* ---- edits: chain, knowledge base, points ------------------------------------ */
const sharing = () => !!(S.relay && store.get(K_SHARE, false) && pilots().length);

function edit(op) {
  op.at = op.at ?? Date.now();
  const events = X.chainEvents(S.chain, op);
  C.applyOp(S.chain, op, S.WH);
  saveLocal();
  if (sharing()) { S.pending.push(op); sync(); } else localAward(events);
  render(true);
}
function kbEdit(op) {
  op.at = op.at ?? Date.now();
  op.by = op.by || surveyor().name;
  const { events } = X.applyKbOp(S.kb, op, op.at);
  saveKb();
  if (sharing()) { S.pending.push(op); sync(); } else localAward(events);
  render(true);
}
function saveLocal() { store.set(K_CHAIN, S.chain); }
function saveKb() {
  /* browser storage is a few MB: trim the oldest d-scans if it ever gets big */
  let txt = JSON.stringify(S.kb);
  if (txt.length > 2e6) {
    for (const rec of Object.values(S.kb)) rec.dscans = (rec.dscans || []).slice(0, 10);
    txt = JSON.stringify(S.kb);
  }
  try { localStorage.setItem(K_KB, txt); } catch { /* full */ }
}
function localAward(events) {
  if (!events.length) return;
  const me = surveyor();
  const res = X.award(S.ledger, me.id, me.name, events, Date.now(), { classOf: classLabelOf });
  store.set(K_SCORE, S.ledger);
  S.me = S.ledger[me.id];
  S.board = X.leaderboard(S.ledger);
  announce(res);
}
function announce(res) {
  if (!res) return;
  if (res.points > 0) feed(`+${res.points} survey points`, "pts");
  for (const id of res.badges || []) {
    const b = X.BADGES.find(x => x.id === id);
    if (!b) continue;
    feed(`Badge earned: ${b.name} (${b.desc})`, "medal");
    toast(`Badge earned: ${b.name}. ${b.desc}.`, 9000);
    chime();
  }
  renderScore();
}

function addLink(a, b, extra = {}) {
  const key = C.linkKey(a, b);
  const old = S.chain.links[key];
  if (old) {
    /* two systems can be joined by more than one hole. A jump through a tagged
       signature becomes its own connection only when this connection already has a
       different signature on that side; otherwise it is the same hole (usually the
       one you came in through), and the jump fills in its signature and type */
    const side = extra.sigA !== undefined ? "sigA" : extra.sigB !== undefined ? "sigB" : null;
    if (side && old[side] && old[side] !== extra[side]) {
      const twinKey = `${key}~${extra[side]}`;
      if (!S.chain.links[twinKey]) {
        const op = C.newLink(a, b, Date.now(), "", extra);
        op.key = twinKey;
        edit(op);
        feed(`A second hole between ${nameOf(a)} and ${nameOf(b)} (${extra[side]}) was added as its own connection. ` +
             `If it is really the same hole, remove one of them.`, "warn");
      }
      return;
    }
    const rec = {};
    if (extra.confirmed && !old.confirmed) rec.confirmed = true;
    for (const k of ["sigA", "sigB", "code", "codeAt", "size", "life", "lifeAt", "mass"]) if (extra[k] != null && old[k] == null) rec[k] = extra[k];
    if (Object.keys(rec).length) edit({ kind: "link", key, rec });
    return;
  }
  edit(C.newLink(a, b, Date.now(), "", extra));
}

/* ---- where the surveyor is ---------------------------------------------------- */
function setHere(system, by) {
  const moved = S.here?.system !== system;
  S.here = { system, by: by || S.here?.by || "", at: Date.now() };
  store.set(K_HERE, S.here);
  if (!moved) return;
  const L = label(system);
  feed(`${by || "You"}: now in ${L.name} (${L.cls})`, "jump");
  if (C.isJ(system)) kbEdit({ kind: "visit", system, by });
  if (!S.root || !inChain(S.root)) setRoot(system);
  S.sel = null;
  fetchKb([system]);
  render(true);
}
const inChain = id => Object.values(S.chain.links).some(l => l.a === id || l.b === id);

/* the hole a pilot just jumped: the wormhole signature in the system they left
   that was tagged with a type most recently (within the last hour) and is not
   already tied to a connection */
function taggedHole(from) {
  const used = new Set();
  for (const l of Object.values(S.chain.links)) {
    if (l.a === from && l.sigA) used.add(l.sigA);
    if (l.b === from && l.sigB) used.add(l.sigB);
  }
  let best = null;
  for (const [sid, sg] of Object.entries(S.chain.sigs[from] || {})) {
    if (!sg.code || used.has(sid) || Date.now() - (sg.codeAt || 0) > 3600e3) continue;
    if (!best || sg.codeAt > best[1].codeAt) best = [sid, sg];
  }
  return best;
}
function linkExtra(from, to) {
  const hit = taggedHole(from);
  if (!hit) return {};
  const [sid, sg] = hit;
  const size = sg.info?.size || (sg.code !== "K162" ? C.sizeFromJump(S.WH[sg.code]?.jump) : null);
  const info = sg.info ? { ...(sg.info.life ? { life: sg.info.life, lifeAt: sg.infoAt } : {}),
                           ...(sg.info.mass ? { mass: sg.info.mass } : {}) } : {};
  return { code: sg.code, codeAt: from, ...(from < to ? { sigA: sid } : { sigB: sid }), ...(size ? { size } : {}), ...info };
}

function onMove(who, from, to, opts) {
  const kind = C.classifyMove(from, to, S.K.g, opts);
  if (kind === "wormhole") {
    const extra = linkExtra(from, to);
    addLink(from, to, { confirmed: true, source: "jump", ...extra });
    if (extra.code) feed(`Type ${extra.code} carried over from the signature you tagged in ${nameOf(from)}`, "scan");
    feed(`${who}: ${nameOf(from)} to ${nameOf(to)}, wormhole added to the chain`, "jump");
  } else if (kind === "unsure") {
    addLink(from, to, { confirmed: false, source: "jump" });
    feed(`${who}: ${nameOf(from)} to ${nameOf(to)} with no gate between them. Confirm it if it was a wormhole.`, "warn");
  }
  /* every character's jumps map holes; only the surveyor being followed moves the view */
  if (S.pin ? who === S.pin : true) { S.auto = who; setHere(to, who); }
}
/* may a location report (not a jump) for this character set "You are in"? */
const follows = name => (S.pin ? name === S.pin : !S.auto || S.auto === name);

/* CCP location API, every 10 seconds */
async function poll() {
  for (const p of pilots()) {
    if (!tracked(p.id)) continue;
    try {
      const w = S.where[p.id] || { name: p.name };
      if (!w.onlineAt || Date.now() - w.onlineAt > 60e3) {
        w.online = !!(await EveSSO.esi(p.id, `/characters/${p.id}/online`)).online;
        w.onlineAt = Date.now();
      }
      if (!w.online) { S.where[p.id] = w; continue; }        // offline pilots never set a location
      const [loc, ship] = await Promise.all([EveSSO.esi(p.id, `/characters/${p.id}/location`),
                                             EveSSO.esi(p.id, `/characters/${p.id}/ship`)]);
      const docked = !!(loc.station_id || loc.structure_id);
      /* when Survey Link reads this pilot's chat log, the log is the faster and
         surer source: the API is only used for ship and docked state */
      if (S.link.ok && S.link.logs && S.logWhere[p.name] !== undefined) {
        /* trust the log, unless the API has disagreed for 25 seconds: then the log
           missed a jump, and the API's answer is used */
        const api = loc.solar_system_id, logged = S.logWhere[p.name];
        if (api === logged) w.mismatchSince = null;
        else if (!w.mismatchSince) w.mismatchSince = Date.now();
        if (!w.mismatchSince || Date.now() - w.mismatchSince < 25e3) {
          Object.assign(w, { system: logged, ship: ship.ship_type_id, docked, name: p.name, err: "" });
          S.where[p.id] = w;
          continue;
        }
        w.mismatchSince = null;
        w.system = logged;
      }
      const prev = w.system ?? S.logWhere[p.name], now = loc.solar_system_id;
      const becameCapsule = CAPSULES.has(ship.ship_type_id) && w.ship && !CAPSULES.has(w.ship);
      Object.assign(w, { system: now, ship: ship.ship_type_id, docked, name: p.name, err: "" });
      S.where[p.id] = w;
      S.logWhere[p.name] = now;
      if (prev && now !== prev) onMove(p.name, prev, now, { becameCapsule, dockedOnArrival: docked });
      else if (follows(p.name) && S.here?.system !== now) setHere(now, p.name);
    } catch (e) {
      S.where[p.id] = { ...(S.where[p.id] || { name: p.name }), err: e.message };
    }
  }
  renderPilots();
  render();
}

/* ---- Survey Link: the clipboard and chat-log helper on this computer --------- */
async function linkPoll() {
  if (S.link.busy || Date.now() < S.link.next) return;
  S.link.busy = true;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`${LINK_URL}?since=${S.link.seq}`, { signal: ctl.signal, cache: "no-store" });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    if (!S.link.ok) feed("Survey Link connected: copies from EVE now arrive here on their own", "link");
    S.link.ok = true; S.link.err = ""; S.link.logs = !!body.logs;
    const items = [].concat(body.items || []);
    if (body.seq < S.link.seq) S.link.primed = false;        // helper restarted
    if (!S.link.primed) {
      /* first contact since this page loaded: copies made before it are not
         replayed (they would land in whatever system the page last knew);
         only each pilot's latest system is taken, as a location */
      const latest = {};
      for (const it of items) if (it.kind === "system") latest[it.char] = it;
      for (const it of Object.values(latest)) onLogSystem({ ...it, initial: true });
      S.link.seq = body.seq;
      S.link.primed = true;
      S.link.next = Date.now() + 700;
      return;
    }
    for (const it of items) {
      if (it.seq <= S.link.seq) continue;
      S.link.seq = it.seq;
      if (it.kind === "paste") routePaste(it.text, "Survey Link");
      else if (it.kind === "system") onLogSystem(it);
    }
    S.link.next = Date.now() + 700;
  } catch (e) {
    if (S.link.ok) feed("Survey Link disconnected", "warn");
    S.link.ok = false; S.link.err = e.name === "AbortError" ? "no answer" : e.message;
    S.link.next = Date.now() + 5000;
  } finally {
    clearTimeout(t);
    S.link.busy = false;
    renderLinkChip();
  }
}
function onLogSystem(it) {
  const id = lookup(it.system);
  if (!id) return;
  const entry = Object.values(S.where).find(w => w.name === it.char);
  const prev = entry?.system ?? S.logWhere[it.char];
  S.logWhere[it.char] = id;
  if (entry) entry.system = id;
  if (!it.initial && prev && prev !== id) onMove(it.char, prev, id, {});
  else if (it.initial) {
    /* where each character was last seen in its log: only the pinned surveyor
       is followed from these; others wait for a real jump */
    if (S.pin === it.char && S.here?.system !== id) setHere(id, it.char);
  } else if (S.pin ? it.char === S.pin : true) { S.auto = it.char; if (S.here?.system !== id) setHere(id, it.char); }
  renderWho();
}
function knownChars() {
  return [...new Set([...pilots().map(p => p.name), ...Object.keys(S.logWhere)])].sort();
}
function renderWho() {
  const sel = document.querySelector("#svWho");
  if (!sel || sel === document.activeElement) return;
  const names = knownChars();
  sel.innerHTML = `<option value="">auto (whoever jumps)</option>` +
    names.map(n => `<option value="${esc(n)}"${n === S.pin ? " selected" : ""}>${esc(n)}</option>`).join("");
}

/* ---- pastes ------------------------------------------------------------------- */
function routePaste(text, source) {
  const r = X.classifyPaste(text);
  if (!r) {
    if (source === "paste") toast("That paste is not a probe scan, directional scan or wormhole Show Info.");
    return;
  }
  const sys = S.here?.system ?? S.sel ?? S.root;
  if (!sys) { toast("Where are you? Log in with tracking on, start Survey Link, or type a system in the Root box."); return; }
  const where = nameOf(sys);
  if (r.kind === "sigs") {
    const known = S.chain.sigs[sys] || {};
    const fresh = r.sigs.filter(s => !known[s.id]).map(s => s.id);
    edit({ kind: "sigs", system: sys, parsed: r.sigs, replace: true });
    S.lastProbe = { system: sys, at: Date.now(), fresh };
    feed(`Probe scan in ${where}: ${pl(r.sigs.length, "signature")}${fresh.length ? `, ${fresh.length} new (${fresh.join(", ")})` : ", nothing new"}`, "scan");
    if (fresh.length && Object.keys(known).length) chime();
  } else if (r.kind === "dscan") {
    const sum = X.summarizeDscan(r.rows, S.ST, S.typeByName);
    sum.ships = Object.fromEntries(Object.entries(sum.ships).sort((a, b) => b[1] - a[1]).slice(0, 20));
    sum.structures = sum.structures.slice(0, 30);
    kbEdit({ kind: "dscan", system: sys, sum });
    feed(`D-scan in ${where}: ${dscanLine(sum)}`, sum.cats.S ? "warn" : "scan");
  } else if (r.kind === "showinfo") {
    const here = Object.entries(S.chain.links).filter(([, l]) => l.a === sys || l.b === sys);
    const tagged = taggedHole(sys);
    /* a hole not jumped yet: the info rides on the wormhole signature you tagged
       most recently, and carries into the connection when you jump it */
    const recentTag = tagged && Date.now() - (tagged[1].codeAt || 0) < 30 * 60e3;
    const target = S.selLink && S.chain.links[S.selLink] ? S.selLink
      : recentTag ? null : here.length === 1 ? here[0][0] : null;
    if (target) applyInfo(target, r.info);
    else if (recentTag) {
      const [sid, sg] = tagged;
      edit({ kind: "sig", system: sys, id: sid, rec: { ...sg, info: r.info, infoAt: Date.now() } });
      feed(`Show Info saved on ${sid} (${sg.code}): ${infoText(r.info)}. It moves to the connection when you jump it.`, "scan");
    }
    else {
      S.pendingInfo = r.info;
      feed(`Show Info read (${infoText(r.info)}). Pick which hole it was in Connections.`, "warn");
      toast("Show Info read. Click the hole it belongs to in Connections, then use 'Apply Show Info'.");
    }
  }
}
function infoText(info) {
  const life = { fresh: "fresh", decay: "under a day", eol: "end of life" }[info.life];
  const mass = { stable: "mass stable", destab: "mass reduced", crit: "mass critical" }[info.mass];
  return [life, mass, info.size && `size ${info.size}`, info.dest && `leads to ${info.dest}`].filter(Boolean).join(", ");
}
function applyInfo(key, info) {
  const rec = {};
  if (info.size) rec.size = info.size;
  if (info.mass) rec.mass = info.mass;
  if (info.life) { rec.life = info.life; rec.lifeAt = Date.now(); }
  edit({ kind: "link", key, rec });
  const l = S.chain.links[key];
  feed(`Show Info applied to ${nameOf(l.a)} - ${nameOf(l.b)}: ${infoText(info)}`, "scan");
  S.pendingInfo = null;
}
const pl = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function dscanLine(sum) {
  const ships = Object.entries(sum.ships || {}).slice(0, 4).map(([t, n]) => `${n} ${t}`).join(", ");
  return pl(sum.total, "object") + (sum.cats?.S ? `, ${pl(sum.cats.S, "ship")} (${ships})` : ", no ships") +
         (sum.structures?.length ? `, ${pl(sum.structures.length, "structure")}` : "") +
         (sum.posModules ? ` (${pl(sum.posModules, "POS module")})` : "") + (sum.holes ? `, ${pl(sum.holes, "hole")}` : "");
}

/* ---- corp sharing via the Atlas relay ------------------------------------------ */
async function relayPost(path, extra) {
  const p = pilots()[0];
  const r = await fetch(`${S.relay}${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await EveSSO.token(p.id), ...extra }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.status);
  return body;
}
async function sync() {
  if (!sharing() || S.syncing) return;
  S.syncing = true;
  const sent = S.pending.splice(0);
  try {
    const body = await relayPost(`/chain${sent.length ? "/ops" : ""}`, { ops: sent });
    S.corp = body.corporation;
    S.chain = body.chain;
    for (const op of S.pending) if (!["visit", "static", "dscan"].includes(op.kind)) C.applyOp(S.chain, op, S.WH);
    C.prune(S.chain, Date.now());
    saveLocal();
    for (const [sys, rec] of Object.entries(body.kb || {})) S.kb[sys] = rec;
    if (body.kb && Object.keys(body.kb).length) saveKb();
    S.board = body.board || [];
    S.me = body.me || null;
    announce(body.awards);
    S.lastSync = new Date();
    S.syncErr = "";
  } catch (e) {
    S.pending.unshift(...sent);
    S.syncErr = String(e.message || e);
  } finally {
    S.syncing = false;
    renderStatus();
    renderScore();
    render();
  }
}
async function fetchKb(systems) {
  if (!sharing() || !systems.length) return;
  try {
    const body = await relayPost("/kb", { systems });
    for (const [sys, rec] of Object.entries(body.kb || {})) S.kb[sys] = rec;
    saveKb();
    render();
  } catch { /* the local copy still shows */ }
}

function askShare() {
  const box = modal(`
    <h3 style="margin-top:0">Share this map with your corporation?</h3>
    <p>Sharing sends what this browser has surveyed (wormholes, signatures, notes, statics and directional scans)
       to the Atlas relay. It is kept for your corporation only, and only pilots the relay verifies as members
       of that corporation can read it. Your finds carry your pilot's name, and survey points go on the corp board.</p>
    <p>Nothing is shared until you tick the box. You can untick it at any time.</p>
    <label class="row"><input type="checkbox" id="cs"> Yes, share my survey map with my corporation</label>
    <div class="row" style="justify-content:flex-end"><button data-close>Cancel</button><button id="ok" class="primary">Save</button></div>`,
    () => { $("#share").checked = store.get(K_SHARE, false); });
  box.querySelector("#ok").onclick = () => {
    const yes = box.querySelector("#cs").checked;
    store.set(K_SHARE, yes);
    $("#share").checked = yes;
    box.remove();
    renderStatus();
    if (yes) { S.pending.push(...snapshotOps()); sync(); }
  };
}
/* turning sharing on uploads what this browser already knows */
function snapshotOps() {
  const ops = [];
  for (const [key, l] of Object.entries(S.chain.links)) ops.push({ kind: "link", key, rec: l, at: l.updated });
  for (const [sys, table] of Object.entries(S.chain.sigs)) {
    for (const [id, s] of Object.entries(table)) ops.push({ kind: "sig", system: sys, id, rec: s, at: s.updated });
  }
  for (const [sys, n] of Object.entries(S.chain.notes)) ops.push({ kind: "note", system: sys, text: n.text, at: n.updated });
  for (const [sys, rec] of Object.entries(S.kb)) {
    if (rec.visit) ops.push({ kind: "visit", system: +sys, at: rec.visit.at });
    for (const code of Object.keys(rec.statics || {})) ops.push({ kind: "static", system: +sys, code, at: rec.statics[code].first });
    for (const d of (rec.dscans || []).slice().reverse()) ops.push({ kind: "dscan", system: +sys, sum: d.sum, at: d.at });
  }
  return ops.slice(0, 200);
}

/* ---- header ----------------------------------------------------------------- */
function renderPilots() {
  const ps = pilots();
  $("#login").textContent = ps.length ? "Add pilot" : "Log in with EVE";
  $("#shareWrap").hidden = !(S.relay && ps.length);
  $("#pilots").innerHTML = ps.map(p => {
    const w = S.where[p.id] || {};
    const at = w.system ? nameOf(w.system) : "";
    const expired = /token request failed|not signed in/.test(w.err || "");
    const state = !tracked(p.id) ? "not tracked" : expired ? "login expired: use Add pilot" : w.err ? "error"
      : w.online === false ? "offline" : at;
    return `<label class="chip${tracked(p.id) ? "" : " off"}" title="${esc(w.err || "Track this pilot's jumps")}">
      <input type="checkbox" data-track="${p.id}"${tracked(p.id) ? " checked" : ""}>
      ${esc(p.name)} <span class="where">${esc(state)}</span></label>`;
  }).join(" ");
  $("#pilots").querySelectorAll("[data-track]").forEach(b => b.onchange = () => {
    S.track[b.dataset.track] = b.checked;
    store.set(K_TRACK, S.track);
    renderPilots();
  });
}
function renderStatus() {
  const el = $("#sync");
  el.classList.toggle("err", !!S.syncErr);
  if (!sharing()) { el.textContent = "map kept in this browser"; return; }
  el.textContent = S.syncErr ? `corp sync failed: ${S.syncErr}`
    : S.lastSync ? `corp map synced ${S.lastSync.toLocaleTimeString()}` : "syncing...";
}
function renderLinkChip() {
  const c = $("#linkChip");
  c.className = `chip ${S.link.ok ? "ok" : "off"}`;
  c.textContent = S.link.ok ? `Survey Link on${S.link.logs ? "" : " (no chat logs)"}` : "Survey Link off";
  c.title = S.link.ok ? "Copies from EVE arrive here on their own" : "Start Survey Link on this computer";
}
function renderScore() {
  const me = S.me || S.ledger[surveyor().id];
  const pts = me?.pts || 0, rank = X.rankOf(pts);
  $("#scoreChip").textContent = `${rank.name} · ${pts} pts`;
  if (S.view === "surveyor") renderScoreCard();
}
function setView(v) {
  S.view = v;
  store.set(K_VIEW, v);
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  $("#chainView").hidden = v !== "chain";
  $("#surveyorView").hidden = v !== "surveyor";
  render(true);
}

/* ---- rendering: chain view ---------------------------------------------------------- */
const NW = 170, NH = 50, GX = 70, GY = 18, PAD = 20;
const MASS_TONE = { stable: "var(--ink-dim)", destab: "var(--warn)", crit: "var(--bad)" };
const SIZE_SHORT = { S: "S frigate", M: "M cruiser", L: "L battleship", XL: "XL capital" };
/* the wording of the current client's Show Info, so a pilot can read and click */
const LIFE_BTN = [["fresh", "More than 1 day"], ["decay", "Less than 1 day"], ["eol", "Less than 4 hours"]];
const MASS_BTN = [["stable", "More than 50%"], ["destab", "Less than 50%"], ["crit", "Less than 10%"]];

function setRoot(id) {
  S.root = id;
  store.set(K_ROOT, id);
  $("#rootInput").value = id ? nameOf(id) : "";
  render(true);
}

/* force=false (timers) leaves panels alone while the pilot is typing in them */
function render(force = false) {
  if (S.view === "surveyor") renderSurveyor(force);
  else renderChain(force);
}

function renderChain(force) {
  const svg = $("#chain");
  const links = Object.values(S.chain.links);
  $("#counts").textContent = `${links.length} link${links.length === 1 ? "" : "s"} · ` +
    `${Object.values(S.chain.sigs).reduce((n, t) => n + Object.keys(t).length, 0)} signatures`;
  if (!S.root || (!links.length && !S.sel)) {
    svg.innerHTML = "";
    svg.setAttribute("width", 0); svg.setAttribute("height", 0);
    $("#empty").hidden = false;
    $("#empty").innerHTML = `<p><b>No chain yet.</b> Start Survey Link or log in with tracking on, then fly through a
      wormhole: each jump draws itself here. You can also type a system in the Root box and add connections by hand.</p>`;
    renderSide(force);
    return;
  }
  $("#empty").hidden = true;
  const t = C.layoutTree(S.chain, S.root);
  const pos = new Map(t.nodes.map(n => [n.id, { x: PAD + n.depth * (NW + GX), y: PAD + 30 + n.row * (NH + GY) }]));
  const W = PAD * 2 + (Math.max(0, ...t.nodes.map(n => n.depth)) + 1) * (NW + GX);
  const H = PAD * 2 + 30 + Math.max(1, t.rows) * (NH + GY);
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  const here = new Map();
  for (const w of Object.values(S.where)) if (w.system) here.set(w.system, [...(here.get(w.system) || []), w.name]);
  if (S.here) here.set(S.here.system, [...new Set([...(here.get(S.here.system) || []), S.here.by || "you"])]);

  const twins = new Map();
  const edge = (from, to, key, cross) => {
    const l = S.chain.links[key], a = pos.get(from), b = pos.get(to);
    /* a second hole between the same two systems bows away from the first */
    const pk = C.linkKey(from, to), n = twins.get(pk) || 0;
    twins.set(pk, n + 1);
    const bow = n * 26;
    const x1 = a.x + NW, y1 = a.y + NH / 2 + bow * 0.3, x2 = b.x, y2 = b.y + NH / 2 + bow * 0.3, mx = (x1 + x2) / 2;
    const tone = MASS_TONE[l.mass] || "var(--ink-faint)";
    const width = { S: 1.5, M: 2.5, L: 3.5, XL: 5 }[l.size || sizeOf(l)] || 2;
    const dash = !l.confirmed ? "6 4" : cross ? "2 4" : "";
    const lab = [l.code || "", l.life === "eol" ? "EOL" : "", lifeShort(l)].filter(Boolean).join(" ");
    return `<path d="M${x1},${y1} C${mx},${y1 + bow} ${mx},${y2 + bow} ${x2},${y2}" fill="none" stroke="${tone}" stroke-width="${width}"
              ${dash ? `stroke-dasharray="${dash}"` : ""} opacity="${cross && !n ? .55 : 1}"/>
            <text x="${mx}" y="${(y1 + y2) / 2 - 5 + bow}" text-anchor="middle" font-size="11"
              fill="${l.life === "eol" ? "var(--bad)" : "var(--ink-dim)"}">${esc(lab)}</text>`;
  };
  const node = n => {
    const p = pos.get(n.id), L = label(n.id);
    const sigs = Object.keys(S.chain.sigs[n.id] || {}).length;
    const who = here.get(n.id);
    return `<g class="node${n.id === S.sel ? " sel" : ""}${n.id === S.root ? " root" : ""}" data-id="${n.id}"
              transform="translate(${p.x},${p.y})">
      <rect width="${NW}" height="${NH}" rx="6"/>
      <rect width="5" height="${NH}" rx="2" style="fill:${L.tone};stroke:none"/>
      <text x="12" y="19" font-size="13" font-weight="600" fill="var(--ink)">${esc(L.name)}</text>
      <text x="${NW - 8}" y="19" font-size="12" text-anchor="end" fill="${L.tone}">${esc(L.cls)}</text>
      <text x="12" y="38" font-size="11" fill="var(--ink-dim)">${esc(trim(L.sub, 18))}</text>
      ${sigs ? `<text x="${NW - 8}" y="38" font-size="11" text-anchor="end" fill="var(--ink-faint)">${sigs} sig${sigs > 1 ? "s" : ""}</text>` : ""}
      ${who ? `<circle cx="${NW - 4}" cy="4" r="6" fill="var(--ok)"><title>${esc(who.join(", "))}</title></circle>` : ""}
    </g>`;
  };
  svg.innerHTML = t.edges.map(e => edge(e.from, e.to, e.key, false)).join("") +
                  t.cross.map(e => edge(e.from, e.to, e.key, true)).join("") +
                  t.nodes.map(node).join("");
  svg.querySelectorAll(".node").forEach(g => {
    g.onclick = () => select(+g.dataset.id);
    g.ondblclick = () => setRoot(+g.dataset.id);
  });
  renderSide(force);
}
const trim = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const sizeOf = l => (l.code && l.code !== "K162" ? C.sizeFromJump(S.WH[l.code]?.jump) : null);
function lifeShort(l) {
  const b = X.lifeBounds(l, S.WH), now = Date.now();
  const hi = Math.max(0, (b.hi - now) / C.HOUR);
  if (b.lo == null) return `<${Math.ceil(hi)}h`;
  return `${dur(b.lo - now, true)}+`;
}
function dur(ms, short = false) {
  if (ms <= 0) return short ? "0m" : "any moment";
  const m = Math.floor(ms / 60e3), h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function select(id) { S.sel = id; render(true); }

function systemMeta(id) {
  const L = label(id), j = S.J[id], k = S.K.s[id];
  return C.isJ(id)
    ? `${esc(L.cls)} · ${esc(j?.[2] || "no effect")} · ${esc(j?.[3] || "")} / ${esc(j?.[4] || "")} · ${j?.[5] ?? "?"} planets, ${j?.[6] ?? "?"} moons`
    : `${esc(L.cls)} · ${esc(k?.[2] || "")} · <a href="../#s=${encodeURIComponent(L.name)}">open in Atlas</a>`;
}
function staticsHtml(id) {
  const st = X.staticsOf(S.kb[id]);
  if (!st.length) return `<span class="hint">none recorded yet (tag a hole's type here to record one)</span>`;
  return st.map(s => { const w = S.WH[s.code]; return `<span class="tag" title="seen ${s.n} time${s.n > 1 ? "s" : ""}${s.sure ? "" : ", not yet sure"}">${esc(s.code)}${w ? ` to ${esc(S.CL[w.to] || "?")}` : ""}${s.sure ? "" : "?"}</span>`; }).join(" ");
}

function renderSide(force = true) {
  const side = $("#side");
  const id = S.sel ?? S.root;
  if (!force && side.dataset.for === String(id) && side.contains(document.activeElement)) return;
  side.dataset.for = String(id);
  if (!id) { side.innerHTML = `<p class="hint">Pick a system in the chain, or type one in the Root box.</p>`; return; }
  const L = label(id);
  side.innerHTML = `
    <h2 style="color:${L.tone}">${esc(L.name)}</h2>
    <div class="meta">${systemMeta(id)}</div>
    <div class="row" style="margin-top:6px">${C.isJ(id) ? staticsHtml(id) : ""}</div>
    <div class="row" style="margin-top:8px"><button id="mkRoot">Make root</button><button id="mkHere">I am here</button></div>
    <h3>Connections</h3>${linksHtml(id)}
    <div class="row"><input id="addTo" placeholder="connect to system..." autocomplete="off" size="20"><button id="addBtn">Add</button></div>
    <h3>Signatures</h3>${sigsHtml(id, true)}
    <h3>Directional scans</h3>${dscanHtml(id)}
    <h3>Notes</h3>${notesHtml(id)}`;
  side.querySelector("#mkRoot").onclick = () => setRoot(id);
  side.querySelector("#mkHere").onclick = () => setHere(id, surveyor().name);
  side.querySelector("#addBtn").onclick = () => {
    const to = lookup(side.querySelector("#addTo").value);
    if (!to) return toast("Unknown system name.");
    if (to !== id) addLink(id, to, { confirmed: true });
  };
  attachSuggest(side.querySelector("#addTo"), () => side.querySelector("#addBtn").click());
  wirePanel(side, id);
}

/* ---- shared panel pieces (chain side panel and surveyor view) ---------------------- */
function linksHtml(id) {
  const mine = Object.entries(S.chain.links).filter(([, l]) => l.a === id || l.b === id)
    .sort((x, y) => (x[1].confirmed === y[1].confirmed ? 0 : x[1].confirmed ? 1 : -1));
  const sigs = Object.entries(S.chain.sigs[id] || {}).filter(([, s]) => /wormhole/i.test(s.type) || !s.type);
  return mine.length ? mine.map(([key, l]) => linkCard(key, l, id, sigs)).join("") : `<p class="hint">None yet.</p>`;
}
function sigsHtml(id, withPaste) {
  const sigs = Object.entries(S.chain.sigs[id] || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const used = new Map();
  for (const l of Object.values(S.chain.links)) {
    if (l.a === id && l.sigA) used.set(l.sigA, l.b);
    if (l.b === id && l.sigB) used.set(l.sigB, l.a);
  }
  const fresh = new Set(S.lastProbe?.system === id && Date.now() - S.lastProbe.at < 30 * 60e3 ? S.lastProbe.fresh : []);
  /* a site is done once its type shows (25%+); a wormhole needs 100% so it can be
     warped to, tagged and jumped */
  const isHole = s => /wormhole/i.test(s.type);
  const state = s => (!s.type ? "unscanned" : isHole(s) ? (s.pct < 100 ? "to finish" : "ready") : "identified");
  const holeCell = (sid, s) => {
    if (!isHole(s)) return esc(s.name);
    const w = s.code && S.WH[s.code];
    const lead = w && !w.exit ? `to ${S.CL[w.to] || "?"}, ${SIZE_SHORT[C.sizeFromJump(w.jump)] || ""}` : s.code === "K162" ? "exit side" : "";
    return `<input data-sigcode="${esc(sid)}" list="whCodes" size="6" placeholder="type" value="${esc(s.code || "")}"
      title="Show Info on the wormhole: the window title says Wormhole XXXX. Type XXXX here."> <span class="hint">${esc(lead)}</span>`;
  };
  const rows = sigs.map(([sid, s]) => `<tr class="${fresh.has(sid) ? "fresh" : ""}">
      <td>${esc(sid)}</td><td>${esc(s.type || "?")}</td><td>${holeCell(sid, s)}</td>
      <td><span class="st st-${state(s).replace(" ", "-")}">${state(s)}</span>${used.has(sid) ? ` to ${esc(nameOf(used.get(sid)))}` : ""}</td>
      <td>${age(s.first)}</td>
      <td class="x"><button class="xbtn" data-delsig="${esc(sid)}" title="Remove">x</button></td></tr>`).join("");
  const unscanned = sigs.filter(([, s]) => ["unscanned", "to finish"].includes(state(s))).length;
  return (withPaste ? `<textarea id="sigPaste" rows="2" placeholder="Probe scanner: select all, copy, paste here (or anywhere on this page)"></textarea>
    <div class="row"><button id="sigGo">Save</button></div>` : "") +
    (sigs.length ? `<div class="hint">${pl(sigs.length, "signature")}, ${unscanned ? `${unscanned} still to scan` : "all identified"}</div>
      <table><tr><th>ID</th><th>Type</th><th>Name</th><th>State</th><th>Age</th><th></th></tr>${rows}</table>`
      : `<p class="hint">No signatures recorded. Copy the probe scanner in game.</p>`);
}
function dscanHtml(id) {
  const rec = S.kb[id] || {};
  const structs = Object.values(rec.structures || {}).sort((a, b) => b.last - a.last);
  const hist = (rec.dscans || []);
  const one = d => `<tr><td>${age(d.at)}</td><td>${esc(d.by || "")}</td><td>${esc(dscanLine(d.sum))}</td></tr>`;
  return (structs.length ? `<div class="hint">Structures seen here:</div><ul class="tight">${structs.map(s =>
      `<li>${esc(s.type)}: ${esc(s.name)} <span class="hint">last ${age(s.last)} ago</span></li>`).join("")}</ul>` : "") +
    (hist.length ? `<table><tr><th>When</th><th>By</th><th>What</th></tr>${hist.slice(0, 15).map(one).join("")}</table>`
      : `<p class="hint">No directional scans saved. Copy the d-scan window in game.</p>`);
}
function notesHtml(id) {
  const n = S.chain.notes[id];
  return `<textarea id="note" rows="3" placeholder="Residents, structures, anything useful">${esc(n?.text || "")}</textarea>
    ${n?.by ? `<div class="hint">last edit by ${esc(n.by)}</div>` : ""}`;
}
function wirePanel(root, id) {
  const go = root.querySelector("#sigGo");
  if (go) go.onclick = () => routePasteFor(id, root.querySelector("#sigPaste").value);
  root.querySelectorAll("[data-sigcode]").forEach(inp => inp.onchange = () => {
    const sid = inp.dataset.sigcode, v = inp.value.trim().toUpperCase();
    if (v && !S.WH[v]) { toast(`${v} is not a known wormhole type.`); return; }
    const cur = S.chain.sigs[id]?.[sid] || {};
    edit({ kind: "sig", system: id, id: sid, rec: { ...cur, code: v || null, codeAt: v ? Date.now() : null } });
    if (v && v !== "K162" && C.isJ(id)) kbEdit({ kind: "static", system: id, code: v });
    /* a connection already tied to this signature gets the type too */
    for (const [key, l] of Object.entries(S.chain.links)) {
      if ((l.a === id && l.sigA === sid) || (l.b === id && l.sigB === sid)) {
        edit({ kind: "link", key, rec: { code: v || null, codeAt: v ? id : null } });
      }
    }
    if (v) feed(`${sid} in ${nameOf(id)} tagged ${v}${S.WH[v]?.exit ? "" : `: leads to ${S.CL[S.WH[v].to] || "?"}`}`, "scan");
  });
  root.querySelectorAll("[data-delsig]").forEach(b => b.onclick = () =>
    edit({ kind: "del", what: "sig", system: id, id: b.dataset.delsig }));
  const note = root.querySelector("#note");
  if (note) note.onchange = e => edit({ kind: "note", system: id, text: e.target.value });
  root.querySelectorAll(".link").forEach(wireLinkCard);
}
function routePasteFor(id, text) {
  const keep = S.here;
  S.here = { system: id, by: keep?.by || "", at: Date.now() };
  routePaste(text, "paste");
  S.here = keep;
}

function linkCard(key, l, here, whSigs) {
  const other = l.a === here ? l.b : l.a;
  const O = label(other);
  const mySig = l.a === here ? l.sigA : l.sigB;
  const b = X.lifeBounds(l, S.WH), now = Date.now();
  const wh = l.code ? S.WH[l.code] : null;
  const info = wh && !wh.exit
    ? `${l.code}: to ${S.CL[wh.to] || "?"}, ${C.SIZES[C.sizeFromJump(wh.jump)] || "?"}, ${wh.life}h life, ${(wh.mass / 1e9).toFixed(2)}B kg total`
    : l.code === "K162" ? "K162: exit side; the other side's type sets the limits" : "type not set";
  const life = b.lo == null ? `<span style="color:var(--warn)">age unknown</span>, closes within ${dur(b.hi - now)}`
    : b.lo <= now ? `<span style="color:var(--bad)">could close any moment</span>, at most ${dur(b.hi - now)}`
    : `open at least <b>${dur(b.lo - now)}</b>, at most ${dur(b.hi - now)}`;
  const opt = (v, cur, text) => `<option value="${v}"${v === (cur || "") ? " selected" : ""}>${text}</option>`;
  return `<div class="link${l.confirmed ? "" : " unsure"}${S.selLink === key ? " picked" : ""}" data-key="${key}" data-here="${here}">
    <div class="row"><span class="to" data-go="${other}" style="color:${O.tone}">${esc(O.name)}</span>
      <span class="tag" style="color:${O.tone}">${esc(O.cls)}</span>
      ${l.mass === "crit" ? `<span class="tag" style="color:var(--bad)">mass critical</span>` : ""}
      <span class="spacer"></span><span class="hint">${life}</span></div>
    ${l.confirmed ? "" : `<div class="row hint" style="color:var(--warn)">Found from a move with no gate between the systems.
      <button data-act="confirm">It was a wormhole</button><button data-act="del">Discard</button></div>`}
    <div class="row">
      <input data-f="code" list="whCodes" placeholder="type, e.g. B274" size="9" value="${esc(l.code || "")}">
      <select data-f="sig">${opt("", mySig, "sig here")}${whSigs.map(([sid]) => opt(sid, mySig, sid)).join("")}</select>
      <select data-f="size">${opt("", l.size, "size")}${Object.entries(SIZE_SHORT).map(([k2, v]) => opt(k2, l.size, v)).join("")}</select>
    </div>
    <div class="row">
    </div>
    <div class="row seg" title="Reliable Lifetime, from the hole's Show Info"><span class="hint">Lifetime</span>
      ${LIFE_BTN.map(([v, t]) => `<button data-life="${v}" class="${l.life === v ? "on" : ""}">${t}</button>`).join("")}</div>
    <div class="row seg" title="Mass Stability, from the hole's Show Info"><span class="hint">Mass</span>
      ${MASS_BTN.map(([v, t]) => `<button data-mass="${v}" class="${l.mass === v ? "on" : ""}">${t}</button>`).join("")}</div>
    <div class="row">
      ${S.pendingInfo ? `<button data-act="apply" class="primary">Apply Show Info</button>` : `<button data-act="pick" title="Show Info pastes go to this hole">${S.selLink === key ? "Show Info goes here" : "Show Info target"}</button>`}
      <button data-act="del" title="Remove this connection">Remove</button>
    </div>
    <div class="hint">${esc(info)}${l.by ? ` · by ${esc(l.by)}` : ""}</div>
  </div>`;
}
function wireLinkCard(card) {
  const key = card.dataset.key, here = +card.dataset.here;
  const l = S.chain.links[key];
  const set = rec => edit({ kind: "link", key, rec });
  card.querySelector("[data-go]").onclick = e => { setView("chain"); select(+e.target.dataset.go); };
  card.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    if (b.dataset.act === "confirm") set({ confirmed: true });
    if (b.dataset.act === "del") edit({ kind: "del", what: "link", key });
    if (b.dataset.act === "apply" && S.pendingInfo) applyInfo(key, S.pendingInfo);
    if (b.dataset.act === "pick") { S.selLink = S.selLink === key ? null : key; render(true); }
  });
  card.querySelectorAll("[data-life]").forEach(b => b.onclick = () => {
    const v = b.dataset.life;
    set({ life: v, lifeAt: Date.now() });
    feed(`${pairName(key)}: lifetime set to ${LIFE_BTN.find(x => x[0] === v)[1].toLowerCase()} remaining`, "scan");
  });
  card.querySelectorAll("[data-mass]").forEach(b => b.onclick = () => {
    const v = b.dataset.mass;
    set({ mass: v });
    feed(`${pairName(key)}: mass set to ${MASS_BTN.find(x => x[0] === v)[1].toLowerCase()} remaining`, v === "crit" ? "warn" : "scan");
  });
  card.querySelectorAll("[data-f]").forEach(f => f.onchange = () => {
    const v = f.value.trim().toUpperCase();
    if (f.dataset.f === "code") {
      if (v && !S.WH[v]) return toast(`${v} is not a known wormhole type.`);
      const rec = { code: v || null, codeAt: v ? here : null };
      const size = v && v !== "K162" ? C.sizeFromJump(S.WH[v]?.jump) : null;
      if (size && !l.size) rec.size = size;
      set(rec);
      if (v && v !== "K162" && C.isJ(here)) kbEdit({ kind: "static", system: here, code: v });
    } else if (f.dataset.f === "sig") {
      set(l.a === here ? { sigA: f.value || null } : { sigB: f.value || null });
    } else if (f.dataset.f === "life") {
      set({ life: f.value || null, lifeAt: f.value ? Date.now() : null });
    } else {
      set({ [f.dataset.f]: f.value || null });
    }
  });
}

/* ---- rendering: surveyor view (second screen) ---------------------------------------- */
function renderSurveyor(force) {
  const root = $("#surveyorView");
  const id = S.here?.system ?? null;
  if (!force && root.dataset.for === String(id) && root.contains(document.activeElement)) { renderTimers(); return; }
  root.dataset.for = String(id);
  renderTimers();
  renderScoreCard();
  renderFeed();
  if (!id) {
    $("#svSystem").innerHTML = `<div class="hint">Where are you?</div><p>Start <b>Survey Link</b> or log in with tracking on,
      and your system appears here as soon as you jump. Or type a system in the box.</p>
      <div class="row"><input id="svWhere" placeholder="system name" autocomplete="off" size="16">
        <span class="hint">or follow</span> <select id="svWho"></select></div>`;
    attachSuggest($("#svWhere"), () => { const s = lookup($("#svWhere").value); if (s) setHere(s, surveyor().name); });
    renderWho();
    $("#svWho").onchange = e => {
      S.pin = e.target.value; store.set(K_PIN, S.pin);
      const sys = S.pin && S.logWhere[S.pin];
      if (sys) setHere(sys, S.pin);
    };
    for (const k of ["#svSigs", "#svLinks", "#svDscan"]) $(k).innerHTML = "";
    return;
  }
  const L = label(id);
  const probe = S.lastProbe?.system === id ? `last probe scan ${age(S.lastProbe.at)} ago` : "no probe scan yet this visit";
  $("#svSystem").innerHTML = `
    <div class="row hint">You are in${S.here.by ? ` (${esc(S.here.by)})` : ""}
      <span class="spacer"></span>following <select id="svWho" title="Which character this screen follows"></select></div>
    <div class="big" style="color:${L.tone}">${esc(L.name)} <span class="cls">${esc(L.cls)}</span></div>
    <div class="meta">${systemMeta(id)}</div>
    <div class="row" style="margin-top:6px">${C.isJ(id) ? `<span class="hint">Statics:</span> ${staticsHtml(id)}` : ""}</div>
    <div class="hint" style="margin-top:6px">${esc(probe)}</div>
    <div class="row" style="margin-top:8px"><button id="svChain">Show in chain</button>
      <button id="svHomeBtn" title="Your way-home timer counts down to here">${S.home === id ? "This is home" : "Set as home"}</button></div>`;
  renderWho();
  $("#svWho").onchange = e => {
    S.pin = e.target.value;
    store.set(K_PIN, S.pin);
    if (S.pin) {
      const sys = S.logWhere[S.pin] ?? Object.values(S.where).find(w => w.name === S.pin)?.system;
      if (sys) setHere(sys, S.pin);
      feed(`Following ${S.pin}`, "jump");
    } else feed("Following whoever jumps", "jump");
    render(true);
  };
  $("#svChain").onclick = () => { setRoot(store.get(K_HOME, null) || id); S.sel = id; setView("chain"); };
  $("#svHomeBtn").onclick = () => { store.set(K_HOME, id); S.home = id; toast(`Home set: ${L.name}.`); render(true); };
  $("#svSigs").innerHTML = `<h3>Signatures</h3>${sigsHtml(id, false)}`;
  $("#svLinks").innerHTML = `<h3>Connections from here</h3>${linksHtml(id)}`;
  $("#svDscan").innerHTML = `<h3>Directional scans</h3>${dscanHtml(id)}`;
  for (const k of ["#svSigs", "#svLinks", "#svDscan"]) wirePanel($(k), id);
}

/* the way-home countdown and its alarm, every second */
function renderTimers() {
  const box = $("#svHome");
  if (!box || S.view !== "surveyor") return;
  const home = S.home ?? store.get(K_HOME, null);
  const id = S.here?.system;
  if (!home) { box.innerHTML = `<div class="hint">Way home</div><p>Set a home system (the button under your current system) to get a minimum-life countdown for your way back.</p>`; return; }
  if (!id) { box.innerHTML = `<div class="hint">Way home to ${esc(nameOf(home))}</div><p class="hint">Waiting for your location.</p>`; return; }
  if (id === home) { box.className = "card"; box.innerHTML = `<div class="hint">Way home</div><div class="big ok">You are home</div><div class="hint">${esc(nameOf(home))}</div>`; return; }
  const now = Date.now();
  const w = X.wayHome(S.chain, id, home, S.WH, now);
  if (!w.connected) {
    box.className = "card warn";
    box.innerHTML = `<div class="hint">Way home to ${esc(nameOf(home))}</div><div class="big">No mapped route</div>
      <p class="hint">The chain has no path from here to home. Map the holes you came through.</p>`;
    return;
  }
  const left = w.left, tier = left == null ? "warn" : left <= 10 * 60e3 ? "bad" : left <= 30 * 60e3 ? "warn" : "ok";
  box.className = `card ${tier}`;
  const weak = w.weakest ? S.chain.links[w.weakest] : null;
  box.innerHTML = `<div class="hint">Way home to ${esc(nameOf(home))}: ${w.jumps} jump${w.jumps > 1 ? "s" : ""}</div>
    <div class="big countdown">${left == null ? "unknown" : dur(left)}</div>
    <div class="hint">${left == null ? "Guaranteed open time is unknown: check Show Info on every hole on the way."
      : left <= 0 ? `the guaranteed time has run out${weak ? ` on ${esc(nameOf(weak.a))} to ${esc(nameOf(weak.b))}` : ""}; it may close any moment`
      : `guaranteed open for at least this long${weak ? `; weakest hole ${esc(nameOf(weak.a))} to ${esc(nameOf(weak.b))}` : ""}`}</div>
    ${w.unknown.length ? `<div class="hint" style="color:var(--warn)">Age unknown: ${w.unknown.map(k => esc(pairName(k))).join("; ")}. Paste its Show Info.</div>` : ""}
    ${w.crit.length ? `<div class="hint" style="color:var(--bad)">Mass critical: ${w.crit.map(k => esc(pairName(k))).join("; ")}. A heavy ship may close it.</div>` : ""}`;
  checkAlarms(w, left);
}
const pairName = k => { const l = S.chain.links[k]; return l ? `${nameOf(l.a)} to ${nameOf(l.b)}` : k; };
/* one alarm per threshold crossed; when several are crossed at once (a hole
   just marked end of life), only the most urgent one sounds */
function checkAlarms(w, left) {
  if (left == null) return;
  const crossed = ALARMS.filter(([th]) => left <= th && !S.alerted.has(`${w.weakest}:${th}:${w.lo}`));
  if (!crossed.length) return;
  for (const [th] of crossed) S.alerted.add(`${w.weakest}:${th}:${w.lo}`);
  const [th, text] = crossed[crossed.length - 1];
  const msg = th === 0 ? "Way home: the guaranteed time is up. A hole on your way home may close any moment."
                       : `Way home: guaranteed open for only ${text} more.`;
  feed(msg, "bad");
  toast(msg, 12000);
  alarm();
}

function renderScoreCard() {
  const box = $("#svScore");
  if (!box) return;
  const me = S.me || S.ledger[surveyor().id];
  const pts = me?.pts || 0, rank = X.rankOf(pts);
  const got = me ? Object.keys(me.badges || {}) : [];
  const pct = rank.next ? Math.round((pts / rank.next.at) * 100) : 100;
  box.innerHTML = `<div class="hint">${esc(surveyor().name)}${sharing() ? " · corp board" : " · this browser"}</div>
    <div class="big">${esc(rank.name)}</div>
    <div>${pts} survey points${rank.next ? ` · ${rank.next.at - pts} to ${esc(rank.next.name)}` : ""}</div>
    <div class="bar"><span style="width:${Math.min(100, pct)}%"></span></div>
    <div class="badges">${X.BADGES.map(b => `<span class="badge${got.includes(b.id) ? " got" : ""}" title="${esc(b.name)}: ${esc(b.desc)}">${esc(b.short)}</span>`).join("")}</div>
    <div class="row"><button id="svBadges">Badges</button><button id="svBoard">Corp board</button></div>`;
  $("#svBadges").onclick = showBadges;
  $("#svBoard").onclick = showBoard;
}
function showBadges() {
  const me = S.me || S.ledger[surveyor().id] || { badges: {} };
  modal(`<h3 style="margin-top:0">Survey badges</h3>
    <table>${X.BADGES.map(b => `<tr><td><span class="badge${me.badges?.[b.id] ? " got" : ""}">${esc(b.short)}</span></td>
      <td><b>${esc(b.name)}</b><div class="hint">${esc(b.desc)}</div></td>
      <td class="hint">${me.badges?.[b.id] ? `earned ${new Date(me.badges[b.id]).toLocaleDateString()}` : ""}</td></tr>`).join("")}</table>
    <h3>Points</h3><table>${Object.entries(X.POINTS).map(([a, p]) => `<tr><td>${esc(POINT_NAMES[a] || a)}</td><td>${p}</td>
      <td class="hint">${X.DAILY_CAP[a] ? `up to ${X.DAILY_CAP[a]} a day` : ""}</td></tr>`).join("")}</table>
    <div class="row" style="justify-content:flex-end"><button data-close>Close</button></div>`);
}
const POINT_NAMES = { jump_link: "Wormhole found by flying it", confirm: "Confirming a gate-less move", first_visit: "First corp survey of a J-system",
  new_sigs: "Each new signature", hole_typed: "Naming a hole's type", hole_status: "Show Info check", static_found: "First record of a static",
  dscan: "Directional scan saved", structure_new: "Each new structure found", note: "First note on a system" };
function showBoard() {
  const rows = (S.board.length ? S.board : X.leaderboard(S.ledger));
  modal(`<h3 style="margin-top:0">${sharing() ? "Corp survey board" : "Survey board (this browser only)"}</h3>
    ${rows.length ? `<table><tr><th>#</th><th>Pilot</th><th>Rank</th><th>Points</th><th>Badges</th></tr>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.rank)}</td><td>${r.pts}</td><td>${r.badges}</td></tr>`).join("")}</table>`
      : `<p class="hint">No points yet.</p>`}
    ${sharing() ? "" : `<p class="hint">Tick "share map with corp" to join the corp board; points there are awarded by the relay to verified pilots.</p>`}
    <div class="row" style="justify-content:flex-end"><button data-close>Close</button></div>`);
}

/* ---- feed, toasts, sounds -------------------------------------------------------------- */
function feed(text, kind = "") {
  S.feed.unshift({ at: Date.now(), text, kind });
  S.feed = S.feed.slice(0, 60);
  renderFeed();
}
function renderFeed() {
  const box = $("#svFeed");
  if (!box) return;
  box.innerHTML = `<h3>Activity</h3>` + (S.feed.length ? `<ul class="feed">${S.feed.map(f =>
    `<li class="${f.kind}"><span class="hint">${new Date(f.at).toLocaleTimeString()}</span> ${esc(f.text)}</li>`).join("")}</ul>`
    : `<p class="hint">Copies from EVE, jumps, points and alerts show here.</p>`);
}
let toastTimer;
function toast(msg, ms = 6000) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}
let audio;
function tone(freqs, len = 0.18) {
  try {
    audio = audio || new AudioContext();
    freqs.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      const t0 = audio.currentTime + i * (len + 0.05);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.start(t0); o.stop(t0 + len + 0.02);
    });
  } catch { /* no sound */ }
}
const chime = () => tone([660, 880]);
let flash;
function alarm() {
  tone([880, 660, 880, 660], 0.25);
  clearInterval(flash);
  let n = 0;
  const base = document.title;
  flash = setInterval(() => { document.title = n++ % 2 ? base : "!! WAY HOME !!"; if (n > 20) { clearInterval(flash); document.title = base; } }, 700);
}
function modal(html, onClose) {
  const box = document.createElement("div");
  box.className = "consent";
  box.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(box);
  const close = () => { box.remove(); if (onClose) onClose(); };
  box.querySelectorAll("[data-close]").forEach(b => b.onclick = close);
  box.onclick = e => { if (e.target === box) close(); };
  return box;
}

/* ---- small helpers ----------------------------------------------------------------- */
function age(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
function lookup(text) {
  return S.byName.get(String(text || "").trim().toLowerCase()) || null;
}
function attachSuggest(input, onPick) {
  const box = $("#suggest");
  let hits = [], on = 0;
  const show = () => {
    const t = input.value.trim().toLowerCase();
    if (t.length < 2) { box.hidden = true; return; }
    hits = [];
    for (const name of S.byName.keys()) {
      if (name.startsWith(t)) hits.push(name);
      if (hits.length >= 12) break;
    }
    if (!hits.length) { box.hidden = true; return; }
    on = 0;
    const r = input.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.bottom + 2}px` });
    box.innerHTML = hits.map((h, i) => `<div class="${i === on ? "on" : ""}" data-i="${i}">${esc(nameOf(S.byName.get(h)))}</div>`).join("");
    box.hidden = false;
    box.querySelectorAll("div").forEach(d => d.onmousedown = e => {
      e.preventDefault();
      input.value = nameOf(S.byName.get(hits[+d.dataset.i]));
      box.hidden = true;
      onPick();
    });
  };
  input.oninput = show;
  input.onblur = () => setTimeout(() => (box.hidden = true), 150);
  input.onkeydown = e => {
    if (e.key === "Enter") {
      if (!box.hidden && hits[on]) input.value = nameOf(S.byName.get(hits[on]));
      box.hidden = true;
      onPick();
    }
  };
}
function showLinkHelp() {
  modal(`<h3 style="margin-top:0">Survey Link</h3>
    <p>Survey Link is a small helper for Windows that runs next to EVE. Copy the probe scanner, the directional scanner or a
       wormhole's Show Info in game, and it lands here on its own: no clicking over to this screen. It also reads EVE's
       Local chat log, so the survey knows about a jump about a second after it happens.</p>
    <p>It only passes on copies shaped like those three EVE windows; anything else on your clipboard never leaves it.
       It talks only to this page, on this computer, and never touches the game client.</p>
    <ol>
      <li>Download both files into one folder:
        <a href="link/Start-SurveyLink.bat" download>Start-SurveyLink.bat</a> and
        <a href="link/SurveyLink.ps1" download>SurveyLink.ps1</a>.</li>
      <li>Double-click <b>Start-SurveyLink.bat</b>. A window opens; leave it open while you survey. Close it to stop.</li>
      <li>The first time, Chrome or Edge asks to let this site reach apps on your device. Click <b>Allow</b>.</li>
    </ol>
    <p class="hint">Status: ${S.link.ok ? `connected${S.link.logs ? ", reading chat logs" : ", chat logs not found"}` : `not connected (${esc(S.link.err || "not started")})`}.</p>
    <div class="row" style="justify-content:flex-end"><button data-close>Close</button></div>`);
}

/* ---- start ---------------------------------------------------------------------------- */
function isChromium() {
  const brands = navigator.userAgentData?.brands || [];
  return brands.some(b => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
}
async function start() {
  if (!isChromium()) {
    modal(`<h3 style="margin-top:0">Please use Chrome or Edge</h3>
      <p>J-Space Survey needs Google Chrome or Microsoft Edge (or another Chromium browser) for Survey Link and
         background timers. Open this page in one of those.</p>`);
    return;
  }
  const cfg = await fetch("../data/sso.json").then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  if (window.EveSSO) {
    EveSSO.clientId = cfg.clientId || "";
    EveSSO.redirectUri = new URL("../", location.href).href;
  }
  S.relay = (cfg.relay || "").replace(/\/$/, "");
  S.home = store.get(K_HOME, null);
  await loadData();
  /* earlier versions saved POS modules as structures; keep only towers and Upwell structures */
  let fixed = false;
  for (const rec of Object.values(S.kb)) {
    for (const [k, st] of Object.entries(rec.structures || {})) {
      const info = S.ST[S.typeByName.get(String(st.type).toLowerCase())];
      if (info && info[2] === "P" && info[1] !== "Control Tower") { delete rec.structures[k]; fixed = true; }
    }
  }
  if (fixed) saveKb();

  const dl = document.createElement("datalist");
  dl.id = "whCodes";
  dl.innerHTML = Object.keys(S.WH).map(c => `<option value="${c}">`).join("");
  document.body.appendChild(dl);

  $("#login").onclick = () => (window.EveSSO && EveSSO.configured() ? EveSSO.login() : toast("Login is not configured."));
  $("#share").checked = store.get(K_SHARE, false);
  $("#share").onchange = e => {
    if (e.target.checked) { e.target.checked = false; askShare(); }
    else { store.set(K_SHARE, false); renderStatus(); }
  };
  $("#linkChip").onclick = showLinkHelp;
  $("#scoreChip").onclick = showBadges;
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  attachSuggest($("#rootInput"), () => { const id = lookup($("#rootInput").value); if (id) { setRoot(id); select(id); } else toast("Unknown system name."); });
  $("#rootHere").onclick = () => { if (S.here) { setRoot(S.here.system); select(S.here.system); } else toast("No location yet."); };
  $("#rootHome").onclick = () => { const h = store.get(K_HOME, null); if (h) { setRoot(h); select(h); } else toast("No home saved yet."); };
  $("#setHome").onclick = () => { if (S.root) { store.set(K_HOME, S.root); S.home = S.root; toast(`Home saved: ${nameOf(S.root)}.`); } };
  if (S.root) $("#rootInput").value = nameOf(S.root);

  /* paste anywhere: Ctrl+V on the page (outside text boxes) routes the copy */
  document.addEventListener("paste", e => {
    if (e.target.closest("input, textarea")) return;
    const text = e.clipboardData?.getData("text");
    if (text) { e.preventDefault(); routePaste(text, "paste"); }
  });
  document.addEventListener("pointerdown", () => { if (audio?.state === "suspended") audio.resume(); }, { once: false });

  setView(S.view === "chain" ? "chain" : "surveyor");
  renderPilots();
  renderStatus();
  renderLinkChip();
  renderScore();
  poll();
  linkPoll();
  setInterval(poll, POLL_MS);
  setInterval(linkPoll, 350);
  setInterval(sync, SYNC_MS);
  setInterval(renderTimers, 1000);
  setInterval(() => { C.prune(S.chain, Date.now()); saveLocal(); render(); }, 60e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); sync(); } });
  sync();
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function gate() {
  let ok = false;
  try { ok = sessionStorage.getItem(GATE_KEY) === "1"; } catch { /* private mode */ }
  if (ok) return Promise.resolve();
  return new Promise(resolve => {
    const box = document.createElement("div");
    box.className = "consent";
    box.style.background = "var(--bg)";
    box.innerHTML = `<div>
      <h3 style="margin-top:0">J-Space Survey is in development</h3>
      <p>Testers only for now. Enter the password to continue, or go <a href="../">back to the Atlas</a>.</p>
      <form class="row" id="gateForm"><input type="password" id="gatePw" autocomplete="off" placeholder="password" autofocus>
        <button class="primary">Open</button></form>
      <div id="gateMsg" class="hint"></div></div>`;
    document.body.appendChild(box);
    box.querySelector("#gateForm").onsubmit = async e => {
      e.preventDefault();
      if (await sha256hex("new-eden-atlas:" + box.querySelector("#gatePw").value) === GATE_HASH) {
        try { sessionStorage.setItem(GATE_KEY, "1"); } catch { /* private mode */ }
        box.remove();
        resolve();
      } else {
        box.querySelector("#gateMsg").textContent = "That is not the password.";
        box.querySelector("#gatePw").select();
      }
    };
  });
}
gate().then(start).catch(e => { document.body.insertAdjacentHTML("beforeend", `<div class="toast">J-Space Survey failed to start: ${esc(e.message)}</div>`); });
