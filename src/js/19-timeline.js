// §19 TIMELINE SEQUENCER ------------------------------------------------------------------
// Master clock T in [0, 70). Real time advances T through a time-warp (slow motion
// segments, hit-stop freezes). Events fire as T crosses them; continuous tracks are
// pure functions of T. Seeking resets transient systems and pre-rolls the last few
// seconds at a coarse step so particles, cloth and rubble are where they should be.
const ACTS = [
  { id: 'breath', num: 'I', name: 'Breath', t0: 0, t1: 7, el: null, color: '#e6dfd2' },
  { id: 'water', num: 'II', name: 'Water', t0: 7, t1: 20, el: 'water', color: '#8ccbe9' },
  { id: 'earth', num: 'III', name: 'Earth', t0: 20, t1: 33, el: 'earth', color: '#cfa66a' },
  { id: 'fire', num: 'IV', name: 'Fire', t0: 33, t1: 47, el: 'fire', color: '#ff8a3a' },
  { id: 'air', num: 'V', name: 'Air', t0: 47, t1: 58, el: 'air', color: '#d3dbe1' },
  { id: 'unity', num: 'VI', name: 'Unity', t0: 58, t1: 70, el: null, color: '#e6dfd2' },
];
const DURATION = 70;
const TL = {
  T: 0, playing: true, hitStop: 0, live: true, events: [], warps: [], resetFns: [], mode: 'cinematic',
  shake: 0, trauma: 0, actIndex: 0, loopCount: 0,
};
function actAt(T) { for (let i = ACTS.length - 1; i >= 0; i--) if (T >= ACTS[i].t0) return i; return 0; }
// event registration: fn(ctx) where ctx.live says whether audio/one-shot UI should run
// kind 'state' events also run when a seek skips past them (persistent world changes);
// 'fx' events (bursts, audio, shake) only fire while the clock actually crosses them.
function at(t, fn, tag = '', kind = 'fx') { TL.events.push({ t, fn, tag, kind }); }
function atState(t, fn, tag = '') { at(t, fn, tag, 'state'); }
function warp(a, b, rate, ramp = 0.12) { TL.warps.push({ a, b, rate, ramp }); }
function onReset(fn) { TL.resetFns.push(fn); }
function warpRate(T) {
  let r = 1;
  for (const w of TL.warps) {
    if (T < w.a - w.ramp || T > w.b + w.ramp) continue;
    const k = smoothstep(w.a - w.ramp, w.a, T) * (1 - smoothstep(w.b, w.b + w.ramp, T));
    r = Math.min(r, lerp(1, w.rate, k));
  }
  return r;
}
function hitStop(frames = 3) { if (!TL.preroll) TL.hitStop = Math.max(TL.hitStop, frames / 60); }
function addTrauma(x) { if (!TL.preroll) TL.trauma = Math.min(1, TL.trauma + x); }

function fireEvents(t0, t1, live, stateOnly = false) {
  const ctx = { live, preroll: !live, skipped: stateOnly };
  for (const e of TL.events) if (e.t > t0 && e.t <= t1 && (!stateOnly || e.kind === 'state')) { try { e.fn(ctx); } catch (err) { console.warn('event', e.tag, err); } }
}
// advance by real dt; returns simulation dt (timeline seconds)
function tlAdvance(realDt) {
  if (!TL.playing || TL.mode !== 'cinematic') return 0;
  let rate;
  if (TL.hitStop > 0) { TL.hitStop -= realDt; rate = 0.015; }
  else rate = warpRate(TL.T);
  const dT = realDt * rate;
  let t1 = TL.T + dT;
  if (t1 >= DURATION) {
    fireEvents(TL.T, DURATION, true);
    TL.loopCount++;
    resetTransient();
    TL.T = 0; t1 = dT * 0.0;
    fireEvents(-1, 0, true);
    return 0;
  }
  fireEvents(TL.T, t1, TL.live);
  TL.T = t1;
  return dT;
}
function resetTransient() {
  for (const fn of TL.resetFns) { try { fn(); } catch (e) { console.warn('reset', e); } }
}
// jump to T; pre-roll re-simulates up to `preroll` seconds so the world is consistent
function tlSeek(T, { preroll = 2.5, step = 1 / 30, stepFn = null } = {}) {
  T = clamp(T, 0, DURATION - 1e-3);
  resetTransient();
  const start = Math.max(0, T - preroll);
  TL.preroll = true;
  // persistent world changes from before the pre-roll window (cracks, raised pillar, broken slabs)
  fireEvents(-1, start, false, true);
  TL.T = start;
  while (TL.T < T - 1e-6) {
    const dt = Math.min(step, T - TL.T);
    fireEvents(TL.T, TL.T + dt, false);
    TL.T += dt;
    if (stepFn) stepFn(dt);
  }
  TL.T = T;
  TL.preroll = false; TL.hitStop = 0; TL.trauma = 0;
  POST.cut = true;
}
