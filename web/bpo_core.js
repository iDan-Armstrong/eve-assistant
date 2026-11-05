/* Blueprint finder: the pure half (no DOM, no network), shared by the page
   and `node --test`.

   Every blueprint on the market is an original (copies trade only by
   contract), so "blueprints I could buy" is every market blueprint minus the
   originals the pilot already owns. Rows carry the cheapest seller within
   reach (from the hourly index), the market average, and how far the price
   sits above or below that average, so the list can be filtered by kind,
   group, name and price. */
(function (root) {
  "use strict";

  const isNpcStation = id => id >= 60000000 && id < 64000000;

  /* originals among the assets: blueprints that are not copies */
  function ownedOriginals(assets, isBlueprint) {
    const out = new Set();
    for (const a of assets || []) if (isBlueprint(a.type_id) && !a.is_blueprint_copy) out.add(a.type_id);
    return out;
  }

  /* bps: {id: [name, productId, catId, groupId]}; index: {sell: {id: [[st, sys, price, qty]]}, avg: {id: price}};
     jumps(sys) gives jumps from the pilot or undefined when out of reach */
  function buildRows(bps, index, owned, jumps) {
    const rows = [];
    for (const [id, [name, , cat, group]] of Object.entries(bps)) {
      const tid = +id;
      if (owned.has(tid)) continue;
      const sellers = ((index && index.sell && index.sell[id]) || []).filter(r => r[3] > 0);
      let best = null, bestJ;
      for (const r of sellers) {
        const j = jumps(r[1]);
        if (j !== undefined && (!best || r[2] < best[2] || (r[2] === best[2] && j < bestJ))) { best = r; bestJ = j; }
      }
      const anywhere = sellers.reduce((m, r) => (!m || r[2] < m[2] ? r : m), null);
      const avg = (index && index.avg && index.avg[id]) || 0;
      const price = best ? best[2] : anywhere ? anywhere[2] : 0;
      rows.push({ tid, name, cat, group, best, jumps: best ? bestJ : undefined, anywhere, avg,
                  vsAvg: price && avg ? (price / avg - 1) * 100 : null });
    }
    return rows;
  }

  /* f: {cat, group, text, inReach, mode: "any" | "below" | "above", pct} */
  function filterRows(rows, f) {
    const words = String(f.text || "").toLowerCase().split(/\s+/).filter(Boolean);
    const pct = Math.max(0, +f.pct || 0);
    return rows.filter(r => {
      if (f.cat && r.cat !== +f.cat) return false;
      if (f.group && r.group !== +f.group) return false;
      if (f.inReach && !r.best) return false;
      if (words.length) { const n = r.name.toLowerCase(); if (!words.every(w => n.includes(w))) return false; }
      if (f.mode === "below") return r.vsAvg !== null && r.vsAvg <= -pct;
      if (f.mode === "above") return r.vsAvg !== null && r.vsAvg <= pct;
      return true;
    });
  }

  function sortRows(rows, by) {
    const key = {
      name: (a, b) => a.name.localeCompare(b.name),
      price: (a, b) => ((a.best || a.anywhere || [0, 0, Infinity])[2]) - ((b.best || b.anywhere || [0, 0, Infinity])[2]),
      deal: (a, b) => (a.vsAvg ?? Infinity) - (b.vsAvg ?? Infinity),
      jumps: (a, b) => (a.jumps ?? Infinity) - (b.jumps ?? Infinity),
    }[by] || ((a, b) => a.name.localeCompare(b.name));
    return rows.slice().sort((a, b) => key(a, b) || a.name.localeCompare(b.name));
  }

  /* one of each chosen blueprint from live sell orders: cheapest NPC
     station within reach, ties to the nearer one. Returns stops grouped by
     station (in the shape SellCore.orderStops takes) and what was not found. */
  function pickPurchases(tids, orders, jumps) {
    const best = new Map();
    for (const o of orders) {
      if (!isNpcStation(o.location_id) || o.volume_remain < 1 || (o.min_volume || 1) > 1) continue;
      const j = jumps(o.system_id);
      if (j === undefined || !tids.includes(o.type_id)) continue;
      const b = best.get(o.type_id);
      if (!b || o.price < b.price || (o.price === b.price && j < b.j)) best.set(o.type_id, { ...o, j });
    }
    const byStation = new Map(), missing = [];
    let total = 0;
    for (const t of tids) {
      const o = best.get(t);
      if (!o) { missing.push(t); continue; }
      let s = byStation.get(o.location_id);
      if (!s) byStation.set(o.location_id, s = { station: o.location_id, system: o.system_id, lines: [], gross: 0 });
      s.lines.push({ type_id: t, qty: 1, price: o.price });
      s.gross += o.price; total += o.price;
    }
    return { stops: [...byStation.values()], missing, total };
  }

  const api = { isNpcStation, ownedOriginals, buildRows, filterRows, sortRows, pickPurchases };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BpoCore = api;
})(typeof self !== "undefined" ? self : this);
