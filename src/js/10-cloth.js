// §10 CLOTH — verlet robe skirt, sash tails, hair tail, pillar scraps ----------------
// Position-based verlet with distance/shear/bend constraints, capsule + ground
// collisions, pinned rows driven by bone-attached anchors (interpolated across
// substeps), and a per-particle aerodynamic force from the shared wind field.
const WIND = {
  base: V3(1.1, 0, -0.35), gust: 0.6, strength: 1, vortex: null, blasts: [],
  // vortex: { c: Vector3, r: radius, spin: m/s tangential, pull: inward m/s, up: m/s, h: height }
};
function windAt(x, y, z, t, out) {
  const g = 1 + WIND.gust * (0.55 * Math.sin(t * 0.9 + x * 0.21) + 0.35 * Math.sin(t * 2.3 + z * 0.37 + 1.3) + 0.25 * Math.sin(t * 5.1 + y * 1.7));
  out.copy(WIND.base).multiplyScalar(WIND.strength * Math.max(0.15, g));
  out.x += 0.35 * Math.sin(t * 1.7 + y * 2.1 + z) * WIND.strength;
  out.z += 0.35 * Math.cos(t * 1.3 + x * 1.9) * WIND.strength;
  const V = WIND.vortex;
  if (V && V.amt > 0.001) {
    const dx = x - V.c.x, dz = z - V.c.z, r = Math.hypot(dx, dz) + 1e-3;
    const fall = Math.exp(-Math.pow(r / (V.r * 1.8), 2)) * smoothstep(-1.5, 0.5, y - V.c.y) * (1 - smoothstep(V.h - 1, V.h + 2, y - V.c.y));
    const tang = V.spin * fall * V.amt, inward = V.pull * fall * V.amt;
    out.x += (-dz / r) * tang - (dx / r) * inward;
    out.z += (dx / r) * tang - (dz / r) * inward;
    out.y += V.up * fall * V.amt;
  }
  for (const b of WIND.blasts) {
    const dx = x - b.c.x, dy = y - b.c.y, dz = z - b.c.z, r = Math.hypot(dx, dy, dz) + 1e-3;
    const k = b.amt * Math.exp(-Math.pow((r - b.r) / b.w, 2));
    out.x += (dx / r) * k; out.y += (dy / r) * k * 0.6; out.z += (dz / r) * k;
  }
  return out;
}

class ClothWorld {
  constructor(max = 2400) {
    this.n = 0; this.max = max;
    this.x = new Float32Array(max * 3); this.p = new Float32Array(max * 3); this.w = new Float32Array(max); // inverse mass (0 = pinned)
    this.drag = new Float32Array(max); this.nrm = new Float32Array(max * 3); this.area = new Float32Array(max);
    this.pin = new Float32Array(max * 3); this.pinPrev = new Float32Array(max * 3); this.pinned = new Uint8Array(max);
    this.ca = []; this.cb = []; this.cr = []; this.ck = [];
    this.colliders = []; // {ax,ay,az,bx,by,bz,r}
    this.pieces = [];
    this.floor = true;
  }
  add(x, y, z, w = 1, area = 0.0025) {
    const i = this.n++; this.x[i * 3] = this.p[i * 3] = x; this.x[i * 3 + 1] = this.p[i * 3 + 1] = y; this.x[i * 3 + 2] = this.p[i * 3 + 2] = z;
    this.w[i] = w; this.area[i] = area; this.drag[i] = 1; return i;
  }
  link(a, b, k = 1, rest = null) {
    const dx = this.x[b * 3] - this.x[a * 3], dy = this.x[b * 3 + 1] - this.x[a * 3 + 1], dz = this.x[b * 3 + 2] - this.x[a * 3 + 2];
    this.ca.push(a); this.cb.push(b); this.cr.push(rest != null ? rest : Math.hypot(dx, dy, dz)); this.ck.push(k);
  }
  finalize() { this.CA = Int32Array.from(this.ca); this.CB = Int32Array.from(this.cb); this.CR = Float32Array.from(this.cr); this.CK = Float32Array.from(this.ck); }
  step(dt, t, iters) {
    if (dt <= 0) return;
    const X = this.x, P = this.p, W = this.w, n = this.n, g = -9.81;
    const dt2 = dt * dt; const wv = _v1;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (this.pinned[i]) continue;
      const vx = X[k] - P[k], vy = X[k + 1] - P[k + 1], vz = X[k + 2] - P[k + 2];
      // aerodynamic force: normal component of relative wind (plus a little tangential drag)
      windAt(X[k], X[k + 1], X[k + 2], t, wv);
      const rx = wv.x - vx / dt, ry = wv.y - vy / dt, rz = wv.z - vz / dt;
      const nx = this.nrm[k], ny = this.nrm[k + 1], nz = this.nrm[k + 2];
      const dn = rx * nx + ry * ny + rz * nz;
      const a = this.area[i] * this.drag[i] * W[i];
      const fx = (dn * nx * 6.0 + rx * 0.9) * a, fy = (dn * ny * 6.0 + ry * 0.9) * a, fz = (dn * nz * 6.0 + rz * 0.9) * a;
      const damp = 0.992;
      P[k] = X[k]; P[k + 1] = X[k + 1]; P[k + 2] = X[k + 2];
      X[k] += vx * damp + fx * dt2 * 60; X[k + 1] += vy * damp + (g + fy * 60) * dt2; X[k + 2] += vz * damp + fz * dt2 * 60;
    }
    const CA = this.CA, CB = this.CB, CR = this.CR, CK = this.CK, nc = CA.length;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < nc; c++) {
        const a = CA[c] * 3, b = CB[c] * 3; const wa = W[CA[c]], wb = W[CB[c]]; const ws = wa + wb; if (ws === 0) continue;
        const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
        const diff = ((d - CR[c]) / d) * CK[c] / ws;
        X[a] += dx * diff * wa; X[a + 1] += dy * diff * wa; X[a + 2] += dz * diff * wa;
        X[b] -= dx * diff * wb; X[b + 1] -= dy * diff * wb; X[b + 2] -= dz * diff * wb;
      }
      this.collide();
    }
  }
  collide() {
    const X = this.x, n = this.n, C = this.colliders;
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) continue;
      const k = i * 3; let x = X[k], y = X[k + 1], z = X[k + 2];
      for (let c = 0; c < C.length; c++) {
        const L = C[c]; if (L.mask && !(L.mask & this.mask[i])) continue;
        const abx = L.bx - L.ax, aby = L.by - L.ay, abz = L.bz - L.az;
        const t = clamp(((x - L.ax) * abx + (y - L.ay) * aby + (z - L.az) * abz) / (abx * abx + aby * aby + abz * abz + 1e-9));
        const cx = L.ax + abx * t, cy = L.ay + aby * t, cz = L.az + abz * t;
        const dx = x - cx, dy = y - cy, dz = z - cz; const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < L.r * L.r && d2 > 1e-10) { const d = Math.sqrt(d2), s = L.r / d; x = cx + dx * s; y = cy + dy * s; z = cz + dz * s; }
      }
      if (this.floor) { const gy = groundHeight(x, z) + 0.006; if (y < gy) { y = gy; const pk = this.p; pk[k] = x - (x - pk[k]) * 0.4; pk[k + 2] = z - (z - pk[k + 2]) * 0.4; } }
      X[k] = x; X[k + 1] = y; X[k + 2] = z;
    }
  }
}

// ---- cloth pieces --------------------------------------------------------------------------
const CLOTH = { world: null, pieces: [], meshes: [], group: new THREE.Group(), time: 0, fig: null, scraps: [] };
CLOTH.group.name = 'cloth';

function clothMaterial({ front, back, rough = 0.9, sheen = 0.8, fray = 0.0, hair = false, key = 'cloth' }) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: rough, metalness: 0, side: THREE.DoubleSide, sheen: sheen > 0 ? 1 : 0, sheenRoughness: 0.55, sheenColor: new THREE.Color(1, 1, 1) });
  m.userData.key = key;
  const U2 = { uFront: { value: new THREE.Color(...front) }, uBack: { value: new THREE.Color(...back) }, uFray: { value: fray }, uSheenAmt: { value: sheen }, uClothV: { value: TEX.clothV }, uHair: { value: hair ? 1 : 0 }, uWetC: CHAR_U.uWet };
  m.userData.u = U2;
  patchWorldMaterial(m, Object.assign((sh) => {
    Object.assign(sh.uniforms, U2);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vCUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCUv; uniform vec3 uFront, uBack; uniform float uFray, uSheenAmt, uHair, uWetC; uniform sampler2D uClothV; float cH; float cAO;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec4 cv = texture2D(uClothV, vCUv * vec2(3.0, 6.0));
          // frayed, torn hem
          float fr = uFray * (0.35 + 0.65 * sp_vnoise2(vec2(vCUv.x * 90.0, 3.0)) + 0.3 * sp_vnoise2(vec2(vCUv.x * 300.0, 1.0)));
          if (vCUv.y > 1.0 - fr * 0.08) discard;
          vec3 col = gl_FrontFacing ? uFront : uBack;
          if (uHair > 0.5) {
            float strand = sp_vnoise2(vec2(vCUv.x * 40.0, vCUv.y * 2.0)) * 0.6 + sp_vnoise2(vec2(vCUv.x * 140.0, vCUv.y * 6.0)) * 0.4;
            if (vCUv.y > 0.93 + 0.07 * strand) discard;
            col *= 0.7 + 0.6 * strand;
            cH = strand * 0.6;
          } else {
            cH = texture2D(uClothV, vCUv * vec2(26.0, 52.0)).a * 0.4 + cv.g * 0.3;
            col *= 0.88 + 0.24 * cv.r;
            col = mix(col, col * vec3(1.18, 1.08, 0.95) + 0.012, smoothstep(0.6, 1.0, vCUv.y) * 0.5); // dusty hem
          }
          col *= mix(1.0, 0.62, uWetC);
          cAO = mix(0.75, 1.0, smoothstep(0.0, 0.25, vCUv.y));
          diffuseColor.rgb = col;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 dh = vec2(dFdx(cH), dFdy(cH)) * 0.0012; // height in metres
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2));
        }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.sheenColor = mix(vec3(1.0), diffuseColor.rgb * 3.0 + 0.1, 0.5) * uSheenAmt * 0.22; material.sheenRoughness = 0.6;
        if (uHair > 0.5) { material.roughness = 0.38; }`)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= cAO; reflectedLight.directDiffuse *= mix(0.8, 1.0, cAO);');
  }, { key }));
  return m;
}

// A grid piece: cols × rows particles, rows hang from row 0 (pinned). Returns piece descriptor.
function gridPiece(W, cols, rows, posFn, { k = 1, shear = 0.6, bend = 0.25, area = 0.0025, drag = 1, cut = null, wrapCols = false, mask = 1 } = {}) {
  const base = W.n;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const p = posFn(c, r); const i = W.add(p.x, p.y, p.z, r === 0 ? 0 : 1, area); W.drag[i] = drag; W.mask[i] = mask; if (r === 0) W.pinned[i] = 1; }
  const id = (c, r) => base + r * cols + c;
  const hc = (c) => !(cut && cut.has(c)); // horizontal link from column c to c+1 allowed?
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cn = wrapCols ? (c + 1) % cols : c + 1;
    if (cn < cols && (wrapCols || c + 1 < cols) && hc(c)) W.link(id(c, r), id(cn, r), k);
    if (r + 1 < rows) W.link(id(c, r), id(c, r + 1), k);
    if (r + 1 < rows && cn < cols && hc(c)) { W.link(id(c, r), id(cn, r + 1), shear); W.link(id(cn, r), id(c, r + 1), shear); }
    if (r + 2 < rows) W.link(id(c, r), id(c, r + 2), bend);
    const cn2 = wrapCols ? (c + 2) % cols : c + 2;
    if (cn2 < cols && hc(c) && hc((c + 1) % cols)) W.link(id(c, r), id(cn2, r), bend * 0.6);
  }
  return { base, cols, rows, id, cut, wrapCols };
}

function tubeGeometry(rows, seg) {
  const n = rows * (seg + 1); const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * 2); for (let r = 0; r < rows; r++) for (let k = 0; k <= seg; k++) { uv[(r * (seg + 1) + k) * 2] = k / seg; uv[(r * (seg + 1) + k) * 2 + 1] = r / (rows - 1); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idx = []; for (let r = 0; r < rows - 1; r++) for (let k = 0; k < seg; k++) { const a = r * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  g.setIndex(idx); g.boundingSphere = new THREE.Sphere(V3(), 1e4); return g;
}
function pieceGeometry(pc, uvFn) {
  const n = pc.cols * pc.rows; const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * 2);
  for (let r = 0; r < pc.rows; r++) for (let c = 0; c < pc.cols; c++) { const [u, v] = uvFn(c, r); uv[(r * pc.cols + c) * 2] = u; uv[(r * pc.cols + c) * 2 + 1] = v; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idx = [];
  for (let r = 0; r < pc.rows - 1; r++) for (let c = 0; c < pc.cols; c++) {
    const cn = pc.wrapCols ? (c + 1) % pc.cols : c + 1; if (cn >= pc.cols && !pc.wrapCols) continue; if (pc.cut && pc.cut.has(c)) continue;
    const a = r * pc.cols + c, b = r * pc.cols + cn, cc = (r + 1) * pc.cols + c, d = (r + 1) * pc.cols + cn;
    idx.push(a, cc, b, b, cc, d);
  }
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(V3(), 1e4);
  return g;
}

// Anchor helpers ---------------------------------------------------------------------------------
function markerFrame(fig, key, outP, outQ) {
  const m = fig.markers[key];
  if (!m) return false;
  if (m.obj) { m.obj.getWorldPosition(outP); m.obj.getWorldQuaternion(outQ); return true; }
  m.bone.updateWorldMatrix(true, false);
  outP.copy(m.local).applyMatrix4(m.bone.matrixWorld); m.bone.getWorldQuaternion(outQ); return true;
}
function boneDelta(fig, name, out) {
  const b = fig.boneFor(name); b.getWorldQuaternion(out);
  const r = fig.restWorldQ ? fig.restWorldQ.get(b) : null;
  if (r) out.multiply(_q2.copy(r).invert());
  return out;
}
const anchorBone = (pc) => (pc.kind === 'hair' ? 'head' : 'hips');
function bodyYawQuat(fig, out) {
  // hips facing from the figure's pelvis orientation projected to the ground plane
  const hips = fig.boneFor('hips'); const q = hips.getWorldQuaternion(_q1);
  const L = fig.boneFor('thigh_L').getWorldPosition(_v1), R = fig.boneFor('thigh_R').getWorldPosition(_v2);
  const left = _v3.subVectors(L, R); left.y = 0; left.normalize();
  const fwd = _v4.set(-left.z, 0, left.x);
  return out.setFromUnitVectors(V3(0, 0, 1), fwd.normalize());
}

function initCloth(fig) {
  CLOTH.group.clear();
  for (const m of CLOTH.meshes) m.geometry.dispose();
  CLOTH.meshes = []; CLOTH.pieces = [];
  const W = new ClothWorld(2600); W.mask = new Uint8Array(2600);
  CLOTH.world = W; CLOTH.fig = fig;
  const P = V3(), MQ = new THREE.Quaternion();
  fig.root.updateMatrixWorld(true);
  // --- skirt: four robe panels with a front wrap overlap and side/back slits
  if (markerFrame(fig, 'skirt', P, MQ)) {
    const radii = fig.markers.skirt.radii; const nR = radii.length;
    const COLS = 32, ROWS = 13, len = Math.max(0.55, (P.y - 0.3)) , step = len / (ROWS - 1);
    const yawQ = boneDelta(fig, 'hips', new THREE.Quaternion());
    const radiusAt = (th) => { const f = ((th / TAU) % 1 + 1) % 1 * nR; const i = Math.floor(f) % nR, j = (i + 1) % nR, u = f - Math.floor(f); return lerp(radii[i], radii[j], u); };
    // column angles: θ from +Z (front) toward +X (figure's left); cuts after these columns (slits)
    const angles = []; for (let c = 0; c < COLS; c++) angles.push((c / COLS) * TAU);
    const cut = new Set([Math.round(COLS * 0.25) - 1, Math.round(COLS * 0.75) - 1]);   // side slits: a front and a back panel
    const localPos = (c, r) => {
      const th = angles[c]; const rr = radiusAt(th) * 1.02 + (r / (ROWS - 1)) * 0.1 + (c === 0 ? 0.008 : 0);
      return V3(Math.sin(th) * rr, -r * step, Math.cos(th) * rr);
    };
    const pc = gridPiece(W, COLS, ROWS, (c, r) => localPos(c, r).applyQuaternion(yawQ).add(P), { k: 1, shear: 0.5, bend: 0.2, area: 0.003, drag: 0.72, cut, wrapCols: true, mask: 1 });
    pc.kind = 'skirt'; pc.localPos = localPos; pc.anchor = 'skirt'; pc.len = len;
    const mat = clothMaterial({ front: [0.03, 0.036, 0.044], back: [0.075, 0.068, 0.06], rough: 0.92, sheen: 1.0, fray: 1.0, key: 'skirt' });
    const geo = pieceGeometry(pc, (c, r) => [c / COLS, r / (ROWS - 1)]);
    const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    CLOTH.group.add(mesh); CLOTH.meshes.push(mesh); pc.mesh = mesh; CLOTH.pieces.push(pc);
  }
  // --- sash tails from the knot (two strips of different length)
  if (markerFrame(fig, 'sash', P, MQ)) {
    const yawQ = boneDelta(fig, 'hips', new THREE.Quaternion());
    for (const [off, width, len] of [[0.0, 0.085, 1.02], [0.03, 0.074, 0.78]]) {
      const ROWS = Math.round(len / 0.05) + 1, COLS = 3;
      const localPos = (c, r) => V3(off + (c / (COLS - 1) - 0.5) * width, -r * 0.05 - 0.02, 0.02 + r * 0.002);
      const pc = gridPiece(W, COLS, ROWS, (c, r) => localPos(c, r).applyQuaternion(yawQ).add(P), { k: 1, shear: 0.8, bend: 0.35, area: 0.0022, drag: 1.3, mask: 2 });
      pc.kind = 'sash'; pc.localPos = localPos; pc.anchor = 'sash';
      const mat = clothMaterial({ front: [0.15, 0.02, 0.015], back: [0.12, 0.016, 0.012], rough: 0.78, sheen: 0.85, fray: 0.8, key: 'sash' });
      const mesh = new THREE.Mesh(pieceGeometry(pc, (c, r) => [c / (COLS - 1), r / (ROWS - 1)]), mat);
      mesh.castShadow = true; mesh.frustumCulled = false; CLOTH.group.add(mesh); CLOTH.meshes.push(mesh); pc.mesh = mesh; CLOTH.pieces.push(pc);
    }
  }
  // --- hair tail: a tapered ribbon of strands from the bun / nape
  if (markerFrame(fig, 'hair', P, MQ)) {
    const yawQ = boneDelta(fig, 'head', new THREE.Quaternion());
    const COLS = 4, ROWS = 11, width = 0.055, seg = 0.042;
    const localPos = (c, r) => V3((c / (COLS - 1) - 0.5) * width * (1 - r / ROWS * 0.6), -r * seg * 0.9, -0.015 - r * seg * 0.35);
    const pc = gridPiece(W, COLS, ROWS, (c, r) => localPos(c, r).applyQuaternion(yawQ).add(P), { k: 1, shear: 0.7, bend: 0.55, area: 0.0012, drag: 0.8, mask: 4 });
    pc.kind = 'hair'; pc.localPos = localPos; pc.anchor = 'hair';
    const hc = fig.hairColor || new THREE.Color(0.2, 0.13, 0.06);
    const mat = clothMaterial({ front: [hc.r, hc.g, hc.b], back: [hc.r * 0.8, hc.g * 0.8, hc.b * 0.8], rough: 0.4, sheen: 0.3, hair: true, key: 'hair' });
    mat.side = THREE.FrontSide;
    pc.tube = { seg: 10 };
    const mesh = new THREE.Mesh(tubeGeometry(ROWS, pc.tube.seg), mat);
    mesh.castShadow = true; mesh.frustumCulled = false; CLOTH.group.add(mesh); CLOTH.meshes.push(mesh); pc.mesh = mesh; CLOTH.pieces.push(pc);
  }
  // --- scraps of cloth tied to the pillars
  for (const a of WORLD.scrapAnchors) {
    const COLS = 3, ROWS = 12, width = 0.11;
    const dir = V3(a.x - a.cx, 0, a.z - a.cz).normalize(); const side = V3(-dir.z, 0, dir.x);
    const localPos = (c, r) => V3(0, 0, 0).addScaledVector(side, (c / (COLS - 1) - 0.5) * width).addScaledVector(dir, 0.012).add(V3(0, -r * 0.055, 0));
    const base = V3(a.x, a.y, a.z);
    const pc = gridPiece(W, COLS, ROWS, (c, r) => localPos(c, r).add(base), { k: 1, shear: 0.6, bend: 0.12, area: 0.0028, drag: 1.4, mask: 8 });
    pc.kind = 'scrap'; pc.localPos = localPos; pc.base = base; pc.pillar = a;
    const tint = [[0.22, 0.2, 0.17], [0.15, 0.04, 0.03], [0.26, 0.24, 0.2]][CLOTH.pieces.length % 3];
    const mat = clothMaterial({ front: tint, back: tint.map((v) => v * 0.85), rough: 0.95, sheen: 0.6, fray: 1.0, key: 'scrap' });
    const mesh = new THREE.Mesh(pieceGeometry(pc, (c, r) => [c / (COLS - 1), r / (ROWS - 1)]), mat);
    mesh.castShadow = true; mesh.frustumCulled = false; CLOTH.group.add(mesh); CLOTH.meshes.push(mesh); pc.mesh = mesh; CLOTH.pieces.push(pc);
    pc.collider = { ax: a.cx, ay: a.y - 3, az: a.cz, bx: a.cx, by: a.y + 1, bz: a.cz, r: a.r + 0.03, mask: 8 };
    pc.released = false;
    CLOTH.scraps.push(pc);
  }
  W.finalize();
  CLOTH.lastAnchors = null;
  resetCloth();
}

// Place every piece in its rest drape around the current anchors (used on seek / teleports).
function resetCloth() {
  const W = CLOTH.world; if (!W) return;
  const fig = CLOTH.fig; const P = V3(), MQ = new THREE.Quaternion(), rot = new THREE.Quaternion();
  for (const pc of CLOTH.pieces) {
    let origin = P;
    if (pc.anchor) { if (!markerFrame(fig, pc.anchor, P, MQ)) continue; boneDelta(fig, anchorBone(pc), rot); }
    else { origin = pc.base; rot.identity(); pc.released = false; }
    for (let r = 0; r < pc.rows; r++) for (let c = 0; c < pc.cols; c++) {
      const i = pc.id(c, r); const p = pc.localPos(c, r).applyQuaternion(rot).add(origin);
      W.x[i * 3] = W.p[i * 3] = p.x; W.x[i * 3 + 1] = W.p[i * 3 + 1] = p.y; W.x[i * 3 + 2] = W.p[i * 3 + 2] = p.z;
      W.pinned[i] = r === 0 ? 1 : 0; W.w[i] = r === 0 ? 0 : 1;
      W.pin[i * 3] = W.pinPrev[i * 3] = p.x; W.pin[i * 3 + 1] = W.pinPrev[i * 3 + 1] = p.y; W.pin[i * 3 + 2] = W.pinPrev[i * 3 + 2] = p.z;
    }
  }
  CLOTH.settle = 20;
}

function releaseScrap(pc) { // tear a scrap free (Act V gathers them into the vortex)
  if (pc.released) return; pc.released = true;
  const W = CLOTH.world;
  for (let c = 0; c < pc.cols; c++) { const i = pc.id(c, 0); W.pinned[i] = 0; W.w[i] = 1; }
}

function updateColliders(fig) {
  const W = CLOTH.world; const C = [];
  const R = fig.colliderRadii || {};
  const cap = (a, b, r, mask = 7) => { const A = fig.boneFor(a), B = fig.boneFor(b); if (!A || !B) return; const pa = A.getWorldPosition(_v1), pb = B.getWorldPosition(_v2); C.push({ ax: pa.x, ay: pa.y, az: pa.z, bx: pb.x, by: pb.y, bz: pb.z, r, mask }); };
  const pad = 0.035; // trousers + robe thickness over the limb
  cap('thigh_L', 'shin_L', (R.thighL || 0.085) + pad, 3); cap('thigh_R', 'shin_R', (R.thighR || 0.085) + pad, 3);
  cap('shin_L', 'foot_L', (R.shinL || 0.06) + 0.03, 3); cap('shin_R', 'foot_R', (R.shinR || 0.06) + 0.03, 3);
  cap('hips', 'spine', (R.hips || 0.18) * 0.92, 3);
  cap('upperChest', 'neck', 0.13, 4); cap('neck', 'head', 0.07, 4);
  cap('upperArm_L', 'forearm_L', (R.upperL || 0.05) + 0.03, 6); cap('upperArm_R', 'forearm_R', (R.upperR || 0.05) + 0.03, 6);
  cap('forearm_L', 'hand_L', (R.foreL || 0.04) + 0.02, 6); cap('forearm_R', 'hand_R', (R.foreR || 0.04) + 0.02, 6);
  // head sphere for the hair tail
  const H = fig.boneFor('head'); if (H) { const hp = H.getWorldPosition(_v1); const d = boneDelta(fig, 'head', _q3); const c = hp.add(_v2.set(0, 0.075, 0.012).applyQuaternion(d)); C.push({ ax: c.x, ay: c.y, az: c.z, bx: c.x, by: c.y + 1e-4, bz: c.z, r: 0.098, mask: 4 }); }
  for (const pc of CLOTH.scraps) C.push(pc.collider);
  W.colliders = C;
}

function updateCloth(dt, t) {
  const W = CLOTH.world, fig = CLOTH.fig; if (!W || !fig) return;
  CLOTH.time = t;
  updateColliders(fig);
  // pinned targets for this frame (anchors ride their bones: pelvis for skirt/sash, head for hair)
  const P = V3(), MQ = new THREE.Quaternion(), rot = new THREE.Quaternion();
  let jump = 0;
  for (const pc of CLOTH.pieces) {
    if (!pc.anchor) continue;
    markerFrame(fig, pc.anchor, P, MQ); boneDelta(fig, anchorBone(pc), rot);
    for (let c = 0; c < pc.cols; c++) {
      const i = pc.id(c, 0); const p = pc.localPos(c, 0).applyQuaternion(rot).add(P);
      jump = Math.max(jump, Math.hypot(p.x - W.pin[i * 3], p.y - W.pin[i * 3 + 1], p.z - W.pin[i * 3 + 2]));
      W.pinPrev[i * 3] = W.pin[i * 3]; W.pinPrev[i * 3 + 1] = W.pin[i * 3 + 1]; W.pinPrev[i * 3 + 2] = W.pin[i * 3 + 2];
      W.pin[i * 3] = p.x; W.pin[i * 3 + 1] = p.y; W.pin[i * 3 + 2] = p.z;
    }
  }
  if (jump > 0.6) { resetCloth(); return; }
  if (dt <= 0) { writeClothMeshes(); return; }
  const sub = Q.clothSub, h = Math.min(dt, 1 / 30) / sub;
  for (let s = 1; s <= sub; s++) {
    const f = s / sub;
    for (const pc of CLOTH.pieces) {
      if (!pc.anchor) continue;
      for (let c = 0; c < pc.cols; c++) { const i = pc.id(c, 0); if (!W.pinned[i]) continue; for (let k = 0; k < 3; k++) W.x[i * 3 + k] = lerp(W.pinPrev[i * 3 + k], W.pin[i * 3 + k], f); }
    }
    computeClothNormals();
    W.step(h, t + h * s, Q.clothIters);
  }
  if (CLOTH.settle > 0) CLOTH.settle--;
  writeClothMeshes();
}

// hair tail: an elliptical tube swept along the strip's centreline, tapering to the tip
function writeTube(pc) {
  const W = CLOTH.world, X = W.x; const seg = pc.tube.seg; const g = pc.mesh.geometry; const pa = g.attributes.position.array, na = g.attributes.normal.array;
  const c0 = 0, c1 = pc.cols - 1; const C = _v1, T = _v2, S = _v3, Nn = _v4; const B = new THREE.Vector3();
  for (let r = 0; r < pc.rows; r++) {
    const a = pc.id(c0, r), b = pc.id(c1, r);
    C.set((X[a * 3] + X[b * 3]) / 2, (X[a * 3 + 1] + X[b * 3 + 1]) / 2, (X[a * 3 + 2] + X[b * 3 + 2]) / 2);
    S.set(X[b * 3] - X[a * 3], X[b * 3 + 1] - X[a * 3 + 1], X[b * 3 + 2] - X[a * 3 + 2]);
    const rn = pc.id(c0, Math.min(r + 1, pc.rows - 1)), rp = pc.id(c0, Math.max(r - 1, 0));
    T.set(X[rn * 3] - X[rp * 3], X[rn * 3 + 1] - X[rp * 3 + 1], X[rn * 3 + 2] - X[rp * 3 + 2]).normalize();
    const u = r / (pc.rows - 1);
    const wid = 0.028 * (1 - 0.55 * u) * (r === 0 ? 0.8 : 1), thick = wid * 0.62;
    S.addScaledVector(T, -S.dot(T)).normalize(); B.crossVectors(T, S).normalize();
    for (let k = 0; k <= seg; k++) {
      const ang = (k / seg) * TAU; const cx = Math.cos(ang), sy = Math.sin(ang);
      const j = (r * (seg + 1) + k) * 3;
      Nn.copy(S).multiplyScalar(cx).addScaledVector(B, sy);
      pa[j] = C.x + S.x * cx * wid + B.x * sy * thick; pa[j + 1] = C.y + S.y * cx * wid + B.y * sy * thick; pa[j + 2] = C.z + S.z * cx * wid + B.z * sy * thick;
      na[j] = Nn.x; na[j + 1] = Nn.y; na[j + 2] = Nn.z;
    }
  }
  g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
}

function computeClothNormals() {
  const W = CLOTH.world, X = W.x, N = W.nrm;
  for (const pc of CLOTH.pieces) {
    for (let r = 0; r < pc.rows; r++) for (let c = 0; c < pc.cols; c++) {
      const i = pc.id(c, r);
      const cl = pc.id(c > 0 ? c - 1 : (pc.wrapCols ? pc.cols - 1 : c), r), cr = pc.id(c < pc.cols - 1 ? c + 1 : (pc.wrapCols ? 0 : c), r);
      const ru = pc.id(c, r > 0 ? r - 1 : r), rd = pc.id(c, r < pc.rows - 1 ? r + 1 : r);
      const ax = X[cr * 3] - X[cl * 3], ay = X[cr * 3 + 1] - X[cl * 3 + 1], az = X[cr * 3 + 2] - X[cl * 3 + 2];
      const bx = X[rd * 3] - X[ru * 3], by = X[rd * 3 + 1] - X[ru * 3 + 1], bz = X[rd * 3 + 2] - X[ru * 3 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1;
      N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
    }
  }
}

function writeClothMeshes() {
  const W = CLOTH.world;
  computeClothNormals();
  for (const pc of CLOTH.pieces) {
    if (pc.tube) { writeTube(pc); continue; }
    const g = pc.mesh.geometry; const pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (let r = 0; r < pc.rows; r++) for (let c = 0; c < pc.cols; c++) {
      const i = pc.id(c, r), j = (r * pc.cols + c) * 3;
      pa[j] = W.x[i * 3]; pa[j + 1] = W.x[i * 3 + 1]; pa[j + 2] = W.x[i * 3 + 2];
      na[j] = -W.nrm[i * 3]; na[j + 1] = -W.nrm[i * 3 + 1]; na[j + 2] = -W.nrm[i * 3 + 2];
    }
    g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
  }
}
