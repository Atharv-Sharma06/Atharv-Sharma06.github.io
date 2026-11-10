// Calibration and validation of src/core/tokens/estimate.ts against the legacy Claude tokenizer
// (`countTokens` from @anthropic-ai/tokenizer).
//
//   node scripts/calibrate-tokens.mjs            validation report over tests/fixtures/tokens/*.txt
//   node scripts/calibrate-tokens.mjs --all      ... plus every corpus found on this machine (about a minute)
//   node scripts/calibrate-tokens.mjs --all --ext <dir>   ... plus <dir>/<language>.txt files (validation only)
//   node scripts/calibrate-tokens.mjs --fit      refit the model on the training split and print the constants
//   node scripts/calibrate-tokens.mjs --fit --write       ... and replace the constants block of estimate.ts
//
// Plain Node is enough: estimate.ts is compiled in memory with esbuild (a devDependency); without esbuild the
// script falls back to Node's own type stripping (Node >= 22.18). `npx tsx scripts/calibrate-tokens.mjs` works too.
//
// Corpora. Nothing third-party is copied into the repository; the machine corpora are read where they are and
// every source is optional:
//   - tests/fixtures/tokens/*.txt   original texts written for this project, one or more per class and language.
//                                   Even-numbered six-line blocks are used for fitting, odd-numbered ones are
//                                   held out.
//   - files found on the machine    licence texts, Markdown, source code in a dozen languages, JSON, CSV, logs
//                                   (/usr/share, /usr/include, /usr/lib/python3, Go and Ruby sources, node_modules)
//   - localisation data             shipped in node_modules: typescript diagnostics, axe-core and zod locales
//   - generated                     numbers, identifiers, URLs, hex and base64 from a seeded generator
//   Every third document of a source is held out ('hold'); the rest is 'train'.
//
// How the fit works. The estimator cuts text into the pieces the legacy tokenizer never merges across (see the
// header of estimate.ts). The reference scanner in this file reports the same pieces, each piece is priced by
// the real tokenizer on its own, and the tables are the (weighted) means or least-squares fits of those prices.
// The reference implementation and estimate.ts must agree exactly; `--fit` checks that.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESTIMATE_TS = join(APP, 'src/core/tokens/estimate.ts');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// ============================================================================================================
// 1. The legacy tokenizer
// ============================================================================================================
const { countTokens, getTokenizer } = require('@anthropic-ai/tokenizer');
const tk = getTokenizer();
/** Same result as countTokens(), without rebuilding the tokenizer on every call. */
const count = (text) => tk.encode(text.normalize('NFKC'), 'all').length;

const pieceCache = new Map();
/** Token count of a short piece, memoised. */
function countPiece(s) {
  let n = pieceCache.get(s);
  if (n === undefined) {
    n = count(s);
    pieceCache.set(s, n);
  }
  return n;
}

let tokLen = null;
/** Byte offsets (in the UTF-8 encoding of the NFKC form) at which the tokens of `s` start. */
function tokenStarts(s) {
  if (!tokLen) {
    tokLen = new Uint16Array(70000);
    for (let id = 0; id < 70000; id++) {
      try {
        tokLen[id] = tk.decode_single_token_bytes(id).length;
      } catch {
        tokLen[id] = 0;
      }
    }
  }
  const ids = tk.encode(s.normalize('NFKC'), 'all');
  const out = new Int32Array(ids.length);
  let off = 0;
  for (let i = 0; i < ids.length; i++) {
    out[i] = off;
    off += tokLen[ids[i]];
  }
  return out;
}

/**
 * Facts read off the vocabulary: which BMP characters are one token (after NFKC), and which 2-byte prefixes
 * of 3-byte UTF-8 characters are tokens (a character of such a 64-code-point block needs 2 tokens, else 3).
 */
function vocabTables() {
  const oneToken = new Uint8Array(0x10000);
  for (let c = 0x80; c < 0x10000; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (count(String.fromCharCode(c)) === 1) oneToken[c] = 1;
  }
  const prefix2 = new Uint8Array(1024);
  for (let id = 0; id < 70000; id++) {
    let b;
    try {
      b = tk.decode_single_token_bytes(id);
    } catch {
      continue;
    }
    if (b.length === 2 && b[0] >= 0xe0 && b[0] <= 0xef && b[1] >= 0x80 && b[1] <= 0xbf) prefix2[(b[0] - 0xe0) * 64 + (b[1] - 0x80)] = 1;
  }
  return { oneToken, prefix2 };
}

// ============================================================================================================
// 2. Corpora
// ============================================================================================================
/** Deterministic PRNG (xorshift32) so generated corpora are identical on every run. */
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function walk(root, accept, maxDepth = 12, out = [], depth = 0) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (depth < maxDepth) walk(p, accept, maxDepth, out, depth + 1);
    } else if (e.isFile() && accept(e.name, p)) out.push(p);
  }
  return out;
}

function readText(p, maxChars) {
  try {
    const st = statSync(p);
    if (st.size === 0 || st.size > 8_000_000) return null;
    let s = readFileSync(p, 'utf8');
    if (s.includes('\u0000') || s.includes('\uFFFD')) return null; // binary or not UTF-8
    if (s.length > maxChars) {
      const cut = s.lastIndexOf('\n', maxChars);
      s = s.slice(0, cut > maxChars / 2 ? cut + 1 : maxChars);
    }
    return s;
  } catch {
    return null;
  }
}

/** Spread deterministically over the file list until `cap` characters are collected. */
function pick(files, cap, { minLen = 600, maxFile = 120_000, filter = null } = {}) {
  const out = [];
  let total = 0;
  const seen = new Set();
  for (const stride of [97, 31, 7, 1]) {
    for (let i = 0; i < files.length && total < cap; i += stride) {
      if (seen.has(i)) continue;
      seen.add(i);
      const text = readText(files[i], maxFile);
      if (!text || text.length < minLen) continue;
      if (filter && !filter(text, files[i])) continue;
      out.push({ name: files[i], text });
      total += text.length;
    }
    if (total >= cap) break;
  }
  return out;
}

const avgLineLen = (t) => t.length / (1 + (t.match(/\n/g) || []).length);
const isMinified = (t) => avgLineLen(t) > 300;
const asciiShare = (t) => {
  let n = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) < 128) n++;
  return n / t.length;
};
const mostlyAscii = (t) => asciiShare(t) > 0.98;

function jsonStrings(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out);
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) jsonStrings(v[k], out);
  return out;
}

/** Cut a document into samples of roughly `size` characters at line boundaries. */
function chunk(text, size = 6000, minTail = 2000) {
  if (text.length <= size + minTail) return [text];
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = start + size;
    if (text.length - end < minTail) end = text.length;
    else {
      const nl = text.indexOf('\n', end);
      end = nl === -1 || nl - end > size ? end : nl + 1;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

// ---------------------------------------------------------------- generated corpora
function genNumbers(rnd, kind) {
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pad = (n, w) => String(n).padStart(w, '0');
  const lines = [];
  if (kind === 'table') {
    lines.push('id        open      high       low     close      volume   change');
    for (let i = 0; i < 90; i++) {
      const open = 20 + rnd() * 400;
      const close = open * (0.95 + rnd() * 0.1);
      lines.push(`${pad(int(1, 99999), 5)}  ${open.toFixed(2).padStart(8)}  ${(Math.max(open, close) * 1.01).toFixed(2).padStart(8)}  ${(Math.min(open, close) * 0.99).toFixed(2).padStart(8)}  ${close.toFixed(2).padStart(8)}  ${String(int(1000, 98000000)).padStart(10)}  ${((close / open - 1) * 100).toFixed(2).padStart(6)}%`);
    }
  } else if (kind === 'times') {
    for (let i = 0; i < 110; i++) {
      const d = `20${pad(int(18, 26), 2)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`;
      const t = `${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}:${pad(int(0, 59), 2)}`;
      const forms = [`${d}T${t}.${pad(int(0, 999), 3)}Z`, `${d} ${t}`, `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${t.slice(0, 5)}`, String(1500000000 + int(0, 290000000)), `${int(1, 12)}:${pad(int(0, 59), 2)} ${rnd() < 0.5 ? 'AM' : 'PM'}`];
      lines.push(`${forms[i % forms.length]}  duration=${int(1, 9000)}ms  bytes=${int(100, 5000000)}  ratio=${rnd().toFixed(4)}`);
    }
  } else if (kind === 'prose') {
    const units = ['kg', 'km', 'ms', 'MB', '%', 'USD', 'EUR', 'items', 'users', 'requests', 'hours', 'pages'];
    const verbs = ['rose to', 'fell to', 'stayed at', 'reached', 'averaged', 'dropped below', 'exceeded'];
    const subjects = ['Revenue', 'The error rate', 'Average latency', 'Memory use', 'The backlog', 'Daily traffic', 'Conversion', 'Storage', 'The budget', 'Head count'];
    for (let i = 0; i < 70; i++) {
      const big = int(1000, 9999999).toLocaleString('en-US');
      lines.push(`${subjects[int(0, 9)]} ${verbs[int(0, 6)]} ${big} ${units[int(0, 11)]} in ${int(1990, 2026)}, compared with ${(rnd() * 1000).toFixed(int(0, 3))} ${units[int(0, 11)]} (${(rnd() * 100).toFixed(1)}%) the year before; ${int(2, 999)} of ${int(1000, 99999)} samples were excluded.`);
    }
  } else {
    for (let i = 0; i < 120; i++) {
      const forms = [
        `+${int(1, 98)} ${int(100, 999)} ${int(100, 999)} ${pad(int(0, 9999), 4)}`,
        `${int(1, 255)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}:${int(1024, 65535)}`,
        `v${int(0, 19)}.${int(0, 40)}.${int(0, 99)}`,
        `${pad(int(0, 9999), 4)} ${pad(int(0, 9999), 4)} ${pad(int(0, 9999), 4)} ${pad(int(0, 9999), 4)}`,
        `${(rnd() * 180 - 90).toFixed(6)}, ${(rnd() * 360 - 180).toFixed(6)}`,
        `${(rnd() * 1e6).toExponential(int(2, 8))}`,
        `${int(1, 999)},${pad(int(0, 999), 3)},${pad(int(0, 999), 3)}.${pad(int(0, 99), 2)}`,
        `#${int(1, 99999)} x${int(1, 64)} @ ${(rnd() * 100).toFixed(2)}`,
      ];
      lines.push(forms[i % forms.length]);
    }
  }
  return lines.join('\n') + '\n';
}

function genIdentifiers(rnd, kind, paths) {
  const bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256)));
  const lines = [];
  if (kind === 'hex') {
    for (let i = 0; i < 60; i++) {
      const h = bytes(32).toString('hex');
      const forms = [h, h.slice(0, 40), `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`, `0x${h.slice(0, 16)}`, h.slice(0, 7), `sha256:${h}`, h.slice(0, 32).toUpperCase(), (h.slice(0, 12).match(/../g) || []).join(':')];
      lines.push(forms[i % forms.length]);
    }
  } else if (kind === 'base64') {
    for (let i = 0; i < 26; i++) {
      const forms = [bytes(48).toString('base64'), bytes(57).toString('base64'), bytes(32).toString('base64url'), `sha512-${bytes(64).toString('base64')}`, `data:application/octet-stream;base64,${bytes(60).toString('base64')}`];
      lines.push(forms[i % forms.length]);
    }
  } else if (kind === 'paths') {
    for (const p of paths) lines.push(p);
  } else {
    const hosts = ['example.com', 'api.example.org', 'cdn.example.net', 'docs.example.io', 'localhost:3000', 'files.example.co.uk'];
    const words = ['users', 'orders', 'items', 'search', 'static', 'assets', 'v1', 'v2', 'api', 'reports', 'images', 'download', 'account', 'settings', 'auth', 'callback', 'products', 'blog'];
    const keys = ['q', 'page', 'limit', 'sort', 'id', 'lang', 'ref', 'utm_source', 'token', 'from', 'to', 'filter'];
    const w = () => words[Math.floor(rnd() * words.length)];
    for (let i = 0; i < 70; i++) {
      let u = `http${rnd() < 0.85 ? 's' : ''}://${hosts[Math.floor(rnd() * hosts.length)]}`;
      const depth = 1 + Math.floor(rnd() * 4);
      for (let d = 0; d < depth; d++) u += '/' + (rnd() < 0.25 ? Math.floor(rnd() * 100000) : w());
      if (rnd() < 0.3) u += ['.html', '.json', '.png', '.js', '.pdf'][Math.floor(rnd() * 5)];
      const nq = Math.floor(rnd() * 4);
      for (let k = 0; k < nq; k++) u += (k === 0 ? '?' : '&') + keys[Math.floor(rnd() * keys.length)] + '=' + (rnd() < 0.5 ? Math.floor(rnd() * 1000) : rnd() < 0.5 ? w() : bytes(6).toString('hex'));
      if (rnd() < 0.15) u += '#' + w();
      lines.push(u);
    }
  }
  return lines.join('\n') + '\n';
}

function genCsv(rnd, variant) {
  const first = ['Ana', 'Ben', 'Chen', 'Dara', 'Emil', 'Fatou', 'Goran', 'Hana', 'Ivo', 'Jun', 'Kofi', 'Lena', 'Mira', 'Nico', 'Omar', 'Pia'];
  const last = ['Novak', 'Silva', 'Okafor', 'Larsen', 'Tanaka', 'Moreau', 'Khan', 'Rossi', 'Petrov', 'Haddad', 'Nguyen', 'Brandt'];
  const cities = ['Lisbon', 'Osaka', 'Nairobi', 'Tallinn', 'Lima', 'Calgary', 'Graz', 'Perth', 'Pune', 'Cork'];
  const status = ['active', 'pending', 'closed', 'on_hold', 'trial'];
  const pick1 = (a) => a[Math.floor(rnd() * a.length)];
  const sep = variant === 1 ? ';' : variant === 2 ? '\t' : ',';
  const rows = [['id', 'first_name', 'last_name', 'email', 'city', 'signup_date', 'plan', 'status', 'balance', 'score'].join(sep)];
  for (let i = 0; i < 70; i++) {
    const f = pick1(first), l = pick1(last);
    rows.push([1000 + i, f, l, `${f}.${l}${Math.floor(rnd() * 90)}@example.com`.toLowerCase(), variant === 0 && rnd() < 0.2 ? `"${pick1(cities)}, ${pick1(['PT', 'JP', 'KE', 'EE', 'PE'])}"` : pick1(cities), `20${String(18 + Math.floor(rnd() * 8)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`, pick1(['free', 'pro', 'team']), pick1(status), (rnd() * 5000 - 500).toFixed(2), Math.floor(rnd() * 100)].join(sep));
  }
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------- main loader
/**
 * Returns samples: { cls, source, name, text, split } where split is 'train', 'hold', 'fixture' or 'ext'.
 * The caller derives the fitting / held-out halves of the fixtures; the external directory is never used for fitting.
 */
function loadCorpora({ appRoot, cap = 900_000, extDir = null, fixturesOnly = false, log = () => {} }) {
  const nm = join(appRoot, 'node_modules');
  const samples = [];
  const addDocs = (cls, source, docs, { size = 6000 } = {}) => {
    // every third document is held out; sources with fewer than three documents are split by chunk instead
    const byChunk = docs.length < 3;
    let k = 0;
    docs.forEach((d, i) => {
      chunk(d.text, size).forEach((text, j) => {
        const split = (byChunk ? k : i) % 3 === 2 ? 'hold' : 'train';
        k++;
        samples.push({ cls, source, name: `${d.name}#${j}`, text, split });
      });
    });
    log(`${cls}/${source}: ${docs.length} documents`);
  };
  const ext = (re) => (n) => re.test(n);

  const machineCorpora = () => {
    // English prose
    addDocs('en-prose', 'licenses', pick(walk('/usr/share/common-licenses', () => true), cap));

    // Markdown and reStructuredText
    addDocs('markdown', 'next-docs', pick(walk(join(nm, 'next/dist/docs'), ext(/\.mdx?$/)), cap));
    addDocs('markdown', 'readmes', pick(walk(nm, ext(/^readme\.md$/i), 3), cap, { minLen: 1500 }));
    addDocs('markdown', 'rst', pick(walk('/usr/share/cmake-3.28/Help', ext(/\.rst$/)), cap / 2, { minLen: 1500 }));

    // Source code
    const jsFiles = walk(nm, (n) => /\.(js|mjs|cjs)$/.test(n) && !/\.min\./.test(n), 6);
    addDocs('code', 'javascript', pick(jsFiles, cap, { filter: (t) => !isMinified(t) && mostlyAscii(t) }));
    addDocs('code', 'typescript', pick(walk(nm, ext(/\.(ts|tsx|mts|cts)$/), 6), cap, { filter: mostlyAscii }));
    addDocs('code', 'python', pick(walk('/usr/lib/python3.12', ext(/\.py$/)).concat(walk('/usr/lib/python3/dist-packages', ext(/\.py$/))), cap, { filter: mostlyAscii }));
    addDocs('code', 'c', pick(walk('/usr/include', ext(/\.h$/)), cap, { filter: mostlyAscii }));
    addDocs('code', 'go', pick(walk('/usr/local/go1.25.1/src', ext(/\.go$/)), cap, { filter: mostlyAscii }));
    addDocs('code', 'ruby', pick(walk('/opt/ruby-3.3.6/lib/ruby', ext(/\.rb$/)), cap, { filter: mostlyAscii }));
    addDocs('code', 'css', pick(walk(nm, ext(/\.css$/), 8), cap / 2, { filter: (t) => !isMinified(t) }));
    addDocs('code', 'sql', pick(walk('/usr/share/postgresql', ext(/\.sql$/)), cap / 2));
    addDocs('code', 'shell', pick(walk('/usr/bin', () => true, 0).concat(walk('/usr/sbin', () => true, 0), walk('/etc', () => true, 2), walk('/usr/local/go1.25.1/src', ext(/\.(sh|bash)$/))), cap / 2, { filter: (t) => /^#!.*\b(ba|da)?sh\b/.test(t.slice(0, 80)) }));
    addDocs('code', 'html-xml', pick(walk('/opt/node22/lib/node_modules', ext(/\.html$/)).concat(walk('/usr/share/mime', ext(/\.xml$/), 1), walk('/usr/share/dbus-1', ext(/\.xml$/))), cap / 2, { filter: (t) => asciiShare(t) > 0.97 }));
    addDocs('code', 'yaml', pick(walk('/opt/google-cloud-sdk/lib/surface', ext(/\.ya?ml$/)), cap / 2));
    addDocs('code-minified', 'javascript', pick(walk(nm, ext(/\.min\.js$/), 6).concat(jsFiles), cap / 2, { filter: (t) => isMinified(t) && mostlyAscii(t) }));
    addDocs('code-minified', 'css', pick(walk(nm, ext(/\.css$/), 8), cap / 3, { filter: isMinified }));

    // JSON
    addDocs('json', 'node_modules', pick(walk(nm, ext(/\.json$/), 5), cap, { maxFile: 60_000, filter: (t, p) => mostlyAscii(t) && !/tokenizer.*claude\.json$/.test(p) }));

    // CSV / tables
    addDocs('tables', 'csv-files', pick(walk('/usr/local/lib/python3.13/dist-packages/numpy', ext(/\.csv$/)).concat(walk('/usr/local/go1.25.1/src', ext(/\.csv$/))), cap / 3, { maxFile: 30_000 }));
    addDocs('tables', 'tab-files', pick(['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/iso3166.tab', '/usr/share/postgresql/16/sql_features.txt', '/usr/share/postgresql/16/errcodes.txt'].filter(existsSync), cap / 3, { maxFile: 40_000 }));
    {
      const rnd = prng(0x51ab1e);
      addDocs('tables', 'generated', Array.from({ length: 9 }, (_, i) => ({ name: `generated-csv-${i}`, text: genCsv(rnd, i % 3) })));
    }

    // Logs and stack traces
    addDocs('logs', 'var-log', pick(['/var/log/dpkg.log', '/var/log/alternatives.log', '/var/log/bootstrap.log', '/var/log/apt/history.log', '/var/log/apt/term.log', '/var/log/fontconfig.log'].filter(existsSync), cap / 2, { maxFile: 150_000 }));

    // URLs, paths, hex, base64
    {
      const lock = readText(join(appRoot, 'package-lock.json'), 240_000);
      if (lock) addDocs('urls-hex-base64', 'lockfile', [{ name: 'package-lock.json', text: lock }]);
      const rnd = prng(0xc0ffee);
      const allPaths = walk(nm, () => true, 5).filter((_, i) => i % 211 === 0).slice(0, 600);
      const docs = [];
      for (let i = 0; i < 6; i++) docs.push({ name: `generated-hex-${i}`, text: genIdentifiers(rnd, 'hex') });
      for (let i = 0; i < 6; i++) docs.push({ name: `generated-base64-${i}`, text: genIdentifiers(rnd, 'base64') });
      for (let i = 0; i < 6; i++) docs.push({ name: `generated-urls-${i}`, text: genIdentifiers(rnd, 'urls') });
      for (let i = 0; i < 6; i++) docs.push({ name: `paths-${i}`, text: genIdentifiers(rnd, 'paths', allPaths.slice(i * 100, i * 100 + 100)) });
      for (let i = 0; i < 6; i++) docs.push({ name: `sha256-of-paths-${i}`, text: allPaths.slice(i * 60, i * 60 + 60).map((p) => `${createHash('sha256').update(p).digest('hex')}  ${basename(p)}`).join('\n') + '\n' });
      addDocs('urls-hex-base64', 'generated', docs);
    }

    // Numbers-heavy text
    {
      const rnd = prng(0x0ddba11);
      const docs = [];
      for (const kind of ['table', 'times', 'prose', 'misc']) for (let i = 0; i < 5; i++) docs.push({ name: `generated-numbers-${kind}-${i}`, text: genNumbers(rnd, kind) });
      addDocs('numbers', 'generated', docs);
      addDocs('numbers', 'tzdata', pick(['/usr/share/zoneinfo/tzdata.zi', '/usr/share/zoneinfo/leap-seconds.list'].filter(existsSync), cap / 4, { maxFile: 60_000 }));
    }

    // Non-English languages: localisation data shipped inside node_modules.
    const langDocs = new Map();
    const addLang = (lang, source, text) => {
      if (text.length < 400) return;
      const k = `lang-${lang}|${source}`;
      if (!langDocs.has(k)) langDocs.set(k, []);
      // split long localisation dumps into several documents so that both splits get text
      const parts = chunk(text, 12_000, 4000);
      parts.forEach((t, i) => langDocs.get(k).push({ name: `${source}:${lang}:${i}`, text: t }));
    };
    const tsLangs = { de: 'de', es: 'es', fr: 'fr', it: 'it', 'pt-br': 'pt', ru: 'ru', ja: 'ja', ko: 'ko', 'zh-cn': 'zh', 'zh-tw': 'zh-hant', cs: 'cs', pl: 'pl', tr: 'tr' };
    for (const [dir, lang] of Object.entries(tsLangs)) {
      const p = join(nm, 'typescript/lib', dir, 'diagnosticMessages.generated.json');
      if (!existsSync(p)) continue;
      try {
        addLang(lang, 'typescript', Object.values(JSON.parse(readFileSync(p, 'utf8'))).join('\n') + '\n');
      } catch {}
    }
    const axeLangs = { de: 'de', es: 'es', fr: 'fr', it: 'it', pt_BR: 'pt', pt_PT: 'pt', ru: 'ru', ja: 'ja', ko: 'ko', zh_CN: 'zh', zh_TW: 'zh-hant', el: 'el', he: 'he', pl: 'pl', da: 'da', nl: 'nl', sv: 'sv', nb: 'nb', eu: 'eu', az: 'az', _template: 'en' };
    for (const [file, lang] of Object.entries(axeLangs)) {
      const p = join(nm, 'axe-core/locales', `${file}.json`);
      if (!existsSync(p)) continue;
      try {
        addLang(lang, `axe-core${file.startsWith('pt_') ? '-' + file.slice(3) : ''}`, jsonStrings(JSON.parse(readFileSync(p, 'utf8')), []).join('\n') + '\n');
      } catch {}
    }
    const zodDir = join(nm, 'zod/v4/locales');
    if (existsSync(zodDir)) {
      const zodLangs = { ar: 'ar', bn: 'bn', hi: 'hi', th: 'th', uk: 'uk', he: 'he', el: 'el', ru: 'ru', fa: 'fa', ur: 'ur', ta: 'ta', ja: 'ja', ko: 'ko', 'zh-CN': 'zh', 'zh-TW': 'zh-hant', es: 'es', fr: 'fr', de: 'de', it: 'it', pt: 'pt', vi: 'vi', id: 'id', nl: 'nl', sv: 'sv', fi: 'fi', hu: 'hu', bg: 'bg', ka: 'ka', hy: 'hy', km: 'km', kn: 'kn', gu: 'gu', ne: 'ne', be: 'be', mk: 'mk' };
      for (const [file, lang] of Object.entries(zodLangs)) {
        const p = join(zodDir, `${file}.js`);
        if (!existsSync(p)) continue;
        const src = readFileSync(p, 'utf8');
        // keep the human-language string literals (anything quoted that contains a non-ASCII letter)
        const strings = [];
        for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (/[^\x00-\x7f]/.test(m[2])) strings.push(m[2]);
        addLang(lang, 'zod', strings.join('\n') + '\n');
      }
    }
    for (const [k, docs] of langDocs) {
      const [cls, source] = k.split('|');
      addDocs(cls, source, docs);
    }
  };
  if (!fixturesOnly) machineCorpora();

  // Hand-written fixtures committed to the repo.
  const fixDir = join(appRoot, 'tests/fixtures/tokens');
  if (existsSync(fixDir)) {
    for (const f of readdirSync(fixDir).sort()) {
      if (!f.endsWith('.txt')) continue;
      const cls = fixtureClass(f);
      samples.push({ cls, source: 'fixture', name: f, text: readFileSync(join(fixDir, f), 'utf8'), split: 'fixture' });
    }
  }

  // Optional external directory: <extDir>/<class>/*.txt or <extDir>/<lang>.txt (validation only).
  if (extDir && existsSync(extDir)) {
    for (const f of readdirSync(extDir).sort()) {
      if (!f.endsWith('.txt')) continue;
      const lang = f.replace(/\.txt$/, '').replace(/^pt-br$/, 'pt');
      samples.push({ cls: lang === 'en' ? 'en-prose' : `lang-${lang}`, source: 'external', name: `ext:${f}`, text: readFileSync(join(extDir, f), 'utf8'), split: 'ext' });
    }
  }
  return samples;
}

/** Map a fixture file name to its report class: the part before the first dot. */
function fixtureClass(file) {
  const head = file.split('.')[0];
  const map = { 'en-chat': 'en-chat', 'en-prose': 'en-prose', markdown: 'markdown', code: 'code', json: 'json', tables: 'tables', logs: 'logs', urls: 'urls-hex-base64', numbers: 'numbers', emoji: 'emoji' };
  return map[head] ?? head; // lang-xx stays as is
}

// ============================================================================================================
// 3. The model: character classes and the reference scanner (must mirror src/core/tokens/estimate.ts)
// ============================================================================================================
// ---- character kinds (ASCII) and non-ASCII groups ----
const K = { SP: 0, NL: 1, WS: 2, LO: 3, UP: 4, DG: 5, PU: 6, LX: 7, HS: 8, LS: 9, X: 10 };
// Non-ASCII groups (for kind X and LX): index into the per-group coefficient tables.
const GROUPS = ['latin', 'greek', 'cyrillic', 'hebrew', 'arabic', 'devanagari', 'indic', 'thai', 'han', 'kana', 'hangul', 'symbol', 'mark', 'other', 'emoji', 'astral'];
const G = Object.fromEntries(GROUPS.map((g, i) => [g, i]));

/** [first, last, group] ranges for the Basic Multilingual Plane; later entries override earlier ones. */
const GROUP_RANGES = [
  [0x0080, 0xffff, 'other'],
  [0x00a1, 0x00bf, 'symbol'],
  [0x00aa, 0x00aa, 'latin'], [0x00b5, 0x00b5, 'latin'], [0x00ba, 0x00ba, 'latin'],
  [0x00c0, 0x02af, 'latin'], [0x00d7, 0x00d7, 'symbol'], [0x00f7, 0x00f7, 'symbol'],
  [0x02b0, 0x02ff, 'symbol'],
  [0x0300, 0x036f, 'latin'], // combining marks of decomposed (NFD) text: counted as letters with diacritics
  [0x0370, 0x03ff, 'greek'], [0x1f00, 0x1fff, 'greek'],
  [0x0400, 0x052f, 'cyrillic'],
  [0x0590, 0x05ff, 'hebrew'], [0xfb1d, 0xfb4f, 'hebrew'],
  [0x0600, 0x06ff, 'arabic'], [0x0750, 0x077f, 'arabic'], [0x08a0, 0x08ff, 'arabic'], [0xfb50, 0xfdff, 'arabic'], [0xfe70, 0xfefe, 'arabic'],
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x0dff, 'indic'],
  [0x0e00, 0x0eff, 'thai'],
  [0x1e00, 0x1eff, 'latin'], [0x2c60, 0x2c7f, 'latin'], [0xa720, 0xa7ff, 'latin'], [0xfb00, 0xfb06, 'latin'],
  [0x2010, 0x2027, 'symbol'], [0x2030, 0x205e, 'symbol'], [0x2070, 0x20cf, 'symbol'], [0x2100, 0x2bff, 'symbol'], [0x2e00, 0x2e7f, 'symbol'],
  [0x200b, 0x200f, 'mark'], [0x202a, 0x202e, 'mark'], [0x2060, 0x206f, 'mark'], [0x20d0, 0x20ff, 'mark'], [0xfe00, 0xfe0f, 'mark'], [0xfe20, 0xfe2f, 'mark'], [0xfeff, 0xfeff, 'mark'],
  [0x2e80, 0x2fdf, 'han'], [0x3400, 0x4dbf, 'han'], [0x4e00, 0x9fff, 'han'], [0xf900, 0xfaff, 'han'],
  [0x3001, 0x303f, 'symbol'], [0x3200, 0x33ff, 'symbol'], [0x4dc0, 0x4dff, 'symbol'], [0xfe10, 0xfe1f, 'symbol'], [0xfe30, 0xfe6f, 'symbol'], [0xff5f, 0xff65, 'symbol'], [0xffe0, 0xffee, 'symbol'],
  [0x3040, 0x30ff, 'kana'], [0x31f0, 0x31ff, 'kana'], [0xff66, 0xff9f, 'kana'],
  [0xac00, 0xd7a3, 'hangul'],
];
/** Characters that count as a plain space / other whitespace / digits although they are not ASCII. */
const SPACE_LIKE = [0x00a0, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000];
const WS_LIKE = [0x0085, 0x1680, 0x2028, 0x2029];
const DIGIT_LIKE = [0x00b2, 0x00b3, 0x00b9];

/** First and last code point of the Cyrillic letters that get an individual fitted cost (upper case is folded onto lower case). */
const CYR_FIRST = 0x0430;
const CYR_COUNT = 48; // U+0430..U+045F
const N_GENERIC = GROUPS.length * 3; // class = 1 + group * 3 + (cost1 - 1)
const N_CLASSES = 1 + N_GENERIC + CYR_COUNT;
const classOf = (group, cost1) => 1 + group * 3 + (cost1 - 1);
const groupOfClass = (cls) => (cls > N_GENERIC ? G.cyrillic : Math.floor((cls - 1) / 3));
/** Prior cost of a class before fitting: the number of tokens the character needs on its own. */
const classPrior = (cls) => (cls > N_GENERIC ? 1 : ((cls - 1) % 3) + 1);

/**
 * Builds the per-code-unit tables:
 *  kind[c] - one of K.*
 *  cls[c]  - cost class of a non-ASCII character: script group x standalone token count (1, 2 or 3),
 *            or an individual class for the common Cyrillic letters
 * `oneToken` is a Uint8Array(65536) flag table (the character is a single token after NFKC),
 * `prefix2` a Uint8Array(1024) flag table per 64-code-point block (its 2-byte UTF-8 prefix is a token).
 */
function buildTables(oneToken, prefix2) {
  const kind = new Uint8Array(0x10000).fill(K.X);
  const group = new Uint8Array(0x10000);
  const cls = new Uint8Array(0x10000);
  for (let c = 0; c < 0x80; c++) {
    kind[c] = c === 0x20 ? K.SP : c === 0x0a ? K.NL : c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d ? K.WS : c >= 0x61 && c <= 0x7a ? K.LO : c >= 0x41 && c <= 0x5a ? K.UP : c >= 0x30 && c <= 0x39 ? K.DG : K.PU;
  }
  for (const [a, b, g] of GROUP_RANGES) for (let c = a; c <= b; c++) group[c] = G[g];
  for (let c = 0x80; c < 0x10000; c++) {
    const cost1 = oneToken[c] ? 1 : c < 0x800 ? 2 : prefix2[c >> 6] ? 2 : 3;
    cls[c] = classOf(group[c], cost1);
    if (group[c] === G.latin) kind[c] = K.LX;
  }
  // common Cyrillic letters: U+0410..U+042F fold onto U+0430..U+044F, U+0400..U+040F onto U+0450..U+045F
  for (let i = 0; i < CYR_COUNT; i++) {
    const lower = CYR_FIRST + i;
    const upper = i < 32 ? lower - 0x20 : lower - 0x50;
    cls[lower] = cls[upper] = 1 + N_GENERIC + i;
  }
  for (const s of SPACE_LIKE) for (let c = Array.isArray(s) ? s[0] : s; c <= (Array.isArray(s) ? s[1] : s); c++) kind[c] = K.SP;
  for (const c of WS_LIKE) kind[c] = K.WS;
  for (const c of DIGIT_LIKE) kind[c] = K.DG;
  // full-width ASCII variants normalise to ASCII, so they take the ASCII kinds
  for (let c = 0xff01; c <= 0xff5e; c++) kind[c] = kind[c - 0xfee0];
  for (let c = 0xd800; c <= 0xdbff; c++) kind[c] = K.HS;
  for (let c = 0xdc00; c <= 0xdfff; c++) kind[c] = K.LS;
  return { kind, cls };
}

/** Astral code point -> cost class. Six 64-code-point emoji blocks have a 3-byte prefix token (2 tokens), the rest need 3. */
function astralClass(cp) {
  if (cp >= 0x1f000 && cp <= 0x1faff) {
    const b = cp >> 6;
    return classOf(G.emoji, b === 0x7cc || b === 0x7d1 || b === 0x7d2 || b === 0x7d4 || b === 0x7d8 || b === 0x7da ? 2 : 3);
  }
  if (cp >= 0x20000 && cp <= 0x3ffff) return classOf(G.han, 3);
  return classOf(G.astral, 3);
}
const CLASS_LONE_SURROGATE = classOf(G.other, 3);

/** ASCII punctuation index 0..31 (in ASCII order); 32 = control characters. */
const N_PUNCT = 33;
function punctIndex(c) {
  if (c >= 0x21 && c <= 0x2f) return c - 0x21;
  if (c >= 0x3a && c <= 0x40) return c - 0x3a + 15;
  if (c >= 0x5b && c <= 0x60) return c - 0x5b + 22;
  if (c >= 0x7b && c <= 0x7e) return c - 0x7b + 28;
  if (c >= 0xff01 && c <= 0xff5e) return punctIndex(c - 0xfee0);
  return 32;
}

// ---- Latin word segments ----
// first segment of a letter run: lower / Capitalised / UPPER  x  after a space / after a digit / anything else;
// later segments of the same run (camelCase humps): Capitalised or UPPER.
const SEG = { LOWER_SP: 0, LOWER: 1, LOWER_DG: 2, CAP_SP: 3, CAP: 4, CAP_DG: 5, UPPER_SP: 6, UPPER: 7, UPPER_DG: 8, IN_CAP: 9, IN_UPPER: 10 };
const SEG_NAMES = ['lower_sp', 'lower', 'lower_dg', 'cap_sp', 'cap', 'cap_dg', 'upper_sp', 'upper', 'upper_dg', 'in_cap', 'in_upper'];
const NSEG = SEG_NAMES.length;
const NSYM = 28; // 26 letters, 26 = letter with diacritic, 27 = word boundary

/**
 * Scans `text` and reports the model's pieces to `sink`:
 *   ws(tokens)                              whitespace tokens (rule based)
 *   contraction(start, end)                 's 't 're 've 'm 'll 'd directly after a letter or digit
 *   digits(start, end, lead, n)
 *   punct(start, end, lead)                 a run of ASCII punctuation
 *   latin(start, end, lead, segs, lx)       segs = [seg, len, seg, len, ...], lx = cost classes of the diacritic letters
 *   bigram(key)                             letter-pair profile increments (key = prev * NSYM + cur)
 *   other(start, end, lead, classes)        a run of non-ASCII characters and their cost classes
 *   endLine()
 * `start` includes the attached leading space when lead === 1.
 */
function scan(text, T, sink) {
  const { kind, cls } = T;
  const n = text.length;
  let i = 0;
  let lead = 0;
  let afterAlnum = false;
  let afterDigit = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    const k = kind[c];
    if (k <= K.WS) {
      let j = i;
      let last = k;
      while (j < n) {
        const kk = kind[text.charCodeAt(j)];
        if (kk > K.WS) break;
        if (kk === K.NL) sink.endLine();
        last = kk;
        j++;
      }
      const len = j - i;
      if (j === n) {
        sink.ws(1 + (len > 64 ? 1 : 0));
        lead = 0;
      } else {
        const head = len - 1;
        let t = head > 0 ? 1 + (head > 64 ? 1 : 0) : 0;
        if (last === K.SP) lead = 1;
        else {
          t += 1;
          lead = 0;
        }
        if (t) sink.ws(t);
      }
      afterAlnum = false;
      afterDigit = false;
      i = j;
    } else if (k === K.LO || k === K.UP || k === K.LX) {
      const start = i - lead;
      const segs = [];
      const lx = [];
      let segLen = 0;
      let segType = 0; // 0 lower, 1 Capitalised, 2 UPPER
      let first = true;
      let prev = 27;
      const close = (len, type) => {
        const t = type === 2 && len === 1 ? 1 : type;
        const g = first ? t * 3 + (lead ? 0 : afterDigit ? 2 : 1) : t === 2 ? SEG.IN_UPPER : SEG.IN_CAP;
        segs.push(g, len);
        first = false;
      };
      let j = i;
      for (; j < n; j++) {
        const cc = text.charCodeAt(j);
        const kk = kind[cc];
        if (kk !== K.LO && kk !== K.UP && kk !== K.LX) break;
        const lower = cc | 0x20;
        const sym = kk === K.LX ? 26 : (cc < 0x80 ? lower : (cc - 0xfee0) | 0x20) - 97;
        sink.bigram(prev * NSYM + sym);
        prev = sym;
        if (kk === K.LX) lx.push(cls[cc]);
        const up = kk === K.UP;
        if (segLen === 0) {
          segType = up ? 2 : 0;
          segLen = 1;
        } else if (up) {
          if (segType === 2) segLen++;
          else {
            close(segLen, segType);
            segType = 2;
            segLen = 1;
          }
        } else if (segType === 2) {
          if (segLen === 1) {
            segType = 1;
            segLen = 2;
          } else {
            close(segLen - 1, 2);
            segType = 1;
            segLen = 2;
          }
        } else segLen++;
      }
      close(segLen, segType);
      sink.bigram(prev * NSYM + 27);
      sink.latin(start, j, lead, segs, lx);
      lead = 0;
      afterAlnum = true;
      afterDigit = false;
      i = j;
    } else if (k === K.DG) {
      let j = i + 1;
      while (j < n && kind[text.charCodeAt(j)] === K.DG) j++;
      sink.digits(i - lead, j, lead, j - i);
      lead = 0;
      afterAlnum = true;
      afterDigit = true;
      i = j;
    } else if (k === K.PU) {
      if (c === 0x27 && afterAlnum && i + 1 < n) {
        const c1 = text.charCodeAt(i + 1);
        const c2 = i + 2 < n ? text.charCodeAt(i + 2) : 0;
        let len = 0;
        if (c1 === 0x73 || c1 === 0x74 || c1 === 0x6d || c1 === 0x64) len = 2; // 's 't 'm 'd
        else if ((c1 === 0x72 && c2 === 0x65) || (c1 === 0x76 && c2 === 0x65) || (c1 === 0x6c && c2 === 0x6c)) len = 3; // 're 've 'll
        if (len) {
          sink.contraction(i, i + len);
          i += len;
          continue; // afterAlnum stays true, lead stays 0
        }
      }
      let j = i + 1;
      while (j < n && kind[text.charCodeAt(j)] === K.PU) j++;
      sink.punct(i - lead, j, lead);
      lead = 0;
      afterAlnum = false;
      afterDigit = false;
      i = j;
    } else {
      // run of non-ASCII, non-Latin characters (any mix of scripts and symbols)
      const start = i - lead;
      const classes = [];
      let j = i;
      while (j < n) {
        const cc = text.charCodeAt(j);
        const kk = kind[cc];
        if (kk === K.X) {
          classes.push(cls[cc]);
          j++;
        } else if (kk === K.HS) {
          const lo = j + 1 < n ? text.charCodeAt(j + 1) : 0;
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            classes.push(astralClass(((cc - 0xd800) << 10) + (lo - 0xdc00) + 0x10000));
            j += 2;
          } else {
            classes.push(CLASS_LONE_SURROGATE);
            j++;
          }
        } else if (kk === K.LS) {
          classes.push(CLASS_LONE_SURROGATE);
          j++;
        } else break;
      }
      sink.other(start, j, lead, classes);
      lead = 0;
      afterAlnum = false;
      afterDigit = false;
      i = j;
    }
  }
  sink.endLine();
}

// ============================================================================================================
// 4. Reference estimator: the scanner plus a parameter set
// ============================================================================================================
const LM = 16; // Latin segment lengths 1..LM are tabulated; longer segments extrapolate linearly
const DLEN = 8; // digit-run lengths 1..DLEN are tabulated
/** Segment classes whose cost depends on the line profile z. */
const B_SEGS = [SEG.LOWER_SP, SEG.LOWER, SEG.CAP_SP, SEG.CAP];
/** Longest length with enough data to tabulate, per segment class; beyond it the fit is linear. */
const SEG_FIT_LEN = [14, 14, 8, 12, 12, 6, 10, 10, 8, 10, 8];
const SEG_FREE = 3; // segments of one letter run beyond this many pay SEGX each

function defaultParams() {
  const tab = () => Array.from({ length: NSEG }, () => new Array(LM + 1).fill(0));
  return {
    LM, KAPPA: 12, ZMIN: -1, ZMAX: 3,
    A: tab(), B: tab(), SEGX: 0, U: new Array(NSYM * NSYM).fill(0),
    CH: Array.from({ length: N_CLASSES }, (_, c) => (c === 0 ? 0 : classPrior(c))), RUN: GROUPS.map(() => [0, 0]),
    D: [new Array(DLEN + 1).fill(1), new Array(DLEN + 1).fill(1)], DS: 0.42,
    PB: new Array(N_PUNCT * N_PUNCT).fill(0.5),
  };
}

function makeEstimator(P, T, { round = true } = {}) {
  const { A, B, U, CH, RUN, D, DS, PB, KAPPA, ZMIN, ZMAX, SEGX } = P;
  return (text) => {
    let total = 0, lineA = 0, lineB = 0, lineU = 0, lineN = 0;
    scan(text, T, {
      ws: (t) => { total += t; },
      contraction: () => { total += 1; },
      digits: (a, b, lead, n) => { total += n <= DLEN ? D[lead][n] : D[lead][DLEN] + DS * (n - DLEN); },
      punct: (a, b, lead) => {
        let t = 1;
        let p = punctIndex(text.charCodeAt(a + lead));
        for (let i = a + lead + 1; i < b; i++) { const q = punctIndex(text.charCodeAt(i)); t += PB[p * N_PUNCT + q]; p = q; }
        total += t;
      },
      latin: (a, b, lead, segs, lx) => {
        for (let i = 0; i < segs.length; i += 2) {
          const g = segs[i], len = segs[i + 1];
          if (len <= LM) { lineA += A[g][len]; lineB += B[g][len]; } else { lineA += A[g][LM] + A[g][0] * (len - LM); lineB += B[g][LM] + B[g][0] * (len - LM); }
        }
        if (segs.length > 2 * SEG_FREE) lineA += SEGX * (segs.length / 2 - SEG_FREE);
        for (const c of lx) total += CH[c];
      },
      bigram: (k) => { lineU += U[k]; lineN++; },
      other: (a, b, lead, classes) => {
        total += RUN[groupOfClass(classes[0])][lead];
        for (let i = 0; i < classes.length; i++) total += CH[classes[i]];
      },
      endLine: () => {
        if (lineN > 0) {
          const z = Math.min(ZMAX, Math.max(ZMIN, lineU / (lineN + KAPPA)));
          const t = lineA + z * lineB;
          if (t > 0) total += t;
          lineA = lineB = lineU = lineN = 0;
        }
      },
    });
    return round ? Math.max(0, Math.round(total)) : total;
  };
}

// ============================================================================================================
// 5. Fitting
// ============================================================================================================
const HYPER = { KAPPA: 12, ZMIN: -1, ZMAX: 3, ITERS: 8, RIDGE_U: 1e-2, RIDGE_T: 1e-4, RIDGE_O: 2, PUNCT_KAPPA: 0.5, U_CLIP: 60 };
const LATIN_MAIN = new Set(['lang-es', 'lang-fr', 'lang-de', 'lang-pt', 'lang-it']);
const LATIN_OTHER = new Set(['lang-pl', 'lang-cs', 'lang-tr', 'lang-sv', 'lang-da', 'lang-nb', 'lang-nl', 'lang-eu', 'lang-az', 'lang-vi', 'lang-id', 'lang-fi', 'lang-hu']);
const SCRIPT_MAIN = new Set(['lang-ru', 'lang-uk', 'lang-el', 'lang-ar', 'lang-he', 'lang-hi', 'lang-bn', 'lang-th', 'lang-zh', 'lang-ja', 'lang-ko']);

/** Relative weight of a class in the fit (its token mass is normalised away, so this is a share, not a size). */
function classShare(cls) {
  if (cls === 'en-prose' || cls === 'markdown') return 3;
  if (cls === 'en-chat' || cls === 'lang-en') return 2;
  if (cls === 'code') return 5;
  if (cls === 'code-minified') return 0.6;
  if (cls === 'json') return 1.5;
  if (cls === 'tables' || cls === 'logs') return 1;
  if (cls === 'urls-hex-base64' || cls === 'numbers') return 0.8;
  if (cls === 'emoji') return 0.5;
  if (LATIN_MAIN.has(cls)) return 1.2;
  if (LATIN_OTHER.has(cls)) return 0.25;
  if (SCRIPT_MAIN.has(cls)) return 1;
  if (cls === 'lang-zh-hant') return 0.5;
  return 0.05; // other languages in non-Latin scripts: tiny samples, kept only as a tie-breaker
}

function solveSPD(M, v, n, ridge) {
  const A = Float64Array.from(M), b = Float64Array.from(v);
  for (let i = 0; i < n; i++) A[i * n + i] += ridge;
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
    d = Math.sqrt(Math.max(d, 1e-12));
    A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / d;
    }
  }
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= A[i * n + k] * b[k]; b[i] = s / A[i * n + i]; }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * b[k]; b[i] = s / A[i * n + i]; }
  return b;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Fits every table of the model on the samples whose split is 'train' or 'fx-train'.
 * Every piece the scanner reports is priced by the real tokenizer on its own (pieces never merge), so the
 * targets are exact; only the Latin-word part needs an iterative fit because of the per-line profile z.
 */
function fitModel(S, T, V, log) {
  const { KAPPA, ZMIN, ZMAX, ITERS, RIDGE_U, RIDGE_T, RIDGE_O } = HYPER;
  const train = S.filter((s) => s.split === 'train' || s.split === 'fx-train');
  {
    // weight per sample: class share, split evenly over the class's sources, divided by the source's token mass
    const mass = new Map();
    const sources = new Map();
    for (const s of train) {
      const k = s.cls + '|' + s.source;
      mass.set(k, (mass.get(k) ?? 0) + s.actual);
      if (!sources.has(s.cls)) sources.set(s.cls, new Set());
      sources.get(s.cls).add(s.source);
    }
    for (const s of train) s.w = (classShare(s.cls) / sources.get(s.cls).size / mass.get(s.cls + '|' + s.source)) * 1e6;
  }

  // ---- collect
  const NA = NSEG * (LM + 1);
  const dig = { w: [new Float64Array(DLEN + 1), new Float64Array(DLEN + 1)], t: [new Float64Array(DLEN + 1), new Float64Array(DLEN + 1)], tail: [] };
  const pairCnt = new Float64Array(N_PUNCT * N_PUNCT), pairBnd = new Float64Array(N_PUNCT * N_PUNCT);
  const punctCache = new Map();
  const pieceId = new Map();
  const pTarget = [], pFeatA = [], pFeatB = [], pLx = [], pSegx = [];
  const lineW = [], lineNW = [], linePieces = [], lineBig = [], lineN = [], lineInitZ = [], lineCls = [];
  const otherRows = [];
  const LX1 = classOf(G.latin, 1);
  for (const s of train) {
    const text = s.text;
    const w = s.w;
    let curPieces = new Map();
    let curBig = new Map();
    let curN = 0;
    scan(text, T, {
      ws: () => {},
      contraction: () => {},
      digits: (a, b, lead, n) => {
        const t = countPiece(text.slice(a, b));
        if (n <= DLEN) { dig.w[lead][n] += w; dig.t[lead][n] += w * t; } else dig.tail.push([w, lead, n, t]);
      },
      punct: (a, b, lead) => {
        const str = text.slice(a, b);
        let e = punctCache.get(str);
        if (e === undefined) {
          // [pairIndex, isTokenBoundary, ...] for every adjacent pair of the run
          e = [];
          if (str.normalize('NFKC').length === str.length) {
            const isStart = new Uint8Array(str.length + 1);
            for (const o of tokenStarts(str)) isStart[o] = 1;
            for (let i = lead + 1; i < str.length; i++) e.push(punctIndex(str.charCodeAt(i - 1)) * N_PUNCT + punctIndex(str.charCodeAt(i)), isStart[i]);
          }
          punctCache.set(str, e);
        }
        for (let i = 0; i < e.length; i += 2) { pairCnt[e[i]] += w; pairBnd[e[i]] += w * e[i + 1]; }
      },
      latin: (a, b, lead, segs, lx) => {
        const str = text.slice(a, b);
        let id = pieceId.get(str);
        if (id === undefined) {
          id = pTarget.length;
          pieceId.set(str, id);
          pTarget.push(countPiece(str));
          const fa = new Map(), fb = new Map();
          for (let i = 0; i < segs.length; i += 2) {
            const g = segs[i], len = segs[i + 1], L = SEG_FIT_LEN[g];
            const idx = g * (LM + 1) + Math.min(len, L);
            fa.set(idx, (fa.get(idx) ?? 0) + 1);
            if (len > L) fa.set(g * (LM + 1), (fa.get(g * (LM + 1)) ?? 0) + (len - L));
            if (B_SEGS.includes(g)) {
              fb.set(idx, (fb.get(idx) ?? 0) + 1);
              if (len > L) fb.set(g * (LM + 1), (fb.get(g * (LM + 1)) ?? 0) + (len - L));
            }
          }
          pFeatA.push(Float64Array.from([...fa.entries()].flat()));
          pFeatB.push(Float64Array.from([...fb.entries()].flat()));
          const l = [0, 0, 0];
          for (const c of lx) l[c - LX1]++;
          pLx.push(l);
          pSegx.push(Math.max(0, segs.length / 2 - SEG_FREE));
        }
        curPieces.set(id, (curPieces.get(id) ?? 0) + 1);
      },
      bigram: (k) => { curBig.set(k, (curBig.get(k) ?? 0) + 1); curN++; },
      other: (a, b, lead, classes) => {
        const f = new Map();
        for (const c of classes) f.set(c, (f.get(c) ?? 0) + 1);
        f.set(N_CLASSES + groupOfClass(classes[0]) * 2 + lead, 1);
        otherRows.push([w, [...f.entries()].flat(), countPiece(text.slice(a, b))]);
      },
      endLine: () => {
        if (curPieces.size === 0) { if (curN) { curBig = new Map(); curN = 0; } return; }
        let nw = 0;
        for (const c of curPieces.values()) nw += c;
        lineW.push(w); lineNW.push(nw); lineN.push(curN);
        linePieces.push(Int32Array.from([...curPieces.entries()].flat()));
        lineBig.push(Uint16Array.from([...curBig.entries()].flat()));
        lineInitZ.push(LATIN_MAIN.has(s.cls) || LATIN_OTHER.has(s.cls) ? 1 : 0);
        lineCls.push(s.cls);
        curPieces = new Map(); curBig = new Map(); curN = 0;
      },
    });
  }
  log(`fit: ${train.length} training samples, ${pTarget.length} distinct Latin words on ${lineW.length} lines, ${punctCache.size} distinct punctuation runs, ${otherRows.length} non-ASCII runs`);

  const P = defaultParams();
  P.KAPPA = KAPPA; P.ZMIN = ZMIN; P.ZMAX = ZMAX;

  // ---- digits: mean tokens by run length; linear beyond DLEN
  for (let lead = 0; lead < 2; lead++) for (let n = 1; n <= DLEN; n++) P.D[lead][n] = dig.w[lead][n] > 0 ? dig.t[lead][n] / dig.w[lead][n] : 1 + 0.42 * (n - 1);
  {
    let sxx = 0, sxy = 0;
    for (const [w, lead, n, t] of dig.tail) { const x = n - DLEN; sxx += w * x * x; sxy += w * x * (t - P.D[lead][DLEN]); }
    P.DS = sxx > 0 ? sxy / sxx : 0.42;
  }

  // ---- punctuation: probability of a token boundary between two adjacent characters (smoothed counts)
  {
    let dc = 0, db = 0, oc = 0, ob = 0;
    for (let a = 0; a < N_PUNCT; a++) for (let b = 0; b < N_PUNCT; b++) { const i = a * N_PUNCT + b; if (a === b) { dc += pairCnt[i]; db += pairBnd[i]; } else { oc += pairCnt[i]; ob += pairBnd[i]; } }
    const pd = db / dc, po = ob / oc;
    const unit = ((dc + oc) / 2e5) * HYPER.PUNCT_KAPPA; // prior strength: a tiny fraction of the total weight
    for (let a = 0; a < N_PUNCT; a++) for (let b = 0; b < N_PUNCT; b++) { const i = a * N_PUNCT + b; const p0 = a === b ? pd : Math.max(po, 0.75); P.PB[i] = (pairBnd[i] + unit * p0) / (pairCnt[i] + unit); }
    log(`fit: punctuation split probability ${pd.toFixed(3)} between equal characters, ${po.toFixed(3)} between different ones`);
  }

  // ---- Latin words: tokens(piece) = A.f + z(line) * B.f + diacritics + extra segments, alternating least squares
  const zByClass = new Map();
  {
    const NL = lineW.length, NP = pTarget.length, NB = NSYM * NSYM, NT = 2 * NA + 4;
    const z = Float64Array.from(lineInitZ);
    const theta = new Float64Array(NT);
    const U = new Float64Array(NB);
    const pA = new Float64Array(NP), pB = new Float64Array(NP);
    const fitTheta = () => {
      const M = new Float64Array(NT * NT), v = new Float64Array(NT);
      const fi = [], fv = [];
      for (let l = 0; l < NL; l++) {
        const zl = z[l], w = lineW[l], lp = linePieces[l];
        for (let q = 0; q < lp.length; q += 2) {
          const id = lp[q], ww = w * lp[q + 1], fa = pFeatA[id], fb = pFeatB[id], y = pTarget[id];
          fi.length = 0; fv.length = 0;
          for (let i = 0; i < fa.length; i += 2) { fi.push(fa[i]); fv.push(fa[i + 1]); }
          if (zl !== 0) for (let i = 0; i < fb.length; i += 2) { fi.push(NA + fb[i]); fv.push(zl * fb[i + 1]); }
          for (let k = 0; k < 3; k++) if (pLx[id][k]) { fi.push(2 * NA + k); fv.push(pLx[id][k]); }
          if (pSegx[id]) { fi.push(2 * NA + 3); fv.push(pSegx[id]); }
          for (let a = 0; a < fi.length; a++) {
            v[fi[a]] += ww * fv[a] * y;
            const row = fi[a] * NT;
            for (let b = 0; b < fi.length; b++) M[row + fi[b]] += ww * fv[a] * fv[b];
          }
        }
      }
      theta.set(solveSPD(M, v, NT, RIDGE_T));
      // slopes of the linear tails must not be negative or absurd
      for (let g = 0; g < NSEG; g++) { theta[g * (LM + 1)] = clamp(theta[g * (LM + 1)], 0, 0.7); theta[NA + g * (LM + 1)] = clamp(theta[NA + g * (LM + 1)], 0, 0.7); }
      for (let id = 0; id < NP; id++) {
        const fa = pFeatA[id], fb = pFeatB[id];
        let a = theta[2 * NA] * pLx[id][0] + theta[2 * NA + 1] * pLx[id][1] + theta[2 * NA + 2] * pLx[id][2] + theta[2 * NA + 3] * pSegx[id], b = 0;
        for (let i = 0; i < fa.length; i += 2) a += theta[fa[i]] * fa[i + 1];
        for (let i = 0; i < fb.length; i += 2) b += theta[NA + fb[i]] * fb[i + 1];
        pA[id] = a; pB[id] = b;
      }
    };
    const lineAB = (l) => {
      const lp = linePieces[l];
      let a = 0, b = 0, y = 0;
      for (let q = 0; q < lp.length; q += 2) { a += pA[lp[q]] * lp[q + 1]; b += pB[lp[q]] * lp[q + 1]; y += pTarget[lp[q]] * lp[q + 1]; }
      return [a, b, y];
    };
    const fitU = () => {
      // line totals: minimise sum_l w_l / words_l * (y_l - a_l - b_l * sum_k n_lk U_k / (N_l + KAPPA))^2
      const M = new Float64Array(NB * NB), v = new Float64Array(NB);
      for (let l = 0; l < NL; l++) {
        const [a, b, y] = lineAB(l);
        if (Math.abs(b) < 1e-9) continue;
        const scale = b / (lineN[l] + KAPPA), resid = y - a, ww = lineW[l] / lineNW[l], lb = lineBig[l];
        for (let i = 0; i < lb.length; i += 2) {
          const fa = scale * lb[i + 1];
          v[lb[i]] += ww * fa * resid;
          const row = lb[i] * NB;
          for (let j = 0; j < lb.length; j += 2) M[row + lb[j]] += ww * fa * scale * lb[j + 1];
        }
      }
      U.set(solveSPD(M, v, NB, RIDGE_U));
      for (let l = 0; l < NL; l++) {
        const lb = lineBig[l];
        let s = 0;
        for (let i = 0; i < lb.length; i += 2) s += U[lb[i]] * lb[i + 1];
        z[l] = clamp(s / (lineN[l] + KAPPA), ZMIN, ZMAX);
      }
    };
    fitTheta(); // starting point: z = 1 on lines of non-English Latin-script samples, 0 elsewhere
    for (let it = 0; it < ITERS; it++) {
      fitU();
      fitTheta();
    }
    for (let g = 0; g < NSEG; g++) {
      const L = SEG_FIT_LEN[g];
      for (let i = 0; i <= LM; i++) {
        const j = Math.min(i, L);
        P.A[g][i] = i === 0 ? theta[g * (LM + 1)] : theta[g * (LM + 1) + j] + theta[g * (LM + 1)] * (i - j);
        P.B[g][i] = i === 0 ? theta[NA + g * (LM + 1)] : theta[NA + g * (LM + 1) + j] + theta[NA + g * (LM + 1)] * (i - j);
      }
    }
    P.U = Array.from(U);
    for (let k = 0; k < 3; k++) P.CH[LX1 + k] = clamp(theta[2 * NA + k], 0.05, 4);
    P.SEGX = clamp(theta[2 * NA + 3], 0, 1.5);
    for (let l = 0; l < NL; l++) { let e = zByClass.get(lineCls[l]); if (!e) zByClass.set(lineCls[l], (e = [0, 0])); e[0] += z[l] * lineNW[l]; e[1] += lineNW[l]; }
    log('fit: mean line profile z per class: ' + [...zByClass.entries()].filter(([, e]) => e[1] > 2000).sort().map(([k, e]) => `${k.replace('lang-', '')}=${(e[0] / e[1]).toFixed(2)}`).join(' '));
  }

  // ---- other scripts and symbols: ridge regression of run tokens on class counts and a run-start term
  {
    const n = N_CLASSES + GROUPS.length * 2;
    const M = new Float64Array(n * n), v = new Float64Array(n);
    const prior = new Float64Array(n);
    for (let c = 1; c < N_CLASSES; c++) prior[c] = c > N_GENERIC ? (V.oneToken[CYR_FIRST + c - 1 - N_GENERIC] ? 0.5 : 1.5) : classPrior(c);
    let sw = 0;
    for (const [w] of otherRows) sw += w;
    const norm = otherRows.length / sw;
    for (const [w0, f, t] of otherRows) {
      const w = w0 * norm;
      let base = 0;
      for (let i = 0; i < f.length; i += 2) base += prior[f[i]] * f[i + 1];
      const y = t - base;
      for (let i = 0; i < f.length; i += 2) { v[f[i]] += w * f[i + 1] * y; for (let j = 0; j < f.length; j += 2) M[f[i] * n + f[j]] += w * f[i + 1] * f[j + 1]; }
    }
    const x = solveSPD(M, v, n, RIDGE_O);
    for (let c = 1; c < N_CLASSES; c++) if (groupOfClass(c) !== G.latin || c > N_GENERIC) P.CH[c] = clamp(prior[c] + x[c], 0.05, 4);
    for (let g = 0; g < GROUPS.length; g++) { P.RUN[g][0] = clamp(x[N_CLASSES + g * 2], -0.6, 1.5); P.RUN[g][1] = clamp(x[N_CLASSES + g * 2 + 1], -0.6, 1.5); }
  }
  return P;
}

// ============================================================================================================
// 6. Constants block of estimate.ts
// ============================================================================================================
/** Sorted integers -> "gap" / "gap.extra" tokens in base 36 (decoded by decodeRuns in estimate.ts). */
function encodeRuns(values) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    const len = j - i + 1;
    out.push((values[i] - cursor).toString(36) + (len > 1 ? '.' + (len - 1).toString(36) : ''));
    cursor = values[i] + len;
    i = j + 1;
  }
  return out.join(' ');
}

/**
 * Rounds the fitted parameters the way estimate.ts stores them.
 * Returns { Q, source }: Q is the rounded parameter set (what the shipped estimator computes with),
 * source is the TypeScript text that goes between the <fitted-constants> markers.
 */
function emitConstants(P, V) {
  const r3 = (x) => +x.toFixed(3);
  const Q = JSON.parse(JSON.stringify(P));
  Q.A = P.A.map((row) => row.map(r3));
  Q.B = P.B.map((row) => row.map(r3));
  Q.CH = P.CH.map(r3);
  Q.RUN = P.RUN.map((row) => row.map(r3));
  Q.D = P.D.map((row) => row.map((x, i) => (i === 0 ? 0 : r3(x))));
  Q.DS = r3(P.DS);
  Q.SEGX = r3(P.SEGX);
  // letter-pair weights: two base-36 digits each; a handful of pairs that almost never occur get extreme
  // weights and are clipped
  const uMin = Math.max(-HYPER.U_CLIP, Math.min(...P.U)), uMax = Math.min(HYPER.U_CLIP, Math.max(...P.U));
  const U_MIN = +uMin.toFixed(4);
  const U_STEP = +((uMax - U_MIN) / 1295).toFixed(6);
  let uStr = '';
  Q.U = P.U.map((v) => {
    const q = Math.max(0, Math.min(1295, Math.round((v - U_MIN) / U_STEP)));
    uStr += q.toString(36).padStart(2, '0');
    return U_MIN + q * U_STEP;
  });
  // punctuation split probabilities: one base-36 digit each
  let pStr = '';
  Q.PB = P.PB.map((p) => {
    const q = Math.max(0, Math.min(35, Math.round(p * 35)));
    pStr += q.toString(36);
    return q / 35;
  });
  const one = [];
  for (let c = 0x80; c < 0x10000; c++) if (V.oneToken[c] && !(c >= 0xff01 && c <= 0xff5e)) one.push(c);
  const pre = [];
  for (let b = 0; b < 1024; b++) if (V.prefix2[b]) pre.push(b);

  const wrap = (s, width) => {
    const parts = [];
    for (let i = 0; i < s.length; i += width) parts.push(s.slice(i, i + width));
    return parts;
  };
  const wrapWords = (s, width = 100) => {
    const parts = [];
    let cur = '';
    for (const w of s.split(' ')) {
      if (cur.length + w.length + 1 > width) { parts.push(cur + ' '); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    parts.push(cur);
    return parts;
  };
  const strLit = (parts) => parts.map((p) => `  '${p}'`).join(' +\n');
  const row = (a) => '[' + a.map((x) => String(x)).join(', ') + ']';
  let out = '';
  out += `// <fitted-constants> generated by \`node scripts/calibrate-tokens.mjs --fit\`; do not edit by hand.\n`;
  out += `/** Letters in the per-line profile: z = sum(U[pair]) / (pairs + KAPPA), clamped to [Z_MIN, Z_MAX]. */\n`;
  out += `const KAPPA = ${P.KAPPA};\nconst Z_MIN = ${P.ZMIN};\nconst Z_MAX = ${P.ZMAX};\n`;
  out += `/**\n * Latin word segments: tokens = A[shape][length] + z * B[shape][length]; index 0 is the slope per extra letter\n * beyond ${LM} letters. Shapes: ${SEG_NAMES.join(', ')}\n * (_sp = after a space, _dg = directly after a digit, in_ = later camelCase hump of the same word).\n */\n`;
  out += `const SEG_A: number[][] = [\n${Q.A.map((r, i) => `  ${row(r)}, // ${SEG_NAMES[i]}`).join('\n')}\n];\n`;
  out += `const SEG_B: number[][] = [\n${Q.B.map((r, i) => `  ${row(r)}, // ${SEG_NAMES[i]}`).join('\n')}\n];\n`;
  out += `/** Extra cost of every segment of one letter run beyond the third (random strings such as base64). */\nconst SEG_EXTRA = ${Q.SEGX};\n`;
  out += `/** Digit runs of 1..${DLEN} digits: [not after a space, after a space]; DIGIT_SLOPE per digit beyond ${DLEN}. */\n`;
  out += `const DIGITS: number[][] = [${row(Q.D[0])}, ${row(Q.D[1])}];\nconst DIGIT_SLOPE = ${Q.DS};\n`;
  out += `/**\n * Cost per non-ASCII character class. Classes 1..${N_GENERIC}: script group x tokens the character needs on its\n * own (1, 2, 3), groups in the order ${GROUPS.join(', ')};\n * classes ${N_GENERIC + 1}..${N_CLASSES - 1}: the Cyrillic letters U+0430..U+045F (upper case folded).\n */\n`;
  const chRows = [];
  for (let i = 0; i < Q.CH.length; i += 12) chRows.push('  ' + Q.CH.slice(i, i + 12).join(', ') + ',');
  out += `const CLASS_COST: number[] = [\n${chRows.join('\n')}\n];\n`;
  out += `/** Added once at the start of a run of non-ASCII characters, per group of its first character: [no space before, after a space]. */\n`;
  out += `const RUN_START: number[][] = [${Q.RUN.map(row).join(', ')}];\n`;
  out += `/** Letter-pair weights of the line profile, 28 x 28 (a-z, letter with diacritic, word boundary), two base-36 digits each. */\n`;
  out += `const PAIR_MIN = ${U_MIN};\nconst PAIR_STEP = ${U_STEP};\nconst PAIR_WEIGHTS =\n${strLit(wrap(uStr, 100))};\n`;
  out += `/**\n * Probability (in 35ths, one base-36 digit) that the tokenizer splits between two adjacent ASCII punctuation\n * characters, 33 x 33 in ASCII order (! " # ... ~, then "control character").\n */\n`;
  out += `const PUNCT_SPLIT =\n${strLit(wrap(pStr, 99))};\n`;
  out += `/**\n * Vocabulary facts (not fitted): BMP characters that are a single token after NFKC, and 64-code-point blocks\n * whose 2-byte UTF-8 prefix is a token (their characters need 2 tokens instead of 3). Run-length coded:\n * "gap" or "gap.extra" in base 36.\n */\n`;
  out += `const ONE_TOKEN_CHARS =\n${strLit(wrapWords(encodeRuns(one)))};\n`;
  out += `const TWO_TOKEN_BLOCKS =\n${strLit(wrapWords(encodeRuns(pre)))};\n`;
  out += `// </fitted-constants>\n`;
  return { Q, source: out };
}

// ============================================================================================================
// 7. Report
// ============================================================================================================
/** Loads the shipped estimator: compiled in memory with esbuild, or by Node's own type stripping. */
async function loadEstimator() {
  try {
    const esbuild = require('esbuild');
    const js = esbuild.transformSync(readFileSync(ESTIMATE_TS, 'utf8'), { loader: 'ts', format: 'esm' }).code;
    return await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    return await import(pathToFileURL(ESTIMATE_TS).href);
  }
}

/** Even blocks of six lines are used for fitting, odd blocks are held out. */
function splitFixture(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const parts = [[], []];
  for (let i = 0; i < lines.length; i++) parts[Math.floor(i / 6) % 2].push(lines[i]);
  return parts.map((p) => (p.length ? p.join('\n') + '\n' : ''));
}

const CLASS_ORDER = ['en-prose', 'en-chat', 'markdown', 'code', 'code-minified', 'json', 'tables', 'logs', 'urls-hex-base64', 'numbers', 'emoji'];
const LANGUAGE_GROUPS = {
  'languages: Latin script (es fr de pt it)': ['lang-es', 'lang-fr', 'lang-de', 'lang-pt', 'lang-it'],
  'languages: Cyrillic (ru uk)': ['lang-ru', 'lang-uk'],
  'languages: Greek, Arabic, Hebrew': ['lang-el', 'lang-ar', 'lang-he'],
  'languages: Indic and Thai (hi bn th)': ['lang-hi', 'lang-bn', 'lang-th'],
  'languages: CJK (zh ja ko)': ['lang-zh', 'lang-ja', 'lang-ko'],
};
const classRank = (c) => (CLASS_ORDER.includes(c) ? String(CLASS_ORDER.indexOf(c)).padStart(2, '0') : 'zz' + c);
const pct = (est, actual) => (actual ? ((100 * (est - actual)) / actual).toFixed(2) + '%' : '');

/** Prints one table: class, samples, chars, actual tokens, estimated, error %, chars/token. */
function printTable(title, samples, { groups = false } = {}) {
  if (samples.length === 0) return;
  const by = new Map();
  const add = (key, s) => {
    let e = by.get(key);
    if (!e) by.set(key, (e = { n: 0, chars: 0, actual: 0, est: 0 }));
    e.n++; e.chars += s.text.length; e.actual += s.actual; e.est += s.est;
  };
  for (const s of samples) add(s.cls, s);
  const rows = [...by.entries()].sort((a, b) => (classRank(a[0]) < classRank(b[0]) ? -1 : 1));
  if (groups) {
    for (const [name, members] of Object.entries(LANGUAGE_GROUPS)) {
      const g = { n: 0, chars: 0, actual: 0, est: 0 };
      for (const m of members) { const e = by.get(m); if (e) { g.n += e.n; g.chars += e.chars; g.actual += e.actual; g.est += e.est; } }
      if (g.n) rows.push([name, g]);
    }
  }
  const all = { n: 0, chars: 0, actual: 0, est: 0 };
  for (const s of samples) { all.n++; all.chars += s.text.length; all.actual += s.actual; all.est += s.est; }
  rows.push(['ALL (pooled, weighted by tokens)', all]);
  const w = Math.max(...rows.map((r) => r[0].length), 5);
  console.log(`\n${title}`);
  console.log(`${'class'.padEnd(w)}  samples     chars    actual  estimate    error  chars/token`);
  for (const [name, e] of rows) console.log(`${name.padEnd(w)}  ${String(e.n).padStart(7)} ${String(e.chars).padStart(9)} ${String(e.actual).padStart(9)} ${String(e.est).padStart(9)} ${pct(e.est, e.actual).padStart(8)}  ${(e.chars / e.actual).toFixed(2).padStart(11)}`);
}

async function main() {
  if (flag('--help') || flag('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 12).join('\n'));
    return;
  }
  const all = flag('--all') || flag('--fit');
  const log = (msg) => console.error(msg);
  const t0 = Date.now();
  let samples = loadCorpora({ appRoot: APP, extDir: option('--ext'), fixturesOnly: !all, log: () => {} });
  for (const s of [...samples]) {
    if (s.split !== 'fixture') continue;
    const [a, b] = splitFixture(s.text);
    if (a) samples.push({ cls: s.cls, source: 'fixture', name: s.name + ' (even blocks)', text: a, split: 'fx-train' });
    if (b) samples.push({ cls: s.cls, source: 'fixture', name: s.name + ' (odd blocks)', text: b, split: 'fx-hold' });
  }
  for (const s of samples) s.actual = count(s.text);
  {
    // the shared tokenizer instance must agree with the published countTokens()
    const probe = samples.filter((s) => s.split === 'fixture').slice(0, 3);
    for (const s of probe) if (countTokens(s.text) !== s.actual) throw new Error('count() disagrees with countTokens() on ' + s.name);
  }
  log(`${samples.length} samples, ${samples.reduce((a, s) => a + s.text.length, 0)} characters, counted in ${Date.now() - t0} ms`);

  let estimator = await loadEstimator();
  if (flag('--fit')) {
    const V = vocabTables();
    const T = buildTables(V.oneToken, V.prefix2);
    const P = fitModel(samples, T, V, log);
    const { Q, source } = emitConstants(P, V);
    const current = readFileSync(ESTIMATE_TS, 'utf8');
    const begin = current.indexOf('// <fitted-constants>'), end = current.indexOf('// </fitted-constants>\n');
    if (begin < 0 || end < 0) throw new Error('constants markers not found in ' + ESTIMATE_TS);
    const upToDate = current.slice(begin, end + '// </fitted-constants>\n'.length) === source;
    if (flag('--write') && !upToDate) {
      writeFileSync(ESTIMATE_TS, current.slice(0, begin) + source + current.slice(end + '// </fitted-constants>\n'.length));
      log(`wrote the new constants to ${ESTIMATE_TS}`);
      estimator = await loadEstimator();
    } else if (!flag('--write')) {
      console.log(source);
    }
    log(upToDate ? 'estimate.ts already contains exactly these constants' : flag('--write') ? 'estimate.ts updated' : 'estimate.ts contains DIFFERENT constants (run with --write to replace them)');
    // the reference implementation with the rounded constants must equal estimate.ts on every sample
    const reference = makeEstimator(Q, T);
    let different = 0;
    for (const s of samples) if (reference(s.text) !== estimator.estimateBaseTokens(s.text)) different++;
    log(`parity of the reference model with estimate.ts: ${different} of ${samples.length} samples differ${different && !upToDate && !flag('--write') ? ' (expected: the constants differ)' : ''}`);
  }

  const { estimateBaseTokens, ESTIMATE_MODEL_VERSION } = estimator;
  for (const s of samples) s.est = estimateBaseTokens(s.text);
  console.log(`estimateBaseTokens (${ESTIMATE_MODEL_VERSION}) against countTokens of @anthropic-ai/tokenizer; error = estimate / actual - 1`);

  const of = (split) => samples.filter((s) => s.split === split);
  console.log('\nfixtures, file by file');
  for (const s of of('fixture')) console.log(`  ${s.name.padEnd(28)} ${String(s.text.length).padStart(5)} chars  actual ${String(s.actual).padStart(5)}  estimate ${String(s.est).padStart(5)}  ${pct(s.est, s.actual).padStart(7)}`);
  printTable('fixtures, whole files (tests/fixtures/tokens; half of every file was used for fitting)', of('fixture'), { groups: true });
  printTable('fixtures, held-out half (odd six-line blocks, never used for fitting)', of('fx-hold'), { groups: true });
  if (all) {
    printTable('machine corpora, held-out documents', of('hold'), { groups: true });
    printTable('machine corpora, training documents', of('train'));
    printTable('external directory (validation only)', of('ext'));
    const big = samples.filter((s) => s.text.length >= 2000 && s.split !== 'fx-train' && s.split !== 'fx-hold');
    const err = (s) => s.est / s.actual - 1;
    const within = big.filter((s) => Math.abs(err(s)) <= 0.12).length;
    console.log(`\nsamples of at least 2000 characters: ${big.length}; within +-12%: ${within} (${((100 * within) / big.length).toFixed(2)}%); within +-6%: ${big.filter((s) => Math.abs(err(s)) <= 0.06).length}`);
    console.log('worst samples of at least 2000 characters:');
    for (const s of [...big].sort((a, b) => Math.abs(err(b)) - Math.abs(err(a))).slice(0, 15)) console.log(`  ${pct(s.est, s.actual).padStart(8)}  ${s.cls}/${s.source}/${s.split}  ${s.name.slice(-64)}  (actual ${s.actual})`);
  }

  // throughput on about 20 MB of UTF-16 text made of all fixtures
  {
    let mixed = of('fixture').map((s) => s.text).join('\n');
    while (mixed.length < 10e6) mixed += mixed;
    mixed = (' ' + mixed.slice(0, 10e6)).slice(1);
    let best = Infinity;
    for (let k = 0; k < 5; k++) { const a = performance.now(); estimateBaseTokens(mixed); best = Math.min(best, performance.now() - a); }
    console.log(`\nthroughput: ${(mixed.length / 1e6).toFixed(0)} million characters of mixed text in ${best.toFixed(0)} ms = ${(mixed.length / 1e6 / (best / 1000)).toFixed(0)} million chars/s = ${((2 * mixed.length) / 1e6 / (best / 1000)).toFixed(0)} MB/s of UTF-16`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
