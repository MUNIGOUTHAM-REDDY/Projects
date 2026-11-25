// World layout: pool shape, path, terrain height. Units are metres.
// The default "Trail" camera stands on the path at z = 6.5 looking north (-z) at the pool.
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

const perlin = new ImprovedNoise();

export const WATER_Y = 0;
export const POOL = { cx: -0.4, cz: -2.1, rx: 6.0, rz: 4.95 };

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;

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

// Normalised elliptical distance from pool centre with a wobbly outline. < 1 is water.
export function poolE(x, z) {
  const dx = (x - POOL.cx) / POOL.rx, dz = (z - POOL.cz) / POOL.rz;
  const ang = Math.atan2(dz, dx);
  const wob = 1 + 0.07 * Math.sin(ang * 3 + 0.6) + 0.05 * Math.sin(ang * 5 + 2.1) + 0.12 * fbm(x * 0.3, z * 0.3, 2, 4);
  let e = Math.sqrt(dx * dx + dz * dz) / wob;
  // The left tree stands on a small headland; water wraps behind and to its left.
  e += 0.5 * Math.exp(-((x + 1.85) ** 2 * 0.9 + (z - 1.8) ** 2 * 0.7));
  e += 0.32 * smoothstep(-2.3, -4.2, x) * smoothstep(-1.8, 1.2, z);
  e -= 0.07 * Math.exp(-((x + 0.1) ** 2 / 0.7 + (z - 2.7) ** 2 / 0.9));
  return e;
}

// The dirt path, from behind the viewer down to the water's edge.
export const PATH = [
  [-1.2, 20], [-0.9, 13], [-0.6, 9.5], [-0.55, 6.8], [-0.55, 4.6], [-0.5, 3.4], [-0.42, 2.4],
];

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
  const d = pathDist(x, z) + 0.18 * fbm(x * 1.4, z * 1.4, 3, 2);
  const width = 0.44 + 0.1 * fbm(z * 0.3, 0.5, 2, 9);
  return 1 - smoothstep(width * 0.6, width, d);
}

export function heightAt(x, z) {
  const e = poolE(x, z);
  const far = Math.hypot(x - POOL.cx, z - POOL.cz);
  let bank = 0.2 + 0.14 * fbm(x * 0.22, z * 0.22, 3, 1) + 0.05 * fbm(x * 1.3, z * 1.3, 2, 3);
  bank += 0.18 * smoothstep(1.0, 1.8, e); // bank rises gently away from the water
  bank += smoothstep(10, 30, far) * (0.8 + 2.2 * fbm(x * 0.04, z * 0.04, 3, 5)); // rolling forest floor
  bank = Math.max(bank, 0.1 + 0.1 * smoothstep(1.0, 1.3, e));
  let h = bank;
  if (e < 1.0) {
    const t = smoothstep(1.0, 0.3, e);
    // Shallow shelf toward the viewer (south), deep hole to the north.
    const front = smoothstep(-1.0, 3.5, z - POOL.cz);
    const depth = 0.35 + 3.1 * Math.pow(t, 0.85) * (1 - 0.6 * front);
    const basin = -depth + 0.18 * fbm(x * 0.5, z * 0.5, 3, 6);
    const edge = smoothstep(1.0, 0.8, e);
    h = lerp(bank, basin, edge);
  }
  if (e > 1.0) h += 0.3 * Math.exp(-((x + 2.2) ** 2 + (z - 2.7) ** 2) / 0.9) * smoothstep(1.0, 1.15, e);
  h -= 0.06 * pathMask(x, z);
  return h;
}

// Things standing in the world that vegetation should avoid.
export const HERO_TREES = {
  left: { x: -1.75, z: 1.3 },
  right: { x: 1.3, z: 2.9 },
};
