/* Mission planner: an org-only panel where members work out a mission plan
   with Claude. The relay (worker/planner.js) checks the pilot is an approved
   member of an org the planner is open to, keeps the plans, and asks Claude,
   who can look up systems, routes, recent kills, prices, the org's chain and
   planet scans before answering. Every member of the org sees every plan and
   can add to it. */
"use strict";

const planUi = { pilot: null, state: null, org: null, plans: [], plan: null, busy: false, timer: null, archived: false };

function openPlanner(open) {
  const panel = document.getElementById("planner");
  panel.hidden = !open;
  clearInterval(planUi.timer);
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "fitbox", "bpo", "assets", "traffic", "orgs"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  planUi.timer = setInterval(plRefresh, 15000);
  plStart();
}

async function plCall(action, extra = {}) {
  if (!reserves.relay) throw new Error("The mission planner needs the Atlas relay.");
  const r = await fetch(`${reserves.relay}/planner`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await EveSSO.token(planUi.pilot), action, ...extra }) });
  const data = await r.json().catch(() => ({ error: `relay answered ${r.status}` }));
  if (!r.ok || data.error) throw new Error(data.error || r.status);
  return data;
}

const plEl = id => document.getElementById(id);
const plEsc = s => MdCore.esc(s ?? "");
function plShow(view) { ["plList", "plNew", "plView"].forEach(id => { plEl(id).hidden = id !== view; }); }
function plSay(text, bad = false) { const s = plEl("plStatus"); s.textContent = text; s.classList.toggle("bad", bad); }

/* the first signed-in pilot (active one first) who belongs to an org the planner is open to */
async function plStart() {
  const ids = [pilotState.active, ...EveSSO.pilots().map(p => p.id)].filter((v, i, a) => v && a.indexOf(v) === i);
  if (!ids.length) { plSay("Sign in with Pilot login to use the mission planner."); plShow(null); return; }
  plSay("Checking your orgs…");
  for (const id of ids) {
    planUi.pilot = id;
    try {
      const st = await plCall("state");
      if (st.orgs.length) { planUi.state = st; break; }
      planUi.state = null;
    } catch (e) { plSay(`Could not reach the planner: ${e.message}`, true); return; }
  }
  if (!planUi.state) {
    plSay("The mission planner is for members of our org. Join it from Corp ▸ Orgs, then come back once an admin approves you.");
    plShow(null);
    return;
  }
  const st = planUi.state;
  planUi.org = planUi.org && st.orgs.some(o => o.id === planUi.org) ? planUi.org : st.orgs[0].id;
  const pilot = EveSSO.pilots().find(p => p.id === planUi.pilot);
  const sel = plEl("plOrg");
  sel.innerHTML = st.orgs.map(o => `<option value="${plEsc(o.id)}">${plEsc(o.name)}</option>`).join("");
  sel.value = planUi.org;
  sel.parentElement.hidden = st.orgs.length < 2;
  plEl("plKind").innerHTML = [...new Set(st.kinds.map(k => k.group))].map(g =>
    `<optgroup label="${plEsc(g)}">${st.kinds.filter(k => k.group === g).map(k => `<option value="${k.id}">${plEsc(k.label)}</option>`).join("")}</optgroup>`).join("");
  plStatusLine(pilot ? pilot.name : "");
  await plLoadList();
}

function plStatusLine(name) {
  const st = planUi.state;
  const live = st.live && st.ready;
  plEl("plLive").className = `pl-live ${live ? "on" : ""}`;
  plEl("plLive").textContent = live ? "Planner live" : st.live ? "Planner waiting for its API key" : "Planner offline";
  plSay(`${name ? `${name} · ` : ""}${st.usedToday} of ${st.daily} replies used today` +
        (live ? "" : ". You can read plans; new answers resume when the planner is live."));
  plEl("plStartBtn").disabled = !live;
  plEl("plSend").disabled = !live;
}

async function plLoadList() {
  try {
    planUi.plans = (await plCall("list", { org: planUi.org })).plans;
  } catch (e) { plSay(e.message, true); return; }
  if (!planUi.plan) plShow("plList");
  plDrawList();
}

const plKindLabel = k => ((planUi.state?.kinds || []).find(x => x.id === k) || { label: k }).label;
const plWhen = iso => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

function plDrawList() {
  const rows = planUi.plans.filter(p => (p.status === "archived") === planUi.archived);
  plEl("plPlans").innerHTML = rows.length ? rows.map(p => `<li data-id="${plEsc(p.id)}"><b>${plEsc(p.title)}</b>
      <span class="m-meta">${plEsc(plKindLabel(p.kind))} · ${plEsc(p.by)} · ${p.n || 0} messages · ${plWhen(p.updated)}</span></li>`).join("")
    : `<li class="pl-empty">${planUi.archived ? "No archived plans." : "No plans yet. Start one: say what you want to do and the planner works out how."}</li>`;
  plEl("plPlans").querySelectorAll("li[data-id]").forEach(li => li.onclick = () => plOpen(li.dataset.id));
  plEl("plArchived").textContent = planUi.archived ? "Show open plans" : "Show archived plans";
}

async function plOpen(id) {
  plShow("plView");
  plEl("plThread").innerHTML = `<p class="m-meta">Loading the plan…</p>`;
  try { planUi.plan = (await plCall("get", { org: planUi.org, id })).plan; }
  catch (e) { plEl("plThread").innerHTML = `<p class="pl-err">${plEsc(e.message)}</p>`; return; }
  plDrawPlan(true);
}

function plDrawPlan(scroll) {
  const p = planUi.plan;
  plEl("plTitle").textContent = p.title;
  plEl("plMeta").textContent = `${plKindLabel(p.kind)} · started by ${p.by} · ${plWhen(p.created)}${p.status === "archived" ? " · archived" : ""}`;
  plEl("plArchive").textContent = p.status === "archived" ? "Reopen" : "Archive";
  plEl("plArchive").hidden = !(p.by === EveSSO.pilots().find(x => x.id === planUi.pilot)?.name);
  plEl("plCompose").hidden = p.status !== "open";
  const thread = plEl("plThread");
  thread.innerHTML = p.messages.map(m => m.role === "user"
    ? `<div class="pl-msg me"><div class="pl-by">${plEsc(m.by)} · ${plWhen(m.at)}</div><div class="pl-text">${plEsc(m.text).replace(/\n/g, "<br>")}</div></div>`
    : `<div class="pl-msg ai"><div class="pl-by">Planner · ${plWhen(m.at)}${m.used && m.used.length ? ` · checked ${plEsc(m.used.join(", "))}` : ""}</div>
         <div class="pl-md">${MdCore.render(m.text)}</div></div>`).join("") +
    (planUi.busy || (p.busyUntil && p.busyUntil > Date.now()) ? `<div class="pl-msg ai pl-wait">The planner is working on it: checking the map, kills and prices. This can take up to a minute.</div>` : "");
  if (scroll) thread.scrollTop = thread.scrollHeight;
}

/* every 15 seconds: other members' messages and the planner's answers */
async function plRefresh() {
  if (planUi.busy || document.getElementById("planner").hidden || !planUi.state) return;
  if (planUi.plan && !plEl("plView").hidden) {
    try {
      const p = (await plCall("get", { org: planUi.org, id: planUi.plan.id })).plan;
      const grew = p.messages.length !== planUi.plan.messages.length || p.busyUntil !== planUi.plan.busyUntil;
      planUi.plan = p;
      if (grew) plDrawPlan(true);
    } catch { /* keep what is shown */ }
  } else if (!plEl("plList").hidden) plLoadList();
}

async function plSubmit(action, extra, waitText) {
  planUi.busy = true;
  plSay(waitText);
  if (planUi.plan) plDrawPlan(true);
  try {
    const { plan } = await plCall(action, { org: planUi.org, ...extra });
    planUi.plan = plan;
    planUi.state.usedToday++;
    plShow("plView");
    plDrawPlan(true);
    plStatusLine(EveSSO.pilots().find(x => x.id === planUi.pilot)?.name || "");
    return true;
  } catch (e) {
    plSay(e.message, true);
    return false;
  } finally {
    planUi.busy = false;
    if (planUi.plan && !plEl("plView").hidden) plDrawPlan(false);
  }
}

function initPlanner() {
  plEl("plClose").onclick = () => openPlanner(false);
  plEl("plOrg").onchange = e => { planUi.org = e.target.value; planUi.plan = null; plLoadList(); };
  plEl("plNewBtn").onclick = () => { planUi.plan = null; plShow("plNew"); plEl("plObjective").focus(); };
  plEl("plArchived").onclick = () => { planUi.archived = !planUi.archived; plDrawList(); };
  plEl("plCancel").onclick = () => plShow("plList");
  plEl("plBack").onclick = () => { planUi.plan = null; plShow("plList"); plLoadList(); };
  plEl("plStartBtn").onclick = async () => {
    const f = { kind: plEl("plKind").value, title: plEl("plName").value, objective: plEl("plObjective").value,
                where: plEl("plWhere").value, who: plEl("plWho").value, when: plEl("plWhen").value, risk: plEl("plRisk").value };
    if (f.objective.trim().length < 3) { plSay("Say what the mission is for.", true); return; }
    plEl("plStartBtn").disabled = true;
    plShow("plView");
    plEl("plTitle").textContent = f.title || f.objective.split("\n")[0].slice(0, 80);
    plEl("plMeta").textContent = plKindLabel(f.kind);
    plEl("plThread").innerHTML = `<div class="pl-msg ai pl-wait">The planner is reading your brief and checking the map, kills and prices. This can take up to a minute.</div>`;
    const ok = await plSubmit("new", f, "Planning…");
    plEl("plStartBtn").disabled = false;
    if (ok) ["plName", "plObjective", "plWhere", "plWho", "plWhen"].forEach(id => { plEl(id).value = ""; });
    else plShow("plNew");
  };
  const send = async () => {
    const text = plEl("plText").value.trim();
    if (!text || planUi.busy) return;
    planUi.plan.messages.push({ role: "user", by: "You", text, at: new Date().toISOString() });
    plEl("plText").value = "";
    const ok = await plSubmit("say", { id: planUi.plan.id, text }, "The planner is answering…");
    if (!ok) { planUi.plan.messages.pop(); plEl("plText").value = text; plDrawPlan(false); }
  };
  plEl("plSend").onclick = send;
  plEl("plText").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  plEl("plArchive").onclick = async () => {
    try {
      planUi.plan = (await plCall("archive", { org: planUi.org, id: planUi.plan.id, reopen: planUi.plan.status === "archived" })).plan;
      plDrawPlan(false);
    } catch (e) { plSay(e.message, true); }
  };
}
initPlanner();
