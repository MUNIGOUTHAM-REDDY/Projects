// Sky dome (bright haze seen through the canopy), image-based light, and drifting motes.
import * as THREE from 'three';
import { G } from './shaders.js';
import { rng } from './world.js';

export const FOG_COLOR = new THREE.Color(0.085, 0.15, 0.1);

export function createMotes(count = 900) {
  const r = rng(5);
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (r() - 0.5) * 26;
    pos[i * 3 + 1] = 0.3 + r() * 7;
    pos[i * 3 + 2] = -3 + (r() - 0.5) * 30;
    seed[i] = r();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: G.uTime, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float seed; uniform float uTime; uniform float uScale; varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * (0.05 + seed * 0.08);
        p.x += sin(t * 3.0 + seed * 40.0) * 0.6;
        p.y += mod(t * 0.6 + seed * 6.0, 6.0) - 3.0;
        p.z += cos(t * 2.3 + seed * 17.0) * 0.6;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * (1.0 + seed * 2.0) * (5.0 / -mv.z);
        vA = (0.5 + 0.5 * sin(uTime * (0.5 + seed) + seed * 20.0)) * smoothstep(26.0, 3.0, -mv.z) * smoothstep(0.3, 1.2, -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.5;
        gl_FragColor = vec4(vec3(1.0, 0.95, 0.75) * a, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 21;
  return pts;
}

export function createSky({ forEnv = false } = {}) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: G.uSunDir, uFog: { value: FOG_COLOR } },
    vertexShader: /* glsl */ `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform vec3 uFog; varying vec3 vD;
      void main(){
        vec3 d = normalize(vD);
        float y = d.y;
        ${forEnv ? `
        // Lighting environment: sky light filtered green by the canopy above, dim warm ground below,
        // a brighter band toward the open river corridor.
        vec3 up = vec3(0.50, 0.66, 0.44) * 0.9;
        vec3 side = vec3(0.30, 0.42, 0.24) * 0.55;
        vec3 down = vec3(0.10, 0.09, 0.05) * 0.5;
        vec3 c = mix(side, up, smoothstep(0.0, 0.8, y));
        c = mix(c, down, smoothstep(0.05, -0.35, y));
        c += vec3(0.9, 0.95, 1.0) * 0.5 * smoothstep(0.55, 1.0, y);
        ` : `
        vec3 zen = vec3(0.24, 0.45, 1.0) * 0.6;
        vec3 haze = vec3(0.62, 0.8, 0.9) * 0.62;
        vec3 c = mix(haze, zen, smoothstep(0.05, 0.9, y));
        // the forest closes in at the horizon: a soft wall of distant crowns, darker toward the ground
        float az = atan(d.z, d.x);
        float top = 0.3 + 0.05 * sin(az * 7.0) + 0.035 * sin(az * 19.0 + 1.3) + 0.02 * sin(az * 43.0 + 0.7);
        vec3 wall = mix(uFog * 0.7, uFog * 2.2 + vec3(0.02, 0.05, 0.01), smoothstep(-0.02, top, y));
        c = mix(wall, c, smoothstep(top - 0.05, top + 0.06, y));
        float s = max(dot(d, normalize(uSun)), 0.0);
        c += vec3(1.0, 0.9, 0.68) * (pow(s, 10.0) * 0.55 + pow(s, 400.0) * 60.0);
        `}
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}
