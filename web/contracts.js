/* Haul planner, contract modes (Courier jobs and Contract deals).

   Both read hourly files made by tools/fetch_contracts.py from CCP's public
   contract lists: data/live/courier.json and data/live/deals.json. Ranking is
   in contract_core.js. Player stations count only where the active pilot may
   dock (the same check as Sell my cargo and the blueprint finder); without
   a signed-in pilot they are shown, marked "docking not checked".
   Contracts are accepted in game: "Open in game" shows the contract in the
   client (CCP's open-window permission, asked once), and "Route" sets the
   autopilot through the stops.
   Uses globals from the main page, pilot.js, haul.js (bfs, haulOrigin,
   haulName), sell.js (dockable, sell, sellNames, sellTax) and bpo.js
   (placeName, OPEN_WINDOW_SCOPE). */
"use strict";

const kontract = { courier: null, deals: null, trees: new Map(), memo: {} };

async function loadContractFile(name) {
  try {
    const r = await fetch(`data/live/${name}.json`, { cache: "no-cache" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function contractCtx(hs, reach) {
  const origin = haulOrigin();
  if (!origin) return null;
  const tree = sys => {
    const k = `${sys}:${hs}`;
    if (!kontract.trees.has(k)) kontract.trees.set(k, bfs(sys, hs));
    return kontract.trees.get(k);
  };
  const stations = stationSystem();
  const pilot = typeof pilotState !== "undefined" && pilotState.active;
  return {
    origin, pilot,
    jumpsFrom: sys => { const d = tree(origin.id).dist.get(sys); return d !== undefined && d <= reach ? d : undefined; },
    path: (a, b) => { const d = tree(a).dist.get(b); return d === undefined ? Infinity : d; },
    /* remembered docking answers: a name means yes, null means refused, none means not asked yet */
    access: loc => {
      const m = pilot && kontract.memo[`${pilot}:${loc}`];
      return m ? !!m.name : null;
    },
    sysOf: loc => stations.get(loc) || sell.structSystems.get(loc) || ((market.structures || {})[loc] || [])[1] || 0,
  };
}

/* ask CCP about the player stations among the best candidates (at most 40
   new ones a search; answers are remembered for a day), then re-rank */
async function checkDocking(ctx, locs, sum) {
  const ids = [...new Set(locs.filter(l => l > 1e12))];
  if (ctx.pilot && ids.length) await dockable(ctx.pilot, ids, sum);
  kontract.memo = loadAccess();
}

const accessTag = p => (p.access === null && p.loc > 1e12 ? ` <span class="k-warn">(docking not checked)</span>` : "");
const jumpsTxt = j => `${j} jump${j === 1 ? "" : "s"}`;
const canOpenContracts = () =>
  (EveSSO.pilots().find(p => p.id === pilotState.active) || { scopes: [] }).scopes.includes(OPEN_WINDOW_SCOPE);

function wireContractButtons(list) {
  list.querySelectorAll("[data-open]").forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (!canOpenContracts()) { EveSSO.login([OPEN_WINDOW_SCOPE]); return; }
    b.textContent = "Opening…";
    try {
      await EveSSO.esi(pilotState.active, `/ui/openwindow/contract?contract_id=${b.dataset.open}`, { method: "POST" });
      b.textContent = "Opened in game";
    } catch (err) { b.textContent = `Failed (${err.message})`; }
  });
  list.querySelectorAll("[data-route]").forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const stops = b.dataset.route.split(",").map(Number);
    b.disabled = true;
    try {
      for (let i = 0; i < stops.length; i++) {
        b.textContent = `Sending ${i + 1} of ${stops.length}…`;
        await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false` +
          `&clear_other_waypoints=${i === 0}&destination_id=${stops[i]}`, { method: "POST" });
      }
      b.textContent = "Route sent";
    } catch (err) { b.textContent = `Failed (${err.message}); is the pilot in game?`; }
    b.disabled = false;
  });
}
const contractButtons = (cid, stops) => {
  const signed = typeof pilotState !== "undefined" && pilotState.data.size;
  return signed ? `<div class="k-btns"><button class="h-copy" data-open="${cid}">${canOpenContracts() ? "Open in game" : "Allow opening in game"}</button>` +
    `<button class="h-copy" data-route="${stops.join(",")}">Route to autopilot</button></div>` : "";
};

const SHOW = 100;
const num = id => { const v = document.getElementById(id).value.trim(); return v ? +v : 0; };

async function findCouriers() {
  const sum = document.getElementById("cSum"), list = document.getElementById("cList");
  list.innerHTML = "";
  sum.textContent = "Loading this hour's courier contracts…";
  const data = kontract.courier = await loadContractFile("courier");
  if (!data) { sum.textContent = "The courier list is not published yet."; return; }
  const hs = document.getElementById("cHigh").checked;
  const ctx = contractCtx(hs, num("cReach") || 10);
  if (!ctx) { sum.textContent = "Where are you? Type your system in the from box."; return; }
  const opts = { maxVolume: num("cVol"), maxCollateral: num("cColl") * 1e6 };
  kontract.memo = loadAccess();
  let ranked = ContractCore.rankCouriers(data.rows, ctx, opts);
  await checkDocking(ctx, ranked.slice(0, SHOW).flatMap(c => [c.from.loc, c.to.loc]), sum);
  ranked = ContractCore.rankCouriers(data.rows, ctx, opts);
  sum.textContent = `${ranked.length.toLocaleString()} courier job${ranked.length === 1 ? "" : "s"} you can take from ${ctx.origin.name}` +
    ` (of ${data.rows.length.toLocaleString()} public)${ranked.length > SHOW ? `, best ${SHOW} shown` : ""}. ` +
    `Listed ${Math.max(0, Math.round((Date.now() - Date.parse(data.generated)) / 60000))} min ago.`;
  list.innerHTML = ranked.slice(0, SHOW).map(c =>
    `<li><div class="k-top"><span class="k-big">${fmtPrice(c.reward)} ISK</span>` +
    `<span class="m-meta">${fmtPrice(c.perJump)} a jump</span></div>` +
    `<div>${placeName(c.from.loc)}${accessTag(c.from)} <span class="m-meta">(${jumpsTxt(c.toPickup)} away)</span>` +
    ` → ${placeName(c.to.loc)}${accessTag(c.to)} <span class="m-meta">(${jumpsTxt(c.haul)})</span></div>` +
    `<div class="m-meta">${Math.round(c.volume).toLocaleString()} m³, collateral ${fmtPrice(c.collateral)} ISK, ` +
    `${c.days} day${c.days === 1 ? "" : "s"} to deliver, offer ends in ${ContractCore.timeLeft(c.expires)}</div>` +
    contractButtons(c.cid, [c.from.loc, c.to.loc]) + `</li>`).join("");
  wireContractButtons(list);
}

async function findDeals() {
  const sum = document.getElementById("dSum"), list = document.getElementById("dList");
  list.innerHTML = "";
  sum.textContent = "Loading this hour's contract deals…";
  const data = kontract.deals = await loadContractFile("deals");
  if (!data) { sum.textContent = "The deals list is not published yet."; return; }
  await sellNames();
  const hs = document.getElementById("dHigh").checked;
  const ctx = contractCtx(hs, num("dReach") || 15);
  if (!ctx) { sum.textContent = "Where are you? Type your system in the from box."; return; }
  const opts = { tax: sellTax(), budget: num("dBudget") * 1e6, maxVolume: num("dVol"), sort: document.getElementById("dSort").value };
  kontract.memo = loadAccess();
  let ranked = ContractCore.rankDeals(data.rows, ctx, opts);
  await checkDocking(ctx, ranked.slice(0, SHOW).map(d => d.at.loc), sum);
  ranked = ContractCore.rankDeals(data.rows, ctx, opts);
  const missing = new Set();
  for (const d of ranked.slice(0, SHOW)) for (const [t] of d.top) if (!haul.names.has(t) && !sell.extraNames.has(t)) missing.add(t);
  if (missing.size) {
    try { for (const x of await EveSSO.esiPublic("/universe/names", [...missing].slice(0, 1000))) sell.extraNames.set(x.id, x.name); }
    catch { /* shown as item <id> */ }
  }
  sum.textContent = `${ranked.length.toLocaleString()} deal${ranked.length === 1 ? "" : "s"} within reach of ${ctx.origin.name}` +
    `${ranked.length > SHOW ? `, best ${SHOW} shown` : ""}. Valued at the best trade hub's buy orders, after your ` +
    `${(opts.tax * 100).toFixed(1)}% sales tax.${data.backlog ? ` Still reading ${data.backlog.toLocaleString()} newer contracts.` : ""}`;
  list.innerHTML = ranked.slice(0, SHOW).map(d => {
    const items = d.top.map(([t, q]) => `${q.toLocaleString()} × ${esc(sellName(t))}`).join(", ") +
      (d.kinds > d.top.length ? ` and ${d.kinds - d.top.length} more kind${d.kinds - d.top.length === 1 ? "" : "s"}` : "");
    return `<li><div class="k-top"><span class="k-big">+${fmtPrice(d.profit)} ISK</span>` +
      `<span class="m-meta">${(d.margin * 100).toFixed(0)}% margin, ${fmtPrice(d.perJump)} a jump</span></div>` +
      `<div class="m-meta">Pay ${fmtPrice(d.price)}, sell for ${fmtPrice(d.gross)} at ${placeName(d.hub)}</div>` +
      `<div>${items}</div>` +
      `<div class="m-meta">At ${placeName(d.at.loc)}${accessTag(d.at)} (${jumpsTxt(d.toPickup)} away), ` +
      `${d.at.loc === d.hub ? "already at the hub" : `then ${jumpsTxt(d.toHub)} to the hub`}. ${Math.round(d.volume).toLocaleString()} m³. Offer ends in ${ContractCore.timeLeft(d.expires)}.` +
      `${d.unsold ? ` <span class="k-warn">${d.unsold.toLocaleString()} unit${d.unsold === 1 ? "" : "s"} no hub buys (not counted).</span>` : ""}</div>` +
      contractButtons(d.cid, d.at.loc === d.hub ? [d.hub] : [d.at.loc, d.hub]) + `</li>`;
  }).join("");
  wireContractButtons(list);
}

function wireContracts() {
  document.getElementById("cGo").onclick = findCouriers;
  document.getElementById("dGo").onclick = findDeals;
  document.getElementById("dSort").onchange = () => { if (kontract.deals) findDeals(); };
}
wireContracts();
