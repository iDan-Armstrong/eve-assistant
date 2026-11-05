/* Blueprint finder: the pure half (no DOM, no network), shared by the page
   and `node --test`.

   "Blueprints I could buy" is every market blueprint minus the originals the
   pilot already owns. Each one can be on offer three ways, and the finder
   takes the cheapest the pilot can actually use:
     npc       sell orders at NPC stations (hourly index; re-read live before routing)
     player    sell orders in player stations (hourly structure-market job),
               only where this pilot may dock
     contract  public contracts selling exactly that one blueprint original,
               at an NPC station or a player station the pilot may dock at
   Market blueprints are always unresearched (CCP allows only those on the
   market), so researched ones (ME/TE above 0) turn up only as contracts. */
(function (root) {
  "use strict";

  const isNpcStation = id => id >= 60000000 && id < 64000000;
  const isStructure = id => id > 1e12;

  /* originals among the assets: blueprints that are not copies */
  function ownedOriginals(assets, isBlueprint) {
    const out = new Set();
    for (const a of assets || []) if (isBlueprint(a.type_id) && !a.is_blueprint_copy) out.add(a.type_id);
    return out;
  }

  /* player stations named in the index, to ask CCP about docking access */
  function structuresIn(index) {
    const ids = new Set();
    for (const rows of Object.values((index && index.st) || {})) for (const r of rows) ids.add(r[0]);
    for (const rows of Object.values((index && index.ct) || {})) for (const r of rows) if (isStructure(r[1])) ids.add(r[1]);
    return [...ids];
  }

  /* every offer for one blueprint the pilot can use.
     access(locationId) -> true when the pilot may dock (NPC stations always);
     sysOf(locationId) -> system id when the index did not know it */
  function offersFor(id, index, access, sysOf = () => 0) {
    const out = [];
    for (const [loc, sys, price, qty] of (index.sell && index.sell[id]) || []) {
      if (qty > 0) out.push({ kind: "npc", loc, sys, price, me: 0, te: 0 });
    }
    for (const [loc, sys, price, qty] of (index.st && index.st[id]) || []) {
      if (qty > 0 && access(loc)) out.push({ kind: "player", loc, sys: sys || sysOf(loc), price, me: 0, te: 0 });
    }
    for (const [cid, loc, sys, price, me, te] of (index.ct && index.ct[id]) || []) {
      if (isNpcStation(loc) || (isStructure(loc) && access(loc))) {
        out.push({ kind: "contract", cid, loc, sys: sys || sysOf(loc), price, me, te });
      }
    }
    return out.filter(o => o.sys);
  }

  const better = (a, b) => !b || a.price < b.price || (a.price === b.price && a.j < b.j);

  /* bps: {id: [name, productId, catId, groupId]}; jumps(sys) gives jumps
     from the pilot, or undefined when out of reach */
  /* research floor: offers below minMe / minTe do not count at all */
  const researched = (o, r = {}) => o.me >= (+r.minMe || 0) && o.te >= (+r.minTe || 0);

  function buildRows(bps, index, owned, jumps, access = isNpcStation, sysOf, research = {}) {
    const rows = [];
    for (const [id, [name, , cat, group]] of Object.entries(bps)) {
      const tid = +id;
      if (owned.has(tid)) continue;
      let best = null, anywhere = null, bestResearched = null;
      for (const o of offersFor(id, index || {}, access, sysOf)) {
        if (!researched(o, research)) continue;
        const j = jumps(o.sys);
        const x = { ...o, j };
        if (j !== undefined && better(x, best)) best = x;
        if (j !== undefined && (o.me > 0 || o.te > 0) && better(x, bestResearched)) bestResearched = x;
        if (!anywhere || o.price < anywhere.price) anywhere = x;
      }
      /* the cheapest researched copy within reach, when the cheapest overall is not researched */
      const alt = best && !(best.me > 0 || best.te > 0) ? bestResearched : null;
      const avg = (index && index.avg && index.avg[id]) || 0;
      const price = best ? best.price : anywhere ? anywhere.price : 0;
      rows.push({ tid, name, cat, group, best, jumps: best ? best.j : undefined, anywhere, avg, alt,
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
    const price = r => (r.best || r.anywhere || { price: Infinity }).price;
    const key = {
      name: (a, b) => a.name.localeCompare(b.name),
      price: (a, b) => price(a) - price(b),
      me: (a, b) => ((b.best || b.anywhere || { me: -1 }).me - (a.best || a.anywhere || { me: -1 }).me)
        || ((b.best || b.anywhere || { te: -1 }).te - (a.best || a.anywhere || { te: -1 }).te),
      deal: (a, b) => (a.vsAvg ?? Infinity) - (b.vsAvg ?? Infinity),
      jumps: (a, b) => (a.jumps ?? Infinity) - (b.jumps ?? Infinity),
    }[by] || ((a, b) => a.name.localeCompare(b.name));
    return rows.slice().sort((a, b) => key(a, b) || a.name.localeCompare(b.name));
  }

  /* live NPC sell orders -> offers (one unit, NPC stations only) */
  function npcOffers(orders) {
    return orders.filter(o => isNpcStation(o.location_id) && o.volume_remain >= 1 && (o.min_volume || 1) <= 1)
      .map(o => ({ type_id: o.type_id, kind: "npc", loc: o.location_id, sys: o.system_id, price: o.price, me: 0, te: 0 }));
  }

  /* one of each chosen blueprint: the cheapest offer within reach, ties to
     the nearer. Returns stops grouped by station (the shape
     SellCore.orderStops takes), the blueprints not found, and the total. */
  function pickPurchases(tids, offers, jumps) {
    const best = new Map();
    for (const o of offers) {
      const j = jumps(o.sys);
      if (j === undefined || !tids.includes(o.type_id)) continue;
      const x = { ...o, j };
      if (better(x, best.get(o.type_id))) best.set(o.type_id, x);
    }
    const byStation = new Map(), missing = [];
    let total = 0;
    for (const t of tids) {
      const o = best.get(t);
      if (!o) { missing.push(t); continue; }
      let s = byStation.get(o.loc);
      if (!s) byStation.set(o.loc, s = { station: o.loc, system: o.sys, lines: [], gross: 0 });
      s.lines.push({ type_id: t, qty: 1, price: o.price, kind: o.kind, cid: o.cid, me: o.me, te: o.te });
      s.gross += o.price; total += o.price;
    }
    return { stops: [...byStation.values()], missing, total };
  }

  /* lab bonuses from trained skill levels, keyed by skill name:
       Metallurgy           -5% ME research time a level
       Research             -5% TE research time a level
       Advanced Industry    -3% research (and manufacturing) time a level, multiplies with the above
       Science              -5% copying time a level
       Laboratory Operation, Advanced Laboratory Operation   +1 science job a level (1 to start)
       Scientific Networking +5 jumps a level for starting jobs remotely (0: this system only)
     Science jobs in use: ME/TE research, copying and invention jobs not yet delivered. */
  const SCIENCE_ACTIVITIES = new Set([3, 4, 5, 8]);
  function labBonuses(levels, jobs = []) {
    const L = n => levels[n] || 0;
    const ai = 1 - 0.03 * L("Advanced Industry");
    const pct = x => Math.round((1 - x) * 1000) / 10;
    return {
      me: pct((1 - 0.05 * L("Metallurgy")) * ai),
      te: pct((1 - 0.05 * L("Research")) * ai),
      copy: pct(1 - 0.05 * L("Science")),
      jobs: 1 + L("Laboratory Operation") + L("Advanced Laboratory Operation"),
      inUse: jobs.filter(j => SCIENCE_ACTIVITIES.has(j.activity_id) && j.status !== "delivered" && j.status !== "cancelled").length,
      range: 5 * L("Scientific Networking"),
      levels: ["Metallurgy", "Research", "Advanced Industry", "Science", "Laboratory Operation",
               "Advanced Laboratory Operation", "Scientific Networking"].map(n => [n, L(n)]),
    };
  }

  const api = { labBonuses, researched, isNpcStation, isStructure, ownedOriginals, structuresIn, offersFor, buildRows,
                filterRows, sortRows, npcOffers, pickPurchases };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BpoCore = api;
})(typeof self !== "undefined" ? self : this);
