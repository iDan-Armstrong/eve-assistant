/* Pure logic for the reserve-sightings relay (no network, no storage), so
   it runs in the Cloudflare Worker and under `node --test` alike.

   A pilot's mining ledger has one row per day, system and ore, and the
   quantity grows as they mine. Comparing two reads of the same day's row
   tells whether someone mined there in between: that is "active". Any row
   at all says the reserve existed on that day: that is "confirmed". */

export const RESERVE_ORES = {
  92566: "Polycrase X-Grade",     // Caldari State
  92567: "Moissanite X-Grade",    // Gallente Federation
  92565: "Raspite X-Grade",       // Amarr Empire
  92568: "Kangite X-Grade",       // Minmatar Republic
};
export const ACTIVE_MINUTES = 60;

/* reserve-ore rows only: [{system, ore, date, qty}] */
export function reserveRows(ledger) {
  return (ledger || [])
    .filter(r => RESERVE_ORES[r.type_id])
    .map(r => ({ system: r.solar_system_id, ore: r.type_id, date: r.date, qty: r.quantity }));
}

/* compare this read with the pilot's previous one.
   prev: {"system:ore:date": qty}. Returns {snapshot, grew: [{system, ore}]} */
export function diffLedger(prev, rows) {
  const snapshot = {}, grew = [];
  for (const r of rows) {
    const key = `${r.system}:${r.ore}:${r.date}`;
    snapshot[key] = r.qty;
    const before = prev ? prev[key] : undefined;
    /* growth since the last read, or a new row for today once we have a
       baseline for this pilot (a first-ever read only sets the baseline) */
    if (prev && (before === undefined ? true : r.qty > before)) grew.push({ system: r.system, ore: r.ore, date: r.date });
  }
  return { snapshot, grew };
}

/* merge into the shared map: {systemId: {ore, lastActive, lastConfirmed}} */
export function mergeSightings(shared, rows, grew, nowIso, today) {
  const out = { ...shared };
  for (const r of rows) {
    const s = out[r.system] = { ...(out[r.system] || {}), ore: r.ore };
    if (!s.lastConfirmed || r.date > s.lastConfirmed) s.lastConfirmed = r.date;
  }
  for (const g of grew) {
    if (g.date !== today) continue;              /* only today's growth means "now" */
    out[g.system] = { ...(out[g.system] || {}), ore: g.ore, lastActive: nowIso };
  }
  return out;
}

/* drop sightings older than `days` so the map forgets ended campaigns */
export function prune(shared, today, days = 30) {
  const cutoff = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(shared).filter(([, s]) => (s.lastConfirmed || "") >= cutoff));
}

/* ---- corp-mate presence ----------------------------------------------------
   presence: {characterId: {name, system, ship, online, at}} per corporation.
   KV allows few writes a day on the free plan, so a pilot's record is
   written only when it changes or every HEARTBEAT_MINUTES, and readers
   drop records older than STALE_MINUTES. */
export const HEARTBEAT_MINUTES = 15;
export const STALE_MINUTES = 30;

export function presenceChanged(old, rec, nowMs) {
  if (!old) return true;
  if (old.system !== rec.system || old.ship !== rec.ship || old.online !== rec.online) return true;
  return nowMs - Date.parse(old.at) >= HEARTBEAT_MINUTES * 60e3;
}

export function freshPresence(map, nowMs) {
  return Object.fromEntries(Object.entries(map || {})
    .filter(([, r]) => nowMs - Date.parse(r.at) < STALE_MINUTES * 60e3));
}
