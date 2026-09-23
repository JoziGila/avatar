// §12 FX CORE — shared particle systems, glow & distortion sprites, rigid chunks, figure probes --
// Element modules register with fxModule({ update(T, dt), reset(), lights() }). Everything a
// module shows is derived from the timeline T where possible (so scrubbing is exact); bursts
// fire from timeline events and are re-simulated by the seek pre-roll.
const FXS = { list: [] };
function fxModule(m) { FXS.list.push(m); return m; }
function sfx(name, o) { if (!TL.preroll && typeof playSfx === 'function') playSfx(name, o || {}); }
const PS = { fire: null, smoke: null, debris: null };

// ---- figure probes: world positions and velocities of the joints the elements follow ----------
const FIG = { names: ['head', 'upperChest', 'hips', 'hand_L', 'hand_R', 'forearm_L', 'forearm_R', 'foot_L', 'foot_R', 'toe_L', 'toe_R'], p: {}, v: {}, prev: {},
  palm_L: V3(), palm_R: V3(), palms: V3(), dirL: V3(), dirR: V3(), fwd: V3(0, 0, 1), side: V3(1, 0, 0), ok: false };
for (const n of FIG.names) { FIG.p[n] = V3(); FIG.v[n] = V3(); FIG.prev[n] = V3(); }
function probeFigure(dt) {
  const f = CHAR.fig; if (!f) return;
  for (const n of FIG.names) {
    const p = FIG.p[n]; FIG.prev[n].copy(p); f.anchor(n, p);
    if (dt > 0 && FIG.ok) FIG.v[n].copy(p).sub(FIG.prev[n]).divideScalar(dt); else FIG.v[n].set(0, 0, 0);
  }
  for (const s of ['L', 'R']) {
    const h = FIG.p['hand_' + s], fa = FIG.p['forearm_' + s], d = FIG['dir' + s];
    d.copy(h).sub(fa); if (d.lengthSq() < 1e-6) d.set(0, -1, 0); d.normalize();
    FIG['palm_' + s].copy(h).addScaledVector(d, 0.075);
  }
  FIG.palms.copy(FIG.palm_L).add(FIG.palm_R).multiplyScalar(0.5);
  const yaw = (CHAR.pose && CHAR.pose.yaw || 0) * DEG;
  FIG.fwd.set(Math.sin(yaw), 0, Math.cos(yaw)); FIG.side.set(FIG.fwd.z, 0, -FIG.fwd.x);
  FIG.ok = true;
}

// ---- particle behaviours ----------------------------------------------------------------------
// behave(kind, p, v, age, life, c, dt): c = (seed, size, kind, param). Integrate p here.
const ATTRACT_GLSL = /* glsl */ `
void attract(vec3 p, inout vec3 v, float dt, float k){
  if (uAttract.w > 0.0){ vec3 d = uAttract.xyz - p; float r = length(d) + 0.06; v += d / r * uAttract.w * k * dt / (0.25 + r * 0.6); v *= exp(-dt * uAttract.w * 0.08 * k); }
}`;
const FIRE_BEHAVE = ATTRACT_GLSL + /* glsl */ `
void behave(float kind, inout vec3 p, inout vec3 v, float age, float life, inout vec4 c, float dt){
  float t = age / life;
  vec3 w = windField(p);
  if (kind < 0.5 || kind > 2.5){            // flame / plasma: buoyant, turbulent, dragged into the air mass
    vec3 cu = curlAt(p * 0.55 + vec3(0.0, -uTime * 0.45, c.x * 7.0));
    float buoy = kind > 2.5 ? 1.2 : 3.2;
    v += (vec3(0.0, buoy * (0.25 + t), 0.0) + cu * 26.0 * (0.35 + t)) * dt;
    v += (w - v) * (1.0 - exp(-dt * (1.1 + 2.8 * t)));
  } else if (kind < 1.5){                   // ember: light, wandering, slowly settling
    vec3 cu = curlAt(p * 0.22 + vec3(uTime * 0.03, 0.0, c.x * 3.0));
    v += (vec3(0.0, 0.35 - 1.1 * t, 0.0) + cu * 16.0) * dt;
    v += (w * 1.15 - v) * (1.0 - exp(-dt * 0.8));
  } else {                                  // spark: ballistic
    v.y -= 9.8 * dt; v *= exp(-dt * 1.1);
  }
  attract(p, v, dt, 1.0);
  p += v * dt;
  float g = groundAt(p.xz);
  if (p.y < g + 0.02){ p.y = g + 0.02; v.y = abs(v.y) * 0.3; v.xz *= 0.55; }
}`;
const SMOKE_BEHAVE = ATTRACT_GLSL + /* glsl */ `
void behave(float kind, inout vec3 p, inout vec3 v, float age, float life, inout vec4 c, float dt){
  float t = age / life;
  vec3 w = windField(p);
  vec3 cu = curlAt(p * 0.28 + vec3(0.0, -uTime * 0.08, c.x * 5.0));
  if (kind < 0.5){ v += (vec3(0.0, 1.3 * (1.0 - t), 0.0) + cu * 7.0) * dt; v += (w - v) * (1.0 - exp(-dt * 1.3)); }           // smoke
  else if (kind < 1.5){ v += (vec3(0.0, -0.3, 0.0) + cu * 4.0) * dt; v += (w * 0.55 - v) * (1.0 - exp(-dt * 1.5)); }        // dust
  else if (kind < 2.5){ v += (vec3(0.0, -0.5, 0.0) + cu * 5.0) * dt; v += (w - v) * (1.0 - exp(-dt * 2.4)); }             // mist / spray
  else if (kind < 3.5){ v += (vec3(0.0, 1.8, 0.0) + cu * 6.0) * dt; v += (w - v) * (1.0 - exp(-dt * 1.7)); }              // steam
  else { v += cu * 3.0 * dt; v *= exp(-dt * 0.9); }                                                                        // blast haze
  attract(p, v, dt, 0.6);
  p += v * dt;
  float g = groundAt(p.xz); if (p.y < g + 0.04){ p.y = g + 0.04; v.y = max(v.y, 0.0); v.xz *= 0.97; }
}`;
const DEBRIS_BEHAVE = ATTRACT_GLSL + /* glsl */ `
void behave(float kind, inout vec3 p, inout vec3 v, float age, float life, inout vec4 c, float dt){
  vec3 w = windField(p);
  if (kind < 0.5 || (kind > 2.5 && kind < 3.5)){       // pebble / ice crystal: ballistic, bouncing, skittering
    v.y -= 9.8 * dt; v += (w - v) * (1.0 - exp(-dt * (kind < 0.5 ? 0.02 : 0.25)));
    attract(p, v, dt, 0.8);
    p += v * dt;
    float g = groundAt(p.xz) + c.y * 0.35;
    if (p.y < g){ p.y = g; if (v.y < 0.0) v.y = -v.y * (kind < 0.5 ? 0.32 : 0.12); v.xz *= kind < 0.5 ? 0.62 : 0.9; if (abs(v.y) < 0.25) v.y = 0.0; c.w += 0.001; }
  } else if (kind < 1.5){                               // droplet
    v.y -= 9.8 * dt; v += (w - v) * (1.0 - exp(-dt * 0.35));
    attract(p, v, dt, 1.0);
    p += v * dt;
    if (p.y < groundAt(p.xz)){ p.y = -1000.0; v = vec3(0.0); }
  } else if (kind < 2.5){                               // leaf / scrap: fluttering, strongly dragged
    vec3 cu = curlAt(p * 0.35 + vec3(c.x * 9.0, uTime * 0.15, 0.0));
    v.y -= 2.0 * dt;
    v += (w * 1.25 + cu * 7.0 - v) * (1.0 - exp(-dt * 2.0));
    v.y += sin(age * (3.0 + c.x * 4.0) + c.x * 20.0) * 1.8 * dt;
    attract(p, v, dt, 1.2);
    p += v * dt;
    float g = groundAt(p.xz) + 0.012; if (p.y < g){ p.y = g; v *= 0.25; }
  } else {                                              // streak: a massless tracer of the air
    vec3 cu = curlAt(p * 0.16 + vec3(0.0, uTime * 0.07, c.x));
    v += (w + cu * 4.0 - v) * (1.0 - exp(-dt * 5.0));
    attract(p, v, dt, 1.5);
    p += v * dt;
  }
}`;

// ---- particle render shaders ------------------------------------------------------------------
const FIRE_VERT = /* glsl */ `
uniform float uAspectFix;
void main(){
  vec4 a, b, c;
  if (!fetchParticle(a, b, c) || a.y < -500.0){ gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float t = a.w / b.w; vAge = t; vLife = b.w; vKind = c.z; vSeed = c.x; vParam = c.w;
  float size = c.y;
  vec4 mv = viewMatrix * vec4(a.xyz, 1.0);
  vec2 q = position.xy;
  if (c.z > 0.5 && c.z < 2.5){        // embers & sparks stretch along their screen motion
    vec3 vv = (viewMatrix * vec4(b.xyz, 0.0)).xyz; float sp = length(vv.xy);
    vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(1.0, 0.0);
    float len = size + sp * (c.z > 1.5 ? 0.018 : 0.009);
    q = vec2(q.x * len, q.y * size); q = vec2(dir.x * q.x - dir.y * q.y, dir.y * q.x + dir.x * q.y);
    mv.xy += q;
  } else {
    size *= c.z > 2.5 ? mix(1.0, 0.35, t) : mix(0.5, 1.45, sqrt(t));
    q = sp_rot(c.x * 6.2831 + a.w * (c.x - 0.5) * 1.6) * q;
    mv.xy += q * size;
  }
  vQ = position.xy; vViewZ = -mv.z; vWPos = a.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const FIRE_FRAG = /* glsl */ `
uniform highp sampler3D uNoise; uniform sampler2D uBB; uniform float uFireGain, uTime;
varying vec2 vQ; varying float vAge, vLife, vKind, vSeed, vParam, vViewZ; varying vec3 vWPos;
vec3 bb(float T){ vec4 b = texture2D(uBB, vec2(clamp((T - 600.0) / 3400.0, 0.0, 1.0), 0.5)); return b.rgb * b.a; }
void main(){
  float r2 = dot(vQ, vQ); if (r2 > 1.0) discard;
  float t = vAge; vec3 col; float alpha = 0.0;
  if (vKind < 0.5 || vKind > 2.5){
    vec3 np = vec3(vQ * 0.32 + vec2(vSeed * 5.3, vSeed * 2.1), t * 0.5 + vSeed * 3.7);
    float n = texture(uNoise, np).r * 0.65 + texture(uNoise, np * 2.3 + 0.3).g * 0.35;
    float r = sqrt(r2);
    float shape = smoothstep(1.0, 0.05, r + (n - 0.52) * 1.15); shape *= shape;
    float hot = vKind > 2.5 ? 3800.0 : 1350.0 + vParam * 900.0;
    float T = mix(hot, 780.0, pow(t, 0.55)) + (n - 0.5) * 420.0;
    float fade = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.5, 1.0, t));
    col = bb(T) * shape * fade * uFireGain * (vKind > 2.5 ? 0.35 : 1.0);
    alpha = shape * smoothstep(0.45, 1.0, t) * 0.22 * (1.0 - smoothstep(0.85, 1.0, t)); // soot occludes as it cools
  } else if (vKind < 1.5){
    float core = exp(-r2 * 5.0);
    float flick = 0.55 + 0.45 * sin(uTime * (7.0 + vSeed * 13.0) + vSeed * 40.0);
    col = bb(mix(1750.0 + vParam * 500.0, 950.0, t)) * core * flick * (1.0 - smoothstep(0.75, 1.0, t)) * uFireGain * 2.2;
  } else {
    float core = exp(-r2 * 3.5);
    col = bb(mix(2800.0, 1300.0, t)) * core * (1.0 - t) * uFireGain * 1.6;
  }
  col *= softFade(vViewZ, 0.25);
  gl_FragColor = vec4(col, alpha);
}`;
// heat haze: every hot flame sprite also bends the scene behind it
const FIRE_HEAT_FRAG = /* glsl */ `
uniform highp sampler3D uNoise; uniform float uTime, uHeatGain;
varying vec2 vQ; varying float vAge, vKind, vSeed, vViewZ;
void main(){
  float r2 = dot(vQ, vQ); if (r2 > 1.0 || (vKind > 0.5 && vKind < 2.5)) discard;
  vec3 np = vec3(vQ * 0.4 + vSeed * 3.0, uTime * 1.3 + vSeed);
  vec2 g = vec2(texture(uNoise, np).r - texture(uNoise, np + vec3(0.07, 0.0, 0.0)).r, texture(uNoise, np).r - texture(uNoise, np + vec3(0.0, 0.07, 0.0)).r);
  float k = (1.0 - r2) * smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge)) * uHeatGain / max(vViewZ, 0.5);
  gl_FragColor = vec4(g * k, 0.0, 0.0);
}`;
const SMOKE_VERT = /* glsl */ `
void main(){
  vec4 a, b, c;
  if (!fetchParticle(a, b, c) || a.y < -500.0){ gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float t = a.w / b.w; vAge = t; vLife = b.w; vKind = c.z; vSeed = c.x; vParam = c.w;
  float grow = c.z < 0.5 ? mix(0.45, 2.3, sqrt(t)) : c.z < 1.5 ? mix(0.55, 2.8, pow(t, 0.45)) : c.z < 2.5 ? mix(0.6, 1.9, sqrt(t)) : c.z < 3.5 ? mix(0.5, 2.0, sqrt(t)) : mix(0.8, 1.6, t);
  float size = c.y * grow;
  vec4 mv = viewMatrix * vec4(a.xyz, 1.0);
  vec2 q = sp_rot(c.x * 6.2831 + a.w * (c.x - 0.5) * 0.5) * position.xy;
  mv.xy += q * size;
  vQ = position.xy; vViewZ = -mv.z; vWPos = a.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FRAG = LIGHTING_GLSL + /* glsl */ `
uniform highp sampler3D uNoise; uniform float uTime, uSmokeGain;
varying vec2 vQ; varying float vAge, vKind, vSeed, vParam, vViewZ; varying vec3 vWPos;
void main(){
  float r2 = dot(vQ, vQ); if (r2 > 1.0) discard;
  float t = vAge;
  vec3 np = vec3(vQ * 0.28 + vec2(vSeed * 4.1, vSeed * 1.7), t * 0.35 + vSeed * 2.3);
  float n = texture(uNoise, np).r * 0.7 + texture(uNoise, np * 2.1 + 0.4).g * 0.3;
  float r = sqrt(r2);
  float dens = smoothstep(1.0, 0.1, r + (n - 0.5) * 1.3);
  vec3 base; float op;
  if (vKind < 0.5){ base = vec3(0.075, 0.07, 0.065); op = 0.55; }
  else if (vKind < 1.5){ base = vec3(0.46, 0.39, 0.3) * (0.85 + 0.3 * vParam); op = 0.5; }
  else if (vKind < 2.5){ base = vec3(0.78, 0.84, 0.88); op = 0.32; }
  else if (vKind < 3.5){ base = vec3(0.85); op = 0.28; }
  else { base = vec3(0.7, 0.72, 0.78); op = 0.2; }
  float fade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.4, 1.0, t));
  float a = dens * op * fade * uSmokeGain;
  // pseudo-normal of a puff, rotated into the world through the view
  vec3 nv = normalize(vec3(vQ, sqrt(max(1.0 - r2, 0.0)) + 0.35));
  vec3 nw = normalize((vec4(nv, 0.0) * viewMatrix).xyz);
  vec3 lit = litSprite(vWPos, nw, dens) * base;
  if (vKind < 0.5) lit += vec3(1.0, 0.35, 0.08) * vParam * (1.0 - t) * 2.5 * base.r; // underlit by the fire that made it
  a *= softFade(vViewZ, 0.6);
  gl_FragColor = vec4(lit * a, a);
}`;
const DEBRIS_VERT = /* glsl */ `
varying float vSpin;
void main(){
  vec4 a, b, c;
  if (!fetchParticle(a, b, c) || a.y < -500.0){ gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float t = a.w / b.w; vAge = t; vLife = b.w; vKind = c.z; vSeed = c.x; vParam = c.w;
  float size = c.y * (1.0 - smoothstep(0.85, 1.0, t));
  vec4 mv = viewMatrix * vec4(a.xyz, 1.0);
  vec2 q = position.xy;
  float spd = length(b.xyz);
  vSpin = a.w * (2.0 + c.x * 9.0) * min(spd, 4.0) * 0.6 + c.x * 30.0;
  if (c.z > 3.5){  // streak along the screen-space flow
    vec3 vv = (viewMatrix * vec4(b.xyz, 0.0)).xyz; float sp = length(vv.xy);
    vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(1.0, 0.0);
    float len = size * 2.0 + sp * 0.07;
    q = vec2(q.x * len, q.y * size * 0.18); q = vec2(dir.x * q.x - dir.y * q.y, dir.y * q.x + dir.x * q.y);
    mv.xy += q;
  } else if (c.z > 1.5 && c.z < 2.5){ // leaf flutter: squash across its spin axis
    q = sp_rot(vSpin * 0.7) * vec2(q.x * abs(cos(vSpin)) + 0.08 * sign(q.x), q.y * 0.55);
    mv.xy += q * size;
  } else {
    q = sp_rot(vSpin) * q; mv.xy += q * size;
  }
  vQ = position.xy; vViewZ = -mv.z; vWPos = a.xyz; vVel = b.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const DEBRIS_FRAG = LIGHTING_GLSL + /* glsl */ `
uniform float uTime; uniform sampler2D uSceneCopy;
varying vec2 vQ; varying float vAge, vKind, vSeed, vParam, vViewZ, vSpin; varying vec3 vWPos, vVel;
void main(){
  float r2 = dot(vQ, vQ); float r = sqrt(r2);
  vec3 col; float a;
  vec3 nv = normalize(vec3(vQ, sqrt(max(1.0 - r2, 0.0)) + 0.2));
  vec3 nw = normalize((vec4(nv, 0.0) * viewMatrix).xyz);
  if (vKind < 0.5){                 // pebble: irregular chunk of granite
    float ang = atan(vQ.y, vQ.x);
    float edge = 0.72 + 0.18 * sin(ang * 3.0 + vSeed * 20.0) + 0.1 * sin(ang * 5.0 + vSeed * 7.0);
    if (r > edge) discard;
    float facet = floor((ang + 3.1416) / 1.2566 + vSeed * 3.0);
    vec3 fn = normalize(nw + (vec3(sin(facet * 2.1), cos(facet * 1.7), sin(facet * 3.3)) - 0.5) * 0.6);
    vec3 base = vec3(0.26, 0.24, 0.22) * (0.75 + 0.5 * fract(vSeed * 13.7));
    col = litSprite(vWPos, fn, 0.0) * base; a = 1.0;
  } else if (vKind < 1.5){          // droplet: a tiny lens of sky with a sun glint
    if (r > 1.0) discard;
    vec2 suv = gl_FragCoord.xy / uResolution;
    vec3 bg = texture2D(uSceneCopy, clamp(suv - vQ * 0.012, vec2(0.001), vec2(0.999))).rgb;   // an inverted, magnified view through the drop
    vec3 h = normalize(uKeyDir + normalize(cameraPosition - vWPos));
    float spec = pow(max(dot(nw, h), 0.0), 40.0) * 5.0;
    col = bg * vec3(0.9, 0.97, 1.0) * (0.85 + 0.3 * r * r) + ambCube(nw) * 0.25 * r + uKeyColor * spec; a = smoothstep(1.0, 0.75, r);
  } else if (vKind < 2.5){          // leaf / cloth scrap
    float leaf = abs(vQ.y) - (1.0 - vQ.x * vQ.x) * 0.55;
    if (leaf > 0.0 || abs(vQ.x) > 1.0) discard;
    vec3 base = vParam > 0.5 ? vec3(0.42, 0.36, 0.3) : mix(vec3(0.36, 0.2, 0.07), vec3(0.55, 0.36, 0.1), fract(vSeed * 7.3));
    base *= 0.85 + 0.25 * smoothstep(0.03, 0.0, abs(vQ.y));
    col = litSprite(vWPos, nw, 0.6) * base; a = 1.0;
  } else if (vKind < 3.5){          // ice crystal: glints as it tumbles
    float d = abs(vQ.x) + abs(vQ.y); if (d > 1.0) discard;
    float tw = pow(abs(sin(vSpin * 1.7 + uTime * 3.0)), 12.0);
    col = ambCube(nw) * vec3(0.92, 0.97, 1.0) * (0.8 + 3.0 * tw) + uKeyColor * tw * 1.5; a = 0.6 * (1.0 - d);
  } else {                          // air streak (additive)
    float line = exp(-vQ.y * vQ.y * 6.0) * smoothstep(1.0, 0.2, abs(vQ.x));
    float fade = smoothstep(0.0, 0.15, vAge) * (1.0 - smoothstep(0.6, 1.0, vAge));
    col = ambCube(vec3(0.0, 1.0, 0.0)) * line * fade * (0.35 + vParam) * 0.8; a = 0.0;
    col *= softFade(vViewZ, 0.3);
    gl_FragColor = vec4(col, 0.0); return;
  }
  a *= softFade(vViewZ, 0.05);
  gl_FragColor = vec4(col * a, a);
}`;

// ---- glow sprites (cores, singularity, flashes) -------------------------------------------------
const GLOW = { max: 192, n: 0, mesh: null };
function glow(p, radius, r, g, b, halo = 0.25) {
  if (GLOW.n >= GLOW.max || !GLOW.mesh) return;
  const G = GLOW.mesh.geometry, i = GLOW.n++;
  G.attributes.aPos.setXYZW(i, p.x, p.y, p.z, radius); G.attributes.aCol.setXYZW(i, r, g, b, halo);
}
function initGlow() {
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); ig.setIndex([0, 1, 2, 0, 2, 3]);
  ig.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(GLOW.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(GLOW.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uLinDepth: U.uLinDepth, uWaterDepth: U.uWaterDepth, uResolution: U.uResolution, uSoft: { value: 1 } },
    vertexShader: GLSL_COMMON + /* glsl */ `attribute vec4 aPos, aCol; varying vec2 vQ; varying vec4 vCol; varying float vViewZ, vR;
      void main(){ vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0); float s = aPos.w * (1.0 + aCol.w * 3.0);
        // pull toward the camera so a glow inside a body still reads, then clamp to near plane
        vec3 toCam = normalize(-mv.xyz); mv.xyz += toCam * min(aPos.w * 0.8, max(-mv.z - 0.1, 0.0));
        mv.xy += position.xy * s; vQ = position.xy * (1.0 + aCol.w * 3.0); vCol = aCol; vViewZ = -mv.z; vR = aPos.w;
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GLSL_COMMON + SOFT_FRAG + /* glsl */ `varying vec2 vQ; varying vec4 vCol; varying float vViewZ, vR;
      void main(){ float r = length(vQ); float core = exp(-r * r * 3.5); float halo = exp(-r * 1.6) * vCol.w * 0.5;
        float k = (core + halo) * smoothstep(1.0 + vCol.w * 3.0, 0.6 + vCol.w * 2.0, r);
        gl_FragColor = vec4(vCol.rgb * k * softFade(vViewZ, max(vR * 0.6, 0.05)), 0.0); }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  GLOW.mesh = new THREE.Mesh(ig, mat); GLOW.mesh.frustumCulled = false; GLOW.mesh.renderOrder = 40; GLOW.mat = mat;
  fxScene.add(GLOW.mesh);
}

// ---- distortion sprites (heat, shock rings, air ripples) → POST.distortRT -----------------------
const DIST = { max: 96, n: 0, mesh: null };
// kind 0 heat shimmer, 1 refracting ring (radius fraction in `ring`), 2 swirl
function distortSprite(p, radius, strength, kind = 0, ring = 0.8, sep = 0) {
  if (DIST.n >= DIST.max || !DIST.mesh) return;
  const G = DIST.mesh.geometry, i = DIST.n++;
  G.attributes.aPos.setXYZW(i, p.x, p.y, p.z, radius); G.attributes.aPar.setXYZW(i, strength, kind, ring, sep);
}
function initDistort() {
  const ig = new THREE.InstancedBufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); ig.setIndex([0, 1, 2, 0, 2, 3]);
  ig.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(DIST.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.setAttribute('aPar', new THREE.InstancedBufferAttribute(new Float32Array(DIST.max * 4), 4).setUsage(THREE.DynamicDrawUsage));
  ig.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uRealTime, uNoise: { value: null } },
    vertexShader: GLSL_COMMON + /* glsl */ `attribute vec4 aPos, aPar; varying vec2 vQ; varying vec4 vPar; varying float vViewZ;
      void main(){ vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0); mv.xy += position.xy * aPos.w; vQ = position.xy; vPar = aPar; vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GLSL_COMMON + /* glsl */ `uniform float uTime; uniform highp sampler3D uNoise; varying vec2 vQ; varying vec4 vPar; varying float vViewZ;
      void main(){
        float r = length(vQ); if (r > 1.0) discard;
        vec2 o = vec2(0.0); float sep = 0.0;
        if (vPar.y < 0.5){
          vec3 np = vec3(vQ * 0.5, uTime * 0.9); float n0 = texture(uNoise, np).r;
          o = vec2(n0 - texture(uNoise, np + vec3(0.05, 0.0, 0.0)).r, n0 - texture(uNoise, np + vec3(0.0, 0.05, 0.0)).r) * (1.0 - r * r);
        } else if (vPar.y < 1.5){
          float w = 0.09; float d = (r - vPar.z) / w; float g = exp(-d * d);
          o = (vQ / max(r, 1e-3)) * (-2.0 * d * g) * 0.25; sep = g * vPar.w;
        } else {
          float g = sin(r * 18.0 - uTime * 6.0) * (1.0 - r) * r;
          o = vec2(-vQ.y, vQ.x) * g;
        }
        gl_FragColor = vec4(o * vPar.x, sep * vPar.x, 0.0);
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  DIST.mesh = new THREE.Mesh(ig, mat); DIST.mesh.frustumCulled = false; DIST.mat = mat;
  distortScene.add(DIST.mesh);
}

// ---- rigid chunks: fragments, slabs' rubble, ice shards (CPU impulse physics) -------------------
class RigidPool {
  constructor(name, geos, material, max = 96, { restitution = 0.28, friction = 0.55, spinDamp = 0.75, shadows = true } = {}) {
    this.name = name; this.max = max; this.items = []; this.rest = restitution; this.fric = friction; this.spinDamp = spinDamp;
    this.meshes = geos.map((g) => { const m = new THREE.InstancedMesh(g, material, max); m.count = 0; m.frustumCulled = false; m.castShadow = shadows; m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); world.add(m); return m; });
    this.radii = geos.map((g) => { g.computeBoundingSphere(); return g.boundingSphere.radius; });
    RIGIDS.push(this);
  }
  spawn(o) {
    if (this.items.length >= this.max) this.items.shift();
    const v = o.variant != null ? o.variant % this.meshes.length : (Math.random() * this.meshes.length) | 0;
    const s = o.scale || 1; const sv = o.scaleV ? o.scaleV.clone() : V3(s, s, s);
    const it = { v, p: o.pos.clone(), vel: (o.vel || V3()).clone(), q: o.quat ? o.quat.clone() : new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
      w: (o.spin || V3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12)).clone(), s: sv,
      r: this.radii[v] * Math.min(sv.x, sv.y, sv.z) * 0.8, age: 0, sleep: 0, life: o.life || 1e9, onGround: false, slide: o.slide || 0 };
    this.items.push(it); return it;
  }
  clear() { this.items.length = 0; for (const m of this.meshes) m.count = 0; }
  step(dt) {
    const g = 9.8;
    for (const it of this.items) {
      it.age += dt; if (it.sleep > 0.6) continue;
      it.vel.y -= g * dt; it.vel.multiplyScalar(Math.exp(-dt * 0.04));
      it.p.addScaledVector(it.vel, dt);
      const wl = it.w.length();
      if (wl > 1e-4) { _q1.setFromAxisAngle(_v1.copy(it.w).multiplyScalar(1 / wl), wl * dt); it.q.premultiply(_q1); }
      const gy = groundHeight(it.p.x, it.p.z) + it.r * 0.55;
      it.onGround = false;
      if (it.p.y < gy) {
        it.p.y = gy; it.onGround = true;
        if (it.vel.y < 0) { const imp = -it.vel.y; it.vel.y = imp > 0.6 ? imp * this.rest : 0; if (imp > 2.5 && it.onImpact) it.onImpact(it, imp); }
        const f = Math.pow(1 - (it.slide ? this.fric * 0.25 : this.fric), dt * 12);
        it.vel.x *= f; it.vel.z *= f;
        it.w.multiplyScalar(Math.pow(this.spinDamp, dt * 12));
        // roll: spin follows the ground velocity a little
        it.w.x += it.vel.z * dt * 6; it.w.z -= it.vel.x * dt * 6;
      }
      if (it.onGround && it.vel.lengthSq() < 0.02 && it.w.lengthSq() < 0.5) it.sleep += dt; else it.sleep = 0;
      if (it.sleep > 0.6) { it.vel.set(0, 0, 0); it.w.set(0, 0, 0); }
    }
  }
  sync() {
    const counts = this.meshes.map(() => 0);
    for (const it of this.items) {
      const m = this.meshes[it.v]; const k = counts[it.v]++;
      const fade = it.life < 1e8 ? 1 - smoothstep(it.life - 0.6, it.life, it.age) : 1;
      _m1.compose(it.p, it.q, _v2.copy(it.s).multiplyScalar(Math.max(fade, 0.001))); m.setMatrixAt(k, _m1);
    }
    this.items = this.items.filter((it) => it.age < it.life);
    this.meshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  }
}
const RIGIDS = [];

// jagged chunk geometry (convex-ish, flat-shaded facets)
function chunkGeometry(seed, sx = 1, sy = 1, sz = 1, detail = 0) {
  const r = new RNG(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.62 + r.f(0, 0.5);
    p.setXYZ(i, p.getX(i) * sx * k, p.getY(i) * sy * k, p.getZ(i) * sz * k);
  }
  const ng = g.index ? g.toNonIndexed() : g; ng.computeVertexNormals();
  return ng;
}

// ---- lifecycle --------------------------------------------------------------------------------
function initFX() {
  const tex = Q.particleTex;
  const fireMat = particleMaterial({ vert: FIRE_VERT, frag: FIRE_FRAG, order: 32, uniforms: { uNoise: { value: TEX.cloudNoise }, uFireGain: { value: 1.2 }, uAspectFix: { value: 1 } } });
  const heatMat = particleMaterial({ vert: FIRE_VERT, frag: FIRE_HEAT_FRAG, blending: 'add', uniforms: { uNoise: { value: TEX.cloudNoise }, uHeatGain: { value: 0.035 } } });
  heatMat.blendSrcAlpha = THREE.OneFactor; heatMat.blendDstAlpha = THREE.OneFactor;
  PS.fire = new GPUParticles({ name: 'fire', width: tex, height: tex, behaviour: FIRE_BEHAVE, material: fireMat, scene: fxScene, layers: [{ material: heatMat, scene: distortScene }] });
  const smokeMat = particleMaterial({ vert: SMOKE_VERT, frag: SMOKE_FRAG, order: 30, uniforms: { uNoise: { value: TEX.cloudNoise }, uSmokeGain: { value: 1 } } });
  PS.smoke = new GPUParticles({ name: 'smoke', width: tex >> 1, height: tex >> 1, behaviour: SMOKE_BEHAVE, material: smokeMat, scene: fxScene });
  const debrisMat = particleMaterial({ vert: DEBRIS_VERT, frag: DEBRIS_FRAG, order: 28, uniforms: {} });
  PS.debris = new GPUParticles({ name: 'debris', width: tex >> 1, height: tex >> 1, behaviour: DEBRIS_BEHAVE, material: debrisMat, scene: fxScene });
  DIST.max = 96; initGlow(); initDistort(); DIST.mat.uniforms.uNoise.value = TEX.cloudNoise;
  for (const m of FXS.list) if (m.init) m.init();
  onReset(resetFX);
}
function resetFX() {
  for (const k of ['fire', 'smoke', 'debris']) PS[k] && PS[k].clear();
  for (const r of RIGIDS) r.clear();
  FIELD.shock2.y = 0; FIELD.attract.w = 0; FIELD.vortex.w = 0;
  if (typeof clearEffectMask === 'function' && FXMASK.rt) clearEffectMask();
  for (const m of FXS.list) if (m.reset) m.reset();
  FIG.ok = false;
}
function updateFX(T, dt) {
  probeFigure(dt);
  GLOW.n = 0; DIST.n = 0;
  for (const m of FXS.list) if (m.update) m.update(T, dt);
  if (dt > 0) { const n = Math.max(1, Math.ceil(dt / (1 / 90))); for (const r of RIGIDS) for (let i = 0; i < n; i++) r.step(dt / n); }
  for (const r of RIGIDS) r.sync();
  GLOW.mesh.geometry.instanceCount = GLOW.n; GLOW.mesh.geometry.attributes.aPos.needsUpdate = GLOW.mesh.geometry.attributes.aCol.needsUpdate = true;
  DIST.mesh.geometry.instanceCount = DIST.n; DIST.mesh.geometry.attributes.aPos.needsUpdate = DIST.mesh.geometry.attributes.aPar.needsUpdate = true;
}
function updateParticles(dt) {
  if (dt <= 0) return;
  PS.fire.update(dt); PS.smoke.update(dt); PS.debris.update(dt);
}
function collectLights() { for (const m of FXS.list) if (m.lights) m.lights(); }
function presentFX(dtReal) { for (const m of FXS.list) if (m.present) m.present(dtReal); }

// small helpers for modules
const _c1 = new THREE.Color();
function bbColor(T, out = _c1) { const c = blackbodyRGB(T); return out.setRGB(c[0], c[1], c[2]); }
function rate(perSecond, dt) { const x = perSecond * dt; const n = Math.floor(x); return n + (Math.random() < x - n ? 1 : 0); }
function randInSphere(r, out = V3()) { do { out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); } while (out.lengthSq() > 1); return out.multiplyScalar(r); }
