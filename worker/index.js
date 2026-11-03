/* New Eden Atlas reserve-sightings relay (Cloudflare Worker).

   POST /report   body {"token": "<EVE SSO access token>"}
     1. verifies the token's signature against CCP's published keys, its
        issuer, audience (this app's client ID) and expiry;
     2. reads that character's mining ledger from CCP ESI with it;
     3. keeps only the four Bulwark reserve ores, compares with the
        pilot's previous read, and updates the shared sightings.
     The token is used for that one ESI call and never stored. The pilot
     is stored only as a salted hash, to remember their previous read.

   GET /sightings -> {"updated", "activeMinutes", "systems": {systemId: {ore, lastActive, lastConfirmed}}}

   Bindings: SIGHTINGS (KV), CLIENT_ID and ALLOWED_ORIGINS (vars), SALT (secret). */

import { ACTIVE_MINUTES, diffLedger, mergeSightings, prune, reserveRows } from "./sightings_core.js";

const JWKS_URL = "https://login.eveonline.com/oauth/jwks";
const ESI = "https://esi.evetech.net";
const UA = "eve-assistant New Eden Atlas relay (+https://github.com/iDan-Armstrong/eve-assistant)";

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", ...headers } });

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function verify(token, env) {
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
  if (![].concat(claims.scp || []).includes("esi-industry.read_character_mining.v1")) throw new Error("mining scope missing");
  return +String(claims.sub).split(":").pop();
}

async function pilotKey(id, env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.SALT}:${id}`));
  return "pilot:" + [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function report(req, env) {
  const { token } = await req.json();
  const id = await verify(token, env);
  const resp = await fetch(`${ESI}/characters/${id}/mining`, {
    headers: { Authorization: `Bearer ${token}`, "X-Compatibility-Date": "2025-09-30", "User-Agent": UA } });
  if (!resp.ok) throw new Error(`ESI mining ledger: ${resp.status}`);
  const rows = reserveRows(await resp.json());

  const pk = await pilotKey(id, env);
  const prev = await env.SIGHTINGS.get(pk, "json");
  const { snapshot, grew } = diffLedger(prev, rows);
  await env.SIGHTINGS.put(pk, JSON.stringify(snapshot), { expirationTtl: 3 * 86400 });

  const now = new Date(), today = now.toISOString().slice(0, 10);
  if (!rows.length && !grew.length) return { reserveRows: 0, active: 0 };
  const shared = (await env.SIGHTINGS.get("sightings", "json")) || {};
  const merged = prune(mergeSightings(shared, rows, grew, now.toISOString(), today), today);
  await env.SIGHTINGS.put("sightings", JSON.stringify(merged));
  return { reserveRows: rows.length, active: grew.filter(g => g.date === today).length };
}

export default {
  async fetch(req, env) {
    const headers = cors(req, env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (req.method === "GET" && url.pathname === "/sightings") {
        const systems = (await env.SIGHTINGS.get("sightings", "json")) || {};
        return json({ updated: new Date().toISOString(), activeMinutes: ACTIVE_MINUTES, systems }, 200,
                    { ...headers, "Cache-Control": "public, max-age=60" });
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
