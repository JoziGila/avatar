// =============================================================================
// STILLPOINT — a real-time elemental martial-arts cinematic
// Three.js r186 · WebGL2 · single file. Sections:
//   §0  core utilities, easing, RNG, noise, shared GLSL
//   §1  quality presets, capabilities, URL flags
//   §2  renderer, render targets, fullscreen helpers
//   §3  procedural textures (granite, cloth, noise volumes, blackbody LUT)
//   §4  atmosphere, sky, stars, environment lighting
//   §5  volumetric cloud sea
//   §6  world: summit terrain, pool, pillars, boulders, peaks, pebbles, effect masks
//   §7  lighting rig (sun/moon key, element lights)
//   §8  character: SDF sculpt + surface nets, skeleton, skinning
//   §9  rig: pose system, IK, retargeting, GLB loading, AnimationMixer clips
//   §10 cloth: verlet robe skirt, sash, hair, pillar scraps
//   §11 GPU particles (GPGPU ring-buffer emitters)
//   §12 water, screen-space fluid, ice
//   §13 earth: slabs, fragments, impulse physics, shockwave, pillar eruption
//   §14 fire: fist flames, fireballs, arcs, torrent, embers, scorch
//   §15 air: vortex, streaks, leaves
//   §16 unity: rings, singularity, shockwave sphere
//   §17 post-processing (EffectComposer passes)
//   §18 choreography (poses, keys)
//   §19 timeline sequencer
//   §20 camera director
//   §21 audio (Web Audio, spatial)
//   §22 UI, input, free-play
//   §23 main loop, adaptive quality
// =============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// §0 ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, x) => clamp((x - a) / (b - a));
const remap = (x, a, b, c, d) => lerp(c, d, invLerp(a, b, x));
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, x) => smooth01(invLerp(a, b, x));
const fract = (x) => x - Math.floor(x);
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
// window: rises over [a-fi, a], holds, falls over [b, b+fo]
const win = (t, a, b, fi, fo) => smoothstep(a - fi, a, t) * (1 - smoothstep(b, b + fo, t));

const Ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inBack: (t) => { const c1 = 1.4, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  // explosive attack, ~4% overshoot, settle — used for strikes
  strike: (t) => { const s = 1 - Math.pow(1 - t, 5); return s + Math.sin(Math.min(t, 1) * Math.PI) * 0.045 * (1 - t) * (1 - t); },
  // committed weight transfer: slow start, heavy middle, soft landing
  heavy: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class RNG {
  constructor(seed = 1) { this.r = mulberry32(seed); }
  f(a = 0, b = 1) { return a + (b - a) * this.r(); }
  i(a, b) { return Math.floor(this.f(a, b + 1)); }
  s() { return this.r() < 0.5 ? -1 : 1; }
  pick(a) { return a[Math.floor(this.r() * a.length)]; }
  g() { let u = 0, v = 0; while (u === 0) u = this.r(); while (v === 0) v = this.r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
  dir(out = new THREE.Vector3()) { const z = this.f(-1, 1), a = this.f(0, TAU), r = Math.sqrt(1 - z * z); return out.set(r * Math.cos(a), z, r * Math.sin(a)); }
}
const rng = new RNG(20260923);

// --- CPU noise: 2D/3D simplex (Gustavson), fbm ------------------------------
const Noise = (() => {
  const perm = new Uint8Array(512), grad3 = [1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1];
  const r = new RNG(1337); const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r.f() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6, F3 = 1 / 3, G3 = 1 / 6;
  function n2(xin, yin) {
    const s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s), t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t); const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255; let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0; if (tt > 0) { g = (perm[ii + perm[jj]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g] * x0 + grad3[g + 1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1; if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g] * x1 + grad3[g + 1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2; if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g] * x2 + grad3[g + 1] * y2); }
    return 70 * n;
  }
  function n3(xin, yin, zin) {
    const s = (xin + yin + zin) * F3, i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s), t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) { if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; } else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; } else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; } }
    else { if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; } else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; } else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; } }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3, x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3; const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0*x0 - y0*y0 - z0*z0; if (tt > 0) { g = (perm[ii + perm[jj + perm[kk]]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g]*x0 + grad3[g+1]*y0 + grad3[g+2]*z0); }
    tt = 0.6 - x1*x1 - y1*y1 - z1*z1; if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g]*x1 + grad3[g+1]*y1 + grad3[g+2]*z1); }
    tt = 0.6 - x2*x2 - y2*y2 - z2*z2; if (tt > 0) { g = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g]*x2 + grad3[g+1]*y2 + grad3[g+2]*z2); }
    tt = 0.6 - x3*x3 - y3*y3 - z3*z3; if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] % 12) * 3; tt *= tt; n += tt * tt * (grad3[g]*x3 + grad3[g+1]*y3 + grad3[g+2]*z3); }
    return 32 * n;
  }
  const fbm2 = (x, y, o = 4, lac = 2.03, g = 0.5) => { let a = 1, s = 0, n = 0; for (let i = 0; i < o; i++) { s += a * n2(x, y); n += a; x *= lac; y *= lac; a *= g; } return s / n; };
  const fbm3 = (x, y, z, o = 4, lac = 2.03, g = 0.5) => { let a = 1, s = 0, n = 0; for (let i = 0; i < o; i++) { s += a * n3(x, y, z); n += a; x *= lac; y *= lac; z *= lac; a *= g; } return s / n; };
  const ridge2 = (x, y, o = 5) => { let a = 0.5, s = 0, f = 1, w = 1; for (let i = 0; i < o; i++) { let v = 1 - Math.abs(n2(x * f, y * f)); v *= v * w; w = clamp(v * 2); s += v * a; f *= 2.1; a *= 0.5; } return s; };
  return { n2, n3, fbm2, fbm3, ridge2 };
})();

// Shake-friendly 1D smooth noise (sum of sines with incommensurate periods)
const wobble = (t, seed = 0) => Math.sin(t * 1.31 + seed) * 0.5 + Math.sin(t * 2.17 + seed * 1.7) * 0.3 + Math.sin(t * 3.73 + seed * 2.3) * 0.2;

// --- shared GLSL -------------------------------------------------------------
const GLSL_COMMON = /* glsl */ `
#ifndef SP_COMMON
#define SP_COMMON
#define SP_PI 3.14159265359
#define SP_TAU 6.28318530718
float sp_hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float sp_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sp_hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 sp_hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 sp_hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4 sp_hash41(float p){ vec4 p4 = fract(vec4(p) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
float sp_ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float sp_vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = sp_hash13(i), b = sp_hash13(i + vec3(1,0,0)), c = sp_hash13(i + vec3(0,1,0)), d = sp_hash13(i + vec3(1,1,0));
  float e = sp_hash13(i + vec3(0,0,1)), f1 = sp_hash13(i + vec3(1,0,1)), g = sp_hash13(i + vec3(0,1,1)), h = sp_hash13(i + vec3(1,1,1));
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,f1,u.x), mix(g,h,u.x), u.y), u.z);
}
float sp_vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sp_hash12(i), sp_hash12(i + vec2(1,0)), u.x), mix(sp_hash12(i + vec2(0,1)), sp_hash12(i + vec2(1,1)), u.x), u.y);
}
float sp_fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * sp_vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.9375; }
float sp_fbm2(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * sp_vnoise2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s / 0.96875; }
float sp_luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sp_dirToEquirect(vec3 d){ return vec3(atan(d.z, d.x) / SP_TAU + 0.5, acos(clamp(d.y, -1.0, 1.0)) / SP_PI, 0.0); }
vec2 sp_equirectUV(vec3 d){ return vec2(atan(d.z, d.x) / SP_TAU + 0.5, 1.0 - acos(clamp(d.y, -1.0, 1.0)) / SP_PI); }
mat2 sp_rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
#endif
`;

// Blackbody chromaticity (Krystek fit) -> linear sRGB, normalized to max channel.
function blackbodyRGB(T, out = [0, 0, 0]) {
  const t = T, t2 = t * t;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t2) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t2);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t2) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t2);
  const x = (3 * u) / (2 * u - 8 * v + 4), y = (2 * v) / (2 * u - 8 * v + 4), z = 1 - x - y;
  const X = x / y, Y = 1, Z = z / y;
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const m = Math.max(r, g, b, 1e-6); out[0] = r / m; out[1] = g / m; out[2] = b / m; return out;
}

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _m1 = new THREE.Matrix4(), _e1 = new THREE.Euler();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
