/* Tools menu: every Atlas tool behind one header button, grouped by job.
   Each entry opens the tool's own panel (Haul entries open the planner in
   that mode). Loaded last, after every panel's script. */
"use strict";

(function () {
  const btn = document.getElementById("toolsBtn"), menu = document.getElementById("toolsMenu");
  const show = open => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };

  const OPEN = {
    route: () => openRoute(true),
    survey: () => { location.href = "survey/"; },
    market: () => openMarket(true),
    fit: () => openFit(true),
    bpo: () => openBpo(true),
    assets: () => openAssets(true),
  };

  btn.onclick = e => { e.stopPropagation(); show(menu.hidden); };
  menu.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => {
    show(false);
    const [tool, mode] = b.dataset.tool.split(":");
    if (tool === "haul") {
      /* also applies when the Haul password has to be entered first */
      haul.pendingMode = mode;
      if (!document.getElementById("haul").hidden) { setHaulMode(mode); haul.pendingMode = null; }
      else openHaul(true);
      return;
    }
    OPEN[tool]();
  });
  document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) show(false); });

  /* one header menu at a time: opening Tools, Corp, Pilot or Overlays closes the others */
  document.addEventListener("click", e => {
    const opener = e.target.closest("[aria-controls$='Menu'], details.toggles > summary");
    if (!opener) return;
    const keep = opener.getAttribute("aria-controls");
    document.querySelectorAll(".pilot-menu").forEach(m => {
      if (m.id === keep || m.hidden) return;
      m.hidden = true;
      const b = document.querySelector(`[aria-controls="${m.id}"]`);
      if (b) b.setAttribute("aria-expanded", "false");
    });
    if (opener.tagName !== "SUMMARY") document.querySelectorAll("details.toggles[open]").forEach(d => { d.open = false; });
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { show(false); btn.focus(); } });
})();
