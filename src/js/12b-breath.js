// §12b BREATH — the stillness of Act I and the closing kneel: breath condensing in the cold air on
// every exhale, and the press of the palms that makes the pebbles tremble and the pool shiver.
const BREATH = { t: { press: 6.5 }, prev: 0 };
function mouthPoint(out) {
  const h = FIG.p.head, n = FIG.p.upperChest;
  // a little in front of and below the head centre, along the body's facing
  return out.copy(h).addScaledVector(FIG.fwd, 0.1).add(_v2.set(0, -0.06, 0)).lerp(n, 0.05);
}
function pressBurst(ctx) {
  if (ctx.skipped) return;
  const c = V3(FIG.p.hips.x, 0, FIG.p.hips.z); c.y = groundHeight(c.x, c.z);
  // pebbles hop in place — a tremor, not an explosion
  PS.debris.emit({ count: 140, pos: V3(c.x, c.y + 0.02, c.z), radius: 1.6, vel: V3(0, 0.9, 0), spread: 0.35, life: [0.9, 1.6], size: [0.008, 0.02], kind: 0 });
  PS.smoke.emit({ count: 26, pos: V3(c.x, c.y + 0.04, c.z), radius: 0.3, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.05, 0), spread: 1.6, life: [1.6, 2.8], size: [0.1, 0.2], kind: 1, param: 0.2 });
  BREATH.ring = TL.T;
  // the pool answers with one concentric shiver
  const P = LAYOUT.pool; for (let k = 0; k < 6; k++) poolDrop(P.x + Math.cos(k) * 0.4, P.z + Math.sin(k) * 0.3, 0.2, 0.0025);
  sfx('press', { gain: 0.6 });
}
fxModule({
  init() { at(BREATH.t.press, (ctx) => pressBurst(ctx), 'press'); },
  reset() { BREATH.ring = -9; BREATH.prev = 0; },
  update(T, dt) {
    if (TL.mode !== 'cinematic') return;
    // condensation on the out-breath while the air is cold and still (Act I and the final kneel)
    const b = CHAR.canon.breath, db = dt > 0 ? (b - BREATH.prev) / dt : 0; BREATH.prev = b;
    const still = (T < 7.2 ? 1 : 0) + smoothstep(67.8, 68.8, T);
    if (dt > 0 && still > 0 && db < -0.15) {
      const m = mouthPoint(_v1);
      PS.smoke.emit({ count: 26 * dt * Math.min(1, -db), scale: 1, pos: m, radius: 0.015, vel: _v3.copy(FIG.fwd).multiplyScalar(0.28).add(_v4.set(0, -0.05, 0)), spread: 0.08, life: [0.9, 1.6], size: [0.025, 0.05], kind: 3, param: 0 });
    }
    // the press: a low pressure ring rolls out across the stone
    const st = T - BREATH.ring;
    if (st > 0 && st < 0.9) {
      const R = st * 6, c = FIG.p.hips;
      distortSprite(_v1.set(c.x, groundHeight(c.x, c.z) + 0.12, c.z), R + 0.4, 0.03 * (1 - st / 0.9), 1, R / (R + 0.4), 0.1);
    }
  },
});
