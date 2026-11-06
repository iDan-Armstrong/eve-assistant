/* Atlas organizations (pilot menu > Organizations).

   An org is a sharing group independent of in-game corporations: J-Space
   Survey chains and survey data, corp-mate positions and reserve sightings
   go to the org instead of the corp when the pilot picks it under
   "Share with". Membership is checked by the relay against the verified
   EVE login on every request; the rules live in worker/org_core.js.

   The active pilot does everything here. The admin password is kept only
   in memory while the admin window is open. Shared with the survey page
   through localStorage "atlas.shareTo" (an org id, or empty for the corp). */
"use strict";

const SHARE_KEY = "atlas.shareTo";
const AtlasOrg = {
  shareTo() { try { return localStorage.getItem(SHARE_KEY) || ""; } catch { return ""; } },
  setShareTo(id) { try { if (id) localStorage.setItem(SHARE_KEY, id); else localStorage.removeItem(SHARE_KEY); } catch { /* private mode */ } },
  mine: [], all: [], operator: false, adminPw: new Map(), view: null, opView: null,
};

async function orgCall(action, extra = {}) {
  const id = pilotState.active || (EveSSO.pilots()[0] || {}).id;
  if (!id) throw new Error("Sign in with Pilot login first.");
  const r = await fetch(`${reserves.relay}/org`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await EveSSO.token(id), action, ...extra }) });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || r.status);
  return data;
}

const JSPACE_NAME = { org: "Org only", public: "Public" };
const ROLE_NAME = o => o.role === "pending" ? "waiting for approval"
  : o.temp ? "Temporary Master Admin" : o.master ? "Master Admin" : o.role === "admin" ? "admin" : "member";

function openOrgs(open) {
  const panel = document.getElementById("orgs");
  panel.hidden = !open;
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "fitbox", "bpo", "assets"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  refreshOrgs();
}

async function refreshOrgs(note = "") {
  const box = document.getElementById("orgBody");
  if (!reserves.relay) { box.innerHTML = `<p class="m-meta">Organizations need the Atlas relay, which is not set up on this site.</p>`; return; }
  const p = EveSSO.pilots().find(x => x.id === pilotState.active) || EveSSO.pilots()[0];
  if (!p) { box.innerHTML = `<p class="m-meta">Sign in with Pilot login first: orgs know you by your EVE login.</p>`; return; }
  box.innerHTML = `<p class="m-meta">Loading…</p>`;
  try {
    const [mine, all] = await Promise.all([orgCall("mine"), orgCall("list")]);
    AtlasOrg.mine = mine.orgs; AtlasOrg.all = all.orgs; AtlasOrg.operator = !!mine.operator;
    if (AtlasOrg.shareTo() && !mine.orgs.some(o => o.id === AtlasOrg.shareTo() && o.role !== "pending")) AtlasOrg.setShareTo("");
    drawOrgs(p, note);
  } catch (e) {
    box.innerHTML = `<p class="s-drop">${esc(e.message)}</p>`;
  }
}

function drawOrgs(p, note) {
  const box = document.getElementById("orgBody");
  const share = AtlasOrg.shareTo();
  const approved = AtlasOrg.mine.filter(o => o.role !== "pending");
  const others = AtlasOrg.all.filter(o => !AtlasOrg.mine.some(m => m.id === o.id));
  box.innerHTML =
    `<div class="h-ship">Acting as <b>${esc(p.name)}</b> (the active pilot).</div>` +
    (note ? `<div class="r-sum">${esc(note)}</div>` : "") +
    `<button class="h-go" id="orgCreateBtn">Create Org</button>` +
    `<form id="orgCreate" class="o-form" hidden>
       <label>Org name<input id="ocName" maxlength="40" autocomplete="off"></label>
       <label>Admin password<input id="ocAdmin" type="password" autocomplete="new-password"></label>
       <label>Admin password again<input id="ocAdmin2" type="password" autocomplete="new-password"></label>
       <label>Member password<input id="ocMember" type="password" autocomplete="new-password"></label>
       <label>Member password again<input id="ocMember2" type="password" autocomplete="new-password"></label>
       <p class="m-meta">You become Master Admin. Members join with the member password and wait for an admin to approve them.
         The admin password opens the admin window. At least 6 characters each, and different from each other.</p>
       <button class="h-go" type="submit">Create</button></form>` +
    `<div class="o-head">Share with</div>
     <label class="m-heat"><input type="radio" name="oShare" value=""${share ? "" : " checked"}> My corporation</label>` +
    approved.map(o => `<label class="m-heat"><input type="radio" name="oShare" value="${esc(o.id)}"${share === o.id ? " checked" : ""}> ${esc(o.name)}</label>`).join("") +
    `<p class="m-meta">J-Space Survey sharing, corp-mate positions and reserve sightings go here. Each of your pilots
       must also tick its share boxes in the pilot menu as before.</p>` +
    `<div class="o-head">Your orgs</div>` +
    (AtlasOrg.mine.length ? `<ul class="o-list">` + AtlasOrg.mine.map(o =>
      `<li><b>${esc(o.name)}</b> <span class="m-meta">${ROLE_NAME(o)}${o.role === "pending" ? "" : `, J-Space ${JSPACE_NAME[o.jspace] || "Org only"}`}</span>
         <span class="o-btns">${o.role === "admin" ? `<button data-admin="${esc(o.id)}">Admin</button>` : ""}
         <button data-leave="${esc(o.id)}">Leave</button></span></li>`).join("") + `</ul>` : `<p class="m-meta">None yet.</p>`) +
    `<div class="o-head">Join an org</div>` +
    (others.length ? `<form id="orgJoin" class="o-form">
       <label>Org<select id="ojOrg">${others.map(o => `<option value="${esc(o.id)}">${esc(o.name)} (${o.members})</option>`).join("")}</select></label>
       <label>Member password<input id="ojPw" type="password" autocomplete="off"></label>
       <button class="h-go" type="submit">Ask to join</button></form>` : `<p class="m-meta">No other orgs yet.</p>`) +
    (AtlasOrg.operator ? `<button class="h-dest" id="orgOperator">Operator: all orgs</button>` : "") +
    `<div id="orgAdmin"></div>` +
    `<p class="r-note">Forgotten password or a dispute? Send an in-game mail to <b>Varg Soth</b>.</p>`;

  document.getElementById("orgCreateBtn").onclick = () => { const f = document.getElementById("orgCreate"); f.hidden = !f.hidden; };
  document.getElementById("orgCreate").onsubmit = async e => {
    e.preventDefault();
    const v = id => document.getElementById(id).value;
    if (v("ocAdmin") !== v("ocAdmin2") || v("ocMember") !== v("ocMember2")) { refreshOrgs("The passwords you typed twice do not match."); return; }
    try {
      const o = await orgCall("create", { name: v("ocName"), adminPassword: v("ocAdmin"), memberPassword: v("ocMember") });
      refreshOrgs(`Created ${o.name}. You are its Master Admin.`);
    } catch (err) { refreshOrgs(err.message); }
  };
  document.querySelectorAll('#orgBody [name="oShare"]').forEach(r => r.onchange = () => {
    AtlasOrg.setShareTo(r.value);
    loadSightings(); loadCorpmates();
  });
  const join = document.getElementById("orgJoin");
  if (join) join.onsubmit = async e => {
    e.preventDefault();
    try {
      const o = await orgCall("join", { org: document.getElementById("ojOrg").value, password: document.getElementById("ojPw").value });
      refreshOrgs(o.role === "pending" ? `Asked to join ${o.name}: an admin has to approve you.` : `You are in ${o.name}.`);
    } catch (err) { refreshOrgs(err.message); }
  };
  document.querySelectorAll("#orgBody [data-leave]").forEach(b => b.onclick = async () => {
    const o = AtlasOrg.mine.find(x => x.id === b.dataset.leave);
    if (!confirmInline(b, `Leave ${o.name}?`)) return;
    try {
      await orgCall("leave", { org: o.id });
      if (AtlasOrg.shareTo() === o.id) AtlasOrg.setShareTo("");
      refreshOrgs(`You left ${o.name}.`);
    } catch (err) { refreshOrgs(err.message); }
  });
  document.querySelectorAll("#orgBody [data-admin]").forEach(b => b.onclick = () => adminGate(b.dataset.admin));
  const op = document.getElementById("orgOperator");
  if (op) op.onclick = operatorView;
}

/* buttons that do something hard to undo ask once more on the button itself */
function confirmInline(btn, question) {
  if (btn.dataset.sure === "1") return true;
  btn.dataset.sure = "1";
  btn.dataset.label = btn.textContent;
  btn.textContent = `${question} Click again`;
  setTimeout(() => { if (btn.isConnected) { btn.dataset.sure = ""; btn.textContent = btn.dataset.label; } }, 4000);
  return false;
}

/* ---- admin window ------------------------------------------------------- */
function adminGate(orgId) {
  const box = document.getElementById("orgAdmin");
  const o = AtlasOrg.mine.find(x => x.id === orgId);
  if (AtlasOrg.adminPw.has(orgId)) { adminRun(orgId, "view"); return; }
  box.innerHTML = `<div class="o-head">Admin: ${esc(o.name)}</div>
    <form id="oaGate" class="o-form"><label>Admin password<input id="oaPw" type="password" autocomplete="off"></label>
    <button class="h-go" type="submit">Open</button></form>`;
  document.getElementById("oaGate").onsubmit = e => {
    e.preventDefault();
    AtlasOrg.adminPw.set(orgId, document.getElementById("oaPw").value);
    adminRun(orgId, "view");
  };
}

async function adminRun(orgId, op, target, extra = {}) {
  const box = document.getElementById("orgAdmin");
  try {
    const v = await orgCall("admin", { org: orgId, adminPassword: AtlasOrg.adminPw.get(orgId), op, target, ...extra });
    drawAdmin(v, op === "view" ? "" : "Done.");
  } catch (err) {
    if (/Wrong password|Too many/.test(err.message)) AtlasOrg.adminPw.delete(orgId);
    box.insertAdjacentHTML("afterbegin", `<p class="s-drop">${esc(err.message)}</p>`);
    if (!AtlasOrg.adminPw.has(orgId)) adminGate(orgId);
  }
}

function memberRows(v, me, master, run) {
  const ago = t => { const d = Math.floor((Date.now() - t) / 864e5); return d < 1 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`; };
  const tag = m => String(m.id) === String(v.master) ? (v.temp ? "Master Admin (away)" : "Master Admin")
    : v.temp && String(m.id) === String(v.temp.id) ? "Temporary Master Admin" : m.role === "pending" ? "waiting" : m.role;
  const order = { pending: 0, admin: 1, member: 2 };
  return v.members.slice().sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name)).map(m => {
    const btn = (opName, label) => `<button data-op="${opName}" data-t="${m.id}">${label}</button>`;
    const self = String(m.id) === String(me);
    const isMasterRow = String(m.id) === String(v.master);
    const b = [];
    if (m.role === "pending") b.push(btn("approve", "Approve"), btn("boot", "Refuse"));
    if (m.role === "member") b.push(btn("promote", "Make admin"), btn("boot", "Boot"));
    if (m.role === "admin" && !self && !isMasterRow && master) b.push(btn("master", "Make Master Admin"), btn("demote", "Make member"), btn("boot", "Boot"));
    if (run === "operator" && !isMasterRow && m.role !== "pending") b.push(btn("master", "Make Master Admin"));
    if (run === "operator" && isMasterRow) b.push(btn("boot", "Remove"));
    return `<tr><td>${esc(m.name)}<div class="m-meta">${tag(m)}, seen ${ago(m.lastSeen)}, activity ${m.activity}</div></td>` +
      `<td class="o-btns">${[...new Set(b)].join("")}</td></tr>`;
  }).join("");
}

function drawAdmin(v, note) {
  const box = document.getElementById("orgAdmin");
  const me = pilotState.active || (EveSSO.pilots()[0] || {}).id;
  const master = String(v.effectiveMaster) === String(me);
  const masterName = (v.members.find(m => String(m.id) === String(v.master)) || {}).name || "nobody";
  const tempName = v.temp ? (v.members.find(m => String(m.id) === String(v.temp.id)) || {}).name : "";
  box.innerHTML = `<div class="o-head">Admin: ${esc(v.name)}</div>` +
    (note ? `<div class="r-sum">${esc(note)}</div>` : "") +
    `<p class="m-meta">Master Admin: <b>${esc(masterName)}</b>${tempName ? `, away; <b>${esc(tempName)}</b> is Temporary Master Admin` : ""}.
       After 30 quiet days the most active admin stands in; 30 more and it is theirs.</p>` +
    `<table class="h-tab o-members">${memberRows(v, me, master, "admin")}</table>` +
    `<div class="o-head">J-Space Survey sharing</div>
     <label class="m-heat"><input type="radio" name="oaJs" value="org"${v.jspace === "org" ? " checked" : ""}${master ? "" : " disabled"}> Org only</label>
     <label class="m-heat"><input type="radio" name="oaJs" value="public"${v.jspace === "public" ? " checked" : ""}${master ? "" : " disabled"}> Public</label>
     <p class="m-meta">Decides how much of the org's J-Space survey data the master J-Space map shows outside the org.
       Known-space survey data stays on the public map either way, except wormhole entrances into the org's own space.
       ${master ? "" : "Only the Master Admin can change this."}</p>` +
    (master ? `<form id="oaRen" class="o-form"><div class="o-head">Rename the org</div>
       <label>New name<input id="oaName" maxlength="40" autocomplete="off" value="${esc(v.name)}"></label>
       <button class="h-go" type="submit">Rename</button></form>` : "") +
    (master ? `<form id="oaPw2" class="o-form"><div class="o-head">Change passwords</div>
       <label>New admin password<input id="oaNewA" type="password" autocomplete="new-password" placeholder="leave blank to keep"></label>
       <label>New member password<input id="oaNewM" type="password" autocomplete="new-password" placeholder="leave blank to keep"></label>
       <button class="h-go" type="submit">Change</button></form>` : "") +
    `<details><summary class="m-meta">Recent changes</summary><ul class="m-meta">${v.log.slice().reverse()
      .map(l => `<li>${new Date(l.at).toISOString().slice(0, 16).replace("T", " ")} ${esc(l.by)} ${esc(l.what)}</li>`).join("")}</ul></details>` +
    `<button class="h-dest" id="oaClose">Close admin window</button>`;
  box.querySelectorAll("[data-op]").forEach(b => b.onclick = () => {
    if (["boot", "master", "demote"].includes(b.dataset.op) && !confirmInline(b, "Sure?")) return;
    adminRun(v.id, b.dataset.op, +b.dataset.t || b.dataset.t);
  });
  box.querySelectorAll('[name="oaJs"]').forEach(r => r.onchange = async () => {
    await adminRun(v.id, "jspace", null, { value: r.value });
    const o = AtlasOrg.mine.find(x => x.id === v.id);
    if (o) o.jspace = r.value;
  });
  const ren = document.getElementById("oaRen");
  if (ren) ren.onsubmit = async e => {
    e.preventDefault();
    await adminRun(v.id, "rename", null, { name: document.getElementById("oaName").value });
    const o = AtlasOrg.mine.find(x => x.id === v.id);
    if (o) o.name = document.getElementById("oaName") ? document.getElementById("oaName").value.trim() : o.name;
  };
  const pw = document.getElementById("oaPw2");
  if (pw) pw.onsubmit = e => {
    e.preventDefault();
    const newA = document.getElementById("oaNewA").value, newM = document.getElementById("oaNewM").value;
    adminRun(v.id, "passwords", null, { newAdmin: newA, newMember: newM });
    if (newA) AtlasOrg.adminPw.set(v.id, newA);
  };
  document.getElementById("oaClose").onclick = () => { AtlasOrg.adminPw.delete(v.id); box.innerHTML = ""; };
}

/* ---- operator (Varg Soth) ----------------------------------------------- */
async function operatorView(note = "") {
  const box = document.getElementById("orgAdmin");
  try {
    const all = await orgCall("operator", {});
    box.innerHTML = `<div class="o-head">Operator: every org</div>` + (typeof note === "string" && note ? `<div class="r-sum">${esc(note)}</div>` : "") +
      all.orgs.map(v => `<details class="o-op"><summary><b>${esc(v.name)}</b> <span class="m-meta">${v.members.length} pilots</span></summary>
        <table class="h-tab o-members" data-org="${esc(v.id)}">${memberRows(v, -1, true, "operator")}</table>
        <form class="o-form" data-rename="${esc(v.id)}"><label>Rename<input name="n" maxlength="40" value="${esc(v.name)}"></label>
        <button class="h-go" type="submit">Rename</button></form>
        <form class="o-form" data-reset="${esc(v.id)}"><label>New admin password<input type="password" name="a" placeholder="leave blank to keep"></label>
        <label>New member password<input type="password" name="m" placeholder="leave blank to keep"></label>
        <button class="h-go" type="submit">Reset passwords</button></form></details>`).join("");
    const run = async (org, op, target, extra = {}) => {
      try { await orgCall("operator", { org, op, target, ...extra }); operatorView("Done."); }
      catch (err) { operatorView(err.message); }
    };
    box.querySelectorAll("table[data-org] [data-op]").forEach(b => b.onclick = () => {
      if (!confirmInline(b, "Sure?")) return;
      run(b.closest("table").dataset.org, b.dataset.op, +b.dataset.t || b.dataset.t);
    });
    box.querySelectorAll("form[data-rename]").forEach(f => f.onsubmit = e => {
      e.preventDefault();
      run(f.dataset.rename, "rename", null, { name: f.n.value });
    });
    box.querySelectorAll("form[data-reset]").forEach(f => f.onsubmit = e => {
      e.preventDefault();
      run(f.dataset.reset, "passwords", null, { newAdmin: f.a.value, newMember: f.m.value });
    });
  } catch (err) { box.innerHTML = `<p class="s-drop">${esc(err.message)}</p>`; }
}

document.getElementById("orgsClose").onclick = () => openOrgs(false);

/* know the pilot's orgs early, so the pilot menu can name the share target */
setTimeout(async () => {
  if (!reserves.relay || !EveSSO.pilots().length) return;
  try { AtlasOrg.mine = (await orgCall("mine")).orgs; } catch { /* relay down or not yet deployed */ }
}, 4000);
