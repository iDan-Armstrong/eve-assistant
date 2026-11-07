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

const JUNK_BID = 0.1;   /* a buy order under 10% of the item's average price is ignored */
const sell = { plan: null, extraNames: new Map(), trees: new Map(), structNames: new Map(), structSystems: new Map(), capped: 0 };

const sellName = t => sell.extraNames.get(+t) || haulName(t);
const sellTax = () => {
  const acct = +document.getElementById("hAcct").value;
  return 0.075 * (1 - 0.11 * acct);
};

/* courier jobs and contract deals start from the ship's hold, read when
   the search runs (the ship arrives after the panel opens); typing in the
   box, or clearing it for any size, takes over */
function syncHoldBoxes() {
  const hold = document.getElementById("hCargo").value;
  for (const id of ["cVol", "dVol"]) {
    const box = document.getElementById(id);
    if (!box) continue;
    if (!box.dataset.touched && hold) box.value = hold;
    box.oninput = () => { box.dataset.touched = "1"; };
  }
}

function setHaulMode(mode) {
  document.querySelectorAll("#haul [data-hmode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.hmode === mode)));
  for (const m of ["trip", "sell", "cour", "deal"]) {
    document.querySelectorAll(`#haul .h-${m}`).forEach(el => { el.hidden = mode !== m; });
  }
  syncHoldBoxes();
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
async function sellResolveNames(names) {
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
    const found = await sellResolveNames(r.unknown);
    for (const [n, tid] of found) sell.byName.set(n, tid);
    r = SellCore.parseCargoPaste(text, n => sell.byName.get(n.toLowerCase()));
  }
  if (!r.items.size) { sum.textContent = "Nothing in that paste looks like a cargo list."; return; }
  await planSell(r.items, r.unknown);
}

/* Can this pilot dock at these player stations? CCP answers the structure
   lookup only for pilots on the station's docking list, so a 403 means no.
   Answers are remembered per pilot for a day. Each refusal counts against
   CCP's error allowance (100 a minute), so at most 40 new stations are
   asked per plan, the most promising first. */
const ACCESS_KEY = "atlas.sell.access", ACCESS_TTL = 864e5, ACCESS_MAX_NEW = 40;
function loadAccess() {
  try { return JSON.parse(localStorage.getItem(ACCESS_KEY)) || {}; } catch { return {}; }
}
async function dockable(pilot, ids, sum) {
  const memo = loadAccess(), now = Date.now(), ok = new Set();
  const todo = [];
  for (const sid of ids) {
    const m = memo[`${pilot}:${sid}`];
    if (m && now - m.at < ACCESS_TTL) {
      if (m.name) { ok.add(sid); sell.structNames.set(sid, m.name); if (m.sys) sell.structSystems.set(sid, m.sys); }
    }
    else todo.push(sid);
  }
  sell.capped = Math.max(0, todo.length - ACCESS_MAX_NEW);
  const ask = todo.slice(0, ACCESS_MAX_NEW);
  let done = 0;
  for (let i = 0; i < ask.length; i += 5) {
    await Promise.all(ask.slice(i, i + 5).map(async sid => {
      try {
        const st = await EveSSO.esi(pilot, `/universe/structures/${sid}`);
        memo[`${pilot}:${sid}`] = { at: now, name: st.name, sys: st.solar_system_id };
        ok.add(sid); sell.structNames.set(sid, st.name); sell.structSystems.set(sid, st.solar_system_id);
      } catch (e) {
        if (/: 40[34]$/.test(e.message)) memo[`${pilot}:${sid}`] = { at: now, name: null };
      }
      sum.textContent = `Checking which player stations you can dock at: ${++done} of ${ask.length}…`;
    }));
  }
  for (const k of Object.keys(memo)) if (now - memo[k].at > ACCESS_TTL) delete memo[k];
  try { localStorage.setItem(ACCESS_KEY, JSON.stringify(memo)); } catch { /* private mode */ }
  return ok;
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
  const res = await computeSale(items, origin, {
    hs, reach: Math.max(0, +document.getElementById("sReach").value || 15),
    minStop: Math.max(0, +document.getElementById("sMin").value || 0) * 1e6,
    structs: document.getElementById("sStruct").checked,
  }, sum);
  sell.plan = { route: res.route, left: res.left, gross: res.gross, origin, hs, unknown, at: new Date() };
  drawSell();
}

/* the sale itself, shared with the asset clean-up tool: live buy orders in
   reach of origin (plus player stations the pilot may dock at), planned by
   SellCore, unsold items to a Jita drop-off.
   opts: { hs, reach, minStop (ISK), structs (bool) } */
async function computeSale(items, origin, opts, sum) {
  const { hs, reach, minStop } = opts;
  const tree = treeFrom(origin.id, hs);
  const near = sys => { const d = tree.dist.get(sys); return d !== undefined && d <= reach; };
  const regions = [...new Set([...tree.dist].filter(([, d]) => d <= reach).map(([s]) => regionOf(s)))];

  const tids = [...items.keys()], jobs = [];
  for (const t of tids) for (const r of regions) jobs.push([t, r]);
  const orders = [], structOrders = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += 24) {
    await Promise.all(jobs.slice(i, i + 24).map(async ([t, r]) => {
      try {
        for (const o of await liveOrders(r, t, "buy")) {
          if (near(o.system_id) && o.location_id >= 60000000 && o.location_id < 64000000) orders.push(o);
        }
      } catch { /* a region failing just drops its orders */ }
      sum.textContent = `Checking buyers: ${++done} of ${jobs.length} item and region pairs…`;
    }));
  }

  /* player stations: CCP's region feed has NPC stations only, so their buy
     orders come from the hourly structure-market job (data/live/structure_orders),
     kept only where this pilot may dock */
  sell.capped = 0;
  const pilot = typeof pilotState !== "undefined" && pilotState.active;
  if (pilot && opts.structs) {
    for (const t of tids) {
      for (const o of await structureOrders(t, "buy")) {
        if (near(o.system_id)) structOrders.push({ ...o, type_id: t, min_volume: 1 });
      }
    }
  }
  if (pilot && opts.structs && structOrders.length) {
    const ok = await dockable(pilot, SellCore.structureCandidates(items, SellCore.planSale({ items, orders }), structOrders), sum);
    orders.push(...structOrders.filter(o => ok.has(o.location_id)));
  }

  /* junk bids: buy orders far below what the item normally trades at
     (CCP's average price) are lowball traps, not buyers */
  const avg = typeof pilotState !== "undefined" && pilotState.prices;
  if (avg) {
    const keep = o => { const a = avg.get(o.type_id); return !a || o.price >= JUNK_BID * a; };
    for (let i = orders.length - 1; i >= 0; i--) if (!keep(orders[i])) orders.splice(i, 1);
  }

  const tax = sellTax();
  const free = new Set([SellCore.JITA.station, ...orders.filter(o => o.system_id === origin.id).map(o => o.location_id)]);
  const p = SellCore.planSale({ items, orders, tax, minStop, maxStops: 8, free });
  const dist = (a, b) => { const d = treeFrom(a, hs).dist.get(b); return d === undefined ? Infinity : d; };
  const drop = p.left.size ? SellCore.JITA : null;
  const route = SellCore.orderStops(p.stops, origin.id, dist, drop);
  return { route, left: p.left, gross: p.gross };
}

function drawSell() {
  const { route, left, gross, origin, hs, unknown, at } = sell.plan;
  const rate = sellTax(), tax = gross * rate, net = gross - tax;
  const sum = document.getElementById("sSum"), out = document.getElementById("sOut");
  const where = s => s.station > 1e12
    ? `${esc(sell.structNames.get(s.station) || `player station ${s.station}`)} <span class="m-meta">(player station, you can dock)</span>`
    : esc(stationName(s.station) || (state.byId.get(s.system) || {}).name || `station ${s.station}`);
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
  if (sell.capped) {
    html += `<div class="m-meta">${sell.capped} more player station${sell.capped === 1 ? "" : "s"} with better bids were not checked yet ` +
      `(CCP limits how many refusals it allows a minute). Plan again in a minute to check them; answers are remembered for a day.</div>`;
  }
  const withStructs = typeof pilotState !== "undefined" && pilotState.active && document.getElementById("sStruct").checked;
  html += `<div class="m-meta">Buy orders checked live with CCP at ${at.toUTCString().slice(17, 22)} UTC, ` +
    `${withStructs ? "NPC stations plus player stations your pilot can dock at (an owner can still close the market to you)" : "NPC stations only"}, each sold at the order's own station. Gross ${fmtPrice(gross)} ISK. ` +
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
      await EveSSO.waypoints(pilotState.active, waypoints, (i, n) => { dest.textContent = `Sending stop ${i} of ${n}…`; });
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
