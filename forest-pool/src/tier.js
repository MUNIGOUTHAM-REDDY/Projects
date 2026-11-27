// Quality tiers. Everything that scales with the device lives here: how far detail reaches, how much of it
// exists, what the frame pipeline does. Desktop defaults to "high", touch devices to "mobile".
const params = new URLSearchParams(location.search);
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
export const QUALITY = params.get('q') || (IS_TOUCH ? 'mobile' : 'high');

const TIERS = {
  high: {
    pixelRatio: 1.25, prMin: 0.85, shadowSize: 2048, shadowHalf: 30, shadowEvery: 6, mirrorSize: 512, mirrorEvery: 1,   // mirror: every (2 x mirrorEvery)th frame
    ao: true, volumetric: 20, bloom: true, fxaa: true, dof: true, halfTextures: false,
    dist: 1.0,            // multiplier on every LOD distance
    count: 1.0,           // multiplier on how many small things exist
    heroLeaves: 0.5, leafScaleCap: 1.5, realUnderstory: true, terrain: [256, 160, 64], farTrees: 1.0, fernBig: 0.08,
    woodDetail: 1, twigs: 0.25, branches: 0.35, sprayRadius: 30, cellScale: 1, ferns: 1, plantShadows: true,
  },
  low: {
    pixelRatio: 1.0, prMin: 0.75, shadowSize: 2048, shadowHalf: 24, shadowEvery: 10, mirrorSize: 384, mirrorEvery: 2,
    ao: true, volumetric: 12, bloom: true, fxaa: true, dof: false, halfTextures: false,
    dist: 0.6, count: 0.4, heroLeaves: 0.2, leafScaleCap: 1.7, realUnderstory: false, terrain: [176, 110, 48], farTrees: 0.55, fernBig: 0,
    woodDetail: 0.75, twigs: 0.2, branches: 0.3, sprayRadius: 18, cellScale: 1.25, ferns: 0.5, plantShadows: true,
  },
  mobile: {
    pixelRatio: 1.25, prMin: 1.0, shadowSize: 1024, shadowHalf: 18, shadowEvery: 46, mirrorSize: 256, mirrorEvery: 3,
    ao: false, volumetric: 0, bloom: false, fxaa: false, dof: false, halfTextures: true,
    dist: 0.36, count: 0.2, heroLeaves: 0.09, leafScaleCap: 2.1, realUnderstory: false, terrain: [112, 72, 32], farTrees: 0.3, fernBig: 0,
    woodDetail: 0.5, twigs: 0, branches: 0, sprayRadius: 8, lightModels: true, cellScale: 1.7, ferns: 0.22, plantShadows: false,
  },
};
export const TIER = { name: TIERS[QUALITY] ? QUALITY : 'high', ...(TIERS[QUALITY] || TIERS.high) };
