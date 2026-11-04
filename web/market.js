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

const market = {
  types: null, item: null, side: "sell", sort: "price", rows: [], origin: null,
  layer: L.layerGroup(), rings: [], regions: null,
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
    const where = stationName(r.location) || "player structure";
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
}

function openMarket(open) {
  document.getElementById("market").hidden = !open;
  document.getElementById("marketBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    openRoute(false);
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
}

function wireMarket() {
  const btn = document.getElementById("marketBtn"), input = document.getElementById("mItem"),
        results = document.getElementById("mItemResults");
  btn.onclick = () => openMarket(document.getElementById("market").hidden);
  document.getElementById("marketClose").onclick = () => {
    openMarket(false); market.layer.remove(); document.body.classList.remove("route-open"); };
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
    syncClear();
    input.focus();
  };
  input.addEventListener("input", syncClear);
  input.oninput = () => {
    syncClear();
    const q = input.value.trim().toLowerCase();
    if (!q || !market.types) { results.classList.remove("open"); return; }
    const starts = [], has = [];
    for (const t of market.types) {
      const n = t[1].toLowerCase();
      if (n.startsWith(q)) starts.push(t); else if (n.includes(q)) has.push(t);
      if (starts.length >= 12) break;
    }
    const hits = [...starts, ...has].slice(0, 12);
    results.innerHTML = hits.map(t => `<button data-id="${t[0]}">${esc(t[1])}</button>`).join("");
    results.classList.toggle("open", hits.length > 0);
    results.querySelectorAll("button").forEach(b => b.onclick = () => {
      market.item = [+b.dataset.id, b.textContent];
      input.value = b.textContent;
      syncClear();
      results.classList.remove("open");
      runMarketSearch();
    });
  };
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
  map.on("zoomend", () => { const r = radiusFor(map.getZoom()); for (const { m, extra } of market.rings) m.setRadius(r + extra); });
}
wireMarket();
