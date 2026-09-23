// §3 PROCEDURAL TEXTURES (baked on the GPU at startup) ---------------------------
const TEX = {};

const GLSL_PERIODIC = /* glsl */ `
float pn2(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = sp_hash12(mod(i, per)), b = sp_hash12(mod(i + vec2(1.0, 0.0), per));
  float c = sp_hash12(mod(i + vec2(0.0, 1.0), per)), d = sp_hash12(mod(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, float f0, int oct, float gain){
  float s = 0.0, a = 0.5, f = f0, n = 0.0;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * pn2(uv * f + float(i) * 17.13, vec2(f)); n += a; f *= 2.0; a *= gain; }
  return s / n;
}
// periodic voronoi with exact border distance (iq). returns (F1 distance, border distance, cell id)
vec3 pvor(vec2 uv, float n, float jit){
  vec2 p = uv * n; vec2 ip = floor(p), fp = fract(p);
  vec2 mg, mr; float md = 8.0; float id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(float(i), float(j)); vec2 cell = mod(ip + g, n);
    vec2 o = 0.5 + (sp_hash22(cell) - 0.5) * jit; vec2 r = g + o - fp; float d = dot(r, r);
    if (d < md){ md = d; mr = r; mg = g; id = sp_hash12(cell + 0.37); }
  }
  float bd = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++){
    vec2 g = mg + vec2(float(i), float(j)); vec2 cell = mod(ip + g, n);
    vec2 o = 0.5 + (sp_hash22(cell) - 0.5) * jit; vec2 r = g + o - fp;
    if (dot(mr - r, mr - r) > 0.00001) bd = min(bd, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(sqrt(md), bd, id);
}
`;

function bake2D(size, frag, { count = 1, uniforms = {}, mip = true, srgb0 = false } = {}) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    count, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: mip,
    minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  });
  if (srgb0) rt.textures[0].colorSpace = THREE.SRGBColorSpace;
  for (const t of rt.textures) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = mip; t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; t.anisotropy = rt.texture.anisotropy; }
  const mat = fsMat(GLSL_PERIODIC + frag, Object.assign({ uSize: { value: size } }, uniforms), { glslVersion: THREE.GLSL3 });
  blit(mat, rt);
  mat.dispose();
  return rt;
}

// Granite: albedo+height, and packed normal/ao/roughness. One tile = 2.5 m of stone.
function bakeGranite(size) {
  const frag = /* glsl */ `
  layout(location = 0) out vec4 oAlbedo;
  layout(location = 1) out vec4 oNRM;
  varying vec2 vUv;
  uniform float uSize;
  vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
  // height & material of the stone at uv (tile coords)
  float graniteHeight(vec2 uv, out vec3 alb, out float rough){
    vec3 g1 = pvor(uv, 190.0, 0.9);   // feldspar-scale crystals ~13mm
    vec3 g2 = pvor(uv + 0.31, 420.0, 0.95); // fine grains ~6mm
    vec3 cr = pvor(uv + 0.77, 7.0, 0.85);   // hairline crack network ~35cm cells
    vec3 cr2 = pvor(uv + 0.13, 3.0, 0.8);   // larger fractures
    float macro = pfbm(uv, 4.0, 5, 0.55);
    float mid = pfbm(uv, 16.0, 4, 0.5);
    float fine = pfbm(uv, 96.0, 3, 0.5);
    // mineral selection per crystal
    float id = g1.z, id2 = g2.z;
    vec3 feld = mix(srgb(vec3(0.70, 0.64, 0.58)), srgb(vec3(0.78, 0.72, 0.64)), sp_hash11(id * 7.1));
    vec3 quartz = srgb(vec3(0.56, 0.57, 0.58));
    vec3 plag = srgb(vec3(0.83, 0.81, 0.77));
    vec3 biot = srgb(vec3(0.13, 0.12, 0.115));
    vec3 c; float r;
    if (id < 0.42){ c = feld; r = 0.84; }
    else if (id < 0.66){ c = quartz; r = 0.55; }
    else if (id < 0.88){ c = plag; r = 0.8; }
    else { c = biot; r = 0.62; }
    // fine grains overlay: biotite specks and quartz glints
    if (id2 > 0.9) { c = mix(c, biot, 0.85); r = 0.6; }
    else if (id2 < 0.12) { c = mix(c, quartz, 0.6); r = min(r, 0.6); }
    c *= 0.9 + 0.2 * sp_hash11(id2 * 13.7);
    // weathering: grime in low areas, iron staining, lichen patches
    float grime = smoothstep(0.35, 0.75, pfbm(uv + 3.1, 6.0, 5, 0.6));
    c = mix(c, c * srgb(vec3(0.62, 0.58, 0.53)), grime * 0.75);
    float iron = smoothstep(0.62, 0.8, pfbm(uv + 7.7, 5.0, 5, 0.55)) * 0.55;
    c = mix(c, srgb(vec3(0.46, 0.33, 0.22)), iron * 0.5);
    float lich = smoothstep(0.66, 0.74, pfbm(uv + 11.3, 11.0, 5, 0.6));
    float lichDots = smoothstep(0.55, 0.62, pn2(uv * 220.0, vec2(220.0)));
    c = mix(c, srgb(vec3(0.60, 0.62, 0.55)), lich * (0.35 + 0.35 * lichDots));
    c *= 0.88 + 0.24 * macro;
    // cracks
    float crackSel = step(0.45, sp_hash11(cr.z * 91.0 + 0.3));
    float crack = (1.0 - smoothstep(0.0, 0.0035 + 0.003 * mid, cr.x * 0.0 + cr.y / 7.0)) * crackSel;
    float crackB = 1.0 - smoothstep(0.0, 0.006, cr2.y / 3.0);
    float cracks = max(crack, crackB);
    c = mix(c, c * 0.35, cracks * 0.85);
    r = mix(r, 0.95, grime * 0.6 + cracks * 0.5);
    alb = c; rough = r;
    float h = macro * 0.55 + mid * 0.22 + fine * 0.05;
    h += (1.0 - g1.x) * 0.018 * (id < 0.66 ? 1.0 : 0.4); // crystals stand proud where weathered
    h -= cracks * 0.12;
    h -= smoothstep(0.7, 1.0, 1.0 - pfbm(uv + 5.5, 24.0, 3, 0.5)) * 0.03; // pitting
    return h;
  }
  void main(){
    vec2 uv = vUv; vec3 alb; float rough;
    float h = graniteHeight(uv, alb, rough);
    vec3 a2; float r2;
    float e = 1.0 / uSize;
    float hx = graniteHeight(uv + vec2(e, 0.0), a2, r2);
    float hy = graniteHeight(uv + vec2(0.0, e), a2, r2);
    // height units: 1.0 ~ 12 mm of relief over a 2.5 m tile
    float relief = 0.012 / (2.5 / uSize) ;
    vec3 n = normalize(vec3(-(hx - h) * relief, -(hy - h) * relief, 1.0));
    float low = pfbm(uv, 4.0, 3, 0.5) * 0.55 + pfbm(uv, 16.0, 2, 0.5) * 0.22;
    float ao = clamp(0.62 + (h - low) * 2.2, 0.25, 1.0);
    oAlbedo = vec4(alb, clamp(h, 0.0, 1.0));
    oNRM = vec4(n.xy * 0.5 + 0.5, ao, rough);
  }`;
  const rt = bake2D(size, frag, { count: 2, srgb0: true });
  TEX.graniteAlbedo = rt.textures[0];
  TEX.graniteNRM = rt.textures[1];
  return rt;
}

// Wool/linen weave: normal (xy), ao, roughness + fiber variation in a second target.
function bakeCloth(size) {
  const frag = /* glsl */ `
  layout(location = 0) out vec4 oN;
  layout(location = 1) out vec4 oV;
  varying vec2 vUv;
  uniform float uSize;
  float weave(vec2 uv, out float var){
    float threads = 96.0; vec2 p = uv * threads;
    vec2 cell = floor(p); vec2 f = fract(p);
    float over = mod(cell.x + cell.y, 2.0);  // plain weave
    float slubW = pn2(vec2(cell.y * 0.37, uv.x * 9.0), vec2(threads * 0.37, 9.0));
    float slubF = pn2(vec2(cell.x * 0.41, uv.y * 9.0), vec2(threads * 0.41, 9.0));
    float warp = sin(f.x * 3.14159) * (0.75 + 0.5 * slubW);
    float weft = sin(f.y * 3.14159) * (0.75 + 0.5 * slubF);
    float h = over > 0.5 ? warp * (0.6 + 0.4 * sin(f.y * 3.14159)) : weft * (0.6 + 0.4 * sin(f.x * 3.14159));
    var = mix(slubW, slubF, over);
    return h;
  }
  void main(){
    vec2 uv = vUv; float var;
    float h = weave(uv, var);
    float e = 1.0 / uSize; float v2;
    float hx = weave(uv + vec2(e, 0.0), v2), hy = weave(uv + vec2(0.0, e), v2);
    vec3 n = normalize(vec3(-(hx - h) * 1.6, -(hy - h) * 1.6, 1.0));
    float fuzz = pfbm(uv, 24.0, 4, 0.55);
    float wear = smoothstep(0.55, 0.8, pfbm(uv + 2.3, 4.0, 5, 0.6));
    oN = vec4(n.xy * 0.5 + 0.5, 0.75 + 0.25 * h, 0.85 + 0.1 * fuzz);
    oV = vec4(var, fuzz, wear, h);
  }`;
  const rt = bake2D(size, frag, { count: 2 });
  TEX.clothN = rt.textures[0];
  TEX.clothV = rt.textures[1];
  return rt;
}

// 3D tiling noise for clouds (R: perlin-worley, G/B/A: worley octaves). 64^3, RGBA8.
function bakeCloudNoise(N = 64) {
  const rt = new THREE.WebGL3DRenderTarget(N, N, N, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const t = rt.texture; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  const mat = fsMat(/* glsl */ `
    varying vec2 vUv; uniform float uZ;
    float worley(vec3 p, float n){
      vec3 ip = floor(p * n), fp = fract(p * n); float md = 1.0;
      for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
        vec3 g = vec3(float(i), float(j), float(k)); vec3 cell = mod(ip + g, n);
        vec3 o = sp_hash33(cell + 0.17); vec3 r = g + o - fp; md = min(md, dot(r, r));
      }
      return 1.0 - sqrt(md);
    }
    vec3 grad(vec3 c, float n){ return normalize(sp_hash33(mod(c, n) + 3.1) * 2.0 - 1.0); }
    float perlin(vec3 p, float n){
      vec3 ip = floor(p * n), f = fract(p * n); vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float v000 = dot(grad(ip, n), f), v100 = dot(grad(ip + vec3(1,0,0), n), f - vec3(1,0,0));
      float v010 = dot(grad(ip + vec3(0,1,0), n), f - vec3(0,1,0)), v110 = dot(grad(ip + vec3(1,1,0), n), f - vec3(1,1,0));
      float v001 = dot(grad(ip + vec3(0,0,1), n), f - vec3(0,0,1)), v101 = dot(grad(ip + vec3(1,0,1), n), f - vec3(1,0,1));
      float v011 = dot(grad(ip + vec3(0,1,1), n), f - vec3(0,1,1)), v111 = dot(grad(ip + vec3(1,1,1), n), f - vec3(1,1,1));
      return mix(mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y), mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y), u.z);
    }
    void main(){
      vec3 p = vec3(vUv, uZ);
      float pf = 0.0, a = 1.0, nn = 0.0; float f = 4.0;
      for (int i = 0; i < 5; i++){ pf += a * perlin(p, f); nn += a; f *= 2.0; a *= 0.5; }
      pf = pf / nn * 0.5 + 0.5;
      float w1 = worley(p, 4.0) * 0.625 + worley(p, 8.0) * 0.25 + worley(p, 16.0) * 0.125;
      float pw = clamp((pf - (1.0 - w1)) / (1.0 - (1.0 - w1)) , 0.0, 1.0); // remap perlin by worley
      pw = mix(pf, pw, 0.55);
      float g = worley(p, 8.0) * 0.625 + worley(p, 16.0) * 0.25 + worley(p, 32.0) * 0.125;
      float b = worley(p, 16.0) * 0.625 + worley(p, 32.0) * 0.25 + worley(p, 64.0) * 0.125;
      float c = worley(p, 32.0);
      gl_FragColor = vec4(pw, g, b, c);
    }`, { uZ: { value: 0 } });
  for (let z = 0; z < N; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / N;
    fsq.material = mat;
    renderer.setRenderTarget(rt, z);
    fsq.render(renderer);
  }
  mat.dispose();
  TEX.cloudNoise = rt.texture;
  return rt;
}

// Curl of a tiling vector potential, 32^3 half-float: divergence-free turbulence for particles.
function bakeCurl(N = 32) {
  const rt = new THREE.WebGL3DRenderTarget(N, N, N, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const t = rt.texture; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  const mat = fsMat(/* glsl */ `
    varying vec2 vUv; uniform float uZ; uniform float uN;
    vec3 grad(vec3 c, float n, float s){ return normalize(sp_hash33(mod(c, n) + s) * 2.0 - 1.0); }
    float gn(vec3 p, float n, float s){
      vec3 ip = floor(p * n), f = fract(p * n); vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float v000 = dot(grad(ip, n, s), f), v100 = dot(grad(ip + vec3(1,0,0), n, s), f - vec3(1,0,0));
      float v010 = dot(grad(ip + vec3(0,1,0), n, s), f - vec3(0,1,0)), v110 = dot(grad(ip + vec3(1,1,0), n, s), f - vec3(1,1,0));
      float v001 = dot(grad(ip + vec3(0,0,1), n, s), f - vec3(0,0,1)), v101 = dot(grad(ip + vec3(1,0,1), n, s), f - vec3(1,0,1));
      float v011 = dot(grad(ip + vec3(0,1,1), n, s), f - vec3(0,1,1)), v111 = dot(grad(ip + vec3(1,1,1), n, s), f - vec3(1,1,1));
      return mix(mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y), mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y), u.z);
    }
    vec3 pot(vec3 p){ return vec3(gn(p, 4.0, 1.3) + 0.5 * gn(p, 8.0, 2.7), gn(p, 4.0, 5.1) + 0.5 * gn(p, 8.0, 6.9), gn(p, 4.0, 9.7) + 0.5 * gn(p, 8.0, 11.3)); }
    void main(){
      vec3 p = vec3(vUv, uZ); float e = 0.5 / uN;
      vec3 dx = vec3(e, 0, 0), dy = vec3(0, e, 0), dz = vec3(0, 0, e);
      vec3 px0 = pot(p - dx), px1 = pot(p + dx), py0 = pot(p - dy), py1 = pot(p + dy), pz0 = pot(p - dz), pz1 = pot(p + dz);
      vec3 c = vec3((py1.z - py0.z) - (pz1.y - pz0.y), (pz1.x - pz0.x) - (px1.z - px0.z), (px1.y - px0.y) - (py1.x - py0.x)) / (2.0 * e);
      gl_FragColor = vec4(c * 0.08, 1.0);
    }`, { uZ: { value: 0 }, uN: { value: N } });
  for (let z = 0; z < N; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / N;
    fsq.material = mat;
    renderer.setRenderTarget(rt, z);
    fsq.render(renderer);
  }
  mat.dispose();
  TEX.curl = rt.texture;
  return rt;
}

// Blackbody color ramp: u = (T - 600K) / 3400K. RGB normalized chroma; A = relative radiance (T^4-ish, compressed).
function makeBlackbodyLUT() {
  const N = 256, data = new Uint16Array(N * 4), c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const T = 600 + (i / (N - 1)) * 3400;
    blackbodyRGB(Math.max(T, 1000), c);
    if (T < 1000) { const k = (T - 600) / 400; c[1] *= k * 0.9 + 0.1; c[2] *= k * k; }
    const rad = Math.pow(T / 1500, 4);
    data[i * 4] = THREE.DataUtils.toHalfFloat(c[0]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(c[1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(c[2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(Math.min(rad, 60000));
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  TEX.blackbody = tex;
  return tex;
}
