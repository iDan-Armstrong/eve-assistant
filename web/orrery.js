/* New Eden Atlas — 3D system view (the orrery).
 *
 * Renders a selected solar system from its real SDE geometry: every body
 * sits at its true position (directions and relative layout preserved);
 * radial distances are log-compressed so a 2,000 AU outer planet and a
 * 0.1 AU inner one share a screen, and body sizes are exaggerated to be
 * visible at all. The footer states exactly that — a map that distorts
 * honestly, and says so, is still a true map.
 *
 * Loaded lazily (dynamic import) the first time a 3D view opens.
 */

import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js";

const PLANET_COLORS = {
  Barren: 0x9d8d7f, Gas: 0xc9a86f, Ice: 0xa9c9e2, Lava: 0xd4663a,
  Oceanic: 0x3f7fc2, Plasma: 0xc45fd1, Storm: 0x8f9fb8,
  Temperate: 0x5fae62, Shattered: 0x6e5f5f, Scorched: 0xc08a4d,
};

/* star color from temperature, rough blackbody feel */
function starColor(tempK) {
  if (!tempK) return 0xffe9c9;
  if (tempK > 25000) return 0x9fb8ff;
  if (tempK > 10000) return 0xcfe0ff;
  if (tempK > 7000) return 0xfdfbff;
  if (tempK > 5500) return 0xfff3d8;
  if (tempK > 4000) return 0xffd9a0;
  return 0xff9d66;
}

const compress = au => Math.pow(Math.max(au, 1e-6), 0.42) * 7;

function place(pos) {
  /* EVE is y-up left-ish; keep y up, flip z so the 2D map's north matches */
  const r = Math.hypot(pos[0], pos[1], pos[2]);
  const k = compress(r) / (r || 1);
  return new THREE.Vector3(pos[0] * k, pos[1] * k, -pos[2] * k);
}

export function openOrrery(host, data, onClose) {
  const { system, cel, stations } = data;
  host.innerHTML = `
    <div class="orr-top">
      <div>
        <div class="orr-crumbs">${system.region} ‹ ${system.constellation}</div>
        <div class="orr-title">${system.name}
          <span style="color:${data.secColor}">${system.sec.toFixed(1)}</span></div>
      </div>
      <button class="orr-close" aria-label="Back to map">✕ map</button>
    </div>
    <div class="orr-note">directions true · distances log-compressed · bodies enlarged
      · drag to orbit, scroll to zoom</div>
    <div class="orr-tip" hidden></div>`;
  const canvasHostStyle = host.style;
  canvasHostStyle.display = "block";

  const scene = new THREE.Scene();
  const w = host.clientWidth, h = host.clientHeight;
  const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 4000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.prepend(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  /* lighting: the star is the only real light, plus a whisper of fill */
  scene.add(new THREE.AmbientLight(0x303848, 1.2));
  const starLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);
  scene.add(starLight);

  /* faint starfield for depth */
  {
    const n = 900, g = new THREE.BufferGeometry(), arr = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) arr[i] = (Math.random() - 0.5) * 3000;
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x3a4a66, size: 1.6, sizeAttenuation: false })));
  }

  const pickables = [], labels = [];
  const tip = host.querySelector(".orr-tip");

  function body(mesh, info, labelText, labelCls, labelDy) {
    scene.add(mesh);
    mesh.userData = info;
    pickables.push(mesh);
    if (labelText) {
      const el = document.createElement("div");
      el.className = "orr-label " + (labelCls || "");
      el.textContent = labelText;
      host.appendChild(el);
      labels.push({ el, obj: mesh, dy: labelDy || 0 });
    }
    return mesh;
  }

  /* star */
  const sTemp = cel.star ? cel.star.tempK : 0;
  const star = body(new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 32, 32),
    new THREE.MeshBasicMaterial({ color: starColor(sTemp) })),
    { kind: "Star", name: cel.star ? (cel.star.name || system.name + " - Star") : "Star",
      sub: cel.star ? `${cel.star.type}, ${sTemp.toLocaleString()} K` : "" },
    null);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: starColor(sTemp),
    transparent: true, opacity: .8, depthWrite: false }));
  glow.scale.setScalar(16);
  scene.add(glow);

  let maxR = 10;

  /* planets, their orbit rings, moons, belts */
  for (const pl of cel.planets) {
    const p = place(pl.pos);
    const rAu = Math.hypot(...pl.pos);
    maxR = Math.max(maxR, p.length());
    const short = pl.name.startsWith(system.name)
      ? pl.name.slice(system.name.length).trim() : pl.name;
    const kindName = (pl.type || "").replace("Planet (", "").replace(")", "");
    const size = Math.min(2.2, Math.max(.55, Math.log10((pl.radiusKm || 3000) / 900)));
    const pc = PLANET_COLORS[kindName] ?? 0x8899aa;
    const mesh = body(new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 24),
      new THREE.MeshLambertMaterial({ color: pc,
        emissive: new THREE.Color(pc).multiplyScalar(.28) })),
      { kind: `Planet (${kindName})`, name: pl.name,
        sub: `${rAu.toFixed(1)} AU from star, r ${pl.radiusKm.toLocaleString()} km`
             + (pl.moons.length ? `, ${pl.moons.length} moons` : "")
             + (pl.belts.length ? `, ${pl.belts.length} belts` : "") },
      short, "pl");
    mesh.position.copy(p);

    /* orbit ring through the planet's compressed radius */
    const ring = new THREE.RingGeometry(p.length() - .02, p.length() + .02, 128);
    const rm = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0x2a3550, side: THREE.DoubleSide, transparent: true, opacity: .55 }));
    rm.rotation.x = -Math.PI / 2;
    scene.add(rm);

    /* moons: true offsets from the planet, compressed harder */
    for (const m of pl.moons) {
      const off = [m.pos[0] - pl.pos[0], m.pos[1] - pl.pos[1], m.pos[2] - pl.pos[2]];
      const d = Math.hypot(...off) || 1e-9;
      const md = size + .5 + Math.pow(d, .35) * 4;
      const mv = new THREE.Vector3(off[0] / d, off[1] / d, -off[2] / d)
        .multiplyScalar(md).add(p);
      const mm = body(new THREE.Mesh(
        new THREE.SphereGeometry(.16, 10, 10),
        new THREE.MeshLambertMaterial({ color: 0x9aa4b5, emissive: 0x2c3440 })),
        { kind: "Moon", name: m.name, sub: `orbits ${short}` }, null);
      mm.position.copy(mv);
    }

    /* belts: a dusty arc near the planet */
    for (const b of pl.belts) {
      const off = [b.pos[0] - pl.pos[0], b.pos[1] - pl.pos[1], b.pos[2] - pl.pos[2]];
      const d = Math.hypot(...off) || 1e-9;
      const bd = size + .5 + Math.pow(d, .35) * 4;
      const centre = new THREE.Vector3(off[0] / d, off[1] / d, -off[2] / d)
        .multiplyScalar(bd).add(p);
      const g = new THREE.BufferGeometry(), pts = new Float32Array(26 * 3);
      for (let i = 0; i < 26; i++) {
        pts[i * 3] = centre.x + (Math.random() - .5) * 1.1;
        pts[i * 3 + 1] = centre.y + (Math.random() - .5) * .3;
        pts[i * 3 + 2] = centre.z + (Math.random() - .5) * 1.1;
      }
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xa78d5c, size: 2.2, sizeAttenuation: false })));
      const hit = body(new THREE.Mesh(
        new THREE.SphereGeometry(.7, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false })),
        { kind: "Asteroid belt", name: b.name, sub: `near ${short}` }, null);
      hit.position.copy(centre);
    }
  }

  /* stargates: octahedra at true positions. Some really do stack (Jita
     keeps four gates within ~0.001 AU), so stacked labels fan out. */
  const gatePts = [];
  for (const gexit of (cel.gates || [])) {
    const p = place(gexit.pos);
    maxR = Math.max(maxR, p.length());
    const stacked = gatePts.filter(q => q.distanceTo(p) < 2).length;
    gatePts.push(p);
    const mesh = body(new THREE.Mesh(
      new THREE.OctahedronGeometry(.9),
      new THREE.MeshLambertMaterial({ color: 0xe8d26a, emissive: 0x4a3f12 })),
      { kind: "Stargate", name: gexit.name,
        sub: `${Math.hypot(...gexit.pos).toFixed(1)} AU from star` },
      gexit.name.replace(/^Stargate \(|\)$/g, ""), "gate", stacked * 13);
    mesh.position.copy(p);
  }

  /* stations: small boxes at true positions */
  for (const st of stations) {
    if (!st.pos) continue;
    const p = place(st.pos);
    const mesh = body(new THREE.Mesh(
      new THREE.BoxGeometry(.5, .5, .5),
      new THREE.MeshLambertMaterial({ color: 0x7fb3d5, emissive: 0x24384a })),
      { kind: "Station", name: st.name, sub: "" }, null);
    mesh.position.copy(p);
  }

  camera.position.set(maxR * .9, maxR * .55, maxR * .9);
  controls.maxDistance = maxR * 3.2;
  controls.minDistance = 4;

  /* picking */
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  function onMove(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) {
      const u = hit.object.userData;
      tip.hidden = false;
      tip.innerHTML = `<b>${u.name}</b><br>${u.kind}${u.sub ? " — " + u.sub : ""}`;
      tip.style.left = (e.clientX - r.left + 14) + "px";
      tip.style.top = (e.clientY - r.top + 10) + "px";
      renderer.domElement.style.cursor = "pointer";
    } else {
      tip.hidden = true;
      renderer.domElement.style.cursor = "";
    }
  }
  renderer.domElement.addEventListener("pointermove", onMove);

  /* label projection */
  const v = new THREE.Vector3();
  function placeLabels() {
    const r = renderer.domElement.getBoundingClientRect();
    for (const { el, obj, dy } of labels) {
      v.copy(obj.position).project(camera);
      if (v.z > 1) { el.style.display = "none"; continue; }
      el.style.display = "";
      el.style.left = ((v.x * .5 + .5) * r.width) + "px";
      el.style.top = ((-v.y * .5 + .5) * r.height - dy) + "px";
    }
  }

  let alive = true;
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    controls.update();
    glow.position.copy(star.position);
    renderer.render(scene, camera);
    placeLabels();
  })();

  function onResize() {
    const w2 = host.clientWidth, h2 = host.clientHeight;
    camera.aspect = w2 / h2;
    camera.updateProjectionMatrix();
    renderer.setSize(w2, h2);
  }
  addEventListener("resize", onResize);

  function close() {
    alive = false;
    removeEventListener("resize", onResize);
    renderer.dispose();
    host.innerHTML = "";
    host.style.display = "none";
    onClose && onClose();
  }
  host.querySelector(".orr-close").onclick = close;
  const esc = e => { if (e.key === "Escape") { close(); removeEventListener("keydown", esc); } };
  addEventListener("keydown", esc);
  return close;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,.9)");
  g.addColorStop(.35, "rgba(255,230,180,.35)");
  g.addColorStop(1, "rgba(255,230,180,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
