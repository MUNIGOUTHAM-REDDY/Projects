import * as THREE from 'three';

export const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
let maxAniso = 8;
export function setAnisotropy(n) { maxAniso = n; }

const cache = new Map();
export function tex(path, { srgb = true, repeat = true, flipY = true } = {}) {
  const key = path + srgb + flipY;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(path);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.flipY = flipY;
  cache.set(key, t);
  return t;
}

export const A = (name) => `assets/${name}`;
export const pbr = (name) => ({
  map: tex(A(`${name}_diff.jpg`)),
  normal: tex(A(`${name}_nor_gl.jpg`), { srgb: false }),
});
