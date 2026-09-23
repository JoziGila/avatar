// Offline Rocketbox → Stillpoint GLB converter (runs in a browser; see convert.html).
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGarments } from './garments.js';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';

const Q = new URLSearchParams(location.search);
const SRC = Q.get('src') || '/rbdl/';
const NAME = Q.get('name') || 'Sports_Female_01';
const OUT = Q.get('out') || 'character.glb';
const WITH_GARMENTS = Q.get('garments') !== '0';
const TEX_SIZE = +(Q.get('tex') || 1024);
const HEAD_TEX = +(Q.get('headtex') || 1024);
const log = (...a) => console.log('[convert]', ...a);

// Facial blendshapes worth keeping: breath, focus, effort, eyes closed.
const KEEP_MORPHS = {
  'AK_09_EyeBlinkLeft': 'eyeBlinkLeft', 'AK_10_EyeBlinkRight': 'eyeBlinkRight',
  'AK_19_EyeSquintLeft': 'eyeSquintLeft', 'AK_20_EyeSquintRight': 'eyeSquintRight',
  'AK_01_BrowDownLeft': 'browDownLeft', 'AK_02_BrowDownRight': 'browDownRight',
  'AK_25_JawOpen': 'jawOpen', 'AK_32_MouthFunnel': 'mouthFunnel',
  'AK_36_MouthPressLeft': 'mouthPressLeft', 'AK_37_MouthPressRight': 'mouthPressRight',
};

async function loadFBX() {
  const mgr = new THREE.LoadingManager();
  mgr.addHandler(/\.tga$/i, new TGALoader(mgr));
  mgr.setURLModifier((u) => SRC + 'Textures/' + u.split(/[\\/]/).pop());
  const done = new Promise((r) => { mgr.onLoad = r; });
  const buf = await (await fetch(SRC + 'Export/' + NAME + '_facial.fbx')).arrayBuffer();
  const fbx = new FBXLoader(mgr).parse(buf, SRC);
  await done;
  return fbx;
}

// TGA DataTexture → canvas at a target size (high-quality downscale)
function texToCanvas(tex, size, fn = null) {
  const img = tex.image; const w = img.width, h = img.height;
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const sctx = src.getContext('2d');
  const id = sctx.createImageData(w, h);
  const d = img.data; const flip = tex.flipY;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((flip ? h - 1 - y : y) * w + x) * 4, di = (y * w + x) * 4;
    id.data[di] = d[si]; id.data[di + 1] = d[si + 1]; id.data[di + 2] = d[si + 2]; id.data[di + 3] = 255;
  }
  if (fn) fn(id.data);
  sctx.putImageData(id, 0, 0);
  let cur = src;
  while (cur.width > size * 1.5) { // progressive halving for quality
    const c = document.createElement('canvas'); c.width = cur.width >> 1; c.height = cur.height >> 1;
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, c.width, c.height); cur = c;
  }
  if (cur.width !== size) { const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, size, size); cur = c; }
  return cur;
}
function canvasTex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.userData.mimeType = 'image/jpeg';
  return t;
}

// Replace saturated magenta (the base model's swimwear print) with surrounding skin by onion-peel inpainting,
// so nothing of the original costume can show above the collar.
function inpaintMagenta(px, w, h) {
  const mask = new Uint8Array(w * h); let n = 0;
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r > 90 && b > 60 && g < 0.72 * Math.min(r, b) && b > g + 25) { mask[i] = 1; n++; }
  }
  // grow the mask by 2px to catch antialiased fringes
  for (let pass = 0; pass < 2; pass++) { const m2 = mask.slice(); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!mask[i] && (mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w])) m2[i] = 1; } mask.set(m2); }
  let remaining = true, guard = 0;
  while (remaining && guard++ < 4000) {
    remaining = false; const fill = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx;
        if (!mask[j]) { r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; c++; }
      }
      if (c) fill.push(i, r / c, g / c, b / c); else remaining = true;
    }
    for (let k = 0; k < fill.length; k += 4) { const i = fill[k]; px[i * 4] = fill[k + 1]; px[i * 4 + 1] = fill[k + 2]; px[i * 4 + 2] = fill[k + 3]; mask[i] = 0; }
    if (!fill.length) break;
  }
  return n;
}

function convertMaterial(m, size) {
  const name = m.name;
  const col = canvasTex(texToCanvas(m.map, size, (px) => { const n = inpaintMagenta(px, m.map.image.width, m.map.image.height); log('inpainted', name, n); }), true);
  const nrm = canvasTex(texToCanvas(m.normalMap, size), false);
  // specular level → glTF metallicRoughness (G = roughness, B = metalness 0)
  const rough = canvasTex(texToCanvas(m.specularMap, size, (px) => {
    for (let i = 0; i < px.length; i += 4) {
      const s = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
      const r = Math.max(0.28, Math.min(0.92, 0.9 - s * 0.85));
      px[i] = 255; px[i + 1] = Math.round(r * 255); px[i + 2] = 0;
    }
  }), false);
  const out = new THREE.MeshStandardMaterial({ name, map: col, normalMap: nrm, roughnessMap: rough, metalnessMap: rough, roughness: 1, metalness: 0 });
  return out;
}

function cleanGeometry(src) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) g.setAttribute(k, src.attributes[k].clone());
  g.groups = src.groups.map((x) => ({ ...x }));
  const dict = src.userData.morphDict;
  g.morphAttributes.position = [];
  const names = [];
  for (const [full, idx] of Object.entries(dict)) {
    const short = full.replace(/^blendShape1\./, '');
    if (KEEP_MORPHS[short]) { g.morphAttributes.position.push(src.morphAttributes.position[idx].clone()); names.push(KEEP_MORPHS[short]); }
  }
  g.morphTargetsRelative = true;
  // merge groups into two contiguous ranges (body, head) so the mesh can be split per material
  const merged = mergeVertices(g, 1e-5);
  merged.userData.morphNames = names;
  return merged;
}

// split an indexed multi-material geometry into one geometry per material index
function splitByMaterial(g, nMat) {
  const idx = g.index.array; const perMat = Array.from({ length: nMat }, () => []);
  for (const gr of g.groups) { const arr = perMat[gr.materialIndex]; for (let i = gr.start; i < gr.start + gr.count; i++) arr.push(idx[i]); }
  return perMat.map((list) => {
    const used = new Map(); const remap = []; list.forEach((v) => { if (!used.has(v)) { used.set(v, remap.length); remap.push(v); } });
    const out = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(g.attributes)) {
      const arr = new a.array.constructor(remap.length * a.itemSize);
      remap.forEach((v, i) => { for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.array[v * a.itemSize + c]; });
      out.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    out.morphAttributes.position = (g.morphAttributes.position || []).map((a) => {
      const arr = new Float32Array(remap.length * 3); remap.forEach((v, i) => { arr[i * 3] = a.array[v * 3]; arr[i * 3 + 1] = a.array[v * 3 + 1]; arr[i * 3 + 2] = a.array[v * 3 + 2]; });
      return new THREE.BufferAttribute(arr, 3);
    });
    out.morphTargetsRelative = true;
    out.setIndex(list.map((v) => used.get(v)));
    return out;
  });
}

async function main() {
  const t0 = performance.now();
  const fbx = await loadFBX();
  let skinned = null; fbx.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  log('loaded', skinned.name, 'verts', skinned.geometry.attributes.position.count, 'ms', (performance.now() - t0).toFixed(0));
  skinned.geometry.userData.morphDict = skinned.morphTargetDictionary;
  const geo = cleanGeometry(skinned.geometry);
  log('indexed verts', geo.attributes.position.count, 'tris', geo.index.count / 3, 'morphs', geo.userData.morphNames.join(','));
  const mats = (Array.isArray(skinned.material) ? skinned.material : [skinned.material]);
  const parts = splitByMaterial(geo, mats.length);
  // drop blendshapes from parts they do not move (the body): saves a lot of bytes
  for (const pg of parts) {
    let mx = 0; for (const a of pg.morphAttributes.position) for (let i = 0; i < a.array.length; i++) mx = Math.max(mx, Math.abs(a.array[i]));
    if (mx < 1e-4) pg.morphAttributes = {}; pg.userData.hasMorphs = mx >= 1e-4;
  }
  const newMats = mats.map((m) => convertMaterial(m, /head/i.test(m.name) ? HEAD_TEX : TEX_SIZE));

  // scene: root (metres) → armature (the FBX bone hierarchy) + one skinned mesh per material
  const root = new THREE.Group(); root.name = 'StillpointFigure';
  const skeleton = skinned.skeleton;
  let rootBone = skeleton.bones[0];
  while (rootBone.parent && rootBone.parent.isBone) rootBone = rootBone.parent;
  log('root bone', rootBone.name, 'fbx root matrix identity', fbx.matrix.equals(new THREE.Matrix4()));
  rootBone.traverse((o) => { o.userData = {}; });
  const armature = new THREE.Group(); armature.name = 'Armature'; armature.scale.setScalar(0.01);
  armature.add(rootBone); root.add(armature);
  root.updateMatrixWorld(true);
  const meshes = parts.map((pg, i) => {
    const m = new THREE.SkinnedMesh(pg, newMats[i]);
    m.name = /head/i.test(mats[i].name) ? 'Head' : 'Body';
    if (pg.userData.hasMorphs) {
      m.morphTargetDictionary = Object.fromEntries(geo.userData.morphNames.map((n, k) => [n, k]));
      m.morphTargetInfluences = geo.userData.morphNames.map(() => 0);
    }
    armature.add(m);
    m.bind(skeleton, skinned.bindMatrix.clone());
    return m;
  });
  root.updateMatrixWorld(true);

  if (WITH_GARMENTS) {
    const t1 = performance.now();
    const garments = await buildGarments({ THREE, meshes, skeleton, armature, log, simplifier: MeshoptSimplifier, ratio: +(Q.get('ratio') || 0.36) });
    for (const g of garments) armature.add(g);
    log('garments', garments.map((g) => `${g.name}:${g.geometry.index.count / 3}`).join(' '), 'ms', (performance.now() - t1).toFixed(0));
  }

  // animation clips from the Rocketbox library (same biped rig): neutral idle + breathing loop
  const clips = [];
  for (const [file, name, fps, maxDur] of [['f_idle_neutral_01', 'idle', 15, 12], ['f_idle_breathe_01', 'breathe', 20, 99]]) {
    try {
      const buf = await (await fetch(SRC + 'Anim/' + file + '.fbx')).arrayBuffer();
      const a = new FBXLoader().parse(buf, SRC).animations[0];
      const keep = a.tracks.filter((t) => {
        const [b, prop] = t.name.split('.');
        if (!/^Bip01/.test(b) || /Footsteps|Eye|Mouth|Lip|Jaw|Tongue|Masseter|Caninus|Cheek|brow|Nose|Upperlip/i.test(b)) return false;
        if (prop === 'scale') return false;
        if (prop === 'position') return b === 'Bip01';
        return prop === 'quaternion' && !!rootBone.getObjectByName(b);
      });
      const dur = Math.min(a.duration, maxDur); const n = Math.round(dur * fps) + 1;
      const times = new Float32Array(n); for (let i = 0; i < n; i++) times[i] = (i / (n - 1)) * dur;
      const tracks = keep.map((t) => {
        const it = t.createInterpolant(); const vs = new Float32Array(n * t.getValueSize());
        for (let i = 0; i < n; i++) { const v = it.evaluate(times[i]); vs.set(v, i * v.length); }
        return new t.constructor(t.name, times.slice(), vs);
      });
      const clip = new THREE.AnimationClip(name, dur, tracks); clips.push(clip);
      log('clip', name, 'dur', dur.toFixed(2), 'tracks', tracks.length);
    } catch (e) { log('clip failed', file, e.message); }
  }

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(root, { binary: true, onlyVisible: true, animations: clips });
  const b64 = btoa(new Uint8Array(glb).reduce((s, b) => s + String.fromCharCode(b), ''));
  log('glb bytes', glb.byteLength);
  if (window.saveFile) await window.saveFile(OUT, b64);
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([glb])); a.download = OUT; a.click(); }

  if (Q.get('preview') !== '0') await preview(glb);
  window.__done = true;
}

async function preview(glb) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(800, 800); document.body.appendChild(renderer.domElement);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x303236);
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3020, 1.2));
  const d = new THREE.DirectionalLight(0xffffff, 2.5); d.position.set(1.5, 3, 2.5); scene.add(d);
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  scene.add(gltf.scene);
  const shots = [[0, 1.0, 3.2, 0, 0.9, 0, 'front'], [2.6, 1.2, 1.8, 0, 0.9, 0, 'three_quarter'], [0.15, 1.62, 0.5, 0, 1.58, 0, 'face'], [-2.8, 1.0, -1.6, 0, 0.9, 0, 'back'], [0.12, 1.62, 0.45, 0, 1.6, 0, 'face_closed']];
  let headMesh = null; gltf.scene.traverse((o) => { if (o.morphTargetDictionary && o.morphTargetDictionary.eyeBlinkLeft !== undefined) headMesh = o; });
  const cam = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  for (const [x, y, z, tx, ty, tz, nm] of shots) {
    cam.position.set(x, y, z); cam.lookAt(tx, ty, tz);
    if (headMesh) { const d = headMesh.morphTargetDictionary; headMesh.morphTargetInfluences[d.eyeBlinkLeft] = headMesh.morphTargetInfluences[d.eyeBlinkRight] = nm === 'face_closed' ? 1 : 0; }
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    if (window.saveFile) await window.saveFile('preview_' + nm + '.png', url.split(',')[1]);
  }
}

main().catch((e) => { console.error('[convert] failed', e.stack || e); window.__done = true; });
