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
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { show(false); btn.focus(); } });
})();
