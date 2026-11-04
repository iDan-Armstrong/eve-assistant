/* J-Space Survey: pure chain logic (no DOM, no network).

   Imported by the survey page, by the Cloudflare relay (worker/index.js) and by
   `node --test`, so the page and the relay apply exactly the same merge rules.

   A chain is plain JSON:
     links: {"a-b": {a, b, code, codeAt, sigA, sigB, size, life, mass, confirmed,
                     first, updated, expires, by}}
     sigs:  {systemId: {"ABC-123": {group, type, name, pct, first, seen, updated}}}
     notes: {systemId: {text, updated, by}}
     gone:  {"link:a-b" | "sig:sys:ABC-123": deletedAtMs}   tombstones, so a delete
            made on one client is not undone by another client's older copy
   Every record carries `updated` (ms). Merging keeps the newest record per key. */

export const HOUR = 3600e3;
export const SIG_TTL_H = 72;           // a signature not seen for 3 days is dropped
export const DEFAULT_LIFE_H = 24;      // unknown hole type: assume a day
export const EOL_H = 4;                // "end of its natural lifetime": under 4 hours
export const DECAY_H = 24;             // "beginning to decay": under a day
export const TOMB_H = 72;

export const isJ = id => id >= 31000000 && id < 32000000;
export const linkKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export const emptyChain = () => ({ links: {}, sigs: {}, notes: {}, gone: {} });

/* ---- size classes from max jump mass (kg) --------------------------------- */
export const SIZES = {
  S: "Frigate and destroyer",
  M: "Up to cruisers and industrials",
  L: "Up to battleships",
  XL: "Freighters and capitals",
};
export function sizeFromJump(kg) {
  if (!kg) return null;
  if (kg <= 5e6) return "S";
  if (kg <= 62e6) return "M";
  if (kg <= 375e6) return "L";
  return "XL";
}

/* ---- probe scanner paste ---------------------------------------------------
   In the probe scanner window: select all, copy. Each row is tab separated:
     ID  Group  Type  Name  Signal  Distance
   Unscanned rows leave Type and Name blank. */
const SIG_ID = /^[A-Z]{3}-\d{3}$/;
const PCT = /^\d+([.,]\d+)?\s?%$/;
export function parseSigs(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const all = raw.split("\t").map(c => c.trim());
    /* the ID is normally first; if the window's columns were rearranged, start at it */
    const at = all.findIndex(c => SIG_ID.test(c));
    if (at < 0) continue;
    const cols = all.slice(at).concat(all.slice(0, at));
    const pctCol = cols.findIndex((c, i) => i > 0 && PCT.test(c));
    const pct = pctCol > 0 ? parseFloat(cols[pctCol].replace(",", ".").replace("%", "")) : 0;
    const text3 = cols.slice(1, pctCol > 0 ? pctCol : 4);
    out.push({ id: cols[0], group: text3[0] || "", type: text3[1] || "", name: text3[2] || "",
               pct: Number.isFinite(pct) ? pct : 0 });
  }
  return out;
}

/* fold a paste into one system's signature table.
   replace=true (the normal case, a full scanner copy) marks every old signature
   missing from the paste as gone. Returns {sigs, removed} */
export function mergeSigs(existing, parsed, now, replace = true) {
  const sigs = { ...(existing || {}) };
  const seenIds = new Set();
  for (const p of parsed) {
    seenIds.add(p.id);
    const old = sigs[p.id];
    const better = (a, b) => (b && b.length ? b : a);
    sigs[p.id] = {
      ...(old || {}),                 /* keeps what a pilot added, like a hole's type code */
      group: better(old?.group || "", p.group),
      type: better(old?.type || "", p.type),
      name: better(old?.name || "", p.name),
      pct: Math.max(old?.pct || 0, p.pct || 0),
      first: old?.first || now,
      seen: now,
      updated: now,
    };
  }
  const removed = replace ? Object.keys(sigs).filter(id => !seenIds.has(id)) : [];
  for (const id of removed) delete sigs[id];
  return { sigs, removed };
}

/* ---- wormhole Show Info paste ----------------------------------------------
   Matched on key phrases, so small wording changes still read. */
export function parseShowInfo(text) {
  const t = String(text || "").toLowerCase();
  const r = {};
  if (/end of its natural lifetime/.test(t)) r.life = "eol";
  else if (/beginning to decay|probably won't last|probably will not last/.test(t)) r.life = "decay";
  else if (/not yet begun its natural cycle of decay/.test(t)) r.life = "fresh";

  if (/critically/.test(t)) r.mass = "crit";
  else if (/stability reduced|reduced by ships|not to a critical degree/.test(t)) r.mass = "destab";
  else if (/not yet had its stability significantly disrupted/.test(t)) r.mass = "stable";

  if (/very large ships|capital|freighter/.test(t)) r.size = "XL";
  else if (/larger ships|battleship/.test(t)) r.size = "L";
  else if (/medium|cruiser/.test(t)) r.size = "M";
  else if (/smallest|very small|frigate/.test(t)) r.size = "S";

  if (/high security/.test(t)) r.dest = "HS";
  else if (/low security/.test(t)) r.dest = "LS";
  else if (/null security/.test(t)) r.dest = "NS";
  else if (/deadly unknown/.test(t)) r.dest = "C6";
  else if (/dangerous unknown/.test(t)) r.dest = "C4-C5";
  else if (/unknown parts/.test(t)) r.dest = "C1-C3";
  return r;
}

/* ---- what kind of move was this? -------------------------------------------
   gates: {systemId: [neighbor ids]} for k-space.
   Returns "none" | "gate" | "wormhole" | "unsure" | "pod".
   unsure = two k-space systems with no gate between them. That is a wormhole,
   but also a cyno jump, a jump clone, a filament or a respawn, so the pilot
   confirms it. */
export function classifyMove(from, to, gates, opts = {}) {
  if (!from || !to || from === to) return "none";
  if (opts.becameCapsule) return "pod";
  const n = gates[String(from)];
  if (n && n.includes(to)) return "gate";
  if (isJ(from) || isJ(to)) return opts.dockedOnArrival && !isJ(to) ? "unsure" : "wormhole";
  return "unsure";
}

/* ---- expiry -------------------------------------------------------------- */
export function expiresAt(link, wormholes) {
  const life = (link.code && wormholes?.[link.code]?.life) || DEFAULT_LIFE_H;
  let end = link.first + life * HOUR;
  if (link.life === "eol" && link.lifeAt) end = Math.min(end, link.lifeAt + EOL_H * HOUR);
  if (link.life === "decay" && link.lifeAt) end = Math.min(end, link.lifeAt + DECAY_H * HOUR);
  return end;
}

/* ---- operations ----------------------------------------------------------
   op = {kind: "link"|"sig"|"sigs"|"note"|"del", ...}. Each carries `at` (ms). */
export function newLink(a, b, at, by, extra = {}) {
  const key = linkKey(a, b);
  return { kind: "link", key, rec: { a: Math.min(a, b), b: Math.max(a, b), code: null, codeAt: null,
    sigA: null, sigB: null, size: null, life: null, lifeAt: null, mass: null,
    confirmed: true, first: at, updated: at, by: by || "", ...extra } };
}

export function applyOp(chain, op, wormholes) {
  const c = chain;
  const at = op.at ?? op.rec?.updated ?? Date.now();
  if (op.kind === "link") {
    const key = op.key || linkKey(op.rec.a, op.rec.b);
    if (c.gone[`link:${key}`] !== undefined && c.gone[`link:${key}`] >= at) return c;
    const old = c.links[key];
    if (old && (old.updated || 0) > at) return c;
    const rec = { ...(old || {}), ...op.rec, first: old?.first ?? op.rec.first ?? at, updated: at };
    rec.expires = expiresAt(rec, wormholes);
    c.links[key] = rec;
    delete c.gone[`link:${key}`];
  } else if (op.kind === "sigs") {
    /* a whole-system paste: replace that system's table */
    const sys = String(op.system);
    const cur = c.sigs[sys] || {};
    const { sigs, removed } = mergeSigs(cur, op.parsed || [], at, op.replace !== false);
    for (const id of removed) c.gone[`sig:${sys}:${id}`] = at;
    for (const id of Object.keys(sigs)) delete c.gone[`sig:${sys}:${id}`];
    c.sigs[sys] = sigs;
  } else if (op.kind === "sig") {
    const sys = String(op.system);
    if (c.gone[`sig:${sys}:${op.id}`] !== undefined && c.gone[`sig:${sys}:${op.id}`] >= at) return c;
    const table = c.sigs[sys] = { ...(c.sigs[sys] || {}) };
    const old = table[op.id];
    if (old && (old.updated || 0) > at) return c;
    table[op.id] = { ...(old || { first: at }), ...op.rec, seen: at, updated: at };
  } else if (op.kind === "note") {
    const sys = String(op.system);
    const old = c.notes[sys];
    if (old && (old.updated || 0) > at) return c;
    c.notes[sys] = { text: String(op.text || "").slice(0, 2000), updated: at, by: op.by || "" };
  } else if (op.kind === "del") {
    if (op.what === "link") {
      delete c.links[op.key];
      c.gone[`link:${op.key}`] = at;
    } else if (op.what === "sig") {
      const sys = String(op.system);
      if (c.sigs[sys]) delete c.sigs[sys][op.id];
      c.gone[`sig:${sys}:${op.id}`] = at;
    }
  }
  return c;
}

/* merge two whole chains record by record (newest wins, tombstones respected) */
export function mergeChains(a, b) {
  const out = emptyChain();
  out.gone = { ...a.gone };
  for (const [k, t] of Object.entries(b.gone || {})) out.gone[k] = Math.max(out.gone[k] || 0, t);
  const newer = (x, y) => (!x ? y : !y ? x : (y.updated || 0) > (x.updated || 0) ? y : x);
  for (const key of new Set([...Object.keys(a.links || {}), ...Object.keys(b.links || {})])) {
    const rec = newer(a.links?.[key], b.links?.[key]);
    if ((out.gone[`link:${key}`] || 0) < (rec.updated || 0)) out.links[key] = rec;
  }
  for (const sys of new Set([...Object.keys(a.sigs || {}), ...Object.keys(b.sigs || {})])) {
    const ta = a.sigs?.[sys] || {}, tb = b.sigs?.[sys] || {};
    const table = {};
    for (const id of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
      const rec = newer(ta[id], tb[id]);
      if ((out.gone[`sig:${sys}:${id}`] || 0) < (rec.updated || 0)) table[id] = rec;
    }
    if (Object.keys(table).length) out.sigs[sys] = table;
  }
  for (const sys of new Set([...Object.keys(a.notes || {}), ...Object.keys(b.notes || {})])) {
    out.notes[sys] = newer(a.notes?.[sys], b.notes?.[sys]);
  }
  return out;
}

/* drop expired links, stale signatures and old tombstones */
export function prune(chain, now) {
  const c = chain;
  for (const [k, l] of Object.entries(c.links)) if ((l.expires || 0) <= now) delete c.links[k];
  for (const [sys, table] of Object.entries(c.sigs)) {
    for (const [id, s] of Object.entries(table)) if (now - (s.seen || 0) > SIG_TTL_H * HOUR) delete table[id];
    if (!Object.keys(table).length) delete c.sigs[sys];
  }
  for (const [k, t] of Object.entries(c.gone)) if (now - t > TOMB_H * HOUR) delete c.gone[k];
  return c;
}

/* ---- chain tree layout ----------------------------------------------------
   Breadth-first from root over the links. Returns nodes with depth (column)
   and row, and the edges of the tree; links back into the tree become "cross"
   edges, drawn but not used for layout. */
export function layoutTree(chain, root) {
  const adj = new Map();
  for (const [key, l] of Object.entries(chain.links)) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push({ to: y, key });
    }
  }
  const depth = new Map([[root, 0]]), parent = new Map(), kids = new Map([[root, []]]);
  const order = [root], cross = [];
  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    const next = (adj.get(cur) || []).slice().sort((p, q) => p.to - q.to);
    for (const { to, key } of next) {
      if (!depth.has(to)) {
        depth.set(to, depth.get(cur) + 1);
        parent.set(to, { from: cur, key });
        kids.get(cur).push(to);
        kids.set(to, []);
        order.push(to);
      } else if (parent.get(cur)?.from !== to && cur < to) {
        cross.push({ from: cur, to, key });
      }
    }
  }
  /* rows: leaves get consecutive rows, a parent sits at its first child's row */
  const row = new Map();
  let next = 0;
  const place = id => {
    const k = kids.get(id) || [];
    if (!k.length) { row.set(id, next++); return; }
    k.forEach(place);
    row.set(id, row.get(k[0]));
  };
  place(root);
  const nodes = order.map(id => ({ id, depth: depth.get(id), row: row.get(id) }));
  const edges = order.slice(1).map(id => ({ from: parent.get(id).from, to: id, key: parent.get(id).key }));
  return { nodes, edges, cross, rows: next };
}

/* systems in the chain that are in known space, for the Atlas overlay */
export function kspaceExits(chain) {
  const out = new Map();
  for (const l of Object.values(chain.links)) {
    for (const s of [l.a, l.b]) if (!isJ(s)) out.set(s, (out.get(s) || 0) + 1);
  }
  return out;
}
