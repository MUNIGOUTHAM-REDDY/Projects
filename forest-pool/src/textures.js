import * as THREE from 'three';
import { TIER } from './tier.js';

export const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
let maxAniso = 8;
export function setAnisotropy(n) { maxAniso = n; }

const cache = new Map();
export function tex(path, { srgb = true, repeat = true, flipY = true } = {}) {
  const key = path + srgb + flipY;
  if (cache.has(key)) return cache.get(key);
  // everything ships as WebP; phones load the half-size set under assets/m/
  let url = path.replace(/\.(jpg|png)$/, '.webp');
  if (TIER.halfTextures) url = url.replace(/^assets\//, 'assets/m/');
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = TIER.halfTextures ? Math.min(2, maxAniso) : maxAniso;
  t.flipY = flipY;
  cache.set(key, t);
  return t;
}

export const A = (name) => `assets/${name}`;
export const pbr = (name) => ({
  map: tex(A(`${name}_diff.jpg`)),
  normal: tex(A(`${name}_nor_gl.jpg`), { srgb: false }),
});
