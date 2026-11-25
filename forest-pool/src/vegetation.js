// Ground cover, all rooted into the terrain: photoscanned ferns, grass tufts and celandine
// (Poly Haven, CC0), fallen sticks, and a carpet of fallen beech leaves.
import * as THREE from 'three';
import { heightAt, river, bankE, pathMask, pathDist, fbm, rng, smoothstep, HERO_TREES, ROCKS } from './world.js';
import { tex, A } from './textures.js';
import { plantMaterials, litterMaterials, leafGeometry, Instances, registerLod } from './foliage.js';
import { loadModel } from './models.js';
import { underwater, dapple } from './shaders.js';

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();

function instanced(variants, lists, materials, { cast = true } = {}) {
  const out = [];
  variants.forEach((v, i) => {
    const list = lists[i];
    if (!list || !list.length) return;
    const inst = new THREE.InstancedMesh(v.geo, materials.mat, list.length);
    const c = new THREE.Color();
    list.forEach((o, k) => {
      if (o.q) q.copy(o.q); else { e.set(o.tx || 0, o.rot, o.tz || 0); q.setFromEuler(e); }
      p.set(o.x, o.y, o.z); s.set(o.s, o.s * (o.sy || 1), o.s);
      inst.setMatrixAt(k, m4.compose(p, q, s));
      inst.setColorAt(k, c.setRGB(o.c[0], o.c[1], o.c[2]));
    });
    inst.castShadow = cast; inst.receiveShadow = true; inst.frustumCulled = false;
    if (materials.depth) inst.customDepthMaterial = materials.depth;
    registerLod(inst);
    out.push(inst);
  });
  return out;
}

const nearRock = (x, z, pad) => ROCKS.some((k) => Math.hypot(k.x - x, k.z - z) < k.r * 0.85 + pad);
const nearHero = (x, z, d) => Math.hypot(x - HERO_TREES.left.x, z - HERO_TREES.left.z) < d || Math.hypot(x - HERO_TREES.right.x, z - HERO_TREES.right.z) < d;

export function createGroundCover(quality) {
  const hi = quality !== 'low';
  const group = new THREE.Group();
  const contacts = [];
  const noReflect = [];
  const r = rng(555);

  // --- Ferns: beds around boulders and tree bases and along the banks -------------------
  const ferns = [];
  const addFern = (x, z, sc) => {
    if (bankE(x, z) < 0.25 || pathMask(x, z) > 0.2 || nearRock(x, z, -0.05) || nearHero(x, z, 0.55)) return false;
    const v = 0.8 + r() * 0.4;
    ferns.push({ x, z, y: heightAt(x, z) - 0.04 * sc, s: sc, sy: 0.85 + r() * 0.5, rot: r() * 6.283, tx: (r() - 0.5) * 0.16, tz: (r() - 0.5) * 0.16, c: [v * (0.9 + r() * 0.2), v, v * (0.8 + r() * 0.3)] });
    contacts.push({ x, z, r: 0.3 * sc, dark: 0.4, moss: 0.25 });
    return true;
  };
  for (const k of ROCKS) {
    if (k.kind === 'r') continue;
    const n = 2 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) { const a = r() * 6.283, d = k.r * (0.95 + r() * 0.7); addFern(k.x + Math.cos(a) * d, k.z + Math.sin(a) * d, 0.7 + r() * 0.8); }
  }
  for (const key in HERO_TREES) {
    const h = HERO_TREES[key];
    for (let i = 0; i < 9; i++) { const a = r() * 6.283, d = 0.8 + r() * 1.5; addFern(h.x + Math.cos(a) * d, h.z + Math.sin(a) * d, 0.8 + r() * 0.8); }
  }
  for (const [fx, fz, fs] of [[-3.7, -9.5, 1.5], [-3.0, -10.4, 1.2], [-4.4, -10.3, 1.3], [-3.4, -11.3, 1.0]]) addFern(fx, fz, fs);   // fern clump by the far-bank viewpoint
  let tries = 0;
  const fernTarget = hi ? 760 : 300;
  while (ferns.length < fernTarget && tries++ < 20000) {
    const a = r() * 6.283, d = 2 + Math.pow(r(), 0.8) * 46;
    const x = -1 + Math.cos(a) * d, z = -3 + Math.sin(a) * d;
    const e2 = bankE(x, z);
    const dens = 0.25 + 0.75 * smoothstep(7, 1, e2) + 0.9 * Math.max(0, fbm(x * 0.13, z * 0.13, 2, 60));
    if (r() > dens) continue;
    addFern(x, z, 0.75 + r() * 0.95);
  }
  loadModel('fern_02').then((variants) => {
    const lists = variants.map(() => []);
    ferns.forEach((f, i) => lists[(i * 7 + (i >> 2)) % variants.length].push(f));
    const mats = plantMaterials('fern_02', { amount: 0.05, flutter: 0.006, tint: [0.62, 0.78, 0.42] });
    const meshes = instanced(variants, lists, mats);
    noReflect.push(...meshes);
    group.add(...meshes);
  });

  // --- Grass tufts: along the banks, the trail's shoulders and in brighter gaps ---------
  const grass = [];
  const grassTarget = hi ? 3400 : 1200;
  tries = 0;
  while (grass.length < grassTarget && tries++ < 60000) {
    const a = r() * 6.283, d = Math.pow(r(), 0.85) * 26;
    const x = -0.5 + Math.cos(a) * d, z = 1 + Math.sin(a) * d;
    const e2 = bankE(x, z);
    if (e2 < 0.08) continue;
    const pm = pathMask(x, z);
    if (pm > 0.35) continue;
    const pd = pathDist(x, z);
    let dens = 0.12 + 0.75 * smoothstep(2.6, 0.2, e2) + 0.55 * smoothstep(1.6, 0.6, pd) * (z > 2 ? 1 : 0) + 0.9 * Math.max(0, fbm(x * 0.2, z * 0.2, 2, 21));
    if (r() > dens) continue;
    if (nearRock(x, z, -0.1) || nearHero(x, z, 0.45)) continue;
    const v = 0.75 + r() * 0.4, dry = r();
    grass.push({ x, z, y: heightAt(x, z) - 0.015, s: 0.8 + r() * 0.8 + smoothstep(1.5, 0.1, e2) * 0.35, sy: 0.8 + r() * 0.5, rot: r() * 6.283, tx: (r() - 0.5) * 0.2, tz: (r() - 0.5) * 0.2, c: [v * (0.85 + dry * 0.25), v * 0.95, v * (0.6 + r() * 0.25)] });
  }
  // Bank-edge sedge and grass: rooted on the lip of the bank and bowing out over the water, breaking the shoreline.
  const edgeTarget = hi ? 1500 : 500;
  const yaw = new THREE.Quaternion(), tilt = new THREE.Quaternion(), axis = new THREE.Vector3();
  tries = 0; let nEdge = 0;
  while (nEdge < edgeTarget && tries++ < edgeTarget * 40) {
    const a = r() * 6.283, d = Math.pow(r(), 0.8) * 30;
    const x = -1 + Math.cos(a) * d, z = -3 + Math.sin(a) * d;
    const rv = river(x, z);
    const sgn = Math.sign(rv.d), nx = -rv.tz * sgn, nz = rv.tx * sgn;   // pointing away from the channel
    const e2 = bankE(x, z, rv);
    if (e2 < -0.12 || e2 > 0.45) continue;
    if (pathDist(x, z) < 0.9 || nearRock(x, z, -0.15)) continue;
    if (fbm(x * 0.35, z * 0.35, 2, 81) < -0.12) continue;                // in runs, with bare gravel between
    const y = heightAt(x, z);
    if (y < -0.06) continue;
    const lean = 0.25 + r() * 0.55;
    axis.set(-nz, 0, nx);                                                 // tilt about the bank line, toward the water
    tilt.setFromAxisAngle(axis.normalize(), -lean);
    yaw.setFromAxisAngle(axis.set(0, 1, 0), r() * 6.283);
    const v = 0.7 + r() * 0.4, dry = r();
    grass.push({ x, z, y: y - 0.03, s: 1.3 + r() * 1.5, sy: 0.9 + r() * 0.7, rot: 0, q: tilt.clone().multiply(yaw), c: [v * (0.8 + dry * 0.3), v * 0.95, v * (0.55 + r() * 0.25)], tall: true });
    nEdge++;
  }

  const fuzz = [];
  const fuzzTarget = hi ? 9000 : 2500;
  tries = 0;
  while (fuzz.length < fuzzTarget && tries++ < fuzzTarget * 8) {
    const a = r() * 6.283, d = Math.pow(r(), 0.75) * 17;
    const x = Math.cos(a) * d, z = 3 + Math.sin(a) * d;
    if (bankE(x, z) < 0.05 || pathMask(x, z) > 0.5) continue;
    if (r() > 0.45 + 1.4 * fbm(x * 0.45, z * 0.45, 2, 91)) continue;
    const v = 0.7 + r() * 0.45;
    fuzz.push({ x, z, y: heightAt(x, z) - 0.008, s: 1.0 + r() * 1.6, sy: 0.7 + r() * 0.8, rot: r() * 6.283, tx: (r() - 0.5) * 0.3, tz: (r() - 0.5) * 0.3, c: [v * 0.9, v, v * 0.6] });
  }
  loadModel('grass_medium_01').then((variants) => {
    // light-weight pieces only; the big clumps are thousands of triangles each
    const use = variants.filter((v) => /tall|tiny/.test(v.name));
    const lists = use.map(() => []);
    grass.forEach((g, i) => {
      let k = Math.floor(r() * use.length);
      if (/tiny/.test(use[k].name) && (g.tall || r() < 0.6)) k = Math.floor(r() * use.length);
      if (g.tall) { const tl = use.map((v, i) => (/tall/.test(v.name) ? i : -1)).filter((i) => i >= 0); k = tl[Math.floor(r() * tl.length)]; }
      lists[k].push({ ...g, s: g.s * (/tiny/.test(use[k].name) ? 1.6 : 1) });
    });
    // a fuzz of tiny tufts so mossy ground is never a bare painted plane
    const tiny = use.map((v, i) => (/tiny/.test(v.name) ? i : -1)).filter((i) => i >= 0);
    fuzz.forEach((g) => lists[tiny[Math.floor(r() * tiny.length)]].push(g));
    const mats = plantMaterials('grass_medium_01', { amount: 0.18, flutter: 0.01, tint: [0.62, 0.78, 0.4], shadow: false });
    const meshes = instanced(use, lists, mats, { cast: false });
    noReflect.push(...meshes);
    group.add(...meshes);
  });

  // --- Celandine: low glossy leaves and a few yellow flowers in damp, mossy patches ------
  const herbs = [];
  const herbTarget = hi ? 1000 : 400;
  tries = 0;
  while (herbs.length < herbTarget && tries++ < 40000) {
    const a = r() * 6.283, d = Math.pow(r(), 0.8) * 24;
    const x = -0.5 + Math.cos(a) * d, z = 1 + Math.sin(a) * d;
    if (bankE(x, z) < 0.3 || pathMask(x, z) > 0.15) continue;
    const patch = fbm(x * 0.3 + 50, z * 0.3, 3, 77);
    if (patch < 0.06 + r() * 0.1) continue;
    if (nearRock(x, z, -0.1) || nearHero(x, z, 0.5)) continue;
    const v = 0.8 + r() * 0.35;
    herbs.push({ x, z, y: heightAt(x, z) - 0.012, s: 0.8 + r() * 0.55, sy: 0.9 + r() * 0.3, rot: r() * 6.283, tx: (r() - 0.5) * 0.15, tz: (r() - 0.5) * 0.15, c: [v, v, v] });
  }
  loadModel('celandine_01').then((variants) => {
    const use = variants.filter((v) => /_a_|_b_|_e_/.test(v.name));
    const lists = use.map(() => []);
    herbs.forEach((h, i) => lists[i % use.length].push(h));
    const mats = plantMaterials('celandine_01', { amount: 0.06, flutter: 0.004, tint: [0.7, 0.8, 0.5], shadow: false });
    const meshes = instanced(use, lists, mats, { cast: false });
    noReflect.push(...meshes);
    group.add(...meshes);
  });

  // --- Fallen sticks --------------------------------------------------------------------
  const sticks = [];
  tries = 0;
  while (sticks.length < (hi ? 170 : 60) && tries++ < 5000) {
    const a = r() * 6.283, d = Math.pow(r(), 0.7) * 38;
    const x = -0.5 + Math.cos(a) * d, z = 1 + Math.sin(a) * d;
    if (bankE(x, z) < 0.4 || nearRock(x, z, 0) || nearHero(x, z, 0.6)) continue;
    const v = 0.7 + r() * 0.4;
    sticks.push({ x, z, y: heightAt(x, z) - 0.03, s: 0.6 + r() * 0.7, rot: r() * 6.283, tx: (r() - 0.5) * 0.12, tz: (r() - 0.5) * 0.12, c: [v, v * 0.97, v * 0.9] });
  }
  loadModel('dry_branches_medium_01').then((variants) => {
    const d = 'models/dry_branches_medium_01', o = { repeat: false, flipY: false };
    const mat = new THREE.MeshStandardMaterial({ map: tex(A(`${d}/diff.jpg`), o), normalMap: tex(A(`${d}/nor.jpg`), { ...o, srgb: false }), roughness: 0.9, metalness: 0 });
    underwater(mat); dapple(mat);
    const lists = variants.map(() => []);
    sticks.forEach((k, i) => lists[i % variants.length].push(k));
    const meshes = instanced(variants, lists, { mat, depth: null });
    group.add(...meshes);
  });

  // --- Leaf litter: small, weathered beech leaves. They drift into the hollows and along the edges of the
  // trail, lie curled, crumpled or half trodden in, and a few have sunk onto the stream bed by the banks.
  const litter = new Instances();
  const litterTarget = hi ? 52000 : 13000;
  const nrm = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), X = new THREE.Vector3(), Z = new THREE.Vector3();
  let n = 0; tries = 0;
  while (n < litterTarget && tries++ < litterTarget * 14) {
    const a = r() * 6.283, d = Math.pow(r(), 0.8) * 31;
    const x = Math.cos(a) * d, z = 0 + Math.sin(a) * d;
    const y = heightAt(x, z);
    const sunk = y < 0.02;
    if (sunk && (y < -0.5 || r() < 0.55)) continue;
    const pd = pathDist(x, z);
    const hollow = -fbm(x * 0.9, z * 0.9, 2, 5);                       // matches the terrain's small relief
    let drift = 0.1 + 2.6 * Math.max(0, fbm(x * 0.3 + 9, z * 0.3, 3, 13)) + 1.8 * Math.max(0, hollow) + 0.25 * fbm(x * 2.1, z * 2.1, 2, 19);
    if (z > 2.5) drift += 0.75 * Math.exp(-(((pd - 0.75) / 0.3) ** 2)) + 0.22 * smoothstep(0.7, 0.2, pd);   // heaped at the path's edges, scattered down the middle
    if (r() > drift) continue;
    if (nearRock(x, z, -0.25)) continue;
    const gx = (heightAt(x + 0.08, z) - y) / 0.08, gz = (heightAt(x, z + 0.08) - y) / 0.08;
    const mode = r();                                                   // flat / curled / crumpled / half-buried
    const wild = mode < 0.55 ? 0.35 : mode < 0.8 ? 0.9 : mode < 0.92 ? 1.8 : 1.2;
    nrm.set(-gx + (r() - 0.5) * wild, 1, -gz + (r() - 0.5) * wild).normalize();
    if (r() < 0.3) nrm.multiplyScalar(-1);                             // some lie face-down, pale side up
    const ra = r() * 6.283;
    dir.set(Math.cos(ra), 0, Math.sin(ra));
    dir.addScaledVector(nrm, -dir.dot(nrm)).normalize();
    side.crossVectors(dir, nrm);
    const sc = 0.03 + Math.pow(r(), 1.5) * 0.045;
    const curl = mode < 0.55 ? 0.3 + r() * 0.8 : mode < 0.8 ? 1.5 + r() * 2 : 2.5 + r() * 3;
    const buried = mode >= 0.92;
    p.set(x, y + (buried ? -0.012 : 0.004 + r() * 0.01) + (mode >= 0.8 && !buried ? sc * 0.25 : 0), z);
    m4.makeBasis(X.copy(side).multiplyScalar(sc * (mode >= 0.8 ? 0.55 + r() * 0.35 : 0.85 + r() * 0.3)), dir.multiplyScalar(sc), Z.copy(nrm).multiplyScalar(sc * curl)).setPosition(p);
    const t = r(), v = (0.5 + r() * 0.6) * (sunk ? 0.75 : 1);
    // weathered browns and greys, the odd paler or still-green leaf
    // tan, ochre, russet and weathered grey-brown; the odd leaf still green
    const c = t < 0.34 ? [0.4, 0.27, 0.14] : t < 0.6 ? [0.3, 0.17, 0.085] : t < 0.8 ? [0.44, 0.34, 0.16] : t < 0.93 ? [0.24, 0.18, 0.12] : t < 0.97 ? [0.5, 0.4, 0.14] : [0.2, 0.28, 0.08];
    litter.add(m4, c[0] * v, c[1] * v, c[2] * v, 0, 0, Math.floor(r() * 4));
    n++;
  }
  const lm = litter.build(leafGeometry(), litterMaterials(), { castShadow: false });
  lm.frustumCulled = false;
  noReflect.push(lm);
  group.add(lm);

  group.userData.contacts = contacts;
  group.userData.noReflect = noReflect;
  return group;
}
