// Debug: top-down height map of the layout -> PPM. usage: node tools/map.mjs out.ppm [half=30] [cx] [cz]
import { heightAt, PATH, ROCKS, HERO_TREES, pathMask } from '../src/world.js';
import { writeFileSync } from 'node:fs';
const out = process.argv[2], half = +(process.argv[3] || 30), cx = +(process.argv[4] || 0), cz = +(process.argv[5] || 0);
const N = 600, buf = Buffer.alloc(N * N * 3);
const t0 = Date.now();
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = cx - half + (i + 0.5) / N * 2 * half, z = cz - half + (j + 0.5) / N * 2 * half;
  const h = heightAt(x, z);
  let c;
  if (h < 0) { const d = Math.min(1, -h / 2); c = [200 - 180 * d, 230 - 110 * d, 220 - 60 * d]; }
  else { const v = Math.min(1, h / 2.5); c = [70 + 120 * v, 110 + 100 * v, 50 + 60 * v]; if (Math.abs((h * 5) % 1) < 0.06) c = c.map((q) => q * 0.8); }
  const pm = pathMask(x, z); c = c.map((q, k) => q * (1 - pm) + [190, 160, 120][k] * pm);
  for (const r of ROCKS) if (Math.hypot(x - r.x, z - r.z) < r.r) c = [90, 90, 90];
  for (const k in HERO_TREES) if (Math.hypot(x - HERO_TREES[k].x, z - HERO_TREES[k].z) < 0.35) c = [255, 0, 0];
  if (Math.abs(x % 10) < 0.06 || Math.abs(z % 10) < 0.06) c = c.map((q) => q * 0.85);
  if (Math.abs(x) < 0.08 || Math.abs(z) < 0.08) c = [0, 0, 0];
  buf.set(c, (j * N + i) * 3);
}
writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${N} ${N}\n255\n`), buf]));
console.log('ms', Date.now() - t0, 'rocks', ROCKS.length);
