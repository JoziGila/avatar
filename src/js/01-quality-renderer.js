// §1 QUALITY PRESETS, CAPABILITIES, FLAGS ---------------------------------------
const URLQ = new URLSearchParams(location.search);
const FLAGS = {
  capture: URLQ.has('capture'),
  noAdapt: URLQ.has('noadapt') || URLQ.has('capture'),
  quality: URLQ.get('q'),
  startT: URLQ.has('t') ? parseFloat(URLQ.get('t')) : null,
  glb: URLQ.get('glb'),
  debug: URLQ.has('debug'),
};
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches || URLQ.has('reduced');
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const IS_MOBILE = IS_TOUCH && Math.min(screen.width, screen.height) < 900;

// Each tier is a ceiling; adaptive quality scales down within it to hold frame rate.
const QUALITY = {
  low: { name: 'low', scale: 0.62, dprMax: 1.25, msaa: 0, shadow: 1024, ao: false, dof: false, mblur: false, streak: false,
    cloudSteps: 18, cloudLight: 1, cloudRes: 0.25, reflect: 0, particles: 0.3, particleTex: 128, clothIters: 5, clothSub: 2,
    lights: 2, ssfRes: 0.5, texSize: 512, skyEvery: 6, envEvery: 90, bodyVox: 0.017, headVox: 0.0055, handVox: 0.0045, terrainSeg: 160 },
  medium: { name: 'medium', scale: 0.8, dprMax: 1.5, msaa: 0, shadow: 2048, ao: false, dof: true, mblur: false, streak: true,
    cloudSteps: 28, cloudLight: 2, cloudRes: 0.33, reflect: 0.33, particles: 0.55, particleTex: 192, clothIters: 7, clothSub: 2,
    lights: 3, ssfRes: 0.5, texSize: 1024, skyEvery: 3, envEvery: 45, bodyVox: 0.0135, headVox: 0.0042, handVox: 0.0034, terrainSeg: 224 },
  high: { name: 'high', scale: 1.0, dprMax: 1.75, msaa: 4, shadow: 2048, ao: true, dof: true, mblur: true, streak: true,
    cloudSteps: 40, cloudLight: 3, cloudRes: 0.5, reflect: 0.5, particles: 0.8, particleTex: 256, clothIters: 9, clothSub: 3,
    lights: 4, ssfRes: 0.5, texSize: 1024, skyEvery: 2, envEvery: 30, bodyVox: 0.012, headVox: 0.0036, handVox: 0.003, terrainSeg: 288 },
  ultra: { name: 'ultra', scale: 1.0, dprMax: 2.0, msaa: 4, shadow: 4096, ao: true, dof: true, mblur: true, streak: true,
    cloudSteps: 56, cloudLight: 4, cloudRes: 0.5, reflect: 0.75, particles: 1.0, particleTex: 256, clothIters: 12, clothSub: 3,
    lights: 6, ssfRes: 0.75, texSize: 2048, skyEvery: 1, envEvery: 20, bodyVox: 0.0105, headVox: 0.0032, handVox: 0.0027, terrainSeg: 320 },
};
const TIERS = ['low', 'medium', 'high', 'ultra'];

// §2 RENDERER ------------------------------------------------------------------
const canvas = document.getElementById('gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: FLAGS.capture });
} catch (e) {
  renderer = null;
}
const gl = renderer ? renderer.getContext() : null;
const CAPS = (() => {
  if (!gl) return { ok: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const cbf = !!gl.getExtension('EXT_color_buffer_float');
  const cbhf = !!gl.getExtension('EXT_color_buffer_half_float') || cbf;
  const flin = !!gl.getExtension('OES_texture_float_linear');
  gl.getExtension('EXT_float_blend');
  return { ok: gl instanceof WebGL2RenderingContext, gpu, floatRT: cbf, halfRT: cbhf, floatLinear: flin,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) | 0, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0 };
})();
// Simulation state wants full float; fall back to half where float targets are unavailable (older mobile GPUs).
const SIM_TYPE = CAPS.floatRT ? THREE.FloatType : THREE.HalfFloatType;

function defaultTier() {
  if (FLAGS.quality && QUALITY[FLAGS.quality]) return FLAGS.quality;
  const g = (CAPS.gpu || '').toLowerCase();
  if (IS_MOBILE) return /apple|adreno \(tm\) (7[3-9]|8)|mali-g7[1-9]|mali-g[1-9]\d\d|immortalis/.test(g) ? 'medium' : 'low';
  if (/swiftshader|llvmpipe|software/.test(g)) return 'medium';
  if (/intel|uhd|iris|mali|adreno|powervr/.test(g)) return 'medium';
  if (/rtx (4|5)0[6-9]0|rtx [2-5]0[89]0|radeon rx [6-9][7-9]|apple m[2-9] (pro|max|ultra)/.test(g)) return 'ultra';
  return 'high';
}
let tierName = defaultTier();
let Q = { ...QUALITY[tierName] };

if (renderer) {
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
}

// Scenes: opaque world, translucent FX, screen-space distortion sources.
const world = new THREE.Scene();
const fxScene = new THREE.Scene();
const distortScene = new THREE.Scene();
world.matrixWorldAutoUpdate = true;
const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.08, 9000);
camera.position.set(0, 1.6, 6);

// Viewport state (CSS px and render resolution)
const VIEW = { w: 1, h: 1, dpr: 1, rw: 1, rh: 1, aspect: 1, dynScale: 1, letterbox: 0 };

function makeRT(w, h, o = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), Object.assign({
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  }, o));
  return rt;
}

// Fullscreen helpers ---------------------------------------------------------
const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const fsq = new FullScreenQuad(null);
function fsMat(fragmentShader, uniforms = {}, o = {}) {
  return new THREE.ShaderMaterial(Object.assign({
    uniforms, vertexShader: o.vertexShader || FS_VERT, fragmentShader: GLSL_COMMON + fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, transparent: false, toneMapped: false,
  }, o, { vertexShader: o.vertexShader || FS_VERT }));
}
function blit(mat, target, clear = false) {
  fsq.material = mat;
  renderer.setRenderTarget(target);
  if (clear) renderer.clear(true, false, false);
  fsq.render(renderer);
}
const copyMat = fsMat(`uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`, { tSrc: { value: null } });
function copyTex(src, target) { copyMat.uniforms.tSrc.value = src; blit(copyMat, target); }

// Common per-frame uniforms shared by many custom shaders (objects are shared by reference).
const U = {
  uTime: { value: 0 },            // timeline-driven time (stops in hit-stop)
  uRealTime: { value: 0 },        // wall clock
  uSunDir: { value: V3(0, 0.1, -1).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
  uMoonDir: { value: V3(0.3, 0.4, 0.8).normalize() },
  uKeyDir: { value: V3(0, 0.3, -1).normalize() },   // whichever of sun/moon is lighting
  uKeyColor: { value: new THREE.Color(1, 1, 1) },
  uSkyZenith: { value: new THREE.Color(0.2, 0.3, 0.5) },
  uSkyHorizon: { value: new THREE.Color(0.6, 0.5, 0.4) },
  uAmbient: { value: new THREE.Color(0.2, 0.2, 0.25) },
  uSkyTex: { value: null },
  uLinDepth: { value: null },
  uWaterDepth: { value: null },
  uSceneCopy: { value: null },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uCamNear: { value: 0.08 },
  uCamFar: { value: 9000 },
  uFogDensity: { value: 0.00055 },
  uWind: { value: V3(1.2, 0, -0.4) },
  uStarVis: { value: 0 },
  uExposure: { value: 1 },
};
