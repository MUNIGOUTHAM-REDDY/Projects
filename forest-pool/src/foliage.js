// Foliage building blocks.
//  - a single beech leaf as real geometry (folded along the midrib, drooping tip, petiole), instanced
//    along generated twigs for the hero trees
//  - twig-spray and bough cards (alpha-cut renders of whole twigs with alternate leaves) for the forest
// Both share one shading model: two-sided, paler underside, back-lit translucency, per-instance tint,
// and the wind hierarchy (branch sway from the instance's sway weight + leaf flutter).
import * as THREE from 'three';
import { tex, A } from './textures.js';
import { chain, wind, worldPos, dapple, underwater, G } from './shaders.js';
import { buildChunks } from './chunks.js';
import { TIER } from './tier.js';

// Mirrors tools/make_leaves.py
const LEAF_V0 = 0.07, LEAF_V1 = 0.95;
const leafHalfWidth = (t) => 0.30 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(t, 0.8))), 0.85) * (1 - 0.22 * t * t);

export function leafGeometry({ petiole = true, flat = false } = {}) {
  // Local frame: petiole base at the origin, leaf runs along +Y (unit length), upper face toward +Z.
  // The outline comes from the texture's alpha, so the mesh only needs the fold and the droop: 8 triangles.
  const pet = 0.12, blade = 1 - pet;
  const st = flat ? [0, 1.0] : [0, 0.48, 1.0];                // fallen leaves: one folded quad pair is enough
  const pos = [], uv = [], idx = [];
  const L = LEAF_V1 - LEAF_V0;
  for (let i = 0; i < st.length; i++) {
    const t = st[i];
    const hw = flat ? 0.3 : i === 1 ? 0.3 : 0.2;
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
  if (petiole) {
    // a thin strip textured from the midrib
    const b = pos.length / 3, pw = 0.012;
    pos.push(-pw, 0, 0, pw, 0, 0, -pw, pet + 0.02, 0.004, pw, pet + 0.02, 0.004);
    uv.push(0.495, 0.3, 0.505, 0.3, 0.495, 0.34, 0.505, 0.34);
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function cardGeometry(segs = 3, bend = 0.16, cup = 0.1, segsU = segs) {
  // Anchored at the bottom centre (the twig base), length along +Y, face toward +Z; droops and cups slightly.
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segs; j++) for (let i = 0; i <= segsU; i++) {
    const u = i / segsU, v = j / segs, x = u - 0.5;
    pos.push(x, v, -bend * v * v + cup * (0.25 - x * x) * 2 * v);
    uv.push(u, v);
  }
  for (let j = 0; j < segs; j++) for (let i = 0; i < segsU; i++) {
    const a = j * (segsU + 1) + i, b = a + segsU + 1;
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
          diffuseColor.a *= 1.0 + lod * 0.2;
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

function depthMaterial(map, cols, rows, flutter, grow = 1) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: map ? 0.4 : 0, side: THREE.DoubleSide });
  if (map) atlasPatch(d, cols, rows, 'd');
  wind(d, { mode: 'inst', flutter });
  // only a fraction of the foliage is drawn into the shadow map; it is enlarged there so the shade stays as deep
  if (grow !== 1) chain(d, 'grow' + grow, (s) => { s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n transformed *= ${grow.toFixed(2)};`); });
  return d;
}

let leafMats = null;
export function leafMaterials() {
  if (leafMats) return leafMats;
  const map = tex(A('leaf_atlas.webp'), { repeat: false });
  const nrm = TIER.halfTextures ? null : tex(A('leaf_atlas_n.jpg'), { srgb: false, repeat: false });
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.54, metalness: 0, envMapIntensity: 0.55,
  });
  atlasPatch(mat, 4, 1, 'm');
  foliageShading(mat, { card: false });
  wind(mat, { mode: 'inst', flutter: 0.16 });
  // Leaf outlines are real geometry, so the shadow pass needs no texture.
  const depth = depthMaterial(null, 4, 1, 0.16, 1.6);
  return (leafMats = { mat, depth });
}

const cardMats = {};
export function cardMaterials(name, cols, rows) {
  if (cardMats[name]) return cardMats[name];
  const map = tex(A(`${name}.webp`), { repeat: false });
  const nrm = TIER.halfTextures ? null : tex(A(`${name}_n.jpg`), { srgb: false, repeat: false });
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

// Collects instances (matrix, tint, sway weight, variant) and turns them into chunked, LOD-managed batches.
export class Instances {
  constructor() { this.m = []; this.c = []; this.s = []; this.v = []; this.count = 0; }
  add(mat4, r, g, b, sway, phase, variant) {
    const e = mat4.elements;
    for (let i = 0; i < 16; i++) this.m.push(e[i]);
    this.c.push(r, g, b); this.s.push(sway, phase); this.v.push(variant);
    this.count++;
  }
  build(geometry, materials, { cell = 16, lod = {}, receiveShadow = true } = {}) {
    const data = { n: this.count, M: this.m, C: this.c, attrs: { aSway: [this.s, 2], aVar: [this.v, 1] } };
    const group = buildChunks(geometry, materials.mat, data, { cell, lod, depthMaterial: materials.depth, receiveShadow, pad: 2 });
    this.m = this.c = this.s = this.v = null;
    return group;
  }
}

// Keeps only a fraction of what is added and enlarges the survivors, so cover stays roughly the same with fewer leaves.
export function thinned(inst, frac) {
  if (frac >= 1) return inst;
  const s = Math.min(TIER.leafScaleCap, Math.pow(frac, -0.4));
  let i = 0;
  return {
    get count() { return inst.count; },
    add(m, r, g, b, sway, phase, variant) {
      i++;
      if ((Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) > frac) return;
      const e = m.elements;
      for (let k = 0; k < 12; k++) if (k % 4 !== 3) e[k] *= s;
      inst.add(m, r, g, b, sway, phase, variant);
    },
  };
}

// Ground plants (photoscanned cards/meshes with alpha): same translucent shading, wind grows with height.
export function plantMaterials(dir, { amount = 0.05, flutter = 0.004, tint = [1, 1, 1], normalScale = 1, shadow = true } = {}) {
  const map = tex(A(`models/${dir}/diff.webp`), { repeat: false, flipY: false });
  const nrm = TIER.halfTextures ? null : tex(A(`models/${dir}/nor.jpg`), { srgb: false, repeat: false, flipY: false });
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
  const nrm = TIER.halfTextures ? null : tex(A('leaf_atlas_n.jpg'), { srgb: false, repeat: false });
  const mat = new THREE.MeshStandardMaterial({ map, normalMap: nrm, normalScale: new THREE.Vector2(0.45, 0.45), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, metalness: 0, envMapIntensity: 0.35 });
  underwater(mat, { wet: false });
  atlasPatch(mat, 4, 1, 'm');
  // dead leaves: keep the veins and blotches, lose the chlorophyll; the instance colour supplies the hue
  chain(mat, 'dry', (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb = vec3(0.62 + 0.5 * clamp(dot(diffuseColor.rgb, vec3(0.4, 0.5, 0.1)) * 8.0, 0.0, 1.0));`);
  });
  foliageShading(mat, { card: false, dry: true });
  return (litterMats = { mat, depth: null });
}
