// Frame pipeline:
//   scene (no water) -> HDR colour + depth
//   GTAO from depth, multiplied in
//   river surface on top (refracts the colour buffer, reflects via its own mirror pass)
//   volumetric sunlight ray-marched through the sun's shadow map (half resolution)
//   depth of field + composite -> bloom -> tone map -> FXAA -> grade / vignette / grain
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { G, NOISE_GLSL, GOBO_GLSL } from './shaders.js';

const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const VolumetricShader = {
  uniforms: {
    tDepth: { value: null }, uShadowMap: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 },
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uSunDir: G.uSunDir, uTime: G.uTime, uStrength: { value: 1 }, uShadowCentre: G.uShadowCentre, uShadowRadius: G.uShadowRadius,
    uSeed: { value: 0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <packing>
    uniform sampler2D tDepth, uShadowMap;
    uniform mat4 uShadowMatrix, uProjInv, uCamWorld;
    uniform vec3 uSunDir, uShadowCentre; uniform float uTime, uStrength, uShadowOn, uShadowRadius, uSeed;
    varying vec2 vUv;
    ${NOISE_GLSL}
    ${GOBO_GLSL}
    float sunVis(vec3 wp) {
      float far = smoothstep(uShadowRadius * 0.72, uShadowRadius * 0.98, length(wp.xz - uShadowCentre.xz));
      float g = canopyGobo(wp, uSunDir, far);
      // individual holes in the high canopy: narrow, well-separated beams rather than an even veil
      vec2 pc = wp.xz + uSunDir.xz / max(uSunDir.y, 0.2) * (16.0 - wp.y);
      float holes = vnoise(pc * 0.75 + 5.0) * 0.6 + vnoise(pc * 1.9 - 2.0) * 0.4;
      g *= 0.1 + 3.2 * smoothstep(0.6, 0.69, holes);
      vec4 sc = uShadowMatrix * vec4(wp, 1.0); sc.xyz /= sc.w;
      if (uShadowOn < 0.5 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return g;
      return step(sc.z - 0.001, unpackRGBAToDepth(texture2D(uShadowMap, sc.xy))) * g;
    }
    void main() {
      float d = texture2D(tDepth, vUv).x;
      vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 vp = uProjInv * clip; vp /= vp.w;
      vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
      vec3 ro = (uCamWorld * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 rd = wp - ro;
      float len = min(length(rd), 46.0);
      rd = normalize(rd);
      const int N = 36;
      float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uSeed * 17.0, vec2(0.06711056, 0.00583715))));
      float acc = 0.0;
      float dt = len / float(N);
      for (int i = 0; i < N; i++) {
        float t = (float(i) + jit) * dt;
        vec3 p = ro + rd * t;
        if (p.y < 0.0) break;
        // thin ground mist, thicker over the water and low down
        float dens = (0.3 + 0.7 * exp(-max(p.y, 0.0) * 0.14)) * (0.75 + 0.5 * vnoise(p.xz * 0.21 + uTime * 0.03 + p.y * 0.3));
        acc += sunVis(p) * dens * dt * exp(-t * 0.05);
      }
      float mu = dot(rd, uSunDir);
      float g = 0.85;
      float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.25 + 0.1;
      phase = min(phase, 2.6);                          // looking straight into the sun must not white out the crown
      // against open sky the glow stays near-white and restrained, so it never turns the blue green
      vec3 col = (d >= 1.0 ? vec3(1.0, 0.97, 0.9) * 0.6 : vec3(1.0, 0.88, 0.62)) * acc * phase * 0.026 * uStrength;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const CompositeShader = {
  uniforms: {
    tColor: { value: null }, tDepth: { value: null }, tVol: { value: null },
    uRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 400 },
    uFocus: { value: 8 }, uAperture: { value: 1 }, uDof: { value: 1 }, uVolOn: { value: 1 },
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uSunDir: G.uSunDir, uMist: { value: 1 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <packing>
    uniform sampler2D tColor, tDepth, tVol;
    uniform vec2 uRes; uniform float uNear, uFar, uFocus, uAperture, uDof, uVolOn, uMist;
    uniform mat4 uProjInv, uCamWorld; uniform vec3 uSunDir;
    varying vec2 vUv;
    float viewZ(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    float coc(float z){
      // thin-lens-like: sharp around the focus distance, soft far background and very near foreground
      float c = abs(1.0 / uFocus - 1.0 / max(z, 0.1)) * uFocus;
      if (z < uFocus) c *= 0.3;                      // keep the foreground readable; only very close things soften
      return clamp(c * 0.42 - 0.2, 0.0, 0.7) * uAperture;
    }
    void main() {
      vec3 col = texture2D(tColor, vUv).rgb;
      if (uDof > 0.5) {
        float z0 = viewZ(vUv);
        float c0 = coc(z0);
        float maxR = uRes.y * 0.0055;
        vec3 acc = col; float wsum = 1.0;
        const float GA = 2.39996323;
        for (int i = 1; i <= 22; i++) {
          float fi = float(i);
          float r = sqrt(fi / 22.0);
          vec2 o = vec2(cos(fi * GA), sin(fi * GA)) * r * maxR / uRes;
          vec2 uv = vUv + o * max(c0, 0.2);
          float zs = viewZ(uv);
          float cs = coc(zs);
          // a sample contributes if its own blur reaches this pixel, or it lies behind a blurred pixel
          float w = clamp(max(cs, c0 * step(z0, zs + 0.05)) * 3.0 - r * 1.5, 0.0, 1.0);
          acc += texture2D(tColor, uv).rgb * w; wsum += w;
        }
        col = acc / wsum;
      }
      // Low mist: cool, pooled near the ground and over the water, thickening with distance; it warms toward the sun.
      float dz = texture2D(tDepth, vUv).x;
      if (dz < 1.0) {
        vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0); vp /= vp.w;
        vec3 ro = (uCamWorld * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 rd = (uCamWorld * vec4(vp.xyz, 1.0)).xyz - ro;
        float t = length(rd); rd /= t;
        float b = 0.3;
        float ry = abs(rd.y) < 1e-3 ? 1e-3 : rd.y;
        float od = 0.013 * exp(-b * max(ro.y, 0.0)) * (1.0 - exp(-b * ry * t)) / (b * ry);
        float f = (1.0 - exp(-max(od, 0.0))) * uMist;
        float mu = max(dot(rd, uSunDir), 0.0);
        vec3 mist = vec3(0.17, 0.26, 0.24) + vec3(0.32, 0.25, 0.12) * pow(mu, 3.0);
        col = mix(col, mist, clamp(f, 0.0, 0.75));
      }
      if (uVolOn > 0.5) {
        vec2 px = 1.0 / uRes;
        vec3 v = texture2D(tVol, vUv).rgb * 0.4;
        v += texture2D(tVol, vUv + px * vec2(1.6, 0.8)).rgb * 0.15;
        v += texture2D(tVol, vUv + px * vec2(-1.6, -0.8)).rgb * 0.15;
        v += texture2D(tVol, vUv + px * vec2(0.8, -1.6)).rgb * 0.15;
        v += texture2D(tVol, vUv + px * vec2(-0.8, 1.6)).rgb * 0.15;
        col += v;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.34 }, uSat: { value: 1.0 }, uGrain: { value: 0.035 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVig, uSat, uGrain, uTime; varying vec2 vUv;
    float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // filmic toe/shoulder, then a gentle split tone: cool green-teal shadows, warm highlights
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.38);
      c = mix(vec3(l), c, uSat);
      c += vec3(-0.016, 0.004, 0.016) * (1.0 - smoothstep(0.0, 0.45, l));
      c *= mix(vec3(1.0), vec3(1.035, 1.005, 0.95), smoothstep(0.5, 1.0, l));
      // rein in neon yellow-greens: pull strongly saturated greens toward a deeper, bluer leaf green
      float gExc = max(c.g - max(c.r, c.b), 0.0);
      c.r -= gExc * 0.10; c.g -= gExc * 0.06;
      vec2 d = vUv - 0.5;
      float v = dot(d, d);
      c *= 1.0 - uVig * v * 1.9 - uVig * v * v * 2.0;
      float g = h(gl_FragCoord.xy + fract(uTime) * 91.7) + h(gl_FragCoord.xy * 1.31 + 7.0 + fract(uTime * 1.7) * 53.0) - 1.0;
      c += g * uGrain * (0.5 + 0.9 * (1.0 - l));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

class ScenePass extends Pass {
  constructor(renderer, scene, camera, water, sun, quality) {
    super();
    this.scene = scene; this.camera = camera; this.water = water; this.sun = sun; this.quality = quality;
    const depth = () => { const d = new THREE.DepthTexture(1, 1); d.type = THREE.UnsignedIntType; d.format = THREE.DepthFormat; d.minFilter = d.magFilter = THREE.NearestFilter; return d; };
    this.depthTexture = depth();
    const opt = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtScene = new THREE.WebGLRenderTarget(1, 1, { ...opt, depthTexture: this.depthTexture });
    this.rtComp = new THREE.WebGLRenderTarget(1, 1, { ...opt, depthTexture: this.depthTexture });
    this.rtVol = new THREE.WebGLRenderTarget(1, 1, { ...opt, depthBuffer: false });
    this.aoScale = quality === 'low' ? 0.5 : 1;
    this.gtao = new GTAOPass(scene, camera, 4, 4);
    this.gtao.setGBuffer(this.depthTexture, undefined);
    this.gtao.normalRenderTarget.dispose();
    this.gtao.normalRenderTarget = { setSize() {}, dispose() {} };
    this.gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: quality === 'low' ? 8 : 16, distanceFallOff: 1, screenSpaceRadius: false });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1.5, rings: 2, samples: quality === 'low' ? 8 : 16 });
    this.gtao.blendIntensity = 1.0;
    this.volMat = new THREE.ShaderMaterial(VolumetricShader);
    this.compMat = new THREE.ShaderMaterial(CompositeShader);
    this.copyMat = new THREE.ShaderMaterial({ uniforms: { t: { value: null } }, vertexShader: FS_VERT, fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }', depthTest: false, depthWrite: false });
    for (const m of [this.volMat, this.compMat]) { m.depthTest = false; m.depthWrite = false; }
    this.fsq = new FullScreenQuad(this.volMat);
    this.ao = true; this.volumetrics = true; this.dof = quality !== 'low';
    this.needsSwap = true;
    this.frame = 0;
  }
  setSize(w, h) {
    this.rtScene.setSize(w, h); this.rtComp.setSize(w, h);
    this.rtVol.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.gtao.setSize(Math.ceil(w * this.aoScale), Math.ceil(h * this.aoScale));
    this.compMat.uniforms.uRes.value.set(w, h);
    this.water.material.uniforms.uRes.value.set(w, h);
  }
  render(renderer, writeBuffer) {
    const { scene, camera, water, sun } = this;
    const oldAuto = renderer.autoClear;
    if (this.still || (this.frame2 = (this.frame2 || 0) + 1) % 2 === 1) renderer.shadowMap.needsUpdate = true;
    camera.layers.set(0);
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rtScene);
    renderer.render(scene, camera);
    const shadowTex = sun.shadow.map ? sun.shadow.map.texture : null;

    // ambient occlusion -> rtComp (shares the depth buffer, so the water can depth-test against the scene)
    if (this.ao) this.gtao.render(renderer, this.rtComp, this.rtScene);
    else { this.copyMat.uniforms.t.value = this.rtScene.texture; this.fsq.material = this.copyMat; renderer.setRenderTarget(this.rtComp); this.fsq.render(renderer); }

    // river surface
    const wu = water.material.uniforms;
    wu.tRefr.value = this.rtScene.texture;
    wu.uShadowMap.value = shadowTex; wu.uShadowOn.value = shadowTex ? 1 : 0;
    camera.layers.set(1);
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rtComp);
    renderer.render(scene, camera);
    camera.layers.set(0);

    // volumetric sunlight
    if (this.volumetrics) {
      const u = this.volMat.uniforms;
      u.tDepth.value = this.depthTexture;
      u.uShadowMap.value = shadowTex; u.uShadowOn.value = shadowTex ? 1 : 0;
      u.uShadowMatrix.value.copy(sun.shadow.matrix);
      u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uSeed.value = this.still ? 0 : (this.frame++ % 8);
      this.fsq.material = this.volMat;
      renderer.setRenderTarget(this.rtVol);
      this.fsq.render(renderer);
    }

    const c = this.compMat.uniforms;
    c.tColor.value = this.rtComp.texture; c.tDepth.value = this.depthTexture; c.tVol.value = this.rtVol.texture;
    c.uNear.value = camera.near; c.uFar.value = camera.far;
    c.uProjInv.value.copy(camera.projectionMatrixInverse); c.uCamWorld.value.copy(camera.matrixWorld);
    c.uDof.value = this.dof ? 1 : 0; c.uVolOn.value = this.volumetrics ? 1 : 0;
    this.fsq.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);
    renderer.autoClear = oldAuto;
  }
}

export function createPipeline({ renderer, scene, camera, water, sun, quality, still }) {
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const scenePass = new ScenePass(renderer, scene, camera, water, sun, quality);
  scenePass.still = still;
  composer.addPass(scenePass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.18, 0.4, 0.95);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(fxaa);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  renderer.shadowMap.autoUpdate = false;
  return {
    composer, scenePass, bloom, grade,
    setSize(w, h) {
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    },
    render(dt, time) {
      grade.uniforms.uTime.value = still ? 0.37 : time;
      composer.render(dt);
    },
  };
}
