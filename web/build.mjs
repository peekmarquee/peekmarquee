// Builds web/dist from web/src. Run: node web/build.mjs (no network needed).
// Output: clean-URL folders (/, /live/, /docs/, /token/, /proof/, /s/ (viewer shell), /404.html, /expired.html)
// nginx: try_files $uri $uri/ =404; and `location ^~ /s/ { try_files /s/index.html =404; }`
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { pages, shell } from './src/pages/pages.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const v = Date.now().toString(36);

// 1. JS: one entry per page + scene (dynamic import → own chunk, never in first load)
const entries = ['landing', 'live', 'viewer', 'docs', 'token', 'proof', 'plain'].map((n) => path.join(src, 'js', `${n}.js`));
const res = await build({
  entryPoints: entries,
  outdir: path.join(dist, 'js'),
  bundle: true, splitting: true, format: 'esm', minify: true, target: 'es2020',
  legalComments: 'none', logLevel: 'warning', metafile: true,
  chunkNames: 'chunk-[hash]',
});

// 2. CSS
await build({ entryPoints: [path.join(src, 'css', 'site.css')], outfile: path.join(dist, 'css', 'site.css'), bundle: true, minify: true, logLevel: 'warning', external: ['/fonts/*', '/assets/*'] });

// 3. static copies
const copyDir = (a, b) => { if (!fs.existsSync(a)) return; fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a)) { const s = path.join(a, f); const d = path.join(b, f); fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d); } };
copyDir(path.join(here, 'assets'), path.join(dist, 'assets'));
copyDir(path.join(here, 'public'), dist);
for (const f of ['token.json', 'deployments.json']) if (fs.existsSync(path.join(here, f))) fs.copyFileSync(path.join(here, f), path.join(dist, f));

// 4. HTML
for (const p of pages) {
  const out = path.join(dist, p.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, shell(p, v));
}

// 5. size report (3D budget ≤220 KB gzip)
const gz = (f) => zlib.gzipSync(fs.readFileSync(f)).length;
const js = fs.readdirSync(path.join(dist, 'js')).map((f) => [f, gz(path.join(dist, 'js', f))]);
const metaOut = res.metafile.outputs;
const sceneChunk = Object.entries(metaOut).filter(([, o]) => Object.keys(o.inputs).some((i) => i.includes('scene/'))).map(([k]) => path.basename(k));
console.log('js gzip KB:', js.map(([f, n]) => `${f}=${(n / 1024).toFixed(1)}`).join(' '));
console.log('scene chunks:', sceneChunk.map((f) => `${f}=${(gz(path.join(dist, 'js', f)) / 1024).toFixed(1)}KB`).join(' '));
console.log('built', pages.length, 'pages →', dist);
