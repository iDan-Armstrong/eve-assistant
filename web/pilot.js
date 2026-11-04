/* Pilot overlay: signed-in characters' location, ship, assets, clones,
   PI colonies, industry jobs and mining ledger, joined onto the map by
   system ID. Uses EveSSO (sso.js) for tokens and PilotCore
   (pilot_core.js) for the asset rollup. Loaded after the main script and
   started by boot() through startPilots(). */
"use strict";

const pilotState = {
  data: new Map(),          // characterId -> loaded record
  active: null,             // characterId used by the route planner
  layer: L.layerGroup(), rings: [],
  prices: null, names: new Map(), structures: new Map(), newStations: new Map(),
};
const PILOT_COLORS = { assets: "#ffcf4a", here: "#ffffff", clone: "#5fd4ff", pi: "#7be37b", mined: "#c7a6ff" };

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const typeName = id => pilotState.names.get(id) || `type ${id}`;
const sysName = id => (state.byId.get(id) || {}).name || `system ${id}`;
/* NPC stations: the static table first, then any station newer than it,
   looked up once from public ESI (pilotState.newStations) */
const stationSystem = (() => {
  let m = null;
  return () => {
    m = m || new Map([...state.stations.values()].flat().map(s => [s.id, s.systemId]));
    for (const [id, st] of pilotState.newStations) if (st) m.set(id, st.system);
    return m;
  };
})();
const stationName = id => {
  for (const list of state.stations.values()) for (const s of list) if (s.id === id) return s.name;
  const st = pilotState.newStations.get(id);
  return st ? st.name : null;
};

async function startPilots() {
  const cfg = await fetch("data/sso.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));
  EveSSO.clientId = cfg.clientId || "";
  reserves.relay = (cfg.relay || "").replace(/\/$/, "");
  loadSightings();
  setInterval(loadSightings, 5 * 60e3);
  setInterval(reportReserves, 10 * 60e3);
  setInterval(() => { reportPresence(); loadCorpmates(); }, 2 * 60e3);
  let note = "";
  try {
    const p = await EveSSO.init();
    if (p) {
      pilotState.active = p.id; note = `Signed in as ${p.name}`;
    }
  } catch (e) { note = e.message; }
  wirePilotMenu();
  renderPilotMenu(note);
  await refreshPilots();
  askUndecided();
}

async function refreshPilots() {
  const pilots = EveSSO.pilots();
  if (!pilots.length) { pilotState.data.clear(); drawPilots(); renderPilotMenu(); return; }
  if (!pilotState.active || !pilots.some(p => p.id === pilotState.active)) pilotState.active = pilots[0].id;
  renderPilotMenu("loading pilot data…");
  if (!pilotState.prices) {
    try {
      const rows = await EveSSO.esiPublic("/markets/prices");
      pilotState.prices = new Map(rows.map(r => [r.type_id, r.average_price || r.adjusted_price || 0]));
    } catch { pilotState.prices = new Map(); }
  }
  await Promise.all(pilots.map(p => loadPilot(p).catch(e => {
    pilotState.data.set(p.id, { id: p.id, name: p.name, errors: [e.message] });
  })));
  await resolveNames();
  drawPilots();
  reportReserves();
  reportPresence();
  loadCorpmates();
  renderCorpMenu();
  renderPilotMenu();
  if (state.selected) renderPilotHere(state.byId.get(state.selected));
}

async function loadPilot(pilot) {
  const id = pilot.id, errors = [];
  const get = path => EveSSO.esi(id, path).catch(e => { errors.push(e.message); return null; });
  const [loc, ship, online, assets, clones, planets, jobs, mining] = await Promise.all([
    get(`/characters/${id}/location`), get(`/characters/${id}/ship`),
    get(`/characters/${id}/online`), get(`/characters/${id}/assets`),
    get(`/characters/${id}/clones`), get(`/characters/${id}/planets`),
    get(`/characters/${id}/industry/jobs`), get(`/characters/${id}/mining`)]);

  /* player structures: only names and systems we may see (docking access) */
  const roots = PilotCore.rootLocations(assets || []);
  const wanted = new Set(PilotCore.unknownStructures(roots));
  for (const c of (clones && clones.jump_clones) || []) if (c.location_type === "structure") wanted.add(c.location_id);
  if (clones && clones.home_location && clones.home_location.location_type === "structure") wanted.add(clones.home_location.location_id);
  for (const j of jobs || []) if (j.station_id > 1e12) wanted.add(j.station_id);
  if (loc && loc.structure_id) wanted.add(loc.structure_id);
  const todo = [...wanted].filter(s => !pilotState.structures.has(s));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(sid => EveSSO.esi(id, `/universe/structures/${sid}`)
      .then(s => pilotState.structures.set(sid, { system: s.solar_system_id, name: s.name }))
      .catch(() => pilotState.structures.set(sid, null))));
  }
  /* stations built after the static data export */
  const known = stationSystem();
  const stIds = new Set([...roots.values()].filter(l => PilotCore.isStation(l)));
  for (const c of (clones && clones.jump_clones) || []) if (PilotCore.isStation(c.location_id)) stIds.add(c.location_id);
  if (clones && clones.home_location && PilotCore.isStation(clones.home_location.location_id)) stIds.add(clones.home_location.location_id);
  for (const j of jobs || []) if (PilotCore.isStation(j.station_id)) stIds.add(j.station_id);
  if (loc && loc.station_id) stIds.add(loc.station_id);
  await Promise.all([...stIds].filter(s => !known.has(s) && !pilotState.newStations.has(s)).map(sid =>
    EveSSO.esiPublic(`/universe/stations/${sid}`)
      .then(st => pilotState.newStations.set(sid, { system: st.system_id, name: st.name }))
      .catch(() => pilotState.newStations.set(sid, null))));

  const structures = new Map([...pilotState.structures].filter(([, v]) => v));
  const roll = PilotCore.rollup(assets || [], roots, stationSystem(), structures, pilotState.prices);

  const placeSystem = (lid) => {
    const pl = PilotCore.placeOf(lid, stationSystem(), structures);
    return pl && pl.system;
  };
  const placeLabel = (lid) => stationName(lid) ||
    (pilotState.structures.get(lid) && pilotState.structures.get(lid).name) ||
    (PilotCore.isSystem(lid) ? sysName(lid) : "a player structure you have no access to");

  pilotState.data.set(id, {
    id, name: pilot.name, errors,
    loc: loc && { system: loc.solar_system_id, dock: loc.station_id || loc.structure_id || null },
    ship: ship && { type: ship.ship_type_id, name: ship.ship_name },
    online: online && online.online,
    assets: roll, assetCount: (assets || []).length,
    home: clones && clones.home_location && {
      system: placeSystem(clones.home_location.location_id), label: placeLabel(clones.home_location.location_id) },
    clones: ((clones && clones.jump_clones) || []).map(c => ({
      system: placeSystem(c.location_id), label: c.name || placeLabel(c.location_id) })),
    planets: planets || [],
    jobs: (jobs || []).map(j => ({ ...j, system: placeSystem(j.station_id) })),
    mining: PilotCore.miningBySystem(mining),
  });
}

/* type names for everything we will print, one bulk call per 1000 ids */
async function resolveNames() {
  const ids = new Set();
  for (const d of pilotState.data.values()) {
    if (d.ship) ids.add(d.ship.type);
    if (d.assets) for (const s of d.assets.bySystem.values()) s.top.slice(0, 6).forEach(t => ids.add(t[0]));
    for (const j of d.jobs || []) ids.add(j.product_type_id || j.blueprint_type_id);
    if (d.mining) for (const m of d.mining.values()) for (const t of m.types.keys()) ids.add(t);
  }
  const todo = [...ids].filter(i => i && !pilotState.names.has(i));
  for (let i = 0; i < todo.length; i += 1000) {
    try {
      const rows = await EveSSO.esiPublic("/universe/names", todo.slice(i, i + 1000));
      rows.forEach(r => pilotState.names.set(r.id, r.name));
    } catch { /* names fall back to type ids */ }
  }
}

/* ---- map --------------------------------------------------------------- */
function drawPilots() {
  pilotState.layer.clearLayers();
  pilotState.rings = [];
  const add = (sysId, color, extra, opts = {}) => {
    const p = state.byId.get(sysId);
    if (!p) return null;
    const m = L.circleMarker(p.ll, { renderer: canvas, interactive: false, fill: false,
      color, weight: 2, opacity: .95, ...opts });
    pilotState.layer.addLayer(m);
    pilotState.rings.push({ m, extra });
    return m;
  };
  const value = new Map();
  for (const d of pilotState.data.values()) {
    if (d.assets) for (const [sys, s] of d.assets.bySystem) value.set(sys, (value.get(sys) || 0) + s.value);
    for (const c of d.clones || []) if (c.system) add(c.system, PILOT_COLORS.clone, 3, { weight: 1.5, dashArray: "2 2" });
    if (d.home && d.home.system) add(d.home.system, PILOT_COLORS.clone, 3, { weight: 2 });
    for (const pl of d.planets || []) add(pl.solar_system_id, PILOT_COLORS.pi, 9, { weight: 1.4 });
  }
  for (const [sys, v] of value) {
    add(sys, PILOT_COLORS.assets, 5 + Math.max(0, Math.log10(Math.max(v, 1)) - 6) * 1.5,
        { weight: 2.2, fill: true, fillOpacity: .12, fillColor: PILOT_COLORS.assets });
  }
  for (const d of pilotState.data.values()) {
    if (!d.loc) continue;
    const m = add(d.loc.system, PILOT_COLORS.here, 12, { weight: 2.4, dashArray: "5 3" });
    if (m) m.bindTooltip(esc(d.name), { permanent: true, direction: "top", offset: [0, -16],
                                        className: "pilot-tag" });
  }
  sizePilotRings();
  drawReserves();
  map.fire("moveend");                       /* re-place labels around the name tags */
  document.getElementById("rPilot").hidden = !pilotState.data.size;
  const box = document.getElementById("tPilots");
  box.closest("label").hidden = !pilotState.data.size;
  if (pilotState.data.size && box.checked) pilotState.layer.addTo(map);
}
function sizePilotRings() {
  const r = radiusFor(map.getZoom());
  for (const { m, extra } of pilotState.rings) m.setRadius(r + extra);
}

/* ---- system panel -------------------------------------------------------- */
function renderPilotHere(p) {
  const box = document.getElementById("pPilot");
  if (!box) return;
  const blocks = [];
  const cm = corpmatesLine(p);
  if (cm) blocks.push(`<div class="rb-head"><span class="rb-level" style="color:#7ef0c8">Corp mates here</span></div>` +
                      `<div class="rb-line">${cm}</div>`);
  const rl = reserveLine(p);
  if (rl) blocks.push(`<div class="rb-head"><span class="rb-level" style="color:${PILOT_COLORS.mined}">Bulwark reserve</span></div>` +
                      `<div class="rb-line">${rl}</div>`);
  for (const d of pilotState.data.values()) {
    const lines = [];
    if (d.loc && d.loc.system === p.id) {
      lines.push(`<b>You are here</b>${d.ship ? ` in ${esc(typeName(d.ship.type))}` : ""}` +
                 (d.loc.dock ? `, docked at ${esc(stationName(d.loc.dock) || (pilotState.structures.get(d.loc.dock) || {}).name || "a structure")}` : ""));
    }
    const a = d.assets && d.assets.bySystem.get(p.id);
    if (a) {
      lines.push(`Assets: ${a.items.toLocaleString()} items, about <b>${fmtIsk(a.value)} ISK</b> in ${a.places.size} location${a.places.size === 1 ? "" : "s"}`);
      for (const loc of a.places.keys()) {
        const nm = stationName(loc) || (pilotState.structures.get(loc) || {}).name || (PilotCore.isSystem(loc) ? "in space" : null);
        if (nm) lines.push(`&nbsp;&nbsp;${esc(nm)}`);
      }
      lines.push(`&nbsp;&nbsp;most valuable: ${a.top.slice(0, 4).map(([t, q, v]) =>
        `${esc(typeName(t))}${q > 1 ? ` ×${q.toLocaleString()}` : ""}${v ? ` (${fmtIsk(v)})` : ""}`).join(", ")}`);
    }
    if (d.home && d.home.system === p.id) lines.push(`Home clone: ${esc(d.home.label)}`);
    for (const c of d.clones || []) if (c.system === p.id) lines.push(`Jump clone: ${esc(c.label)}`);
    for (const pl of d.planets || []) {
      if (pl.solar_system_id === p.id) {
        lines.push(`PI colony: ${esc(pl.planet_type)} planet, ${pl.num_pins} structures, command center level ${pl.upgrade_level}`);
      }
    }
    for (const j of d.jobs || []) {
      if (j.system === p.id && j.status === "active") {
        lines.push(`Industry job: ${esc(typeName(j.product_type_id || j.blueprint_type_id))}, ends ${new Date(j.end_date).toUTCString().slice(5, 22)}`);
      }
    }
    const m = d.mining && d.mining.get(p.id);
    const ore = p.bulwark && p.bulwark.oreTypeId;
    if (m && ore && m.types.has(ore)) {
      lines.push(`<b>Reserve confirmed</b> by the mining ledger: ${m.types.get(ore).toLocaleString()} ` +
                 `${esc(p.bulwark.ore)} mined here, last on ${m.last.get(ore)}`);
    }
    if (m) {
      lines.push(`Mined here (30d): ${m.qty.toLocaleString()} units: ` +
        [...m.types].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([t, q]) => `${esc(typeName(t))} ${q.toLocaleString()}`).join(", "));
    }
    if (lines.length) {
      blocks.push(`<div class="rb-head"><span class="rb-level" style="color:${PILOT_COLORS.assets}">${esc(d.name)}</span></div>` +
                  lines.map(l => `<div class="rb-line">${l}</div>`).join(""));
    }
  }
  box.innerHTML = blocks.join("");
}

/* ---- header menu ----------------------------------------------------------- */
function wirePilotMenu() {
  const btn = document.getElementById("pilotBtn"), menu = document.getElementById("pilotMenu");
  btn.onclick = () => {
    if (!EveSSO.pilots().length) { if (EveSSO.configured()) EveSSO.login(); return; }
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
  };
  document.addEventListener("click", e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
      menu.hidden = true; btn.setAttribute("aria-expanded", "false");
    }
  });
  const box = document.getElementById("tPilots");
  box.onchange = () => box.checked ? pilotState.layer.addTo(map) : pilotState.layer.remove();
  map.on("zoomend", sizePilotRings);
}
function renderPilotMenu(note = "") {
  const btn = document.getElementById("pilotBtn"), menu = document.getElementById("pilotMenu");
  const pilots = EveSSO.pilots();
  if (!EveSSO.configured()) {
    btn.textContent = "Pilot login";
    btn.disabled = true;
    btn.title = "Pilot login is being set up";
    return;
  }
  btn.disabled = false;
  if (!pilots.length) {
    btn.textContent = "Pilot login";
    btn.title = "Sign in with your EVE account: your data stays in this browser";
    menu.hidden = true;
    return;
  }
  const act = pilots.find(p => p.id === pilotState.active) || pilots[0];
  btn.innerHTML = `<img src="https://images.evetech.net/characters/${act.id}/portrait?size=32" alt="" width="18" height="18">` +
                  `${esc(act.name)}${pilots.length > 1 ? ` +${pilots.length - 1}` : ""}`;
  btn.title = "Your pilots";
  menu.innerHTML = pilots.map(p => {
    const d = pilotState.data.get(p.id) || {};
    const where = d.loc ? `${sysName(d.loc.system)}${d.ship ? `, ${typeName(d.ship.type)}` : ""}` : "";
    return `<div class="pm-row${p.id === pilotState.active ? " active" : ""}" data-id="${p.id}">
      <img src="https://images.evetech.net/characters/${p.id}/portrait?size=64" alt="" width="32" height="32">
      <div class="pm-who"><div>${d.online ? '<i class="pm-on" title="online"></i>' : ""}${esc(p.name)}</div>
        <div class="pm-where">${esc(where)}${d.errors && d.errors.length ? ` <span title="${esc(d.errors.join("; "))}">(partial data)</span>` : ""}</div></div>
      <button data-act="go" title="Show on map">◎</button>
      <button data-act="out" title="Sign out this pilot">✕</button></div>` +
      (reserves.relay ? `<div class="pm-shares" data-id="${p.id}">share with corp:
        <label><input type="checkbox" data-kind="reserves"${shareFor(p.id, "reserves") ? " checked" : ""}> reserves</label>
        <label><input type="checkbox" data-kind="location"${shareFor(p.id, "location") ? " checked" : ""}> location</label></div>` : "");
  }).join("") +
  `<div class="pm-foot"><button data-act="add">Add a character</button><button data-act="refresh">Refresh</button></div>` +
  (act.scopes.includes("esi-markets.structure_markets.v1")
    ? `<div class="pm-collector"><button data-act="collector">Copy ${esc(act.name)}'s token for the market collector</button>
       <div class="pm-note">Only for the GitHub secret EVE_MARKET_REFRESH_TOKEN. Treat it like a password.</div></div>` : "") +
  (reserves.relay ? `<div class="pm-note">Sharing sends that pilot's login to the Atlas relay, which checks it ` +
    `with CCP and keeps no token. Only members of the same corporation see shared reserves (no names) or ` +
    `locations (name, system, ship).</div>` : "") +
  `<div class="pm-note">${esc(note || "Tokens stay in this browser and go only to CCP, unless you share.")}</div>`;
  menu.querySelectorAll(".pm-shares input").forEach(box => box.onchange = e => {
    e.stopPropagation();
    const id = +box.closest(".pm-shares").dataset.id;
    setShare(id, { ...shares(id), [box.dataset.kind]: box.checked });
    if (box.dataset.kind === "reserves" && box.checked) reportReserves();
    if (box.dataset.kind === "location") reportPresence(box.checked ? null : id);
  });
  menu.querySelectorAll(".pm-row").forEach(row => {
    const id = +row.dataset.id;
    row.onclick = e => {
      const act = e.target.dataset.act;
      if (act === "out") { EveSSO.logout(id); pilotState.data.delete(id); refreshPilots(); return; }
      pilotState.active = id;
      const d = pilotState.data.get(id);
      if (act === "go" && d && d.loc) { select(d.loc.system); flyTo(state.byId.get(d.loc.system).ll, 7); }
      renderPilotMenu();
    };
  });
  menu.querySelector('[data-act="add"]').onclick = () => EveSSO.login();
  const coll = menu.querySelector('[data-act="collector"]');
  if (coll) coll.onclick = async () => {
    const p = JSON.parse(localStorage.getItem("atlas.pilots") || "{}")[act.id];
    try { await navigator.clipboard.writeText(p.refresh); coll.textContent = "Copied. Paste it into GitHub, then clear your clipboard."; }
    catch { coll.textContent = "Copy failed: your browser blocked clipboard access"; }
  };
  menu.querySelector('[data-act="refresh"]').onclick = () => refreshPilots();
}

/* ---- route planner hooks ----------------------------------------------------- */
function pilotLocationName() {
  const d = pilotState.data.get(pilotState.active);
  return d && d.loc ? sysName(d.loc.system) : null;
}
async function sendToAutopilot(path, progress = () => {}) {
  const id = pilotState.active;
  if (!id || !path || path.length < 2) return "Plan a route and sign in first.";
  const d = pilotState.data.get(id);
  try {
    const hops = path.slice(1);
    for (let i = 0; i < hops.length; i++) {
      progress(i + 1, hops.length);
      await EveSSO.esi(id, `/ui/autopilot/waypoint?add_to_beginning=false&clear_other_waypoints=${i === 0}` +
                          `&destination_id=${hops[i]}`, { method: "POST" });
    }
    return `Sent ${hops.length} waypoints to ${d ? d.name : "your pilot"}'s autopilot.`;
  } catch (e) {
    return `Autopilot update failed (${e.message}). The pilot must be logged in to the game.`;
  }
}

/* screen boxes covered by pilot name tags, so system labels steer clear */
function pilotTagBoxes() {
  const out = [];
  for (const d of pilotState.data.values()) {
    const p = d.loc && state.byId.get(d.loc.system);
    if (!p || !document.getElementById("tPilots").checked) continue;
    const pt = map.latLngToContainerPoint(p.ll);
    const w = textWidth(d.name, '700 12.5px "Chakra Petch", sans-serif') + 22;
    out.push({ x: pt.x - w / 2, y: pt.y - 16 - 26, w, h: 26 });
  }
  /* corp mates' tags hang below their system */
  if (typeof corpmates !== "undefined" && document.getElementById("tPilots").checked) {
    const seen = new Set();
    for (const r of corpmates.list.values()) {
      const p = state.byId.get(r.system);
      if (!p || seen.has(r.system)) continue;
      seen.add(r.system);
      const pt = map.latLngToContainerPoint(p.ll);
      const w = textWidth(r.name + " +9", '700 12.5px "Chakra Petch", sans-serif') + 22;
      out.push({ x: pt.x - w / 2, y: pt.y + 12, w, h: 26 });
    }
  }
  return out;
}

/* ---- Bulwark reserves: shared sightings ------------------------------------
   CCP publishes no record of the limited-time reserve sites. The one CCP
   record that shows them is a pilot's mining ledger, so the Atlas relay
   (worker/) collects verified ledger reads from pilots who opt in and
   keeps, per corporation and system: the reserve ore, the last day it
   was mined, and the last time a member's ledger grew there (mined within
   the hour). Only verified members of that corporation can read them, so
   the map never tells outsiders where miners are working. A signed-in
   pilot's own ledger adds to them locally even with sharing off. */
const reserves = { relay: "", shared: {}, activeMinutes: 60, layer: L.layerGroup(), rings: [], at: null };
/* per-pilot sharing choices: {reserves: bool, location: bool}, absent until asked */
const shares = id => { try { return JSON.parse(localStorage.getItem(`atlas.share.${id}`)) || {}; } catch { return {}; } };
const shareDecided = id => { try { return localStorage.getItem(`atlas.share.${id}`) !== null; } catch { return true; } };
const shareFor = (id, kind) => !!shares(id)[kind];
function setShare(id, choice) {
  try { localStorage.setItem(`atlas.share.${id}`, JSON.stringify(choice)); } catch { /* private mode */ }
}

/* corp-only: each signed-in pilot asks for their own corporation's
   sightings; a viewer with pilots in two corps sees both */
async function loadSightings() {
  const pilots = EveSSO.pilots();
  if (!reserves.relay || !pilots.length) { reserves.shared = {}; drawReserves(); return; }
  const merged = {}, corps = new Set();
  for (const p of pilots) {
    try {
      const r = await fetch(`${reserves.relay}/sightings`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: await EveSSO.token(p.id) }) }).then(x => x.json());
      if (!r.systems || corps.has(r.corporation)) continue;
      corps.add(r.corporation);
      reserves.activeMinutes = r.activeMinutes || 60;
      for (const [sys, s] of Object.entries(r.systems)) {
        const m = merged[sys] = merged[sys] || { ...s };
        if ((s.lastActive || "") > (m.lastActive || "")) m.lastActive = s.lastActive;
        if ((s.lastConfirmed || "") > (m.lastConfirmed || "")) m.lastConfirmed = s.lastConfirmed;
      }
    } catch { /* relay down: local sightings still show */ }
  }
  reserves.shared = merged;
  drawReserves();
}
async function reportReserves() {
  if (!reserves.relay) return;
  for (const p of EveSSO.pilots()) {
    if (!shareFor(p.id, "reserves")) continue;
    try {
      const token = await EveSSO.token(p.id);
      await fetch(`${reserves.relay}/report`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    } catch { /* one pilot failing must not stop the rest */ }
  }
  loadSightings();
}
/* shared sightings plus this browser's own ledgers: {systemId: {ore, lastActive, lastConfirmed}} */
function reserveSightings() {
  const out = {};
  for (const [id, s] of Object.entries(reserves.shared)) out[id] = { ...s };
  for (const d of pilotState.data.values()) {
    for (const [sys, m] of d.mining || []) {
      const p = state.byId.get(sys);
      const ore = p && p.bulwark && p.bulwark.oreTypeId;
      if (!ore || !m.types.has(ore)) continue;
      const s = out[sys] = out[sys] || { ore };
      const day = m.last.get(ore);
      if (!s.lastConfirmed || day > s.lastConfirmed) s.lastConfirmed = day;
    }
  }
  return out;
}
const reserveActive = s => s.lastActive && Date.now() - Date.parse(s.lastActive) < reserves.activeMinutes * 60e3;

function drawReserves() {
  reserves.layer.clearLayers();
  reserves.rings = [];
  for (const [id, s] of Object.entries(reserveSightings())) {
    const p = state.byId.get(+id);
    if (!p) continue;
    const active = reserveActive(s);
    const m = L.circleMarker(p.ll, { renderer: canvas, interactive: false,
      fill: active, fillColor: PILOT_COLORS.mined, fillOpacity: .25,
      color: PILOT_COLORS.mined, weight: active ? 3 : 1.6, opacity: active ? 1 : .75,
      dashArray: active ? null : "4 3" });
    reserves.layer.addLayer(m);
    reserves.rings.push({ m, extra: active ? 13 : 11 });
  }
  const r = radiusFor(map.getZoom());
  for (const { m, extra } of reserves.rings) m.setRadius(r + extra);
  const box = document.getElementById("tBulwark");
  if (!box.checked) reserves.layer.remove(); else reserves.layer.addTo(map);
  if (!reserves.wired) {
    reserves.wired = true;
    map.on("zoomend", () => { const r2 = radiusFor(map.getZoom()); for (const { m, extra } of reserves.rings) m.setRadius(r2 + extra); });
    box.addEventListener("change", () => box.checked ? reserves.layer.addTo(map) : reserves.layer.remove());
  }
  if (state.selected) renderPilotHere(state.byId.get(state.selected));
}
function reserveLine(p) {
  const s = reserveSightings()[p.id];
  if (!s || !p.bulwark) return "";
  if (reserveActive(s)) {
    const min = Math.max(1, Math.round((Date.now() - Date.parse(s.lastActive)) / 60e3));
    return `<b>Reserve active</b>: ${esc(p.bulwark.ore)} mined here ${min} min ago (your corporation)`;
  }
  return `Reserve last seen ${s.lastConfirmed}: ${esc(p.bulwark.ore)} in a corp mate's or your mining ledger`;
}

/* every signed-in pilot who has not chosen yet is asked, one at a time */
function askUndecided() {
  if (document.querySelector(".consent")) return;
  if (EveSSO.pilots().length && !devNoticeSeen()) { showDevNotice(); return; }   /* notice comes first */
  if (!reserves.relay) return;
  const next = EveSSO.pilots().find(p => !shareDecided(p.id));
  if (next) askToShare(next);
}

/* ask once per pilot, right after sign-in. Both boxes start unticked:
   sharing tracks where a pilot is and mines, so it needs express consent */
function askToShare(pilot) {
  const box = document.createElement("div");
  box.className = "consent";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Share with your corporation");
  box.innerHTML = `<div class="c-card"><h3>Share with your corporation?</h3>
    <p>${esc(pilot.name)} can share with <b>members of the same corporation only</b>. Nothing is shared
    unless you tick it.</p>
    <label class="c-opt"><input type="checkbox" data-kind="reserves"> <span><b>Bulwark reserve sightings</b>:
      light up reserves you mine, from your mining ledger. Shows system, ore and time, never your name.</span></label>
    <label class="c-opt"><input type="checkbox" data-kind="location"> <span><b>My location</b>: corp mates
      see your name, system and ship while you have the Atlas open.</span></label>
    <p class="c-small">To check, the Atlas relay reads that data from CCP with your login and keeps no token.
      You can change either choice any time in the pilot menu.</p>
    <div class="c-buttons"><button data-act="save">Save</button></div></div>`;
  document.body.appendChild(box);
  box.querySelector("[data-act=save]").onclick = () => {
    const choice = {};
    box.querySelectorAll("input").forEach(i => { choice[i.dataset.kind] = i.checked; });
    setShare(pilot.id, choice);
    box.remove();
    askUndecided();                           /* next pilot who has not chosen */
    reportReserves();
    reportPresence();
    renderPilotMenu();
  };
  const card = box.querySelector(".c-card");
  card.tabIndex = -1;
  card.focus();
}

/* ---- corp mates' locations -------------------------------------------------
   Pilots who tick "location" report their system, ship and online status
   every 2 minutes while the Atlas is open; the relay keeps them per
   corporation and serves them only to verified members of that corp. */
const corpmates = { list: new Map(), layer: L.layerGroup(), rings: [], corps: [], names: new Map(), focus: false };

async function reportPresence(stopId = null) {
  if (!reserves.relay) return;
  for (const p of EveSSO.pilots()) {
    const share = shareFor(p.id, "location");
    if (!share && p.id !== stopId) continue;
    try {
      await fetch(`${reserves.relay}/presence`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: await EveSSO.token(p.id), share }) });
    } catch { /* try again next round */ }
  }
  if (stopId) loadCorpmates();
}
async function loadCorpmates() {
  const pilots = EveSSO.pilots();
  if (!reserves.relay || !pilots.length) { corpmates.list.clear(); drawCorpmates(); return; }
  const own = new Set(pilots.map(p => p.id)), corps = new Set(), list = new Map();
  for (const p of pilots) {
    try {
      const r = await fetch(`${reserves.relay}/corpmates`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: await EveSSO.token(p.id) }) }).then(x => x.json());
      if (!r.pilots || corps.has(r.corporation)) continue;
      corps.add(r.corporation);
      for (const [id, rec] of Object.entries(r.pilots)) if (!own.has(+id)) list.set(+id, { ...rec, corp: r.corporation });
    } catch { /* relay down */ }
  }
  corpmates.list = list;
  corpmates.corps = [...corps];
  for (const c of corps) {
    if (corpmates.names.has(c)) continue;
    try { const info = await EveSSO.esiPublic(`/corporations/${c}`); corpmates.names.set(c, `${info.name} [${info.ticker}]`); }
    catch { corpmates.names.set(c, `corporation ${c}`); }
  }
  const missing = [...list.values()].map(r => r.ship).filter(t => t && !pilotState.names.has(t));
  if (missing.length) {
    try { (await EveSSO.esiPublic("/universe/names", [...new Set(missing)])).forEach(r => pilotState.names.set(r.id, r.name)); }
    catch { /* ship names fall back to type ids */ }
  }
  drawCorpmates();
}
function drawCorpmates() {
  corpmates.layer.clearLayers();
  corpmates.rings = [];
  const bySys = new Map();
  for (const [id, r] of corpmates.list) (bySys.get(r.system) || bySys.set(r.system, []).get(r.system)).push(r);
  for (const [sys, mates] of bySys) {
    const p = state.byId.get(sys);
    if (!p) continue;
    const m = L.circleMarker(p.ll, { renderer: canvas, interactive: false, fill: false,
      color: "#5cf2c0", weight: 2.4, opacity: 1, dashArray: "3 3" });
    m.bindTooltip(esc(mates.length > 1 ? `${mates[0].name} +${mates.length - 1}` : mates[0].name),
      { permanent: true, direction: "bottom", offset: [0, 14], className: "pilot-tag corp-tag" });
    corpmates.layer.addLayer(m);
    corpmates.rings.push({ m, extra: 9 });
  }
  const r = radiusFor(map.getZoom());
  for (const { m, extra } of corpmates.rings) m.setRadius(r + extra);
  const box = document.getElementById("tPilots");
  if (box.checked && corpmates.list.size) corpmates.layer.addTo(map); else corpmates.layer.remove();
  if (!corpmates.wired) {
    corpmates.wired = true;
    map.on("zoomend", () => { const r2 = radiusFor(map.getZoom()); for (const { m, extra } of corpmates.rings) m.setRadius(r2 + extra); });
    box.addEventListener("change", drawCorpmates);
  }
  if (state.selected) renderPilotHere(state.byId.get(state.selected));
  renderCorpMenu();
  applyCorpFocus();
  map.fire("moveend");                       /* re-place labels around the new tags */
}
function corpmatesLine(p) {
  const here = [...corpmates.list.values()].filter(r => r.system === p.id);
  if (!here.length) return "";
  return here.map(r => `${esc(r.name)}${r.ship ? ` (${esc(typeName(r.ship))})` : ""}` +
    `${r.online ? "" : ", offline"}`).join("; ");
}

/* ---- in-development notice ------------------------------------------------
   Shown to signed-in pilots until they acknowledge it; bump the version
   to show it again after a big change. */
const DEV_NOTICE = "atlas.devNotice.v1";
const devNoticeSeen = () => { try { return localStorage.getItem(DEV_NOTICE) === "1"; } catch { return true; } };
function showDevNotice() {
  const box = document.createElement("div");
  box.className = "consent";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", "New Eden Atlas is in development");
  box.innerHTML = `<div class="c-card dev-card"><h3>In development</h3>
    <p>The New Eden Atlas is a work in progress and strictly in development. It changes often, sometimes
    several times a day, and features may move, break, or go down without notice while we build.</p>
    <p>Feedback is very much appreciated: bugs, ideas, or anything that looks off.
    Email <a href="mailto:NewEdenAtlas@gmail.com?subject=New%20Eden%20Atlas%20feedback">NewEdenAtlas@gmail.com</a>.</p>
    <label class="c-opt"><input type="checkbox" id="devAck"> <span>I understand this is in development
      and may change or be down at any time.</span></label>
    <div class="c-buttons"><button data-act="ok" disabled>Continue</button></div></div>`;
  document.body.appendChild(box);
  const ack = box.querySelector("#devAck"), ok = box.querySelector("[data-act=ok]");
  ack.onchange = () => { ok.disabled = !ack.checked; };
  ok.onclick = () => {
    try { localStorage.setItem(DEV_NOTICE, "1"); } catch { /* private mode */ }
    box.remove();
    askUndecided();
  };
  const card = box.querySelector(".c-card");
  card.tabIndex = -1;
  card.focus();
}

/* ---- Corp button: who is on the Atlas, and a corp-only map view ------------ */
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? "just now" : `${m} min ago`; };
function renderCorpMenu() {
  const wrap = document.getElementById("corpWrap"), btn = document.getElementById("corpBtn"), menu = document.getElementById("corpMenu");
  wrap.hidden = !(reserves.relay && EveSSO.pilots().length);
  if (wrap.hidden) return;
  const mates = [...corpmates.list.entries()].sort((a, b) => (b[1].online - a[1].online) || a[1].name.localeCompare(b[1].name));
  btn.innerHTML = `Corp${mates.length ? `<span class="cm-badge">${mates.length}</span>` : ""}`;
  btn.classList.toggle("focus-on", corpmates.focus);
  btn.title = "Corp mates sharing their location on the Atlas";
  const head = corpmates.corps.map(c => esc(corpmates.names.get(c) || `corporation ${c}`)).join(", ");
  menu.innerHTML = `<div class="cm-head"><b>${head || "Your corporation"}</b><br><span>On the Atlas and sharing location</span></div>` +
    (mates.length ? mates.map(([id, r]) => `<div class="pm-row" data-sys="${r.system}">
        <img src="https://images.evetech.net/characters/${id}/portrait?size=64" alt="" width="32" height="32">
        <div class="pm-who"><div>${r.online ? '<i class="pm-on" title="online in game"></i>' : ""}${esc(r.name)}</div>
          <div class="pm-where">${esc(sysName(r.system))}${r.ship ? `, ${esc(typeName(r.ship))}` : ""} · ${ago(r.at)}</div></div>
        <button data-act="go" title="Show on map">◎</button></div>`).join("")
      : `<div class="cm-empty">No corp mates are sharing right now. Corp mates appear here while they have the Atlas
         open with "location" ticked in their pilot menu.</div>`) +
    `<label class="cm-focus"><input type="checkbox" id="cmFocus"${corpmates.focus ? " checked" : ""}> Corp view: show only
       corp mates, your pilots and your corp's reserves</label>`;
  menu.querySelectorAll(".pm-row").forEach(row => row.onclick = () => {
    const sys = +row.dataset.sys, p = state.byId.get(sys);
    if (p) { select(sys); flyTo(p.ll, 7); }
    menu.hidden = true; btn.setAttribute("aria-expanded", "false");
  });
  menu.querySelector("#cmFocus").onchange = e => {
    corpmates.focus = e.target.checked;
    try { localStorage.setItem("atlas.corpFocus", corpmates.focus ? "1" : "0"); } catch { /* private mode */ }
    applyLayer(currentLayer);            /* re-colors the map, then applyCorpFocus dims it */
    renderCorpMenu();
  };
  if (!corpmates.menuWired) {
    corpmates.menuWired = true;
    try { corpmates.focus = localStorage.getItem("atlas.corpFocus") === "1"; } catch { /* default off */ }
    btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
    document.addEventListener("click", e => {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.hidden = true; btn.setAttribute("aria-expanded", "false");
      }
    });
    setInterval(renderCorpMenu, 60e3);   /* keep "n min ago" honest */
  }
}

/* Corp view: every system fades except where the corp has something going
   on (corp mates, your own pilots and their assets, corp reserve sightings),
   which keep their layer color and grow a little. */
function applyCorpFocus() {
  if (typeof state === "undefined" || !state.markers) return;
  const keep = new Set();
  if (corpmates.focus) {
    for (const r of corpmates.list.values()) keep.add(r.system);
    for (const d of pilotState.data.values()) {
      if (d.loc) keep.add(d.loc.system);
      if (d.assets) for (const s of d.assets.bySystem.keys()) keep.add(s);
    }
    for (const id of Object.keys(reserveSightings())) keep.add(+id);
  }
  state.markers.forEach((m, id) => {
    const on = !corpmates.focus || keep.has(id);
    m.setStyle({ fillOpacity: on ? .95 : .12, opacity: on ? .9 : .15 });
    if (corpmates.focus && on) m.bringToFront();
  });
  for (const [layer, box] of state.overlays || []) {
    if (corpmates.focus) layer.remove();
    else if (document.getElementById(box).checked) layer.addTo(map);
  }
  document.body.classList.toggle("corp-focus", corpmates.focus);
  document.getElementById("corpBtn").classList.toggle("focus-on", corpmates.focus);
}

/* ---- right-click: set destination / add waypoint ---------------------------
   Stations, structures and systems can be autopilot targets; a planet,
   moon or belt sends its system (CCP's API takes nothing finer). */
function closeCtx() { document.querySelectorAll(".ctx").forEach(c => c.remove()); }
document.addEventListener("click", closeCtx);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeCtx(); });
document.addEventListener("contextmenu", e => {
  const el = e.target.closest("#panel [data-dest]");
  if (!el || !el.dataset.dest) return;
  e.preventDefault();
  closeCtx();
  const id = +el.dataset.dest, name = el.dataset.destName || "", note = el.dataset.destNote;
  const pilot = pilotState.data.get(pilotState.active);
  const box = document.createElement("div");
  box.className = "ctx";
  box.setAttribute("role", "menu");
  box.innerHTML = `<div class="ctx-head">${esc(note ? `${note} (autopilot goes to ${name})` : name)}</div>` +
    (pilot ? `<button data-mode="dest" role="menuitem">Set destination for ${esc(pilot.name)}</button>
              <button data-mode="wp" role="menuitem">Add waypoint for ${esc(pilot.name)}</button>
              <div class="ctx-note">${pilot.online ? "Sent to the game client now." : "The pilot must be logged in to the game."}</div>`
           : `<div class="ctx-note">Sign in with Pilot login to send routes to your game client.</div>`);
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + "px";
  box.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + "px";
  box.querySelectorAll("button").forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const dest = b.dataset.mode === "dest";
    b.textContent = "Sending…";
    try {
      await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false` +
        `&clear_other_waypoints=${dest}&destination_id=${id}`, { method: "POST" });
      b.textContent = dest ? `Destination set: ${name}` : `Waypoint added: ${name}`;
    } catch (err) {
      b.textContent = `Failed (${err.message}); is the pilot in game?`;
    }
    setTimeout(closeCtx, 1600);
  });
});
