// Publishes the static export into the portfolio site.
//
// The portfolio is served by GitHub Pages straight from the repository, so the built
// app is committed: `out/` is copied to `<repo root>/claude-lifetime/`, which Pages
// serves at /claude-lifetime/. Run after `npm run build` (or use `npm run publish:site`).
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..', '..');
const out = join(app, 'out');
const target = join(repo, 'claude-lifetime');

if (!existsSync(join(out, 'index.html'))) {
  console.error('No build found in out/. Run `npm run build` first.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(out, target, { recursive: true });

// The bundler emits PGlite's uncompressed WebAssembly and file-system image because
// the library refers to them. The app never requests them: the database worker loads
// the gzip-compressed copies under pglite/ instead (src/db/worker/pglite.worker.ts).
// Leaving them out keeps about 15 MB out of the repository on every publish.
const media = join(target, '_next', 'static', 'media');
let pruned = 0;
for (const name of existsSync(media) ? readdirSync(media) : []) {
  if (/^(pglite|initdb)\.[^/]*\.(wasm|data)$/.test(name)) {
    pruned += statSync(join(media, name)).size;
    rmSync(join(media, name));
  }
}

// GitHub Pages runs Jekyll by default, which drops every path that starts with an
// underscore, including _next/. An empty .nojekyll at the site root turns that off.
const noJekyll = join(repo, '.nojekyll');
if (!existsSync(noJekyll)) writeFileSync(noJekyll, '');

let files = 0;
let bytes = 0;
const largest = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      const size = statSync(path).size;
      files++;
      bytes += size;
      largest.push([size, relative(target, path)]);
    }
  }
};
walk(target);
largest.sort((a, b) => b[0] - a[0]);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`published ${files} files (${mb(bytes)}) to ${relative(repo, target)}/, left out ${mb(pruned)} of unused PGlite assets`);
for (const [size, path] of largest.slice(0, 4)) console.log(`  ${mb(size).padStart(8)}  ${path}`);
