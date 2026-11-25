// Forest floor and riverbed: nested height-field patches with a splat-driven material blend
// (moss, leaf litter, packed-earth path, gravel bars, mud on cut banks, pebbled bed).
import * as THREE from 'three';
import { heightAt } from './world.js';
import { pbr, tex, A } from './textures.js';
import { underwater, chain, dapple, worldPos } from './shaders.js';
import { SPLAT } from './bake.js';

function displacedPlane(size, segs, cx, cz, sink = null) {
  const g = new THREE.PlaneGeometry(size, size, segs, segs);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, 0, cz);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    let y = heightAt(x, z);
    if (sink && sink(x, z)) y -= 0.6;
    p.setY(i, y);
  }
  g.computeVertexNormals();
  return g;
}

export function createTerrain(quality, splat) {
  const ground = pbr('forrest_ground_01');
  const litter = pbr('leaves_forest_ground');
  const clump = pbr('forest_leaves_02');
  const dirt = pbr('forest_ground_04');
  const peb = pbr('ganges_river_pebbles');
  const sand = tex(A('forrest_sand_01_diff.jpg'));
  const mud = tex(A('brown_mud_leaves_01_diff.jpg'));

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 0.7 });
  underwater(mat);
  chain(mat, 'terrain', (s) => {
    Object.assign(s.uniforms, {
      uSplat: { value: splat }, uSplatBox: { value: new THREE.Vector3(SPLAT.minX, SPLAT.minZ, SPLAT.size) },
      tGround: { value: ground.map }, nGround: { value: ground.normal },
      tLitter: { value: litter.map }, nLitter: { value: litter.normal },
      tClump: { value: clump.map },
      tDirt: { value: dirt.map }, nDirt: { value: dirt.normal },
      tPeb: { value: peb.map }, nPeb: { value: peb.normal },
      tSand: { value: sand }, tMud: { value: mud },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vTN = normalize(mat3(modelMatrix) * objectNormal);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTN;
        uniform sampler2D uSplat; uniform vec3 uSplatBox;
        uniform sampler2D tGround, nGround, tLitter, nLitter, tClump, tDirt, nDirt, tPeb, nPeb, tSand, tMud;
        vec3 tNs; float tRough;
        // Two scales blended by noise hide the texture tiling.
        vec4 tri(sampler2D t, vec2 uv, float n){ return mix(texture2D(t, uv), texture2D(t, mat2(0.62, 0.47, -0.47, 0.62) * uv + 0.37), n); }
        float lum(vec3 c){ return dot(c, vec3(0.3, 0.55, 0.15)); }
        `)
      .replace('#include <map_fragment>', `
        vec2 suv = (vUW.xz - uSplatBox.xy) / uSplatBox.z;
        vec4 sp = texture2D(uSplat, suv);
        float inS = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
        float big = vnoise(vUW.xz * 0.11);
        float mid = vnoise(vUW.xz * 0.6 + 7.0);
        float fine = vnoise(vUW.xz * 3.1 + 2.0);
        sp = mix(vec4(0.0, 0.35 + 0.5 * big, 0.4 + 0.5 * mid, 1.0), sp, inS);
        vec2 uv = vUW.xz;
        float tn = smoothstep(0.3, 0.7, vnoise(vUW.xz * 0.23 + 3.0));
        vec3 cG = tri(tGround, uv * 0.36, tn).rgb;
        vec3 cL = tri(tLitter, uv * 0.45, tn).rgb;
        vec3 cC = tri(tClump, uv * 0.42, tn).rgb;
        vec3 cD = tri(tDirt, uv * 0.42, tn).rgb;
        vec3 cP = tri(tPeb, uv * 0.3, tn).rgb;
        vec3 cP2 = texture2D(tPeb, uv * 0.085 + 0.5).rgb;
        vec3 cS = tri(tSand, uv * 0.35, tn).rgb;
        vec3 cM = tri(tMud, uv * 0.4, tn).rgb;
        vec3 nG = tri(nGround, uv * 0.36, tn).xyz, nL = tri(nLitter, uv * 0.45, tn).xyz;
        vec3 nD = tri(nDirt, uv * 0.42, tn).xyz, nP = tri(nPeb, uv * 0.3, tn).xyz;

        float y = vUW.y;
        float slope = 1.0 - clamp(normalize(vTN).y, 0.0, 1.0);
        float path = smoothstep(0.2, 0.75, sp.r + (mid - 0.5) * 0.4 + (fine - 0.5) * 0.2);
        float moss = smoothstep(0.3, 0.7, sp.g + (mid - 0.5) * 0.5 + (lum(cG) - 0.3) * 0.6);
        float lit = smoothstep(0.3, 0.68, sp.b + (fine - 0.5) * 0.35 + (lum(cL) - 0.25) * 0.8);

        // forest floor: mossy soil, beech litter in drifts, bright moss cushions
        vec3 soil = cG * vec3(0.5, 0.5, 0.36);
        vec3 mossC = mix(cC * vec3(0.36, 0.66, 0.2), cG * vec3(0.34, 0.62, 0.22), 0.35 + 0.3 * big);
        mossC *= 0.6 + 0.75 * mid;
        vec3 col = mix(soil, cL * vec3(0.72, 0.56, 0.42), lit * (1.0 - 0.75 * moss));
        vec3 nrm = mix(nG, nL, lit * (1.0 - 0.75 * moss));
        mossC *= 0.45 + 1.7 * lum(cC);
        col = mix(col, mossC, moss);
        tRough = mix(0.95, 0.85, moss);

        // the path: packed earth, paler and sandier where feet wear it
        vec3 pathCol = mix(cD * vec3(1.12, 1.0, 0.86), cS * vec3(0.95, 0.88, 0.76), smoothstep(0.45, 1.0, path) * 0.55);
        pathCol = mix(pathCol, cL * vec3(0.8, 0.66, 0.5), smoothstep(0.55, 0.8, sp.b) * 0.5 * (1.0 - smoothstep(0.7, 1.0, sp.r)));
        col = mix(col, pathCol * 0.8, path);
        nrm = mix(nrm, nD, path);

        // banks: gravel and cobbles near the water on gentle ground, raw mud where the bank is cut
        float nearW = smoothstep(0.42, 0.08, y + (mid - 0.5) * 0.22 + (lum(cP) - 0.4) * 0.25);
        float steep = smoothstep(0.25, 0.55, slope);
        vec3 gravel = mix(cP, cP2, 0.35) * vec3(0.92, 0.9, 0.84);
        vec3 bank = mix(gravel, cM * vec3(0.8, 0.72, 0.6), steep * smoothstep(0.0, 0.2, y));
        col = mix(col, bank, nearW * (1.0 - 0.6 * moss * smoothstep(0.1, 0.3, y)));
        nrm = mix(nrm, mix(nP, nD, steep), nearW);
        float cut = smoothstep(0.45, 0.8, slope) * step(0.02, y);
        col = mix(col, cM * vec3(0.62, 0.52, 0.42), cut * 0.85);

        // riverbed: cobbles on the riffles, pale sand and silt in the pools
        float bed = smoothstep(0.03, -0.1, y);
        float deep = smoothstep(-0.35, -1.3, y + (mid - 0.5) * 0.4);
        vec3 bedCol = mix(gravel * 1.05, mix(cS * vec3(1.05, 1.0, 0.9), cP2, 0.25), deep * 0.8);
        bedCol = mix(bedCol, bedCol * vec3(0.55, 0.62, 0.4), smoothstep(0.55, 0.8, vnoise(vUW.xz * 0.5 + 9.0)) * 0.5); // algae
        col = mix(col, bedCol, bed);
        nrm = mix(nrm, nP, bed);

        // contact shade under rocks, trunks and plants; distant ground falls into forest shade
        col *= mix(0.42, 1.0, sp.a);
        col *= 0.7 + 0.55 * big;
        // break up repetition at the scale of the texture tile and over whole glades
        col *= (0.82 + 0.36 * vnoise(vUW.xz * 0.37 + 11.0)) * (0.85 + 0.3 * vnoise(vUW.xz * 0.027 + 4.0));
        col = mix(col, col.grb * vec3(0.9, 1.0, 0.8), 0.18 * vnoise(vUW.xz * 0.19 + 30.0));
        tNs = nrm * 2.0 - 1.0;
        diffuseColor.rgb *= col;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = normalize(vTN);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - wn * wn.x);
          vec3 B = cross(wn, T);
          vec3 pw = normalize(T * tNs.x * 2.2 - B * tNs.y * 2.2 + wn * tNs.z);
          normal = normalize((viewMatrix * vec4(pw, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = tRough;`);
  });
  dapple(mat);

  const hi = quality !== 'low';
  const inner = { size: 48, cx: -1, cz: -4 };
  const midR = { size: 150, cx: -6, cz: -20 };
  const inside = (b, m) => (x, z) => Math.abs(x - b.cx) < b.size / 2 - m && Math.abs(z - b.cz) < b.size / 2 - m;
  const geos = [
    displacedPlane(inner.size, hi ? 400 : 240, inner.cx, inner.cz),
    displacedPlane(midR.size, hi ? 280 : 180, midR.cx, midR.cz, inside(inner, 0.6)),
    displacedPlane(520, 90, 0, 0, inside(midR, 6)),
  ];
  const group = new THREE.Group();
  for (const g of geos) { const m = new THREE.Mesh(g, mat); m.receiveShadow = true; group.add(m); }
  group.userData.material = mat;
  return group;
}
