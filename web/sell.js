/* Sell my cargo (inside the Haul planner).

   Reads what is in the signed-in pilot's ship holds (CCP's asset list, or a
   paste of the cargo window), fetches every buy order for those items in the
   regions within reach, and plans the stops that sell everything for the
   most ISK after sales tax (sell_core.js does the planning). Anything no one
   is buying, or no one within reach, goes to a last stop at Jita 4-4 to be
   left in the hangar there. The stops go to the game's autopilot as
   waypoints. Loaded after haul.js; uses its globals (haul, bfs, haulOrigin,
   liveOrders, haulName) and pilot.js (pilotState, stationName). */
"use strict";

const sell = { plan: null, extraNames: new Map(), trees: new Map() };

const sellName = t => sell.extraNames.get(+t) || haulName(t);
const sellTax = () => {
  const acct = +document.getElementById("hAcct").value;
  return 0.075 * (1 - 0.11 * acct);
};

function setHaulMode(mode) {
  document.querySelectorAll("#haul [data-hmode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.hmode === mode)));
  document.querySelectorAll("#haul .h-trip").forEach(el => { el.hidden = mode !== "trip"; });
  document.querySelectorAll("#haul .h-sell").forEach(el => { el.hidden = mode !== "sell"; });
  if (mode === "trip") haul.layer.addTo(map); else haul.layer.remove();
}

async function sellNames() {
  if (!haul.names) {
    try { haul.names = new Map((await fetch("data/live/market_types.json").then(r => r.json())).types); }
    catch { haul.names = new Map(); }
  }
  if (!sell.byName) sell.byName = new Map([...haul.names].map(([id, n]) => [n.toLowerCase(), id]));
}

/* names CCP knows that the hourly market list does not */
async function resolveNames(names) {
  const out = new Map();
  if (!names.length) return out;
  try {
    const r = await EveSSO.esiPublic("/universe/ids", names.slice(0, 500));
    for (const t of r.inventory_types || []) { out.set(t.name.toLowerCase(), t.id); sell.extraNames.set(t.id, t.name); }
  } catch { /* stays unknown */ }
  return out;
}
async function nameTypes(ids) {
  const missing = ids.filter(t => !haul.names.has(t) && !sell.extraNames.has(t));
  for (let i = 0; i < missing.length; i += 500) {
    try {
      const r = await EveSSO.esiPublic("/universe/names", missing.slice(i, i + 500));
      for (const x of r) sell.extraNames.set(x.id, x.name);
    } catch { /* shown as item <id> */ }
  }
}

async function scanCargo() {
  const sum = document.getElementById("sSum");
  const id = typeof pilotState !== "undefined" && pilotState.active;
  if (!id) { sum.textContent = "Sign in with your pilot first, or paste the cargo from the game."; return; }
  sum.textContent = "Reading your ship and its cargo from CCP…";
  try {
    const ship = await EveSSO.esi(id, `/characters/${id}/ship`);
    const assets = await EveSSO.esi(id, `/characters/${id}/assets`);
    const items = SellCore.cargoFromAssets(assets, ship.ship_item_id);
    if (!items.size) {
      sum.textContent = "CCP's asset list shows an empty hold. It can be up to an hour behind the game; " +
        "if you just loaded up, paste the cargo instead.";
      return;
    }
    await planSell(items, []);
  } catch (e) {
    sum.textContent = `Could not read the cargo (${e.message}). Sign in again, or paste the cargo instead.`;
  }
}

async function pasteCargo() {
  const sum = document.getElementById("sSum");
  await sellNames();
  const text = document.getElementById("sPaste").value;
  let r = SellCore.parseCargoPaste(text, n => sell.byName.get(n.toLowerCase()));
  if (r.unknown.length) {
    const found = await resolveNames(r.unknown);
    for (const [n, tid] of found) sell.byName.set(n, tid);
    r = SellCore.parseCargoPaste(text, n => sell.byName.get(n.toLowerCase()));
  }
  if (!r.items.size) { sum.textContent = "Nothing in that paste looks like a cargo list."; return; }
  await planSell(r.items, r.unknown);
}

const treeFrom = (sys, hs) => {
  const k = `${sys}:${hs}`;
  if (!sell.trees.has(k)) sell.trees.set(k, bfs(sys, hs));
  return sell.trees.get(k);
};

async function planSell(items, unknown) {
  const sum = document.getElementById("sSum"), out = document.getElementById("sOut");
  const dest = document.getElementById("sDest");
  dest.hidden = true; out.innerHTML = "";
  await sellNames();
  await nameTypes([...items.keys()]);
  const origin = haulOrigin();
  if (!origin) { sum.textContent = "Where are you? Type your system in the from box."; return; }
  const hs = document.getElementById("sHigh").checked;
  const reach = Math.max(0, +document.getElementById("sReach").value || 15);
  const tree = treeFrom(origin.id, hs);
  const near = sys => { const d = tree.dist.get(sys); return d !== undefined && d <= reach; };
  const regions = [...new Set([...tree.dist].filter(([, d]) => d <= reach).map(([s]) => regionOf(s)))];

  const tids = [...items.keys()], jobs = [];
  for (const t of tids) for (const r of regions) jobs.push([t, r]);
  const orders = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += 12) {
    await Promise.all(jobs.slice(i, i + 12).map(async ([t, r]) => {
      try {
        for (const o of await liveOrders(r, t, "buy")) {
          /* NPC stations only: player structures may not let you dock */
          if (o.location_id >= 60000000 && o.location_id < 64000000 && near(o.system_id)) orders.push(o);
        }
      } catch { /* a region failing just drops its orders */ }
      sum.textContent = `Checking buyers: ${++done} of ${jobs.length} item and region pairs…`;
    }));
  }

  const tax = sellTax();
  const minStop = Math.max(0, +document.getElementById("sMin").value || 0) * 1e6;
  const free = new Set([SellCore.JITA.station, ...orders.filter(o => o.system_id === origin.id).map(o => o.location_id)]);
  const p = SellCore.planSale({ items, orders, tax, minStop, maxStops: 8, free });
  const dist = (a, b) => { const d = treeFrom(a, hs).dist.get(b); return d === undefined ? Infinity : d; };
  const drop = p.left.size ? SellCore.JITA : null;
  const route = SellCore.orderStops(p.stops, origin.id, dist, drop);
  sell.plan = { route, left: p.left, gross: p.gross, origin, hs, unknown, at: new Date() };
  drawSell();
}

function drawSell() {
  const { route, left, gross, origin, hs, unknown, at } = sell.plan;
  const rate = sellTax(), tax = gross * rate, net = gross - tax;
  const sum = document.getElementById("sSum"), out = document.getElementById("sOut");
  const where = s => esc(stationName(s.station) || (state.byId.get(s.system) || {}).name || `station ${s.station}`);
  const jumpsTxt = j => j === Infinity ? `no ${hs ? "highsec " : ""}route` : `${j} jump${j === 1 ? "" : "s"}`;
  const sells = route.stops.filter(s => s.lines.length);
  sum.textContent = sells.length
    ? `${sells.length} sell stop${sells.length === 1 ? "" : "s"} from ${origin.name}, ${jumpsTxt(route.jumps)} in all: ` +
      `${fmtPrice(net)} ISK after ${fmtPrice(tax)} sales tax.`
    : `No one within reach is buying what you carry.`;
  let html = "";
  route.stops.forEach((s, i) => {
    const isDrop = left.size > 0 && s.station === SellCore.JITA.station;
    html += `<div class="h-stop"><div class="h-stop-head"><span class="h-n sell">${i + 1}</span>` +
      `<b>${s.lines.length ? (isDrop ? "Sell and drop off" : "Sell") : "Drop off"}</b> at ${where(s)} <span class="m-meta">(${jumpsTxt(s.jumps)})</span></div>`;
    if (s.lines.length) {
      html += `<table class="h-tab"><tr><th>item</th><th>qty</th><th>each</th><th>after tax</th></tr>` +
        s.lines.map(l => `<tr><td>${esc(sellName(l.type_id))}</td><td>${l.qty.toLocaleString()}</td>` +
          `<td>${fmtPrice(l.price)}</td><td>${fmtPrice(l.qty * l.price * (1 - rate))}</td></tr>`).join("") +
        `<tr class="h-sum"><td>stop total</td><td></td><td></td><td class="h-profit">${fmtPrice(s.gross * (1 - rate))}</td></tr></table>`;
    }
    if (isDrop && left.size) {
      html += `<div class="m-meta s-drop">No buyer within reach: leave these in your Jita 4-4 hangar.</div>` +
        `<table class="h-tab"><tr><th>item</th><th>qty</th></tr>` +
        [...left].map(([t, q]) => `<tr><td>${esc(sellName(t))}</td><td>${q.toLocaleString()}</td></tr>`).join("") + `</table>`;
    }
    html += `</div>`;
  });
  if (unknown && unknown.length) {
    html += `<div class="m-meta s-drop">Not recognised from the paste, so not planned: ${unknown.map(esc).join(", ")}.</div>`;
  }
  html += `<div class="m-meta">Buy orders checked live with CCP at ${at.toUTCString().slice(17, 22)} UTC, ` +
    `NPC stations only, each sold at the order's own station. Gross ${fmtPrice(gross)} ISK. ` +
    `In game, right-click each item at the stop and choose Sell This Item; check the price matches before you confirm, ` +
    `since other haulers can fill an order before you arrive.</div>`;
  out.innerHTML = html;

  const dest = document.getElementById("sDest");
  const waypoints = route.stops.filter(s => s.jumps !== Infinity).map(s => s.station);
  dest.hidden = !(typeof pilotState !== "undefined" && pilotState.data.size) || !waypoints.length;
  dest.textContent = `Send sell route to autopilot (${waypoints.length} stop${waypoints.length === 1 ? "" : "s"})`;
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

function wireSell() {
  document.querySelectorAll("#haul [data-hmode]").forEach(b => b.onclick = () => setHaulMode(b.dataset.hmode));
  document.getElementById("sScan").onclick = scanCargo;
  document.getElementById("sPasteGo").onclick = pasteCargo;
  document.getElementById("hAcct").addEventListener("change", () => { if (sell.plan) drawSell(); });
}
wireSell();
