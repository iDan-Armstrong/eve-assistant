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
  setInterval(() => { if (shareOn()) reportReserves(); }, 10 * 60e3);
  let note = "";
  try {
    const p = await EveSSO.init();
    if (p) { pilotState.active = p.id; note = `Signed in as ${p.name}`; }
  } catch (e) { note = e.message; }
  wirePilotMenu();
  renderPilotMenu(note);
  await refreshPilots();
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
  if (shareOn()) reportReserves();
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
      <button data-act="out" title="Sign out this pilot">✕</button></div>`;
  }).join("") +
  `<div class="pm-foot"><button data-act="add">Add a character</button><button data-act="refresh">Refresh</button></div>` +
  (reserves.relay ? `<label class="pm-share"><input type="checkbox" id="pmShare"${shareOn() ? " checked" : ""}> ` +
    `Share Bulwark reserve sightings</label><div class="pm-note">When on, your login is sent to the Atlas relay ` +
    `to read your mining ledger for the four reserve ores. The relay checks it with CCP, keeps no token and ` +
    `publishes only system, ore and time, never your name.</div>` : "") +
  `<div class="pm-note">${esc(note || (shareOn() ? "Tokens go only to CCP and, for reserve checks, the Atlas relay." : "Tokens stay in this browser and go only to CCP."))}</div>`;
  const share = menu.querySelector("#pmShare");
  if (share) share.onchange = () => {
    try { localStorage.setItem("atlas.shareReserves", share.checked ? "1" : "0"); } catch { /* private mode */ }
    if (share.checked) reportReserves();
    renderPilotMenu();
  };
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
    const w = textWidth(d.name, '600 11px "Chakra Petch", sans-serif') + 16;
    out.push({ x: pt.x - w / 2, y: pt.y - 16 - 22, w, h: 22 });
  }
  return out;
}

/* ---- Bulwark reserves: shared sightings ------------------------------------
   CCP publishes no record of the limited-time reserve sites. The one CCP
   record that shows them is a pilot's mining ledger, so the Atlas relay
   (worker/) collects verified ledger reads from pilots who opt in and
   publishes, per system: the reserve ore, the last day it was mined, and
   the last time anyone's ledger grew there (mined within the hour).
   Everyone sees the shared sightings, signed in or not; a signed-in
   pilot's own ledger adds to them locally even with sharing off. */
const reserves = { relay: "", shared: {}, activeMinutes: 60, layer: L.layerGroup(), rings: [], at: null };
const shareOn = () => { try { return localStorage.getItem("atlas.shareReserves") === "1"; } catch { return false; } };

async function loadSightings() {
  if (!reserves.relay) { drawReserves(); return; }
  try {
    const r = await fetch(`${reserves.relay}/sightings`).then(x => x.json());
    reserves.shared = r.systems || {};
    reserves.activeMinutes = r.activeMinutes || 60;
    reserves.at = r.updated;
  } catch { /* relay down: local sightings still show */ }
  drawReserves();
}
async function reportReserves() {
  if (!reserves.relay) return;
  for (const p of EveSSO.pilots()) {
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
    return `<b>Reserve active</b>: ${esc(p.bulwark.ore)} mined here ${min} min ago`;
  }
  return `Reserve last confirmed ${s.lastConfirmed}: ${esc(p.bulwark.ore)} in a pilot's mining ledger`;
}
