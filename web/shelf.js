/* Station market: everything for sale (and wanted) at one NPC station.
   The hourly market job writes one small file per station from every
   region's orders (CCP only serves whole regions). Opened from the
   "market" link beside each station in the system panel. */
"use strict";

const shelf = { station: null, items: [], sort: "name", names: null };

async function openShelf(stationId, label) {
  const box = document.getElementById("shelf");
  openRoute(false);
  ["market", "haul"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  box.hidden = false;
  document.body.classList.add("route-open");
  document.getElementById("sTitle").textContent = label;
  document.getElementById("sFilter").value = "";
  const sum = document.getElementById("sSum"), list = document.getElementById("sList");
  sum.textContent = "Loading this station's market…";
  list.innerHTML = "";
  try {
    if (!shelf.names) shelf.names = new Map((await fetch("data/live/market_types.json").then(r => r.json())).types);
    const r = await fetch(`data/live/stations/${stationId}.json`);
    if (!r.ok) { sum.textContent = "No market orders at this station right now."; shelf.items = []; return; }
    const doc = await r.json();
    shelf.station = stationId;
    shelf.generated = doc.generated;
    shelf.items = doc.items.map(([tid, sell, sellQty, buy, buyQty]) =>
      ({ tid, name: shelf.names.get(tid) || `item ${tid}`, sell, sellQty, buy, buyQty }));
    drawShelf();
  } catch { sum.textContent = "Station markets are not published yet; they arrive with the next hourly update."; }
}

function drawShelf() {
  const q = document.getElementById("sFilter").value.trim().toLowerCase();
  let rows = shelf.items.filter(x => !q || x.name.toLowerCase().includes(q));
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    sell: (a, b) => (b.sell || 0) * b.sellQty - (a.sell || 0) * a.sellQty,
    buy: (a, b) => (b.buy || 0) * b.buyQty - (a.buy || 0) * a.buyQty,
  }[shelf.sort];
  rows.sort(by);
  const forSale = shelf.items.filter(x => x.sellQty).length, wanted = shelf.items.filter(x => x.buyQty).length;
  document.getElementById("sSum").innerHTML = `<b>${forSale.toLocaleString()}</b> items for sale, ` +
    `<b>${wanted.toLocaleString()}</b> wanted by buyers` + (q ? `; ${rows.length.toLocaleString()} match "${esc(q)}"` : "") +
    `. Snapshot from ${hhmm(shelf.generated)}.`;
  const shown = rows.slice(0, 300);
  document.getElementById("sList").innerHTML = shown.map(x => `<li data-tid="${x.tid}">
      <div class="r-sys"><span>${esc(x.name)}</span></div>
      <div class="m-meta s-cols">
        <span>${x.sellQty ? `sell <b>${fmtPrice(x.sell)}</b> · ${x.sellQty.toLocaleString()} for sale` : "none for sale"}</span>
        <span>${x.buyQty ? `buy <b>${fmtPrice(x.buy)}</b> · ${x.buyQty.toLocaleString()} wanted` : "no buyers"}</span>
      </div></li>`).join("") +
    (rows.length > shown.length ? `<li class="m-meta">${(rows.length - shown.length).toLocaleString()} more: type in the filter to narrow the list.</li>` : "");
  document.querySelectorAll("#sList li[data-tid]").forEach(li => li.onclick = () => {
    /* hand the item to Find item: where else is it cheaper, and how far */
    const tid = +li.dataset.tid;
    document.getElementById("shelf").hidden = true;
    openMarket(true);
    market.item = [tid, shelf.names.get(tid)];
    document.getElementById("mItem").value = shelf.names.get(tid);
    document.getElementById("mClear").hidden = false;
    runMarketSearch();
  });
}

function wireShelf() {
  document.getElementById("shelfClose").onclick = () => {
    document.getElementById("shelf").hidden = true;
    document.body.classList.remove("route-open");
  };
  document.getElementById("sFilter").oninput = drawShelf;
  document.querySelectorAll("#shelf [data-ssort]").forEach(b => b.onclick = () => {
    shelf.sort = b.dataset.ssort;
    document.querySelectorAll("#shelf [data-ssort]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    drawShelf();
  });
  /* the "market" link beside each station in the system panel */
  document.getElementById("pStations").addEventListener("click", e => {
    const a = e.target.closest("[data-shelf]");
    if (a) { e.stopPropagation(); openShelf(+a.dataset.shelf, a.dataset.name); }
  });
}
wireShelf();
