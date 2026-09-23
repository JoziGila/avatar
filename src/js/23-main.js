// §23 MAIN — boot, resize, loop, adaptive quality ---------------------------------
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
  VIEW.rw = Math.max(2, Math.floor(w * dpr)); VIEW.rh = Math.max(2, Math.floor(h * dpr));
}
function applySize() {
  computeView();
  renderer.setPixelRatio(VIEW.dpr);
  renderer.setSize(VIEW.w, VIEW.h, false);
  VIEW.rw = renderer.domElement.width; VIEW.rh = renderer.domElement.height;
  camera.aspect = VIEW.aspect; camera.updateProjectionMatrix();
  resizePost(VIEW.rw, VIEW.rh);
}

async function boot() {
  if (!renderer || !CAPS.ok) { fail('This cinematic needs WebGL2, which this browser or device does not provide. Try a recent Chrome, Edge, Firefox or Safari.'); return; }
  computeView();
  setLoading(0.05, 'Quarrying granite…'); await nextFrame();
  bakeGranite(Q.texSize); bakeCloth(512); makeBlackbodyLUT();
  setLoading(0.2, 'Raising the cloud sea…'); await nextFrame();
  bakeCloudNoise(64); bakeCurl(32);
  initSky(); initClouds(); initLights();
  setLoading(0.35, 'Shaping the summit…'); await nextFrame();
  buildWorld(); initEffectMask(); makeHeightTexture();
  initPost(); applySize();
  if (typeof bootStage2 === 'function') await bootStage2();
  setLoading(1, 'Breathe.');
  window.addEventListener('resize', () => applySize());
  SKY.sunElev = 4 * DEG; updateSkyState(); renderSkyTexture(true); updateEnvironment(true);
  loaderEl.classList.add('done');
  window.__SP = { ready: true, renderAt: captureAt };
  if (!FLAGS.capture) requestAnimationFrame(loop);
}

let lastNow = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  frame(dt);
}

function frame(dt) {
  U.uRealTime.value += dt; U.uTime.value += dt;
  updateSkyState(); renderSkyTexture(); updateEnvironment();
  updateKeyLight(V3(0, 1, 0));
  flushLights();
  updateEffectMask(dt);
  const cq = URLQ.get('cam');
  if (cq) { const c = cq.split(',').map(Number); camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); if (c[6]) { camera.fov = c[6]; camera.updateProjectionMatrix(); } }
  else { camera.position.set(3.2, 1.9, 7.5); camera.lookAt(0, 1.0, 0); }
  renderFrame();
}

async function captureAt(t) {
  SKY.sunElev = (URLQ.has('sun') ? parseFloat(URLQ.get('sun')) : (4 - t * 0.2)) * DEG; updateSkyState(); renderSkyTexture(true); updateEnvironment(true);
  frame(1 / 30);
  return { t };
}

boot().catch((e) => { console.error(e); fail('Something went wrong while building the scene: ' + (e && e.message ? e.message : e)); });
