// Bundles src/ into one inline module and writes dist/index.html with the assets beside it.
// three.js stays external (loaded from jsDelivr via the page's import map).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
// Assets are optimised into .opt/ (WebP textures at shipping sizes, a half-size set for phones, combined
// foliage atlases, decimated models as glTF JSON with inlined buffers) and copied from there. Re-run when a source changes.
const newest = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).reduce((t, e) => Math.max(t, statSync(`${e.parentPath ?? e.path}/${e.name}`).mtimeMs), 0);
const srcTime = Math.max(newest('assets'), statSync('tools/optimize_assets.py').mtimeMs);
if (!existsSync('.opt/.stamp') || statSync('.opt/.stamp').mtimeMs < srcTime) {
  rmSync('.opt', { recursive: true, force: true });
  execFileSync('python3', ['tools/optimize_assets.py', 'assets', '.opt'], { stdio: 'inherit' });
  writeFileSync('.opt/.stamp', '');
}
cpSync('.opt', 'dist/assets', { recursive: true });
rmSync('dist/assets/.stamp');
// Optional intro splash; remove intro.js (and its <script> tag) to drop it.
if (existsSync('intro.js')) cpSync('intro.js', 'dist/intro.js');
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
