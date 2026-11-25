// A handful of leaves let go of the canopy: each one side-slips and rocks like a falling plate,
// some tumble end over end, they settle on the ground, or land on the river and ride the current
// (following the same baked flow field that drives the water shader).
import * as THREE from 'three';
import { heightAt, rng, WATER_Y } from './world.js';
import { sampleBake } from './bake.js';
import { litterMaterials, leafGeometry } from './foliage.js';

export function createFallingLeaves(quality) {
  const N = quality === 'low' ? 50 : 130;
  const SCALE = Number(new URLSearchParams(location.search).get('leafscale') || 1);
  const g = leafGeometry().clone();
  g.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(N).map((_, i) => i % 4), 1));
  const mesh = new THREE.InstancedMesh(g, litterMaterials().mat, N);
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const r = rng(909);
  const L = [];
  const tints = [[0.36, 0.25, 0.06], [0.26, 0.15, 0.06], [0.3, 0.3, 0.07], [0.27, 0.11, 0.045], [0.17, 0.25, 0.06]];
  const spawn = (o, fresh) => {
    // drop zones: under the two hero crowns and along the river corridor in front of the trail
    // the river corridor and, more thickly, the places people stand and look
    const k = r();
    if (k < 0.24) { o.x = 0.1 + (r() - 0.5) * 5; o.z = 5.2 + (r() - 0.5) * 5; }            // over the trail
    else if (k < 0.46) { o.x = 0.8 + (r() - 0.5) * 6; o.z = -1.5 + (r() - 0.5) * 6; }      // over the pool by the landing
    else if (k < 0.62) { o.x = -2.6 + (r() - 0.5) * 5; o.z = 4.6 + (r() - 0.5) * 5; }      // under the old tree
    else if (k < 0.76) { o.x = -3 + (r() - 0.5) * 9; o.z = -1 + (r() - 0.5) * 8; }
    else { o.x = 1.5 + (r() - 0.5) * 10; o.z = -8 + (r() - 0.5) * 14; }
    o.y = fresh ? 6 + r() * 7 : 1 + r() * 11;
    o.mode = 0; o.age = 0; o.rest = 0; o.fade = fresh ? 0 : 1;
    o.tumble = r() < 0.3;
    o.w = 2.2 + r() * 1.6;            // rocking frequency
    o.amp = 0.35 + r() * 0.5;         // rocking amplitude (rad)
    o.ph = r() * 6.283; o.head = r() * 6.283; o.spin = (r() - 0.5) * 1.2;
    o.size = 0.075 + r() * 0.03;
    o.vy = 0;
    o.q = o.q || new THREE.Quaternion();
  };
  for (let i = 0; i < N; i++) {
    const o = {}; spawn(o, false);
    o.v = 0.7 + r() * 0.4;
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
      // afloat: wet and curled, lying low so the edges dip under the surface
      const fl = o.mode === 2;
      m.compose(p.set(o.x, o.y - (fl ? 0.006 : 0), o.z), o.q, s.set(sc * (fl ? 0.85 : 1), sc * (fl ? 0.85 : 1), sc * (fl ? 2.2 : 1.9)));
      const t = tints[i % tints.length], v = o.v * (fl ? 0.6 : 1);
      mesh.instanceColor.setXYZ(i, t[0] * v, t[1] * v, t[2] * v);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
  }
  // The first few leaves belong to the viewer: they always fall somewhere in the 3-15 m ahead of the camera,
  // and are re-dropped upwind and overhead when they have landed or been left behind.
  const LOCAL = quality === 'low' ? 8 : 12;
  const fwd = new THREE.Vector3();
  function respawnLocal(o, cam, target, fresh) {
    spawn(o, fresh);
    fwd.subVectors(target, cam.position); fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const d = 3 + r() * 12, lat = (r() - 0.5) * d * 0.9;
    o.x = cam.position.x + fwd.x * d - fwd.z * lat - 0.6;      // a little upwind: they drift back into view
    o.z = cam.position.z + fwd.z * d + fwd.x * lat - 0.3;
    const ground = Math.max(heightAt(o.x, o.z), WATER_Y);
    o.y = Math.max(ground + 2.5, cam.position.y + 1.2) + r() * (fresh ? 3.5 : 0) - (fresh ? 0 : r() * 2.2);
    o.amp = 0.6 + r() * 0.5; o.size = 0.085 + r() * 0.02;
    o.local = true; o.linger = 1.5 + r() * 3.5;
  }
  function stepAll(dt, time, cam, target) {
    for (let i = 0; i < N; i++) {
      const o = L[i];
      step(o, dt, time);
      if (i < LOCAL && cam) {
        const dx = o.x - cam.position.x, dz = o.z - cam.position.z;
        if (!o.local || dx * dx + dz * dz > 24 * 24 || (o.mode !== 0 && o.rest > o.linger)) respawnLocal(o, cam, target, !!o.local);
      }
    }
  }
  mesh.userData.update = (dt, time, jump, cam, target) => {
    if (jump) {
      // advance the same simulation from a fixed seed, so a still frame (or the first live frame) already
      // has leaves in the air, on the ground and afloat
      const total = 40 + time, h = 1 / 30;
      for (let t = 0; t < total; t += h) stepAll(h, t - 40, cam, target);
    } else stepAll(dt, time, cam, target);
    write();
  };
  write();
  return mesh;
}
