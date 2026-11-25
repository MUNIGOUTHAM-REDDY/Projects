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
function tube(limb, { radial = 8, flare = 0, flareLobes = 5, flareH = 0.5, seed = 0, lumps = 0, collar = 0, knots = null, barkTile = 1.2, ground = null, tintV = null } = {}) {
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
      sway.push(sw); if (tintV) col.push(ao * tintV[0], ao * tintV[1], ao * tintV[2]); else col.push(ao, ao, ao);
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
    const child = new Limb(new Path(pts), r0, rTip, s0, s0 + flex * L * L, parent.level + 1);
    child.tp = t;
    out.push(child);
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

// Real leaves along a twig: alternate and roughly in the twig's plane, but as untidy as the real thing:
// uneven spacing bunched toward the tip, missing leaves, every size, each rolled and pitched its own way.
function leafTwig(limb, leaves, r, tint, { spacing = 0.034, size = 0.1, from = 0.1, shade = 1 } = {}) {
  const n = Math.max(2, Math.floor(limb.path.L * (1 - from) / spacing));
  const P = V(0, 0, 0), T = V(0, 0, 0), side = V(0, 0, 0), dir = V(0, 0, 0), nrm = V(0, 0, 0);
  let s = r() < 0.5 ? 1 : -1;
  const twigHue = r(), twigV = 0.85 + r() * 0.3;
  for (let k = 0; k <= n; k++) {
    const last = k === n;
    const u = (k + (r() - 0.5) * 0.9) / n;
    const t = last ? 1 : from + (1 - from) * Math.pow(clamp(u, 0, 1), 0.72);
    s = -s;
    if (!last && r() < 0.3 - 0.27 * t) continue;            // gaps, mostly on the older wood
    limb.path.at(t, P); limb.path.tangent(t, T);
    side.crossVectors(T, UP);
    if (side.lengthSq() < 0.02) side.set(1, 0, 0);
    side.normalize().multiplyScalar(s);
    const ang = last ? 0.3 * (r() - 0.5) : (0.5 + r() * 0.85);
    dir.copy(T).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    dir.y += 0.12 - r() * 0.62;                            // most petioles sag, a few reach up
    dir.x += (r() - 0.5) * 0.3; dir.z += (r() - 0.5) * 0.3;
    dir.normalize();
    nrm.copy(UP).addScaledVector(side, (r() - 0.5) * 1.7).addScaledVector(T, (r() - 0.5) * 1.2);
    if (r() < 0.06) nrm.multiplyScalar(-1);                 // the odd leaf hangs twisted, pale side out
    nrm.normalize();
    const sc = size * (0.72 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.1))) * (0.6 + r() * 0.8);
    basis(P, dir, nrm, sc * (0.85 + r() * 0.3), sc, sc, _m);
    const v = (0.72 + r() * 0.42) * twigV * shade, hue = twigHue * 0.6 + r() * 0.4;
    const variant = r() < 0.08 ? 3 : Math.floor(r() * 3);
    const yel = r() < 0.03 ? 1.35 : 1;
    leaves.add(_m, tint[0] * v * (0.86 + hue * 0.32) * yel, tint[1] * v * (0.96 + hue * 0.08), tint[2] * v * (0.7 + hue * 0.5), limb.swayAt(t), r(), variant);
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
    const v = (0.74 + r() * 0.4) * shade * (0.46 + 0.62 * t), hue = r();
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
          c = mix(c, vec3(0.40, 0.45, 0.36) * (0.5 + l * 1.4), li);
          // moss: thick at the base, creeping up the damp north side and along the tops of limbs
          float ground = texture2D(tBakeB, (vUW.xz - uBakeB.xy) * uBakeB.z).r;
          float hRel = vUW.y - max(ground, 0.0);
          float low = smoothstep(${mossHeight.toFixed(2)}, 0.05, hRel) * smoothstep(-0.35, 0.45, N.y);
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
function roots(x, z, y0, r, geos, { count = 6, len = 2.2, rad = 0.11, seed = 0, heading = null, spread = 0.9, tintV = null }) {
  for (let i = 0; i < count; i++) {
    let a = heading === null ? seed + (i / count) * 6.283 + (r() - 0.5) * 0.5 : heading + ((i + 0.5) / count - 0.5) * 2 * spread + (r() - 0.5) * 0.3;
    const L = len * (0.55 + r() * 0.7), n = 7, pts = [];
    let px = x + Math.cos(a) * 0.1, pz = z + Math.sin(a) * 0.1;
    pts.push(V(px, y0 + 0.5, pz));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      a += (r() - 0.5) * 1.0;
      px += Math.cos(a) * L / n; pz += Math.sin(a) * L / n;
      const g = heightAt(px, pz);
      const rr = rad * (1 - 0.8 * f);
      pts.push(V(px, Math.max(g, -0.25) + rr * (0.85 - 2.0 * f * f) + (k === 1 ? 0.12 : 0), pz));
    }
    const limb = new Limb(smoothPath(pts, 6), rad * (0.8 + r() * 0.5), 0.012, 0, 0, 1);
    geos.push(tube(limb, { radial: heading === null ? 9 : 8, lumps: 0.07, seed: seed + i * 3.1, collar: 0.5, barkTile: 0.7, tintV }));
  }
}

function growHero(mains, r, out, tint, { branchCount = 14, twigDensity = 1 } = {}) {
  for (const main of mains) {
    const big = main.path.L > 4;
    const t0 = main.r0 > 0.15 ? 0.34 : 0.12;               // heavy leaders stay clean near the fork
    const l1 = big ? sprout(main, { count: branchCount * main.path.L / 7, t0, t1: 0.97, angle: [42, 68], len: (t, p) => Math.min(2.6, 0.5 + p.path.L * 0.32) * (1 - 0.45 * t), rRatio: 0.42, up: 0.12, droop: 0.1, planar: true, wiggle: 0.2, segs: 6, flex: 0.012, twist: 0.5 }, r) : [];
    const tail = new Limb(new Path(main.path.p.slice(-3)), main.radiusAt(0.9), 0.004, main.swayAt(0.9), main.s1, main.level + 1);
    tail.tp = 1; tail.isTail = true;
    l1.push(tail);
    if (!big) { main.tp = 0.7; l1.push(main); }
    for (const b1 of l1) {
      if (b1 !== main && !b1.isTail) out.geos.push(tube(b1, { radial: 6, collar: 0.5, barkTile: 0.6 }));
      const outer1 = 0.72 + 0.3 * (b1.tp ?? 0.7);
      const l2 = sprout(b1, { count: Math.max(2, b1.path.L * 5.6), t0: 0.18, t1: 0.96, angle: [38, 62], len: (t, p) => Math.min(1.0, 0.25 + p.path.L * 0.38) * (1 - 0.4 * t), rRatio: 0.5, rTip: 0.003, up: 0.05, droop: 0.22, planar: true, wiggle: 0.2, segs: 4, flex: 0.02 }, r);
      const t2 = new Limb(new Path(b1.path.p.slice(-2)), b1.radiusAt(0.85), 0.003, b1.swayAt(0.85), b1.s1, b1.level + 1);
      t2.tp = 1; l2.push(t2);
      for (const b2 of l2) {
        // leaves deep inside the crown sit in the shade of the shell
        const shade = outer1 * (0.48 + 0.58 * b2.tp);
        out.twigs.push(tube(b2, { radial: 4, barkTile: 0.5 }));
        const l3 = sprout(b2, { count: Math.max(1, b2.path.L * 8.5 * twigDensity), t0: 0.15, t1: 0.92, angle: [30, 62], len: (t, p) => Math.min(0.5, 0.16 + p.path.L * 0.45), rRatio: 0.6, rTip: 0.002, droop: 0.35, planar: true, wiggle: 0.18, segs: 3, flex: 0.03 }, r);
        for (const tw of l3) { out.twigs.push(tube(tw, { radial: 3, barkTile: 0.5 })); leafTwig(tw, out.leaves, r, tint, { shade: shade * (0.85 + 0.2 * tw.tp) }); }
        leafTwig(b2, out.leaves, r, tint, { from: 0.45, shade });
      }
    }
  }
}

// Limbs are never smooth arcs: jog the control points so they kink where old side branches were shed.
function kinked(pts, r, amt = 0.1) {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const seg = p.distanceTo(pts[i - 1]) * amt;
    return V(p.x + (r() - 0.5) * 2 * seg, p.y + (r() - 0.5) * 1.4 * seg, p.z + (r() - 0.5) * 2 * seg);
  });
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
  roots(x, z, y0, r, out.geos, { count: 2, len: 5.6, rad: 0.085, seed: 7.7, heading: 0.31, spread: 0.3 });   // across the trail
  const leader = (pts, r0, r1, s1) => new Limb(smoothPath(kinked(pts, r, r0 > 0.15 ? 0.05 : 0.16), 6), r0, r1, 0.004, s1, 1);
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
  growHero([...mains, top], r, out, [1.0, 1.0, 0.9], { twigDensity: out.twigDensity });
}

function heroRight(out, r) {
  const { x, z } = HERO_TREES.right;
  const y0 = heightAt(x, z);
  const P = (dx, dy, dz) => V(x + dx, y0 + dy, z + dz);
  const trunkPath = smoothPath([P(0.05, -0.8, 0.03), P(0, 0.6, 0), P(-0.06, 2.2, -0.05), P(-0.2, 4.5, -0.16), P(-0.42, 7.5, -0.3), P(-0.6, 11, -0.42), P(-0.66, 15, -0.5), P(-0.55, 19, -0.6), P(-0.7, 23, -0.7)], 6);
  const trunk = new Limb(trunkPath, 0.31, 0.05, 0, 0.9, 0);
  trunk.swayAt = (t) => 0.9 * Math.pow(Math.max(0, t - 0.1), 2.2);
  out.geos.push(tube(trunk, { radial: 26, flare: 1.5, flareLobes: 4, flareH: 0.55, seed: 4.1, lumps: 0.06, knots: addKnots(r, 9, 10, 0.3), barkTile: 1.5, ground: y0 }));
  roots(x, z, y0, r, out.rootGeos, { count: 8, len: 2.9, rad: 0.13, seed: 2.2, tintV: [0.6, 0.57, 0.52] });
  roots(x, z, y0, r, out.geos, { count: 2, len: 5.8, rad: 0.08, seed: 5.1, heading: 2.48, spread: 0.3 });
  const leader = (pts, r0, r1, s1) => new Limb(smoothPath(kinked(pts, r, r0 > 0.15 ? 0.05 : 0.16), 6), r0, r1, 0.004, s1, 1);
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
    for (let i = 1; i <= 5; i++) { dir.y += 0.07 - 0.02 * i; dir.x += (r() - 0.5) * 0.3; dir.z += (r() - 0.5) * 0.3; dir.normalize(); cur.addScaledVector(dir, len / 5); pts.push(cur.clone()); }
    mains.push(leader(pts, lerp(0.12, 0.05, t), 0.012, 0.3 + t * 0.4));
  }
  mains.forEach((m, i) => out.geos.push(tube(m, { radial: 10, collar: 0.6, lumps: 0.04, seed: i, barkTile: 0.75 })));
  growHero(mains, r, out, [0.8, 0.9, 0.85], { branchCount: 12, twigDensity: out.twigDensity });
}

// --- Forest ---------------------------------------------------------------------------
// One crown axis (a trunk or a co-dominant leader) carrying scaffold limbs that spiral up it.
function crown(axis, r, out, { t0, nL, lenBase, far, mid, tint, tintV, H }) {
  let az = r() * 6.28;
  for (let k = 0; k < nL; k++) {
    const f = (k + r() * 0.6) / nL;
    const t = lerp(t0, 0.97, Math.pow(f, 0.9));
    az += 2.39996 + (r() - 0.5) * 0.9;
    const base = axis.path.at(t);
    const len = lerp(lenBase, lenBase * 0.32, smoothstep(0.15, 1, f)) * (0.6 + r() * 0.8);
    const dir = V(Math.cos(az), 0.25 + f * 0.8 + (r() - 0.5) * 0.3, Math.sin(az)).normalize();
    const pts = [base.clone()], cur = base.clone(), segs = far ? 3 : 5;
    for (let i = 1; i <= segs; i++) { dir.y += 0.09 - 0.03 * i * (5 / segs); dir.x += (r() - 0.5) * 0.3; dir.z += (r() - 0.5) * 0.3; dir.normalize(); cur.addScaledVector(dir, len / segs); pts.push(cur.clone()); }
    const s0 = axis.swayAt(t);
    const limb = new Limb(new Path(pts), Math.min(axis.radiusAt(t) * 0.55, 0.014 + len * 0.016), 0.012, s0, s0 + 0.35, 1);
    out.geos.push(tube(limb, { radial: far ? 4 : 6, collar: 0.5, barkTile: 0.8, tintV }));
    const shade = lerp(0.66, 1.05, f);                      // lower crown sits in the shade of the upper
    if (far) { sprayBranch(limb, out.boughs, r, tint, { spacing: 0.8, size: 2.7, from: 0.2, variants: 2, sag: 0.2, shade }); continue; }
    const branches = sprout(limb, { count: (mid ? 5 : 8.5) * len / 5.5, t0: 0.2, t1: 0.95, angle: [40, 65], len: (tt) => (0.9 + len * 0.26) * (1 - 0.4 * tt), rRatio: 0.45, rTip: 0.006, up: 0.04, droop: 0.12, planar: true, wiggle: 0.2, segs: 3, flex: 0.02, twist: 0.4 }, r);
    for (const b of branches) {
      out.small.push(tube(b, { radial: 4, barkTile: 0.6, tintV }));
      if (mid) sprayBranch(b, out.boughs, r, tint, { spacing: 0.9, size: 1.9, from: 0.2, variants: 2, shade });
      else sprayBranch(b, out.sprays, r, tint, { spacing: 0.3, size: 0.85, from: 0.12, shade });
    }
    if (!mid) sprayBranch(limb, out.sprays, r, tint, { spacing: 0.4, size: 0.9, from: 0.5, shade });
    if (k % 2 === 0) sprayBranch(limb, out.boughs, r, tint, { spacing: 1.5, size: 2.3, from: 0.3, variants: 2, terminal: false, shade: shade * 0.8 });
  }
}

// Forest trees come in several characters: tall clean-boled beeches, heavy old trees that fork into
// co-dominant leaders, slender leaning poles with low crowns, and the occasional dead snag.
function forestTree(x, z, r, out, kind, force = null) {
  const y0 = heightAt(x, z);
  const far = kind === 'far', mid = kind === 'mid';
  const k = r();
  const type = force ? force : far ? (k < 0.08 ? 'snag' : k < 0.3 ? 'old' : k < 0.5 ? 'young' : 'beech') : k < 0.08 ? 'snag' : k < 0.22 ? 'old' : k < 0.36 ? 'young' : 'beech';
  let H = 21 + r() * 9, R = 0.15 + Math.pow(r(), 3) * 0.42;        // many slim stems, few stout ones
  if (type === 'old') { H = 25 + r() * 8; R = 0.4 + r() * r() * 0.22; }
  if (type === 'young') { H = 10 + r() * 7; R = 0.07 + H * 0.006 + r() * 0.03; }
  if (type === 'snag') { H = force ? 11 + r() * 3 : 7 + r() * 9; R = force ? 0.3 : 0.2 + r() * 0.2; }
  // Trees on the bank lean out over the water toward the light; everything else leans a few degrees its own way.
  const rv = river(x, z);
  const e = Math.abs(rv.d) - rv.w;
  const toward = -Math.sign(rv.d) * smoothstep(9, 1.5, e) * (0.05 + r() * 0.13) * (force ? 0.25 : 1);
  const la = r() * 6.283, lm = (type === 'young' ? 0.06 + r() * 0.16 : 0.02 + r() * 0.1) * (far ? 1.7 : 1);
  const lx = -rv.tz * toward + Math.cos(la) * lm, lz = rv.tx * toward + Math.sin(la) * lm;
  const ctrl = [];
  const bend = (r() - 0.5) * (type === 'young' ? 2.2 : 1.9), ba = r() * 6.28, bend2 = (r() - 0.5) * (type === 'snag' ? 0.2 : 0.6), bb = r() * 6.28;
  for (let i = 0; i <= 6; i++) {
    const f = i / 6, h = f * H;
    const sb = Math.sin(f * Math.PI) * bend * (type === 'snag' ? 0.3 : 1), sc2 = Math.sin(f * Math.PI * 2.3) * bend2 * f;
    const j = i > 0 ? 0.36 : 0;
    ctrl.push(V(x + lx * h * (0.6 + f) + Math.cos(ba) * sb + Math.cos(bb) * sc2 + (r() - 0.5) * j, y0 - 0.6 + h, z + lz * h * (0.6 + f) + Math.sin(ba) * sb + Math.sin(bb) * sc2 + (r() - 0.5) * j));
  }
  const path = smoothPath(ctrl, far ? 0.5 : 1.3);
  const trunk = new Limb(path, R, R * 0.16, 0, 1.0, 0);
  const snag = type === 'snag';
  // a snag keeps its girth and ends in a splintered break
  trunk.radiusAt = (t) => (snag ? R * (1 - 0.3 * t) * (1 - 0.8 * smoothstep(0.9, 1.0, t)) : R * (1 - 0.84 * Math.pow(t, 1.25)));
  trunk.swayAt = (t) => (snag ? 0 : (type === 'young' ? 1.4 : 1.0) * Math.pow(Math.max(0, t - 0.1), 2.3));
  // every trunk its own shade of grey: some weathered pale, some dark and wet-looking, a few green with algae
  const bv = snag ? 1.0 : 0.72 + r() * 0.4, bh = r();
  const tintV = [bv * (0.96 + bh * 0.08), bv * (0.98 + (1 - bh) * 0.06), bv * (0.9 + bh * 0.1)];
  (snag ? out.snags : out.geos).push(tube(trunk, { radial: far ? 7 : type === 'young' ? 9 : 14, flare: far ? 0 : type === 'old' ? 1.6 : 1.15, flareLobes: 4 + Math.floor(r() * 3), flareH: 0.45 + R * 0.9, seed: r() * 10, lumps: far ? 0 : snag ? 0.2 : 0.06, knots: far || type === 'young' ? null : addKnots(r, Math.min(8, H * 0.4), 5, R), barkTile: 1.3, ground: y0, tintV }));
  out.contacts.push({ x, z, r: R * 2.6, dark: 0.5, moss: 0.6 });
  // roots exposed where the bank has been washed out from under the tree
  if (!far && e < 3.4 && type !== 'young') {
    const heading = Math.atan2(rv.tx * -Math.sign(rv.d), -rv.tz * -Math.sign(rv.d));
    roots(x, z, y0, r, out.roots, { count: 2 + Math.floor(r() * 2), len: e + 1.6, rad: 0.06 + R * 0.2, seed: r() * 9, heading, spread: 0.6, tintV: [0.62, 0.58, 0.52] });
  }
  if (snag) {
    // broken stubs and one or two dead limbs
    const stubs = sprout(trunk, { count: 7, t0: 0.3, t1: 0.98, angle: [50, 85], len: () => 0.5 + r() * 1.6, rRatio: 0.4, rTip: 0.02, planar: false, wiggle: 0.3, segs: 3, droop: 0.15 }, r);
    for (const b of stubs) out.snags.push(tube(b, { radial: 5, collar: 0.5, barkTile: 0.7, tintV }));
    return;
  }
  // species and site: most crowns mid-green, some deep blue-green, some olive, some yellow-green, a few much darker (alder)
  const ph = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1, pv = 0.86 + 0.22 * (Math.abs(Math.sin(x * 39.3 + z * 11.1) * 9631.7) % 1);
  const pal = ph < 0.16 ? [0.5, 0.7, 0.56] : ph < 0.36 ? [0.66, 0.86, 0.78] : ph < 0.54 ? [0.98, 0.92, 0.5] : ph < 0.7 ? [1.06, 1.02, 0.56] : [0.86, 0.96, 0.74];
  const tint = [(0.86 + r() * 0.3) * pal[0] * pv, (0.94 + r() * 0.14) * pal[1] * pv, (0.72 + r() * 0.4) * pal[2] * pv];
  // a second, darker species with feathery compound leaves, about a quarter of the stand
  const sp2 = !far && ph < 0.26;
  if (sp2) { tint[0] = 0.68 * pv; tint[1] = 0.76 * pv; tint[2] = 0.7 * pv; }
  { const c = path.at(0.78); out.crowns.push({ x: c.x, z: c.z, r: Math.max(3, (type === 'young' ? 4.4 * 0.9 : type === 'old' ? 8.5 * H / 26 : 7.0 * H / 26) * 0.95) }); }
  const crown0 = type === 'young' ? 0.25 + r() * 0.2 : type === 'old' ? 0.3 + r() * 0.12 : 0.34 + r() * 0.26;
  const lenBase = (type === 'young' ? 4.4 : type === 'old' ? 8.5 : 7.0) * (H / 26) * (type === 'young' ? 26 / H * 0.9 : 1);
  const nL = far ? 10 : type === 'young' ? 13 + Math.floor(r() * 4) : 13 + Math.floor(r() * 5);
  const o = { far, mid, tint, tintV, H };
  if (sp2) out = { ...out, sprays: out.sprays2, boughs: out.boughs2 };
  if (type === 'old' && !far) {
    // co-dominant leaders split off low in the crown and carry their own limbs
    const nLead = 1 + Math.floor(r() * 2);
    const leaders = sprout(trunk, { count: nLead, t0: crown0 - 0.02, t1: crown0 + 0.12, angle: [18, 32], len: () => H * (0.42 + r() * 0.12), rRatio: 0.8, rTip: 0.03, up: 0.1, planar: false, wiggle: 0.12, segs: 6, flex: 0.004 }, r);
    for (const l of leaders) {
      l.r0 = trunk.radiusAt(l.tp) * 0.72;
      out.geos.push(tube(l, { radial: 10, collar: 0.3, lumps: 0.05, barkTile: 1.3, tintV }));
      crown(l, r, out, { ...o, t0: 0.3, nL: 8, lenBase: lenBase * 0.75 });
    }
    crown(trunk, r, out, { ...o, t0: crown0 + 0.12, nL: nL - 3, lenBase });
  } else crown(trunk, r, out, { ...o, t0: crown0, nL, lenBase });
}

// Understory beech saplings: thin whippy stems with flat layered sprays, the bright mid-level green.
// Near the places people stand, understory plants get real leaves on real twigs instead of spray cards.
function leafyBranch(b, r, out, tint, shade) {
  const tw = sprout(b, { count: Math.max(2, b.path.L * 7), t0: 0.12, t1: 0.95, angle: [32, 62], len: (t, p) => Math.min(0.34, 0.12 + p.path.L * 0.3), rRatio: 0.6, rTip: 0.002, droop: 0.3, planar: true, wiggle: 0.18, segs: 3, flex: 0.04 }, r);
  for (const t of tw) { out.small.push(tube(t, { radial: 3, barkTile: 0.4 })); leafTwig(t, out.leaves, r, tint, { size: 0.074, shade }); }
  leafTwig(b, out.leaves, r, tint, { from: 0.4, size: 0.074, shade });
}
const nearViewer = (x, z) => Math.hypot(x - 0.3, z - 6.5) < 14 || Math.hypot(x - 0.8, z + 1.5) < 13 || Math.hypot(x + 5.4, z + 6.4) < 9;

function sapling(x, z, r, out) {
  const y0 = heightAt(x, z);
  const H = 0.9 + r() * r() * 5.2, R = 0.012 + H * 0.007;
  const lean = r() * 6.28, la = 0.1 + r() * 0.25;
  const ctrl = [];
  for (let i = 0; i <= 4; i++) { const f = i / 4; ctrl.push(V(x + Math.cos(lean) * la * H * f * f + (i ? (r() - 0.5) * 0.12 : 0), y0 - 0.1 + H * f, z + Math.sin(lean) * la * H * f * f + (i ? (r() - 0.5) * 0.12 : 0))); }
  const stem = new Limb(smoothPath(ctrl, 3), R, 0.004, 0, 0.12 * H * 0.4, 0);
  out.small.push(tube(stem, { radial: 5, barkTile: 0.4 }));
  const dk = 0.6 + r() * 0.3;
  const tint = [(0.9 + r() * 0.2) * dk, (0.98 + r() * 0.1) * dk, (0.72 + r() * 0.25) * dk];
  const real = out.realNear && nearViewer(x, z);
  const br = sprout(stem, { count: 5 + H * 3.4, t0: 0.2, t1: 0.97, angle: [50, 80], len: (t) => (0.4 + H * 0.2) * (1 - 0.55 * t), rRatio: 0.5, rTip: 0.003, up: 0.02, droop: 0.1, planar: false, wiggle: 0.16, segs: 3, flex: 0.05 }, r);
  for (const b of br) {
    out.small.push(tube(b, { radial: 3, barkTile: 0.4 }));
    if (real) leafyBranch(b, r, out, tint, 0.8 + 0.25 * b.tp);
    else sprayBranch(b, out.sprays, r, tint, { spacing: 0.17, size: 0.5, from: 0.1, sag: 0.15, shade: 0.9 });
  }
  if (real) leafTwig(stem, out.leaves, r, tint, { from: 0.6, size: 0.074 });
  else sprayBranch(stem, out.sprays, r, tint, { spacing: 0.22, size: 0.5, from: 0.55, shade: 0.95 });
}

// Understory shrubs: several arching stems from one stool, densely leafed, 2-4 m tall.
function shrub(x, z, r, out) {
  const y0 = heightAt(x, z);
  const n = 4 + Math.floor(r() * 5);
  const tint = [0.8 + r() * 0.2, 0.92 + r() * 0.12, 0.62 + r() * 0.25];
  out.contacts.push({ x, z, r: 0.5, dark: 0.45, moss: 0.3 });
  const real = out.realNear && nearViewer(x, z);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + r(), H = 1.6 + r() * 2.4, out0 = 0.5 + r() * 1.1;
    const ctrl = [];
    for (let q = 0; q <= 4; q++) { const f = q / 4; ctrl.push(V(x + Math.cos(a) * (0.08 + out0 * f * f * 1.4) + (q ? (r() - 0.5) * 0.15 : 0), y0 - 0.08 + H * (f - 0.22 * f * f), z + Math.sin(a) * (0.08 + out0 * f * f * 1.4) + (q ? (r() - 0.5) * 0.15 : 0))); }
    const stem = new Limb(smoothPath(ctrl, 3), 0.014 + H * 0.005, 0.004, 0, 0.1 * H, 0);
    out.small.push(tube(stem, { radial: 4, barkTile: 0.4 }));
    const br = sprout(stem, { count: 5 + H * 3, t0: 0.22, t1: 0.97, angle: [45, 75], len: (t) => (0.35 + H * 0.16) * (1 - 0.5 * t), rRatio: 0.5, rTip: 0.003, droop: 0.12, planar: false, wiggle: 0.18, segs: 3, flex: 0.05 }, r);
    for (const b of br) {
      out.small.push(tube(b, { radial: 3, barkTile: 0.4 }));
      if (real) leafyBranch(b, r, out, tint, 0.7 + 0.3 * b.tp);
      else sprayBranch(b, out.sprays, r, tint, { spacing: 0.15, size: 0.44, from: 0.1, sag: 0.2, shade: 0.72 + 0.3 * b.tp });
    }
    if (real) leafTwig(stem, out.leaves, r, tint, { from: 0.55, size: 0.074 });
    else sprayBranch(stem, out.sprays, r, tint, { spacing: 0.2, size: 0.46, from: 0.5, shade: 0.95 });
  }
}

export function createTrees(quality) {
  const hi = quality !== 'low';
  const r = rng(1234);
  const heroL = { geos: [], twigs: [], leaves: new Instances(), twigDensity: hi ? 1 : 0.45, rootGeos: [] };
  const heroR = { geos: [], twigs: [], leaves: new Instances(), twigDensity: hi ? 1 : 0.45, rootGeos: [] };
  heroLeft(heroL, r);
  heroRight(heroR, r);

  const forest = { geos: [], small: [], sprays: new Instances(), boughs: new Instances(), sprays2: new Instances(), boughs2: new Instances(), snags: [], leaves: new Instances(), contacts: [], roots: [], crowns: [], realNear: hi };
  const placed = [{ x: HERO_TREES.left.x, z: HERO_TREES.left.z }, { x: HERO_TREES.right.x, z: HERO_TREES.right.z }];
  const tooClose = (x, z, d) => placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < d * d);
  const okGround = (x, z, margin) => {
    const rv = river(x, z);
    if (bankE(x, z, rv) < margin) return false;
    if (pathDist(x, z) < 1.9) return false;
    if (Math.hypot(x - 0.2, z - 8.6) < 3.2) return false;        // the viewer's spot on the trail
    if (ROCKS.some((k) => Math.hypot(k.x - x, k.z - z) < k.r + 0.5)) return false;
    if (Math.hypot(x + 5.0, z + 6.5) < 3.2) return false;
    { const t = clamp(((x + 6.5) * -4.5 + (z + 6) * -4.5) / 40.5, 0, 1); if (Math.hypot(x + 6.5 + 4.5 * t, z + 6 + 4.5 * t) < 2.4) return false; }   // no trunk wall at the left edge of the water's-edge view        // room around the far-bank viewpoint (also the left edge of the water's-edge view)
    // a gap in the canopy up-sun of the trail's end, so a pool of sunlight reaches the path
    const sx = G.uSunDir.value.x, sz = G.uSunDir.value.z, sl = Math.hypot(sx, sz);
    const t = clamp(((x - 0.3) * sx + (z - 6.2) * sz) / sl, 8, 19);
    if (Math.hypot(x - (0.3 + (sx / sl) * t), z - (6.2 + (sz / sl) * t)) < 3.6) return false;
    return true;
  };
  // Near and middle forest: full trees with twig sprays.
  let tries = 0, nNear = 0;
  const nearTarget = hi ? 135 : 80;
  while (nNear < nearTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 5 + Math.pow(r(), 0.75) * 50;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    // groves and gaps: trees crowd together in places and leave glades elsewhere
    const grove = clamp(0.5 + 1.6 * fbm(x * 0.07, z * 0.07, 2, 70), 0, 1);
    if (r() > 0.25 + 0.75 * grove) continue;
    if (z < -14 && z > -45 && Math.abs(river(x, z).d) < river(x, z).w + 9 && r() < 0.4) continue;   // keep depth open along the river
    if (!okGround(x, z, 0.9 + r() * 2.5) || tooClose(x, z, lerp(7.5, 3.4, grove) * (0.75 + r() * 0.5))) continue;
    placed.push({ x, z }); nNear++;
    forestTree(x, z, r, forest, Math.hypot(x + 1, z + 3) < (hi ? 30 : 20) ? 'near' : 'mid');
    // trees come up in twos and threes from the same patch of light
    for (let c = 0, nc = r() < 0.45 ? 1 + Math.floor(r() * 2) : 0; c < nc && nNear < nearTarget; c++) {
      const ca = r() * 6.283, cd = 1.3 + r() * 1.5, cx = x + Math.cos(ca) * cd, cz = z + Math.sin(ca) * cd;
      if (!okGround(cx, cz, 0.9) || tooClose(cx, cz, 1.15)) continue;
      placed.push({ x: cx, z: cz }); nNear++;
      forestTree(cx, cz, r, forest, Math.hypot(cx + 1, cz + 3) < (hi ? 30 : 20) ? 'near' : 'mid');
    }
  }
  // Big trees on both banks upstream lean together over the water and close the canopy above the river.
  for (let i = 0; i < (hi ? 9 : 6); i++) {
    for (let t2 = 0; t2 < 30; t2++) {
      const z = -24 - r() * 32, side = i % 2 ? 1 : -1;
      let x0 = 0; { let best = 1e9; for (let xx = -14; xx <= 14; xx += 0.5) { const d = Math.abs(river(xx, z).d); if (d < best) { best = d; x0 = xx; } } }
      const x = x0 + side * (river(x0, z).w + 3.2 + r() * 3.5);
      if (bankE(x, z) < 0.9 || tooClose(x, z, 3.2)) continue;
      placed.push({ x, z }); nNear++;
      forestTree(x, z, r, forest, z > -30 ? 'near' : 'mid', r() < 0.45 ? 'old' : 'beech');
      break;
    }
  }
  // Two bleached dead trunks stand where the main views can see them.
  for (const [sx0, sz0] of [[-9.5, -14.0], [7.6, -13.0]]) {
    let x = sx0, z = sz0;
    for (let k = 0; k < 40 && bankE(x, z) < 1.2; k++) { const rv = river(x, z), sg = Math.sign(rv.d) || 1; x += -rv.tz * sg * 0.4; z += rv.tx * sg * 0.4; }
    placed.push({ x, z });
    forestTree(x, z, r, forest, 'near', 'snag');
  }
  // Far ring: cheaper trees (bough cards only) that close the view and carry the atmospheric depth.
  let nFar = 0; tries = 0;
  const farTarget = hi ? 380 : 170;
  while (nFar < farTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 36 + Math.pow(r(), 0.8) * 144;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (bankE(x, z) < 1.5 || tooClose(x, z, 5.0)) continue;
    placed.push({ x, z }); nFar++;
    forestTree(x, z, r, forest, 'far');
  }
  // Understory.
  let nSap = 0; tries = 0;
  const sapTarget = hi ? 95 : 45;
  const saps = [];
  while (nSap < sapTarget && tries++ < 9000) {
    const ang = r() * 6.283, rad = 3 + Math.pow(r(), 0.9) * 40;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (!okGround(x, z, 0.5) || saps.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 1.6) || tooClose(x, z, 0.9)) continue;
    if (fbm(x * 0.09, z * 0.09, 2, 40) < -0.08) continue;      // saplings come in thickets
    if (bankE(x, z) < 3.5 && r() < 0.75) continue;             // not a hedge along the water
    if (x > -2.4 && x < 3.4 && z > 0.5 && z < 9.5) continue;   // keep the view down the trail to the water open
    if (Math.hypot(x + 2.3, z - 5.0) < 4.2) continue;          // and the view up into the old tree's crown
    saps.push({ x, z }); nSap++;
    sapling(x, z, r, forest);
  }

  let nShrub = 0; tries = 0;
  const shrubTarget = hi ? 78 : 26;
  while (nShrub < shrubTarget && tries++ < 6000) {
    const ang = r() * 6.283, rad = 6 + Math.pow(r(), 0.8) * 30;
    const x = -1 + Math.cos(ang) * rad, z = -3 + Math.sin(ang) * rad;
    if (!okGround(x, z, 0.8) || tooClose(x, z, 1.6) || saps.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 4)) continue;
    if (Math.hypot(x - 0.2, z - 8.4) < 6 || pathDist(x, z) < 3) continue;
    if (fbm(x * 0.08 + 20, z * 0.08, 2, 44) < -0.14) continue;
    saps.push({ x, z }); nShrub++;
    shrub(x, z, r, forest);
  }

  const barkHero = barkMaterial('japanese_hackberry_bark', { tint: [1.5, 1.5, 1.38], desat: 0.5, moss: 0.85, lichen: 0.6, normal: 1.7, mossHeight: 1.3 });
  const barkForest = barkMaterial('japanese_hackberry_bark', { tint: [1.12, 1.12, 1.04], desat: 0.5, moss: 0.9, lichen: 0.4, normal: 1.4, mossHeight: 1.4 });
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
  // dead standing trunks: bark gone, wood bleached silver-grey
  addWood(forest.snags, barkMaterial('tree_bark_03', { tint: [1.25, 1.2, 1.1], desat: 0.85, moss: 0.55, lichen: 0, normal: 2.2, mossHeight: 1.6 }));
  // washed-out bank roots: bare, dark, wet wood rather than mossy
  addWood([...forest.roots, ...heroR.rootGeos], barkMaterial('japanese_hackberry_bark', { tint: [0.9, 0.85, 0.78], desat: 0.3, moss: 0.12, lichen: 0, normal: 1.6, mossHeight: 0.5 }));
  addWood(forest.small, barkForest, { shadow: false, reflect: false });

  const leafGeo = leafGeometry();
  const lm = leafMaterials();
  const thinned = [];
  for (const h of [heroL, heroR]) { const m = h.leaves.build(leafGeo, lm, { shadowFrac: 0.7, mirrorFrac: 0.3 }); thinned.push(m); group.add(m); }
  if (forest.leaves.count) { const m = forest.leaves.build(leafGeo, lm, { shadowFrac: 0.7, mirrorFrac: 0.3 }); m.frustumCulled = false; thinned.push(m); group.add(m); }
  const sprayM = cardMaterials('spray_atlas', 2, 2);
  const boughM = cardMaterials('bough_atlas', 2, 1);
  const sprays = forest.sprays.build(cardGeometry(2, 0.16, 0.1), sprayM, { shadowFrac: 0.5, mirrorFrac: 0.5 });
  const boughs = forest.boughs.build(cardGeometry(2, 0.12, 0.08), boughM, { shadowFrac: 0.2, mirrorFrac: 0.6 });
  thinned.push(sprays, boughs);
  sprays.frustumCulled = false; boughs.frustumCulled = false;
  group.add(sprays, boughs);
  const sprays2 = forest.sprays2.build(cardGeometry(2, 0.2, 0.1), cardMaterials('spray2_atlas', 2, 2), { shadowFrac: 0.5, mirrorFrac: 0.5 });
  const boughs2 = forest.boughs2.build(cardGeometry(2, 0.14, 0.08), cardMaterials('bough2_atlas', 2, 1), { shadowFrac: 0.2, mirrorFrac: 0.6 });
  thinned.push(sprays2, boughs2);
  sprays2.frustumCulled = false; boughs2.frustumCulled = false;
  group.add(sprays2, boughs2);

  group.userData.crowns = [...forest.crowns, { x: HERO_TREES.left.x - 0.5, z: HERO_TREES.left.z - 1.2, r: 7.5 }, { x: HERO_TREES.right.x - 0.5, z: HERO_TREES.right.z - 0.4, r: 6.5 }];
  group.userData.contacts = forest.contacts;
  group.userData.noReflect = noReflect;
  group.userData.thinned = thinned;
  group.userData.counts = { near: nNear, far: nFar, saplings: nSap, heroLeaves: heroL.leaves.count + heroR.leaves.count, underLeaves: 0, sprays: forest.sprays.count, boughs: forest.boughs.count };
  console.warn('trees', JSON.stringify(group.userData.counts));
  return group;
}
