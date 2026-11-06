/* Fit shopper: what you still need for a fit, and where to buy all of it.

   1. The fit comes from the pilot's saved fittings (needs the fittings
      scope) or from pasted EFT text (no scope at all).
   2. The pilot's assets are counted per item; loose items count, modules
      fitted to other ships do not unless asked.
   3. The hourly job publishes, per item, the 40 cheapest NPC stations
      (data/live/sell_index). A station qualifies when it has every
      missing item in stock; qualifying stations are ranked by total cost,
      with jumps from the pilot. Buying each item at its own cheapest
      station is shown for comparison. */
"use strict";

const FITTINGS_SCOPE = "esi-fittings.read_fittings.v1";
const fit = { names: null, byName: null, fits: [], need: [], result: [], sort: "cost" };

async function fitNames() {
  if (!fit.names) {
    const t = (await fetch("data/live/market_types.json").then(r => r.json())).types;
    fit.names = new Map(t);
    fit.byName = new Map(t.map(([id, n]) => [n.toLowerCase(), id]));
  }
}

/* EFT: "[Ship, Name]" then one item per line, "Name xN" for stacks,
   blank lines between racks, "[Empty ... slot]" for gaps */
function parseEft(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = new Map(), unknown = [];
  let ship = null, title = "Pasted fit";
  const add = (name, n) => {
    const id = fit.byName.get(name.toLowerCase());
    if (id) out.set(id, (out.get(id) || 0) + n); else unknown.push(name);
  };
  for (const line of lines) {
    const head = line.match(/^\[([^,\]]+),\s*(.*)\]$/);
    if (head) { ship = head[1].trim(); title = head[2].trim() || ship; continue; }
    if (/^\[empty .* slot\]$/i.test(line)) continue;
    const m = line.match(/^(.*?)\s+x(\d+)$/);
    const name = (m ? m[1] : line).split(",")[0].trim();     /* "Module, Charge" loads a charge */
    add(name, m ? +m[2] : 1);
  }
  return { title, ship, items: out, unknown };
}

function fromSaved(f) {
  const items = new Map();
  for (const it of f.items) items.set(it.type_id, (items.get(it.type_id) || 0) + it.quantity);
  return { title: f.name, ship: fit.names.get(f.ship_type_id), shipId: f.ship_type_id, items, unknown: [] };
}

/* what is still missing after the pilot's assets */
function missingFor(spec, includeHull, useFitted) {
  const d = typeof pilotState !== "undefined" && pilotState.data.get(pilotState.active);
  const want = new Map(spec.items);
  if (includeHull) {
    const hullId = spec.shipId || (spec.ship && fit.byName.get(spec.ship.toLowerCase()));
    if (hullId) want.set(hullId, (want.get(hullId) || 0) + 1);
  }
  return [...want].map(([tid, n]) => {
    const have = d && d.owned && d.owned.get(tid)
      ? d.owned.get(tid).filter(x => useFitted || !x.fitted).reduce((a, x) => a + x.n, 0) : 0;
    return { tid, name: fit.names.get(tid) || `item ${tid}`, want: n, have: Math.min(have, n), need: Math.max(0, n - have) };
  });
}

async function shopFor(need) {
  const shards = new Map();
  for (const x of need) {
    const s = x.tid % 64;
    if (!shards.has(s)) shards.set(s, fetch(`data/live/sell_index/${s}.json`).then(r => r.ok ? r.json() : {}));
  }
  const rows = new Map();
  for (const x of need) rows.set(x.tid, ((await shards.get(x.tid % 64))[x.tid]) || []);
  /* every station that stocks at least one needed item */
  const stations = new Map();
  for (const x of need) {
    for (const [st, sys, price, qty] of rows.get(x.tid)) {
      const s = stations.get(st) || stations.set(st, { st, sys, cost: 0, got: 0, lines: [] }).get(st);
      if (qty >= x.need) { s.cost += price * x.need; s.got += 1; s.lines.push({ ...x, price }); }
    }
  }
  const cheapestEach = need.reduce((a, x) => {
    const r = rows.get(x.tid).find(([, , , q]) => q >= x.need);
    return r ? a + r[2] * x.need : NaN;
  }, 0);
  return { complete: [...stations.values()].filter(s => s.got === need.length), cheapestEach, rows };
}

async function runFit() {
  const sum = document.getElementById("fSum"), list = document.getElementById("fList");
  await fitNames();
  const pick = document.getElementById("fSaved").value;
  const spec = pick ? fromSaved(fit.fits[+pick]) : parseEft(document.getElementById("fEft").value);
  if (!spec.items.size && !spec.ship) { sum.textContent = "Pick a saved fit or paste one (EFT format)."; return; }
  const all = missingFor(spec, document.getElementById("fHull").checked, document.getElementById("fFitted").checked);
  fit.need = all.filter(x => x.need > 0);
  const owned = all.filter(x => x.have > 0);
  sum.innerHTML = `<b>${esc(spec.title)}</b>${spec.ship ? ` (${esc(spec.ship)})` : ""}: ${all.length} items, ` +
    `${owned.length ? `${owned.length} already owned in full or part, ` : ""}<b>${fit.need.length}</b> to buy.` +
    (spec.unknown.length ? `<br>Not recognized: ${spec.unknown.map(esc).join(", ")}` : "");
  if (!fit.need.length) { list.innerHTML = `<li class="m-meta">You already own everything on this fit.</li>`; return; }
  sum.insertAdjacentHTML("beforeend", "<br>Searching every station's market…");
  const { complete, cheapestEach } = await shopFor(fit.need);
  const origin = marketOrigin();
  const dist = origin ? distancesFrom(origin.id) : null;
  fit.result = complete.map(s => ({ ...s, jumps: dist ? dist.jumps.get(s.sys) : null }));
  fit.cheapestEach = cheapestEach;
  fit.origin = origin;
  drawFit();
}

function drawFit() {
  const sum = document.getElementById("fSum"), list = document.getElementById("fList");
  sum.innerHTML = sum.innerHTML.replace(/<br>Searching every station's market…$/, "");
  const far = x => x == null ? Infinity : x;
  const rows = [...fit.result].sort(fit.sort === "near" ? (a, b) => far(a.jumps) - far(b.jumps) || a.cost - b.cost
                                                        : (a, b) => a.cost - b.cost || far(a.jumps) - far(b.jumps)).slice(0, 15);
  if (!rows.length) {
    list.innerHTML = `<li class="m-meta">No single NPC station stocks everything still needed. ` +
      (Number.isFinite(fit.cheapestEach) ? `Buying each item at its cheapest station would cost ${fmtPrice(fit.cheapestEach)} ISK.` : "") + `</li>`;
    return;
  }
  const best = rows.reduce((a, s) => Math.min(a, s.cost), Infinity);
  list.innerHTML = (Number.isFinite(fit.cheapestEach)
      ? `<li class="m-meta">Cheapest possible, each item at its own station: ${fmtPrice(fit.cheapestEach)} ISK.</li>` : "") +
    rows.map((s, i) => {
      const p = state.byId.get(s.sys);
      return `<li data-i="${i}"><div class="r-sys"><span class="h-profit">${fmtPrice(s.cost)} ISK</span>
          <span style="color:${secColor(p.sec)}">${p.sec.toFixed(1)}</span><span>${esc(p.name)}</span>
          <span class="r-reg">${s.jumps == null ? "" : `${s.jumps} jumps`}</span></div>
        <div class="m-meta">${esc(stationName(s.st) || p.name)}${s.cost > best ? `, +${Math.round(100 * (s.cost - best) / best)}% vs cheapest station` : ", cheapest full set"}</div></li>`;
    }).join("");
  list.querySelectorAll("li[data-i]").forEach(li => li.onclick = e => {
    if (e.target.closest(".h-stops")) return;
    const s = rows[+li.dataset.i];
    list.querySelectorAll(".h-stops").forEach(x => x.remove());
    list.querySelectorAll("li").forEach(x => x.classList.toggle("on", x === li));
    li.insertAdjacentHTML("beforeend", `<div class="h-stops"><table class="h-tab">
      <tr><th>item</th><th>qty</th><th>each</th><th>total</th></tr>
      ${s.lines.map(x => `<tr><td>${esc(x.name)}</td><td>${x.need}</td><td>${fmtPrice(x.price)}</td><td>${fmtPrice(x.price * x.need)}</td></tr>`).join("")}
      <tr class="h-sum"><td>total</td><td></td><td></td><td>${fmtPrice(s.cost)}</td></tr></table>
      <div class="row-btns"><button class="h-copy" data-act="copy">Copy buy list</button>
      ${typeof pilotState !== "undefined" && pilotState.data.size ? `<button class="h-copy" data-act="dest">Set destination here</button>` : ""}</div>
      <div class="m-meta">Lowest prices from the hourly snapshot; check in game before you buy.</div></div>`);
    li.querySelector("[data-act=copy]").onclick = async ev => {
      ev.stopPropagation();
      try { await navigator.clipboard.writeText(s.lines.map(x => `${x.name}\t${x.need}`).join("\n")); ev.target.textContent = "Copied: paste into Multibuy"; }
      catch { ev.target.textContent = "Copy blocked by the browser"; }
    };
    const dest = li.querySelector("[data-act=dest]");
    if (dest) dest.onclick = async ev => {
      ev.stopPropagation();
      try {
        await EveSSO.esi(pilotState.active, `/ui/autopilot/waypoint?add_to_beginning=false&clear_other_waypoints=true&destination_id=${s.st}`, { method: "POST" });
        ev.target.textContent = "Destination set";
      } catch (err) { ev.target.textContent = `Failed (${err.message})`; }
    };
    select(s.sys); flyTo(state.byId.get(s.sys).ll, 6);
  });
}

async function loadSavedFits() {
  const sel = document.getElementById("fSaved"), note = document.getElementById("fScope");
  fit.fits = [];
  sel.innerHTML = `<option value="">paste a fit below instead</option>`;
  const p = typeof EveSSO !== "undefined" && EveSSO.pilots().find(x => x.id === pilotState.active);
  if (!p) { note.innerHTML = "Sign in to use saved fittings and count what you already own."; return; }
  if (!p.scopes.includes(FITTINGS_SCOPE)) {
    note.innerHTML = `<button class="h-copy" id="fGrant">Allow the Atlas to read ${esc(p.name)}'s saved fittings</button>`;
    document.getElementById("fGrant").onclick = () => EveSSO.login([FITTINGS_SCOPE]);
    return;
  }
  note.textContent = "";
  try {
    await fitNames();
    fit.fits = await EveSSO.esi(p.id, `/characters/${p.id}/fittings`);
    fit.fits.sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML += fit.fits.map((f, i) => `<option value="${i}">${esc(f.name)} (${esc(fit.names.get(f.ship_type_id) || "ship")})</option>`).join("");
  } catch (e) { note.textContent = `Could not read saved fittings (${e.message}).`; }
}

function openFit(open) {
  const box = document.getElementById("fitbox");
  box.hidden = !open;
  document.getElementById("fitBtn").setAttribute("aria-expanded", String(open));
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "bpo", "assets"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  loadSavedFits();
}

function wireFit() {
  document.getElementById("fitBtn").onclick = () => openFit(document.getElementById("fitbox").hidden);
  document.getElementById("fitClose").onclick = () => openFit(false);
  document.getElementById("fGo").onclick = () => runFit();
  document.querySelectorAll("#fitbox [data-fsort]").forEach(b => b.onclick = () => {
    fit.sort = b.dataset.fsort;
    document.querySelectorAll("#fitbox [data-fsort]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (fit.result.length) drawFit();
  });
}
wireFit();
