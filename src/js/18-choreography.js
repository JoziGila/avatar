// §18 CHOREOGRAPHY — poses, keys, per-limb overlap ---------------------------------------
// Keys hold full poses; transitions use per-key easing (sharp for strikes, gentle for flow).
// Sampling adds overlapping action: hips lead, the head and hands trail, so the body
// always initiates and the extremities (and the elements after them) follow.
const LOC = {
  pool: V3(LAYOUT.pool.x, 0, LAYOUT.pool.z),
  P1: V3(LAYOUT.pillars[0].x, 0, LAYOUT.pillars[0].z),
  P2: V3(LAYOUT.pillars[1].x, 0, LAYOUT.pillars[1].z),
  P3: V3(LAYOUT.pillars[2].x, 0, LAYOUT.pillars[2].z),
  P4: V3(LAYOUT.pillars[3].x, 0, LAYOUT.pillars[3].z),
  B1: V3(LAYOUT.boulders[0].x, 0, LAYOUT.boulders[0].z),
  erupt: V3(LAYOUT.eruptPillar.x, 0, LAYOUT.eruptPillar.z),
};
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z) / DEG;
const AIR_WALK = { c: [0.9, 0.05], R: 0.9, t0: 47.25, t1: 51.45, steps: 12 };   // Baguazhang circle (Act V)
const YAW = { pool: yawTo(V3(), LOC.pool), P1: yawTo(V3(), LOC.P1), earth: 180, fire: -72 };

// body-frame (x left, z forward) → world, for a figure standing at `o` with facing yaw°
function bw(o, yaw, bx, bz) { const a = yaw * DEG, c = Math.cos(a), s = Math.sin(a); return [o[0] + bx * c + bz * s, o[1] - bx * s + bz * c]; }
const deep = (o) => JSON.parse(JSON.stringify(o));

const POSE_KEYS = new Set(Object.keys(makePose()));
function pose(over = {}, base = null) {
  const P = base ? deep(base) : makePose();
  for (const [k, v] of Object.entries(over)) {
    if (k === 'stance') continue;
    if (!POSE_KEYS.has(k)) { console.warn('unknown pose key', k); continue; }
    if (typeof v === 'string' && (k === 'shapeL' || k === 'shapeR')) P[k] = HAND_SHAPES[v].slice();
    else P[k] = Array.isArray(v) ? v.slice() : v;
  }
  if (over.stance) applyStance(P, over.stance);
  return P;
}
// stance helper: origin, yaw, left/right foot body offsets, toe-out, hip height & offset
function applyStance(P, s) {
  const o = s.o || [0, 0], yaw = s.yaw != null ? s.yaw : P.yaw;
  const L = bw(o, yaw, s.L[0], s.L[1]), R = bw(o, yaw, s.R[0], s.R[1]);
  P.footL = [L[0], L[1], s.liftL || 0, yaw + (s.toeL != null ? s.toeL : 10), s.pitchL || 0];
  P.footR = [R[0], R[1], s.liftR || 0, yaw - (s.toeR != null ? s.toeR : 10), s.pitchR || 0];
  const hb = s.hipOff || [0, 0]; const H = bw(o, yaw, (s.L[0] + s.R[0]) / 2 + hb[0], (s.L[1] + s.R[1]) / 2 + hb[1]);
  P.hip = [H[0], s.h != null ? s.h : 0.93, H[1]];
  P.yaw = yaw;
  if (s.knee) { P.kneeL = [s.knee, 0, 1]; P.kneeR = [-s.knee, 0, 1]; }
  if (s.heelL != null) P.footLx[1] = s.heelL; if (s.heelR != null) P.footRx[1] = s.heelR;
}
// arm presets (left-side convention; the solver mirrors the right side)
const ARM = {
  down: { arm: [6, -76, 0], elbow: [14, 10], hand: [4, 0, 0] },
  relaxFront: { arm: [22, -70, 10], elbow: [34, 30], hand: [8, 0, 0] },
  chamber: { arm: [-38, -64, 72], elbow: [118, 85], hand: [0, 0, 0] },
  guard: { arm: [52, -48, 32], elbow: [112, 55], hand: [-8, 0, 0] },
  thighs: { arm: [30, -64, 8], elbow: [52, 35], hand: [18, 0, 0] },
  palmsUpLow: { arm: [55, -40, -70], elbow: [30, -70], hand: [-10, 0, 0] },
  palmsUpHigh: { arm: [75, 5, -70], elbow: [20, -70], hand: [-20, 0, 0] },
  pressDown: { arm: [40, -52, 0], elbow: [35, 5], hand: [-55, 0, 0] },
  wide: { arm: [8, 12, -40], elbow: [12, -40], hand: [-10, 0, 0] },
  overhead: { arm: [10, 78, 0], elbow: [18, 0], hand: [0, 0, 0] },
};
function arms(P, left, right = left) {
  const a = ARM[left] || left, b = ARM[right] || right;
  P.armL = a.arm.slice(); P.elbowL = a.elbow.slice(); P.handL = a.hand.slice();
  P.armR = b.arm.slice(); P.elbowR = b.elbow.slice(); P.handR = b.hand.slice();
  return P;
}

// ---- key track ----------------------------------------------------------------------------------
const CHOREO = { keys: [], face: [], look: [] };
function key(t, P, ease = 'inOutSine') { CHOREO.keys.push({ t, P, ease }); return P; }
// modify-and-key: clone previous key's pose, apply fn, add as new key
function kf(t, ease, fn) { const prev = CHOREO.keys[CHOREO.keys.length - 1]; const P = deep(prev.P); fn(P); return key(t, P, ease); }

function lerpArr(a, b, t, out) { for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t; return out; }
function lerpPoseInto(A, B, t, O) {
  for (const k of Object.keys(A)) {
    const a = A[k], b = B[k];
    if (Array.isArray(a)) { if (!O[k] || O[k].length !== a.length) O[k] = a.slice(); lerpArr(a, b, t, O[k]); }
    else if (typeof a === 'number') O[k] = a + (b - a) * t;
  }
  return O;
}
const _poseTmp = makePose(), _poseTmp2 = makePose();
function sampleKeys(T, out) {
  const K = CHOREO.keys; if (!K.length) return out;
  if (T <= K[0].t) return lerpPoseInto(K[0].P, K[0].P, 0, out);
  let i = 1; while (i < K.length && K[i].t < T) i++;
  if (i >= K.length) return lerpPoseInto(K[K.length - 1].P, K[K.length - 1].P, 0, out);
  const k0 = K[i - 1], k1 = K[i]; const u = clamp((T - k0.t) / Math.max(1e-4, k1.t - k0.t));
  const e = typeof k1.ease === 'function' ? k1.ease : Ease[k1.ease] || Ease.inOutSine;
  return lerpPoseInto(k0.P, k1.P, e(u), out);
}
// overlap: channel groups sample at small time offsets
const LEAD = { hip: 0.035, yaw: 0.03, pelvis: 0.03, footL: 0.0, footR: 0.0, footLx: 0, footRx: 0, spine: 0.02, chest: 0.01, upperChest: 0.0,
  neck: -0.02, head: -0.035, clavL: 0.0, clavR: 0.0, armL: -0.01, armR: -0.01, elbowL: -0.025, elbowR: -0.025, handL: -0.045, handR: -0.045, shapeL: -0.03, shapeR: -0.03 };
function sampleChoreo(T, out) {
  sampleKeys(T, out);
  for (const [k, dt] of Object.entries(LEAD)) {
    if (!dt) continue;
    sampleKeys(T + dt, _poseTmp);
    const v = _poseTmp[k]; if (Array.isArray(v)) out[k] = v.slice(); else out[k] = v;
  }
  return out;
}

// ================================================================================================
// THE SEQUENCE
// ================================================================================================
function buildChoreography() {
  CHOREO.keys.length = 0;
  const O = [0, 0];
  // ---------------------------------------------------------------- ACT I · BREATH (0–7)
  const kneel = pose({ stance: { o: [0, -0.02], yaw: 0, L: [0.13, -0.3], R: [-0.13, -0.3], h: 0.47, pitchL: 108, pitchR: 108, toeL: 4, toeR: 4 },
    pelvis: [10, 0], spine: [6, 0, 0], chest: [4, 0, 0], neck: [14, 0, 0], head: [12, 0, 0], kneeL: [0.12, -1.2, 1], kneeR: [-0.12, -1.2, 1],
    shapeL: 'relax', shapeR: 'relax', face: [1, 0, 0, 0, 0] });
  arms(kneel, 'thighs');
  key(0, kneel);
  key(2.9, pose({ spine: [4, 0, 0], neck: [10, 0, 0], head: [9, 0, 0] }, kneel), 'inOutSine');
  // lean forward, right foot comes forward: rising half-kneel
  key(3.55, pose({ hip: [0, 0.52, 0.02], pelvis: [22, 0], spine: [16, 0, 0], neck: [4, 0, 0], head: [0, 0, 0],
    footR: [-0.14, 0.34, 0.07, -6, 0], kneeR: [-0.1, 0.3, 1] }, kneel), 'inOutSine');
  key(3.95, pose({ hip: [0.02, 0.6, 0.06], pelvis: [26, 0], spine: [18, 0, 0], footR: [-0.14, 0.38, 0, -8, 0], kneeR: [-0.1, 0.4, 1],
    armL: [30, -60, 8], armR: [40, -58, 10], elbowL: [40, 20], elbowR: [55, 20] }, kneel), 'inOutQuad');
  // stand (pushing through the front foot) and bring the feet together: the scroll's first figure
  key(4.75, arms(pose({ stance: { o: [0, 0.12], yaw: 0, L: [0.085, 0.02], R: [-0.085, 0.02], h: 0.95, toeL: 6, toeR: 6 }, pelvis: [2, 0], spine: [2, 0, 0], neck: [2, 0, 0], head: [2, 0, 0],
    face: [0.85, 0, 0, 0, 0], shapeL: 'relax', shapeR: 'relax' }), 'down'), 'heavy');
  // commencing form of the 24-step form: weight settles right, the left foot steps out to shoulder width
  key(5.05, arms(pose({ stance: { o: [0, 0.12], yaw: 0, L: [0.15, 0.02], R: [-0.085, 0.02], h: 0.94, liftL: 0.045, hipOff: [-0.06, 0] }, face: [0.85, 0, 0, 0, 0], shapeL: 'relax', shapeR: 'relax' }), 'down'), 'inOutSine');
  const open = pose({ stance: { o: [0, 0.12], yaw: 0, L: [0.17, 0.02], R: [-0.17, 0.02], h: 0.95, toeL: 8, toeR: 8 }, face: [0.8, 0, 0, 0, 0], shapeL: 'relax', shapeR: 'relax' });
  key(5.3, arms(pose({}, open), 'down'), 'inOutSine');
  // inhale: the arms float up to shoulder height, palms down, wrists soft, as if lifted by water
  key(5.95, arms(pose({ chest: [-3, 0, 0], head: [-2, 0, 0], shapeL: 'relax', shapeR: 'relax', face: [0.75, 0, 0, 0, 0] }, open), { arm: [82, -6, 0], elbow: [16, 0], hand: [14, 0, 0] }), 'inOutSine');
  // exhale: sink, and the palms press down to the waist — the pebbles tremble
  const horse = arms(pose({ stance: { o: [0, 0.12], yaw: 0, L: [0.21, 0.02], R: [-0.21, 0.02], h: 0.83, toeL: 10, toeR: 10, knee: 0.45 }, pelvis: [5, 0], spine: [2, 0, 0], neck: [2, 0, 0],
    face: [0.8, 0, 0.1, 0, 0], shapeL: 'palm', shapeR: 'palm' }), { arm: [55, -50, 0], elbow: [42, 0], hand: [-62, 0, 0] });
  key(6.5, horse, 'heavy');
  key(6.95, pose({ head: [-2, 0, 0], neck: [0, 0, 0], face: [0, 0, 0.2, 0.15, 0.2] }, horse), 'inOutSine'); // eyes open

  // ---------------------------------------------------------------- ACT II · WATER (7–20)
  const pY = YAW.pool; // ~ -125°
  key(7.35, pose({ head: [0, -35, 0], neck: [0, -20, 0], look: [LOC.pool.x, 0.2, LOC.pool.z, 0.8] }, horse), 'inOutSine');
  // step and pivot to face the pool: left foot steps round, right pivots
  const W0 = [0.1, 0.0];
  key(7.75, arms(pose({ stance: { o: W0, yaw: pY * 0.55, L: [0.2, 0.3], R: [-0.25, -0.1], h: 0.86, liftL: 0.08, heelR: 0.3 }, spine: [0, -12, 0], face: [0, 0, 0.2, 0.1, 0.1],
    look: [LOC.pool.x, 0.2, LOC.pool.z, 0.9], shapeL: 'relax', shapeR: 'relax' }), 'relaxFront'), 'inOutSine');
  const bowPool = arms(pose({ stance: { o: W0, yaw: pY, L: [0.16, 0.38], R: [-0.16, -0.34], h: 0.8, toeL: 4, toeR: 30, knee: 0.35 }, pelvis: [4, 0], spine: [4, 0, 0],
    face: [0, 0, 0.3, 0.2, 0.1], look: [LOC.pool.x, 0.3, LOC.pool.z, 0.7], shapeL: 'relax', shapeR: 'relax' }), 'palmsUpLow');
  key(8.1, bowPool, 'inOutSine');
  // slow upward sweep: palms rise, the pool bulges and the column climbs
  key(9.6, arms(pose({ hip: [bowPool.hip[0], 0.86, bowPool.hip[2]], chest: [-6, 0, 0], head: [-10, 0, 0], shapeL: 'open', shapeR: 'open', look: [LOC.pool.x * 0.6, 2.4, LOC.pool.z * 0.6, 0.6] }, bowPool), 'palmsUpHigh'), 'inOutSine');
  // draw the water in: hands come to the chest, weight shifts back
  // hold the ball: upper hand palm-down at the chest, lower hand palm-up at the waist, the water gathered between
  key(10.4, arms(pose({ hip: [bowPool.hip[0] - Math.sin(pY * DEG) * 0.12, 0.84, bowPool.hip[2] - Math.cos(pY * DEG) * 0.12], spine: [2, 8, 0], chest: [-2, 6, 0], head: [0, 0, 0], shapeL: 'cup', shapeR: 'open',
    look: [0, 0, 0, 0] }, bowPool), { arm: [48, -58, -72], elbow: [62, -70], hand: [-12, 0, 0] }, { arm: [72, -34, 8], elbow: [88, 4], hand: [4, 0, 0] }), 'inOutSine');
  // flowing pivot: turn right through ~180°, arms circling, the ribbon wraps around
  const y1 = pY + 70, y2 = pY + 135, y3 = YAW.P1;
  key(11.1, arms(pose({ stance: { o: [0.05, 0.05], yaw: y1, L: [0.2, 0.15], R: [-0.24, -0.2], h: 0.84, liftR: 0.06, heelR: 0.4 }, spine: [0, 18, 0], chest: [0, 10, 0], shapeL: 'open', shapeR: 'open' }),
    { arm: [95, 10, -40], elbow: [25, -30], hand: [-10, 0, 0] }, { arm: [30, 25, -60], elbow: [20, -50], hand: [-10, 0, 0] }), 'inOutSine');
  key(11.9, arms(pose({ stance: { o: [0.0, 0.1], yaw: y2, L: [0.24, 0.12], R: [-0.2, -0.16], h: 0.86, liftL: 0.05, heelL: 0.3 }, spine: [2, 14, 4], chest: [0, 8, 0], shapeL: 'open', shapeR: 'open' }),
    { arm: [40, 60, -20], elbow: [30, -20], hand: [0, 0, 0] }, { arm: [85, -10, -50], elbow: [40, -50], hand: [-10, 0, 0] }), 'inOutSine');
  const frontP1 = pose({ stance: { o: [-0.05, 0.0], yaw: y3, L: [0.14, 0.42], R: [-0.16, -0.36], h: 0.8, toeL: 4, toeR: 32, knee: 0.4 }, spine: [4, 0, 0], shapeL: 'open', shapeR: 'open', face: [0, 0, 0.4, 0.3, 0.3] });
  key(12.9, arms(pose({ spine: [4, -10, 0], chest: [0, -8, 0] }, frontP1), { arm: [80, 20, -40], elbow: [40, -30], hand: [-10, 0, 0] }, { arm: [70, -10, -30], elbow: [60, -40], hand: [-10, 0, 0] }), 'inOutSine');
  // snake creeps down (anticipation): sink onto the rear leg, the lead leg straight toward the pillar;
  // the lead hand slides low along it while the rear hand hooks high behind — the water runs along the ground
  const coil = arms(pose({ stance: { o: [-0.05, 0.0], yaw: y3, L: [0.12, 0.68], R: [-0.2, -0.3], h: 0.44, toeL: 0, toeR: 62, hipOff: [-0.06, -0.24], liftL: 0, pitchL: 0 },
    pelvis: [22, 0], spine: [26, -10, 0], chest: [8, -6, 0], neck: [-14, 8, 0], head: [-16, 6, 0], kneeL: [0.2, 0.3, 0.2], kneeR: [-0.55, 0.25, 1],
    shapeL: 'palm', shapeR: 'hook', face: [0, 0, 0.7, 0.5, 0.6] }), { arm: [72, -66, -55], elbow: [6, -55], hand: [-20, 0, 0] }, { arm: [-40, 14, 25], elbow: [12, 0], hand: [78, 0, 0] });
  key(13.85, coil, 'inOutCubic');
  // WATER SINGLE WHIP: rise into the bow stance, the lead palm drives the stream at the camera, the hook trails behind
  const whip = arms(pose({ stance: { o: [-0.05, 0.0], yaw: y3, L: [0.14, 0.52], R: [-0.18, -0.3], h: 0.8, toeL: 2, toeR: 42, hipOff: [0, 0.07] },
    pelvis: [4, 0], spine: [6, -8, 0], chest: [2, -6, 0], neck: [-4, 6, 0], head: [-4, 6, 0],
    shapeL: 'palm', shapeR: 'hook', face: [0, 0.35, 0.8, 0.6, 0.2] }), { arm: [86, -2, -8], elbow: [12, -8], hand: [-66, 0, 0] }, { arm: [-40, 6, 22], elbow: [8, 0], hand: [80, 0, 0] });
  key(14.08, whip, 'strike');
  // stop dead — hold while the stream freezes
  key(15.15, pose({ face: [0, 0, 0.8, 0.7, 0.8] }, whip), 'linear');
  // breath, small draw back
  key(15.85, arms(pose({ hip: [whip.hip[0] - Math.sin(y3 * DEG) * 0.14, 0.8, whip.hip[2] - Math.cos(y3 * DEG) * 0.14], spine: [2, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
    shapeL: 'palm', shapeR: 'palm', face: [0, 0, 0.6, 0.4, 0.4] }, whip), { arm: [72, -14, -10], elbow: [62, -10], hand: [-62, 0, 0] }), 'inOutSine');
  // single push launches the spear
  const push = arms(pose({ stance: { o: [0.1 * Math.sin(y3 * DEG), 0.1 * Math.cos(y3 * DEG)], yaw: y3, L: [0.14, 0.5], R: [-0.16, -0.3], h: 0.78, toeR: 30 }, spine: [8, 0, 0], chest: [4, 0, 0],
    shapeL: 'palm', shapeR: 'palm', face: [0, 0.4, 0.8, 0.5, 0] }), { arm: [86, -6, -5], elbow: [6, -10], hand: [-72, 0, 0] });
  key(16.02, push, 'strike');
  key(17.4, pose({ face: [0, 0, 0.4, 0.2, 0.2] }, push), 'outSine');
  // recover and turn toward the back of the platform (earth)
  key(18.6, arms(pose({ stance: { o: [0.05, 0.05], yaw: 100, L: [0.12, 0.05], R: [-0.14, -0.05], h: 0.92 }, shapeL: 'relax', shapeR: 'relax', face: [0, 0, 0.1, 0, 0] }), 'relaxFront'), 'inOutSine');
  key(19.4, arms(pose({ stance: { o: [0, 0], yaw: 165, L: [0.16, 0.0], R: [-0.16, 0.02], h: 0.92, liftR: 0.03 }, shapeL: 'relax', shapeR: 'relax' }), 'down'), 'inOutSine');

  // ---------------------------------------------------------------- ACT III · EARTH (20–33)
  const eY = YAW.earth; const E0 = [0, 0.1];
  const rooted = arms(pose({ stance: { o: E0, yaw: eY, L: [0.46, 0], R: [-0.46, 0], h: 0.68, toeL: 22, toeR: 22, knee: 0.8 }, pelvis: [8, 0], spine: [6, 0, 0], chest: [2, 0, 0], neck: [6, 0, 0], head: [2, 0, 0],
    shapeL: 'palm', shapeR: 'palm', face: [0, 0, 0.5, 0.3, 0.4] }), 'pressDown');
  key(20.8, rooted, 'heavy');
  // anticipation: right knee lifts high, arms rise
  const lift = arms(pose({ stance: { o: E0, yaw: eY, L: [0.2, 0], R: [-0.3, 0.08], h: 0.86, toeL: 18, liftR: 0.52, pitchR: -10, hipOff: [0.16, 0] }, spine: [-2, 0, -6], chest: [-4, 0, 0], head: [-4, 0, 0],
    kneeR: [-0.2, 0.2, 1], shapeL: 'fist', shapeR: 'fist', face: [0, 0.2, 0.7, 0.4, 0.2] }), { arm: [60, 20, -20], elbow: [70, -10], hand: [0, 0, 0] });
  key(21.55, pose({ hip: [lift.hip[0], 0.78, lift.hip[2]], footR: [lift.footR[0], lift.footR[1], 0.25, lift.footR[3], 0] }, lift), 'inOutSine');
  key(22.1, lift, 'outCubic');
  // STOMP
  const stomp = arms(pose({ stance: { o: E0, yaw: eY, L: [0.46, 0], R: [-0.46, 0.04], h: 0.64, toeL: 22, toeR: 22, knee: 0.8 }, pelvis: [10, 0], spine: [12, 0, 0], chest: [6, 0, 0], neck: [6, 0, 0], head: [4, 0, 0],
    shapeL: 'fist', shapeR: 'fist', face: [0, 0.6, 1, 0.6, 0] }), { arm: [35, -58, 10], elbow: [25, 10], hand: [0, 0, 0] });
  key(22.3, stomp, 'inExpo');
  key(22.9, pose({ face: [0, 0, 0.8, 0.5, 0.6] }, stomp), 'outCubic');
  // raise the slabs: strained, heavy rise of the palms
  key(24.5, arms(pose({ hip: [stomp.hip[0], 0.72, stomp.hip[2]], spine: [0, 0, 0], chest: [-6, 0, 0], head: [-6, 0, 0], shapeL: 'claw', shapeR: 'claw', face: [0, 0.3, 1, 0.8, 0.8] }, stomp),
    { arm: [70, -10, -60], elbow: [70, -60], hand: [-30, 0, 0] }), 'heavy');
  key(24.85, arms(pose({ shapeL: 'fist', shapeR: 'fist' }, CHOREO.keys[CHOREO.keys.length - 1].P), { arm: [65, -12, -40], elbow: [95, -30], hand: [0, 0, 0] }), 'outBack');
  // chamber
  const eGuard = arms(pose({ stance: { o: E0, yaw: eY, L: [0.34, 0.1], R: [-0.36, -0.12], h: 0.74, toeL: 14, toeR: 26, knee: 0.6 }, spine: [4, 0, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0, 0.9, 0.6, 0.7] }), 'guard', 'chamber');
  key(25.25, eGuard, 'inOutSine');
  // left punch → slab 1
  const punchL = pose({ spine: [6, -14, 0], chest: [2, -10, 0], ikL: [0.1, 0.5, 0.72, 1], poleL: [0.6, -0.6, -0.2], elbowL: [0, -60], handL: [0, 0, 0], face: [0, 0.5, 1, 0.6, 0] }, eGuard);
  key(25.36, punchL, 'strike');
  key(25.62, pose({ ikL: [0.1, 0.45, 0.5, 0], spine: [4, 0, 0], chest: [0, 0, 0] }, eGuard), 'outCubic');
  // right punch → slab 2
  const punchR = pose({ spine: [6, 16, 0], chest: [2, 12, 0], ikR: [-0.08, 0.5, 0.74, 1], poleR: [-0.6, -0.6, -0.2], elbowR: [0, -60], handR: [0, 0, 0], armL: ARM.chamber.arm, elbowL: ARM.chamber.elbow, face: [0, 0.5, 1, 0.6, 0] }, eGuard);
  key(25.76, punchR, 'strike');
  key(26.05, pose({ ikR: [0, 0.4, 0.4, 0], spine: [2, -10, 0] }, eGuard), 'outCubic');
  // spinning back fist: wind-up, full turn on the left foot, right arm whips around
  key(26.3, pose({ spine: [4, -30, 0], chest: [0, -20, 0], armR: [60, -30, 40], elbowR: [120, 40], hip: [eGuard.hip[0], 0.76, eGuard.hip[2]], footRx: [0, 0.5, 0] }, eGuard), 'inOutQuad');
  const spinMid = pose({ stance: { o: E0, yaw: eY - 180, L: [0.12, 0.05], R: [-0.18, -0.25], h: 0.84, liftR: 0.12, heelL: 0.6 }, spine: [4, 10, 0], shapeL: 'fist', shapeR: 'fist' });
  arms(spinMid, 'guard', { arm: [20, -10, 30], elbow: [60, 30], hand: [0, 0, 0] });
  key(26.52, spinMid, 'inQuad');
  const backfist = arms(pose({ stance: { o: E0, yaw: eY - 350, L: [0.3, 0.08], R: [-0.34, -0.1], h: 0.78, toeL: 16, toeR: 24 }, spine: [6, -12, 0], chest: [2, -8, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0.6, 1, 0.6, 0] }),
    'chamber', { arm: [70, 6, 60], elbow: [6, 60], hand: [20, 0, 0] });
  key(26.75, backfist, 'outQuart');
  key(27.4, pose({ face: [0, 0, 0.7, 0.4, 0.3] }, backfist), 'outSine');
  // settle to the wide stance; gather low
  key(28.5, pose({ yaw: eY - 360 }, arms(pose({}, rooted), 'pressDown')), 'inOutSine');
  const crouch = arms(pose({ stance: { o: E0, yaw: eY - 360, L: [0.44, 0.02], R: [-0.44, 0.02], h: 0.58, toeL: 24, toeR: 24, knee: 0.85 }, pelvis: [16, 0], spine: [20, 0, 0], chest: [8, 0, 0], neck: [-6, 0, 0], head: [-8, 0, 0],
    shapeL: 'fist', shapeR: 'fist', face: [0, 0.2, 1, 0.8, 0.8] }), { arm: [45, -64, 60], elbow: [20, 60], hand: [10, 0, 0] });
  key(29.85, crouch, 'heavy');
  // fists drive upward — the pillar erupts
  const rise = arms(pose({ stance: { o: E0, yaw: eY - 360, L: [0.4, 0.02], R: [-0.4, 0.02], h: 0.86, toeL: 20, toeR: 20 }, pelvis: [-2, 0], spine: [-6, 0, 0], chest: [-6, 0, 0], neck: [-8, 0, 0], head: [-10, 0, 0],
    shapeL: 'fist', shapeR: 'fist', face: [0, 0.7, 1, 0.5, 0] }), { arm: [40, 62, 40], elbow: [30, 40], hand: [0, 0, 0] });
  key(30.08, rise, 'strike');
  key(31.6, pose({ face: [0, 0, 0.5, 0.3, 0.3] }, rise), 'outSine');
  key(33.0, arms(pose({ stance: { o: E0, yaw: eY - 360 + 20, L: [0.2, 0.0], R: [-0.2, 0.0], h: 0.91 }, shapeL: 'relax', shapeR: 'relax', face: [0.1, 0, 0.1, 0, 0] }), 'down'), 'inOutSine');

  // ---------------------------------------------------------------- ACT IV · FIRE (33–47)
  const fY = YAW.fire; const F0 = [0.1, 0.15];
  const fStance = pose({ stance: { o: F0, yaw: fY, L: [0.16, 0.26], R: [-0.18, -0.24], h: 0.84, toeL: 6, toeR: 28, knee: 0.4 }, spine: [2, 0, 0], shapeL: 'relax', shapeR: 'relax', face: [0.2, 0, 0.2, 0.1, 0] });
  key(34.2, arms(pose({}, fStance), 'relaxFront'), 'inOutSine');
  // deep inhale (the scroll's 息氣火 — breath, energy, fire): fists rise to the chest
  key(35.05, arms(pose({ chest: [-6, 0, 0], head: [-4, 0, 0], shapeL: 'fist', shapeR: 'fist', face: [0.2, 0, 0.6, 0.4, 0.6] }, fStance), { arm: [48, -54, 38], elbow: [112, 58], hand: [-8, 0, 0] }), 'inOutSine');
  // sharp exhale: flames ignite in the fists, below the face
  const fGuard = arms(pose({ chest: [2, 0, 0], head: [4, 0, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0.3, 0.9, 0.7, 0.2] }, fStance), { arm: [46, -50, 36], elbow: [108, 56], hand: [-6, 0, 0] });
  key(35.3, fGuard, 'outCubic');
  key(35.85, pose({ face: [0, 0, 0.9, 0.6, 0.6] }, fGuard), 'linear');
  // Northern Shaolin chamber: both fists drawn to the hips, palms up; every jab fires from here
  const fChamber = arms(pose({ chest: [0, 0, 0], head: [2, 0, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0, 0.9, 0.6, 0.6] }, fStance), 'chamber');
  key(36.08, fChamber, 'inOutSine');
  const jabTimes = [36.2, 36.55, 36.9, 37.25, 37.6];
  jabTimes.forEach((t, i) => {
    const L = i % 2 === 0;
    const tgt = L ? [0.06, 0.52, 0.78, 1] : [-0.02, 0.5, 0.8, 1];
    const jab = pose(L ? { ikL: tgt, poleL: [0.7, -0.5, -0.2], elbowL: [0, -40], spine: [4, -10, 0], chest: [2, -6, 0] } : { ikR: tgt, poleR: [-0.7, -0.5, -0.2], elbowR: [0, -40], spine: [4, 12, 0], chest: [2, 8, 0] }, fChamber);
    jab.face = [0, 0.5, 1, 0.7, 0];
    key(t - 0.02, pose(L ? { spine: [2, 6, 0] } : { spine: [2, -6, 0] }, fChamber), 'inOutSine');
    key(t + 0.07, jab, 'strike');
    key(t + 0.26, pose({}, fChamber), 'outCubic');
  });
  // rising kick (right leg) → vertical flame arc
  const kickSet = arms(pose({ stance: { o: F0, yaw: fY, L: [0.14, 0.22], R: [-0.16, -0.1], h: 0.88, toeL: 10, heelR: 0.3 }, spine: [2, 0, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0, 1, 0.6, 0.5] }), 'guard');
  key(38.25, kickSet, 'inOutSine');
  const kickTop = bw(F0, fY, -0.05, 0.62);
  const kickHigh = arms(pose({ stance: { o: F0, yaw: fY, L: [0.1, 0.12], R: [-0.05, 0.62], h: 0.9, toeL: 20, liftR: 1.55, pitchR: 30 }, pelvis: [-18, 0], spine: [-10, 0, 0], chest: [-4, 0, 0], head: [8, 0, 0],
    kneeR: [0, 1, 0.2], shapeL: 'fist', shapeR: 'fist', face: [0, 0.6, 1, 0.5, 0] }), { arm: [20, -30, 20], elbow: [80, 40], hand: [0, 0, 0] }, { arm: [-20, -40, 30], elbow: [60, 40], hand: [0, 0, 0] });
  key(38.62, kickHigh, 'outQuart');
  key(38.95, arms(pose({ stance: { o: F0, yaw: fY, L: [0.12, 0.2], R: [-0.14, 0.34], h: 0.86 }, shapeL: 'fist', shapeR: 'fist' }), 'guard'), 'inCubic');
  // spinning heel kick: turn on the left foot, right leg sweeps a horizontal arc
  key(39.18, arms(pose({ stance: { o: F0, yaw: fY + 110, L: [0.08, 0.2], R: [-0.3, 0.2], h: 0.86, liftR: 0.3, heelL: 0.5 }, spine: [6, 20, 0], shapeL: 'fist', shapeR: 'fist' }), 'guard'), 'inQuad');
  const heel = arms(pose({ stance: { o: F0, yaw: fY + 250, L: [0.08, 0.1], R: [-0.95, 0.05], h: 0.9, liftR: 0.95, pitchR: -10, heelL: 0.6 }, pelvis: [0, 24], spine: [4, 10, 18], chest: [0, 0, 10], head: [0, -20, -10],
    kneeR: [-1, 0.2, 0], shapeL: 'fist', shapeR: 'fist', face: [0, 0.5, 1, 0.6, 0] }), 'guard', { arm: [10, -20, 30], elbow: [40, 30], hand: [0, 0, 0] });
  key(39.55, heel, 'linear');
  key(39.9, arms(pose({ stance: { o: F0, yaw: fY + 360, L: [0.16, 0.24], R: [-0.18, -0.22], h: 0.84 }, shapeL: 'fist', shapeR: 'fist', face: [0, 0, 0.8, 0.5, 0.4] }), 'guard'), 'outCubic');
  // gather: palms cupped at the right hip, deep breath, flames swell
  const fY2 = fY + 360;
  const gather = arms(pose({ stance: { o: F0, yaw: fY2, L: [0.18, 0.36], R: [-0.2, -0.3], h: 0.78, toeR: 34, knee: 0.5 }, spine: [6, -24, 0], chest: [0, -16, 0], neck: [0, 22, 0], head: [0, 14, 0],
    shapeL: 'cup', shapeR: 'cup', face: [0, 0, 1, 0.7, 0.7] }), { arm: [30, -52, -30], elbow: [110, -50], hand: [-40, 0, 0] }, { arm: [-30, -60, -20], elbow: [100, -40], hand: [-40, 0, 0] });
  key(41.8, gather, 'inOutSine');
  // double palm thrust — sustained torrent
  const thrust = arms(pose({ stance: { o: [F0[0] + 0.1 * Math.sin(fY * DEG), F0[1] + 0.1 * Math.cos(fY * DEG)], yaw: fY2, L: [0.18, 0.5], R: [-0.2, -0.28], h: 0.76, toeR: 34 }, spine: [10, 0, 0], chest: [4, 0, 0], neck: [-4, 0, 0],
    shapeL: 'palm', shapeR: 'palm', face: [0, 0.8, 1, 0.8, 0] }), { arm: [86, -10, -4], elbow: [8, -10], hand: [-75, 0, 0] });
  key(42.05, thrust, 'strike');
  key(43.95, pose({ hip: [thrust.hip[0], 0.75, thrust.hip[2]], spine: [12, 0, 0] }, thrust), 'linear');
  key(44.25, pose({ face: [0, 0.2, 0.6, 0.3, 0.3] }, thrust), 'outCubic');
  key(45.6, arms(pose({ stance: { o: F0, yaw: fY2, L: [0.16, 0.3], R: [-0.18, -0.22], h: 0.86 }, shapeL: 'relax', shapeR: 'relax', face: [0.3, 0.2, 0.2, 0, 0] }), 'relaxFront'), 'inOutSine');
  key(46.8, arms(pose({ stance: { o: [0, 0.05], yaw: 360, L: [0.14, 0.0], R: [-0.14, 0.0], h: 0.93 }, shapeL: 'relax', shapeR: 'relax', face: [0.2, 0, 0, 0, 0] }), 'down'), 'inOutSine');

  // ---------------------------------------------------------------- ACT V · AIR (47–58)
  // Baguazhang circle walking: the low mud-wading step around a small circle, the lead palm held
  // toward the centre where the wind gathers; a palm change, then the spiral that lifts the body.
  const aY = 360; const A0 = [0, 0.05];
  const CW = AIR_WALK;
  {
    const { c, R, t0, t1, steps } = CW;
    const dth = TAU / steps, th0 = Math.PI;                 // start on the circle at A0, walk a full turn
    const on = (th, r) => [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)];
    let prev = 360;
    const yawAt = (th) => { let y = Math.atan2(Math.sin(th), -Math.cos(th)) / DEG + 360; while (y - prev > 180) y -= 360; while (y - prev < -180) y += 360; return y; };
    const upper = { spine: [2, 16, 0], chest: [0, 14, 0], neck: [0, 10, 0], head: [-3, 8, 0], face: [0.35, 0, 0.1, 0, 0],
      armL: [46, 14, -45], elbowL: [30, -45], handL: [-42, 0, 0], armR: [100, -16, -35], elbowR: [88, -35], handR: [-30, 0, 0], shapeL: 'palm', shapeR: 'palm' };
    const rIn = R - 0.13, rOut = R + 0.13;
    let thL = th0, thR = th0;
    const place = (P, th, liftL, liftR) => {
      const y = yawAt(th); prev = y;
      const h = on(th, R); P.hip = [h[0], 0.83, h[1]]; P.yaw = y;
      const fl = on(thL, rIn), fr = on(thR, rOut);
      P.footL = [fl[0], fl[1], liftL, yawAt(thL), 0]; prev = y;
      P.footR = [fr[0], fr[1], liftR, yawAt(thR) + 16, 0]; prev = y;
      P.kneeL = [0.3, 0, 1]; P.kneeR = [-0.3, 0, 1];
    };
    const dt = (t1 - t0) / steps;
    // settle into the walking posture on the spot
    const P0 = pose(upper); place(P0, th0, 0, 0); key(t0, P0, 'inOutSine');
    for (let k = 1; k <= steps; k++) {
      const left = k % 2 === 1;
      const thHip0 = th0 - (k - 1) * dth, thHip1 = th0 - k * dth;
      const target = k === steps ? thHip1 : thHip1 - dth / 2;
      const from = left ? thL : thR;
      // mid-step: the moving foot glides low past the standing one
      if (left) thL = (from + target) / 2; else thR = (from + target) / 2;
      const Pm = pose(upper); place(Pm, (thHip0 + thHip1) / 2, left ? 0.035 : 0, left ? 0 : 0.035); key(t0 + (k - 0.5) * dt, Pm, 'linear');
      if (left) thL = target; else thR = target;
      const Pk = pose(upper); place(Pk, thHip1, 0, 0); key(t0 + k * dt, Pk, k === steps ? 'inOutSine' : 'linear');
    }
    // closing half-step: bring the trailing foot level
    thL = thR = th0 - steps * dth;
    const Pc = pose(upper); place(Pc, thL, 0, 0); key(t1 + 0.12, Pc, 'inOutSine');
  }
  // palm change: toe-in and wrap the arms low, then turn out as one palm spirals overhead
  key(51.8, pose({ stance: { o: A0, yaw: 720 + 35, L: [0.12, 0.02], R: [-0.06, 0.12], h: 0.8, toeR: -40, knee: 0.45 }, spine: [6, 20, 0], chest: [4, 12, 0],
    armL: [84, -46, 30], elbowL: [70, 30], handL: [-10, 0, 0], armR: [88, -40, 30], elbowR: [66, 30], handR: [-10, 0, 0], shapeL: 'palm', shapeR: 'palm', face: [0.3, 0, 0.3, 0.1, 0] }), 'inOutSine');
  key(52.15, pose({ stance: { o: A0, yaw: 720 + 75, L: [0.1, 0], R: [-0.12, 0.04], h: 0.9, heelL: 0.35, liftR: 0.06 }, spine: [-4, -10, 0], chest: [-6, -8, 0], head: [-10, 0, 0],
    armL: [20, -58, 0], elbowL: [25, 0], handL: [-20, 0, 0], armR: [14, 76, -20], elbowR: [26, -20], handR: [-20, 0, 0], shapeL: 'open', shapeR: 'open', face: [0.4, 0, 0.2, 0, 0] }), 'inOutSine');
  // spin: pirouette on the left foot, arms extended then drawn in, rising
  const aS = 810;
  key(52.4, arms(pose({ stance: { o: A0, yaw: aS, L: [0.08, 0], R: [-0.12, 0.05], h: 0.92, liftR: 0.15, heelL: 0.5 }, shapeL: 'open', shapeR: 'open', face: [0.4, 0, 0.2, 0, 0] }), 'wide'), 'inQuad');
  key(53.0, arms(pose({ stance: { o: A0, yaw: aS + 270, L: [0.06, 0], R: [-0.06, 0.04], h: 1.1, liftL: 0.15, liftR: 0.22, pitchL: 35, pitchR: 35 }, lift: 0.5, shapeL: 'open', shapeR: 'open', face: [0.6, 0, 0, 0, 0] }), 'wide'), 'linear');
  key(53.6, arms(pose({ stance: { o: A0, yaw: aS + 630, L: [0.06, 0], R: [-0.06, 0.04], h: 1.6, liftL: 0.66, liftR: 0.72, pitchL: 45, pitchR: 45 }, lift: 1, shapeL: 'relax', shapeR: 'relax', face: [0.7, 0, 0, 0, 0] }),
    { arm: [30, -40, 0], elbow: [70, 0], hand: [0, 0, 0] }), 'linear');
  key(55.2, arms(pose({ stance: { o: A0, yaw: aS + 810, L: [0.08, 0.02], R: [-0.08, -0.06], h: 2.6, liftL: 1.75, liftR: 1.66, pitchL: 50, pitchR: 45 }, lift: 1, kneeR: [-0.2, 0.3, 1], shapeL: 'open', shapeR: 'open', face: [0.8, 0, 0, 0, 0] }), 'wide'), 'outSine');
  key(57.8, arms(pose({ stance: { o: A0, yaw: aS + 900, L: [0.08, 0.02], R: [-0.08, -0.08], h: 2.95, liftL: 2.1, liftR: 1.96, pitchL: 50, pitchR: 40 }, lift: 1, head: [-8, 0, 0], shapeL: 'open', shapeR: 'open', face: [0.9, 0, 0, 0, 0] }),
    { arm: [10, -5, -60], elbow: [20, -50], hand: [-10, 0, 0] }), 'inOutSine');

  // ---------------------------------------------------------------- ACT VI · UNITY (58–70)
  const uY = aS + 990; // 1800° ≡ 0: face the default camera side (+Z) again, and loop seamlessly
  const hover = (h, over = {}, st = {}) => pose(Object.assign({ stance: Object.assign({ o: A0, yaw: uY, L: [0.09, 0.03], R: [-0.08, -0.1], h, liftL: h - 0.84, liftR: h - 0.94, pitchL: 50, pitchR: 38 }, st), lift: 1, kneeR: [-0.2, 0.4, 1] }, over));
  key(60.0, arms(hover(3.0, { chest: [-8, 0, 0], head: [-12, 0, 0], shapeL: 'open', shapeR: 'open', face: [0.5, 0, 0, 0, 0] }), { arm: [10, 18, -70], elbow: [14, -70], hand: [-15, 0, 0] }), 'inOutSine');
  key(62.6, arms(hover(3.05, { chest: [-4, 0, 0], head: [-6, 0, 0], shapeL: 'open', shapeR: 'open', face: [0.2, 0, 0.3, 0.2, 0] }), { arm: [35, 5, -60], elbow: [30, -60], hand: [-15, 0, 0] }), 'inOutSine');
  // compression: palms close toward a point in front of the chest
  const comp = hover(3.0, { spine: [10, 0, 0], chest: [8, 0, 0], neck: [6, 0, 0], head: [8, 0, 0], ikL: [0.06, 0.52, 0.34, 1], ikR: [-0.06, 0.52, 0.34, 1], poleL: [0.8, -0.4, -0.4], poleR: [-0.8, -0.4, -0.4],
    handL: [-20, 0, 70], handR: [-20, 0, 70], shapeL: 'open', shapeR: 'open', face: [0.3, 0, 1, 0.8, 0.9] });
  key(64.15, comp, 'inCubic');
  key(64.95, pose({ ikL: [0.05, 0.52, 0.33, 1], ikR: [-0.05, 0.52, 0.33, 1], face: [1, 0, 0.6, 0.3, 0.9] }, comp), 'linear');   // total stillness, eyes closed
  // release: arms fling open, the body arches
  const release = arms(hover(3.05, { spine: [-8, 0, 0], chest: [-12, 0, 0], neck: [-8, 0, 0], head: [-14, 0, 0], shapeL: 'open', shapeR: 'open', face: [0, 0.6, 0, 0, 0] }), { arm: [-10, 25, -80], elbow: [6, -80], hand: [-30, 0, 0] });
  key(65.12, release, 'outExpo');
  key(66.4, pose({ face: [0.4, 0.1, 0, 0, 0] }, release), 'outSine');
  // descend and land softly
  key(67.7, arms(hover(1.05, { lift: 0.4, face: [0.5, 0, 0, 0, 0], shapeL: 'relax', shapeR: 'relax' }, { liftL: 0.08, liftR: 0.05, pitchL: 20, pitchR: 20 }), 'relaxFront'), 'inOutSine');
  key(68.05, arms(pose({ stance: { o: A0, yaw: uY, L: [0.14, 0.04], R: [-0.14, -0.06], h: 0.84, knee: 0.3 }, face: [0.6, 0, 0, 0, 0], shapeL: 'relax', shapeR: 'relax' }), 'relaxFront'), 'outQuad');
  // closing of the 24-step form: cross hands at the chest, then separate and press down as the breath leaves
  key(68.38, arms(pose({ stance: { o: A0, yaw: uY, L: [0.15, 0.04], R: [-0.15, -0.06], h: 0.9 }, face: [0.6, 0, 0, 0, 0], shapeL: 'open', shapeR: 'open' }),
    { arm: [98, -22, 20], elbow: [74, 20], hand: [-8, 0, 0] }), 'inOutSine');
  key(68.78, arms(pose({ stance: { o: A0, yaw: uY, L: [0.14, 0.04], R: [-0.14, -0.06], h: 0.9, knee: 0.3 }, face: [0.75, 0, 0, 0, 0], shapeL: 'palm', shapeR: 'palm' }),
    { arm: [55, -52, 0], elbow: [40, 0], hand: [-58, 0, 0] }), 'inOutSine');
  // return to the kneel
  key(69.2, pose({ hip: [0.0, 0.62, 0.0], pelvis: [16, 0], spine: [12, 0, 0], yaw: uY, footR: [-0.14, 0.3, 0, uY - 6, 0], footL: [0.13, -0.3, 0, uY + 4, 108], kneeL: [0.12, -1.2, 1], face: [0.9, 0, 0, 0, 0] }, arms(pose({}, kneel), 'relaxFront')), 'inOutSine');
  const kneelEnd = pose({ yaw: uY }, kneel);
  key(69.8, kneelEnd, 'inOutSine');
  key(70.0, kneelEnd, 'linear');
  CHOREO.keys.sort((a, b) => a.t - b.t);
}
