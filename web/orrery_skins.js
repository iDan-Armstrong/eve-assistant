/* New Eden Atlas: skins for the 3D system view.
 *
 * Every texture here is drawn by code (no game art): seeded noise sampled on
 * the sphere, so it wraps without a seam, and shaped by what the data says
 * about the body:
 *   stars    colour from temperature, granulation, limb darkening
 *   planets  by type (gas bands, storm swirls, continents and oceans, ice
 *            sheets, lava cracks, plasma filaments, craters, shattered
 *            crust), tinted by surface temperature; clouds and a thin
 *            atmosphere where the type has weather
 *   moons    cratered rock, cold ones bluer, hot ones browner
 *   stations a model per empire style (spire, stacked towers, sphere and
 *            ring, scaffold) with lit windows, and a light in the colour of
 *            the station's services, so the map's legend still reads
 * The same body always looks the same: the seed is its id.
 */
import * as THREE from "three";

/* ---- seeded noise -------------------------------------------------------- */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function noise3(seed) {
  const r = rng(seed), P = new Uint8Array(512), V = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; V[i] = r(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  const fade = t => t * t * (3 - 2 * t);
  const h = (x, y, z) => V[P[P[P[x & 255] + (y & 255)] + (z & 255)]];
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
             l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf), zf);
  };
}
function fbm(n, x, y, z, oct = 5) {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f, z * f); norm += a; a *= 0.5; f *= 2.03; }
  return s / norm;
}
/* ridged noise: thin bright lines (cracks, filaments) */
const ridge = (n, x, y, z, oct = 4) => {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * (1 - Math.abs(2 * n(x * f, y * f, z * f) - 1)); norm += a; a *= 0.5; f *= 2.1; }
  return s / norm;
};

/* paint a W x H equirectangular canvas: fn(x, y, z, lat) -> [r, g, b, a?] (0..255) */
function paint(W, H, fn) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H), d = img.data;
  for (let j = 0; j < H; j++) {
    const lat = Math.PI * (0.5 - (j + 0.5) / H), cl = Math.cos(lat), y = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = 2 * Math.PI * (i + 0.5) / W;
      const px = fn(cl * Math.cos(lon), y, cl * Math.sin(lon), lat);
      const k = (j * W + i) * 4;
      d[k] = px[0]; d[k + 1] = px[1]; d[k + 2] = px[2]; d[k + 3] = px[3] ?? 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = t => Math.max(0, Math.min(1, t));
const smooth = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const hex = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
/* a palette ramp: stops [[t, [r,g,b]], ...] */
function ramp(stops, t) {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      return mix(ca, cb, (t - a) / (b - a || 1));
    }
  }
  return stops[stops.length - 1][1];
}

/* ---- stars ------------------------------------------------------------------ */
export function starRGB(tempK) {
  /* a rough blackbody: blue-white hot stars, yellow suns, orange and red cool ones */
  return ramp([[0, [255, 120, 70]], [0.18, [255, 168, 100]], [0.32, [255, 214, 160]], [0.45, [255, 240, 214]],
               [0.6, [248, 248, 255]], [0.78, [205, 220, 255]], [1, [160, 185, 255]]],
              (Math.log((tempK || 5500) / 2500)) / Math.log(30000 / 2500));
}
/* the colour the star's own type names ("Sun O1 (Bright Blue)", "Sun K5 (Red Giant)",
   "Sun G5 (Gold Immanence)"); the temperature decides only when the type names none */
const NAMED = [
  [/gold/i, [255, 205, 95]], [/divine/i, [255, 250, 235]], [/glory/i, [215, 230, 255]], [/fruitful/i, [190, 255, 200]],
  [/bright blue/i, [140, 175, 255]], [/blue/i, [170, 195, 255]], [/white/i, [245, 246, 255]],
  [/red/i, [255, 110, 75]], [/orange/i, [255, 165, 85]], [/yellow/i, [255, 225, 130]], [/pink/i, [255, 175, 190]],
];
export function starColorOf(type, tempK) {
  const m = String(type || "").match(/\(([^)]+)\)/);
  if (m) for (const [re, c] of NAMED) if (re.test(m[1])) return c;
  return starRGB(tempK);
}
const cache = new Map();
export function starTextureFor(tempK, seed, type) {
  const key = `star:${type || ""}:${Math.round(tempK || 0)}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const n = noise3(seed), base = starColorOf(type, tempK);
  const t = paint(512, 256, (x, y, z) => {
    /* fine granulation, a few faint darker spots, brighter faculae: a lit plasma surface, not rock */
    const g = fbm(n, x * 14, y * 14, z * 14, 4), spots = smooth(0.66, 0.74, fbm(n, x * 2.2 + 7, y * 2.2, z * 2.2, 3));
    const fac = smooth(0.6, 0.75, ridge(n, x * 6 + 3, y * 6, z * 6, 3));
    const k = 0.97 + 0.08 * (g - 0.5) - 0.07 * spots + 0.06 * fac;
    return scale(base, k).map(v => Math.min(255, v));
  });
  cache.set(key, t);
  return t;
}

/* ---- planets ------------------------------------------------------------------ */
/* kind -> how its surface is drawn; tempK tints it (hot worlds redder and drier) */
function planetPainter(kind, n, tempK) {
  const hot = smooth(350, 900, tempK || 300), cold = 1 - smooth(60, 130, tempK || 300);
  switch (kind) {
    case "Gas": {
      const pal = hot > 0.3 ? [[0, [140, 70, 40]], [0.4, [210, 140, 80]], [0.7, [235, 200, 150]], [1, [180, 110, 70]]]
        : cold > 0.5 ? [[0, [90, 120, 150]], [0.5, [170, 200, 215]], [1, [120, 150, 180]]]
        : [[0, [150, 110, 70]], [0.3, [205, 170, 120]], [0.55, [235, 215, 175]], [0.8, [190, 140, 90]], [1, [160, 120, 85]]];
      return (x, y, z) => {
        const warp = fbm(n, x * 3, y * 3, z * 3, 4) * 0.35;
        const band = 0.5 + 0.5 * Math.sin((y + warp) * 22 + fbm(n, x * 1.5, y * 6, z * 1.5, 3) * 4);
        let c = ramp(pal, band * 0.8 + fbm(n, x * 8, y * 30, z * 8, 3) * 0.2);
        const storm = smooth(0.8, 0.86, fbm(n, x * 4 + 3, y * 4, z * 4, 3));
        return mix(c, [245, 230, 205], storm * 0.6);
      };
    }
    case "Storm": return (x, y, z) => {
      const w = fbm(n, x * 2.5, y * 2.5, z * 2.5, 3);
      const sw = 0.5 + 0.5 * Math.sin((y * 9 + w * 6) + fbm(n, x * 5, y * 5, z * 5, 4) * 5);
      let c = ramp([[0, [40, 55, 80]], [0.45, [95, 115, 145]], [0.8, [165, 180, 205]], [1, [220, 228, 240]]], sw * 0.7 + w * 0.3);
      const flash = smooth(0.82, 0.9, ridge(n, x * 6 + 11, y * 6, z * 6, 3));
      return mix(c, [235, 240, 255], flash * 0.7);
    };
    case "Temperate": return (x, y, z, lat) => {
      const h = fbm(n, x * 2.2, y * 2.2, z * 2.2, 6);
      const sea = 0.5 + hot * 0.08;
      const pole = smooth(0.78 - cold * 0.3, 0.9 - cold * 0.3, Math.abs(Math.sin(lat)) + (fbm(n, x * 6, y * 6, z * 6, 3) - 0.5) * 0.15);
      let c;
      if (h < sea) c = ramp([[0, [10, 40, 90]], [0.85, [25, 85, 150]], [1, [60, 140, 170]]], h / sea);
      else {
        const t = (h - sea) / (1 - sea), dry = clamp01(hot * 1.4 + (fbm(n, x * 4 + 5, y * 4, z * 4, 3) - 0.5) * 0.8);
        c = mix(ramp([[0, [70, 120, 55]], [0.5, [50, 95, 45]], [1, [115, 105, 80]]], t), ramp([[0, [175, 150, 95]], [1, [130, 100, 70]]], t), dry);
      }
      return mix(c, [235, 240, 245], pole);
    };
    case "Oceanic": return (x, y, z, lat) => {
      const h = fbm(n, x * 2.5, y * 2.5, z * 2.5, 6);
      let c = ramp([[0, [5, 25, 70]], [0.6, [15, 65, 130]], [0.75, [40, 120, 165]], [1, [90, 175, 185]]], h);
      if (h > 0.7) c = mix(c, [190, 175, 120], smooth(0.7, 0.74, h) * 0.8);      /* a few islands */
      const pole = smooth(0.85, 0.95, Math.abs(Math.sin(lat)));
      return mix(c, [230, 238, 245], pole);
    };
    case "Ice": return (x, y, z) => {
      const h = fbm(n, x * 3, y * 3, z * 3, 5), cr = smooth(0.82, 0.92, ridge(n, x * 5, y * 5, z * 5, 4));
      const c = ramp([[0, [150, 175, 200]], [0.5, [205, 222, 235]], [1, [245, 250, 255]]], h);
      return mix(c, [95, 135, 175], cr * 0.7);
    };
    case "Lava": return (x, y, z) => {
      const h = fbm(n, x * 3, y * 3, z * 3, 5), cr = smooth(0.7, 0.9, ridge(n, x * 4, y * 4, z * 4, 5));
      const crust = ramp([[0, [25, 18, 16]], [0.6, [55, 40, 34]], [1, [85, 65, 55]]], h);
      return mix(crust, [255, 70 + 90 * hot, 15], cr);
    };
    case "Plasma": return (x, y, z) => {
      const f = smooth(0.65, 0.95, ridge(n, x * 3.5, y * 3.5, z * 3.5, 5));
      const base = ramp([[0, [40, 10, 60]], [1, [110, 40, 140]]], fbm(n, x * 2, y * 2, z * 2, 4));
      return mix(base, [245, 140, 255], f);
    };
    case "Shattered": return (x, y, z) => {
      const h = fbm(n, x * 4, y * 4, z * 4, 5), cr = smooth(0.8, 0.95, ridge(n, x * 3, y * 3, z * 3, 4));
      return mix(ramp([[0, [35, 30, 32]], [1, [95, 85, 85]]], h), [10, 8, 10], cr);
    };
    case "Scorched":
    case "Barren":
    default: {
      const pal = kind === "Scorched" || hot > 0.4
        ? [[0, [90, 50, 30]], [0.6, [160, 105, 65]], [1, [200, 150, 105]]]
        : cold > 0.4 ? [[0, [80, 85, 95]], [0.6, [140, 145, 150]], [1, [185, 190, 195]]]
        : [[0, [85, 72, 60]], [0.6, [150, 132, 112]], [1, [190, 175, 155]]];
      return craters(n, pal, Math.floor(n(0.5, 0.5, 0.5) * 1e6));
    }
  }
}
/* rock with real craters: round bowls with bright rims, scattered over the sphere */
function craters(n, pal, seed = 1, count = 70) {
  const r = rng(seed * 13 + 5), list = [];
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1, a = r() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
    const size = 0.03 + Math.pow(r(), 3) * 0.22;              /* many small, a few large (radians) */
    list.push([s * Math.cos(a), u, s * Math.sin(a), Math.cos(size), size]);
  }
  return (x, y, z) => {
    let v = fbm(n, x * 4, y * 4, z * 4, 6) * 0.85 + fbm(n, x * 18, y * 18, z * 18, 2) * 0.15;
    for (const [cx, cy, cz, cosR, size] of list) {
      const d = x * cx + y * cy + z * cz;
      if (d < cosR - 0.02) continue;
      const t = Math.acos(Math.min(1, d)) / size;               /* 0 centre .. 1 rim */
      v += t < 0.85 ? -0.16 * (1 - t * t) : t < 1.1 ? 0.14 * (1 - Math.abs(t - 0.97) / 0.13) : 0;
    }
    return ramp(pal, v);
  };
}
const GLOW = { Lava: true, Plasma: true };
const CLOUDS = { Temperate: 0.55, Oceanic: 0.5, Storm: 0.35, Gas: 0.18 };
const AIR = { Temperate: 0x8fc6ff, Oceanic: 0x7fb8ff, Storm: 0xa7b6d6, Gas: 0xe5c9a0, Ice: 0xcfe6ff, Plasma: 0xd08cff, Lava: 0xff9a5a };

/* a planet mesh group: surface, clouds and air; opts { kind, seed, tempK, size } */
export function planetSkin({ kind, seed, tempK, size }) {
  const key = `pl:${kind}:${seed}:${Math.round(tempK || 0)}`;
  let tex = cache.get(key);
  if (!tex) { tex = paint(512, 256, planetPainter(kind, noise3(seed), tempK)); cache.set(key, tex); }
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: kind === "Oceanic" ? 0.55 : 0.92, metalness: 0 });
  /* every surface glows faintly with its own texture, so the night side still shows; lava and plasma glow hard */
  mat.emissiveMap = tex; mat.emissive = new THREE.Color(0xffffff);
  mat.emissiveIntensity = GLOW[kind] ? 0.6 : 0.16;
  const surface = new THREE.Mesh(new THREE.SphereGeometry(size, 48, 32), mat);
  const spin = [{ obj: surface, rate: 0.02 + (seed % 7) * 0.004 }];
  const extra = [];
  if (CLOUDS[kind]) {
    const ck = `cl:${kind}:${seed}`;
    let ct = cache.get(ck);
    if (!ct) {
      const cn = noise3(seed * 31 + 7), cover = CLOUDS[kind];
      ct = paint(512, 256, (x, y, z) => {
        const v = smooth(1 - cover, 1 - cover + 0.25, fbm(cn, x * 3, y * 5, z * 3, 5));
        return [255, 255, 255, Math.round(v * 220)];
      });
      cache.set(ck, ct);
    }
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(size * 1.025, 48, 32),
      new THREE.MeshStandardMaterial({ map: ct, transparent: true, depthWrite: false, roughness: 1 }));
    extra.push(clouds);
    spin.push({ obj: clouds, rate: 0.045 + (seed % 5) * 0.006 });
  }
  if (AIR[kind]) extra.push({ glow: AIR[kind], scale: size * 2.9 });
  return { surface, extra, spin };
}

/* ---- moons ----------------------------------------------------------------------- */
const MOON_PALS = [
  [[0, [70, 72, 78]], [0.6, [135, 138, 145]], [1, [180, 182, 188]]],
  [[0, [85, 75, 65]], [0.6, [145, 132, 118]], [1, [190, 178, 160]]],
  [[0, [60, 70, 85]], [0.6, [125, 140, 160]], [1, [185, 200, 215]]],
];
export function moonMaterial(seed, tempK) {
  const pal = tempK && tempK < 150 ? 2 : tempK && tempK > 400 ? 1 : seed % 2 ? 1 : 0;
  const v = seed % 6;                         /* six textures per palette is plenty for moons */
  const key = `moon:${pal}:${v}`;
  let tex = cache.get(key);
  if (!tex) { tex = paint(256, 128, craters(noise3(1000 + pal * 10 + v), MOON_PALS[pal], 77 + v, 45)); cache.set(key, tex); }
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 1, emissive: new THREE.Color(0x14171c) });
}

/* ---- stations ------------------------------------------------------------------- */
export function styleOf(st) {
  const s = `${st.type || ""} ${st.corp || ""} ${st.name || ""}`;
  for (const k of ["Amarr", "Caldari", "Gallente", "Minmatar"]) if (s.includes(k)) return k;
  if (/Jita|Ishukone|Lai Dai|Kaalakiota|Sukuun|Hyasyoda|Wiyrkomi|Zainou|Nugoeihuvi/.test(s)) return "Caldari";
  return "Other";
}
const HULL = {
  Amarr: { base: [196, 160, 88], trim: [235, 215, 160], lit: [255, 225, 150], metal: 0.65 },
  Caldari: { base: [92, 104, 120], trim: [150, 162, 178], lit: [190, 225, 255], metal: 0.5 },
  Gallente: { base: [190, 200, 196], trim: [90, 140, 120], lit: [180, 255, 220], metal: 0.35 },
  Minmatar: { base: [120, 78, 52], trim: [165, 120, 85], lit: [255, 190, 120], metal: 0.3 },
  Other: { base: [140, 145, 150], trim: [190, 195, 200], lit: [230, 235, 255], metal: 0.4 },
};
function hullTexture(style, seed) {
  const key = `hull:${style}:${seed % 4}`;
  if (cache.has(key)) return cache.get(key);
  const H = HULL[style], r = rng(seed * 7 + 3);
  const W = 256, Hh = 128, c = document.createElement("canvas");
  c.width = W; c.height = Hh;
  const g = c.getContext("2d");
  const css = a => `rgb(${a.map(v => Math.round(Math.min(255, v))).join(",")})`;
  g.fillStyle = css(H.base); g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 90; i++) {                /* panels */
    const k = 0.82 + r() * 0.3;
    g.fillStyle = css(scale(H.base, k));
    g.fillRect(Math.floor(r() * W), Math.floor(r() * Hh), 8 + r() * 40, 4 + r() * 18);
  }
  if (style === "Minmatar") {                   /* rust streaks */
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(80,40,20,${0.15 + r() * 0.25})`; g.fillRect(r() * W, r() * Hh, 2 + r() * 4, 10 + r() * 40); }
  }
  g.strokeStyle = css(H.trim); g.lineWidth = 1;   /* seams */
  for (let y = 0; y < Hh; y += 16) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  for (let i = 0; i < 260; i++) {               /* lit windows */
    if (r() < 0.45) continue;
    g.fillStyle = css(scale(H.lit, 0.7 + r() * 0.3));
    g.fillRect(Math.floor(r() * W / 3) * 3, Math.floor(r() * Hh / 4) * 4 + 1, 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  cache.set(key, t);
  return t;
}

/* a station model about 1 unit long, built along +z (the caller turns it), with
   a service light of colour accent */
export function stationModel(st, seed, accent) {
  const style = styleOf(st), H = HULL[style];
  const tex = hullTexture(style, seed);
  const hull = new THREE.MeshStandardMaterial({ map: tex, metalness: H.metal, roughness: 0.45,
    emissiveMap: tex, emissive: new THREE.Color(0x222222), emissiveIntensity: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(`rgb(${H.trim.join(",")})`), metalness: H.metal, roughness: 0.4 });
  const glowMat = new THREE.MeshBasicMaterial({ color: accent });
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m;
  };
  if (style === "Amarr") {
    /* a tall golden spire over a broad base, with fins */
    add(new THREE.CylinderGeometry(0.12, 0.22, 0.35, 16), hull, 0, -0.05, 0);
    add(new THREE.ConeGeometry(0.1, 0.7, 16), trim, 0, 0.45, 0);
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.03, 0.32, 0.22), hull, Math.cos(i * Math.PI / 2) * 0.2, 0.02, Math.sin(i * Math.PI / 2) * 0.2, 0, -i * Math.PI / 2, 0);
    add(new THREE.TorusGeometry(0.2, 0.02, 8, 24), glowMat, 0, 0.14, 0, Math.PI / 2);
  } else if (style === "Caldari") {
    /* stacked blocks and towers */
    add(new THREE.BoxGeometry(0.5, 0.14, 0.3), hull, 0, -0.1, 0);
    add(new THREE.BoxGeometry(0.14, 0.55, 0.14), hull, -0.13, 0.22, 0);
    add(new THREE.BoxGeometry(0.12, 0.4, 0.12), hull, 0.12, 0.14, 0.03);
    add(new THREE.BoxGeometry(0.3, 0.05, 0.18), trim, 0, 0.42, 0);
    add(new THREE.BoxGeometry(0.52, 0.02, 0.32), glowMat, 0, -0.02, 0);
  } else if (style === "Gallente") {
    /* a sphere hub with a ring and two pods */
    add(new THREE.SphereGeometry(0.17, 24, 16), hull);
    add(new THREE.TorusGeometry(0.32, 0.035, 10, 40), trim, 0, 0, 0, Math.PI / 2.4);
    add(new THREE.SphereGeometry(0.07, 16, 12), hull, 0.32, 0.05, 0);
    add(new THREE.SphereGeometry(0.07, 16, 12), hull, -0.32, -0.05, 0);
    add(new THREE.TorusGeometry(0.18, 0.012, 8, 32), glowMat, 0, 0, 0, Math.PI / 2);
  } else if (style === "Minmatar") {
    /* an uneven scaffold of beams and hab blocks */
    const r = rng(seed);
    for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.04, 0.5 + r() * 0.3, 0.04), trim, (r() - 0.5) * 0.4, (r() - 0.5) * 0.15, (r() - 0.5) * 0.3, (r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6);
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.12 + r() * 0.1, 0.1, 0.1 + r() * 0.08), hull, (r() - 0.5) * 0.35, (r() - 0.5) * 0.45, (r() - 0.5) * 0.2);
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), glowMat, 0.05, 0, 0, 0, 0, Math.PI / 2);
  } else {
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.18, 6), hull);
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), trim, 0, 0.15, 0);
    add(new THREE.TorusGeometry(0.21, 0.015, 6, 6), glowMat, 0, 0.09, 0, Math.PI / 2);
  }
  return g;
}

/* a soft round glow sprite texture (shared) */
let _glow = null;
export function softGlow() {
  if (_glow) return _glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,0.9)"); gr.addColorStop(0.35, "rgba(255,255,255,0.35)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}
