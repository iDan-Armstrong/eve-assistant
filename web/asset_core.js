/* Asset clean-up: the pure half (no DOM, no network), shared by the page and
   `node --test`.

   stacksFrom() turns CCP's asset list into loose stacks you could pick up:
   items in a station's (or player station's) hangar, and items inside a
   container sitting in that hangar. Fitted modules, anything inside a ship,
   assembled ships and assembled containers themselves are left out (you
   cannot put an assembled ship in a hold; a container's contents are listed
   instead).

   planPickups() picks the stops that fill the hold, one at a time from where
   the pilot is:
     sell         the stop with the most ISK per jump that still fits, taking
                  the best ISK per m3 first; stops worth under minStop skipped
     consolidate  the stop that clears the most stacks per jump, smallest
                  first, then everything is dropped at the chosen station */
(function (root) {
  "use strict";

  const isNpcStation = id => id >= 60000000 && id < 64000000;
  const isPlace = id => isNpcStation(id) || id > 1e12;
  const SHIP = 6;

  /* catOf(typeId) -> category id (6 = ship), or 0 when unknown */
  function stacksFrom(assets, catOf) {
    const byId = new Map(assets.map(a => [a.item_id, a]));
    const hasChildren = new Set(assets.map(a => a.location_id));
    const stacks = new Map();
    for (const a of assets) {
      if (a.is_singleton && (catOf(a.type_id) === SHIP || hasChildren.has(a.item_id))) continue;
      let top = a, inside = false, ok = true;
      while (byId.has(top.location_id)) {
        const parent = byId.get(top.location_id);
        if (catOf(parent.type_id) === SHIP) { ok = false; break; }
        inside = true;
        top = parent;
      }
      if (!ok || top.location_flag !== "Hangar" || !isPlace(top.location_id)) continue;
      const key = `${top.location_id}:${a.type_id}`;
      const s = stacks.get(key) || { loc: top.location_id, type_id: a.type_id, qty: 0, inContainer: false };
      s.qty += a.quantity || 1;
      s.inContainer = s.inContainer || inside;
      stacks.set(key, s);
    }
    return [...stacks.values()];
  }

  /* what a pilot is carrying now, in m3: items in the active ship's holds */
  function cargoUsed(assets, shipItemId, volOf) {
    let m3 = 0;
    for (const a of assets) {
      if (a.location_id === shipItemId && (a.location_flag === "Cargo" || /Hold$/.test(a.location_flag || ""))) {
        m3 += (volOf(a.type_id) || 0) * (a.quantity || 1);
      }
    }
    return m3;
  }

  /* fill: take stacks in order until the space runs out (partial last stack) */
  function fill(stacks, space) {
    const take = [];
    let m3 = 0, value = 0;
    for (const s of stacks) {
      const room = space - m3;
      const n = s.vol > 0 ? Math.min(s.qty, Math.floor(room / s.vol + 1e-9)) : s.qty;
      if (n <= 0) continue;
      take.push({ type_id: s.type_id, qty: n, vol: s.vol, value: s.value, of: s.qty });
      m3 += n * s.vol; value += n * s.value;
    }
    return { take, m3, value, cleared: take.filter(t => t.qty === t.of).length };
  }

  /* stacks: [{loc, sys, type_id, qty, vol (m3 each), value (ISK each)}]
     opts: { mode: "sell" | "consolidate", capacity, origin, dist(a, b),
             dest: {loc, sys} (consolidate), maxStops, minStop (sell, ISK) } */
  function planPickups(stacks, opts) {
    const { mode, capacity, origin, dist } = opts;
    const maxStops = opts.maxStops || 8;
    const pool = new Map();
    for (const s of stacks) {
      if (!(s.vol >= 0) || s.vol === undefined) continue;
      if (mode === "consolidate" && opts.dest && s.loc === opts.dest.loc) continue;
      if (mode === "sell" && !(s.value > 0)) continue;
      if (!pool.has(s.loc)) pool.set(s.loc, { loc: s.loc, sys: s.sys, stacks: [] });
      pool.get(s.loc).stacks.push({ ...s });
    }
    const order = mode === "sell"
      ? (a, b) => b.value / Math.max(b.vol, 1e-6) - a.value / Math.max(a.vol, 1e-6)
      : (a, b) => a.qty * a.vol - b.qty * b.vol || b.value - a.value;
    const stops = [];
    let here = origin, space = capacity;
    while (stops.length < maxStops && space > 0 && pool.size) {
      let best = null;
      for (const p of pool.values()) {
        const d = dist(here, p.sys);
        if (d === Infinity) continue;
        const f = fill(p.stacks.slice().sort(order), space);
        if (!f.take.length) continue;
        if (mode === "sell" && f.value < (opts.minStop || 0)) continue;
        const score = (mode === "sell" ? f.value : f.cleared + f.take.length / 100) / (d + 1);
        if (!best || score > best.score) best = { p, f, d, score };
      }
      if (!best) break;
      stops.push({ kind: "pickup", loc: best.p.loc, sys: best.p.sys, jumps: best.d, take: best.f.take, m3: best.f.m3, value: best.f.value });
      space -= best.f.m3; here = best.p.sys;
      for (const t of best.f.take) {
        const s = best.p.stacks.find(x => x.type_id === t.type_id);
        s.qty -= t.qty;
      }
      best.p.stacks = best.p.stacks.filter(s => s.qty > 0);
      if (!best.p.stacks.length) pool.delete(best.p.loc);
    }
    const carried = new Map();
    for (const s of stops) for (const t of s.take) carried.set(t.type_id, (carried.get(t.type_id) || 0) + t.qty);
    let left = 0;
    for (const p of pool.values()) left += p.stacks.length;
    if (mode === "consolidate" && opts.dest && stops.length) {
      stops.push({ kind: "drop", loc: opts.dest.loc, sys: opts.dest.sys, jumps: dist(here, opts.dest.sys),
                   take: [...carried].map(([type_id, qty]) => ({ type_id, qty })),
                   m3: capacity - space, value: stops.reduce((a, s) => a + s.value, 0) });
    }
    return { stops, carried, m3: capacity - space, value: stops.filter(s => s.kind === "pickup").reduce((a, s) => a + s.value, 0),
             stacksLeft: left, jumps: stops.reduce((a, s) => a + (s.jumps === Infinity ? 0 : s.jumps), 0) };
  }

  /* where to consolidate by default: the station holding the most stack value (or volume) */
  function suggestDest(stacks) {
    const by = new Map();
    for (const s of stacks) {
      const w = (s.value || 0) * s.qty + (s.vol || 0) * s.qty;
      by.set(s.loc, { loc: s.loc, sys: s.sys, w: ((by.get(s.loc) || {}).w || 0) + w, n: ((by.get(s.loc) || {}).n || 0) + 1 });
    }
    return [...by.values()].sort((a, b) => b.w - a.w)[0] || null;
  }

  const api = { stacksFrom, cargoUsed, planPickups, suggestDest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AssetCore = api;
})(typeof self !== "undefined" ? self : this);
