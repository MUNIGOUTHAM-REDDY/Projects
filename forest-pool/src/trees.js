// Procedural trees: curved, tapering limbs with root flare, recursive twigs and
// leaf-cluster cards. Two hand-placed hero trees frame the pool; a seeded forest fills the rest.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, poolE, pathDist, rng, fbm, HERO_TREES } from './world.js';
import { tex, pbr, A } from './textures.js';
import { chain, wind, underwater, dapple, G } from './shaders.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Build a tube along a curve with a per-point radius and optional radius modulation.
function limbGeometry(points, r0, r1, { radial = 10, perMetre = 5, flare = 0, flareLobes = 5, seed = 0, barkTile = 0.9, rough = 0 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const L = curve.getLength();
  const segs = Math.max(3, Math.ceil(L * perMetre));
  const frames = curve.computeFrenetFrames(segs, false);
  const base = points[0];
  const uRep = Math.max(1, Math.round((2 * Math.PI * r0) / barkTile));
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const P = curve.getPointAt(t);
    const N = frames.normals[i], B = frames.binormals[i];
    let r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    const hy = Math.max(0, (P.y - base.y));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let rr = r;
      if (flare > 0) {
        const f = Math.exp(-hy * 2.2);
        rr *= 1 + flare * f * (0.55 + 0.45 * Math.sin(a * flareLobes + seed)) + 0.12 * flare * Math.exp(-hy * 0.6);
      }
      if (rough > 0) rr *= 1 + rough * Math.sin(a * 3 + t * 9 + seed) * 0.5 + rough * 0.5 * Math.sin(a * 7 - t * 23 + seed * 2);
      const nx = ca * N.x + sa * B.x, ny = ca * N.y + sa * B.y, nz = ca * N.z + sa * B.z;
      pos.push(P.x + rr * nx, P.y + rr * ny, P.z + rr * nz);
      nor.push(nx, ny, nz);
      uv.push((j / radial) * uRep, (t * L) / barkTile);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return { geo: g, curve };
}

function perpendicular(dir, r) {
  const a = Math.abs(dir.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
  const p = new THREE.Vector3().crossVectors(dir, a).normalize();
  return p.applyAxisAngle(dir, r() * Math.PI * 2);
}

// Recursively sprout side branches from a limb curve, collecting geometry and leaf cards.
function sprout(curve, radius, depth, r, out, opts) {
  const { count = 5, lenScale = 0.45, from = 0.35, up = 0.35, leafSize = 1.2, leafDensity = 1, droop = 0.15 } = opts;
  const L = curve.getLength();
  const n = Math.max(1, Math.round(count * (0.6 + r() * 0.8)));
  for (let k = 0; k < n; k++) {
    const t = from + (1 - from) * ((k + r()) / n);
    const P = curve.getPointAt(t);
    const T = curve.getTangentAt(t);
    const side = perpendicular(T, r);
    const dir = T.clone().multiplyScalar(0.55).add(side.multiplyScalar(0.85)).add(V(0, up, 0)).normalize();
    const len = L * lenScale * (0.6 + r() * 0.6) * (1 - t * 0.35);
    if (len < 0.25) continue;
    const mid = P.clone().addScaledVector(dir, len * 0.5).add(V(0, len * (r() - 0.3) * 0.2, 0));
    const end = P.clone().addScaledVector(dir, len).add(V(0, -len * droop * r(), 0));
    const rr = Math.max(0.012, radius * (1 - t * 0.7) * 0.55);
    const { geo, curve: c2 } = limbGeometry([P, mid, end], rr, rr * 0.25, { radial: depth > 0 ? 6 : 4, perMetre: 3 });
    out.geos.push(geo);
    if (depth > 0) {
      sprout(c2, rr, depth - 1, r, out, { ...opts, count: Math.max(2, count - 1), lenScale: lenScale * 0.85, from: 0.3 });
    }
    // Leaf cards along the outer part of each twig.
    const leaves = Math.round((depth === 0 ? 3 : 1.5) * leafDensity * (0.6 + r() * 0.8));
    for (let q = 0; q < leaves; q++) {
      const lt = 0.45 + 0.55 * r();
      const lp = c2.getPointAt(lt).add(V((r() - 0.5) * 0.4, (r() - 0.3) * 0.3, (r() - 0.5) * 0.4));
      out.leaves.push({ p: lp, s: leafSize * (0.7 + r() * 0.6), r: r() });
    }
  }
}

function leafMatrix(l, r) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 2.4, r() * Math.PI * 2, (r() - 0.5) * 2.4));
  return new THREE.Matrix4().compose(l.p, q, V(l.s, l.s, l.s));
}

function barkMaterial(name, { moss = 0.5, tint = [1, 1, 1], mossBase = 1.6, desat = 0 } = {}) {
  const b = pbr(name);
  const mossTex = tex(A('forest_leaves_02_diff.jpg'));
  const mat = new THREE.MeshStandardMaterial({
    map: b.map, normalMap: b.normal, roughness: 0.92, color: new THREE.Color(...tint),
    normalScale: new THREE.Vector2(1.3, 1.3),
  });
  chain(mat, 'bark' + moss + mossBase + desat, (s) => {
    Object.assign(s.uniforms, { tMossB: { value: mossTex } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBW; varying vec3 vBN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vBW = (modelMatrix * vec4(transformed, 1.0)).xyz; vBN = normalize(mat3(modelMatrix) * objectNormal);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBW; varying vec3 vBN; uniform sampler2D tMossB;
        float bh(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float bn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(bh(i),bh(i+vec2(1,0)),f.x), mix(bh(i+vec2(0,1)),bh(i+vec2(1,1)),f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), ${desat.toFixed(2)});
        {
          float up = clamp(vBN.y, 0.0, 1.0);
          float streak = bn(vec2(atan(vBN.z, vBN.x) * 3.0, vBW.y * 0.6) + vBW.xz);
          float low = smoothstep(${mossBase.toFixed(2)}, 0.0, vBW.y - 0.0);
          float m = clamp(${moss.toFixed(2)} * (up * 1.2 + low * 1.1 + streak * 0.7) - 0.35, 0.0, 1.0);
          m = smoothstep(0.15, 0.75, m);
          vec3 mc = texture2D(tMossB, vBW.xz * 0.9 + vBW.y * 0.7).rgb * vec3(0.95, 1.35, 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, mc, m);
        }`);
  });
  underwater(mat, { caustics: true });
  dapple(mat, { strength: 0.7 });
  return mat;
}

function leafMaterial(texName, { tint = new THREE.Color(1, 1, 1), glow = 0.25 } = {}) {
  const map = tex(A(texName));
  const mat = new THREE.MeshStandardMaterial({
    map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, color: tint,
    emissive: new THREE.Color(0.6, 0.85, 0.15), emissiveMap: map, emissiveIntensity: glow,
  });
  wind(mat, { amount: 0.08, useUvY: false, freq: 1.1 });
  // Leaves are lit as if their normals point up-and-out, which avoids black backfaces.
  chain(mat, 'leafnormal', (s) => {
    s.vertexShader = s.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      objectNormal = normalize(objectNormal * 0.35 + vec3(0.0, 0.8, 0.0));`);
  });
  return mat;
}

function leafMesh(list, material, r) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const m = new THREE.InstancedMesh(plane, material, list.length);
  const c = new THREE.Color();
  list.forEach((l, i) => {
    m.setMatrixAt(i, leafMatrix(l, r));
    const v = 0.75 + l.r * 0.45;
    c.setRGB(v * (0.9 + l.r * 0.2), v, v * (0.75 + l.r * 0.2));
    m.setColorAt(i, c);
  });
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// --- Hero trees -----------------------------------------------------------

function heroLeft(out, r) {
  const { x, z } = HERO_TREES.left;
  const y0 = heightAt(x, z);
  const trunk = limbGeometry(
    [V(x + 0.12, y0 - 0.5, z), V(x + 0.06, y0 + 0.7, z), V(x + 0.1, y0 + 1.3, z - 0.04), V(x + 0.16, y0 + 1.95, z - 0.08)],
    0.27, 0.1, { radial: 22, perMetre: 8, flare: 1.3, flareLobes: 5, seed: 1.3, rough: 0.05, barkTile: 1.6 });
  out.geos.push(trunk.geo);
  const F = V(x + 0.16, y0 + 1.6, z - 0.08);
  const limbs = [
    // main limb leaning up-left, leaving the frame top-left
    { pts: [V(x + 0.1, y0 + 1.45, z - 0.08), V(x - 0.15, y0 + 2.5, z + 0.05), V(x - 0.35, y0 + 3.3, z + 0.2), V(x - 0.95, y0 + 4.3, z + 0.05), V(x - 1.15, y0 + 5.6, z + 0.15), V(x - 1.8, y0 + 8.5, z - 0.3)], r0: 0.15, r1: 0.03 },
    // main limb arching up-right across the top of the view
    { pts: [V(x + 0.22, y0 + 1.45, z - 0.08), V(x + 0.5, y0 + 2.35, z + 0.05), V(x + 0.6, y0 + 3.1, z + 0.25), V(x + 1.25, y0 + 3.7, z + 0.4), V(x + 1.35, y0 + 4.6, z + 0.7), V(x + 2.0, y0 + 5.4, z + 0.6), V(x + 2.4, y0 + 6.9, z + 0.6)], r0: 0.15, r1: 0.03 },
    // thin reaching branch to the right
    { pts: [V(x + 0.45, y0 + 2.2, z), V(x + 1.1, y0 + 2.7, z + 0.15), V(x + 1.9, y0 + 3.0, z + 0.35), V(x + 2.8, y0 + 3.5, z + 0.6), V(x + 3.5, y0 + 4.3, z + 0.8)], r0: 0.07, r1: 0.008 },
    // thin branch to the left
    { pts: [V(x - 0.2, y0 + 2.6, z + 0.03), V(x - 0.8, y0 + 3.0, z + 0.3), V(x - 1.5, y0 + 3.2, z + 0.6), V(x - 2.2, y0 + 3.3, z + 0.9)], r0: 0.06, r1: 0.02 },
    // thin one back over the water
    { pts: [V(x + 0.7, y0 + 3.0, z + 0.1), V(x + 0.9, y0 + 4.2, z - 0.8), V(x + 1.1, y0 + 6.0, z - 1.8)], r0: 0.07, r1: 0.025 },
  ];
  for (const l of limbs) {
    const { geo, curve } = limbGeometry(l.pts, l.r0, l.r1, { radial: 14, perMetre: 6, rough: 0.03 });
    out.geos.push(geo);
    sprout(curve, l.r0, 1, r, out, { count: 7, lenScale: 0.4, from: 0.25, leafSize: 1.1, leafDensity: 2.2 });
  }
}

function heroRight(out, r) {
  const { x, z } = HERO_TREES.right;
  const y0 = heightAt(x, z);
  const pts = [V(x, y0 - 0.6, z), V(x - 0.02, y0 + 1.4, z - 0.02), V(x - 0.1, y0 + 3.4, z - 0.08), V(x - 0.28, y0 + 6.0, z - 0.2), V(x - 0.35, y0 + 10, z - 0.3), V(x - 0.25, y0 + 16, z - 0.4)];
  const trunk = limbGeometry(pts, 0.22, 0.1, { radial: 20, perMetre: 6, flare: 1.4, flareLobes: 4, seed: 4.1, rough: 0.05 });
  out.geos.push(trunk.geo);
  // Roots reaching into the water.
  const roots = [
    [V(x - 0.1, y0 + 0.15, z), V(x - 0.5, y0 - 0.05, z - 0.25), V(x - 0.85, -0.35, z - 0.55), V(x - 1.05, -0.6, z - 0.7)],
    [V(x, y0 + 0.1, z - 0.1), V(x - 0.15, y0 - 0.1, z - 0.6), V(x - 0.25, -0.4, z - 1.05)],
    [V(x + 0.1, y0 + 0.1, z), V(x + 0.55, y0 - 0.05, z - 0.25), V(x + 0.95, y0 - 0.2, z - 0.4)],
    [V(x - 0.1, y0 + 0.1, z + 0.05), V(x - 0.6, y0 - 0.05, z + 0.3), V(x - 1.0, y0 - 0.2, z + 0.4)],
  ];
  for (const rp of roots) out.geos.push(limbGeometry(rp, 0.11, 0.03, { radial: 8, perMetre: 6 }).geo);
  const branches = [
    { pts: [V(x + 0.03, y0 + 1.9, z), V(x - 0.25, y0 + 2.4, z - 0.05), V(x - 0.6, y0 + 3.2, z - 0.1), V(x - 0.85, y0 + 3.7, z - 0.25), V(x - 1.15, y0 + 4.1, z - 0.4), V(x - 1.4, y0 + 4.9, z - 0.5)], r0: 0.05, r1: 0.015 },
    { pts: [V(x - 0.1, y0 + 3.3, z - 0.08), V(x + 0.55, y0 + 4.0, z + 0.1), V(x + 1.3, y0 + 4.5, z + 0.3), V(x + 2.2, y0 + 5.3, z + 0.3)], r0: 0.09, r1: 0.03 },
    { pts: [V(x - 0.3, y0 + 7.5, z - 0.2), V(x - 1.0, y0 + 8.6, z - 0.4), V(x - 1.9, y0 + 9.4, z - 0.4), V(x - 2.6, y0 + 10.6, z - 0.6)], r0: 0.08, r1: 0.03 },
    { pts: [V(x - 0.32, y0 + 9.5, z - 0.3), V(x + 0.6, y0 + 10.6, z - 0.1), V(x + 1.6, y0 + 11.6, z + 0.2)], r0: 0.07, r1: 0.025 },
    { pts: [V(x - 0.3, y0 + 12, z - 0.35), V(x - 0.4, y0 + 13, z - 1.4), V(x - 0.6, y0 + 14.5, z - 2.4)], r0: 0.07, r1: 0.025 },
  ];
  for (const l of branches) {
    const { geo, curve } = limbGeometry(l.pts, l.r0, l.r1, { radial: 10, perMetre: 5 });
    out.geos.push(geo);
    sprout(curve, l.r0, 1, r, out, { count: 5, lenScale: 0.45, from: 0.3, leafSize: 1.1, leafDensity: 1.3 });
  }
}

// --- Forest ---------------------------------------------------------------

function forestTree(x, z, r, out, { tall = true } = {}) {
  const y0 = heightAt(x, z);
  const H = tall ? 17 + r() * 12 : 3 + r() * 4;
  const R = tall ? 0.16 + r() * 0.26 : 0.04 + r() * 0.05;
  const lean = V((r() - 0.5) * 0.06, 1, (r() - 0.5) * 0.06).normalize();
  const pts = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const h = (i / n) * H;
    const wob = tall ? 0.12 : 0.15;
    pts.push(V(x + lean.x * h + (r() - 0.5) * wob * (i > 0), y0 - 0.4 + h, z + lean.z * h + (r() - 0.5) * wob * (i > 0)));
  }
  const { geo, curve } = limbGeometry(pts, R, R * 0.3, {
    radial: tall ? 12 : 5, perMetre: tall ? 1.2 : 1.5, flare: tall ? 0.6 : 0, flareLobes: 4 + Math.floor(r() * 3), seed: r() * 10, barkTile: 1.1,
  });
  out.geos.push(geo);
  // Branches only in the crown; long bare trunks like the beech stand in the reference.
  const crownFrom = tall ? 0.3 + r() * 0.12 : 0.35;
  sprout(curve, R, tall ? 1 : 0, r, out, {
    count: tall ? 14 : 4, lenScale: tall ? 0.24 : 0.4, from: crownFrom, up: 0.45,
    leafSize: tall ? 3.0 : 1.2, leafDensity: tall ? 1.0 : 1.6, droop: 0.1,
  });
  // Epicormic leaf tufts on the trunk give the bright mid-level green seen between trunks.
  const tufts = tall ? Math.floor(r() * 4) : 0;
  for (let i = 0; i < tufts; i++) {
    const p = curve.getPointAt(0.15 + r() * 0.35).add(V((r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6));
    out.leaves.push({ p, s: 0.8 + r() * 0.6, r: r() });
  }
}

export function createTrees(quality) {
  const r = rng(1234);
  const hero = { geos: [], leaves: [] };
  heroLeft(hero, r);
  const heroR = { geos: [], leaves: [] };
  heroRight(heroR, r);

  const forest = { geos: [], leaves: [] };
  const under = { geos: [], leaves: [] };
  const placed = [];
  const tooClose = (x, z, d) => placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < d * d);
  const target = quality === 'low' ? 150 : 260;
  let tries = 0;
  while (placed.length < target && tries++ < 8000) {
    // Denser to the north (behind the pool), where the default view looks.
    const ang = r() * Math.PI * 2;
    const rad = 6 + Math.pow(r(), 0.8) * 48;
    let x = -0.4 + Math.cos(ang) * rad, z = -2.2 + Math.sin(ang) * rad;
    if (z > 0 && r() < 0.45) continue;
    if (poolE(x, z) < 1.25) continue;
    if (pathDist(x, z) < 1.6) continue;
    if (Math.hypot(x - HERO_TREES.left.x, z - HERO_TREES.left.z) < 2.5) continue;
    if (Math.hypot(x - HERO_TREES.right.x, z - HERO_TREES.right.z) < 2.2) continue;
    if (Math.hypot(x + 0.3, z - 6.5) < 3.5) continue; // keep the viewer's spot open
    if (tooClose(x, z, 2.2)) continue;
    placed.push({ x, z });
    forestTree(x, z, r, forest, { tall: true });
  }
  // A distant ring of slim trunks for depth.
  for (let i = 0, n = 0; n < 24 && i < 400; i++) {
    const ang = -Math.PI / 2 + (r() - 0.5) * 2.6, rad = 25 + r() * 15;
    const x = -0.4 + Math.cos(ang) * rad, z = -2.2 + Math.sin(ang) * rad;
    if (tooClose(x, z, 2.5)) continue;
    placed.push({ x, z }); forestTree(x, z, r, forest, { tall: true }); n++;
  }
  // Understory saplings.
  let u = 0; tries = 0;
  const uTarget = quality === 'low' ? 60 : 110;
  while (u < uTarget && tries++ < 6000) {
    const ang = r() * Math.PI * 2;
    const rad = 7 + r() * 30;
    const x = -0.4 + Math.cos(ang) * rad, z = -2.2 + Math.sin(ang) * rad;
    if (poolE(x, z) < 1.3 || pathDist(x, z) < 1.8) continue;
    if (Math.hypot(x + 0.3, z - 6.5) < 4) continue;
    if (tooClose(x, z, 1.0)) continue;
    forestTree(x, z, r, under, { tall: false });
    u++;
  }

  const barkL = barkMaterial('japanese_hackberry_bark', { moss: 0.5, tint: [1.15, 1.15, 1.03], mossBase: 1.4, desat: 0.45 });
  const barkR = barkMaterial('bark_brown_02', { moss: 1.1, tint: [1.7, 1.6, 1.45], mossBase: 2.2, desat: 0.3 });
  const barkF = barkMaterial('japanese_hackberry_bark', { moss: 0.55, tint: [1.6, 1.6, 1.5], mossBase: 1.2, desat: 0.35 });

  const group = new THREE.Group();
  const add = (geos, mat) => {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  add(hero.geos, barkL);
  add(heroR.geos, barkR);
  add([...forest.geos, ...under.geos], barkF);

  const leafMat = leafMaterial('leafcluster.png', { glow: 0.45 });
  const leafMatSparse = leafMaterial('leafsparse.png', { glow: 0.45 });
  const lr = rng(99);
  const leaves = [
    leafMesh([...hero.leaves, ...heroR.leaves], leafMatSparse, lr),
    leafMesh(forest.leaves, leafMat, lr),
    leafMesh(under.leaves, leafMatSparse, lr),
  ];
  // Only the two hero trees cast real leaf shadows; the canopy dapple pattern stands in for the rest.
  leaves[1].castShadow = false; leaves[2].castShadow = false;
  leaves.forEach((m) => group.add(m));
  group.userData.leaves = leaves;
  group.userData.counts = { trees: placed.length, saplings: u, leafCards: leaves.reduce((a, m) => a + m.count, 0) };
  return group;
}
