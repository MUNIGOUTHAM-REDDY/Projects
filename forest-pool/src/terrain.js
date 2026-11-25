// Forest floor: one detailed patch around the pool plus a coarse outer ring.
// A splat texture (path / pool floor / moss / leaf litter) drives a texture blend in the shader.
import * as THREE from 'three';
import { heightAt, poolE, pathMask, fbm, smoothstep } from './world.js';
import { pbr } from './textures.js';
import { underwater, chain, dapple } from './shaders.js';

export const SPLAT = { min: -40, size: 80, res: 512 };

function buildSplat() {
  const { min, size, res } = SPLAT;
  const data = new Uint8Array(res * res * 4);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = min + (i + 0.5) / res * size;
      const z = min + (j + 0.5) / res * size;
      const e = poolE(x, z);
      const path = pathMask(x, z);
      const pool = smoothstep(1.0, 0.93, e);
      // Bright moss: strong on the near-left bank and on the banks just around the water.
      let moss = 0.5 + 0.9 * fbm(x * 0.35, z * 0.35, 3, 11);
      moss += 0.6 * smoothstep(1.6, 1.0, e);
      moss += 0.7 * smoothstep(3.5, 0, Math.hypot(x + 1.6, z - 4.2));
      moss += 0.6 * smoothstep(2.8, 0, Math.hypot(x - 0.9, z - 3.6));
      moss += 0.5 * smoothstep(1.5, 1.0, e) * (z > -2 ? 1 : 0);
      moss = Math.min(1, Math.max(0, moss)) * (1 - path);
      const litter = Math.min(1, Math.max(0, 0.45 + 1.4 * fbm(x * 0.5 + 9, z * 0.5, 3, 13))) * (1 - pool);
      const k = (j * res + i) * 4;
      data[k] = path * 255;
      data[k + 1] = pool * 255;
      data[k + 2] = moss * 255;
      data[k + 3] = litter * 255;
    }
  }
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function displacedPlane(size, segs, cx, cz, sink = null) {
  const g = new THREE.PlaneGeometry(size, size, segs, segs);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, 0, cz);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let y = heightAt(x, z);
    if (sink && sink(x, z)) y -= 0.25;
    p.setY(i, y);
  }
  g.computeVertexNormals();
  return g;
}

export function createTerrain(quality) {
  const splat = buildSplat();
  const grass = pbr('forrest_ground_01');
  const moss = pbr('aerial_grass_rock');
  const mossClump = pbr('forest_leaves_02');
  const dirt = pbr('forest_ground_04');
  const sand = pbr('forrest_sand_01');
  const pebbles = pbr('river_small_rocks');

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.55 });
  chain(mat, 'terrain', (s) => {
    Object.assign(s.uniforms, {
      uSplat: { value: splat }, uSplatMin: { value: SPLAT.min }, uSplatSize: { value: SPLAT.size },
      tGrass: { value: grass.map }, nGrass: { value: grass.normal },
      tMoss: { value: moss.map }, nMoss: { value: moss.normal },
      tClump: { value: mossClump.map }, nClump: { value: mossClump.normal },
      tDirt: { value: dirt.map }, nDirt: { value: dirt.normal },
      tSand: { value: sand.map }, nSand: { value: sand.normal },
      tPeb: { value: pebbles.map }, nPeb: { value: pebbles.normal },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vTW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTN = normalize(mat3(modelMatrix) * objectNormal);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTW; varying vec3 vTN;
        uniform sampler2D uSplat; uniform float uSplatMin; uniform float uSplatSize;
        uniform sampler2D tGrass, nGrass, tMoss, nMoss, tClump, nClump, tDirt, nDirt, tSand, nSand, tPeb, nPeb;
        vec3 tNs; float tAO;
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
        // Two scales blended by noise hides texture tiling.
        vec3 tri(sampler2D t, vec2 uv, float n){ return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.37 + 0.31).rgb, n); }
        `)
      .replace('#include <map_fragment>', `
        vec2 suv = (vTW.xz - uSplatMin) / uSplatSize;
        vec4 sp = texture2D(uSplat, suv);
        float big = vnoise(vTW.xz * 0.15);
        float n2 = vnoise(vTW.xz * 0.8 + 7.0);
        vec2 uv = vTW.xz;
        vec3 cG = tri(tGrass, uv * 0.42, big);
        vec3 cM = tri(tMoss, uv * 0.30, big) * vec3(0.8, 1.3, 0.38);
        vec3 cC = tri(tClump, uv * 0.55, big) * vec3(0.8, 1.4, 0.4);
        vec3 cD = tri(tDirt, uv * 0.45, big);
        vec3 cS = tri(tSand, uv * 0.40, big);
        vec3 cP = tri(tPeb, uv * 0.50, big);
        vec3 nG = texture2D(nGrass, uv * 0.42).xyz, nM = texture2D(nMoss, uv * 0.30).xyz, nC = texture2D(nClump, uv * 0.55).xyz;
        vec3 nD = texture2D(nDirt, uv * 0.45).xyz, nS = texture2D(nSand, uv * 0.40).xyz, nP = texture2D(nPeb, uv * 0.5).xyz;
        float path = smoothstep(0.15, 0.85, sp.r + (n2 - 0.5) * 0.35);
        float pool = sp.g;
        float moss = smoothstep(0.2, 0.8, sp.b + (n2 - 0.5) * 0.4);
        float litter = smoothstep(0.35, 0.9, sp.a);
        vec3 col = mix(cG, mix(cM, cC, smoothstep(0.4, 0.7, n2)), moss);
        vec3 nrm = mix(nG, mix(nM, nC, smoothstep(0.4, 0.7, n2)), moss);
        col = mix(col, cD * vec3(0.95, 0.9, 0.85), litter * 0.35 * (1.0 - moss));
        float hum = vnoise(vTW.xz * 0.8 + 11.0) * 0.6 + vnoise(vTW.xz * 2.3) * 0.4;
        col *= mix(vec3(0.55, 0.62, 0.45), vec3(1.2, 1.25, 1.05), hum) * (1.0 - path) + path;
        // Path: packed earth with sandy wear in the middle.
        vec3 pathCol = mix(cD * vec3(1.05, 1.0, 0.9), cS * vec3(1.05, 1.0, 0.88), smoothstep(0.3, 0.9, path) * 0.75);
        pathCol = vec3(dot(pathCol, vec3(0.33))) * vec3(1.3, 1.12, 0.86) * 1.45;
        col = mix(col, pathCol, path);
        nrm = mix(nrm, mix(nD, nS, 0.5), path);
        // Pool floor: pale limestone sand with scattered pebbles; slightly wet just above the waterline.
        vec3 floorCol = mix(cS * vec3(1.15, 1.12, 1.0), cP, smoothstep(0.55, 0.8, vnoise(vTW.xz * 0.35 + 3.0)) * 0.6);
        col = mix(col, floorCol, pool);
        nrm = mix(nrm, mix(nS, nP, 0.4), pool);
        float farD = length((vTW.xz - vec2(-0.4, -2.1)) / vec2(6.0, 4.95));
        col = mix(col, col * vec3(0.42, 0.5, 0.32), smoothstep(1.5, 2.4, farD));
        float wet = smoothstep(0.35, 0.0, vTW.y) * (1.0 - pool) ;
        col *= 1.0 - wet * 0.35;
        tNs = nrm * 2.0 - 1.0;
        diffuseColor.rgb *= col;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(vTN);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - wn * wn.x);
          vec3 B = cross(wn, T);
          vec3 pw = normalize(T * tNs.x * 1.4 - B * tNs.y * 1.4 + wn * tNs.z);
          normal = normalize((viewMatrix * vec4(pw, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.55, wet);`);
  });
  underwater(mat);
  dapple(mat);

  const inner = 40;
  const segs = quality === 'low' ? 220 : 400;
  const innerGeo = displacedPlane(inner, segs, -0.5, -1);
  const outerGeo = displacedPlane(260, quality === 'low' ? 90 : 140, 0, 0, (x, z) => Math.abs(x + 0.5) < inner / 2 - 1 && Math.abs(z + 1) < inner / 2 - 1);

  const group = new THREE.Group();
  const a = new THREE.Mesh(innerGeo, mat);
  const b = new THREE.Mesh(outerGeo, mat);
  for (const m of [a, b]) { m.receiveShadow = true; group.add(m); }
  group.userData.splat = splat;
  return group;
}
