// §22 UI & INPUT — control bar, scrubber with act markers, chapter slates, element free-play,
// orbit camera, character loading (file · drop · URL), quality, sound, keys, idle-hide,
// and adaptive quality that holds the frame rate by trading resolution first.
const UI = { el: {}, idle: 0, lastAct: -1, scrubbing: false, chapterT: 0, toastT: 0, pointer: null, lastMove: 0 };
const $ = (id) => document.getElementById(id);
function fmtTime(t) { const m = Math.floor(t / 60), s = t - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`; }
function toast(msg, secs = 3) { const t = UI.el.toast; t.textContent = msg; t.hidden = false; UI.toastT = secs; }
function showChapter(i) {
  const a = ACTS[i]; if (!a) return;
  UI.el.chapter.querySelector('.num').textContent = a.num;
  UI.el.chapter.querySelector('.name').textContent = a.name;
  UI.el.chapter.style.setProperty('--accent', a.color);
  UI.el.chapter.classList.add('show'); UI.chapterT = 3.2;
}

// ---- orbit camera -------------------------------------------------------------------------------
function makeOrbit() {
  const c = new OrbitControls(camera, renderer.domElement);
  c.enableDamping = true; c.dampingFactor = 0.08; c.minDistance = 1.2; c.maxDistance = 40; c.maxPolarAngle = Math.PI * 0.495;
  c.target.set(0, 1.0, 0); c.enabled = false; c.enablePan = true;
  ORBIT.controls = c;
  ORBIT.update = (dt) => {
    // keep the target near the figure when it moves (air lift), without fighting the user
    const h = CAM.anchors.hips; if (h) c.target.lerp(_v1.set(h.x, Math.max(0.9, h.y), h.z), 1 - Math.exp(-dt * 1.5));
    c.update(dt);
    camera.near = 0.06; camera.far = 9000; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    POST.grade.aperture = 0; POST.grade.focus = camera.position.distanceTo(c.target);
  };
}
function setOrbit(on) {
  ORBIT.active = on; if (ORBIT.controls) ORBIT.controls.enabled = on;
  UI.el.cam.setAttribute('aria-pressed', String(on)); document.body.classList.toggle('orbit', on);
  if (on) { POST.cut = true; const h = CAM.anchors.hips || V3(0, 1, 0); ORBIT.controls.target.set(h.x, Math.max(0.9, h.y), h.z); }
  else { CAM.first = true; CAM.shotIndex = -1; }
}

// ---- modes ----------------------------------------------------------------------------------------
function setPlaying(p) {
  TL.playing = p; UI.el.play.classList.toggle('paused', !p);
  UI.el.play.setAttribute('aria-label', p ? 'Pause' : 'Play');
}
function selectElement(el) {
  const cur = TL.mode === 'free' ? FREE.el : null;
  const next = cur === el ? null : el;
  for (const b of document.querySelectorAll('.el')) b.setAttribute('aria-pressed', String(b.dataset.el === next));
  if (next) {
    if (typeof enterFreePlay === 'function') enterFreePlay(next);
    if (!ORBIT.active) setOrbit(true);
    UI.el.hint.textContent = FREE_HINTS[next]; UI.el.hint.hidden = false;
    document.body.classList.add('freeplay');
  } else {
    if (typeof exitFreePlay === 'function') exitFreePlay();
    UI.el.hint.hidden = true; document.body.classList.remove('freeplay');
    if (ORBIT.active) setOrbit(false);
  }
}
const FREE_HINTS = {
  water: 'Water · tap to lash a stream · drag to steer it',
  earth: 'Earth · tap to raise stone · drag to rake the ground',
  fire: 'Fire · tap to throw fire · drag to pour a torrent',
  air: 'Air · tap for a gust · drag to spin a vortex',
};

// ---- quality --------------------------------------------------------------------------------------
function setQuality(name, persist = true) {
  if (!QUALITY[name]) return;
  tierName = name; const prev = Q;
  Q = { ...QUALITY[name] };
  // things that can change live; particle texture sizes and bake resolutions keep their boot values
  Q.particleTex = prev.particleTex; Q.texSize = prev.texSize;
  VIEW.dynScale = 1;
  if (LIGHTS.key.shadow.mapSize.x !== Q.shadow) { LIGHTS.key.shadow.mapSize.set(Q.shadow, Q.shadow); if (LIGHTS.key.shadow.map) { LIGHTS.key.shadow.map.dispose(); LIGHTS.key.shadow.map = null; } }
  const samples = Math.min(Q.msaa, CAPS.maxSamples);
  if (POST.sceneRT.samples !== samples) { POST.sceneRT.samples = samples; POST.sceneRT.dispose(); }
  if (Q.reflect > 0 && !POOL.reflRT) POOL.reflRT = makeRT(8, 8, { depthBuffer: true });
  applySize();
  UI.el.quality.value = name;
  if (persist) try { localStorage.setItem('stillpoint.quality', name); } catch (e) { /* private mode */ }
}
// Adaptive quality: hold ~60 fps on desktop, ~30+ on phones. Resolution goes first (cheap to
// restore), then particle density, then the expensive passes; recovery walks back up slowly.
const ADAPT = { ema: 1 / 60, cool: 2, good: 0, level: 0, target: IS_MOBILE ? 1 / 32 : 1 / 57 };
function adaptQuality(dt) {
  if (FLAGS.noAdapt || !TL || document.hidden) return;
  ADAPT.ema += (Math.min(dt, 0.25) - ADAPT.ema) * 0.05;
  ADAPT.cool -= dt; if (ADAPT.cool > 0) return;
  const slow = ADAPT.ema > ADAPT.target * 1.12, fast = ADAPT.ema < ADAPT.target * 0.8;
  if (slow) {
    ADAPT.good = 0;
    if (VIEW.dynScale > 0.62) { VIEW.dynScale = Math.max(0.6, VIEW.dynScale - 0.1); applySize(); }
    else if (VIEW_PSCALE > 0.5) VIEW_PSCALE -= 0.25;
    else if (Q.ao || Q.mblur || Q.dof) { if (Q.ao) Q.ao = false; else if (Q.mblur) Q.mblur = false; else Q.dof = false; }
    else if (Q.cloudSteps > 16) Q.cloudSteps = Math.max(16, Q.cloudSteps - 8);
    ADAPT.cool = 1.2;
  } else if (fast) {
    ADAPT.good += 1;
    if (ADAPT.good > 3) {
      if (VIEW_PSCALE < 1) VIEW_PSCALE = Math.min(1, VIEW_PSCALE + 0.25);
      else if (VIEW.dynScale < 1) { VIEW.dynScale = Math.min(1, VIEW.dynScale + 0.1); applySize(); }
      ADAPT.good = 0;
    }
    ADAPT.cool = 2.5;
  } else ADAPT.cool = 1;
}

// ---- character loading ------------------------------------------------------------------------------
function charStatus(msg) { UI.el.status.textContent = msg; }
async function loadCharacterBuffer(buf, label) {
  charStatus('Loading ' + label + '…');
  try {
    const fig = await parseGLB(buf, label);
    fig.useClips = UI.el.clips.checked;
    await setFigure(fig);
    seekTo(TL.T, 1.0);
    charStatus('Currently: ' + label + (fig.clipNames && fig.clipNames.length ? ` · clips: ${fig.clipNames.join(', ')}` : ''));
    toast('Character loaded — the choreography is retargeted onto it');
  } catch (e) {
    console.warn(e);
    charStatus('Could not use that file: ' + (e && e.message ? e.message : e));
    toast('That model could not be retargeted — ' + (e && e.message ? e.message : 'unknown error'), 5);
  }
}
async function loadCharacterURL(url) {
  try {
    const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadCharacterBuffer(await r.arrayBuffer(), url.split('/').pop().split('?')[0] || 'model.glb');
  } catch (e) { charStatus('Could not fetch that URL (' + e.message + '). The server must allow cross-origin requests.'); }
}

// ---- pointer → world --------------------------------------------------------------------------------
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
function pointerWorld(ev, out = V3()) {
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  // march the ground height field, then fall back to a plane at chest height
  const o = _ray.ray.origin, d = _ray.ray.direction;
  let t = 0.3, prevAbove = true;
  for (let i = 0; i < 160; i++) {
    const p = _v1.copy(o).addScaledVector(d, t);
    if (p.y < groundHeight(p.x, p.z)) {
      let a = t - (i ? 0.25 : 0.3), b = t;
      for (let k = 0; k < 10; k++) { const m = (a + b) / 2; const q = _v2.copy(o).addScaledVector(d, m); if (q.y < groundHeight(q.x, q.z)) b = m; else a = m; }
      return out.copy(o).addScaledVector(d, b);
    }
    t += 0.25; if (t > 40) break;
  }
  const k = d.y < -0.01 ? (1.2 - o.y) / d.y : 12;
  return out.copy(o).addScaledVector(d, Math.min(Math.max(k, 2), 30));
}

// ---- init -------------------------------------------------------------------------------------------
function initUI() {
  const E = UI.el = { bar: $('bar'), play: $('bPlay'), tc: $('tc'), scrub: $('scrubber'), acts: $('acts'), cam: $('bCam'), sound: $('bSound'), quality: $('quality'),
    char: $('bChar'), panel: $('charpanel'), chapter: $('chapter'), hint: $('hint'), toast: $('toast'), drop: $('drop'), file: $('glbFile'), url: $('glbUrl'),
    load: $('glbLoad'), reset: $('glbReset'), clips: $('useClips'), status: $('charStatus'), close: $('charClose') };
  for (const a of ACTS) {
    const d = document.createElement('div'); d.className = 'a';
    d.style.left = (a.t0 / DURATION * 100) + '%'; d.style.width = ((a.t1 - a.t0) / DURATION * 100) + '%';
    d.innerHTML = `<span>${a.num} · ${a.name}</span>`; d.title = `${a.num}. ${a.name}`; E.acts.appendChild(d);
  }
  makeOrbit();
  E.quality.value = tierName;
  charStatus('Currently: ' + (CHAR.fig && CHAR.fig.info ? CHAR.fig.info : 'procedural figure') + '.');
  document.body.classList.add('bar-on');

  E.play.addEventListener('click', () => { if (TL.mode !== 'cinematic') selectElement(FREE.el); setPlaying(!TL.playing); });
  // scrubbing: cheap preview seeks while dragging, a settled seek on release
  let pendingSeek = null, seekRaf = 0;
  const doSeek = () => { seekRaf = 0; if (pendingSeek == null) return; const t = pendingSeek; pendingSeek = null; seekTo(t, UI.scrubbing ? 0.35 : 1.5); };
  E.scrub.addEventListener('input', () => {
    UI.scrubbing = true; if (TL.mode !== 'cinematic') selectElement(FREE.el);
    pendingSeek = +E.scrub.value; if (!seekRaf) seekRaf = requestAnimationFrame(doSeek);
  });
  E.scrub.addEventListener('change', () => { UI.scrubbing = false; pendingSeek = +E.scrub.value; doSeek(); });
  for (const b of document.querySelectorAll('.el')) b.addEventListener('click', () => selectElement(b.dataset.el));
  E.cam.addEventListener('click', () => setOrbit(!ORBIT.active));
  E.sound.addEventListener('click', () => {
    const on = E.sound.getAttribute('aria-pressed') !== 'true';
    if (typeof setSound === 'function') setSound(on);
    E.sound.setAttribute('aria-pressed', String(on)); E.sound.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
  });
  E.quality.addEventListener('change', () => setQuality(E.quality.value));
  const togglePanel = (show = E.panel.hidden) => { E.panel.hidden = !show; E.char.setAttribute('aria-expanded', String(show)); };
  E.char.addEventListener('click', () => togglePanel());
  E.close.addEventListener('click', () => togglePanel(false));
  E.file.addEventListener('change', async () => { const f = E.file.files && E.file.files[0]; if (f) await loadCharacterBuffer(await f.arrayBuffer(), f.name); E.file.value = ''; });
  E.load.addEventListener('click', () => { const u = E.url.value.trim(); if (u) loadCharacterURL(u); });
  E.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); E.load.click(); } });
  E.reset.addEventListener('click', async () => { charStatus('Restoring the default figure…'); await loadDefaultFigure(); seekTo(TL.T, 1.0); charStatus('Currently: ' + (CHAR.fig.info || 'procedural figure') + '.'); });
  E.clips.addEventListener('change', () => { if (CHAR.fig) CHAR.fig.useClips = E.clips.checked; });
  // drag & drop a .glb anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; E.drop.hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', (e) => { if (!E.drop.hidden) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) E.drop.hidden = true; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; E.drop.hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.(glb|gltf)$/i.test(f.name)) await loadCharacterBuffer(await f.arrayBuffer(), f.name);
    else if (f) toast('Drop a binary glTF (.glb) character');
  });
  // pointer on the canvas: tap casts, drag steers (free play); anything wakes the bar
  const cv = renderer.domElement;
  let down = null;
  cv.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), drag: false, id: e.pointerId };
    if (TL.mode === 'free' && typeof freeDragStart === 'function' && !e.shiftKey) { /* decided on move */ }
  });
  cv.addEventListener('pointermove', (e) => {
    wake();
    if (!down || down.id !== e.pointerId) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.drag && dx * dx + dy * dy > 64 && TL.mode === 'free' && !e.shiftKey && !ORBIT.userOrbiting) {
      down.drag = true; if (ORBIT.controls) ORBIT.controls.enabled = false;
      if (typeof freeDragStart === 'function') freeDragStart(pointerWorld(e));
    }
    if (down.drag && typeof freeDragMove === 'function') freeDragMove(pointerWorld(e));
  });
  const up = (e) => {
    if (!down || down.id !== e.pointerId) return;
    const quick = performance.now() - down.t < 350 && !down.drag;
    if (down.drag) { if (typeof freeDragEnd === 'function') freeDragEnd(); if (ORBIT.controls) ORBIT.controls.enabled = ORBIT.active; }
    else if (quick) {
      const p = pointerWorld(e);
      if (TL.mode === 'free' && typeof freeTap === 'function') freeTap(p);
      else if (TL.mode === 'cinematic' && !ORBIT.active) {
        // a tap during the film casts the current act's element into the scene
        const el = ACTS[actAt(TL.T)].el || 'air';
        if (typeof freeTap === 'function') freeTap(p, el, true);
      }
    }
    down = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    wake();
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); E.play.click(); }
    else if (k === 'arrowright' || k === 'arrowleft') { e.preventDefault(); if (TL.mode !== 'cinematic') selectElement(FREE.el); seekTo((TL.T + (k === 'arrowright' ? 5 : -5) + DURATION) % DURATION, 1.2); }
    else if (k >= '1' && k <= '4') selectElement(['water', 'earth', 'fire', 'air'][+k - 1]);
    else if (k === 'escape' || k === '0') { if (!E.panel.hidden) togglePanel(false); else if (TL.mode !== 'cinematic') selectElement(FREE.el); }
    else if (k === 'o') setOrbit(!ORBIT.active);
    else if (k === 'm') E.sound.click();
    else if (k === 'c') togglePanel();
  });
  document.addEventListener('visibilitychange', () => { lastNow = performance.now(); });
  // saved quality choice
  try { const q = localStorage.getItem('stillpoint.quality'); if (q && QUALITY[q] && !FLAGS.quality) setQuality(q, false); } catch (e) { /* ignore */ }
  if (REDUCED_MOTION) toast('Reduced motion: camera shake, flashes and chromatic aberration are off', 4);
  showChapter(actAt(TL.T));
}
function wake() { UI.idle = 0; document.body.classList.remove('idle'); }

function updateUI() {
  const E = UI.el; if (!E.scrub) return;
  const dt = Math.min(0.1, U.uRealTime.value - (UI.lastRT || 0)); UI.lastRT = U.uRealTime.value;
  if (!UI.scrubbing) { E.scrub.value = TL.T.toFixed(2); }
  E.scrub.style.setProperty('--p', (TL.T / DURATION * 100).toFixed(2) + '%');
  E.tc.textContent = TL.mode === 'free' ? 'free play' : fmtTime(TL.T);
  const ai = actAt(TL.T);
  if (ai !== UI.lastAct) {
    UI.lastAct = ai;
    [...E.acts.children].forEach((d, i) => d.classList.toggle('cur', i === ai));
    for (const b of document.querySelectorAll('.el')) b.classList.toggle('cur', b.dataset.el === ACTS[ai].el);
    if (TL.mode === 'cinematic' && TL.playing) showChapter(ai);
  }
  if (UI.chapterT > 0) { UI.chapterT -= dt; if (UI.chapterT <= 0) E.chapter.classList.remove('show'); }
  if (UI.toastT > 0) { UI.toastT -= dt; if (UI.toastT <= 0) E.toast.hidden = true; }
  UI.idle += dt;
  if (UI.idle > 2.8 && E.panel.hidden && !document.body.classList.contains('idle')) document.body.classList.add('idle');
  document.body.classList.toggle('bar-on', !document.body.classList.contains('idle'));
  const bh = E.bar.offsetHeight; if (bh !== UI.barH) { UI.barH = bh; document.documentElement.style.setProperty('--barh', bh + 'px'); }
}
