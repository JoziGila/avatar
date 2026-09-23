// Assembles the single-file cinematic from src/ into index.html.
//   node tools/build.mjs            -> index.html (complete, self-contained document)
//   node tools/build.mjs --artifact -> dist/stillpoint.html (fragment for hosts that supply their own <html>/<head>/<body>)
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const read = (f) => readFileSync(join(src, f), 'utf8');

const THREE_VERSION = '0.186.0';
const head = read('head.html').replaceAll('%%THREE%%', THREE_VERSION);
const style = read('style.css');
const body = read('body.html');
const jsFiles = readdirSync(join(src, 'js')).filter((f) => f.endsWith('.js')).sort();
const js = jsFiles.map((f) => `// ---- ${f} ----\n` + readFileSync(join(src, 'js', f), 'utf8')).join('\n');
const importmap = `<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/"
} }
</script>`;
const script = `<script type="module">\n${js}\n</script>`;
// Default character (dressed Microsoft Rocketbox avatar, MIT) embedded as base64 so the page stays self-contained.
let charBlock = '';
try {
  const glb = readFileSync(join(root, 'assets', 'character.glb'));
  charBlock = `<script type="application/octet-stream" id="sp-character">${glb.toString('base64')}</script>`;
} catch (e) { console.warn('no assets/character.glb — the procedural figure will be used'); }

const artifact = process.argv.includes('--artifact');
let out;
if (artifact) {
  out = `${head}\n<style>\n${style}\n</style>\n${body}\n${charBlock}\n${importmap}\n${script}\n`;
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'stillpoint.html'), out);
  console.log('wrote dist/stillpoint.html', (out.length / 1024).toFixed(1) + ' KB');
} else {
  out = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${head}\n<style>\n${style}\n</style>\n</head>\n<body>\n${body}\n${charBlock}\n${importmap}\n${script}\n</body>\n</html>\n`;
  writeFileSync(join(root, 'index.html'), out);
  console.log('wrote index.html', (out.length / 1024).toFixed(1) + ' KB', jsFiles.length + ' js sections');
}
