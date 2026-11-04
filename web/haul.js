/* Haul planner: profitable round trips from where you are.

   The hourly job (tools/haul.py) finds station pairs where an item sells
   for less at A than buyers pay at B. Here those pairs become legs sized
   to your ship and budget: each leg fills the cargo hold with the items
   that earn the most per m3 between the same two stations, after your
   sales tax (instant trades: buy from sell orders, sell into buy orders).
   Two legs make a loop: out from home and back toward it, so the hold is
   earning in both directions. Loops are ranked by ISK per jump over the
   whole circuit, home to home.

   The page asks for a password first. This is a soft gate on a public
   site, not security: only a hash of the password is in the code, and
   the market data underneath is CCP's public data. */
"use strict";

const HAUL_HASH = "a8bdc05a86857c614f27b9586f31d76efdd45b5fa8b1920d1ecf7f7a2fd5796a";
const haul = { data: null, names: null, layer: L.layerGroup(), loops: [], sort: "perJump" };

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const haulUnlocked = () => { try { return sessionStorage.getItem("atlas.haul") === "1"; } catch { return false; } };

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
    g.items.sort((x, y) => y.net / y.v - x.net / x.v);
    let m3 = 0, isk = 0, profit = 0;
    const take = [];
    for (const it of g.items) {
      const n = Math.floor(Math.min(it.units, (cargo - m3) / it.v, (budget - isk) / it.c));
      if (n <= 0) continue;
      m3 += n * it.v; isk += n * it.c; profit += n * it.net;
      take.push({ tid: it.tid, n, profit: n * it.net, cost: n * it.c, c: it.c, g: it.g, m3: n * it.v });
    }
    if (profit > 0) legs.push({ ...g, take, m3, isk, profit });
  }
  return legs;
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
    for (const L2 of legs) {
      if (L2.a === o.L1.a && L2.b === o.L1.b) continue;      /* the outbound leg already took those orders */
      const bc = fromB.dist.get(L2.asys);
      if (bc == null || bc > maxOut) continue;
      const cd = tree(L2.asys).dist.get(L2.bsys), dh = home.dist.get(L2.bsys);
      if (cd == null || dh == null) continue;
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
    `${loops.length} round trips from <b>${esc(origin.name)}</b>${hs ? ", highsec only" : ""}.`;
  drawHauls();
}

function drawHauls() {
  const list = document.getElementById("hList");
  const loops = [...haul.loops].sort((a, b) => haul.sort === "total" ? b.total - a.total : b.perJump - a.perJump).slice(0, 15);
  const nm = t => (haul.names && haul.names.get(+t)) || `item ${t}`;
  const leg = (L, label, jumpsTo) => {
    const a = state.byId.get(L.asys), b = state.byId.get(L.bsys);
    const items = L.take.slice(0, 4).map(x => `${esc(nm(x.tid))} ×${x.n.toLocaleString()}`).join(", ") +
      (L.take.length > 4 ? `, +${L.take.length - 4} more` : "");
    return `<div class="h-leg"><b>${label}</b>: buy at ${esc(stationName(L.a) || a.name)} ` +
      `<span class="m-meta">(${jumpsTo} jumps)</span>, sell at ${esc(stationName(L.b) || b.name)}<br>` +
      `<span class="m-meta">${items}; ${Math.round(L.m3).toLocaleString()} m3, ${fmtPrice(L.isk)} ISK in</span> ` +
      `<span class="h-profit">+${fmtPrice(L.profit)}</span></div>`;
  };
  list.innerHTML = loops.map((o, i) => `<li data-i="${i}">
    <div class="r-sys"><span class="h-profit">+${fmtPrice(o.total)} ISK</span>
      <span class="m-meta">${o.jumps} jumps, ${fmtPrice(o.perJump)} per jump</span></div>
    ${leg(o.L1, "Out", haul.ctx.home.dist.get(o.L1.asys))}
    ${o.L2 ? leg(o.L2, "Back", haul.ctx.tree(o.L1.bsys).dist.get(o.L2.asys))
           : `<div class="h-leg m-meta">Back: no profitable return leg nearby; fly home empty.</div>`}
  </li>`).join("") || `<li class="m-meta">No profitable loops within reach. Widen the reach, raise the budget, or allow lowsec.</li>`;
  list.querySelectorAll("li[data-i]").forEach(li => li.onclick = e => {
    if (e.target.closest(".h-stops")) return;          /* reading the tables, not choosing a trip */
    showLoop(loops[+li.dataset.i], li);
  });
}

/* the whole circuit on the map: home, buy, sell, buy, sell, home */
function showLoop(o, li) {
  const { origin, tree } = haul.ctx;
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
  /* autopilot: the whole circuit, jump by jump, so the game flies this
     route (highsec only if chosen) rather than its own; each trade stop is
     its station, so autopilot docks there; home is the starting system */
  const stopIds = [o.L1.a, o.L1.b, ...(o.L2 ? [o.L2.a, o.L2.b] : []), origin.id];
  const waypoints = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const seg = pathTo(tree(stops[i]), stops[i + 1]) || [stops[i + 1]];
    waypoints.push(...seg.slice(1, -1), stopIds[i]);
  }
  const btn = document.getElementById("hDest"), first = document.getElementById("hFirst");
  const signedIn = typeof pilotState !== "undefined" && pilotState.data.size;
  btn.hidden = first.hidden = !signedIn;
  btn.textContent = `Send whole trip to autopilot (${waypoints.length} waypoints)`;
  first.textContent = "Set destination: first buy stop only";
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      for (let i = 0; i < waypoints.length; i++) {
        btn.textContent = `Sending waypoint ${i + 1} of ${waypoints.length}…`;
        await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false` +
          `&clear_other_waypoints=${i === 0}&destination_id=${waypoints[i]}`, { method: "POST" });
      }
      btn.textContent = `Trip sent: ${waypoints.length} waypoints, docking at each trade stop`;
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
  if (open && !haulUnlocked()) { askHaulPassword(); return; }
  panel.hidden = !open;
  document.getElementById("haulBtn").setAttribute("aria-expanded", String(open));
  if (!open) { haul.layer.remove(); document.body.classList.remove("route-open"); return; }
  openRoute(false);
  if (typeof openMarket === "function") document.getElementById("market").hidden = true;
  document.body.classList.add("route-open");
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

function askHaulPassword() {
  const box = document.createElement("div");
  box.className = "consent";
  box.innerHTML = `<form class="c-card"><h3>Haul planner</h3>
    <p>This planner is password protected.</p>
    <input type="password" id="haulPw" autocomplete="off" placeholder="password"
      style="width:100%;padding:7px 9px;background:rgba(13,19,31,.85);color:var(--ink);border:1px solid var(--panel-edge);border-radius:3px;font:inherit">
    <p class="c-small" id="haulPwMsg"></p>
    <div class="c-buttons"><button type="submit">Unlock</button><button type="button" data-act="cancel">Cancel</button></div></form>`;
  document.body.appendChild(box);
  const input = box.querySelector("#haulPw");
  input.focus();
  box.querySelector("[data-act=cancel]").onclick = () => box.remove();
  box.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    if (await sha256hex("new-eden-atlas:" + input.value) === HAUL_HASH) {
      try { sessionStorage.setItem("atlas.haul", "1"); } catch { /* private mode */ }
      box.remove();
      openHaul(true);
    } else {
      box.querySelector("#haulPwMsg").textContent = "That is not the password.";
      input.select();
    }
  };
}

function wireHaul() {
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
  return html + `<div class="m-meta">Buy from sell orders, sell into buy orders. Prices are this hour's best;
    check each in game before you commit.</div></div>`;
}
