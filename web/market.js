/* Market finder: "where can I buy (or sell) this item near me?"

   For one item, every k-space region's NPC orders are fetched live from
   CCP's public market API (one small request per region). Each order
   names its solar system, so it joins straight onto the map. Distance is
   counted two ways from the chosen origin over the stargate graph: plain
   jumps, and the safer-route cost the route planner uses (security band,
   30-day kills, gate camps, recent kills, ganks), so a cheap seller behind
   a notorious pipe ranks as what it is. Loaded after the main script and
   pilot.js; uses their globals (state, map, canvas, danger, ...). */
"use strict";

/* deal heat map: green (best) through yellow and orange to red (worst) */
const DEAL_RAMP = ["#2fe07a", "#c8e04a", "#ffb03a", "#ff4a3a"];
function dealColor(x) {                          /* x in [0, 1], 0 = best deal */
  const pos = Math.min(.999, Math.max(0, x)) * (DEAL_RAMP.length - 1), i = Math.floor(pos), f = pos - i;
  const a = DEAL_RAMP[i], b = DEAL_RAMP[i + 1];
  const mix = k => Math.round(parseInt(a.slice(k, k + 2), 16) * (1 - f) + parseInt(b.slice(k, k + 2), 16) * f)
    .toString(16).padStart(2, "0");
  return "#" + mix(1) + mix(3) + mix(5);
}

const market = {
  types: null, item: null, side: "sell", sort: "price", rows: [], origin: null,
  layer: L.layerGroup(), rings: [], regions: null, heat: L.layerGroup(), heatRings: [],
};
const ESI_BASE = "https://esi.evetech.net";
const ESI_HEADERS = { "X-Compatibility-Date": "2025-09-30" };
const fmtPrice = v => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M"
                   : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(2);

/* one-to-all shortest paths from `from`: jumps (BFS) and safer cost (Dijkstra) */
function distancesFrom(from) {
  const jumps = new Map([[from, 0]]), q = [from];
  for (let i = 0; i < q.length; i++) {
    for (const w of state.routeAdj.get(q[i]) || []) {
      if (!jumps.has(w)) { jumps.set(w, jumps.get(q[i]) + 1); q.push(w); }
    }
  }
  const costOf = id => { const d = danger(state.byId.get(id)); return 1 + 3 * d + 2 * d * d; };
  const safe = new Map([[from, 0]]), heap = [[0, from]];
  const up = i => { while (i) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
  const down = i => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
    if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
    if (m === i) return; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } };
  while (heap.length) {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; down(0); }
    const [d, v] = top;
    if (d > safe.get(v)) continue;
    for (const w of state.routeAdj.get(v) || []) {
      const nd = d + costOf(w);
      if (nd < (safe.has(w) ? safe.get(w) : Infinity)) { safe.set(w, nd); heap.push([nd, w]); up(heap.length - 1); }
    }
  }
  return { jumps, safe };
}

async function structureOrders(typeId, side) {
  try {
    if (!market.structures) market.structures = await fetch("data/live/structures.json").then(r => r.ok ? r.json() : {});
    const shard = await fetch(`data/live/structure_orders/${typeId % 64}.json`).then(r => r.ok ? r.json() : {});
    const rec = shard[typeId];
    if (!rec) return [];
    return rec[side === "sell" ? "s" : "b"].map(([price, qty, sid]) => ({
      price, volume_remain: qty, location_id: sid, system_id: (market.structures[sid] || [])[1] }))
      .filter(o => o.system_id);
  } catch { return []; }
}

async function marketRegions() {
  if (!market.regions) {
    const r = await fetch("data/regions.json").then(x => x.json());
    market.regions = r.regions.filter(x => x.systems && x.id < 11000000).map(x => x.id);
  }
  return market.regions;
}

async function fetchItemOrders(typeId, side, progress) {
  const regions = await marketRegions(), out = [];
  let done = 0;
  for (let i = 0; i < regions.length; i += 10) {
    await Promise.all(regions.slice(i, i + 10).map(async rid => {
      try {
        const r = await fetch(`${ESI_BASE}/markets/${rid}/orders?order_type=${side}&type_id=${typeId}`, { headers: ESI_HEADERS });
        if (r.ok) out.push(...await r.json());
      } catch { /* a region failing just drops its orders */ }
      progress(++done, regions.length);
    }));
  }
  return out;
}

function marketOrigin() {
  const typed = document.getElementById("mFrom").value.trim().toLowerCase();
  if (typed) {
    const p = [...state.byId.values()].find(s => s.name.toLowerCase() === typed);
    if (p) return p;
  }
  const d = typeof pilotState !== "undefined" && pilotState.data.get(pilotState.active);
  if (d && d.loc) return state.byId.get(d.loc.system);
  return state.selected ? state.byId.get(state.selected) : null;
}

async function runMarketSearch() {
  const sum = document.getElementById("mSum"), list = document.getElementById("mList");
  if (!market.item) return;
  const origin = marketOrigin();
  market.origin = origin;
  sum.textContent = `Searching every region for ${market.item[1]}…`;
  list.innerHTML = "";
  const orders = await fetchItemOrders(market.item[0], market.side,
    (n, of) => { sum.textContent = `Searching ${market.item[1]}: region ${n} of ${of}…`; });
  /* player-structure orders: collected hourly by tools/fetch_structure_markets.py
     (CCP serves those only per structure, to a pilot with access) */
  const extra = await structureOrders(market.item[0], market.side);
  orders.push(...extra);
  const dist = origin ? distancesFrom(origin.id) : null;
  market.rows = orders.filter(o => state.byId.has(o.system_id)).map(o => ({
    price: o.price, qty: o.volume_remain, min: o.min_volume || 1, range: o.range,
    system: o.system_id, location: o.location_id,
    jumps: dist ? dist.jumps.get(o.system_id) : null,
    safe: dist ? dist.safe.get(o.system_id) : null,
  }));
  drawMarket();
}

function sortedRows() {
  const better = market.side === "sell" ? (a, b) => a.price - b.price : (a, b) => b.price - a.price;
  const far = x => x == null ? Infinity : x;
  const rows = [...market.rows];
  if (market.sort === "jumps") rows.sort((a, b) => far(a.jumps) - far(b.jumps) || better(a, b));
  else if (market.sort === "safe") rows.sort((a, b) => far(a.safe) - far(b.safe) || better(a, b));
  else rows.sort((a, b) => better(a, b) || far(a.jumps) - far(b.jumps));
  return rows;
}

function drawMarket() {
  const sum = document.getElementById("mSum"), list = document.getElementById("mList");
  market.layer.clearLayers();
  market.rings = [];
  if (!market.item) return;
  const rows = sortedRows().slice(0, 40);
  const side = market.side === "sell" ? "sell orders" : "buy orders";
  if (!rows.length) { sum.textContent = `No ${side} for ${market.item[1]} on any NPC market right now.`; list.innerHTML = ""; return; }
  const all = market.rows.map(r => r.price), bestPrice = market.side === "sell" ? Math.min(...all) : Math.max(...all);
  sum.innerHTML = `<b>${market.rows.length.toLocaleString()}</b> ${side} for <b>${esc(market.item[1])}</b>; ` +
    `best ${fmtPrice(bestPrice)} ISK` + (market.origin ? `. Distances from ${esc(market.origin.name)}.` :
    `. Sign in or pick a system to see distances.`);
  list.innerHTML = rows.map((r, i) => {
    const p = state.byId.get(r.system);
    const st = market.structures && market.structures[r.location];
    const where = stationName(r.location) || (st ? `${st[0]} (player structure)` : "player structure");
    const dist = r.jumps == null ? "" : `${r.jumps} jump${r.jumps === 1 ? "" : "s"}` +
      (r.safe != null && r.jumps ? `, safer-route cost ${r.safe.toFixed(0)}` : "");
    const pct = bestPrice ? Math.round(100 * (r.price - bestPrice) / bestPrice) : 0;
    return `<li data-i="${i}" data-sys="${r.system}"><div class="r-sys">
        <span class="m-price">${fmtPrice(r.price)}</span>
        <span style="color:${secColor(p.sec)}">${p.sec.toFixed(1)}</span><span>${esc(p.name)}</span>
        <span class="r-reg">${esc(p.region)}</span></div>
      <div class="m-meta">${r.qty.toLocaleString()} available${r.min > 1 ? ` (min ${r.min})` : ""}` +
      `${pct ? `, ${pct > 0 ? "+" : ""}${pct}% vs best` : ", best price"}${dist ? `; ${dist}` : ""}</div>
      <div class="m-meta">${esc(where)}</div></li>`;
  }).join("");
  list.querySelectorAll("li").forEach(li => li.onclick = () => {
    const sys = +li.dataset.sys;
    if (market.origin && market.origin.id !== sys) {
      document.getElementById("rFrom").value = market.origin.name;
      document.getElementById("rTo").value = state.byId.get(sys).name;
      openMarket(false);
      openRoute(true);
      drawRoute();
    } else { select(sys); flyTo(state.byId.get(sys).ll, 7); }
  });
  /* map: ring per seller system, brightest for the top of the list */
  const seen = new Set();
  rows.forEach((r, i) => {
    if (seen.has(r.system)) return;
    seen.add(r.system);
    const p = state.byId.get(r.system);
    const m = L.circleMarker(p.ll, { renderer: canvas, interactive: false, fill: true,
      fillColor: "#7fd0ff", fillOpacity: i < 5 ? .35 : .12, color: "#7fd0ff",
      weight: i < 5 ? 2.6 : 1.4, opacity: i < 5 ? 1 : .7 });
    if (i < 5) m.bindTooltip(fmtPrice(r.price), { permanent: true, direction: "right", offset: [12, 0], className: "price-tag" });
    market.layer.addLayer(m);
    market.rings.push({ m, extra: i < 5 ? 8 : 5 });
  });
  const rr = radiusFor(map.getZoom());
  for (const { m, extra } of market.rings) m.setRadius(rr + extra);
  market.layer.addTo(map);
  document.getElementById("mHeatWrap").hidden = false;
  if (document.getElementById("mHeat").checked) drawHeat();
}

/* every system with orders, colored by how good its best price is: ranked
   against the other systems (a rank spreads the colors evenly even when a
   few absurd prices sit at the far end) */
function drawHeat() {
  market.heat.clearLayers();
  market.heatRings = [];
  const on = document.getElementById("mHeat").checked && market.rows.length;
  document.getElementById("mRamp").hidden = !on;
  if (!on) { market.heat.remove(); return; }
  const sellSide = market.side === "sell", best = new Map();
  for (const r of market.rows) {
    const b = best.get(r.system);
    if (b == null || (sellSide ? r.price < b : r.price > b)) best.set(r.system, r.price);
  }
  const ranked = [...best].sort((a, b) => sellSide ? a[1] - b[1] : b[1] - a[1]);
  ranked.forEach(([sys, price], i) => {
    const p = state.byId.get(sys);
    const color = dealColor(ranked.length > 1 ? i / (ranked.length - 1) : 0);
    const glow = L.circleMarker(p.ll, { renderer: canvas, interactive: false, stroke: false,
      fill: true, fillColor: color, fillOpacity: .22 });
    const core = L.circleMarker(p.ll, { renderer: canvas, interactive: false, stroke: true, color,
      weight: 2, opacity: .95, fill: true, fillColor: color, fillOpacity: .55 });
    glow.bindTooltip(`${esc(p.name)}: ${fmtPrice(price)}`, { sticky: true, className: "price-tag" });
    market.heat.addLayer(glow);
    market.heat.addLayer(core);
    market.heatRings.push({ m: glow, extra: 14 }, { m: core, extra: 2 });
  });
  const r = radiusFor(map.getZoom());
  for (const { m, extra } of market.heatRings) m.setRadius(r + extra);
  market.heat.addTo(map);
  market.layer.remove();                         /* the heat map replaces the top-five rings */
}

function openMarket(open) {
  document.getElementById("market").hidden = !open;
  document.getElementById("marketBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    openRoute(false);
    document.getElementById("haul").hidden = true;
    document.getElementById("shelf").hidden = true;
    document.getElementById("fitbox").hidden = true;
    document.body.classList.add("route-open");          /* zoom buttons step aside */
    loadMarketTypes();
    document.getElementById("mItem").focus();
  }
}

async function loadMarketTypes() {
  if (market.types) return;
  try {
    const r = await fetch("data/live/market_types.json").then(x => x.json());
    market.types = r.types;
  } catch {
    market.types = [];
    document.getElementById("mSum").textContent = "The item list is not published yet; it arrives with the next hourly update.";
  }
  loadTypeMeta();
}

/* item facts from the SDE (tools/build_type_meta.py): slot, kind, tech level,
   rig size per type, for the filters under the item box */
const SLOT_NAME = { H: "high", M: "mid", L: "low", R: "rig", S: "subsystem" };
const RIG_SIZE = { 1: "small", 2: "medium", 3: "large", 4: "capital" };
async function loadTypeMeta() {
  if (market.meta) return;
  try {
    market.meta = await fetch("data/type_meta.json").then(x => x.json());
  } catch {
    market.meta = null;
    document.querySelector(".m-filters").hidden = true;
    return;
  }
  const fill = (id, entries) => {
    const sel = document.getElementById(id);
    sel.innerHTML = sel.options[0].outerHTML + entries.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("");
  };
  const count = (i) => { const c = {}; for (const v of Object.values(market.meta.t)) c[v[i]] = (c[v[i]] || 0) + 1; return c; };
  const metaCount = count(2), catCount = count(1);
  fill("mfMeta", Object.entries(market.meta.metas).filter(([k]) => metaCount[k]).sort((a, b) => +a[0] - +b[0]));
  fill("mfCat", Object.entries(market.meta.cats).filter(([k]) => catCount[k]).sort((a, b) => a[1].localeCompare(b[1])));
}
function itemFilter() {
  const slot = document.getElementById("mfSlot").value, size = document.getElementById("mfSize").value,
        meta = document.getElementById("mfMeta").value, cat = document.getElementById("mfCat").value;
  if (!market.meta || !(slot || meta || cat)) return null;
  return tid => {
    const m = market.meta.t[tid];
    if (!m) return false;
    if (slot && m[0] !== slot) return false;
    if (slot === "R" && size && String(m[3]) !== size) return false;
    if (meta && String(m[2]) !== meta) return false;
    if (cat && String(m[1]) !== cat) return false;
    return true;
  };
}
function itemTag(tid) {
  const m = market.meta && market.meta.t[tid];
  if (!m) return "";
  const parts = [];
  if (m[0]) parts.push(m[0] === "R" && m[3] ? `${RIG_SIZE[m[3]]} rig` : `${SLOT_NAME[m[0]]}${m[0] === "R" || m[0] === "S" ? "" : " slot"}`);
  const meta = market.meta.metas[m[2]];
  if (meta && meta !== "Tech I") parts.push(meta);
  return parts.join(" · ");
}

function wireMarket() {
  const btn = document.getElementById("marketBtn"), input = document.getElementById("mItem"),
        results = document.getElementById("mItemResults");
  btn.onclick = () => openMarket(document.getElementById("market").hidden);
  document.getElementById("marketClose").onclick = () => {
    openMarket(false); market.layer.remove(); market.heat.remove(); document.body.classList.remove("route-open"); };
  const clear = document.getElementById("mClear");
  const syncClear = () => { clear.hidden = !input.value && !market.item; };
  clear.onclick = () => {                      /* back to a blank search, map cleared */
    market.item = null;
    market.rows = [];
    input.value = "";
    results.classList.remove("open");
    document.getElementById("mList").innerHTML = "";
    document.getElementById("mSum").textContent = "Pick an item. Every region's NPC market is searched live from CCP.";
    market.layer.clearLayers();
    market.rings = [];
    market.heat.clearLayers();
    market.heat.remove();
    document.getElementById("mHeatWrap").hidden = true;
    document.getElementById("mRamp").hidden = true;
    syncClear();
    input.focus();
  };
  input.addEventListener("input", syncClear);
  input.oninput = () => {
    syncClear();
    const q = input.value.trim().toLowerCase();
    const pass = itemFilter();
    /* with a filter set, an empty box lists everything that matches it */
    if ((!q && !pass) || !market.types) { results.classList.remove("open"); return; }
    const LIMIT = pass ? 40 : 12;
    const starts = [], has = [];
    let total = 0;
    for (const t of market.types) {
      if (pass && !pass(t[0])) continue;
      const n = t[1].toLowerCase();
      if (!q || n.startsWith(q)) { starts.push(t); total++; }
      else if (n.includes(q)) { has.push(t); total++; }
      if (!pass && starts.length >= LIMIT) break;
    }
    const hits = [...starts, ...has].slice(0, LIMIT);
    results.innerHTML = hits.map(t => `<button data-id="${t[0]}"><span class="m-tag">${esc(itemTag(t[0]))}</span>${esc(t[1])}</button>`).join("") +
      (pass && total > hits.length ? `<div class="m-count">${total} items match; type more of the name to narrow it</div>` : "") +
      (pass && !total ? `<div class="m-count">No items match these filters${q ? " and that name" : ""}.</div>` : "");
    results.classList.toggle("open", hits.length > 0 || !!pass);
    results.querySelectorAll("button").forEach(b => b.onclick = () => {
      const label = b.lastChild.textContent;
      market.item = [+b.dataset.id, label];
      input.value = label;
      syncClear();
      results.classList.remove("open");
      runMarketSearch();
    });
  };
  for (const id of ["mfSlot", "mfSize", "mfMeta", "mfCat"]) {
    document.getElementById(id).onchange = () => {
      document.getElementById("mfSize").hidden = document.getElementById("mfSlot").value !== "R";
      if (market.item) { market.item = null; input.value = ""; }    /* a new filter starts a new pick */
      input.oninput();
      input.focus();
    };
  }
  input.onkeydown = e => {
    if (e.key === "Enter") { const b = results.querySelector("button"); if (b) b.click(); }
  };
  document.getElementById("mFrom").onchange = () => market.item && runMarketSearch();
  document.querySelectorAll("#market [data-side]").forEach(b => b.onclick = () => {
    market.side = b.dataset.side;
    document.querySelectorAll("#market [data-side]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (market.item) runMarketSearch();
  });
  document.querySelectorAll("#market [data-sort]").forEach(b => b.onclick = () => {
    market.sort = b.dataset.sort;
    document.querySelectorAll("#market [data-sort]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    drawMarket();
  });
  map.on("zoomend", () => { const r = radiusFor(map.getZoom());
    for (const { m, extra } of [...market.rings, ...market.heatRings]) m.setRadius(r + extra); });
  document.getElementById("mHeat").onchange = () => {
    if (document.getElementById("mHeat").checked) drawHeat();
    else { market.heat.remove(); document.getElementById("mRamp").hidden = true; market.layer.addTo(map); }
  };
}
wireMarket();
