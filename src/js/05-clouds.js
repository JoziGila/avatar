// §5 VOLUMETRIC CLOUD SEA ------------------------------------------------------
// Raymarched height-field volume under the summit, rendered at reduced resolution
// with blue-noise jitter and composited with depth awareness. Uniforms drive the
// Act V spiral parting and the Act VI blast front.
const CLOUD = {
  top: -54, bottom: -150, density: 0.055,
  spiral: 0, spiralPhase: 0, blast: 0, blastR: 0, wind: V3(3.2, 0, -1.1), offset: V3(0, 0, 0),
};
let cloudRT, cloudMat, cloudCompMat;

function initClouds() {
  cloudRT = makeRT(4, 4, { type: THREE.HalfFloatType });
  cloudMat = fsMat(/* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uLinDepth, uSkyTex; uniform highp sampler3D uNoise;
    uniform mat4 uInvProjView; uniform vec3 uCamPos;
    uniform vec3 uKeyDir, uKeyColor, uSkyZenith, uSkyHorizon, uSunDir;
    uniform float uTop, uBottom, uDensity, uTime, uSpiral, uSpiralPhase, uBlastR, uBlast, uFrame;
    uniform vec3 uOffset; uniform int uSteps, uLightSteps; uniform vec2 uLowRes;
    float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * SP_PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
    float topAt(vec3 p){
      vec3 w = p + uOffset;
      float big = texture(uNoise, w * vec3(0.0011, 0.0009, 0.0011)).r;
      float mid = texture(uNoise, w * vec3(0.0048, 0.004, 0.0048) + 0.37).r;
      float sml = texture(uNoise, w * vec3(0.019, 0.012, 0.019) + 0.71).r;
      float top = uTop - pow(1.0 - big, 1.4) * 46.0 - (1.0 - mid) * 16.0 - (1.0 - sml) * 6.0;
      float r = length(p.xz); float th = atan(p.z, p.x);
      // Act V: vast spiral parting around the mountain
      if (uSpiral > 0.001){
        float arms = sin(3.0 * th + r * 0.0085 - uSpiralPhase);
        float armCut = smoothstep(-0.1, 0.85, arms) * smoothstep(1400.0, 250.0, r) * smoothstep(40.0, 160.0, r);
        float eye = smoothstep(230.0, 70.0, r);
        top -= uSpiral * (armCut * 60.0 + eye * 90.0);
        top += uSpiral * 10.0 * exp(-pow((arms - 0.95) * 2.5, 2.0)) * smoothstep(1400.0, 300.0, r); // ridged lips
      }
      // Act VI: blast front shoves the sea outward, clearing a vast bowl
      if (uBlast > 0.001){
        float inside = smoothstep(uBlastR, uBlastR - 260.0, r);
        top -= uBlast * inside * 120.0;
        top += uBlast * 22.0 * exp(-pow((r - uBlastR) / 90.0, 2.0));
      }
      return top;
    }
    float densityAt(vec3 p, bool detail){
      float top = topAt(p);
      float d = clamp((top - p.y) / 16.0, 0.0, 1.0);
      if (d <= 0.0) return 0.0;
      if (detail){
        vec3 w = p + uOffset * 1.6;
        vec4 n = texture(uNoise, w * 0.024 + vec3(0.0, uTime * 0.004, 0.0));
        float det = n.g * 0.65 + n.b * 0.35;
        d = d - (1.0 - det) * 0.55 * (1.0 - d);
      }
      return max(d, 0.0) * uDensity;
    }
    void main(){
      vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec4 wp = uInvProjView * ndc; vec3 rd = normalize(wp.xyz / wp.w - uCamPos); vec3 ro = uCamPos;
      float sceneDist = texture2D(uLinDepth, vUv).r; // linear view depth
      // convert view depth to ray distance
      vec4 fwdW = uInvProjView * vec4(0.0, 0.0, 1.0, 1.0); vec3 fwd = normalize(fwdW.xyz / fwdW.w - uCamPos);
      float rayScene = sceneDist / max(dot(rd, fwd), 0.05);
      float yMax = uTop + 30.0, yMin = uBottom;
      // slab intersection
      float t0 = 0.0, t1 = 7000.0;
      if (abs(rd.y) > 1e-4){
        float ta = (yMax - ro.y) / rd.y, tb = (yMin - ro.y) / rd.y;
        t0 = max(min(ta, tb), 0.0); t1 = min(max(ta, tb), 7000.0);
      } else if (ro.y > yMax || ro.y < yMin) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      t1 = min(t1, rayScene);
      if (t1 <= t0){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float jitter = sp_ign(gl_FragCoord.xy + uFrame * 5.588238);
      float T = 1.0; vec3 L = vec3(0.0);
      float mu = dot(rd, uKeyDir);
      float phase = mix(hg(mu, 0.65), hg(mu, -0.2), 0.3) * 4.0 * SP_PI;
      vec3 amb = mix(uSkyHorizon, uSkyZenith, 0.65) * 0.8;
      float t = t0; float dist = t1 - t0;
      float baseStep = max(dist / float(uSteps), 1.5);
      t += baseStep * jitter;
      float wsum = 0.0, dsum = 0.0;
      for (int i = 0; i < 96; i++){
        if (i >= uSteps || t > t1 || T < 0.015) break;
        vec3 p = ro + rd * t;
        float stepLen = baseStep * (1.0 + t * 0.0004);
        float dens = densityAt(p, true);
        if (dens > 0.0005){
          // light march toward the key light
          float od = 0.0; float ls = 7.0; float lt = 0.0;
          for (int j = 0; j < 6; j++){ if (j >= uLightSteps) break; lt += ls; vec3 lp = p + uKeyDir * (lt - ls * 0.5); od += densityAt(lp, false) * ls; ls *= 2.6; }
          float Tl = max(exp(-od), exp(-od * 0.25) * 0.55) ;
          float powder = 1.0 - exp(-dens * 30.0);
          float topFrac = clamp((topAt(p) - p.y) / 40.0, 0.0, 1.0);
          vec3 S = uKeyColor * Tl * phase * mix(0.5, 1.0, powder) + amb * (0.75 - 0.6 * topFrac);
          float sigma = dens;
          float Ts = exp(-sigma * stepLen);
          vec3 Sint = S * (1.0 - Ts);
          L += T * Sint;
          wsum += T * (1.0 - Ts); dsum += T * (1.0 - Ts) * t;
          T *= Ts;
        }
        t += stepLen;
      }
      // below the sea: a dark haze floor where the clouds have been torn away
      if (T > 0.015 && t >= t1 - 0.5 && t1 < rayScene - 1.0 && rd.y < 0.0){
        vec3 floorCol = mix(uSkyZenith * 0.25, uSkyHorizon * 0.2, 0.5);
        L += T * floorCol; T = 0.0;
      }
      // aerial perspective on the cloud surface
      float avgD = wsum > 0.0 ? dsum / wsum : t1;
      vec3 hz = texture2D(uSkyTex, sp_equirectUV(normalize(vec3(rd.x, max(rd.y, 0.01), rd.z)))).rgb;
      float fogK = 1.0 - exp(-avgD / 5200.0);
      L = mix(L, hz * (1.0 - T), fogK);
      gl_FragColor = vec4(L, T);
    }`, {
    uLinDepth: U.uLinDepth, uSkyTex: U.uSkyTex, uNoise: { value: null },
    uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    uKeyDir: U.uKeyDir, uKeyColor: U.uKeyColor, uSkyZenith: U.uSkyZenith, uSkyHorizon: U.uSkyHorizon, uSunDir: U.uSunDir,
    uTop: { value: CLOUD.top }, uBottom: { value: CLOUD.bottom }, uDensity: { value: CLOUD.density }, uTime: U.uRealTime,
    uSpiral: { value: 0 }, uSpiralPhase: { value: 0 }, uBlastR: { value: 0 }, uBlast: { value: 0 }, uFrame: { value: 0 },
    uOffset: { value: CLOUD.offset }, uSteps: { value: 40 }, uLightSteps: { value: 3 }, uLowRes: { value: new THREE.Vector2() },
  });

  // Depth-aware upsample + composite (premultiplied light, transmittance in alpha)
  cloudCompMat = fsMat(/* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uCloud, uLinDepth; uniform mat4 uInvProjView; uniform vec3 uCamPos; uniform float uYMax; uniform vec2 uLowRes;
    void main(){
      vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec4 wp = uInvProjView * ndc; vec3 rd = normalize(wp.xyz / wp.w - uCamPos);
      vec4 fwdW = uInvProjView * vec4(0.0, 0.0, 1.0, 1.0); vec3 fwd = normalize(fwdW.xyz / fwdW.w - uCamPos);
      float d = texture2D(uLinDepth, vUv).r / max(dot(rd, fwd), 0.05);
      float tEnter = rd.y < -1e-4 ? (uYMax - uCamPos.y) / rd.y : 1e9;
      if (uCamPos.y < uYMax) tEnter = 0.0;
      if (d < tEnter){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      // 4-tap tent upsample
      vec2 px = 1.0 / uLowRes;
      vec4 c = texture2D(uCloud, vUv) * 0.4;
      c += texture2D(uCloud, vUv + vec2(px.x, px.y) * 0.5) * 0.15;
      c += texture2D(uCloud, vUv + vec2(-px.x, px.y) * 0.5) * 0.15;
      c += texture2D(uCloud, vUv + vec2(px.x, -px.y) * 0.5) * 0.15;
      c += texture2D(uCloud, vUv + vec2(-px.x, -px.y) * 0.5) * 0.15;
      gl_FragColor = c;
    }`, {
    uCloud: { value: null }, uLinDepth: U.uLinDepth, uInvProjView: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
    uYMax: { value: CLOUD.top + 30 }, uLowRes: { value: new THREE.Vector2(1, 1) },
  }, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, transparent: true });
}

function resizeClouds(rw, rh) {
  const s = Q.cloudRes;
  cloudRT.setSize(Math.max(8, Math.round(rw * s)), Math.max(8, Math.round(rh * s)));
  cloudMat.uniforms.uLowRes.value.set(cloudRT.width, cloudRT.height);
  cloudCompMat.uniforms.uLowRes.value.set(cloudRT.width, cloudRT.height);
}

let _cloudFrame = 0;
function renderClouds(cam, target) {
  _cloudFrame++;
  const u = cloudMat.uniforms;
  _ipv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
  u.uInvProjView.value.copy(_ipv); u.uCamPos.value.copy(cam.position);
  u.uNoise.value = TEX.cloudNoise;
  u.uTop.value = CLOUD.top; u.uBottom.value = CLOUD.bottom; u.uDensity.value = CLOUD.density;
  u.uSpiral.value = CLOUD.spiral; u.uSpiralPhase.value = CLOUD.spiralPhase; u.uBlast.value = CLOUD.blast; u.uBlastR.value = CLOUD.blastR;
  u.uFrame.value = _cloudFrame % 64; u.uSteps.value = Q.cloudSteps; u.uLightSteps.value = Q.cloudLight;
  blit(cloudMat, cloudRT);
  const c = cloudCompMat.uniforms;
  c.uCloud.value = cloudRT.texture; c.uInvProjView.value.copy(_ipv); c.uCamPos.value.copy(cam.position); c.uYMax.value = CLOUD.top + 30;
  blit(cloudCompMat, target);
}
