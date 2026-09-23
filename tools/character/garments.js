// Garment generator for a skinned humanoid in bind pose.
// Builds a signed distance field of the body from its triangles, then meshes the
// wardrobe as offset shells clipped to anatomical regions (surface nets), transfers
// skin weights from the nearest body triangles and hides skin that is fully covered.
// The wardrobe is original: layered linen + weathered robe with a crossover collar,
// loose trousers, forearm / shin / foot wraps and a knotted sash.

export async function buildGarments({ THREE, meshes, skeleton, armature, log, simplifier = null, ratio = 0.35 }) {
  const T0 = performance.now();
  const V = new THREE.Vector3();
  // ---------------------------------------------------------------- body soup
  const soup = []; // per mesh: { mesh, W (world verts), idx }
  let triCount = 0;
  for (const m of meshes) {
    const g = m.geometry, n = g.attributes.position.count, W = new Float32Array(n * 3);
    m.updateMatrixWorld(true);
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, V); V.applyMatrix4(m.matrixWorld); W[i * 3] = V.x; W[i * 3 + 1] = V.y; W[i * 3 + 2] = V.z; }
    soup.push({ mesh: m, W, idx: g.index.array });
    triCount += g.index.count / 3;
  }
  // flat triangle arrays
  const TV = new Float32Array(triCount * 9), TN = new Float32Array(triCount * 3), TM = new Int32Array(triCount * 4); // mesh id + 3 vertex ids
  let t = 0;
  soup.forEach((s, mi) => {
    for (let f = 0; f < s.idx.length; f += 3) {
      const a = s.idx[f], b = s.idx[f + 1], c = s.idx[f + 2];
      for (let k = 0; k < 3; k++) { TV[t * 9 + k] = s.W[a * 3 + k]; TV[t * 9 + 3 + k] = s.W[b * 3 + k]; TV[t * 9 + 6 + k] = s.W[c * 3 + k]; }
      const ux = TV[t * 9 + 3] - TV[t * 9], uy = TV[t * 9 + 4] - TV[t * 9 + 1], uz = TV[t * 9 + 5] - TV[t * 9 + 2];
      const vx = TV[t * 9 + 6] - TV[t * 9], vy = TV[t * 9 + 7] - TV[t * 9 + 1], vz = TV[t * 9 + 8] - TV[t * 9 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      TN[t * 3] = nx / l; TN[t * 3 + 1] = ny / l; TN[t * 3 + 2] = nz / l;
      TM[t * 4] = mi; TM[t * 4 + 1] = a; TM[t * 4 + 2] = b; TM[t * 4 + 3] = c;
      t++;
    }
  });
  // ---------------------------------------------------------------- joints
  const bone = (n) => skeleton.bones.find((b) => b.name === n);
  const J = {};
  const jn = { pelvis: 'Bip01_Pelvis', spine: 'Bip01_Spine', spine1: 'Bip01_Spine1', spine2: 'Bip01_Spine2', neck: 'Bip01_Neck', head: 'Bip01_Head' };
  for (const s of ['L', 'R']) Object.assign(jn, {
    ['clav' + s]: `Bip01_${s}_Clavicle`, ['up' + s]: `Bip01_${s}_UpperArm`, ['fore' + s]: `Bip01_${s}_Forearm`, ['hand' + s]: `Bip01_${s}_Hand`,
    ['mid' + s]: `Bip01_${s}_Finger2`, ['thumb' + s]: `Bip01_${s}_Finger0`, ['thigh' + s]: `Bip01_${s}_Thigh`, ['calf' + s]: `Bip01_${s}_Calf`,
    ['foot' + s]: `Bip01_${s}_Foot`, ['toe' + s]: `Bip01_${s}_Toe0`,
  });
  for (const [k, n] of Object.entries(jn)) { const b = bone(n); if (!b) throw new Error('missing bone ' + n); J[k] = b.getWorldPosition(new THREE.Vector3()); }
  // body bounds
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < TV.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], TV[i + k]); mx[k] = Math.max(mx[k], TV[i + k]); }
  const topY = mx[1];
  log('body height', topY.toFixed(3), 'joints pelvis', J.pelvis.y.toFixed(3), 'neck', J.neck.y.toFixed(3), 'tris', triCount);

  // ---------------------------------------------------------------- distance grid
  const h = +(new URLSearchParams(location.search).get('h') || 0.008), band = 0.06;
  const lo = [mn[0] - band - h, mn[1] - band - h, mn[2] - band - h];
  const nx = Math.ceil((mx[0] - lo[0] + band + h) / h) + 1, ny = Math.ceil((mx[1] - lo[1] + band + h) / h) + 1, nz = Math.ceil((mx[2] - lo[2] + band + h) / h) + 1;
  const N = nx * ny * nz;
  const UD = new Float32Array(N).fill(1e9), CT = new Int32Array(N).fill(-1), CS = new Int8Array(N);
  const gid = (i, j, k) => i + nx * (j + ny * k);
  const cp = [0, 0, 0];
  function closestOnTri(px, py, pz, o, out) {
    const ax = TV[o], ay = TV[o + 1], az = TV[o + 2], bx = TV[o + 3], by = TV[o + 4], bz = TV[o + 5], cx = TV[o + 6], cy = TV[o + 7], cz = TV[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz); return; }
    const den = 1 / (va + vb + vc); const v = vb * den, w = vc * den;
    out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
  }
  for (let f = 0; f < triCount; f++) {
    const o = f * 9;
    const x0 = Math.min(TV[o], TV[o + 3], TV[o + 6]) - band, x1 = Math.max(TV[o], TV[o + 3], TV[o + 6]) + band;
    const y0 = Math.min(TV[o + 1], TV[o + 4], TV[o + 7]) - band, y1 = Math.max(TV[o + 1], TV[o + 4], TV[o + 7]) + band;
    const z0 = Math.min(TV[o + 2], TV[o + 5], TV[o + 8]) - band, z1 = Math.max(TV[o + 2], TV[o + 5], TV[o + 8]) + band;
    const i0 = Math.max(0, Math.ceil((x0 - lo[0]) / h)), i1 = Math.min(nx - 1, Math.floor((x1 - lo[0]) / h));
    const j0 = Math.max(0, Math.ceil((y0 - lo[1]) / h)), j1 = Math.min(ny - 1, Math.floor((y1 - lo[1]) / h));
    const k0 = Math.max(0, Math.ceil((z0 - lo[2]) / h)), k1 = Math.min(nz - 1, Math.floor((z1 - lo[2]) / h));
    const fnx = TN[f * 3], fny = TN[f * 3 + 1], fnz = TN[f * 3 + 2];
    for (let k = k0; k <= k1; k++) { const pz = lo[2] + k * h;
      for (let j = j0; j <= j1; j++) { const py = lo[1] + j * h;
        for (let i = i0; i <= i1; i++) { const px = lo[0] + i * h;
          closestOnTri(px, py, pz, o, cp);
          const dx = px - cp[0], dy = py - cp[1], dz = pz - cp[2]; const d2 = dx * dx + dy * dy + dz * dz;
          const id = i + nx * (j + ny * k);
          if (d2 < UD[id]) { UD[id] = d2; CT[id] = f; CS[id] = (dx * fnx + dy * fny + dz * fnz) >= 0 ? 1 : -1; }
        }
      }
    }
  }
  for (let i = 0; i < N; i++) if (UD[i] < 1e8) UD[i] = Math.sqrt(UD[i]);
  // sign by flood fill from the grid boundary through cells clear of the surface
  const out = new Uint8Array(N); const queue = new Int32Array(N); let qh = 0, qt = 0;
  const free = (id) => UD[id] > h * 0.95;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
    const id = gid(i, j, k); if (free(id) && !out[id]) { out[id] = 1; queue[qt++] = id; }
  }
  while (qh < qt) {
    const id = queue[qh++]; const i = id % nx, j = ((id / nx) | 0) % ny, k = (id / (nx * ny)) | 0;
    const nb = [i > 0 ? id - 1 : -1, i < nx - 1 ? id + 1 : -1, j > 0 ? id - nx : -1, j < ny - 1 ? id + nx : -1, k > 0 ? id - nx * ny : -1, k < nz - 1 ? id + nx * ny : -1];
    for (const q of nb) if (q >= 0 && !out[q] && free(q)) { out[q] = 1; queue[qt++] = q; }
  }
  const SD = new Float32Array(N);
  for (let id = 0; id < N; id++) {
    const d = Math.min(UD[id], band * 1.5);
    const outside = free(id) ? out[id] === 1 : CS[id] > 0;
    SD[id] = outside ? d : -d;
  }
  // smoothed field for draped (non-tight) garments: separable gaussian, sigma ~ 2.5 cm
  const SB = blur3(SD, nx, ny, nz, 0.026 / h);
  const SB2 = blur3(SD, nx, ny, nz, 0.042 / h); // looser drape for the robe
  log('sdf grid', nx, ny, nz, 'ms', (performance.now() - T0).toFixed(0));

  const sample = (F, x, y, z) => {
    const fx = (x - lo[0]) / h, fy = (y - lo[1]) / h, fz = (z - lo[2]) / h;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(ny - 2, Math.floor(fy))), k = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j)), w = Math.min(1, Math.max(0, fz - k));
    const c = (a, b, cc) => F[gid(i + a, j + b, k + cc)];
    return ((c(0, 0, 0) * (1 - u) + c(1, 0, 0) * u) * (1 - v) + (c(0, 1, 0) * (1 - u) + c(1, 1, 0) * u) * v) * (1 - w)
      + ((c(0, 0, 1) * (1 - u) + c(1, 0, 1) * u) * (1 - v) + (c(0, 1, 1) * (1 - u) + c(1, 1, 1) * u) * v) * w;
  };

  // ---------------------------------------------------------------- anatomy labels
  const segs = [];
  const seg = (name, a, b, r, side = 0) => segs.push({ name, a: a.clone(), b: b.clone(), r, side, ab: b.clone().sub(a), l2: b.clone().sub(a).lengthSq() });
  const pelvisLow = J.pelvis.clone().add(new THREE.Vector3(0, -0.06, 0));
  const headTop = new THREE.Vector3(J.head.x, topY - 0.08, J.head.z + 0.02);
  seg('torso', pelvisLow, J.neck, 0.12); seg('head', J.neck, headTop, 0.085);
  for (const s of ['L', 'R']) {
    const sg = s === 'L' ? 1 : -1;
    const tip = J['mid' + s].clone().add(J['mid' + s].clone().sub(J['hand' + s]).multiplyScalar(0.9));
    const toeTip = J['toe' + s].clone().add(J['toe' + s].clone().sub(J['foot' + s]).setY(0).normalize().multiplyScalar(0.06));
    seg('upper', J['up' + s], J['fore' + s], 0.045, sg); seg('fore', J['fore' + s], J['hand' + s], 0.036, sg); seg('hand', J['hand' + s], tip, 0.028, sg);
    seg('thigh', J['thigh' + s], J['calf' + s], 0.075, sg); seg('shin', J['calf' + s], J['foot' + s], 0.048, sg); seg('foot', J['foot' + s], toeTip, 0.035, sg);
  }
  const P = new THREE.Vector3();
  function label(x, y, z) {
    let best = null, bd = 1e9, bt = 0;
    for (const s of segs) {
      const px = x - s.a.x, py = y - s.a.y, pz = z - s.a.z;
      const tt = Math.max(0, Math.min(1, (px * s.ab.x + py * s.ab.y + pz * s.ab.z) / s.l2));
      const dx = px - s.ab.x * tt, dy = py - s.ab.y * tt, dz = pz - s.ab.z * tt;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r;
      if (d < bd) { bd = d; best = s; bt = (px * s.ab.x + py * s.ab.y + pz * s.ab.z) / s.l2; }
    }
    return { s: best, t: bt, d: bd };
  }
  // ---------------------------------------------------------------- garments
  const waistY = J.pelvis.y + 0.075, neckY = J.neck.y;
  const len = (s) => Math.sqrt(s.l2);
  const tRange = (L, a, b) => Math.max(a - L.t, L.t - b) * len(L.s);
  const smax = (a, b, k) => { const hh = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + hh * hh * k * 0.25; };
  const n3 = (x, y, z) => Math.sin(x * 47.1 + Math.sin(y * 13.3) * 2) * Math.sin(z * 39.7 + y * 9.1) * Math.sin(y * 21.3 + x * 5.7);
  const GARMENTS = [
    { name: 'Trousers', drape: 1, t: (x, y, z) => 0.021 + 0.022 * ss(J.calfL.y + 0.22, J.calfL.y - 0.16, y) + 0.004 * n3(x, y, z),
      region: (L, x, y, z) => {
        if (L.s.name === 'thigh') return Math.max(y - waistY + 0.02, -0.02);
        if (L.s.name === 'shin') return tRange(L, -0.2, 0.4 + 0.02 * Math.sin(Math.atan2(x - L.s.a.x, z - L.s.a.z) * 3));
        if (L.s.name === 'torso') return Math.max(y - waistY + 0.02, J.pelvis.y - 0.2 - y);
        return 0.05;
      } },
    { name: 'ShinWrap', drape: 0, t: () => 0.0095,
      region: (L) => L.s.name === 'shin' ? tRange(L, 0.28, 1.08) : 0.05 },
    { name: 'FootWrap', drape: 0, t: () => 0.0065,
      region: (L, x, y, z) => L.s.name === 'foot' ? Math.max(tRange(L, -0.3, 0.55), y - (J.footL.y + 0.045)) : 0.05 },
    { name: 'Inner', drape: 0, t: () => 0.0065,
      region: (L, x, y, z) => {
        if (L.s.name === 'torso') {
          const band = Math.max(waistY - 0.06 - y, y - (neckY + 0.035));
          const v = Math.max(Math.abs(x - J.neck.x) - (y - (neckY - 0.09)) * 0.48, J.neck.z - 0.02 - z);
          return smax(band, -v, 0.004);
        }
        if (L.s.name === 'upper') return tRange(L, -0.5, 0.62);
        if (L.s.name === 'head') return y - (neckY + 0.035);
        return 0.05;
      } },
    { name: 'Robe', drape: 2, t: (x, y, z) => 0.019 + 0.005 * n3(x * 0.7, y * 0.5, z * 0.7) + 0.01 * ss(waistY + 0.2, waistY - 0.05, y),
      region: (L, x, y, z) => {
        if (L.s.name === 'torso') {
          const band = Math.max(waistY - 0.11 - y, y - (neckY + 0.018));
          // crossover collar: V whose apex sits a little to the figure's right, below the sternum
          const apexY = neckY - 0.235, ax = J.neck.x - 0.012;
          const v = Math.max(Math.abs(x - ax) - (y - apexY) * 0.5, J.neck.z - 0.005 - z);
          return smax(band, -v, 0.005);
        }
        if (L.s.name === 'upper') return tRange(L, -0.5, 0.9 + 0.03 * Math.sin(z * 90));
        if (L.s.name === 'head') return y - (neckY + 0.018);
        return 0.05;
      } },
    { name: 'ForeWrap', drape: 0, t: () => 0.0085,
      region: (L) => L.s.name === 'fore' ? tRange(L, 0.16, 1.2) : L.s.name === 'hand' ? tRange(L, -0.2, 0.38) : 0.05 },
    { name: 'Sash', drape: 2, t: (x, y, z) => 0.019 + 0.01 * ss(waistY + 0.2, waistY - 0.05, y) + 0.014 + 0.003 * Math.sin(Math.atan2(x - J.pelvis.x, z - J.pelvis.z) * 9 + y * 60),
      region: (L, x, y, z) => (L.s.name === 'torso' || L.s.name === 'thigh') ? Math.max(waistY - 0.075 - y + 0.006 * Math.sin(x * 40 + z * 30), y - (waistY + 0.035)) : 0.05 },
  ];
  function ss(a, b, x) { const tt = Math.max(0, Math.min(1, (x - a) / (b - a))); return tt * tt * (3 - 2 * tt); }
  // sash knot on the figure's left front hip
  const fwd = new THREE.Vector3(0, 0, 1);
  const knotC = new THREE.Vector3(J.pelvis.x + 0.1, waistY - 0.025, 0); // z solved below from the surface
  { let zz = J.pelvis.z + 0.02; for (let k = 0; k < 40; k++) { if (sample(SD, knotC.x, knotC.y, zz) > 0.03) break; zz += 0.005; } knotC.z = zz - 0.004; }
  const ell = (x, y, z, c, r) => { const qx = (x - c[0]) / r[0], qy = (y - c[1]) / r[1], qz = (z - c[2]) / r[2]; const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz), k1 = Math.sqrt((qx / r[0]) ** 2 + (qy / r[1]) ** 2 + (qz / r[2]) ** 2); return k0 * (k0 - 1) / k1; };
  const knot = (x, y, z) => Math.min(
    ell(x, y, z, [knotC.x, knotC.y + 0.004, knotC.z - 0.002], [0.05, 0.036, 0.022]),
    ell(x, y, z, [knotC.x + 0.028, knotC.y - 0.03, knotC.z - 0.006], [0.03, 0.038, 0.017]),
    ell(x, y, z, [knotC.x - 0.03, knotC.y - 0.022, knotC.z - 0.008], [0.026, 0.03, 0.016]));
  const info = { g: -1 };
  function garmentSDF(x, y, z, o = null) {
    const skin = sample(SD, x, y, z); const skinB = sample(SB, x, y, z); const skinB2 = sample(SB2, x, y, z);
    const L = label(x, y, z);
    let d = 1e9, win = -1;
    for (let gi = 0; gi < GARMENTS.length; gi++) {
      const G = GARMENTS[gi]; const r = G.region(L, x, y, z); if (r > 0.02) continue;
      const base = G.drape === 2 ? Math.min(skinB2, skin + 0.002) : G.drape ? Math.min(skinB, skin + 0.002) : skin;
      const taper = 0.38 + 0.62 * ss(0, 0.022, -r); // fabric thins toward hems and collars
      const sh = smax(base - G.t(x, y, z) * taper, r, 0.006);
      if (sh < d - 0.0003) { d = sh; win = gi; } else if (sh < d) { d = Math.min(d, sh); }
    }
    const kd = knot(x, y, z); if (kd < d) { d = kd; win = GARMENTS.findIndex((g) => g.name === 'Sash'); }
    if (o) o.g = win;
    return d;
  }

  // ---------------------------------------------------------------- mesh (surface nets on the same grid)
  const GF = new Float32Array(N);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = gid(i, j, k); const x = lo[0] + i * h, y = lo[1] + j * h, z = lo[2] + k * h;
    GF[id] = Math.abs(SD[id]) > band ? (SD[id] > 0 ? 1 : -1) * band : garmentSDF(x, y, z);
  }
  log('garment field ms', (performance.now() - T0).toFixed(0));
  const net = surfaceNets(GF, nx, ny, nz, lo, h);
  const nv = net.verts.length / 3; const VP = net.verts; const VN = new Float32Array(nv * 3); const VG = new Int8Array(nv);
  const e = h * 0.15;
  for (let i = 0; i < nv; i++) {
    let x = VP[i * 3], y = VP[i * 3 + 1], z = VP[i * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const d = garmentSDF(x, y, z);
      const gx = (garmentSDF(x + e, y, z) - garmentSDF(x - e, y, z)) / (2 * e), gy = (garmentSDF(x, y + e, z) - garmentSDF(x, y - e, z)) / (2 * e), gz = (garmentSDF(x, y, z + e) - garmentSDF(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz || 1; const st = Math.max(-h * 0.6, Math.min(h * 0.6, d / g2));
      x -= gx * st; y -= gy * st; z -= gz * st;
    }
    VP[i * 3] = x; VP[i * 3 + 1] = y; VP[i * 3 + 2] = z;
    const gx = garmentSDF(x + e, y, z) - garmentSDF(x - e, y, z), gy = garmentSDF(x, y + e, z) - garmentSDF(x, y - e, z), gz = garmentSDF(x, y, z + e) - garmentSDF(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1; VN[i * 3] = gx / l; VN[i * 3 + 1] = gy / l; VN[i * 3 + 2] = gz / l;
    garmentSDF(x, y, z, info); VG[i] = info.g;
  }
  // Taubin smoothing (no shrink) removes surface-nets stair-steps along hems and collars
  {
    const adj = Array.from({ length: nv }, () => []);
    for (let f = 0; f < net.idx.length; f += 3) { const a = net.idx[f], b = net.idx[f + 1], c = net.idx[f + 2]; adj[a].push(b, c); adj[b].push(a, c); adj[c].push(a, b); }
    const tmp = new Float32Array(nv * 3);
    for (let it = 0; it < 6; it++) {
      const lam = it % 2 === 0 ? 0.55 : -0.58;
      for (let v = 0; v < nv; v++) {
        const A = adj[v]; if (!A.length) { tmp[v * 3] = VP[v * 3]; tmp[v * 3 + 1] = VP[v * 3 + 1]; tmp[v * 3 + 2] = VP[v * 3 + 2]; continue; }
        let sx = 0, sy = 0, sz = 0; for (const u of A) { sx += VP[u * 3]; sy += VP[u * 3 + 1]; sz += VP[u * 3 + 2]; }
        const k = 1 / A.length;
        tmp[v * 3] = VP[v * 3] + lam * (sx * k - VP[v * 3]); tmp[v * 3 + 1] = VP[v * 3 + 1] + lam * (sy * k - VP[v * 3 + 1]); tmp[v * 3 + 2] = VP[v * 3 + 2] + lam * (sz * k - VP[v * 3 + 2]);
      }
      VP.set(tmp);
    }
    // area-weighted vertex normals from the smoothed mesh
    VN.fill(0);
    for (let f = 0; f < net.idx.length; f += 3) {
      const a = net.idx[f], b = net.idx[f + 1], c = net.idx[f + 2];
      const ux = VP[b * 3] - VP[a * 3], uy = VP[b * 3 + 1] - VP[a * 3 + 1], uz = VP[b * 3 + 2] - VP[a * 3 + 2];
      const wx = VP[c * 3] - VP[a * 3], wy = VP[c * 3 + 1] - VP[a * 3 + 1], wz = VP[c * 3 + 2] - VP[a * 3 + 2];
      const nx_ = uy * wz - uz * wy, ny_ = uz * wx - ux * wz, nz_ = ux * wy - uy * wx;
      for (const v of [a, b, c]) { VN[v * 3] += nx_; VN[v * 3 + 1] += ny_; VN[v * 3 + 2] += nz_; }
    }
    for (let v = 0; v < nv; v++) { const l = Math.hypot(VN[v * 3], VN[v * 3 + 1], VN[v * 3 + 2]) || 1; VN[v * 3] /= l; VN[v * 3 + 1] /= l; VN[v * 3 + 2] /= l; }
  }
  // cull faces buried inside the body (region walls) and faces with no garment owner
  const faces = [];
  for (let f = 0; f < net.idx.length; f += 3) {
    const a = net.idx[f], b = net.idx[f + 1], c = net.idx[f + 2];
    const cx = (VP[a * 3] + VP[b * 3] + VP[c * 3]) / 3, cy = (VP[a * 3 + 1] + VP[b * 3 + 1] + VP[c * 3 + 1]) / 3, cz = (VP[a * 3 + 2] + VP[b * 3 + 2] + VP[c * 3 + 2]) / 3;
    if (sample(SD, cx, cy, cz) < -0.0035) continue;
    const gs = [VG[a], VG[b], VG[c]]; if (gs[0] < 0 && gs[1] < 0 && gs[2] < 0) continue;
    faces.push(a, b, c);
  }
  // ---------------------------------------------------------------- skin weights via nearest body triangle
  const nb = meshes.map((m) => ({ si: m.geometry.attributes.skinIndex.array, sw: m.geometry.attributes.skinWeight.array }));
  const SI = new Uint16Array(nv * 4), SW = new Float32Array(nv * 4);
  const acc = new Map();
  for (let i = 0; i < nv; i++) {
    const x = VP[i * 3], y = VP[i * 3 + 1], z = VP[i * 3 + 2];
    // nearest triangle from the grid cell (fallback: search neighbours)
    let best = -1, bd = 1e9;
    const ci = Math.round((x - lo[0]) / h), cj = Math.round((y - lo[1]) / h), ck = Math.round((z - lo[2]) / h);
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = ci + di, jj = cj + dj, kk = ck + dk; if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
      const f = CT[gid(ii, jj, kk)]; if (f < 0) continue;
      closestOnTri(x, y, z, f * 9, cp); const d2 = (x - cp[0]) ** 2 + (y - cp[1]) ** 2 + (z - cp[2]) ** 2;
      if (d2 < bd) { bd = d2; best = f; }
    }
    acc.clear();
    if (best >= 0) {
      closestOnTri(x, y, z, best * 9, cp);
      const o = best * 9; const bc = bary(cp, TV, o);
      const mi = TM[best * 4];
      for (let v = 0; v < 3; v++) {
        const vi = TM[best * 4 + 1 + v];
        for (let k = 0; k < 4; k++) { const b = nb[mi].si[vi * 4 + k], w = nb[mi].sw[vi * 4 + k] * bc[v]; if (w > 0) acc.set(b, (acc.get(b) || 0) + w); }
      }
    }
    const top = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4); let s = 0; for (const q of top) s += q[1];
    for (let k = 0; k < 4; k++) { if (k < top.length && s > 0) { SI[i * 4 + k] = top[k][0]; SW[i * 4 + k] = top[k][1] / s; } }
  }
  // smooth weights along the garment surface for looser garments (reduces tearing at joints)
  smoothWeights(SI, SW, faces, nv, VG, GARMENTS, 3);

  // ---------------------------------------------------------------- AO + wrap phase
  const AO = new Float32Array(nv * 3), UV = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const x = VP[i * 3], y = VP[i * 3 + 1], z = VP[i * 3 + 2], nx_ = VN[i * 3], ny_ = VN[i * 3 + 1], nz_ = VN[i * 3 + 2];
    let occ = 0, wsum = 0.5;
    for (let s = 1; s <= 4; s++) { const hs = s * 0.012; const d = Math.min(garmentSDF(x + nx_ * hs, y + ny_ * hs, z + nz_ * hs), sample(SD, x + nx_ * hs, y + ny_ * hs, z + nz_ * hs)); occ += (hs - d) * wsum / hs; wsum *= 0.55; }
    const ao = Math.max(0.2, Math.min(1, 1 - occ * 0.85));
    AO[i * 3] = AO[i * 3 + 1] = AO[i * 3 + 2] = ao;
    // spiral wrap phase around the limb axis, stored as (cos, sin) so it interpolates across the seam
    const L = label(x, y, z);
    const ax = L.s.ab.clone().normalize();
    const ref = Math.abs(ax.y) > 0.8 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ax, ref).normalize(), w = new THREE.Vector3().crossVectors(ax, u);
    const r = new THREE.Vector3(x, y, z).sub(L.s.a);
    const along = r.dot(ax), ang = Math.atan2(r.dot(w), r.dot(u));
    const phase = along / 0.034 + ang / (Math.PI * 2) * L.s.side;
    UV[i * 2] = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2); UV[i * 2 + 1] = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
  }

  // ---------------------------------------------------------------- one garment mesh; material blends per vertex
  // Continuous region memberships composite the layers inner → outer, so every material
  // boundary follows the true (smooth) hem line instead of the triangle zigzag.
  const LAYER_ORDER = ['Inner', 'ForeWrap', 'FootWrap', 'ShinWrap', 'Trousers', 'Robe', 'Sash'];
  const PROPS = {
    Inner: { col: [0.39, 0.33, 0.24], rough: 0.86, sheen: 0.55, wrap: 0 },
    ForeWrap: { col: [0.32, 0.27, 0.185], rough: 0.9, sheen: 0.45, wrap: 1 },
    FootWrap: { col: [0.3, 0.25, 0.17], rough: 0.92, sheen: 0.4, wrap: 1 },
    ShinWrap: { col: [0.31, 0.26, 0.18], rough: 0.9, sheen: 0.45, wrap: 1 },
    Trousers: { col: [0.042, 0.036, 0.03], rough: 0.9, sheen: 0.7, wrap: 0 },
    Robe: { col: [0.03, 0.036, 0.044], rough: 0.92, sheen: 1.0, wrap: 0 },
    Sash: { col: [0.15, 0.02, 0.015], rough: 0.78, sheen: 0.85, wrap: 0 },
  };
  const gByName = Object.fromEntries(GARMENTS.map((g) => [g.name, g]));
  const keepFaces = [];
  for (let f = 0; f < faces.length; f += 3) keepFaces.push(faces[f], faces[f + 1], faces[f + 2]);
  const used = new Map(), remap = []; for (const v of keepFaces) if (!used.has(v)) { used.set(v, remap.length); remap.push(v); }
  const n = remap.length;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const col = new Float32Array(n * 4), uv0 = new Float32Array(n * 2), uv1 = new Float32Array(n * 2);
  armature.updateMatrixWorld(true);
  const toLocal = armature.matrixWorld.clone().invert(); const m3 = new THREE.Matrix3().getNormalMatrix(toLocal); const tmp = new THREE.Vector3();
  remap.forEach((v, i) => {
    const x = VP[v * 3], y = VP[v * 3 + 1], z = VP[v * 3 + 2];
    const L = label(x, y, z);
    let c = [...PROPS.Inner.col], rough = PROPS.Inner.rough, sheen = PROPS.Inner.sheen, wrapW = 0;
    for (const name of LAYER_ORDER) {
      const G = gByName[name]; const r = G.region(L, x, y, z);
      // membership, but only if this layer is actually the surface here (not buried under an outer one)
      let m = 1 - ss(-0.0025, 0.0025, r);
      if (m <= 0) continue;
      const P = PROPS[name];
      c = c.map((cv, k) => cv + (P.col[k] - cv) * m); rough += (P.rough - rough) * m; sheen += (P.sheen - sheen) * m; wrapW += (P.wrap - wrapW) * m;
    }
    tmp.set(x, y, z).applyMatrix4(toLocal); pos.set([tmp.x, tmp.y, tmp.z], i * 3);
    tmp.set(VN[v * 3], VN[v * 3 + 1], VN[v * 3 + 2]).applyMatrix3(m3).normalize(); nor.set([tmp.x, tmp.y, tmp.z], i * 3);
    for (let k = 0; k < 4; k++) { si[i * 4 + k] = SI[v * 4 + k]; sw[i * 4 + k] = SW[v * 4 + k]; }
    col.set([c[0], c[1], c[2], AO[v * 3]], i * 4);
    // wrap phase direction scaled by wrap membership (0 → no bands)
    uv0.set([0.5 + (UV[v * 2] - 0.5) * wrapW, 0.5 + (UV[v * 2 + 1] - 0.5) * wrapW], i * 2);
    uv1.set([rough, sheen], i * 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv0, 2)); g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(keepFaces.map((v) => used.get(v)));
  // decimate: surface nets oversample smooth cloth; keep normals, colours and wrap phase intact
  if (simplifier) {
    await simplifier.ready;
    const attrs = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) attrs.set([nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2], col[i * 4] * 4, col[i * 4 + 1] * 4, col[i * 4 + 2] * 4, uv0[i * 2], uv0[i * 2 + 1]], i * 8);
    const src = new Uint32Array(g.index.array);
    const target = Math.floor(src.length * ratio / 3) * 3;
    const [dst, err] = simplifier.simplifyWithAttributes(src, pos, 3, attrs, 8, [0.4, 0.4, 0.4, 1, 1, 1, 0.6, 0.6], null, target, 0.0035, []);
    log('garment simplify', src.length / 3, '→', dst.length / 3, 'err', err.toFixed(5));
    g.setIndex(Array.from(dst));
  }
  const gmat = new THREE.MeshStandardMaterial({ name: 'Garment', color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
  const gmesh = new THREE.SkinnedMesh(g, gmat); gmesh.name = 'Garment';
  gmesh.bind(skeleton, new THREE.Matrix4());
  const garmentMeshes = [gmesh];

  // ---------------------------------------------------------------- hide skin under the clothes
  for (let mi = 0; mi < meshes.length; mi++) {
    const s = soup[mi]; const idx = s.idx; const keep = [];
    for (let f = 0; f < idx.length; f += 3) {
      let covered = true;
      for (let v = 0; v < 3 && covered; v++) {
        const vi = idx[f + v]; const x = s.W[vi * 3], y = s.W[vi * 3 + 1], z = s.W[vi * 3 + 2];
        // covered if a garment exists 1.6 cm further outward along the normal direction and deep inside its region
        const L = label(x, y, z); let deep = false;
        for (const G of GARMENTS) { const r = G.region(L, x, y, z); if (r < -0.016) { deep = true; break; } }
        if (!deep) covered = false;
      }
      if (!covered) keep.push(idx[f], idx[f + 1], idx[f + 2]);
    }
    const before = idx.length / 3;
    s.mesh.geometry.setIndex(keep);
    log('skin', s.mesh.name, 'tris', before, '→', keep.length / 3);
  }

  // ---------------------------------------------------------------- markers for runtime (sash tails, skirt ring, hair tail, colliders)
  const head = bone('Bip01_Head'), pelvisB = bone('Bip01_Pelvis');
  const addMarker = (name, parent, worldPos, extras) => {
    const o = new THREE.Object3D(); o.name = name; parent.add(o);
    parent.updateMatrixWorld(true);
    o.position.copy(parent.worldToLocal(worldPos.clone())); o.userData = extras || {};
    return o;
  };
  // hair: find the bun (most posterior head surface near the top-back)
  let bun = null, bz = 1e9;
  for (let i = 0; i < soup[1 < soup.length ? 1 : 0].W.length; i += 3) {
    const W = soup[1 < soup.length ? 1 : 0].W; const x = W[i], y = W[i + 1], z = W[i + 2];
    if (y > J.head.y + 0.03 && y < topY - 0.02 && Math.abs(x - J.head.x) < 0.03 && z < bz) { bz = z; bun = new THREE.Vector3(x, y, z); }
  }
  if (bun) addMarker('Marker_HairTail', head, bun.add(new THREE.Vector3(0, -0.01, 0.012)), { kind: 'hair' });
  addMarker('Marker_SashKnot', pelvisB, knotC.clone(), { kind: 'sash' });
  // waist ring just under the sash: sample the robe's outer radius all around
  const ringY = waistY - 0.07; const ring = [];
  for (let a = 0; a < 24; a++) {
    const th = (a / 24) * Math.PI * 2; const dx = Math.sin(th), dz = Math.cos(th);
    let r = 0.05; for (; r < 0.35; r += 0.004) if (garmentSDF(J.pelvis.x + dx * r, ringY, J.pelvis.z + dz * r) > 0.001 && sample(SD, J.pelvis.x + dx * r, ringY, J.pelvis.z + dz * r) > 0.012) break;
    ring.push(+r.toFixed(4));
  }
  addMarker('Marker_SkirtRing', pelvisB, new THREE.Vector3(J.pelvis.x, ringY, J.pelvis.z), { kind: 'skirt', radii: ring });
  // collider radii per limb from the cross-section
  const radius = (a, b) => { const c = a.clone().lerp(b, 0.5); let r = 0.02; const d = b.clone().sub(a).normalize(); const u = new THREE.Vector3(1, 0, 0).cross(d).normalize(); if (u.lengthSq() < 0.1) u.set(0, 0, 1); for (; r < 0.2; r += 0.003) { const p = c.clone().addScaledVector(u, r); if (sample(SD, p.x, p.y, p.z) > 0) break; } return +r.toFixed(3); };
  const colliders = {
    thighL: radius(J.thighL, J.calfL), thighR: radius(J.thighR, J.calfR), shinL: radius(J.calfL, J.footL), shinR: radius(J.calfR, J.footR),
    upperL: radius(J.upL, J.foreL), upperR: radius(J.upR, J.foreR), foreL: radius(J.foreL, J.handL), foreR: radius(J.foreR, J.handR),
    torso: 0.13, hips: +(ring.reduce((s, v) => s + v, 0) / ring.length).toFixed(3),
  };
  addMarker('Marker_Colliders', pelvisB, J.pelvis.clone(), { kind: 'colliders', radii: colliders, height: +topY.toFixed(3), waistY: +waistY.toFixed(3) });
  log('markers', JSON.stringify({ bun: !!bun, knot: knotC.toArray().map((v) => +v.toFixed(3)), colliders }));
  log('total garment ms', (performance.now() - T0).toFixed(0));
  return garmentMeshes;

  // ---------------------------------------------------------------- helpers
  function bary(p, TVa, o) {
    const ax = TVa[o], ay = TVa[o + 1], az = TVa[o + 2];
    const v0 = [TVa[o + 3] - ax, TVa[o + 4] - ay, TVa[o + 5] - az], v1 = [TVa[o + 6] - ax, TVa[o + 7] - ay, TVa[o + 8] - az], v2 = [p[0] - ax, p[1] - ay, p[2] - az];
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01 || 1; const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    return [1 - v - w, v, w];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
}

function blur3(F, nx, ny, nz, sigma) {
  const r = Math.ceil(sigma * 2.5); const k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  let A = Float32Array.from(F), B = new Float32Array(F.length);
  const strides = [1, nx, nx * ny], dims = [nx, ny, nz];
  for (let ax = 0; ax < 3; ax++) {
    const st = strides[ax], dn = dims[ax];
    for (let id = 0; id < A.length; id++) {
      const c = ax === 0 ? id % nx : ax === 1 ? ((id / nx) | 0) % ny : (id / (nx * ny)) | 0;
      let s = 0;
      for (let q = -r; q <= r; q++) { const cc = Math.min(dn - 1, Math.max(0, c + q)); s += A[id + (cc - c) * st] * k[q + r]; }
      B[id] = s;
    }
    const T = A; A = B; B = T;
  }
  return A;
}

function surfaceNets(F, nx, ny, nz, lo, h) {
  const cid = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const gidx = (i, j, k) => i + nx * (j + ny * k);
  const cellIdx = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const verts = [];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const v = F[gidx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]; cv[c] = v; if (v < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      const va = cv[a], vb = cv[b]; if ((va < 0) === (vb < 0)) continue;
      const tt = va / (va - vb);
      sx += (a & 1) + tt * ((b & 1) - (a & 1)); sy += ((a >> 1) & 1) + tt * (((b >> 1) & 1) - ((a >> 1) & 1)); sz += ((a >> 2) & 1) + tt * (((b >> 2) & 1) - ((a >> 2) & 1)); n++;
    }
    cellIdx[cid(i, j, k)] = verts.length / 3;
    verts.push(lo[0] + (i + sx / n) * h, lo[1] + (j + sy / n) * h, lo[2] + (k + sz / n) * h);
  }
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const tt = b; b = d; d = tt; }
    const dac = (verts[a * 3] - verts[c * 3]) ** 2 + (verts[a * 3 + 1] - verts[c * 3 + 1]) ** 2 + (verts[a * 3 + 2] - verts[c * 3 + 2]) ** 2;
    const dbd = (verts[b * 3] - verts[d * 3]) ** 2 + (verts[b * 3 + 1] - verts[d * 3 + 1]) ** 2 + (verts[b * 3 + 2] - verts[d * 3 + 2]) ** 2;
    if (dac < dbd) idx.push(a, b, c, a, c, d); else idx.push(a, b, d, b, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = F[gidx(i, j, k)] < 0;
    if (v0 !== (F[gidx(i + 1, j, k)] < 0)) quad(cellIdx[cid(i, j - 1, k - 1)], cellIdx[cid(i, j, k - 1)], cellIdx[cid(i, j, k)], cellIdx[cid(i, j - 1, k)], !v0);
    if (v0 !== (F[gidx(i, j + 1, k)] < 0)) quad(cellIdx[cid(i - 1, j, k - 1)], cellIdx[cid(i - 1, j, k)], cellIdx[cid(i, j, k)], cellIdx[cid(i, j, k - 1)], !v0);
    if (v0 !== (F[gidx(i, j, k + 1)] < 0)) quad(cellIdx[cid(i - 1, j - 1, k)], cellIdx[cid(i, j - 1, k)], cellIdx[cid(i, j, k)], cellIdx[cid(i - 1, j, k)], !v0);
  }
  return { verts: new Float32Array(verts), idx };
}

function smoothWeights(SI, SW, faces, nv, VG, GARMENTS, iters) {
  const adj = Array.from({ length: nv }, () => new Set());
  for (let f = 0; f < faces.length; f += 3) { const a = faces[f], b = faces[f + 1], c = faces[f + 2]; adj[a].add(b).add(c); adj[b].add(a).add(c); adj[c].add(a).add(b); }
  for (let it = 0; it < iters; it++) {
    const NI = new Uint16Array(SI), NW = new Float32Array(SW);
    for (let v = 0; v < nv; v++) {
      const g = VG[v]; if (g < 0 || !GARMENTS[g].drape) continue;
      const acc = new Map();
      const add = (u, s) => { for (let k = 0; k < 4; k++) { const w = SW[u * 4 + k] * s; if (w > 0) acc.set(SI[u * 4 + k], (acc.get(SI[u * 4 + k]) || 0) + w); } };
      add(v, 1); for (const u of adj[v]) add(u, 0.5 / Math.max(1, adj[v].size) * 2);
      const top = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4); let s = 0; for (const q of top) s += q[1];
      for (let k = 0; k < 4; k++) { NI[v * 4 + k] = k < top.length ? top[k][0] : 0; NW[v * 4 + k] = k < top.length ? top[k][1] / s : 0; }
    }
    SI.set(NI); SW.set(NW);
  }
}
