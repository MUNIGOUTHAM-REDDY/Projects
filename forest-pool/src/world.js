// World layout: a forest river, its banks, the path and everything that needs to agree on
// where the ground is. Units are metres; the water surface is the plane y = 0.
// The river runs from the north (-z) towards the viewer, then bends west (-x) in a deep pool
// right below the end of the path. Upstream of the pool is a shallow riffle full of boulders.
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

const perlin = new ImprovedNoise();

export const WATER_Y = 0;

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function fbm(x, z, oct = 4, seed = 0) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * perlin.noise(x * f, z * f, 1.7 + i * 3.1 + seed * 7.3);
    a *= 0.5; f *= 2.03;
  }
  return s; // roughly [-0.6, 0.6]
}

// Seeded RNG so the forest is identical on every load.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- River centreline -------------------------------------------------------
// x, z, half-width, mid-channel depth. Listed upstream -> downstream.
const CTRL = [
  [16, -120, 3.0, 0.5], [13, -92, 3.0, 0.6], [8, -68, 3.0, 0.5], [5.5, -50, 3.2, 0.8], [-1.5, -35, 3.2, 0.5],
  [3.4, -23.5, 3.6, 1.2], [2.9, -14, 3.6, 0.3], [1.2, -7.0, 4.0, 0.34], [-3.2, -1.9, 4.5, 1.8],
  [-10.5, 0.4, 3.9, 1.2], [-20, 0.6, 3.3, 0.45], [-31, 5, 3.3, 0.9], [-48, 3, 3.0, 0.6], [-72, 8, 3.0, 0.6], [-110, 5, 3.0, 0.6],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const RIV = (() => {
  const xs = [], zs = [], ws = [], ds = [];
  for (let i = 0; i < CTRL.length - 1; i++) {
    const a = CTRL[Math.max(0, i - 1)], b = CTRL[i], c = CTRL[i + 1], d = CTRL[Math.min(CTRL.length - 1, i + 2)];
    const len = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const n = Math.max(2, Math.ceil(len / 0.5));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      xs.push(catmull(a[0], b[0], c[0], d[0], t));
      zs.push(catmull(a[1], b[1], c[1], d[1], t));
      const st = t * t * (3 - 2 * t);
      ws.push(lerp(b[2], c[2], st));
      ds.push(lerp(b[3], c[3], st));
    }
  }
  const n = xs.length;
  const tx = new Float32Array(n), tz = new Float32Array(n), kap = new Float32Array(n), ss = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = xs[b] - xs[a], dz = zs[b] - zs[a], l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
    if (i > 0) ss[i] = ss[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  // Signed curvature, smoothed over a few metres. Positive = the channel turns right (looking downstream).
  const raw = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    const cr = tx[i - 1] * tz[i + 1] - tz[i - 1] * tx[i + 1];
    raw[i] = cr / Math.max(0.2, ss[i + 1] - ss[i - 1]);
  }
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -8; k <= 8; k++) { const j = i + k; if (j < 0 || j >= n) continue; s += raw[j]; w++; }
    kap[i] = s / w;
  }
  return { n, xs: Float32Array.from(xs), zs: Float32Array.from(zs), ws: Float32Array.from(ws), ds: Float32Array.from(ds), tx, tz, kap, ss };
})();

// Coarse grid of candidate centreline samples per cell, so nearest-point queries stay cheap.
const GRID = { min: -130, size: 4, n: 65, cells: null };
function gridCell(x, z) {
  if (!GRID.cells) {
    GRID.cells = new Array(GRID.n * GRID.n);
    const { n, xs, zs } = RIV;
    for (let j = 0; j < GRID.n; j++) for (let i = 0; i < GRID.n; i++) {
      const cx = GRID.min + (i + 0.5) * GRID.size, cz = GRID.min + (j + 0.5) * GRID.size;
      let dmin = 1e9;
      for (let k = 0; k < n; k++) { const d = Math.hypot(cx - xs[k], cz - zs[k]); if (d < dmin) dmin = d; }
      const lim = dmin + GRID.size * 1.5, list = [];
      for (let k = 0; k < n; k++) if (Math.hypot(cx - xs[k], cz - zs[k]) <= lim) list.push(k);
      GRID.cells[j * GRID.n + i] = Uint16Array.from(list);
    }
  }
  const i = Math.floor((x - GRID.min) / GRID.size), j = Math.floor((z - GRID.min) / GRID.size);
  if (i < 0 || j < 0 || i >= GRID.n || j >= GRID.n) return null;
  return GRID.cells[j * GRID.n + i];
}

// Nearest point on the centreline. Returns a shared object (copy what you need).
// d: signed lateral distance in metres (positive = right-hand side looking downstream)
const R = { d: 0, s: 0, w: 0, D: 0, k: 0, tx: 0, tz: 1, i: 0 };
export function river(x, z) {
  const { n, xs, zs } = RIV;
  let best = 1e18, bi = 0;
  const cell = gridCell(x, z);
  if (cell) {
    for (let c = 0; c < cell.length; c++) {
      const i = cell[c], dx = x - xs[i], dz = z - zs[i], q = dx * dx + dz * dz;
      if (q < best) { best = q; bi = i; }
    }
  } else {
    for (let i = 0; i < n; i += 2) {
      const dx = x - xs[i], dz = z - zs[i], q = dx * dx + dz * dz;
      if (q < best) { best = q; bi = i; }
    }
  }
  let bd = 1e18, bt = 0, bseg = bi;
  for (let i = Math.max(0, bi - 2); i < Math.min(n - 1, bi + 2); i++) {
    const vx = xs[i + 1] - xs[i], vz = zs[i + 1] - zs[i];
    const t = clamp(((x - xs[i]) * vx + (z - zs[i]) * vz) / (vx * vx + vz * vz), 0, 1);
    const px = xs[i] + vx * t, pz = zs[i] + vz * t;
    const q = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (q < bd) { bd = q; bt = t; bseg = i; }
  }
  const i = bseg, j = i + 1, t = bt;
  const txx = lerp(RIV.tx[i], RIV.tx[j], t), tzz = lerp(RIV.tz[i], RIV.tz[j], t);
  const px = lerp(xs[i], xs[j], t), pz = lerp(zs[i], zs[j], t);
  const side = txx * (z - pz) - tzz * (x - px); // cross(T, q - p)
  R.d = Math.sqrt(bd) * (side >= 0 ? 1 : -1);
  R.s = lerp(RIV.ss[i], RIV.ss[j], t);
  R.w = lerp(RIV.ws[i], RIV.ws[j], t);
  R.D = lerp(RIV.ds[i], RIV.ds[j], t);
  R.k = lerp(RIV.kap[i], RIV.kap[j], t);
  R.tx = txx; R.tz = tzz; R.i = i;
  return R;
}
export const riverPoint = (i) => [RIV.xs[i], RIV.zs[i]];
export const RIVER_SAMPLES = RIV;

// The dirt path, from behind the viewer down to a small landing on the bank.
export const PATH = [
  [3.2, 46], [2.4, 32], [1.2, 21], [0.4, 14], [0.05, 9.6], [0.1, 7.2], [0.45, 5.4], [0.95, 4.1], [1.25, 3.2],
];
export const LANDING = { x: 1.3, z: 2.9 };

export function pathDist(x, z) {
  let best = 1e9;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i], [bx, bz] = PATH[i + 1];
    const vx = bx - ax, vz = bz - az, wx = x - ax, wz = z - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz)));
    const d = Math.hypot(wx - vx * t, wz - vz * t);
    if (d < best) best = d;
  }
  return best;
}

export function pathMask(x, z) {
  if (z < 1.5 || Math.abs(x - 1.5) > 9) return 0;
  const d = pathDist(x, z) + 0.2 * fbm(x * 1.4, z * 1.4, 3, 2);
  const width = 0.72 + 0.16 * fbm(z * 0.3, 0.5, 2, 9);
  return 1 - smoothstep(width * 0.55, width, d);
}

// Metres outside the (noisy) bank line; negative inside the channel.
export function bankE(x, z, r = river(x, z)) {
  const wob = 1.0 * fbm(x * 0.17, z * 0.17, 3, 4) + 0.3 * fbm(x * 0.8, z * 0.8, 2, 8);
  return Math.abs(r.d) - r.w + wob * 1.7;
}

// 0 = gentle gravel bank, 1 = undercut bank. The outside of a bend is cut, the inside is a bar.
export function cutBank(x, z, r) {
  const outer = -r.k * Math.sign(r.d); // > 0 on the outside of the bend
  let c = 0.42 + outer * 9 + 0.9 * fbm(x * 0.12, z * 0.12, 2, 12);
  c = smoothstep(0.25, 0.75, c);
  c *= 1 - smoothstep(5.0, 1.8, Math.hypot(x - LANDING.x, z - LANDING.z)); // the landing is always a beach
  return c;
}

export function heightAt(x, z) {
  const r = river(x, z);
  const e = bankE(x, z, r);
  const cut = cutBank(x, z, r);
  let h;
  if (e >= 0) {
    const gentle = 0.02 + 0.5 * smoothstep(0, 3.2, e) + 0.05 * smoothstep(0, 0.6, e);
    const steep = 0.02 + 0.62 * smoothstep(-0.02, 0.42, e) + 0.08 * smoothstep(0.4, 2.5, e);
    h = lerp(gentle, steep, cut);
    const inland = smoothstep(0.3, 5, e);
    h += inland * (0.22 * fbm(x * 0.11, z * 0.11, 3, 1) + 0.07 * fbm(x * 0.45, z * 0.45, 2, 3));
    h += 0.035 * fbm(x * 1.6, z * 1.6, 2, 5) * smoothstep(0, 1, e);
    // The valley sides rise slowly away from the water, then roll.
    h += 0.045 * Math.max(0, e - 3) * (1 - 0.5 * smoothstep(10, 60, e)) + smoothstep(18, 60, e) * 1.6 * fbm(x * 0.035, z * 0.035, 3, 5);
    h -= 0.07 * pathMask(x, z) * smoothstep(0.2, 1.5, e);
  } else {
    const m = -e;
    // The thalweg hugs the outside of bends.
    const off = clamp(r.k * 7.0, -0.55, 0.55);
    const nn = clamp(r.d / r.w, -1, 1);
    const p = (nn + off) / (1 + Math.sign(nn + off) * off);
    const prof = 0.5 + 0.5 * Math.pow(Math.max(0, 1 - p * p), 0.8);
    const edgeW = lerp(2.6, 0.7, cut);
    const f = smoothstep(0, edgeW, m);
    const bed = r.D * prof * (1 + 0.5 * fbm(x * 0.28, z * 0.28, 3, 6)) + 0.06;
    h = 0.02 - bed * f - 0.05 * smoothstep(0, 0.5, m) * cut;
    h += 0.05 * fbm(x * 1.1, z * 1.1, 2, 7) * f;
  }
  return h;
}

// Depth of water at a point (0 on land).
export const depthAt = (x, z) => Math.max(0, WATER_Y - heightAt(x, z));

// --- Hero trees and rocks: shared so vegetation, flow and ground cover all agree ---------
export const HERO_TREES = {
  left: { x: -2.9, z: 4.5 },
  right: { x: 4.6, z: 1.6 },
};

// Rocks: x, z, radius (m), sink (fraction of height buried), kind ('r' river / 'b' bank / 'f' foreground).
export const ROCKS = (() => {
  const list = [
    // foreground boulders flanking the path
    { x: -1.25, z: 6.6, r: 0.62, sink: 0.3, kind: 'f' }, { x: -1.9, z: 7.6, r: 0.45, sink: 0.35, kind: 'f' },
    { x: 1.35, z: 6.9, r: 0.7, sink: 0.32, kind: 'f' }, { x: 2.2, z: 6.1, r: 0.42, sink: 0.4, kind: 'f' },
    { x: -0.95, z: 5.2, r: 0.33, sink: 0.4, kind: 'f' }, { x: 1.9, z: 7.9, r: 0.38, sink: 0.4, kind: 'f' },
    // at the landing, half in the water
    { x: 2.5, z: 2.0, r: 0.5, sink: 0.35, kind: 'b' }, { x: -0.3, z: 2.9, r: 0.42, sink: 0.4, kind: 'b' }, { x: 0.7, z: 2.0, r: 0.3, sink: 0.3, kind: 'r' },
    // pool margins
    { x: 3.2, z: -0.6, r: 0.6, sink: 0.3, kind: 'r' }, { x: -6.2, z: 2.1, r: 0.55, sink: 0.3, kind: 'r' }, { x: -4.6, z: -5.4, r: 0.62, sink: 0.3, kind: 'b' },
    // head of the pool and the riffle: the current threads between these
    { x: 0.2, z: -4.6, r: 0.62, sink: 0.2, kind: 'r' }, { x: 2.3, z: -5.2, r: 0.8, sink: 0.2, kind: 'r' }, { x: -1.2, z: -5.9, r: 0.45, sink: 0.2, kind: 'r' },
    { x: 1.1, z: -6.9, r: 0.42, sink: 0.2, kind: 'r' }, { x: 3.6, z: -7.4, r: 0.55, sink: 0.2, kind: 'r' }, { x: -0.3, z: -8.3, r: 0.7, sink: 0.2, kind: 'r' },
    { x: 2.2, z: -9.0, r: 0.5, sink: 0.2, kind: 'r' }, { x: 4.6, z: -9.9, r: 0.75, sink: 0.25, kind: 'r' }, { x: 0.9, z: -10.6, r: 0.38, sink: 0.2, kind: 'r' },
    { x: 3.0, z: -11.4, r: 0.85, sink: 0.2, kind: 'r' }, { x: 1.4, z: -12.9, r: 0.55, sink: 0.2, kind: 'r' }, { x: 5.0, z: -12.6, r: 0.48, sink: 0.25, kind: 'r' },
    { x: 3.4, z: -14.4, r: 0.62, sink: 0.2, kind: 'r' }, { x: 2.0, z: -16.2, r: 0.5, sink: 0.2, kind: 'r' }, { x: 5.4, z: -15.6, r: 0.75, sink: 0.4, kind: 'b' },
    { x: -1.4, z: -11.6, r: 0.6, sink: 0.4, kind: 'b' }, { x: 5.6, z: -6.0, r: 0.55, sink: 0.4, kind: 'b' }, { x: -3.0, z: -7.6, r: 0.5, sink: 0.4, kind: 'b' },
    { x: 3.9, z: -18.4, r: 0.6, sink: 0.25, kind: 'r' }, { x: 6.2, z: -21.5, r: 0.8, sink: 0.4, kind: 'b' },
    // downstream
    { x: -9.5, z: 3.6, r: 0.55, sink: 0.3, kind: 'r' }, { x: -13.5, z: -2.2, r: 0.7, sink: 0.3, kind: 'r' }, { x: -17.5, z: 1.6, r: 0.5, sink: 0.2, kind: 'r' },
    { x: -19.5, z: -0.4, r: 0.62, sink: 0.2, kind: 'r' }, { x: -21.5, z: 1.6, r: 0.45, sink: 0.2, kind: 'r' }, { x: -7.2, z: 7.4, r: 0.6, sink: 0.4, kind: 'b' },
  ];
  // Seeded extras along the banks and in shallow water, away from the path.
  const r = rng(4242);
  let tries = 0;
  while (list.length < 78 && tries++ < 4000) {
    const i = Math.floor(r() * RIV.n * 0.5 + RIV.n * 0.22);
    const side = r() < 0.5 ? -1 : 1;
    const off = RIV.ws[i] * (0.35 + r() * 1.1) * side;
    const x = RIV.xs[i] - RIV.tz[i] * off + (r() - 0.5), z = RIV.zs[i] + RIV.tx[i] * off + (r() - 0.5);
    if (Math.hypot(x, z) > 46) continue;
    if (pathDist(x, z) < 1.4) continue;
    if (Math.hypot(x - HERO_TREES.left.x, z - HERO_TREES.left.z) < 1.6 || Math.hypot(x - HERO_TREES.right.x, z - HERO_TREES.right.z) < 1.6) continue;
    const rad = 0.22 + Math.pow(r(), 2.2) * 0.75;
    if (list.some((o) => Math.hypot(o.x - x, o.z - z) < (o.r + rad) * 1.15)) continue;
    const dep = depthAt(x, z);
    if (dep > 0.45) continue;
    list.push({ x, z, r: rad, sink: dep > 0.02 ? 0.2 : 0.36 + r() * 0.16, kind: dep > 0.02 ? 'r' : 'b' });
  }
  list.forEach((o, i) => { o.rot = (i * 2.399963) % (Math.PI * 2); o.variant = i; });
  return list;
})();
