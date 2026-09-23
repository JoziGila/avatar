// §14 EARTH — the stomp (shockwave, crack network, dust, jumping pebbles), three slabs torn from
// the summit that hover and grind, are punched into the pillars and the lip boulder and burst into
// rigid fragments, and the stone column that erupts under the camera.
const EARTH = {
  t: { stomp: 22.3, tear: [23.05, 23.3, 23.55], launch: [25.36, 25.76, 26.75], rise: 30.08 },
  slabs: [], rock: null, pillar: null, pillarH: 3.2, flight: 24, crackR: 7.2, stompAt: V3(0.46, 0, 0.06),
};
// slab hover spots in the body frame of the rooted stance (E0 = [0, 0.1], yaw 180°): x left, z forward
const SLAB_DEFS = [
  { b: [0.24, 1.02], h: 1.22, target: 'P2', seed: 5, rot: 0.3 },     // left punch
  { b: [-0.22, 1.02], h: 1.04, target: 'P3', seed: 9, rot: -0.4 },   // right punch
  { b: [-0.78, 0.55], h: 1.28, target: 'B1', seed: 13, rot: 1.1 },   // spinning back fist
];

function slabGeometry(seed, w = 1.15, t = 0.26, d = 0.78) {
  const g = new THREE.BoxGeometry(w, t, d, 10, 2, 7);
  const p = g.attributes.position, o = seed * 3.7;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ex = Math.abs(x) / (w / 2), ez = Math.abs(z) / (d / 2);
    const edge = Math.max(ex, ez);
    // torn outline: pull the rim in by noise
    const k = 1 - 0.16 * Math.max(0, Noise.n2(x * 5 + o, z * 5 - o) * 0.5 + 0.5) * smoothstep(0.7, 1, edge);
    x *= k; z *= k;
    if (y < 0) y -= 0.07 * (Noise.fbm2(x * 3 + o, z * 3, 3) * 0.5 + 0.5) + 0.05 * (1 - edge);   // ragged underside
    else y += 0.012 * Noise.n2(x * 6 + o, z * 6);
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}
function eruptGeometry(seed, H) {
  const g = new THREE.CylinderGeometry(0.44, 0.62, H, 7, 16, false);
  const p = g.attributes.position, o = seed * 1.9;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z) || 1; const a = Math.atan2(z, x);
    const top = y > H / 2 - 1e-3;
    let dr = 1 + 0.08 * Noise.n2(a * 2 + o, y * 1.3) + 0.04 * Noise.n2(a * 6, y * 5 + o);
    if (top) { y += 0.28 * (Noise.n2(x * 4 + o, z * 4) * 0.5 + 0.5) - 0.1 * r; }
    else if (y > H / 2 - 0.35) { dr *= 1 - 0.1 * smoothstep(H / 2 - 0.35, H / 2, y); }
    p.setXYZ(i, x * dr, y + H / 2, z * dr);
  }
  g.computeVertexNormals();
  return g;
}
function targetPoint(name, from, out) {
  if (name === 'B1') { const b = LAYOUT.boulders[0]; const d = _v1.set(b.x - from.x, 0, b.z - from.z).normalize(); return out.set(b.x - d.x * b.s * 0.95, groundHeight(b.x, b.z) + 0.45 * b.s, b.z - d.z * b.s * 0.95); }
  const pd = LAYOUT.pillars.find((q) => q.id === name); const d = _v1.set(pd.x - from.x, 0, pd.z - from.z).normalize();
  return out.set(pd.x - d.x * pd.r * 0.95, 1.25, pd.z - d.z * pd.r * 0.95);
}

function initEarth() {
  const mat = WORLD.stoneMat;
  EARTH.rock = new RigidPool('rock', [chunkGeometry(31, 1, 0.7, 0.8, 1), chunkGeometry(32, 0.8, 1, 0.6, 1), chunkGeometry(33, 1.1, 0.5, 0.9, 1), chunkGeometry(34, 0.7, 0.6, 0.7, 1)], mat, 160, { restitution: 0.22, friction: 0.6 });
  const E0 = [0, 0.1], yaw = 180;
  SLAB_DEFS.forEach((d, i) => {
    const m = new THREE.Mesh(slabGeometry(d.seed), mat); m.castShadow = m.receiveShadow = true; m.visible = false; world.add(m);
    const [x, z] = bw(E0, yaw, d.b[0], d.b[1]);
    const home = V3(x, groundHeight(x, z), z);
    const hover = V3(x, d.h, z);
    const target = targetPoint(d.target, hover, V3());
    EARTH.slabs.push({ def: d, mesh: m, home, hover, target, q: new THREE.Quaternion(), tear: EARTH.t.tear[i], launch: EARTH.t.launch[i],
      hit: EARTH.t.launch[i] + hover.distanceTo(target) / EARTH.flight, pit: i, broke: false });
  });
  const ep = LAYOUT.eruptPillar;
  EARTH.pillar = new THREE.Mesh(eruptGeometry(21, EARTH.pillarH), mat); EARTH.pillar.castShadow = EARTH.pillar.receiveShadow = true;
  EARTH.pillar.position.set(ep.x, -EARTH.pillarH - 0.5, ep.z); EARTH.pillar.rotation.y = 0.7; EARTH.pillar.visible = false; world.add(EARTH.pillar);
}

// ---- beats --------------------------------------------------------------------------------------
function stompBurst(ctx) {
  const c = EARTH.stompAt.copy(FIG.p.foot_R); c.y = groundHeight(c.x, c.z);
  if (ctx.skipped) return;
  hitStop(4); addTrauma(0.6);
  PS.smoke.emit({ count: 70, pos: V3(c.x, c.y + 0.05, c.z), radius: 0.35, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.2, 0), spread: 5.5, life: [1.4, 2.8], size: [0.14, 0.28], kind: 1, param: 0.4 });
  PS.smoke.emit({ count: 14, pos: V3(c.x, c.y + 0.1, c.z), radius: 0.3, vel: V3(0, 0.8, 0), spread: 1.0, life: [1.2, 2.2], size: [0.2, 0.36], kind: 1, param: 0.6 });
  // pebbles jump across the whole plateau, more near the foot
  PS.debris.emit({ count: 260, pos: V3(c.x, c.y + 0.03, c.z), radius: 2.6, vel: V3(0, 2.2, 0), spread: 1.3, life: [1.6, 3.0], size: [0.012, 0.03], kind: 0 });
  PS.debris.emit({ count: 120, pos: V3(c.x, c.y + 0.03, c.z), radius: 0.7, vel: V3(0, 3.2, 0), spread: 2.2, life: [1.4, 2.6], size: [0.02, 0.045], kind: 0 });
  for (let i = 0; i < 8; i++) EARTH.rock.spawn({ pos: V3(c.x + (Math.random() - 0.5) * 0.8, c.y + 0.05, c.z + (Math.random() - 0.5) * 0.8), vel: V3((Math.random() - 0.5) * 2.5, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 2.5), scale: 0.03 + Math.random() * 0.04 });
  FIELD.shock.set(c.x, c.y, c.z, 0); FIELD.shock2.set(0.5, 9, 0, 0); EARTH.shockT = TL.T;
  sfx('stomp', { pos: c, gain: 1 });
}
function slabTear(i, ctx) {
  const S = EARTH.slabs[i]; const c = S.home;
  if (ctx.skipped) return;
  addTrauma(0.18);
  PS.smoke.emit({ count: 16, pos: V3(c.x, c.y + 0.05, c.z), radius: 0.45, vel: V3(0, 1.0, 0), spread: 1.0, life: [1.2, 2.2], size: [0.12, 0.26], kind: 1, param: 0.5 });
  PS.debris.emit({ count: 70, pos: V3(c.x, c.y + 0.05, c.z), radius: 0.5, vel: V3(0, 2.6, 0), spread: 1.6, life: [1.2, 2.4], size: [0.015, 0.035], kind: 0 });
  for (let k = 0; k < 5; k++) EARTH.rock.spawn({ pos: V3(c.x + (Math.random() - 0.5) * 1.0, c.y + 0.1, c.z + (Math.random() - 0.5) * 0.7), vel: V3((Math.random() - 0.5) * 1.5, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 1.5), scale: 0.04 + Math.random() * 0.05 });
  sfx('tear', { pos: c, gain: 0.9, pitch: 0.9 + i * 0.08 });
}
function slabContact(i, ctx) {
  const S = EARTH.slabs[i];
  if (ctx.skipped) return;
  hitStop(i === 2 ? 4 : 3); addTrauma(i === 2 ? 0.35 : 0.25);
  const p = S.hover;
  PS.smoke.emit({ count: 20, pos: p, radius: 0.3, vel: V3(0, 0.2, 0), spread: 1.5, life: [0.8, 1.8], size: [0.12, 0.25], kind: 1, param: 0.6 });
  PS.debris.emit({ count: 60, pos: p, radius: 0.35, vel: _v1.copy(S.target).sub(p).normalize().multiplyScalar(4), spread: 3, life: [1, 2], size: [0.01, 0.03], kind: 0 });
  sfx('punchRock', { pos: p, gain: 1, pitch: 1 + i * 0.05 });
}
function slabImpact(i, ctx) {
  const S = EARTH.slabs[i]; const hp = S.target; const dir = V3().copy(S.target).sub(S.hover).normalize();
  const r = new RNG(700 + i * 31);
  for (let k = 0; k < 24; k++) {
    const vel = V3().copy(dir).multiplyScalar(r.f(-1.5, 3.5)).add(V3(r.f(-3, 3), r.f(0.5, 5), r.f(-3, 3)));
    const it = EARTH.rock.spawn({ pos: V3(hp.x + r.f(-0.3, 0.3), hp.y + r.f(-0.2, 0.2), hp.z + r.f(-0.3, 0.3)), vel, scale: r.f(0.05, 0.19), variant: k });
    if (ctx.skipped) { const a = r.f(0, TAU), d = r.f(0.3, 2.4); it.p.set(hp.x + Math.cos(a) * d, 0, hp.z + Math.sin(a) * d); it.p.y = groundHeight(it.p.x, it.p.z) + it.r * 0.55; it.vel.set(0, 0, 0); it.w.set(0, 0, 0); it.sleep = 1; }
  }
  if (ctx.skipped) return;
  addTrauma(0.2); hitStop(2);
  PS.smoke.emit({ count: 70, pos: hp, radius: 0.5, vel: V3().copy(dir).multiplyScalar(-1.2).add(V3(0, 0.6, 0)), spread: 1.6, life: [2, 4], size: [0.3, 0.6], kind: 1, param: 0.7 });
  PS.debris.emit({ count: 160, pos: hp, radius: 0.4, vel: V3().copy(dir).multiplyScalar(-2).add(V3(0, 2, 0)), spread: 3.5, life: [1.2, 2.6], size: [0.012, 0.035], kind: 0 });
  sfx('rockImpact', { pos: hp, gain: 1 });
}
function eruption(ctx) {
  const ep = LAYOUT.eruptPillar; const c = V3(ep.x, groundHeight(ep.x, ep.z), ep.z);
  const r = new RNG(3030);
  for (let k = 0; k < 22; k++) {
    const a = r.f(0, TAU), sp = r.f(1.5, 4.5);
    const it = EARTH.rock.spawn({ pos: V3(c.x + Math.cos(a) * 0.6, c.y + 0.1, c.z + Math.sin(a) * 0.6), vel: V3(Math.cos(a) * sp, r.f(3, 7), Math.sin(a) * sp), scale: r.f(0.05, 0.16), variant: k });
    if (ctx.skipped) { const d = r.f(0.8, 3); it.p.set(c.x + Math.cos(a) * d, 0, c.z + Math.sin(a) * d); it.p.y = groundHeight(it.p.x, it.p.z) + it.r * 0.55; it.vel.set(0, 0, 0); it.w.set(0, 0, 0); it.sleep = 1; }
  }
  if (ctx.skipped) return;
  hitStop(5); addTrauma(0.85);
  PS.smoke.emit({ count: 70, pos: V3(c.x, c.y + 0.1, c.z), radius: 0.7, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.5, 0), spread: 4.5, life: [1.8, 3.4], size: [0.22, 0.42], kind: 1, param: 0.5 });
  PS.smoke.emit({ count: 26, pos: V3(c.x, c.y + 1.0, c.z), radius: 0.6, vel: V3(0, 3.0, 0), spread: 1.4, life: [1.4, 2.6], size: [0.22, 0.42], kind: 1, param: 0.7 });
  PS.debris.emit({ count: 320, pos: V3(c.x, c.y + 0.1, c.z), radius: 0.8, vel: V3(0, 5, 0), spread: 3, life: [1.5, 3], size: [0.012, 0.04], kind: 0 });
  sfx('erupt', { pos: c, gain: 1 });
}

// ---- per frame ------------------------------------------------------------------------------------
const _eq = new THREE.Quaternion(), _ee = new THREE.Euler();
function updateEarth(T, dt) {
  const t = EARTH.t;
  // crack network races out from the stomp and stays
  const ck = T >= t.stomp ? Ease.outCubic(clamp((T - t.stomp) / 0.32)) : 0;
  if (ck > 0) TERRAIN_U.uCrack.value.set(EARTH.stompAt.x, EARTH.stompAt.z, EARTH.crackR * ck, 1);
  else TERRAIN_U.uCrack.value.set(0, 0, 0, 0);
  // stomp shockwave: ground-hugging refraction ring + particle push
  const st = T - t.stomp;
  if (st > 0 && st < 0.7) {
    const R = st * 11;
    FIELD.shock.set(EARTH.stompAt.x, EARTH.stompAt.y + 0.1, EARTH.stompAt.z, R); FIELD.shock2.set(0.6, 14 * (1 - st / 0.7), 0, 0);
    distortSprite(_v1.set(EARTH.stompAt.x, EARTH.stompAt.y + 0.2, EARTH.stompAt.z), R + 0.5, 0.05 * (1 - st / 0.7), 1, R / (R + 0.5), 0.3);
  } else if (st >= 0.7 && st < 0.75) FIELD.shock2.y = 0;
  // slabs
  EARTH.slabs.forEach((S, i) => {
    const m = S.mesh; const d = S.def;
    if (T < S.tear || T >= S.hit) {
      m.visible = false;
      TERRAIN_U.uPits.value[i].set(S.home.x, S.home.z, 0.6, T >= S.tear ? 1 : 0);
      return;
    }
    m.visible = true;
    TERRAIN_U.uPits.value[i].set(S.home.x, S.home.z, 0.6, 1);
    const pos = m.position;
    const lt = T - S.tear;
    if (T < S.launch) {
      // tear (fast), then a laboured rise with the palms, then hover and grind
      const tear = Ease.outBack(clamp(lt / 0.32));
      const lift = Ease.inOutSine(clamp((T - 23.6) / 1.25));
      const y0 = S.home.y - 0.1;
      pos.set(S.home.x, lerp(y0, y0 + 0.45, tear), S.home.z);
      pos.lerp(S.hover, lift);
      const bob = Math.sin(T * 2.1 + i * 2) * 0.03 * lift;
      pos.y += bob;
      const grind = (T < 24.9 ? 1 : 0.35) * clamp(lt / 0.3);
      _ee.set(d.rot * 0.15 * tear + Math.sin(T * 17 + i) * 0.012 * grind, d.rot + Math.sin(T * 0.7 + i) * 0.06, Math.sin(T * 1.3 + i * 3) * 0.08 * lift + Math.sin(T * 23 + i * 5) * 0.01 * grind);
      m.quaternion.setFromEuler(_ee);
      // grit trickles off the hovering underside
      if (dt > 0 && lt > 0.25) {
        PS.debris.emit({ count: rate(14, dt), scale: 1, pos: _v1.set(pos.x, pos.y - 0.18, pos.z), radius: 0.35, vel: V3(0, -0.2, 0), spread: 0.2, life: [0.8, 1.4], size: [0.006, 0.014], kind: 0 });
        if (Math.random() < dt * 3) PS.smoke.emit({ count: 1, scale: 1, pos: _v1.set(pos.x, pos.y - 0.2, pos.z), radius: 0.3, vel: V3(0, -0.15, 0), spread: 0.1, life: [1.2, 2.2], size: [0.1, 0.2], kind: 1, param: 0.4 });
      }
    } else {
      // launched: fast, flat arc, tumbling about the flight axis
      const u = clamp((T - S.launch) / (S.hit - S.launch));
      pos.copy(S.hover).lerp(S.target, u); pos.y += Math.sin(u * Math.PI) * 0.25;
      const dir = _v2.copy(S.target).sub(S.hover).normalize();
      _eq.setFromAxisAngle(dir, (T - S.launch) * 14);
      _ee.set(d.rot * 0.15, d.rot, 0); m.quaternion.setFromEuler(_ee).premultiply(_eq);
      if (dt > 0) PS.smoke.emit({ count: rate(40, dt), scale: 1, pos, radius: 0.35, vel: V3(0, 0, 0), spread: 0.4, life: [0.8, 1.6], size: [0.12, 0.22], kind: 1, param: 0.5 });
      distortSprite(pos, 0.8, 0.02, 0, 0, 0);
    }
  });
  // the erupting column
  const P = EARTH.pillar, ep = LAYOUT.eruptPillar, g0 = groundHeight(ep.x, ep.z);
  if (T >= t.rise - 0.02) {
    const k = Ease.outExpo(clamp((T - t.rise) / 0.42));
    P.visible = true;
    const shake = T - t.rise < 0.6 ? Math.sin(T * 90) * 0.02 * (1 - (T - t.rise) / 0.6) : 0;
    P.position.set(ep.x + shake, g0 - EARTH.pillarH - 0.1 + (EARTH.pillarH - 0.15) * k, ep.z);
    if (dt > 0 && T - t.rise < 0.5) {
      PS.debris.emit({ count: rate(260, dt), scale: 1, pos: _v1.set(ep.x, g0 + 0.05, ep.z), radius: 0.7, vel: V3(0, 2.5, 0), spread: 1.5, life: [0.8, 1.8], size: [0.01, 0.03], kind: 0 });
      PS.smoke.emit({ count: rate(40, dt), scale: 1, pos: _v1.set(ep.x, g0 + 0.1, ep.z), radius: 0.7, vel: V3(0, 1.2, 0), spread: 1.0, life: [1.2, 2.4], size: [0.18, 0.34], kind: 1, param: 0.5 });
      // grit sliding off the rising top
      PS.debris.emit({ count: rate(60, dt), scale: 1, pos: _v1.set(ep.x, P.position.y + EARTH.pillarH, ep.z), radius: 0.4, vel: V3(0, 1.5, 0), spread: 1.4, life: [1, 2], size: [0.01, 0.03], kind: 0 });
    }
  } else P.visible = false;
}

fxModule({
  init() {
    initEarth();
    const t = EARTH.t;
    at(t.stomp, (ctx) => stompBurst(ctx), 'stomp');
    at(22.2, () => sfx('knee', { gain: 0.5 }), 'knee');
    t.tear.forEach((tt, i) => at(tt, (ctx) => slabTear(i, ctx), 'tear ' + i));
    EARTH.slabs.forEach((S, i) => {
      at(S.launch, (ctx) => slabContact(i, ctx), 'contact ' + i);
      atState(S.hit, (ctx) => slabImpact(i, ctx), 'impact ' + i);
    });
    atState(t.rise, (ctx) => eruption(ctx), 'erupt');
    warp(t.stomp + 0.02, t.stomp + 0.34, 0.45, 0.06);        // the shock rolls out slightly slowed
    warp(t.rise + 0.02, t.rise + 0.55, 0.4, 0.08);
  },
  reset() { EARTH.shockT = -1; TERRAIN_U.uCrack.value.set(0, 0, 0, 0); for (const v of TERRAIN_U.uPits.value) v.set(0, 0, 0, 0); },
  update(T, dt) { updateEarth(T, dt); },
});
