// Loads Poly Haven glTFs (geometry only; our own materials) and returns their meshes as
// base-centred geometries ready for instancing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { manager, A } from './textures.js';

const loader = new GLTFLoader();
const fileLoader = new THREE.FileLoader(manager);
fileLoader.setResponseType('json');

// The models ship as glTF JSON with their buffer inlined as a base64 data: URI. Some hosts'
// content-security policy forbids fetching data: URIs, which made GLTFLoader fail silently and
// the page hang at 100%. Decode the buffer ourselves and hand GLTFLoader an in-memory GLB.
function toGLB(gltf) {
  const b64 = gltf.buffers[0].uri.split(',')[1];
  const raw = atob(b64);
  const bin = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
  const json = { ...gltf, buffers: [{ byteLength: bin.length }] };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (jsonBytes.length + 3) & ~3, binLen = (bin.length + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsonLen + 8 + binLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen); out.set(jsonBytes, 20);
  const o = 20 + jsonLen;
  dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out.buffer;
}
export const modelJobs = [];
export function loadModel(id, { centre = true } = {}) {
  const job = new Promise((resolve) => {
    const fail = (e) => { console.warn('model failed', id, e); resolve([]); };
    fileLoader.load(A(`models/${id}/${id}.json`), (data) => {
      let glb;
      try { glb = toGLB(data); } catch (e) { fail(e); return; }
      loader.parse(glb, '', (gltf) => {
      const out = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone();
        // keep each piece's own shape and scale, drop its place on the asset sheet
        const s = new THREE.Vector3(), q = new THREE.Quaternion(), p = new THREE.Vector3();
        o.updateWorldMatrix(true, false);
        o.matrixWorld.decompose(p, q, s);
        g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(), q, s));
        g.computeBoundingBox();
        const b = g.boundingBox;
        if (centre) g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
        g.computeBoundingBox(); g.computeBoundingSphere();
        const bb = g.boundingBox;
        out.push({ name: o.name, geo: g, height: bb.max.y - bb.min.y, radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 });
      });
      out.sort((a, b) => a.name.localeCompare(b.name));
      resolve(out);
      }, fail);
    }, undefined, fail);
  });
  modelJobs.push(job);
  return job;
}
