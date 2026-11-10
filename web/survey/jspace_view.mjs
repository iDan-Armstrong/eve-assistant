/* J-Space Survey: the Systems view of the survey page.

   One J-system at a time: its traits, star, planets and moons come from the
   game data (data/jspace/bodies), and planet scans come from the pilots.

   A planet scan is captured one resource at a time. The pilot presses Input
   scan results, then in game hovers a resource in the planet's scan panel and
   takes a screenshot (Win+Shift+S). The picture arrives through Survey Link
   or a paste (Ctrl+V), text recognition reads the planet, the resource and
   its density from it, and the scan is saved with the pilot's resolution
   (Planetology plus Advanced Planetology). Rules in jspace_core.mjs.

   With sharing on, scans and pictures go to the Atlas relay (the org's room,
   or the public room when the org shares J-Space publicly). Otherwise, and
   for pictures while the relay has no picture storage, they stay in this
   browser (scans in localStorage, pictures in IndexedDB). */
import * as J from "./jspace_core.mjs";

const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const SKILLS_SCOPE = "esi-skills.read_skills.v1";
const K_JP = "atlas.jspace.planets", K_LOCALSHOT = "atlas.jspace.localShots", K_SEL = "atlas.jspace.sel";
const ARM_MS = 3 * 3600e3;          /* capturing stays on until stopped, or three hours without a picture */
const MAX_JPEG = 430e3;

let X;            // the page's helpers, from init()
const V = {
  types: null, shards: {}, sys: null, planet: null,
  jp: {}, localShots: {},                // scans; resource key -> local picture
  armed: 0, busy: false, queue: [], recent: [],
  skills: {}, tess: null, urls: new Map(),
};

export function init(ctx) {
  X = ctx;
  V.jp = X.store.get(K_JP, {});
  V.localShots = X.store.get(K_LOCALSHOT, {});
  const sel = X.store.get(K_SEL, null);
  if (sel) { V.sys = sel.sys; V.planet = sel.planet; }
}
export const armed = () => Date.now() < V.armed;
/* called every few seconds: when capturing has timed out, the panels say so */
let shownArmed = false;
export function tick() {
  if (armed() !== shownArmed) { shownArmed = armed(); if (X && X.$("#jsCapture")) render(); }
}
const save = () => { X.store.set(K_JP, V.jp); X.store.set(K_LOCALSHOT, V.localShots); X.store.set(K_SEL, { sys: V.sys, planet: V.planet }); };

/* ---- reference data ------------------------------------------------------------- */
async function bodiesOf(sys) {
  if (!V.types) V.types = await fetch("../data/jspace/body_types.json").then(r => r.json());
  const n = sys % 16;
  if (!V.shards[n]) V.shards[n] = await fetch(`../data/jspace/bodies/${n}.json`).then(r => r.json());
  return V.shards[n][sys] || null;
}
const typeName = id => (V.types && V.types[id]) || "";
const planetLabel = (sys, p) => `${X.nameOf(sys)} ${J.roman(p[1])}`;

/* ---- the scanning pilot and their resolution ------------------------------------ */
function scanPilot() {
  const ps = X.pilots();
  const here = ps.find(p => X.S.where[p.id]?.system === V.sys || X.S.logWhere[p.name] === V.sys);
  const s = X.surveyor();
  return here || ps.find(p => String(p.id) === s.id) || ps[0] || null;
}
async function resolutionFor(p) {
  if (!p) return null;
  if (!p.scopes.includes(SKILLS_SCOPE)) return null;
  const c = V.skills[p.id];
  if (c && Date.now() - c.at < 10 * 60e3) return c.res;
  const r = await window.EveSSO.esi(p.id, `/characters/${p.id}/skills`);
  const res = J.resolutionOf(r.skills);
  V.skills[p.id] = { res, at: Date.now() };
  return res;
}

/* ---- pictures kept in this browser ------------------------------------------------ */
function idb() {
  return new Promise((ok, bad) => {
    const rq = indexedDB.open("atlas-jspace", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("shots");
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => bad(rq.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((ok, bad) => {
    const tx = db.transaction("shots", mode);
    const rq = fn(tx.objectStore("shots"));
    tx.oncomplete = () => ok(rq?.result);
    tx.onerror = () => bad(tx.error);
  });
}
const keyOf = (sys, planet, resource) => `${sys}/${planet}/${resource}`;

async function shotUrl(sys, planet, resource, rec) {
  const k = keyOf(sys, planet, resource);
  const want = rec?.shot ? `r:${rec.shot}` : V.localShots[k] ? `l:${V.localShots[k]}` : null;
  if (!want) return null;
  if (V.urls.has(want)) return V.urls.get(want);
  let blob = null;
  if (want.startsWith("r:")) {
    const p = X.pilots()[0];
    const r = await fetch(`${X.S.relay}/jspace/shot`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: await window.EveSSO.token(p.id), org: X.shareOrg(), key: rec.shot }) });
    if (r.ok) blob = await r.blob();
  } else {
    blob = await idbDo("readonly", s => s.get(V.localShots[k])).catch(() => null);
  }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  V.urls.set(want, url);
  return url;
}

/* ---- loading a system ------------------------------------------------------------- */
export async function show(sys) {
  if (sys && sys !== V.sys) { V.sys = sys; V.planet = null; save(); }
  await render();
  if (V.sys && X.sharing()) {
    try {
      const body = await X.relayPost("/jspace/get", { systems: [V.sys] });
      V.shots = body.shots;
      V.jp = J.mergeStores(V.jp, body.planets);
      save();
      render();
    } catch (e) { X.toast(`Could not load shared scans (${e.message}).`); }
  }
}

/* ---- rendering ---------------------------------------------------------------------- */
const pct = d => `<span class="jd"><span style="width:${Math.max(2, d)}%"></span></span>`;

export async function render() {
  const left = X.$("#jsSystem"), mid = X.$("#jsPlanet"), right = X.$("#jsCapture");
  if (!left) return;
  if (!V.sys) {
    left.innerHTML = `${pickerHtml()}<p class="hint">Pick a J-system, or press Where I am.</p>`;
    mid.innerHTML = ""; renderCapture(); wirePicker(); return;
  }
  const b = await bodiesOf(V.sys);
  const L = X.label(V.sys);
  const scans = V.jp[V.sys] || {};
  const rows = (b?.planets || []).map(p => {
    const kind = J.planetKind(typeName(p[2]));
    const got = Object.keys(scans[p[0]] || {}).length;
    const need = J.resourcesOf(typeName(p[2])).length;
    return `<tr class="jrow${p[0] === V.planet ? " on" : ""}" data-p="${p[0]}">
      <td>${J.roman(p[1])}</td><td>${X.esc(kind)}</td><td>${p[7].length}</td>
      <td>${need ? `<span class="st ${got >= need ? "st-identified" : got ? "st-to-finish" : "st-unscanned"}">${got}/${need}</span>` : `<span class="hint">no resources</span>`}</td></tr>`;
  }).join("");
  left.innerHTML = `${pickerHtml()}
    <h2 style="color:${L.tone};margin:8px 0 2px">${X.esc(L.name)}</h2>
    <div class="meta">${X.systemMeta(V.sys)}</div>
    <div class="row">${X.isJ(V.sys) ? `<span class="hint">Statics:</span> ${X.staticsHtml(V.sys)}` : ""}</div>
    <div class="meta">Star: ${X.esc(typeName(b?.star?.[0]) || "unknown")}</div>
    ${b ? `<div class="row"><button id="js3d">3D view</button></div>` : ""}
    <h3>Planets</h3>
    ${b ? `<table class="jtable"><thead><tr><th></th><th>Type</th><th>Moons</th><th>Scanned</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="hint">No planet data for this system.</p>`}`;
  wirePicker();
  const b3 = X.$("#js3d");
  if (b3) b3.onclick = () => open3d(b);
  left.querySelectorAll(".jrow").forEach(tr => tr.onclick = () => { V.planet = +tr.dataset.p; save(); render(); });
  renderPlanet(b);
  renderCapture();
}

function pickerHtml() {
  return `<div class="row"><input id="jsPick" placeholder="J-system name" autocomplete="off" size="14" value="${V.sys ? X.esc(X.nameOf(V.sys)) : ""}">
    <button id="jsHere">Where I am</button></div>`;
}
function wirePicker() {
  const inp = X.$("#jsPick");
  X.attachSuggest(inp, () => { const id = X.lookup(inp.value); if (id) show(id); else X.toast("Unknown system name."); });
  X.$("#jsHere").onclick = () => { if (X.S.here?.system) show(X.S.here.system); else X.toast("No location yet."); };
}

function renderPlanet(b) {
  const mid = X.$("#jsPlanet");
  const p = b?.planets.find(x => x[0] === V.planet);
  if (!p) { mid.innerHTML = `<h3>Planet</h3><p class="hint">Pick a planet on the left to see its scans.</p>`; return; }
  const tname = typeName(p[2]);
  const scans = V.jp[V.sys]?.[p[0]] || {};
  const res = J.resourcesOf(tname);
  mid.innerHTML = `<h3>${X.esc(planetLabel(V.sys, p))} · ${X.esc(J.planetKind(tname))}</h3>
    <div class="meta">Radius ${p[6].toLocaleString()} km · ${p[7].length} moon${p[7].length === 1 ? "" : "s"}</div>
    ${res.length ? `<div class="jres">${res.map(r => {
      const s = scans[r];
      return `<div class="jr" data-r="${X.esc(r)}">
        <div class="jthumb" data-r="${X.esc(r)}">${s || V.localShots[keyOf(V.sys, p[0], r)] ? "" : "<span class='hint'>no picture</span>"}</div>
        <div><b>${X.esc(r)}</b>
        ${s ? `<div class="row">${pct(s.d)} <b>${s.d}%</b></div>
               <div class="hint">resolution ${s.res} · ${X.esc(s.by || "you")} · ${X.age(s.at)} ago</div>`
            : `<div class="hint">not scanned</div>`}</div></div>`;
    }).join("")}</div>` : `<p class="hint">This planet type has no resources to scan.</p>`}
    <div class="row" style="margin-top:8px"><button class="primary" id="jsArm">${armed() ? "Stop capturing" : "Input scan results"}</button></div>`;
  X.$("#jsArm").onclick = () => { V.armed = armed() ? 0 : Date.now() + ARM_MS; renderPlanet(b); renderCapture(); };
  for (const r of res) {
    const box = mid.querySelector(`.jthumb[data-r="${CSS.escape(r)}"]`);
    shotUrl(V.sys, p[0], r, scans[r]).then(url => {
      if (!url || !box) return;
      box.innerHTML = `<img src="${url}" alt="${X.esc(r)} scan">`;
      box.onclick = () => X.modal(`<img src="${url}" style="max-width:min(1200px,90vw);display:block" alt="${X.esc(r)} scan">
        <div class="row" style="justify-content:flex-end"><button data-close>Close</button></div>`);
    });
  }
}

function renderCapture() {
  const box = X.$("#jsCapture");
  if (!box) return;
  const on = armed();
  shownArmed = on;
  box.innerHTML = `<h3>Scan capture</h3>
    ${on ? `<p class="ok-text">Waiting for scan pictures.</p>
      <ol class="tight"><li>Pick the planet in the list here, then in game open it and press <b>Scan</b>.</li>
      <li>Click a resource, then hover it so the tooltip shows its <b>Resource Density</b> and what it is <b>Required For</b>.</li>
      <li>Press <b>Win+Shift+S</b> and capture the panel, the tooltip and the planet.</li>
      <li>${X.S.link.ok ? "Survey Link brings the picture here." : "Click this page and press <b>Ctrl+V</b>."} Repeat for each resource.</li></ol>`
      : `<p class="hint">Press <b>Input scan results</b> on a planet to start. Pictures are only taken while capturing is on.</p>`}
    ${V.busy ? `<p class="hint">Reading a picture…</p>` : ""}
    ${V.recent.map(c => captureHtml(c)).join("")}`;
  box.querySelectorAll("[data-fix]").forEach(f => wireFix(f));
}
function captureHtml(c) {
  if (c.state === "saved") return `<div class="jcap ok">${X.esc(c.text)}</div>`;
  if (c.state === "error") return `<div class="jcap bad">${X.esc(c.text)}</div>`;
  /* needs the pilot: pick what text recognition could not read */
  const b = V.shards[V.sys % 16]?.[V.sys];
  const planets = b?.planets || [];
  const p = planets.find(x => x[0] === c.planet);
  const res = p ? J.resourcesOf(typeName(p[2])) : J.ALL_RESOURCES;
  return `<div class="jcap warn" data-fix="${c.id}">
    <div class="hint">${X.esc(c.text)}</div>
    <div class="row"><select data-k="planet">${planets.map(x => `<option value="${x[0]}"${x[0] === c.planet ? " selected" : ""}>${X.esc(planetLabel(V.sys, x))}</option>`).join("")}</select>
      <select data-k="resource">${res.map(r => `<option${r === c.resource ? " selected" : ""}>${X.esc(r)}</option>`).join("")}</select>
      <input data-k="d" type="number" min="0" max="100" size="4" value="${c.d ?? ""}" placeholder="%">
      <button data-k="save">Save</button><button data-k="drop">Drop</button></div></div>`;
}
function wireFix(el) {
  const c = V.recent.find(x => String(x.id) === el.dataset.fix);
  el.querySelector('[data-k="planet"]').onchange = e => { c.planet = +e.target.value; renderCapture(); };
  el.querySelector('[data-k="drop"]').onclick = () => { V.recent = V.recent.filter(x => x !== c); renderCapture(); };
  el.querySelector('[data-k="save"]').onclick = () => {
    c.planet = +el.querySelector('[data-k="planet"]').value;
    c.resource = el.querySelector('[data-k="resource"]').value;
    c.d = +el.querySelector('[data-k="d"]').value;
    if (!(c.d >= 0 && c.d <= 100) || el.querySelector('[data-k="d"]').value === "") { X.toast("Enter the density, 0 to 100."); return; }
    commit(c);
  };
}

/* ---- reading a picture ------------------------------------------------------------- */
async function tesseract() {
  if (V.tess) return V.tess;
  if (!window.Tesseract) {
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = TESS_URL; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  const w = await window.Tesseract.createWorker("eng");
  await w.setParameters({ tessedit_pageseg_mode: "11" });
  V.tess = w;
  return w;
}
/* keep the light grey interface text, drop the coloured heat map; text black on white, twice the size */
function textOnly(bmp) {
  const c = document.createElement("canvas");
  c.width = bmp.width * 2; c.height = bmp.height * 2;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const v = mx > 120 && mx - mn < 40 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}
async function jpegOf(bmp) {
  for (const [w, q] of [[1400, 0.82], [1200, 0.72], [1000, 0.62], [800, 0.55]]) {
    const s = Math.min(1, w / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", q));
    if (blob.size <= MAX_JPEG) return blob;
  }
  return null;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error("timed out")), ms))]);
let nextId = 1;
/* a picture from Survey Link or a paste */
export async function takeImage(blob, source) {
  if (!armed()) return false;
  V.armed = Date.now() + ARM_MS;       /* each picture keeps capturing on */
  V.queue.push({ blob, source });
  if (!V.busy) drain();
  return true;
}
async function drain() {
  V.busy = true; renderCapture();
  while (V.queue.length) {
    const { blob } = V.queue.shift();
    const c = { id: nextId++, state: "fix", text: "" };
    try {
      const bmp = await createImageBitmap(blob);
      c.jpeg = await jpegOf(bmp);
      let got = { system: null, index: null, resource: null, density: null };
      try {
        const w = await withTimeout(tesseract(), 60e3);
        const { data } = await withTimeout(w.recognize(textOnly(bmp)), 60e3);
        got = J.parseScanText(data.text);
      } catch (e) {
        V.tess = null;            /* text recognition failed to load or run: the pilot fills in the values */
      }
      await place(c, got);
    } catch (e) {
      c.state = "error"; c.text = `That is not a picture the survey can use (${e.message || e}).`;
    }
    V.recent.unshift(c);
    V.recent = V.recent.slice(0, 8);
    if (c.state === "ready") await commit(c);
    renderCapture();
  }
  V.busy = false; renderCapture();
}
/* the capture goes to the planet picked in the list: text recognition reads
   planet numerals too unreliably (III as II) to move a scan on its own. The
   planet it read is used only when none is picked, and a capture that looks
   like another system is held for the pilot to check. */
async function place(c, got) {
  const b = await bodiesOf(V.sys);
  const near = (a, b2) => a && b2 && a.length === b2.length && [...a].filter((ch, i) => ch !== b2[i]).length <= 2;
  const otherSys = got.system && !near(got.system.toUpperCase(), X.nameOf(V.sys).toUpperCase());
  let p = b?.planets.find(x => x[0] === V.planet) || null;
  if (!p && got.index && !otherSys) p = b?.planets.find(x => x[1] === got.index) || null;
  c.planet = p ? p[0] : null;
  const allowed = p ? J.resourcesOf(typeName(p[2])) : [];
  c.resource = got.resource && allowed.includes(got.resource) ? got.resource : null;
  c.d = got.density;
  const where = p ? planetLabel(V.sys, p) : "no planet picked";
  const what = [where, c.resource || (got.resource ? `${got.resource} (not on this planet)` : "resource not read"),
    got.density != null ? `${got.density}%` : "density not read"].join(", ");
  if (otherSys) { c.state = "fix"; c.text = `This picture looks like ${got.system}, not ${X.nameOf(V.sys)}. Read: ${what}. Check and save.`; }
  else if (p && c.resource && c.d != null && got.sure) { c.state = "ready"; c.text = what; }
  else if (p && c.resource && c.d != null) { c.state = "fix"; c.text = `Read: ${what}. The resource name was not certain: check it and save.`; }
  else { c.state = "fix"; c.text = `Read: ${what}. Check and save.`; }
  if (p && p[0] !== V.planet) { V.planet = p[0]; save(); render(); }
}

/* ---- saving --------------------------------------------------------------------------- */
async function commit(c) {
  const p = scanPilot();
  const name = `${X.nameOf(V.sys)} ${J.roman((V.shards[V.sys % 16]?.[V.sys]?.planets.find(x => x[0] === c.planet) || [0, 0])[1])}`;
  try {
    if (X.sharing() && p) {
      if (!p.scopes.includes(SKILLS_SCOPE)) { askSkills(p); throw new Error("the survey needs permission to read skills"); }
      const image = c.jpeg ? await b64(c.jpeg) : null;
      const r = await X.relayPost("/jspace/scan", { system: V.sys, planet: c.planet, resource: c.resource, d: c.d, image }, p);
      if (!r.applied) throw new Error(r.reason || "not saved");
      J.applyScan(V.jp, { system: V.sys, planet: c.planet, resource: c.resource, d: c.d, res: r.res, by: r.by, at: r.at, shot: r.shot });
      if (!r.shot && c.jpeg) await keepLocal(c);
      c.text = `Saved ${c.resource} ${c.d}% on ${name}, resolution ${r.res}${r.shot ? "" : " (picture kept in this browser)"}.`;
    } else {
      const res = await resolutionFor(p);
      if (res == null) { if (p) askSkills(p); throw new Error("sign in, and allow the survey to read skills, so the scan gets a resolution"); }
      const r = J.applyScan(V.jp, { system: V.sys, planet: c.planet, resource: c.resource, d: c.d, res, by: p.name, at: Date.now() });
      if (!r.applied) throw new Error(r.reason);
      if (c.jpeg) await keepLocal(c);
      c.text = `Saved ${c.resource} ${c.d}% on ${name}, resolution ${res} (this browser only).`;
    }
    c.state = "saved";
    save();
    X.feed(c.text, "pts");
  } catch (e) {
    c.state = "error"; c.text = `${c.resource || "Scan"} on ${name} not saved: ${e.message || e}.`;
  }
  render();
}
async function keepLocal(c) {
  const k = keyOf(V.sys, c.planet, c.resource);
  const id = `${k}/${Date.now()}`;
  const old = V.localShots[k];
  await idbDo("readwrite", s => { if (old) s.delete(old); return s.put(c.jpeg, id); });
  V.localShots[k] = id;
}
const b64 = blob => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.readAsDataURL(blob); });

function askSkills(p) {
  X.modal(`<h3 style="margin-top:0">Allow the survey to read skills</h3>
    <p>A planet scan is saved with its resolution, from ${X.esc(p.name)}'s Planetology and Advanced Planetology.
       Sign in once more and allow skills to be read. Nothing else changes.</p>
    <div class="row" style="justify-content:flex-end"><button data-close>Not now</button><button class="primary" id="jsSkills">Sign in</button></div>`);
  X.$("#jsSkills").onclick = () => window.EveSSO.login([SKILLS_SCOPE]);
}

/* ---- 3D system view ------------------------------------------------------------------
   The Atlas's own orrery, fed from the game data in bodies/ (positions in km,
   turned to AU) and the scans: a scanned planet's profile lists each resource
   with its density, resolution and picture. */
const AU_KM = 1.495978707e8;
const SPECTRAL_K = { O: 30000, B: 15000, A: 9000, F: 7000, G: 5600, K: 4500, M: 3200 };
async function open3d(b) {
  const sys = V.sys, L = X.label(sys), name = X.nameOf(sys);
  const au = p => [p[0] / AU_KM, p[1] / AU_KM, p[2] / AU_KM];
  const scans = V.jp[sys] || {};
  const planets = [];
  for (const p of b.planets) {
    const tname = typeName(p[2]), pname = `${name} ${J.roman(p[1])}`;
    const res = J.resourcesOf(tname), got = scans[p[0]] || {};
    const rows = [];
    for (const r of res) {
      const s = got[r];
      let cell = s ? `<b>${s.d}%</b> · res ${s.res} · ${X.esc(s.by || "")} · ${X.age(s.at)} ago` : "not scanned";
      if (s) {
        const url = await shotUrl(sys, p[0], r, s).catch(() => null);
        if (url) cell += `<img src="${url}" alt="${X.esc(r)} scan" data-full="${url}">`;
      }
      rows.push([X.esc(r), cell]);
    }
    const n = Object.keys(got).length;
    planets.push({
      id: p[0], name: pname, type: tname, pos: au(p.slice(3, 6)), radiusKm: p[6], st: null, belts: [],
      moons: p[7].map(m => ({ id: m[0], name: `${pname} - Moon ${m[1]}`, pos: au(m.slice(2, 5)) })),
      pi: res, scanRows: rows,
      tag: res.length ? `${n}/${res.length}` : "", tagCls: res.length && n >= res.length ? "scanned" : "",
    });
  }
  const st = typeName(b.star?.[0]);
  const host = X.$("#orrery");
  try {
    const { openOrrery } = await import("../orrery.js");
    openOrrery(host, {
      system: { name, sec: -1, region: "", constellation: "" },
      crumbs: `${X.esc(L.cls)} · ${X.esc(L.sub || "no effect")} · J-Space Survey`,
      keys: `<span class="orr-key"><i class="k-moon"></i> moon</span>
             <span class="orr-key" style="color:#8ff0b0">green label = every resource scanned</span>
             <span class="orr-key">click a planet for its scans and pictures</span>`,
      cel: { star: st ? { id: sys, name: `${name} - Star`, type: st, tempK: SPECTRAL_K[(st.match(/Sun ([OBAFGKM])/) || [])[1]] || 0,
                          radiusKm: b.star[1] } : null,
             planets, gates: [] },
      stations: [], secColor: "#e0524f", closeLabel: "✕ close",
    });
    host.onclick = e => {
      const img = e.target.closest(".orr-profile img");
      if (img) X.modal(`<img src="${img.dataset.full}" style="max-width:min(1200px,90vw);display:block" alt="">
        <div class="row" style="justify-content:flex-end"><button data-close>Close</button></div>`);
    };
  } catch (err) {
    X.toast(`The 3D view could not start (${err.message || err}).`);
  }
}
