// §21 FREE PLAY — pick an element, tap to cast it at a point on the summit, drag to steer it.
// The figure turns to the target and strikes with the element's form; the effects reuse each
// element's systems (screen-space water, stone and rubble, fire, wind fields).
const FREE = { el: null, yaw: 0, yawTarget: 0, strikeT: 9, strikeSide: 0, base: null, strike: null, prevT: 0, casts: [], drag: null, spikes: [], savedT: 0 };
const FREE_ORIGIN = [0, 0.05];

function freePoses(el, yaw) {
  const st = (o) => Object.assign({ o: FREE_ORIGIN, yaw }, o);
  if (el === 'water') return {
    base: arms(pose({ stance: st({ L: [0.15, 0.3], R: [-0.16, -0.24], h: 0.84, toeR: 30, knee: 0.35 }), spine: [2, 6, 0], shapeL: 'cup', shapeR: 'open', face: [0.1, 0, 0.2, 0.1, 0] }),
      { arm: [48, -58, -72], elbow: [62, -70], hand: [-12, 0, 0] }, { arm: [72, -34, 8], elbow: [88, 4], hand: [4, 0, 0] }),
    strike: arms(pose({ stance: st({ L: [0.15, 0.5], R: [-0.18, -0.28], h: 0.8, toeR: 42, hipOff: [0, 0.07] }), spine: [6, -8, 0], shapeL: 'palm', shapeR: 'hook', face: [0, 0.3, 0.8, 0.5, 0.2] }),
      { arm: [86, -2, -8], elbow: [12, -8], hand: [-66, 0, 0] }, { arm: [-40, 6, 22], elbow: [8, 0], hand: [80, 0, 0] }),
  };
  if (el === 'earth') return {
    base: arms(pose({ stance: st({ L: [0.44, 0], R: [-0.44, 0], h: 0.7, toeL: 22, toeR: 22, knee: 0.8 }), pelvis: [8, 0], spine: [6, 0, 0], shapeL: 'palm', shapeR: 'palm', face: [0, 0, 0.5, 0.3, 0.4] }), 'pressDown'),
    strike: arms(pose({ stance: st({ L: [0.44, 0], R: [-0.44, 0.02], h: 0.74, toeL: 22, toeR: 22, knee: 0.8 }), spine: [-4, 0, 0], chest: [-6, 0, 0], shapeL: 'claw', shapeR: 'claw', face: [0, 0.4, 1, 0.7, 0.6] }),
      { arm: [70, -10, -60], elbow: [70, -60], hand: [-30, 0, 0] }),
  };
  if (el === 'fire') return {
    base: arms(pose({ stance: st({ L: [0.16, 0.26], R: [-0.18, -0.24], h: 0.84, toeL: 6, toeR: 28, knee: 0.4 }), shapeL: 'fist', shapeR: 'fist', face: [0, 0, 0.8, 0.5, 0.5] }), 'chamber'),
    strike: pose({ stance: st({ L: [0.16, 0.34], R: [-0.18, -0.24], h: 0.82, toeL: 6, toeR: 28, knee: 0.4 }), ikL: [0.06, 0.52, 0.8, 1], poleL: [0.7, -0.5, -0.2], elbowL: [0, -40], spine: [4, -10, 0], chest: [2, -6, 0],
      armR: ARM.chamber.arm, elbowR: ARM.chamber.elbow, shapeL: 'fist', shapeR: 'fist', face: [0, 0.5, 1, 0.7, 0] }),
  };
  return {
    base: pose({ stance: st({ L: [0.2, 0.06], R: [-0.18, -0.12], h: 0.84, toeR: 20, knee: 0.35 }), spine: [2, 14, 0], chest: [0, 10, 0],
      armL: [46, 14, -45], elbowL: [30, -45], handL: [-42, 0, 0], armR: [100, -16, -35], elbowR: [88, -35], handR: [-30, 0, 0], shapeL: 'palm', shapeR: 'palm', face: [0.3, 0, 0.1, 0, 0] }),
    strike: arms(pose({ stance: st({ L: [0.18, 0.46], R: [-0.2, -0.26], h: 0.8, toeR: 32, hipOff: [0, 0.08] }), spine: [8, 0, 0], shapeL: 'palm', shapeR: 'palm', face: [0, 0.4, 0.7, 0.4, 0] }),
      { arm: [86, -8, -5], elbow: [8, -10], hand: [-72, 0, 0] }),
  };
}
function yawToward(p) { return Math.atan2(p.x - FREE_ORIGIN[0], p.z - FREE_ORIGIN[1]) / DEG; }
function enterFreePlay(el) {
  if (TL.mode === 'cinematic') FREE.savedT = TL.T;
  FREE.el = el;
  // a calm moment of the film for the light: the dusk of the first act, nothing in flight
  if (TL.mode === 'cinematic') { seekTo(6.9, 0.4); }
  TL.mode = 'free'; TL.playing = true;
  FREE.yaw = FREE.yawTarget = CHAR.pose.yaw || 0; FREE.strikeT = 9; FREE.casts.length = 0;
  const P = freePoses(el, FREE.yaw); FREE.base = P.base; FREE.strike = P.strike;
  if (CHAR.fig && CHAR.fig.playBase && CHAR.fig.useClips) CHAR.fig.playBase('stance') || CHAR.fig.playBase('idle');
}
function exitFreePlay() {
  FREE.el = null; FREE.drag = null; FREE.casts.length = 0; FIELD.vortex.w = 0;
  TL.mode = 'cinematic';
  if (CHAR.fig && CHAR.fig.clipWeight) CHAR.fig.clipWeight = 0;
  seekTo(FREE.savedT || 0, 1.2);
}
function freePlayPose(P, dt) {
  if (!FREE.el) return;
  // turn toward the latest target, then settle; strike envelope: snap out, hold, return
  let dy = FREE.yawTarget - FREE.yaw; while (dy > 180) dy -= 360; while (dy < -180) dy += 360;
  const turn = Math.abs(dy) > 0.5;
  FREE.yaw += dy * (1 - Math.exp(-dt * 7));
  if (turn || !FREE.base) { const Pp = freePoses(FREE.el, FREE.yaw); FREE.base = Pp.base; FREE.strike = Pp.strike; }
  FREE.strikeT += dt;
  const s = FREE.drag ? 1 : FREE.strikeT < 0.1 ? Ease.outCubic(FREE.strikeT / 0.1) : FREE.strikeT < 0.3 ? 1 : 1 - Ease.inOutSine(clamp((FREE.strikeT - 0.3) / 0.45));
  lerpPoseInto(FREE.base, FREE.strike, s, P);
  // gentle idle sway
  P.hip[1] += Math.sin(simTime * 1.3) * 0.006;
}

// ---- casting -------------------------------------------------------------------------------------
function freeTap(point, el = FREE.el, fromFilm = false) {
  if (!el) return;
  if (!fromFilm) { FREE.yawTarget = yawToward(point); FREE.strikeT = 0; }
  const from = (fromFilm ? FIG.palms : FIG.palms).clone();
  const now = simTime;
  if (el === 'water') FREE.casts.push({ kind: 'water', from, to: point.clone(), t0: now + 0.06, dur: 0.38 });
  else if (el === 'fire') FREE.casts.push({ kind: 'fire', p: from, v: point.clone().sub(from).normalize().multiplyScalar(19), to: point.clone(), t0: now + 0.05, life: 1.4, hit: false });
  else if (el === 'earth') FREE.casts.push({ kind: 'earth', to: point.clone(), t0: now + 0.12, scale: 1 });
  else FREE.casts.push({ kind: 'air', from, to: point.clone(), t0: now + 0.08 });
  sfx(el === 'water' ? 'whoosh' : el === 'fire' ? 'fireball' : el === 'earth' ? 'tear' : 'gust', { pos: point, gain: 0.8 });
}
function freeDragStart(p) { if (!FREE.el) return; FREE.drag = { p: p.clone(), last: p.clone(), acc: 0 }; FREE.yawTarget = yawToward(p); }
function freeDragMove(p) { if (!FREE.drag) return; FREE.drag.acc += FREE.drag.p.distanceTo(p); FREE.drag.p.copy(p); FREE.yawTarget = yawToward(p); }
function freeDragEnd() { FREE.drag = null; FIELD.vortex.w = 0; FREE.strikeT = 0.3; }

function spawnSpike(at, scale = 1) {
  let m = FREE.spikes.find((s) => !s.mesh.visible);
  if (!m) {
    if (FREE.spikes.length >= 10) m = FREE.spikes.shift(); else {
      const mesh = new THREE.Mesh(eruptGeometry(90 + FREE.spikes.length, 1.4), WORLD.stoneMat); mesh.castShadow = mesh.receiveShadow = true; world.add(mesh);
      m = { mesh };
    }
    FREE.spikes.push(m);
  }
  const g = groundHeight(at.x, at.z);
  Object.assign(m, { x: at.x, z: at.z, g, t0: simTime, s: scale, crumbled: false });
  m.mesh.scale.set(scale * 0.55, scale, scale * 0.55); m.mesh.rotation.set((Math.random() - 0.5) * 0.25, Math.random() * TAU, (Math.random() - 0.5) * 0.25);
  m.mesh.visible = true;
  PS.smoke.emit({ count: 26 * scale, pos: V3(at.x, g + 0.05, at.z), radius: 0.4 * scale, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.4, 0), spread: 2.6, life: [1.2, 2.4], size: [0.15, 0.3], kind: 1, param: 0.5 });
  PS.debris.emit({ count: 90 * scale, pos: V3(at.x, g + 0.05, at.z), radius: 0.45 * scale, vel: V3(0, 3, 0), spread: 1.8, life: [1.2, 2.2], size: [0.012, 0.03], kind: 0 });
  addTrauma(0.15 * scale);
}
const _fa = V3(), _fb = V3();
function waterArc(from, to, u, out) {
  const mid = _fa.copy(from).lerp(to, 0.5); mid.y += 0.4 + from.distanceTo(to) * 0.18;
  const a = 1 - u; return out.set(0, 0, 0).addScaledVector(from, a * a).addScaledVector(mid, 2 * a * u).addScaledVector(to, u * u);
}
function updateFree(T, dt) {
  if (TL.mode !== 'free' && !FREE.casts.length) return;
  const now = simTime;
  for (const c of FREE.casts) {
    const lt = now - c.t0; if (lt < 0) continue;
    if (c.kind === 'water') {
      const head = clamp(lt / c.dur), tail = clamp((lt - 0.22) / c.dur);
      const from = FIG.palms;
      for (let k = 0; k <= 24; k++) { const u = lerp(tail, head, k / 24); waterArc(from, c.to, u, _fb); ssfBlob(_fb, 0.075 * (0.6 + 0.4 * Math.sin(Math.PI * k / 24)), 0.2); }
      if (head >= 1 && !c.done) {
        c.done = true;
        PS.debris.emit({ count: 160, pos: c.to, radius: 0.15, vel: V3(0, 2.4, 0), spread: 2.2, life: [0.4, 1.0], size: [0.006, 0.013], kind: 1 });
        PS.smoke.emit({ count: 8, pos: c.to, radius: 0.2, vel: V3(0, 0.5, 0), spread: 0.4, life: [0.6, 1.2], size: [0.1, 0.2], kind: 2 });
        paintMark(c.to.x, c.to.z, 0.9, 1, 0, 0, 0); poolDrop(c.to.x, c.to.z, 0.3, 0.02);
        sfx('splash', { pos: c.to, gain: 0.8 });
      }
      if (tail >= 1) c.dead = true;
    } else if (c.kind === 'fire') {
      if (c.hit) { c.dead = true; continue; }
      if (dt > 0) {
        const last = c.p.clone(); c.p.addScaledVector(c.v, dt);
        const seg = c.p.distanceTo(last);
        PS.fire.emit({ count: seg * 80, pos: last, pos2: c.p, radius: 0.05, vel: _v1.copy(c.v).multiplyScalar(0.15), spread: 0.6, life: [0.18, 0.42], size: [0.05, 0.1], kind: 0, param: 0.9 });
        PS.fire.emit({ count: seg * 36, pos: last, pos2: c.p, radius: 0.03, vel: _v1.copy(c.v).multiplyScalar(0.3), spread: 0.3, life: [0.08, 0.18], size: [0.04, 0.07], kind: 3 });
        PS.smoke.emit({ count: seg * 3, pos: last, pos2: c.p, radius: 0.08, vel: V3(0, 0.5, 0), spread: 0.3, life: [1.0, 2.0], size: [0.08, 0.16], kind: 0, param: 0.8 });
        if (c.p.distanceTo(c.to) < 0.4 || c.p.y < groundHeight(c.p.x, c.p.z) + 0.05 || lt > c.life) {
          c.hit = true;
          PS.fire.emit({ count: 220, pos: c.p, radius: 0.15, vel: V3(0, 1.4, 0), spread: 3.2, life: [0.3, 0.8], size: [0.1, 0.22], kind: 0, param: 1 });
          PS.fire.emit({ count: 90, pos: c.p, radius: 0.1, vel: V3(0, 1, 0), spread: 5, life: [0.4, 0.9], size: [0.004, 0.009], kind: 2 });
          PS.smoke.emit({ count: 20, pos: c.p, radius: 0.25, vel: V3(0, 0.9, 0), spread: 0.6, life: [1.8, 3.2], size: [0.2, 0.4], kind: 0, param: 1 });
          paintMark(c.p.x, c.p.z, 0.6, 0, 0.65, 0.7, 0); addTrauma(0.12);
          FIRE.flash = { p: c.p.clone(), t: TL.T }; c.flashT = now;
          sfx('fireImpact', { pos: c.p, gain: 0.9 });
        }
      }
      glow(c.p, 0.09, 14, 9, 4, 0.3);
    } else if (c.kind === 'earth') {
      if (!c.done) { c.done = true; spawnSpike(c.to, 1); sfx('erupt', { pos: c.to, gain: 0.6 }); }
      c.dead = true;
    } else if (c.kind === 'air') {
      const k = clamp(lt / 0.9);
      if (!c.done) {
        c.done = true;
        PS.smoke.emit({ count: 40, pos: c.to, radius: 0.3, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.3, 0), spread: 5, life: [0.8, 1.6], size: [0.15, 0.3], kind: 1, param: 0.3 });
        PS.debris.emit({ count: 120, pos: c.from, pos2: c.to, radius: 0.3, vel: _v1.copy(c.to).sub(c.from).normalize().multiplyScalar(9), spread: 1.2, life: [0.5, 1.0], size: [0.04, 0.07], kind: 4, param: 0.8 });
        FIELD.shock.set(c.to.x, c.to.y, c.to.z, 0); FIELD.shock2.set(0.6, 12, 0, 0); c.shock = true;
        sfx('gust', { pos: c.to, gain: 0.9 });
      }
      if (c.shock) { FIELD.shock.w = k * 5; FIELD.shock2.y = 12 * (1 - k); }
      distortSprite(_v1.copy(c.to).add(_v2.set(0, 0.6, 0)), 0.6 + k * 4, 0.05 * (1 - k), 1, 0.8, 0.25);
      if (k >= 1) { c.dead = true; FIELD.shock2.y = 0; }
    }
  }
  FREE.casts = FREE.casts.filter((c) => !c.dead);
  // stone spikes: stand for a while, then crumble into rubble
  for (const m of FREE.spikes) {
    if (!m.mesh.visible) continue;
    const lt = now - m.t0;
    const rise = Ease.outBack(clamp(lt / 0.22));
    const sink = smoothstep(2.6, 3.4, lt);
    m.mesh.position.set(m.x, m.g - 1.4 * m.s + 1.3 * m.s * rise - 1.5 * m.s * sink, m.z);
    if (lt > 2.6 && !m.crumbled) {
      m.crumbled = true;
      for (let k = 0; k < 7; k++) EARTH.rock.spawn({ pos: V3(m.x + (Math.random() - 0.5) * 0.4, m.g + 0.4 * m.s + Math.random() * 0.6 * m.s, m.z + (Math.random() - 0.5) * 0.4), vel: V3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2), scale: 0.05 + Math.random() * 0.08 * m.s, life: 7 });
      PS.smoke.emit({ count: 14, pos: V3(m.x, m.g + 0.3, m.z), radius: 0.3, vel: V3(0, 0.3, 0), spread: 0.8, life: [1.2, 2.2], size: [0.15, 0.3], kind: 1, param: 0.5 });
    }
    if (lt > 3.5) m.mesh.visible = false;
  }
  // steering
  const D = FREE.drag;
  if (D && TL.mode === 'free') {
    const from = FIG.palms, to = D.p;
    if (FREE.el === 'water') {
      for (let k = 0; k <= 30; k++) { const u = k / 30; waterArc(from, to, u, _fb); ssfBlob(_fb, 0.07 + 0.015 * Math.sin(u * 24 - now * 14), 0.25); }
      if (dt > 0) { PS.debris.emit({ count: 90 * dt, pos: to, radius: 0.15, vel: V3(0, 1.8, 0), spread: 1.8, life: [0.4, 0.9], size: [0.006, 0.012], kind: 1 }); if (Math.random() < dt * 10) paintMark(to.x, to.z, 0.7, 1, 0, 0, 0); poolDrop(to.x, to.z, 0.2, 0.004); }
    } else if (FREE.el === 'fire' && dt > 0) {
      const d = _v3.copy(to).sub(from).normalize();
      PS.fire.emit({ count: 2400 * dt, pos: from, radius: 0.08, vel: _v1.copy(d).multiplyScalar(13), spread: 1.5, life: [0.4, 0.8], size: [0.08, 0.18], kind: 0, param: 1 });
      PS.fire.emit({ count: 500 * dt, pos: from, radius: 0.05, vel: _v1.copy(d).multiplyScalar(16), spread: 0.7, life: [0.16, 0.3], size: [0.05, 0.1], kind: 3 });
      PS.smoke.emit({ count: 30 * dt, pos: to, radius: 0.6, vel: V3(0, 1.4, 0), spread: 0.8, life: [1.5, 3], size: [0.3, 0.6], kind: 0, param: 1 });
      if (Math.random() < dt * 20) paintMark(to.x, to.z, 0.5, 0, 0.5, 0.5, 0);
    } else if (FREE.el === 'earth' && D.acc > 0.45) { D.acc = 0; spawnSpike(to, 0.55); }
    else if (FREE.el === 'air') {
      FIELD.vortex.set(to.x, to.z, 1.4, 1); FIELD.vortex2.set(7, 1.2, 2.5, 4); FIELD.vortexY = groundHeight(to.x, to.z);
      if (dt > 0) {
        PS.debris.emit({ count: 140 * dt, pos: V3(to.x, FIELD.vortexY + 0.2, to.z), radius: 1.3, vel: V3(0, 0.5, 0), spread: 0.5, life: [0.8, 1.6], size: [0.05, 0.08], kind: 4, param: 0.7 });
        PS.smoke.emit({ count: 20 * dt, pos: V3(to.x, FIELD.vortexY + 0.1, to.z), radius: 1.2, vel: V3(0, 0.3, 0), spread: 0.6, life: [1.2, 2.2], size: [0.2, 0.35], kind: 1, param: 0.3 });
      }
      distortSprite(_v1.set(to.x, FIELD.vortexY + 1.0, to.z), 1.5, 0.03, 2, 0, 0);
    }
  }
}
fxModule({
  update(T, dt) { updateFree(T, dt); },
  reset() { for (const m of FREE.spikes) m.mesh.visible = false; },
  lights() {
    for (const c of FREE.casts) if (c.kind === 'fire' && !c.hit) requestLight(c.p, FIRE_COL, 2.2, 4, 12);
    if (FREE.drag && FREE.el === 'fire') requestLight(_v1.copy(FIG.palms).lerp(FREE.drag.p, 0.4), FIRE_COL, 8, 6, 16);
  },
});
