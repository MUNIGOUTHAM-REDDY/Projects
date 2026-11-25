// Shared shader uniforms and material patches: underwater absorption + caustics, wet banks,
// canopy dapple outside the shadow map, and the wind hierarchy used by every plant.
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSunDir: { value: new THREE.Vector3(-0.42, 0.74, -0.52).normalize() },
  uWaterY: { value: 0 },
  uWaterScatter: { value: new THREE.Color(0.006, 0.105, 0.12) },
  uAbsorb: { value: new THREE.Vector3(0.55, 0.075, 0.115) },
  uShadowCentre: { value: new THREE.Vector3(0, 0, 0) },
  uShadowRadius: { value: 30 },
  tBake: { value: null },          // rgba: bed height, flow x, flow z, foam
  uBake: { value: new THREE.Vector4(0, 0, 1, 1) }, // min x, min z, 1/size
};

// Compose several onBeforeCompile patches on one material.
export function chain(mat, key, fn) {
  const prev = mat.userData._patches || [];
  prev.push({ key, fn });
  mat.userData._patches = prev;
  // Each patch inserts its declarations after "#include <common>". To keep them in application order
  // (later patches may use earlier helpers) the token is moved behind the previous insertions.
  mat.onBeforeCompile = (s, r) => {
    const T = '#include <common>';
    for (const k of ['vertexShader', 'fragmentShader']) s[k] = s[k].replace(T, T + '\n//CE');
    for (const p of prev) {
      for (const k of ['vertexShader', 'fragmentShader']) s[k] = s[k].replace(T, '//CB').replace('//CE', T + '\n//CE');
      p.fn(s, r);
      for (const k of ['vertexShader', 'fragmentShader']) s[k] = s[k].replace(T, '').replace('//CB', T);
    }
  };
  mat.customProgramCacheKey = () => prev.map((p) => p.key).join('|');
  return mat;
}

export const NOISE_GLSL = /* glsl */ `
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h12(i),h12(i+vec2(1,0)),f.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x), f.y); }
`;

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

// The canopy above the modelled trees: large gaps and closed patches (pools of sun, lakes of shade).
// Leaf-scale dapple comes from the real shadow map near the viewer; beyond its reach a finer pattern stands in.
export const GOBO_GLSL = /* glsl */ `
float canopyGap(vec3 w, vec3 sunDir){
  vec2 p = w.xz + sunDir.xz / max(sunDir.y, 0.2) * (16.0 - w.y);
  float a = vnoise(p * 0.085 + 1.7) * 0.6 + vnoise(p * 0.21 + 3.1) * 0.4;
  // a few deliberate openings: over the end of the trail, the pool and the riffle
  vec2 o = sunDir.xz / max(sunDir.y, 0.2) * 16.0;
  a += 0.30 * exp(-dot(p - o - vec2(0.2, 5.6), p - o - vec2(0.2, 5.6)) / 14.0);
  a += 0.26 * exp(-dot(p - o - vec2(-2.0, -1.0), p - o - vec2(-2.0, -1.0)) / 30.0);
  a += 0.24 * exp(-dot(p - o - vec2(2.5, -9.5), p - o - vec2(2.5, -9.5)) / 40.0);
  return smoothstep(0.43, 0.6, a);
}
float canopyDapple(vec3 w, vec3 sunDir){
  vec2 p = w.xz + sunDir.xz / max(sunDir.y, 0.2) * (14.0 - w.y);
  float a = vnoise(p * 0.55) * 0.5 + vnoise(p * 1.5 + 3.1) * 0.3 + vnoise(p * 3.9 - 1.7) * 0.2;
  return smoothstep(0.42, 0.56, a);
}
float canopyGobo(vec3 w, vec3 sunDir, float far){
  return canopyGap(w, sunDir) * mix(1.0, canopyDapple(w, sunDir), far);
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

// World position varying + noise helpers, used by the other patches.
export function worldPos(mat) {
  if (mat.userData._wp) return mat;
  mat.userData._wp = true;
  return chain(mat, 'wp', (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUW;')
      .replace(s.vertexShader.includes('//PV_END') ? '//PV_END' : '#include <project_vertex>', (m) => m + '\n' + WORLDPOS_VERTEX);
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vUW;
      ${NOISE_GLSL}`);
  });
}

// Anything below the water plane gets light absorption along the view path, in-scattering and
// animated caustics; the band just above the waterline is wet: darker and glossy.
export function underwater(mat, { caustics = true, wet = true } = {}) {
  worldPos(mat);
  return chain(mat, 'uw' + caustics + wet, (s) => {
    Object.assign(s.uniforms, {
      uTime: G.uTime, uWaterY: G.uWaterY, uWaterScatter: G.uWaterScatter, uAbsorb: G.uAbsorb,
    });
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uWaterY; uniform vec3 uWaterScatter; uniform vec3 uAbsorb;
        ${CAUSTIC_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${wet ? `{
          float wl = vUW.y - uWaterY + 0.12 * (vnoise(vUW.xz * 1.7) - 0.5) + 0.05 * (vnoise(vUW.xz * 7.0) - 0.5);
          float wetK = smoothstep(0.24, 0.05, wl);
          diffuseColor.rgb *= mix(1.0, 0.42, wetK);
          roughnessFactor = mix(roughnessFactor, 0.45, wetK * step(uWaterY - 0.01, vUW.y));
        }` : ''}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (vUW.y < uWaterY) {
          float dY = uWaterY - vUW.y;
          float camH = max(cameraPosition.y - uWaterY, 0.05);
          float viewLen = dY / max(camH + dY, 0.01) * length(cameraPosition - vUW);
          float L = min(viewLen, dY * 3.5) + dY * 0.9;
          ${caustics ? `
          float ca = causticPattern(vUW.xz * 0.9 + vec2(0.0, uTime * 0.02), uTime * 0.5);
          ca += 0.6 * causticPattern(vUW.xz * 1.7 + 3.1, uTime * 0.41);
          gl_FragColor.rgb *= 1.0 + ca * 2.2 * exp(-dY * 0.5) * smoothstep(0.0, 0.12, dY);` : ''}
          vec3 trans = exp(-uAbsorb * L);
          gl_FragColor.rgb = gl_FragColor.rgb * trans + uWaterScatter * (1.0 - exp(-0.38 * L));
        }`);
  });
}

// Canopy dapple for surfaces outside the shadow map's reach (it fades in with distance).
export function dapple(mat, { strength = 1 } = {}) {
  worldPos(mat);
  return chain(mat, 'dapple' + strength, (s) => {
    Object.assign(s.uniforms, { uSunDirD: G.uSunDir, uShadowCentre: G.uShadowCentre, uShadowRadius: G.uShadowRadius });
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDirD; uniform vec3 uShadowCentre; uniform float uShadowRadius;
        ${GOBO_GLSL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float far = smoothstep(uShadowRadius * 0.72, uShadowRadius * 0.98, length(vUW.xz - uShadowCentre.xz));
          float gob = mix(1.0, canopyGobo(vUW, uSunDirD, far), ${strength.toFixed(2)});
          reflectedLight.directDiffuse *= gob;
          reflectedLight.directSpecular *= gob;
        }`);
  });
}

// Wind. Every plant vertex carries a sway weight in metres (0 at the trunk, growing along limbs to
// the twigs); the displacement field is a smooth function of rest position, so children stay
// attached to their parents. Leaves add a small high-frequency flutter on top.
export const WIND_GLSL = /* glsl */ `
uniform float uTime; uniform float uWind;
vec3 swayField(vec3 wp, float w) {
  float t = uTime;
  float ph = wp.x * 0.13 + wp.z * 0.17;
  float gust = 0.55 + 0.45 * sin(t * 0.23 + ph * 0.6) * sin(t * 0.11 + 1.7);
  float a = sin(t * 0.85 + ph) * 0.6 + sin(t * 1.9 + ph * 2.3 + wp.y * 0.31) * 0.28 + sin(t * 3.7 + ph * 5.1 + wp.y * 0.9) * 0.08;
  float b = sin(t * 1.25 + ph * 1.7 + 1.3) * 0.5 + sin(t * 2.6 + wp.y * 0.5) * 0.15;
  return vec3(0.85 * a - 0.5 * b * 0.5, -abs(a) * 0.12, 0.5 * a + 0.85 * b * 0.5) * (w * gust * uWind * 0.6);
}
`;

// mode 'attr': per-vertex "aSway" (tubes); 'inst': per-instance "aSway" (x weight, y flutter phase), flutter grows along local +y;
// 'height': weight grows with local height (ground plants).
export function wind(mat, { mode = 'attr', amount = 0.05, flutter = 0.0, depth = false } = {}) {
  return chain(mat, 'wind' + mode + amount + flutter, (s) => {
    Object.assign(s.uniforms, { uTime: G.uTime, uWind: G.uWind });
    const decl = mode === 'attr' ? 'attribute float aSway;' : mode === 'inst' ? 'attribute vec2 aSway;' : '';
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}\n${WIND_GLSL}`)
      .replace('#include <project_vertex>', `
        vec4 mvPosition;
        {
          vec4 wp0 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp0 = instanceMatrix * wp0;
          #endif
          wp0 = modelMatrix * wp0;
          ${mode === 'attr' ? `vec3 off = swayField(wp0.xyz, aSway);` : ''}
          ${mode === 'inst' ? `
            vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vec3 off = swayField(root, aSway.x);
            float fl = ${flutter.toFixed(3)} * uWind * position.y;
            float fp = uTime * (5.0 + aSway.y * 3.0) + aSway.y * 40.0;
            vec3 nrm = normalize((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
            off += nrm * (sin(fp) * 0.6 + sin(fp * 2.3 + 1.0) * 0.4) * fl * length(wp0.xyz - root) * (0.4 + 0.6 * sin(uTime * 0.6 + root.x + aSway.y * 6.0));
          ` : ''}
          ${mode === 'height' ? `
            vec3 root = wp0.xyz;
            #ifdef USE_INSTANCING
              root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            #endif
            float hh = max(wp0.y - root.y, 0.0);
            vec3 off = swayField(root, ${amount.toFixed(3)} * hh * (1.0 + hh));
            off += vec3(sin(uTime * 4.0 + wp0.x * 9.0 + wp0.z * 7.0), 0.0, cos(uTime * 3.3 + wp0.z * 8.0)) * ${flutter.toFixed(3)} * hh * uWind;
          ` : ''}
          wp0.xyz += off;
          mvPosition = viewMatrix * wp0;
          gl_Position = projectionMatrix * mvPosition;
        }
        //PV_END`)
      // later chunks expect "transformed"/worldPosition in local space; keep them consistent for shadows
      .replace('#include <worldpos_vertex>', `
        #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
          vec4 worldPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            worldPosition = instanceMatrix * worldPosition;
          #endif
          worldPosition = modelMatrix * worldPosition;
        #endif`);
  });
}
