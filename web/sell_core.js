/* Sell my cargo: the planning half, with no DOM and no network, so it runs
   in the browser and under `node --test` alike.

   Input is what is in the hold (type id and quantity) and every buy order
   for those types at stations the pilot may visit. The plan sells each unit
   into the best-paying buy order it can reach (highest price first, honoring
   each order's remaining volume and minimum volume), then drops stations
   that are not worth the detour: a stop is kept only if removing it would
   cost more than `minStop` ISK after tax, and at most `maxStops` stops are
   kept. Units removed from a dropped stop move to the next best buyer among
   the stops that are left. Stations that cost no detour are always kept.
   Whatever no buyer takes is left over, to carry
   to the drop-off station at the end of the trip.

   Orders are always sold at the order's own station, even when the order's
   range would allow selling from nearby: that keeps every stop a simple
   "dock and sell" in game. */
(function (root) {
  "use strict";

  const JITA = { station: 60003760, system: 30000142 };

  /* in-game inventory copy (list or icon view, Ctrl+A then Ctrl+C):
     name, then quantity in the next column (blank for a single item).
     Returns { items: Map(typeId -> qty), unknown: [names] }. */
  function parseCargoPaste(text, idOfName) {
    const items = new Map(), unknown = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const cols = raw.split("\t").map(c => c.trim());
      const name = cols[0];
      if (!name) continue;
      const tid = idOfName(name);
      if (!tid) { unknown.push(name); continue; }
      const digits = (cols[1] || "").replace(/[^\d]/g, "");
      const qty = /^[\d\s., ']+$/.test(cols[1] || "") && digits ? +digits : 1;
      items.set(tid, (items.get(tid) || 0) + qty);
    }
    return { items, unknown };
  }

  /* ESI assets -> what is in the ship's holds (not fitted, not the ship).
     Items inside a container in the hold are counted too. */
  const HOLD_FLAG = f => f === "Cargo" || /Hold$/.test(f || "") || f === "FleetHangar";
  function cargoFromAssets(assets, shipItemId) {
    const items = new Map(), inHold = new Set();
    for (const a of assets || []) {
      if (a.location_id === shipItemId && HOLD_FLAG(a.location_flag)) inHold.add(a.item_id);
    }
    for (const a of assets || []) {
      const direct = inHold.has(a.item_id);
      const nested = inHold.has(a.location_id);
      if (direct || nested) items.set(a.type_id, (items.get(a.type_id) || 0) + (a.quantity || 1));
    }
    return items;
  }

  /* orders sorted best price first, once; allocate() reuses that order */
  function sortOrders(orders) {
    return orders.slice().sort((a, b) => b.price - a.price || a.location_id - b.location_id);
  }

  /* sell every unit into the best order at an allowed station */
  function allocate(items, sorted, allowed) {
    const left = new Map(items), byStation = new Map();
    let gross = 0;
    for (const o of sorted) {
      if (allowed && !allowed.has(o.location_id)) continue;
      const want = left.get(o.type_id);
      if (!want) continue;
      const take = Math.min(want, o.volume_remain);
      if (take <= 0 || take < (o.min_volume || 1)) continue;
      left.set(o.type_id, want - take);
      let s = byStation.get(o.location_id);
      if (!s) byStation.set(o.location_id, s = { station: o.location_id, system: o.system_id, lines: [], gross: 0 });
      const line = s.lines.find(l => l.type_id === o.type_id && l.price === o.price);
      if (line) line.qty += take;
      else s.lines.push({ type_id: o.type_id, qty: take, price: o.price });
      s.gross += take * o.price;
      gross += take * o.price;
    }
    for (const [t, q] of left) if (!q) left.delete(t);
    return { byStation, left, gross };
  }

  /* free: stations that cost no detour (the drop-off station the trip ends
     at anyway, stations in the system you are in); never dropped for being
     small, and not counted against maxStops */
  function planSale({ items, orders, tax = 0, minStop = 0, maxStops = 8, free = new Set() }) {
    const sorted = sortOrders(orders);
    const allowed = new Set(sorted.map(o => o.location_id));
    let plan = allocate(items, sorted, allowed);
    for (;;) {
      const used = [...plan.byStation.keys()].filter(st => !free.has(st));
      if (!used.length) break;
      let worst = null, worstLoss = Infinity;
      for (const st of used) {
        allowed.delete(st);
        const loss = (plan.gross - allocate(items, sorted, allowed).gross) * (1 - tax);
        allowed.add(st);
        if (loss < worstLoss) { worstLoss = loss; worst = st; }
      }
      if (worstLoss >= minStop && used.length <= maxStops) break;
      allowed.delete(worst);
      plan = allocate(items, sorted, allowed);
    }
    for (const s of plan.byStation.values()) {
      s.lines.sort((a, b) => b.qty * b.price - a.qty * a.price);
      s.net = s.gross * (1 - tax);
    }
    return { stops: [...plan.byStation.values()], left: plan.left,
             gross: plan.gross, tax: plan.gross * tax, net: plan.gross * (1 - tax) };
  }

  /* visiting order: nearest next stop first; then the drop-off station (if
     any) goes wherever it adds the fewest jumps, since leaving the unsold
     items there can happen at any point of the trip (first, if you are
     already there). dist(fromSystem, toSystem) gives jumps or Infinity. */
  function orderStops(stops, originSystem, dist, last = null) {
    const rest = stops.filter(s => !last || s.station !== last.station);
    const lastStop = last ? (stops.find(s => s.station === last.station) || { ...last, lines: [], gross: 0, net: 0 }) : null;
    const out = [];
    let here = originSystem;
    while (rest.length) {
      let bi = 0, bd = Infinity;
      rest.forEach((s, i) => { const d = dist(here, s.system); if (d < bd) { bd = d; bi = i; } });
      const s = rest.splice(bi, 1)[0];
      here = s.system;
      out.push(s);
    }
    if (lastStop) {
      const sysAt = k => (k < 0 ? originSystem : out[k].system);
      let best = out.length, extra = dist(sysAt(out.length - 1), lastStop.system);
      for (let k = 0; k < out.length; k++) {
        const add = dist(sysAt(k - 1), lastStop.system) + dist(lastStop.system, out[k].system) - dist(sysAt(k - 1), out[k].system);
        if (add < extra) { extra = add; best = k; }
      }
      out.splice(best, 0, lastStop);
    }
    let jumps = 0;
    out.forEach((s, k) => { s.jumps = dist(k ? out[k - 1].system : originSystem, s.system); jumps += s.jumps; });
    return { stops: out, jumps };
  }

  const api = { JITA, parseCargoPaste, cargoFromAssets, sortOrders, allocate, planSale, orderStops };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SellCore = api;
})(typeof self !== "undefined" ? self : this);
