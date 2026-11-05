/* Blueprint finder (opened from the pilot menu).

   1. Scan: the pilot's assets (or all signed-in pilots') are read from CCP
      and every blueprint original they hold is set aside.
   2. List: every other blueprint on the market, with the cheapest NPC
      seller within reach from the hourly index (data/live/bpo_index.json)
      and its price against the market average. Filter by the kind and
      group of what it builds (data/blueprints.json, from the SDE), by
      words in the name and by price against average; tick the ones wanted.
   3. Price and route: the ticked blueprints are re-read live from CCP in
      every region within reach, the cheapest seller of each is picked, and
      the stations become an autopilot route, nearest first.
   Uses globals from the main page, pilot.js, haul.js (bfs, liveOrders,
   regionOf) and sell_core.js (orderStops). */
"use strict";

const bpo = { bps: null, index: null, owned: null, rows: [], checked: new Set(), plan: null, tree: null };

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
    ? `Blueprint originals ${(pilots.find(p => p.id === pilotState.active) || pilots[0]).name} does not own yet, and where to buy them.`
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
  const reach = Math.max(0, +document.getElementById("bReach").value || 25);
  const t = bfs(origin.id, hs);
  return { origin, hs, reach, jumps: sys => { const d = t.dist.get(sys); return d !== undefined && d <= reach ? d : undefined; } };
}

async function scanBpos() {
  const sum = document.getElementById("bSum");
  await loadBpoData();
  if (!bpo.bps) return;
  const pilots = EveSSO.pilots();
  if (!pilots.length) { sum.textContent = "Sign in with Pilot login first."; return; }
  const ids = document.getElementById("bAll").checked ? pilots.map(p => p.id) : [pilotState.active || pilots[0].id];
  const owned = new Set();
  let failed = 0;
  for (const id of ids) {
    sum.textContent = `Reading ${(pilots.find(p => p.id === id) || {}).name || "pilot"}'s assets from CCP…`;
    try {
      const assets = await EveSSO.esi(id, `/characters/${id}/assets`);
      for (const t of BpoCore.ownedOriginals(assets, t => !!bpo.bps[t])) owned.add(t);
    } catch { failed++; }
  }
  bpo.owned = owned;
  bpo.failed = failed;
  rebuildBpoRows();
}

function rebuildBpoRows() {
  if (!bpo.owned) return;
  const sum = document.getElementById("bSum");
  bpo.tree = bpoTree();
  if (!bpo.tree) { sum.textContent = "Type your system in the from box."; return; }
  bpo.rows = BpoCore.buildRows(bpo.bps, bpo.index, bpo.owned, bpo.tree.jumps);
  drawBpoList();
}

function bpoFilters() {
  return { cat: document.getElementById("bCat").value, group: document.getElementById("bGroup").value,
           text: document.getElementById("bText").value, inReach: document.getElementById("bInReach").checked,
           mode: document.getElementById("bMode").value, pct: document.getElementById("bPct").value };
}

const SHOW_MAX = 300;
function drawBpoList() {
  const sum = document.getElementById("bSum"), list = document.getElementById("bList");
  const shown = BpoCore.sortRows(BpoCore.filterRows(bpo.rows, bpoFilters()), document.getElementById("bSort").value);
  const total = Object.keys(bpo.bps).length;
  sum.textContent = `You own ${bpo.owned.size.toLocaleString()} of ${total.toLocaleString()} blueprints on the market` +
    `${bpo.failed ? ` (${bpo.failed} pilot${bpo.failed === 1 ? "" : "s"} could not be read)` : ""}. ` +
    `${shown.length.toLocaleString()} match${shown.length === 1 ? "es" : ""}` +
    `${shown.length > SHOW_MAX ? `, first ${SHOW_MAX} shown: narrow the filters` : ""}. ${bpo.checked.size} checked.`;
  const where = st => esc(stationName(st) || `station ${st}`);
  list.innerHTML = shown.slice(0, SHOW_MAX).map(r => {
    const row = r.best || r.anywhere;
    const vs = r.vsAvg === null ? "" : ` <span class="${r.vsAvg <= 0 ? "b-good" : "b-bad"}">${r.vsAvg <= 0 ? "" : "+"}${r.vsAvg.toFixed(0)}% vs average</span>`;
    const place = r.best ? `${where(r.best[0])}, ${r.jumps} jump${r.jumps === 1 ? "" : "s"}`
      : row ? `cheapest out of reach: ${where(row[0])}` : "not on sale at an NPC station this hour";
    return `<li data-tid="${r.tid}"><input type="checkbox"${bpo.checked.has(r.tid) ? " checked" : ""} aria-label="Choose ${esc(r.name)}">` +
      `<div class="b-main"><div>${esc(r.name)}</div>` +
      `<div class="m-meta">${row ? `<span class="m-price">${fmtPrice(row[2])}</span>` : ""}${vs}` +
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
  const orders = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += 12) {
    await Promise.all(jobs.slice(i, i + 12).map(async ([t, r]) => {
      try { orders.push(...await liveOrders(r, t, "sell")); } catch { /* region skipped */ }
      sum.textContent = `Checking sellers live: ${++done} of ${jobs.length}…`;
    }));
  }
  const pick = BpoCore.pickPurchases(tids, orders, tree.jumps);
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
    : "None of the checked blueprints is for sale at an NPC station within reach right now.";
  out.innerHTML = route.stops.map((s, i) =>
    `<div class="h-stop"><div class="h-stop-head"><span class="h-n buy">${i + 1}</span><b>Buy</b> at ` +
    `${esc(stationName(s.station) || `station ${s.station}`)} <span class="m-meta">(${s.jumps} jump${s.jumps === 1 ? "" : "s"})</span></div>` +
    `<table class="h-tab"><tr><th>blueprint</th><th>price</th></tr>` +
    s.lines.map(l => `<tr><td>${esc(name(l.type_id))}</td><td>${fmtPrice(l.price)}</td></tr>`).join("") +
    `<tr class="h-sum"><td>stop total</td><td>${fmtPrice(s.gross)}</td></tr></table></div>`).join("") +
    (pick.missing.length ? `<div class="m-meta s-drop">Not for sale at an NPC station within reach right now: ` +
      `${pick.missing.map(t => esc(name(t))).join(", ")}. Try a longer reach or untick Highsec only.</div>` : "") +
    (pick.stops.length ? `<div class="m-meta">Total ${fmtPrice(pick.total)} ISK, checked live with CCP at ` +
      `${new Date().toUTCString().slice(17, 22)} UTC. In game, open the market at each stop, search the blueprint name ` +
      `and buy the one at this station; check the price before you confirm.</div>` : "");
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
