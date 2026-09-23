// §17 POST-PROCESSING — EffectComposer with custom passes ------------------------
// ScenePass renders sky → opaque world → linear depth → clouds → SSAO → refraction
// copy → screen-space water → translucent FX → distortion sources into its own
// MSAA HDR target; the composer chain then runs distortion, DOF, motion blur,
// bloom (+anamorphic streak) and the final grade (ACES, CA, grain, vignette, bars).
const POST = {
  sceneRT: null, linDepthRT: null, aoRT: null, aoTmpRT: null, sceneCopyRT: null, distortRT: null,
  composer: null, scenePass: null, distortPass: null, dofPass: null, mblurPass: null, bloomPass: null, streakPass: null, finalPass: null,
  prevViewProj: new THREE.Matrix4(), curViewProj: new THREE.Matrix4(), cut: true,
  grade: { exposure: 1, contrast: 1.05, saturation: 1, temp: 0, tint: 0, lift: new THREE.Vector3(0, 0, 0), gain: new THREE.Vector3(1, 1, 1),
    vignette: 0.35, grain: 0.05, ca: 0, letterbox: 0, fade: 0, flash: 0, flashColor: new THREE.Color(1, 1, 1), bloom: 0.6, bloomThreshold: 1.6, streak: 0.25,
    focus: 4, aperture: 0, shutter: 0.5, heat: 1, drops: 0 },
};

const linMat = fsMat(/* glsl */ `
  varying vec2 vUv; uniform sampler2D tDepth; uniform float uNear, uFar;
  void main(){
    float d = texture2D(tDepth, vUv).r;
    float z = (uNear * uFar) / ((uFar - uNear) * d - uFar);
    gl_FragColor = vec4(d >= 1.0 ? uFar : -z, 0.0, 0.0, 1.0);
  }`, { tDepth: { value: null }, uNear: U.uCamNear, uFar: U.uCamFar });

const aoMat = fsMat(/* glsl */ `
  varying vec2 vUv; uniform sampler2D tLin; uniform mat4 uProj; uniform mat4 uInvProj; uniform vec2 uTexel; uniform float uRadius, uFrame;
  vec3 viewPos(vec2 uv){ float z = texture2D(tLin, uv).r; vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0); vec3 dir = p.xyz / p.w; return dir * (z / -dir.z); }
  void main(){
    float z0 = texture2D(tLin, vUv).r;
    if (z0 > 60.0){ gl_FragColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv);
    vec3 Px = viewPos(vUv + vec2(uTexel.x, 0.0)), Py = viewPos(vUv + vec2(0.0, uTexel.y));
    vec3 Pmx = viewPos(vUv - vec2(uTexel.x, 0.0)), Pmy = viewPos(vUv - vec2(0.0, uTexel.y));
    vec3 dx = abs(Px.z - P.z) < abs(Pmx.z - P.z) ? Px - P : P - Pmx;
    vec3 dy = abs(Py.z - P.z) < abs(Pmy.z - P.z) ? Py - P : P - Pmy;
    vec3 N = normalize(cross(dx, dy));
    float ang = sp_ign(gl_FragCoord.xy + uFrame * 3.1) * SP_TAU;
    float rad = uRadius; float ao = 0.0; const int S = 12;
    vec4 pr = uProj * vec4(P + vec3(rad, 0.0, 0.0), 1.0); vec4 pc = uProj * vec4(P, 1.0);
    float pxR = abs(pr.x / pr.w - pc.x / pc.w) * 0.5;
    for (int i = 0; i < S; i++){
      float f = (float(i) + 0.5) / float(S);
      float a = ang + float(i) * 2.39996; float r = sqrt(f) * pxR;
      vec2 suv = vUv + vec2(cos(a), sin(a)) * r;
      vec3 Q = viewPos(suv); vec3 v = Q - P; float vv = dot(v, v);
      float vn = dot(v, N);
      ao += max(0.0, vn - 0.015 * -P.z) / (vv + 0.02) * smoothstep(rad * rad * 4.0, 0.0, vv);
    }
    ao = clamp(1.0 - 1.35 * ao / float(S) * rad, 0.0, 1.0);
    ao = mix(1.0, ao, smoothstep(60.0, 30.0, z0));
    gl_FragColor = vec4(ao, z0, 0.0, 1.0);
  }`, { tLin: U.uLinDepth, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.45 }, uFrame: { value: 0 } });

const aoBlurMat = fsMat(/* glsl */ `
  varying vec2 vUv; uniform sampler2D tAO; uniform vec2 uDir;
  void main(){
    vec2 c = texture2D(tAO, vUv).rg; float s = c.x, w = 1.0;
    for (int i = -3; i <= 3; i++){ if (i == 0) continue; vec2 o = texture2D(tAO, vUv + uDir * float(i)).rg;
      float wi = exp(-abs(o.y - c.y) / max(c.y * 0.03, 0.02)) * (1.0 - abs(float(i)) / 4.0); s += o.x * wi; w += wi; }
    gl_FragColor = vec4(s / w, c.y, 0.0, 1.0);
  }`, { tAO: { value: null }, uDir: { value: new THREE.Vector2() } });

const aoApplyMat = fsMat(/* glsl */ `
  varying vec2 vUv; uniform sampler2D tAO; uniform float uStrength;
  void main(){ float a = texture2D(tAO, vUv).r; a = mix(1.0, a, uStrength); gl_FragColor = vec4(a, a, a, 1.0); }`,
{ tAO: { value: null }, uStrength: { value: 0.85 } },
{ blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, transparent: true });

// ------------------------------------------------------------------------------
class ScenePass extends Pass {
  constructor() { super(); this.needsSwap = false; this.frame = 0; }
  render(r) {
    this.frame++;
    const cam = camera;
    const rt = POST.sceneRT;
    r.setRenderTarget(rt); r.setClearColor(0x000000, 1); r.clear(true, true, false);
    drawSkyBackground(cam, rt);
    r.setRenderTarget(rt); r.render(world, cam);
    linMat.uniforms.tDepth.value = rt.depthTexture;
    blit(linMat, POST.linDepthRT);
    renderClouds(cam, rt);
    if (Q.ao && POST.aoEnabled) {
      aoMat.uniforms.uProj.value.copy(cam.projectionMatrix); aoMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
      aoMat.uniforms.uTexel.value.set(1 / POST.aoRT.width, 1 / POST.aoRT.height); aoMat.uniforms.uFrame.value = this.frame % 16;
      blit(aoMat, POST.aoRT);
      aoBlurMat.uniforms.tAO.value = POST.aoRT.texture; aoBlurMat.uniforms.uDir.value.set(1 / POST.aoRT.width, 0); blit(aoBlurMat, POST.aoTmpRT);
      aoBlurMat.uniforms.tAO.value = POST.aoTmpRT.texture; aoBlurMat.uniforms.uDir.value.set(0, 1 / POST.aoRT.height); blit(aoBlurMat, POST.aoRT);
      aoApplyMat.uniforms.tAO.value = POST.aoRT.texture; blit(aoApplyMat, rt);
    }
    copyTex(rt.texture, POST.sceneCopyRT);
    if (typeof renderWaterSSF === 'function') renderWaterSSF(cam, rt);
    r.setRenderTarget(rt); r.render(fxScene, cam);
    r.setRenderTarget(POST.distortRT); r.setClearColor(0x000000, 0); r.clear(true, false, false); r.setClearColor(0x000000, 1);
    if (POST.grade.heat > 0) r.render(distortScene, cam);
  }
}

class DistortPass extends Pass {
  constructor() {
    super();
    this.mat = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D tScene, tDist; uniform float uAmt;
      void main(){
        vec4 d = texture2D(tDist, vUv);
        vec2 off = d.xy * uAmt;
        float sep = d.z * uAmt; // chromatic split on refractive edges
        vec3 c;
        if (abs(sep) > 1e-5){ c.r = texture2D(tScene, vUv + off * (1.0 + sep * 4.0)).r; c.g = texture2D(tScene, vUv + off).g; c.b = texture2D(tScene, vUv + off * (1.0 - sep * 4.0)).b; }
        else c = texture2D(tScene, vUv + off).rgb;
        gl_FragColor = vec4(c + d.w * vec3(0.9, 0.95, 1.0) * 0.0, 1.0);
      }`, { tScene: { value: null }, tDist: { value: null }, uAmt: { value: 1 } });
  }
  render(r, writeBuffer) {
    this.mat.uniforms.tScene.value = POST.sceneRT.texture; this.mat.uniforms.tDist.value = POST.distortRT.texture;
    this.mat.uniforms.uAmt.value = POST.grade.heat;
    blit(this.mat, this.renderToScreen ? null : writeBuffer);
  }
}

class DOFPass extends Pass {
  constructor() {
    super();
    this.halfA = makeRT(4, 4); this.halfB = makeRT(4, 4);
    this.prefilter = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor, tLin; uniform float uFocus, uAperture, uMaxCoC; uniform vec2 uTexel;
      float coc(float z){ return clamp((z - uFocus) / z * uAperture, -1.0, 1.0) * uMaxCoC; }
      void main(){
        vec2 o = uTexel * 0.5; vec3 c = vec3(0.0); float cc = 0.0; float mx = 0.0;
        for (int i = 0; i < 4; i++){ vec2 uv = vUv + vec2(i == 0 || i == 2 ? -o.x : o.x, i < 2 ? -o.y : o.y);
          vec3 s = texture2D(tColor, uv).rgb; float z = texture2D(tLin, uv).r; float k = coc(z);
          float w = 1.0 / (1.0 + sp_luma(s) * 0.15); c += s * w; cc += w; mx = abs(k) > abs(mx) ? k : mx; }
        gl_FragColor = vec4(c / cc, mx);
      }`, { tColor: { value: null }, tLin: U.uLinDepth, uFocus: { value: 4 }, uAperture: { value: 0 }, uMaxCoC: { value: 12 }, uTexel: { value: new THREE.Vector2() } });
    this.bokeh = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D tHalf; uniform vec2 uTexel; uniform float uMaxCoC;
      void main(){
        vec4 c0 = texture2D(tHalf, vUv); float r0 = abs(c0.a);
        vec3 acc = c0.rgb; float wsum = 1.0;
        const int N = 28;
        for (int i = 0; i < N; i++){
          float f = (float(i) + 0.5) / float(N); float a = float(i) * 2.39996323; float r = sqrt(f) * uMaxCoC;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;
          vec4 s = texture2D(tHalf, uv); float rs = abs(s.a);
          // sample contributes if its own CoC reaches us; background can't bleed over sharp foreground
          float reach = smoothstep(r - 1.2, r + 0.3, rs);
          float behind = s.a > 0.0 && c0.a < s.a ? 1.0 : 1.0;
          float w = reach * behind * (1.0 + sp_luma(s.rgb) * 0.08);
          acc += s.rgb * w; wsum += w;
        }
        gl_FragColor = vec4(acc / wsum, c0.a);
      }`, { tHalf: { value: null }, uTexel: { value: new THREE.Vector2() }, uMaxCoC: { value: 12 } });
    this.comp = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor, tBlur, tLin; uniform float uFocus, uAperture, uMaxCoC;
      void main(){
        vec3 sharp = texture2D(tColor, vUv).rgb; vec4 b = texture2D(tBlur, vUv);
        float z = texture2D(tLin, vUv).r; float k = abs(clamp((z - uFocus) / z * uAperture, -1.0, 1.0) * uMaxCoC);
        float m = smoothstep(0.6, 2.2, max(k, abs(b.a) * step(b.a, 0.0)));
        gl_FragColor = vec4(mix(sharp, b.rgb, m), 1.0);
      }`, { tColor: { value: null }, tBlur: { value: null }, tLin: U.uLinDepth, uFocus: { value: 4 }, uAperture: { value: 0 }, uMaxCoC: { value: 12 } });
  }
  setSize(w, h) { this.halfA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.halfB.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); }
  render(r, writeBuffer, readBuffer) {
    const g = POST.grade; const maxCoC = Math.min(14, 7 + VIEW.rh / 180);
    const p = this.prefilter.uniforms; p.tColor.value = readBuffer.texture; p.uFocus.value = g.focus; p.uAperture.value = g.aperture; p.uMaxCoC.value = maxCoC;
    p.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    blit(this.prefilter, this.halfA);
    const b = this.bokeh.uniforms; b.tHalf.value = this.halfA.texture; b.uTexel.value.set(1 / this.halfA.width, 1 / this.halfA.height); b.uMaxCoC.value = maxCoC * 0.5;
    blit(this.bokeh, this.halfB);
    const c = this.comp.uniforms; c.tColor.value = readBuffer.texture; c.tBlur.value = this.halfB.texture; c.uFocus.value = g.focus; c.uAperture.value = g.aperture; c.uMaxCoC.value = maxCoC;
    blit(this.comp, this.renderToScreen ? null : writeBuffer);
  }
}

class MotionBlurPass extends Pass {
  constructor() {
    super();
    this.mat = fsMat(/* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor, tLin; uniform mat4 uInvProj, uCamWorld, uPrevVP; uniform float uShutter, uMaxLen;
      void main(){
        float z = texture2D(tLin, vUv).r;
        vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0); vec3 dir = vp.xyz / vp.w;
        vec3 viewP = dir * (min(z, 3000.0) / -dir.z);
        vec4 wp = uCamWorld * vec4(viewP, 1.0);
        vec4 pp = uPrevVP * wp; vec2 prevUv = pp.xy / pp.w * 0.5 + 0.5;
        vec2 vel = (vUv - prevUv) * uShutter;
        float len = length(vel); if (len > uMaxLen) vel *= uMaxLen / len;
        if (len < 0.0006){ gl_FragColor = texture2D(tColor, vUv); return; }
        float j = sp_ign(gl_FragCoord.xy) - 0.5;
        vec3 acc = vec3(0.0); const int N = 10;
        for (int i = 0; i < N; i++){ float t = (float(i) + 0.5 + j) / float(N) - 0.5; acc += texture2D(tColor, vUv - vel * t).rgb; }
        gl_FragColor = vec4(acc / float(N), 1.0);
      }`, { tColor: { value: null }, tLin: U.uLinDepth, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() }, uShutter: { value: 0.5 }, uMaxLen: { value: 0.06 } });
  }
  render(r, writeBuffer, readBuffer) {
    const u = this.mat.uniforms; u.tColor.value = readBuffer.texture;
    u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    u.uPrevVP.value.copy(POST.cut ? POST.curViewProj : POST.prevViewProj);
    u.uShutter.value = POST.grade.shutter;
    blit(this.mat, this.renderToScreen ? null : writeBuffer);
  }
}

// Anamorphic streak: bright pass squeezed vertically, blurred horizontally; added in the final grade.
class StreakPass extends Pass {
  constructor() {
    super(); this.needsSwap = false;
    this.a = makeRT(4, 4); this.b = makeRT(4, 4);
    this.bright = fsMat(/* glsl */ `varying vec2 vUv; uniform sampler2D tColor; uniform float uThresh;
      void main(){ vec3 c = texture2D(tColor, vUv).rgb; float l = sp_luma(c); gl_FragColor = vec4(c * smoothstep(uThresh, uThresh * 2.5, l), 1.0); }`,
    { tColor: { value: null }, uThresh: { value: 3 } });
    this.blur = fsMat(/* glsl */ `varying vec2 vUv; uniform sampler2D tSrc; uniform float uStep; uniform vec2 uTexel;
      void main(){ vec3 s = vec3(0.0); float w = 0.0; for (int i = -4; i <= 4; i++){ float k = exp(-float(i * i) / 8.0); s += texture2D(tSrc, vUv + vec2(float(i) * uStep * uTexel.x, 0.0)).rgb * k; w += k; } gl_FragColor = vec4(s / w, 1.0); }`,
    { tSrc: { value: null }, uStep: { value: 1 }, uTexel: { value: new THREE.Vector2() } });
  }
  setSize(w, h) { const sw = Math.max(8, w >> 2), sh = Math.max(8, h >> 3); this.a.setSize(sw, sh); this.b.setSize(sw, sh); }
  render(r, writeBuffer, readBuffer) {
    this.bright.uniforms.tColor.value = readBuffer.texture; blit(this.bright, this.a);
    const u = this.blur.uniforms; u.uTexel.value.set(1 / this.a.width, 1 / this.a.height);
    let src = this.a, dst = this.b;
    for (const st of [1, 3, 9, 20]) { u.tSrc.value = src.texture; u.uStep.value = st; blit(this.blur, dst); const t = src; src = dst; dst = t; }
    POST.streakTex = src.texture;
  }
}

const GLSL_ACES = /* glsl */ `
vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 acesFilmic(vec3 c){
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = IN * c; c = RRTAndODTFit(c); c = OUT * c; return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;
class FinalPass extends Pass {
  constructor() {
    super();
    this.mat = fsMat(GLSL_ACES + /* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor, tStreak, tDrops; uniform float uStreak, uExposure, uContrast, uSat, uTemp, uTint, uVig, uGrain, uCA, uBar, uFade, uFlash, uTime, uAspect, uDrops;
      uniform vec3 uLift, uGain, uFlashColor; uniform vec2 uRes;
      vec3 wb(vec3 c, float temp, float tint){ return c * vec3(1.0 + temp * 0.18 - tint * 0.05, 1.0 + tint * 0.08, 1.0 - temp * 0.2 - tint * 0.05); }
      void main(){
        vec2 uv = vUv;
        // lens water droplets (refractive), from the water whip
        if (uDrops > 0.001){
          vec4 dr = texture2D(tDrops, uv);
          uv += (dr.xy - 0.5) * 0.06 * dr.z * uDrops;
        }
        vec2 d = uv - 0.5; d.x *= uAspect;
        vec3 col;
        if (uCA > 0.0001){
          vec2 o = (uv - 0.5) * uCA * (0.4 + dot(d, d));
          col = vec3(texture2D(tColor, uv - o).r, texture2D(tColor, uv).g, texture2D(tColor, uv + o).b);
        } else col = texture2D(tColor, uv).rgb;
        col += texture2D(tStreak, uv).rgb * uStreak * vec3(0.55, 0.75, 1.25);
        col = wb(col, uTemp, uTint) * uExposure;
        col = acesFilmic(col / 0.6);
        // grade in display-referred space
        col = pow(max(col, 0.0), vec3(1.0 / 2.2));
        col = col * uGain + uLift * (1.0 - col);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSat);
        col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
        col = pow(col, vec3(2.2));
        float v = 1.0 - uVig * smoothstep(0.25, 1.05, length(d * vec2(0.9, 1.0)));
        col *= v;
        col = mix(col, uFlashColor, uFlash);
        col *= 1.0 - uFade;
        // film grain: luminance-weighted, temporally varying
        float g = sp_hash12(gl_FragCoord.xy + fract(uTime * 13.7) * 511.0) + sp_hash12(gl_FragCoord.xy * 1.37 + fract(uTime * 7.1) * 311.0) - 1.0;
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += g * uGrain * (0.25 + 0.75 * sqrt(max(lum, 0.0))) * 0.35;
        col = toSRGB(max(col, 0.0));
        col += (sp_hash12(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
        // anamorphic letterbox
        if (vUv.y < uBar || vUv.y > 1.0 - uBar) col = vec3(0.0);
        gl_FragColor = vec4(col, 1.0);
      }`, {
      tColor: { value: null }, tStreak: { value: null }, tDrops: { value: null }, uStreak: { value: 0 }, uExposure: { value: 1 }, uContrast: { value: 1 }, uSat: { value: 1 },
      uTemp: { value: 0 }, uTint: { value: 0 }, uVig: { value: 0.3 }, uGrain: { value: 0.05 }, uCA: { value: 0 }, uBar: { value: 0 }, uFade: { value: 0 },
      uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uTime: U.uRealTime, uAspect: { value: 1 }, uDrops: { value: 0 },
      uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uRes: { value: new THREE.Vector2() },
    });
  }
  render(r, writeBuffer, readBuffer) {
    const u = this.mat.uniforms, g = POST.grade;
    u.tColor.value = readBuffer.texture; u.tStreak.value = POST.streakTex || blackTex; u.uStreak.value = Q.streak ? g.streak : 0;
    u.tDrops.value = POST.dropsTex || blackTex; u.uDrops.value = g.drops;
    u.uExposure.value = g.exposure; u.uContrast.value = g.contrast; u.uSat.value = g.saturation; u.uTemp.value = g.temp; u.uTint.value = g.tint;
    u.uVig.value = g.vignette; u.uGrain.value = g.grain; u.uCA.value = REDUCED_MOTION ? 0 : g.ca; u.uBar.value = g.letterbox; u.uFade.value = g.fade;
    u.uFlash.value = REDUCED_MOTION ? Math.min(g.flash, 0.25) : g.flash; u.uFlashColor.value.copy(g.flashColor);
    u.uLift.value.copy(g.lift); u.uGain.value.copy(g.gain); u.uAspect.value = VIEW.aspect;
    blit(this.mat, this.renderToScreen ? null : writeBuffer);
  }
}
const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blackTex.needsUpdate = true;

function initPost() {
  const w = VIEW.rw, h = VIEW.rh;
  POST.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
    samples: Math.min(Q.msaa, CAPS.maxSamples), minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  POST.sceneRT.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  POST.linDepthRT = makeRT(w, h, { type: SIM_TYPE, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  U.uLinDepth.value = POST.linDepthRT.texture;
  POST.aoRT = makeRT(w >> 1, h >> 1, { format: THREE.RGFormat }); POST.aoTmpRT = makeRT(w >> 1, h >> 1, { format: THREE.RGFormat });
  POST.sceneCopyRT = makeRT(w, h); U.uSceneCopy.value = POST.sceneCopyRT.texture;
  POST.distortRT = makeRT(w >> 1, h >> 1);
  POST.aoEnabled = true;

  POST.composer = new EffectComposer(renderer, makeRT(w, h));
  POST.composer.setPixelRatio(1);
  POST.scenePass = new ScenePass();
  POST.distortPass = new DistortPass();
  POST.dofPass = new DOFPass();
  POST.mblurPass = new MotionBlurPass();
  POST.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.55, 1.6);
  POST.bloomPass.highPassUniforms.smoothWidth.value = 1.2;
  POST.streakPass = new StreakPass();
  POST.finalPass = new FinalPass();
  for (const p of [POST.scenePass, POST.distortPass, POST.dofPass, POST.mblurPass, POST.bloomPass, POST.streakPass, POST.finalPass]) POST.composer.addPass(p);
}

function resizePost(w, h) {
  POST.sceneRT.setSize(w, h);
  POST.sceneRT.depthTexture.image.width = w; POST.sceneRT.depthTexture.image.height = h;
  POST.linDepthRT.setSize(w, h); POST.aoRT.setSize(w >> 1, h >> 1); POST.aoTmpRT.setSize(w >> 1, h >> 1);
  POST.sceneCopyRT.setSize(w, h); POST.distortRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  POST.composer.setSize(w, h);
  U.uResolution.value.set(w, h);
  resizeClouds(w, h);
  if (typeof resizeWaterSSF === 'function') resizeWaterSSF(w, h);
}

function updatePostFlags() {
  const g = POST.grade;
  POST.dofPass.enabled = Q.dof && g.aperture > 0.002;
  POST.mblurPass.enabled = Q.mblur && g.shutter > 0.01;
  POST.streakPass.enabled = Q.streak && g.streak > 0.01;
  POST.bloomPass.strength = g.bloom; POST.bloomPass.threshold = g.bloomThreshold; POST.bloomPass.radius = 0.55;
}

function renderFrame() {
  camera.updateMatrixWorld();
  POST.curViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  updatePostFlags();
  POST.composer.render(0);
  POST.prevViewProj.copy(POST.curViewProj);
  POST.cut = false;
}
