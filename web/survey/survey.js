/* J-Space Survey: wormhole chain mapper that feeds the New Eden Atlas.

   - Logins are the Atlas's own (shared localStorage on this origin); CCP
     returns to the Atlas page, which hands the pilot back here.
   - Tracked pilots are polled every 10 seconds while this page is open. A
     move between systems with no stargate between them becomes a link: in
     wormhole space at once, between two known-space systems only after the
     pilot confirms it (it could be a cyno, a clone jump or a filament).
   - The chain lives in this browser. With "share map with corp" ticked it
     is merged with the corp's copy on the Atlas relay, where only verified
     members of the same corporation can read it.
   - Rules for merging, expiry and parsing are in chain_core.mjs, shared with
     the relay and covered by tests. */
import * as C from "./chain_core.mjs";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const K_CHAIN = "atlas.survey.chain", K_ROOT = "atlas.survey.root", K_HOME = "atlas.survey.home",
      K_SHARE = "atlas.survey.share", K_TRACK = "atlas.survey.track";
const CAPSULES = new Set([670, 33328]);
const POLL_MS = 10e3, SYNC_MS = 15e3;

const S = {
  J: {}, K: { s: {}, g: {} }, WH: {}, CL: {},
  byName: new Map(),
  chain: C.prune(store.get(K_CHAIN, C.emptyChain()), Date.now()),
  pending: [], relay: "", corp: null,
  track: store.get(K_TRACK, {}),          // pilotId -> bool (default on)
  where: {},                               // pilotId -> {system, ship, docked, online, name}
  root: store.get(K_ROOT, null), sel: null,
  syncing: false, lastSync: null, syncErr: "",
};

/* ---- reference data ----------------------------------------------------- */
const classOf = id => (C.isJ(id) ? S.J[id]?.[1] : null);
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
function classTone(c) {
  return c >= 1 && c <= 6 ? `var(--c${c})` : "var(--sp)";
}
const nameOf = id => label(id).name;

async function loadData() {
  const get = p => fetch(p).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  [S.J, S.K, S.WH, S.CL] = await Promise.all([get("../data/jspace/systems.json"), get("../data/jspace/kspace.json"),
    get("../data/jspace/wormholes.json"), get("../data/jspace/classes.json")]);
  for (const [id, v] of Object.entries(S.J)) S.byName.set(v[0].toLowerCase(), +id);
  for (const [id, v] of Object.entries(S.K.s)) S.byName.set(v[0].toLowerCase(), +id);
}

/* ---- chain edits ---------------------------------------------------------- */
function edit(op) {
  op.at = op.at ?? Date.now();
  C.applyOp(S.chain, op, S.WH);
  if (sharing()) S.pending.push(op);
  saveLocal();
  render(true);
  if (sharing()) sync();
}
function saveLocal() { store.set(K_CHAIN, S.chain); }

function addLink(a, b, extra = {}) {
  const key = C.linkKey(a, b);
  if (S.chain.links[key]) {
    if (extra.confirmed && !S.chain.links[key].confirmed) edit({ kind: "link", key, rec: { confirmed: true } });
    return;
  }
  edit(C.newLink(a, b, Date.now(), "", extra));
}

/* ---- pilots: login and tracking ---------------------------------------------- */
const pilots = () => (window.EveSSO && EveSSO.configured() ? EveSSO.pilots() : []);
const tracked = id => S.track[id] !== false;

async function poll() {
  for (const p of pilots()) {
    if (!tracked(p.id)) continue;
    try {
      const w = S.where[p.id] || { name: p.name };
      if (!w.onlineAt || Date.now() - w.onlineAt > 60e3) {
        w.online = !!(await EveSSO.esi(p.id, `/characters/${p.id}/online`)).online;
        w.onlineAt = Date.now();
      }
      if (!w.online && w.system) { S.where[p.id] = w; continue; }
      const [loc, ship] = await Promise.all([EveSSO.esi(p.id, `/characters/${p.id}/location`),
                                             EveSSO.esi(p.id, `/characters/${p.id}/ship`)]);
      const prev = w.system, now = loc.solar_system_id;
      const docked = !!(loc.station_id || loc.structure_id);
      const becameCapsule = CAPSULES.has(ship.ship_type_id) && w.ship && !CAPSULES.has(w.ship);
      if (prev && now !== prev) onMove(p, prev, now, { becameCapsule, dockedOnArrival: docked });
      Object.assign(w, { system: now, ship: ship.ship_type_id, docked, name: p.name, err: "" });
      S.where[p.id] = w;
    } catch (e) {
      S.where[p.id] = { ...(S.where[p.id] || { name: p.name }), err: e.message };
    }
  }
  renderPilots();
  render();
}

function onMove(p, from, to, opts) {
  const kind = C.classifyMove(from, to, S.K.g, opts);
  if (kind === "wormhole") {
    addLink(from, to, { confirmed: true });
    toast(`${p.name}: ${nameOf(from)} to ${nameOf(to)} added to the chain.`);
  } else if (kind === "unsure") {
    addLink(from, to, { confirmed: false });
    toast(`${p.name} moved ${nameOf(from)} to ${nameOf(to)} with no gate between them. ` +
          `If it was a wormhole, confirm it in the system panel.`);
  }
  if (!S.root || !S.chain.links || !inChain(S.root)) setRoot(to);
}
const inChain = id => Object.values(S.chain.links).some(l => l.a === id || l.b === id);

/* ---- corp sharing via the Atlas relay --------------------------------------- */
const sharing = () => !!(S.relay && store.get(K_SHARE, false) && pilots().length);
async function sync() {
  if (!sharing() || S.syncing) return;
  S.syncing = true;
  const sent = S.pending.splice(0);
  try {
    const p = pilots()[0];
    const r = await fetch(`${S.relay}/chain${sent.length ? "/ops" : ""}`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: await EveSSO.token(p.id), ops: sent }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    S.corp = body.corporation;
    /* the corp copy is the base; edits made while this request was out go back on top */
    S.chain = body.chain;
    for (const op of S.pending) C.applyOp(S.chain, op, S.WH);
    C.prune(S.chain, Date.now());
    saveLocal();
    S.lastSync = new Date();
    S.syncErr = "";
  } catch (e) {
    S.pending.unshift(...sent);
    S.syncErr = String(e.message || e);
  } finally {
    S.syncing = false;
    renderStatus();
    render();
  }
}

function askShare() {
  const box = document.createElement("div");
  box.className = "consent";
  box.innerHTML = `<div>
    <h3 style="margin-top:0">Share this map with your corporation?</h3>
    <p>Sharing sends the chain in this browser (systems, wormholes, signatures and notes) to the Atlas relay.
       It is kept for your corporation only, and only pilots the relay verifies as members of that corporation can read it.
       Links found from your jumps carry your pilot's name, so corp mates will see where you have been in wormhole space.</p>
    <p>Nothing is shared until you tick the box. You can untick it at any time.</p>
    <label class="row"><input type="checkbox" id="cs"> Yes, share my survey map with my corporation</label>
    <div class="row" style="justify-content:flex-end"><button id="cc">Cancel</button><button id="ok" class="primary">Save</button></div>
  </div>`;
  document.body.appendChild(box);
  box.querySelector("#cc").onclick = () => { box.remove(); $("#share").checked = store.get(K_SHARE, false); };
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
  return ops;
}

/* ---- rendering: header ---------------------------------------------------- */
function renderPilots() {
  const ps = pilots();
  $("#login").textContent = ps.length ? "Add pilot" : "Log in with EVE";
  $("#shareWrap").hidden = !(S.relay && ps.length);
  $("#pilots").innerHTML = ps.map(p => {
    const w = S.where[p.id] || {};
    const at = w.system ? nameOf(w.system) : "";
    const state = !tracked(p.id) ? "not tracked" : w.err ? "error" : w.online === false ? "offline" : at;
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

/* ---- rendering: chain ------------------------------------------------------- */
const NW = 170, NH = 50, GX = 70, GY = 18, PAD = 20;
const SIZE_SHORT = { S: "S frigate", M: "M cruiser", L: "L battleship", XL: "XL capital" };
const MASS_TONE = { stable: "var(--ink-dim)", destab: "var(--warn)", crit: "var(--bad)" };

function setRoot(id) {
  S.root = id;
  store.set(K_ROOT, id);
  $("#rootInput").value = id ? nameOf(id) : "";
  render(true);
}

/* force=false (timers) leaves the side panel alone while the pilot is typing in it */
function render(force = false) {
  const svg = $("#chain");
  const links = Object.values(S.chain.links);
  $("#counts").textContent = `${links.length} link${links.length === 1 ? "" : "s"} · ` +
    `${Object.values(S.chain.sigs).reduce((n, t) => n + Object.keys(t).length, 0)} signatures`;
  if (!S.root || (!links.length && !S.sel)) {
    svg.innerHTML = "";
    svg.setAttribute("width", 0); svg.setAttribute("height", 0);
    $("#empty").hidden = false;
    $("#empty").innerHTML = `<p><b>No chain yet.</b> Log in with EVE and fly through a wormhole: with tracking on,
      each jump draws itself here. You can also type a system in the Root box and add connections by hand.</p>
      <p>In each system, open the probe scanner, select all, copy, and paste into <b>Signatures</b>.
      Tag a wormhole with its type (B274, K162 and so on) or paste its Show Info text to record size, age and mass.</p>`;
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

  const edge = (from, to, key, cross) => {
    const l = S.chain.links[key], a = pos.get(from), b = pos.get(to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const tone = MASS_TONE[l.mass] || "var(--ink-faint)";
    const width = { S: 1.5, M: 2.5, L: 3.5, XL: 5 }[l.size || sizeOf(l)] || 2;
    const dash = !l.confirmed ? "6 4" : cross ? "2 4" : "";
    const hrs = Math.max(0, (l.expires - Date.now()) / C.HOUR);
    const lab = [l.code || "", l.life === "eol" ? "EOL" : "", `${hrs < 1 ? "<1" : Math.round(hrs)}h`].filter(Boolean).join(" ");
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${tone}" stroke-width="${width}"
              ${dash ? `stroke-dasharray="${dash}"` : ""} opacity="${cross ? .55 : 1}"/>
            <text x="${mx}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" font-size="11"
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

/* ---- rendering: side panel ------------------------------------------------------ */
function select(id) { S.sel = id; render(true); }

function renderSide(force = true) {
  const side = $("#side");
  const id = S.sel ?? S.root;
  if (!force && side.dataset.for === String(id) && side.contains(document.activeElement)) return;
  side.dataset.for = String(id);
  if (!id) { side.innerHTML = `<p class="hint">Pick a system in the chain, or type one in the Root box.</p>`; return; }
  const L = label(id);
  const j = S.J[id], k = S.K.s[id];
  const meta = C.isJ(id)
    ? `${esc(L.cls)} · ${esc(j?.[2] || "no effect")} · ${esc(j?.[3] || "")} / ${esc(j?.[4] || "")} · ${j?.[5] ?? "?"} planets, ${j?.[6] ?? "?"} moons`
    : `${esc(L.cls)} · ${esc(k?.[2] || "")} · <a href="../#s=${encodeURIComponent(L.name)}">open in Atlas</a>`;
  const mine = Object.entries(S.chain.links).filter(([, l]) => l.a === id || l.b === id)
    .sort((x, y) => (x[1].confirmed === y[1].confirmed ? 0 : x[1].confirmed ? 1 : -1));
  const sigs = Object.entries(S.chain.sigs[id] || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const whSigs = sigs.filter(([, s]) => /wormhole/i.test(s.type) || !s.type);
  const note = S.chain.notes[id]?.text || "";

  side.innerHTML = `
    <h2 style="color:${L.tone}">${esc(L.name)}</h2>
    <div class="meta">${meta}</div>
    <div class="row" style="margin-top:8px">
      <button id="mkRoot">Make root</button>
    </div>

    <h3>Connections</h3>
    ${mine.length ? mine.map(([key, l]) => linkCard(key, l, id, whSigs)).join("") : `<p class="hint">None yet.</p>`}
    <div class="row"><input id="addTo" placeholder="connect to system..." autocomplete="off" size="20">
      <button id="addBtn">Add</button></div>

    <h3>Signatures</h3>
    <textarea id="sigPaste" rows="3" placeholder="Probe scanner: select all, copy, paste here"></textarea>
    <div class="row"><label><input type="checkbox" id="sigReplace" checked> paste is the full list
      (removes signatures that are gone)</label><button id="sigGo">Save</button></div>
    ${sigs.length ? `<table><tr><th>ID</th><th>Type</th><th>Name</th><th>%</th><th>Age</th><th></th></tr>
      ${sigs.map(([sid, s]) => `<tr><td>${esc(sid)}</td><td>${esc(s.type || "?")}</td><td>${esc(s.name)}</td>
        <td>${Math.round(s.pct || 0)}</td><td>${age(s.first)}</td>
        <td class="x"><button class="xbtn" data-delsig="${esc(sid)}" title="Remove">x</button></td></tr>`).join("")}</table>`
      : `<p class="hint">No signatures recorded.</p>`}

    <h3>Notes</h3>
    <textarea id="note" rows="3" placeholder="Residents, structures, statics, anything useful">${esc(note)}</textarea>
    ${S.chain.notes[id]?.by ? `<div class="hint">last edit by ${esc(S.chain.notes[id].by)}</div>` : ""}
  `;
  side.querySelector("#mkRoot").onclick = () => setRoot(id);
  side.querySelector("#addBtn").onclick = () => {
    const to = lookup(side.querySelector("#addTo").value);
    if (!to) return toast("Unknown system name.");
    if (to === id) return;
    addLink(id, to, { confirmed: true });
  };
  attachSuggest(side.querySelector("#addTo"), () => side.querySelector("#addBtn").click());
  side.querySelector("#sigGo").onclick = () => {
    const parsed = C.parseSigs(side.querySelector("#sigPaste").value);
    if (!parsed.length) return toast("No signatures found in that paste. Copy from the probe scanner window.");
    edit({ kind: "sigs", system: id, parsed, replace: side.querySelector("#sigReplace").checked });
    toast(`${parsed.length} signature${parsed.length > 1 ? "s" : ""} saved for ${L.name}.`);
  };
  side.querySelectorAll("[data-delsig]").forEach(b => b.onclick = () =>
    edit({ kind: "del", what: "sig", system: id, id: b.dataset.delsig }));
  side.querySelector("#note").onchange = e => edit({ kind: "note", system: id, text: e.target.value });
  side.querySelectorAll(".link").forEach(wireLinkCard);
}

function linkCard(key, l, here, whSigs) {
  const other = l.a === here ? l.b : l.a;
  const O = label(other);
  const mySig = l.a === here ? l.sigA : l.sigB;
  const hrs = Math.max(0, (l.expires - Date.now()) / C.HOUR);
  const wh = l.code ? S.WH[l.code] : null;
  const info = wh && !wh.exit
    ? `${l.code}: to ${S.CL[wh.to] || "?"}, ${C.SIZES[C.sizeFromJump(wh.jump)] || "?"}, ${wh.life}h life, ${(wh.mass / 1e9).toFixed(2)}B kg total`
    : l.code === "K162" ? "K162: exit side; the other side's type sets the limits" : "type not set";
  const opt = (v, cur, text) => `<option value="${v}"${v === (cur || "") ? " selected" : ""}>${text}</option>`;
  return `<div class="link${l.confirmed ? "" : " unsure"}" data-key="${key}" data-here="${here}">
    <div class="row"><span class="to" data-go="${other}" style="color:${O.tone}">${esc(O.name)}</span>
      <span class="tag" style="color:${O.tone}">${esc(O.cls)}</span>
      <span class="spacer"></span><span class="hint">${hrs < 1 ? "under 1h" : `about ${Math.round(hrs)}h`} left</span></div>
    ${l.confirmed ? "" : `<div class="row hint" style="color:var(--warn)">Found from a move with no gate between the systems.
      <button data-act="confirm">It was a wormhole</button><button data-act="del">Discard</button></div>`}
    <div class="row">
      <input data-f="code" list="whCodes" placeholder="type, e.g. B274" size="9" value="${esc(l.code || "")}">
      <select data-f="sig">${opt("", mySig, "sig here")}${whSigs.map(([sid]) => opt(sid, mySig, sid)).join("")}</select>
      <select data-f="size">${opt("", l.size, "size")}${Object.entries(SIZE_SHORT).map(([k2, v]) => opt(k2, l.size, v)).join("")}</select>
    </div>
    <div class="row">
      <select data-f="life">${opt("", l.life, "age")}${opt("fresh", l.life, "fresh")}${opt("decay", l.life, "under a day")}${opt("eol", l.life, "end of life")}</select>
      <select data-f="mass">${opt("", l.mass, "mass")}${opt("stable", l.mass, "stable")}${opt("destab", l.mass, "reduced")}${opt("crit", l.mass, "critical")}</select>
      <button data-act="info" title="Paste the wormhole's Show Info text">Paste Show Info</button>
      <button data-act="del" title="Remove this connection">Remove</button>
    </div>
    <div class="hint">${esc(info)}${l.by ? ` · by ${esc(l.by)}` : ""}</div>
  </div>`;
}

function wireLinkCard(card) {
  const key = card.dataset.key, here = +card.dataset.here;
  const l = S.chain.links[key];
  const set = rec => edit({ kind: "link", key, rec });
  card.querySelector("[data-go]").onclick = e => select(+e.target.dataset.go);
  card.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    if (b.dataset.act === "confirm") set({ confirmed: true });
    if (b.dataset.act === "del") edit({ kind: "del", what: "link", key });
    if (b.dataset.act === "info") {
      const text = prompt("Paste the wormhole's Show Info description:");
      if (!text) return;
      const r = C.parseShowInfo(text);
      if (!Object.keys(r).length) return toast("Nothing recognised in that text.");
      const rec = {};
      if (r.size) rec.size = r.size;
      if (r.mass) rec.mass = r.mass;
      if (r.life) { rec.life = r.life; rec.lifeAt = Date.now(); }
      set(rec);
      toast(`Read: ${Object.entries(r).map(([k2, v]) => `${k2} ${v}`).join(", ")}.`);
    }
  });
  card.querySelectorAll("[data-f]").forEach(f => f.onchange = () => {
    const v = f.value.trim().toUpperCase();
    if (f.dataset.f === "code") {
      if (v && !S.WH[v]) return toast(`${v} is not a known wormhole type.`);
      const rec = { code: v || null, codeAt: v ? here : null };
      const size = v && v !== "K162" ? C.sizeFromJump(S.WH[v]?.jump) : null;
      if (size && !l.size) rec.size = size;
      set(rec);
    } else if (f.dataset.f === "sig") {
      set(l.a === here ? { sigA: f.value || null } : { sigB: f.value || null });
    } else if (f.dataset.f === "life") {
      set({ life: f.value || null, lifeAt: f.value ? Date.now() : null });
    } else {
      set({ [f.dataset.f]: f.value || null });
    }
  });
}

/* ---- small helpers ---------------------------------------------------------------- */
function age(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
function lookup(text) {
  const t = String(text || "").trim().toLowerCase();
  return S.byName.get(t) || null;
}
let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

/* name suggestions for system inputs, from about 8,100 names */
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

/* ---- start --------------------------------------------------------------------- */
async function start() {
  const cfg = await fetch("../data/sso.json").then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  if (window.EveSSO) {
    EveSSO.clientId = cfg.clientId || "";
    EveSSO.redirectUri = new URL("../", location.href).href;
  }
  S.relay = (cfg.relay || "").replace(/\/$/, "");
  await loadData();

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
  attachSuggest($("#rootInput"), () => { const id = lookup($("#rootInput").value); if (id) { setRoot(id); select(id); } else toast("Unknown system name."); });
  $("#rootHere").onclick = () => {
    const w = Object.values(S.where).find(x => x.system);
    if (w) { setRoot(w.system); select(w.system); } else toast("No tracked pilot location yet.");
  };
  $("#rootHome").onclick = () => { const h = store.get(K_HOME, null); if (h) { setRoot(h); select(h); } else toast("No home saved yet."); };
  $("#setHome").onclick = () => { if (S.root) { store.set(K_HOME, S.root); toast(`Home saved: ${nameOf(S.root)}.`); } };
  if (S.root) $("#rootInput").value = nameOf(S.root);

  renderPilots();
  renderStatus();
  render();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(sync, SYNC_MS);
  setInterval(() => { C.prune(S.chain, Date.now()); saveLocal(); render(); }, 60e3);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); sync(); } });
  sync();
}
start().catch(e => { document.body.insertAdjacentHTML("beforeend", `<div class="toast">J-Space Survey failed to start: ${esc(e.message)}</div>`); });
