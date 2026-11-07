/* Asset clean-up (Tools > Assets).

   1. Scan: the active pilot's assets from CCP, turned into loose stacks
      (asset_core.js stacksFrom), each with its packaged volume (type_meta,
      or CCP for ships and anything unlisted) and what the best trade hub's
      buy orders pay for it (data/live/stations/<hub>.json). The ship's hold
      minus what is already in it is the free space, which the pilot can
      change.
   2. Filter by kind of item and words in the name; pick a goal:
        Sell for most profit  pickups by ISK per jump, then the sale planned
                              from the last pickup with live buy orders
                              (sell.js computeSale), unsold items to Jita
        Move and consolidate  pickups that clear the most stacks per jump,
                              then a drop-off at the chosen station
   3. Send the stops to autopilot and follow them in the trip window
      (hud.html), which knows pickup and drop-off stops. */
"use strict";

const HUBS = [60003760, 60008494, 60011866, 60004588, 60005686];
const assetsUi = { stacks: null, mode: "sell", vols: new Map(), hubBuy: null, plan: null, kinds: null };

function openAssets(open) {
  const panel = document.getElementById("assets");
  panel.hidden = !open;
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "fitbox", "bpo"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  const d = pilotState.data.get(pilotState.active);
  const from = document.getElementById("aFrom");
  if (!from.value && d && d.loc) from.value = sysName(d.loc.system);
  if (!EveSSO.pilots().length) document.getElementById("aWho").textContent = "Sign in with Pilot login first: the clean-up reads your assets.";
}

function setAssetMode(mode) {
  assetsUi.mode = mode;
  document.querySelectorAll("#assets [data-amode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.amode === mode)));
  document.querySelectorAll("#assets .a-sell").forEach(el => { el.hidden = mode !== "sell"; });
  document.querySelectorAll("#assets .a-cons").forEach(el => { el.hidden = mode !== "consolidate"; });
}

const catOfType = t => ((market.meta && market.meta.t[t]) || [])[1] || 0;
const volOf = t => assetsUi.vols.get(t);
const valueOf = t => (assetsUi.hubBuy && assetsUi.hubBuy.get(t)) || 0;

/* packaged volume: the SDE (type_meta) for most things; CCP for ships, whose
   static volume is the assembled size, and for anything type_meta lacks */
async function loadVolumes(tids, sum) {
  const ask = [];
  for (const t of tids) {
    if (assetsUi.vols.has(t)) continue;
    const m = market.meta && market.meta.t[t];
    if (m && m[4] !== undefined && m[1] !== 6) assetsUi.vols.set(t, m[4]);
    else ask.push(t);
  }
  let done = 0;
  for (let i = 0; i < ask.length; i += 10) {
    await Promise.all(ask.slice(i, i + 10).map(async t => {
      try {
        const x = await EveSSO.esiPublic(`/universe/types/${t}`);
        assetsUi.vols.set(t, x.packaged_volume ?? x.volume ?? 0);
        if (!haul.names || !haul.names.has(t)) sell.extraNames.set(t, x.name);
      } catch { /* unknown volume: left out of planning */ }
      sum.textContent = `Looking up item sizes: ${++done} of ${ask.length}…`;
    }));
  }
}

/* best buy order per type across the five trade hubs (hourly station files) */
async function loadHubBuy() {
  if (assetsUi.hubBuy) return;
  const best = new Map();
  await Promise.all(HUBS.map(async h => {
    try {
      const d = await fetch(`data/live/stations/${h}.json`).then(r => r.json());
      for (const [tid, , , buy] of d.items) if (buy && buy > (best.get(tid) || 0)) best.set(tid, buy);
    } catch { /* a missing hub just values lower */ }
  }));
  assetsUi.hubBuy = best;
}

async function scanAssets() {
  const sum = document.getElementById("aSum");
  const pilots = EveSSO.pilots();
  if (!pilots.length) { sum.textContent = "Sign in with Pilot login first."; return; }
  const id = pilotState.active || pilots[0].id;
  const who = (pilots.find(p => p.id === id) || {}).name || "pilot";
  sum.textContent = `Reading ${who}'s assets from CCP…`;
  try {
    await loadTypeMeta();
    await sellNames();
    const [assets, ship] = await Promise.all([EveSSO.esi(id, `/characters/${id}/assets`), EveSSO.esi(id, `/characters/${id}/ship`)]);
    const stacks = AssetCore.stacksFrom(assets, catOfType);
    const tids = [...new Set([...stacks.map(s => s.type_id), ...assets.filter(a => a.location_id === ship.ship_item_id).map(a => a.type_id)])];
    await loadVolumes(tids, sum);
    sum.textContent = "Valuing items at the trade hubs…";
    await loadHubBuy();
    await nameTypes(tids);

    /* where each stack is: NPC stations from the station list, player stations
       from what CCP tells this pilot (asked once a day, at most 40 at a time) */
    const stations = stationSystem();
    const structs = [...new Set(stacks.filter(s => s.loc > 1e12).map(s => s.loc))];
    if (structs.length) await dockable(id, structs, sum);
    const sysOf = loc => stations.get(loc) || sell.structSystems.get(loc) || ((market.structures || {})[loc] || [])[1] || 0;
    assetsUi.stacks = stacks.map(s => ({ ...s, sys: sysOf(s.loc), vol: volOf(s.type_id), value: valueOf(s.type_id) }));
    assetsUi.unplaced = assetsUi.stacks.filter(s => !s.sys).length;

    /* free hold: the ship's cargo capacity minus what is already in its holds */
    let cap = 0, shipName = "";
    try {
      const t = await EveSSO.esiPublic(`/universe/types/${ship.ship_type_id}`);
      cap = t.capacity || 0; shipName = t.name;
    } catch { /* type the hold by hand */ }
    const used = AssetCore.cargoUsed(assets, ship.ship_item_id, volOf);
    const free = Math.max(0, Math.floor(cap - used));
    document.getElementById("aHold").value = free;
    document.getElementById("aHoldNote").textContent = cap
      ? `m³ free: ${shipName} holds ${Math.round(cap).toLocaleString()}, ${Math.round(used).toLocaleString()} in use (base hold, before skills and expanders)`
      : "m³ free (type your hold)";
    document.getElementById("aWho").textContent = `${who}${shipName ? ` in ${/^[aeiou]/i.test(shipName) ? "an" : "a"} ${shipName}` : ""}.`;

    fillKinds();
    fillDest();
    document.getElementById("aGo").hidden = false;
    summarizeStacks();
  } catch (e) {
    sum.textContent = `Could not read assets (${e.message}). Sign in again and retry.`;
  }
}

function fillKinds() {
  const counts = new Map();
  for (const s of assetsUi.stacks) { const c = catOfType(s.type_id); counts.set(c, (counts.get(c) || 0) + 1); }
  const name = c => (market.meta && market.meta.cats[c]) || "Other";
  /* blueprint originals are research assets: left out unless ticked */
  const BLUEPRINT = 9;
  assetsUi.kinds = new Set([...counts.keys()].filter(c => c !== BLUEPRINT));
  document.getElementById("aKinds").innerHTML = [...counts].sort((a, b) => name(a[0]).localeCompare(name(b[0])))
    .map(([c, n]) => `<label><input type="checkbox" data-kind="${c}"${c === BLUEPRINT ? "" : " checked"}> ${esc(name(c))} <span class="m-meta">(${n})</span></label>`).join("");
  document.querySelectorAll("#aKinds [data-kind]").forEach(b => b.onchange = () => {
    if (b.checked) assetsUi.kinds.add(+b.dataset.kind); else assetsUi.kinds.delete(+b.dataset.kind);
    const all = assetsUi.kinds.size === counts.size;
    document.getElementById("aKindsSum").textContent = `Kinds of items: ${all ? "all" : `${assetsUi.kinds.size} of ${counts.size}`}`;
    summarizeStacks();
  });
}

function fillDest() {
  const by = new Map();
  for (const s of assetsUi.stacks) {
    if (!s.sys) continue;
    const e = by.get(s.loc) || { loc: s.loc, sys: s.sys, value: 0, n: 0 };
    e.value += s.qty * s.value; e.n += 1; by.set(s.loc, e);
  }
  const best = AssetCore.suggestDest(assetsUi.stacks.filter(s => s.sys));
  document.getElementById("aDest").innerHTML = [...by.values()].sort((a, b) => b.value - a.value).map(e =>
    `<option value="${e.loc}"${best && best.loc === e.loc ? " selected" : ""}>${placeName(e.loc)} (${e.n} stacks)</option>`).join("");
}

function filteredStacks() {
  const words = document.getElementById("aText").value.toLowerCase().split(/\s+/).filter(Boolean);
  return assetsUi.stacks.filter(s => s.sys && s.vol !== undefined && assetsUi.kinds.has(catOfType(s.type_id)) &&
    (!words.length || words.every(w => sellName(s.type_id).toLowerCase().includes(w))));
}

function summarizeStacks() {
  if (!assetsUi.stacks) return;
  const f = filteredStacks();
  const m3 = f.reduce((a, s) => a + s.qty * s.vol, 0), value = f.reduce((a, s) => a + s.qty * s.value, 0);
  const places = new Set(f.map(s => s.loc)).size;
  document.getElementById("aSum").textContent = `${f.length.toLocaleString()} stacks at ${places} station${places === 1 ? "" : "s"}: ` +
    `${Math.round(m3).toLocaleString()} m³, worth ${fmtPrice(value)} ISK at hub buy orders.` +
    `${assetsUi.unplaced ? ` ${assetsUi.unplaced} stacks are in player stations this pilot cannot dock at (left out).` : ""}`;
}

/* ---- planning ---------------------------------------------------------- */
function assetTree() {
  const typed = document.getElementById("aFrom").value.trim().toLowerCase();
  const origin = [...state.byId.values()].find(s => s.name.toLowerCase() === typed);
  if (!origin) return null;
  const hs = document.getElementById("aHigh").checked;
  const r = document.getElementById("aReach").value.trim();
  const reach = r ? Math.max(0, +r || 0) : Infinity;
  const trees = new Map();
  const tree = a => { if (!trees.has(a)) trees.set(a, bfs(a, hs)); return trees.get(a); };
  const dist = (a, b) => { const d = tree(a).dist.get(b); return d === undefined ? Infinity : d; };
  return { origin, hs, reach, tree, dist };
}

async function planAssets() {
  const sum = document.getElementById("aSum"), out = document.getElementById("aOut");
  document.getElementById("aActs").hidden = true; out.innerHTML = "";
  const t = assetTree();
  if (!t) { sum.textContent = "Type your system in the from box."; return; }
  const capacity = Math.max(0, +document.getElementById("aHold").value || 0);
  if (!capacity) { sum.textContent = "Set how much room your hold has."; return; }
  const stacks = filteredStacks().filter(s => t.dist(t.origin.id, s.sys) <= t.reach);
  const mode = assetsUi.mode;
  let dest = null;
  if (mode === "consolidate") {
    const loc = +document.getElementById("aDest").value;
    const s0 = assetsUi.stacks.find(s => s.loc === loc);
    dest = s0 ? { loc, sys: s0.sys } : null;
    if (!dest) { sum.textContent = "Choose where to drop everything."; return; }
  }
  const plan = AssetCore.planPickups(stacks, {
    mode, capacity, origin: t.origin.id, dist: t.dist, dest, maxStops: 8,
    minStop: Math.max(0, +document.getElementById("aMin").value || 0) * 1e6,
  });
  if (!plan.stops.length) {
    sum.textContent = mode === "sell" ? "Nothing worth collecting fits these settings: try a lower worth-it amount or a longer reach."
      : "Nothing to move with these settings.";
    return;
  }
  let sale = null;
  if (mode === "sell") {
    const last = plan.stops[plan.stops.length - 1];
    const from = state.byId.get(last.sys);
    sale = await computeSale(plan.carried, { id: last.sys, name: from.name }, {
      hs: t.hs, reach: Number.isFinite(t.reach) ? Math.max(5, t.reach) : 15, minStop: Math.max(0, +document.getElementById("aMin").value || 0) * 1e6, structs: true }, sum);
  }
  assetsUi.plan = { plan, sale, t, mode, at: new Date() };
  drawAssetPlan();
}

/* every stop in visiting order, in the trip window's shape */
function assetStops() {
  const { plan, sale } = assetsUi.plan;
  const rate = sellTax();
  const stops = plan.stops.map(s => ({
    kind: s.kind, station: s.loc, system: s.sys, stationName: placeName(s.loc).replace(/&amp;/g, "&"),
    items: s.take.map(x => ({ name: sellName(x.type_id), n: x.qty, each: s.kind === "pickup" ? x.value : 0,
      total: s.kind === "pickup" ? x.qty * x.value : 0, keep: x.of ? x.of - x.qty : 0 })),
    m3: s.m3, isk: s.value, jumps: s.jumps,
  }));
  if (sale) {
    for (const s of sale.route.stops) {
      const dropHere = sale.left.size && s.station === SellCore.JITA.station;
      if (s.lines.length) {
        stops.push({ kind: "sell", station: s.station, system: s.system, stationName: placeName(s.station).replace(/&amp;/g, "&"),
          items: s.lines.map(l => ({ name: sellName(l.type_id), n: l.qty, each: l.price, total: l.qty * l.price * (1 - rate) })),
          profit: s.gross * (1 - rate), jumps: s.jumps });
      }
      if (dropHere) {
        stops.push({ kind: "drop", station: s.station, system: s.system, stationName: placeName(s.station).replace(/&amp;/g, "&"),
          items: [...sale.left].map(([tid, n]) => ({ name: sellName(tid), n, each: 0, total: 0 })), jumps: s.lines.length ? 0 : s.jumps });
      }
    }
  }
  return stops;
}

function drawAssetPlan() {
  const { plan, sale, t, mode } = assetsUi.plan;
  const sum = document.getElementById("aSum"), out = document.getElementById("aOut");
  const stops = assetStops();
  const jumps = stops.reduce((a, s) => a + (s.jumps === Infinity ? 0 : s.jumps || 0), 0);
  const rate = sellTax();
  const net = sale ? sale.gross * (1 - rate) : 0;
  const pickups = plan.stops.filter(s => s.kind === "pickup").length;
  sum.textContent = mode === "sell"
    ? `${pickups} pickup${pickups === 1 ? "" : "s"} filling ${Math.round(plan.m3).toLocaleString()} m³, then ` +
      `${sale.route.stops.filter(s => s.lines.length).length} sell stop(s): ${fmtPrice(net)} ISK after tax, ${jumps} jumps in all.`
    : `${pickups} pickup${pickups === 1 ? "" : "s"} (${Math.round(plan.m3).toLocaleString()} m³), then drop it all at ` +
      `${placeName(plan.stops[plan.stops.length - 1].loc)}: ${jumps} jumps in all. ${plan.stacksLeft} stacks still to move next trip.`;
  const VERB = { pickup: "Pick up", drop: "Drop off", sell: "Sell" };
  out.innerHTML = stops.map((s, i) =>
    `<div class="h-stop"><div class="h-stop-head"><span class="h-n ${s.kind === "sell" ? "sell" : "buy"}">${i + 1}</span>` +
    `<b>${VERB[s.kind]}</b> at ${esc(s.stationName)} <span class="m-meta">(${s.jumps === Infinity ? "no route" : `${s.jumps} jump${s.jumps === 1 ? "" : "s"}`})</span></div>` +
    `<table class="h-tab"><tr><th>item</th><th>qty</th><th>${s.kind === "sell" ? "after tax" : s.kind === "pickup" ? "worth" : ""}</th></tr>` +
    s.items.map(x => `<tr><td>${esc(x.name)}${x.keep ? ` <span class="m-meta">(leave ${x.keep.toLocaleString()})</span>` : ""}</td>` +
      `<td>${x.n.toLocaleString()}</td><td>${x.total ? fmtPrice(x.total) : ""}</td></tr>`).join("") +
    `</table></div>`).join("") +
    (mode === "sell" && sale && sale.left.size ? `<div class="m-meta s-drop">No buyer near the last pickup for some items: they go to Jita 4-4.</div>` : "");
  const signed = typeof pilotState !== "undefined" && pilotState.data.size;
  document.getElementById("aActs").hidden = !signed;
  assetsUi.stopsForHud = stops;
}

/* the trip window reads this (localStorage "atlas.activeHaul") */
function saveAssetTrip(stops) {
  const { t, mode, sale } = assetsUi.plan;
  const sys = id => { const p = state.byId.get(id); return { id, name: p.name, sec: +p.sec.toFixed(1) }; };
  const path = [t.origin.id];
  for (const s of stops) {
    const seg = pathTo(t.tree(path[path.length - 1]), s.system);
    if (seg) path.push(...seg.slice(1));
  }
  const active = {
    pilot: pilotState.active, pilotName: (pilotState.data.get(pilotState.active) || {}).name,
    started: new Date().toISOString(), tax: sellTax(),
    total: sale ? sale.gross * (1 - sellTax()) : 0,
    label: mode === "sell" ? `asset sale worth ${fmtPrice(sale ? sale.gross * (1 - sellTax()) : 0)}` : "asset consolidation run",
    stops, home: sys(stops[stops.length - 1].system), path: path.map(sys), done: 0,
  };
  try { localStorage.setItem("atlas.activeHaul", JSON.stringify(active)); } catch { /* private mode */ }
}

async function sendAssetRoute() {
  const btn = document.getElementById("aDestBtn");
  const stops = assetsUi.stopsForHud;
  /* the window first: browsers allow it only straight from the click */
  window.open("hud.html", "atlasHaulHud", "width=460,height=720");
  saveAssetTrip(stops);
  const waypoints = stops.filter(s => s.jumps !== Infinity).map(s => s.station).filter((s, i, a) => s !== a[i - 1]);
  btn.disabled = true;
  try {
    await EveSSO.waypoints(pilotState.active, waypoints, (i, n) => { btn.textContent = `Sending stop ${i} of ${n}…`; });
    btn.textContent = `Route sent: ${waypoints.length} stop${waypoints.length === 1 ? "" : "s"}, docking at each`;
  } catch (e) { btn.textContent = `Failed (${e.message}); is the pilot in game?`; }
  btn.disabled = false;
}

function wireAssets() {
  document.getElementById("aClose").onclick = () => openAssets(false);
  document.getElementById("aScan").onclick = scanAssets;
  document.getElementById("aGo").onclick = planAssets;
  document.getElementById("aDestBtn").onclick = sendAssetRoute;
  document.getElementById("aHud").onclick = () => { saveAssetTrip(assetsUi.stopsForHud); window.open("hud.html", "atlasHaulHud", "width=460,height=720"); };
  document.querySelectorAll("#assets [data-amode]").forEach(b => b.onclick = () => setAssetMode(b.dataset.amode));
  document.getElementById("aText").oninput = summarizeStacks;
  setAssetMode("sell");
}
wireAssets();
