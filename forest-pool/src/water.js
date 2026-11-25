// Pool surface: a planar mirror (Reflector) with a custom shader that adds ripples,
// Fresnel reflectance and a sun glint. Depth colour comes from the underwater patch
// applied to everything beneath the surface.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { POOL, WATER_Y } from './world.js';
import { G } from './shaders.js';

const WaterShader = {
  name: 'PoolWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3() },
    uTint: { value: new THREE.Color(0.1, 0.55, 0.55) },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vW;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uSunDir;
    uniform vec3 uTint;
    varying vec4 vUv;
    varying vec3 vW;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
    float hgt(vec2 p) {
      float t = uTime;
      float h = 0.0;
      h += vn(p * 1.3 + vec2(t * 0.18, t * 0.05)) * 0.5;
      h += vn(p * 2.9 - vec2(t * 0.11, t * 0.21)) * 0.25;
      h += vn(p * 6.1 + vec2(t * 0.31, -t * 0.17)) * 0.12;
      h += sin(dot(p, vec2(0.8, 0.6)) * 4.0 - t * 1.1) * 0.025;
      return h;
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec2 p = vW.xz;
      float e = 0.03;
      float h0 = hgt(p);
      vec2 grad = vec2(hgt(p + vec2(e, 0.0)) - h0, hgt(p + vec2(0.0, e)) - h0) / e;
      vec3 n = normalize(vec3(-grad.x * 0.035, 1.0, -grad.y * 0.035));
      vec3 V = normalize(cameraPosition - vW);
      float dist = length(cameraPosition - vW);
      vec2 ruv = vUv.xy / vUv.w + n.xz * 0.06 / max(1.0, dist * 0.15);
      vec3 refl = texture2D(tDiffuse, ruv).rgb;
      float cosT = clamp(dot(V, n), 0.0, 1.0);
      float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      // Calm forest water reads as more reflective than pure Fresnel; keep near-view see-through.
      float R = clamp(F * 1.6 + 0.22, 0.0, 0.95) * mix(0.45, 1.0, smoothstep(2.5, 8.0, dist));
      vec3 tint = mix(vec3(0.62, 0.85, 0.75), vec3(0.10, 0.45, 0.55), smoothstep(3.0, 12.0, dist)) * 0.75;
      vec3 col = refl * tint;
      vec3 H = normalize(uSunDir + V);
      float spec = pow(max(dot(n, H), 0.0), 600.0) * 6.0;
      gl_FragColor = vec4(col + spec * vec3(1.0, 0.95, 0.8), R + spec * 0.5);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export function createWater(quality) {
  const w = POOL.rx * 2.8, d = POOL.rz * 2.8;
  const geo = new THREE.PlaneGeometry(w, d, 1, 1);
  const res = quality === 'low' ? 512 : 1024;
  const water = new Reflector(geo, {
    shader: WaterShader,
    textureWidth: res,
    textureHeight: res,
    clipBias: 0.003,
    multisample: quality === 'low' ? 0 : 4,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.set(POOL.cx, WATER_Y, POOL.cz);
  water.material.transparent = true;
  water.material.depthWrite = false;
  water.material.uniforms.uTime = G.uTime;
  water.material.uniforms.uSunDir = G.uSunDir;
  water.renderOrder = 10;
  return water;
}

// Hide objects that should not appear in (or would be too costly to draw into) the reflection.
export function excludeFromReflection(water, objects) {
  const orig = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    const vis = objects.map((o) => o.visible);
    objects.forEach((o) => (o.visible = false));
    orig.apply(this, args);
    objects.forEach((o, i) => (o.visible = vis[i]));
  };
}
