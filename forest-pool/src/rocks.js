// Photoscanned mossy boulders (Poly Haven rock_moss_set_01/02), bedded into the ground: each is sunk
// by a good part of its height, blends into soil and moss where it meets the terrain, turns dark and
// glossy at the waterline, and gains extra moss on its upward faces. Plus cobbles along the water's
// edge, a fallen trunk in the riffle and a stump.
import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildChunks, registerMesh } from './chunks.js';
import { TIER } from './tier.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { heightAt, rng, river, bankE, pathDist, ROCKS, fbm, smoothstep, PATH } from './world.js';
import { tex, A } from './textures.js';
import { chain, underwater, dapple, G } from './shaders.js';
import { loadModel } from './models.js';

const perlin = new ImprovedNoise();

// Shared "sits in the ground" patch: needs the baked terrain height.
function bedded(mat, { moss = 0.6, blend = 0.14, key = '' } = {}) {
  const mossTex = tex(A('forest_leaves_02_diff.jpg'));
  underwater(mat);
  chain(mat, 'bedded' + moss + blend + key, (s) => {
    Object.assign(s.uniforms, { tMossR: { value: mossTex }, tBakeR: G.tBake, uBakeR: G.uBake });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRN;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vRN = objectNormal;
        #ifdef USE_INSTANCING
          vRN = mat3(instanceMatrix) * vRN;
        #endif
        vRN = normalize(mat3(modelMatrix) * vRN);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRN; uniform sampler2D tMossR, tBakeR; uniform vec4 uBakeR; float rMoss;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 N = normalize(vRN);
          float ground = texture2D(tBakeR, (vUW.xz - uBakeR.xy) * uBakeR.z).r;
          float rel = vUW.y - ground;
          float n1 = vnoise(vUW.xz * 5.0 + vUW.y * 3.0), n2 = vnoise(vUW.xz * 17.0 + vUW.y * 11.0);
          // moss cushions on upward faces, thicker near the ground and away from splashing water
          float m = ${moss.toFixed(2)} * (smoothstep(0.1, 0.8, N.y) * 1.1 + smoothstep(0.5, 0.0, rel) * 0.5) + (n1 - 0.5) * 0.8 + (n2 - 0.5) * 0.3 - 0.25;
          m *= smoothstep(0.02, 0.2, vUW.y);
          rMoss = smoothstep(0.3, 0.6, m);
          vec3 tw = pow(abs(N), vec3(3.0)); tw /= (tw.x + tw.y + tw.z);
          vec3 mt = texture2D(tMossR, vUW.zy * 0.9).rgb * tw.x + texture2D(tMossR, vUW.xz * 0.9).rgb * tw.y + texture2D(tMossR, vUW.xy * 0.9).rgb * tw.z;
          mt *= 0.55 + 1.3 * dot(mt, vec3(0.33));
          diffuseColor.rgb = mix(diffuseColor.rgb, mt * vec3(0.34, 0.62, 0.17) * (0.7 + 0.6 * n1), rMoss);
          // soil, litter and damp creep up from the ground; the join itself falls into shade
          float soil = smoothstep(${blend.toFixed(2)}, 0.0, rel + (n1 - 0.5) * 0.1) * step(0.0, ground);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.07, 0.04) * (0.6 + n2), soil * 0.85);
          diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(-0.02, 0.22, rel));
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 1.0, rMoss);`);
  });
  dapple(mat);
  return mat;
}

function rockMaterial(set) {
  const d = `models/${set}`;
  const o = { repeat: false, flipY: false };
  const mat = new THREE.MeshStandardMaterial({
    map: tex(A(`${d}/diff.jpg`), o), normalMap: tex(A(`${d}/nor.jpg`), { ...o, srgb: false }), roughnessMap: tex(A(`${d}/rough.jpg`), { ...o, srgb: false }),
    roughness: 1, metalness: 0, color: new THREE.Color(0.92, 0.92, 0.88), envMapIntensity: 0.6,
  });
  return bedded(mat, { moss: 0.75, key: set });
}

function pebbleGeometry(seed) {
  let g = new THREE.IcosahedronGeometry(1, 1);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = perlin.noise(v.x * 1.2 + seed, v.y * 1.2, v.z * 1.2 - seed) * 0.35 + perlin.noise(v.x * 3 + seed, v.y * 3, v.z * 3) * 0.1;
    v.multiplyScalar(1 + n);
    p.setXYZ(i, v.x, v.y * 0.62, v.z * 0.82);
  }
  g.computeVertexNormals();
  return g;
}

function pebbleMaterial() {
  const t = tex(A('mossy_rock_diff.jpg'));
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.6 });
  bedded(mat, { moss: 0.35, blend: 0.03, key: 'peb' });
  chain(mat, 'pebtri', (s) => {
    Object.assign(s.uniforms, { tPebble: { value: t } });
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tPebble;')
      .replace('#include <map_fragment>', `
        {
          vec3 w = pow(abs(normalize(vRN)), vec3(4.0)); w /= (w.x + w.y + w.z);
          vec3 c = texture2D(tPebble, vUW.zy * 1.3).rgb * w.x + texture2D(tPebble, vUW.xz * 1.3).rgb * w.y + texture2D(tPebble, vUW.xy * 1.3).rgb * w.z;
          diffuseColor.rgb *= mix(vec3(dot(c, vec3(0.33))), c, 0.6) * 1.5;
        }
        #include <map_fragment>`);
  });
  return mat;
}

export function createRocks() {
  const group = new THREE.Group();
  const r = rng(42);
  Promise.all([loadModel('rock_moss_set_01'), loadModel('rock_moss_set_02')]).then(([a, b]) => {
    const mats = [rockMaterial('rock_moss_set_01'), rockMaterial('rock_moss_set_02')];
    const all = [...a.map((v) => ({ ...v, mat: mats[0] })), ...b.map((v) => ({ ...v, mat: mats[1] }))];
    if (!all.length) return;
    // Boulders are baked into one mesh per 24 m cell and material: a handful of draw calls, each culled on its own.
    const cells = new Map();
    const m = new THREE.Object3D();
    ROCKS.forEach((rk, i) => {
      const v = all[(i * 5 + 3) % all.length];
      let sc = rk.r / v.radius;
      let h = v.height * sc;
      const bed = heightAt(rk.x, rk.z);
      // boulders in the stream must break the surface
      if (!rk.sub && bed < 0 && h * (1 - rk.sink) < -bed + 0.22) { const k = Math.min(1.7, (-bed + 0.22) / (h * (1 - rk.sink))); sc *= k; h *= k; }
      m.scale.setScalar(sc);
      m.rotation.set((r() - 0.5) * 0.12, rk.rot, (r() - 0.5) * 0.12);
      // sunken boulders: tops a hand's breadth under the surface, showing as dark shapes with a boil above
      // boulders on the shallow ledges and bars are bedded deep in the cobbles, not perched on them
      const sinkK = bed > -0.2 && rk.kind === 'r' ? Math.max(rk.sink, 0.45) : Math.max(rk.sink, rk.kind === 'r' ? 0.3 : rk.sink);
      const yBase = rk.sub ? Math.max(bed - h * 0.6, Math.min(bed - h * rk.sink, -(0.04 + r() * 0.12) - h)) : bed - h * sinkK;
      m.position.set(rk.x, yBase, rk.z);
      m.updateMatrix();
      const key = String(mats.indexOf(v.mat));
      let c = cells.get(key); if (!c) cells.set(key, (c = { mat: v.mat, geos: [] }));
      c.geos.push(v.geo.clone().applyMatrix4(m.matrix));
    });
    for (const c of cells.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(c.geos), c.mat);
      mesh.receiveShadow = true;
      registerMesh(mesh, { tag: 'rocks', shadow: 1, mirror: 1, mirrorDist: 45, full: 160, zero: 160 });
      group.add(mesh);
    }
  });

  // Cobbles and pebbles: thick along the waterline and on the gravel bars, scattered over the riffles.
  const count = Math.round(5200 * Math.max(TIER.count, 0.35));
  const geos = [pebbleGeometry(1.3)];
  const mat = pebbleMaterial();
  const per = geos.map(() => []);
  let n = 0, tries = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  while (n < count && tries++ < count * 30) {
    const ang = r() * 6.283, rad = Math.pow(r(), 0.7) * 30;
    const x = -1 + Math.cos(ang) * rad, z = -4 + Math.sin(ang) * rad;
    const y = heightAt(x, z);
    if (y > 0.3 || y < -0.5) continue;
    const edge = Math.exp(-(((y - 0.02) / 0.13) ** 2));
    // gravel comes in bars and pockets, not as a strip: bare mud and moss reach the water in between
    const pocket = smoothstep(-0.05, 0.25, fbm(x * 0.33, z * 0.33, 2, 52)) * (0.4 + 0.6 * smoothstep(-0.1, 0.2, fbm(x * 1.4, z * 1.4, 2, 53)));
    if (r() > (0.1 + 0.9 * edge) * (0.06 + 0.94 * pocket)) continue;
    if (pathDist(x, z) < 0.5 && r() < 0.8) continue;
    const big = r();
    const size = 0.02 + Math.pow(big, 5) * 0.42 + Math.pow(r(), 2) * 0.06;
    e.set((r() - 0.5) * 0.5, r() * 6.283, (r() - 0.5) * 0.5); q.setFromEuler(e);
    p.set(x, y - size * (0.2 + r() * 0.3), z); s.set(size * (0.6 + r() * 1.1), size * (0.4 + r() * 0.7), size * (0.6 + r() * 0.8));
    m4.compose(p, q, s);
    const v = 0.6 + r() * 0.55, w = r();
    per[0].push({ m: m4.clone(), size, c: [v * (0.95 + w * 0.12), v * (0.93 + w * 0.06), v * (0.86 - w * 0.06)] });
    n++;
  }
  // grit and small stones trodden into the trail
  const nPath = Math.round(700 * TIER.count);
  for (let k = 0; k < nPath; k++) {
    const seg = Math.floor(r() * (PATH.length - 3)) + 2, f = r();
    const x = PATH[seg][0] + (PATH[seg + 1][0] - PATH[seg][0]) * f + (r() + r() - 1) * 0.75, z = PATH[seg][1] + (PATH[seg + 1][1] - PATH[seg][1]) * f + (r() - 0.5) * 0.4;
    if (fbm(x * 1.1, z * 1.1, 2, 61) < -0.02) continue;          // gathered in the ruts, not sprinkled evenly
    const size = 0.005 + Math.pow(r(), 4) * 0.02;
    e.set((r() - 0.5) * 0.5, r() * 6.283, (r() - 0.5) * 0.5); q.setFromEuler(e);
    p.set(x, heightAt(x, z) - size * 0.45, z); s.set(size * (0.7 + r() * 0.9), size * (0.5 + r() * 0.4), size * (0.7 + r() * 0.7));
    m4.compose(p, q, s);
    const v = 0.85 + r() * 0.5;
    per[0].push({ m: m4.clone(), size, c: [v, v * 0.94, v * 0.82] });
  }
  {
    // Stored largest first within each chunk: with distance only the cobbles remain, then nothing.
    const list = per[0], n = list.length, M = new Float32Array(n * 16), C = new Float32Array(n * 3), key = new Float32Array(n);
    list.forEach((o, k) => { o.m.toArray(M, k * 16); C.set(o.c, k * 3); key[k] = o.size; });
    group.add(buildChunks(geos[0], mat, { n, M, C, key }, { cell: 18, lod: { tag: 'pebbles', full: 8, zero: 36, min: 0.06, shadow: 0, mirror: 0 }, pad: 0.1 }));
  }

  // A fallen trunk lying from the bank into the riffle, and an old stump beside the trail.
  const wood = (id, place) => loadModel(id).then(([v]) => {
    if (!v) return;
    const d = `models/${id}`, o = { repeat: false, flipY: false };
    const mat = new THREE.MeshStandardMaterial({ map: tex(A(`${d}/diff.jpg`), o), normalMap: tex(A(`${d}/nor.jpg`), { ...o, srgb: false }), roughness: 0.9, metalness: 0 });
    bedded(mat, { moss: 0.8, blend: 0.1, key: id });
    const m = new THREE.Mesh(v.geo, mat);
    place(m, v);
    m.receiveShadow = true;
    registerMesh(m, { tag: 'logs', shadow: 1, mirror: 1, mirrorDist: 45, full: 150, zero: 150 });
    group.add(m);
  });
  wood('dead_tree_trunk', (m) => {
    m.scale.setScalar(2.3);
    m.position.set(-2.6, 0.14, -9.6);
    m.rotation.set(0.0, -0.45, -0.08);
  });
  wood('tree_stump_01', (m, v) => {
    const x = -4.9, z = 8.3;
    m.scale.setScalar(1.0);
    m.rotation.y = 1.1;
    m.position.set(x, heightAt(x, z) - 0.12, z);
  });
  group.userData.extra = [{ x: -4.9, z: 8.3, r: 0.7 }];
  return group;
}
