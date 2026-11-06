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

   POST /chain      body {"token": ...} -> {"corporation", "chain", "board", "me"}
   POST /chain/ops  body {"token": ..., "ops": [...]} -> the same, plus "awards" and "kb"
     The J-Space Survey wormhole chain, shared inside one corporation and
     returned only to a verified member. Ops and merge rules come from
     web/survey/chain_core.mjs, the same module the survey page runs.
     Knowledge-base ops (visit, static, dscan) keep what stays true about a
     system; points for every op go to the verified pilot only
     (web/survey/survey_core.mjs).
   POST /kb         body {"token": ..., "systems": [ids]} -> {"kb": {id: record}}

   Organizations (Atlas orgs, independent of in-game corporations):
   POST /org        body {"token": ..., "action": ..., ...}
     list | mine | create {name, adminPassword, memberPassword}
     | join {org, password} | leave {org}
     | admin {org, adminPassword, op: view|approve|boot|promote|demote|master|passwords|rename|jspace, target, newAdmin, newMember, name, value}
     | operator {org, op, target, newAdmin, newMember}   (the Atlas operator only)
     The Atlas operator holds Master Admin standing in every org: all orgs
     in "mine", any org's data, every admin and Master Admin control,
     without the org's passwords. Not stored as a member, so an org's own
     Master Admin and the 30-day rules are unaffected.
     Rules in worker/org_core.js. Passwords are kept only as salted PBKDF2
     hashes; five wrong tries an hour per pilot per org.
   Every sharing endpoint above also takes "org": <id>. The relay checks the
   verified pilot is an approved member, then uses that org's room instead
   of the corporation's, so a pilot shares with their corp or one of their
   orgs, never both at once.

   Bindings: SIGHTINGS (KV), CORP and ORGS (Durable Objects), CLIENT_ID,
   ALLOWED_ORIGINS and OPERATORS (vars: operator character names). The
   salt for pilot hashes is made on first use and kept in KV, which is
   private to the Worker; a SALT secret, if set, takes its place. */

import { ACTIVE_MINUTES, diffLedger, freshPresence, mergeSightings, prune,
         reserveRows } from "./sightings_core.js";
import { applyOp, emptyChain, prune as pruneChain } from "../web/survey/chain_core.mjs";
import { applyKbOp, award, chainEvents, leaderboard } from "../web/survey/survey_core.mjs";
import * as Org from "./org_core.js";
import WORMHOLES from "../web/data/jspace/wormholes.json";
import JSYSTEMS from "../web/data/jspace/systems.json";
import CLASSES from "../web/data/jspace/classes.json";

const KB_KINDS = new Set(["visit", "static", "dscan", "probe", "claim"]);
const classOf = id => { const j = JSYSTEMS[id]; return j ? CLASSES[j[1]] || null : null; };
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
  const { token, org } = await req.json();
  const who = await verify(token, env, true);
  const { id } = who;
  const corp = (await spaceOf(who, org, env)).key;
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
    const st = this.state.storage;
    if (url.pathname === "/kb-get") {
      const { systems } = await req.json();
      const out = {};
      for (const sys of (systems || []).slice(0, 100)) {
        const rec = await st.get(`kb:${sys}`);
        if (rec) out[sys] = rec;
      }
      return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/chain-get" || url.pathname === "/chain-ops") {
      const body = await req.json();
      const pilot = body.pilot || {};
      const c = await this.loadChain();
      const ledger = (await st.get("scores")) || {};
      const before = new Set(Object.keys(c.sigs));
      const out = { chain: c, kb: {}, awards: null };
      if (url.pathname === "/chain-ops") {
        const touched = new Set(), kbTouched = new Map();
        const events = [];
        for (const op of (body.ops || []).slice(0, MAX_OPS)) {
          if (KB_KINDS.has(op.kind)) {
            const sys = String(op.system);
            const kb = { [sys]: kbTouched.get(sys) || (await st.get(`kb:${sys}`)) || undefined };
            if (!kb[sys]) delete kb[sys];
            events.push(...applyKbOp(kb, op, now).events);
            kbTouched.set(sys, kb[sys]);
            continue;
          }
          if (op.system !== undefined) touched.add(String(op.system));
          events.push(...chainEvents(c, op));
          applyOp(c, op, WORMHOLES);
        }
        pruneChain(c, now);
        if (Object.keys(c.links).length > MAX_LINKS) throw new Error("chain is too large");
        for (const sys of before) if (!c.sigs[sys]) touched.add(sys);
        await this.saveChain(c, touched);
        for (const [sys, rec] of kbTouched) { await st.put(`kb:${sys}`, rec); out.kb[sys] = rec; }
        if (pilot.id && events.length) {
          out.awards = award(ledger, String(pilot.id), pilot.name, events, now, { classOf });
          await st.put("scores", ledger);
        }
      }
      out.board = leaderboard(ledger).slice(0, 25);
      out.me = pilot.id ? ledger[String(pilot.id)] || null : null;
      return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
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

/* ---- organizations ------------------------------------------------------ */
const PBKDF2_ITER = 20000;
const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
async function hashPassword(pw, saltB64) {
  const saltBytes = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITER }, key, 256);
  return { s: b64(saltBytes), h: b64(bits), i: PBKDF2_ITER };
}
async function checkPassword(pw, rec) {
  if (!rec || typeof pw !== "string") return false;
  const h = (await hashPassword(pw, rec.s)).h;
  let diff = h.length ^ rec.h.length;
  for (let i = 0; i < Math.min(h.length, rec.h.length); i++) diff |= h.charCodeAt(i) ^ rec.h.charCodeAt(i);
  return diff === 0;
}
const goodPassword = pw => typeof pw === "string" && pw.length >= 6 && pw.length <= 100;

/* every org lives here (one instance): membership, roles, password hashes */
export class OrgDirectory {
  constructor(state) { this.state = state; }
  async get(id) { return this.state.storage.get(`org:${id}`); }
  async save(org) {
    await this.state.storage.put(`org:${org.id}`, org);
    const index = (await this.state.storage.get("index")) || {};
    index[org.id] = org.name;
    await this.state.storage.put("index", index);
  }
  async pilotOrgs(id) { return (await this.state.storage.get(`pilot:${id}`)) || []; }
  async setPilotOrgs(id, list) { await this.state.storage.put(`pilot:${id}`, [...new Set(list)]); }

  async fetch(req) {
    const body = await req.json();
    const { action, who } = body;
    const now = Date.now();
    const out = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    const fail = (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status });
    try {
      const index = (await this.state.storage.get("index")) || {};
      const load = async () => {
        const org = await this.get(body.org);
        if (!org) throw new Error("No such org.");
        if (Org.settleMaster(org, now)) await this.save(org);
        return org;
      };
      const passwordGate = async (org, rec) => {
        if (Org.tooManyTries(org, who.id, now)) throw new Error("Too many wrong passwords: try again in an hour.");
        const ok = await checkPassword(body.adminPassword ?? body.password, rec);
        Org.noteTry(org, who.id, ok, now);
        await this.save(org);
        if (!ok) throw new Error("Wrong password.");
      };
      switch (action) {
        case "list": {
          const orgs = [];
          for (const id of Object.keys(index)) {
            const o = await this.get(id);
            if (o) orgs.push({ id, name: o.name, members: Object.values(o.members).filter(m => m.role !== "pending").length });
          }
          return out({ orgs: orgs.sort((a, b) => a.name.localeCompare(b.name)) });
        }
        case "mine": {
          const mine = [];
          if (body.isOperator) {
            /* the Atlas operator holds Master Admin standing in every org */
            for (const id of Object.keys(index)) {
              const o = await this.get(id);
              if (o) mine.push({ id, name: o.name, role: "admin", master: true, operator: true, jspace: Org.jspaceOf(o), temp: false });
            }
            return out({ orgs: mine.sort((a, b) => a.name.localeCompare(b.name)) });
          }
          for (const id of await this.pilotOrgs(who.id)) {
            const o = await this.get(id);
            if (!o || !o.members[who.id]) continue;
            Org.settleMaster(o, now);
            mine.push({ id, name: o.name, role: o.members[who.id].role, master: Org.isMaster(o, who.id), jspace: Org.jspaceOf(o),
                        temp: !!o.temp && String(o.temp.id) === String(who.id) });
          }
          return out({ orgs: mine });
        }
        case "create": {
          const name = String(body.name || "").trim();
          if (Object.values(index).some(n => n.toLowerCase() === name.toLowerCase())) throw new Error("That name is taken.");
          if (!goodPassword(body.adminPassword) || !goodPassword(body.memberPassword)) throw new Error("Passwords need at least 6 characters.");
          if (body.adminPassword === body.memberPassword) throw new Error("The admin and member passwords must differ.");
          const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
          const org = Org.newOrg({ id, name, creator: who, now });
          org.pw = { admin: await hashPassword(body.adminPassword), member: await hashPassword(body.memberPassword) };
          await this.save(org);
          await this.setPilotOrgs(who.id, [...await this.pilotOrgs(who.id), id]);
          return out({ id, name: org.name, role: "admin", master: true });
        }
        case "join": {
          const org = await load();
          if (org.members[who.id]) return out({ id: org.id, name: org.name, role: org.members[who.id].role });
          await passwordGate(org, org.pw.member);
          const role = Org.join(org, who, now);
          await this.save(org);
          await this.setPilotOrgs(who.id, [...await this.pilotOrgs(who.id), org.id]);
          return out({ id: org.id, name: org.name, role });
        }
        case "leave": {
          const org = await load();
          Org.leave(org, who.id, now);
          if (!Object.keys(org.members).length) {
            await this.state.storage.delete(`org:${org.id}`);
            delete index[org.id];
            await this.state.storage.put("index", index);
          } else await this.save(org);
          await this.setPilotOrgs(who.id, (await this.pilotOrgs(who.id)).filter(x => x !== org.id));
          return out({ left: org.id });
        }
        case "admin":
        case "operator": {
          const operator = action === "operator";
          if (operator && !body.isOperator) return fail("Operator only.", 403);
          if (operator && !body.org) {
            const all = [];
            for (const id of Object.keys(index)) { const o = await this.get(id); if (o) all.push(Org.adminView(o, now)); }
            return out({ orgs: all });
          }
          const org = await load();
          if (!operator) {
            if (!Org.isAdmin(org, who.id)) throw new Error("Admins only.");
            await passwordGate(org, org.pw.admin);
          }
          const op = body.op || "view";
          if (op !== "view") {
            if (op === "rename") {
              const name = String(body.name || "").trim().toLowerCase();
              if (Object.entries(index).some(([id, n]) => id !== org.id && n.toLowerCase() === name)) throw new Error("That name is taken.");
            }
            Org.adminAction(org, who, op, body.target, now, { operator, name: body.name, value: body.value });
            if (op === "passwords") {
              if (body.newAdmin !== undefined && body.newAdmin !== "") {
                if (!goodPassword(body.newAdmin)) throw new Error("Passwords need at least 6 characters.");
                org.pw.admin = await hashPassword(body.newAdmin);
              }
              if (body.newMember !== undefined && body.newMember !== "") {
                if (!goodPassword(body.newMember)) throw new Error("Passwords need at least 6 characters.");
                org.pw.member = await hashPassword(body.newMember);
              }
            }
            if (op === "boot") await this.setPilotOrgs(body.target, (await this.pilotOrgs(body.target)).filter(x => x !== org.id));
            await this.save(org);
          }
          return out(Org.adminView(org, now));
        }
        case "check": {
          const org = await this.get(body.org);
          if (org && body.isOperator) return out({ ok: true, name: org.name, role: "admin", jspace: Org.jspaceOf(org) });
          const m = org && org.members[who.id];
          if (!m || m.role === "pending") return out({ ok: false });
          const mark = m.lastTouch;
          Org.touch(org, who.id, who.name, now);
          const settled = Org.settleMaster(org, now);
          if (settled || m.lastTouch !== mark) await this.save(org);
          return out({ ok: true, name: org.name, role: m.role, jspace: Org.jspaceOf(org) });
        }
        default:
          return fail("Unknown org action.");
      }
    } catch (e) {
      return fail(e.message);
    }
  }
}
const orgDir = env => env.ORGS.get(env.ORGS.idFromName("directory"));
async function orgCall(env, payload) {
  const r = await orgDir(env).fetch("https://orgs/", { method: "POST", body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "org error");
  return data;
}
const isOperator = (who, env) => (env.OPERATORS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
  .includes(String(who.name || "").toLowerCase());

/* where a request shares: the pilot's corporation, or an org they are an
   approved member of. key names the room (and KV prefix); label goes back
   to the page in "corporation" so older pages keep working. */
async function spaceOf(who, org, env) {
  if (org) {
    const c = await orgCall(env, { action: "check", org: String(org), who: { id: who.id, name: who.name }, isOperator: isOperator(who, env) });
    if (!c.ok) throw new Error("Not an approved member of that org.");
    return { key: `org:${org}`, label: `org:${org}`, org: { id: String(org), name: c.name, jspace: c.jspace } };
  }
  const corp = await corporationOf(who.id);
  return { key: String(corp), label: corp, org: null };
}

async function presence(req, env) {
  const { token, share, org } = await req.json();
  const who = await verify(token, env);
  const corp = (await spaceOf(who, org, env)).key;
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
      if (req.method === "POST" && url.pathname === "/org") {
        const body = await req.json();
        const who = await verify(body.token, env);
        const { token, ...rest } = body;
        const payload = { ...rest, who: { id: who.id, name: who.name }, isOperator: isOperator(who, env) };
        const data = await orgCall(env, payload);
        return json({ ...data, operator: payload.isOperator }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && url.pathname === "/sightings") {
        const { token, org } = await req.json();
        const sp = await spaceOf(await verify(token, env), org, env);
        const systems = (await env.SIGHTINGS.get(`sightings:${sp.key}`, "json")) || {};
        return json({ updated: new Date().toISOString(), activeMinutes: ACTIVE_MINUTES,
                      corporation: sp.label, org: sp.org, systems }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && url.pathname === "/presence") {
        return json(await presence(req, env), 200, headers);
      }
      if (req.method === "POST" && url.pathname === "/corpmates") {
        const { token, org } = await req.json();
        const sp = await spaceOf(await verify(token, env), org, env);
        const pilots = await room(env, sp.key).fetch("https://room/get").then(r => r.json());
        return json({ corporation: sp.label, org: sp.org, pilots }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && (url.pathname === "/chain" || url.pathname === "/chain/ops")) {
        const body = await req.json();
        const who = await verify(body.token, env);
        const sp = await spaceOf(who, body.org, env);
        const corp = sp.key;
        const ops = (body.ops || []).map(op => ({ ...op, by: who.name,
          rec: op.rec ? { ...op.rec, by: who.name } : op.rec }));
        const path = url.pathname === "/chain" ? "/chain-get" : "/chain-ops";
        const r = await room(env, corp).fetch(`https://room${path}`,
          { method: "POST", body: JSON.stringify({ ops, pilot: { id: who.id, name: who.name } }) });
        if (!r.ok) throw new Error(await r.text());
        return json({ corporation: sp.label, org: sp.org, ...(await r.json()) }, 200, { ...headers, "Cache-Control": "no-store" });
      }
      if (req.method === "POST" && url.pathname === "/kb") {
        const body = await req.json();
        const sp = await spaceOf(await verify(body.token, env), body.org, env);
        const corp = sp.key;
        const r = await room(env, corp).fetch("https://room/kb-get",
          { method: "POST", body: JSON.stringify({ systems: (body.systems || []).map(Number).filter(Boolean) }) });
        return json({ corporation: sp.label, org: sp.org, kb: await r.json() }, 200, { ...headers, "Cache-Control": "no-store" });
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
