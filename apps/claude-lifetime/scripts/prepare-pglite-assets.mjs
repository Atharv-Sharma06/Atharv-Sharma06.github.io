// Copies PGlite's WebAssembly assets into public/ as gzip files so the app can
// fetch them from a stable, versioned URL and decompress them in the worker.
// (Static hosts such as GitHub Pages do not compress .data files, so shipping
// them pre-compressed cuts the first-load download from ~15.6 MB to ~5.2 MB.)
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The package does not export ./package.json, so resolve its entry point and walk up from dist/.
const pkgDir = join(dirname(require.resolve('@electric-sql/pglite')), '..');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const outDir = join(root, 'public', 'pglite', version);
mkdirSync(outDir, { recursive: true });

for (const name of ['pglite.wasm', 'pglite.data', 'initdb.wasm']) {
  const src = join(pkgDir, 'dist', name);
  const dest = join(outDir, `${name}.gz`);
  if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) continue;
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dest));
  console.log(`pglite asset: ${name} -> public/pglite/${version}/${name}.gz (${statSync(dest).size} bytes)`);
}
