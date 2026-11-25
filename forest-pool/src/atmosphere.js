// Soft sun shafts through the canopy and drifting motes of pollen.
import * as THREE from 'three';
import { G } from './shaders.js';
import { rng } from './world.js';

export function createShafts() {
  const group = new THREE.Group();
  const r = rng(8);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: G.uTime, uStrength: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying float vFade; varying vec3 vWP;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vec3 toCam = normalize(cameraPosition - wp.xyz);
        vec3 axis = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vFade = 1.0 - abs(dot(toCam, axis)); // shafts seen end-on fade out
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uStrength;
      varying vec2 vUv; varying float vFade; varying vec3 vWP;
      void main() {
        float edge = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
        float len = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
        float flick = 0.75 + 0.25 * sin(uTime * 0.3 + vWP.x * 0.7 + vWP.z * 0.4);
        float a = edge * edge * len * flick * vFade * 0.12 * uStrength;
        gl_FragColor = vec4(vec3(1.0, 0.96, 0.78) * a, 1.0);
      }`,
  });
  const sun = G.uSunDir.value.clone();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sun);
  const spots = [
    [-0.5, -4, 3.5], [2.2, -6.5, 2.5], [-3.5, -6, 2.8], [0.8, -1.5, 2.2], [4.5, -3, 2.0], [-2.0, 0.5, 1.8],
    [1.5, -10, 3.0], [-5.5, -9, 3.0], [6.5, -8, 2.6],
  ];
  for (const [x, z, w] of spots) {
    const L = 16 + r() * 6;
    const geo = new THREE.PlaneGeometry(w, L, 1, 1);
    geo.translate(0, L / 2, 0);
    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, 0, z);
      m.quaternion.copy(q);
      m.rotateY(k * Math.PI / 2 + r());
      m.renderOrder = 20;
      group.add(m);
    }
  }
  group.userData.material = mat;
  return group;
}

export function createMotes(count = 900) {
  const r = rng(5);
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = -0.4 + (r() - 0.5) * 18;
    pos[i * 3 + 1] = 0.3 + r() * 6;
    pos[i * 3 + 2] = -1 + (r() - 0.5) * 16;
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
        gl_PointSize = uScale * (1.5 + seed * 2.5) * (6.0 / -mv.z);
        vA = (0.4 + 0.6 * sin(uTime * (0.5 + seed) + seed * 20.0) * 0.5 + 0.3) * smoothstep(30.0, 4.0, -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.6;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.8) * a, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 21;
  return pts;
}

// Sky dome: bright light filtering through distant canopy, darker foliage masses near the horizon.
export function createSky({ forEnv = false } = {}) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: G.uSunDir },
    vertexShader: /* glsl */ `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; varying vec3 vD;
      float h(vec3 p){ p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i), h(i+vec3(1,0,0)), f.x), mix(h(i+vec3(0,1,0)), h(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i+vec3(0,0,1)), h(i+vec3(1,0,1)), f.x), mix(h(i+vec3(0,1,1)), h(i+vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        vec3 d = normalize(vD);
        float y = d.y;
        // Dense foliage everywhere, with small bright holes of sky-lit leaves.
        vec3 dark = vec3(0.045, 0.085, 0.025);
        vec3 lit = vec3(0.55, 0.78, 0.22);
        float f = n3(d * 11.0) * 0.55 + n3(d * 29.0) * 0.3 + n3(d * 61.0) * 0.15;
        float holes = smoothstep(0.55, 0.8, f) * smoothstep(-0.1, 0.4, y);
        vec3 c = mix(dark, lit, holes);
        c = mix(c, vec3(0.13, 0.2, 0.07), smoothstep(0.15, -0.05, y));
        c += vec3(1.1, 1.15, 0.8) * smoothstep(0.75, 0.9, f) * smoothstep(0.3, 0.8, y);
        c += vec3(1.0, 0.95, 0.75) * pow(max(dot(d, normalize(uSun)), 0.0), 18.0) * 1.5;
        ${forEnv ? `
        // Smooth, averaged version for lighting: bright filtered canopy above, dark green below.
        c = mix(vec3(0.11, 0.13, 0.08), vec3(0.8, 0.86, 0.68), smoothstep(-0.2, 0.9, y));` : ''}
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}
