import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { G } from './shaders.js';
import { manager, setAnisotropy, A } from './textures.js';
import { heightAt, WATER_Y } from './world.js';
import { createTerrain } from './terrain.js';
import { createWater, excludeFromReflection } from './water.js';
import { createTrees } from './trees.js';
import { createGrass, createFerns } from './vegetation.js';
import { createRocks } from './rocks.js';
import { createShafts, createMotes, createSky } from './atmosphere.js';

const params = new URLSearchParams(location.search);
const STILL = params.has('still');
const isMobile = matchMedia('(pointer: coarse)').matches;
let quality = params.get('q') || (isMobile ? 'low' : 'high');

// --- Renderer -------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: STILL });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'low' ? 1.25 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(new THREE.Color('#56703a'), 0.0095);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 400);

// --- Light ----------------------------------------------------------------
const SUN_COLOR = new THREE.Color(1.0, 0.94, 0.8);
const sun = new THREE.DirectionalLight(SUN_COLOR, 4.6);
const sunTarget = new THREE.Object3D();
sunTarget.position.set(-0.4, 0, -1.5);
scene.add(sunTarget);
sun.target = sunTarget;
sun.position.copy(sunTarget.position).addScaledVector(G.uSunDir.value, 60);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(quality === 'low' ? 2048 : 4096);
const sc = sun.shadow.camera;
sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24; sc.near = 20; sc.far = 110;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.025;
sun.shadow.radius = 3;
scene.add(sun);
const hemi = new THREE.HemisphereLight(new THREE.Color('#d8ecc0'), new THREE.Color('#2a2c20'), 0.22);
scene.add(hemi);

/* environment light is built from the sky dome after it is created (see below) */

// --- World ----------------------------------------------------------------
const terrain = createTerrain(quality);
const water = createWater(quality);
const trees = createTrees(quality);
const grass = createGrass(quality);
const ferns = createFerns(quality);
const rocks = createRocks(quality);
const shafts = createShafts();
const motes = createMotes(quality === 'low' ? 400 : 900);
const sky = createSky();
{
  // Image-based light from our own canopy sky, so shade picks up green forest light rather than blue sky.
  const envScene = new THREE.Scene();
  const envSky = createSky({ forEnv: true });
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();
}
scene.add(sky, terrain, water, trees, grass, ferns, rocks, shafts, motes);
excludeFromReflection(water, [grass, shafts, motes]);

// --- Post -----------------------------------------------------------------
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality === 'low' ? 0 : 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.65, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.32 }, uSat: { value: 1.1 }, uRes: { value: new THREE.Vector2() } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVig; uniform float uSat; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.3);
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVig * dot(d, d) * 2.2;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(grade);

// --- Camera presets & controls -------------------------------------------
const PRESETS = {
  trail: { label: 'Trail', pos: [-0.25, 1.7, 6.5], target: [-0.25, 0.12, -3.5], fov: 60 },
  edge: { label: "Water's edge", pos: [0.35, 0.42, 2.55], target: [-0.6, 0.15, -6], fov: 55 },
  farbank: { label: 'Far bank', pos: [1.2, 1.6, -7.4], target: [-0.4, 0.5, 3.0], fov: 58 },
  canopy: { label: 'Canopy', pos: [-0.5, 1.1, 3.3], target: [-1.3, 9.0, 0.2], fov: 72 },
  above: { label: 'Above', pos: [-0.4, 17, 6.5], target: [-0.4, 0, -2.2], fov: 50 },
};

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxDistance = 60;
controls.minDistance = 0.3;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.8;

function setPreset(name, instant = false) {
  const p = PRESETS[name];
  if (!p) return;
  const from = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };
  const to = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target), fov: p.fov };
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.preset === name));
  if (instant) {
    camera.position.copy(to.pos); controls.target.copy(to.target); camera.fov = to.fov; camera.updateProjectionMatrix();
    tween = null;
    return;
  }
  tween = { from, to, t: 0, dur: 2.4 };
}
let tween = null;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

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
  tween = null;
}

function keepAboveGround() {
  const g = Math.max(heightAt(camera.position.x, camera.position.z), WATER_Y) + 0.18;
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
let ready = false;
manager.onLoad = () => {
  ready = true;
  ui.loader?.classList.add('done');
  if (STILL) {
    // Let shaders compile and the reflection settle before capture.
    let n = 0;
    const tick = () => { renderFrame(0); if (++n < 4) requestAnimationFrame(tick); else window.__ready = true; };
    requestAnimationFrame(tick);
  }
};

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
const toggles = {
  wind: (on) => (G.uWind.value = on ? 1 : 0),
  rays: (on) => { shafts.visible = on; motes.visible = on; },
  drift: (on) => { controls.autoRotate = on; controls.autoRotateSpeed = 0.35; },
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
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const shot = params.get('shot') || 'trail';
setPreset(PRESETS[shot] ? shot : 'trail', true);
if (STILL) {
  document.body.classList.add('clean', 'still');
  G.uTime.value = Number(params.get('t') || 14);
  if (params.has('cam')) {
    const [px, py, pz, tx, ty, tz, fov] = params.get('cam').split(',').map(Number);
    camera.position.set(px, py, pz); controls.target.set(tx, ty, tz);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }
}

const clock = new THREE.Clock();
function renderFrame(dt) {
  if (!STILL) G.uTime.value += dt;
  if (tween) {
    tween.t += dt / tween.dur;
    const k = ease(Math.min(1, tween.t));
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, k);
    controls.target.lerpVectors(tween.from.target, tween.to.target, k);
    camera.fov = THREE.MathUtils.lerp(tween.from.fov, tween.to.fov, k);
    camera.updateProjectionMatrix();
    if (tween.t >= 1) tween = null;
  }
  walk(dt);
  controls.update(dt);
  keepAboveGround();
  composer.render(dt);
}
function loop() {
  const dt = Math.min(0.05, clock.getDelta());
  if (ready && !STILL) renderFrame(dt);
  requestAnimationFrame(loop);
}
loop();

window.__scene = { scene, camera, controls, renderer, trees, setPreset };
