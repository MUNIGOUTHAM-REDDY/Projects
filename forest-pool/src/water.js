// River surface: a ribbon following the channel. Planar reflection (Reflector), screen-space
// refraction of the already-rendered riverbed, flow-mapped ripples that follow the current,
// foam around boulders and over the riffles, and sun glints that respect the canopy's shadow.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RIVER_SAMPLES, WATER_Y, LEDGES } from './world.js';
import { G, NOISE_GLSL, GOBO_GLSL } from './shaders.js';
import { tex, A } from './textures.js';

const WaterShader = {
  name: 'RiverWater',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    attribute vec2 aSD; attribute vec2 aT;
    varying vec4 vUv;
    varying vec3 vW;
    varying vec2 vSD; varying vec2 vT;
    uniform sampler2D tBake; uniform vec4 uBake; uniform float uTime;
    uniform float uLedges[6];
    void main() {
      vSD = aSD; vT = aT;
      vUv = textureMatrix * vec4(position, 1.0);
      vec3 pos = position;
      vec3 w0 = (modelMatrix * vec4(position, 1.0)).xyz;
      // standing waves and haystacks where the stream breaks over ledges and round boulders: real geometry, a few centimetres high
      vec4 bk = texture2D(tBake, (w0.xz - uBake.xy) * uBake.z);
      float k = clamp(bk.a, 0.0, 1.0) * smoothstep(0.3, 1.0, length(bk.gb)) * smoothstep(0.04, 0.22, -bk.r);
      pos.z += k * (0.075 * sin(aSD.y * 3.6 + sin(aSD.x * 2.3) * 1.5) + 0.025 * sin(aSD.x * 5.1 + aSD.y * 1.7 + uTime * 0.6) + 0.02);
      // water backs up a few centimetres behind each cobble ledge and drops over it
      for (int i = 0; i < 6; i++) { float ds = aSD.y - uLedges[i]; pos.z += 0.05 * smoothstep(-7.0, -0.6, ds) * (1.0 - smoothstep(-0.3, 0.8, ds)) * smoothstep(0.02, 0.15, -bk.r); }
      vW = (modelMatrix * vec4(pos, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tRefr, tBake, tWaterN, tFoam, uShadowMap;
    uniform float uLedges[6];
    uniform mat4 uShadowMatrix;
    uniform vec4 uBake;
    uniform vec2 uRes;
    uniform float uTime, uShadowOn;
    uniform vec3 uSunDir, uSunColor, uShadowCentre;
    uniform float uShadowRadius;
    varying vec4 vUv;
    varying vec3 vW;
    varying vec2 vSD; varying vec2 vT;
    #include <common>
    #include <packing>
    ${NOISE_GLSL}
    ${GOBO_GLSL}
    float sunVis(vec3 wp) {
      float far = smoothstep(uShadowRadius * 0.72, uShadowRadius * 0.98, length(wp.xz - uShadowCentre.xz));
      float g = canopyGobo(wp, uSunDir, far);
      vec4 sc = uShadowMatrix * vec4(wp, 1.0); sc.xyz /= sc.w;
      if (uShadowOn < 0.5 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return g;
      float s = 0.0;
      vec2 px = vec2(1.0 / 2048.0);
      s += step(sc.z - 0.0015, unpackRGBAToDepth(texture2D(uShadowMap, sc.xy + px * vec2(-0.6, -0.4))));
      s += step(sc.z - 0.0015, unpackRGBAToDepth(texture2D(uShadowMap, sc.xy + px * vec2(0.6, -0.5))));
      s += step(sc.z - 0.0015, unpackRGBAToDepth(texture2D(uShadowMap, sc.xy + px * vec2(-0.3, 0.6))));
      s += step(sc.z - 0.0015, unpackRGBAToDepth(texture2D(uShadowMap, sc.xy + px * vec2(0.5, 0.5))));
      return s * 0.25 * g;
    }
    // Ripples live in streamline coordinates (across, along the channel), so they are stretched
    // along the current. Two copies slide downstream and cross-fade as they shear.
    vec3 flowNormal(vec2 q, vec2 fl, vec2 scale, float period, float offs) {
      float t = uTime / period + offs;
      float p0 = fract(t), p1 = fract(t + 0.5);
      vec2 f = fl * period * scale;
      vec3 a = texture2D(tWaterN, q * scale - f * (p0 - 0.5) + vec2(0.13, 0.71) * floor(t)).xyz * 2.0 - 1.0;
      vec3 b = texture2D(tWaterN, q * scale - f * (p1 - 0.5) + vec2(0.57, 0.29) * floor(t + 0.5) + 0.37).xyz * 2.0 - 1.0;
      return mix(a, b, abs(1.0 - 2.0 * p0));
    }
    vec3 flowTex(sampler2D tx, vec2 q, vec2 fl, vec2 scale, float period) {
      float t = uTime / period;
      float p0 = fract(t), p1 = fract(t + 0.5);
      vec2 f = fl * period * scale;
      vec3 a = texture2D(tx, q * scale - f * (p0 - 0.5) + vec2(0.31, 0.17) * floor(t)).rgb;
      vec3 b = texture2D(tx, q * scale - f * (p1 - 0.5) + vec2(0.77, 0.53) * floor(t + 0.5) + 0.5).rgb;
      return mix(a, b, abs(1.0 - 2.0 * p0));
    }
    void main() {
      vec2 p = vW.xz;
      vec4 bk = texture2D(tBake, (p - uBake.xy) * uBake.z);
      float depth = -bk.r;
      if (depth < -0.2) discard;
      vec2 flow = bk.gb;
      float speed = length(flow);
      float foamK = bk.a;
      vec3 V = normalize(cameraPosition - vW);
      float dist = length(cameraPosition - vW);
      vec2 T = normalize(vT), Nl = vec2(-T.y, T.x);
      vec2 fl = vec2(dot(flow, Nl), dot(flow, T));         // flow in (across, along)
      vec2 q = vSD;

      // long glassy swells, finer chop where the water runs fast and shallow, a breath of wind
      fl = fl * min(1.0, 0.2 / max(length(fl), 1e-3));        // cap the shear so fast water does not smear
      vec3 n1 = flowNormal(q, fl, vec2(0.5, 0.32), 1.8, 0.0);
      vec3 n2 = flowNormal(q, fl, vec2(1.5, 1.3), 1.3, 0.3);
      vec3 n4 = flowNormal(q, fl, vec2(3.4, 3.4), 0.8, 0.6);
      vec3 n3 = texture2D(tWaterN, p * 0.19 + uTime * vec2(0.013, 0.009)).xyz * 2.0 - 1.0;
      float fast = smoothstep(0.15, 1.15, speed);
      float chop = 0.17 + 0.6 * fast + 0.6 * clamp(foamK, 0.0, 1.0);
      chop *= smoothstep(0.0, 0.08, depth) * 0.75 + 0.25;
      // pools carry only a slow swell; chop belongs to the riffles
      vec2 nq = (n1.xy * 1.0 + n2.xy * (0.12 + 0.5 * fast) + n4.xy * (0.3 * fast * fast)) * chop;
      // crests run with the flow, but never more than 2:1
      // standing waves: stationary crests across the current below rocks and ledges
      nq.y += cos(q.y * 3.6 + sin(q.x * 2.3) * 1.5) * clamp(foamK, 0.0, 1.0) * 0.3 * smoothstep(0.3, 1.0, speed);
      vec3 n5 = texture2D(tWaterN, p * 0.83 + uTime * vec2(-0.021, 0.034)).xyz * 2.0 - 1.0;   // round wind ripple
      // equal slope across and along the current, so sun glitter breaks into short flecks instead of long streaks
      vec2 nxy = Nl * nq.x * 0.5 + T * nq.y * 0.9 + n3.xy * 0.03 + n5.xy * (0.1 + 0.42 * chop);
      nxy *= 1.0 / (1.0 + dist * 0.045);                    // tame sparkle aliasing far away
      vec3 n = normalize(vec3(nxy.x, 1.0, nxy.y));

      float cosT = clamp(dot(V, n), 0.0, 1.0);
      // forest water under a dark canopy mirrors more than bare Fresnel suggests: trunks and banks cut across the turquoise
      float F = clamp(0.07 + 0.93 * pow(1.0 - cosT, 3.6), 0.0, 1.0);

      // refraction of the bed, bent more where the water is deeper
      vec2 suv = gl_FragCoord.xy / uRes;
      float bend = clamp(depth * 1.6, 0.0, 1.0) / (1.0 + dist * 0.12);
      vec3 refr = texture2D(tRefr, suv + n.xz * 0.05 * bend).rgb;

      vec3 refl = texture2D(tDiffuse, vUv.xy / vUv.w + n.xz * 0.075).rgb;
      refl = min(refl, vec3(6.0));

      float vis = sunVis(vW);
      vec3 col = mix(refr, refl, F);

      // sun glitter
      vec3 H = normalize(uSunDir + V);
      float nh = max(dot(n, H), 0.0);
      float spec = pow(nh, 900.0) * 14.0 + pow(nh, 120.0) * 0.35;
      // at a grazing view glints stretch toward the viewer; a fine round mask breaks them into flecks
      spec *= smoothstep(0.38, 0.62, vnoise(p * 17.0 + uTime * vec2(0.9, -0.6))) * 1.5;
      col += uSunColor * spec * vis * (0.04 + 0.96 * F) * 2.5;

      // foam: lacy cells that drift with the flow, densest right against the rocks
      vec3 ft = flowTex(tFoam, q, fl, vec2(1.1, 0.55), 2.2);        // foam cells at most 2:1 along the current
      vec3 ft2 = flowTex(tFoam, q + 3.7, fl, vec2(3.0, 1.5), 1.4);
      // drifting bubble lines: long threads of foam carried down the fastest water
      vec3 ft3 = flowTex(tFoam, q + 1.3, fl, vec2(1.6, 0.8), 2.6);
      float threads = smoothstep(0.7, 0.9, ft3.b * 0.6 + ft3.r * 0.55) * (0.7 * clamp(foamK, 0.0, 1.0)) * ft2.g;
      float lace = ft.r * 0.75 + ft2.r * 0.5 + ft2.g * 0.3;
      float fk = clamp(foamK, 0.0, 1.2);
      // never a solid sheet: even the heaviest white water stays broken into lace and streaks
      float th = max(0.46, 1.1 - fk * 0.7);
      th = max(th, 0.52);
      float foam = smoothstep(th, th + 0.35, lace + fk * 0.1) * (0.35 + 0.65 * ft2.g) * (0.4 + 0.6 * ft.b) * smoothstep(0.02, 0.3, fk);
      // white caps break on the crests of the standing waves
      float crest = sin(q.y * 3.6 + sin(q.x * 2.3) * 1.5);
      foam += smoothstep(0.45, 0.95, crest) * clamp(foamK, 0.0, 1.0) * smoothstep(0.3, 1.0, speed) * (0.35 + 0.65 * ft2.r) * 0.9;
      // a broken white tongue where the water spills off each ledge
      for (int i = 0; i < 6; i++) { float ds = q.y - uLedges[i] + 0.5 * (ft.b - 0.5); foam += exp(-(ds - 0.9) * (ds - 0.9) / 0.5) * smoothstep(0.5, 0.95, ft.r * 0.6 + ft2.r * 0.55 + ft2.g * 0.25) * 0.85; }
      foam *= smoothstep(0.03, 0.16, depth);               // no foam film over bare gravel
      // a thin lapping edge along the shore
      float shore = smoothstep(0.06, 0.015, depth) * smoothstep(0.0, 0.015, depth) * ft2.g * ft.r * 0.6;
      foam = clamp(foam + threads * 0.6 * smoothstep(0.03, 0.16, depth) + shore, 0.0, 0.7);
      vec3 foamCol = vec3(0.86, 0.9, 0.86) * (uSunColor * vis * 0.75 + vec3(0.2, 0.26, 0.2));
      col = mix(col, foamCol, foam);

      float alpha = smoothstep(-0.015, 0.03, depth);
      gl_FragColor = vec4(col, alpha);
    }`,
};

function ribbonGeometry() {
  const { n, xs, zs, ws, tx, tz, ss } = RIVER_SAMPLES;
  const pos = [], idx = [], sd = [], tt = [];
  const ACROSS = 14;
  let c = 0;
  for (let i = 0; i < n; i++) {
    // dense where people look (0.5 m stations), coarse far up- and downstream
    const near = Math.hypot(xs[i] + 1, zs[i] + 5) < 45;
    if (!near && i % 4 !== 0) continue;
    const w = ws[i] + 4.5;
    for (let k = 0; k <= ACROSS; k++) {
      const d = -w + (2 * w * k) / ACROSS;
      // Reflector expects a plane in local XY facing +Z; it is laid flat by rotating -90 deg about X.
      pos.push(xs[i] - tz[i] * d, -(zs[i] + tx[i] * d), 0);
      sd.push(d, ss[i]); tt.push(tx[i], tz[i]);
    }
    if (c > 0) for (let k = 0; k < ACROSS; k++) { const a0 = (c - 1) * (ACROSS + 1) + k, b0 = a0 + ACROSS + 1; idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
    c++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSD', new THREE.Float32BufferAttribute(sd, 2));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createWater(quality, sun) {
  const res = quality === 'low' ? 512 : 1024;
  const water = new Reflector(ribbonGeometry(), {
    shader: WaterShader, textureWidth: res, textureHeight: res, clipBias: 0.02, multisample: 0, type: THREE.HalfFloatType,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  const m = water.material;
  m.side = THREE.DoubleSide;
  m.transparent = true;
  m.depthWrite = false;
  Object.assign(m.uniforms, {
    uLedges: { value: LEDGES.map((l) => l.s) }, tRefr: { value: null }, tBake: G.tBake, uBake: G.uBake, uRes: { value: new THREE.Vector2(1, 1) },
    tWaterN: { value: tex(A('water_n.jpg'), { srgb: false }) }, tFoam: { value: tex(A('foam.jpg'), { srgb: false }) },
    uTime: G.uTime, uSunDir: G.uSunDir, uSunColor: { value: new THREE.Color(1, 0.95, 0.85).multiplyScalar(4) },
    uShadowMap: { value: null }, uShadowMatrix: { value: sun.shadow.matrix }, uShadowOn: { value: 0 },
    uShadowCentre: G.uShadowCentre, uShadowRadius: G.uShadowRadius,
  });
  water.layers.set(1);
  water.frustumCulled = false;
  water.userData.sun = sun;
  return water;
}

// Hide objects that should not appear in (or would be too costly to draw into) the reflection,
// and draw only a fraction of the instanced foliage there.
export function excludeFromReflection(water, objects, thinned = []) {
  const orig = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    // lists may hold arrays that fill in as models finish loading
    const list = objects.flat();
    const vis = list.map((o) => o.visible);
    list.forEach((o) => (o.visible = false));
    thinned.forEach((m) => (m.count = Math.floor(m.userData.liveCount * m.userData.mirrorFrac)));
    orig.apply(this, args);
    thinned.forEach((m) => (m.count = m.userData.liveCount));
    list.forEach((o, i) => (o.visible = vis[i]));
  };
}
