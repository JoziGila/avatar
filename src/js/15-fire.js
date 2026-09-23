// §15 FIRE — flames kindled in the fists, jabs that throw fireballs with white-hot cores, kicks
// that leave arcs of flame and heat haze, the sustained double-palm torrent that lights the
// summit, then the abrupt cut to drifting embers and smoking scorch.
const FIRE = {
  t: { ignite: 35.3, jabs: [36.27, 36.62, 36.97, 37.32, 37.67], kick1: [38.28, 38.74], kick2: [39.16, 39.62], swell: 40.9, torrent: 42.05, cut: 44.05, end: 47 },
  balls: [], arc: [], scorch: [], heat: 0, torrentLight: 0, flicker: 0,
};
const FIRE_COL = new THREE.Color(1.0, 0.46, 0.14);
function fireDir(out, pitch = 0) {
  const yaw = (CHAR.pose.yaw || 0) * DEG;
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}

// ---- fireballs --------------------------------------------------------------------------------------
function launchFireball(i, ctx) {
  const side = i % 2 === 0 ? 'L' : 'R';
  const from = FIG['palm_' + side].clone();
  const d = fireDir(V3(), -0.02);
  // aim loosely at the pillar on the left edge; alternate shots flare a little wide
  const P4 = LAYOUT.pillars[3]; const to = V3(P4.x, 1.35 + (i % 3) * 0.12, P4.z);
  const aim = to.sub(from).normalize();
  d.lerp(aim, 0.75).normalize();
  const spread = [0, 0.07, -0.05, 0.1, -0.02][i];
  d.applyAxisAngle(_v1.set(0, 1, 0), spread);
  FIRE.balls.push({ p: from, v: d.multiplyScalar(19), age: 0, life: 1.1, hit: false, last: from.clone(), i });
  if (!ctx.skipped) {
    PS.fire.emit({ count: 60, pos: from, radius: 0.08, vel: _v2.copy(d).multiplyScalar(0.3), spread: 2.2, life: [0.15, 0.35], size: [0.05, 0.1], kind: 3 });
    PS.fire.emit({ count: 26, pos: from, radius: 0.05, vel: _v2.copy(d).multiplyScalar(0.4), spread: 4, life: [0.3, 0.7], size: [0.004, 0.008], kind: 2 });
    addTrauma(0.12); hitStop(2);
    sfx('fireball', { pos: from, gain: 0.9, pitch: 0.95 + i * 0.04 });
  }
}
function updateFireballs(T, dt) {
  const P4 = LAYOUT.pillars[3];
  for (const b of FIRE.balls) {
    if (b.hit || b.age > b.life) continue;
    if (dt > 0) {
      b.last.copy(b.p); b.age += dt; b.p.addScaledVector(b.v, dt); b.v.y -= 0.6 * dt;
      const seg = b.p.distanceTo(b.last);
      const grow = 1 + b.age * 0.8;
      PS.fire.emit({ count: seg * 80, pos: b.last, pos2: b.p, radius: 0.05 * grow, vel: _v1.copy(b.v).multiplyScalar(0.15), spread: 0.6, life: [0.18, 0.42], size: [0.05 * grow, 0.1 * grow], kind: 0, param: 0.9 });
      PS.fire.emit({ count: seg * 36, pos: b.last, pos2: b.p, radius: 0.03, vel: _v1.copy(b.v).multiplyScalar(0.3), spread: 0.3, life: [0.08, 0.18], size: [0.04, 0.07], kind: 3 });
      PS.smoke.emit({ count: seg * 3, pos: b.last, pos2: b.p, radius: 0.08 * grow, vel: V3(0, 0.5, 0), spread: 0.3, life: [1.0, 2.0], size: [0.08, 0.16], kind: 0, param: 0.8 });
      PS.fire.emit({ count: seg * 4, pos: b.p, radius: 0.1, vel: _v1.copy(b.v).multiplyScalar(0.3), spread: 1.5, life: [1.0, 2.2], size: [0.004, 0.008], kind: 1, param: 0.6 });
      // strike the pillar
      const dx = b.p.x - P4.x, dz = b.p.z - P4.z;
      if (Math.hypot(dx, dz) < P4.r + 0.12 && b.p.y < P4.h) { b.hit = true; fireballImpact(b, T); }
      if (b.p.y < groundHeight(b.p.x, b.p.z) + 0.05) { b.hit = true; fireballImpact(b, T); }
    }
    const fade = 1 - smoothstep(b.life - 0.25, b.life, b.age);
    glow(b.p, 0.09, 14 * fade, 9 * fade, 4 * fade, 0.3);
    distortSprite(b.p, 0.45, 0.035 * fade, 0, 0, 0);
  }
}
function fireballImpact(b, T) {
  const n = V3(b.p.x - LAYOUT.pillars[3].x, 0, b.p.z - LAYOUT.pillars[3].z).normalize();
  PS.fire.emit({ count: 220, pos: b.p, radius: 0.15, vel: _v1.copy(n).multiplyScalar(1.5).add(V3(0, 1.2, 0)), spread: 3.2, life: [0.3, 0.8], size: [0.1, 0.22], kind: 0, param: 1 });
  PS.fire.emit({ count: 90, pos: b.p, radius: 0.1, vel: _v1.copy(n).multiplyScalar(3), spread: 5, life: [0.4, 0.9], size: [0.004, 0.009], kind: 2 });
  PS.fire.emit({ count: 40, pos: b.p, radius: 0.2, vel: V3(0, 0.6, 0), spread: 1.5, life: [1.5, 3], size: [0.005, 0.009], kind: 1, param: 0.8 });
  PS.smoke.emit({ count: 22, pos: b.p, radius: 0.25, vel: V3(0, 0.9, 0), spread: 0.6, life: [1.8, 3.2], size: [0.2, 0.4], kind: 0, param: 1 });
  const g = V3(b.p.x + n.x * 0.5, 0, b.p.z + n.z * 0.5);
  paintMark(g.x, g.z, 0.55, 0, 0.6, 0.6, 0);
  FIRE.scorch.push({ x: g.x, z: g.z, t: T, k: 0.6 });
  FIRE.flash = { p: b.p.clone(), t: T };
  sfx('fireImpact', { pos: b.p, gain: 0.9 });
}

// ---- per frame ----------------------------------------------------------------------------------------
function emitFist(side, T, dt, k) {
  const p = FIG['palm_' + side], v = FIG.v['hand_' + side];
  const n = 260 * k * dt;
  PS.fire.emit({ count: n, pos: p, radius: 0.03 * (0.7 + 0.5 * k), vel: _v1.copy(v).multiplyScalar(0.45).add(_v2.set(0, 0.3, 0)), spread: 0.25, life: [0.22, 0.45], size: [0.018 * (0.7 + 0.6 * k), 0.042 * (0.7 + 0.6 * k)], kind: 0, param: 0.75 });
  PS.fire.emit({ count: 50 * k * dt, pos: p, radius: 0.03, vel: _v1.copy(v).multiplyScalar(0.3), spread: 0.2, life: [0.1, 0.2], size: [0.025, 0.04], kind: 3 });
  if (Math.random() < dt * 6 * k) PS.fire.emit({ count: 1, scale: 1, pos: p, radius: 0.04, vel: _v1.set(0, 0.8, 0), spread: 0.8, life: [1.0, 2.2], size: [0.003, 0.006], kind: 1, param: 0.6 });
  if (Math.random() < dt * 5 * k) PS.smoke.emit({ count: 1, scale: 1, pos: _v1.copy(p).add(_v2.set(0, 0.25, 0)), radius: 0.05, vel: _v2.set(0, 0.7, 0), spread: 0.2, life: [1.0, 2.0], size: [0.06, 0.12], kind: 0, param: 0.9 });
}
function updateFire(T, dt) {
  const t = FIRE.t;
  FIRE.flicker = 0.85 + 0.15 * Math.sin(T * 31) * Math.sin(T * 17.3 + 1);
  // fists: kindle on the sharp exhale, swell in the gather, hand over to the torrent
  const pre = win(T, t.ignite - 0.3, t.ignite - 0.02, 0.05, 0.02);
  const fist = smoothstep(t.ignite - 0.02, t.ignite + 0.12, T) * (1 - smoothstep(t.torrent - 0.08, t.torrent, T));
  const swell = 1 + 0.8 * smoothstep(t.swell, t.torrent - 0.1, T);
  FIRE.fist = fist * swell;
  if (dt > 0) {
    if (pre > 0 && Math.random() < dt * 20) for (const s of ['L', 'R']) PS.fire.emit({ count: 2, scale: 1, pos: FIG['palm_' + s], radius: 0.03, vel: V3(0, 0.3, 0), spread: 1.2, life: [0.2, 0.4], size: [0.002, 0.004], kind: 2 });
    if (fist > 0.01) { emitFist('L', T, dt, fist * swell); emitFist('R', T, dt, fist * swell); }
  }
  if (fist > 0.01) for (const s of ['L', 'R']) glow(FIG['palm_' + s], 0.035 * swell, 4 * fist * FIRE.flicker, 2.2 * fist * FIRE.flicker, 0.7 * fist, 0.5);
  updateFireballs(T, dt);
  // kick arcs: flames stream off the foot while it travels
  const inK1 = T >= t.kick1[0] && T <= t.kick1[1], inK2 = T >= t.kick2[0] && T <= t.kick2[1];
  if ((inK1 || inK2) && dt > 0) {
    const toe = FIG.p.toe_R, v = FIG.v.toe_R; const sp = v.length();
    const hip = FIG.p.hips; const out = _v3.copy(toe).sub(hip).normalize();
    const n = sp * dt * 150;
    PS.fire.emit({ count: n, pos: toe, pos2: FIG.prev.toe_R, radius: 0.06, vel: _v1.copy(v).multiplyScalar(0.22).addScaledVector(out, 1.2), spread: 0.5, life: [0.45, 0.85], size: [0.07, 0.13], kind: 0, param: 0.95 });
    PS.fire.emit({ count: n * 0.25, pos: toe, pos2: FIG.prev.toe_R, radius: 0.03, vel: _v1.copy(v).multiplyScalar(0.1), spread: 0.3, life: [0.12, 0.25], size: [0.05, 0.08], kind: 3 });
    PS.fire.emit({ count: n * 0.08, pos: toe, radius: 0.05, vel: _v1.copy(v).multiplyScalar(0.5), spread: 2.5, life: [0.4, 0.8], size: [0.004, 0.008], kind: 2 });
    FIRE.arc.push({ p: toe.clone(), t: T });
  }
  FIRE.arc = FIRE.arc.filter((a) => T - a.t < 0.7 && T >= a.t);
  for (let i = 0; i < FIRE.arc.length; i += 2) { const a = FIRE.arc[i]; const k = 1 - (T - a.t) / 0.7; distortSprite(a.p, 0.35 + (T - a.t) * 0.6, 0.05 * k, 0, 0, 0); }
  // torrent
  const tor = T >= t.torrent && T < t.cut ? Math.min(1, (T - t.torrent) / 0.08) : 0;
  FIRE.torrent = tor;
  if (tor > 0) {
    const d = fireDir(_v4, -0.13); const p = FIG.palms;
    const side = _v3.set(d.z, 0, -d.x).normalize();
    if (dt > 0) {
      PS.fire.emit({ count: 3200 * dt * tor, pos: p, radius: 0.1, vel: _v1.copy(d).multiplyScalar(14.5), spread: 1.7, life: [0.45, 0.85], size: [0.09, 0.2], kind: 0, param: 1 });
      PS.fire.emit({ count: 700 * dt * tor, pos: p, radius: 0.06, vel: _v1.copy(d).multiplyScalar(17), spread: 0.8, life: [0.18, 0.34], size: [0.06, 0.11], kind: 3 });
      PS.fire.emit({ count: 170 * dt, pos: p, radius: 0.1, vel: _v1.copy(d).multiplyScalar(13), spread: 4, life: [0.5, 1.1], size: [0.004, 0.009], kind: 2 });
      PS.fire.emit({ count: 70 * dt, pos: _v2.copy(p).addScaledVector(d, 4), radius: 1.2, vel: _v1.copy(d).multiplyScalar(3).add(V3(0, 1, 0)), spread: 2, life: [1.5, 3], size: [0.004, 0.008], kind: 1, param: 0.9 });
      PS.smoke.emit({ count: 55 * dt, pos: _v2.copy(p).addScaledVector(d, 6), radius: 1.2, vel: _v1.copy(d).multiplyScalar(2).add(V3(0, 1.5, 0)), spread: 1, life: [2, 3.5], size: [0.35, 0.7], kind: 0, param: 1 });
      // the ground under the stream scorches and glows
      if (Math.random() < dt * 30) { const k = 2.5 + Math.random() * 5; const g = _v2.copy(p).addScaledVector(d, k).addScaledVector(side, (Math.random() - 0.5) * 1.2); paintMark(g.x, g.z, 0.35 + k * 0.06, 0, 0.55, 0.55, 0); }
      if (Math.random() < dt * 4) { const k = 3 + Math.random() * 4; const g = _v2.copy(p).addScaledVector(d, k); FIRE.scorch.push({ x: g.x, z: g.z, t: T, k: 1 }); }
    }
    for (let k = 0; k < 4; k++) distortSprite(_v2.copy(p).addScaledVector(d, 1.2 + k * 1.6).add(_v1.set(0, 0.35, 0)), 0.8 + k * 0.4, 0.05, 0, 0, 0);
    glow(_v2.copy(p).addScaledVector(d, 0.25), 0.14, 12 * tor, 8 * tor, 3.5 * tor, 0.35);
  }
  // after the cut: embers drift, scorch marks smoke
  if (T >= t.cut && T < t.end && dt > 0) {
    for (const s of FIRE.scorch) if (Math.random() < dt * 1.2 * s.k) PS.smoke.emit({ count: 1, scale: 1, pos: _v1.set(s.x, groundHeight(s.x, s.z) + 0.05, s.z), radius: 0.25, vel: V3(0, 0.45, 0), spread: 0.15, life: [2.5, 4.5], size: [0.12, 0.26], kind: 0, param: 0.15 });
  }
  // global warmth while the torrent burns
  FX_STATE.warm = Math.max(FX_STATE.warm, tor * 0.9, fist * 0.25);
}

fxModule({
  init() {
    const t = FIRE.t;
    at(t.ignite, (ctx) => {
      if (ctx.skipped) return;
      for (const s of ['L', 'R']) PS.fire.emit({ count: 90, pos: FIG['palm_' + s], radius: 0.05, vel: V3(0, 0.6, 0), spread: 1.6, life: [0.2, 0.5], size: [0.04, 0.09], kind: 0, param: 1 });
      addTrauma(0.1); sfx('ignite', { pos: FIG.palms, gain: 1 });
    }, 'ignite');
    t.jabs.forEach((tt, i) => at(tt, (ctx) => launchFireball(i, ctx), 'jab ' + i));
    at(t.kick1[0] + 0.05, () => sfx('fireWhoosh', { pos: FIG.p.foot_R, gain: 0.9, pitch: 1.1 }), 'kick1');
    at(t.kick2[0] + 0.05, () => sfx('fireWhoosh', { pos: FIG.p.foot_R, gain: 1, pitch: 0.85 }), 'kick2');
    at(t.torrent, (ctx) => { addTrauma(0.35); sfx('torrent', { pos: FIG.palms, gain: 1, dur: t.cut - t.torrent }); }, 'torrent');
    atState(t.cut, (ctx) => {
      // the abrupt cut: every live flame is gone, only embers remain
      PS.fire.clear();
      const d = fireDir(V3(), 0); const p = FIG.palms.clone();
      PS.fire.emit({ count: 360, pos: p.addScaledVector(d, 3.5), radius: 2.6, vel: V3(0, 0.4, 0), spread: 0.8, life: [2.5, 5], size: [0.004, 0.009], kind: 1, param: 0.7 });
      FIRE.torrent = 0;
    }, 'cut');
    warp(t.kick2[0] + 0.12, t.kick2[1] - 0.05, 0.5, 0.06);   // the heel kick's arc hangs for a beat
  },
  reset() { FIRE.balls.length = 0; FIRE.arc.length = 0; FIRE.scorch.length = 0; FIRE.flash = null; FIRE.torrent = 0; FIRE.fist = 0; },
  update(T, dt) { FX_STATE.warm = 0; updateFire(T, dt); },
  lights() {
    const T = TL.T, t = FIRE.t;
    if (FIRE.fist > 0.01) for (const s of ['L', 'R']) requestLight(FIG['palm_' + s], FIRE_COL, 0.55 * FIRE.fist * FIRE.flicker, 3, 8);
    for (const b of FIRE.balls) if (!b.hit && b.age < b.life) requestLight(b.p, FIRE_COL, 2.2 * (1 - smoothstep(b.life - 0.25, b.life, b.age)), 4, 12);
    if (FIRE.flash && T - FIRE.flash.t < 0.35 && T >= FIRE.flash.t) requestLight(FIRE.flash.p, FIRE_COL, 5 * (1 - (T - FIRE.flash.t) / 0.35), 5, 12);
    if (FIRE.torrent > 0) {
      const d = fireDir(_v4, -0.13);
      for (const [k, I] of [[0.6, 4], [3.2, 9], [6.2, 7]]) requestLight(_v1.copy(FIG.palms).addScaledVector(d, k), FIRE_COL, I * FIRE.torrent * FIRE.flicker, 8, 16);
    }
    // cooling scorch glow
    if (T >= t.cut && T < t.cut + 3) requestLight(_v1.copy(FIG.palms).addScaledVector(fireDir(_v2, 0), 4.5).setY(0.3), FIRE_COL, 1.2 * (1 - (T - t.cut) / 3), 2, 8);
  },
});
