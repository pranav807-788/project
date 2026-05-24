// ─────────────────────────────────────────────────────────────────────────────
//  Lumière — a cinematic, physics-driven 3D scene
//  Bulb pendulum · scroll-choreographed camera · smart doors · dust · bloom
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
// frame-rate-independent smoothing factor (higher = snappier)
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  scrollTarget: 0,
  scroll: 0,
  mouse: { tx: 0, ty: 0, x: 0, y: 0 },
  // pendulum (radians) — rotation around Z (left/right swing) and X (front/back)
  bulb: { sX: 0, vX: 0, sZ: 0, vZ: 0 },
  prevAnchor: new THREE.Vector3(),
  // doors
  doorOpen: 0,
  doorTarget: 0,
  // global intensity envelope
  lightEnv: 1,
  time: 0,
};

// ── Renderer / Scene / Camera ────────────────────────────────────────────────
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.085);

const camera = new THREE.PerspectiveCamera(
  46,
  window.innerWidth / window.innerHeight,
  0.05,
  120
);
camera.position.set(0, 1.55, 5.6);

// ── Lights ───────────────────────────────────────────────────────────────────
// Very low ambient — everything must be earned by the bulb light.
scene.add(new THREE.AmbientLight(0x1a130c, 0.18));

// A faint hemisphere just to keep darks from being pure black.
scene.add(new THREE.HemisphereLight(0x221a14, 0x050403, 0.12));

// The bulb light itself — warm, with shadows.
const bulbLight = new THREE.PointLight(0xffb070, 4.6, 22, 1.7);
bulbLight.castShadow = true;
bulbLight.shadow.mapSize.set(1024, 1024);
bulbLight.shadow.bias = -0.0008;
bulbLight.shadow.radius = 4;
scene.add(bulbLight);

// Subtle warm fill that follows the bulb but doesn't cast shadows.
const bulbFill = new THREE.PointLight(0xffd6a0, 1.0, 8, 2.2);
scene.add(bulbFill);

// Light leaking from behind the doors when they open.
const leakLight = new THREE.PointLight(0xfff0d8, 0, 12, 2.0);
leakLight.position.set(0, 1.8, -10.2);
scene.add(leakLight);

// ── Room shell ───────────────────────────────────────────────────────────────
const room = new THREE.Group();
scene.add(room);

const wallMat = new THREE.MeshStandardMaterial({
  color: 0x0a0807,
  roughness: 0.96,
  metalness: 0.0,
});

// Floor — slightly reflective dark stone
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0c0a08,
  roughness: 0.55,
  metalness: 0.25,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
floor.receiveShadow = true;
room.add(floor);

// Ceiling
const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), wallMat);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.y = 5.2;
ceiling.receiveShadow = true;
room.add(ceiling);

// Side walls
const sideWallGeom = new THREE.PlaneGeometry(60, 5.2);
const wallL = new THREE.Mesh(sideWallGeom, wallMat);
wallL.rotation.y = Math.PI / 2;
wallL.position.set(-6, 2.6, -10);
wallL.receiveShadow = true;
room.add(wallL);
const wallR = wallL.clone();
wallR.rotation.y = -Math.PI / 2;
wallR.position.set(6, 2.6, -10);
room.add(wallR);

// Back wall — frames the doors
const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5.2), wallMat);
backWall.position.set(0, 2.6, -8.05);
backWall.receiveShadow = true;
room.add(backWall);

// ── Hanging bulb assembly ────────────────────────────────────────────────────
// Hierarchy: anchor (moves along scroll) → pivot (swings) → bulbGroup.
const bulbAnchor = new THREE.Object3D();
bulbAnchor.position.set(0, 4.6, 1.6);
scene.add(bulbAnchor);

const bulbPivot = new THREE.Object3D();
bulbAnchor.add(bulbPivot);

const CABLE_LEN = 1.85;

// Cable — a thin cylinder that hangs from the pivot
const cable = new THREE.Mesh(
  new THREE.CylinderGeometry(0.006, 0.006, CABLE_LEN, 8),
  new THREE.MeshStandardMaterial({ color: 0x1a1614, roughness: 0.95 })
);
cable.position.y = -CABLE_LEN / 2;
bulbPivot.add(cable);

// Bulb itself
const bulbGroup = new THREE.Group();
bulbGroup.position.y = -CABLE_LEN;
bulbPivot.add(bulbGroup);

const bulbMat = new THREE.MeshStandardMaterial({
  color: 0xfff2c8,
  emissive: 0xffb070,
  emissiveIntensity: 3.8,
  roughness: 0.18,
  metalness: 0.0,
  transparent: true,
  opacity: 0.95,
});
const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24), bulbMat);
bulbGroup.add(bulb);

// Inner filament (gives the bulb a pinprick of intense brightness for bloom)
const filament = new THREE.Mesh(
  new THREE.SphereGeometry(0.04, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffe6b8 })
);
bulbGroup.add(filament);

// Brass socket
const socket = new THREE.Mesh(
  new THREE.CylinderGeometry(0.055, 0.07, 0.13, 18),
  new THREE.MeshStandardMaterial({
    color: 0x1a1310,
    metalness: 0.9,
    roughness: 0.35,
  })
);
socket.position.y = 0.16;
bulbGroup.add(socket);

// ── Premium center table ─────────────────────────────────────────────────────
const table = new THREE.Group();
table.position.set(0, 0, 1.6);
scene.add(table);

// Top — clearcoated dark stone for that "luxury" reflection feel
const topMat = new THREE.MeshPhysicalMaterial({
  color: 0x14110f,
  roughness: 0.22,
  metalness: 0.35,
  clearcoat: 1.0,
  clearcoatRoughness: 0.18,
  reflectivity: 0.6,
});
const tableTop = new THREE.Mesh(
  new THREE.BoxGeometry(2.4, 0.05, 1.15),
  topMat
);
tableTop.position.y = 0.92;
tableTop.castShadow = true;
tableTop.receiveShadow = true;
table.add(tableTop);

// Subtle bevel under the top
const apron = new THREE.Mesh(
  new THREE.BoxGeometry(2.32, 0.04, 1.07),
  new THREE.MeshStandardMaterial({ color: 0x0a0908, roughness: 0.6, metalness: 0.4 })
);
apron.position.y = 0.88;
apron.receiveShadow = true;
table.add(apron);

// 4 minimal legs (slim metallic)
const legMat = new THREE.MeshStandardMaterial({
  color: 0x100d0b,
  roughness: 0.3,
  metalness: 0.85,
});
for (const x of [-1, 1])
  for (const z of [-1, 1]) {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.9, 0.05),
      legMat
    );
    leg.position.set(x * 1.08, 0.46, z * 0.49);
    leg.castShadow = true;
    table.add(leg);
  }

// A tiny detail object on the table — a small brass cylinder, gives the bulb
// something to glint off and makes the reflection move convincingly.
const piece = new THREE.Mesh(
  new THREE.CylinderGeometry(0.06, 0.07, 0.18, 24),
  new THREE.MeshPhysicalMaterial({
    color: 0xc8a070,
    metalness: 1.0,
    roughness: 0.28,
    clearcoat: 0.4,
  })
);
piece.position.set(0.55, 1.04, 0.1);
piece.castShadow = true;
table.add(piece);

// ── Smart double doors ───────────────────────────────────────────────────────
const doorsGroup = new THREE.Group();
doorsGroup.position.set(0, 1.85, -8);
scene.add(doorsGroup);

const doorMat = new THREE.MeshStandardMaterial({
  color: 0x0d0b09,
  roughness: 0.45,
  metalness: 0.35,
});

// Door frame
const frameMat = new THREE.MeshStandardMaterial({
  color: 0x16110d,
  roughness: 0.4,
  metalness: 0.5,
});
const frameTop = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.1, 0.18), frameMat);
frameTop.position.y = 1.85;
doorsGroup.add(frameTop);
const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.7, 0.18), frameMat);
frameL.position.x = -1.0;
doorsGroup.add(frameL);
const frameR = frameL.clone();
frameR.position.x = 1.0;
doorsGroup.add(frameR);

// Left door — pivot on its outer edge
const leftPivot = new THREE.Object3D();
leftPivot.position.set(-0.92, 0, 0);
doorsGroup.add(leftPivot);
const leftDoor = new THREE.Mesh(new THREE.BoxGeometry(0.92, 3.55, 0.07), doorMat);
leftDoor.position.x = 0.46;
leftDoor.castShadow = true;
leftDoor.receiveShadow = true;
leftPivot.add(leftDoor);

// Right door
const rightPivot = new THREE.Object3D();
rightPivot.position.set(0.92, 0, 0);
doorsGroup.add(rightPivot);
const rightDoor = new THREE.Mesh(new THREE.BoxGeometry(0.92, 3.55, 0.07), doorMat);
rightDoor.position.x = -0.46;
rightDoor.castShadow = true;
rightDoor.receiveShadow = true;
rightPivot.add(rightDoor);

// Brass handles
function makeHandle(side) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.08, 12),
    new THREE.MeshStandardMaterial({
      color: 0xc8a070,
      metalness: 1.0,
      roughness: 0.3,
    })
  );
  stem.rotation.x = Math.PI / 2;
  stem.position.z = 0.06;
  g.add(stem);
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.28, 16),
    new THREE.MeshStandardMaterial({
      color: 0xd6b483,
      metalness: 1.0,
      roughness: 0.25,
      emissive: 0xffaa55,
      emissiveIntensity: 0,
    })
  );
  grip.rotation.z = Math.PI / 2;
  grip.position.set(side * -0.05, 0, 0.1);
  g.add(grip);
  return { group: g, grip };
}
const handleLObj = makeHandle(1);
handleLObj.group.position.set(0.78, 0, 0.04);
leftPivot.add(handleLObj.group);
const handleRObj = makeHandle(-1);
handleRObj.group.position.set(-0.78, 0, 0.04);
rightPivot.add(handleRObj.group);

// Thin glowing seam between the doors (the "light gap")
const seamMat = new THREE.MeshBasicMaterial({
  color: 0xffd6a0,
  transparent: true,
  opacity: 0,
});
const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 3.55), seamMat);
seam.position.set(0, 0, 0.04);
doorsGroup.add(seam);

// ── Dust particles (drift, lit by the bulb) ──────────────────────────────────
const DUST_COUNT = 520;
const dustGeom = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_COUNT * 3);
const dustVel = new Float32Array(DUST_COUNT * 3);
for (let i = 0; i < DUST_COUNT; i++) {
  dustPos[i * 3] = (Math.random() - 0.5) * 9;
  dustPos[i * 3 + 1] = Math.random() * 4.6;
  dustPos[i * 3 + 2] = (Math.random() - 0.5) * 14 - 2;
  dustVel[i * 3] = (Math.random() - 0.5) * 0.0015;
  dustVel[i * 3 + 1] = (Math.random() * 0.6 + 0.25) * 0.0028;
  dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.0015;
}
dustGeom.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({
  color: 0xffd0a0,
  size: 0.022,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const dust = new THREE.Points(dustGeom, dustMat);
scene.add(dust);

// ── Volumetric light cone (cheap fake) ───────────────────────────────────────
// A vertical cone under the bulb gives the impression of a visible light beam
// without requiring volumetric raymarching. Additive + transparent.
const coneGeom = new THREE.ConeGeometry(2.2, 4.2, 32, 1, true);
coneGeom.translate(0, -2.1, 0);
const coneMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { uIntensity: { value: 0.8 } },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    varying float vY;
    void main() {
      vPos = position;
      vY = (position.y + 4.2) / 4.2; // 0 at tip (top), ~1 at base (bottom)
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vPos;
    varying float vY;
    uniform float uIntensity;
    void main() {
      // Fade radially from the cone's central axis and fade out toward the floor.
      float r = length(vPos.xz) / max(0.001, mix(0.1, 2.2, 1.0 - vY));
      float radial = smoothstep(1.0, 0.0, r);
      float vertical = pow(1.0 - vY, 1.4) * 0.9 + 0.1;
      float a = radial * vertical * 0.18 * uIntensity;
      vec3 col = vec3(1.0, 0.72, 0.42);
      gl_FragColor = vec4(col, a);
    }
  `,
});
const lightCone = new THREE.Mesh(coneGeom, coneMat);
scene.add(lightCone);

// ── Post-processing (bloom) ──────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.85, // strength
  0.75, // radius
  0.18  // threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ── Input: scroll + mouse ────────────────────────────────────────────────────
function onScroll() {
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  state.scrollTarget = clamp(window.scrollY / max, 0, 1);
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

window.addEventListener(
  "pointermove",
  (e) => {
    state.mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
    state.mouse.ty = -((e.clientY / window.innerHeight) * 2 - 1);
  },
  { passive: true }
);
// Touch support — treat last touch as cursor
window.addEventListener(
  "touchmove",
  (e) => {
    if (!e.touches[0]) return;
    state.mouse.tx = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
    state.mouse.ty = -((e.touches[0].clientY / window.innerHeight) * 2 - 1);
  },
  { passive: true }
);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

// ── Overlay text fade based on scroll ────────────────────────────────────────
const sceneTexts = Array.from(document.querySelectorAll(".scene-text")).map((el) => ({
  el,
  start: parseFloat(el.dataset.start),
  end: parseFloat(el.dataset.end),
}));
function updateOverlay(s) {
  for (const t of sceneTexts) {
    let o = 0;
    if (s >= t.start && s <= t.end) {
      const u = (s - t.start) / (t.end - t.start);
      // Triangular fade: in over first 25%, hold, out over last 25%.
      const fadeIn = smoothstep(0, 0.25, u);
      const fadeOut = 1 - smoothstep(0.75, 1, u);
      o = fadeIn * fadeOut;
    }
    t.el.style.opacity = o.toFixed(3);
    t.el.style.transform = `translateY(${(1 - o) * 24}px)`;
  }
  // Hide the scroll indicator after the user has clearly engaged.
  const ind = document.querySelector(".scroll-indicator");
  if (ind) ind.style.opacity = (1 - smoothstep(0.02, 0.12, s)).toFixed(3);
}

// ── Main loop ────────────────────────────────────────────────────────────────
const tmpAnchor = new THREE.Vector3();
const tmpBulb = new THREE.Vector3();
let lastTime = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  state.time += dt;

  // ── Smooth (inertial) scroll & mouse ──
  state.scroll += (state.scrollTarget - state.scroll) * damp(4.2, dt);
  state.mouse.x += (state.mouse.tx - state.mouse.x) * damp(5.5, dt);
  state.mouse.y += (state.mouse.ty - state.mouse.y) * damp(5.5, dt);

  const s = state.scroll;

  // ── Bulb anchor path (the "guide") ──
  // Phase A (0 → 0.7): drift from over-table to over-doors.
  // Phase B (0.7 → 1.0): return home, then sit and softly swing.
  let anchorZ;
  if (s < 0.7) {
    anchorZ = lerp(1.6, -6.4, easeInOut(s / 0.7));
  } else {
    anchorZ = lerp(-6.4, 1.6, easeInOut((s - 0.7) / 0.3));
  }
  // Save previous to derive anchor velocity (drives pendulum drag).
  const prevAZ = bulbAnchor.position.z;
  bulbAnchor.position.set(state.mouse.x * 0.04, 4.6, anchorZ);
  const anchorVZ = (bulbAnchor.position.z - prevAZ) / Math.max(dt, 1e-4);

  // ── Bulb pendulum (two-axis) ──
  // Restoring force toward straight-down + viscous damping.
  const G = 9.0; // gravity-ish
  const damping = 1.6;
  // X-axis swing (around world Z)
  const aX = -(G / CABLE_LEN) * Math.sin(state.bulb.sX) - state.bulb.vX * damping;
  state.bulb.vX += aX * dt;
  state.bulb.sX += state.bulb.vX * dt;
  // Z-axis swing (around world X)
  const aZ = -(G / CABLE_LEN) * Math.sin(state.bulb.sZ) - state.bulb.vZ * damping;
  state.bulb.vZ += aZ * dt;
  state.bulb.sZ += state.bulb.vZ * dt;

  // Inject forces:
  //   • mouse → small left/right swing
  //   • anchor moving forward → bulb lags backward (drag)
  state.bulb.vX += state.mouse.x * 0.08 * dt;
  state.bulb.vZ += -anchorVZ * 0.18; // sign: if anchor moves -z, bulb swings +z (lagging)

  bulbPivot.rotation.z = state.bulb.sX;
  bulbPivot.rotation.x = state.bulb.sZ;

  // ── Light intensity envelope ──
  // Soft fade-in at top, peak through the journey, deep fade-out at the very end.
  let env = 1.0;
  env *= smoothstep(0.0, 0.06, s);          // gentle wake-up
  env *= 1 - smoothstep(0.88, 1.0, s);      // final extinguish
  // A slow, almost imperceptible flicker — feels alive, not robotic.
  const flicker = 1 + Math.sin(state.time * 2.4) * 0.012 + Math.sin(state.time * 6.7) * 0.008;
  state.lightEnv = env;

  bulbLight.intensity = 4.6 * env * flicker;
  bulbFill.intensity = 0.9 * env * flicker;
  bulbMat.emissiveIntensity = 3.8 * env * flicker;
  filament.material.color.setRGB(1.0 * env, 0.9 * env, 0.72 * env);
  scene.fog.density = lerp(0.085, 0.18, 1 - env); // room thickens as light dies

  // ── Position bulb light + fill at the swung bulb's world position ──
  bulbGroup.getWorldPosition(tmpBulb);
  bulbLight.position.copy(tmpBulb);
  bulbFill.position.copy(tmpBulb);

  // ── Light cone follows the bulb ──
  bulbAnchor.getWorldPosition(tmpAnchor);
  lightCone.position.set(tmpBulb.x, tmpBulb.y, tmpBulb.z);
  // tilt the cone slightly with the swing for realism
  lightCone.rotation.z = state.bulb.sX * 0.6;
  lightCone.rotation.x = state.bulb.sZ * 0.6;
  coneMat.uniforms.uIntensity.value = env * 0.95;

  // ── Camera dolly — follows the bulb's lead ──
  // Phase A: glide forward (z 5.6 → -3.6), eye-level rises a touch.
  // Phase B: retreat backward (z -3.6 → 7.2).
  let camZ, camY, lookZ;
  if (s < 0.7) {
    const t = s / 0.7;
    camZ = lerp(5.6, -3.6, easeInOut(t));
    camY = lerp(1.55, 1.78, t);
    lookZ = lerp(0.5, -7.2, easeInOut(t));
  } else {
    const t = (s - 0.7) / 0.3;
    camZ = lerp(-3.6, 7.2, easeInOut(t));
    camY = lerp(1.78, 1.5, t);
    lookZ = lerp(-7.2, 1.5, easeInOut(t));
  }
  // Subtle parallax from the cursor — perspective shift on the table & scene.
  const camTargetX = state.mouse.x * 0.35;
  camera.position.x += (camTargetX - camera.position.x) * damp(3.0, dt);
  camera.position.y = camY + state.mouse.y * 0.12;
  camera.position.z = camZ;
  camera.lookAt(state.mouse.x * 0.15, 1.55 + state.mouse.y * 0.05, lookZ);

  // ── Smart doors (mouse proximity) ──
  // Active range in scroll: ~0.42–0.78. Outside that range they stay closed.
  const doorActive =
    smoothstep(0.4, 0.5, s) * (1 - smoothstep(0.78, 0.86, s));
  // Project mouse toward door center: cursor near center (0,0) → open more.
  const mDist = Math.hypot(state.mouse.x, state.mouse.y * 0.9);
  const proximity = clamp(1 - mDist * 1.05, 0, 1);
  // Anticipation: a small flutter even before the user "commits" close.
  const anticipation = Math.pow(proximity, 1.6);
  state.doorTarget = anticipation * doorActive;
  // Different rates for opening vs closing — opening is curious, closing settles.
  const openingRate = state.doorTarget > state.doorOpen ? 2.2 : 1.6;
  state.doorOpen += (state.doorTarget - state.doorOpen) * damp(openingRate, dt);

  // Max swing angle ~ 62°
  const maxAngle = Math.PI * 0.34;
  leftPivot.rotation.y = state.doorOpen * maxAngle;
  rightPivot.rotation.y = -state.doorOpen * maxAngle;

  // Handle glow ramps with proximity (independent of opening, so the door
  // "notices" you even when it hasn't committed to opening).
  const handleGlow = clamp(proximity * doorActive * 1.6 + state.doorOpen * 0.6, 0, 2.6);
  handleLObj.grip.material.emissiveIntensity = handleGlow;
  handleRObj.grip.material.emissiveIntensity = handleGlow;

  // Light leak: small even when closed (anticipation), bigger when open.
  const leakBase = doorActive * (0.4 + proximity * 0.8);
  leakLight.intensity = leakBase * 2.5 + state.doorOpen * 7.5;
  // Seam glow visible only when the doors are still mostly shut.
  seamMat.opacity = clamp(leakBase * (1 - state.doorOpen) * 0.9, 0, 1);

  // ── Dust ──
  const positions = dust.geometry.attributes.position.array;
  for (let i = 0; i < DUST_COUNT; i++) {
    const ix = i * 3;
    positions[ix]     += dustVel[ix]     + Math.sin(state.time * 0.6 + i) * 0.0004;
    positions[ix + 1] += dustVel[ix + 1] * (0.6 + state.lightEnv * 0.6);
    positions[ix + 2] += dustVel[ix + 2] + Math.cos(state.time * 0.5 + i) * 0.0004;
    if (positions[ix + 1] > 4.9) {
      positions[ix + 1] = 0;
      positions[ix]     = (Math.random() - 0.5) * 9;
      positions[ix + 2] = (Math.random() - 0.5) * 14 - 2;
    }
  }
  dust.geometry.attributes.position.needsUpdate = true;
  // More dust visible when the door is opening (disturbance) and dim at the very end.
  dustMat.opacity = clamp(
    0.32 * state.lightEnv + state.doorOpen * 0.25 + proximity * doorActive * 0.15,
    0,
    0.8
  );

  // ── Bloom envelope — softer at the very ends, full through the journey ──
  bloom.strength = 0.55 + 0.55 * state.lightEnv;

  // ── Tone-mapping exposure: gently dim at the end ──
  renderer.toneMappingExposure = 0.8 + 0.4 * state.lightEnv;

  // ── HTML overlay ──
  updateOverlay(s);

  composer.render();
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// ── A small kick to wake the pendulum on load (so it isn't perfectly still) ──
state.bulb.vX = 0.18;
state.bulb.vZ = -0.05;
