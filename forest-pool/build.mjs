// Bundles src/ into one inline module and writes dist/index.html with the assets beside it.
// three.js stays external (loaded from jsDelivr via the page's import map).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';

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
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
