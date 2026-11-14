/* Lowsec traffic: 30 days of hourly jumps and kills for every lowsec system,
   gathered by the hourly Atlas bot (tools/lowsec_traffic.py) from CCP's
   last-hour counts. Totals, daily and weekday patterns, the hours of the day
   that are busiest and quietest, with times shown in EVE time (UTC) or the
   viewer's own time. */
"use strict";

const trafficUi = { doc: null, sel: null, local: true };

function openTraffic(open) {
  const panel = document.getElementById("traffic");
  panel.hidden = !open;
  if (!open) { document.body.classList.remove("route-open"); return; }
  openRoute(false);
  ["market", "haul", "shelf", "fitbox", "bpo", "assets"].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  document.body.classList.add("route-open");
  if (!trafficUi.doc) loadTraffic();
}

async function loadTraffic() {
  const sum = document.getElementById("tSum");
  sum.textContent = "Loading the traffic record…";
  try {
    const r = await fetch("data/live/lowsec_traffic.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    trafficUi.doc = await r.json();
  } catch {
    sum.textContent = "The traffic record is not available yet: the bot writes it on its next hourly run.";
    return;
  }
  const regions = [...new Set(Object.values(trafficUi.doc.systems).map(s => s.r))].sort();
  const sel = document.getElementById("tRegion");
  sel.innerHTML = `<option value="">every lowsec region</option>` + regions.map(r => `<option>${r}</option>`).join("");
  renderTraffic();
}

/* average jumps per day over the hours actually sampled */
const tPerDay = s => trafficUi.doc.hoursHeld ? s.t[0] / trafficUi.doc.hoursHeld * 24 : 0;
const tKillsPerWeek = s => trafficUi.doc.hoursHeld ? s.t[1] / trafficUi.doc.hoursHeld * 168 : 0;
const tOffset = () => (trafficUi.local ? -new Date().getTimezoneOffset() / 60 : 0);
const tHourLabel = h => { const x = ((h + Math.round(tOffset())) % 24 + 24) % 24; return `${String(x).padStart(2, "0")}:00`; };
const tZone = () => (trafficUi.local ? "your time" : "EVE time");

function renderTraffic() {
  const doc = trafficUi.doc;
  if (!doc) return;
  const region = document.getElementById("tRegion").value;
  const ore = document.getElementById("tOre").checked;
  const minBelts = +document.getElementById("tBelts").value || 0;
  const text = document.getElementById("tText").value.trim().toLowerCase();
  const sort = document.getElementById("tSort").value;
  let rows = Object.entries(doc.systems).map(([id, s]) => ({ id: +id, ...s }));
  rows = rows.filter(s => (!region || s.r === region) && (!ore || s.o.length) && s.b >= minBelts &&
                          (!text || s.n.toLowerCase().includes(text)));
  const by = {
    quiet: (a, b) => tPerDay(a) - tPerDay(b) || a.t[1] - b.t[1],
    busy: (a, b) => tPerDay(b) - tPerDay(a),
    kills: (a, b) => b.t[1] - a.t[1],
    belts: (a, b) => b.b - a.b || tPerDay(a) - tPerDay(b),
  }[sort];
  rows.sort(by);
  const days = doc.days.length;
  document.getElementById("tSum").textContent =
    `${rows.length} systems · ${doc.hoursHeld} hours recorded over ${days} day${days === 1 ? "" : "s"}` +
    (doc.hoursHeld < 24 * 30 ? " (fills to 30 days as the bot runs)" : "");
  const list = document.getElementById("tList");
  list.innerHTML = rows.slice(0, 200).map(s => `<li class="t-row${s.id === trafficUi.sel ? " on" : ""}" data-id="${s.id}">
      <div class="t-line"><b>${s.n}</b> <span class="t-sec">${s.s.toFixed(1)}</span> <span class="t-reg">${s.r}</span></div>
      <div class="t-line t-nums"><span>${tPerDay(s).toFixed(0)} jumps/day</span><span>${tKillsPerWeek(s).toFixed(1)} kills/week</span>
        <span>${s.b} belts</span>${s.o.length ? `<span class="t-ore">${s.o.join(", ")}</span>` : ""}</div>
      ${s.id === trafficUi.sel ? trafficDetail(s) : ""}</li>`).join("") ||
    `<li class="t-row">No lowsec system matches these filters.</li>`;
  list.querySelectorAll(".t-row[data-id]").forEach(li => li.onclick = e => {
    if (e.target.closest(".t-detail")) return;
    const id = +li.dataset.id;
    trafficUi.sel = trafficUi.sel === id ? null : id;
    renderTraffic();
  });
  list.querySelectorAll("[data-map]").forEach(b => b.onclick = e => { e.stopPropagation(); const p = state.byId.get(+b.dataset.map); if (p) { select(p.id); flyTo(p.ll, 6); } });
  list.querySelectorAll("[data-zone]").forEach(b => b.onclick = e => { e.stopPropagation(); trafficUi.local = !trafficUi.local; renderTraffic(); });
}

/* a small bar chart: values (null = no data), labels under every nth bar */
function tBars(values, labels, every, color, unit) {
  const W = 300, H = 76, top = 6, base = 58;
  const max = Math.max(1, ...values.filter(v => v != null));
  const bw = W / values.length;
  const bars = values.map((v, i) => {
    const x = i * bw + 1, w = Math.max(1, bw - 2);
    if (v == null) return `<rect x="${x}" y="${base - 2}" width="${w}" height="2" fill="var(--ink-faint)" opacity=".4"><title>${labels[i]}: no data</title></rect>`;
    const h = (v / max) * (base - top);
    return `<rect x="${x}" y="${base - h}" width="${w}" height="${Math.max(h, .5)}" fill="${color}"><title>${labels[i]}: ${v} ${unit}</title></rect>`;
  }).join("");
  const ticks = labels.map((l, i) => (i % every === 0 ? `<text x="${i * bw + bw / 2}" y="${base + 13}" text-anchor="middle">${l}</text>` : "")).join("");
  return `<svg class="t-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${unit}">
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--panel-edge)"/>${bars}${ticks}
    <text x="${W}" y="10" text-anchor="end" class="t-max">max ${Math.round(max * 10) / 10}</text></svg>`;
}

function trafficDetail(s) {
  const doc = trafficUi.doc;
  const shift = Math.round(tOffset());
  /* the hour-of-day profile, turned to the chosen clock */
  const prof = Array.from({ length: 24 }, (_, i) => s.h[((i - shift) % 24 + 24) % 24]);
  const profK = s.hk ? Array.from({ length: 24 }, (_, i) => s.hk[((i - shift) % 24 + 24) % 24]) : null;
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const known = prof.map((v, i) => [v, i]).filter(([v]) => v != null);
  const peak = known.slice().sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => `${hours[i]}:00`);
  const quiet = known.slice().sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, i]) => `${hours[i]}:00`);
  /* weekly totals from the daily record */
  const weeks = [];
  doc.days.forEach((d, i) => {
    const wk = Math.floor(i / 7);
    weeks[wk] = (weeks[wk] || 0) + (s.d[i] || 0);
  });
  const dayLabels = doc.days.map(d => d.slice(5));
  const wdNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `<div class="t-detail">
    <div class="t-facts">
      <span><b>${s.t[0].toLocaleString()}</b> jumps</span><span><b>${s.t[1]}</b> pilot kills</span><span><b>${s.t[2].toLocaleString()}</b> NPC kills</span>
      <span>over ${doc.hoursHeld} recorded hours</span>
    </div>
    <div class="t-h">Busiest hours <span class="t-dim">(${tZone()})</span>: <b>${peak.join(", ") || "not enough data"}</b></div>
    <div class="t-h">Quietest hours: <b>${quiet.join(", ") || "not enough data"}</b>
      <button class="t-zone" data-zone>show ${trafficUi.local ? "EVE time" : "my time"}</button></div>
    <div class="t-cap">Average jumps in each hour of the day (${tZone()})</div>
    ${tBars(prof, hours, 3, "#6aa9ff", "jumps an hour")}
    ${profK && profK.some(v => v) ? `<div class="t-cap">Average pilot kills in each hour</div>${tBars(profK, hours, 3, "#e0524f", "kills an hour")}` : ""}
    <div class="t-cap">Jumps each day (EVE time days)</div>
    ${tBars(s.d.map((v, i) => (doc.hoursPerDay[i] ? v : null)), dayLabels, Math.max(1, Math.ceil(dayLabels.length / 6)), "#6aa9ff", "jumps")}
    ${s.w.some(v => v != null) ? `<div class="t-cap">Average jumps by day of the week</div>${tBars(s.w, wdNames, 1, "#8ff0b0", "jumps a day")}` : ""}
    <div class="t-cap">Weekly totals: ${weeks.map((w, i) => `week ${i + 1}: <b>${w.toLocaleString()}</b>`).join(" · ")}</div>
    <div class="t-dim">Days with few recorded hours read low; hover a bar for its value. ${s.o.length ? `Belts should carry ${s.o.join(" and ")}.` : "No Nocxium ore expected in its belts."}</div>
    <button class="h-go" data-map="${s.id}">Show on map</button>
  </div>`;
}

(function () {
  document.getElementById("tClose").onclick = () => openTraffic(false);
  ["tRegion", "tOre", "tSort"].forEach(id => document.getElementById(id).onchange = renderTraffic);
  ["tBelts", "tText"].forEach(id => document.getElementById(id).oninput = renderTraffic);
})();
