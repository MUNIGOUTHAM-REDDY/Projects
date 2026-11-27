import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { G } from './shaders.js';
import { manager, setAnisotropy } from './textures.js';
import { heightAt, WATER_Y } from './world.js';
import { buildBake, buildSplat, buildCanopy } from './bake.js';
import { createTerrain } from './terrain.js';
import { createWater, excludeFromReflection } from './water.js';
import { createTrees } from './trees.js';
import { createGroundCover } from './vegetation.js';
import { createRocks } from './rocks.js';
import { createFallingLeaves } from './leaves.js';
import { createMotes, createSky, FOG_COLOR } from './atmosphere.js';
import { createPipeline } from './post.js';
import { setDetail, updateChunks, setShadowArea, chunkStats } from './chunks.js';
import { TIER, QUALITY, IS_TOUCH } from './tier.js';
import { modelJobs } from './models.js';

const params = new URLSearchParams(location.search);
const STILL = params.has('still');
const isMobile = IS_TOUCH || TIER.name === 'mobile';
const quality = TIER.name;
const flag = (k) => params.get(k) !== '0';

// --- Renderer -------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: STILL });
const SS = Number(params.get('ss') || 0);
// Phones have dense screens but weak GPUs: render at a steady 1.5x there rather than starting high and collapsing.
renderer.setPixelRatio(SS || Math.min(devicePixelRatio, TIER.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(params.get('exp') || 1.22);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, Number(params.get("fog") || 0.0105));

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);

// --- Light ----------------------------------------------------------------
const SUN_COLOR = new THREE.Color(1.0, 0.89, 0.72);
const sun = new THREE.DirectionalLight(SUN_COLOR, Number(params.get('sun') || 11));
const sunTarget = new THREE.Object3D();
sunTarget.position.set(-0.5, 0, -1.5);
G.uShadowCentre.value.copy(sunTarget.position);
const SHADOW_HALF = TIER.shadowHalf;
setShadowArea(sunTarget.position.x, sunTarget.position.z, SHADOW_HALF);
G.uShadowRadius.value = SHADOW_HALF;
scene.add(sunTarget);
sun.target = sunTarget;
sun.position.copy(sunTarget.position).addScaledVector(G.uSunDir.value, 80);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(TIER.shadowSize);
const sc = sun.shadow.camera;
sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF; sc.near = 20; sc.far = 150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 1.3;
scene.add(sun);

// --- World ----------------------------------------------------------------
buildBake();
const trees = createTrees(quality);
buildCanopy(trees.userData.crowns);
const rocks = createRocks(quality);
const cover = createGroundCover(quality);
const splat = buildSplat([...(trees.userData.contacts || []), ...(cover.userData.contacts || [])]);
const terrain = createTerrain(quality, splat);
const water = createWater(quality, sun);
const falling = createFallingLeaves(quality);
const motes = createMotes(TIER.name === 'high' ? 600 : TIER.name === 'low' ? 300 : 120);
const sky = createSky();
{
  // Image-based light from a canopy-filtered sky, so shade picks up green forest light.
  const envScene = new THREE.Scene();
  envScene.add(createSky({ forEnv: true }));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = Number(params.get('env') || 1.6);
  pmrem.dispose();
}
scene.add(sky, terrain, water, trees, rocks, cover, falling, motes);
excludeFromReflection(water, [motes, falling], STILL);
// The far ring of trees is grown after the first frames (all at once for a still capture).
trees.userData.stream(STILL);

const pipeline = createPipeline({ renderer, scene, camera, water, sun, quality, still: STILL });
if (!flag('ao')) pipeline.scenePass.ao = false;
if (!flag('vol')) pipeline.scenePass.volumetrics = false;
if (!flag('dof') || isMobile) pipeline.scenePass.dof = false;
// Film grain reads as noise/shimmer on small, lower-resolution phone renders.
if (isMobile) pipeline.grade.uniforms.uGrain.value = 0.0;

// --- Camera presets & controls -------------------------------------------
const PRESETS = {
  trail: { label: 'Trail', pos: [0.25, 1.72, 8.4], target: [-0.45, 1.5, -3.0], fov: 60, focus: 9 },
  edge: { label: "Water's edge", pos: [0.25, 0.5, 1.5], target: [1.6, 0.35, -9.0], fov: 52, focus: 7 },
  farbank: { label: 'Far bank', pos: [-5.4, 1.25, -6.4], target: [3.0, 0.4, -11.5], fov: 56, focus: 9 },
  canopy: { label: 'Canopy', pos: [-1.4, 1.2, 6.2], target: [-3.2, 8.5, 2.6], fov: 68, focus: 7 },
  above: { label: 'Above', pos: [-6.4, 11.5, -1.6], target: [1.8, 0, -8.5], fov: 52, focus: 15 },
};

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxDistance = 60;
controls.minDistance = 0.3;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.8;

let tween = null;
let focus = 9;
let baseFov = 56;
function applyFov() {
  const minV = 2 * Math.atan(Math.tan((72 * Math.PI) / 360) / camera.aspect) * 180 / Math.PI;
  camera.fov = Math.min(88, Math.max(baseFov, minV));
  camera.updateProjectionMatrix();
}
function setPreset(name, instant = false) {
  const p = PRESETS[name];
  if (!p) return;
  const from = { pos: camera.position.clone(), target: controls.target.clone(), fov: baseFov, focus };
  const to = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target), fov: p.fov, focus: p.focus };
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.preset === name));
  if (instant) {
    camera.position.copy(to.pos); controls.target.copy(to.target); baseFov = to.fov; applyFov(); focus = to.focus;
    tween = null;
    return;
  }
  tween = { from, to, t: 0, dur: 2.6 };
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
controls.addEventListener('start', () => { tween = null; focus = -1; });

// WASD / arrow keys walk the camera and its focus point together.
const keys = new Set();
addEventListener('keydown', (e) => { if (!e.target.closest('input')) keys.add(e.key.toLowerCase()); });
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
function walk(dt) {
  if (!keys.size) return;
  const f = new THREE.Vector3().subVectors(controls.target, camera.position); f.y = 0; f.normalize();
  const rgt = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
  const mv = new THREE.Vector3();
  if (keys.has('w') || keys.has('arrowup')) mv.add(f);
  if (keys.has('s') || keys.has('arrowdown')) mv.sub(f);
  if (keys.has('d') || keys.has('arrowright')) mv.add(rgt);
  if (keys.has('a') || keys.has('arrowleft')) mv.sub(rgt);
  if (keys.has('e')) mv.y += 1;
  if (keys.has('q')) mv.y -= 1;
  if (mv.lengthSq() === 0) return;
  mv.normalize().multiplyScalar(dt * (keys.has('shift') ? 6 : 2.2));
  camera.position.add(mv); controls.target.add(mv);
  tween = null; focus = -1;
}

function keepAboveGround() {
  const g = Math.max(heightAt(camera.position.x, camera.position.z), WATER_Y) + 0.22;
  if (camera.position.y < g) camera.position.y = g;
}

// --- UI -------------------------------------------------------------------
const ui = {
  loader: document.getElementById('loader'),
  bar: document.getElementById('loader-bar'),
  pct: document.getElementById('loader-pct'),
};
manager.onProgress = (_, loaded, total) => {
  const p = Math.round((loaded / total) * 100);
  if (ui.bar) ui.bar.style.transform = `scaleX(${p / 100})`;
  if (ui.pct) ui.pct.textContent = `${p}%`;
};
// Ready once every model has been turned into meshes and the textures those meshes asked for have arrived.
let ready = false, modelsDone = false, queueEmpty = false;
function start() {
  if (ready || !modelsDone || !queueEmpty) return;
  ready = true;
  ui.loader?.classList.add('done');
  if (STILL) {
    // Let shaders compile, the shadow map and the reflection settle before capture.
    let n = 0;
    const tick = () => { renderFrame(0); if (++n < 3) requestAnimationFrame(tick); else window.__ready = true; };
    requestAnimationFrame(tick);
  }
}
manager.onStart = () => { queueEmpty = false; };
manager.onLoad = () => { queueEmpty = true; start(); };
Promise.all(modelJobs).then(() => { modelsDone = true; start(); });

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
const toggles = {
  wind: (on) => (G.uWind.value = on ? 1 : 0),
  rays: (on) => { pipeline.scenePass.volumetrics = on; pipeline.scenePass.compMat.uniforms.uMist.value = on ? 1 : 0.4; motes.visible = on; },
  drift: (on) => { controls.autoRotate = on; controls.autoRotateSpeed = 0.3; },
};
document.querySelectorAll('[data-toggle]').forEach((b) => {
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    toggles[b.dataset.toggle](on);
  });
});
document.getElementById('hide-ui')?.addEventListener('click', () => document.body.classList.toggle('clean'));

// --- Loop -----------------------------------------------------------------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  pipeline.setSize(w, h);
  camera.aspect = w / h;
  applyFov();
}
addEventListener('resize', resize);
resize();

const shot = params.get('shot') || 'trail';
setPreset(PRESETS[shot] ? shot : 'trail', true);
if (STILL) {
  document.body.classList.add('clean', 'still');
  G.uTime.value = Number(params.get('t') || 14);
  if (params.has('cam')) {
    const [px, py, pz, tx, ty, tz, fov, fc] = params.get('cam').split(',').map(Number);
    camera.position.set(px, py, pz); controls.target.set(tx, ty, tz);
    if (fov) { baseFov = fov; applyFov(); }
    focus = fc || -1;
  }
}
falling.userData.update(0, STILL ? G.uTime.value : 0, true, camera, controls.target);

const clock = new THREE.Clock();
function renderFrame(dt) {
  if (!STILL) G.uTime.value += dt;
  if (tween) {
    tween.t += dt / tween.dur;
    const k = ease(Math.min(1, tween.t));
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, k);
    controls.target.lerpVectors(tween.from.target, tween.to.target, k);
    baseFov = THREE.MathUtils.lerp(tween.from.fov, tween.to.fov, k);
    focus = THREE.MathUtils.lerp(tween.from.focus > 0 ? tween.from.focus : tween.to.focus, tween.to.focus, k);
    applyFov();
    if (tween.t >= 1) tween = null;
  }
  walk(dt);
  controls.update(dt);
  keepAboveGround();
  if (!STILL) falling.userData.update(dt, G.uTime.value, false, camera, controls.target);
  updateChunks(camera, G.uTime.value, STILL);
  const cu = pipeline.scenePass.compMat.uniforms;
  // Presets carry a focus distance; when exploring freely, focus on the orbit target and ease the blur off.
  const want = focus > 0 ? focus : camera.position.distanceTo(controls.target);
  cu.uFocus.value += (want - cu.uFocus.value) * (dt > 0 ? Math.min(1, dt * 4) : 1);
  cu.uAperture.value = focus > 0 ? 1 : 0.6;
  pipeline.render(dt, G.uTime.value);
}
// Dynamic resolution: if the GPU cannot hold a smooth frame rate, trade pixels for it (and take them back when it can).
// Sharpness matters more than foliage density, so foliage is thinned first and resolution has a high floor.
// Resolution only ever steps down (never back up), so the image doesn't pulse between sharp and soft.
const PR_MAX = renderer.getPixelRatio(), PR_MIN = Math.min(PR_MAX, TIER.prMin);
const DETAIL_MIN = isMobile ? 0.25 : 0.45;
let ema = 1 / 60, sinceAdjust = 0, detail = 1;
function adapt(raw) {
  ema += (raw - ema) * 0.05;
  if (++sinceAdjust < 60) return;
  if (ema <= 1 / 28) return;
  const pr = renderer.getPixelRatio();
  // too slow: first thin the instanced foliage (it dominates the triangle count), then shed pixels
  if (detail > DETAIL_MIN) { detail = Math.max(DETAIL_MIN, detail - 0.15); setDetail(detail); sinceAdjust = 0; ema = 1 / 40; return; }
  if (pr > PR_MIN) { renderer.setPixelRatio(Math.max(PR_MIN, pr * 0.85)); resize(); sinceAdjust = 0; ema = 1 / 40; }
}
function loop() {
  const raw = clock.getDelta();
  const dt = Math.min(0.05, raw);
  if (ready && !STILL) { renderFrame(dt); if (document.visibilityState === 'visible' && raw < 2 && flag('adapt')) adapt(raw); }
  requestAnimationFrame(loop);
}
loop();

window.__scene = { THREE, scene, camera, controls, renderer, trees, setPreset, pipeline, sun, water, chunkStats, updateChunks, tier: TIER };
