/* Haul planner: profitable round trips from where you are.

   The hourly job (tools/haul.py) finds station pairs where an item sells
   for less at A than buyers pay at B. Here those pairs become legs sized
   to your ship and budget: each leg fills the cargo hold with the items
   that earn the most per m3 between the same two stations, after your
   sales tax (instant trades: buy from sell orders, sell into buy orders).
   Two legs make a loop: out from home and back toward it, so the hold is
   earning in both directions. Loops are ranked by ISK per jump over the
   whole circuit, home to home.

   Open to everyone: the market data underneath is CCP's public data. */
"use strict";

const haul = { data: null, names: null, layer: L.layerGroup(), loops: [], sort: "perJump" };


/* BFS over the stargate graph (optionally highsec only): distance and parent */
function bfs(from, highsecOnly) {
  const dist = new Map([[from, 0]]), parent = new Map(), q = [from];
  for (let i = 0; i < q.length; i++) {
    const v = q[i];
    for (const w of state.routeAdj.get(v) || []) {
      if (dist.has(w)) continue;
      if (highsecOnly && state.byId.get(w).sec < 0.5) continue;
      dist.set(w, dist.get(v) + 1); parent.set(w, v); q.push(w);
    }
  }
  return { dist, parent };
}
function pathTo(tree, to) {
  if (!tree.dist.has(to)) return null;
  const p = [to];
  while (tree.parent.has(p[0])) p.unshift(tree.parent.get(p[0]));
  return p;
}

/* legs: per station pair, the cargo-filling item mix (best ISK per m3 first) */
function buildLegs(cargo, budget, tax) {
  const groups = new Map();
  for (const [tid, a, asys, b, bsys, units, cost, gross] of haul.data.pairs) {
    const v = haul.data.volumes[tid];
    if (!v || !state.byId.has(asys) || !state.byId.has(bsys)) continue;
    const per = { tid, units, c: cost / units, g: gross / units, net: gross / units * (1 - tax) - cost / units, v };
    if (per.net <= 0) continue;
    const key = a + ">" + b;
    (groups.get(key) || groups.set(key, { a, b, asys, bsys, items: [] }).get(key)).items.push(per);
  }
  const legs = [];
  for (const g of groups.values()) {
    const filled = fillHold(g.items, cargo, budget);
    if (filled.profit > 0) legs.push({ ...g, ...filled });
  }
  return legs;
}

/* A return leg that buys at the outbound leg's buy station, or sells at
   its sell station, meets orders the outbound leg already used: those
   units come off before the return leg fills its hold. */
function afterLeg(L2, L1, cargo, budget) {
  const sameBuy = L2.a === L1.a, sameSell = L2.b === L1.b;
  if (!sameBuy && !sameSell) return L2;
  const used = new Map(L1.take.map(x => [x.tid, x.n]));
  const items = L2.items.map(it => used.has(it.tid) ? { ...it, units: it.units - used.get(it.tid) } : it).filter(it => it.units > 0);
  return { ...L2, items, ...fillHold(items, cargo, budget) };
}

/* fill the hold with the items that earn the most per m3, within budget */
function fillHold(items, cargo, budget) {
  /* only items with at least this many units that are both for sale at the
     buy stop AND wanted by buyers at the sell stop, at a profit (the walked
     quantity is capped by both books): thin stock or thin demand is likely
     gone by the time you arrive */
  const minStock = Math.max(1, +document.getElementById("hMin").value || 1);
  items = [...items].sort((x, y) => y.net / y.v - x.net / x.v);
  let m3 = 0, isk = 0, profit = 0;
  const take = [];
  for (const it of items) {
    if (it.units < minStock) continue;
    const n = Math.floor(Math.min(it.units, (cargo - m3) / it.v, (budget - isk) / it.c));
    if (n <= 0) continue;
    m3 += n * it.v; isk += n * it.c; profit += n * it.net;
    take.push({ tid: it.tid, n, profit: n * it.net, cost: n * it.c, c: it.c, g: it.g, m3: n * it.v });
  }
  return { take, m3, isk, profit };
}

/* ---- live check --------------------------------------------------------------
   The pairs come from the last hourly snapshot; orders get bought out in
   between. Before a trip is shown in detail, every candidate item of each
   leg is re-read from CCP right now (that station's sell orders, the other
   station's buy orders), the books are walked again, and the hold is
   refilled from what is really there. */
const regionOf = sys => state.byId.get(sys).regionId;
async function liveOrders(region, tid, side) {
  const r = await fetch(`https://esi.evetech.net/markets/${region}/orders?order_type=${side}&type_id=${tid}`,
    { headers: { "X-Compatibility-Date": "2025-09-30" } });
  if (!r.ok) throw new Error(`ESI ${r.status}`);
  return r.json();
}
function walkLive(asks, bids, tax) {
  asks = asks.map(a => [a.price, a.volume_remain]).sort((x, y) => x[0] - y[0]);
  bids = bids.map(b => [b.price, b.volume_remain, b.min_volume || 1]).sort((x, y) => y[0] - x[0]);
  let i = 0, j = 0, units = 0, cost = 0, gross = 0;
  while (i < asks.length && j < bids.length) {
    const [pa, qa] = asks[i], [pb, qb, mn] = bids[j];
    if (pb * (1 - tax) <= pa) break;
    const take = Math.min(qa, qb);
    if (take < mn) { j++; continue; }
    units += take; cost += take * pa; gross += take * pb;
    asks[i][1] -= take; bids[j][1] -= take;
    if (!asks[i][1]) i++;
    if (!bids[j][1]) j++;
  }
  return { units, cost, gross };
}
async function verifyLeg(L, before = null) {
  const { tax, cargo, budget } = haul.ctx;
  const candidates = [...L.items].sort((x, y) => y.net / y.v - x.net / x.v).slice(0, 25);
  const live = [], gone = [];
  await Promise.all(candidates.map(async it => {
    try {
      const [asks, bids] = await Promise.all([
        liveOrders(regionOf(L.asys), it.tid, "sell").then(o => o.filter(x => x.location_id === L.a)),
        liveOrders(regionOf(L.bsys), it.tid, "buy").then(o => o.filter(x => x.location_id === L.b))]);
      /* the outbound leg, checked first, already bought or sold some of these */
      const used = before && (before.take.find(x => x.tid === it.tid) || {}).n;
      const a2 = used && before.a === L.a ? consume(asks, used, (x, y) => x.price - y.price) : asks;
      const b2 = used && before.b === L.b ? consume(bids, used, (x, y) => y.price - x.price) : bids;
      const w = walkLive(a2, b2, tax);
      if (!w.units) { gone.push(it.tid); return; }
      live.push({ tid: it.tid, v: it.v, units: w.units, c: w.cost / w.units, g: w.gross / w.units,
                  net: w.gross / w.units * (1 - tax) - w.cost / w.units });
    } catch { live.push(it); }          /* CCP unreachable: keep the snapshot figure */
  }));
  const filled = fillHold(live.filter(x => x.net > 0), cargo, budget);
  const wasTaken = new Set(L.take.map(x => x.tid));
  return { ...L, ...filled, gone: gone.filter(t => wasTaken.has(t)), checked: new Date() };
}
/* a copy of an order book with n units taken off, best orders first */
function consume(orders, n, best) {
  const out = orders.map(o => ({ ...o })).sort(best);
  for (const o of out) {
    const t = Math.min(n, o.volume_remain);
    o.volume_remain -= t; n -= t;
    if (!n) break;
  }
  return out.filter(o => o.volume_remain > 0);
}
async function verifyLoop(o) {
  const L1 = await verifyLeg(o.L1);
  const L2 = o.L2 ? await verifyLeg(o.L2, L1) : null;
  o.L1 = L1;
  if (L2) o.L2 = L2;
  o.total = o.L1.profit + (o.L2 ? o.L2.profit : 0);
  o.perJump = o.total / Math.max(1, o.jumps);
  o.verified = true;
}

function planHauls() {
  const sum = document.getElementById("hSum"), list = document.getElementById("hList");
  const origin = haulOrigin();
  if (!origin) { sum.textContent = "Sign in, or type a starting system."; return; }
  const cargo = +document.getElementById("hCargo").value || 0;
  const budget = (+document.getElementById("hBudget").value || 0) * 1e6;
  const acct = +document.getElementById("hAcct").value;
  const tax = haul.data.tax.base * (1 - haul.data.tax.perAccountingLevel * acct);
  const maxOut = +document.getElementById("hReach").value || 10;
  const hs = document.getElementById("hHigh").checked;
  if (cargo <= 0 || budget <= 0) { sum.textContent = "Set your cargo (m3) and budget."; return; }

  const home = bfs(origin.id, hs);
  const legs = buildLegs(cargo, budget, tax);
  const trees = new Map();
  const tree = sys => trees.get(sys) || trees.set(sys, bfs(sys, hs)).get(sys);
  /* outbound: starts within reach of home */
  const out = [];
  for (const L1 of legs) {
    const toA = home.dist.get(L1.asys);
    if (toA == null || toA > maxOut) continue;
    const ab = tree(L1.asys).dist.get(L1.bsys);
    if (ab == null) continue;
    out.push({ L1, j1: toA + ab, rate: L1.profit / Math.max(1, toA + ab) });
  }
  out.sort((x, y) => y.rate - x.rate);
  /* back: for the best outbound legs, the leg that best brings you home */
  const loops = [];
  for (const o of out.slice(0, 60)) {
    const fromB = tree(o.L1.bsys);
    const homeAlone = home.dist.get(o.L1.bsys) ?? Infinity;
    let best = { L2: null, j2: homeAlone, profit: 0 };
    for (const L2raw of legs) {
      if (L2raw.a === o.L1.a && L2raw.b === o.L1.b) continue;      /* the outbound leg already took those orders */
      const bc = fromB.dist.get(L2raw.asys);
      if (bc == null || bc > maxOut) continue;
      const cd = tree(L2raw.asys).dist.get(L2raw.bsys), dh = home.dist.get(L2raw.bsys);
      if (cd == null || dh == null) continue;
      const L2 = afterLeg(L2raw, o.L1, cargo, budget);
      if (L2.profit <= 0) continue;
      const j2 = bc + cd + dh;
      if ((o.L1.profit + L2.profit) / (o.j1 + j2) > (o.L1.profit + best.profit) / (o.j1 + best.j2)) {
        best = { L2, j2, profit: L2.profit };
      }
    }
    const total = o.L1.profit + best.profit, jumps = o.j1 + best.j2;
    if (Number.isFinite(jumps)) loops.push({ ...o, ...best, total, jumps, perJump: total / Math.max(1, jumps) });
  }
  haul.loops = loops;
  haul.ctx = { origin, tax, cargo, budget, hs, home, tree };
  sum.innerHTML = `${legs.length.toLocaleString()} profitable station pairs at ${(tax * 100).toFixed(2)}% sales tax; ` +
    `${loops.length} round trips from <b>${esc(origin.name)}</b>${hs ? ", highsec only" : ""}. ` +
    `Snapshot ${Math.round((Date.now() - Date.parse(haul.data.generated)) / 60e3)} min old; pick a trip to check it live.`;
  drawHauls();
}

function drawHauls() {
  const list = document.getElementById("hList");
  const loops = [...haul.loops].sort((a, b) => haul.sort === "total" ? b.total - a.total : b.perJump - a.perJump).slice(0, 15);
  list.innerHTML = loops.map((o, i) => `<li data-i="${i}">
    <div class="r-sys"><span class="h-profit">+${fmtPrice(o.total)} ISK</span>
      <span class="m-meta">${o.jumps} jumps, ${fmtPrice(o.perJump)} per jump</span></div>
    ${legHtml(o.L1, "Out", haul.ctx.home.dist.get(o.L1.asys))}
    ${o.L2 ? legHtml(o.L2, "Back", haul.ctx.tree(o.L1.bsys).dist.get(o.L2.asys))
           : `<div class="h-leg m-meta">Back: no profitable return leg nearby; fly home empty.</div>`}
  </li>`).join("") || `<li class="m-meta">No profitable loops within reach. Widen the reach, raise the budget, or allow lowsec.</li>`;
  list.querySelectorAll("li[data-i]").forEach(li => li.onclick = e => {
    if (e.target.closest(".h-stops")) return;          /* reading the tables, not choosing a trip */
    showLoop(loops[+li.dataset.i], li);
  });
}

/* the whole circuit on the map: home, buy, sell, buy, sell, home */
function legHtml(L, label, jumpsTo) {
  const nm = haulName;
    const a = state.byId.get(L.asys), b = state.byId.get(L.bsys);
    const items = L.take.slice(0, 4).map(x => `${esc(nm(x.tid))} ×${x.n.toLocaleString()}`).join(", ") +
      (L.take.length > 4 ? `, +${L.take.length - 4} more` : "");
    return `<div class="h-leg"><b>${label}</b>: buy at ${esc(stationName(L.a) || a.name)} ` +
      `<span class="m-meta">(${jumpsTo} jumps)</span>, sell at ${esc(stationName(L.b) || b.name)}<br>` +
      `<span class="m-meta">${items}; ${Math.round(L.m3).toLocaleString()} m3, ${fmtPrice(L.isk)} ISK in</span> ` +
      `<span class="h-profit">+${fmtPrice(L.profit)}</span></div>`;
  }

async function showLoop(o, li) {
  const { origin, tree } = haul.ctx;
  if (!o.verified) {
    li.classList.add("on");
    li.insertAdjacentHTML("beforeend", `<div class="h-stops m-meta">Checking every item live with CCP…</div>`);
    await verifyLoop(o);
    li.querySelector(".h-stops").remove();
    const head = li.querySelector(".r-sys");
    if (head) head.innerHTML = `<span class="h-profit">+${fmtPrice(o.total)} ISK</span>` +
      `<span class="m-meta">${o.jumps} jumps, ${fmtPrice(o.perJump)} per jump · checked live</span>`;
    const legs = li.querySelectorAll(".h-leg");
    if (legs[0]) legs[0].outerHTML = legHtml(o.L1, "Out", haul.ctx.home.dist.get(o.L1.asys));
    if (legs[1] && o.L2) legs[1].outerHTML = legHtml(o.L2, "Back", haul.ctx.tree(o.L1.bsys).dist.get(o.L2.asys));
  }
  const stops = [origin.id, o.L1.asys, o.L1.bsys, ...(o.L2 ? [o.L2.asys, o.L2.bsys] : []), origin.id];
  const path = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const seg = pathTo(tree(stops[i]), stops[i + 1]);
    if (seg) path.push(...(path.length ? seg.slice(1) : seg));
  }
  haul.layer.clearLayers();
  const lls = path.map(id => state.byId.get(id).ll);
  haul.layer.addLayer(L.polyline(lls, { renderer: route.renderer || canvas, interactive: false,
    color: "#7dff9a", weight: 3, opacity: .9 }));
  [["buy", o.L1.asys], ["sell", o.L1.bsys], ...(o.L2 ? [["buy", o.L2.asys], ["sell", o.L2.bsys]] : [])]
    .forEach(([kind, sys], k) => {
      const m = L.circleMarker(state.byId.get(sys).ll, { renderer: canvas, interactive: false, radius: radiusFor(map.getZoom()) + 7,
        color: kind === "buy" ? "#7dff9a" : "#ffd24a", weight: 2.6, fill: false });
      m.bindTooltip(`${k + 1}. ${kind} at ${esc(state.byId.get(sys).name)}`, { permanent: true, direction: "right",
        offset: [12, 0], className: "price-tag" });
      haul.layer.addLayer(m);
    });
  haul.layer.addTo(map);
  map.fitBounds(L.latLngBounds(lls).pad(.2), { maxZoom: 7, paddingTopLeft: [document.getElementById("haul").getBoundingClientRect().right + 20, 60] });
  document.querySelectorAll("#hList li").forEach(x => {
    x.classList.toggle("on", x === li);
    const d = x.querySelector(".h-stops");
    if (d) d.remove();
  });
  li.insertAdjacentHTML("beforeend", stopsHtml(o));
  li.querySelectorAll("[data-copy]").forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const L = b.dataset.copy === "1" ? o.L1 : o.L2;
    /* one "name quantity" per line: pastes straight into the in-game Multibuy window */
    const text = L.take.map(x => `${haulName(x.tid)}\t${x.n}`).join("\n");
    try { await navigator.clipboard.writeText(text); b.textContent = "Copied: paste into Multibuy in game"; }
    catch { b.textContent = "Copy failed: browser blocked the clipboard"; }
  });
  /* autopilot: just the turn points that hold the game to this circuit
     (highsec only if chosen), not every system; each trade stop is its
     station, so autopilot docks there; home is the starting system */
  const stopIds = [o.L1.a, o.L1.b, ...(o.L2 ? [o.L2.a, o.L2.b] : []), origin.id];
  const waypoints = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const seg = pathTo(tree(stops[i]), stops[i + 1]) || [stops[i], stops[i + 1]];
    const turns = PilotCore.turnPoints(seg, v => state.routeAdj.get(v) || []);
    waypoints.push(...turns.slice(0, -1), stopIds[i]);
  }
  const btn = document.getElementById("hDest"), first = document.getElementById("hFirst");
  const signedIn = typeof pilotState !== "undefined" && pilotState.data.size;
  btn.hidden = first.hidden = !signedIn;
  btn.textContent = `Send whole trip to autopilot (${waypoints.length} waypoints)`;
  first.textContent = "Set destination: first buy stop only";
  btn.onclick = async () => {
    btn.disabled = true;
    /* open the pop-out first: browsers allow a new window only straight
       from a click, before any waiting */
    const hud = window.open("hud.html", "atlasHaulHud", "width=460,height=720");
    saveActiveHaul(o, stops, path);
    try {
      await EveSSO.waypoints(pilotState.active, waypoints, (i, n) => { btn.textContent = `Sending waypoint ${i} of ${n}…`; });
      btn.textContent = `Trip sent: ${waypoints.length} waypoints, docking at each trade stop`;
      if (!hud) btn.textContent += ". Your browser blocked the haul window; use Open haul window.";
    } catch (e) { btn.textContent = `Failed (${e.message}); is the pilot in game?`; }
    btn.disabled = false;
  };
  first.onclick = async () => {
    first.textContent = "Sending…";
    try {
      await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false&clear_other_waypoints=true&destination_id=${o.L1.a}`, { method: "POST" });
      first.textContent = "Destination set: first buy stop";
    } catch (e) { first.textContent = `Failed (${e.message}); is the pilot in game?`; }
  };
}

function haulOrigin() {
  const typed = document.getElementById("hFrom").value.trim().toLowerCase();
  if (typed) { const p = [...state.byId.values()].find(s => s.name.toLowerCase() === typed); if (p) return p; }
  const d = typeof pilotState !== "undefined" && pilotState.data.get(pilotState.active);
  return d && d.loc ? state.byId.get(d.loc.system) : (state.selected ? state.byId.get(state.selected) : null);
}

/* the signed-in pilot's ship sets the default cargo (base hold; rigs and
   skills add more, so the number is editable) */
async function fillShip() {
  const d = typeof pilotState !== "undefined" && pilotState.data.get(pilotState.active);
  const label = document.getElementById("hShip");
  if (!d || !d.ship) { label.textContent = "no pilot signed in: enter your cargo"; return; }
  try {
    const t = await fetch(`https://esi.evetech.net/universe/types/${d.ship.type}`,
      { headers: { "X-Compatibility-Date": "2025-09-30" } }).then(r => r.json());
    label.textContent = `${d.name} in a ${t.name}${d.ship.name ? ` ("${d.ship.name}")` : ""}`;
    if (t.capacity) document.getElementById("hCargo").value = Math.round(t.capacity);
  } catch { label.textContent = "ship unknown: enter your cargo"; }
}

async function openHaul(open) {
  const panel = document.getElementById("haul");
  panel.hidden = !open;
  document.getElementById("haulBtn").setAttribute("aria-expanded", String(open));
  if (!open) { haul.layer.remove(); document.body.classList.remove("route-open"); return; }
  openRoute(false);
  if (typeof openMarket === "function") document.getElementById("market").hidden = true;
  document.getElementById("shelf").hidden = true;
  document.getElementById("fitbox").hidden = true;
  if (document.getElementById("bpo")) document.getElementById("bpo").hidden = true;
  if (document.getElementById("assets")) document.getElementById("assets").hidden = true;
  document.body.classList.add("route-open");
  if (haul.pendingMode && typeof setHaulMode === "function") { setHaulMode(haul.pendingMode); haul.pendingMode = null; }
  fillShip();
  if (!haul.data) {
    document.getElementById("hSum").textContent = "Loading this hour's trade pairs…";
    try {
      haul.data = await fetch("data/live/haul.json").then(r => r.json());
      const t = await fetch("data/live/market_types.json").then(r => r.json());
      haul.names = new Map(t.types);
      document.getElementById("hSum").textContent = `Trade pairs from ${hhmm(haul.data.generated)}. Set your hold and budget, then Find hauls.`;
    } catch {
      document.getElementById("hSum").textContent = "Trade pairs are not published yet; they arrive with the next hourly update.";
    }
  }
}

function wireHaul() {
  const hudBtn = document.getElementById("hHud");
  try { hudBtn.hidden = !localStorage.getItem("atlas.activeHaul"); } catch { /* none */ }
  hudBtn.onclick = () => window.open("hud.html", "atlasHaulHud", "width=460,height=720");
  document.getElementById("haulBtn").onclick = () => openHaul(document.getElementById("haul").hidden);
  document.getElementById("haulClose").onclick = () => openHaul(false);
  document.getElementById("hGo").onclick = () => { if (haul.data) planHauls(); };
  const acct = document.getElementById("hAcct"), taxLbl = document.getElementById("hTax");
  const showTax = () => { taxLbl.textContent = `${(7.5 * (1 - .11 * +acct.value)).toFixed(2)}% sales tax`; };
  acct.onchange = showTax; showTax();
  document.querySelectorAll("#haul [data-hsort]").forEach(b => b.onclick = () => {
    haul.sort = b.dataset.hsort;
    document.querySelectorAll("#haul [data-hsort]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (haul.loops.length) drawHauls();
  });
}
wireHaul();

const haulName = t => (haul.names && haul.names.get(+t)) || `item ${t}`;

/* stop by stop: exactly what to buy and sell, at what price, for how much */
function stopsHtml(o) {
  const tax = haul.ctx.tax;
  const where = (station, sys) => esc(stationName(station) || state.byId.get(sys).name);
  const buyTable = L => `<table class="h-tab"><tr><th>item</th><th>qty</th><th>each</th><th>total</th></tr>` +
    L.take.map(x => `<tr><td>${esc(haulName(x.tid))}</td><td>${x.n.toLocaleString()}</td>` +
      `<td>${fmtPrice(x.c)}</td><td>${fmtPrice(x.n * x.c)}</td></tr>`).join("") +
    `<tr class="h-sum"><td>total</td><td></td><td>${Math.round(L.m3).toLocaleString()} m3</td><td>${fmtPrice(L.isk)}</td></tr></table>`;
  const sellTable = L => `<table class="h-tab"><tr><th>item</th><th>qty</th><th>each</th><th>after tax</th></tr>` +
    L.take.map(x => `<tr><td>${esc(haulName(x.tid))}</td><td>${x.n.toLocaleString()}</td>` +
      `<td>${fmtPrice(x.g)}</td><td>${fmtPrice(x.n * x.g * (1 - tax))}</td></tr>`).join("") +
    `<tr class="h-sum"><td>profit</td><td></td><td></td><td class="h-profit">+${fmtPrice(L.profit)}</td></tr></table>`;
  const stop = (n, kind, station, sys, body, copy) =>
    `<div class="h-stop"><div class="h-stop-head"><span class="h-n ${kind}">${n}</span>` +
    `<b>${kind === "buy" ? "Buy" : "Sell"}</b> at ${where(station, sys)}` +
    `${copy ? `<button class="h-copy" data-copy="${copy}">Copy buy list</button>` : ""}</div>${body}</div>`;
  let html = `<div class="h-stops">` +
    stop(1, "buy", o.L1.a, o.L1.asys, buyTable(o.L1), "1") +
    stop(2, "sell", o.L1.b, o.L1.bsys, sellTable(o.L1));
  if (o.L2) {
    html += stop(3, "buy", o.L2.a, o.L2.asys, buyTable(o.L2), "2") +
            stop(4, "sell", o.L2.b, o.L2.bsys, sellTable(o.L2));
  }
  const gone = [...(o.L1.gone || []), ...((o.L2 && o.L2.gone) || [])];
  if (!o.L1.take.length) {
    return `<div class="h-stops m-meta">Nothing on this trip passes the live check now: the items were bought out,
      or there is less on the market than your minimum stock. Try another trip, or run Find hauls again.</div>`;
  }
  const when = o.L1.checked ? o.L1.checked.toUTCString().slice(17, 22) + " UTC" : "";
  return html + `<div class="m-meta">${when ? `Checked live with CCP at ${when}: these quantities and prices are on the market now. ` : ""}` +
    `${gone.length ? `Bought out since the snapshot and dropped: ${gone.map(t => esc(haulName(t))).join(", ")}. ` : ""}` +
    `Buy from sell orders, sell into buy orders; anything can still move before you arrive.</div></div>`;
}

/* the active haul, for the pop-out window (hud.html): every stop with
   exactly what to do there, and the jump-by-jump path to track progress */
function saveActiveHaul(o, stops, path) {
  const tax = haul.ctx.tax;
  const sys = id => { const p = state.byId.get(id); return { id, name: p.name, sec: +p.sec.toFixed(1) }; };
  const stop = (kind, L) => ({
    kind, station: kind === "buy" ? L.a : L.b, system: kind === "buy" ? L.asys : L.bsys,
    stationName: stationName(kind === "buy" ? L.a : L.b) || state.byId.get(kind === "buy" ? L.asys : L.bsys).name,
    items: L.take.map(x => ({ name: haulName(x.tid), n: x.n,
      each: kind === "buy" ? x.c : x.g, total: kind === "buy" ? x.n * x.c : x.n * x.g * (1 - tax) })),
    m3: L.m3, isk: L.isk, profit: L.profit,
  });
  const active = {
    pilot: pilotState.active, pilotName: (pilotState.data.get(pilotState.active) || {}).name,
    started: new Date().toISOString(), tax, total: o.total,
    stops: [stop("buy", o.L1), stop("sell", o.L1), ...(o.L2 ? [stop("buy", o.L2), stop("sell", o.L2)] : [])],
    home: sys(stops[0]), path: path.map(sys), done: 0,
  };
  try { localStorage.setItem("atlas.activeHaul", JSON.stringify(active)); } catch { /* private mode */ }
  document.getElementById("hHud").hidden = false;
}
