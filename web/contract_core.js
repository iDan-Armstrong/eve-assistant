/* Haul planner, contract modes: the pure half (no DOM, no network), shared by
   the page and `node --test`.

   Courier jobs: public courier contracts (data/live/courier.json) ranked by
   reward per jump, counting the jumps to the pickup as well as the haul.
   Contract deals: item-exchange contracts worth more at a trade hub's buy
   orders than their price (data/live/deals.json), with profit after the
   pilot's own sales tax.

   ctx: { jumpsFrom(sys) -> jumps from the pilot or undefined when out of reach,
          path(a, b) -> jumps between systems or Infinity (highsec only if asked),
          access(loc) -> true / false / null (player station not checked),
          sysOf(loc) -> system id for a location the data did not place } */
(function (root) {
  "use strict";

  const isNpcStation = id => id >= 60000000 && id < 64000000;

  function place(loc, sys, ctx) {
    const s = sys || (ctx.sysOf ? ctx.sysOf(loc) : 0);
    const a = isNpcStation(loc) ? true : ctx.access ? ctx.access(loc) : null;
    return { loc, sys: s, access: a };
  }

  /* opts: { maxVolume, maxCollateral, minReward } (blank/0 = no limit) */
  function rankCouriers(rows, ctx, opts = {}, now = Date.now()) {
    const out = [];
    for (const [cid, a, aSys, b, bSys, reward, collateral, volume, days, expires] of rows) {
      if (opts.maxVolume && volume > opts.maxVolume) continue;
      if (opts.maxCollateral && collateral > opts.maxCollateral) continue;
      if (opts.minReward && reward < opts.minReward) continue;
      if (Date.parse(expires) <= now) continue;
      const from = place(a, aSys, ctx), to = place(b, bSys, ctx);
      if (!from.sys || !to.sys || from.access === false || to.access === false) continue;
      const toPickup = ctx.jumpsFrom(from.sys);
      if (toPickup === undefined) continue;
      const haul = ctx.path(from.sys, to.sys);
      if (haul === Infinity) continue;
      out.push({ cid, from, to, reward, collateral, volume, days, expires, toPickup, haul,
                 perJump: reward / Math.max(1, toPickup + haul) });
    }
    return out.sort((x, y) => y.perJump - x.perJump || y.reward - x.reward);
  }

  /* opts: { tax, budget, maxVolume, minProfit, sort: "profit" | "perJump" | "margin" } */
  function rankDeals(rows, ctx, opts = {}, now = Date.now()) {
    const tax = opts.tax ?? 0.042, out = [];
    for (const [cid, loc, sys, price, gross, hub, volume, kinds, top, unsold, expires] of rows) {
      if (opts.budget && price > opts.budget) continue;
      if (opts.maxVolume && volume > opts.maxVolume) continue;
      if (expires && Date.parse(expires) <= now) continue;
      const at = place(loc, sys, ctx);
      if (!at.sys || at.access === false) continue;
      const profit = gross * (1 - tax) - price;
      if (profit <= (opts.minProfit || 0)) continue;
      const toPickup = ctx.jumpsFrom(at.sys);
      if (toPickup === undefined) continue;
      const hubSys = ctx.sysOf ? ctx.sysOf(hub) : 0;
      const toHub = hubSys ? ctx.path(at.sys, hubSys) : Infinity;
      if (toHub === Infinity) continue;
      out.push({ cid, at, price, gross, hub, hubSys, volume, kinds, top, unsold, expires, profit,
                 margin: profit / price, toPickup, toHub, perJump: profit / Math.max(1, toPickup + toHub) });
    }
    const key = { perJump: d => d.perJump, margin: d => d.margin }[opts.sort] || (d => d.profit);
    return out.sort((x, y) => key(y) - key(x) || y.profit - x.profit);
  }

  /* "3d 4h", "5h", "40m" until an ISO time */
  function timeLeft(iso, now = Date.now()) {
    const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
    if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
    if (m >= 60) return `${Math.floor(m / 60)}h`;
    return `${m}m`;
  }

  const api = { rankCouriers, rankDeals, timeLeft };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ContractCore = api;
})(typeof self !== "undefined" ? self : this);
