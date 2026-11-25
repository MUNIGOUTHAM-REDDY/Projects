// Bundles src/ into one inline module and writes dist/index.html with the assets beside it.
// three.js stays external (loaded from jsDelivr via the page's import map).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  write: false,
  minify: true,
  external: ['three', 'three/addons/*'],
  target: 'es2020',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('index.template.html', 'utf8').replace('/*BUNDLE*/', () => js);
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
cpSync('assets', 'dist/assets', { recursive: true });
// Artifacts only serve web file types, so every glTF becomes a .json with its buffer inlined as base64.
for (const id of readdirSync('assets/models')) {
  const dir = `assets/models/${id}`;
  const gltf = JSON.parse(readFileSync(`${dir}/${id}.gltf`, 'utf8'));
  for (const b of gltf.buffers) b.uri = 'data:application/octet-stream;base64,' + readFileSync(`${dir}/${b.uri}`).toString('base64');
  writeFileSync(`dist/${dir}/${id}.json`, JSON.stringify(gltf));
  rmSync(`dist/${dir}/${id}.gltf`); rmSync(`dist/${dir}/${id}.bin`);
}
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
