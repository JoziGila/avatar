// §4 ATMOSPHERE, SKY, STARS, ENVIRONMENT ---------------------------------------
// Single-scattering Rayleigh + Mie + ozone (Nishita-style) with Schüler's Chapman
// approximation for light paths. Precomputed each few frames into an equirect HDR
// texture that feeds the background, fog/aerial perspective, clouds and PMREM IBL.
const ATMO = {
  Re: 6360e3, Ra: 6420e3, alt: 2600,
  bR: [5.802e-6, 13.558e-6, 33.1e-6], HR: 8000,
  bM: 3.996e-6, bMext: 4.44e-6, HM: 1200, g: 0.8,
  bO: [0.65e-6, 1.881e-6, 0.085e-6], ozone: 0.7,
  sunI: 22, moonI: 0.034,
};
const GLSL_ATMO = /* glsl */ `
const float Re = ${ATMO.Re.toFixed(1)}; const float Ra = ${ATMO.Ra.toFixed(1)};
const vec3 bR = vec3(${ATMO.bR.map((v) => v.toExponential(4)).join(',')});
const float bM = ${ATMO.bM.toExponential(4)}; const float bMe = ${ATMO.bMext.toExponential(4)};
const vec3 bO = vec3(${ATMO.bO.map((v) => v.toExponential(4)).join(',')}) * ${ATMO.ozone.toFixed(2)};
const float HR = ${ATMO.HR.toFixed(1)}; const float HM = ${ATMO.HM.toFixed(1)};
float chapman(float X, float h, float cz){
  float c = sqrt(X + h);
  if (cz >= 0.0) return c / (c * cz + 1.0) * exp(-h);
  float x0 = sqrt(1.0 - cz * cz) * (X + h); float c0 = sqrt(x0);
  return 2.0 * c0 * exp(X - x0) - c / (1.0 - c * cz) * exp(-h);
}
vec3 transmittanceTo(vec3 pos, vec3 L){ // pos relative to planet center
  float r = length(pos); float cz = dot(pos / r, L); float h = r - Re;
  float odR = HR * chapman(Re / HR, h / HR, cz);
  float odM = HM * chapman(Re / HM, h / HM, cz);
  return exp(-(bR * odR + bMe * odM + bO * odR * 0.6));
}
float phaseR(float mu){ return 3.0 / (16.0 * SP_PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g){ float g2 = g * g; return 3.0 / (8.0 * SP_PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
vec2 raySphere(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float d = b * b - c; if (d < 0.0) return vec2(1e9, -1e9); d = sqrt(d); return vec2(-b - d, -b + d); }
// in-scattered radiance along a view ray from the observer, lit by sun and moon
vec3 atmosphere(vec3 rd, vec3 sunDir, float sunI, vec3 moonDir, float moonI, float obsAlt, out vec3 transView){
  vec3 ro = vec3(0.0, Re + obsAlt, 0.0);
  vec2 ta = raySphere(ro, rd, Ra); vec2 tg = raySphere(ro, rd, Re);
  float tMax = ta.y; if (tg.x > 0.0) tMax = min(tMax, tg.x);
  const int N = 16; float ds = tMax / float(N);
  vec3 sumRs = vec3(0.0), sumMs = vec3(0.0), sumRm = vec3(0.0), sumMm = vec3(0.0);
  float odR = 0.0, odM = 0.0; float t = 0.0;
  for (int i = 0; i < N; i++){
    // quadratic sample distribution: denser near observer
    float s0 = float(i) / float(N), s1 = float(i + 1) / float(N);
    float t0 = s0 * s0 * tMax, t1 = s1 * s1 * tMax; float dt = t1 - t0; float tm = 0.5 * (t0 + t1);
    vec3 p = ro + rd * tm; float h = length(p) - Re;
    float dR = exp(-h / HR) * dt, dM = exp(-h / HM) * dt;
    odR += dR; odM += dM;
    vec3 tv = exp(-(bR * odR + bMe * odM + bO * odR * 0.6));
    vec3 ts = transmittanceTo(p, sunDir); vec3 tmn = transmittanceTo(p, moonDir);
    sumRs += dR * tv * ts; sumMs += dM * tv * ts;
    sumRm += dR * tv * tmn; sumMm += dM * tv * tmn;
  }
  transView = exp(-(bR * odR + bMe * odM + bO * odR * 0.6));
  float mus = dot(rd, sunDir), mum = dot(rd, moonDir);
  vec3 L = sunI * (sumRs * bR * phaseR(mus) + sumMs * bM * phaseM(mus, ${ATMO.g.toFixed(2)}));
  L += moonI * (sumRm * bR * phaseR(mum) + sumMm * bM * phaseM(mum, 0.7));
  return L;
}
`;

const SKY = {
  sunElev: 4 * DEG, sunAz: -145 * DEG, moonElev: 20 * DEG, moonAz: 20 * DEG, moonPhase: 0.3,
  cloudSeaColor: new THREE.Color(), nightGlow: 0.0, starVis: 0, milky: 0.8, sunVis: 1,
  dirty: true, frame: 0, envFrame: 1e9, lastEnvSunElev: 999,
};
const SKY_W = 256, SKY_H = 128;
let skyRT, skyMat, bgMat, pmrem, envRT;

function initSky() {
  skyRT = makeRT(SKY_W, SKY_H, { type: THREE.HalfFloatType, wrapS: THREE.RepeatWrapping });
  skyRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  skyRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  U.uSkyTex.value = skyRT.texture;
  skyMat = fsMat(GLSL_ATMO + /* glsl */ `
    varying vec2 vUv;
    uniform vec3 uSunDir, uMoonDir; uniform float uSunI, uMoonI, uAlt;
    uniform vec3 uCloudSea; uniform float uNightGlow;
    void main(){
      float phi = (vUv.x - 0.5) * SP_TAU; float theta = (1.0 - vUv.y) * SP_PI;
      vec3 rd = vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
      vec3 tv;
      // the cloud sea horizon sits slightly below the geometric horizon
      vec3 rdA = rd; rdA.y = max(rd.y, 0.004);
      vec3 L = atmosphere(normalize(rdA), uSunDir, uSunI, uMoonDir, uMoonI, uAlt, tv);
      // airglow / starlight floor so night is deep blue, never pure black
      vec3 night = vec3(0.0010, 0.0017, 0.0036) * uNightGlow * (1.0 + 1.5 * pow(1.0 - max(rd.y, 0.0), 3.0));
      L += night;
      if (rd.y < 0.0){
        // below horizon: lit cloud-sea carpet fading in under the haze
        float k = smoothstep(0.0, -0.12, rd.y);
        L = mix(L, uCloudSea + night * 0.6, k * 0.9);
      }
      gl_FragColor = vec4(L, 1.0);
    }`, {
    uSunDir: U.uSunDir, uMoonDir: U.uMoonDir, uSunI: { value: ATMO.sunI }, uMoonI: { value: ATMO.moonI }, uAlt: { value: ATMO.alt },
    uCloudSea: { value: SKY.cloudSeaColor }, uNightGlow: { value: 1 },
  });

  // Background: equirect sky + sun disc + moon + stars + milky way, per pixel from view rays.
  bgMat = fsMat(/* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uSkyTex; uniform mat4 uInvProjView; uniform vec3 uCamPos;
    uniform vec3 uSunDir, uMoonDir, uSunColor; uniform float uStarVis, uTime, uSunVis, uMoonPhase, uMilky;
    uniform vec2 uResolution; uniform float uPixAngle;
    vec3 starLayer(vec3 d, float scale, float density, float pix){
      vec3 p = d * scale; vec3 base = floor(p - 0.5); vec3 col = vec3(0.0);
      for (int k = 0; k < 2; k++) for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++){
        vec3 c = base + vec3(float(i), float(j), float(k));
        vec4 h = vec4(sp_hash33(c * 0.7131 + scale * 1.618), sp_hash13(c * 1.3173 - scale));   // true 3D hash: no lattice rows
        if (h.x > density) continue;
        vec3 sp = normalize(c + 0.25 + 0.5 * h.yzw);
        float ang = length(sp - d);            // chord ≈ angle; acos loses all precision at star scale
        float w = pix * 0.85;
        float mag = pow(h.y, 6.0) * 3.2 + 0.015;
        float twk = 0.7 + 0.3 * sin(uTime * (2.0 + 9.0 * h.z) + h.w * 40.0) * smoothstep(0.5, 0.0, d.y);
        vec3 tint = mix(vec3(0.66, 0.78, 1.0), vec3(1.0, 0.8, 0.58), smoothstep(0.3, 1.0, h.z));
        col += tint * mag * twk * exp(-ang * ang / (w * w));
      }
      return col;
    }
    void main(){
      vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec4 wp = uInvProjView * ndc; vec3 rd = normalize(wp.xyz / wp.w - uCamPos);
      vec3 col = texture2D(uSkyTex, sp_equirectUV(rd)).rgb;
      float pix = uPixAngle;
      // sun disc with limb darkening
      float cs = dot(rd, uSunDir); float sunR = 0.0056;
      float ang = acos(clamp(cs, -1.0, 1.0));
      if (ang < sunR * 1.6){
        float x = clamp(ang / sunR, 0.0, 1.0);
        float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - x * x, 0.0)));
        float disc = 1.0 - smoothstep(0.92, 1.05, ang / sunR);
        col += uSunColor * 2600.0 * disc * limb * uSunVis * step(-0.02, rd.y);
      }
      // stars + milky way (fade with sky luminance and toward the haze)
      float skyL = sp_luma(col);
      float vis = uStarVis * smoothstep(-0.02, 0.18, rd.y) * clamp(1.0 - skyL * 8.0, 0.0, 1.0);
      if (vis > 0.001){
        // sparse bright stars, a thinner middle layer, and a faint dusting concentrated in the milky way
        vec3 mwN0 = normalize(vec3(0.35, 0.55, 0.76)); float inBand = exp(-pow(dot(rd, mwN0) / 0.3, 2.0));
        vec3 s = starLayer(rd, 70.0, 0.05, pix) + starLayer(rd, 150.0, 0.035, pix) * 0.5 + starLayer(rd, 300.0, 0.012 + 0.05 * inBand, pix) * 0.3;
        // milky way band: great circle tilted across the sky
        vec3 mwN = normalize(vec3(0.35, 0.55, 0.76));
        float band = exp(-pow(dot(rd, mwN) / 0.23, 2.0));
        float neb = sp_fbm3(rd * 6.0) * 0.8 + sp_fbm3(rd * 17.0) * 0.4;
        float dust = smoothstep(0.45, 0.75, sp_fbm3(rd * 11.0 + 3.0)) * exp(-pow(dot(rd, mwN) / 0.06, 2.0));
        vec3 mw = vec3(0.020, 0.022, 0.030) * band * neb * (1.0 - 0.8 * dust) * uMilky;
        col += (s * 0.5 + mw) * vis;
      }
      // moon
      float cm = dot(rd, uMoonDir); float moonR = 0.0085;
      float am = acos(clamp(cm, -1.0, 1.0));
      if (am < moonR * 1.3 && rd.y > -0.01){
        vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0))); vec3 t2 = cross(t1, uMoonDir);
        vec2 q = vec2(dot(rd, t1), dot(rd, t2)) / moonR;
        float r2 = dot(q, q);
        if (r2 < 1.0){
          vec3 n = normalize(q.x * t1 + q.y * t2 - sqrt(1.0 - r2) * uMoonDir);
          float pa = uMoonPhase * SP_PI;
          vec3 Lm = normalize(-uMoonDir * cos(pa) + t1 * sin(pa));
          float lit = smoothstep(-0.04, 0.1, dot(n, Lm));
          float maria = 0.7 + 0.3 * smoothstep(0.35, 0.65, sp_fbm3(vec3(q * 2.2, 1.0)));
          col += vec3(0.95, 0.93, 0.88) * 2.2 * lit * maria * (1.0 - smoothstep(0.95, 1.0, r2));
        }
      }
      col += vec3(0.8, 0.85, 1.0) * 0.012 * exp(-am * 40.0) * uStarVis; // moon halo
      gl_FragColor = vec4(col, 1.0);
    }`, {
    uSkyTex: U.uSkyTex, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    uSunDir: U.uSunDir, uMoonDir: U.uMoonDir, uSunColor: U.uSunColor, uStarVis: U.uStarVis, uTime: U.uRealTime,
    uSunVis: { value: 1 }, uMoonPhase: { value: SKY.moonPhase }, uMilky: { value: 0.8 }, uResolution: U.uResolution, uPixAngle: { value: 0.0006 },
  });

  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
}

// --- JS mirror of the atmosphere for light colors ------------------------------
const Atmo = (() => {
  const { Re, bR, bMext, HR, HM, bO, ozone } = ATMO;
  function chapman(X, h, cz) {
    const c = Math.sqrt(X + h);
    if (cz >= 0) return (c / (c * cz + 1)) * Math.exp(-h);
    const x0 = Math.sqrt(1 - cz * cz) * (X + h), c0 = Math.sqrt(x0);
    return 2 * c0 * Math.exp(X - x0) - (c / (1 - c * cz)) * Math.exp(-h);
  }
  // transmittance from the observer toward direction with elevation e (radians)
  function trans(e, alt, out) {
    const cz = Math.sin(e), h = alt;
    const odR = HR * chapman(Re / HR, h / HR, cz), odM = HM * chapman(Re / HM, h / HM, cz);
    for (let i = 0; i < 3; i++) out[i] = Math.exp(-(bR[i] * odR + bMext * odM + bO[i] * ozone * odR * 0.6));
    return out;
  }
  return { trans };
})();

function dirFromElevAz(e, a, out) { return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)); }

const _tr = [0, 0, 0];
function updateSkyState() {
  dirFromElevAz(SKY.sunElev, SKY.sunAz, U.uSunDir.value);
  dirFromElevAz(SKY.moonElev, SKY.moonAz, U.uMoonDir.value);
  // sun color at the summit (including the disc sinking behind the cloud-sea horizon)
  Atmo.trans(Math.max(SKY.sunElev, -0.02), ATMO.alt, _tr);
  const horizonCut = smoothstep(-0.018, 0.012, SKY.sunElev);
  SKY.sunVis = horizonCut;
  U.uSunColor.value.setRGB(_tr[0], _tr[1], _tr[2]);
  // key light: sun until it sets, then the moon (continuous via cross-fade of direction/intensity)
  const sunW = horizonCut * smoothstep(-0.04, 0.05, SKY.sunElev);
  const moonW = (1 - smoothstep(-0.07, 0.0, SKY.sunElev)) * smoothstep(0.02, 0.2, SKY.moonElev);
  const sunL = sunW * 3.2, moonL = moonW * 0.11;
  const k = sunL / Math.max(sunL + moonL, 1e-6);
  U.uKeyDir.value.copy(U.uMoonDir.value).lerp(U.uSunDir.value, k).normalize();
  U.uKeyColor.value.setRGB(_tr[0] * sunL + 0.55 * moonL, _tr[1] * sunL + 0.66 * moonL, _tr[2] * sunL + 0.95 * moonL);
  // ambient estimates (zenith/horizon) — analytic, good enough for fills and fog fallback
  const day = smoothstep(-0.2, 0.08, SKY.sunElev);
  const tw = smoothstep(-0.12, 0.02, SKY.sunElev);
  U.uSkyZenith.value.setRGB(lerp(0.004, 0.06, day) * 0.8 + 0.01 * tw, lerp(0.007, 0.09, day), lerp(0.016, 0.20, day) + 0.02 * tw);
  U.uSkyHorizon.value.setRGB(lerp(0.006, 0.55, day) * (0.6 + 0.4 * _tr[0]), lerp(0.008, 0.35, day) * (0.5 + 0.5 * _tr[1]), lerp(0.014, 0.25, day));
  U.uAmbient.value.copy(U.uSkyZenith.value).lerp(U.uSkyHorizon.value, 0.35);
  // lit cloud-sea color seen below the horizon
  const sunOnCloud = Math.max(Math.sin(SKY.sunElev) + 0.05, 0) * 1.6 * SKY.sunVis;
  SKY.cloudSeaColor.setRGB(_tr[0] * sunOnCloud * 1.5 + U.uSkyZenith.value.r * 0.9, _tr[1] * sunOnCloud * 1.5 + U.uSkyZenith.value.g * 0.9, _tr[2] * sunOnCloud * 1.5 + U.uSkyZenith.value.b * 0.9);
  bgMat.uniforms.uSunVis.value = SKY.sunVis;
  U.uStarVis.value = SKY.starVis;
}

let _skyLastElev = 999, _skyFrames = 0;
function renderSkyTexture(force = false) {
  _skyFrames++;
  const moved = Math.abs(SKY.sunElev - _skyLastElev) > 0.0004;
  if (!force && !(moved && _skyFrames % Q.skyEvery === 0)) return false;
  _skyLastElev = SKY.sunElev;
  skyMat.uniforms.uNightGlow.value = 1;
  blit(skyMat, skyRT);
  integrateSkyAmbient();
  return true;
}
// Ambient cube: cosine-weighted integral of the sky texture around six axes. The lower face sees
// the summit's granite lit by that same sky, not the cloud sea far below the horizon.
let ambRT = null, ambMat = null;
function integrateSkyAmbient() {
  if (!ambRT) {
    ambRT = makeRT(6, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    ambMat = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D uSky;
      vec3 axisOf(int i){ return i == 0 ? vec3(1,0,0) : i == 1 ? vec3(-1,0,0) : i == 2 ? vec3(0,1,0) : i == 3 ? vec3(0,-1,0) : i == 4 ? vec3(0,0,1) : vec3(0,0,-1); }
      void main(){
        int f = int(floor(vUv.x * 6.0)); vec3 n = axisOf(f);
        vec3 sum = vec3(0.0); float wsum = 0.0;
        for (int j = 0; j < 12; j++) for (int i = 0; i < 24; i++){
          float el = (float(j) + 0.5) / 12.0 * 1.5707963; float az = (float(i) + 0.5) / 24.0 * 6.2831853;
          vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
          float w = cos(el);                                        // solid-angle weight on the upper hemisphere
          float c = max(dot(d, n), 0.0);
          sum += texture2D(uSky, sp_equirectUV(d)).rgb * c * w; wsum += w;
        }
        vec3 irr = sum / wsum * 2.0;                                 // sky seen by this axis
        vec3 up = vec3(0.0);
        // ground bounce: granite (albedo ~0.2) under the whole upper sky
        for (int i = 0; i < 24; i++){ float az = (float(i) + 0.5) / 24.0 * 6.2831853; up += texture2D(uSky, sp_equirectUV(normalize(vec3(cos(az), 0.6, sin(az))))).rgb; }
        up /= 24.0;
        float below = max(-n.y, 0.0) + (1.0 - abs(n.y)) * 0.5;
        irr += up * 0.2 * below;
        gl_FragColor = vec4(irr, 1.0);
      }`, { uSky: { value: null } });
    U.uAmbCube.value = ambRT.texture;
  }
  ambMat.uniforms.uSky.value = skyRT.texture;
  blit(ambMat, ambRT);
}

let _envCounter = 0, _envLastElev = 999;
function updateEnvironment(force = false) {
  _envCounter++;
  if (!force && (_envCounter < Q.envEvery || Math.abs(SKY.sunElev - _envLastElev) < 0.002)) return;
  _envCounter = 0; _envLastElev = SKY.sunElev;
  const rt = pmrem.fromEquirectangular(skyRT.texture, envRT || null);
  envRT = rt;
  world.environment = rt.texture;
}

const _ipv = new THREE.Matrix4();
function drawSkyBackground(cam, target) {
  _ipv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
  bgMat.uniforms.uInvProjView.value.copy(_ipv);
  bgMat.uniforms.uCamPos.value.copy(cam.position);
  blit(bgMat, target);
}
