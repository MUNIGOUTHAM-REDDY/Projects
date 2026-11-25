// Procedural beech wood. Every tree is a hierarchy: trunk -> scaffold limbs -> branches -> branchlets
// -> twigs, and foliage only ever grows from twigs:
//   hero trees  : real leaf geometry, alternate along each twig in the twig's own plane
//   forest trees: twig-spray cards rooted on branches and aligned with them (boughs for the far ring)
// Limbs carry a sway weight that accumulates down the hierarchy so the wind moves the tree as one.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { heightAt, river, bankE, pathDist, rng, fbm, clamp, lerp, smoothstep, HERO_TREES, ROCKS } from './world.js';
import { tex, pbr, A } from './textures.js';
import { chain, wind, underwater, dapple, worldPos, G } from './shaders.js';
import { leafGeometry, cardGeometry, leafMaterials, cardMaterials, Instances } from './foliage.js';

const perlin = new ImprovedNoise();
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _a = V(0, 0, 0), _b = V(0, 0, 0), _c = V(0, 0, 0), _m = new THREE.Matrix4();

// --- Paths -------------------------------------------------------------------
class Path {
  constructor(pts) {
    this.p = pts;
    const n = pts.length;
    this.cum = new Float32Array(n);
    for (let i = 1; i < n; i++) this.cum[i] = this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]);
    this.L = this.cum[n - 1];
    this.tan = pts.map((_, i) => V(0, 0, 0).subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize());
  }
  seg(t) {
    const d = clamp(t, 0, 1) * this.L, c = this.cum;
    let i = 0;
    while (i < c.length - 2 && c[i + 1] < d) i++;
    return [i, (d - c[i]) / Math.max(1e-6, c[i + 1] - c[i])];
  }
  at(t, out = V(0, 0, 0)) { const [i, f] = this.seg(t); return out.lerpVectors(this.p[i], this.p[i + 1], f); }
  tangent(t, out = V(0, 0, 0)) { const [i, f] = this.seg(t); return out.lerpVectors(this.tan[i], this.tan[i + 1], f).normalize(); }
}
const smoothPath = (ctrl, perMetre = 5) => {
  const c = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  c.arcLengthDivisions = 60;
  return new Path(c.getSpacedPoints(Math.max(3, Math.ceil(c.getLength() * perMetre))));
};

class Limb {
  constructor(path, r0, r1, s0, s1, level) { this.path = path; this.r0 = r0; this.r1 = r1; this.s0 = s0; this.s1 = s1; this.level = level; }
  radiusAt(t) { return this.r0 + (this.r1 - this.r0) * Math.pow(t, 0.85); }
  swayAt(t) { return this.s0 + (this.s1 - this.s0) * t * t; }
}

// --- Tube mesh along a limb -------------------------------------------------------
function tube(limb, { radial = 8, flare = 0, flareLobes = 5, flareH = 0.5, seed = 0, lumps = 0, collar = 0, knots = null, barkTile = 1.2, ground = null } = {}) {
  const { path } = limb;
  const P = path.p, n = P.length;
  const pos = [], uv = [], sway = [], col = [], idx = [];
  const uRep = Math.max(1, Math.round((2 * Math.PI * limb.r0) / barkTile));
  const N = V(0, 0, 0), B = V(0, 0, 0), T = V(0, 0, 0);
  T.copy(path.tan[0]);
  N.copy(Math.abs(T.y) < 0.9 ? UP : V(1, 0, 0)).addScaledVector(T, -T.dot(Math.abs(T.y) < 0.9 ? UP : V(1, 0, 0))).normalize();
  for (let i = 0; i < n; i++) {
    T.copy(path.tan[i]);
    N.addScaledVector(T, -N.dot(T)).normalize();
    B.crossVectors(T, N);
    const t = path.cum[i] / path.L, dist = path.cum[i];
    let r = limb.radiusAt(t);
    if (collar > 0) r *= 1 + collar * Math.exp(-dist / (limb.r0 * 2.2));
    const sw = limb.swayAt(t);
    const hy = ground === null ? 1e9 : P[i].y - ground;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let rr = r, ao = 1;
      if (flare > 0) {
        // buttress roots: uneven lobes that swell toward the ground
        const f = Math.exp(-Math.max(0, hy) / flareH);
        const lobe = 0.5 + 0.5 * Math.sin(a * flareLobes + seed + 0.7 * Math.sin(a * 2 + seed * 3));
        const lobe2 = 0.5 + 0.5 * Math.sin(a * (flareLobes + 3) - seed * 2);
        rr *= 1 + flare * f * (0.25 + 0.75 * Math.pow(lobe, 1.6) + 0.2 * lobe2) + 0.1 * flare * Math.exp(-Math.max(0, hy) / (flareH * 4));
        ao *= 1 - 0.45 * f * (1 - lobe);
      }
      if (lumps > 0) {
        const q = j === radial ? 0 : a; // keep the seam closed
        rr *= 1 + lumps * (perlin.noise(Math.cos(q) * 1.3 + seed, dist * 0.55, Math.sin(q) * 1.3) + 0.45 * perlin.noise(Math.cos(q) * 3.1, dist * 1.6 + seed, Math.sin(q) * 3.1));
      }
      if (knots) for (const k of knots) {
        let da = a - k.a; da = Math.atan2(Math.sin(da), Math.cos(da));
        const dd = ((dist - k.d) / (k.s * 1.2)) ** 2 + ((da * r) / k.s) ** 2;
        if (dd < 6) { const e = Math.exp(-dd); rr += k.s * 0.42 * (e - 0.55 * Math.exp(-dd * 7)); ao *= 1 - 0.3 * Math.exp(-dd * 5); }
      }
      if (collar > 0) ao *= 1 - 0.4 * Math.exp(-dist / (limb.r0 * 1.2));
      pos.push(P[i].x + rr * (ca * N.x + sa * B.x), P[i].y + rr * (ca * N.y + sa * B.y), P[i].z + rr * (ca * N.z + sa * B.z));
      uv.push((j / radial) * uRep, dist / barkTile);
      sway.push(sw); col.push(ao, ao, ao);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // close the shading seam
  const nr = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    const a = i * (radial + 1), b = a + radial;
    const x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b), l = Math.hypot(x, y, z) || 1;
    nr.setXYZ(a, x / l, y / l, z / l); nr.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

// --- Growth ------------------------------------------------------------------------
// Sprout child limbs from a parent. Children alternate left/right in a (roughly horizontal) plane when
// `planar`, otherwise spiral with the golden angle. They bend toward the light and sag under their own weight.
function sprout(parent, spec, r) {
  const { count, t0 = 0.3, t1 = 0.95, angle = [45, 60], len, rRatio = 0.5, rTip = 0.004, up = 0, droop = 0, planar = true, wiggle = 0.1, segs = 4, flex = 0.02, twist = 0 } = spec;
  const out = [];
  const n = Math.max(1, Math.round(count * (0.8 + r() * 0.4)));
  let side = r() < 0.5 ? 1 : -1, az = r() * 6.28;
  const P = V(0, 0, 0), T = V(0, 0, 0), perp = V(0, 0, 0), d = V(0, 0, 0);
  for (let k = 0; k < n; k++) {
    const t = t0 + (t1 - t0) * (k + 0.5 + (r() - 0.5) * 0.6) / n;
    parent.path.at(t, P); parent.path.tangent(t, T);
    if (planar) {
      perp.crossVectors(T, UP);
      if (perp.lengthSq() < 0.02) perp.set(Math.cos(az), 0, Math.sin(az));
      perp.normalize().multiplyScalar(side);
      perp.applyAxisAngle(T, (r() - 0.5) * 0.7 + twist * side);
      side = -side;
    } else {
      az += 2.39996 + (r() - 0.5) * 0.6;
      _a.copy(Math.abs(T.y) < 0.95 ? UP : V(1, 0, 0));
      perp.crossVectors(T, _a).normalize().applyAxisAngle(T, az);
    }
    const ang = (angle[0] + (angle[1] - angle[0]) * r()) * Math.PI / 180;
    d.copy(T).multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();
    const L = (typeof len === 'function' ? len(t, parent) : len) * (0.75 + r() * 0.5);
    if (L < 0.08) continue;
    const pts = [P.clone()];
    const step = L / segs;
    const cur = P.clone();
    for (let i = 1; i <= segs; i++) {
      const f = i / segs;
      d.y += up * step * (1 - 0.4 * f) - droop * step * f;
      d.x += (r() - 0.5) * wiggle; d.y += (r() - 0.5) * wiggle * 0.6; d.z += (r() - 0.5) * wiggle;
      d.normalize();
      cur.addScaledVector(d, step);
      pts.push(cur.clone());
    }
    const pr = parent.radiusAt(t);
    const r0 = Math.max(rTip * 1.5, Math.min(pr * rRatio, 0.006 + L * 0.02));
    const s0 = parent.swayAt(t);
    out.push(new Limb(new Path(pts), r0, rTip, s0, s0 + flex * L * L, parent.level + 1));
  }
  return out;
}

// Basis for something lying in a twig's plane: Y along `dir`, Z as close to `nrm` as possible.
function basis(pos, dir, nrm, sx, sy, sz, out) {
  _b.copy(nrm).addScaledVector(dir, -nrm.dot(dir));
  if (_b.lengthSq() < 1e-4) _b.set(1, 0, 0).addScaledVector(dir, -dir.x);
  _b.normalize();
  _a.crossVectors(dir, _b);
  return out.makeBasis(_c.copy(_a).multiplyScalar(sx), _a.copy(dir).multiplyScalar(sy), _b.multiplyScalar(sz)).setPosition(pos);
}

// Real leaves along a twig: alternate, in the plane spanned by the twig and the horizon, tips sagging.
function leafTwig(limb, leaves, r, tint, { spacing = 0.036, size = 0.088, from = 0.1 } = {}) {
  const n = Math.max(2, Math.floor(limb.path.L * (1 - from) / spacing));
  const P = V(0, 0, 0), T = V(0, 0, 0), side = V(0, 0, 0), dir = V(0, 0, 0), nrm = V(0, 0, 0);
  let s = r() < 0.5 ? 1 : -1;
  for (let k = 0; k <= n; k++) {
    const last = k === n;
    const t = last ? 1 : from + (1 - from) * (k + 0.3 * r()) / n;
    limb.path.at(t, P); limb.path.tangent(t, T);
    side.crossVectors(T, UP);
    if (side.lengthSq() < 0.02) side.set(1, 0, 0);
    side.normalize().multiplyScalar(s); s = -s;
    const ang = last ? 0.15 * (r() - 0.5) : (0.75 + r() * 0.4);
    dir.copy(T).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    dir.y -= 0.12 + r() * 0.22;                           // petioles sag
    dir.normalize();
    nrm.copy(UP).addScaledVector(side, (r() - 0.5) * 0.9).addScaledVector(T, (r() - 0.5) * 0.5).normalize();
    const sc = size * (0.7 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.1))) * (0.85 + r() * 0.3);
    basis(P, dir, nrm, sc, sc, sc, _m);
    const v = 0.78 + r() * 0.36, hue = r();
    const variant = r() < 0.07 ? 3 : Math.floor(r() * 3);
    leaves.add(_m, tint[0] * v * (0.92 + hue * 0.2), tint[1] * v, tint[2] * v * (0.8 + hue * 0.3), limb.swayAt(t), r(), variant);
  }
}

// Spray cards along a branch: alternate, lying in the branch's plane with some roll and sag.
function sprayBranch(limb, cards, r, tint, { spacing = 0.42, size = 0.8, from = 0.2, variants = 4, sag = 0.25, terminal = true, shade = 1 } = {}) {
  const n = Math.max(1, Math.floor(limb.path.L * (1 - from) / spacing));
  const P = V(0, 0, 0), T = V(0, 0, 0), side = V(0, 0, 0), dir = V(0, 0, 0), nrm = V(0, 0, 0);
  let s = r() < 0.5 ? 1 : -1;
  for (let k = 0; k <= n; k++) {
    const last = k === n;
    if (last && !terminal) break;
    const t = last ? 0.97 : from + (1 - from) * (k + 0.4 * r()) / n;
    limb.path.at(t, P); limb.path.tangent(t, T);
    side.crossVectors(T, UP);
    if (side.lengthSq() < 0.02) side.set(1, 0, 0);
    side.normalize().multiplyScalar(s); s = -s;
    const ang = last ? 0.2 * (r() - 0.5) : 0.7 + r() * 0.5;
    dir.copy(T).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    dir.y -= sag * (0.3 + r());
    dir.normalize();
    nrm.copy(UP).addScaledVector(side, (r() - 0.5) * 1.1).addScaledVector(T, (r() - 0.5) * 0.6).normalize();
    const sc = size * (0.8 + r() * 0.45);
    basis(P, dir, nrm, sc, sc, sc, _m);
    const v = (0.74 + r() * 0.4) * shade * (0.62 + 0.45 * t), hue = r();
    cards.add(_m, tint[0] * v * (0.92 + hue * 0.22), tint[1] * v, tint[2] * v * (0.8 + hue * 0.3), limb.swayAt(t), r(), Math.floor(r() * variants));
  }
}

// --- Bark ---------------------------------------------------------------------------
function barkMaterial(name, { tint = [1, 1, 1], desat = 0.3, moss = 1, lichen = 0.5, normal = 1.2, mossHeight = 1.6 } = {}) {
  const b = pbr(name);
  const mossTex = tex(A('forest_leaves_02_diff.jpg'));
  const mat = new THREE.MeshStandardMaterial({
    map: b.map, normalMap: b.normal, roughness: 0.9, color: new THREE.Color(...tint), vertexColors: true,
    normalScale: new THREE.Vector2(normal, normal), envMapIntensity: 0.8,
  });
  underwater(mat);
  chain(mat, 'bark' + name + moss + lichen + desat + mossHeight, (s) => {
    Object.assign(s.uniforms, { tMossB: { value: mossTex }, tBakeB: G.tBake, uBakeB: G.uBake });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvBN = normalize(mat3(modelMatrix) * objectNormal);');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBN; uniform sampler2D tMossB, tBakeB; uniform vec4 uBakeB; float bMoss;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float l = dot(c, vec3(0.3, 0.59, 0.11));
          c = mix(c, vec3(l), ${desat.toFixed(2)});
          vec3 N = normalize(vBN);
          float ang = atan(N.z, N.x);
          // stem-flow streaks and pale lichen blotches, as on old beech
          float streak = vnoise(vec2(ang * 2.0 + vUW.x, vUW.y * 0.35));
          c *= mix(0.72, 1.08, smoothstep(0.25, 0.7, streak));
          float li = vnoise(vec2(ang * 1.6, vUW.y * 1.3) + vUW.xz * 0.7) * 0.6 + vnoise(vec2(ang * 5.0, vUW.y * 4.0) + vUW.xz * 2.0) * 0.4;
          li = smoothstep(0.56, 0.7, li) * ${lichen.toFixed(2)};
          c = mix(c, vec3(0.50, 0.55, 0.44) * (0.5 + l * 1.4), li);
          // moss: thick at the base, creeping up the damp north side and along the tops of limbs
          float ground = texture2D(tBakeB, (vUW.xz - uBakeB.xy) * uBakeB.z).r;
          float hRel = vUW.y - max(ground, 0.0);
          float low = smoothstep(${mossHeight.toFixed(2)}, 0.05, hRel);
          float northish = dot(normalize(N.xz + 1e-4), normalize(vec2(0.55, 0.83))) * 0.5 + 0.5;
          float top = smoothstep(0.15, 0.85, N.y);
          float mn = vnoise(vUW.xz * 3.0 + vUW.y * 2.0) * 0.6 + vnoise(vUW.xy * 9.0 + vUW.z * 7.0) * 0.4;
          float m = ${moss.toFixed(2)} * (low * (0.55 + 0.7 * northish) + top * 0.8 * smoothstep(14.0, 2.0, hRel) + 0.35 * northish * smoothstep(7.0, 1.0, hRel)) + (mn - 0.5) * 0.9 - (l - 0.35) * 0.5;
          bMoss = smoothstep(0.38, 0.62, m);
          vec3 mt = texture2D(tMossB, vec2(ang * 0.7 + vUW.x * 0.3, vUW.y * 0.8)).rgb;
          vec3 mc = mt * vec3(0.34, 0.6, 0.17) * (0.75 + 0.5 * mn);
          c = mix(c, mc, bMoss);
          c *= mix(0.55, 1.0, smoothstep(0.0, 0.3, hRel));         // dirt-dark where trunk meets soil
          diffuseColor.rgb = c;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 1.0, bMoss);`);
  });
  dapple(mat);
  wind(mat, { mode: 'attr' });
  return mat;
}

function barkDepth() {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  wind(d, { mode: 'attr' });
  return d;
}

// --- Hero trees -----------------------------------------------------------------------
function addKnots(r, L, n, rad) {
  const k = [];
  for (let i = 0; i < n; i++) k.push({ d: 0.5 + r() * (L - 0.6), a: r() * 6.28, s: rad * (0.12 + r() * 0.16) });
  return k;
}

// Surface roots: snake outward from the flare, half buried, diving into the soil (or the river).
function roots(x, z, y0, r, geos, { count = 6, len = 2.2, rad = 0.11, seed = 0 }) {
  for (let i = 0; i < count; i++) {
    let a = seed + (i / count) * 6.283 + (r() - 0.5) * 0.5;
    const L = len * (0.55 + r() * 0.7), n = 7, pts = [];
    let px = x + Math.cos(a) * 0.1, pz = z + Math.sin(a) * 0.1;
    pts.push(V(px, y0 + 0.5, pz));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      a += (r() - 0.5) * 0.7;
      px += Math.cos(a) * L / n; pz += Math.sin(a) * L / n;
      const g = heightAt(px, pz);
      const rr = rad * (1 - 0.8 * f);
      pts.push(V(px, g + rr * (0.55 - 1.6 * f * f) + (k === 1 ? 0.12 : 0), pz));
    }
    const limb = new Limb(smoothPath(pts, 6), rad * (0.8 + r() * 0.5), 0.012, 0, 0, 1);
    geos.push(tube(limb, { radial: 9, lumps: 0.16, seed: seed + i * 3.1, collar: 0.5, barkTile: 0.7 }));
  }
}

function growHero(mains, r, out, tint, { branchCount = 14, twigDensity = 1 } = {}) {
  for (const main of mains) {
    const big = main.path.L > 4;
    const l1 = big ? sprout(main, { count: branchCount * main.path.L / 7, t0: 0.22, t1: 0.97, angle: [42, 68], len: (t, p) => Math.min(2.6, 0.5 + p.path.L * 0.32) * (1 - 0.45 * t), rRatio: 0.42, up: 0.12, droop: 0.1, planar: true, wiggle: 0.14, segs: 6, flex: 0.012, twist: 0.5 }, r) : [];
    l1.push(new Limb(new Path(main.path.p.slice(-3)), main.radiusAt(0.9), 0.004, main.swayAt(0.9), main.s1, main.level + 1));
    if (!big) l1.push(main);
    for (const b1 of l1) {
      if (b1 !== main) out.geos.push(tube(b1, { radial: 6, collar: 0.5, barkTile: 0.6 }));
      const l2 = sprout(b1, { count: Math.max(2, b1.path.L * 5.6), t0: 0.18, t1: 0.96, angle: [38, 62], len: (t, p) => Math.min(1.0, 0.25 + p.path.L * 0.38) * (1 - 0.4 * t), rRatio: 0.5, rTip: 0.003, up: 0.05, droop: 0.22, planar: true, wiggle: 0.16, segs: 4, flex: 0.02 }, r);
      l2.push(new Limb(new Path(b1.path.p.slice(-2)), b1.radiusAt(0.85), 0.003, b1.swayAt(0.85), b1.s1, b1.level + 1));
      for (const b2 of l2) {
        out.twigs.push(tube(b2, { radial: 4, barkTile: 0.5 }));
        const l3 = sprout(b2, { count: Math.max(1, b2.path.L * 8.5 * twigDensity), t0: 0.15, t1: 0.92, angle: [35, 58], len: (t, p) => Math.min(0.5, 0.16 + p.path.L * 0.45), rRatio: 0.6, rTip: 0.002, droop: 0.35, planar: true, wiggle: 0.12, segs: 3, flex: 0.03 }, r);
        for (const tw of l3) { out.twigs.push(tube(tw, { radial: 3, barkTile: 0.5 })); leafTwig(tw, out.leaves, r, tint); }
        leafTwig(b2, out.leaves, r, tint, { from: 0.45 });
      }
    }
  }
}

function heroLeft(out, r) {
  const { x, z } = HERO_TREES.left;
  const y0 = heightAt(x, z);
  const P = (dx, dy, dz) => V(x + dx, y0 + dy, z + dz);
  // The trunk sweeps straight into the leading limb; two more leaders split off at the fork.
  const trunkPath = smoothPath([P(0, -0.7, 0), P(0.02, 0.5, -0.02), P(0.08, 1.5, -0.08), P(0.2, 2.5, -0.22), P(0.12, 3.7, -0.62), P(-0.25, 5.2, -1.2), P(-0.85, 7.2, -1.7), P(-1.15, 9.6, -2.3), P(-0.9, 12.4, -2.9), P(-1.4, 15.4, -3.3)], 7);
  const trunk = new Limb(trunkPath, 0.37, 0.04, 0, 0.5, 0);
  trunk.radiusAt = (t) => { const d = t * trunkPath.L; return d < 3.2 ? lerp(0.37, 0.3, d / 3.2) : lerp(0.25, 0.04, Math.pow((d - 3.2) / (trunkPath.L - 3.2), 0.8)) + 0.05 * Math.exp(-(d - 3.2) * 1.5); };
  trunk.swayAt = (t) => 0.5 * Math.pow(Math.max(0, t - 0.12), 2);
  out.geos.push(tube(trunk, { radial: 30, flare: 1.15, flareLobes: 5, flareH: 0.42, seed: 1.3, lumps: 0.07, knots: addKnots(r, 6, 9, 0.36), barkTile: 1.5, ground: y0 }));
  roots(x, z, y0, r, out.geos, { count: 7, len: 2.4, rad: 0.12, seed: 0.4 });
  const leader = (pts, r0, r1, s1) => new Limb(smoothPath(pts, 6), r0, r1, 0.004, s1, 1);
  const mains = [
    // arches right, across the path and the top of the frame
    leader([P(0.16, 2.15, -0.16), P(0.72, 3.15, -0.12), P(1.6, 4.15, 0.08), P(2.75, 4.95, 0.2), P(4.05, 5.55, 0.02), P(5.4, 6.3, -0.4), P(6.7, 7.5, -0.9)], 0.24, 0.035, 0.55),
    // back-left leader
    leader([P(0.06, 1.95, -0.02), P(-0.55, 2.95, 0.28), P(-1.45, 3.95, 0.66), P(-2.6, 4.75, 0.9), P(-3.8, 5.8, 1.0), P(-5.0, 7.3, 0.8)], 0.21, 0.035, 0.5),
    // long low limb reaching out over the water
    leader([P(0.14, 3.3, -0.5), P(0.32, 3.75, -1.3), P(0.62, 3.95, -2.5), P(0.82, 3.9, -3.9), P(1.25, 4.3, -5.4)], 0.11, 0.02, 0.4),
    // a thin low branch drooping toward the viewer
    leader([P(1.25, 3.82, 0.0), P(1.75, 3.7, 0.75), P(2.2, 3.35, 1.6), P(2.5, 3.05, 2.5)], 0.055, 0.008, 0.3),
    leader([P(-0.7, 6.6, -1.6), P(-1.8, 7.4, -1.1), P(-3.0, 8.3, -0.9), P(-4.1, 9.6, -1.0)], 0.1, 0.02, 0.5),
    leader([P(-1.05, 8.8, -2.1), P(-0.2, 9.9, -2.9), P(0.9, 10.8, -3.6), P(2.0, 12.1, -4.0)], 0.09, 0.02, 0.5),
    leader([P(-1.0, 11.0, -2.6), P(-2.0, 12.0, -3.2), P(-3.0, 13.4, -3.4)], 0.07, 0.015, 0.5),
  ];
  mains.forEach((m, i) => out.geos.push(tube(m, { radial: i < 2 ? 18 : 10, collar: i < 2 ? 0.35 : 0.55, lumps: 0.05, seed: i * 2.1, knots: i < 2 ? addKnots(r, 4, 4, m.r0) : null, barkTile: i < 2 ? 1.5 : 0.75 })));
  const top = new Limb(new Path(trunkPath.p.filter((_, i) => trunkPath.cum[i] > 5.5)), 0.17, 0.04, 0.03, 0.5, 1);
  growHero([...mains, top], r, out, [1.0, 1.0, 1.0], { twigDensity: out.twigDensity });
}

function heroRight(out, r) {
  const { x, z } = HERO_TREES.right;
  const y0 = heightAt(x, z);
  const P = (dx, dy, dz) => V(x + dx, y0 + dy, z + dz);
  const trunkPath = smoothPath([P(0.05, -0.8, 0.03), P(0, 0.6, 0), P(-0.06, 2.2, -0.05), P(-0.2, 4.5, -0.16), P(-0.42, 7.5, -0.3), P(-0.6, 11, -0.42), P(-0.66, 15, -0.5), P(-0.55, 19, -0.6), P(-0.7, 23, -0.7)], 6);
  const trunk = new Limb(trunkPath, 0.31, 0.05, 0, 0.9, 0);
  trunk.swayAt = (t) => 0.9 * Math.pow(Math.max(0, t - 0.1), 2.2);
  out.geos.push(tube(trunk, { radial: 26, flare: 1.5, flareLobes: 4, flareH: 0.55, seed: 4.1, lumps: 0.06, knots: addKnots(r, 9, 10, 0.3), barkTile: 1.5, ground: y0 }));
  roots(x, z, y0, r, out.geos, { count: 8, len: 2.9, rad: 0.13, seed: 2.2 });
  const leader = (pts, r0, r1, s1) => new Limb(smoothPath(pts, 6), r0, r1, 0.004, s1, 1);
  const mains = [
    // low branches sweeping out over the pool
    leader([P(-0.08, 2.9, -0.06), P(-0.7, 3.4, -0.3), P(-1.6, 3.6, -0.75), P(-2.7, 3.45, -1.2), P(-3.8, 3.6, -1.5)], 0.075, 0.012, 0.4),
    leader([P(-0.18, 4.3, -0.15), P(-0.5, 4.9, -1.0), P(-0.9, 5.2, -2.2), P(-1.2, 5.1, -3.4), P(-1.3, 5.5, -4.5)], 0.085, 0.012, 0.45),
    leader([P(-0.25, 5.4, -0.2), P(0.4, 6.0, 0.5), P(1.2, 6.4, 1.3), P(1.9, 6.5, 2.3)], 0.07, 0.012, 0.4),
    leader([P(-0.3, 6.2, -0.24), P(-1.2, 7.0, 0.3), P(-2.4, 7.5, 0.9), P(-3.6, 7.6, 1.6), P(-4.6, 8.1, 2.2)], 0.09, 0.012, 0.5),
  ];
  // scaffold limbs of the crown, spiralling up the trunk
  let az = 0.6;
  for (let h = 8.2; h < 22; h += 1.15 + r() * 0.5) {
    az += 2.4 + (r() - 0.5) * 0.5;
    const t = h / 24, len = lerp(6.2, 2.4, smoothstep(0.35, 0.95, t)) * (0.8 + r() * 0.4);
    const base = trunkPath.at(h / trunkPath.L * 1.02 + 0.03);
    const dir = V(Math.cos(az), 0.45 + t * 0.6, Math.sin(az)).normalize();
    const pts = [base.clone()], cur = base.clone();
    for (let i = 1; i <= 5; i++) { dir.y += 0.07 - 0.02 * i; dir.x += (r() - 0.5) * 0.12; dir.z += (r() - 0.5) * 0.12; dir.normalize(); cur.addScaledVector(dir, len / 5); pts.push(cur.clone()); }
    mains.push(leader(pts, lerp(0.12, 0.05, t), 0.012, 0.3 + t * 0.4));
  }
  mains.forEach((m, i) => out.geos.push(tube(m, { radial: 10, collar: 0.6, lumps: 0.04, seed: i, barkTile: 0.75 })));
  growHero(mains, r, out, [0.95, 1.0, 0.95], { branchCount: 12, twigDensity: out.twigDensity });
}

// --- Forest ---------------------------------------------------------------------------
function forestTree(x, z, r, out, kind) {
  const y0 = heightAt(x, z);
  const far = kind === 'far', mid = kind === 'mid';
  const H = 21 + r() * 9, R = 0.24 + r() * r() * 0.46;
  // Trees on the bank lean out over the water toward the light.
  const rv = river(x, z);
  const e = Math.abs(rv.d) - rv.w;
  const toward = -Math.sign(rv.d) * smoothstep(9, 1.5, e) * (0.05 + r() * 0.12);
  const lx = -rv.tz * toward + (r() - 0.5) * 0.06, lz = rv.tx * toward + (r() - 0.5) * 0.06;
  const ctrl = [];
  const bend = (r() - 0.5) * 0.9, ba = r() * 6.28;
  for (let i = 0; i <= 6; i++) {
    const f = i / 6, h = f * H;
    const s = Math.sin(f * Math.PI) * bend;
    ctrl.push(V(x + lx * h * (0.6 + f) + Math.cos(ba) * s + (i > 0 ? (r() - 0.5) * 0.18 : 0), y0 - 0.6 + h, z + lz * h * (0.6 + f) + Math.sin(ba) * s + (i > 0 ? (r() - 0.5) * 0.18 : 0)));
  }
  const path = smoothPath(ctrl, far ? 0.5 : 1.3);
  const trunk = new Limb(path, R, R * 0.16, 0, 1.0, 0);
  trunk.radiusAt = (t) => R * (1 - 0.84 * Math.pow(t, 1.25));
  trunk.swayAt = (t) => 1.0 * Math.pow(Math.max(0, t - 0.1), 2.3);
  out.geos.push(tube(trunk, { radial: far ? 7 : 14, flare: far ? 0 : 0.85, flareLobes: 4 + Math.floor(r() * 3), flareH: 0.4 + R * 0.5, seed: r() * 10, lumps: far ? 0 : 0.05, barkTile: 1.3, ground: y0 }));
  out.contacts.push({ x, z, r: R * 2.6, dark: 0.5, moss: 0.6 });
  // crown: long clear bole, then scaffold limbs spiralling up
  const crown0 = 0.36 + r() * 0.14;
  const tint = [0.9 + r() * 0.25, 0.95 + r() * 0.12, 0.8 + r() * 0.3];
  let az = r() * 6.28;
  const nL = far ? 10 : 14 + Math.floor(r() * 5);
  for (let k = 0; k < nL; k++) {
    const f = (k + r() * 0.6) / nL;
    const t = lerp(crown0, 0.97, Math.pow(f, 0.9));
    az += 2.39996 + (r() - 0.5) * 0.7;
    const base = path.at(t);
    const len = lerp(7.4, 2.4, smoothstep(0.15, 1, f)) * (0.75 + r() * 0.5) * (H / 26);
    const dir = V(Math.cos(az), 0.3 + f * 0.75, Math.sin(az)).normalize();
    const pts = [base.clone()], cur = base.clone(), segs = far ? 3 : 5;
    for (let i = 1; i <= segs; i++) { dir.y += 0.09 - 0.03 * i * (5 / segs); dir.x += (r() - 0.5) * 0.14; dir.z += (r() - 0.5) * 0.14; dir.normalize(); cur.addScaledVector(dir, len / segs); pts.push(cur.clone()); }
    const s0 = trunk.swayAt(t);
    const limb = new Limb(new Path(pts), Math.min(trunk.radiusAt(t) * 0.55, 0.12), 0.012, s0, s0 + 0.35, 1);
    out.geos.push(tube(limb, { radial: far ? 4 : 6, collar: 0.5, barkTile: 0.8 }));
    const shade = lerp(0.72, 1.05, f);                      // lower crown sits in the shade of the upper
    if (far) { sprayBranch(limb, out.boughs, r, tint, { spacing: 0.8, size: 2.7, from: 0.2, variants: 2, sag: 0.2, shade }); continue; }
    const branches = sprout(limb, { count: mid ? 5 : 8.5, t0: 0.25, t1: 0.95, angle: [40, 65], len: (tt) => (0.9 + len * 0.26) * (1 - 0.4 * tt), rRatio: 0.45, rTip: 0.006, up: 0.04, droop: 0.12, planar: true, wiggle: 0.14, segs: 3, flex: 0.02, twist: 0.4 }, r);
    for (const b of branches) {
      out.small.push(tube(b, { radial: 4, barkTile: 0.6 }));
      if (mid) sprayBranch(b, out.boughs, r, tint, { spacing: 0.9, size: 1.9, from: 0.2, variants: 2, shade });
      else sprayBranch(b, out.sprays, r, tint, { spacing: 0.3, size: 0.85, from: 0.12, shade });
    }
    if (!mid) sprayBranch(limb, out.sprays, r, tint, { spacing: 0.4, size: 0.9, from: 0.5, shade });
    if (k % 2 === 0) sprayBranch(limb, out.boughs, r, tint, { spacing: 1.5, size: 2.3, from: 0.3, variants: 2, terminal: false, shade: shade * 0.8 });
  }
}

// Understory beech saplings: thin whippy stems with flat layered sprays, the bright mid-level green.
function sapling(x, z, r, out) {
  const y0 = heightAt(x, z);
  const H = 1.4 + r() * r() * 4.5, R = 0.012 + H * 0.007;
  const lean = r() * 6.28, la = 0.1 + r() * 0.25;
  const ctrl = [];
  for (let i = 0; i <= 4; i++) { const f = i / 4; ctrl.push(V(x + Math.cos(lean) * la * H * f * f, y0 - 0.1 + H * f, z + Math.sin(lean) * la * H * f * f)); }
  const stem = new Limb(smoothPath(ctrl, 3), R, 0.004, 0, 0.12 * H * 0.4, 0);
  out.small.push(tube(stem, { radial: 5, barkTile: 0.4 }));
  const tint = [0.95 + r() * 0.2, 1.02 + r() * 0.1, 0.75 + r() * 0.25];
  const br = sprout(stem, { count: 3 + H * 2.2, t0: 0.25, t1: 0.97, angle: [55, 80], len: (t) => (0.45 + H * 0.22) * (1 - 0.55 * t), rRatio: 0.5, rTip: 0.003, up: 0.02, droop: 0.1, planar: false, wiggle: 0.12, segs: 3, flex: 0.05 }, r);
  for (const b of br) {
    out.small.push(tube(b, { radial: 3, barkTile: 0.4 }));
    sprayBranch(b, out.sprays, r, tint, { spacing: 0.3, size: 0.62, from: 0.2, sag: 0.15, shade: 1.0 });
  }
  sprayBranch(stem, out.sprays, r, tint, { spacing: 0.4, size: 0.6, from: 0.8 });
}

export function createTrees(quality) {
  const hi = quality !== 'low';
  const r = rng(1234);
  const heroL = { geos: [], twigs: [], leaves: new Instances(), twigDensity: hi ? 1 : 0.45 };
  const heroR = { geos: [], twigs: [], leaves: new Instances(), twigDensity: hi ? 1 : 0.45 };
  heroLeft(heroL, r);
  heroRight(heroR, r);

  const forest = { geos: [], small: [], sprays: new Instances(), boughs: new Instances(), contacts: [] };
  const placed = [{ x: HERO_TREES.left.x, z: HERO_TREES.left.z }, { x: HERO_TREES.right.x, z: HERO_TREES.right.z }];
  const tooClose = (x, z, d) => placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < d * d);
  const okGround = (x, z, margin) => {
    const rv = river(x, z);
    if (bankE(x, z, rv) < margin) return false;
    if (pathDist(x, z) < 1.9) return false;
    if (Math.hypot(x - 0.2, z - 8.6) < 3.2) return false;        // the viewer's spot on the trail
    if (ROCKS.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + 0.5)) return false;
    return true;
  };
  // Near and middle forest: full trees with twig sprays.
  let tries = 0, nNear = 0;
  const nearTarget = hi ? 135 : 80;
  while (nNear < nearTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 5 + Math.pow(r(), 0.75) * 50;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (!okGround(x, z, 0.9 + r() * 2.5) || tooClose(x, z, 3.6 + r() * 2.2)) continue;
    placed.push({ x, z }); nNear++;
    forestTree(x, z, r, forest, Math.hypot(x + 1, z + 3) < (hi ? 30 : 20) ? 'near' : 'mid');
  }
  // Far ring: cheaper trees (bough cards only) that close the view and carry the atmospheric depth.
  let nFar = 0; tries = 0;
  const farTarget = hi ? 170 : 90;
  while (nFar < farTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 50 + Math.pow(r(), 0.8) * 75;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (bankE(x, z) < 1.5 || tooClose(x, z, 5.5)) continue;
    placed.push({ x, z }); nFar++;
    forestTree(x, z, r, forest, 'far');
  }
  // Understory.
  let nSap = 0; tries = 0;
  const sapTarget = hi ? 150 : 70;
  const saps = [];
  while (nSap < sapTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 3 + Math.pow(r(), 0.9) * 40;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (!okGround(x, z, 0.5) || saps.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 1.6) || tooClose(x, z, 0.9)) continue;
    if (fbm(x * 0.09, z * 0.09, 2, 40) < -0.08) continue;      // saplings come in thickets
    saps.push({ x, z }); nSap++;
    sapling(x, z, r, forest);
  }

  const barkHero = barkMaterial('japanese_hackberry_bark', { tint: [1.5, 1.5, 1.38], desat: 0.5, moss: 0.85, lichen: 0.6, normal: 1.7, mossHeight: 1.3 });
  const barkForest = barkMaterial('japanese_hackberry_bark', { tint: [1.3, 1.3, 1.2], desat: 0.55, moss: 0.85, lichen: 0.7, normal: 1.2, mossHeight: 1.3 });
  const depth = barkDepth();

  const group = new THREE.Group();
  const noReflect = [];
  const addWood = (geos, mat, { shadow = true, reflect = true } = {}) => {
    if (!geos.length) return null;
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.castShadow = shadow; m.receiveShadow = true; m.customDepthMaterial = depth;
    group.add(m);
    if (!reflect) noReflect.push(m);
    return m;
  };
  addWood([...heroL.geos, ...heroR.geos], barkHero);
  addWood([...heroL.twigs, ...heroR.twigs], barkHero, { shadow: false, reflect: false });
  addWood(forest.geos, barkForest);
  addWood(forest.small, barkForest, { shadow: false, reflect: false });

  const leafGeo = leafGeometry();
  const lm = leafMaterials();
  const thinned = [];
  for (const h of [heroL, heroR]) { const m = h.leaves.build(leafGeo, lm, { shadowFrac: 0.7, mirrorFrac: 0.3 }); thinned.push(m); group.add(m); }
  const sprayM = cardMaterials('spray_atlas', 2, 2);
  const boughM = cardMaterials('bough_atlas', 2, 1);
  const sprays = forest.sprays.build(cardGeometry(2, 0.16, 0.1), sprayM, { shadowFrac: 0.5, mirrorFrac: 0.5 });
  const boughs = forest.boughs.build(cardGeometry(2, 0.12, 0.08), boughM, { shadowFrac: 0.2, mirrorFrac: 0.6 });
  thinned.push(sprays, boughs);
  sprays.frustumCulled = false; boughs.frustumCulled = false;
  group.add(sprays, boughs);

  group.userData.contacts = forest.contacts;
  group.userData.noReflect = noReflect;
  group.userData.thinned = thinned;
  group.userData.counts = { near: nNear, far: nFar, saplings: nSap, heroLeaves: heroL.leaves.count + heroR.leaves.count, sprays: forest.sprays.count, boughs: forest.boughs.count };
  console.warn('trees', JSON.stringify(group.userData.counts));
  return group;
}
