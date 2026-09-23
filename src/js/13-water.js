// §13 WATER — the pool (ripple heightfield, planar reflection), the living stream rendered as a
// screen-space fluid, the freeze into ice, the spear and its shatter, and droplets on the lens.
const WATER = {
  // beats (timeline seconds), matched to the choreography keys in §18
  t: { rise: 8.2, draw: 9.75, wrap: 10.5, coil: 13.45, whip: 13.86, reach: 14.08, freeze: 14.12, crack: 15.25, formed: 15.95, launch: 16.02, hit: 16.33 },
  N: 48, nodes: [], snap: true, frozenAt: null, spear: null, iceVis: 0, level: LAYOUT.pool.level,
  hitPoint: V3(), launchDir: V3(), spearBase: V3(), spearFlight: V3(), shattered: false,
};
for (let i = 0; i < WATER.N; i++) WATER.nodes.push({ p: V3(), v: V3(), g: V3(), r: 0, gr: 0, fz: V3() });

// ================================================================================================
// POOL: ripple heightfield + surface shading (refraction of the basin, planar reflection)
// ================================================================================================
const POOL = { mesh: null, a: null, b: null, simMat: null, acc: 0, drops: [], reflRT: null, reflCam: new THREE.PerspectiveCamera(), reflVP: new THREE.Matrix4(),
  clip: new THREE.Plane(V3(0, 1, 0), 0), sphere: new THREE.Sphere(), frustum: new THREE.Frustum(), inView: false, R: 128 };
function initPool() {
  const P = LAYOUT.pool, R = POOL.R;
  const opt = { type: SIM_TYPE, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  POOL.a = makeRT(R, R, opt); POOL.b = makeRT(R, R, opt);
  for (const rt of [POOL.a, POOL.b]) { renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); }
  renderer.setClearColor(0x000000, 1);
  POOL.simMat = fsMat(/* glsl */ `
    varying vec2 vUv; uniform sampler2D tPrev; uniform vec2 uTexel; uniform vec4 uDrops[8]; uniform int uDropN; uniform float uDamp;
    void main(){
      vec4 c = texture2D(tPrev, vUv);
      float n = texture2D(tPrev, vUv + vec2(uTexel.x, 0.0)).r + texture2D(tPrev, vUv - vec2(uTexel.x, 0.0)).r
              + texture2D(tPrev, vUv + vec2(0.0, uTexel.y)).r + texture2D(tPrev, vUv - vec2(0.0, uTexel.y)).r;
      float h = (n * 0.5 - c.g) * uDamp;
      for (int i = 0; i < 8; i++){ if (i >= uDropN) break; vec4 d = uDrops[i]; vec2 q = (vUv - d.xy) / d.z; h += d.w * exp(-dot(q, q) * 3.0); }
      vec2 e = vUv * 2.0 - 1.0; h *= smoothstep(1.0, 0.94, length(e));
      gl_FragColor = vec4(h, c.r, 0.0, 1.0);
    }`, { tPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / R, 1 / R) }, uDrops: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, uDropN: { value: 0 }, uDamp: { value: 0.986 } });
  const S = 1.03;
  const geo = new THREE.CircleGeometry(1, 120, 0, TAU); geo.rotateX(-Math.PI / 2);
  // add interior rings so the vertex displacement has something to move
  const ring = new THREE.RingGeometry(0.02, 1, 120, 28); ring.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tHeight: { value: POOL.a.texture }, tRefl: { value: blackTex }, uReflVP: { value: POOL.reflVP }, uHasRefl: { value: 0 },
      uSceneCopy: U.uSceneCopy, uLinDepth: U.uLinDepth, uResolution: U.uResolution, uSkyTex: U.uSkyTex, uTime: U.uTime,
      uKeyDir: U.uKeyDir, uKeyColor: U.uKeyColor, uSkyZenith: U.uSkyZenith, uSkyHorizon: U.uSkyHorizon,
      uTexW: { value: new THREE.Vector2(2 * P.a * S / R, 2 * P.b * S / R) }, uRot: { value: new THREE.Vector2(Math.cos(-P.rot), Math.sin(-P.rot)) },
      uStir: { value: 0 }, uStirC: { value: new THREE.Vector2(0.5, 0.5) },
    },
    vertexShader: GLSL_COMMON + /* glsl */ `
      uniform sampler2D tHeight; varying vec2 vUv; varying vec3 vWPos; varying float vViewZ;
      void main(){
        vUv = vec2(position.x, -position.z) * 0.5 + 0.5;
        float h = texture2D(tHeight, vUv).r;
        vec4 wp = modelMatrix * vec4(position, 1.0); wp.y += h;
        vWPos = wp.xyz; vec4 mv = viewMatrix * wp; vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLSL_COMMON + /* glsl */ `
      uniform sampler2D tHeight, tRefl, uSceneCopy, uLinDepth, uSkyTex; uniform mat4 uReflVP; uniform float uHasRefl, uTime, uStir;
      uniform vec2 uResolution, uTexW, uRot, uStirC; uniform vec3 uKeyDir, uKeyColor, uSkyZenith, uSkyHorizon;
      varying vec2 vUv; varying vec3 vWPos; varying float vViewZ;
      float wv(vec2 p){ return sp_vnoise2(p * 6.0 + uTime * vec2(0.55, 0.25)) * 0.6 + sp_vnoise2(p * 14.0 - uTime * vec2(0.35, 0.8)) * 0.4; }
      void main(){
        vec2 tx = vec2(1.0 / 128.0);
        float hL = texture2D(tHeight, vUv - vec2(tx.x, 0.0)).r, hR = texture2D(tHeight, vUv + vec2(tx.x, 0.0)).r;
        float hD = texture2D(tHeight, vUv - vec2(0.0, tx.y)).r, hU = texture2D(tHeight, vUv + vec2(0.0, tx.y)).r;
        vec2 g = vec2((hR - hL) / (2.0 * uTexW.x), (hU - hD) / (2.0 * uTexW.y));
        // local (u along a, v along b, v = -z) → world
        vec2 gl = vec2(g.x, -g.y);
        vec2 gw = vec2(gl.x * uRot.x - gl.y * uRot.y, gl.x * uRot.y + gl.y * uRot.x);
        // fine wind ripples
        vec2 p = vWPos.xz; float e = 0.01;
        float w0 = wv(p); vec2 wg = vec2(wv(p + vec2(e, 0.0)) - w0, wv(p + vec2(0.0, e)) - w0) / e * 0.0035;
        // stirring vortex while the column is drawn
        vec2 sc = vUv - uStirC; float sr = length(sc) + 1e-3;
        vec2 swirl = vec2(-sc.y, sc.x) / sr * sin(sr * 60.0 - uTime * 9.0) * exp(-sr * 7.0) * uStir * 0.25;
        vec3 N = normalize(vec3(-gw.x - wg.x - swirl.x, 1.0, -gw.y - wg.y - swirl.y));
        vec3 V = normalize(cameraPosition - vWPos);
        float NdV = max(dot(N, V), 0.0);
        float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
        vec3 refl;
        vec3 R = reflect(-V, N);
        vec3 skyR = texture2D(uSkyTex, sp_equirectUV(normalize(vec3(R.x, max(R.y, 0.02), R.z)))).rgb;
        if (uHasRefl > 0.5){
          vec4 rc = uReflVP * vec4(vWPos, 1.0); vec2 ruv = rc.xy / rc.w * 0.5 + 0.5; ruv += N.xz * 0.06;
          refl = texture2D(tRefl, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;
        } else refl = skyR;
        vec2 suv = gl_FragCoord.xy / uResolution;
        float sceneZ = texture2D(uLinDepth, suv).r;
        float depth = clamp(sceneZ - vViewZ, 0.0, 3.0) * max(NdV, 0.25);
        vec2 ruv2 = suv + N.xz * 0.05 * min(depth * 4.0, 1.0);
        float zc = texture2D(uLinDepth, ruv2).r; if (zc < vViewZ) ruv2 = suv;   // don't refract foreground in
        vec3 refr = texture2D(uSceneCopy, ruv2).rgb;
        vec3 absorb = exp(-depth * vec3(5.0, 1.7, 1.1) * 1.6);
        vec3 deep = (uSkyZenith * 0.6 + uSkyHorizon * 0.15) * vec3(0.12, 0.34, 0.38);
        refr = refr * absorb + deep * (1.0 - absorb);
        vec3 H = normalize(uKeyDir + V); float nh = max(dot(N, H), 0.0);
        float spec = pow(nh, 900.0) * 120.0 + pow(nh, 90.0) * 1.2;
        vec3 col = mix(refr, refl, F) + uKeyColor * spec * (0.2 + F);
        float shore = smoothstep(0.0, 0.025, depth / max(NdV, 0.25));
        gl_FragColor = vec4(col, shore);
      }`,
    transparent: true, depthWrite: false, depthTest: true,
  });
  POOL.mesh = new THREE.Mesh(ring, mat);
  POOL.mesh.scale.set(P.a * S, 1, P.b * S); POOL.mesh.rotation.y = -P.rot;
  POOL.mesh.position.set(P.x, P.level, P.z); POOL.mesh.renderOrder = 5; POOL.mesh.frustumCulled = false;
  fxScene.add(POOL.mesh);
  POOL.mat = mat;
  POOL.sphere.set(V3(P.x, P.level, P.z), Math.max(P.a, P.b) * 1.1);
  if (Q.reflect > 0) POOL.reflRT = makeRT(8, 8, { depthBuffer: true });
}
// world xz → pool sim uv
function poolUV(x, z, out = { u: 0, v: 0, e: 0 }) {
  const P = LAYOUT.pool, dx = x - P.x, dz = z - P.z, c = Math.cos(P.rot), s = Math.sin(P.rot), S = 1.03;
  const lu = (dx * c + dz * s) / (P.a * S), lv = (-dx * s + dz * c) / (P.b * S);
  out.u = lu * 0.5 + 0.5; out.v = lv * 0.5 + 0.5; out.e = Math.hypot(lu, lv); return out;
}
function poolDrop(x, z, radius, strength) {
  const q = poolUV(x, z); if (q.e > 0.97) return;
  if (POOL.drops.length < 8) POOL.drops.push([q.u, q.v, radius / (LAYOUT.pool.a * 2), strength]);
}
function stepPool(dt) {
  POOL.acc += dt; let steps = 0;
  const m = POOL.simMat.uniforms;
  while (POOL.acc > 1 / 60 && steps < 4) {
    POOL.acc -= 1 / 60; steps++;
    const n = steps === 1 ? POOL.drops.length : 0;
    for (let i = 0; i < n; i++) m.uDrops.value[i].set(...POOL.drops[i]);
    m.uDropN.value = n; m.tPrev.value = POOL.a.texture;
    blit(POOL.simMat, POOL.b); const t = POOL.a; POOL.a = POOL.b; POOL.b = t;
  }
  if (steps) POOL.drops.length = 0;
  POOL.mat.uniforms.tHeight.value = POOL.a.texture;
}
// planar reflection: the real world seen from the eye mirrored below the waterline
function renderPoolReflection(cam) {
  POOL.mat.uniforms.uHasRefl.value = 0;
  if (!POOL.reflRT || !Q.reflect) return;
  _m1.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); POOL.frustum.setFromProjectionMatrix(_m1);
  POOL.inView = POOL.frustum.intersectsSphere(POOL.sphere) && cam.position.y > POOL.mesh.position.y;
  if (!POOL.inView) return;
  const w = Math.max(64, Math.round(VIEW.rw * Q.reflect)), h = Math.max(64, Math.round(VIEW.rh * Q.reflect));
  if (POOL.reflRT.width !== w || POOL.reflRT.height !== h) POOL.reflRT.setSize(w, h);
  const L = POOL.mesh.position.y, rc = POOL.reflCam;
  rc.fov = cam.fov; rc.aspect = cam.aspect; rc.near = cam.near; rc.far = cam.far;
  rc.position.set(cam.position.x, 2 * L - cam.position.y, cam.position.z);
  const f = _v1.set(0, 0, -1).applyQuaternion(cam.quaternion); f.y = -f.y;
  const up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion); up.y = -up.y;
  rc.up.copy(up); rc.lookAt(_v3.copy(rc.position).add(f)); rc.updateMatrixWorld();
  rc.projectionMatrix.copy(cam.projectionMatrix); rc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
  POOL.reflVP.multiplyMatrices(rc.projectionMatrix, rc.matrixWorldInverse);
  renderer.setRenderTarget(POOL.reflRT); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, false);
  drawSkyBackground(rc, POOL.reflRT);
  const prevClip = renderer.clippingPlanes, prevSM = renderer.shadowMap.autoUpdate;
  renderer.clippingPlanes = [POOL.clip.set(_v4.set(0, 1, 0), -(L - 0.01))]; renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(POOL.reflRT); renderer.render(world, rc);
  renderer.clippingPlanes = prevClip; renderer.shadowMap.autoUpdate = prevSM;
  POOL.mat.uniforms.tRefl.value = POOL.reflRT.texture; POOL.mat.uniforms.uHasRefl.value = 1;
}

// ================================================================================================
// SCREEN-SPACE FLUID: sphere impostors → view depth + thickness → bilateral smoothing → shading
// ================================================================================================
const SSF = { max: 900, n: 0, depthRT: null, thickRT: null, blurA: null, blurB: null, depthScene: new THREE.Scene(), thickScene: new THREE.Scene(), geo: null, spray: [] };
function ssfBlob(p, r, foam = 0) {
  if (SSF.n >= SSF.max || r < 0.004) return;
  const i = SSF.n++; SSF.geo.attributes.aBlob.setXYZW(i, p.x, p.y, p.z, r); SSF.geo.attributes.aFoam.setX(i, foam);
}
function initSSF() {
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); ig.setIndex([0, 1, 2, 0, 2, 3]);
  ig.setAttribute('aBlob', new THREE.InstancedBufferAttribute(new Float32Array(SSF.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.setAttribute('aFoam', new THREE.InstancedBufferAttribute(new Float32Array(SSF.max), 1).setUsage(THREE.DynamicDrawUsage));
  ig.instanceCount = 0; SSF.geo = ig;
  const vert = GLSL_COMMON + /* glsl */ `attribute vec4 aBlob; attribute float aFoam; varying vec2 vQ; varying vec3 vC; varying float vR, vFoam;
    void main(){ vec4 c = viewMatrix * vec4(aBlob.xyz, 1.0); vC = c.xyz; vR = aBlob.w; vFoam = aFoam;
      vec4 mv = c; mv.xy += position.xy * aBlob.w * 1.05; vQ = position.xy * 1.05; gl_Position = projectionMatrix * mv; }`;
  const depthMat = new THREE.ShaderMaterial({ vertexShader: vert, depthTest: true, depthWrite: true,
    fragmentShader: /* glsl */ `uniform mat4 projectionMatrix; varying vec2 vQ; varying vec3 vC; varying float vR, vFoam;
      void main(){ float r2 = dot(vQ, vQ); if (r2 > 1.0) discard; vec3 p = vC + vec3(vQ * vR, sqrt(1.0 - r2) * vR);
        vec4 cp = projectionMatrix * vec4(p, 1.0); gl_FragDepth = cp.z / cp.w * 0.5 + 0.5; gl_FragColor = vec4(-p.z, 0.0, 0.0, 1.0); }` });
  const thickMat = new THREE.ShaderMaterial({ vertexShader: vert, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    fragmentShader: /* glsl */ `varying vec2 vQ; varying vec3 vC; varying float vR, vFoam;
      void main(){ float r2 = dot(vQ, vQ); if (r2 > 1.0) discard; float t = 2.0 * sqrt(1.0 - r2) * vR; gl_FragColor = vec4(t, t * vFoam, 0.0, 0.0); }` });
  const m1 = new THREE.Mesh(ig, depthMat), m2 = new THREE.Mesh(ig, thickMat); m1.frustumCulled = m2.frustumCulled = false;
  SSF.depthScene.add(m1); SSF.thickScene.add(m2);
  const nearest = { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  if (!CAPS.floatRT) nearest.type = THREE.HalfFloatType;
  SSF.depthRT = makeRT(8, 8, Object.assign({ depthBuffer: true }, nearest));
  SSF.blurA = makeRT(8, 8, nearest); SSF.blurB = makeRT(8, 8, nearest);
  SSF.thickRT = makeRT(8, 8, { format: THREE.RGFormat });
  SSF.blurMat = fsMat(/* glsl */ `
    varying vec2 vUv; uniform sampler2D tD; uniform vec2 uDir; uniform float uWorldPx;
    void main(){
      float z = texture2D(tD, vUv).r; if (z <= 0.0){ gl_FragColor = vec4(0.0); return; }
      float rad = clamp(uWorldPx * 0.05 / z, 1.0, 14.0);
      float sum = 0.0, wsum = 0.0;
      for (int i = -7; i <= 7; i++){
        float x = float(i) / 7.0; vec2 uv = vUv + uDir * x * rad;
        float s = texture2D(tD, uv).r; if (s <= 0.0) continue;
        float dz = (s - z) / (0.06 + z * 0.004);
        float w = exp(-x * x * 2.0) * exp(-dz * dz);
        sum += s * w; wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-5), 0.0, 0.0, 1.0);
    }`, { tD: { value: null }, uDir: { value: new THREE.Vector2() }, uWorldPx: { value: 500 } });
  SSF.compMat = fsMat(/* glsl */ `
    varying vec2 vUv; uniform sampler2D tD, tT, uSceneCopy, uLinDepth, uSkyTex, uAmbCube; uniform mat4 uInvProj, uCamWorld, uProj; uniform vec2 uTexel;
    uniform vec3 uKeyDir, uKeyColor, uSkyZenith, uSkyHorizon; uniform float uTime;
    vec3 vpos(vec2 uv, float z){ vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); vec3 d = p.xyz / p.w; return d * (z / -d.z); }
    // bilinear depth that ignores empty texels (the fluid texture is lower resolution than the frame)
    float zAt(vec2 uv, out float cover){
      vec2 px = uv / uTexel - 0.5; vec2 f = fract(px); vec2 b = (floor(px) + 0.5) * uTexel;
      vec4 z = vec4(texture2D(tD, b).r, texture2D(tD, b + vec2(uTexel.x, 0.0)).r, texture2D(tD, b + vec2(0.0, uTexel.y)).r, texture2D(tD, b + uTexel).r);
      vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) * step(1e-4, z);
      cover = dot(w, vec4(1.0)); return cover > 1e-4 ? dot(w, z) / cover : 0.0;
    }
    void main(){
      float cover; float z = zAt(vUv, cover); vec2 th = texture2D(tT, vUv).rg;
      if (z <= 0.0 || cover < 0.35 || th.r < 0.003) discard;
      float zs = texture2D(uLinDepth, vUv).r; if (z > zs + 0.02) discard;
      vec3 P = vpos(vUv, z);
      vec2 ox = vec2(uTexel.x, 0.0) * 0.75, oy = vec2(0.0, uTexel.y) * 0.75; float cv;
      float zr = zAt(vUv + ox, cv), zl = zAt(vUv - ox, cv), zu = zAt(vUv + oy, cv), zd = zAt(vUv - oy, cv);
      vec3 dx = (zr > 0.0 && (zl <= 0.0 || abs(zr - z) < abs(zl - z))) ? vpos(vUv + ox, zr) - P : (zl > 0.0 ? P - vpos(vUv - ox, zl) : vec3(1e-3, 0.0, 0.0));
      vec3 dy = (zu > 0.0 && (zd <= 0.0 || abs(zu - z) < abs(zd - z))) ? vpos(vUv + oy, zu) - P : (zd > 0.0 ? P - vpos(vUv - oy, zd) : vec3(0.0, 1e-3, 0.0));
      vec3 N = normalize(cross(dx, dy)); if (N.z < 0.0) N = -N;
      vec3 V = normalize(-P);
      vec3 Nw = normalize(mat3(uCamWorld) * N), Vw = normalize(mat3(uCamWorld) * V);
      float thick = th.r, foam = clamp(th.g / max(th.r, 1e-4), 0.0, 1.0);
      float NdV = max(dot(N, V), 0.0);
      float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
      vec2 ruv = vUv - N.xy * 0.075 * min(thick * 8.0, 1.0) * (1.0 / max(z * 0.35, 1.0));
      if (texture2D(uLinDepth, ruv).r < z) ruv = vUv;
      vec3 refr = texture2D(uSceneCopy, ruv).rgb;
      vec3 absorb = exp(-thick * vec3(1.7, 0.55, 0.36) * 1.5);
      vec3 amb = texelFetch(uAmbCube, ivec2(2, 0), 0).rgb;
      vec3 body = (amb * 0.8 + uKeyColor * 0.05) * vec3(0.3, 0.62, 0.66);
      refr = refr * absorb + body * (1.0 - absorb);
      vec3 R = reflect(-Vw, Nw);
      vec3 env = texture2D(uSkyTex, sp_equirectUV(normalize(vec3(R.x, abs(R.y) * 0.9 + 0.04, R.z)))).rgb;
      vec3 H = normalize(uKeyDir + Vw); float nh = max(dot(Nw, H), 0.0);
      float spec = pow(nh, 600.0) * 60.0 + pow(nh, 60.0) * 0.8;
      vec3 col = mix(refr, env, F) + uKeyColor * spec;
      col += (amb * 0.8 + uKeyColor * 0.12) * pow(1.0 - NdV, 3.0) * 0.35;      // bright silhouette of a curved liquid surface
      // aerated white water where the stream tears
      vec3 foamCol = (amb * 1.1 + uKeyColor * (0.3 + 0.4 * max(dot(Nw, uKeyDir), 0.0))) * 0.95;
      float fn = sp_vnoise2(gl_FragCoord.xy * 0.02 + uTime * 2.0);
      col = mix(col, foamCol, clamp(foam * (0.5 + 0.8 * fn), 0.0, 0.7));
      float a = smoothstep(0.003, 0.03, thick) * smoothstep(0.35, 0.8, cover);
      vec4 cp = uProj * vec4(P, 1.0); gl_FragDepth = cp.z / cp.w * 0.5 + 0.5;
      gl_FragColor = vec4(col, a);
    }`, { uProj: { value: new THREE.Matrix4() }, uAmbCube: U.uAmbCube, tD: { value: null }, tT: { value: null }, uSceneCopy: U.uSceneCopy, uLinDepth: U.uLinDepth, uSkyTex: U.uSkyTex,
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() },
    uKeyDir: U.uKeyDir, uKeyColor: U.uKeyColor, uSkyZenith: U.uSkyZenith, uSkyHorizon: U.uSkyHorizon, uTime: U.uTime },
  { blending: THREE.NormalBlending, transparent: true, depthTest: true, depthWrite: true });
  U.uWaterDepth.value = blackTex;
}
function resizeWaterSSF(w, h) {
  if (!SSF.depthRT) return;
  const s = Q.ssfRes, sw = Math.max(8, Math.round(w * s)), sh = Math.max(8, Math.round(h * s));
  for (const rt of [SSF.depthRT, SSF.blurA, SSF.blurB, SSF.thickRT]) rt.setSize(sw, sh);
}
function renderWaterSSF(cam, rt) {
  SSF.geo.instanceCount = SSF.n;
  if (!SSF.n) { U.uWaterDepth.value = blackTex; return; }
  SSF.geo.attributes.aBlob.needsUpdate = SSF.geo.attributes.aFoam.needsUpdate = true;
  if (SSF.depthRT.width < 16) resizeWaterSSF(VIEW.rw, VIEW.rh);
  renderer.setRenderTarget(SSF.depthRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, false);
  renderer.render(SSF.depthScene, cam);
  renderer.setRenderTarget(SSF.thickRT); renderer.clear(true, false, false);
  renderer.render(SSF.thickScene, cam);
  renderer.setClearColor(0x000000, 1);
  const b = SSF.blurMat.uniforms, W = SSF.depthRT.width, H = SSF.depthRT.height;
  b.uWorldPx.value = H / (2 * Math.tan(cam.fov * DEG / 2));
  let src = SSF.depthRT;
  for (let it = 0; it < 2; it++) {
    b.tD.value = src.texture; b.uDir.value.set(1 / W, 0); blit(SSF.blurMat, SSF.blurA);
    b.tD.value = SSF.blurA.texture; b.uDir.value.set(0, 1 / H); blit(SSF.blurMat, SSF.blurB);
    src = SSF.blurB;
  }
  const c = SSF.compMat.uniforms;
  c.tD.value = SSF.blurB.texture; c.tT.value = SSF.thickRT.texture; c.uTexel.value.set(1 / W, 1 / H);
  c.uInvProj.value.copy(cam.projectionMatrixInverse); c.uProj.value.copy(cam.projectionMatrix); c.uCamWorld.value.copy(cam.matrixWorld);
  blit(SSF.compMat, rt);
  U.uWaterDepth.value = SSF.blurB.texture;
}

// ================================================================================================
// ICE: the frozen stream (faceted tube), spear, shards
// ================================================================================================
const ICE = { mesh: null, geo: null, M: 80, S: 7, front: 0, frost: 0, mat: null, shards: null, jitter: null };
function iceMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uSceneCopy: U.uSceneCopy, uResolution: U.uResolution, uSkyTex: U.uSkyTex, uKeyDir: U.uKeyDir, uKeyColor: U.uKeyColor,
      uSkyZenith: U.uSkyZenith, uSkyHorizon: U.uSkyHorizon, uAmbCube: U.uAmbCube, uNoise: { value: TEX.cloudNoise }, uFrost: { value: 0.3 }, uFront: { value: -1 } },
    vertexShader: GLSL_COMMON + /* glsl */ `attribute float aS; varying vec3 vWPos, vLocal; varying float vS;
      void main(){ vec4 lp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          lp = instanceMatrix * lp;
        #endif
        vec4 wp = modelMatrix * lp; vWPos = wp.xyz; vLocal = position * 5.0 + aS * 3.0; vS = aS;
        gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: GLSL_COMMON + /* glsl */ `
      uniform sampler2D uSceneCopy, uSkyTex, uAmbCube; uniform vec2 uResolution; uniform vec3 uKeyDir, uKeyColor, uSkyZenith, uSkyHorizon;
      uniform highp sampler3D uNoise; uniform float uFrost, uFront;
      varying vec3 vWPos, vLocal; varying float vS;
      void main(){
        vec3 N = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
        vec3 V = normalize(cameraPosition - vWPos); if (dot(N, V) < 0.0) N = -N;
        float NdV = max(dot(N, V), 0.0);
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec3 Nv = (viewMatrix * vec4(N, 0.0)).xyz;
        vec3 refr = texture2D(uSceneCopy, clamp(suv - Nv.xy * 0.06, vec2(0.001), vec2(0.999))).rgb;
        float fr = texture(uNoise, vLocal * 0.21).g; float crack = smoothstep(0.74, 0.77, fr) - smoothstep(0.77, 0.8, fr);
        float bub = smoothstep(0.82, 0.9, texture(uNoise, vLocal * 0.9 + 3.0).b);
        vec3 R = reflect(-V, N);
        vec3 env = texture2D(uSkyTex, sp_equirectUV(normalize(vec3(R.x, abs(R.y) * 0.85 + 0.05, R.z)))).rgb;
        float F = 0.03 + 0.97 * pow(1.0 - NdV, 4.0);
        vec3 H = normalize(uKeyDir + V); float nh = max(dot(N, H), 0.0);
        float spec = pow(nh, 260.0) * 30.0 + pow(nh, 30.0) * 0.4;
        vec3 tint = vec3(0.8, 0.92, 1.0);
        vec3 amb = texelFetch(uAmbCube, ivec2(2, 0), 0).rgb;
        vec3 col = refr * tint * (0.75 + 0.2 * NdV) + env * F + uKeyColor * spec + amb * 0.35 * (1.0 - NdV);
        col += (amb * 1.5 + uKeyColor * 0.3) * (crack * 0.8 + bub * 0.3);
        float fn = texture(uNoise, vLocal * 0.55).r;
        float frontGlow = uFront > -0.5 ? smoothstep(0.14, 0.0, abs(vS - uFront)) : 0.0;
        float frost = clamp(uFrost * smoothstep(0.35, 0.75, fn + (1.0 - NdV) * 0.45) + frontGlow * 0.9, 0.0, 1.0);
        vec3 frostCol = (amb * 1.1 + uKeyColor * (0.2 + 0.55 * max(dot(N, uKeyDir), 0.0))) * vec3(0.95, 0.98, 1.0);
        col = mix(col, frostCol, frost * 0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
function initIce() {
  const M = ICE.M, S = ICE.S;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((M * S + 2) * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const aS = new Float32Array(M * S + 2);
  for (let i = 0; i < M; i++) for (let j = 0; j < S; j++) aS[i * S + j] = i / (M - 1);
  aS[M * S] = 0; aS[M * S + 1] = 1;
  g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
  const idx = [];
  for (let i = 0; i < M - 1; i++) for (let j = 0; j < S; j++) {
    const a = i * S + j, b = i * S + (j + 1) % S, c = (i + 1) * S + j, d = (i + 1) * S + (j + 1) % S;
    idx.push(a, c, b, b, c, d);
  }
  for (let j = 0; j < S; j++) { idx.push(M * S, (j + 1) % S, j); idx.push(M * S + 1, (M - 1) * S + j, (M - 1) * S + (j + 1) % S); }
  g.setIndex(idx);
  ICE.geo = g; ICE.mat = iceMaterial();
  ICE.mesh = new THREE.Mesh(g, ICE.mat); ICE.mesh.frustumCulled = false; ICE.mesh.renderOrder = 2; ICE.mesh.visible = false; ICE.mesh.castShadow = true;
  fxScene.add(ICE.mesh);
  const r = new RNG(404); ICE.jitter = new Float32Array(M * S); for (let i = 0; i < M * S; i++) ICE.jitter[i] = r.f(0.86, 1.12);
  // shards (instanced, same shader)
  const shardMat = iceMaterial(); shardMat.uniforms.uFrost.value = 0.45;
  const geos = [chunkGeometry(71, 0.5, 1.6, 0.4), chunkGeometry(72, 0.35, 1.1, 0.5), chunkGeometry(73, 0.6, 0.9, 0.3), chunkGeometry(74, 0.3, 2.0, 0.3)];
  for (const gg of geos) { const n = gg.attributes.position.count; gg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(n).fill(0.5), 1)); }
  ICE.shards = new RigidPool('ice', geos, shardMat, 72, { restitution: 0.18, friction: 0.35, spinDamp: 0.85, shadows: false });
  for (const m of ICE.shards.meshes) { world.remove(m); fxScene.add(m); m.renderOrder = 2; }
}
// write the tube along a polyline of points with radii
const _ta = V3(), _tn = V3(), _tb = V3(), _tp = V3();
function writeIceTube(pts, radii) {
  const M = ICE.M, S = ICE.S, pos = ICE.geo.attributes.position.array, n = pts.length;
  let prevN = null;
  for (let i = 0; i < M; i++) {
    const f = (i / (M - 1)) * (n - 1), k = Math.min(n - 2, Math.floor(f)), t = f - k;
    _tp.copy(pts[k]).lerp(pts[k + 1], t); const r = lerp(radii[k], radii[k + 1], t);
    _ta.copy(pts[k + 1]).sub(pts[k]); if (_ta.lengthSq() < 1e-10) _ta.set(0, 1, 0); _ta.normalize();
    if (!prevN) { _tn.set(0, 1, 0); if (Math.abs(_ta.y) > 0.9) _tn.set(1, 0, 0); _tn.sub(_v1.copy(_ta).multiplyScalar(_tn.dot(_ta))).normalize(); }
    else { _tn.copy(prevN).sub(_v1.copy(_ta).multiplyScalar(prevN.dot(_ta))).normalize(); }
    prevN = prevN || V3(); prevN.copy(_tn);
    _tb.crossVectors(_ta, _tn);
    for (let j = 0; j < S; j++) {
      const a = (j / S) * TAU + i * 0.12, rr = r * ICE.jitter[i * S + j];
      const o = (i * S + j) * 3;
      pos[o] = _tp.x + (_tn.x * Math.cos(a) + _tb.x * Math.sin(a)) * rr;
      pos[o + 1] = _tp.y + (_tn.y * Math.cos(a) + _tb.y * Math.sin(a)) * rr;
      pos[o + 2] = _tp.z + (_tn.z * Math.cos(a) + _tb.z * Math.sin(a)) * rr;
    }
  }
  const e0 = M * S * 3; pos[e0] = pts[0].x; pos[e0 + 1] = pts[0].y; pos[e0 + 2] = pts[0].z;
  pos[e0 + 3] = pts[n - 1].x; pos[e0 + 4] = pts[n - 1].y; pos[e0 + 5] = pts[n - 1].z;
  ICE.geo.attributes.position.needsUpdate = true;
  ICE.geo.computeBoundingSphere();
}

// ================================================================================================
// LENS DROPS: refractive droplets painted into a small texture, applied in the final grade
// ================================================================================================
const DROPS = { rt: null, list: [], mesh: null, scene: new THREE.Scene(), cam: new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1), shot: -1, max: 48 };
function initLensDrops() {
  DROPS.rt = makeRT(384, 216);
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); ig.setIndex([0, 1, 2, 0, 2, 3]);
  ig.setAttribute('aD', new THREE.InstancedBufferAttribute(new Float32Array(DROPS.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAspect: { value: 1 } },
    vertexShader: /* glsl */ `attribute vec4 aD; uniform float uAspect; varying vec2 vQ; varying float vA;
      void main(){ vQ = position.xy; vA = aD.w; vec2 p = aD.xy + position.xy * vec2(aD.z / uAspect, aD.z * (1.0 + 0.25 * position.y * position.y)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `varying vec2 vQ; varying float vA;
      void main(){ vec2 q = vQ; q.y += 0.12 * (1.0 - q.x * q.x); float r2 = dot(q, q); if (r2 > 1.0) discard;
        float hgt = sqrt(1.0 - r2); vec2 o = -q * hgt * 0.55; float m = smoothstep(1.0, 0.8, sqrt(r2)) * vA;
        gl_FragColor = vec4(0.5 + o * 0.5, m, m); }`,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  DROPS.mesh = new THREE.Mesh(ig, mat); DROPS.mesh.frustumCulled = false; DROPS.scene.add(DROPS.mesh);
  POST.dropsTex = DROPS.rt.texture;
}
function lensSplash(n = 14, cx = 0.5, cy = 0.55, spread = 0.35) {
  for (let i = 0; i < n; i++) {
    if (DROPS.list.length >= DROPS.max) DROPS.list.shift();
    const a = Math.random() * TAU, d = Math.pow(Math.random(), 0.7) * spread;
    DROPS.list.push({ x: cx + Math.cos(a) * d * 1.2, y: cy + Math.sin(a) * d, r: 0.007 + Math.pow(Math.random(), 4) * 0.03, age: 0, life: 2.2 + Math.random() * 2.5, vy: 0 });
  }
}
function updateLensDrops(realDt) {
  if (CAM.shotIndex !== DROPS.shot) { DROPS.list.length = 0; DROPS.shot = CAM.shotIndex; }
  const L = DROPS.list;
  for (const d of L) { d.age += realDt; if (d.r > 0.03) { d.vy = Math.min(d.vy + realDt * 0.02 * d.r * 30, 0.05); d.y -= d.vy * realDt; } }
  for (let i = L.length - 1; i >= 0; i--) if (L[i].age > L[i].life) L.splice(i, 1);
  POST.grade.drops = L.length && !REDUCED_MOTION ? 1 : 0;
  if (!L.length) return;
  const a = DROPS.mesh.geometry.attributes.aD;
  L.forEach((d, i) => a.setXYZW(i, d.x, d.y, d.r, 1 - smoothstep(d.life - 0.8, d.life, d.age)));
  a.needsUpdate = true; DROPS.mesh.geometry.instanceCount = L.length;
  DROPS.mesh.material.uniforms.uAspect.value = VIEW.aspect;
  renderer.setRenderTarget(DROPS.rt); renderer.setClearColor(0x808000, 0); renderer.clear(true, false, false); renderer.setClearColor(0x000000, 1);
  renderer.render(DROPS.scene, DROPS.cam);
}

// ================================================================================================
// THE STREAM: a guided rope of water. Each node chases a choreographed target with a damped
// spring; the target path morphs column → arc → wrap → coil → whip, then freezes.
// ================================================================================================
const _bz = [V3(), V3(), V3(), V3()];
function bez3(a, b, c, d, t, out) {
  const u = 1 - t; return out.set(0, 0, 0).addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * t).addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
}
function waterPhaseWeights(T) {
  const t = WATER.t;
  const arc = 1 - smoothstep(t.wrap - 0.1, t.wrap + 0.45, T);
  const coil = smoothstep(t.coil - 0.1, t.coil + 0.2, T) * (1 - smoothstep(t.whip - 0.02, t.whip + 0.06, T));
  const whip = smoothstep(t.whip - 0.02, t.whip + 0.06, T);
  const wrap = Math.max(0, 1 - arc - coil - whip);
  return { arc, wrap, coil, whip };
}
function toP1Dir(from, out) { return out.set(LOC.P1.x - from.x, 0, LOC.P1.z - from.z).normalize(); }
const _wa = V3(), _wb = V3(), _wc = V3(), _wd = V3(), _we = V3(), _wf = V3();
// target position and radius of node u∈[0,1] (0 = head/leading tip, 1 = tail)
function waterTarget(u, T, out) {
  const t = WATER.t, P = LAYOUT.pool;
  const w = waterPhaseWeights(T);
  const F = FIG.p.hips, palms = FIG.palms;
  let r = 0;
  out.set(0, 0, 0);
  if (w.arc > 0) {
    const A = _wa.set(P.x, WATER.level, P.z), B = _wb.set(P.x, WATER.level + 2.9, P.z);
    const toFig = _we.set(F.x - P.x, 0, F.z - P.z).normalize();
    const C = _wc.copy(palms).addScaledVector(toFig, -1.4).setY(palms.y + 1.6), D = _wd.copy(palms);
    const rise = Ease.outCubic(clamp((T - t.rise) / 1.35));
    const draw = Ease.inOutSine(clamp((T - t.draw) / (t.wrap + 0.35 - t.draw)));
    const s1 = lerp(0.36 * rise, 1.0, draw), s0 = lerp(0, 0.7, Ease.inQuad(draw));
    const s = lerp(s1, s0, u);
    bez3(A, B, C, D, s, _wf);
    // the column twists as it climbs
    const sw = (0.05 + 0.05 * (1 - u)) * (1 - draw) * rise;
    _wf.x += Math.cos(T * 5 + u * 9) * sw; _wf.z += Math.sin(T * 5 + u * 9) * sw;
    out.addScaledVector(_wf, w.arc);
    const rr = lerp(lerp(0.17, 0.32, Math.pow(u, 1.6)), lerp(0.12, 0.09, u), draw) * (0.25 + 0.75 * rise);
    r += rr * w.arc;
  }
  if (w.wrap > 0) {
    const ph = (T - t.wrap) * 3.0 + 0.6;
    const ang = -ph - u * 5.2 + (CHAR.pose.yaw || 0) * DEG * 0.4;
    const rad = 0.66 + 0.2 * u + 0.05 * Math.sin(T * 3 + u * 7);
    _wf.set(F.x + Math.sin(ang) * rad, 1.02 + 0.36 * Math.sin(ang * 0.9 + 1.2 + T * 0.8) - 0.18 * u, F.z + Math.cos(ang) * rad);
    // the head is carried by the hands
    const hk = (1 - smoothstep(0, 0.22, u)) * 0.75;
    _wf.lerp(palms, hk);
    out.addScaledVector(_wf, w.wrap);
    r += (0.1 - 0.025 * u) * w.wrap;
  }
  if (w.coil > 0) {
    const d = toP1Dir(F, _we);
    const c = _wa.copy(F).addScaledVector(d, -0.42).setY(0.98);
    const ang = -(T - t.coil) * 14.0 - u * 9.4;
    const rad = 0.3 + 0.16 * u;
    _wf.set(c.x + Math.sin(ang) * rad, c.y + (u - 0.5) * 0.3 + Math.sin(ang) * 0.1, c.z + Math.cos(ang) * rad);
    _wf.lerp(palms, (1 - smoothstep(0, 0.18, u)) * 0.8);
    out.addScaledVector(_wf, w.coil);
    r += (0.1 - 0.02 * u) * w.coil;
  }
  if (w.whip > 0) {
    const d = toP1Dir(F, _we); const side = _wd.set(d.z, 0, -d.x);
    const k = Ease.outCubic(clamp((T - t.whip) / (t.reach - t.whip)));
    const L = 2.62 * k;
    const along = (1 - u) * L;
    _wf.copy(palms).addScaledVector(d, along).addScaledVector(side, 0.28 * (1 - u) * k);
    _wf.y = lerp(palms.y, 1.3, (1 - u) * k) + Math.sin((1 - u) * Math.PI) * 0.12;
    // travelling S-wave that dies as the whip straightens
    const amp = 0.22 * (1 - k) + 0.02;
    const wv = Math.sin(u * 9.0 - (T - t.whip) * 38.0) * amp * Math.sin(u * Math.PI);
    _wf.addScaledVector(side, wv); _wf.y += wv * 0.5;
    out.addScaledVector(_wf, w.whip);
    r += lerp(0.07, 0.1, u) * (0.9 + 0.2 * Math.sin(u * 20 - T * 30)) * w.whip;
  }
  return r;
}

function spearFrame(T) {
  // spear axis at the moment it forms: from beside the palms toward the ice target
  const S = WATER.spear;
  const F = FIG.p.hips, palms = FIG.palms;
  if (!S.fixed) {
    const d = S.dir.copy(WATER.hitPoint).sub(palms).normalize();
    S.base.copy(palms).addScaledVector(d, 0.18);
  }
  return S;
}

function updateWater(T, dt) {
  const t = WATER.t;
  WATER.level = LAYOUT.pool.level - 0.035 * smoothstep(t.rise, t.wrap, T);
  POOL.mesh.position.y = WATER.level;
  if (dt > 0) stepPool(dt);
  // stirring vortex in the pool while the column is attached
  const attached = smoothstep(t.rise - 0.2, t.rise + 0.4, T) * (1 - smoothstep(t.draw + 0.3, t.wrap, T));
  POOL.mat.uniforms.uStir.value = attached;
  if (attached > 0.01 && dt > 0 && Math.random() < 0.6) {
    const a = T * 7 + Math.random(); const rr = 0.25 + Math.random() * 0.25;
    poolDrop(LAYOUT.pool.x + Math.cos(a) * rr, LAYOUT.pool.z + Math.sin(a) * rr, 0.14, -0.0035 * attached);
  }
  // gentle ambient wind ripples
  if (dt > 0 && Math.random() < dt * 1.5) { const q = LAYOUT.pool; poolDrop(q.x + (Math.random() - 0.5) * q.a * 1.4, q.z + (Math.random() - 0.5) * q.b * 1.4, 0.05, 0.0012); }

  // ---- stream ----
  SSF.n = 0; ICE.mesh.visible = false;
  const live = T > t.rise - 0.05 && T < t.hit + 0.02;
  if (!live) { WATER.snap = true; WATER.frozenAt = null; return; }
  const N = WATER.N, nodes = WATER.nodes;
  const freezeT = t.freeze;
  const frozen = T >= freezeT;
  if (!WATER.hitPoint.lengthSq()) {
    const P1 = LAYOUT.pillars[0]; const d = V3(P1.x, 0, P1.z).normalize();
    WATER.hitPoint.set(P1.x - d.x * P1.r * 0.98, 1.38, P1.z - d.z * P1.r * 0.98);
  }
  if (!frozen) {
    WATER.frozenAt = null;
    for (let i = 0; i < N; i++) { const nd = nodes[i]; nd.gr = waterTarget(i / (N - 1), T, nd.g); }
    if (WATER.snap || dt <= 0) { for (const nd of nodes) { if (WATER.snap) { nd.p.copy(nd.g); nd.v.set(0, 0, 0); nd.r = nd.gr; } } WATER.snap = false; }
    if (dt > 0) {
      const w = waterPhaseWeights(T);
      const om = lerp(lerp(16, 11, w.wrap), 48, w.whip + w.coil * 0.5), ze = 0.62;
      const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / sub;
      for (let s = 0; s < sub; s++) for (let i = 0; i < N; i++) {
        const nd = nodes[i]; const u = i / (N - 1);
        const o = om * (1 - 0.35 * u);
        nd.v.x += (o * o * (nd.g.x - nd.p.x) - 2 * ze * o * nd.v.x) * h;
        nd.v.y += (o * o * (nd.g.y - nd.p.y) - 2 * ze * o * nd.v.y) * h;
        nd.v.z += (o * o * (nd.g.z - nd.p.z) - 2 * ze * o * nd.v.z) * h;
        nd.p.addScaledVector(nd.v, h);
      }
      for (const nd of nodes) nd.r = damp(nd.r, nd.gr, 18, dt);
      // spray: droplets shed where the stream moves fast
      const spd = [];
      for (let i = 0; i < N; i += 3) {
        const nd = nodes[i]; const v = nd.v.length(); spd.push(v);
        if (nd.r < 0.02) continue;
        const cnt = rate(Math.max(0, v - 1.5) * 9 + (T < t.draw ? 6 : 0), dt);
        if (cnt) PS.debris.emit({ count: cnt * 2, scale: 1, pos: nd.p, radius: nd.r * 0.9, vel: _v1.copy(nd.v).multiplyScalar(0.8), spread: 0.8 + v * 0.1, life: [0.5, 1.2], size: [0.006, 0.013], kind: 1 });
        if (v > 5 && Math.random() < dt * 4) PS.smoke.emit({ count: 1, scale: 1, pos: nd.p, radius: nd.r, vel: _v1.copy(nd.v).multiplyScalar(0.3), spread: 0.3, life: [0.4, 0.8], size: [0.04, 0.07], kind: 2 });
      }
      // splash back into the pool while the column is attached
      if (attached > 0.1) {
        PS.debris.emit({ count: 40 * dt, scale: 1, pos: _v1.set(LAYOUT.pool.x, WATER.level + 0.05, LAYOUT.pool.z), radius: 0.22, vel: V3(0, 1.8, 0), spread: 1.2, life: [0.4, 0.9], size: [0.006, 0.012], kind: 1 });
        if (Math.random() < dt * 8) PS.smoke.emit({ count: 1, scale: 1, pos: _v1.set(LAYOUT.pool.x, WATER.level + 0.1, LAYOUT.pool.z), radius: 0.3, vel: V3(0, 0.3, 0), spread: 0.3, life: [0.8, 1.4], size: [0.1, 0.18], kind: 2 });
      }
    }
    // resample the rope into overlapping spheres (Catmull-Rom between nodes)
    for (let i = 0; i < N - 1; i++) {
      const a = nodes[Math.max(0, i - 1)].p, b = nodes[i].p, c = nodes[i + 1].p, d = nodes[Math.min(N - 1, i + 2)].p;
      const r0 = nodes[i].r, r1 = nodes[i + 1].r; if (r0 < 0.01 && r1 < 0.01) continue;
      const seg = b.distanceTo(c); const steps = Math.min(8, Math.max(1, Math.ceil(seg / (Math.max(0.02, Math.min(r0, r1)) * 0.45))));
      for (let k = 0; k < steps; k++) {
        const tt = k / steps, t2 = tt * tt, t3 = t2 * tt;
        _v1.set(0, 0, 0).addScaledVector(a, -0.5 * t3 + t2 - 0.5 * tt).addScaledVector(b, 1.5 * t3 - 2.5 * t2 + 1).addScaledVector(c, -1.5 * t3 + 2 * t2 + 0.5 * tt).addScaledVector(d, 0.5 * t3 - 0.5 * t2);
        const u = (i + tt) / (N - 1);
        const pulse = 1 + 0.18 * Math.sin(u * 40 - T * 16);
        const v = nodes[i].v.length();
        ssfBlob(_v1, lerp(r0, r1, tt) * pulse, clamp((v - 4) * 0.08, 0, 0.45) + (u > 0.93 && T < t.wrap ? 0.3 : 0));
      }
    }
    // tip: a fat drop that leads, plus a scatter of beads around the head
    const hd = nodes[0];
    if (T < t.whip) for (let k = 0; k < 5; k++) { const a = T * 13 + k * 1.3; _v2.set(Math.cos(a), Math.sin(a * 1.3), Math.sin(a)).multiplyScalar(hd.r * 1.4); ssfBlob(_v1.copy(hd.p).add(_v2), hd.r * 0.35, 0.3); }
    // lens hit at the whip
    return;
  }
  // ---- frozen: ice replaces water, frost races out from the hands ----
  if (!WATER.frozenAt) {
    // seeking straight into the frozen span: take the whip's shape at the freeze instant
    if (WATER.snap) for (let i = 0; i < N; i++) { const nd = nodes[i]; nd.r = waterTarget(i / (N - 1), freezeT, nd.p); }
    for (const nd of nodes) { nd.fz.copy(nd.p); nd.v.set(0, 0, 0); }
    WATER.frozenAt = T; WATER.snap = false;
    WATER.spear = { dir: V3(), base: V3(), fixed: false };
  }
  const front = smoothstep(freezeT, freezeT + 0.75, T);              // 0 → 1 from hands to tip
  const S = spearFrame(T);
  const form = Ease.inOutCubic(clamp((T - t.crack) / (t.formed - t.crack)));
  if (T >= t.launch && !S.fixed) { S.fixed = true; }
  const fly = T >= t.launch ? Ease.inQuad(clamp((T - t.launch) / (t.hit - t.launch))) : 0;
  const pts = [], radii = [];
  const SPEAR_L = 1.9;
  const flyOff = _v3.set(0, 0, 0);
  if (fly > 0) flyOff.copy(WATER.hitPoint).sub(_v4.copy(S.base).addScaledVector(S.dir, SPEAR_L)).multiplyScalar(fly);
  for (let i = 0; i < N; i++) {
    const nd = nodes[i]; const u = i / (N - 1);
    const frozenHere = (1 - u) <= front * 1.02;
    const iceR = frozenHere ? nd.r * 1.3 : 0;
    // spear shape: u=0 tip → u=1 butt
    const sp = _v2.copy(S.base).addScaledVector(S.dir, SPEAR_L * (1 - u)).add(flyOff);
    const spR = 0.1 * Math.pow(Math.sin(Math.PI * clamp(Math.pow(1 - u, 0.55), 0, 1) * 0.999 + 0.001), 0.8) * (u > 0.97 ? 0.6 : 1);
    // far part of the frozen whip breaks away when the spear condenses
    const dist = nd.fz.distanceTo(FIG.palms);
    const keep = T < t.crack ? 1 : (dist < 1.9 ? 1 : 0);
    const p = V3().copy(nd.fz).lerp(sp, form);
    pts.push(p); radii.push(lerp(iceR * keep, spR, form));
    // unfrozen part is still water (brief)
    if (!frozenHere && T < freezeT + 0.8) ssfBlob(nd.fz, nd.r, 0.1);
  }
  writeIceTube(pts, radii);
  ICE.mesh.visible = T < t.hit;
  ICE.mat.uniforms.uFront.value = T < freezeT + 0.8 ? 1 - front : -1;
  ICE.mat.uniforms.uFrost.value = lerp(0.25, 0.55, smoothstep(freezeT, freezeT + 1.2, T)) * (1 - 0.4 * form);
  // crystallising mist and glints along the front
  if (dt > 0 && T < freezeT + 0.8) {
    const fi = Math.round((1 - front) * (N - 1)); const nd = nodes[Math.min(N - 1, Math.max(0, fi))];
    PS.smoke.emit({ count: 25 * dt, scale: 1, pos: nd.fz, radius: 0.06, vel: V3(0, 0.1, 0), spread: 0.2, life: [0.5, 1.0], size: [0.03, 0.06], kind: 2 });
    PS.debris.emit({ count: 120 * dt, scale: 1, pos: nd.fz, radius: 0.1, vel: V3(0, 0.2, 0), spread: 0.4, life: [0.6, 1.2], size: [0.004, 0.008], kind: 3 });
  }
  // spear flight: frost contrail
  if (dt > 0 && fly > 0 && T < t.hit) {
    PS.smoke.emit({ count: 120 * dt, scale: 1, pos: _v1.copy(S.base).addScaledVector(S.dir, SPEAR_L * 0.4).add(flyOff), pos2: _v2.copy(S.base).add(flyOff), radius: 0.04, vel: V3(0, 0.05, 0), spread: 0.2, life: [0.4, 0.9], size: [0.03, 0.06], kind: 2 });
    PS.debris.emit({ count: 150 * dt, scale: 1, pos: _v1.copy(S.base).addScaledVector(S.dir, SPEAR_L * 0.5).add(flyOff), radius: 0.06, vel: V3(0, 0, 0), spread: 0.8, life: [0.5, 1.0], size: [0.004, 0.009], kind: 3 });
  }
}

// break-away of the whip's far end when the spear condenses
function iceCrack(ctx) {
  const N = WATER.N; let spawned = 0;
  for (let i = 0; i < N; i += 2) {
    const nd = WATER.nodes[i]; if (nd.fz.distanceTo(FIG.palms) < 1.9) continue;
    ICE.shards.spawn({ pos: nd.fz, vel: V3((Math.random() - 0.5) * 0.8, Math.random() * 0.6, (Math.random() - 0.5) * 0.8), scale: 0.035 + Math.random() * 0.03, slide: 1 }); spawned++;
    PS.debris.emit({ count: 12, scale: 1, pos: nd.fz, radius: 0.06, vel: V3(0, 0.3, 0), spread: 1.2, life: [0.8, 1.6], size: [0.004, 0.01], kind: 3 });
    PS.smoke.emit({ count: 1, scale: 1, pos: nd.fz, radius: 0.05, vel: V3(0, 0, 0), spread: 0.3, life: [0.8, 1.4], size: [0.05, 0.1], kind: 2 });
  }
  if (spawned) sfx('iceCrack', { pos: FIG.palms, gain: 0.7 });
}
// the spear strikes the pillar: burst of shards, crystals and frost
function iceShatter(ctx) {
  const hp = WATER.hitPoint, S = WATER.spear || { dir: toP1Dir(V3(), V3()) };
  const back = V3().copy(S.dir).multiplyScalar(-1);
  const r = new RNG(1603);
  const n = ctx && ctx.skipped ? 26 : 44;
  for (let i = 0; i < n; i++) {
    const out = V3().copy(back).multiplyScalar(r.f(0.5, 3.2)).add(V3(r.f(-2.2, 2.2), r.f(-0.4, 2.6), r.f(-2.2, 2.2)));
    const it = ICE.shards.spawn({ pos: V3().copy(hp).add(V3(r.f(-0.08, 0.08), r.f(-0.1, 0.1), r.f(-0.08, 0.08))), vel: out, scale: r.f(0.025, 0.075), slide: 1 });
    if (ctx && ctx.skipped) { it.p.set(hp.x + back.x * r.f(0.3, 2.6) + r.f(-1.2, 1.2), 0, hp.z + back.z * r.f(0.3, 2.6) + r.f(-1.2, 1.2)); it.p.y = groundHeight(it.p.x, it.p.z) + 0.02; it.vel.set(0, 0, 0); it.w.set(0, 0, 0); it.sleep = 1; }
  }
  if (ctx && ctx.skipped) { TERRAIN_U.uSpotK.value.x = 1; return; }
  PS.debris.emit({ count: 500, pos: hp, radius: 0.1, vel: back.clone().multiplyScalar(1.5), spread: 3.2, life: [0.8, 2.0], size: [0.003, 0.009], kind: 3 });
  PS.smoke.emit({ count: 8, scale: 1, pos: hp, radius: 0.12, vel: back.clone().multiplyScalar(0.9), spread: 0.8, life: [0.6, 1.2], size: [0.08, 0.15], kind: 2 });
  PS.debris.emit({ count: 60, pos: hp, radius: 0.1, vel: back.clone().multiplyScalar(2), spread: 2.5, life: [0.6, 1.2], size: [0.006, 0.012], kind: 1 });
  hitStop(3); addTrauma(0.45);
  POST.grade.flash = Math.max(POST.grade.flash, 0.12); POST.grade.flashColor.setRGB(0.85, 0.95, 1.0);
  sfx('iceShatter', { pos: hp, gain: 1 });
}

// ================================================================================================
fxModule({
  init() {
    initPool(); initSSF(); initIce(); initLensDrops();
    resizeWaterSSF(VIEW.rw, VIEW.rh);
    const t = WATER.t;
    warp(t.reach - 0.05, t.reach + 0.13, 0.28, 0.05);        // the whip hangs at the lens
    warp(t.hit - 0.02, t.hit + 1.05, 0.2, 0.08);               // shatter in slow motion
    at(t.rise, () => sfx('waterRise', { pos: LOC.pool, gain: 0.8 }), 'water rise');
    at(t.whip + 0.02, () => sfx('whoosh', { pos: FIG.palms, gain: 0.9, pitch: 1.2 }), 'whip');
    at(t.reach - 0.02, () => { lensSplash(9, 0.56, 0.5, 0.3); sfx('splashLens', { gain: 0.8 }); }, 'lens drops');
    at(t.freeze, () => sfx('freeze', { pos: FIG.palms, gain: 0.9 }), 'freeze');
    at(t.crack, (ctx) => iceCrack(ctx), 'ice crack');
    at(t.launch, () => { sfx('whoosh', { pos: FIG.palms, gain: 1, pitch: 0.8 }); addTrauma(0.15); }, 'launch');
    atState(t.hit, (ctx) => iceShatter(ctx), 'ice shatter');
  },
  reset() {
    WATER.snap = true; WATER.frozenAt = null; WATER.spear = null; SSF.n = 0; DROPS.list.length = 0;
    TERRAIN_U.uSpotK.value.x = 0;
  },
  update(T, dt) {
    const t = WATER.t;
    updateWater(T, dt);
    // frost bloom on the struck pillar
    if (T >= t.hit) { TERRAIN_U.uSpot.value.set(WATER.hitPoint.x, WATER.hitPoint.y, WATER.hitPoint.z, 0.62); TERRAIN_U.uSpotK.value.x = Math.max(TERRAIN_U.uSpotK.value.x, smoothstep(t.hit, t.hit + 0.35, T)); }
    else TERRAIN_U.uSpotK.value.x = 0;
  },
  present(dtReal) { updateLensDrops(dtReal); },
});
