// Ground cover: instanced grass blades and photoscanned ferns (Poly Haven fern_02, CC0).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { heightAt, poolE, pathMask, fbm, rng, HERO_TREES } from './world.js';
import { manager, tex, A } from './textures.js';
import { wind, chain } from './shaders.js';

function bladeGeometry() {
  // A tapered, slightly curved blade, 1 m tall, built from 4 segments.
  const segs = 4, pos = [], uv = [], nor = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = 0.018 * (1 - t * 0.9);
    const bend = t * t * 0.18;
    pos.push(-w, t, bend, w, t, bend);
    uv.push(0, t, 1, t);
    nor.push(0, 0.9, 0.35, 0, 0.9, 0.35);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function createGrass(quality) {
  const count = quality === 'low' ? 45000 : 110000;
  const r = rng(77);
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1, envMapIntensity: 0.3, emissive: new THREE.Color(0.03, 0.08, 0.01) });
  wind(mat, { amount: 0.12, useUvY: true, freq: 1.6 });
  chain(mat, 'grassgrad', (s) => {
    // Darker at the root, sunlit yellow-green at the tip.
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= mix(0.5, 1.25, vUv.y);`);
    s.vertexShader = s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vUv = uv;');
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\n#ifndef USE_UV\nvarying vec2 vUv;\n#endif');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\n#ifndef USE_UV\nvarying vec2 vUv;\n#endif');
  });
  const mesh = new THREE.InstancedMesh(bladeGeometry(), mat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  let n = 0, tries = 0;
  while (n < count && tries++ < count * 8) {
    // Concentrate blades near the pool and the viewer.
    const rad = Math.pow(r(), 1.35) * 26;
    const ang = r() * Math.PI * 2;
    const x = -0.4 + Math.cos(ang) * rad;
    const z = 0.5 + Math.sin(ang) * rad * 0.95;
    const pe = poolE(x, z);
    if (pe < 1.0) continue;
    const pm = pathMask(x, z);
    if (pm > 0.25 && r() < 0.97) continue;
    // Patchy clumps.
    const clump = 0.5 + fbm(x * 0.6, z * 0.6, 3, 21) * 1.6 + (pe < 1.35 ? 0.35 : 0);
    if (r() > clump) continue;
    if (Math.hypot(x - HERO_TREES.left.x, z - HERO_TREES.left.z) < 0.5) continue;
    if (Math.hypot(x - HERO_TREES.right.x, z - HERO_TREES.right.z) < 0.75) continue;
    const y = heightAt(x, z);
    if (y < 0.03) continue;
    // Keep the near foreground for moss, rocks and ferns like the reference.
    const nearCam = Math.hypot(x + 0.3, z - 5.2);
    if (nearCam < 3.2 && !(x > 0.4 && z < 3.4)) { if (r() < 0.9) continue; }
    if (pe < 1.45 && z > -1.5 && x < 0.9) continue;
    const fore = Math.hypot(x + 0.3, z - 4.5) < 4.2 && !(x > 0.9 && z < 3.6);
    if (fore && (pm > 0.12 || r() < 0.35)) continue;
    const tall = pe < 1.25 ? 1.4 : 1.0; // lush reeds at the water's edge
    let h = (0.08 + r() * 0.22) * tall * (0.7 + clump * 0.4);
    if (fore) h *= 0.45;
    e.set((r() - 0.5) * 0.5, r() * Math.PI * 2, (r() - 0.5) * 0.5);
    q.setFromEuler(e);
    s.set(0.8 + r() * 0.6, h, 1);
    p.set(x, y - 0.02, z);
    m.compose(p, q, s);
    mesh.setMatrixAt(n, m);
    const g = (0.75 + r() * 0.4) * (pe > 1.45 && z < -2 ? 0.6 : 1);
    c.setRGB(0.26 * g + r() * 0.06, 0.5 * g, 0.08 * g);
    mesh.setColorAt(n, c);
    n++;
  }
  mesh.count = n;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

// Hand-placed fern beds (matching the reference), plus scattered ones around the banks.
const FERN_SPOTS = [
  // around the left tree base, sunlit
  [-1.25, 1.0, 1.0], [-2.25, 1.35, 0.9], [-1.9, 0.6, 0.8], [-2.8, 0.9, 1.1], [-3.5, 1.6, 1.0], [-2.4, 2.4, 0.8],
  // right bank by the roots
  [1.95, 3.3, 1.0], [2.4, 2.4, 1.1], [2.1, 4.1, 0.9], [2.9, 3.2, 1.0], [0.85, 3.6, 0.6],
  // far bank, a line of bright ferns in the sun
  [1.5, -6.8, 1.3], [2.5, -6.4, 1.2], [3.6, -5.9, 1.3], [4.6, -5.1, 1.2], [0.4, -7.1, 1.1], [-1.0, -7.2, 1.2], [-2.4, -7.0, 1.1], [5.6, -4.0, 1.2],
  // near-left foreground
  [-1.8, 4.3, 0.7], [-2.6, 5.2, 0.9],
  // low ferns along the near water edge where sedge used to be
  [-1.05, 2.75, 0.55], [-2.2, 2.6, 0.7], [0.55, 2.85, 0.5], [-3.6, 2.3, 0.8],
  // bright clump hugging the left trunk base
  [-1.3, 1.1, 0.75, 1],
  [-2.6, 3.0, 0.7], [-2.1, 3.4, 0.55], [-3.0, 3.6, 0.65],
  // right bank cover
  [1.0, 3.3, 0.5], [1.5, 3.9, 0.55], [2.2, 4.4, 0.6], [0.9, 4.3, 0.45], [1.8, 3.1, 0.5], [2.5, 3.0, 0.6],
  // near-right foreground
  [1.45, 5.0, 0.8], [2.2, 5.6, 0.9],
];

export function createFerns(quality) {
  const group = new THREE.Group();
  const loader = new GLTFLoader(manager);
  const alpha = tex(A('fern/textures/fern_02_alpha_1k.jpg'), { srgb: false, repeat: false, flipY: false });
  loader.load(A('fern/fern_02.json'), (gltf) => {
    gltf.scene.updateMatrixWorld(true);
    const variants = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      g.computeBoundingBox();
      const b = g.boundingBox;
      g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      g.computeBoundingBox();
      variants.push({ geo: g, height: g.boundingBox.max.y, mat: o.material });
    });
    const r = rng(555);
    const spots = [];
    for (const [x, z, s, force] of FERN_SPOTS) {
      if (!force && poolE(x, z) < 1.15) continue;
      spots.push([x, z, s]);
      // small companions around each bed
      for (let k = 0; k < 2; k++) { const cx = x + (r() - 0.5) * 1.4, cz = z + (r() - 0.5) * 1.4; if (poolE(cx, cz) > 1.15) spots.push([cx, cz, s * (0.5 + r() * 0.4)]); }
    }
    const extra = quality === 'low' ? 60 : 130;
    let tries = 0;
    while (spots.length < FERN_SPOTS.length * 3 + extra && tries++ < 5000) {
      const ang = r() * Math.PI * 2, rad = 4 + r() * 18;
      const x = -0.4 + Math.cos(ang) * rad, z = -2.2 + Math.sin(ang) * rad;
      const pe = poolE(x, z);
      if (pe < 1.15 || pathMask(x, z) > 0.1) continue;
      if (Math.hypot(x + 0.3, z - 6.5) < 1.5) continue;
      spots.push([x, z, 0.7 + r() * 0.7]);
    }
    const per = variants.map(() => []);
    spots.forEach((sp, i) => per[i % variants.length].push(sp));
    variants.forEach((v, vi) => {
      const mat = v.mat.clone();
      mat.alphaMap = alpha;
      mat.alphaTest = 0.5;
      mat.transparent = false;
      mat.side = THREE.DoubleSide;
      mat.color = new THREE.Color(1.25, 1.4, 0.75);
      mat.emissive = new THREE.Color(0.35, 0.55, 0.08);
      mat.emissiveMap = mat.map;
      mat.emissiveIntensity = 0.35;
      wind(mat, { amount: 0.05, useUvY: false, freq: 1.2 });
      const inst = new THREE.InstancedMesh(v.geo, mat, per[vi].length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion();
      per[vi].forEach(([x, z, s], i) => {
        const y = heightAt(x, z) - 0.03;
        const nearPool = poolE(x, z) < 1.45 && z > -2 ? 0.7 : 1;
        const sc = (s * 0.9 * nearPool) / Math.max(0.4, v.height);
        q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.2, r() * Math.PI * 2, (r() - 0.5) * 0.2));
        m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sc, sc * (0.85 + r() * 0.3), sc));
        inst.setMatrixAt(i, m);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      group.add(inst);
    });
  });
  return group;
}
