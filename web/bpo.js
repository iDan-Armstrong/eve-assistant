/* Blueprint finder (opened from the pilot menu).

   1. Scan: the pilot's assets (or all signed-in pilots') are read from CCP
      and every blueprint original they hold is set aside. The player
      stations that sell blueprints (or hold blueprint contracts) are checked
      for this pilot's docking access, as in Sell my cargo.
   2. List: every other blueprint on the market with its cheapest offer the
      pilot can use (NPC market, player-station market or a public contract;
      data/live/bpo_index.json, hourly) and its price against the market
      average. Filter by the kind and group of what it builds
      (data/blueprints.json, from the SDE), by words in the name and by
      price against average; tick the ones wanted.
   3. Price and route: NPC sellers of the ticked blueprints are re-read live
      from CCP, the cheapest offer of each is picked, and the stations become
      an autopilot route, nearest first.
   Uses globals from the main page, pilot.js, haul.js (bfs, liveOrders,
   regionOf), market.js (market.structures), sell.js (dockable, sell) and
   sell_core.js (orderStops). */
"use strict";

const OPEN_WINDOW_SCOPE = "esi-ui.open_window.v1";
const bpo = { bps: null, index: null, owned: null, access: new Set(), rows: [], checked: new Set(), tree: null };

function openBpo(open) {
  const panel = document.getElementById("bpo");
  panel.hidden = !open;
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "fitbox"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  const d = pilotState.data.get(pilotState.active);
  const from = document.getElementById("bFrom");
  if (!from.value && d && d.loc) from.value = sysName(d.loc.system);
  const who = document.getElementById("bWho");
  const pilots = EveSSO.pilots();
  who.textContent = pilots.length
    ? `Blueprint originals ${(pilots.find(p => p.id === pilotState.active) || pilots[0]).name} does not own yet, and the cheapest place to get each.`
    : "Sign in with Pilot login first: the finder reads your assets to see which blueprints you own.";
  loadBpoData();
}

async function loadBpoData() {
  const sum = document.getElementById("bSum");
  try {
    if (!bpo.bps) {
      const r = await fetch("data/blueprints.json");
      if (!r.ok) throw new Error("blueprints");
      const d = await r.json();
      bpo.bps = d.b; bpo.cats = d.cats; bpo.groups = d.groups;
      const cat = document.getElementById("bCat");
      cat.innerHTML = `<option value="">any kind</option>` + Object.entries(bpo.cats)
        .sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join("");
      fillGroups();
    }
    if (!bpo.index) {
      const r = await fetch("data/live/bpo_index.json");
      bpo.index = r.ok ? await r.json() : { sell: {}, avg: {} };
    }
    if (!market.structures) {
      market.structures = await fetch("data/live/structures.json").then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    }
  } catch {
    sum.textContent = "The blueprint list is not published yet.";
  }
}

function fillGroups() {
  const cat = document.getElementById("bCat").value, sel = document.getElementById("bGroup");
  sel.innerHTML = `<option value="">any group</option>` + Object.entries(bpo.groups)
    .filter(([, [, c]]) => !cat || String(c) === cat)
    .sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([id, [n]]) => `<option value="${id}">${esc(n)}</option>`).join("");
}

function bpoOrigin() {
  const typed = document.getElementById("bFrom").value.trim().toLowerCase();
  return [...state.byId.values()].find(s => s.name.toLowerCase() === typed) || null;
}
function bpoTree() {
  const origin = bpoOrigin();
  if (!origin) return null;
  const hs = document.getElementById("bHigh").checked;
  const typed = document.getElementById("bReach").value.trim();
  const reach = typed ? Math.max(0, +typed || 0) : Infinity;          /* blank: anywhere you can fly */
  const t = bfs(origin.id, hs);
  return { origin, hs, reach, jumps: sys => { const d = t.dist.get(sys); return d !== undefined && d <= reach ? d : undefined; } };
}

const bpoAccess = id => BpoCore.isNpcStation(id) || bpo.access.has(id);
const bpoSysOf = id => sell.structSystems.get(id) || ((market.structures || {})[id] || [])[1] || 0;
const placeName = id => esc(BpoCore.isStructure(id)
  ? sell.structNames.get(id) || ((market.structures || {})[id] || [])[0] || `player station ${id}`
  : stationName(id) || `station ${id}`);
const KIND = { npc: "market", player: "player station market", contract: "contract" };

async function scanBpos() {
  const sum = document.getElementById("bSum");
  await loadBpoData();
  if (!bpo.bps) return;
  const pilots = EveSSO.pilots();
  if (!pilots.length) { sum.textContent = "Sign in with Pilot login first."; return; }
  const active = pilotState.active || pilots[0].id;
  const ids = document.getElementById("bAll").checked ? pilots.map(p => p.id) : [active];
  const owned = new Set();
  let failed = 0;
  for (const id of ids) {
    sum.textContent = `Reading ${(pilots.find(p => p.id === id) || {}).name || "pilot"}'s assets from CCP…`;
    try {
      const assets = await EveSSO.esi(id, `/characters/${id}/assets`);
      for (const t of BpoCore.ownedOriginals(assets, t => !!bpo.bps[t])) owned.add(t);
    } catch { failed++; }
  }
  /* player stations and contracts there count only where this pilot may dock */
  const structs = BpoCore.structuresIn(bpo.index);
  bpo.access = structs.length ? await dockable(active, structs, sum) : new Set();
  bpo.capped = sell.capped;
  bpo.owned = owned;
  bpo.failed = failed;
  rebuildBpoRows();
}

function rebuildBpoRows() {
  if (!bpo.owned) return;
  const sum = document.getElementById("bSum");
  bpo.tree = bpoTree();
  if (!bpo.tree) { sum.textContent = "Type your system in the from box."; return; }
  bpo.rows = BpoCore.buildRows(bpo.bps, bpo.index, bpo.owned, bpo.tree.jumps, bpoAccess, bpoSysOf);
  drawBpoList();
}

function bpoFilters() {
  return { cat: document.getElementById("bCat").value, group: document.getElementById("bGroup").value,
           text: document.getElementById("bText").value, inReach: document.getElementById("bInReach").checked,
           mode: document.getElementById("bMode").value, pct: document.getElementById("bPct").value };
}

const SHOW_MAX = 300;
const offerTxt = o => `${KIND[o.kind]}${o.kind === "contract" ? `, ME ${o.me} / TE ${o.te}` : ""}`;
function drawBpoList() {
  const sum = document.getElementById("bSum"), list = document.getElementById("bList");
  const shown = BpoCore.sortRows(BpoCore.filterRows(bpo.rows, bpoFilters()), document.getElementById("bSort").value);
  const total = Object.keys(bpo.bps).length;
  sum.textContent = `You own ${bpo.owned.size.toLocaleString()} of ${total.toLocaleString()} blueprints on the market` +
    `${bpo.failed ? ` (${bpo.failed} pilot${bpo.failed === 1 ? "" : "s"} could not be read)` : ""}. ` +
    `${bpo.capped ? `${bpo.capped} player stations still to check for docking: scan again in a minute. ` : ""}` +
    `${shown.length.toLocaleString()} match${shown.length === 1 ? "es" : ""}` +
    `${shown.length > SHOW_MAX ? `, first ${SHOW_MAX} shown: narrow the filters` : ""}. ${bpo.checked.size} checked.`;
  list.innerHTML = shown.slice(0, SHOW_MAX).map(r => {
    const o = r.best || r.anywhere;
    const vs = r.vsAvg === null ? "" : ` <span class="${r.vsAvg <= 0 ? "b-good" : "b-bad"}">${r.vsAvg <= 0 ? "" : "+"}${r.vsAvg.toFixed(0)}% vs average</span>`;
    const place = r.best ? `${offerTxt(o)} at ${placeName(o.loc)}, ${r.jumps} jump${r.jumps === 1 ? "" : "s"}`
      : o ? `cheapest is out of reach: ${offerTxt(o)} at ${placeName(o.loc)}` : "no offer anywhere you can buy this hour";
    return `<li data-tid="${r.tid}"><input type="checkbox"${bpo.checked.has(r.tid) ? " checked" : ""} aria-label="Choose ${esc(r.name)}">` +
      `<div class="b-main"><div>${esc(r.name)}</div>` +
      `<div class="m-meta">${o ? `<span class="m-price">${fmtPrice(o.price)}</span>` : ""}${vs}` +
      `${r.avg ? `, average ${fmtPrice(r.avg)}` : ""}<br>${place}</div></div></li>`;
  }).join("");
  list.querySelectorAll("li").forEach(li => li.onclick = e => {
    const tid = +li.dataset.tid, box = li.querySelector("input");
    if (e.target !== box) box.checked = !box.checked;
    if (box.checked) bpo.checked.add(tid); else bpo.checked.delete(tid);
    drawBpoSelection();
  });
  drawBpoSelection();
}

function drawBpoSelection() {
  const go = document.getElementById("bGo");
  go.hidden = !bpo.checked.size;
  go.textContent = `Price and route the ${bpo.checked.size} checked blueprint${bpo.checked.size === 1 ? "" : "s"}`;
  const sum = document.getElementById("bSum");
  sum.textContent = sum.textContent.replace(/\d+ checked\.$/, `${bpo.checked.size} checked.`);
}

async function routeBpos() {
  const sum = document.getElementById("bSum"), out = document.getElementById("bOut"), dest = document.getElementById("bDest");
  const tree = bpoTree();
  if (!tree) { sum.textContent = "Type your system in the from box."; return; }
  dest.hidden = true; out.innerHTML = "";
  const tids = [...bpo.checked];
  const regions = [...new Set([...state.byId.keys()].filter(sys => tree.jumps(sys) !== undefined).map(regionOf))];
  const jobs = [];
  for (const t of tids) for (const r of regions) jobs.push([t, r]);
  const live = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += 12) {
    await Promise.all(jobs.slice(i, i + 12).map(async ([t, r]) => {
      try { live.push(...await liveOrders(r, t, "sell")); } catch { /* region skipped */ }
      sum.textContent = `Checking NPC sellers live: ${++done} of ${jobs.length}…`;
    }));
  }
  /* NPC prices live; player-station orders and contracts from the hourly index */
  const offers = BpoCore.npcOffers(live);
  for (const t of tids) {
    for (const o of BpoCore.offersFor(String(t), bpo.index, bpoAccess, bpoSysOf)) {
      if (o.kind !== "npc") offers.push({ ...o, type_id: t });
    }
  }
  const pick = BpoCore.pickPurchases(tids, offers, tree.jumps);
  const trees = new Map();
  const dist = (a, b) => {
    if (!trees.has(a)) trees.set(a, bfs(a, tree.hs));
    const d = trees.get(a).dist.get(b);
    return d === undefined ? Infinity : d;
  };
  const route = SellCore.orderStops(pick.stops, tree.origin.id, dist, null);
  const name = t => (bpo.bps[t] || [`item ${t}`])[0];
  sum.textContent = pick.stops.length
    ? `${tids.length - pick.missing.length} of ${tids.length} blueprints for ${fmtPrice(pick.total)} ISK at ` +
      `${route.stops.length} station${route.stops.length === 1 ? "" : "s"}, ${route.jumps} jump${route.jumps === 1 ? "" : "s"} in all from ${tree.origin.name}.`
    : "None of the checked blueprints is on offer anywhere you can buy within reach right now.";
  const canOpen = (EveSSO.pilots().find(p => p.id === pilotState.active) || { scopes: [] }).scopes.includes(OPEN_WINDOW_SCOPE);
  const line = l => `<tr><td>${esc(name(l.type_id))}<div class="m-meta">${offerTxt(l)}` +
    `${l.kind === "contract" ? ` <button class="h-copy" data-cid="${l.cid}">${canOpen ? "Open in game" : "Allow opening in game"}</button>` : ""}` +
    `</div></td><td>${fmtPrice(l.price)}</td></tr>`;
  out.innerHTML = route.stops.map((s, i) =>
    `<div class="h-stop"><div class="h-stop-head"><span class="h-n buy">${i + 1}</span><b>Buy</b> at ` +
    `${placeName(s.station)} <span class="m-meta">(${s.jumps} jump${s.jumps === 1 ? "" : "s"})</span></div>` +
    `<table class="h-tab"><tr><th>blueprint</th><th>price</th></tr>` + s.lines.map(line).join("") +
    `<tr class="h-sum"><td>stop total</td><td>${fmtPrice(s.gross)}</td></tr></table></div>`).join("") +
    (pick.missing.length ? `<div class="m-meta s-drop">Not on offer anywhere you can buy within reach right now: ` +
      `${pick.missing.map(t => esc(name(t))).join(", ")}. Try a longer reach or untick Highsec only.</div>` : "") +
    (pick.stops.length ? `<div class="m-meta">Total ${fmtPrice(pick.total)} ISK. NPC market prices checked live with CCP at ` +
      `${new Date().toUTCString().slice(17, 22)} UTC; player-station orders and contracts are from the hourly scan, so one ` +
      `may have sold since. Market: open the market at the stop, search the blueprint name and buy the one at this station. ` +
      `Contract: Open in game shows it in your client (or search Contracts for the blueprint name at that station). ` +
      `Check the price, and a contract's ME/TE, before you confirm.</div>` : "");
  out.querySelectorAll("[data-cid]").forEach(b => b.onclick = async () => {
    if (!canOpen) { EveSSO.login([OPEN_WINDOW_SCOPE]); return; }
    b.textContent = "Opening…";
    try {
      await EveSSO.esi(pilotState.active, `/ui/openwindow/contract?contract_id=${b.dataset.cid}`, { method: "POST" });
      b.textContent = "Opened in game";
    } catch (e) { b.textContent = `Failed (${e.message}); is the pilot in game?`; }
  });
  const waypoints = route.stops.map(s => s.station);
  dest.hidden = !waypoints.length || !pilotState.data.size;
  dest.textContent = `Send buying route to autopilot (${waypoints.length} stop${waypoints.length === 1 ? "" : "s"})`;
  dest.onclick = async () => {
    dest.disabled = true;
    try {
      for (let i = 0; i < waypoints.length; i++) {
        dest.textContent = `Sending stop ${i + 1} of ${waypoints.length}…`;
        await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false` +
          `&clear_other_waypoints=${i === 0}&destination_id=${waypoints[i]}`, { method: "POST" });
      }
      dest.textContent = `Route sent: ${waypoints.length} stop${waypoints.length === 1 ? "" : "s"}, docking at each`;
    } catch (e) { dest.textContent = `Failed (${e.message}); is the pilot in game?`; }
    dest.disabled = false;
  };
}

function wireBpo() {
  document.getElementById("bpoClose").onclick = () => openBpo(false);
  document.getElementById("bScan").onclick = scanBpos;
  document.getElementById("bGo").onclick = routeBpos;
  document.getElementById("bCat").onchange = () => { fillGroups(); if (bpo.owned) drawBpoList(); };
  ["bGroup", "bMode", "bSort", "bInReach"].forEach(id => document.getElementById(id).onchange = () => { if (bpo.owned) drawBpoList(); });
  ["bText", "bPct"].forEach(id => document.getElementById(id).oninput = () => { if (bpo.owned) drawBpoList(); });
  ["bFrom", "bReach"].forEach(id => document.getElementById(id).onchange = rebuildBpoRows);
  document.getElementById("bHigh").onchange = rebuildBpoRows;
}
wireBpo();
