// §16 AIR — the wind made visible: a vortex gathers around the circle walk (leaves, dust, embers,
// torn cloth scraps from the pillars), streamline ribbons trace the flow, the spin lifts the body
// in a funnel of air, and at altitude the whole cloud sea turns in a spiral.
const AIR = {
  t: { gather: 47.0, scraps: [48.4, 49.2, 50.0, 50.7], spin: 52.35, lift: 53.0, reveal: 55.2, end: 58.0 },
  lines: [], M: 44, H: 30, mesh: null, amt: 0,
};

// ---- streamline ribbons: CPU tracers advected through the same field as cloth and particles ------
function initWindLines() {
  const M = AIR.M, H = AIR.H;
  const g = new THREE.BufferGeometry();
  const n = M * H * 2;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aPrev', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aNext', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const side = new Float32Array(n), along = new Float32Array(n), line = new Float32Array(n);
  const idx = [];
  for (let l = 0; l < M; l++) for (let i = 0; i < H; i++) {
    const v = (l * H + i) * 2;
    side[v] = -1; side[v + 1] = 1; along[v] = along[v + 1] = i / (H - 1); line[v] = line[v + 1] = l;
    if (i < H - 1) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
  }
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1)); g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: 0.018 }, uAmbCube: U.uAmbCube, uKeyColor: U.uKeyColor, uLinDepth: U.uLinDepth, uWaterDepth: U.uWaterDepth, uResolution: U.uResolution, uSoft: { value: 1 } },
    vertexShader: GLSL_COMMON + /* glsl */ `
      attribute vec3 aPrev, aNext; attribute float aSide, aAlong, aAlpha; uniform float uWidth;
      varying float vAlong, vSide, vAlpha, vViewZ;
      void main(){
        vec4 p = viewMatrix * vec4(position, 1.0), a = viewMatrix * vec4(aPrev, 1.0), b = viewMatrix * vec4(aNext, 1.0);
        vec2 t = b.xy - a.xy; t = length(t) > 1e-6 ? normalize(t) : vec2(1.0, 0.0);
        float w = uWidth * sin(3.14159 * aAlong) * (0.4 + 0.6 * aAlong);
        p.xy += vec2(-t.y, t.x) * aSide * w;
        vAlong = aAlong; vSide = aSide; vAlpha = aAlpha; vViewZ = -p.z;
        gl_Position = projectionMatrix * p;
      }`,
    fragmentShader: GLSL_COMMON + SOFT_FRAG + /* glsl */ `
      uniform sampler2D uAmbCube; uniform vec3 uKeyColor; varying float vAlong, vSide, vAlpha, vViewZ;
      void main(){
        float core = 1.0 - vSide * vSide;
        float fade = smoothstep(0.0, 0.35, vAlong) * vAlpha;
        vec3 sky = texelFetch(uAmbCube, ivec2(2, 0), 0).rgb;
        vec3 col = (sky * 2.2 + uKeyColor * 0.25) * core * fade * softFade(vViewZ, 0.3);
        gl_FragColor = vec4(col, 0.0);
      }`,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  AIR.mesh = new THREE.Mesh(g, mat); AIR.mesh.frustumCulled = false; AIR.mesh.renderOrder = 29; AIR.mesh.visible = false;
  fxScene.add(AIR.mesh);
  for (let l = 0; l < M; l++) AIR.lines.push({ pts: Array.from({ length: H }, () => V3()), age: 0, life: 1, alive: false });
}
function seedLine(L, c, R, h) {
  const a = Math.random() * TAU, r = R * (0.35 + Math.random() * 0.95);
  const p = V3(c.x + Math.cos(a) * r, c.y + 0.1 + Math.random() * h, c.z + Math.sin(a) * r);
  for (const q of L.pts) q.copy(p);
  L.age = 0; L.life = 1.2 + Math.random() * 1.6; L.alive = true; L.acc = 0;
}
const _wl = V3();
function updateWindLines(T, dt, amt, c, R, h) {
  const M = AIR.M, H = AIR.H, g = AIR.mesh.geometry;
  AIR.mesh.visible = amt > 0.01;
  if (!AIR.mesh.visible) { for (const L of AIR.lines) L.alive = false; return; }
  const P = g.attributes.position.array, A = g.attributes.aPrev.array, B = g.attributes.aNext.array, AL = g.attributes.aAlpha.array;
  const sub = 2, h2 = dt / sub;
  AIR.lines.forEach((L, l) => {
    if (!L.alive || L.age > L.life) { if (Math.random() < amt) seedLine(L, c, R, h); else { L.alive = false; } }
    if (L.alive && dt > 0) {
      L.age += dt;
      // head advances through the flow; the tail is the head's recent path
      const head = L.pts[0];
      for (let s = 0; s < sub; s++) { windAt(head.x, head.y, head.z, T, _wl); head.addScaledVector(_wl, h2); }
      L.acc += dt;
      if (L.acc > 0.022) { L.acc = 0; for (let i = H - 1; i > 0; i--) L.pts[i].copy(L.pts[i - 1]); }
    }
    const fade = L.alive ? smoothstep(0, 0.3, L.age) * (1 - smoothstep(L.life - 0.4, L.life, L.age)) * amt : 0;
    for (let i = 0; i < H; i++) {
      const p = L.pts[i], pp = L.pts[Math.max(0, i - 1)], pn = L.pts[Math.min(H - 1, i + 1)];
      for (let k = 0; k < 2; k++) {
        const v = ((l * H + i) * 2 + k), o = v * 3;
        P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z;
        A[o] = pn.x; A[o + 1] = pn.y; A[o + 2] = pn.z;   // aPrev = older sample (toward the tail)
        B[o] = pp.x; B[o + 1] = pp.y; B[o + 2] = pp.z;
        AL[v] = fade;
      }
    }
  });
  for (const k of ['position', 'aPrev', 'aNext', 'aAlpha']) g.attributes[k].needsUpdate = true;
}

// ---- the act ----------------------------------------------------------------------------------------
const _ac = V3();
function airCentre(T, out) {
  // the circle walk's centre while walking, the figure itself once it spins
  const w = AIR_WALK; const k = smoothstep(51.4, 52.6, T);
  return out.set(lerp(w.c[0], FIG.p.hips.x, k), groundHeight(w.c[0], w.c[1]), lerp(w.c[1], FIG.p.hips.z, k));
}
function updateAir(T, dt) {
  const t = AIR.t;
  const gather = smoothstep(t.gather, 51.0, T) * (1 - smoothstep(t.end - 0.4, t.end + 0.8, T));
  const spin = smoothstep(t.spin - 0.1, t.lift + 0.3, T) * (1 - smoothstep(t.end - 0.4, t.end + 0.6, T));
  const grand = smoothstep(t.reveal - 0.6, t.reveal + 1.4, T) * (1 - smoothstep(t.end - 0.2, t.end + 0.8, T));
  AIR.amt = Math.max(gather, spin);
  const c = airCentre(T, _ac);
  const R = lerp(lerp(2.4, 1.5, spin), 22, grand), H = lerp(lerp(3.5, 7, spin), 30, grand);
  // one field for everything: cloth (WIND.vortex), CPU streamlines and GPU particles (FIELD.vortex)
  const spinV = lerp(lerp(3.2, 8.5, spin), 14, grand), pull = lerp(0.8, 1.6, spin), up = lerp(0.6, 3.2, spin);
  if (AIR.amt > 0.001) {
    WIND.vortex = WIND.vortex || { c: V3(), r: 1, spin: 0, pull: 0, up: 0, h: 0, amt: 0 };
    Object.assign(WIND.vortex, { r: R, spin: spinV, pull, up, h: H, amt: AIR.amt }); WIND.vortex.c.copy(c);
    FIELD.vortex.set(c.x, c.z, R, AIR.amt); FIELD.vortex2.set(spinV, pull, up, H); FIELD.vortexY = c.y;
  } else if (WIND.vortex) { WIND.vortex.amt = 0; FIELD.vortex.w = 0; }
  updateWindLines(T, dt, AIR.amt * (1 - grand * 0.5), c, R * 1.1, H * 0.8);
  if (dt <= 0 || AIR.amt <= 0.01) return;
  // gathered debris: leaves blown in from beyond the edge, grit and dust off the granite
  const edge = 5 + Math.random() * 4, a = Math.random() * TAU;
  PS.debris.emit({ count: rate(28 * gather, dt), scale: 1, pos: _v1.set(c.x + Math.cos(a) * edge, 0.3 + Math.random() * 1.2, c.z + Math.sin(a) * edge), radius: 1.2, vel: V3(0, 0.6, 0), spread: 1, life: [4, 7], size: [0.025, 0.045], kind: 2 });
  PS.debris.emit({ count: 90 * AIR.amt * dt, pos: c, radius: R * 0.9, vel: V3(0, 0.6, 0), spread: 0.6, life: [0.8, 1.6], size: [0.05, 0.09], kind: 4, param: 0.5 });
  PS.smoke.emit({ count: 14 * AIR.amt * dt, pos: _v1.set(c.x, c.y + 0.08, c.z), radius: R * 0.8, vel: V3(0, 0.2, 0), spread: 0.3, life: [1.6, 3], size: [0.2, 0.4], kind: 1, param: 0.25 });
  if (Math.random() < dt * 4 * gather) PS.debris.emit({ count: 3, scale: 1, pos: _v1.set(c.x, c.y + 0.05, c.z), radius: R, vel: V3(0, 1.2, 0), spread: 0.6, life: [1.5, 2.5], size: [0.01, 0.02], kind: 0 });
  // the last embers of the fire act rise into the spiral
  if (T < 52 && Math.random() < dt * 8) PS.fire.emit({ count: 2, scale: 1, pos: _v1.set(c.x + (Math.random() - 0.5) * 6, 0.2, c.z + (Math.random() - 0.5) * 6), radius: 0.5, vel: V3(0, 0.4, 0), spread: 0.3, life: [2.5, 4], size: [0.004, 0.008], kind: 1, param: 0.6 });
  // the funnel: refraction swirls stacked up the spin, a dust ring racing round the base
  if (spin > 0.05) {
    for (let k = 0; k < 4; k++) distortSprite(_v1.set(c.x, c.y + 0.6 + k * 1.1 + FIG.p.hips.y * 0.4, c.z), 0.9 + k * 0.35, 0.035 * spin, 2, 0, 0);
    PS.smoke.emit({ count: 30 * spin * dt, pos: _v1.set(c.x, c.y + 0.05, c.z), radius: 1.3, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.5, 0), spread: 2.2, life: [1, 1.8], size: [0.2, 0.35], kind: 1, param: 0.2 });
    PS.debris.emit({ count: 160 * spin * dt, pos: _v1.set(c.x, c.y + 0.5, c.z), radius: 1.4, vel: V3(0, 2.5, 0), spread: 0.8, life: [0.6, 1.2], size: [0.06, 0.1], kind: 4, param: 0.9 });
  }
  // at altitude: huge streaks sweep round the mountain with the parting clouds
  if (grand > 0.05) {
    const ga = Math.random() * TAU, gr = 12 + Math.random() * 30;
    PS.debris.emit({ count: 60 * grand * dt, pos: _v1.set(Math.cos(ga) * gr, -4 + Math.random() * 18, Math.sin(ga) * gr), radius: 4, vel: V3(0, 0, 0), spread: 1, life: [1.2, 2.2], size: [0.4, 0.8], kind: 4, param: 0.6 });
  }
}

fxModule({
  init() {
    initWindLines();
    AIR.t.scraps.forEach((tt, i) => atState(tt, () => { const pc = CLOTH.scraps[i]; if (pc) releaseScrap(pc); }, 'scrap ' + i));
    at(AIR.t.gather + 0.2, () => sfx('windRise', { gain: 0.9, dur: 5 }), 'wind rise');
    at(AIR.t.spin, () => sfx('vortex', { gain: 1, dur: 5.5 }), 'vortex');
  },
  reset() { for (const L of AIR.lines) L.alive = false; if (WIND.vortex) WIND.vortex.amt = 0; FIELD.vortex.w = 0; resetCloth(); },
  update(T, dt) {
    if (TL.mode !== 'cinematic') return;
    // scraps stay torn after a seek (the cloth reset re-pins everything)
    AIR.t.scraps.forEach((tt, i) => { const pc = CLOTH.scraps[i]; if (pc && T >= tt && !pc.released) releaseScrap(pc); });
    updateAir(T, dt);
  },
});
