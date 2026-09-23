// §20 CAMERA DIRECTOR + GLOBAL TRACKS -------------------------------------------------------
// Shots are pure functions of timeline time (so scrubbing is exact); cuts happen at shot
// boundaries. A trauma model adds shake on impacts; reduced motion removes shake and
// smooths every move with a long time constant.
const CAM = { p: V3(), t: V3(), fov: 35, roll: 0, focus: 4, aperture: 0, shake: 1, shotIndex: -1,
  smoothP: V3(), smoothT: V3(), smoothFov: 35, first: true, handheld: 0.35, anchors: {} };

// anchors from the figure (world)
function refreshAnchors() {
  const f = CHAR.fig; if (!f) return;
  const A = CAM.anchors;
  for (const k of ['head', 'upperChest', 'hips', 'hand_L', 'hand_R', 'foot_L', 'foot_R']) { A[k] = A[k] || V3(); f.anchor(k, A[k]); }
  A.chest = A.chest || V3(); A.chest.copy(A.upperChest).lerp(A.hips, 0.3);
  A.hands = A.hands || V3(); A.hands.copy(A.hand_L).add(A.hand_R).multiplyScalar(0.5);
}
const ease = (u, e = 'inOutSine') => (Ease[e] || Ease.inOutSine)(clamp(u));
const vlerp = (a, b, t) => V3().copy(a).lerp(b, t);
const around = (c, yawDeg, dist, h) => V3(c.x + Math.sin(yawDeg * DEG) * dist, h, c.z + Math.cos(yawDeg * DEG) * dist);

const SHOTS = [];
function shot(t0, t1, name, fn) { SHOTS.push({ t0, t1, name, fn }); }
function buildShots() {
  SHOTS.length = 0;
  const A = CAM.anchors;
  const figC = () => V3(A.hips.x, 0, A.hips.z);
  // ---- I · BREATH
  shot(0, 5.4, 'aerial dolly-in', (u) => {
    const e = ease(u, 'inOutCubic');
    const p = vlerp(V3(-7.5, 8.5, 15.5), V3(-1.1, 1.05, 3.1), e);
    const t = vlerp(V3(0, 0.6, 0), V3(A.head.x, A.head.y - 0.15, A.head.z), smoothstep(0.1, 1, u));
    return { p, t, fov: lerp(28, 30, e), aperture: lerp(0.0, 0.06, e), handheld: 0.15 };
  });
  shot(5.4, 7.0, 'stance low', (u) => {
    const c = figC();
    return { p: vlerp(V3(c.x - 1.9, 0.42, c.z + 1.7), V3(c.x - 1.6, 0.46, c.z + 1.45), u), t: V3(c.x, 0.55, c.z), fov: 34, aperture: 0.09, focusOn: A.hips };
  });
  // ---- II · WATER
  const pool = LOC.pool;
  shot(7.0, 8.25, 'over shoulder to pool', (u) => {
    const c = figC(); const d = V3(pool.x - c.x, 0, pool.z - c.z).normalize(); const side = V3(d.z, 0, -d.x);
    const p = c.clone().addScaledVector(d, -1.5).addScaledVector(side, 0.8).setY(1.55);
    return { p: p.addScaledVector(d, 0.2 * u), t: V3(pool.x, 0.2, pool.z), fov: 36, aperture: 0.05, focusOn: pool };
  });
  shot(8.25, 10.4, 'column rises', (u) => {
    const c = figC(); const d = V3(pool.x - c.x, 0, pool.z - c.z); const len = d.length(); d.normalize(); const side = V3(d.z, 0, -d.x);
    const mid = c.clone().addScaledVector(d, len * 0.52);
    const p = mid.clone().addScaledVector(side, 5.6).setY(0.75 + 0.2 * u).addScaledVector(d, -0.5 * u);
    return { p, t: mid.clone().setY(1.25 + 0.35 * ease(u)), fov: 42, aperture: 0.02 };
  });
  shot(10.4, 13.45, 'orbit ribbon', (u) => {
    const c = figC();
    return { p: around(c, lerp(150, 330, ease(u, 'inOutSine')), 3.3, 1.35 + 0.25 * Math.sin(u * Math.PI)), t: V3(c.x, 1.15, c.z), fov: 36, aperture: 0.06, focusOn: A.chest };
  });
  const p1 = LOC.P1;
  shot(13.45, 14.26, 'whip at camera', (u) => {
    const c = figC(); const d = V3(p1.x - c.x, 0, p1.z - c.z).normalize(); const side = V3(d.z, 0, -d.x);
    const p = c.clone().addScaledVector(d, 3.4).addScaledVector(side, 1.15).setY(1.3);
    const snap = smoothstep(0.55, 1.0, u);
    const tip = c.clone().addScaledVector(d, 2.3).setY(1.3);
    return { p, t: V3(c.x, 1.25, c.z), fov: lerp(42, 32, Ease.outExpo(snap)), aperture: 0.03, focusOn: A.hands.clone().lerp(tip, smoothstep(0.45, 0.62, u)) };
  });
  shot(14.26, 15.95, 'freeze close', (u) => {
    const c = figC(); const d = V3(p1.x - c.x, 0, p1.z - c.z).normalize(); const side = V3(d.z, 0, -d.x);
    const p = A.hands.clone().addScaledVector(side, -1.75).addScaledVector(d, -0.15 + 0.3 * ease(u)).setY(A.hands.y + 0.22);
    return { p, t: A.hands.clone().addScaledVector(d, 0.5).setY(A.hands.y - 0.06), fov: 34, aperture: 0.06, focusOn: A.hands.clone().addScaledVector(d, 0.45) };
  });
  shot(15.95, 16.34, 'launch side', (u) => {
    const c = figC(); const d = V3(p1.x - c.x, 0, p1.z - c.z).normalize(); const side = V3(d.z, 0, -d.x);
    const mid = c.clone().addScaledVector(d, 2.6);
    return { p: mid.clone().addScaledVector(side, 5.2).setY(1.3), t: mid.clone().setY(1.2), fov: 38, aperture: 0.02 };
  });
  shot(16.34, 17.9, 'shatter slow-mo', (u) => {
    const pc = LOC.P1; const c = figC(); const d = V3(pc.x - c.x, 0, pc.z - c.z).normalize(); const side = V3(d.z, 0, -d.x);
    const hit = pc.clone().addScaledVector(d, -0.5).setY(1.35);
    const e = ease(u, 'inOutSine');
    const p = hit.clone().addScaledVector(d, -lerp(1.9, 3.6, e)).addScaledVector(side, lerp(1.0, 1.6, e)).setY(lerp(1.5, 0.9, e));
    return { p, t: hit.clone().lerp(pc.clone().addScaledVector(d, -1.6).setY(0.2), e * 0.8), fov: 36, aperture: 0.06, focusOn: hit };
  });
  shot(17.9, 20.0, 'shards settle wide', (u) => {
    const c = figC();
    return { p: vlerp(V3(4.8, 1.6, 7.2), V3(2.5, 1.05, 4.8), ease(u)), t: V3(c.x + 1.2, 0.7, c.z + 0.9), fov: 38, aperture: 0.02 };
  });
  // ---- III · EARTH (the figure faces −Z, into the afterglow)
  shot(20.0, 22.36, 'ground level', (u) => {
    const c = figC();
    return { p: V3(c.x + 1.6, 0.22, c.z + 2.2 - 0.3 * u), t: V3(c.x - 0.1, 0.9, c.z - 1.0), fov: 44, aperture: 0.03, shake: 1.5 };
  });
  shot(22.36, 25.28, 'slabs rise', (u) => {
    const c = figC();
    return { p: vlerp(V3(c.x - 3.7, 0.4, c.z - 0.2), V3(c.x - 3.3, 0.55, c.z - 0.8), ease(u)), t: V3(c.x + 0.1, 1.05 + 0.15 * u, c.z - 0.55), fov: 40, aperture: 0.03, shake: 1.5 };
  });
  shot(25.28, 27.3, 'combo behind', (u) => {
    const c = figC();
    return { p: V3(c.x + 0.9, 0.55, c.z + 2.3), t: V3(c.x - 0.2, 1.1, c.z - 4.0), fov: 42, aperture: 0.02, shake: 1.6 };
  });
  shot(27.3, 29.95, 'dust drift', (u) => {
    const c = figC();
    return { p: vlerp(V3(c.x + 3.4, 0.7, c.z - 1.8), V3(c.x + 1.4, 0.3, c.z - 3.2), ease(u)), t: V3(c.x, 0.8, c.z), fov: 38, aperture: 0.04 };
  });
  shot(29.95, 33.0, 'pillar beneath camera', (u, lt) => {
    const c = figC();
    const rise = smoothstep(0.02, 0.9, lt);
    return { p: V3(c.x + 1.25, 0.3 + rise * 0.25, c.z - 3.1), t: V3(c.x, 1.05 + rise * 0.45, c.z), fov: 46, aperture: 0.02, shake: 2.0, roll: -2 * rise };
  });
  // ---- IV · FIRE (faces −72°: toward P4 on the left)
  const fy = YAW.fire;
  shot(33.0, 35.1, 'settling wide', (u) => {
    const c = figC();
    return { p: around(c, fy + 150, lerp(6.5, 5.6, u), 1.5), t: V3(c.x, 1.0, c.z), fov: 36, aperture: 0.03 };
  });
  shot(35.1, 36.12, 'face lit from below', (u) => {
    const c = figC();
    const p = A.head.clone().add(V3(Math.sin((fy + 58) * DEG) * 0.95, -0.1, Math.cos((fy + 58) * DEG) * 0.95));
    return { p, t: A.head.clone().add(V3(0, -0.1, 0)), fov: 30, aperture: 0.1, focusOn: A.head };
  });
  const jabAngles = [fy + 35, fy - 60, fy + 150, fy - 20, fy + 80];
  [36.12, 36.47, 36.82, 37.17, 37.52].forEach((t, i) => {
    shot(t, i < 4 ? t + 0.35 : 38.1, 'jab cut ' + i, (u) => {
      const c = figC(); const ang = jabAngles[i];
      const dist = [2.2, 3.0, 2.6, 1.9, 3.4][i], h = [1.3, 0.8, 1.6, 1.1, 0.6][i];
      return { p: around(c, ang, dist, h), t: V3(c.x + Math.sin(fy * DEG) * 1.2, 1.25, c.z + Math.cos(fy * DEG) * 1.2), fov: [32, 40, 36, 30, 44][i], aperture: 0.05, shake: 1.3 };
    });
  });
  shot(38.1, 40.2, 'kicks + whip pan', (u, lt) => {
    const c = figC();
    const pan = smoothstep(1.2, 1.55, lt);
    const p = around(c, fy - 60, 4.2, 1.2);
    const t0 = V3(c.x, 1.3 + 0.6 * smoothstep(0.3, 0.55, lt), c.z);
    const t1 = around(c, fy + 250 + 40, 2.5, 1.1);
    return { p, t: t0.lerp(t1, pan * (1 - smoothstep(1.7, 2.1, lt))), fov: 40, aperture: 0.02, shake: 1.2 };
  });
  shot(40.2, 42.0, 'gather push-in', (u) => {
    const c = figC();
    return { p: vlerp(around(c, fy + 70, 3.2, 1.2), around(c, fy + 55, 2.2, 1.15), ease(u)), t: A.hands.clone(), fov: 34, aperture: 0.08, focusOn: A.hands };
  });
  shot(42.0, 44.05, 'torrent across frame', (u) => {
    const c = figC();
    const fwd = V3(Math.sin(fy * DEG), 0, Math.cos(fy * DEG)); const side = V3(fwd.z, 0, -fwd.x);
    const mid = c.clone().addScaledVector(fwd, 2.8);
    return { p: mid.clone().addScaledVector(side, -6.4).setY(1.4), t: mid.clone().setY(1.0), fov: 44, aperture: 0.0, shake: 0.8 };
  });
  shot(44.05, 47.0, 'embers in silence', (u) => {
    const c = figC();
    const fwd = V3(Math.sin(fy * DEG), 0, Math.cos(fy * DEG));
    const scorch = c.clone().addScaledVector(fwd, 2.4);
    return { p: vlerp(scorch.clone().add(V3(1.2, 0.5, 1.4)), c.clone().add(V3(2.2, 1.3, 2.8)), ease(u)), t: vlerp(scorch.clone().setY(0.1), V3(c.x, 1.1, c.z), ease(u, 'inOutCubic')), fov: 36, aperture: 0.07 };
  });
  // ---- V · AIR
  shot(47.0, 52.1, 'gathering wind', (u) => {
    const c = figC();
    return { p: around(c, lerp(10, 60, u), lerp(4.6, 4.0, u), 1.35), t: V3(c.x, 1.1, c.z), fov: 36, aperture: 0.04 };
  });
  shot(52.1, 55.2, 'rising crane', (u) => {
    const c = figC(); const e = ease(u, 'inOutSine');
    return { p: around(c, lerp(60, 150, e), lerp(4.0, 7.5, e), lerp(1.3, 7.0, e)), t: V3(c.x, A.hips.y + 0.2, c.z), fov: lerp(36, 42, e), aperture: 0.0 };
  });
  shot(55.2, 58.0, 'reveal spiral', (u) => {
    const c = figC(); const e = ease(u, 'inOutCubic');
    return { p: vlerp(around(c, 150, 7.5, 7.0), around(c, 170, 95, 150), e), t: vlerp(V3(c.x, A.hips.y, c.z), V3(0, -60, 0), e), fov: lerp(42, 52, e), aperture: 0.0 };
  });
  // ---- VI · UNITY
  shot(58.0, 63.45, 'orbit rings', (u) => {
    const c = V3(A.hips.x, A.hips.y, A.hips.z);
    return { p: around(c, lerp(200, 330, u), 5.6, c.y + 0.6), t: c.clone().add(V3(0, 0.3, 0)), fov: 38, aperture: 0.03 };
  });
  shot(63.45, 65.0, 'snap in', (u) => {
    const c = V3(A.hips.x, A.hips.y, A.hips.z);
    const snap = Ease.outExpo(smoothstep(0, 0.25, u));
    const tgt = A.hands.clone();
    return { p: vlerp(around(c, 330, 5.6, c.y + 0.6), around(tgt, 345, 1.3, tgt.y + 0.1), snap), t: tgt, fov: lerp(38, 30, snap), aperture: 0.1, focusOn: tgt };
  });
  shot(65.0, 66.7, 'extreme wide release', (u) => {
    return { p: V3(-60, 58, 250).lerp(V3(-70, 70, 270), u), t: V3(0, 2, 0), fov: 38, aperture: 0.0, shake: 0.6 };
  });
  shot(66.7, 68.7, 'descent', (u) => {
    const c = figC();
    return { p: around(c, 20, lerp(5.2, 4.2, u), lerp(2.6, 1.3, u)), t: V3(c.x, A.hips.y, c.z), fov: 36, aperture: 0.05 };
  });
  shot(68.7, 70.0, 'return to stillness', (u) => {
    const c = figC();
    return { p: vlerp(V3(-1.6, 1.1, 3.6), V3(-7.5, 8.5, 15.5), ease(u, 'inCubic') * 0.35), t: V3(c.x, 0.7, c.z), fov: 30, aperture: 0.05 };
  });
}

function shotAt(T) { for (let i = 0; i < SHOTS.length; i++) if (T >= SHOTS[i].t0 && T < SHOTS[i].t1) return i; return SHOTS.length - 1; }

const _shk = V3();
function updateCamera(T, realDt) {
  refreshAnchors();
  const i = shotAt(T); const S = SHOTS[i];
  const u = clamp((T - S.t0) / (S.t1 - S.t0)); const lt = T - S.t0;
  const s = S.fn(u, lt) || {};
  const cut = i !== CAM.shotIndex;
  if (cut) { POST.cut = true; CAM.shotIndex = i; }
  let p = s.p, t = s.t, fov = s.fov || 35;
  if (REDUCED_MOTION && !cut && !CAM.first) {
    const k = 1 - Math.exp(-realDt / 0.45);
    CAM.smoothP.lerp(p, k); CAM.smoothT.lerp(t, k); CAM.smoothFov += (fov - CAM.smoothFov) * k;
    p = CAM.smoothP; t = CAM.smoothT; fov = CAM.smoothFov;
  } else { CAM.smoothP.copy(p); CAM.smoothT.copy(t); CAM.smoothFov = fov; }
  CAM.first = false;
  camera.position.copy(p);
  camera.up.set(0, 1, 0);
  camera.lookAt(t);
  // handheld drift + trauma shake
  const hh = (s.handheld != null ? s.handheld : CAM.handheld) * (REDUCED_MOTION ? 0.25 : 1);
  const rt = U.uRealTime.value;
  const sh = REDUCED_MOTION ? 0 : Math.pow(TL.trauma, 2) * (s.shake || 1);
  camera.rotateX((wobble(rt * 0.6, 1) * 0.004 * hh) + wobble(rt * 22, 3) * 0.035 * sh);
  camera.rotateY((wobble(rt * 0.5, 2) * 0.005 * hh) + wobble(rt * 19, 7) * 0.04 * sh);
  camera.rotateZ((s.roll || 0) * DEG + wobble(rt * 17, 9) * 0.025 * sh);
  if (sh > 0) camera.position.add(_shk.set(wobble(rt * 25, 4), wobble(rt * 23, 5), wobble(rt * 27, 6)).multiplyScalar(0.05 * sh));
  TL.trauma = Math.max(0, TL.trauma - realDt * 1.6);
  // lens: portrait-safe horizontal field of view
  const hMin = 30 * DEG; const vFromH = 2 * Math.atan(Math.tan(hMin / 2) / VIEW.aspect) / DEG;
  camera.fov = Math.max(fov, VIEW.aspect < 1.2 ? Math.min(vFromH, 75) : fov);
  camera.near = 0.06; camera.far = 9000;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  // focus & aperture
  const focusP = s.focusOn || A_head();
  POST.grade.focus = Math.max(0.3, camera.position.distanceTo(focusP));
  POST.grade.aperture = Q.dof ? (s.aperture || 0) : 0;
}
const A_head = () => CAM.anchors.head || V3(0, 1.6, 0);

// ---- global tracks: sky, clouds, wind, grade, fades -------------------------------------------
const SUN_KEYS = [[0, 3.4], [7, 3.0], [20, 1.9], [30, 0.7], [33, -0.3], [35.5, -2.0], [47, -3.8], [58, -5.8], [65, -8.0], [70, -9.5]];
function keysAt(keys, T) { if (T <= keys[0][0]) return keys[0][1]; for (let i = 1; i < keys.length; i++) if (T <= keys[i][0]) { const a = keys[i - 1], b = keys[i]; return lerp(a[1], b[1], smooth01((T - a[0]) / (b[0] - a[0]))); } return keys[keys.length - 1][1]; }
const GRADES = {
  //          exposure temp tint sat contrast bloom thresh vignette grain streak auto-exposure
  breath:  [1.0, 0.05, 0.0, 0.92, 1.06, 0.45, 2.2, 0.42, 0.05, 0.2, 1.0],
  water:   [1.0, -0.12, -0.02, 0.95, 1.07, 0.5, 2.0, 0.38, 0.05, 0.25, 1.0],
  earth:   [1.0, 0.18, 0.03, 0.82, 1.1, 0.4, 2.4, 0.4, 0.06, 0.15, 1.0],
  fire:    [0.85, 0.2, 0.02, 1.05, 1.12, 0.8, 1.6, 0.46, 0.06, 0.35, 0.5],
  air:     [0.95, -0.12, 0.0, 0.82, 1.05, 0.5, 2.0, 0.4, 0.05, 0.25, 0.7],
  unity:   [0.95, -0.18, 0.02, 0.88, 1.1, 0.7, 1.7, 0.44, 0.05, 0.3, 0.72],
};
function applyTracks(T) {
  SKY.sunElev = keysAt(SUN_KEYS, T) * DEG;
  SKY.moonElev = 16 * DEG; SKY.moonAz = 25 * DEG;
  const release = smoothstep(65.0, 66.2, T);
  SKY.starVis = clamp(smoothstep(-2.0, -8.0, SKY.sunElev / DEG) * 0.9 + release * 0.6, 0, 1.2);
  // clouds: spiral (Act V) and blast (Act VI)
  CLOUD.spiral = smoothstep(52.5, 57.5, T) * (1 - smoothstep(69.2, 70, T));
  CLOUD.spiralPhase = (T - 52) * 0.35;
  CLOUD.blast = smoothstep(65.0, 65.2, T) * (1 - smoothstep(69.4, 70, T));
  CLOUD.blastR = lerp(0, 2600, Ease.outCubic(clamp((T - 65.0) / 2.2)));
  CLOUD.offset.set(T * 2.4, 0, -T * 0.9);
  // wind by act
  WIND.strength = keysAt([[0, 0.9], [7, 0.75], [20, 0.55], [33, 0.35], [44, 0.2], [47, 0.6], [58, 0.3], [65, 0.1], [66.5, 1.1], [69, 0.9], [70, 0.9]], T);
  // grade: blend per-act looks across 1 s around act boundaries
  const g = POST.grade; const ai = actAt(T); const A = ACTS[ai], B = ACTS[Math.min(ai + 1, ACTS.length - 1)];
  const k = smoothstep(A.t1 - 1.0, A.t1 + 0.2, T);
  const ga = GRADES[A.id], gb = GRADES[B.id];
  const mix = (i) => lerp(ga[i], gb[i], ai < ACTS.length - 1 ? k : 0);
  g.exposure = mix(0) * FX_STATE.exposureMul; g.temp = mix(1) + FX_STATE.warm * 0.5; g.tint = mix(2); g.saturation = mix(3); g.contrast = mix(4);
  g.bloom = mix(5) * FX_STATE.bloomMul; g.bloomThreshold = mix(6); g.vignette = mix(7); g.grain = mix(8); g.streak = mix(9); g.autoExposure = mix(10);
  g.fade = Math.max(1 - smoothstep(1.0, 3.2, T), smoothstep(68.7, 69.95, T));
  g.shutter = REDUCED_MOTION ? 0.25 : 0.5;
  // letterbox (anatomorphic 2.39:1 in landscape; a slim frame in portrait)
  const target = VIEW.aspect > 1.3 ? 2.39 : VIEW.aspect;
  g.letterbox = VIEW.aspect > 1.3 ? clamp((1 - VIEW.aspect / target) / 2, 0, 0.3) : 0.035;
}
const FX_STATE = { exposureMul: 1, bloomMul: 1, warm: 0 };
