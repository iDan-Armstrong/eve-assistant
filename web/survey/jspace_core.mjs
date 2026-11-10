/* J-Space Survey: planet scans, the pure half (no DOM, no network), shared by
   the survey page, the relay and `node --test`.

   A planet scan is kept per resource: { d: density %, res: resolution, by,
   at, shot }. Resolution is what the skill descriptions call it: Planetology
   plus Advanced Planetology, 0 to 10. A new capture replaces the stored one
   when its resolution is higher, or the same and the capture is newer; a
   lower resolution never replaces a better scan.

   parseScanText() reads what the text recognition found in a capture of the
   in-game scan view: the planet in the panel header ("J170949 III"), the
   resource in the hover tooltip ("Aqueous Liquids Raw Resource") and its
   "Resource Density: 58%". Recognition makes mistakes (III read as "Ill",
   0 as O), so names are matched loosely and the pilot checks before saving. */

export const PLANETOLOGY = 2406, ADVANCED_PLANETOLOGY = 2403;

export const PLANET_RESOURCES = {
  Barren: ["Aqueous Liquids", "Base Metals", "Carbon Compounds", "Micro Organisms", "Noble Metals"],
  Gas: ["Aqueous Liquids", "Base Metals", "Ionic Solutions", "Noble Gas", "Reactive Gas"],
  Ice: ["Aqueous Liquids", "Heavy Metals", "Micro Organisms", "Noble Gas", "Planktic Colonies"],
  Lava: ["Base Metals", "Felsic Magma", "Heavy Metals", "Non-CS Crystals", "Suspended Plasma"],
  Oceanic: ["Aqueous Liquids", "Carbon Compounds", "Complex Organisms", "Micro Organisms", "Planktic Colonies"],
  Plasma: ["Base Metals", "Heavy Metals", "Noble Metals", "Non-CS Crystals", "Suspended Plasma"],
  Storm: ["Aqueous Liquids", "Base Metals", "Ionic Solutions", "Noble Gas", "Suspended Plasma"],
  Temperate: ["Aqueous Liquids", "Autotrophs", "Carbon Compounds", "Complex Organisms", "Micro Organisms"],
};
export const ALL_RESOURCES = [...new Set(Object.values(PLANET_RESOURCES).flat())].sort();
/* each raw resource makes exactly one Tier 1 product: the tooltip's "Required For" line names it */
export const PRODUCT_OF = {
  "Aqueous Liquids": "Water", "Autotrophs": "Industrial Fibers", "Base Metals": "Reactive Metals",
  "Carbon Compounds": "Biofuels", "Complex Organisms": "Proteins", "Felsic Magma": "Silicon",
  "Heavy Metals": "Toxic Metals", "Ionic Solutions": "Electrolytes", "Micro Organisms": "Bacteria",
  "Noble Gas": "Oxygen", "Noble Metals": "Precious Metals", "Non-CS Crystals": "Chiral Structures",
  "Planktic Colonies": "Biomass", "Reactive Gas": "Oxidizing Compound", "Suspended Plasma": "Plasmoids",
};
const RESOURCE_OF = Object.fromEntries(Object.entries(PRODUCT_OF).map(([r, p]) => [p, r]));

/* "Planet (Storm)" -> "Storm" */
export const planetKind = typeName => (String(typeName || "").match(/\(([^)]+)\)/) || [])[1] || String(typeName || "");
export const resourcesOf = typeName => PLANET_RESOURCES[planetKind(typeName)] || [];

/* skills: CCP's [{skill_id, active_skill_level}] */
export function resolutionOf(skills) {
  let r = 0;
  for (const s of skills || []) {
    if (s.skill_id === PLANETOLOGY || s.skill_id === ADVANCED_PLANETOLOGY) r += s.active_skill_level || 0;
  }
  return Math.min(10, r);
}

const ROMAN = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
export function roman(n) {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}
export function fromRoman(s) {
  const val = { I: 1, V: 5, X: 10 };
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = val[s[i]], b = val[s[i + 1]] || 0;
    if (!a) return 0;
    n += a < b ? -a : a;
  }
  return roman(n) === s ? n : 0;
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
/* the resource a phrase most likely names, or null; compares the phrase's last words */
export function matchResource(phrase, names = ALL_RESOURCES) {
  const words = String(phrase || "").toLowerCase().replace(/[^a-z\- ]/g, " ").split(/\s+/).filter(Boolean);
  let best = null;
  for (const n of names) {
    const k = n.split(" ").length;
    if (words.length < k) continue;
    const tail = words.slice(-k).join(" ");
    const dist = lev(tail, n.toLowerCase());
    if (dist <= Math.max(2, Math.floor(n.length / 5)) && (!best || dist < best.dist)) best = { name: n, dist };
  }
  return best ? best.name : null;
}

/* a Tier 1 product named anywhere in the text (any line, any position), or null.
   Short names must match within one letter, so ordinary words do not pass for them */
export function findProduct(text) {
  let best = null;
  for (const line of String(text || "").split(/\n|\|/)) {
    const words = line.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
    for (const prod of Object.keys(RESOURCE_OF)) {
      const k = prod.split(" ").length, target = prod.toLowerCase();
      /* a short name read with a letter wrong only counts on its "Tier" line (often read as Tit, Tie) */
      const tierLine = /\bti[a-z]{0,3}\b/.test(words.join(" "));
      const limit = target.length < 8 ? (tierLine ? 1 : 0) : Math.max(2, Math.floor(target.length / 5));
      for (let i = 0; i + k <= words.length; i++) {
        const d = lev(words.slice(i, i + k).join(" "), target);
        if (d <= limit && (!best || d < best.d)) best = { prod, d };
      }
    }
  }
  return best ? best.prod : null;
}

/* text read from a capture -> { system, index, resource, density, sure } (null where not found);
   sure: the resource came from its Tier 1 product, not from a name near the density line */
export function parseScanText(text, names = ALL_RESOURCES) {
  const t = String(text || "");
  const out = { system: null, index: null, resource: null, density: null, sure: false };
  const pm = t.match(/\b(J ?\d{6}|Thera|J\d{4,5})\s+([IVXl1|!]{1,5})(?=\s|$)/m);
  if (pm) {
    const n = fromRoman(pm[2].replace(/[l1|!]/g, "I"));
    if (n) { out.system = pm[1].replace(" ", ""); out.index = n; }
  }
  /* surest first: the Tier 1 product the tooltip says the resource is required for */
  const prod = findProduct(t);
  if (prod && names.includes(RESOURCE_OF[prod])) { out.resource = RESOURCE_OF[prod]; out.sure = true; }
  const rm = !out.resource && t.match(/([A-Za-z\- ]{3,40}?)\s*Raw\s*Res[a-z]*/i);
  if (rm) out.resource = matchResource(rm[1], names);
  const dm = t.match(/Res[a-z]*\s*Dens[a-z]*\s*[:;.]?\s*([0-9OoIl]{1,3})\s*%/i);
  if (!out.resource && dm) {
    /* the tooltip's title is the last resource named above its density line */
    const above = t.slice(0, dm.index).split(/\n|\|/).reverse();
    for (const line of above) {
      const hit = names.find(n => matchResource(line.replace(/[^A-Za-z\- ]/g, " ").trim(), [n]) ||
                                  line.toLowerCase().includes(n.toLowerCase()));
      if (hit) { out.resource = hit; break; }
    }
  }
  if (dm) {
    const v = +dm[1].replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
    if (v >= 0 && v <= 100) out.density = v;
  }
  return out;
}

/* does rec replace old? higher resolution, or the same and newer */
export const replaces = (old, rec) => !old || rec.res > old.res || (rec.res === old.res && rec.at >= old.at);

/* store: { system: { planetId: { resource: rec } } }
   op: { system, planet, resource, d, res, by, at, shot }
   -> { applied, replaced: the record it replaced, or null, reason } */
export function applyScan(store, op) {
  const d = Math.round(+op.d), res = Math.round(+op.res);
  if (!ALL_RESOURCES.includes(op.resource)) return { applied: false, reason: "unknown resource" };
  if (!(d >= 0 && d <= 100) || !(res >= 0 && res <= 10)) return { applied: false, reason: "out of range" };
  const sys = String(op.system), pl = String(op.planet);
  const rec = { d, res, by: op.by || "", at: op.at || Date.now(), shot: op.shot || null };
  const planet = ((store[sys] ||= {})[pl] ||= {});
  const old = planet[op.resource] || null;
  if (!replaces(old, rec)) return { applied: false, replaced: null, reason: `stored scan has a higher resolution (${old.res})` };
  planet[op.resource] = rec;
  return { applied: true, replaced: old };
}

/* the better of two copies of the same store (public and org), per resource */
export function mergeStores(...stores) {
  const out = {};
  for (const st of stores) for (const [sys, planets] of Object.entries(st || {})) {
    for (const [pl, resources] of Object.entries(planets)) {
      for (const [r, rec] of Object.entries(resources)) {
        const cur = out[sys]?.[pl]?.[r];
        if (replaces(cur, rec)) ((out[sys] ||= {})[pl] ||= {})[r] = rec;
      }
    }
  }
  return out;
}
