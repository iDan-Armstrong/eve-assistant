/* Pure functions behind the pilot overlay: no DOM, no network, so they
   run in the browser and under `node --test` alike.

   The core job is a relational rollup. ESI returns assets as a flat table
   where each row's location_id is either a place (station, structure,
   solar system) or another item (a container, a ship's cargo hold). Walking
   that parent chain up to its root place, then joining the place to its
   solar system, puts every item on the map. */
(function (root) {
  "use strict";

  const isStation = id => id >= 60000000 && id < 64000000;
  const isSystem = id => id >= 30000000 && id < 33000000;
  const ASSET_SAFETY = 2004;

  /* item_id -> root location_id (the first parent that is not an item) */
  function rootLocations(assets) {
    const parent = new Map(assets.map(a => [a.item_id, a.location_id]));
    const memo = new Map();
    const resolve = id => {
      const seen = [];
      let cur = id;
      while (parent.has(cur) && !memo.has(cur) && seen.length < 32) {
        seen.push(cur);
        cur = parent.get(cur);
      }
      const top = memo.has(cur) ? memo.get(cur) : cur;
      for (const s of seen) memo.set(s, top);
      return top;
    };
    const out = new Map();
    for (const a of assets) out.set(a.item_id, resolve(a.item_id));
    return out;
  }

  /* where a root location sits: {system, kind, name} or null if unknown.
     stationSystem: Map(stationId -> systemId); structures: Map(id -> {system, name}) */
  function placeOf(loc, stationSystem, structures) {
    if (isSystem(loc)) return { system: loc, kind: "space" };
    if (isStation(loc)) return stationSystem.has(loc) ? { system: stationSystem.get(loc), kind: "station" } : null;
    if (loc === ASSET_SAFETY) return { system: null, kind: "asset safety" };
    const s = structures.get(loc);
    return s ? { system: s.system, kind: "structure", name: s.name } : null;
  }

  /* roll assets up per system: {systemId: {items, value, places: {locId: n}, top: [[typeId, qty, value]]}} */
  function rollup(assets, roots, stationSystem, structures, prices) {
    const bySystem = new Map(), unplaced = { items: 0, value: 0, locations: new Set() };
    const typeTotals = new Map();
    for (const a of assets) {
      const loc = roots.get(a.item_id);
      const place = placeOf(loc, stationSystem, structures);
      const unit = a.is_blueprint_copy ? 0 : (prices.get(a.type_id) || 0);
      const value = unit * a.quantity;
      if (!place || place.system == null) {
        unplaced.items += a.quantity; unplaced.value += value; unplaced.locations.add(loc);
        continue;
      }
      let s = bySystem.get(place.system);
      if (!s) bySystem.set(place.system, s = { items: 0, value: 0, places: new Map() });
      s.items += a.quantity;
      s.value += value;
      s.places.set(loc, (s.places.get(loc) || 0) + a.quantity);
      const key = place.system + ":" + a.type_id;
      const t = typeTotals.get(key) || [a.type_id, 0, 0];
      t[1] += a.quantity; t[2] += value;
      typeTotals.set(key, t);
    }
    for (const [key, t] of typeTotals) {
      const s = bySystem.get(+key.split(":")[0]);
      (s.top = s.top || []).push(t);
    }
    for (const s of bySystem.values()) s.top.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
    return { bySystem, unplaced };
  }

  /* structure ids that need a name/system lookup */
  function unknownStructures(roots, stationSystem) {
    const ids = new Set();
    for (const loc of roots.values()) {
      if (!isSystem(loc) && !isStation(loc) && loc !== ASSET_SAFETY && loc > 1e12) ids.add(loc);
    }
    return [...ids];
  }

  /* mining ledger -> {systemId: {qty, types: Map(typeId -> qty), last: Map(typeId -> date)}} */
  function miningBySystem(rows) {
    const out = new Map();
    for (const r of rows || []) {
      let s = out.get(r.solar_system_id);
      if (!s) out.set(r.solar_system_id, s = { qty: 0, types: new Map() });
      s.qty += r.quantity;
      s.types.set(r.type_id, (s.types.get(r.type_id) || 0) + r.quantity);
      s.last = s.last || new Map();                     /* latest day per ore */
      if (!s.last.has(r.type_id) || r.date > s.last.get(r.type_id)) s.last.set(r.type_id, r.date);
    }
    return out;
  }

  const api = { isStation, isSystem, ASSET_SAFETY, rootLocations, placeOf, rollup,
                unknownStructures, miningBySystem };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PilotCore = api;
})(typeof self !== "undefined" ? self : this);
