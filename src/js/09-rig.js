// §9 RIG — canonical pose solver, IK, retargeting, GLB figures, AnimationMixer clips --
// Choreography is authored against a canonical skeleton (SKEL_DEF, T-pose, identity
// rest rotations). CanonRig evaluates a pose (FK + two-bone IK + hand shapes + additive
// breathing / secondary motion) into world transforms. A Figure then shows it: the
// procedural SDF figure copies the canonical bones directly; a GLB figure retargets
// them onto its own skeleton (world-space deltas with rest alignment) and re-solves
// leg IK on its real bone lengths so feet plant exactly.

const BONE_N = SKEL_DEF.length;
const HAND_SHAPES = {
  //         curl1 curl2 curl3 spread thumbCurl thumbOpp
  open:    [0.05, 0.05, 0.04, 0.25, 0.0, 0.15],
  relax:   [0.28, 0.38, 0.3, 0.1, 0.25, 0.3],
  fist:    [1.0, 1.0, 0.85, 0.0, 0.75, 0.85],
  palm:    [0.0, 0.0, 0.0, 0.0, 0.15, 0.0],
  blade:   [0.02, 0.0, 0.0, -0.05, 0.6, 0.7],
  claw:    [0.35, 0.8, 0.75, 0.45, 0.4, 0.5],
  cup:     [0.25, 0.32, 0.2, 0.05, 0.2, 0.55],
  hook:    [0.62, 0.55, 0.3, -0.15, 0.45, 0.95],   // Tai Chi hook hand: fingertips gathered to the thumb
};
function handParams(h) {
  if (!h) return HAND_SHAPES.relax;
  if (typeof h === 'string') return HAND_SHAPES[h] || HAND_SHAPES.relax;
  return h;
}

// Pose record (plain numbers so it can be interpolated channel by channel)
function makePose() {
  return {
    hip: [0, 0.95, 0], yaw: 0, pelvis: [0, 0],      // hips position (x, height above ground, z), facing yaw°, pelvis pitch/roll°
    spine: [0, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], // pitch, yaw, roll (°)
    clavL: [0, 0], clavR: [0, 0],                    // raise, forward
    armL: [0, -78, 0], armR: [0, -78, 0],            // forward, raise, twist
    elbowL: [10, 0], elbowR: [10, 0],                 // flex, forearm twist (pronation)
    handL: [0, 0, 0], handR: [0, 0, 0],               // flex (toward palm), deviation, extra roll
    shapeL: HAND_SHAPES.relax.slice(), shapeR: HAND_SHAPES.relax.slice(),
    ikL: [0, 0, 0, 0], ikR: [0, 0, 0, 0],             // body-frame target x,y,z + weight
    poleL: [0.3, -0.4, -0.6], poleR: [-0.3, -0.4, -0.6], // elbow hint (body frame)
    footL: [0.11, 0.0, 0, 0, 0], footR: [-0.11, 0.0, 0, 0, 0], // world x, world z, lift, yaw°, pitch°
    footLx: [0, 0, 0], footRx: [0, 0, 0],             // roll°, heel raise (0..1), toe bend°
    kneeL: [0.25, 0, 1], kneeR: [-0.25, 0, 1],        // knee pole (body frame)
    face: [0, 0, 0, 0, 0],                            // blink, jaw, brow, squint, press
    look: [0, 0, 0, 0],                               // head look-at world target + weight
    lift: 0,                                          // airborne lift (feet unplanted), 0..1
  };
}

// --- quaternion helpers -------------------------------------------------------------
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _ea = new THREE.Euler();
const qEuler = (x, y, z, order, out = new THREE.Quaternion()) => out.setFromEuler(_ea.set(x * DEG, y * DEG, z * DEG, order));
const qMirror = (q) => q.set(q.x, -q.y, -q.z, q.w);
// rotation from the basis (X,Y,Z) → (x', y', z')
const _mb = new THREE.Matrix4();
function qFromBasis(x, y, z, out) { _mb.makeBasis(x, y, z); return out.setFromRotationMatrix(_mb); }

// Two-bone IK helper: returns the knee/elbow position given root A, target T, lengths, pole direction
function ikMid(A, T, l1, l2, pole, out) {
  const d = _v1.subVectors(T, A); let dist = d.length();
  const maxR = (l1 + l2) * 0.9995, minR = Math.abs(l1 - l2) * 1.001 + 1e-4;
  dist = clamp(dist, minR, maxR);
  const dir = d.normalize();
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pp = _v2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-8) pp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pp.normalize();
  return out.copy(A).addScaledVector(dir, cosA * l1).addScaledVector(pp, sinA * l1);
}

// --- canonical rig --------------------------------------------------------------------
class CanonRig {
  constructor() {
    this.local = Array.from({ length: BONE_N }, () => new THREE.Quaternion());
    this.world = Array.from({ length: BONE_N }, () => new THREE.Quaternion());
    this.pos = Array.from({ length: BONE_N }, () => new THREE.Vector3());
    this.parent = SKEL_DEF.map((b) => (b.parent ? SKEL_INDEX[b.parent] : -1));
    this.offset = SKEL_DEF.map((b, i) => { const p = this.parent[i]; const o = V3(...b.p); if (p >= 0) o.sub(V3(...SKEL_DEF[p].p)); return o; });
    this.I = SKEL_INDEX;
    this.len = (a, b) => V3(...restPos(a)).distanceTo(V3(...restPos(b)));
    this.thighLen = this.len('thigh_L', 'shin_L'); this.shinLen = this.len('shin_L', 'foot_L');
    this.upperLen = this.len('upperArm_L', 'forearm_L'); this.foreLen = this.len('forearm_L', 'hand_L');
    this.ankleH = restPos('foot_L')[1];
    this.hipRest = V3(...restPos('hips'));
    // secondary motion springs (spine / head lag, arm swing)
    this.spring = { v: V3(), x: V3(), prevHip: null, hv: V3() };
    this.breath = 0;
    this.footWorld = { L: V3(), R: V3() };
    this.footGround = { L: V3(), R: V3() };
    this.planted = { L: 1, R: 1 };
  }
  fk(i) {
    const p = this.parent[i];
    if (p < 0) { this.world[i].copy(this.local[i]); return; }
    this.world[i].multiplyQuaternions(this.world[p], this.local[i]);
    this.pos[i].copy(this.offset[i]).applyQuaternion(this.world[p]).add(this.pos[p]);
  }
  fkChain(from) { // recompute world for bone `from` and all its descendants (bones are in parent-first order)
    const start = this.I[from];
    const inSub = new Uint8Array(BONE_N); inSub[start] = 1; this.fk(start);
    for (let i = start + 1; i < BONE_N; i++) { const p = this.parent[i]; if (p >= 0 && inSub[p]) { inSub[i] = 1; this.fk(i); } }
  }
  setLocalFromWorld(name, qWorld) {
    const i = this.I[name], p = this.parent[i];
    this.local[i].copy(this.world[p]).invert().multiply(qWorld);
  }

  // Evaluate a pose → world transforms. dt drives springs (0 = snap).
  solve(P, dt = 0, extra = null) {
    const I = this.I, L = this.local;
    for (const q of L) q.identity();
    // hips
    const gy = groundHeight(P.hip[0], P.hip[2]);
    const hipW = _v3.set(P.hip[0], gy + P.hip[1], P.hip[2]);
    // secondary: hips acceleration drives a damped spring that sways the upper body
    const sp = this.spring;
    if (!sp.prevHip || dt <= 0) { sp.prevHip = hipW.clone(); sp.hv.set(0, 0, 0); sp.x.set(0, 0, 0); sp.v.set(0, 0, 0); }
    else {
      const vel = _v4.subVectors(hipW, sp.prevHip).divideScalar(Math.max(dt, 1e-3));
      const acc = vel.clone().sub(sp.hv).divideScalar(Math.max(dt, 1e-3));
      sp.hv.copy(vel); sp.prevHip.copy(hipW);
      const k = 60, c = 11;
      acc.clampLength(0, 40);
      sp.v.addScaledVector(acc.multiplyScalar(-0.0022), 1).addScaledVector(sp.x, -k * dt).multiplyScalar(Math.exp(-c * dt));
      sp.x.addScaledVector(sp.v, dt);
      sp.x.clampLength(0, 0.12);
    }
    this.pos[I.root].set(hipW.x, gy, hipW.z);
    this.world[I.root].identity(); L[I.root].identity();
    qEuler(P.pelvis[0], P.yaw, -P.pelvis[1], 'YXZ', L[I.hips]);
    this.world[I.hips].copy(L[I.hips]); this.pos[I.hips].copy(hipW);
    // spine chain (+ breathing + spring lag expressed in the body frame)
    const yawQ = qEuler(0, P.yaw, 0, 'YXZ', _qc);
    const lag = sp.x.clone().applyQuaternion(yawQ.clone().invert());
    const br = this.breath;
    qEuler(P.spine[0] + lag.z * 60, P.spine[1], -P.spine[2] + lag.x * 60, 'YXZ', L[I.spine]);
    qEuler(P.chest[0] - br * 1.2 + lag.z * 40, P.chest[1], -P.chest[2] + lag.x * 40, 'YXZ', L[I.chest]);
    qEuler(P.upperChest[0] - br * 1.8, P.upperChest[1], -P.upperChest[2], 'YXZ', L[I.upperChest]);
    qEuler(P.neck[0] + br * 0.8 - lag.z * 50, P.neck[1], -P.neck[2] - lag.x * 30, 'YXZ', L[I.neck]);
    qEuler(P.head[0] + br * 0.6 - lag.z * 40, P.head[1], -P.head[2], 'YXZ', L[I.head]);
    // arms (authored for the left side; right mirrored)
    for (const s of ['L', 'R']) {
      const R = s === 'R';
      const clav = P['clav' + s], arm = P['arm' + s], el = P['elbow' + s], hd = P['hand' + s];
      const setM = (name, q) => { if (R) qMirror(q); L[I[name + '_' + s]].copy(q); };
      setM('clavicle', qEuler(0, -clav[1], clav[0] + br * 2.2, 'YZX'));
      setM('upperArm', qEuler(arm[2], -arm[0], arm[1], 'YZX'));
      setM('forearm', qEuler(0, -el[0], 0, 'YZX'));
      setM('forearmTwist', qEuler(el[1] * 0.5, 0, 0, 'YZX'));
      setM('hand', qEuler(el[1] * 0.5 + hd[2], hd[1], -hd[0], 'XZY'));
      this.setFingers(s, P['shape' + s]);
    }
    // FK everything once
    for (let i = 1; i < BONE_N; i++) if (i !== I.hips) this.fk(i);
    // head look-at (additive, weighted)
    if (P.look[3] > 0.001) this.lookAt(P.look, P.look[3]);
    // arm IK (blended over FK by weight)
    for (const s of ['L', 'R']) { const ik = P['ik' + s]; if (ik[3] > 0.001) this.armIK(s, P, ik); }
    // legs: IK to foot targets
    for (const s of ['L', 'R']) this.legIK(s, P);
    if (extra) extra(this);
  }

  setFingers(s, sh) {
    const I = this.I, L = this.local, R = s === 'R';
    const [c1, c2, c3, spread, tc, to] = sh;
    const spreads = { index: 1, middle: 0.1, ring: -0.8, pinky: -1.6 };
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      const q1 = qEuler(0, spreads[f] * spread * 9, -(c1 * 88), 'YZX');
      const q2 = qEuler(0, 0, -(c2 * 100), 'YZX');
      const q3 = qEuler(0, 0, -(c3 * 70), 'YZX');
      if (R) { qMirror(q1); qMirror(q2); qMirror(q3); }
      L[I[`${f}1_${s}`]].copy(q1); L[I[`${f}2_${s}`]].copy(q2); L[I[`${f}3_${s}`]].copy(q3);
    }
    // thumb: opposition swings it under the palm, curl folds it
    const ax = V3(0.78, 0, -0.62).normalize();
    const t1 = new THREE.Quaternion().setFromAxisAngle(V3(0.35, -0.2, 0.9).normalize(), -to * 0.9).multiply(new THREE.Quaternion().setFromAxisAngle(ax, tc * 0.35));
    const t2 = new THREE.Quaternion().setFromAxisAngle(ax, tc * 0.75);
    const t3 = new THREE.Quaternion().setFromAxisAngle(ax, tc * 0.9);
    if (R) { qMirror(t1); qMirror(t2); qMirror(t3); }
    L[I['thumb1_' + s]].copy(t1); L[I['thumb2_' + s]].copy(t2); L[I['thumb3_' + s]].copy(t3);
  }

  lookAt(look, w) {
    const I = this.I; const hi = I.head;
    const target = _v1.set(look[0], look[1], look[2]);
    const dir = target.sub(this.pos[hi]).normalize();
    const fwd = _v2.set(0, 0, 1).applyQuaternion(this.world[hi]);
    const q = _qa.setFromUnitVectors(fwd, dir);
    // limit and weight
    const ang = 2 * Math.acos(clamp(q.w, -1, 1));
    const maxA = 70 * DEG; const k = ang > maxA ? maxA / ang : 1;
    _qb.identity().slerp(q, k * w);
    // split between neck (40%) and head (60%)
    const qn = _qc.identity().slerp(_qb, 0.4);
    const nw = new THREE.Quaternion().multiplyQuaternions(qn, this.world[I.neck]);
    this.setLocalFromWorld('neck', nw); this.fkChain('neck');
    const q2 = new THREE.Quaternion().identity().slerp(_qb, 0.6);
    const hw = new THREE.Quaternion().multiplyQuaternions(q2, this.world[hi]);
    this.setLocalFromWorld('head', hw); this.fkChain('head');
  }

  armIK(s, P, ik) {
    const I = this.I, R = s === 'R', w = ik[3];
    const up = I['upperArm_' + s], fo = I['forearm_' + s], ha = I['hand_' + s];
    // target in body frame (hips position + facing yaw)
    const yawQ = qEuler(0, P.yaw, 0, 'YXZ', new THREE.Quaternion());
    const T = V3(ik[0], ik[1], ik[2]).applyQuaternion(yawQ).add(this.pos[I.hips]);
    const pole = V3(...P['pole' + s]).applyQuaternion(yawQ);
    const A = this.pos[up].clone();
    const B = ikMid(A, T, this.upperLen, this.foreLen, pole, new THREE.Vector3());
    const dU = B.clone().sub(A).normalize(), dF = T.clone().sub(B).normalize();
    // left: bone axis +X, hinge -Y ; right mirrored: bone axis -X
    const ax = R ? dU.clone().negate() : dU.clone();
    let hinge = new THREE.Vector3().crossVectors(dU, dF);
    if (hinge.lengthSq() < 1e-6) hinge.copy(pole).cross(dU);
    hinge.normalize();
    const yAx = R ? hinge.clone() : hinge.clone().negate();
    const zAx = new THREE.Vector3().crossVectors(ax, yAx).normalize(); yAx.crossVectors(zAx, ax).normalize();
    const qU = qFromBasis(ax, yAx, zAx, new THREE.Quaternion());
    const axF = R ? dF.clone().negate() : dF.clone();
    const zF = new THREE.Vector3().crossVectors(axF, yAx).normalize(); const yF = new THREE.Vector3().crossVectors(zF, axF).normalize();
    const qF = qFromBasis(axF, yF, zF, new THREE.Quaternion());
    // blend with FK in world space
    const qUw = this.world[up].clone().slerp(qU, w);
    this.setLocalFromWorld('upperArm_' + s, qUw); this.fk(up);
    const qFw = this.world[fo].clone().slerp(qF, w);
    const handWorldBefore = this.world[ha].clone(); // keep authored hand orientation relative to forearm
    this.setLocalFromWorld('forearm_' + s, qFw);
    this.fkChain('forearm_' + s);
  }

  legIK(s, P) {
    const I = this.I, R = s === 'R';
    const th = I['thigh_' + s], sh = I['shin_' + s], ft = I['foot_' + s], toe = I['toe_' + s];
    const f = P['foot' + s], fx = P['foot' + s + 'x'];
    const yawF = f[3] * DEG, pitch = f[4] * DEG, roll = fx[0] * DEG, heel = fx[1];
    const gx = f[0], gz = f[1];
    const gnd = groundHeight(gx, gz);
    // foot orientation: yaw, then terrain alignment (when planted), then pitch/roll
    const qYaw = new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), yawF);
    const n = groundNormal(gx, gz, new THREE.Vector3());
    const planted = 1 - clamp(f[2] / 0.06);
    const qTer = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), n); _qa.identity().slerp(qTer, planted);
    const qFoot = new THREE.Quaternion().multiplyQuaternions(_qa, qYaw);
    // heel raise pivots about the ball of the foot
    const heelAng = heel * 38 * DEG;
    qFoot.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch + heelAng, 0, R ? -roll : roll, 'XZY')));
    // ankle target: ground contact + ankle height along foot up, adjusted for heel raise (pivot at the ball)
    const ball = V3(...restPos('toe_' + s)).sub(V3(...restPos('foot_' + s))); // ankle → ball (rest)
    const ballW = ball.clone().applyQuaternion(qYaw).add(V3(gx, gnd + this.ankleH + f[2], gz));
    const ankle = ballW.clone().sub(ball.clone().applyQuaternion(qFoot));
    if (heel <= 0 && f[2] <= 0) ankle.set(gx, gnd + this.ankleH, gz);
    else if (heel <= 0) ankle.set(gx, gnd + this.ankleH + f[2], gz);
    this.footGround[s].set(gx, gnd, gz);
    const A = this.pos[th].clone();
    const kp = P['knee' + s]; const yawQ = qEuler(0, P.yaw, 0, 'YXZ', new THREE.Quaternion());
    const pole = V3(kp[0] * (R ? 1 : 1), kp[1], kp[2]).applyQuaternion(yawQ).add(V3(0, 0, 0));
    pole.add(V3(0, 0, 1).applyQuaternion(qYaw).multiplyScalar(0.6)).normalize();
    const B = ikMid(A, ankle, this.thighLen, this.shinLen, pole, new THREE.Vector3());
    const dT = B.clone().sub(A).normalize(), dS = ankle.clone().sub(B).normalize();
    // thigh basis: -Y along the bone, Z toward the knee's front
    const yT = dT.clone().negate();
    let zT = pole.clone().addScaledVector(dT, -pole.dot(dT)).normalize();
    // make sure knee "front" is consistent with the bend (shin goes backwards)
    const bend = new THREE.Vector3().crossVectors(dT, dS);
    const xT = new THREE.Vector3().crossVectors(yT, zT).normalize(); zT.crossVectors(xT, yT).normalize();
    if (bend.lengthSq() > 1e-6) { const xb = bend.normalize().negate(); if (xb.dot(xT) < 0) xb.negate(); xT.copy(xb); zT.crossVectors(xT, yT).normalize(); }
    const qT = qFromBasis(xT, yT, zT, new THREE.Quaternion());
    this.setLocalFromWorld('thigh_' + s, qT); this.fk(th);
    const yS = dS.clone().negate(); const zS = new THREE.Vector3().crossVectors(xT, yS).normalize(); const xS = new THREE.Vector3().crossVectors(yS, zS).normalize();
    const qS = qFromBasis(xS, yS, zS, new THREE.Quaternion());
    this.setLocalFromWorld('shin_' + s, qS); this.fk(sh);
    this.setLocalFromWorld('foot_' + s, qFoot); this.fk(ft);
    // toes stay flat on the ground when the heel lifts
    const toeQ = new THREE.Quaternion().multiplyQuaternions(_qa, qYaw);
    if (fx[2]) toeQ.multiply(new THREE.Quaternion().setFromAxisAngle(V3(1, 0, 0), fx[2] * DEG));
    const flat = new THREE.Quaternion().copy(this.world[ft]).slerp(toeQ, clamp(heel * 1.4 + (fx[2] ? 1 : 0)));
    this.setLocalFromWorld('toe_' + s, flat); this.fk(toe);
    this.footWorld[s].copy(this.pos[ft]);
    this.planted[s] = planted * (1 - P.lift);
  }
}

// --- GLB bone name matching ------------------------------------------------------------
const BONE_ALIASES = {
  hips: ['hips', 'pelvis', 'hip', 'root_hips', 'bip01pelvis', 'cpelvis'],
  spine: ['spine', 'spine1', 'spine01', 'abdomen', 'spinelower', 'bip01spine'],
  chest: ['spine2', 'spine02', 'chest', 'spine1', 'bip01spine1', 'spinemiddle'],
  upperChest: ['spine3', 'spine03', 'upperchest', 'chestupper', 'spine2', 'bip01spine2', 'spineupper'],
  neck: ['neck', 'neck1', 'neck01', 'bip01neck'],
  head: ['head', 'bip01head'],
  clavicle: ['shoulder', 'clavicle', 'collar', 'clav'],
  upperArm: ['upperarm', 'arm', 'uparm', 'shoulderlower'],
  forearm: ['forearm', 'lowerarm', 'elbow', 'forearmroll'],
  hand: ['hand', 'wrist'],
  thigh: ['upleg', 'thigh', 'upperleg', 'legupper'],
  shin: ['leg', 'calf', 'lowerleg', 'shin', 'knee', 'leglower'],
  foot: ['foot', 'ankle'],
  toe: ['toebase', 'toe', 'toes', 'ball', 'toe0'],
};
const FINGER_ALIASES = { thumb: ['thumb', 'finger0'], index: ['index', 'indexfinger', 'finger1', 'pointer'], middle: ['middle', 'finger2'], ring: ['ring', 'finger3'], pinky: ['pinky', 'little', 'finger4'] };
function normName(n) {
  return n.toLowerCase().replace(/^mixamorig[:_]?/, '').replace(/^(def|org|mch)[-_.]/, '').replace(/^j_bip_[lcr]_/, '').replace(/^cc_base_/, '').replace(/[\s_.:\-]/g, '');
}
function sideOf(raw) {
  const n = raw.toLowerCase();
  if (/(^|[^a-z])(left|l)([^a-z]|$)|left|_l$|\.l$|^l_|lft/.test(n) && !/right/.test(n)) return 'L';
  if (/(^|[^a-z])(right|r)([^a-z]|$)|right|_r$|\.r$|^r_|rgt/.test(n)) return 'R';
  if (/j_bip_l_|bip01_l_|bip01 l /.test(n)) return 'L';
  if (/j_bip_r_|bip01_r_|bip01 r /.test(n)) return 'R';
  return null;
}
function mapSkeleton(bones) {
  const info = bones.map((b) => {
    let raw = b.name; const side = sideOf(raw);
    let n = normName(raw).replace(/^bip01/, '').replace(/^(left|right)/, '').replace(/(left|right)$/, '');
    if (side) n = n.replace(/^[lr](?=[a-z])/, '').replace(/[lr]$/, '');
    let depth = 0; let p = b.parent; while (p && p.isBone) { depth++; p = p.parent; }
    return { b, raw, n, side, depth };
  });
  const map = {};
  const find = (aliases, side, pred = () => true) => {
    for (const a of aliases) {
      const c = info.filter((x) => x.n === a && (side ? x.side === side : !x.side) && pred(x));
      if (c.length) return c.sort((p, q) => p.depth - q.depth)[0].b;
    }
    return null;
  };
  map.hips = find(BONE_ALIASES.hips, null) || info.filter((x) => !x.side).sort((p, q) => p.depth - q.depth).map((x) => x.b).find((b) => b.children.filter((c) => c.isBone).length >= 3) || null;
  // spine chain: walk from hips toward the head through non-sided bones
  const headB = find(BONE_ALIASES.head, null);
  if (map.hips && headB) {
    const chain = []; let p = headB.parent;
    while (p && p !== map.hips && p.isBone) { chain.unshift(p); p = p.parent; }
    const neckB = chain.length ? chain[chain.length - 1] : null;
    const spineB = chain.slice(0, -1);
    map.neck = neckB; map.head = headB;
    if (spineB.length >= 3) { map.spine = spineB[0]; map.chest = spineB[Math.floor(spineB.length / 2)]; map.upperChest = spineB[spineB.length - 1]; }
    else if (spineB.length === 2) { map.spine = spineB[0]; map.upperChest = spineB[1]; }
    else if (spineB.length === 1) { map.spine = spineB[0]; }
  }
  for (const s of ['L', 'R']) {
    for (const k of ['clavicle', 'upperArm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe']) {
      let b = find(BONE_ALIASES[k], s, (x) => k !== 'upperArm' || !/forearm|lower/.test(x.n));
      if (k === 'shin') b = find(['calf', 'lowerleg', 'shin', 'leg', 'knee', 'leglower'], s, (x) => !/up/.test(x.n));
      map[k + '_' + s] = b;
    }
    // fingers: chains under the hand
    const hand = map['hand_' + s];
    if (hand) {
      for (const [f, al] of Object.entries(FINGER_ALIASES)) {
        const cands = info.filter((x) => x.side === s && al.some((a) => x.n.startsWith(a) && /\d?$/.test(x.n)));
        // Biped style: finger0, finger01, finger02 → order by depth
        const roots = cands.filter((x) => { let p = x.b.parent; return p === hand; });
        let root = roots.length ? roots[0].b : null;
        if (!root) { const byDepth = cands.sort((p, q) => p.depth - q.depth); root = byDepth.length ? byDepth[0].b : null; }
        const chain = []; let c = root;
        while (c && chain.length < 3) { chain.push(c); c = c.children.find((ch) => ch.isBone); }
        chain.forEach((b, k) => { map[`${f}${k + 1}_${s}`] = b; });
      }
    }
  }
  return map;
}

// --- Figure base ----------------------------------------------------------------------------
class Figure {
  constructor() { this.root = new THREE.Group(); this.root.name = 'Figure'; this.kind = 'base'; this.markers = {}; this.faceWeights = [0, 0, 0, 0, 0]; }
  anchor(name, out) { return out.set(0, 1, 0); }
  update() {}
}

// Procedural SDF figure: the canonical skeleton is its own skeleton.
class ProceduralFigure extends Figure {
  constructor() {
    super(); this.kind = 'procedural';
    const geo = buildCharacterGeometry();
    this.bones = SKEL_DEF.map((d) => { const b = new THREE.Bone(); b.name = d.name; return b; });
    SKEL_DEF.forEach((d, i) => {
      const p = d.parent ? SKEL_INDEX[d.parent] : -1;
      const o = V3(...d.p); if (p >= 0) o.sub(V3(...SKEL_DEF[p].p));
      this.bones[i].position.copy(o);
      if (p >= 0) this.bones[p].add(this.bones[i]);
    });
    this.skeleton = new THREE.Skeleton(this.bones);
    this.mesh = new THREE.SkinnedMesh(geo, makeProceduralSkinMaterial());
    this.mesh.add(this.bones[0]);
    this.mesh.bind(this.skeleton);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    this.colliderRadii = { thighL: 0.09, thighR: 0.09, shinL: 0.062, shinR: 0.062, upperL: 0.055, upperR: 0.055, foreL: 0.045, foreR: 0.045, torso: 0.15, hips: 0.2 };
    this.markers.hair = { bone: this.bones[SKEL_INDEX.head], local: V3(0, 1.607, -0.098).sub(V3(...restPos('head'))) };
    this.markers.sash = { bone: this.bones[SKEL_INDEX.hips], local: V3(0.108, 0.978, 0.135).sub(V3(...restPos('hips'))) };
    this.markers.skirt = { bone: this.bones[SKEL_INDEX.hips], local: V3(0, 0.935, -0.005).sub(V3(...restPos('hips'))), radii: Array.from({ length: 24 }, (_, a) => { const th = a / 24 * TAU; return 0.2 + 0.035 * Math.abs(Math.cos(th)); }) };
    this.boneFor = (canon) => this.bones[SKEL_INDEX[canon]];
    this.hairColor = new THREE.Color(0.016, 0.011, 0.009);
    this.info = 'procedural figure';
  }
  apply(C) {
    for (let i = 0; i < BONE_N; i++) this.bones[i].quaternion.copy(C.local[i]);
    this.bones[SKEL_INDEX.root].position.copy(C.pos[SKEL_INDEX.root]);
    this.bones[SKEL_INDEX.hips].position.copy(C.pos[SKEL_INDEX.hips]).sub(C.pos[SKEL_INDEX.root]);
    this.root.updateMatrixWorld(true);
  }
  anchor(name, out) { const b = this.bones[SKEL_INDEX[name]] || this.bones[0]; return b.getWorldPosition(out); }
}

// GLB figure: retargets the canonical pose, owns an AnimationMixer for the model's clips.
class GLBFigure extends Figure {
  constructor(gltf, opts = {}) {
    super(); this.kind = 'glb'; this.gltf = gltf; this.info = opts.label || 'loaded model';
    const scene = gltf.scene || gltf.scenes[0];
    this.model = scene;
    let skinned = [];
    scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    if (!skinned.length) throw new Error('No skinned mesh found — the model needs a skeleton (rig).');
    this.skinned = skinned;
    this.skeleton = skinned.reduce((a, m) => (m.skeleton.bones.length > a.bones.length ? m.skeleton : a), skinned[0].skeleton);
    for (const m of skinned) { m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; }
    const bones = this.skeleton.bones;
    this.map = mapSkeleton(bones);
    const need = ['hips', 'head', 'upperArm_L', 'upperArm_R', 'forearm_L', 'forearm_R', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R', 'foot_L', 'foot_R'];
    const missing = need.filter((k) => !this.map[k]);
    if (missing.length) throw new Error('Could not find these bones: ' + missing.join(', ') + '. Humanoid rigs from Mixamo, Unreal, Rigify or VRM work best.');
    // the node transforms of a glTF rig are its rest pose (Skeleton.pose() would rebuild it in the
    // skin's bind space, which differs from world space whenever the mesh node carries a transform)
    scene.updateMatrixWorld(true);
    // scale so the leg length matches the canonical figure; stand on the ground
    const legT = this.map.thigh_L.getWorldPosition(V3()).distanceTo(this.map.foot_L.getWorldPosition(V3()));
    const legC = V3(...restPos('thigh_L')).distanceTo(V3(...restPos('foot_L')));
    this.scale = legC / Math.max(legT, 1e-4);
    this.inner = new THREE.Group(); this.inner.add(scene); this.inner.scale.setScalar(this.scale);
    this.root.add(this.inner);
    // face the canonical +Z: estimate the model's forward from the toe/foot or head offset
    this.root.updateMatrixWorld(true);
    const fwd = this.estimateForward();
    this.inner.quaternion.setFromUnitVectors(fwd, V3(0, 0, 1));
    this.root.updateMatrixWorld(true);
    const footY = Math.min(this.map.foot_L.getWorldPosition(V3()).y, this.map.foot_R.getWorldPosition(V3()).y);
    let minY = 1e9; for (const m of skinned) { m.geometry.computeBoundingBox(); }
    this.ankleH = this.estimateAnkleHeight(footY);
    this.inner.position.y -= (footY - this.ankleH);
    this.root.updateMatrixWorld(true);
    // rest world data for every bone (after scale/orientation)
    this.restWorldQ = new Map(); this.restLocalQ = new Map(); this.restLocalP = new Map();
    for (const b of bones) { this.restWorldQ.set(b, b.getWorldQuaternion(new THREE.Quaternion())); this.restLocalQ.set(b, b.quaternion.clone()); this.restLocalP.set(b, b.position.clone()); }
    // alignment rotations: target rest bone direction → canonical rest bone direction
    this.align = {};
    const childCanon = {
      hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
    };
    for (const s of ['L', 'R']) Object.assign(childCanon, {
      ['clavicle_' + s]: 'upperArm_' + s, ['upperArm_' + s]: 'forearm_' + s, ['forearm_' + s]: 'hand_' + s, ['hand_' + s]: 'middle1_' + s,
      ['thigh_' + s]: 'shin_' + s, ['shin_' + s]: 'foot_' + s, ['foot_' + s]: 'toe_' + s,
      ['thumb1_' + s]: 'thumb2_' + s, ['thumb2_' + s]: 'thumb3_' + s, ['index1_' + s]: 'index2_' + s, ['index2_' + s]: 'index3_' + s,
      ['middle1_' + s]: 'middle2_' + s, ['middle2_' + s]: 'middle3_' + s, ['ring1_' + s]: 'ring2_' + s, ['ring2_' + s]: 'ring3_' + s,
      ['pinky1_' + s]: 'pinky2_' + s, ['pinky2_' + s]: 'pinky3_' + s,
    });
    this.order = [];
    for (const [c, tb] of Object.entries(this.map)) {
      if (!tb || SKEL_INDEX[c] === undefined) continue;
      let A = new THREE.Quaternion();
      const cc = childCanon[c]; const tc = cc ? this.map[cc] : null;
      if (cc && tc) {
        const dT = tc.getWorldPosition(V3()).sub(tb.getWorldPosition(V3())).normalize();
        const dC = V3(...restPos(cc)).sub(V3(...restPos(c))).normalize();
        if (dT.lengthSq() > 0.5) A.setFromUnitVectors(dT, dC);
      } else if (/^(index3|middle3|ring3|pinky3|thumb3)_/.test(c)) {
        // distal phalanx: reuse the parent's alignment
        const pc = c.replace('3_', '2_'); A = this.align[pc] ? this.align[pc].clone() : A;
      }
      this.align[c] = A;
      this.order.push({ c, ci: SKEL_INDEX[c], b: tb });
    }
    // parent-first order of target bones
    const depth = (b) => { let d = 0; let p = b.parent; while (p) { d++; p = p.parent; } return d; };
    this.order.sort((a, b) => depth(a.b) - depth(b.b));
    this.mapped = new Set(this.order.map((o) => o.b));
    this.hipsRestWorld = this.map.hips.getWorldPosition(V3());
    this.hipsOffset = this.hipsRestWorld.clone().sub(V3(...restPos('hips')));
    this.lens = {};
    for (const s of ['L', 'R']) {
      this.lens['thigh' + s] = this.map['thigh_' + s].getWorldPosition(V3()).distanceTo(this.map['shin_' + s].getWorldPosition(V3()));
      this.lens['shin' + s] = this.map['shin_' + s].getWorldPosition(V3()).distanceTo(this.map['foot_' + s].getWorldPosition(V3()));
    }
    // markers baked into the default character (sash knot, skirt ring, hair tail, colliders)
    scene.traverse((o) => {
      if (/^Marker_/.test(o.name)) {
        const k = o.userData && o.userData.kind;
        if (k === 'hair') this.markers.hair = { obj: o };
        if (k === 'sash') this.markers.sash = { obj: o };
        if (k === 'skirt') this.markers.skirt = { obj: o, radii: (o.userData.radii || []).map((r) => r * this.scale) };
        if (k === 'colliders') this.colliderRadii = Object.fromEntries(Object.entries(o.userData.radii || {}).map(([a, v]) => [a, v * this.scale]));
      }
    });
    if (!this.colliderRadii) this.colliderRadii = { thighL: 0.085, thighR: 0.085, shinL: 0.06, shinR: 0.06, upperL: 0.05, upperR: 0.05, foreL: 0.04, foreR: 0.04, torso: 0.15, hips: 0.19 };
    this.hasGarments = !!scene.getObjectByName('Garment');
    this.boneFor = (canon) => this.map[canon] || null;
    // facial blendshapes
    this.morphMeshes = skinned.filter((m) => m.morphTargetDictionary);
    this.setupMaterials();
    this.setupMixer();
  }
  estimateForward() {
    // both feet's toes point forward (splay cancels out); fall back to the facing implied by left/right
    const d = V3();
    for (const s of ['L', 'R']) { const f = this.map['foot_' + s], t = this.map['toe_' + s]; if (f && t) d.add(t.getWorldPosition(V3()).sub(f.getWorldPosition(V3()))); }
    d.y = 0;
    const lr = this.map.thigh_L.getWorldPosition(V3()).sub(this.map.thigh_R.getWorldPosition(V3())); lr.y = 0; // points to the figure's left
    const fromLR = V3(-lr.z, 0, lr.x).normalize(); // left = +X when facing +Z → forward = rotate left by -90°
    if (d.lengthSq() > 1e-6) { d.normalize(); if (d.dot(fromLR) < 0.3) return fromLR; return d.add(fromLR).normalize(); }
    return fromLR.lengthSq() > 0.5 ? fromLR : V3(0, 0, 1);
  }
  estimateAnkleHeight(footY) {
    let minY = 1e9; const v = V3();
    for (const m of this.skinned) {
      const p = m.geometry.attributes.position; const step = Math.max(1, Math.floor(p.count / 4000));
      for (let i = 0; i < p.count; i += step) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); if (v.y < minY) minY = v.y; }
    }
    return clamp(footY - minY, 0.03, 0.2);
  }
  setupMaterials() {
    for (const m of this.skinned) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const out = mats.map((mt) => {
        if (/garment/i.test(m.name) || /garment/i.test(mt.name)) return makeGarmentMaterial(mt);
        return makeSkinMaterialFromGLB(mt, /head/i.test(m.name) || /head/i.test(mt.name));
      });
      m.material = Array.isArray(m.material) ? out : out[0];
    }
  }
  setupMixer() {
    const clips = this.gltf.animations || [];
    this.clips = {};
    const classify = (n) => {
      n = n.toLowerCase();
      if (/breath|breathe/.test(n)) return 'breathe';
      if (/punch|jab|strike|hook|cross/.test(n)) return 'punch';
      if (/kick/.test(n)) return 'kick';
      if (/spin|turn|twirl|roundhouse/.test(n)) return 'spin';
      if (/stance|guard|fight|ready|combat/.test(n)) return 'stance';
      if (/idle|stand|rest|neutral|tpose/.test(n)) return 'idle';
      return null;
    };
    for (const c of clips) { const k = classify(c.name); if (k && !this.clips[k]) this.clips[k] = c; }
    if (!Object.keys(this.clips).length && clips.length) this.clips.idle = clips[0];
    // the mixer drives a hidden copy of the bone hierarchy; results are layered in apply()
    let rootBone = this.skeleton.bones[0]; while (rootBone.parent && rootBone.parent.isBone) rootBone = rootBone.parent;
    // include a non-joint rig root (e.g. a biped's centre-of-mass node) so its tracks bind too
    const top = rootBone.parent && rootBone.parent !== this.model && !rootBone.parent.isScene && rootBone.parent.children.length === 1 ? rootBone.parent : rootBone;
    this.clipRoot = top.clone(true);
    this.clipRoot.traverse((o) => { const src = this.skeleton.getBoneByName(o.name); if (src) { o.quaternion.copy(this.restLocalQ.get(src)); o.position.copy(this.restLocalP.get(src)); } });
    this.clipBones = new Map(); this.clipRoot.traverse((o) => { const src = this.skeleton.getBoneByName(o.name); if (src) this.clipBones.set(src, o); });
    this.mixer = new THREE.AnimationMixer(this.clipRoot);
    this.actions = {};
    for (const [k, c] of Object.entries(this.clips)) {
      if (k === 'breathe') {
        const add = THREE.AnimationUtils.makeClipAdditive(c.clone(), 0);
        const a = this.mixer.clipAction(add); a.blendMode = THREE.AdditiveAnimationBlendMode; a.setEffectiveWeight(0); a.play();
        this.actions.breathe = a;
      } else {
        const a = this.mixer.clipAction(c); a.setEffectiveWeight(0); a.play(); this.actions[k] = a;
      }
    }
    this.clipWeight = 0;       // how much the base clip pose shows through (free-play idle)
    this.currentBase = null;
    this.useClips = true;
  }
  // crossfade the mixer's base layer (idle / stance / punch / kick / spin)
  playBase(kind, fade = 0.35) {
    if (!this.useClips) return false;
    const next = this.actions[kind]; if (!next) return false;
    if (this.currentBase === kind) return true;
    const prev = this.currentBase ? this.actions[this.currentBase] : null;
    next.reset(); next.setEffectiveWeight(1); next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false); else next.fadeIn(fade);
    this.currentBase = kind;
    return true;
  }
  apply(C, dt, layer = {}) {
    // 1) mixer (hidden rig): base clip + additive breathing
    const breathW = layer.breath != null ? layer.breath : 0;
    if (this.actions.breathe) this.actions.breathe.setEffectiveWeight(breathW);
    this.mixer.update(dt);
    // 2) retarget the canonical pose onto the model
    const tmpW = new THREE.Quaternion();
    const worldQ = new Map();
    const parentWorld = (b) => {
      const p = b.parent; if (!p || !p.isBone) return p ? p.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      if (worldQ.has(p)) return worldQ.get(p);
      const q = parentWorld(p).clone().multiply(p.quaternion); worldQ.set(p, q); return q;
    };
    this.root.updateMatrixWorld(true);
    const clipW = this.clipWeight;
    for (const o of this.order) {
      const b = o.b;
      const qc = C.world[o.ci];
      tmpW.copy(qc).multiply(this.align[o.c]).multiply(this.restWorldQ.get(b));
      const pw = parentWorld(b);
      const local = pw.clone().invert().multiply(tmpW);
      if (clipW > 0.001) { const cb = this.clipBones.get(b); if (cb) local.slerp(cb.quaternion, clipW); }
      b.quaternion.copy(local);
      worldQ.set(b, pw.clone().multiply(local));
    }
    // additive breathing delta from the mixer (clip bone local vs rest)
    if (this.actions.breathe && breathW > 0.001) {
      for (const o of this.order) {
        if (!/spine|chest|neck|clavicle|head/i.test(o.c)) continue;
        const cb = this.clipBones.get(o.b); if (!cb) continue;
        const d = this.restLocalQ.get(o.b).clone().invert().multiply(cb.quaternion);
        o.b.quaternion.multiply(d);
      }
    }
    // hips position (world) → local of its parent
    const hips = this.map.hips;
    const hw = C.pos[SKEL_INDEX.hips].clone().add(this.hipsOffset.clone().applyQuaternion(C.world[SKEL_INDEX.hips]));
    if (clipW > 0.001) { /* keep canonical placement; clip root motion is ignored for stability */ }
    hips.parent.updateMatrixWorld(true);
    hips.position.copy(hips.parent.worldToLocal(hw));
    this.root.updateMatrixWorld(true);
    // 3) leg IK on the model's real proportions: plant the ankles exactly
    for (const s of ['L', 'R']) this.legIK(s, C);
    // 4) face
    this.applyFace(layer.face || this.faceWeights);
    this.root.updateMatrixWorld(true);
  }
  legIK(s, C) {
    const th = this.map['thigh_' + s], sh = this.map['shin_' + s], ft = this.map['foot_' + s];
    const ciF = SKEL_INDEX['foot_' + s];
    const target = C.pos[ciF].clone();
    target.y += this.ankleH - C.ankleH; // model ankle height differs from the canonical one
    const A = th.getWorldPosition(V3()), B = sh.getWorldPosition(V3()), Cc = ft.getWorldPosition(V3());
    const pole = B.clone().sub(A.clone().lerp(Cc, 0.5)); if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
    const Bn = ikMid(A, target, this.lens['thigh' + s], this.lens['shin' + s], pole.normalize(), new THREE.Vector3());
    const footWorldQ = ft.getWorldQuaternion(new THREE.Quaternion());
    // rotate thigh so A→B aligns with A→Bn
    const q1 = new THREE.Quaternion().setFromUnitVectors(B.clone().sub(A).normalize(), Bn.clone().sub(A).normalize());
    const thW = th.getWorldQuaternion(new THREE.Quaternion()); const nthW = q1.multiply(thW);
    th.quaternion.copy(th.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(nthW)); th.updateMatrixWorld(true);
    const B2 = sh.getWorldPosition(V3()), C2 = ft.getWorldPosition(V3());
    const q2 = new THREE.Quaternion().setFromUnitVectors(C2.clone().sub(B2).normalize(), target.clone().sub(B2).normalize());
    const shW = sh.getWorldQuaternion(new THREE.Quaternion()); const nshW = q2.multiply(shW);
    sh.quaternion.copy(sh.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(nshW)); sh.updateMatrixWorld(true);
    ft.quaternion.copy(sh.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(footWorldQ)); ft.updateMatrixWorld(true);
  }
  applyFace(f) {
    for (const m of this.morphMeshes) {
      const d = m.morphTargetDictionary, inf = m.morphTargetInfluences;
      const set = (k, v) => { if (d[k] !== undefined) inf[d[k]] = clamp(v); };
      set('eyeBlinkLeft', f[0]); set('eyeBlinkRight', f[0]);
      set('jawOpen', f[1] * 0.6); set('mouthFunnel', f[1] * 0.35);
      set('browDownLeft', f[2]); set('browDownRight', f[2]);
      set('eyeSquintLeft', f[3]); set('eyeSquintRight', f[3]);
      set('mouthPressLeft', f[4]); set('mouthPressRight', f[4]);
    }
  }
  anchor(name, out) {
    const b = this.map[name] || this.map.hips; return b.getWorldPosition(out);
  }
}

// --- figure materials -----------------------------------------------------------------------
// Shared lighting tweak: wrap-lit skin with a warm scattering band at the terminator.
function injectSkinLighting(sh) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment.replace('vec3 irradiance = dotNL * directLight.color;', `vec3 irradiance = dotNL * directLight.color;
      if (spSkinW > 0.0) {
        float wn = dot(geometryNormal, directLight.direction);
        float wrapD = saturate((wn + 0.5) / 1.5);
        vec3 sss = directLight.color * max(wrapD - dotNL, 0.0) * vec3(1.0, 0.36, 0.2) * spSkinW;
        reflectedLight.directDiffuse += sss * BRDF_Lambert(material.diffuseColor) * 1.4;
      }`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nfloat spSkinW = 0.0;')
    .replace('#include <lights_physical_pars_fragment>', chunk);
}
function makeSkinMaterialFromGLB(src, isHead) {
  const m = new THREE.MeshPhysicalMaterial({
    map: src.map || null, normalMap: src.normalMap || null, roughnessMap: src.roughnessMap || null,
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1), roughness: src.roughnessMap ? 1 : 0.55, metalness: 0,
    normalScale: new THREE.Vector2(1, 1), specularIntensity: 0.55, sheen: 0,
    transparent: !!src.transparent, alphaTest: src.alphaTest || 0, side: src.side || THREE.FrontSide,
  });
  if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
  m.name = 'skin:' + (src.name || '');
  patchWorldMaterial(m, Object.assign((sh) => {
    injectSkinLighting(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      spSkinW = ${isHead ? '0.85' : '1.0'};`);
  }, { key: 'glbskin' + (isHead ? 'h' : '') }));
  return m;
}
// Garment: albedo in vertex colour, AO in its alpha, roughness/sheen in uv1, wrap phase in uv.
function makeGarmentMaterial(src) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(1, 1, 1), side: THREE.DoubleSide });
  m.name = 'garment';
  m.userData.key = 'garment';
  patchWorldMaterial(m, Object.assign((sh) => {
    sh.uniforms.uClothN = { value: TEX.clothV }; sh.uniforms.uTime = U.uTime; sh.uniforms.uDust = CHAR_U.uDust; sh.uniforms.uWet = CHAR_U.uWet;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n#ifndef USE_UV1\nattribute vec2 uv1;\n#endif\nvarying vec2 vGUv; varying vec2 vGP; varying vec3 vRest; varying vec3 vRestN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGUv = uv; vGP = uv1; vRest = position; vRestN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vGUv; varying vec2 vGP; varying vec3 vRest; varying vec3 vRestN; uniform sampler2D uClothN; uniform float uDust, uWet;
        float gAO; float gRough; float gSheen; float gH;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          #ifdef USE_COLOR_ALPHA
          gAO = vColor.a;
          #else
          gAO = 1.0;
          #endif
          diffuseColor.a = 1.0; gRough = vGP.x; gSheen = vGP.y;
          vec3 rp = vRest * 0.01;               // armature space is centimetres
          vec3 an = abs(normalize(vRestN)); an = pow(an, vec3(4.0)); an /= an.x + an.y + an.z;
          float sc = 26.0;
          float wv = texture2D(uClothN, rp.zy * sc).a * an.x + texture2D(uClothN, rp.xz * sc).a * an.y + texture2D(uClothN, rp.xy * sc).a * an.z;
          vec4 vv = texture2D(uClothN, rp.zy * 3.0) * an.x + texture2D(uClothN, rp.xz * 3.0) * an.y + texture2D(uClothN, rp.xy * 3.0) * an.z;
          // wrap bands: spiral phase encoded as a direction, its length = wrap membership
          vec2 wd = (vGUv - 0.5) * 2.0; float wm = clamp(length(wd), 0.0, 1.0);
          float ph = atan(wd.y, wd.x) / 6.2831853;
          float band = fract(ph);
          float edge = smoothstep(0.0, 0.08, band) * (1.0 - smoothstep(0.9, 1.0, band) * 0.6);
          gH = wv * 0.35 + wm * (edge * 0.9 + 0.2 * sin(band * 40.0));
          // weathering: sun-bleached shoulders, dust toward the hems, frayed wear, darker band edges on wraps
          float fade = smoothstep(0.35, 0.9, vv.b) * 0.35 + smoothstep(120.0, 150.0, vRest.y) * 0.15;
          vec3 col = diffuseColor.rgb;
          col = mix(col, col * vec3(1.25, 1.22, 1.15) + 0.01, fade);
          float hem = 1.0 - smoothstep(10.0, 55.0, vRest.y);
          col = mix(col, col * vec3(1.12, 1.02, 0.9) + vec3(0.02, 0.016, 0.01), hem * 0.6 + uDust * 0.25);
          col *= mix(1.0, 0.72 + 0.28 * edge, wm);
          col *= 0.9 + 0.2 * vv.r;
          col *= mix(1.0, 0.6, uWet);
          diffuseColor.rgb = col;
          gRough = mix(gRough, 0.55, uWet * 0.8);
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 dh = vec2(dFdx(gH), dFdy(gH)) * 0.0015; // height in metres
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor = mix(vec3(1.0), diffuseColor.rgb * 3.0 + 0.1, 0.55) * gSheen * 0.22;
        material.sheenRoughness = 0.6;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gAO; reflectedLight.indirectSpecular *= gAO;
        reflectedLight.directDiffuse *= mix(0.6, 1.0, gAO);`);
  }, { key: 'garment' }));
  return m;
}
const CHAR_U = { uDust: { value: 0 }, uWet: { value: 0 } };

// Procedural figure material: per-vertex albedo/props from the SDF sculpt.
function makeProceduralSkinMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(1, 1, 1) });
  m.name = 'procedural-figure';
  patchWorldMaterial(m, Object.assign((sh) => {
    injectSkinLighting(sh);
    sh.uniforms.uClothN = { value: TEX.clothV };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aProps; attribute vec4 aPat; attribute vec3 aRest; attribute vec3 aRestN; varying vec4 vProps; varying vec4 vPat; varying vec3 vRest; varying vec3 vRestN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvProps = aProps; vPat = aPat; vRest = aRest; vRestN = aRestN;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vProps; varying vec4 vPat; varying vec3 vRest; varying vec3 vRestN; uniform sampler2D uClothN; float gH;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 an = abs(normalize(vRestN)); an = pow(an, vec3(4.0)); an /= an.x + an.y + an.z;
          float wv = texture2D(uClothN, vRest.zy * 26.0).a * an.x + texture2D(uClothN, vRest.xz * 26.0).a * an.y + texture2D(uClothN, vRest.xy * 26.0).a * an.z;
          // wrap bands: spiral around forearm (x axis) or shin (y axis)
          float ax = abs(vRest.x) > 0.4 ? abs(vRest.x) : vRest.y;
          vec2 cr = abs(vRest.x) > 0.4 ? vec2(vRest.z + 0.015, vRest.y - 1.425) : vec2(vRest.z, abs(vRest.x) - 0.09);
          float band = fract(ax / 0.032 + atan(cr.y, cr.x) / 6.2831853);
          float edge = smoothstep(0.0, 0.08, band);
          float skinPores = sp_vnoise(vRest * 900.0);
          gH = vPat.x * wv * 0.4 + vPat.y * edge * 0.8 + vPat.z * sin(atan(vRest.x, vRest.z + 0.02) * 260.0 + vRest.y * 30.0) * 0.3 + vProps.z * skinPores * 0.08;
          diffuseColor.rgb *= mix(1.0, 0.75 + 0.25 * edge, vPat.y);
          diffuseColor.rgb *= 1.0 - clamp(vPat.w, 0.0, 1.0) * 0.8;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 0.8, 0.8), clamp(-vPat.w, 0.0, 1.0));
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vProps.x;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 dh = vec2(dFdx(gH), dFdy(gH)) * 0.0012;
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        spSkinW = vProps.z;
        material.sheenColor = mix(vec3(1.0), diffuseColor.rgb * 3.0 + 0.1, 0.5) * vProps.y * 0.22;
        material.sheenRoughness = 0.6;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vProps.w; reflectedLight.indirectSpecular *= vProps.w;
        reflectedLight.directDiffuse *= mix(0.65, 1.0, vProps.w);`);
  }, { key: 'procfig' }));
  return m;
}

// --- loading -----------------------------------------------------------------------------------------
async function parseGLB(buffer, label) {
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  // use <img> decoding for embedded textures: works in sandboxed hosts where fetch(blob:) may be blocked
  loader.register((parser) => { parser.textureLoader = new THREE.TextureLoader(parser.options.manager); return { name: 'sp_img_textures' }; });
  const gltf = await loader.parseAsync(buffer, '');
  return new GLBFigure(gltf, { label });
}
function embeddedCharacterBuffer() {
  const el = document.getElementById('sp-character');
  if (!el || !el.textContent.trim()) return null;
  const s = atob(el.textContent.trim()); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
