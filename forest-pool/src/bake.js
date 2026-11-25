// Baked maps the shaders and the scatter code share: riverbed height, the flow field (with
// boulders deflecting it and trailing foam), and a splat map for the ground materials.
import * as THREE from 'three';
import { heightAt, river, bankE, cutBank, pathMask, fbm, smoothstep, clamp, ROCKS, HERO_TREES, WATER_Y } from './world.js';
import { G } from './shaders.js';

export const BAKE = { minX: -83, minZ: -97, size: 150, res: 600, data: null };
export const SPLAT = { minX: -36, minZ: -40, size: 72, res: 576, tex: null };

export function buildBake() {
  const { minX, minZ, size, res } = BAKE;
  const data = new Float32Array(res * res * 4);
  const cell = size / res;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      const k = (j * res + i) * 4;
      const h = heightAt(x, z);
      data[k] = h;
      const r = river(x, z);
      if (Math.abs(r.d) > r.w + 4) continue;
      const depth = Math.max(0, WATER_Y - h);
      const nn = clamp(r.d / r.w, -1.2, 1.2);
      let sp = clamp(0.3 / (r.D * 0.6 + depth * 0.4 + 0.12), 0.3, 1.6) * Math.max(0.12, 1 - 0.7 * nn * nn);
      sp *= smoothstep(-0.05, 0.25, depth) * 0.85 + 0.15;
      data[k + 1] = r.tx * sp; data[k + 2] = r.tz * sp;
      // riffles: fast shallow water breaks into white streaks; a faint line of scum along the banks
      let foam = smoothstep(0.85, 1.5, sp) * smoothstep(0.42, 0.12, depth) * smoothstep(0.0, 0.06, depth) * (0.25 + 0.9 * Math.max(0, fbm(x * 0.9, z * 0.9, 2, 31) + 0.15));
      data[k + 3] = foam;
    }
  }
  // Boulders standing in the water: potential flow around a cylinder, plus bow ripple and wake foam.
  for (const rk of ROCKS) {
    const dep = WATER_Y - heightAt(rk.x, rk.z);
    if (dep < -0.12) continue;
    const a = rk.r * 0.92, reach = a * 7;
    const i0 = Math.max(0, Math.floor((rk.x - reach - minX) / cell)), i1 = Math.min(res - 1, Math.ceil((rk.x + reach - minX) / cell));
    const j0 = Math.max(0, Math.floor((rk.z - reach - minZ) / cell)), j1 = Math.min(res - 1, Math.ceil((rk.z + reach - minZ) / cell));
    const kc = (clamp(Math.floor((rk.z - minZ) / cell), 0, res - 1) * res + clamp(Math.floor((rk.x - minX) / cell), 0, res - 1)) * 4;
    let ux = data[kc + 1], uz = data[kc + 2];
    const us = Math.hypot(ux, uz);
    if (us < 0.05) continue;
    const dxn = ux / us, dzn = uz / us;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      const rx = x - rk.x, rz = z - rk.z, d = Math.hypot(rx, rz);
      const k = (j * res + i) * 4;
      if (data[k] > 0.03) continue;
      let fx = data[k + 1], fz = data[k + 2];
      if (d < a * 0.8) { data[k + 1] = fx * 0.05; data[k + 2] = fz * 0.05; continue; }
      const nx = rx / d, nz = rz / d;
      const q = Math.min(1, (a * a) / (d * d));
      const un = fx * nx + fz * nz;
      fx -= q * (2 * un * nx - fx); fz -= q * (2 * un * nz - fz);
      const along = rx * dxn + rz * dzn, lat = Math.abs(-rx * dzn + rz * dxn);
      // slack water in the lee, slowly recovering
      const lee = along > 0 ? Math.exp(-((lat / (a * 0.75)) ** 2)) * Math.exp(-along / (a * 4.5)) : 0;
      fx *= 1 - 0.8 * lee; fz *= 1 - 0.8 * lee;
      data[k + 1] = fx; data[k + 2] = fz;
      const collar = Math.exp(-(((d - a * 1.05) / (a * 0.22)) ** 2)) * (0.55 + 0.45 * Math.max(0, -along / d));
      const wakeEdge = along > 0 ? Math.exp(-(((lat - a * (0.8 + along / (a * 9))) / (a * 0.3)) ** 2)) * Math.exp(-along / (a * 5)) : 0;
      data[k + 3] = Math.min(1.5, data[k + 3] + us * (0.9 * collar + 0.75 * wakeEdge + 0.5 * lee * Math.exp(-along / (a * 2))));
    }
  }
  BAKE.data = data;
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const t = new THREE.DataTexture(half, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  G.tBake.value = t;
  G.uBake.value.set(minX, minZ, 1 / size, cell);
  return t;
}

const S = { h: 0, fx: 0, fz: 0, foam: 0 };
export function sampleBake(x, z) {
  const { minX, minZ, size, res, data } = BAKE;
  const u = (x - minX) / size * res - 0.5, v = (z - minZ) / size * res - 0.5;
  if (!data || u < 0 || v < 0 || u >= res - 1 || v >= res - 1) { S.h = heightAt(x, z); S.fx = S.fz = S.foam = 0; return S; }
  const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j;
  const k = (j * res + i) * 4, w00 = (1 - a) * (1 - b), w10 = a * (1 - b), w01 = (1 - a) * b, w11 = a * b;
  const g = (o) => data[k + o] * w00 + data[k + 4 + o] * w10 + data[k + res * 4 + o] * w01 + data[k + res * 4 + 4 + o] * w11;
  S.h = g(0); S.fx = g(1); S.fz = g(2); S.foam = g(3);
  return S;
}
// Fast ground height for scattering thousands of small things.
export const groundY = (x, z) => sampleBake(x, z).h;

// Splat: R path, G moss, B leaf litter, A contact shade (things standing on the ground).
export function buildSplat(extraContacts = []) {
  const { minX, minZ, size, res } = SPLAT;
  const data = new Uint8Array(res * res * 4);
  const cell = size / res;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      const r = river(x, z);
      const e = bankE(x, z, r);
      const path = pathMask(x, z);
      let moss = 0.42 + 1.5 * fbm(x * 0.16, z * 0.16, 3, 11) + 0.45 * smoothstep(5, 0.5, e) + 0.25 * smoothstep(9, 2, Math.hypot(x, z - 6));
      moss = clamp(moss, 0, 1) * (1 - path);
      let litter = clamp(0.5 + 1.7 * fbm(x * 0.22 + 9, z * 0.22, 3, 13) - 0.35 * smoothstep(4, 0.5, e), 0, 1);
      litter = Math.max(litter * (1 - path * 0.6), 0.6 * path * clamp(0.5 + 2 * fbm(x * 0.7, z * 0.7, 2, 17), 0, 1));
      const k = (j * res + i) * 4;
      data[k] = path * 255; data[k + 1] = moss * 255; data[k + 2] = litter * 255; data[k + 3] = 255;
    }
  }
  const stamp = (cx, cz, rad, dark, mossAdd) => {
    const reach = rad * 2.2;
    const i0 = Math.max(0, Math.floor((cx - reach - minX) / cell)), i1 = Math.min(res - 1, Math.ceil((cx + reach - minX) / cell));
    const j0 = Math.max(0, Math.floor((cz - reach - minZ) / cell)), j1 = Math.min(res - 1, Math.ceil((cz + reach - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
      const d = Math.hypot(x - cx, z - cz) / rad;
      const k = (j * res + i) * 4;
      const sh = 1 - dark * smoothstep(1.9, 0.75, d);
      data[k + 3] = Math.min(data[k + 3], sh * 255);
      data[k + 1] = Math.min(255, data[k + 1] + mossAdd * 255 * smoothstep(2.0, 0.9, d));
      data[k] = data[k] * (1 - 0.8 * smoothstep(1.6, 0.9, d));
    }
  };
  for (const rk of ROCKS) stamp(rk.x, rk.z, rk.r, 0.55, 0.5);
  for (const k in HERO_TREES) stamp(HERO_TREES[k].x, HERO_TREES[k].z, 0.75, 0.5, 0.8);
  for (const c of extraContacts) stamp(c.x, c.z, c.r, c.dark ?? 0.45, c.moss ?? 0.3);
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  SPLAT.tex = t;
  return t;
}
