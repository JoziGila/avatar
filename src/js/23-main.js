// §23 MAIN — boot, resize, simulation/presentation loop, adaptive quality ----------------------
const loaderEl = document.getElementById('loader');
function setLoading(p, msg) {
  loaderEl.querySelector('.fill').style.width = `${Math.round(p * 100)}%`;
  if (msg) loaderEl.querySelector('.msg').textContent = msg;
}
function fail(msg) {
  loaderEl.classList.add('error');
  loaderEl.querySelector('.msg').textContent = msg;
  window.__SP = { failed: msg };
}

function computeView() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, Q.dprMax) * Q.scale * VIEW.dynScale;
  VIEW.w = w; VIEW.h = h; VIEW.dpr = dpr; VIEW.aspect = w / h;
}
function applySize() {
  computeView();
  renderer.setPixelRatio(VIEW.dpr);
  renderer.setSize(VIEW.w, VIEW.h, false);
  VIEW.rw = renderer.domElement.width; VIEW.rh = renderer.domElement.height;
  camera.aspect = VIEW.aspect; camera.updateProjectionMatrix();
  resizePost(VIEW.rw, VIEW.rh);
  bgMat.uniforms.uPixAngle.value = (camera.fov * DEG) / VIEW.rh;
  document.documentElement.style.setProperty('--lb', `${Math.round(POST.grade.letterbox * VIEW.h)}px`);
}

// ---- figure management -------------------------------------------------------------------------
const CHAR = { canon: new CanonRig(), fig: null, pose: makePose(), overlay: null, freePose: null };
async function setFigure(fig) {
  if (CHAR.fig) world.remove(CHAR.fig.root);
  CHAR.fig = fig; world.add(fig.root);
  sampleChoreo(TL.T, CHAR.pose);
  CHAR.canon.solve(CHAR.pose, 0); fig.apply(CHAR.canon, 0, {});
  initCloth(fig);
  if (!CLOTH.group.parent) world.add(CLOTH.group);
  if (typeof onFigureChanged === 'function') onFigureChanged(fig);
}
async function loadDefaultFigure() {
  let fig = null;
  if (URLQ.get('fig') !== 'proc') {
    try { const buf = embeddedCharacterBuffer(); if (buf) fig = await parseGLB(buf, 'Default figure (Rocketbox avatar, dressed)'); }
    catch (e) { console.warn('default character failed, using procedural figure', e); }
  }
  if (!fig) fig = new ProceduralFigure();
  await setFigure(fig);
}

// breathing rhythm: slow and deep in stillness, sharp exhales on cues
function breathAt(T) {
  let b = Math.sin((T / 4.4) * TAU) * 0.8;
  b = lerp(b, Math.sin(clamp((T - 0.2) / 3.0) * Math.PI) * 1.2, 1 - smoothstep(3.0, 3.6, T));   // the single slow breath in the dark
  b += Math.exp(-Math.pow((T - 35.2) / 0.12, 2)) * -1.6 + Math.exp(-Math.pow((T - 34.5) / 0.5, 2)) * 1.0; // inhale → sharp exhale (fire)
  if (T > 64.2 && T < 65.0) b *= 0.05;   // held breath before the release
  return b;
}

// ---- boot ---------------------------------------------------------------------------------------
async function boot() {
  if (!renderer || !CAPS.ok) { fail('This cinematic needs WebGL2, which this browser or device does not provide. Try a recent Chrome, Edge, Firefox or Safari.'); return; }
  computeView();
  setLoading(0.05, 'Quarrying granite…'); await nextFrame();
  bakeGranite(Q.texSize); bakeCloth(512); makeBlackbodyLUT();
  setLoading(0.2, 'Raising the cloud sea…'); await nextFrame();
  bakeCloudNoise(64); bakeCurl(32);
  initSky(); initClouds(); initLights();
  setLoading(0.32, 'Shaping the summit…'); await nextFrame();
  buildWorld(); initEffectMask(); makeHeightTexture();
  initPost(); applySize();
  setLoading(0.5, 'Waking the figure…'); await nextFrame();
  buildChoreography(); buildShots();
  await loadDefaultFigure();
  setLoading(0.72, 'Kindling the elements…'); await nextFrame();
  if (typeof initFX === 'function') initFX();
  if (typeof initUI === 'function') initUI();
  setLoading(0.9, 'Compiling light…'); await nextFrame();
  const T0 = FLAGS.startT != null ? FLAGS.startT : 0;
  seekTo(T0, 0.8);
  applyTracks(TL.T); updateSkyState(); renderSkyTexture(true); updateEnvironment(true);
  setLoading(1, 'Breathe.');
  window.addEventListener('resize', () => applySize());
  loaderEl.classList.add('done');
  window.__SP = { ready: true, renderAt: captureAt, seek: (t) => seekTo(t) };
  if (!FLAGS.capture) requestAnimationFrame(loop);
}

// ---- simulation & presentation -------------------------------------------------------------------
let simTime = 0;
function simulate(dtSim) {
  const T = TL.T;
  simTime += dtSim; U.uTime.value = simTime;
  applyTracks(T);
  if (TL.mode === 'cinematic') sampleChoreo(T, CHAR.pose);
  else if (typeof freePlayPose === 'function') freePlayPose(CHAR.pose, dtSim);
  if (typeof poseOverlay === 'function') poseOverlay(CHAR.pose, T, dtSim);
  CHAR.canon.breath = breathAt(TL.mode === 'cinematic' ? T : simTime);
  CHAR.canon.solve(CHAR.pose, dtSim);
  CHAR.fig.apply(CHAR.canon, dtSim, { breath: 0.9, face: CHAR.pose.face });
  if (typeof updateFX === 'function') updateFX(T, dtSim);
  updateCloth(dtSim, simTime);
  if (typeof updateParticles === 'function') updateParticles(dtSim);
  updateEffectMask(dtSim);
}
function present(dtReal) {
  U.uRealTime.value += dtReal;
  updateSkyState(); renderSkyTexture(); updateEnvironment();
  if (TL.mode === 'cinematic' || !ORBIT.active) updateCamera(TL.mode === 'cinematic' ? TL.T : FREE_T, dtReal);
  else ORBIT.update(dtReal);
  if (FLAGS.capture) debugCameraOverride();
  updateKeyLight(CAM.anchors.hips || V3(0, 1, 0));
  if (typeof collectLights === 'function') collectLights();
  flushLights(); syncParticleLights();
  if (typeof updateAudio === 'function') updateAudio(dtReal);
  if (typeof updateUI === 'function') updateUI();
  renderFrame();
}
const FREE_T = 6.9;
const ORBIT = { active: false, update() {} };

function seekTo(T, preroll = 2.2) {
  tlSeek(T, { preroll, step: 1 / 30, stepFn: (dt) => simulate(dt) });
  simulate(0);
  resetCloth();
  // let the cloth settle into the current pose
  for (let i = 0; i < 24; i++) { CHAR.canon.solve(CHAR.pose, 1 / 60); CHAR.fig.apply(CHAR.canon, 1 / 60, { breath: 0.9 }); updateCloth(1 / 60, simTime + i / 60); }
  CAM.first = true; CAM.shotIndex = -1;
}

let lastNow = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  if (typeof adaptQuality === 'function') adaptQuality(dt);
  const dtSim = tlAdvance(dt) || (TL.mode !== 'cinematic' ? dt : 0);
  simulate(dtSim);
  present(dt);
}

async function captureAt(t) {
  seekTo(t, URLQ.has('preroll') ? +URLQ.get('preroll') : 1.5);
  present(1 / 60);
  return { t, fig: CHAR.fig && CHAR.fig.info, shot: SHOTS[CAM.shotIndex] && SHOTS[CAM.shotIndex].name };
}
if (FLAGS.capture) window.__eval = (s) => eval(s);
// development: fixed or following camera for pose review (capture mode only)
function debugCameraOverride() {
  const f = URLQ.get('follow'), c = URLQ.get('cam');
  if (URLQ.has('nofade')) POST.grade.fade = 0;
  if (c) { const v = c.split(',').map(Number); camera.position.set(v[0], v[1], v[2]); camera.lookAt(v[3], v[4], v[5]); if (v[6]) camera.fov = v[6]; }
  else if (f) { const v = f.split(',').map(Number); const h = CAM.anchors.hips || V3(0, 1, 0); camera.position.set(h.x + Math.sin(v[0] * DEG) * v[1], v[2], h.z + Math.cos(v[0] * DEG) * v[1]); camera.lookAt(h.x, h.y * 0.85, h.z); camera.fov = v[3] || 34; }
  else return;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(); POST.grade.aperture = 0; POST.cut = true;
}

boot().catch((e) => { console.error(e); fail('Something went wrong while building the scene: ' + (e && e.message ? e.message : e)); });
