// §6 WORLD — summit terrain, pool, pillars, boulders, distant peaks, effect masks --
const LAYOUT = {
  pool: { x: -4.7, z: -3.3, a: 2.3, b: 1.45, rot: 0.5, depth: 0.24, level: -0.05 },
  // stone pillars: ice target (P1), earth slab targets, set dressing
  pillars: [
    { id: 'P1', x: 5.4, z: 3.9, h: 3.3, r: 0.44, seed: 11 },   // ice spear target (front right)
    { id: 'P2', x: -3.1, z: -7.1, h: 3.9, r: 0.5, seed: 23 },  // slab target (back left)
    { id: 'P3', x: 4.3, z: -6.3, h: 3.5, r: 0.46, seed: 37 },  // slab target (back right)
    { id: 'P4', x: -6.9, z: 2.6, h: 4.2, r: 0.5, seed: 41 },   // fire target (left)
    { id: 'P5', x: -1.4, z: 7.6, h: 2.3, r: 0.48, seed: 53, broken: true }, // foreground ruin
  ],
  boulders: [
    { x: 0.9, z: -8.7, s: 1.25, seed: 3 },  // slab target (back centre, platform lip)
    { x: 8.4, z: -1.6, s: 1.0, seed: 5 },
    { x: -8.6, z: -2.1, s: 0.8, seed: 7 },
    { x: 6.9, z: 6.2, s: 0.7, seed: 9 },
    { x: -5.9, z: 6.9, s: 0.9, seed: 13 },
    { x: 2.9, z: 8.9, s: 0.65, seed: 17 },
    { x: -9.1, z: 4.9, s: 1.1, seed: 19 },
    { x: 9.3, z: 3.2, s: 0.55, seed: 21 },
  ],
  eruptPillar: { x: 0.35, z: -2.35, h: 3.1, r: 0.55 },
};

// ---- terrain height function (shared by mesh, physics, IK, particles) --------
function platformRadius(th) {
  const c = Math.cos(th), s = Math.sin(th);
  let r = 9.7 + 0.9 * Noise.n2(c * 1.3 + 7, s * 1.3 + 3) + 0.35 * Noise.n2(c * 4.1 + 1, s * 4.1 - 5) + 0.12 * Noise.n2(c * 11 + 3, s * 11 + 9);
  // widen toward the pool so its basin sits on the lip, not over the drop
  const dp = Math.atan2(LAYOUT.pool.z, LAYOUT.pool.x); let da = Math.abs(((th - dp + Math.PI) % TAU + TAU) % TAU - Math.PI);
  r += 0.9 * Math.exp(-da * da * 6);
  return r;
}
function poolCoords(x, z) {
  const P = LAYOUT.pool, dx = x - P.x, dz = z - P.z, c = Math.cos(P.rot), s = Math.sin(P.rot);
  const u = (dx * c + dz * s) / P.a, v = (-dx * s + dz * c) / P.b;
  return Math.sqrt(u * u + v * v);
}
function platformHeight(x, z) {
  let h = 0.055 * Noise.fbm2(x * 0.14 + 3.1, z * 0.14 - 1.7, 4) + 0.014 * Noise.fbm2(x * 0.75, z * 0.75, 3);
  // gentle rise toward the centre so the figure stands on the crown
  const r = Math.hypot(x, z); h += 0.05 * Math.exp(-r * r * 0.02);
  // pool basin with a worn lip
  const e = poolCoords(x, z);
  if (e < 1.5) {
    const P = LAYOUT.pool;
    const bowl = e < 1 ? P.depth * Math.pow(1 - Math.pow(e, 2.2), 0.7) : 0;
    const lip = 0.025 * Math.exp(-Math.pow((e - 1.1) / 0.12, 2));
    h += -bowl + lip;
    h = Math.min(h, lerp(h, P.level - 0.004, smoothstep(1.02, 0.96, e)));
  }
  return h;
}
// cliff profile beyond the platform edge: [radial offset from edge, height] control points
const CLIFF = [[-0.35, 0], [0, -0.06], [0.3, -0.36], [0.8, -1.5], [1.8, -4.4], [3.8, -9], [7.5, -16], [13, -25], [22, -38], [36, -56], [60, -84], [100, -120], [170, -175], [300, -260]];
function cliffAt(d) {
  if (d <= CLIFF[0][0]) return 0;
  for (let i = 1; i < CLIFF.length; i++) {
    if (d <= CLIFF[i][0]) {
      const a = CLIFF[i - 1], b = CLIFF[i]; const t = (d - a[0]) / (b[0] - a[0]);
      return lerp(a[1], b[1], i < 3 ? smooth01(t) : t);
    }
  }
  return CLIFF[CLIFF.length - 1][1];
}
function groundHeight(x, z) {
  const r = Math.hypot(x, z), th = Math.atan2(z, x), R0 = platformRadius(th);
  const d = r - R0;
  const top = platformHeight(x, z);
  if (d < -0.35) return top;
  return top * smoothstep(0.1, -0.35, d) + cliffAt(d);
}
function groundNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.05;
  const hx = groundHeight(x + e, z) - groundHeight(x - e, z), hz = groundHeight(x, z + e) - groundHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// ---- shared world material patch: world pos varying + sky-colored aerial perspective ----
const GLSL_FOG = /* glsl */ `
  vec3 spFog(vec3 col, vec3 wpos){
    vec3 d = wpos - cameraPosition; float dist = length(d); vec3 dir = d / max(dist, 1e-3);
    vec3 fc = texture2D(uSkyTex, sp_equirectUV(normalize(vec3(dir.x, max(dir.y, 0.015), dir.z)))).rgb;
    float h = clamp((wpos.y + 60.0) / 400.0, 0.0, 1.0);
    float k = 1.0 - exp(-dist * uFogDensity * mix(1.6, 0.55, h));
    return mix(col, fc, k);
  }
`;
function patchWorldMaterial(mat, extra = null) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    sh.uniforms.uSkyTex = U.uSkyTex; sh.uniforms.uFogDensity = U.uFogDensity;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 wp4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4;
          #endif
          #ifdef USE_BATCHING
            wp4 = batchingMatrix * wp4;
          #endif
          vWPos = (modelMatrix * wp4).xyz;
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWNrm = normalize(mat3(modelMatrix) * wn); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON + '\nvarying vec3 vWPos; varying vec3 vWNrm; uniform sampler2D uSkyTex; uniform float uFogDensity;\n' + GLSL_FOG + '\n//SP_DECL')
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = spFog(gl_FragColor.rgb, vWPos);');
    if (extra) extra(sh, r);
    if (prev) prev(sh, r);
  };
  mat.customProgramCacheKey = () => (extra ? extra.key || 'x' : 'w') + (mat.userData.key || '');
  return mat;
}

// ---- granite/terrain material ------------------------------------------------
const TERRAIN_U = {
  uAlbedo: { value: null }, uNRM: { value: null }, uTexScale: { value: 1 / 2.5 },
  uEffect: { value: null }, uEffectBounds: { value: new THREE.Vector4(-13, -13, 26, 26) },
  uCrack: { value: new THREE.Vector4(0, 0, 0, 0) },   // center xz, radius, amount
  uPits: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  uPoolRim: { value: new THREE.Vector4(LAYOUT.pool.x, LAYOUT.pool.z, LAYOUT.pool.a, LAYOUT.pool.b) },
  uPoolRot: { value: LAYOUT.pool.rot }, uPoolLevel: { value: LAYOUT.pool.level },
  uBB: { value: TEX.blackbody || null }, uTime: U.uTime,
  uSpot: { value: new THREE.Vector4(0, -100, 0, 0.5) },   // localized frost on vertical stone (ice impact): centre xyz, radius
  uSpotK: { value: new THREE.Vector4(0, 0, 0, 0) },        // frost amount
};
function makeStoneMaterial({ tint = [1, 1, 1], terrain = false, key = 'stone' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...tint), roughness: 1, metalness: 0 });
  const extra = (sh) => {
    Object.assign(sh.uniforms, TERRAIN_U);
    sh.fragmentShader = sh.fragmentShader
      .replace('//SP_DECL', `//SP_DECL
        uniform sampler2D uAlbedo, uNRM, uEffect, uBB; uniform float uTexScale, uTime, uPoolRot, uPoolLevel;
        uniform vec4 uEffectBounds, uCrack, uPoolRim, uSpot, uSpotK; uniform vec4 uPits[4];
        vec3 gN; float gAO; float gRough; float gWet; float gCav; vec3 gEmit;
        vec3 triNormal(vec3 p, vec3 n, float s, out vec4 nrm){
          vec3 w = pow(abs(n), vec3(6.0)); w /= (w.x + w.y + w.z);
          vec4 tx = texture2D(uNRM, p.zy * s), ty = texture2D(uNRM, p.xz * s), tz = texture2D(uNRM, p.xy * s);
          nrm = tx * w.x + ty * w.y + tz * w.z;
          vec3 nx = vec3(tx.xy * 2.0 - 1.0, 0.0); nx.z = sqrt(max(1.0 - dot(nx.xy, nx.xy), 0.0));
          vec3 ny = vec3(ty.xy * 2.0 - 1.0, 0.0); ny.z = sqrt(max(1.0 - dot(ny.xy, ny.xy), 0.0));
          vec3 nz = vec3(tz.xy * 2.0 - 1.0, 0.0); nz.z = sqrt(max(1.0 - dot(nz.xy, nz.xy), 0.0));
          nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
          ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
          nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
          return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
        }
        vec4 triAlbedo(vec3 p, vec3 n, float s){
          vec3 w = pow(abs(n), vec3(6.0)); w /= (w.x + w.y + w.z);
          return texture2D(uAlbedo, p.zy * s) * w.x + texture2D(uAlbedo, p.xz * s) * w.y + texture2D(uAlbedo, p.xy * s) * w.z;
        }
        // world-space flagstone seams (voronoi borders) for the platform top
        float seams(vec2 p){
          vec2 ip = floor(p), fp = fract(p); vec2 mg, mr; float md = 8.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){ vec2 g = vec2(float(i), float(j)); vec2 o = 0.5 + 0.4 * (sp_hash22(ip + g) - 0.5); vec2 r = g + o - fp; float d = dot(r, r); if (d < md){ md = d; mr = r; mg = g; } }
          float bd = 8.0;
          for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++){ vec2 g = mg + vec2(float(i), float(j)); vec2 o = 0.5 + 0.4 * (sp_hash22(ip + g) - 0.5); vec2 r = g + o - fp; if (dot(mr - r, mr - r) > 1e-5) bd = min(bd, dot(0.5 * (mr + r), normalize(r - mr))); }
          return bd;
        }
      `)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 N0 = normalize(vWNrm);
          vec4 alb = triAlbedo(vWPos, N0, uTexScale);
          vec4 alb2 = triAlbedo(vWPos * 0.21 + 3.7, N0, uTexScale);
          vec3 base = alb.rgb * mix(vec3(0.82), vec3(1.12), alb2.a) * (0.9 + 0.2 * alb2.g);
          vec4 nrm; gN = triNormal(vWPos, N0, uTexScale, nrm);
          vec4 nrm2; vec3 gN2 = triNormal(vWPos * 0.23 + 1.3, N0, uTexScale, nrm2);
          gN = normalize(gN + (gN2 - N0) * 0.6);
          gAO = nrm.b * mix(1.0, nrm2.b, 0.5); gRough = nrm.a; gCav = nrm.b; gEmit = vec3(0.0); gWet = 0.0;
          float flatness = smoothstep(0.75, 0.95, N0.y);
          ${terrain ? `
          // flagstone seams on the plateau: warped, broken fracture lines, not tiles
          vec2 sp = vWPos.xz * 0.5 + 11.0;
          sp += vec2(sp_fbm2(vWPos.xz * 0.9), sp_fbm2(vWPos.xz * 0.9 + 5.2)) * 0.55 - 0.27;
          float sd = seams(sp) / 0.5;
          float seamVis = smoothstep(0.35, 0.6, sp_vnoise2(vWPos.xz * 1.3 + 4.0));
          float seamW = 0.004 + 0.012 * sp_vnoise2(vWPos.xz * 4.0);
          float seam = (1.0 - smoothstep(seamW * 0.4, seamW, sd)) * flatness * smoothstep(9.5, 7.0, length(vWPos.xz)) * seamVis;
          base *= 1.0 - seam * 0.6; gAO *= 1.0 - seam * 0.45; gRough = mix(gRough, 1.0, seam);
          // grit and dust in the low areas of the plateau
          float grit = smoothstep(0.55, 0.8, sp_fbm2(vWPos.xz * 1.7)) * flatness;
          base = mix(base, base * vec3(1.08, 1.02, 0.95) + 0.012, grit * 0.35);
          // pool: wet rim and submerged darkening
          vec2 pd = vWPos.xz - uPoolRim.xy; float c = cos(uPoolRot), s = sin(uPoolRot);
          vec2 pe = vec2(pd.x * c + pd.y * s, -pd.x * s + pd.y * c) / uPoolRim.zw; float e = length(pe);
          float rimWet = smoothstep(1.6, 1.0, e) * (0.55 + 0.45 * sp_vnoise2(vWPos.xz * 3.0));
          float under = smoothstep(uPoolLevel + 0.01, uPoolLevel - 0.02, vWPos.y);
          gWet = max(gWet, max(rimWet, under));
          base *= mix(1.0, 0.72, under);
          // stomp cracks: radial fracture network revealed by the shockwave
          if (uCrack.w > 0.0){
            vec2 cp = vWPos.xz - uCrack.xy; float cr = length(cp);
            float ang = atan(cp.y, cp.x);
            vec2 pc = vec2(ang * 3.0, log(cr + 0.35) * 5.5);
            float bd = seams(pc * 1.3 + 4.0);
            float w = 0.035 * smoothstep(uCrack.z, 0.0, cr) + 0.006;
            float crack = (1.0 - smoothstep(0.0, w, bd)) * step(cr, uCrack.z) * uCrack.w * smoothstep(7.5, 0.5, cr);
            base *= 1.0 - crack * 0.85; gAO *= 1.0 - crack * 0.8; gRough = mix(gRough, 1.0, crack);
            gN = normalize(gN + vec3(cp.x, 0.0, cp.y) / max(cr, 0.01) * crack * 0.25);
            // fresh broken stone rim around cracks is paler
            float rim = (1.0 - smoothstep(w, w * 3.0 + 0.02, bd)) * step(cr, uCrack.z) * uCrack.w * smoothstep(6.0, 0.5, cr) * (1.0 - crack);
            base = mix(base, base * 1.35 + 0.02, rim * 0.5);
          }
          // pits left by torn-out slabs
          for (int i = 0; i < 4; i++){
            vec4 P = uPits[i]; if (P.w <= 0.0) continue;
            vec2 q = (vWPos.xz - P.xy); float ca = cos(P.z * 7.1), sa = sin(P.z * 7.1);
            q = vec2(q.x * ca + q.y * sa, -q.x * sa + q.y * ca);
            vec2 hb = vec2(0.62, 0.36) * P.z / 0.62;
            vec2 dq = abs(q) - hb; float sdb = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) + 0.09 * (sp_vnoise2(vWPos.xz * 6.0) - 0.5) + 0.04 * sp_vnoise2(vWPos.xz * 19.0);
            float hole = smoothstep(0.04, -0.1, sdb) * P.w;
            float deep = smoothstep(-0.02, -0.3, sdb);                      // raw socket, darkest where it was deepest
            float edge = smoothstep(0.14, 0.0, abs(sdb)) * P.w;
            vec3 socket = base * mix(0.55, 0.25, deep) * vec3(0.95, 0.9, 0.84);  // fresh, unweathered stone in shadow
            base = mix(base, socket, hole);
            base = mix(base, base * 1.25 + 0.02, edge * (1.0 - hole) * 0.4);
            gAO *= 1.0 - hole * (0.35 + 0.4 * deep); gRough = mix(gRough, 1.0, hole);
            gN = normalize(gN + vec3(q.x, 0.0, q.y) * edge * 0.6);
          }
          ` : ''}
          // painted effect masks: wet / scorch / glow / frost
          vec2 euv = (vWPos.xz - uEffectBounds.xy) / uEffectBounds.zw;
          if (all(greaterThan(euv, vec2(0.0))) && all(lessThan(euv, vec2(1.0)))){
            vec4 fx = texture2D(uEffect, euv);
            float heightMask = smoothstep(-2.0, -0.4, vWPos.y);
            fx *= heightMask;
            gWet = max(gWet, clamp(fx.r, 0.0, 1.0));
            float sc = clamp(fx.g, 0.0, 1.0);
            float sn = sp_vnoise2(vWPos.xz * 6.0) * 0.5 + sp_vnoise2(vWPos.xz * 23.0) * 0.5;
            float soot = smoothstep(0.1, 0.5, sc + (sn - 0.5) * 0.35);
            base = mix(base, base * vec3(0.55, 0.47, 0.40), smoothstep(0.02, 0.3, sc) * 0.6);
            base = mix(base, vec3(0.018, 0.016, 0.014), soot * 0.9);
            gRough = mix(gRough, 0.97, soot);
            float hot = clamp(fx.b, 0.0, 1.5) * smoothstep(0.25, 0.75, sn + fx.b * 0.3);
            float T = clamp(hot * 0.55, 0.0, 1.0);
            vec4 bb = texture2D(uBB, vec2(T * 0.55 + 0.05, 0.5));
            gEmit += bb.rgb * pow(T, 2.2) * 9.0;
            float fr = clamp(fx.a, 0.0, 1.0) * smoothstep(0.35, 0.65, sn * 0.6 + fx.a * 0.6);
            base = mix(base, vec3(0.62, 0.72, 0.8), fr * 0.8);
            gRough = mix(gRough, 0.35, fr); gN = normalize(mix(gN, N0, fr * 0.5));
          }
          // localized frost bloom where the ice spear struck
          if (uSpotK.x > 0.0){
            float fd = distance(vWPos, uSpot.xyz);
            float fn = sp_vnoise2(vWPos.xy * 9.0 + vWPos.zy * 7.0) * 0.6 + sp_vnoise2(vWPos.xz * 31.0 + vWPos.y * 17.0) * 0.4;
            float fs = smoothstep(uSpot.w, uSpot.w * 0.15, fd + (fn - 0.5) * uSpot.w * 0.7) * uSpotK.x;
            base = mix(base, vec3(0.66, 0.76, 0.84), fs * 0.8 * smoothstep(0.3, 0.6, fn + fs * 0.3));
            gRough = mix(gRough, 0.28, fs); gN = normalize(mix(gN, N0, fs * 0.6)); gWet = max(gWet, fs * 0.3);
          }
          // wet stone: darker, glossier, flatter normal
          float porous = 0.55;
          base *= mix(1.0, porous, gWet);
          gRough = mix(gRough, 0.12, gWet * gWet);
          gN = normalize(mix(gN, N0, gWet * 0.65));
          diffuseColor.rgb = base * diffuse;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(gRough, 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += gEmit;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gAO; reflectedLight.indirectSpecular *= mix(gAO, 1.0, gWet * 0.5);
        reflectedLight.directDiffuse *= mix(1.0, gCav, 0.45);`);
  };
  extra.key = key + (terrain ? 'T' : '');
  patchWorldMaterial(mat, extra);
  return mat;
}

// ---- terrain mesh --------------------------------------------------------------
function buildTerrain() {
  const NA = Q.terrainSeg, NP = Math.round(NA * 0.42), NC = 56;
  const rings = NP + NC; const verts = (rings) * NA + 1;
  const pos = new Float32Array(verts * 3);
  pos[0] = 0; pos[1] = platformHeight(0, 0); pos[2] = 0;
  const cliffD = []; // param along cliff: use arc-length-ish spacing in d
  for (let j = 0; j < NC; j++) { const u = (j + 1) / NC; cliffD.push(-0.35 + Math.pow(u, 2.1) * 262); }
  for (let a = 0; a < NA; a++) {
    const th = (a / NA) * TAU, c = Math.cos(th), s = Math.sin(th);
    const R0 = platformRadius(th);
    for (let i = 0; i < rings; i++) {
      let x, y, z;
      if (i < NP) {
        const r = ((i + 1) / NP) * (R0 - 0.35);
        x = c * r; z = s * r; y = platformHeight(x, z);
      } else {
        const d = cliffD[i - NP]; const r = R0 + d;
        x = c * r; z = s * r;
        y = cliffAt(d) + (d < 0.1 ? platformHeight(x, z) * smoothstep(0.1, -0.35, d) : 0);
        // rocky displacement grows with depth below the lip; strata ledges and buttress ridges
        const depth = Math.max(0, -y);
        const amp = Math.min(depth * 0.16, 14) * smoothstep(0.1, 1.5, d);
        const n = Noise.fbm3(x * 0.07, y * 0.12, z * 0.07, 4) + 0.5 * Noise.fbm3(x * 0.3, y * 0.45, z * 0.3, 3);
        const strata = Math.sin(y * 0.8 + Noise.n2(c * 3, s * 3) * 4) * 0.25;
        const butt = Math.pow(Math.max(0, Noise.n2(c * 2.2 + 11, s * 2.2 - 4)), 1.5) * 1.6 + Math.pow(Math.max(0, Noise.n2(c * 5.1 - 3, s * 5.1 + 8)), 2) * 0.8;
        const push = (n + strata * 0.3) * amp + butt * Math.min(depth * 0.35, 30) * smoothstep(0.5, 4, d);
        x += c * push; z += s * push;
        y += Noise.n3(x * 0.15, y * 0.15, z * 0.15) * amp * 0.3;
      }
      const k = 1 + a * rings + i;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    }
  }
  const idx = [];
  for (let a = 0; a < NA; a++) {
    const a1 = (a + 1) % NA;
    idx.push(0, 1 + a1 * rings, 1 + a * rings);
    for (let i = 0; i < rings - 1; i++) {
      const p00 = 1 + a * rings + i, p01 = 1 + a * rings + i + 1, p10 = 1 + a1 * rings + i, p11 = 1 + a1 * rings + i + 1;
      idx.push(p00, p10, p01, p01, p10, p11);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---- rocks: displaced icospheres ---------------------------------------------------
function rockGeometry(seed, detail = 3, sx = 1, sy = 0.7, sz = 1, rough = 0.35) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position; const o = seed * 7.31;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let d = 1 + rough * Noise.fbm3(x * 1.3 + o, y * 1.3 - o, z * 1.3 + o * 0.5, 4) + 0.12 * Noise.n3(x * 4 + o, y * 4, z * 4 - o);
    // cleave planes: chunky facets
    const f = Math.max(Math.abs(x + 0.3 * Noise.n2(o, 1)), Math.abs(z)) * 0.18;
    d -= f * 0.3;
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  const ng = mergeVerticesLite(g);
  ng.computeVertexNormals();
  return ng;
}
function mergeVerticesLite(g) {
  // collapse duplicated vertices from non-indexed icosahedron → smooth normals
  const src = g.index ? g.toNonIndexed() : g; const p = src.attributes.position; const map = new Map(); const pos = []; const idx = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`;
    let j = map.get(k); if (j === undefined) { j = pos.length / 3; map.set(k, j); pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(j);
  }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setIndex(idx); return out;
}

// ---- pillars: stacked, eroded drums ------------------------------------------------
function weld(g) { g.deleteAttribute('uv'); g.deleteAttribute('normal'); return mergeVertices(g, 1e-4); }
function pillarGeometry(def) {
  const r = new RNG(def.seed); const parts = []; let y = -0.25;
  const target = def.h; let k = 0;
  while (y < target - 0.2 && k < 8) {
    const hh = Math.min(r.f(0.55, 0.95), target - y + 0.05);
    const rad = def.r * r.f(0.88, 1.06) * (1 - k * 0.025);
    const g = weld(new THREE.CylinderGeometry(rad * 0.97, rad, hh, 18, 7, false));
    const p = g.attributes.position; const off = def.seed * 3.7 + k * 1.9;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, x), rr = Math.hypot(x, z);
      const edge = Math.abs(yy) / (hh / 2);
      let d = 1 + 0.07 * Noise.fbm3(Math.cos(a) * 2 + off, yy * 2.2, Math.sin(a) * 2 - off, 4) + 0.025 * Noise.n3(Math.cos(a) * 9, yy * 9, Math.sin(a) * 9 + off);
      d -= 0.1 * Math.pow(edge, 8) * (rr / rad);
      const topErode = yy > 0 ? 0.025 * Noise.n2(x * 7 + off, z * 7) * (rr / rad) : 0;
      p.setXYZ(i, x * d, yy + topErode - 0.03 * Math.pow(edge, 8) * Math.sign(yy), z * d);
    }
    g.rotateY(r.f(0, TAU));
    g.rotateZ(r.f(-0.025, 0.025)); g.rotateX(r.f(-0.025, 0.025));
    g.translate(r.f(-0.025, 0.025), y + hh / 2, r.f(-0.025, 0.025));
    parts.push(g);
    y += hh; k++;
  }
  if (!def.broken) {
    const cap = weld(new THREE.BoxGeometry(def.r * 2.5, 0.28, def.r * 2.5, 6, 2, 6));
    const p = cap.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), yy = p.getY(i), z = p.getZ(i); const n = 1 + 0.08 * Noise.n3(x * 3 + def.seed, yy * 3, z * 3); p.setXYZ(i, x * n, yy * n, z * n); }
    cap.rotateY(r.f(0, TAU)); cap.translate(0, y + 0.12, 0);
    parts.push(cap); y += 0.26;
  } else {
    const g = weld(new THREE.ConeGeometry(def.r * 0.95, 0.5, 14, 4, false));
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), yy = p.getY(i), z = p.getZ(i); p.setXYZ(i, x * (1 + 0.3 * Noise.n3(x * 5, yy * 5, z * 5 + def.seed)), yy * (0.4 + 0.6 * Math.abs(Noise.n2(x * 6, z * 6))), z); }
    g.translate(0, y + 0.15, 0); parts.push(g); y += 0.3;
  }
  const merged = mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return { geo: merged, top: y };
}

// ---- distant peaks -------------------------------------------------------------------
function peakGeometry(seed, R, H, snowLine) {
  const NA = 72, NR = 26; const pos = [], col = [], idx = [];
  const o = seed * 13.1;
  for (let i = 0; i <= NR; i++) {
    const u = i / NR;
    for (let a = 0; a < NA; a++) {
      const th = (a / NA) * TAU; const c = Math.cos(th), s = Math.sin(th);
      const rr = u * R * (1 + 0.25 * Noise.n2(c * 1.5 + o, s * 1.5 - o));
      const ridge = Noise.ridge2(c * rr / R * 2.2 + o, s * rr / R * 2.2 - o, 5);
      let h = H * Math.pow(1 - u, 1.35) * (0.55 + 0.6 * ridge) - u * 40;
      if (i === 0) h = H * 1.02;
      const x = c * rr, z = s * rr;
      pos.push(x, h, z);
      const slope = 1 - u;
      const snow = smoothstep(snowLine - 30, snowLine + 30, h + 25 * Noise.n2(x * 0.01 + o, z * 0.01)) * smoothstep(0.1, 0.4, slope + ridge * 0.3);
      const rock = [0.075, 0.07, 0.068];
      col.push(lerp(rock[0], 0.8, snow), lerp(rock[1], 0.83, snow), lerp(rock[2], 0.88, snow));
    }
  }
  for (let i = 0; i < NR; i++) for (let a = 0; a < NA; a++) {
    const a1 = (a + 1) % NA; const p00 = i * NA + a, p01 = i * NA + a1, p10 = (i + 1) * NA + a, p11 = (i + 1) * NA + a1;
    idx.push(p00, p10, p01, p01, p10, p11);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ---- effect masks (top-down painted: wet, scorch, glow, frost) ----------------------
const FXMASK = { rt: null, marks: [], pending: [], mat: null, decayMat: null, cam: null, mesh: null, max: 256 };
function initEffectMask() {
  const S = 512;
  FXMASK.rt = makeRT(S, S, { type: THREE.HalfFloatType });
  TERRAIN_U.uEffect.value = FXMASK.rt.texture;
  // the paint shader maps world xz straight to clip space; the camera is a formality
  FXMASK.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const quad = new THREE.PlaneGeometry(1, 1);
  const ig = new THREE.InstancedBufferGeometry(); ig.index = quad.index; ig.attributes.position = quad.attributes.position; ig.attributes.uv = quad.attributes.uv;
  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(FXMASK.max * 4), 4); // x, z, radius, angle
  const aVal = new THREE.InstancedBufferAttribute(new Float32Array(FXMASK.max * 4), 4); // wet, scorch, glow, frost
  aPos.setUsage(THREE.DynamicDrawUsage); aVal.setUsage(THREE.DynamicDrawUsage);
  ig.setAttribute('aPos', aPos); ig.setAttribute('aVal', aVal); ig.instanceCount = 0;
  FXMASK.mat = new THREE.ShaderMaterial({
    uniforms: { uBounds: TERRAIN_U.uEffectBounds },
    vertexShader: /* glsl */ `attribute vec4 aPos; attribute vec4 aVal; uniform vec4 uBounds; varying vec2 vQ; varying vec4 vVal; varying float vSeed;
      void main(){ vQ = position.xy * 2.0; vVal = aVal; vSeed = aPos.w;
        float c = cos(aPos.w), s = sin(aPos.w); vec2 q = mat2(c, -s, s, c) * position.xy * aPos.z * 2.0;
        vec2 xz = aPos.xy + q; vec2 uv = (xz - uBounds.xy) / uBounds.zw; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`,
    fragmentShader: GLSL_COMMON + /* glsl */ `varying vec2 vQ; varying vec4 vVal; varying float vSeed;
      void main(){ float r = length(vQ); float n = sp_vnoise2(vQ * 3.0 + vSeed * 7.0) * 0.5 + sp_vnoise2(vQ * 7.0 - vSeed) * 0.5;
        float m = smoothstep(1.0, 0.35, r + (n - 0.5) * 0.55); if (m <= 0.0) discard; gl_FragColor = vVal * m; }`,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    depthTest: false, depthWrite: false, transparent: true,
  });
  FXMASK.mesh = new THREE.Mesh(ig, FXMASK.mat); FXMASK.mesh.frustumCulled = false;
  FXMASK.scene = new THREE.Scene(); FXMASK.scene.add(FXMASK.mesh);
  FXMASK.decayMat = fsMat(`uniform vec4 uK; void main(){ gl_FragColor = uK; }`, { uK: { value: new THREE.Vector4(1, 1, 1, 1) } },
    { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor, transparent: true });
  clearEffectMask();
}
function clearEffectMask() {
  renderer.setRenderTarget(FXMASK.rt); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); renderer.setClearColor(0x000000, 1);
  FXMASK.pending.length = 0;
}
// wet, scorch, glow, frost in [0..1+]
function paintMark(x, z, radius, wet = 0, scorch = 0, glow = 0, frost = 0) {
  if (FXMASK.pending.length < FXMASK.max) FXMASK.pending.push([x, z, radius, Math.random() * TAU, wet, scorch, glow, frost]);
}
function updateEffectMask(dt) {
  if (dt > 0) {
    const k = FXMASK.decayMat.uniforms.uK.value;
    k.set(Math.exp(-dt / 16), 1, Math.exp(-dt / 3.2), Math.exp(-dt / 24));
    blit(FXMASK.decayMat, FXMASK.rt);
  }
  const n = FXMASK.pending.length; if (!n) return;
  const g = FXMASK.mesh.geometry; const aP = g.attributes.aPos, aV = g.attributes.aVal;
  for (let i = 0; i < n; i++) { const m = FXMASK.pending[i]; aP.setXYZW(i, m[0], m[1], m[2], m[3]); aV.setXYZW(i, m[4], m[5], m[6], m[7]); }
  aP.needsUpdate = aV.needsUpdate = true; g.instanceCount = n;
  renderer.setRenderTarget(FXMASK.rt); renderer.render(FXMASK.scene, FXMASK.cam);
  FXMASK.pending.length = 0;
}

// ---- ground heightmap texture for GPU particle collisions --------------------------
function makeHeightTexture() {
  const N = 256, ext = 13, data = new Uint16Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -ext + (i + 0.5) / N * 2 * ext, z = -ext + (j + 0.5) / N * 2 * ext;
    const h = groundHeight(x, z);
    const k = (j * N + i) * 4;
    data[k] = THREE.DataUtils.toHalfFloat(Math.max(h, -50)); data[k + 1] = 0; data[k + 2] = 0; data[k + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  TEX.height = t; TEX.heightExt = ext;
  return t;
}

// ---- assemble the world ------------------------------------------------------------
const WORLD = { terrain: null, stoneMat: null, terrainMat: null, pillars: [], boulders: [], peaks: [], scrapAnchors: [] };
function buildWorld() {
  TERRAIN_U.uAlbedo.value = TEX.graniteAlbedo; TERRAIN_U.uNRM.value = TEX.graniteNRM; TERRAIN_U.uBB.value = TEX.blackbody;
  WORLD.terrainMat = makeStoneMaterial({ tint: [1.0, 0.97, 0.94], terrain: true, key: 'terrain' });
  WORLD.stoneMat = makeStoneMaterial({ tint: [0.95, 0.93, 0.9], key: 'stone' });
  const tg = buildTerrain();
  WORLD.terrain = new THREE.Mesh(tg, WORLD.terrainMat);
  WORLD.terrain.receiveShadow = true; WORLD.terrain.castShadow = true;
  world.add(WORLD.terrain);

  for (const def of LAYOUT.pillars) {
    const { geo, top } = pillarGeometry(def);
    const m = new THREE.Mesh(geo, WORLD.stoneMat);
    m.position.set(def.x, groundHeight(def.x, def.z) - 0.05, def.z);
    m.castShadow = m.receiveShadow = true;
    world.add(m);
    WORLD.pillars.push({ def, mesh: m, top: m.position.y + top });
    // cloth scrap anchor on the windward side just under the capital
    const a = Math.atan2(-def.z, -def.x) + 0.6;
    WORLD.scrapAnchors.push({ pillar: def.id, x: def.x + Math.cos(a) * def.r * 0.95, y: m.position.y + top - 0.55 - (def.broken ? 0.3 : 0), z: def.z + Math.sin(a) * def.r * 0.95, r: def.r, cx: def.x, cz: def.z });
  }
  for (const b of LAYOUT.boulders) {
    const g = rockGeometry(b.seed, 3, 1.1, 0.62, 0.9, 0.3);
    const m = new THREE.Mesh(g, WORLD.stoneMat);
    const y = groundHeight(b.x, b.z);
    m.position.set(b.x, y - 0.18 * b.s, b.z); m.scale.setScalar(b.s); m.rotation.y = b.seed;
    m.castShadow = m.receiveShadow = true; world.add(m); WORLD.boulders.push(m);
  }
  // scatter of small embedded rocks for scale
  const small = rockGeometry(99, 2, 1, 0.55, 0.85, 0.35);
  const sm = new THREE.InstancedMesh(small, WORLD.stoneMat, 60); const r = new RNG(77); const M = new THREE.Matrix4(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < 200 && n < 60; i++) {
    const a = r.f(0, TAU), rr = r.f(3.5, 9.6); const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    if (poolCoords(x, z) < 1.4) continue; if (rr > platformRadius(a) - 0.4) continue;
    const sc = r.f(0.05, 0.22); s.set(sc * r.f(0.8, 1.4), sc, sc * r.f(0.8, 1.3)); q.setFromEuler(_e1.set(r.f(-0.3, 0.3), r.f(0, TAU), r.f(-0.3, 0.3)));
    M.compose(_v1.set(x, groundHeight(x, z) - sc * 0.25, z), q, s); sm.setMatrixAt(n++, M);
  }
  sm.count = n; sm.castShadow = sm.receiveShadow = true; world.add(sm);

  // distant peaks rising through the cloud sea
  const peakMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  patchWorldMaterial(peakMat); peakMat.userData.key = 'peak';
  const peaks = [
    [520, -35, 170, 95, 1], [760, 30, 260, 150, 2], [640, 75, 200, 60, 3], [1450, -70, 520, 260, 4], [1900, 140, 700, 420, 5],
    [2300, -120, 800, 520, 6], [1250, 190, 460, 180, 7], [2800, 60, 950, 610, 8], [3400, -20, 1200, 820, 9], [980, -150, 300, 120, 10],
    [3900, 175, 1400, 700, 11], [1700, 250, 600, 300, 12], [4600, -95, 1500, 900, 13],
  ];
  for (const [dist, azDeg, R, H, seed] of peaks) {
    const g = peakGeometry(seed, R, H, H * 0.55);
    const m = new THREE.Mesh(g, peakMat);
    const az = azDeg * DEG + SKY.sunAz * 0.0;
    m.position.set(Math.sin(az) * dist, CLOUD.top - 90, Math.cos(az) * dist);
    m.rotation.y = seed;
    world.add(m); WORLD.peaks.push(m);
  }
}
