// §8 CHARACTER — SDF sculpt, surface nets, skinning --------------------------------
// The fallback figure is sculpted from signed-distance primitives (anatomy), clothed
// with offset shells restricted to garment regions (inner linen, robe, sash, wraps,
// trousers, hair), meshed with surface nets on three grids (body / head / hands) and
// skinned by distance-weighted primitive ownership. Rest pose: T-pose facing +Z,
// every bone with identity rest rotation (so local rotations are world deltas).

// ---- skeleton definition -------------------------------------------------------
const FINGERS = {
  index: { base: [0.094, 0.001, 0.026], dir: [1, 0, 0.07], segs: [0.043, 0.025, 0.021], r: [0.0098, 0.0088, 0.0078, 0.0068] },
  middle: { base: [0.097, 0.002, 0.006], dir: [1, 0, 0.0], segs: [0.047, 0.029, 0.022], r: [0.0102, 0.0091, 0.008, 0.007] },
  ring: { base: [0.092, 0.0, -0.013], dir: [1, 0, -0.06], segs: [0.044, 0.027, 0.021], r: [0.0096, 0.0086, 0.0077, 0.0067] },
  pinky: { base: [0.083, -0.002, -0.031], dir: [1, 0, -0.14], segs: [0.034, 0.021, 0.019], r: [0.0085, 0.0077, 0.0069, 0.006] },
  thumb: { base: [0.024, -0.013, 0.023], dir: [0.62, -0.3, 0.72], segs: [0.041, 0.033, 0.027], r: [0.0135, 0.0112, 0.0098, 0.0082] },
};
function buildSkeletonDef() {
  const D = [];
  const add = (name, parent, p) => D.push({ name, parent, p: p.slice() });
  add('root', null, [0, 0, 0]);
  add('hips', 'root', [0, 0.95, 0]);
  add('spine', 'hips', [0, 1.05, -0.006]);
  add('chest', 'spine', [0, 1.19, -0.012]);
  add('upperChest', 'chest', [0, 1.32, -0.012]);
  add('neck', 'upperChest', [0, 1.466, -0.022]);
  add('head', 'neck', [0, 1.56, -0.004]);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1; const m = (v) => [v[0] * s, v[1], v[2]];
    add('clavicle_' + side, 'upperChest', m([0.028, 1.41, 0.018]));
    add('upperArm_' + side, 'clavicle_' + side, m([0.178, 1.425, -0.016]));
    add('forearm_' + side, 'upperArm_' + side, m([0.458, 1.425, -0.016]));
    add('forearmTwist_' + side, 'forearm_' + side, m([0.582, 1.425, -0.015]));
    add('hand_' + side, 'forearmTwist_' + side, m([0.706, 1.425, -0.013]));
    const H = [0.706, 1.425, -0.013];
    for (const [fn, f] of Object.entries(FINGERS)) {
      const d = V3(...f.dir).normalize(); let p = [H[0] + f.base[0], H[1] + f.base[1], H[2] + f.base[2]];
      let parent = 'hand_' + side;
      for (let k = 0; k < 3; k++) {
        const nm = `${fn}${k + 1}_${side}`; add(nm, parent, m(p)); parent = nm;
        p = [p[0] + d.x * f.segs[k], p[1] + d.y * f.segs[k], p[2] + d.z * f.segs[k]];
      }
    }
    add('thigh_' + side, 'hips', m([0.09, 0.915, 0.002]));
    add('shin_' + side, 'thigh_' + side, m([0.093, 0.497, 0.006]));
    add('foot_' + side, 'shin_' + side, m([0.09, 0.08, -0.008]));
    add('toe_' + side, 'foot_' + side, m([0.093, 0.022, 0.128]));
  }
  return D;
}
const SKEL_DEF = buildSkeletonDef();
const SKEL_INDEX = Object.fromEntries(SKEL_DEF.map((b, i) => [b.name, i]));
const restPos = (name) => SKEL_DEF[SKEL_INDEX[name]].p;

// ---- SDF primitives ---------------------------------------------------------------
const PT = { SPH: 0, ELL: 1, CAP: 2, RCONE: 3, RBOX: 4 };
function prim(type, o) {
  const p = Object.assign({ type, k: 0.02, sub: false, soft: 0.012, bone: 'hips' }, o);
  // conservative AABB for culling
  let lo, hi; const pad = (p.k || 0) + 0.004;
  if (type === PT.SPH) { lo = p.c.map((v) => v - p.r); hi = p.c.map((v) => v + p.r); }
  else if (type === PT.ELL) { lo = p.c.map((v, i) => v - p.rad[i]); hi = p.c.map((v, i) => v + p.rad[i]); }
  else if (type === PT.CAP || type === PT.RCONE) { const r = type === PT.CAP ? p.r : Math.max(p.r1, p.r2); lo = p.a.map((v, i) => Math.min(v, p.b[i]) - r); hi = p.a.map((v, i) => Math.max(v, p.b[i]) + r); }
  else { const e = Math.hypot(...p.half) + p.round; lo = p.c.map((v) => v - e); hi = p.c.map((v) => v + e); }
  p.lo = lo.map((v) => v - pad); p.hi = hi.map((v) => v + pad);
  if (type === PT.RCONE) { p.ba = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]]; p.l2 = p.ba[0] ** 2 + p.ba[1] ** 2 + p.ba[2] ** 2; p.rr = p.r1 - p.r2; p.a2 = p.l2 - p.rr * p.rr; p.il2 = 1 / p.l2; }
  if (type === PT.CAP) { p.ba = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]]; p.l2 = p.ba[0] ** 2 + p.ba[1] ** 2 + p.ba[2] ** 2; }
  if (type === PT.RBOX) { const e = new THREE.Euler(...(p.rot || [0, 0, 0])); const m = new THREE.Matrix4().makeRotationFromEuler(e).invert(); p.inv = m.elements.slice(); }
  return p;
}
function evalPrim(p, x, y, z) {
  switch (p.type) {
    case PT.SPH: { const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2]; return Math.sqrt(dx * dx + dy * dy + dz * dz) - p.r; }
    case PT.ELL: {
      const qx = (x - p.c[0]) / p.rad[0], qy = (y - p.c[1]) / p.rad[1], qz = (z - p.c[2]) / p.rad[2];
      const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
      const k1 = Math.sqrt((qx / p.rad[0]) ** 2 + (qy / p.rad[1]) ** 2 + (qz / p.rad[2]) ** 2);
      return k1 < 1e-9 ? -Math.min(...p.rad) : (k0 * (k0 - 1)) / k1;
    }
    case PT.CAP: {
      const px = x - p.a[0], py = y - p.a[1], pz = z - p.a[2];
      const h = clamp((px * p.ba[0] + py * p.ba[1] + pz * p.ba[2]) / p.l2);
      const dx = px - p.ba[0] * h, dy = py - p.ba[1] * h, dz = pz - p.ba[2] * h;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - p.r;
    }
    case PT.RCONE: {
      const pax = x - p.a[0], pay = y - p.a[1], paz = z - p.a[2];
      const yy = pax * p.ba[0] + pay * p.ba[1] + paz * p.ba[2]; const zz = yy - p.l2;
      const xvx = pax * p.l2 - p.ba[0] * yy, xvy = pay * p.l2 - p.ba[1] * yy, xvz = paz * p.l2 - p.ba[2] * yy;
      const x2 = xvx * xvx + xvy * xvy + xvz * xvz; const y2 = yy * yy * p.l2, z2 = zz * zz * p.l2;
      const k = Math.sign(p.rr) * p.rr * p.rr * x2;
      if (Math.sign(zz) * p.a2 * z2 > k) return Math.sqrt(x2 + z2) * p.il2 - p.r2;
      if (Math.sign(yy) * p.a2 * y2 < k) return Math.sqrt(x2 + y2) * p.il2 - p.r1;
      return (Math.sqrt(x2 * p.a2 * p.il2) + yy * p.rr) * p.il2 - p.r1;
    }
    case PT.RBOX: {
      const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2]; const m = p.inv;
      const lx = m[0] * dx + m[4] * dy + m[8] * dz, ly = m[1] * dx + m[5] * dy + m[9] * dz, lz = m[2] * dx + m[6] * dy + m[10] * dz;
      const qx = Math.abs(lx) - p.half[0] + p.round, qy = Math.abs(ly) - p.half[1] + p.round, qz = Math.abs(lz) - p.half[2] + p.round;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - p.round;
    }
  }
  return 1;
}
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

// Evaluate a primitive list; optionally record per-primitive distances.
function evalPrims(list, x, y, z, dists = null) {
  let d = 1e9;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (x < p.lo[0] || y < p.lo[1] || z < p.lo[2] || x > p.hi[0] || y > p.hi[1] || z > p.hi[2]) { if (dists) dists[i] = 1e9; continue; }
    const di = evalPrim(p, x, y, z);
    if (dists) dists[i] = di;
    d = p.sub ? smax(d, -di, p.k) : smin(d, di, p.k);
  }
  return d;
}

// ---- anatomy -------------------------------------------------------------------------
function mirrorPrims(list) {
  const out = [];
  for (const p of list) {
    out.push(p);
    if (p.mirror === false) continue;
    const q = Object.assign({}, p);
    const mx = (v) => [-v[0], v[1], v[2]];
    if (q.c) q.c = mx(q.c); if (q.a) q.a = mx(q.a); if (q.b) q.b = mx(q.b);
    if (q.rot) q.rot = [q.rot[0], -q.rot[1], -q.rot[2]];
    const sw = (n) => n.replace(/_L$/, '_R');
    q.bone = sw(q.bone); if (q.bones) q.bones = q.bones.map(sw);
    out.push(prim(q.type, q));
  }
  return out;
}
function bodyPrims() {
  const L = [];
  const C = (o) => Object.assign(o, { mirror: false });
  // torso (centre line)
  L.push(prim(PT.ELL, C({ c: [0, 0.935, -0.006], rad: [0.158, 0.106, 0.108], bone: 'hips', k: 0 })));
  L.push(prim(PT.ELL, { c: [0.07, 0.878, -0.06], rad: [0.084, 0.094, 0.072], bone: 'hips', k: 0.03 }));
  L.push(prim(PT.ELL, C({ c: [0, 1.052, 0.006], rad: [0.137, 0.12, 0.098], bone: 'spine', k: 0.05 })));
  L.push(prim(PT.ELL, C({ c: [0, 1.17, -0.004], rad: [0.148, 0.12, 0.103], bone: 'chest', k: 0.05 })));
  L.push(prim(PT.ELL, C({ c: [0, 1.268, -0.01], rad: [0.158, 0.128, 0.106], bone: 'upperChest', k: 0.04 })));
  L.push(prim(PT.ELL, { c: [0.072, 1.305, 0.044], rad: [0.08, 0.058, 0.05], bone: 'upperChest', k: 0.03 }));
  L.push(prim(PT.ELL, C({ c: [0, 1.338, -0.045], rad: [0.15, 0.1, 0.074], bone: 'upperChest', k: 0.04 })));
  L.push(prim(PT.ELL, { c: [0.1, 1.22, -0.03], rad: [0.068, 0.12, 0.07], bone: 'chest', k: 0.03 }));
  L.push(prim(PT.ELL, { c: [0.186, 1.405, -0.013], rad: [0.062, 0.07, 0.066], bone: 'upperArm_L', k: 0.035, soft: 0.02 }));
  L.push(prim(PT.CAP, { a: [0.03, 1.455, -0.035], b: [0.16, 1.425, -0.02], r: 0.042, bone: 'clavicle_L', k: 0.04 }));
  L.push(prim(PT.RCONE, C({ a: [0, 1.43, -0.02], b: [0, 1.592, 0.004], r1: 0.057, r2: 0.05, bone: 'neck', k: 0.03 })));
  // arms
  L.push(prim(PT.RCONE, { a: [0.19, 1.425, -0.015], b: [0.458, 1.425, -0.016], r1: 0.048, r2: 0.036, bone: 'upperArm_L', k: 0.03 }));
  L.push(prim(PT.ELL, { c: [0.33, 1.423, 0.012], rad: [0.085, 0.037, 0.035], bone: 'upperArm_L', k: 0.02 }));
  L.push(prim(PT.ELL, { c: [0.31, 1.426, -0.036], rad: [0.09, 0.036, 0.034], bone: 'upperArm_L', k: 0.02 }));
  L.push(prim(PT.SPH, { c: [0.458, 1.425, -0.021], r: 0.036, bone: 'forearm_L', k: 0.02 }));
  L.push(prim(PT.RCONE, { a: [0.458, 1.425, -0.016], b: [0.702, 1.425, -0.013], r1: 0.037, r2: 0.025, bone: 'forearm_L',
    bones: ['forearm_L', 'forearmTwist_L', 'hand_L'], k: 0.02 }));
  L.push(prim(PT.ELL, { c: [0.522, 1.43, -0.008], rad: [0.075, 0.034, 0.036], bone: 'forearm_L', k: 0.02 }));
  // legs
  L.push(prim(PT.RCONE, { a: [0.09, 0.915, 0.0], b: [0.095, 0.497, 0.006], r1: 0.082, r2: 0.05, bone: 'thigh_L', k: 0.04, soft: 0.02 }));
  L.push(prim(PT.ELL, { c: [0.098, 0.72, 0.026], rad: [0.066, 0.16, 0.062], bone: 'thigh_L', k: 0.03 }));
  L.push(prim(PT.ELL, { c: [0.09, 0.74, -0.03], rad: [0.06, 0.15, 0.058], bone: 'thigh_L', k: 0.03 }));
  L.push(prim(PT.SPH, { c: [0.095, 0.497, 0.012], r: 0.047, bone: 'shin_L', k: 0.02 }));
  L.push(prim(PT.RCONE, { a: [0.095, 0.497, 0.006], b: [0.09, 0.09, -0.006], r1: 0.046, r2: 0.03, bone: 'shin_L', k: 0.02 }));
  L.push(prim(PT.ELL, { c: [0.09, 0.37, -0.028], rad: [0.048, 0.1, 0.045], bone: 'shin_L', k: 0.03 }));
  L.push(prim(PT.SPH, { c: [0.09, 0.08, -0.006], r: 0.032, bone: 'foot_L', k: 0.02 }));
  L.push(prim(PT.ELL, { c: [0.09, 0.046, -0.042], rad: [0.033, 0.042, 0.042], bone: 'foot_L', k: 0.02 }));
  L.push(prim(PT.RBOX, { c: [0.094, 0.042, 0.058], half: [0.041, 0.03, 0.08], round: 0.022, rot: [0.12, 0, 0], bone: 'foot_L', k: 0.03 }));
  L.push(prim(PT.RBOX, { c: [0.097, 0.022, 0.17], half: [0.043, 0.017, 0.04], round: 0.016, rot: [0, -0.08, 0], bone: 'toe_L', k: 0.015 }));
  return mirrorPrims(L);
}
function headPrims() {
  const L = []; const C = (o) => Object.assign(o, { mirror: false });
  const S = 0.006;
  L.push(prim(PT.RCONE, C({ a: [0, 1.395, -0.02], b: [0, 1.595, 0.004], r1: 0.058, r2: 0.05, bone: 'neck', k: 0, soft: 0.02 })));
  L.push(prim(PT.ELL, C({ c: [0, 1.668, -0.014], rad: [0.077, 0.094, 0.098], bone: 'head', k: 0.03, soft: S })));
  L.push(prim(PT.ELL, C({ c: [0, 1.622, 0.03], rad: [0.066, 0.083, 0.074], bone: 'head', k: 0.02, soft: S })));
  L.push(prim(PT.ELL, C({ c: [0, 1.567, 0.036], rad: [0.056, 0.034, 0.058], bone: 'head', k: 0.026, soft: S })));
  L.push(prim(PT.ELL, C({ c: [0, 1.549, 0.078], rad: [0.021, 0.02, 0.018], bone: 'head', k: 0.012, soft: S })));
  L.push(prim(PT.ELL, { c: [0.047, 1.628, 0.058], rad: [0.022, 0.016, 0.02], bone: 'head', k: 0.012, soft: S }));
  L.push(prim(PT.CAP, C({ a: [-0.044, 1.668, 0.081], b: [0.044, 1.668, 0.081], r: 0.012, bone: 'head', k: 0.016, soft: S })));
  L.push(prim(PT.SPH, { c: [0.032, 1.648, 0.094], r: 0.0165, bone: 'head', k: 0.012, sub: true, soft: S }));
  L.push(prim(PT.ELL, { c: [0.032, 1.6455, 0.0835], rad: [0.0158, 0.0102, 0.0112], bone: 'head', k: 0.006, soft: S }));
  L.push(prim(PT.CAP, C({ a: [0, 1.656, 0.088], b: [0, 1.61, 0.107], r: 0.0082, bone: 'head', k: 0.012, soft: S })));
  L.push(prim(PT.SPH, C({ c: [0, 1.604, 0.107], r: 0.0115, bone: 'head', k: 0.008, soft: S })));
  L.push(prim(PT.SPH, { c: [0.0125, 1.599, 0.098], r: 0.0086, bone: 'head', k: 0.006, soft: S }));
  L.push(prim(PT.ELL, C({ c: [0, 1.582, 0.097], rad: [0.022, 0.0078, 0.0092], bone: 'head', k: 0.008, soft: S })));
  L.push(prim(PT.ELL, C({ c: [0, 1.5695, 0.094], rad: [0.0185, 0.0068, 0.0082], bone: 'head', k: 0.006, soft: S })));
  L.push(prim(PT.CAP, C({ a: [-0.019, 1.5755, 0.1035], b: [0.019, 1.5755, 0.1035], r: 0.0021, bone: 'head', k: 0.002, sub: true, soft: S })));
  L.push(prim(PT.ELL, { c: [0.075, 1.628, -0.004], rad: [0.012, 0.03, 0.02], bone: 'head', k: 0.006, soft: S }));
  L.push(prim(PT.SPH, { c: [0.079, 1.628, 0.0], r: 0.0075, bone: 'head', k: 0.004, sub: true, soft: S }));
  return mirrorPrims(L);
}
function handPrims(side) {
  const s = side === 'L' ? 1 : -1; const L = []; const H = [0.706, 1.425, -0.013]; const S = 0.0035;
  const m = (v) => [v[0] * s, v[1], v[2]];
  L.push(prim(PT.RCONE, { a: m([0.64, 1.425, -0.014]), b: m([0.708, 1.425, -0.013]), r1: 0.028, r2: 0.025, bone: 'forearmTwist_' + side, k: 0, soft: 0.01, mirror: false }));
  L.push(prim(PT.RBOX, { c: m([0.752, 1.4235, -0.006]), half: [0.049, 0.0145, 0.042], round: 0.012, rot: [0, 0, 0], bone: 'hand_' + side, k: 0.012, soft: S, mirror: false }));
  L.push(prim(PT.ELL, { c: m([0.733, 1.415, 0.021]), rad: [0.03, 0.0145, 0.019], bone: 'thumb1_' + side, k: 0.012, soft: S, mirror: false }));
  L.push(prim(PT.ELL, { c: m([0.752, 1.418, -0.034]), rad: [0.036, 0.012, 0.012], bone: 'hand_' + side, k: 0.01, soft: S, mirror: false }));
  for (const [fn, f] of Object.entries(FINGERS)) {
    const d = V3(...f.dir).normalize(); let p = [H[0] + f.base[0], H[1] + f.base[1], H[2] + f.base[2]];
    if (fn !== 'thumb') L.push(prim(PT.SPH, { c: m([p[0] - 0.004, p[1] + 0.006, p[2]]), r: f.r[0] * 1.02, bone: `${fn}1_${side}`, k: 0.006, soft: S, mirror: false }));
    for (let k = 0; k < 3; k++) {
      const q = [p[0] + d.x * f.segs[k], p[1] + d.y * f.segs[k], p[2] + d.z * f.segs[k]];
      L.push(prim(PT.RCONE, { a: m(p), b: m(k === 2 ? [q[0] - d.x * 0.004, q[1] - d.y * 0.004, q[2] - d.z * 0.004] : q), r1: f.r[k], r2: f.r[k + 1], bone: `${fn}${k + 1}_${side}`, k: k === 0 ? 0.008 : 0.004, soft: S, mirror: false }));
      p = q;
    }
  }
  return L;
}

// ---- garments: offset shells over the skin, clipped to regions ------------------------
const MATS = {
  skin: { id: 0, col: [0.36, 0.2, 0.135], rough: 0.5, sheen: 0, skin: 1, pat: [0, 0, 0, 0] },
  linen: { id: 1, col: [0.37, 0.325, 0.25], rough: 0.86, sheen: 0.55, skin: 0, pat: [1, 0, 0, 0] },
  trouser: { id: 2, col: [0.052, 0.047, 0.042], rough: 0.9, sheen: 0.7, skin: 0, pat: [1, 0, 0, 0] },
  robe: { id: 3, col: [0.047, 0.052, 0.06], rough: 0.92, sheen: 1.0, skin: 0, pat: [1, 0, 0, 0] },
  wrap: { id: 4, col: [0.3, 0.262, 0.2], rough: 0.9, sheen: 0.45, skin: 0, pat: [0.5, 1, 0, 0] },
  sash: { id: 5, col: [0.175, 0.03, 0.022], rough: 0.78, sheen: 0.85, skin: 0, pat: [1, 0, 0, 0] },
  hair: { id: 6, col: [0.016, 0.011, 0.009], rough: 0.42, sheen: 0.25, skin: 0, pat: [0, 0, 1, 0] },
};
const MAT_LIST = Object.values(MATS).sort((a, b) => a.id - b.id);
const yBand = (y, a, b) => Math.max(a - y, y - b);
// regions return negative inside
const REGIONS = {
  trouser: (x, y, z) => Math.max(yBand(y, 0.36, 0.99), -(Math.abs(x) - 0.0) - 1),
  shinWrap: (x, y, z) => Math.max(yBand(y, 0.075, 0.445), 0.02 - Math.abs(x)),
  footWrap: (x, y, z) => y - 0.118,
  undershirt: (x, y, z) => {
    const torso = Math.max(yBand(y, 0.93, 1.505), Math.abs(x) - 0.2);
    const arm = Math.max(yBand(Math.abs(x), 0.12, 0.505), Math.abs(y - 1.425) - 0.1);
    const vn = Math.max(Math.abs(x - 0.004) - (y - 1.37) * 0.42, 0.01 - z); // small V at the throat
    return Math.max(Math.min(torso, arm), -vn);
  },
  robe: (x, y, z) => {
    const torso = Math.max(yBand(y, 0.9, 1.468), Math.abs(x) - 0.21);
    const sleeve = Math.max(yBand(Math.abs(x), 0.12, 0.425 + 0.012 * Math.sin(z * 90)), Math.abs(y - 1.425) - 0.11);
    const vn = Math.max(Math.abs(x - 0.012) - (y - 1.165) * 0.5, 0.012 - z); // crossover V-neck
    return Math.max(Math.min(torso, sleeve), -vn);
  },
  foreWrap: (x, y, z) => Math.max(yBand(Math.abs(x), 0.49, 0.712), Math.abs(y - 1.425) - 0.08),
  sash: (x, y, z) => Math.max(yBand(y + 0.012 * Math.sin(x * 23 + z * 11), 0.925, 1.038), Math.abs(x) - 0.25),
};
const LAYERS = [
  { name: 'trouser', mat: MATS.trouser, t: (x, y, z) => 0.019 + 0.016 * smoothstep(0.72, 0.42, y) + 0.004 * Noise.n3(x * 30, y * 9, z * 30) },
  { name: 'shinWrap', mat: MATS.wrap, t: () => 0.0095 },
  { name: 'footWrap', mat: MATS.wrap, t: () => 0.0065 },
  { name: 'undershirt', mat: MATS.linen, t: () => 0.0065 },
  { name: 'robe', mat: MATS.robe, t: (x, y, z) => 0.017 + 0.004 * Noise.n3(x * 18, y * 6, z * 18) + 0.006 * smoothstep(1.3, 1.0, y) },
  { name: 'foreWrap', mat: MATS.wrap, t: () => 0.0085 },
  { name: 'sash', mat: MATS.sash, t: (x, y, z) => 0.031 + 0.003 * Math.sin(y * 150 + x * 20) },
];
const SASH_KNOT = [
  prim(PT.ELL, { c: [0.108, 0.978, 0.118], rad: [0.046, 0.041, 0.03], bone: 'hips', k: 0 }),
  prim(PT.ELL, { c: [0.132, 0.95, 0.112], rad: [0.03, 0.034, 0.022], bone: 'hips', k: 0 }),
];

// Clothed body SDF (+ which layer won, for materials)
function clothedSDF(list, x, y, z, out = null, shrink = 0) {
  const skin = evalPrims(list, x, y, z) + shrink;
  let d = skin, win = MATS.skin;
  for (const L of LAYERS) {
    const r = REGIONS[L.name](x, y, z); if (r > 0.03) continue;
    const shell = smax(skin - L.t(x, y, z), r, 0.004);
    if (shell < d + 0.0004) { d = Math.min(d, shell); win = L.mat; }
  }
  for (const k of SASH_KNOT) { const kd = evalPrim(k, x, y, z) + shrink; if (kd < d) { d = kd; win = MATS.sash; } }
  if (out) out.mat = win;
  return d;
}
function hairSDF(list, x, y, z, out = null) {
  const skin = evalPrims(list, x, y, z);
  // hairline: higher over the forehead, down to the nape; clear of ears and face
  const hl = 1.605 + 0.094 * smoothstep(0.02, 0.1, z) - 0.03 * smoothstep(-0.02, -0.1, z) + 0.022 * smoothstep(0.052, 0.078, Math.abs(x)) * smoothstep(0.07, -0.03, z);
  const region = hl - y;
  const t = 0.009 + 0.01 * smoothstep(1.62, 1.75, y) + 0.004 * smoothstep(-0.02, -0.1, z);
  let hair = smax(skin - t, region, 0.006);
  // tie at the nape where the simulated tail begins
  const tie = evalPrim(HAIR_TIE, x, y, z);
  hair = smin(hair, tie, 0.012);
  let d = skin, win = MATS.skin;
  if (hair < d + 0.0003) { d = Math.min(d, hair); win = MATS.hair; }
  if (out) out.mat = win;
  return d;
}
const HAIR_TIE = prim(PT.ELL, { c: [0, 1.607, -0.098], rad: [0.029, 0.03, 0.028], bone: 'head', k: 0 });

// ---- surface nets ------------------------------------------------------------------------
function surfaceNets(sdf, lo, hi, h) {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  // coarse pre-pass: skip full evaluation far from the surface
  const cs = 4, cnx = Math.ceil(nx / cs) + 1, cny = Math.ceil(ny / cs) + 1, cnz = Math.ceil(nz / cs) + 1;
  const CF = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++)
    CF[i + cnx * (j + cny * k)] = sdf(lo[0] + i * cs * h, lo[1] + j * cs * h, lo[2] + k * cs * h);
  const far = cs * h * 1.8;
  for (let k = 0; k < nz; k++) {
    const z = lo[2] + k * h; const ck = Math.floor(k / cs);
    for (let j = 0; j < ny; j++) {
      const y = lo[1] + j * h; const cj = Math.floor(j / cs);
      for (let i = 0; i < nx; i++) {
        const x = lo[0] + i * h; const ci = Math.floor(i / cs);
        // conservative: if all 8 coarse corners are far and same-signed, reuse coarse value
        let mn = 1e9, mx = -1e9;
        for (let c = 0; c < 8; c++) { const v = CF[(ci + (c & 1)) + cnx * ((cj + ((c >> 1) & 1)) + cny * (ck + ((c >> 2) & 1)))]; if (v < mn) mn = v; if (v > mx) mx = v; }
        F[i + nx * (j + ny * k)] = (mn > far || mx < -far) ? (mn > far ? mn : mx) : sdf(x, y, z);
      }
    }
  }
  const cellIdx = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const verts = [];
  const cid = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const v = F[(i + (c & 1)) + nx * ((j + ((c >> 1) & 1)) + ny * (k + ((c >> 2) & 1)))]; cv[c] = v; if (v < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      const va = cv[a], vb = cv[b]; if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += (a & 1) + t * ((b & 1) - (a & 1)); sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1)); sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1)); n++;
    }
    cellIdx[cid(i, j, k)] = verts.length / 3;
    verts.push(lo[0] + (i + sx / n) * h, lo[1] + (j + sy / n) * h, lo[2] + (k + sz / n) * h);
  }
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    const dac = (verts[a * 3] - verts[c * 3]) ** 2 + (verts[a * 3 + 1] - verts[c * 3 + 1]) ** 2 + (verts[a * 3 + 2] - verts[c * 3 + 2]) ** 2;
    const dbd = (verts[b * 3] - verts[d * 3]) ** 2 + (verts[b * 3 + 1] - verts[d * 3 + 1]) ** 2 + (verts[b * 3 + 2] - verts[d * 3 + 2]) ** 2;
    if (dac < dbd) idx.push(a, b, c, a, c, d); else idx.push(a, b, d, b, c, d);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = F[i + nx * (j + ny * k)] < 0;
    if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 + 1 && k < nz) {
      const v1 = F[(i + 1) + nx * (j + ny * k)] < 0;
      if (v0 !== v1 && j <= ny - 1 && k <= nz - 1 && j - 1 < ny - 1 && k - 1 < nz - 1 && j < ny - 1 + 0 + 1 && k < nz - 1 + 1) {
        if (j < ny - 1 + 1 && j <= ny - 1 && k <= nz - 1 && j - 1 >= 0 && k - 1 >= 0 && j < ny && k < nz && j <= ny - 2 + 1 && k <= nz - 2 + 1 && j - 0 < ny - 1 + 1) {
          if (j < ny - 1 + 1 && j - 1 < ny - 1 && k - 1 < nz - 1 && j < ny - 0 && (j < ny - 1 || false) && (k < nz - 1 || false))
            quad(cellIdx[cid(i, j - 1, k - 1)], cellIdx[cid(i, j, k - 1)], cellIdx[cid(i, j, k)], cellIdx[cid(i, j - 1, k)], !v0);
        }
      }
    }
    if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
      const v1 = F[i + nx * ((j + 1) + ny * k)] < 0;
      if (v0 !== v1) quad(cellIdx[cid(i - 1, j, k - 1)], cellIdx[cid(i - 1, j, k)], cellIdx[cid(i, j, k)], cellIdx[cid(i, j, k - 1)], !v0);
    }
    if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
      const v1 = F[i + nx * (j + ny * (k + 1))] < 0;
      if (v0 !== v1) quad(cellIdx[cid(i - 1, j - 1, k)], cellIdx[cid(i, j - 1, k)], cellIdx[cid(i, j, k)], cellIdx[cid(i - 1, j, k)], !v0);
    }
  }
  return { verts: new Float32Array(verts), idx };
}

// ---- build a skinned mesh part from an SDF --------------------------------------------------
function buildPart(opts) {
  const { prims, lo, hi, h, sdf, aoStep = 0.008, keep = null } = opts;
  const t0 = performance.now();
  const sn = surfaceNets(sdf, lo, hi, h);
  let V = sn.verts; const nv = V.length / 3;
  // project vertices onto the surface (Newton), compute normals
  const N = new Float32Array(nv * 3); const e = h * 0.12;
  for (let i = 0; i < nv; i++) {
    let x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const d = sdf(x, y, z);
      const gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * e) || 1;
      const step = clamp(d / (gl * gl), -h * 0.6, h * 0.6);
      x -= (gx / (2 * e)) * step; y -= (gy / (2 * e)) * step; z -= (gz / (2 * e)) * step;
    }
    V[i * 3] = x; V[i * 3 + 1] = y; V[i * 3 + 2] = z;
    const gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1; N[i * 3] = gx / l; N[i * 3 + 1] = gy / l; N[i * 3 + 2] = gz / l;
  }
  // optional face culling (zones owned by another part)
  let idx = sn.idx;
  if (keep) {
    const out = [];
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], c = idx[f + 2];
      const cx = (V[a * 3] + V[b * 3] + V[c * 3]) / 3, cy = (V[a * 3 + 1] + V[b * 3 + 1] + V[c * 3 + 1]) / 3, cz = (V[a * 3 + 2] + V[b * 3 + 2] + V[c * 3 + 2]) / 3;
      if (keep(cx, cy, cz)) out.push(a, b, c);
    }
    idx = out;
  }
  // attributes: skin weights, material, AO, detail
  const skinIndex = new Uint16Array(nv * 4), skinWeight = new Float32Array(nv * 4);
  const col = new Float32Array(nv * 3), props = new Float32Array(nv * 4), pat = new Float32Array(nv * 4);
  const dists = new Float32Array(prims.length); const bw = new Map(); const info = { mat: null };
  for (let i = 0; i < nv; i++) {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    evalPrims(prims, x, y, z, dists);
    let dmin = 1e9; for (let p = 0; p < prims.length; p++) if (!prims[p].sub && dists[p] < dmin) dmin = dists[p];
    bw.clear();
    for (let p = 0; p < prims.length; p++) {
      const P = prims[p]; if (P.sub || dists[p] > 1e8) continue;
      const w = Math.exp(-Math.max(dists[p] - dmin, 0) / P.soft); if (w < 1e-3) continue;
      if (P.bones) {
        // gradient along the segment (forearm → twist → hand)
        const ax = P.b[0] - P.a[0], ay = P.b[1] - P.a[1], az = P.b[2] - P.a[2];
        const t = clamp(((x - P.a[0]) * ax + (y - P.a[1]) * ay + (z - P.a[2]) * az) / (ax * ax + ay * ay + az * az), -0.2, 1.2);
        const w0 = 1 - smoothstep(0.1, 0.55, t), w2 = smoothstep(0.78, 1.08, t), w1 = Math.max(0, 1 - w0 - w2);
        const b = P.bones; bw.set(b[0], (bw.get(b[0]) || 0) + w * w0); bw.set(b[1], (bw.get(b[1]) || 0) + w * w1); bw.set(b[2], (bw.get(b[2]) || 0) + w * w2);
      } else bw.set(P.bone, (bw.get(P.bone) || 0) + w);
    }
    const arr = [...bw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0; for (const a of arr) sum += a[1];
    for (let k = 0; k < 4; k++) {
      if (k < arr.length && sum > 0) { skinIndex[i * 4 + k] = SKEL_INDEX[arr[k][0]]; skinWeight[i * 4 + k] = arr[k][1] / sum; }
      else { skinIndex[i * 4 + k] = 0; skinWeight[i * 4 + k] = 0; }
    }
    // material (which layer owns the surface here)
    sdf(x, y, z, info);
    const M = info.mat || MATS.skin;
    col[i * 3] = M.col[0]; col[i * 3 + 1] = M.col[1]; col[i * 3 + 2] = M.col[2];
    // SDF ambient occlusion
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2]; let occ = 0, wsum = 0.5;
    for (let s = 1; s <= 4; s++) { const hs = s * aoStep; const d = sdf(x + nx * hs, y + ny * hs, z + nz * hs); occ += (hs - d) * wsum / hs; wsum *= 0.55; }
    const ao = clamp(1 - occ * 0.9, 0.18, 1);
    props[i * 4] = M.rough; props[i * 4 + 1] = M.sheen; props[i * 4 + 2] = M.skin; props[i * 4 + 3] = ao;
    pat[i * 4] = M.pat[0]; pat[i * 4 + 1] = M.pat[1]; pat[i * 4 + 2] = M.pat[2]; pat[i * 4 + 3] = opts.detail ? opts.detail(x, y, z, M) : 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(V, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aProps', new THREE.BufferAttribute(props, 4));
  g.setAttribute('aPat', new THREE.BufferAttribute(pat, 4));
  g.setAttribute('aRest', new THREE.BufferAttribute(V.slice(), 3));
  g.setAttribute('aRestN', new THREE.BufferAttribute(N.slice(), 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setIndex(idx);
  g.userData.ms = performance.now() - t0;
  return g;
}

// face details: brows, lash line, lips (dark = +, lips = -)
function faceDetail(x, y, z, M) {
  if (M !== MATS.skin || y < 1.54 || z < 0.05) return 0;
  const ax = Math.abs(x);
  const brow = Math.exp(-(((ax - 0.034) / 0.021) ** 2) - (((y - 1.6715 + 0.012 * (ax - 0.034) / 0.02) / 0.0052) ** 2)) * smoothstep(0.07, 0.085, z);
  const lash = Math.exp(-(((ax - 0.032) / 0.0145) ** 2) - (((y - 1.6432) / 0.0019) ** 2)) * smoothstep(0.085, 0.092, z);
  const lips = Math.exp(-((x / 0.02) ** 2) - (((y - 1.5755) / 0.0085) ** 2)) * smoothstep(0.085, 0.095, z);
  return clamp(brow * 0.85 + lash) - lips * 0.6;
}

function buildCharacterGeometry() {
  const body = bodyPrims(), head = headPrims(), handL = handPrims('L'), handR = handPrims('R');
  const hb = Q.bodyVox, hh = Q.headVox, hhand = Q.handVox;
  const zones = { neckShrink: (x, y, z) => 0.0028 * smoothstep(1.43, 1.46, y) * (Math.abs(x) < 0.11 ? 1 : 0) + 0.0028 * smoothstep(0.69, 0.705, Math.abs(x)) };
  const bodySDF = (x, y, z, out) => clothedSDF(body, x, y, z, out, zones.neckShrink(x, y, z));
  const parts = [];
  parts.push(buildPart({ prims: body, lo: [-0.73, -0.02, -0.21], hi: [0.73, 1.515, 0.245], h: hb, sdf: bodySDF, aoStep: 0.012,
    keep: (x, y, z) => !(y > 1.47 && Math.abs(x) < 0.1) && Math.abs(x) < 0.712 }));
  parts.push(buildPart({ prims: head, lo: [-0.11, 1.39, -0.135], hi: [0.11, 1.795, 0.132], h: hh, sdf: (x, y, z, out) => hairSDF(head, x, y, z, out), aoStep: 0.006, detail: faceDetail,
    keep: (x, y, z) => y > 1.405 }));
  parts.push(buildPart({ prims: handL, lo: [0.655, 1.37, -0.075], hi: [0.94, 1.465, 0.105], h: hhand, sdf: (x, y, z, out) => { if (out) out.mat = MATS.skin; return evalPrims(handL, x, y, z); }, aoStep: 0.004,
    keep: (x, y, z) => x > 0.67 }));
  parts.push(buildPart({ prims: handR, lo: [-0.94, 1.37, -0.075], hi: [-0.655, 1.465, 0.105], h: hhand, sdf: (x, y, z, out) => { if (out) out.mat = MATS.skin; return evalPrims(handR, x, y, z); }, aoStep: 0.004,
    keep: (x, y, z) => x < -0.67 }));
  const merged = mergeGeometries(parts, false);
  merged.userData.ms = parts.map((p) => p.userData.ms.toFixed(0));
  return merged;
}
