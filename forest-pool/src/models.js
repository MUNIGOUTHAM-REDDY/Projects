// Loads Poly Haven glTFs (geometry only; our own materials) and returns their meshes as
// base-centred geometries ready for instancing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { manager, A } from './textures.js';

const loader = new GLTFLoader(manager);
export const modelJobs = [];
export function loadModel(id, { centre = true } = {}) {
  const job = new Promise((resolve) => {
    loader.load(A(`models/${id}/${id}.json`), (gltf) => {
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
    });
  });
  modelJobs.push(job);
  return job;
}
