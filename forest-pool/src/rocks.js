// Moss-covered boulders and low moss mounds, procedurally displaced and triplanar-textured.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { heightAt, rng, poolE } from './world.js';
import { pbr } from './textures.js';
import { chain, underwater, dapple } from './shaders.js';

const perlin = new ImprovedNoise();

function rockGeometry(seed, { sx = 1, sy = 0.6, sz = 1, lump = 0.35, detail = 18 } = {}) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let n = 0, a = 1, f = 1.1;
    for (let o = 0; o < 6; o++) {
      n += a * perlin.noise(v.x * f + seed, v.y * f + seed * 0.7, v.z * f - seed);
      a *= 0.5; f *= 2.1;
    }
    const d = 1 + n * lump;
    v.multiplyScalar(d);
    // Flatten the underside so rocks sit into the ground.
    if (v.y < -0.1) v.y = -0.1 + (v.y + 0.1) * 0.35;
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}

function mossMaterial() {
  const moss = pbr('forest_leaves_02');
  const moss2 = pbr('aerial_grass_rock');
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: 0.95, metalness: 0,
    sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(0.4, 0.65, 0.18),
  });
  chain(mat, 'moss-triplanar', (s) => {
    Object.assign(s.uniforms, { tM1: { value: moss.map }, nM1: { value: moss.normal }, tM2: { value: moss2.map } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRW; varying vec3 vRN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vRW = (modelMatrix * vec4(transformed, 1.0)).xyz; vRN = normalize(mat3(modelMatrix) * objectNormal);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRW; varying vec3 vRN; uniform sampler2D tM1, nM1, tM2;
        vec3 triT(sampler2D t, vec3 p, vec3 w){ return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z; }`)
      .replace('#include <map_fragment>', `
        vec3 tw = pow(abs(normalize(vRN)), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec3 c1 = triT(tM1, vRW * 1.7, tw);
        vec3 c2 = triT(tM2, vRW * 0.45, tw);
        float lum = dot(mix(c1, c2, 0.45), vec3(0.33));
        vec3 deep = vec3(0.035, 0.11, 0.01), litc = vec3(0.26, 0.5, 0.045);
        float shade = smoothstep(-0.5, 0.7, vRN.y);
        vec3 mc = mix(deep, litc, shade) * (0.15 + lum * 2.6);
        mc = mix(mc, mix(c1, c2, 0.45) * vec3(0.7, 1.0, 0.45), 0.3);
        mc = mix(mc * 0.35, mc, smoothstep(-0.9, -0.2, vRN.y));
        mc *= mix(0.4, 1.0, smoothstep(0.0, 0.25, vRW.y - 0.0));
        float crev = smoothstep(0.25, 0.6, dot(triT(tM2, vRW * 0.25 + 3.7, tw), vec3(0.33)));
        mc = mix(mc * vec3(0.55, 0.6, 0.5), mc * 1.1, crev);
        diffuseColor.rgb *= mc;
        vec3 rN = triT(nM1, vRW * 1.7, tw) * 2.0 - 1.0; rN.xy *= 0.55;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(vRN);
          vec3 T = normalize(cross(wn, abs(wn.y) < 0.95 ? vec3(0,1,0) : vec3(1,0,0)));
          vec3 B = cross(wn, T);
          vec3 pw = normalize(T * rN.x + B * rN.y + wn * max(rN.z, 0.3));
          normal = normalize((viewMatrix * vec4(pw, 0.0)).xyz);
        }`);
  });
  underwater(mat);
  dapple(mat, { strength: 0.85 });
  return mat;
}

// Boulders placed to echo the reference: a big one in the near foreground, clusters left and right.
const ROCKS = [
  // x, z, size, flatten
  [0.0, 4.65, 0.38, 0.6],     // large foreground rock, bottom centre-right
  [0.1, 4.0, 0.26, 0.62],    // mid rock beyond it
  [-1.35, 4.25, 0.34, 0.62],  // bottom-left rock
  [-0.95, 4.75, 0.2, 0.7],
  [-1.3, 5.2, 0.24, 0.6],
  [0.75, 4.1, 0.22, 0.65],
  [1.15, 4.6, 0.32, 0.6],
  [-3.1, 2.6, 0.45, 0.6],
  [3.4, -5.6, 0.6, 0.55],
  [-4.6, -5.5, 0.7, 0.5],
  [5.6, 0.2, 0.55, 0.6],
];

export function createRocks(quality) {
  const r = rng(42);
  const mat = mossMaterial();
  const group = new THREE.Group();
  const detail = quality === 'low' ? 10 : 18;
  const list = [...ROCKS];
  // A few scattered submerged stones and bank rocks.
  for (let i = 0; i < 26; i++) {
    const ang = r() * Math.PI * 2, rad = 3 + r() * 14;
    const x = -0.4 + Math.cos(ang) * rad, z = -2.2 + Math.sin(ang) * rad * 0.8;
    if (z > 1 && Math.abs(x) < 2.5) continue;
    const pe = poolE(x, z);
    list.push([x, z, (pe < 1 ? 0.25 : 0.3) + r() * 0.35, 0.5 + r() * 0.2]);
  }
  list.forEach(([x, z, s, f], i) => {
    const geo = rockGeometry(i * 3.7 + 1.1, { sx: 1 + r() * 0.3, sy: f, sz: 0.9 + r() * 0.3, detail });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, heightAt(x, z) - s * f * 0.15, z);
    m.scale.setScalar(s);
    m.rotation.y = r() * Math.PI * 2;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  });
  // Low moss mounds that soften the ground on the near-left bank.
  const mounds = [[-2.2, 4.0, 0.8], [-3.0, 3.0, 0.8], [2.5, 3.9, 0.6], [-3.4, 4.8, 0.9]];
  mounds.forEach(([x, z, s], i) => {
    const geo = rockGeometry(50 + i, { sx: 1.3, sy: 0.22, sz: 1.1, lump: 0.25, detail: Math.min(detail, 12) });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, heightAt(x, z) - 0.02, z);
    m.scale.setScalar(s);
    m.receiveShadow = true;
    group.add(m);
  });
  return group;
}
