// §7 LIGHTING RIG — sun/moon key with fitted shadow frustum, element light pool --
const LIGHTS = { key: null, pool: [], requests: [], fill: null };

function initLights() {
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(Q.shadow, Q.shadow);
  key.shadow.bias = -0.00035; key.shadow.normalBias = 0.025; key.shadow.radius = 2.2;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 90;
  world.add(key); world.add(key.target);
  LIGHTS.key = key;
  for (let i = 0; i < Q.lights; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 16, 2);
    l.castShadow = false; world.add(l); LIGHTS.pool.push(l);
  }
}

// Fit the orthographic shadow frustum around the arena as seen from the light.
const _lv = new THREE.Matrix4(), _corner = new THREE.Vector3();
function fitShadow(focus) {
  const key = LIGHTS.key; const d = U.uKeyDir.value;
  key.target.position.copy(focus);
  key.position.copy(focus).addScaledVector(d, 40);
  key.updateMatrixWorld(); key.target.updateMatrixWorld();
  _lv.lookAt(key.position, key.target.position, _v1.set(0, 1, 0)).setPosition(key.position).invert();
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  const R = 11.5;
  for (let i = 0; i < 8; i++) {
    _corner.set(focus.x + (i & 1 ? R : -R), i & 2 ? 6.5 : -0.8, focus.z + (i & 4 ? R : -R)).applyMatrix4(_lv);
    x0 = Math.min(x0, _corner.x); x1 = Math.max(x1, _corner.x); y0 = Math.min(y0, _corner.y); y1 = Math.max(y1, _corner.y);
    z0 = Math.min(z0, _corner.z); z1 = Math.max(z1, _corner.z);
  }
  const c = key.shadow.camera;
  // snap to texels to stop shimmering as the camera moves
  const tx = (x1 - x0) / key.shadow.mapSize.x, ty = (y1 - y0) / key.shadow.mapSize.y;
  c.left = Math.floor(x0 / tx) * tx; c.right = Math.ceil(x1 / tx) * tx; c.bottom = Math.floor(y0 / ty) * ty; c.top = Math.ceil(y1 / ty) * ty;
  c.near = Math.max(0.1, -z1 - 5); c.far = -z0 + 5;
  c.updateProjectionMatrix();
}

function requestLight(pos, color, intensity, priority = 1, range = 14) {
  if (intensity <= 0.001) return;
  LIGHTS.requests.push({ x: pos.x, y: pos.y, z: pos.z, r: color.r, g: color.g, b: color.b, i: intensity, p: priority * intensity, range });
}
function flushLights() {
  const req = LIGHTS.requests; req.sort((a, b) => b.p - a.p);
  const pool = LIGHTS.pool;
  for (let i = 0; i < pool.length; i++) {
    const l = pool[i], q = req[i];
    if (q) { l.position.set(q.x, q.y, q.z); l.color.setRGB(q.r, q.g, q.b); l.intensity = q.i; l.distance = q.range; l.visible = true; }
    else { l.intensity = 0; }
  }
  // merge the rest into the strongest as a soft fallback so nothing pops harshly
  req.length = 0;
}

function updateKeyLight(focus) {
  const key = LIGHTS.key;
  key.color.copy(U.uKeyColor.value);
  const m = Math.max(key.color.r, key.color.g, key.color.b);
  if (m > 0) { key.intensity = m; key.color.multiplyScalar(1 / m); } else key.intensity = 0;
  fitShadow(focus);
}
