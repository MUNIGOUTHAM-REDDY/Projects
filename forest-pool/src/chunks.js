// Open-world style visibility. Every large set of instances is split into a grid of chunks, one InstancedMesh
// per chunk with a tight bounding sphere, so three.js frustum-culls it per pass (main camera, shadow camera,
// mirror camera). A few times a second each chunk's level of detail is re-evaluated from its distance to the
// camera: instances are stored in an order where any prefix is an even sample, so "less detail" is just a
// smaller draw count, and beyond its range a chunk is not drawn at all.
import * as THREE from 'three';
import { TIER } from './tier.js';

const chunks = [];
let lastT = -1;
const lastPos = new THREE.Vector3(1e9, 0, 0);
const SHADOW = { x: 0, z: 0, r: 30 };
export function setShadowArea(x, z, r) { SHADOW.x = x; SHADOW.z = z; SHADOW.r = r; }
let detail = 1;
export function setDetail(f) { detail = f; lastT = -1; }

// lod: { full, zero, min, shadow, mirror, mirrorDist, adaptive }
//   full/zero: distance (m) up to which everything is drawn / at which only `min` (a fraction, 0 = nothing) remains
//   shadow / mirror: fraction drawn into the shadow map / the water reflection (0 = not at all)
function register(mesh, centre, radius, lod, n) {
  const c = { mesh, centre, radius, lod: { full: 1e9, zero: 1e9, min: 0, shadow: 0, mirror: 0, mirrorDist: 1e9, adaptive: false, ...lod }, n, frac: -1, live: n, d: 0 };
  if (mesh.isInstancedMesh) c.lod.mirror *= TIER.mirrorK;
  if (!TIER.foliageShadows && c.lod.adaptive) c.lod.shadow = 0;      // phones: the canopy gobo stands in for leaf shadows
  c.lod.full *= TIER.dist; c.lod.zero *= TIER.dist; if (c.lod.mirrorDist < 1e8) c.lod.mirrorDist *= TIER.dist;
  mesh.userData.chunk = c; mesh.userData.tag = c.lod.tag || 'chunk';
  // only chunks inside the sun's shadow box ever cast
  const inShadow = Math.hypot(centre.x - SHADOW.x, centre.z - SHADOW.z) < SHADOW.r * 1.25 + radius;
  mesh.castShadow = c.lod.shadow > 0 && inShadow;
  if (mesh.isInstancedMesh && mesh.castShadow && c.lod.shadow < 1) {
    mesh.onBeforeShadow = () => { mesh.count = Math.max(1, Math.floor(c.live * c.lod.shadow)); };
    mesh.onAfterShadow = () => { mesh.count = c.live; };
  }
  chunks.push(c);
  lastT = -1; lastPos.set(1e9, 0, 0);       // re-evaluate on the next frame
  return c;
}

// A plain mesh (merged wood of one forest cell, a boulder...) that should simply stop being drawn far away.
export function registerMesh(mesh, lod = {}) {
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const s = mesh.geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld.identity().compose(mesh.position, mesh.quaternion, mesh.scale));
  return register(mesh, s.center, s.radius, lod, 1);
}

// Split instances into chunks. data: { n, M (n*16 matrices), C (n*3 colours, optional), attrs: { name: [Float32Array, itemSize] }, key (optional sort key: larger first) }
export function buildChunks(geometry, material, data, { cell = 16, lod = {}, depthMaterial = null, receiveShadow = true, pad = 1.2 } = {}) {
  const group = new THREE.Group();
  const { n, M, C, attrs = {}, key = null } = data;
  if (!n) return group;
  cell *= TIER.cellScale;                       // weaker devices: fewer, larger batches
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.floor(M[i * 16 + 12] / cell) + ',' + Math.floor(M[i * 16 + 14] / cell);
    let a = cells.get(k); if (!a) cells.set(k, (a = []));
    a.push(i);
  }
  let seed = 12345;
  for (const ids of cells.values()) {
    if (key) ids.sort((a, b) => key[b] - key[a]);
    else for (let i = ids.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    const m = ids.length;
    const g = geometry.clone();
    const mesh = new THREE.InstancedMesh(g, material, m);
    const im = mesh.instanceMatrix.array;
    const box = new THREE.Box3(), p = new THREE.Vector3();
    let maxS = 0;
    for (let q = 0; q < m; q++) {
      const s = ids[q] * 16;
      for (let e = 0; e < 16; e++) im[q * 16 + e] = M[s + e];
      box.expandByPoint(p.set(M[s + 12], M[s + 13], M[s + 14]));
      maxS = Math.max(maxS, Math.hypot(M[s], M[s + 1], M[s + 2]), Math.hypot(M[s + 4], M[s + 5], M[s + 6]));
    }
    if (C) {
      const c = new Float32Array(m * 3);
      for (let q = 0; q < m; q++) { c[q * 3] = C[ids[q] * 3]; c[q * 3 + 1] = C[ids[q] * 3 + 1]; c[q * 3 + 2] = C[ids[q] * 3 + 2]; }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(c, 3);
    }
    for (const name in attrs) {
      const [src, size] = attrs[name], a = new Float32Array(m * size);
      for (let q = 0; q < m; q++) for (let e = 0; e < size; e++) a[q * size + e] = src[ids[q] * size + e];
      g.setAttribute(name, new THREE.InstancedBufferAttribute(a, size));
    }
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius += geometry.boundingSphere.radius * maxS + pad;      // instance extent + wind
    mesh.boundingSphere = sphere;
    mesh.frustumCulled = true;
    mesh.receiveShadow = receiveShadow;
    if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
    register(mesh, sphere.center.clone(), sphere.radius, lod, m);
    group.add(mesh);
  }
  return group;
}

// Re-evaluate levels of detail. Cheap (a few hundred distance tests) and only run a few times a second.
export function updateChunks(camera, time, force = false) {
  if (!force && Math.abs(time - lastT) < 0.25 && lastPos.distanceToSquared(camera.position) < 4) return;
  lastT = time; lastPos.copy(camera.position);
  for (const c of chunks) {
    const d = Math.max(0, c.centre.distanceTo(camera.position) - c.radius);
    c.d = d;
    const { full, zero, min } = c.lod;
    let f = d <= full ? 1 : d >= zero ? min : 1 - (1 - min) * (d - full) / (zero - full);
    if (min > 0 && d > zero * 2.2 && c.lod.hide !== false) f = c.lod.keepFar ? min : 0;
    // hysteresis: a chunk that is already hidden stays hidden until clearly back inside its range; small changes are ignored
    if (c.frac === 0 && d > zero * 0.94 && min === 0) f = 0;
    if (c.frac >= 0 && f > 0 && c.frac > 0 && Math.abs(f - c.frac) < 0.07 && f !== 1) continue;
    c.frac = f;
    const k = c.lod.adaptive ? detail : 1;
    c.live = c.mesh.isInstancedMesh ? Math.floor(c.n * f * k) : (f > 0 ? 1 : 0);
    c.mesh.visible = c.live > 0;
    if (c.mesh.isInstancedMesh) c.mesh.count = Math.max(1, c.live);
  }
}

// The water's mirror pass draws a reduced world: big shapes only, thinned.
const saved = [];
export function mirrorBegin() {
  saved.length = 0;
  for (const c of chunks) {
    const m = c.mesh;
    saved.push(m.visible);
    if (!m.visible) continue;
    if (c.lod.mirror <= 0 || c.d > c.lod.mirrorDist) { m.visible = false; continue; }
    if (m.isInstancedMesh) m.count = Math.max(1, Math.floor(c.live * c.lod.mirror));
  }
}
export function mirrorEnd() {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    c.mesh.visible = saved[i];
    if (c.mesh.isInstancedMesh) c.mesh.count = Math.max(1, c.live);
  }
}
export const chunkStats = () => ({ chunks: chunks.length, visible: chunks.filter((c) => c.mesh.visible).length });
