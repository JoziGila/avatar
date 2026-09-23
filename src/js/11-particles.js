// §11 GPU PARTICLES — GPGPU simulation with ring-buffer emitters ----------------------
// State lives in float textures (MRT): t0 = pos.xyz + age, t1 = vel.xyz + life,
// t2 = seed, size, kind, param. The CPU only queues emitters (packed into a small data
// texture); spawning, integration, forces and collisions all happen in one fragment
// pass. Rendering draws one instanced quad per texel, fetching state by gl_InstanceID.
const EMIT_MAX = 48, EMIT_TEX = 6;
const FIELD = {
  shock: new THREE.Vector4(0, -100, 0, 0), shock2: new THREE.Vector4(1, 0, 0, 0),   // centre xyz + radius | thickness, strength
  vortex: new THREE.Vector4(0, 0, 3, 0), vortex2: new THREE.Vector4(0, 0, 0, 6), vortexY: 0, // cx, cz, radius, amount | spin, pull, up, height
  rings: [0, 1, 2, 3].map(() => ({ c: V3(), n: V3(0, 1, 0), r: 2, speed: 3, amt: 0, compress: 0 })),
  attract: new THREE.Vector4(0, -100, 0, 0), // centre + strength (Unity singularity)
};
const PARTICLE_COMMON = /* glsl */ `
uniform highp sampler3D uCurl; uniform sampler2D uHeight; uniform float uHeightExt;
uniform vec3 uWind; uniform float uGust, uTime, uDt;
uniform vec4 uShock, uShock2, uVortex, uVortex2; uniform float uVortexY;
uniform vec4 uRingC[4], uRingN[4], uRingP[4]; uniform vec4 uAttract;
float groundAt(vec2 xz){
  vec2 uv = (xz + uHeightExt) / (2.0 * uHeightExt);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return -400.0;
  return texture2D(uHeight, uv).r;
}
vec3 curlAt(vec3 p){ return texture(uCurl, p).xyz; }
vec3 windField(vec3 p){
  vec3 w = uWind * (1.0 + uGust * (0.55 * sin(uTime * 0.9 + p.x * 0.21) + 0.35 * sin(uTime * 2.3 + p.z * 0.37 + 1.3)));
  if (uVortex.w > 0.001){
    vec2 d = p.xz - uVortex.xy; float r = length(d) + 1e-3; float hy = p.y - uVortexY;
    float fall = exp(-pow(r / (uVortex.z * 1.8), 2.0)) * smoothstep(-1.5, 0.5, hy) * (1.0 - smoothstep(uVortex2.w - 1.0, uVortex2.w + 2.0, hy));
    vec2 tang = vec2(-d.y, d.x) / r;
    w.xz += (tang * uVortex2.x - d / r * uVortex2.y) * fall * uVortex.w;
    w.y += uVortex2.z * fall * uVortex.w;
  }
  return w;
}
`;

const UPDATE_FRAG = /* glsl */ `
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
varying vec2 vUv;
uniform sampler2D t0, t1, t2, uEmit; uniform int uEmitCount; uniform vec2 uSize; uniform float uFrameSeed;
` + PARTICLE_COMMON + /* glsl */ `
vec4 E(int k, int f){ return texelFetch(uEmit, ivec2(k * ${EMIT_TEX} + f, 0), 0); }
vec3 randDir(vec3 h){ float z = h.x * 2.0 - 1.0; float a = h.y * SP_TAU; float r = sqrt(max(0.0, 1.0 - z * z)); return vec3(r * cos(a), z, r * sin(a)); }
//BEHAVIOUR
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy); float idx = float(ij.y) * uSize.x + float(ij.x);
  vec4 a = texelFetch(t0, ij, 0), b = texelFetch(t1, ij, 0), c = texelFetch(t2, ij, 0);
  for (int k = 0; k < ${EMIT_MAX}; k++){
    if (k >= uEmitCount) break;
    vec4 e0 = E(k, 0);
    if (idx >= e0.x && idx < e0.x + e0.y){
      float j = idx - e0.x;
      vec3 h = sp_hash33(vec3(idx * 0.1234 + uFrameSeed, e0.w * 1.7 + j * 0.013, uFrameSeed * 0.37 + 0.5));
      vec3 h2 = sp_hash33(h * 91.7 + vec3(uFrameSeed));
      vec4 e1 = E(k, 1), e2 = E(k, 2), e3 = E(k, 3), e4 = E(k, 4), e5 = E(k, 5);
      float u = (j + h.z) / max(e0.y, 1.0);
      vec3 base = mix(e1.xyz, e2.xyz, e2.w > 0.5 ? u : 0.0);
      vec3 rd = randDir(h);
      vec3 pos;
      if (e2.w > 1.5) { // ring / disc in the plane whose normal is e5.xyz... (spawnMode 2): radius e1.w
        vec3 n = normalize(e5.yzw + vec3(1e-4)); vec3 t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0))); vec3 bt = cross(n, t);
        float ang = h.x * SP_TAU; pos = e1.xyz + (t * cos(ang) + bt * sin(ang)) * e1.w * (0.85 + 0.15 * h.y) + rd * 0.05;
      } else pos = base + rd * e1.w * pow(h2.x, 0.33);
      vec3 vel = e3.xyz + randDir(h2) * e3.w;
      if (e2.w > 1.5) { vec3 n = normalize(e5.yzw + vec3(1e-4)); vec3 radial = normalize(pos - e1.xyz); vel = e3.xyz + radial * e3.w * (0.7 + 0.6 * h2.y); }
      float life = mix(e4.x, e4.y, h2.z);
      float size = mix(e4.z, e4.w, h.z);
      o0 = vec4(pos, h2.y * uDt); o1 = vec4(vel, life); o2 = vec4(h.x + h.y * 0.001, size, e0.z, e5.x);
      return;
    }
  }
  if (b.w <= 0.0) { o0 = a; o1 = b; o2 = c; return; }
  vec3 p = a.xyz, v = b.xyz; float age = a.w + uDt;
  if (age >= b.w) { o0 = vec4(0.0, -1000.0, 0.0, 0.0); o1 = vec4(0.0); o2 = c; return; }
  float kind = c.z;
  behave(kind, p, v, age, b.w, c, uDt);
  // generic fields: shockwave shell, unity rings, singularity pull
  if (uShock2.y > 0.0){ vec3 d = p - uShock.xyz; float r = length(d) + 1e-3; float sh = exp(-pow((r - uShock.w) / uShock2.x, 2.0)); v += d / r * sh * uShock2.y * uDt; }
  o0 = vec4(p, age); o1 = vec4(v, b.w); o2 = c;
}
`;

class GPUParticles {
  constructor({ name, width, height, behaviour, material, scene, layers = [] }) {
    this.name = name; this.W = width; this.H = height; this.cap = width * height;
    const mk = () => new THREE.WebGLRenderTarget(width, height, { count: 3, type: SIM_TYPE, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.rtA = mk(); this.rtB = mk();
    this.emitData = new Float32Array(EMIT_MAX * EMIT_TEX * 4);
    this.emitTex = new THREE.DataTexture(this.emitData, EMIT_MAX * EMIT_TEX, 1, THREE.RGBAFormat, THREE.FloatType);
    this.emitTex.minFilter = this.emitTex.magFilter = THREE.NearestFilter; this.emitTex.needsUpdate = true;
    this.queue = []; this.cursor = 0; this.frameSeed = 0;
    this.updateMat = fsMat(UPDATE_FRAG.replace('//BEHAVIOUR', behaviour), {
      t0: { value: null }, t1: { value: null }, t2: { value: null }, uEmit: { value: this.emitTex }, uEmitCount: { value: 0 },
      uSize: { value: new THREE.Vector2(width, height) }, uFrameSeed: { value: 0 }, ...fieldUniforms(),
    }, { glslVersion: THREE.GLSL3 });
    // render: instanced quads
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]); geo.instanceCount = this.cap;
    this.material = material;
    Object.assign(material.uniforms, { tP0: { value: null }, tP1: { value: null }, tP2: { value: null }, uPSize: { value: new THREE.Vector2(width, height) } });
    this.mesh = new THREE.Mesh(geo, material); this.mesh.frustumCulled = false; this.mesh.renderOrder = material.userData.order || 0;
    this.mesh.name = 'particles:' + name;
    scene.add(this.mesh);
    for (const L of layers) { const m2 = new THREE.Mesh(geo, L.material); m2.frustumCulled = false; Object.assign(L.material.uniforms, { tP0: material.uniforms.tP0, tP1: material.uniforms.tP1, tP2: material.uniforms.tP2, uPSize: material.uniforms.uPSize }); L.scene.add(m2); }
    this.clear();
  }
  clear() {
    for (const rt of [this.rtA, this.rtB]) { renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); }
    renderer.setClearColor(0x000000, 1);
    this.queue.length = 0; this.bindRender();
  }
  // e: { count, pos, pos2?, radius, vel, spread, life:[a,b], size:[a,b], kind, param, mode, normal }
  emit(e) {
    let n = Math.round((e.count || 0) * (e.scale == null ? Q.particles * VIEW_PSCALE : e.scale));
    if (e.count > 0 && n < 1 && Math.random() < e.count * Q.particles) n = 1;
    if (n <= 0) return;
    n = Math.min(n, Math.floor(this.cap / 4));
    this.queue.push(Object.assign({}, e, { n }));
  }
  pack() {
    const D = this.emitData; let k = 0;
    for (const e of this.queue) {
      let remaining = e.n;
      while (remaining > 0 && k < EMIT_MAX) {
        const start = this.cursor; const cnt = Math.min(remaining, this.cap - start);
        const o = k * EMIT_TEX * 4;
        const p = e.pos, p2 = e.pos2 || e.pos, v = e.vel || _v1.set(0, 0, 0), nn = e.normal || _v2.set(0, 1, 0);
        D[o] = start; D[o + 1] = cnt; D[o + 2] = e.kind || 0; D[o + 3] = Math.random() * 1000;
        D[o + 4] = p.x; D[o + 5] = p.y; D[o + 6] = p.z; D[o + 7] = e.radius || 0;
        D[o + 8] = p2.x; D[o + 9] = p2.y; D[o + 10] = p2.z; D[o + 11] = e.mode != null ? e.mode : (e.pos2 ? 1 : 0);
        D[o + 12] = v.x; D[o + 13] = v.y; D[o + 14] = v.z; D[o + 15] = e.spread || 0;
        D[o + 16] = e.life[0]; D[o + 17] = e.life[1]; D[o + 18] = e.size[0]; D[o + 19] = e.size[1];
        D[o + 20] = e.param || 0; D[o + 21] = nn.x; D[o + 22] = nn.y; D[o + 23] = nn.z;
        this.cursor = (this.cursor + cnt) % this.cap; remaining -= cnt; k++;
      }
      if (k >= EMIT_MAX) break;
    }
    this.queue.length = 0;
    this.emitTex.needsUpdate = true;
    return k;
  }
  update(dt) {
    const k = this.pack();
    const u = this.updateMat.uniforms;
    u.t0.value = this.rtA.textures[0]; u.t1.value = this.rtA.textures[1]; u.t2.value = this.rtA.textures[2];
    u.uEmitCount.value = k; u.uFrameSeed.value = (this.frameSeed = (this.frameSeed + 1) % 997) * 0.618;
    syncFieldUniforms(u, dt);
    blit(this.updateMat, this.rtB);
    const t = this.rtA; this.rtA = this.rtB; this.rtB = t;
    this.bindRender();
  }
  bindRender() {
    const u = this.material.uniforms; u.tP0.value = this.rtA.textures[0]; u.tP1.value = this.rtA.textures[1]; u.tP2.value = this.rtA.textures[2];
  }
}
let VIEW_PSCALE = 1; // adaptive quality scales emission

function fieldUniforms() {
  return {
    uCurl: { value: TEX.curl }, uHeight: { value: TEX.height }, uHeightExt: { value: TEX.heightExt || 13 },
    uWind: { value: new THREE.Vector3() }, uGust: { value: 0.6 }, uTime: U.uTime, uDt: { value: 0 },
    uShock: { value: FIELD.shock }, uShock2: { value: FIELD.shock2 }, uVortex: { value: FIELD.vortex }, uVortex2: { value: FIELD.vortex2 }, uVortexY: { value: 0 },
    uRingC: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uRingN: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uRingP: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uAttract: { value: FIELD.attract },
  };
}
function syncFieldUniforms(u, dt) {
  u.uDt.value = dt; u.uWind.value.copy(WIND.base).multiplyScalar(WIND.strength); u.uGust.value = WIND.gust; u.uVortexY.value = FIELD.vortexY;
  u.uCurl.value = TEX.curl; u.uHeight.value = TEX.height;
  FIELD.rings.forEach((r, i) => { u.uRingC.value[i].set(r.c.x, r.c.y, r.c.z, r.r); u.uRingN.value[i].set(r.n.x, r.n.y, r.n.z, r.amt); u.uRingP.value[i].set(r.speed, r.compress, 0, 0); });
}

// ---- shared render shader pieces ---------------------------------------------------------------
const PARTICLE_VERT_HEAD = /* glsl */ `
uniform sampler2D tP0, tP1, tP2; uniform vec2 uPSize;
varying vec2 vQ; varying float vAge; varying float vLife; varying float vKind; varying float vSeed; varying float vParam; varying vec3 vWPos; varying float vViewZ; varying vec3 vVel;
bool fetchParticle(out vec4 a, out vec4 b, out vec4 c){
  ivec2 ij = ivec2(gl_InstanceID % int(uPSize.x), gl_InstanceID / int(uPSize.x));
  a = texelFetch(tP0, ij, 0); b = texelFetch(tP1, ij, 0); c = texelFetch(tP2, ij, 0);
  return b.w > 0.0 && a.w < b.w;
}
`;
const SOFT_FRAG = /* glsl */ `
uniform sampler2D uLinDepth, uWaterDepth; uniform vec2 uResolution; uniform float uSoft;
float softFade(float viewZ, float dist){
  vec2 suv = gl_FragCoord.xy / uResolution;
  float sd = texture2D(uLinDepth, suv).r;
  float wd = texture2D(uWaterDepth, suv).r; if (wd > 0.0) sd = min(sd, wd);
  return clamp((sd - viewZ) / dist, 0.0, 1.0);
}
`;
function particleMaterial({ vert, frag, blending = 'premult', order = 0, depthWrite = false, uniforms = {} }) {
  const m = new THREE.ShaderMaterial({
    uniforms: Object.assign({
      uLinDepth: U.uLinDepth, uWaterDepth: U.uWaterDepth, uResolution: U.uResolution, uSoft: { value: 1 }, uTime: U.uTime,
      uKeyDir: U.uKeyDir, uKeyColor: U.uKeyColor, uSkyZenith: U.uSkyZenith, uSkyHorizon: U.uSkyHorizon, uBB: { value: TEX.blackbody },
      uLightPos: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uLightCol: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uAmbCube: U.uAmbCube,
      uExposure: U.uExposure, uSceneCopy: U.uSceneCopy,
    }, uniforms),
    vertexShader: GLSL_COMMON + PARTICLE_VERT_HEAD + vert,
    fragmentShader: GLSL_COMMON + SOFT_FRAG + frag,
    transparent: true, depthWrite, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: blending === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  m.userData.order = order;
  PARTICLE_MATS.push(m);
  return m;
}
const PARTICLE_MATS = [];
// point lights that particles can use (fire-lit smoke, dust lit by impacts)
function syncParticleLights() {
  const pool = LIGHTS.pool;
  for (const m of PARTICLE_MATS) {
    for (let i = 0; i < 4; i++) {
      const l = pool[i];
      if (l && l.intensity > 0) { m.uniforms.uLightPos.value[i].set(l.position.x, l.position.y, l.position.z, l.distance || 12); m.uniforms.uLightCol.value[i].set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, 1); }
      else m.uniforms.uLightCol.value[i].set(0, 0, 0, 0);
    }
  }
}
const LIGHTING_GLSL = /* glsl */ `
uniform vec3 uKeyDir, uKeyColor, uSkyZenith, uSkyHorizon; uniform vec4 uLightPos[4], uLightCol[4]; uniform sampler2D uAmbCube;
vec3 ambCube(vec3 n){
  vec3 n2 = n * n;
  return n2.x * texelFetch(uAmbCube, ivec2(n.x > 0.0 ? 0 : 1, 0), 0).rgb + n2.y * texelFetch(uAmbCube, ivec2(n.y > 0.0 ? 2 : 3, 0), 0).rgb + n2.z * texelFetch(uAmbCube, ivec2(n.z > 0.0 ? 4 : 5, 0), 0).rgb;
}
vec3 litSprite(vec3 wpos, vec3 n, float thickness){
  float ndl = dot(n, uKeyDir) * 0.5 + 0.5;
  vec3 amb = ambCube(n);
  vec3 c = uKeyColor * ndl * mix(1.0, 0.35, thickness) + amb;
  for (int i = 0; i < 4; i++){
    if (uLightCol[i].w <= 0.0) continue;
    vec3 d = uLightPos[i].xyz - wpos; float dd = dot(d, d);
    c += uLightCol[i].rgb * (0.6 + 0.4 * max(dot(n, normalize(d)), 0.0)) / (dd + 0.35) * 0.25;
  }
  return c;
}
`;
