// Minimal static file server that behaves like GitHub Pages: directory indexes,
// a 404.html fallback, no rewrites. Used for `npm run preview` and the e2e tests.
//   node scripts/serve-static.mjs <rootDir> [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const full = normalize(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null; // path traversal
  if (existsSync(full) && statSync(full).isDirectory()) {
    const index = join(full, 'index.html');
    return existsSync(index) ? { file: index, redirect: !decoded.endsWith('/') } : null;
  }
  return existsSync(full) ? { file: full } : null;
}

createServer((req, res) => {
  const hit = resolvePath(req.url ?? '/');
  if (hit?.redirect) {
    res.writeHead(301, { Location: (req.url ?? '/').split('?')[0] + '/' });
    return res.end();
  }
  const file = hit?.file ?? join(root, '404.html');
  const status = hit ? 200 : 404;
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(status, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': 'max-age=600',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}`));
