/* New Eden Atlas reserve-sightings relay (Cloudflare Worker).

   POST /report   body {"token": "<EVE SSO access token>"}
     1. verifies the token's signature against CCP's published keys, its
        issuer, audience (this app's client ID) and expiry;
     2. reads that character's mining ledger from CCP ESI with it;
     3. keeps only the four Bulwark reserve ores, compares with the
        pilot's previous read, and updates the sightings of the pilot's
        corporation (looked up from CCP's public character record).
     The token is used for those ESI calls and never stored. The pilot
     is stored only as a salted hash, to remember their previous read.

   POST /sightings  body {"token": ...}
     -> {"updated", "activeMinutes", "corporation", "systems": {systemId: {ore, lastActive, lastConfirmed}}}
     Sightings are kept per corporation and returned only to a verified
     member of that corporation: a reserve being mined is exactly what a
     ganker would want to know, so nobody outside the corp can read them.

   POST /presence   body {"token": ..., "share": true|false}
     A pilot who opts in shares their system, ship and online status with
     their corporation (written only on change or every 15 minutes);
     share=false removes them at once.
   POST /corpmates  body {"token": ...} -> {"corporation", "pilots": {id: {name, system, ship, online, at}}}
     Corp mates seen in the last 30 minutes, for a verified member only.

   POST /chain      body {"token": ...} -> {"corporation", "chain"}
   POST /chain/ops  body {"token": ..., "ops": [...]} -> {"corporation", "chain"}
     The J-Space Survey wormhole chain, shared inside one corporation and
     returned only to a verified member. Ops and merge rules come from
     web/survey/chain_core.mjs, the same module the survey page runs.

   Bindings: SIGHTINGS (KV), CLIENT_ID and ALLOWED_ORIGINS (vars). The
   salt for pilot hashes is made on first use and kept in KV, which is
   private to the Worker; a SALT secret, if set, takes its place. */

import { ACTIVE_MINUTES, diffLedger, freshPresence, mergeSightings, prune,
         reserveRows } from "./sightings_core.js";
import { applyOp, emptyChain, prune as pruneChain } from "../web/survey/chain_core.mjs";
import WORMHOLES from "../web/data/jspace/wormholes.json";

const MAX_OPS = 200;
const MAX_LINKS = 3000;

const JWKS_URL = "https://login.eveonline.com/oauth/jwks";
const ESI = "https://esi.evetech.net";
const UA = "eve-assistant New Eden Atlas relay (+https://github.com/iDan-Armstrong/eve-assistant)";

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", ...headers } });

/* JWT segments are unpadded base64url; atob needs standard, padded base64 */
const b64urlBytes = s => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - b.length % 4) % 4)), c => c.charCodeAt(0));
};
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function verify(token, env, needMining = false) {
  const [h, p, sig] = String(token).split(".");
  if (!sig) throw new Error("malformed token");
  const header = b64urlJson(h), claims = b64urlJson(p);
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwks = await fetch(JWKS_URL, { cf: { cacheTtl: 3600 } }).then(r => r.json());
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.alg === "RS256");
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig),
                                        new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  if (!["login.eveonline.com", "https://login.eveonline.com"].includes(claims.iss)) throw new Error("bad issuer");
  if (![].concat(claims.aud).includes(env.CLIENT_ID)) throw new Error("token is for another app");
  if (claims.exp * 1000 < Date.now()) throw new Error("token expired");
  if (needMining && ![].concat(claims.scp || []).includes("esi-industry.read_character_mining.v1")) throw new Error("mining scope missing");
  return { id: +String(claims.sub).split(":").pop(), name: claims.name, scp: [].concat(claims.scp || []) };
}

async function salt(env) {
  if (env.SALT) return env.SALT;
  let s = await env.SIGHTINGS.get("salt");
  if (!s) {
    s = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.SIGHTINGS.put("salt", s);
  }
  return s;
}

async function pilotKey(id, env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${await salt(env)}:${id}`));
  return "pilot:" + [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* the character's current corporation, from CCP's public record */
async function corporationOf(id) {
  const r = await fetch(`${ESI}/characters/${id}`, {
    headers: { "X-Compatibility-Date": "2025-09-30", "User-Agent": UA }, cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error(`ESI character: ${r.status}`);
  return (await r.json()).corporation_id;
}

async function report(req, env) {
  const { token } = await req.json();
  const { id } = await verify(token, env, true);
  const corp = await corporationOf(id);
  const resp = await fetch(`${ESI}/characters/${id}/mining`, {
    headers: { Authorization: `Bearer ${token}`, "X-Compatibility-Date": "2025-09-30", "User-Agent": UA } });
  if (!resp.ok) throw new Error(`ESI mining ledger: ${resp.status}`);
  const rows = reserveRows(await resp.json());

  const pk = await pilotKey(id, env);
  const prev = await env.SIGHTINGS.get(pk, "json");
  const { snapshot, grew } = diffLedger(prev, rows);
  if (prev === null || JSON.stringify(prev) !== JSON.stringify(snapshot)) {    /* writes are scarce */
    await env.SIGHTINGS.put(pk, JSON.stringify(snapshot), { expirationTtl: 3 * 86400 });
  }

  const now = new Date(), today = now.toISOString().slice(0, 10);
  if (!rows.length && !grew.length) return { reserveRows: 0, active: 0 };
  const key = `sightings:${corp}`;
  const shared = (await env.SIGHTINGS.get(key, "json")) || {};
  const merged = prune(mergeSightings(shared, rows, grew, now.toISOString(), today), today);
  if (JSON.stringify(merged) !== JSON.stringify(shared)) await env.SIGHTINGS.put(key, JSON.stringify(merged));
  return { reserveRows: rows.length, active: grew.filter(g => g.date === today).length };
}

async function esiAuthed(path, token) {
  const r = await fetch(`${ESI}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Compatibility-Date": "2025-09-30", "User-Agent": UA } });
  if (!r.ok) throw new Error(`ESI ${path}: ${r.status}`);
  return r.json();
}

/* Corp-mate positions live in a Durable Object, one per corporation: a
   single always-current copy (no KV edge-cache lag) with far more writes
   allowed than KV, so pilots can report every 30 seconds. */
export class CorpRoom {
  constructor(state) { this.state = state; }

  /* the survey chain is stored in parts: links, notes and tombstones as one
     record each, signatures as one record per system */
  async loadChain() {
    const st = this.state.storage;
    const c = emptyChain();
    c.links = (await st.get("chain:links")) || {};
    c.notes = (await st.get("chain:notes")) || {};
    c.gone = (await st.get("chain:gone")) || {};
    for (const [k, v] of await st.list({ prefix: "chain:sigs:" })) c.sigs[k.slice(11)] = v;
    return c;
  }
  async saveChain(c, touched) {
    const st = this.state.storage;
    await st.put({ "chain:links": c.links, "chain:notes": c.notes, "chain:gone": c.gone });
    for (const sys of touched) {
      if (c.sigs[sys] && Object.keys(c.sigs[sys]).length) await st.put(`chain:sigs:${sys}`, c.sigs[sys]);
      else await st.delete(`chain:sigs:${sys}`);
    }
  }

  async fetch(req) {
    const url = new URL(req.url), now = Date.now();
    if (url.pathname === "/chain-get" || url.pathname === "/chain-ops") {
      const c = await this.loadChain();
      const before = new Set(Object.keys(c.sigs));
      if (url.pathname === "/chain-ops") {
        const { ops } = await req.json();
        const touched = new Set();
        for (const op of (ops || []).slice(0, MAX_OPS)) {
          if (op.system !== undefined) touched.add(String(op.system));
          applyOp(c, op, WORMHOLES);
        }
        pruneChain(c, now);
        if (Object.keys(c.links).length > MAX_LINKS) throw new Error("chain is too large");
        for (const sys of before) if (!c.sigs[sys]) touched.add(sys);
        await this.saveChain(c, touched);
      }
      return new Response(JSON.stringify(c), { headers: { "Content-Type": "application/json" } });
    }
    let map = (await this.state.storage.get("pilots")) || {};
    if (url.pathname === "/set") {
      const { id, rec } = await req.json();
      if (rec) map[id] = rec; else delete map[id];
      map = freshPresence(map, now);
      await this.state.storage.put("pilots", map);
      return new Response("ok");
    }
    return new Response(JSON.stringify(freshPresence(map, now)), { headers: { "Content-Type": "application/json" } });
  }
}
const room = (env, corp) => env.CORP.get(env.CORP.idFromName(String(corp)));

async function presence(req, env) {
  const { token, share } = await req.json();
  const who = await verify(token, env);
  const corp = await corporationOf(who.id);
  if (!share) {
    await room(env, corp).fetch("https://room/set", { method: "POST", body: JSON.stringify({ id: who.id, rec: null }) });
    return { shared: false };
  }
  for (const s of ["esi-location.read_location.v1", "esi-location.read_ship_type.v1", "esi-location.read_online.v1"]) {
    if (!who.scp.includes(s)) throw new Error(`scope missing: ${s}`);
  }
  const [loc, ship, online] = await Promise.all([
    esiAuthed(`/characters/${who.id}/location`, token), esiAuthed(`/characters/${who.id}/ship`, token),
    esiAuthed(`/characters/${who.id}/online`, token)]);
  const rec = { name: who.name, system: loc.solar_system_id, ship: ship.ship_type_id,
                online: !!online.online, at: new Date().toISOString() };
  await room(env, corp).fetch("https://room/set", { method: "POST", body: JSON.stringify({ id: who.id, rec }) });
  return { shared: true };
}

export default {
  async fetch(req, env) {
    const headers = cors(req, env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (req.method === "POST" && url.pathname === "/sightings") {
        const { token } = await req.json();
        const corp = await corporationOf((await verify(token, env)).id);
        const systems = (await env.SIGHTINGS.get(`sightings:${corp}`, "json")) || {};
        return json({ updated: new Date().toISOString(), activeMinutes: ACTIVE_MINUTES,
                      corporation: corp, systems }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && url.pathname === "/presence") {
        return json(await presence(req, env), 200, headers);
      }
      if (req.method === "POST" && url.pathname === "/corpmates") {
        const { token } = await req.json();
        const corp = await corporationOf((await verify(token, env)).id);
        const pilots = await room(env, corp).fetch("https://room/get").then(r => r.json());
        return json({ corporation: corp, pilots }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && (url.pathname === "/chain" || url.pathname === "/chain/ops")) {
        const body = await req.json();
        const who = await verify(body.token, env);
        const corp = await corporationOf(who.id);
        const ops = (body.ops || []).map(op => ({ ...op, by: who.name,
          rec: op.rec ? { ...op.rec, by: who.name } : op.rec }));
        const path = url.pathname === "/chain" ? "/chain-get" : "/chain-ops";
        const r = await room(env, corp).fetch(`https://room${path}`,
          { method: "POST", body: JSON.stringify({ ops }) });
        if (!r.ok) throw new Error(await r.text());
        return json({ corporation: corp, chain: await r.json() }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && url.pathname === "/report") {
        return json(await report(req, env), 200, headers);
      }
      return json({ error: "not found" }, 404, headers);
    } catch (e) {
      return json({ error: e.message }, 400, headers);
    }
  },
};
