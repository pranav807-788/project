// ─────────────────────────────────────────────────────────────────────────────
//  Lumière — Kitchen Atelier
//  A 7-phase cinematic 3D scene driven by scroll + cursor.
//
//  Phases (scroll progress 0..1):
//    I   The Light       — bulb intro, pendulum, faint warm glow
//    II  The Threshold   — premium doors, cursor-aware
//    III The Reveal      — camera passes through doors into the kitchen,
//                          a sweeping spotlight scans across the room
//    IV  The Craft       — services emerge in the light projection
//    V   Selected Work   — projects rail with horizontal parallax
//    VI  Behind The Magic— floating material / fixture pieces drift
//    Fin                 — camera retreats; doors briefly reopen to
//                          frame the contact card; light fades to black
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { EffectComposer }   from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }       from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass }  from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass }       from "three/addons/postprocessing/OutputPass.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
// Frame-rate-independent smoothing factor — higher = snappier.
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/**
 * Sample a piecewise-linear track of [s, ...values] keyframes at progress s,
 * interpolating between the surrounding keyframes with eased easing.
 * Returns an array of the values (without the leading s).
 */
function sampleTrack(track, s) {
  if (s <= track[0][0]) return track[0].slice(1);
  if (s >= track[track.length - 1][0]) return track[track.length - 1].slice(1);
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (s >= a[0] && s <= b[0]) {
      const t = easeInOut((s - a[0]) / (b[0] - a[0]));
      const out = [];
      for (let j = 1; j < a.length; j++) out.push(lerp(a[j], b[j], t));
      return out;
    }
  }
  return track[track.length - 1].slice(1);
}

/** Smooth on/off envelope for a chapter — 1 inside [start,end], 0 outside,
 *  with soft fade-in/out controlled by the third arg. */
function chapterEnvelope(s, start, end, fade = 0.04) {
  return smoothstep(start - fade, start + fade, s) *
         (1 - smoothstep(end - fade, end + fade, s));
}

// ── Chapter ranges ───────────────────────────────────────────────────────────
const CHAPTERS = [
  { id: "light",    start: 0.00, end: 0.12 },
  { id: "door",     start: 0.13, end: 0.27 },
  { id: "reveal",   start: 0.30, end: 0.43 },
  { id: "services", start: 0.46, end: 0.61 },
  { id: "projects", start: 0.64, end: 0.78 },
  { id: "magic",    start: 0.81, end: 0.91 },
  { id: "ending",   start: 0.94, end: 1.00 },
];

// Camera keyframes  [s,  x,    y,     z,    lx,   ly,   lz,   fov]
const CAM_KEYS = [
  [0.00,  0.0, 1.55,  6.0,   0.0, 1.50, -0.5, 46],
  [0.12,  0.0, 1.58,  4.4,   0.0, 1.55, -2.0, 46],
  [0.27,  0.0, 1.70,  0.8,   0.0, 1.65, -8.0, 46],
  [0.34,  0.0, 1.70, -3.5,   0.0, 1.55, -12.0, 48],
  [0.43,  0.0, 1.70, -9.5,   0.0, 1.30, -16.0, 50],
  [0.55, -0.7, 1.70, -10.0,  0.4, 1.35, -16.0, 52],
  [0.62, -0.4, 1.65, -10.5,  0.0, 1.40, -15.5, 52],
  [0.70,  0.6, 1.65, -10.5, -0.3, 1.40, -15.5, 52],
  [0.85,  0.0, 1.60,  -8.5,  0.0, 1.45, -14.5, 50],
  [0.92,  0.0, 1.55,   0.0,  0.0, 1.50,  -6.0, 46],
  [0.96,  0.0, 1.55,   3.5,  0.0, 1.55,  -5.0, 44],
  [1.00,  0.0, 1.55,   7.0,  0.0, 1.55,  -1.0, 44],
];

// Bulb anchor keyframes  [s, x, y, z]
const BULB_KEYS = [
  [0.00, 0.0, 4.6,  1.6],
  [0.18, 0.0, 4.5, -1.0],
  [0.32, 0.0, 4.3, -7.0],
  [0.43, 0.0, 4.3, -12.0],
  [0.78, 0.0, 4.3, -12.0],
  [0.88, 0.0, 4.4, -8.0],
  [0.94, 0.0, 4.5,  0.0],
  [1.00, 0.0, 4.6,  1.6],
];

// Door open keyframes [s, openness]
//   open as we approach (chapter 2), fully open for pass-through (3),
//   stays open through 4-5-6, closes briefly during early ending,
//   reopens to frame the contact card (0.96-0.985), closes to black.
const DOOR_KEYS = [
  [0.00, 0.00],
  [0.13, 0.00],
  [0.22, 0.55],   // slight anticipation as we near the threshold
  [0.27, 0.95],
  [0.32, 1.00],
  [0.93, 1.00],
  [0.945, 0.05],  // closed pause as camera arrives back outside
  [0.955, 0.00],
  [0.965, 1.00],  // doors open to reveal the contact card
  [0.985, 1.00],
  [1.00, 0.00],   // and close as everything fades
];

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  scrollTarget: 0,
  scroll: 0,
  mouse:   { tx: 0, ty: 0, x: 0, y: 0 },
  bulb:    { sX: 0, vX: 0, sZ: 0, vZ: 0 },  // pendulum (rotations + velocities)
  doorOpen: 0,
  doorTarget: 0,
  lightEnv: 1,
  time: 0,
};

// ── Renderer / Scene / Camera ────────────────────────────────────────────────
const canvas   = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace  = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.07);

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.55, 6.0);

// ── Lights ───────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x1a130c, 0.16));
scene.add(new THREE.HemisphereLight(0x221a14, 0x050403, 0.10));

// Main bulb — the protagonist; soft warm shadow caster
const bulbLight = new THREE.PointLight(0xffb070, 4.6, 22, 1.7);
bulbLight.castShadow = true;
bulbLight.shadow.mapSize.set(1024, 1024);
bulbLight.shadow.bias = -0.0008;
bulbLight.shadow.radius = 4;
scene.add(bulbLight);

// Subtle warm fill that follows the bulb
const bulbFill = new THREE.PointLight(0xffd6a0, 0.9, 8, 2.2);
scene.add(bulbFill);

// Light leaking from behind the doors when ajar
const leakLight = new THREE.PointLight(0xfff0d8, 0, 14, 2.0);
leakLight.position.set(0, 1.9, -8.6);
scene.add(leakLight);

// Three kitchen pendants — non-shadow point lights for performance
const pendantLights = [];
for (let i = -1; i <= 1; i++) {
  const pl = new THREE.PointLight(0xffc080, 0, 7, 2.1);
  pl.position.set(i * 1.2, 4.0, -14);
  pendantLights.push(pl);
  scene.add(pl);
}

// Sweeping reveal spotlight — used only during Chapter III
const sweepLight = new THREE.SpotLight(
  0xffd0a0, 0, 26, Math.PI * 0.18, 0.55, 1.6
);
sweepLight.position.set(0, 4.5, -10.5);
sweepLight.target.position.set(0, 0, -16);
sweepLight.castShadow = true;
sweepLight.shadow.mapSize.set(512, 512);
sweepLight.shadow.bias = -0.001;
scene.add(sweepLight);
scene.add(sweepLight.target);

// Backsplash LED strip — emissive plane gets its own subtle point light
const backsplashLight = new THREE.PointLight(0xffd28a, 0, 5, 2.4);
backsplashLight.position.set(0, 1.45, -21.6);
scene.add(backsplashLight);

// ── Room shell ───────────────────────────────────────────────────────────────
const room = new THREE.Group();
scene.add(room);

const wallMat = new THREE.MeshStandardMaterial({
  color: 0x0a0807, roughness: 0.96, metalness: 0.0,
});

const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0c0a08, roughness: 0.5, metalness: 0.3,
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 80), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -10);
floor.receiveShadow = true;
room.add(floor);

const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(40, 80), wallMat);
ceiling.rotation.x = Math.PI / 2;
ceiling.position.set(0, 5.2, -10);
ceiling.receiveShadow = true;
room.add(ceiling);

// Side walls run the full length (entry hall + kitchen)
const sideWallGeom = new THREE.PlaneGeometry(80, 5.2);
const wallL = new THREE.Mesh(sideWallGeom, wallMat);
wallL.rotation.y = Math.PI / 2;
wallL.position.set(-7, 2.6, -10);
wallL.receiveShadow = true;
room.add(wallL);
const wallR = wallL.clone();
wallR.rotation.y = -Math.PI / 2;
wallR.position.set(7, 2.6, -10);
room.add(wallR);

// Kitchen back wall (closes the kitchen)
const backKitchen = new THREE.Mesh(new THREE.PlaneGeometry(14, 5.2), wallMat);
backKitchen.position.set(0, 2.6, -22);
backKitchen.receiveShadow = true;
room.add(backKitchen);

// Threshold wall — frames the doorway with three solid panels
//   doorway opening is 2.0m wide × 3.7m tall, centered at x=0.
const thresholdMat = wallMat.clone();
const thresholdTop = new THREE.Mesh(new THREE.BoxGeometry(14, 1.5, 0.18), thresholdMat);
thresholdTop.position.set(0, 4.45, -8.05);
thresholdTop.receiveShadow = true;
room.add(thresholdTop);
const thresholdL = new THREE.Mesh(new THREE.BoxGeometry(6, 3.7, 0.18), thresholdMat);
thresholdL.position.set(-4, 1.85, -8.05);
thresholdL.receiveShadow = true;
room.add(thresholdL);
const thresholdR = new THREE.Mesh(new THREE.BoxGeometry(6, 3.7, 0.18), thresholdMat);
thresholdR.position.set(4, 1.85, -8.05);
thresholdR.receiveShadow = true;
room.add(thresholdR);

// ── Hanging bulb assembly ────────────────────────────────────────────────────
// Hierarchy: anchor (animated along scroll) → pivot (swings) → bulbGroup.
const bulbAnchor = new THREE.Object3D();
bulbAnchor.position.set(0, 4.6, 1.6);
scene.add(bulbAnchor);

const bulbPivot = new THREE.Object3D();
bulbAnchor.add(bulbPivot);

const CABLE_LEN = 1.85;

const cable = new THREE.Mesh(
  new THREE.CylinderGeometry(0.006, 0.006, CABLE_LEN, 8),
  new THREE.MeshStandardMaterial({ color: 0x1a1614, roughness: 0.95 })
);
cable.position.y = -CABLE_LEN / 2;
bulbPivot.add(cable);

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

const filament = new THREE.Mesh(
  new THREE.SphereGeometry(0.04, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffe6b8 })
);
bulbGroup.add(filament);

const socket = new THREE.Mesh(
  new THREE.CylinderGeometry(0.055, 0.07, 0.13, 18),
  new THREE.MeshStandardMaterial({ color: 0x1a1310, metalness: 0.9, roughness: 0.35 })
);
socket.position.y = 0.16;
bulbGroup.add(socket);

// ── Smart double doors (cursor-aware) ────────────────────────────────────────
const doorsGroup = new THREE.Group();
doorsGroup.position.set(0, 1.85, -8);
scene.add(doorsGroup);

const doorMat = new THREE.MeshStandardMaterial({
  color: 0x0a0908, roughness: 0.55, metalness: 0.4,
});

const frameMat = new THREE.MeshStandardMaterial({
  color: 0x16110d, roughness: 0.45, metalness: 0.5,
});
const frameTop = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.1, 0.22), frameMat);
frameTop.position.y = 1.85;
doorsGroup.add(frameTop);
const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.7, 0.22), frameMat);
frameL.position.x = -1.0;
doorsGroup.add(frameL);
const frameR = frameL.clone();
frameR.position.x = 1.0;
doorsGroup.add(frameR);

// Left door
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

// Brass handles — emissiveIntensity ramps with cursor proximity
function makeHandle(side) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0xc8a070, metalness: 1.0, roughness: 0.3 })
  );
  stem.rotation.x = Math.PI / 2;
  stem.position.z = 0.06;
  g.add(stem);
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.28, 16),
    new THREE.MeshStandardMaterial({
      color: 0xd6b483, metalness: 1.0, roughness: 0.25,
      emissive: 0xffaa55, emissiveIntensity: 0,
    })
  );
  grip.rotation.z = Math.PI / 2;
  grip.position.set(side * -0.05, 0, 0.1);
  g.add(grip);
  return { group: g, grip };
}
const handleL = makeHandle(1);  handleL.group.position.set(0.78, 0, 0.04);  leftPivot.add(handleL.group);
const handleR = makeHandle(-1); handleR.group.position.set(-0.78, 0, 0.04); rightPivot.add(handleR.group);

// Glowing seam visible while doors are still nearly shut
const seamMat = new THREE.MeshBasicMaterial({ color: 0xffd6a0, transparent: true, opacity: 0 });
const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 3.55), seamMat);
seam.position.set(0, 0, 0.04);
doorsGroup.add(seam);

// ── Kitchen island ───────────────────────────────────────────────────────────
const island = new THREE.Group();
island.position.set(0, 0, -14);
scene.add(island);

// Marble top (Calacatta-ish)
const marbleMat = new THREE.MeshPhysicalMaterial({
  color: 0xd6cfc1,
  roughness: 0.18,
  metalness: 0.0,
  clearcoat: 0.7,
  clearcoatRoughness: 0.12,
  reflectivity: 0.6,
});
const islandTop = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.06, 1.4), marbleMat);
islandTop.position.y = 0.95;
islandTop.castShadow = true;
islandTop.receiveShadow = true;
island.add(islandTop);

// A subtle vein layer — a thin lighter slab just below to suggest depth
const islandVein = new THREE.Mesh(
  new THREE.BoxGeometry(3.38, 0.005, 1.38),
  new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.4, metalness: 0.0 })
);
islandVein.position.y = 0.985;
island.add(islandVein);

// Dark stone base (waterfall edges)
const baseMat = new THREE.MeshStandardMaterial({
  color: 0x0c0a08, roughness: 0.55, metalness: 0.3,
});
const islandBase = new THREE.Mesh(new THREE.BoxGeometry(3.32, 0.92, 1.32), baseMat);
islandBase.position.y = 0.46;
islandBase.castShadow = true;
islandBase.receiveShadow = true;
island.add(islandBase);

// Two thin brass drawer pulls on the front face
const pullMat = new THREE.MeshStandardMaterial({
  color: 0xc8a070, metalness: 1.0, roughness: 0.3,
});
for (const x of [-0.8, 0.8]) {
  const pull = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 0.014), pullMat);
  pull.position.set(x, 0.55, 0.66 + 0.01);
  island.add(pull);
}

// A small brass piece on top — gives the bulb something to glint off
const islandPiece = new THREE.Mesh(
  new THREE.CylinderGeometry(0.05, 0.06, 0.18, 24),
  new THREE.MeshPhysicalMaterial({
    color: 0xc8a070, metalness: 1.0, roughness: 0.28, clearcoat: 0.4,
  })
);
islandPiece.position.set(0.9, 1.07, 0.2);
islandPiece.castShadow = true;
island.add(islandPiece);

// A low marble bowl
const islandBowl = new THREE.Mesh(
  new THREE.CylinderGeometry(0.18, 0.16, 0.09, 24, 1, true),
  new THREE.MeshPhysicalMaterial({
    color: 0xece6d8, roughness: 0.35, clearcoat: 0.4, side: THREE.DoubleSide,
  })
);
islandBowl.position.set(-0.7, 1.025, -0.05);
island.add(islandBowl);

// ── Kitchen pendants (3 small bulbs above the island) ────────────────────────
const pendants = [];
for (let i = -1; i <= 1; i++) {
  const g = new THREE.Group();
  g.position.set(i * 1.2, 0, -14);
  scene.add(g);

  const c = new THREE.Mesh(
    new THREE.CylinderGeometry(0.005, 0.005, 1.0, 6),
    new THREE.MeshStandardMaterial({ color: 0x1a1614, roughness: 0.9 })
  );
  c.position.y = 4.5;
  g.add(c);

  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0x1a130d, metalness: 0.7, roughness: 0.4,
  });
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.16, 18), shadeMat);
  shade.position.y = 3.92;
  g.add(shade);

  const pBulbMat = new THREE.MeshStandardMaterial({
    color: 0xfff2c8, emissive: 0xffb070, emissiveIntensity: 0,
    roughness: 0.18, metalness: 0,
  });
  const pBulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), pBulbMat);
  pBulb.position.y = 3.8;
  g.add(pBulb);

  pendants.push({ group: g, bulbMat: pBulbMat });
}

// ── Wall shelves & decor on the kitchen back wall ────────────────────────────
const shelfMat = new THREE.MeshStandardMaterial({
  color: 0x1a130d, roughness: 0.5, metalness: 0.4,
});
function addShelf(y) {
  const s = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.04, 0.32), shelfMat);
  s.position.set(0, y, -21.7);
  s.castShadow = true;
  s.receiveShadow = true;
  scene.add(s);
}
addShelf(2.0);
addShelf(2.85);

// A few small decorative items on the shelves
const decorBrass = new THREE.MeshStandardMaterial({
  color: 0xc8a070, metalness: 1.0, roughness: 0.32,
});
const decorStone = new THREE.MeshStandardMaterial({
  color: 0xece6d8, roughness: 0.35, metalness: 0.0,
});
function addDecor() {
  // small vase
  const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.28, 18), decorStone);
  vase.position.set(-1.0, 2.18, -21.65);
  vase.castShadow = true;
  scene.add(vase);

  // small round box
  const box = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 24), decorBrass);
  box.position.set(0.9, 2.08, -21.65);
  box.castShadow = true;
  scene.add(box);

  // tall slim figure on upper shelf
  const fig = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.08), decorBrass);
  fig.position.set(-0.7, 3.05, -21.65);
  fig.castShadow = true;
  scene.add(fig);

  // squat bowl on upper shelf
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.08, 18), decorStone);
  bowl.position.set(0.6, 2.92, -21.65);
  bowl.castShadow = true;
  scene.add(bowl);
}
addDecor();

// Backsplash strip (emissive horizontal accent)
const backsplashStrip = new THREE.Mesh(
  new THREE.PlaneGeometry(3.0, 0.04),
  new THREE.MeshBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0 })
);
backsplashStrip.position.set(0, 1.42, -21.94);
scene.add(backsplashStrip);

// ── Floating elements (Chapter VI) ───────────────────────────────────────────
// Small premium pieces — material samples, cabinet slabs, lighting fixtures —
// drift slowly during the "Behind the Magic" phase.
const FLOAT_COUNT = 10;
const floaters = [];
const brassMat = new THREE.MeshPhysicalMaterial({
  color: 0xc8a070, metalness: 1.0, roughness: 0.28, clearcoat: 0.3,
});
const woodMat = new THREE.MeshStandardMaterial({
  color: 0x3a2516, roughness: 0.55, metalness: 0.05,
});
const stoneMat = new THREE.MeshPhysicalMaterial({
  color: 0xd6cfc1, roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.18,
});
const blackMat = new THREE.MeshStandardMaterial({
  color: 0x14110f, roughness: 0.4, metalness: 0.5,
});

function makeFloater(i) {
  let mesh;
  const kind = i % 5;
  if (kind === 0) {
    // material sample slab
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.22), stoneMat);
  } else if (kind === 1) {
    // cabinet piece
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.05), woodMat);
  } else if (kind === 2) {
    // brass handle / fixture
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.32, 14), brassMat);
  } else if (kind === 3) {
    // ring (lighting fixture)
    mesh = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.015, 10, 24), brassMat);
  } else {
    // small obsidian cube
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), blackMat);
  }
  mesh.castShadow = true;
  // Distribute roughly in front of the camera position used during chapter 6.
  // Chapter 6 camera is around z = -8..-9; floaters live z = -7..-12.
  const x = (Math.random() - 0.5) * 4.4;
  const y = 0.9 + Math.random() * 2.2;
  const z = -7 - Math.random() * 5;
  mesh.position.set(x, y, z);
  mesh.userData = {
    bobAmp:   0.05 + Math.random() * 0.12,
    bobRate:  0.4  + Math.random() * 0.6,
    rotRate:  (Math.random() - 0.5) * 0.5,
    yBase:    y,
    phase:    Math.random() * Math.PI * 2,
  };
  // Hidden by default; opacity ramped during chapter 6.
  mesh.material = mesh.material.clone();
  mesh.material.transparent = true;
  mesh.material.opacity = 0;
  scene.add(mesh);
  floaters.push(mesh);
}
for (let i = 0; i < FLOAT_COUNT; i++) makeFloater(i);

// ── Dust particles ───────────────────────────────────────────────────────────
const DUST_COUNT = 540;
const dustGeom = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_COUNT * 3);
const dustVel = new Float32Array(DUST_COUNT * 3);
for (let i = 0; i < DUST_COUNT; i++) {
  // Spread dust through the entire room (entry hall + kitchen)
  dustPos[i * 3]     = (Math.random() - 0.5) * 11;
  dustPos[i * 3 + 1] = Math.random() * 4.6;
  dustPos[i * 3 + 2] = -Math.random() * 22 + 2;
  dustVel[i * 3]     = (Math.random() - 0.5) * 0.0015;
  dustVel[i * 3 + 1] = (Math.random() * 0.6 + 0.25) * 0.0028;
  dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.0015;
}
dustGeom.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({
  color: 0xffd0a0, size: 0.022, transparent: true, opacity: 0.5,
  depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
});
const dust = new THREE.Points(dustGeom, dustMat);
scene.add(dust);

// ── Volumetric light cone under the bulb (cheap fake) ────────────────────────
const coneGeom = new THREE.ConeGeometry(2.2, 4.2, 32, 1, true);
coneGeom.translate(0, -2.1, 0);
const coneMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uIntensity: { value: 0.8 } },
  vertexShader: /* glsl */ `
    varying vec3 vPos; varying float vY;
    void main() {
      vPos = position; vY = (position.y + 4.2) / 4.2;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vPos; varying float vY;
    uniform float uIntensity;
    void main() {
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
  0.85, 0.75, 0.18
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

window.addEventListener("pointermove", (e) => {
  state.mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
  state.mouse.ty = -((e.clientY / window.innerHeight) * 2 - 1);
}, { passive: true });

window.addEventListener("touchmove", (e) => {
  if (!e.touches[0]) return;
  state.mouse.tx = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
  state.mouse.ty = -((e.touches[0].clientY / window.innerHeight) * 2 - 1);
}, { passive: true });

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

// ── Overlay: per-section fade tied to scroll progress + chapter nav ──────────
const overlaySections = Array.from(document.querySelectorAll(".overlay > section")).map(el => ({
  el, start: parseFloat(el.dataset.start), end: parseFloat(el.dataset.end),
}));
const projectsRail = document.getElementById("projects-rail");
const projectsRailViewport = projectsRail ? projectsRail.parentElement : null;
const chapterNavItems = Array.from(document.querySelectorAll("#chapter-nav-list li"));
const scrollIndicatorEl = document.querySelector(".scroll-indicator");

function updateOverlay(s) {
  for (const t of overlaySections) {
    let o = 0;
    if (s >= t.start && s <= t.end) {
      const u = (s - t.start) / (t.end - t.start);
      const fadeIn  = smoothstep(0, 0.22, u);
      const fadeOut = 1 - smoothstep(0.78, 1, u);
      o = fadeIn * fadeOut;
    }
    t.el.style.opacity   = o.toFixed(3);
    t.el.style.transform = `translateY(${(1 - o) * 26}px)`;
  }

  // Projects rail: translate horizontally based on local scroll within ch. 5
  if (projectsRail && projectsRailViewport) {
    const ch = CHAPTERS[4]; // projects
    const u = clamp((s - ch.start) / (ch.end - ch.start), 0, 1);
    const eased = easeInOut(u);
    const railW = projectsRail.scrollWidth;
    const portW = projectsRailViewport.clientWidth;
    const maxX = Math.max(0, railW - portW);
    projectsRail.style.transform = `translate3d(${(-eased * maxX).toFixed(1)}px, 0, 0)`;
  }

  // Chapter nav: light up the dot whose range contains s
  let activeId = null;
  for (const c of CHAPTERS) {
    if (s >= c.start - 0.02 && s <= c.end + 0.04) { activeId = c.id; }
  }
  for (const li of chapterNavItems) {
    li.classList.toggle("is-active", li.dataset.chapter === activeId);
  }

  // Hide the scroll indicator after engagement
  if (scrollIndicatorEl) {
    scrollIndicatorEl.style.opacity = (1 - smoothstep(0.02, 0.12, s)).toFixed(3);
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
const tmpBulb = new THREE.Vector3();
let lastTime = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  state.time += dt;

  // ── Smooth (inertial) scroll & mouse ──
  state.scroll  += (state.scrollTarget - state.scroll)  * damp(4.2, dt);
  state.mouse.x += (state.mouse.tx - state.mouse.x)     * damp(5.5, dt);
  state.mouse.y += (state.mouse.ty - state.mouse.y)     * damp(5.5, dt);

  const s = state.scroll;

  // Per-chapter envelopes (used to gate effects)
  const envLight    = chapterEnvelope(s, 0.00, 0.12);
  const envDoor     = chapterEnvelope(s, 0.13, 0.27);
  const envReveal   = chapterEnvelope(s, 0.30, 0.43);
  const envServices = chapterEnvelope(s, 0.46, 0.61);
  const envProjects = chapterEnvelope(s, 0.64, 0.78);
  const envMagic    = chapterEnvelope(s, 0.81, 0.91);
  const envEnding   = chapterEnvelope(s, 0.94, 1.00, 0.02);

  // Kitchen lights are alive once we cross the threshold (~ chapter 3 onward),
  // and dim again at the very end.
  const kitchenAlive = clamp(
    smoothstep(0.30, 0.45, s) * (1 - smoothstep(0.91, 0.96, s)),
    0, 1
  );

  // ── Bulb anchor (the "guide") ──
  const [bx, by, bz] = sampleTrack(BULB_KEYS, s);
  const prevAZ = bulbAnchor.position.z;
  bulbAnchor.position.set(bx + state.mouse.x * 0.05, by, bz);
  const anchorVZ = (bulbAnchor.position.z - prevAZ) / Math.max(dt, 1e-4);

  // ── Bulb pendulum (two-axis, spring + viscous damping) ──
  const G = 9.0, damping = 1.6;
  const aX = -(G / CABLE_LEN) * Math.sin(state.bulb.sX) - state.bulb.vX * damping;
  state.bulb.vX += aX * dt;
  state.bulb.sX += state.bulb.vX * dt;
  const aZ = -(G / CABLE_LEN) * Math.sin(state.bulb.sZ) - state.bulb.vZ * damping;
  state.bulb.vZ += aZ * dt;
  state.bulb.sZ += state.bulb.vZ * dt;
  // Force injection: cursor → swing, anchor velocity → drag
  state.bulb.vX += state.mouse.x * 0.07 * dt;
  state.bulb.vZ += -anchorVZ * 0.16;
  bulbPivot.rotation.z = state.bulb.sX;
  bulbPivot.rotation.x = state.bulb.sZ;

  // ── Camera (sample keyframes; small cursor parallax) ──
  const [cx, cy, cz, lx, ly, lz, fov] = sampleTrack(CAM_KEYS, s);
  const camTargetX = cx + state.mouse.x * 0.25;
  camera.position.x += (camTargetX - camera.position.x) * damp(3.0, dt);
  camera.position.y = cy + state.mouse.y * 0.10;
  camera.position.z = cz;
  camera.lookAt(lx + state.mouse.x * 0.10, ly + state.mouse.y * 0.05, lz);
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  // ── Light envelope (main bulb) ──
  // Soft fade-in at top (chapter 1 builds glow), peak through journey,
  // gentle dim in ending — but never fully off until the last beat.
  let env = 1.0;
  env *= smoothstep(0.0, 0.08, s);          // chapter 1 wake-up
  env *= 1 - smoothstep(0.97, 1.00, s);     // final extinguish
  // Slight extra fade as we travel through the kitchen (the protagonist
  // shares the stage with pendants there).
  env *= 1 - 0.18 * kitchenAlive;
  const flicker = 1
    + Math.sin(state.time * 2.4) * 0.012
    + Math.sin(state.time * 6.7) * 0.008;
  state.lightEnv = env;

  bulbLight.intensity        = 4.6 * env * flicker;
  bulbFill.intensity         = 0.9 * env * flicker;
  bulbMat.emissiveIntensity  = 3.8 * env * flicker;
  filament.material.color.setRGB(1.0 * env, 0.9 * env, 0.72 * env);
  scene.fog.density          = lerp(0.07, 0.16, 1 - env);

  // Position bulb light + fill at the swung bulb's world position
  bulbGroup.getWorldPosition(tmpBulb);
  bulbLight.position.copy(tmpBulb);
  bulbFill.position.copy(tmpBulb);

  // Light cone follows the bulb
  lightCone.position.copy(tmpBulb);
  lightCone.rotation.z = state.bulb.sX * 0.6;
  lightCone.rotation.x = state.bulb.sZ * 0.6;
  coneMat.uniforms.uIntensity.value = env * 0.95;

  // ── Smart doors: keyframe baseline + cursor amplification in chapter 2 ──
  const [doorKeyOpen] = sampleTrack(DOOR_KEYS, s);
  const mDist = Math.hypot(state.mouse.x, state.mouse.y * 0.9);
  const proximity = clamp(1 - mDist * 1.05, 0, 1);
  const cursorBoost = Math.pow(proximity, 1.6) * envDoor * 0.4;
  state.doorTarget = clamp(doorKeyOpen + cursorBoost, 0, 1);
  const openingRate = state.doorTarget > state.doorOpen ? 2.4 : 1.6;
  state.doorOpen += (state.doorTarget - state.doorOpen) * damp(openingRate, dt);

  const maxAngle = Math.PI * 0.34;
  leftPivot.rotation.y  =  state.doorOpen * maxAngle;
  rightPivot.rotation.y = -state.doorOpen * maxAngle;

  // Handle glow — proximity in chapter 2 + the final reveal moment
  const handleGlow = clamp(
    proximity * envDoor * 1.6 + state.doorOpen * 0.4 + envEnding * 1.2,
    0, 2.6
  );
  handleL.grip.material.emissiveIntensity = handleGlow;
  handleR.grip.material.emissiveIntensity = handleGlow;

  // Light leak — both during chapter 2 anticipation and the final reveal
  const leakBase = (envDoor * (0.4 + proximity * 0.8))
                 + envEnding * 1.4;
  leakLight.intensity = leakBase * 2.0 + state.doorOpen * 6.5;

  // Seam glow visible only when doors are nearly shut and active
  seamMat.opacity = clamp(leakBase * (1 - state.doorOpen) * 0.9, 0, 1);

  // ── Kitchen pendants & backsplash come alive in the kitchen ──
  for (const p of pendants) {
    p.bulbMat.emissiveIntensity = 2.4 * kitchenAlive * flicker;
  }
  for (let i = 0; i < pendantLights.length; i++) {
    pendantLights[i].intensity = 1.6 * kitchenAlive * flicker;
  }
  backsplashStrip.material.opacity = 0.7 * kitchenAlive;
  backsplashLight.intensity = 0.8 * kitchenAlive;

  // ── Sweeping spotlight during chapter 3 ──
  // Position oscillates across the room; intensity peaks mid-chapter.
  const sweepU = clamp((s - 0.30) / (0.43 - 0.30), 0, 1);
  // Arc from -3 to +3 across the chapter, with a slight overshoot/return
  const sweepX = Math.sin(sweepU * Math.PI) * 3.2 - 1.6 * (1 - Math.cos(sweepU * Math.PI));
  const sweepIntensity = envReveal * 8.0 * Math.sin(sweepU * Math.PI);
  sweepLight.position.set(sweepX, 4.8, -10.0);
  sweepLight.target.position.set(sweepX * 0.6, 0.5, -16);
  sweepLight.target.updateMatrixWorld();
  sweepLight.intensity = sweepIntensity;

  // ── Floating elements during chapter 6 ──
  const floatVis = envMagic;
  for (let i = 0; i < floaters.length; i++) {
    const m = floaters[i];
    const u = m.userData;
    m.position.y = u.yBase + Math.sin(state.time * u.bobRate + u.phase) * u.bobAmp;
    m.rotation.y += u.rotRate * dt;
    m.rotation.x += u.rotRate * 0.3 * dt;
    m.material.opacity = 0.85 * floatVis;
    m.visible = floatVis > 0.005;
  }

  // ── Dust ──
  const positions = dust.geometry.attributes.position.array;
  for (let i = 0; i < DUST_COUNT; i++) {
    const ix = i * 3;
    positions[ix]     += dustVel[ix]     + Math.sin(state.time * 0.6 + i) * 0.0004;
    positions[ix + 1] += dustVel[ix + 1] * (0.6 + state.lightEnv * 0.6);
    positions[ix + 2] += dustVel[ix + 2] + Math.cos(state.time * 0.5 + i) * 0.0004;
    if (positions[ix + 1] > 4.9) {
      positions[ix + 1] = 0;
      positions[ix]     = (Math.random() - 0.5) * 11;
      positions[ix + 2] = -Math.random() * 22 + 2;
    }
  }
  dust.geometry.attributes.position.needsUpdate = true;
  dustMat.opacity = clamp(
    0.30 * state.lightEnv
      + state.doorOpen * 0.20
      + proximity * envDoor * 0.18
      + envMagic * 0.15,
    0, 0.8
  );

  // ── Bloom + tone-mapping envelopes ──
  bloom.strength = 0.55 + 0.55 * state.lightEnv + 0.15 * envEnding;
  renderer.toneMappingExposure = 0.78 + 0.42 * state.lightEnv;

  // ── HTML overlay + projects rail + chapter nav ──
  updateOverlay(s);

  composer.render();
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// A small kick to wake the pendulum on load
state.bulb.vX = 0.18;
state.bulb.vZ = -0.05;
