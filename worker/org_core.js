/* Atlas organizations: the rules, with no storage and no crypto, shared by
   the relay's OrgDirectory and `node --test`.

   An org is a sharing group independent of in-game corporations. Pilots are
   identified by their verified EVE login; passwords are extra gates (the
   relay passes in already-checked results, never the passwords).

   Roles: pending (asked to join, sees nothing), member, admin. One admin is
   Master Admin: the creator, until they hand it on. Admins approve and boot
   members and promote members to admin; only the Master Admin demotes or
   boots admins, changes the passwords, renames the org, and passes
   Master Admin on.

   Master Admin gone quiet: after 30 days without the Master Admin using the
   relay, the most active other admin of the last 30 days becomes Temporary
   Master Admin, with the same powers. If the Master Admin comes back, they
   hold it again at once; if 30 more days pass first, the temporary holder
   becomes the Master Admin for good.

   The Atlas operator (Varg Soth) can reset an org's passwords, make any
   member Master Admin, and remove anyone, for disputes sent by game mail. */

export const DAY = 864e5;
export const STALE = 30 * DAY;
export const TOUCH_EVERY = 10 * 60e3;          // one activity mark per 10 minutes of use
export const NAME_RE = /^[\p{L}\p{N} .'_-]{3,40}$/u;

const dayOf = t => new Date(t).toISOString().slice(0, 10);

export function newOrg({ id, name, creator, now }) {
  if (!NAME_RE.test(name || "")) throw new Error("Org names are 3 to 40 letters, numbers, spaces or . ' _ -");
  return {
    id, name: name.trim(), created: now, master: creator.id, temp: null,
    members: { [creator.id]: { name: creator.name, role: "admin", joined: now, lastSeen: now, act: { [dayOf(now)]: 1 }, lastTouch: now } },
    log: [{ at: now, by: creator.name, what: "created the org" }],
  };
}

export const effectiveMaster = org => (org.temp ? org.temp.id : org.master);

/* activity: 10-minute marks over the last 30 days */
export function activity(m, now) {
  let n = 0;
  for (const [d, c] of Object.entries((m && m.act) || {})) if (now - Date.parse(d) < STALE + DAY) n += c;
  return n;
}

export function touch(org, id, name, now) {
  const m = org.members[id];
  if (!m || m.role === "pending") return false;
  m.lastSeen = now;
  if (name) m.name = name;
  if (now - (m.lastTouch || 0) < TOUCH_EVERY) return true;
  m.lastTouch = now;
  const d = dayOf(now);
  m.act = m.act || {};
  m.act[d] = (m.act[d] || 0) + 1;
  for (const k of Object.keys(m.act)) if (now - Date.parse(k) > STALE + 2 * DAY) delete m.act[k];
  return true;
}

/* applies the 30-day rules; returns true when anything changed */
export function settleMaster(org, now) {
  const before = JSON.stringify([org.master, org.temp]);
  const m = org.members[org.master];
  const mLast = m ? m.lastSeen : 0;
  if (org.temp && (!org.members[org.temp.id] || org.members[org.temp.id].role !== "admin")) org.temp = null;
  if (org.temp) {
    if (mLast > org.temp.since) {
      log(org, now, "Master Admin", "is back and holds Master Admin again");
      org.temp = null;
    } else if (now - org.temp.since >= STALE) {
      const heir = org.temp.id;
      log(org, now, org.members[heir].name, `became Master Admin (${m ? m.name : "the old Master Admin"} gone over 60 days)`);
      org.master = heir;
      org.temp = null;
    }
  }
  if (!org.temp && now - mLast >= STALE) {
    let best = null;
    for (const [id, x] of Object.entries(org.members)) {
      if (id === String(org.master) || x.role !== "admin") continue;
      const a = activity(x, now);
      if (a > 0 && (!best || a > best.a || (a === best.a && x.lastSeen > best.x.lastSeen))) best = { id, x, a };
    }
    if (best) {
      org.temp = { id: isNaN(+best.id) ? best.id : +best.id, since: now };
      log(org, now, best.x.name, "became Temporary Master Admin (Master Admin quiet for 30 days)");
    }
  }
  return JSON.stringify([org.master, org.temp]) !== before;
}

function log(org, now, by, what) {
  org.log = [...(org.log || []), { at: now, by, what }].slice(-100);
}

export const roleOf = (org, id) => (org.members[id] || {}).role || null;
export const isAdmin = (org, id) => roleOf(org, id) === "admin";
export const isMaster = (org, id) => String(effectiveMaster(org)) === String(id);

/* a pilot asks to join (the member password was already checked) */
export function join(org, who, now) {
  const m = org.members[who.id];
  if (m) return m.role;
  org.members[who.id] = { name: who.name, role: "pending", joined: now, lastSeen: now, act: {} };
  log(org, now, who.name, "asked to join");
  return "pending";
}

export function leave(org, id, now) {
  const m = org.members[id];
  if (!m) return;
  const others = Object.keys(org.members).filter(k => k !== String(id) && org.members[k].role !== "pending");
  if (String(org.master) === String(id) && others.length) throw new Error("Pass Master Admin to another admin before leaving.");
  delete org.members[id];
  log(org, now, m.name, "left");
}

/* admin actions. actor: {id, name}; returns a short result. Throws on anything not allowed. */
export function adminAction(org, actor, action, targetId, now, opts = {}) {
  settleMaster(org, now);
  const operator = !!opts.operator;
  if (!operator && !isAdmin(org, actor.id)) throw new Error("Admins only.");
  const master = operator || isMaster(org, actor.id);
  const t = org.members[targetId];
  const needTarget = () => { if (!t) throw new Error("No such member."); };
  const notSelf = () => { if (!operator && String(targetId) === String(actor.id)) throw new Error("Not on yourself."); };
  switch (action) {
    case "approve":
      needTarget();
      if (t.role !== "pending") throw new Error("Already a member.");
      t.role = "member";
      log(org, now, actor.name, `approved ${t.name}`);
      return "approved";
    case "boot":
      needTarget(); notSelf();
      if (String(targetId) === String(org.master) && !operator) throw new Error("The Master Admin cannot be booted.");
      if (t.role === "admin" && !master) throw new Error("Only the Master Admin boots admins.");
      if (String(targetId) === String(org.master)) {
        const heir = Object.keys(org.members).find(k => k !== String(targetId) && org.members[k].role === "admin");
        if (!heir) throw new Error("Make another admin Master Admin first.");
        org.master = +heir || heir;
      }
      delete org.members[targetId];
      if (org.temp && String(org.temp.id) === String(targetId)) org.temp = null;
      log(org, now, actor.name, `removed ${t.name}`);
      return "removed";
    case "promote":
      needTarget();
      if (t.role !== "member") throw new Error("Only members can be made admin.");
      t.role = "admin";
      log(org, now, actor.name, `made ${t.name} an admin`);
      return "promoted";
    case "demote":
      needTarget(); notSelf();
      if (!master) throw new Error("Only the Master Admin demotes admins.");
      if (t.role !== "admin") throw new Error("Not an admin.");
      if (String(targetId) === String(org.master)) throw new Error("Pass Master Admin on first.");
      t.role = "member";
      if (org.temp && String(org.temp.id) === String(targetId)) org.temp = null;
      log(org, now, actor.name, `made ${t.name} a member`);
      return "demoted";
    case "master":
      needTarget();
      if (!master) throw new Error("Only the Master Admin passes Master Admin on.");
      if (t.role !== "admin") {
        if (!operator) throw new Error("Make them an admin first.");
        t.role = "admin";
      }
      org.master = isNaN(+targetId) ? targetId : +targetId;
      org.temp = null;
      log(org, now, actor.name, `made ${t.name} Master Admin`);
      return "master";
    case "rename": {
      if (!master) throw new Error("Only the Master Admin renames the org.");
      const name = String(opts.name || "").trim();
      if (!NAME_RE.test(name)) throw new Error("Org names are 3 to 40 letters, numbers, spaces or . ' _ -");
      if (name === org.name) return "renamed";
      log(org, now, actor.name, `renamed the org from ${org.name} to ${name}`);
      org.name = name;
      return "renamed";
    }
    case "passwords":
      if (!master) throw new Error("Only the Master Admin changes the passwords.");
      log(org, now, actor.name, "changed the passwords");
      return "passwords";
    default:
      throw new Error("Unknown action.");
  }
}

/* what an admin sees */
export function adminView(org, now) {
  return {
    id: org.id, name: org.name, master: org.master, temp: org.temp, effectiveMaster: effectiveMaster(org),
    members: Object.entries(org.members).map(([id, m]) => ({
      id: +id || id, name: m.name, role: m.role, joined: m.joined, lastSeen: m.lastSeen, activity: activity(m, now) })),
    log: (org.log || []).slice(-30),
  };
}

/* failed password tries: 5 an hour per pilot per org */
export function tooManyTries(org, id, now) {
  const f = (org.fails || {})[id];
  return !!f && now - f.since < 3600e3 && f.n >= 5;
}
export function noteTry(org, id, ok, now) {
  org.fails = org.fails || {};
  if (ok) { delete org.fails[id]; return; }
  const f = org.fails[id];
  org.fails[id] = !f || now - f.since >= 3600e3 ? { n: 1, since: now } : { n: f.n + 1, since: f.since };
}
