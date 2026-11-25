// Foliage building blocks.
//  - a single beech leaf as real geometry (folded along the midrib, drooping tip, petiole), instanced
//    along generated twigs for the hero trees
//  - twig-spray and bough cards (alpha-cut renders of whole twigs with alternate leaves) for the forest
// Both share one shading model: two-sided, paler underside, back-lit translucency, per-instance tint,
// and the wind hierarchy (branch sway from the instance's sway weight + leaf flutter).
import * as THREE from 'three';
import { tex, A } from './textures.js';
import { chain, wind, worldPos, dapple, underwater, G } from './shaders.js';

// Mirrors tools/make_leaves.py
const LEAF_V0 = 0.07, LEAF_V1 = 0.95;
const leafHalfWidth = (t) => 0.30 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(t, 0.8))), 0.85) * (1 - 0.22 * t * t);

export function leafGeometry() {
  // Local frame: petiole base at the origin, leaf runs along +Y (unit length), upper face toward +Z.
  const pet = 0.12, blade = 1 - pet;
  const st = [0, 0.3, 0.66, 1.0];
  const pos = [], uv = [], idx = [];
  const L = LEAF_V1 - LEAF_V0;
  for (let i = 0; i < st.length; i++) {
    const t = st[i];
    const hw = Math.max(0.03, leafHalfWidth(t) * 1.16) * (t === 0 ? 4 : 1);
    const y = pet + t * blade;
    const droop = -0.16 * t * t + 0.03 * t;             // tip curls down
    const fold = 0.26;                                   // V-fold along the midrib
    for (let s = -1; s <= 1; s++) {
      const x = s * hw * blade;
      pos.push(x, y, droop * blade + Math.abs(s) * hw * blade * fold);
      uv.push(0.5 + s * hw * L / 0.5, LEAF_V0 + t * L);
    }
  }
  for (let i = 0; i < st.length - 1; i++) {
    const a = i * 3;
    idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3, a + 1, a + 2, a + 4, a + 2, a + 5, a + 4);
  }
  // petiole: a thin strip textured from the midrib
  const b = pos.length / 3, pw = 0.012;
  pos.push(-pw, 0, 0, pw, 0, 0, -pw, pet + 0.02, 0.004, pw, pet + 0.02, 0.004);
  uv.push(0.495, 0.3, 0.505, 0.3, 0.495, 0.34, 0.505, 0.34);
  idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function cardGeometry(segs = 3, bend = 0.16, cup = 0.1) {
  // Anchored at the bottom centre (the twig base), length along +Y, face toward +Z; droops and cups slightly.
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segs; j++) for (let i = 0; i <= segs; i++) {
    const u = i / segs, v = j / segs, x = u - 0.5;
    pos.push(x, v, -bend * v * v + cup * (0.25 - x * x) * 2 * v);
    uv.push(u, v);
  }
  for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
    const a = j * (segs + 1) + i, b = a + segs + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function atlasPatch(mat, cols, rows, key) {
  return chain(mat, 'atlas' + key + cols + rows, (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVar;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = (vMapUv + vec2(mod(aVar, ${cols.toFixed(1)}), floor(aVar / ${cols.toFixed(1)}))) / vec2(${cols.toFixed(1)}, ${rows.toFixed(1)});
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = (vNormalMapUv + vec2(mod(aVar, ${cols.toFixed(1)}), floor(aVar / ${cols.toFixed(1)}))) / vec2(${cols.toFixed(1)}, ${rows.toFixed(1)});
        #endif`);
  });
}

function foliageShading(mat, { card, dry = false }) {
  worldPos(mat);
  chain(mat, 'foliage' + card + dry, (s) => {
    Object.assign(s.uniforms, { uSunDirF: G.uSunDir });
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirF;\nfloat fBack;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${card ? `{
          // keep coverage as the cut-out minifies, so distant crowns stay dense instead of dissolving
          vec2 tuv = vMapUv * vec2(textureSize(map, 0));
          float lod = max(0.0, 0.5 * log2(max(dot(dFdx(tuv), dFdx(tuv)), dot(dFdy(tuv), dFdy(tuv)))));
          diffuseColor.a *= 1.0 + lod * 0.42;
        }` : ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 sv = normalize((viewMatrix * vec4(uSunDirF, 0.0)).xyz);
          float nl = dot(normal, sv);
          // the sun is on the far side of the blade: light it from behind, tinted by the leaf
          fBack = smoothstep(0.05, -0.2, nl);
          vec3 base = diffuseColor.rgb;
          vec3 under = mix(base, vec3(dot(base, vec3(0.3, 0.6, 0.1))) * vec3(0.9, 1.0, 0.72), 0.3) * 0.78;
          if (!gl_FrontFacing) diffuseColor.rgb = under;
          vec3 trans = min(base * vec3(1.05, 1.45, 0.4), vec3(0.3, 0.6, 0.13));   // transmission is the leaf's own colour, never white
          ${dry ? 'trans = base * vec3(1.15, 0.9, 0.5); if (!gl_FrontFacing) diffuseColor.rgb = base * 1.1;' : ''}
          diffuseColor.rgb = mix(diffuseColor.rgb, trans, fBack);
          normal = mix(normal, -normal, step(nl, 0.0));
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directSpecular *= (1.0 - fBack) * (gl_FrontFacing ? 1.0 : 0.3) * ${card ? '0.25' : '0.6'};
        reflectedLight.indirectSpecular *= ${card ? '0.3' : '0.6'};`);
  });
  dapple(mat);
  return mat;
}

function depthMaterial(map, cols, rows, flutter) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: map ? 0.4 : 0, side: THREE.DoubleSide });
  if (map) atlasPatch(d, cols, rows, 'd');
  wind(d, { mode: 'inst', flutter });
  return d;
}

let leafMats = null;
export function leafMaterials() {
  if (leafMats) return leafMats;
  const map = tex(A('leaf_atlas.webp'), { repeat: false });
  const nrm = tex(A('leaf_atlas_n.jpg'), { srgb: false, repeat: false });
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.54, metalness: 0, envMapIntensity: 0.55,
  });
  atlasPatch(mat, 4, 1, 'm');
  foliageShading(mat, { card: false });
  wind(mat, { mode: 'inst', flutter: 0.16 });
  // Leaf outlines are real geometry, so the shadow pass needs no texture.
  const depth = depthMaterial(null, 4, 1, 0.16);
  return (leafMats = { mat, depth });
}

const cardMats = {};
export function cardMaterials(name, cols, rows) {
  if (cardMats[name]) return cardMats[name];
  const map = tex(A(`${name}.webp`), { repeat: false });
  const nrm = tex(A(`${name}_n.jpg`), { srgb: false, repeat: false });
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap: nrm, normalScale: new THREE.Vector2(1.0, 1.0), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.8, metalness: 0, envMapIntensity: 0.4,
  });
  atlasPatch(mat, cols, rows, 'm');
  foliageShading(mat, { card: true });
  wind(mat, { mode: 'inst', flutter: 0.035 });
  const depth = depthMaterial(map, cols, rows, 0.035);
  return (cardMats[name] = { mat, depth });
}

// Every instanced plant mesh registers here. Instances are in random order, so drawing a prefix is an even
// thinning of the whole: setDetail() is the geometry half of the dynamic quality control.
export const lodMeshes = [];
export function registerLod(mesh) { mesh.userData.fullCount = mesh.count; mesh.userData.liveCount = mesh.count; lodMeshes.push(mesh); return mesh; }
export function setDetail(f) {
  for (const m of lodMeshes) { m.userData.liveCount = Math.max(1, Math.floor(m.userData.fullCount * f)); m.count = m.userData.liveCount; }
}

// Collects instances (matrix, tint, sway weight, variant) and turns them into an InstancedMesh.
export class Instances {
  constructor() { this.m = []; this.c = []; this.s = []; this.v = []; this.count = 0; }
  add(mat4, r, g, b, sway, phase, variant) {
    const e = mat4.elements;
    for (let i = 0; i < 16; i++) this.m.push(e[i]);
    this.c.push(r, g, b); this.s.push(sway, phase); this.v.push(variant);
    this.count++;
  }
  // Instances are shuffled, so any prefix is an even subsample of the whole: the shadow and mirror passes
  // draw only a fraction (which also leaves the gaps a real crown has, letting sun-flecks through).
  build(geometry, materials, { castShadow = true, receiveShadow = true, shadowFrac = 1, mirrorFrac = 1 } = {}) {
    const n = this.count, order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    let seed = 12345;
    for (let i = n - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const M = new Float32Array(n * 16), C = new Float32Array(n * 3), S = new Float32Array(n * 2), Vv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = order[i];
      for (let q = 0; q < 16; q++) M[i * 16 + q] = this.m[k * 16 + q];
      C[i * 3] = this.c[k * 3]; C[i * 3 + 1] = this.c[k * 3 + 1]; C[i * 3 + 2] = this.c[k * 3 + 2];
      S[i * 2] = this.s[k * 2]; S[i * 2 + 1] = this.s[k * 2 + 1]; Vv[i] = this.v[k];
    }
    const g = geometry.clone();
    g.setAttribute('aSway', new THREE.InstancedBufferAttribute(S, 2));
    g.setAttribute('aVar', new THREE.InstancedBufferAttribute(Vv, 1));
    const mesh = new THREE.InstancedMesh(g, materials.mat, n);
    mesh.instanceMatrix.array.set(M);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(C, 3);
    mesh.customDepthMaterial = materials.depth;
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    mesh.computeBoundingSphere();
    mesh.boundingSphere.radius += 2;
    registerLod(mesh);
    if (shadowFrac < 1) {
      mesh.onBeforeShadow = () => { mesh.count = Math.floor(mesh.userData.liveCount * shadowFrac); };
      mesh.onAfterShadow = () => { mesh.count = mesh.userData.liveCount; };
    }
    mesh.userData.mirrorFrac = mirrorFrac;
    this.m = this.c = this.s = this.v = null;
    return mesh;
  }
}

// Ground plants (photoscanned cards/meshes with alpha): same translucent shading, wind grows with height.
export function plantMaterials(dir, { amount = 0.05, flutter = 0.004, tint = [1, 1, 1], normalScale = 1, shadow = true } = {}) {
  const map = tex(A(`models/${dir}/diff.webp`), { repeat: false, flipY: false });
  const nrm = tex(A(`models/${dir}/nor.jpg`), { srgb: false, repeat: false, flipY: false });
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap: nrm, normalScale: new THREE.Vector2(normalScale, normalScale), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.6, metalness: 0, envMapIntensity: 0.8, color: new THREE.Color(...tint),
  });
  foliageShading(mat, { card: true });
  wind(mat, { mode: 'height', amount, flutter });
  let depth = null;
  if (shadow) {
    depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.4, side: THREE.DoubleSide });
    wind(depth, { mode: 'height', amount, flutter });
  }
  return { mat, depth };
}

// Fallen and falling leaves: the same leaf mesh, no wind, tinted per instance.
let litterMats = null;
export function litterMaterials() {
  if (litterMats) return litterMats;
  const map = tex(A('leaf_atlas.webp'), { repeat: false });
  const nrm = tex(A('leaf_atlas_n.jpg'), { srgb: false, repeat: false });
  const mat = new THREE.MeshStandardMaterial({ map, normalMap: nrm, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, envMapIntensity: 0.35 });
  underwater(mat, { wet: false });
  atlasPatch(mat, 4, 1, 'm');
  // dead leaves: keep the veins and blotches, lose the chlorophyll; the instance colour supplies the hue
  chain(mat, 'dry', (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb = vec3(min(pow(dot(diffuseColor.rgb, vec3(0.4, 0.5, 0.1)) * 9.0, 1.5), 1.1));`);
  });
  foliageShading(mat, { card: false, dry: true });
  return (litterMats = { mat, depth: null });
}
