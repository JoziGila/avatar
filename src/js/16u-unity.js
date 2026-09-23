// §16u UNITY — four interlocking rings (water, stone, flame, wind) orbit the hovering figure, are
// drawn in and compressed to a blinding point between the palms, a held silence, then a spherical
// shockwave with a refractive edge blasts the cloud sea away under the stars.
const UNITY = {
  t: { form: [58.2, 58.7, 59.2, 59.7], compress: 63.45, point: 64.95, release: 65.05, fade: 68.7 },
  rings: [], stones: null, windRing: null, sphere: null, rim: null, shockR: 0,
};
// ring planes: normals in the figure frame, tilted like the hoops of an armillary sphere
const RING_DEFS = [
  { el: 'water', r: 1.15, tilt: [72, 0], speed: 1.4, color: [0.5, 0.8, 1.0] },
  { el: 'stone', r: 1.35, tilt: [-60, 55], speed: -0.8, color: [0.8, 0.7, 0.55] },
  { el: 'fire', r: 1.25, tilt: [18, -62], speed: 1.9, color: [1.0, 0.5, 0.15] },
  { el: 'air', r: 1.5, tilt: [-24, 118], speed: -2.3, color: [0.85, 0.9, 1.0] },
];
const _uq = new THREE.Quaternion(), _ue = new THREE.Euler(), _un = V3(), _ut = V3(), _ub = V3(), _up = V3();
function ringFrame(i, T, out) {
  const d = RING_DEFS[i];
  const prec = T * 0.25 + i * 1.3;   // the hoops precess slowly round the vertical
  _ue.set(d.tilt[0] * DEG, (d.tilt[1] * DEG) + prec, 0, 'YXZ'); _uq.setFromEuler(_ue);
  out.n = (out.n || V3()).set(0, 1, 0).applyQuaternion(_uq);
  out.t = (out.t || V3()).set(1, 0, 0).applyQuaternion(_uq);
  out.b = (out.b || V3()).crossVectors(out.n, out.t);
  return out;
}
function ringPoint(F, c, R, a, out) { return out.copy(c).addScaledVector(F.t, Math.cos(a) * R).addScaledVector(F.b, Math.sin(a) * R); }

function initUnity() {
  // stone hoop: tumbling granite chunks (instanced)
  const geo = chunkGeometry(61, 1, 0.8, 0.9, 1);
  UNITY.stones = new THREE.InstancedMesh(geo, WORLD.stoneMat, 18); UNITY.stones.castShadow = true; UNITY.stones.frustumCulled = false; UNITY.stones.visible = false;
  UNITY.stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage); world.add(UNITY.stones);
  // wind hoop: a thin torus of scrolling streaks (additive)
  const tg = new THREE.TorusGeometry(1, 0.05, 6, 160);
  const windMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uAmt: { value: 0 }, uAmbCube: U.uAmbCube, uLinDepth: U.uLinDepth, uWaterDepth: U.uWaterDepth, uResolution: U.uResolution, uSoft: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying float vViewZ; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GLSL_COMMON + SOFT_FRAG + /* glsl */ `uniform float uTime, uAmt; uniform sampler2D uAmbCube; varying vec2 vUv; varying float vViewZ;
      void main(){
        float a = vUv.x * 160.0; float lane = floor(vUv.y * 5.0);
        float s = sp_vnoise2(vec2(a * 0.18 - uTime * 9.0 * (1.0 + lane * 0.2), lane * 7.3));
        float streak = smoothstep(0.55, 0.9, s) * (1.0 - abs(vUv.y * 2.0 - 1.0));
        vec3 sky = texelFetch(uAmbCube, ivec2(2, 0), 0).rgb;
        gl_FragColor = vec4((sky * 3.0 + vec3(0.35, 0.4, 0.5)) * streak * uAmt * softFade(vViewZ, 0.2), 0.0);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  UNITY.windRing = new THREE.Mesh(tg, windMat); UNITY.windRing.frustumCulled = false; UNITY.windRing.renderOrder = 29; UNITY.windRing.visible = false; fxScene.add(UNITY.windRing);
  // the shockwave: a refracting shell (distortion target) and a faint glowing rim (scene)
  const sg = new THREE.IcosahedronGeometry(1, 5);
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 } },
    vertexShader: /* glsl */ `varying vec3 vN, vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uAmt; varying vec3 vN, vV;
      void main(){ float f = 1.0 - abs(dot(vN, vV)); float edge = pow(f, 4.0);
        gl_FragColor = vec4(vN.xy * edge * 0.09 * uAmt, edge * uAmt * 0.6, 0.0); }`,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  UNITY.sphere = new THREE.Mesh(sg, shellMat); UNITY.sphere.frustumCulled = false; UNITY.sphere.visible = false; distortScene.add(UNITY.sphere);
  const rimMat = new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uHeat: { value: 1 } },
    vertexShader: /* glsl */ `varying vec3 vN, vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uAmt, uHeat; varying vec3 vN, vV;
      void main(){ float f = 1.0 - abs(dot(vN, vV)); float rim = pow(f, 6.0) * 1.5 + pow(f, 2.0) * 0.04;
        vec3 c = mix(vec3(0.55, 0.75, 1.0), vec3(1.0, 0.8, 0.5), uHeat);
        gl_FragColor = vec4(c * rim * uAmt, 0.0); }`,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  UNITY.rim = new THREE.Mesh(sg, rimMat); UNITY.rim.frustumCulled = false; UNITY.rim.visible = false; UNITY.rim.renderOrder = 35; fxScene.add(UNITY.rim);
  for (let i = 0; i < 4; i++) UNITY.rings.push({});
}

function updateUnity(T, dt) {
  const t = UNITY.t;
  const palms = FIG.palms, chest = _up.copy(FIG.p.upperChest).lerp(FIG.p.hips, 0.35);
  const before = T < t.release;
  // compression: every hoop is drawn into the point between the palms
  const comp = Ease.inCubic(clamp((T - t.compress) / (t.point - t.compress)));
  const centre = V3().copy(chest).lerp(palms, smoothstep(t.compress - 0.3, t.compress + 0.6, T));
  UNITY.stones.visible = false; UNITY.windRing.visible = false;
  for (let i = 0; i < 4; i++) {
    const d = RING_DEFS[i];
    const grow = Ease.outBack(clamp((T - t.form[i]) / 0.9));
    const alive = before && T >= t.form[i];
    if (!alive) continue;
    const F = ringFrame(i, T, UNITY.rings[i]);
    const R = d.r * grow * (1 - comp * 0.985);
    const spin = d.speed * (1 + comp * 6);
    const phase = T * spin;
    if (d.el === 'water') {
      const n = 72;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + phase;
        const pulse = 0.055 + 0.02 * Math.sin(a * 3 - T * 5);
        ssfBlob(ringPoint(F, centre, R, a, _v1), pulse * (1 - comp * 0.7) * Math.min(1, grow + 0.2), 0.1);
      }
      if (dt > 0 && Math.random() < dt * 20 * (1 - comp)) PS.debris.emit({ count: 2, scale: 1, pos: ringPoint(F, centre, R, Math.random() * TAU, _v1), radius: 0.03, vel: _v2.copy(F.t).multiplyScalar(0), spread: 0.4, life: [0.6, 1.2], size: [0.005, 0.01], kind: 1 });
    } else if (d.el === 'stone') {
      const n = 16, m = UNITY.stones; m.visible = true;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + phase;
        ringPoint(F, centre, R, a, _v1);
        _ue.set(T * (1.3 + k * 0.1) + k, T * (0.9 + k * 0.07), k * 0.7); _uq.setFromEuler(_ue);
        const s = (0.05 + 0.035 * ((k * 7) % 5) / 4) * Math.min(1, grow) * (1 - comp * 0.9);
        _m1.compose(_v1, _uq, _v2.set(s, s, s)); m.setMatrixAt(k, _m1);
      }
      m.count = n; m.instanceMatrix.needsUpdate = true;
    } else if (d.el === 'fire') {
      if (dt > 0) {
        const n = Math.round(12 + comp * 12);
        for (let k = 0; k < n; k++) {
          const a = Math.random() * TAU;
          ringPoint(F, centre, R, a, _v1);
          _v2.copy(F.t).multiplyScalar(-Math.sin(a)).addScaledVector(F.b, Math.cos(a)).multiplyScalar(R * spin);   // tangential
          PS.fire.emit({ count: 55 * dt * Math.min(1, grow), pos: _v1, radius: 0.03, vel: _v2, spread: 0.2, life: [0.18, 0.34], size: [0.03, 0.06], kind: k % 4 === 0 ? 3 : 0, param: 0.9 });
        }
      }
    } else {
      const w = UNITY.windRing; w.visible = true;
      w.position.copy(centre); w.scale.setScalar(Math.max(R, 0.01));
      w.quaternion.setFromUnitVectors(_v3.set(0, 0, 1), F.n);
      w.rotateZ(phase);
      w.material.uniforms.uAmt.value = Math.min(1, grow) * (1 - comp * 0.3);
      if (R > 0.2) for (let k = 0; k < 3; k++) distortSprite(ringPoint(F, centre, R, phase * 1.5 + k * 2.09, _v1), 0.25, 0.03, 0, 0, 0);
    }
  }
  // the point: grows to blinding, pulls everything in
  const pt = smoothstep(t.compress + 0.2, t.point, T) * (before ? 1 : 0);
  if (pt > 0) {
    const fl = 1 + 0.08 * Math.sin(T * 60);
    glow(palms, 0.03 + pt * 0.05, 30 * pt * pt * fl, 26 * pt * pt * fl, 18 * pt * pt * fl, 0.8);
    FIELD.attract.set(palms.x, palms.y, palms.z, 6 * pt);
    distortSprite(palms, 0.5 + pt * 0.6, 0.05 * pt, 2, 0, 0);
  } else FIELD.attract.w = 0;
  // release: the shell races outward; the clouds are shoved away by CLOUD.blast (§20)
  const st = T - t.release;
  if (st >= 0 && st < 3.5) {
    const k = Ease.outCubic(clamp(st / 1.7));
    const R = 0.3 + 170 * k;
    UNITY.shockR = R;
    const fade = 1 - smoothstep(0.9, 2.6, st);
    for (const m of [UNITY.sphere, UNITY.rim]) { m.visible = fade > 0.001; m.position.copy(FIG.palms); m.scale.setScalar(R); }
    UNITY.sphere.material.uniforms.uAmt.value = fade;
    UNITY.rim.material.uniforms.uAmt.value = fade * (1 - smoothstep(0, 2.2, st) * 0.7) * 1.6;
    UNITY.rim.material.uniforms.uHeat.value = 1 - smoothstep(0, 0.6, st);
    FIELD.shock.set(FIG.palms.x, FIG.palms.y, FIG.palms.z, R); FIELD.shock2.set(1.2 + R * 0.05, 30 * fade, 0, 0);
    WIND.blasts.length = 0; WIND.blasts.push({ c: FIG.palms.clone(), r: R, w: 1.5 + R * 0.1, amt: 16 * fade });
  } else { UNITY.sphere.visible = UNITY.rim.visible = false; if (st >= 3.5 || st < 0) { WIND.blasts.length = 0; if (st < 0) FIELD.shock2.y = Math.min(FIELD.shock2.y, 0); } }
  // afterwards: motes of all four elements drift down around the descending figure
  if (st > 0.3 && T < t.fade + 0.8 && dt > 0) {
    const c = FIG.p.hips; const k = 1 - smoothstep(66.5, 69, T);
    PS.fire.emit({ count: 20 * k * dt, pos: _v1.set(c.x, c.y + 2.5, c.z), radius: 3, vel: V3(0, -0.2, 0), spread: 0.3, life: [3, 5], size: [0.004, 0.007], kind: 1, param: 0.5 });
    PS.debris.emit({ count: 30 * k * dt, pos: _v1.set(c.x, c.y + 3, c.z), radius: 3, vel: V3(0, -0.3, 0), spread: 0.3, life: [3, 5], size: [0.004, 0.008], kind: 3 });
    PS.debris.emit({ count: 5 * k * dt, pos: _v1.set(c.x, c.y + 3, c.z), radius: 3, vel: V3(0, -0.2, 0), spread: 0.3, life: [4, 6], size: [0.025, 0.04], kind: 2 });
  }
}
function unityRelease(ctx) {
  if (ctx.skipped) return;
  flashFrame(REDUCED_MOTION ? 0.25 : 0.85, 1.0, 0.97, 0.92);
  hitStop(4); addTrauma(0.7);
  const p = FIG.palms;
  for (const k of [0, 3]) PS.fire.emit({ count: 300, pos: p, radius: 0.1, vel: V3(0, 0, 0), spread: 9, life: [0.3, 0.8], size: [0.03, 0.08], kind: k, param: 1 });
  PS.debris.emit({ count: 500, pos: p, radius: 0.1, vel: V3(0, 0, 0), spread: 8, life: [1, 2.2], size: [0.004, 0.01], kind: 3 });
  PS.debris.emit({ count: 200, pos: p, radius: 0.1, vel: V3(0, 0, 0), spread: 10, life: [0.6, 1.2], size: [0.1, 0.2], kind: 4, param: 1 });
  sfx('release', { pos: p, gain: 1 });
}

fxModule({
  init() {
    initUnity();
    const t = UNITY.t;
    t.form.forEach((tt, i) => at(tt, () => sfx('ringForm', { gain: 0.7, pitch: 0.8 + i * 0.15, el: RING_DEFS[i].el }), 'ring ' + i));
    at(t.compress, () => sfx('compress', { gain: 0.9, dur: t.point - t.compress }), 'compress');
    at(t.release, (ctx) => unityRelease(ctx), 'release');
    at(68.05, (ctx) => { if (ctx.skipped) return; const c = FIG.p.hips; PS.smoke.emit({ count: 26, pos: V3(c.x, groundHeight(c.x, c.z) + 0.05, c.z), radius: 0.3, mode: 2, normal: V3(0, 1, 0), vel: V3(0, 0.1, 0), spread: 1.8, life: [1.2, 2.2], size: [0.12, 0.22], kind: 1, param: 0.3 }); sfx('land', { gain: 0.6 }); }, 'land');
  },
  reset() { UNITY.stones.visible = false; UNITY.windRing.visible = false; UNITY.sphere.visible = UNITY.rim.visible = false; FIELD.attract.w = 0; WIND.blasts.length = 0; },
  update(T, dt) { if (TL.mode === 'cinematic') updateUnity(T, dt); },
  lights() {
    const T = TL.T, t = UNITY.t;
    if (TL.mode !== 'cinematic') return;
    const ringsOn = T > t.form[0] && T < t.release;
    if (ringsOn) {
      const c = _v1.copy(FIG.p.upperChest);
      requestLight(c, FIRE_COL, 1.2 * smoothstep(t.form[2], t.form[2] + 0.8, T), 3, 10);
      _c1.setRGB(0.55, 0.75, 1.0); requestLight(c.add(_v2.set(0, 0.4, 0)), _c1, 0.8 * smoothstep(t.form[0], t.form[0] + 0.8, T), 2, 10);
    }
    const pt = smoothstep(t.compress + 0.2, t.point, T) * (T < t.release ? 1 : 0);
    if (pt > 0) { _c1.setRGB(1.0, 0.9, 0.75); requestLight(FIG.palms, _c1, 14 * pt * pt, 10, 14); }
    const st = T - t.release;
    if (st >= 0 && st < 1.2) { _c1.setRGB(1.0, 0.95, 0.88); requestLight(FIG.palms, _c1, 40 * (1 - st / 1.2), 10, 60); }
  },
});
