// A handful of leaves let go of the canopy: each one side-slips and rocks like a falling plate,
// some tumble end over end, they settle on the ground, or land on the river and ride the current
// (following the same baked flow field that drives the water shader).
import * as THREE from 'three';
import { heightAt, rng, WATER_Y } from './world.js';
import { sampleBake } from './bake.js';
import { litterMaterials, leafGeometry } from './foliage.js';

export function createFallingLeaves(quality) {
  const N = quality === 'low' ? 30 : 64;
  const SCALE = Number(new URLSearchParams(location.search).get('leafscale') || 1);
  const g = leafGeometry().clone();
  g.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(N).map((_, i) => i % 4), 1));
  const mesh = new THREE.InstancedMesh(g, litterMaterials().mat, N);
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const r = rng(909);
  const L = [];
  const tints = [[0.6, 0.44, 0.07], [0.42, 0.24, 0.07], [0.5, 0.5, 0.1], [0.4, 0.15, 0.05], [0.3, 0.42, 0.08]];
  const spawn = (o, fresh) => {
    // drop zones: under the two hero crowns and along the river corridor in front of the trail
    const k = r();
    if (k < 0.3) { o.x = -3 + (r() - 0.5) * 9; o.z = 3.5 + (r() - 0.5) * 7; }
    else if (k < 0.55) { o.x = 3.5 + (r() - 0.5) * 7; o.z = 1 + (r() - 0.5) * 7; }
    else { o.x = 0.5 + (r() - 0.5) * 11; o.z = -5 + (r() - 0.5) * 16; }
    o.y = fresh ? 6 + r() * 7 : 1 + r() * 11;
    o.mode = 0; o.age = 0; o.rest = 0; o.fade = fresh ? 0 : 1;
    o.tumble = r() < 0.3;
    o.w = 2.2 + r() * 1.6;            // rocking frequency
    o.amp = 0.35 + r() * 0.5;         // rocking amplitude (rad)
    o.ph = r() * 6.283; o.head = r() * 6.283; o.spin = (r() - 0.5) * 1.2;
    o.size = 0.095 + r() * 0.035;
    o.vy = 0;
    o.q = o.q || new THREE.Quaternion();
  };
  for (let i = 0; i < N; i++) {
    const o = {}; spawn(o, false);
    const t = tints[i % tints.length], v = 0.7 + r() * 0.4;
    mesh.instanceColor.setXYZ(i, t[0] * v, t[1] * v, t[2] * v);
    L.push(o);
  }
  const m = new THREE.Matrix4(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ax = new THREE.Vector3();
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); // leaf +Z -> up

  function step(o, dt, time) {
    o.age += dt;
    o.fade = Math.min(1, o.fade + dt * 2);
    if (o.mode === 0) {
      const gust = 0.5 + 0.5 * Math.sin(time * 0.23 + o.ph);
      if (o.tumble) {
        // autorotation: spins about its long axis and glides off sideways
        o.ph += dt * 9;
        o.x += (Math.cos(o.head) * 0.75 + 0.35 * gust) * dt; o.z += (Math.sin(o.head) * 0.75 + 0.2 * gust) * dt;
        o.y -= 1.15 * dt;
        o.head += o.spin * 0.3 * dt;
        qa.setFromAxisAngle(ax.set(0, 1, 0), -o.head);
        qb.setFromAxisAngle(ax.set(0, 0, 1), o.ph);
        o.q.copy(qa).multiply(qb);
      } else {
        // flutter: swing like a pendulum, dropping fastest through the middle of each swing
        const a = o.ph + o.w * o.age;
        const sw = Math.sin(a), cw = Math.cos(a);
        const lat = o.amp * 0.9 * o.w * cw * 0.32;
        o.x += (Math.cos(o.head) * lat + 0.3 * gust) * dt; o.z += (Math.sin(o.head) * lat + 0.18 * gust) * dt;
        o.y -= (0.55 + 0.6 * cw * cw) * dt;
        o.head += o.spin * dt;
        qa.setFromAxisAngle(ax.set(0, 1, 0), -o.head);
        qb.setFromAxisAngle(ax.set(0, 0, 1), -o.amp * sw);
        o.q.copy(qa).multiply(flat).multiply(qb);
      }
      const ground = heightAt(o.x, o.z);
      if (o.y <= Math.max(ground, WATER_Y) + 0.012) {
        if (ground < WATER_Y - 0.03) { o.mode = 2; o.y = WATER_Y + 0.004; }
        else { o.mode = 1; o.y = ground + 0.012; }
        o.rest = 0;
        qa.setFromAxisAngle(ax.set(0, 1, 0), -o.head);
        o.q.copy(qa).multiply(flat);
      }
    } else if (o.mode === 1) {
      o.rest += dt;
      if (o.rest > 9 + o.amp * 10) { o.fade -= dt * 3; if (o.fade <= 0.02) spawn(o, true); }
    } else {
      // afloat: carried by the current, slowly turning, nudged around rocks by the flow field
      const b = sampleBake(o.x, o.z);
      const sp = Math.hypot(b.fx, b.fz);
      o.x += b.fx * 0.75 * dt + Math.sin(time * 0.7 + o.ph) * 0.02 * dt;
      o.z += b.fz * 0.75 * dt + Math.cos(time * 0.6 + o.ph) * 0.02 * dt;
      o.head += (o.spin * 0.4 + sp * 0.3 * Math.sin(time * 0.5 + o.ph)) * dt;
      o.y = WATER_Y + 0.004 + Math.sin(time * 2.1 + o.ph) * 0.002;
      qa.setFromAxisAngle(ax.set(0, 1, 0), -o.head);
      qb.setFromAxisAngle(ax.set(1, 0, 0), Math.sin(time * 1.7 + o.ph) * 0.05);
      o.q.copy(qa).multiply(flat).multiply(qb);
      o.rest += dt;
      const stuck = b.h > WATER_Y - 0.02 || sp < 0.03;
      if (o.rest > 70 || Math.abs(o.x) > 60 || Math.abs(o.z) > 60 || (stuck && o.rest > 25)) { o.fade -= dt * 3; if (o.fade <= 0.02) spawn(o, true); }
    }
  }
  function write() {
    for (let i = 0; i < N; i++) {
      const o = L[i], sc = o.size * SCALE * Math.max(0.001, o.fade);
      m.compose(p.set(o.x, o.y, o.z), o.q, s.set(sc, sc, sc));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  let simT = 0;
  mesh.userData.update = (dt, time, jump) => {
    if (jump) {
      // still frames: run the simulation forward so the capture shows leaves mid-fall and afloat
      const total = 40 + time, h = 1 / 30;
      for (let t = 0; t < total; t += h) for (const o of L) step(o, h, t - 40);
    } else {
      simT += dt;
      for (const o of L) step(o, dt, time);
    }
    write();
  };
  write();
  return mesh;
}
