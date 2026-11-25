// Shared shader uniforms and material patches (underwater absorption, caustics, wind).
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSunDir: { value: new THREE.Vector3(-0.32, 0.82, -0.47).normalize() },
  uWaterY: { value: 0 },
  uWaterScatter: { value: new THREE.Color(0.012, 0.25, 0.32) },
  uAbsorb: { value: new THREE.Vector3(0.55, 0.11, 0.09) },
};

// Compose several onBeforeCompile patches on one material.
export function chain(mat, key, fn) {
  const prev = mat.userData._patches || [];
  prev.push({ key, fn });
  mat.userData._patches = prev;
  mat.onBeforeCompile = (s, r) => { for (const p of prev) p.fn(s, r); };
  mat.customProgramCacheKey = () => prev.map((p) => p.key).join('|');
  return mat;
}

export const CAUSTIC_GLSL = /* glsl */ `
float causticPattern(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.0);
}
`;

const WORLDPOS_VERTEX = /* glsl */ `
  {
    vec4 uwp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      uwp = instanceMatrix * uwp;
    #endif
    vUW = (modelMatrix * uwp).xyz;
  }
`;

// Anything below the water plane gets light absorption along the view path,
// teal in-scattering and animated caustics. Gives the pool its turquoise depth.
export function underwater(mat, { caustics = true } = {}) {
  return chain(mat, 'uw' + (caustics ? 'c' : ''), (s) => {
    Object.assign(s.uniforms, {
      uTime: G.uTime, uWaterY: G.uWaterY, uWaterScatter: G.uWaterScatter, uAbsorb: G.uAbsorb,
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERTEX);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vUW;
        uniform float uTime; uniform float uWaterY; uniform vec3 uWaterScatter; uniform vec3 uAbsorb;
        ${CAUSTIC_GLSL}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (vUW.y < uWaterY) {
          float dY = uWaterY - vUW.y;
          float camH = cameraPosition.y - vUW.y;
          float viewLen = camH > dY ? (dY / camH) * length(cameraPosition - vUW) : length(cameraPosition - vUW);
          float L = viewLen + dY * 0.6;
          ${caustics ? `
          float ca = causticPattern(vUW.xz * 0.55 + vec2(0.0, uTime * 0.01), uTime * 0.45);
          ca += 0.6 * causticPattern(vUW.xz * 0.9 + 3.1, uTime * 0.37);
          gl_FragColor.rgb *= 1.0 + ca * 1.6 * exp(-dY * 0.5) * smoothstep(0.0, 0.25, dY);` : ''}
          gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(0.78, 1.06, 0.96), smoothstep(0.45, 0.05, dY));
          vec3 trans = exp(-uAbsorb * L);
          gl_FragColor.rgb = gl_FragColor.rgb * trans + uWaterScatter * (1.0 - exp(-0.45 * L));
        }`);
  });
}

// Canopy dapple: a projected leaf-shadow pattern multiplied into direct sunlight only.
// Requires underwater() to have been applied first (uses its vUW world position).
export function dapple(mat, { strength = 1 } = {}) {
  return chain(mat, 'dapple' + strength, (s) => {
    Object.assign(s.uniforms, { uSunDirD: G.uSunDir });
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDirD;
        float dh(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float dn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(dh(i),dh(i+vec2(1,0)),f.x), mix(dh(i+vec2(0,1)),dh(i+vec2(1,1)),f.x), f.y); }
        float canopyGobo(vec3 w){
          // project onto a canopy plane 9 m up along the sun direction
          vec2 p = w.xz + uSunDirD.xz / max(uSunDirD.y, 0.2) * (9.0 - w.y);
          float a = dn(p * 0.55) * 0.55 + dn(p * 1.7 + 3.1) * 0.3 + dn(p * 4.3 - 1.7) * 0.15;
          float big = dn(p * 0.12 + 7.0);
          return smoothstep(0.52, 0.6, a + (big - 0.5) * 0.35);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float gob = mix(1.0, canopyGobo(vUW), ${strength.toFixed(2)});
          reflectedLight.directDiffuse *= gob * 1.25;
          reflectedLight.directSpecular *= gob;
        }`);
  });
}

// Gentle wind sway for foliage. Bend grows with height in the mesh (uv.y or local y).
export function wind(mat, { amount = 0.06, useUvY = true, freq = 1.3 } = {}) {
  return chain(mat, 'wind' + amount + useUvY, (s) => {
    Object.assign(s.uniforms, { uTime: G.uTime, uWind: G.uWind });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
            ip = instanceMatrix[3].xyz;
          #endif
          float ph = ip.x * 0.7 + ip.z * 0.9;
          float k = ${useUvY ? 'uv.y * uv.y' : 'clamp(position.y, 0.0, 1.5)'};
          float w = sin(uTime * ${freq.toFixed(2)} + ph) * 0.6 + sin(uTime * ${(freq * 2.7).toFixed(2)} + ph * 1.7) * 0.25;
          transformed.x += w * ${amount.toFixed(3)} * k * uWind;
          transformed.z += cos(uTime * ${(freq * 0.8).toFixed(2)} + ph) * ${(amount * 0.6).toFixed(3)} * k * uWind;
        }`);
  });
}
