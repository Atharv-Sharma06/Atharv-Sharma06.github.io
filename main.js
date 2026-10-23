/* ─────────────────────────────────────────────────────────────
   Atharv Sharma — portfolio (8-bit edition)
   ───────────────────────────────────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const html = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EMAIL = 'atharv.eck@gmail.com';
const GH_USER = 'Atharv-Sharma06';

// Tells the CSS fallbacks that JS is alive and in control of reveals.
html.classList.add('js-ok');

function seeded(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  });
  [].concat(children).forEach(c => node.append(c));
  return node;
}

function setInert(selectors, on) {
  selectors.forEach(sel => { const n = $(sel); if (n) n.inert = on; });
}

$$('.js-year').forEach(n => { n.textContent = new Date().getFullYear(); });

/* ── Mobile menu ──────────────────────────────────────────── */
const menuBtn = $('#menu-btn');
const nav = $('#nav');
function setMenu(open) {
  nav.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.textContent = open ? 'Close' : 'Menu';
}
menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
$$('a', nav).forEach(a => a.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && nav.classList.contains('open')) { setMenu(false); menuBtn.focus(); }
});
const wideMQ = matchMedia('(min-width: 721px)');
const onWide = e => { if (e.matches) setMenu(false); };
if (wideMQ.addEventListener) wideMQ.addEventListener('change', onWide); else wideMQ.addListener(onWide);

/* ── Intro: type the name, fill the loading bar ───────────── */
const hero = $('#hero');
const heroName = $('#hero-name');
const typeEl = $('.type', heroName);
const loadLabel = $('#load-label');
const segbar = $('#segbar');
const SEGMENTS = 20;
for (let i = 0; i < SEGMENTS; i++) segbar.append(el('i'));
const segs = $$('i', segbar);
const introSteps = $$('.intro-step', hero);
let introRaf = 0;

function endIntro() {
  cancelAnimationFrame(introRaf);
  typeEl.textContent = typeEl.dataset.text;
  heroName.classList.remove('typing');
  heroName.removeAttribute('aria-label');
  hero.classList.remove('intro', 'loading');
  introSteps.forEach(s => s.classList.add('shown'));
  segs.forEach(s => s.classList.remove('on'));
}

function playIntro() {
  cancelAnimationFrame(introRaf);
  if (reduceMotion) { endIntro(); return; }
  const full = typeEl.dataset.text;
  const TYPE_MS = 75;
  const DURATION = 2300;
  heroName.setAttribute('aria-label', full);
  heroName.classList.add('typing');
  hero.classList.add('intro', 'loading');
  introSteps.forEach(s => s.classList.remove('shown'));
  const t0 = performance.now();
  const tick = now => {
    const t = now - t0;
    const n = Math.min(full.length, Math.floor(t / TYPE_MS));
    typeEl.replaceChildren(full.slice(0, n), el('span', { class: 'caret', 'aria-hidden': 'true' }), el('span', { class: 'ghost', 'aria-hidden': 'true', text: full.slice(n) }));
    // Progress arrives in uneven chunks, like a real loader.
    const x = clamp(t / DURATION, 0, 1);
    const pct = Math.min(100, Math.floor((1 - Math.pow(1 - x, 2.4)) * 100 + Math.sin(x * 9) * 2));
    loadLabel.textContent = `Loading ${clamp(pct, 0, 100)}%`;
    segs.forEach((s, i) => s.classList.toggle('on', ((i + 1) / SEGMENTS) * 100 <= pct));
    introSteps.forEach((s, i) => { if (t > 1050 + i * 240) s.classList.add('shown'); });
    if (t < DURATION + 300) introRaf = requestAnimationFrame(tick);
    else endIntro();
  };
  introRaf = requestAnimationFrame(tick);
}
playIntro();

$('#replay').addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  heroName.setAttribute('tabindex', '-1');
  heroName.focus({ preventScroll: true });
  playIntro();
});

/* ── Reveals + heading scramble ───────────────────────────── */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=?';
function scramble(node) {
  if (reduceMotion) return;
  const final = node.textContent;
  node.setAttribute('aria-label', final);
  const DURATION = 650;
  const t0 = performance.now();
  const tick = now => {
    const p = clamp((now - t0) / DURATION, 0, 1);
    const fixed = Math.floor(p * final.length);
    let out = final.slice(0, fixed);
    for (let i = fixed; i < final.length; i++) {
      out += final[i] === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    }
    node.textContent = out;
    if (p < 1) requestAnimationFrame(tick);
    else node.textContent = final;
  };
  requestAnimationFrame(tick);
}

const io = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const t = entry.target;
    if (t.hasAttribute('data-scramble')) scramble(t);
    else t.classList.add('in');
    io.unobserve(t);
  });
}, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
$$('.rv, [data-scramble]').forEach(n => io.observe(n));

/* ── Pixel avatar ─────────────────────────────────────────── */
// Palette lives here so the character is easy to re-skin.
const SPRITE_PALETTE = {
  H: '#20241f', h: '#30362f', S: '#b97a52', s: '#94603f', E: '#e9e7df', P: '#0a0c0a',
  M: '#e9e7df', G: '#3f8a4a', g: '#2f6b37', w: '#e9e7df', L: '#8ff09a', D: '#1a1d1a',
};
const SPRITE_ROWS = [
  '......HHHHHH......',
  '....HHHHHHHHHH....',
  '...HHHHHHHHHHHH...',
  '..HHHhHHHHHHhHHH..',
  '..HHHHHHHHHHHHHH..',
  '..HHHSSSHHSSSHHH..',
  '..HHSSSSSSSSSSHH..',
  '..HSSSSSSSSSSSSH..',
  '.sSSSEESSSSEESSSs.',
  '.sSSSPESSSSPESSSs.',
  '..SSSSSSSSSSSSSS..',
  '..SSSSSSSssSSSSS..',
  '..SSSSSSSSSSSSSS..',
  '..sSSSSMMMMSSSSs..',
  '...sSSSSSSSSSSs...',
  '.....ssSSSSss.....',
  '...GGGGGggGGGGG...',
  '..GGGGGGGGGGGGGG..',
  '.GGGwGGGGGGGGwGGG.',
  '.GGGwGGGGGGGLwGGG.',
  '.GGGGGGGGGLLGGGGG.',
  '.SSGGGGGGLGGGGGSS.',
  '.SSGGGGGGGGGGGGSS.',
  '...DDDDD..DDDDD...',
];

(function drawSprite() {
  const svg = $('#sprite');
  if (!svg) return;
  const NS = 'http://www.w3.org/2000/svg';
  const base = document.createElementNS(NS, 'g');
  const eyes = document.createElementNS(NS, 'g');
  eyes.setAttribute('class', 'eyes');
  SPRITE_ROWS.forEach((row, y) => {
    // Merge horizontal runs of one colour into a single rect.
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let w = 1;
      while (row[x + w] === ch) w++;
      if (ch !== '.') {
        const isEye = ch === 'E' || ch === 'P';
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y);
        r.setAttribute('width', w); r.setAttribute('height', 1);
        r.setAttribute('fill', SPRITE_PALETTE[isEye ? 'S' : ch]);
        base.append(r);
        if (isEye) {
          const e = r.cloneNode();
          e.setAttribute('fill', SPRITE_PALETTE[ch]);
          eyes.append(e);
        }
      }
      x += w;
    }
  });
  svg.append(base, eyes);
})();

/* ── Project previews (generated, illustrative) ───────────── */
const VW = 320, VH = 180;
const pts = arr => arr.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
function windowFrame(bg, bar, title, body) {
  return `<svg viewBox="0 0 ${VW} ${VH}" shape-rendering="crispEdges" role="img" aria-label="Illustrative preview of ${title}">
    <rect width="${VW}" height="${VH}" fill="${bg}"/>
    <rect width="${VW}" height="14" fill="${bar}"/>
    <rect x="6" y="5" width="4" height="4" fill="#e8673f"/><rect x="13" y="5" width="4" height="4" fill="#ffffff" opacity=".25"/><rect x="20" y="5" width="4" height="4" fill="#ffffff" opacity=".25"/>
    <text x="${VW / 2}" y="10" fill="#ffffff" opacity=".55" font-family="Silkscreen, monospace" font-size="6" text-anchor="middle">${title}</text>
    ${body}
  </svg>`;
}
const txt = (x, y, s, fill = '#ffffff', size = 6, op = 0.6, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${fill}" opacity="${op}" font-family="Silkscreen, monospace" font-size="${size}" text-anchor="${anchor}">${s}</text>`;

const SHOTS = {
  macro() {
    const rand = seeded(7);
    let b = `<rect x="0" y="14" width="66" height="166" fill="#132748"/>${txt(8, 28, 'FILTERS')}`;
    ['US', 'UK', 'EU', 'JP'].forEach((c, i) => {
      b += `<rect x="8" y="${36 + i * 14}" width="50" height="9" fill="${i === 0 ? '#7cc4ff' : '#1d3866'}"/>${txt(12, 43 + i * 14, c, i === 0 ? '#0f1d36' : '#ffffff', 6, 0.8)}`;
    });
    ['CPI', 'UNRATE', 'GDP'].forEach((k, i) => {
      const x = 76 + i * 80;
      b += `<rect x="${x}" y="22" width="72" height="34" fill="#16294a"/>${txt(x + 6, 32, k)}`;
      const sp = Array.from({ length: 12 }, (_, j) => [x + 6 + j * 5.4, 48 - rand() * 10 - (k === 'CPI' ? j * 0.5 : 0)]);
      b += `<polyline points="${pts(sp)}" fill="none" stroke="${i === 1 ? '#ffd166' : '#7cc4ff'}" stroke-width="1.5"/>`;
    });
    b += `<rect x="76" y="64" width="232" height="106" fill="#16294a"/>`;
    for (let g = 0; g < 4; g++) b += `<rect x="84" y="${78 + g * 22}" width="216" height="1" fill="#ffffff" opacity=".08"/>`;
    const n = 40, a = [], u = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      a.push([84 + t * 216, 150 - (16 + 60 * Math.exp(-Math.pow((t - 0.75) / 0.1, 2)) + t * 14 + rand() * 4)]);
      u.push([84 + t * 216, 150 - (52 - t * 20 + 70 * Math.exp(-Math.pow((t - 0.58) / 0.035, 2)) + rand() * 3)]);
    }
    b += `<polyline points="${pts(u)}" fill="none" stroke="#ffd166" stroke-width="1.5" opacity=".8"/><polyline points="${pts(a)}" fill="none" stroke="#7cc4ff" stroke-width="2"/>`;
    return windowFrame('#0f1d36', '#0a1528', 'economic_dashboard', b);
  },

  candles() {
    const rand = seeded(11);
    let b = `${txt(10, 28, 'TICKER · 1D')}`;
    ['1M', '6M', '1Y'].forEach((l, i) => { b += `<rect x="${236 + i * 26}" y="20" width="22" height="10" fill="${i === 2 ? '#5fd068' : '#1c2328'}"/>${txt(247 + i * 26, 28, l, i === 2 ? '#0f1417' : '#ffffff', 6, 0.8, 'middle')}`; });
    const n = 30; let c = 100; const data = [];
    for (let i = 0; i < n; i++) { const o = c; c = o + (rand() - 0.42) * 6; data.push({ o, c, h: Math.max(o, c) + rand() * 3, l: Math.min(o, c) - rand() * 3 }); }
    const lo = Math.min(...data.map(d => d.l)), hi = Math.max(...data.map(d => d.h));
    const Y = v => 118 - (v - lo) / (hi - lo) * 80;
    data.forEach((d, i) => {
      const x = 14 + i * 9.8, col = d.c >= d.o ? '#5fd068' : '#e8673f';
      b += `<rect x="${x + 2.5}" y="${Y(d.h)}" width="1" height="${Y(d.l) - Y(d.h)}" fill="${col}"/><rect x="${x}" y="${Y(Math.max(d.o, d.c))}" width="6" height="${Math.max(2, Y(Math.min(d.o, d.c)) - Y(Math.max(d.o, d.c)))}" fill="${col}"/>`;
    });
    const sma = data.map((_, i) => { const s = data.slice(Math.max(0, i - 6), i + 1); return [17 + i * 9.8, Y(s.reduce((a, d) => a + d.c, 0) / s.length)]; });
    b += `<polyline points="${pts(sma)}" fill="none" stroke="#ffffff" stroke-width="1" stroke-dasharray="3 2" opacity=".7"/>`;
    b += `<rect x="10" y="128" width="300" height="44" fill="#151b1f"/>${txt(16, 138, 'RSI')}<rect x="16" y="146" width="288" height="1" fill="#e8673f" opacity=".4"/><rect x="16" y="162" width="288" height="1" fill="#5fd068" opacity=".4"/>`;
    const rsi = Array.from({ length: 48 }, (_, i) => [16 + i * 6.1, 154 + Math.sin(i / 3) * 9 + (rand() - 0.5) * 6]);
    b += `<polyline points="${pts(rsi)}" fill="none" stroke="#c9a6ff" stroke-width="1.2"/>`;
    return windowFrame('#0f1417', '#0a0e10', 'stock_analysis', b);
  },

  forecast() {
    const rand = seeded(23);
    const hist = 28, fut = 14;
    let v = 100; const ys = [];
    for (let i = 0; i < hist; i++) { v += (rand() - 0.45) * 5; ys.push(v); }
    const fc = [ys[hist - 1]];
    for (let i = 1; i < fut; i++) fc.push(fc[i - 1] + 0.6 + (rand() - 0.5));
    const all = ys.concat(fc), lo = Math.min(...all) - 14, hi = Math.max(...all) + 14;
    const X = i => 14 + i * (292 / (hist + fut - 1)), Y = y => 128 - (y - lo) / (hi - lo) * 98;
    const up = fc.map((y, i) => [X(hist - 1 + i), Y(y + Math.sqrt(i) * 3.4)]);
    const dn = fc.map((y, i) => [X(hist - 1 + i), Y(y - Math.sqrt(i) * 3.4)]).reverse();
    let b = `${txt(10, 28, 'LSTM · FORECAST')}${txt(310, 28, 'CI BAND', '#c9a6ff', 6, 0.8, 'end')}`;
    b += `<polygon points="${pts(up.concat(dn))}" fill="#c9a6ff" opacity=".2"/>`;
    b += `<rect x="${X(hist - 1)}" y="30" width="1" height="100" fill="#ffffff" opacity=".25"/>`;
    b += `<polyline points="${pts(ys.map((y, i) => [X(i), Y(y)]))}" fill="none" stroke="#ffffff" stroke-width="1.6"/>`;
    b += `<polyline points="${pts(fc.map((y, i) => [X(hist - 1 + i), Y(y)]))}" fill="none" stroke="#c9a6ff" stroke-width="2" stroke-dasharray="4 3"/>`;
    b += `<rect x="10" y="142" width="300" height="30" fill="#211740"/>${txt(16, 154, 'TRAINING')}`;
    for (let i = 0; i < 20; i++) b += `<rect x="${16 + i * 14.4}" y="160" width="11" height="5" fill="${i < 13 ? '#c9a6ff' : '#3a2d61'}"/>`;
    return windowFrame('#170f2b', '#100a1f', 'market_predictor', b);
  },

  sentiment() {
    const rand = seeded(31);
    let b = `${txt(10, 28, 'HEADLINES')}`;
    for (let i = 0; i < 6; i++) {
      const y = 36 + i * 22, s = Math.sin(i * 1.7) * 0.7 + (rand() - 0.5) * 0.5;
      b += `<rect x="10" y="${y}" width="186" height="16" fill="#26170f"/>`;
      b += `<rect x="16" y="${y + 4}" width="${60 + rand() * 70}" height="3" fill="#ffffff" opacity=".35"/><rect x="16" y="${y + 9}" width="${40 + rand() * 50}" height="3" fill="#ffffff" opacity=".18"/>`;
      b += `<rect x="${s > 0 ? 164 : 164 - Math.abs(s) * 24}" y="${y + 5}" width="${Math.abs(s) * 24}" height="6" fill="${s > 0 ? '#5fd068' : '#e8673f'}"/>`;
    }
    b += `<rect x="206" y="22" width="104" height="150" fill="#26170f"/>${txt(258, 36, 'MOOD', '#ffffff', 6, 0.6, 'middle')}`;
    const cols = ['#e8673f', '#e8673f', '#f08a4b', '#f0a84b', '#e8c547', '#c9d44f', '#9bd45a', '#5fd068', '#5fd068'];
    cols.forEach((c, i) => {
      const a = Math.PI * (1 - i / (cols.length - 1));
      b += `<rect x="${258 + Math.cos(a) * 36 - 4}" y="${96 - Math.sin(a) * 36 - 4}" width="8" height="8" fill="${c}"/>`;
    });
    b += `<line x1="258" y1="96" x2="${258 + Math.cos(0.7) * 26}" y2="${96 - Math.sin(0.7) * 26}" stroke="#ffffff" stroke-width="2" shape-rendering="auto"/><rect x="255" y="93" width="6" height="6" fill="#ffffff"/>`;
    b += `${txt(222, 116, 'FEAR', '#e8673f', 6, 0.9)}${txt(296, 116, 'GREED', '#5fd068', 6, 0.9, 'end')}`;
    const price = Array.from({ length: 16 }, (_, i) => [214 + i * 5.8, 156 - Math.sin(i / 3) * 8 - i * 0.6]);
    b += `<polyline points="${pts(price)}" fill="none" stroke="#ffffff" stroke-width="1.2" opacity=".7"/>`;
    return windowFrame('#1d120c', '#140c07', 'sentiment_analyzer', b);
  },

  frontier() {
    const rand = seeded(5);
    const X = x => 20 + (x - 0.08) / 0.26 * 280, Y = y => 128 - (y - 0.02) / 0.24 * 100;
    const front = x => 0.03 + 0.42 * Math.sqrt(Math.max(x - 0.09, 0)) - 0.15 * (x - 0.09);
    let b = `${txt(10, 28, 'EFFICIENT FRONTIER')}${txt(310, 28, 'MONTE CARLO', '#5bffc8', 6, 0.8, 'end')}`;
    for (let i = 0; i < 220; i++) {
      const x = 0.1 + rand() * 0.23, y = front(x) - Math.pow(rand(), 0.6) * 0.12;
      b += `<rect x="${X(x).toFixed(0)}" y="${Y(y).toFixed(0)}" width="2" height="2" fill="#5bffc8" opacity="${clamp((y - 0.02) / x / 1.4, 0.15, 0.95).toFixed(2)}"/>`;
    }
    const curve = [];
    for (let x = 0.095; x <= 0.33; x += 0.006) curve.push([X(x), Y(front(x))]);
    b += `<polyline points="${pts(curve)}" fill="none" stroke="#ffffff" stroke-width="1.6"/>`;
    let best = { s: 0, x: 0 };
    for (let x = 0.1; x <= 0.33; x += 0.002) { const s = (front(x) - 0.02) / x; if (s > best.s) best = { s, x }; }
    b += `<rect x="${X(best.x) - 4}" y="${Y(front(best.x)) - 4}" width="8" height="8" fill="#e8c547"/>`;
    b += `<rect x="10" y="142" width="300" height="30" fill="#0f2e2b"/>${txt(16, 154, 'ALLOCATION')}`;
    const w = [0.3, 0.22, 0.18, 0.17, 0.13], cs = ['#5bffc8', '#7cc4ff', '#c9a6ff', '#e8c547', '#e8673f'];
    let x0 = 16;
    w.forEach((f, i) => { b += `<rect x="${x0}" y="160" width="${f * 288 - 2}" height="6" fill="${cs[i]}"/>`; x0 += f * 288; });
    return windowFrame('#0b211f', '#071715', 'portfolio_optimizer', b);
  },
};

function renderShot(container, type) {
  if (!SHOTS[type]) return;
  const tag = $('.shot-tag', container);
  container.innerHTML = SHOTS[type]();
  if (tag) container.append(tag);
}
$$('.shot[data-shot]').forEach(s => renderShot(s, s.dataset.shot));

/* ── Project window ───────────────────────────────────────── */
const modal = $('#modal');
let modalReturn = null;
const cards = $$('.card');

function openProject(card) {
  const link = $('.card-link', card).href;
  const slug = link.split('/').filter(Boolean).pop();
  $('#modal-file').textContent = `${slug}.py`;
  $('#modal-title').textContent = $('.card-title', card).textContent;
  $('#modal-tag').textContent = $('.card-tag', card).textContent;
  $('#modal-desc').textContent = $('.card-desc', card).textContent;
  $('#modal-stack').textContent = $('.more-stack', card).textContent;
  const list = $('#modal-features');
  list.replaceChildren(...$$('.card-more li', card).map(li => el('li', { text: li.textContent })));
  $('#modal-link').href = link;
  const shot = $('#modal-shot');
  renderShot(shot, card.dataset.project);
  shot.append(el('span', { class: 'shot-tag', text: 'Preview · illustrative' }));
  modalReturn = document.activeElement;
  modal.hidden = false;
  html.classList.add('modal-open');
  setInert(['.header', 'main', '.footer'], true);
  $('.term-x', modal).focus();
}
function closeProject() {
  if (modal.hidden) return;
  modal.hidden = true;
  html.classList.remove('modal-open');
  setInert(['.header', 'main', '.footer'], false);
  if (modalReturn) modalReturn.focus();
}
cards.forEach(card => $('.explore', card).addEventListener('click', () => openProject(card)));
$$('[data-close]', modal).forEach(n => n.addEventListener('click', closeProject));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProject(); });

/* ── Quest log tabs ───────────────────────────────────────── */
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => { t.classList.toggle('active', t === tab); t.setAttribute('aria-pressed', String(t === tab)); });
    $$('.log-list').forEach(l => { l.hidden = l.dataset.panel !== tab.dataset.tab; });
  });
});

/* ── GitHub activity ──────────────────────────────────────── */
function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

function describeEvent(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'PushEvent': {
      const commit = p.commits?.slice(-1)[0];
      if (commit) return commit.message.split('\n')[0];
      return `pushed to ${(p.ref || '').replace('refs/heads/', '') || 'main'}`;
    }
    // Branch/tag creation is noise in a feed; only new repositories are worth showing.
    case 'CreateEvent': return p.ref_type === 'repository' ? 'created repository' : null;
    // The public events API no longer always includes titles, so fall back to the number.
    case 'PullRequestEvent': {
      const pr = p.pull_request || {};
      const action = p.action === 'closed' && pr.merged ? 'merged' : p.action;
      return pr.title ? `${action} PR: ${pr.title}` : `${action} PR #${p.number ?? pr.number ?? ''}`.trim();
    }
    case 'IssuesEvent': {
      const issue = p.issue || {};
      return issue.title ? `${p.action} issue: ${issue.title}` : `${p.action} issue #${issue.number ?? ''}`.trim();
    }
    case 'ReleaseEvent': return `released ${p.release?.tag_name || ''}`;
    case 'PublicEvent': return 'made repository public';
    default: return null;
  }
}

// Shown immediately, and kept if the GitHub API is rate-limited or unreachable (snapshot of 2026-06-09).
let commits = [
  { repo: 'Atharv-Sharma06.github.io', msg: 'Add DAR Youth Leadership Award to Achievements', date: '2026-06-09' },
  { repo: 'Atharv-Sharma06.github.io', msg: 'Fix GitHub activity: correct username & null commits', date: '2026-06-09' },
  { repo: 'ai-investment-assistant', msg: 'Add portfolio analysis features', date: '2026-05-24' },
  { repo: 'investment-research-assist', msg: 'Initial commit', date: '2026-05-23' },
  { repo: 'stock-analyser', msg: 'Update stock analysis logic', date: '2026-05-16' },
  { repo: 'ECONOMIC-data-reader', msg: 'Add macroeconomic data reader', date: '2026-04-15' },
].map(c => ({ ...c, ago: timeAgo(new Date(`${c.date}T12:00:00`)) }));

function renderCommits() {
  $('#commit-list').replaceChildren(...commits.slice(0, 7).map(c => el('li', {}, [
    el('span', { class: 'c-time', text: c.ago }),
    el('span', { class: 'c-repo', text: c.repo }),
    el('span', { class: 'c-msg', text: c.msg.slice(0, 80) }),
  ])));
}
renderCommits();

(async function loadGitHubActivity() {
  try {
    const [eventsRes, userRes] = await Promise.all([
      fetch(`https://api.github.com/users/${GH_USER}/events/public?per_page=40`),
      fetch(`https://api.github.com/users/${GH_USER}`),
    ]);
    const user = userRes.ok ? await userRes.json() : {};
    if (Number.isFinite(user.public_repos)) $('#gh-repos').textContent = user.public_repos;
    if (!eventsRes.ok) return;
    const events = await eventsRes.json();
    const rows = (Array.isArray(events) ? events : [])
      .map(e => ({ e, msg: describeEvent(e) }))
      .filter(r => r.msg)
      .slice(0, 9)
      .map(({ e, msg }) => ({
        repo: e.repo.name.startsWith(`${GH_USER}/`) ? e.repo.name.split('/')[1] : e.repo.name,
        msg,
        ago: timeAgo(new Date(e.created_at)),
      }));
    if (rows.length) { commits = rows; renderCommits(); }
  } catch (_) { /* static data already shown */ }
})();

/* ── Terminal ─────────────────────────────────────────────── */
(function terminal() {
  const out = $('#term-out');
  const form = $('#term-form');
  const input = $('#term-input');
  const prompt = $('#term-prompt');
  const PROMPT_HTML = prompt.innerHTML;
  const history = [];
  let hIndex = 0;
  let note = null;     // active "write a note" flow, or null
  let sending = false;

  function print(parts, cls = '') {
    const p = el('p', { class: cls });
    [].concat(parts).forEach(part => {
      if (typeof part === 'string') p.append(part);
      else if (part.href) p.append(el('a', { href: part.href, ...(part.ext ? { target: '_blank', rel: 'noopener' } : {}) }, [part.text]));
      else if (part.cls) p.append(el('span', { class: part.cls, text: part.text }));
    });
    out.append(p);
    out.scrollTop = out.scrollHeight;
    return p;
  }
  const echo = cmd => print(`${note ? 'note' : 'guest~'} $ ${cmd}`, 't-cmd');

  const PROJECTS = cards.map(c => ({ card: c, name: $('.card-title', c).textContent, link: $('.card-link', c).href }));

  const COMMANDS = {
    help: { desc: 'list commands', run() {
      Object.entries(COMMANDS).filter(([, c]) => c.desc).forEach(([k, c]) => print(`${k.padEnd(9, ' ')} --> ${c.desc}`));
      print('tip: tab completes, up/down browses history.', 't-dim');
    } },
    about: { desc: 'a little about me', run() {
      print('Atharv Sharma. Quant developer. Fort Mill, SC.');
      print('I build Python tools that turn market data into decisions — backtests, optimizers, forecasts. Open to internships & research.');
    } },
    hello: { desc: 'say hello', run() {
      print('Hey, player 2. Welcome to my corner of the internet. Try "projects", or "note" to send me a message.');
    } },
    projects: { desc: 'see what i have built', run() {
      PROJECTS.forEach((p, i) => print([`${i + 1}. ${p.name}  `, { href: p.link, text: 'code', ext: true }]));
      print('type "open 1" (or any number) to explore one.', 't-dim');
    } },
    open: { run(arg) {
      const p = PROJECTS[parseInt(arg, 10) - 1];
      if (!p) { print('usage: open <1-' + PROJECTS.length + '>', 't-err'); return; }
      print(`opening ${p.name}…`, 't-ok');
      openProject(p.card);
    } },
    skills: { desc: 'my skill tree', run() {
      print('technical: python, pandas, numpy, sql, scikit-learn, tensorflow, streamlit, plotly, javascript, git');
      print('quant: backtesting, portfolio theory, monte carlo, volatility, sharpe ratio, options basics, fred api, yfinance');
    } },
    awards: { desc: 'achievements unlocked', run() {
      $$('.log-list[data-panel="achievements"] b').forEach(b => print(`★ ${b.textContent}`));
    } },
    log: { desc: 'recent github activity', run() {
      commits.slice(0, 6).forEach(c => print([{ cls: 't-dim', text: `${c.ago.padEnd(8, ' ')} ` }, { cls: 't-ok', text: c.repo }, ` ${c.msg}`]));
    } },
    note: { desc: 'write me a note', run() { startNote(); } },
    copy: { desc: 'copy my email', async run() {
      try { await navigator.clipboard.writeText(EMAIL); print(`copied ${EMAIL} to your clipboard.`, 't-ok'); }
      catch (_) { print(['clipboard blocked — here it is: ', { href: `mailto:${EMAIL}`, text: EMAIL }]); }
    } },
    follow: { desc: 'find me elsewhere', run() {
      print(['github   ', { href: `https://github.com/${GH_USER}`, text: `github.com/${GH_USER}`, ext: true }]);
      print(['email    ', { href: `mailto:${EMAIL}`, text: EMAIL }]);
      print(['resume   ', { href: 'resume.pdf', text: 'resume.pdf', ext: true }]);
    } },
    resume: { desc: 'open my resume', run() {
      print(['opening ', { href: 'resume.pdf', text: 'resume.pdf', ext: true }, '…'], 't-ok');
      window.open('resume.pdf', '_blank', 'noopener');
    } },
    clear: { desc: 'a fresh terminal', run() { out.replaceChildren(); } },
    replay: { desc: 'play the intro again', run() { $('#replay').click(); } },
    whoami: { run() { print('guest. (recruiters, you are very welcome — try "note".)'); } },
    date: { run() { print(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }) + ' ET'); } },
    sudo: { run(arg) {
      if (/hire/i.test(arg)) { print('access granted. opening a note…', 't-ok'); startNote('Internship / hiring'); }
      else print('permission denied. nice try though.', 't-err');
    } },
    exit: { run() { print('there is no escape. (kidding — just scroll up.)'); } },
  };
  const ALIASES = { hi: 'hello', ls: 'projects', email: 'note', contact: 'note', github: 'follow', socials: 'follow', cv: 'resume', cls: 'clear', achievements: 'awards', activity: 'log', 'git': 'log' };

  function run(raw) {
    const line = raw.trim();
    if (!line) return;
    if (note) { noteAnswer(line); return; }
    echo(line);
    history.push(line); hIndex = history.length;
    const [word, ...rest] = line.split(/\s+/);
    const key = ALIASES[word.toLowerCase()] || word.toLowerCase();
    const cmd = COMMANDS[key];
    if (cmd) cmd.run(rest.join(' '));
    else print(`command not found: ${word}. type "help".`, 't-err');
  }

  /* write-a-note flow */
  const TOPICS = ['Internship', 'Research role', 'Project collaboration', 'Just saying hi'];
  const NOTE_STEPS = [
    { key: 'name', q: "what's your name?", ph: 'your name', check: v => v.length >= 2 || 'i need at least a first name.' },
    { key: 'email', q: 'where can i reach you?', ph: 'you@company.com', type: 'email', check: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "that email doesn't look right." },
    { key: 'topic', q: `what's this about? ${TOPICS.map((t, i) => `${i + 1} ${t.toLowerCase()}`).join(' · ')}`, ph: 'pick a number or type your own', map: v => TOPICS[parseInt(v, 10) - 1] || v },
    { key: 'message', q: 'your message — a sentence or two is perfect:', ph: 'type your message', check: v => v.length >= 10 || 'a little more detail helps me reply properly.' },
    { key: 'confirm', q: 'send it? (y/n)', ph: 'y or n' },
  ];

  function setPrompt(label) {
    if (label) prompt.replaceChildren(el('span', { class: 'green', text: label }));
    else prompt.innerHTML = PROMPT_HTML;
  }
  function askNote() {
    const step = NOTE_STEPS[note.i];
    print(step.q, 't-ok');
    setPrompt(`note ${note.i + 1}/${NOTE_STEPS.length} >`);
    input.placeholder = step.ph;
    input.type = step.type || 'text';
    input.focus({ preventScroll: true });
  }
  function startNote(topic) {
    note = { i: 0, data: {} };
    if (topic) note.preset = topic;
    print('writing a note. type "cancel" any time to stop.', 't-dim');
    askNote();
  }
  function endNote() {
    note = null;
    setPrompt();
    input.placeholder = 'Type a command';
    input.type = 'text';
  }
  function noteAnswer(v) {
    print(`note $ ${v}`, 't-cmd');
    if (/^cancel$/i.test(v)) { print('note cancelled.', 't-dim'); endNote(); return; }
    const step = NOTE_STEPS[note.i];
    if (step.key === 'confirm') {
      if (/^y(es)?$/i.test(v)) { sendNote(); return; }
      if (/^n(o)?$/i.test(v)) { print('not sent. type "note" to start over.', 't-dim'); endNote(); return; }
      print('type y or n.', 't-err'); return;
    }
    const ok = step.check ? step.check(v) : true;
    if (ok !== true) { print(ok, 't-err'); return; }
    note.data[step.key] = step.map ? step.map(v) : v;
    note.i++;
    if (note.i === 2 && note.preset) { note.data.topic = note.preset; note.i++; }
    if (NOTE_STEPS[note.i].key === 'confirm') {
      const d = note.data;
      print(`to: ${EMAIL}`, 't-dim');
      print(`from: ${d.name} <${d.email}>`, 't-dim');
      print(`re: ${d.topic}`, 't-dim');
      print(`"${d.message}"`, 't-dim');
    }
    askNote();
  }

  async function sendNote() {
    if (sending) return;
    sending = true;
    const d = note.data;
    print('sending…', 't-dim');
    const body = new URLSearchParams({ 'form-name': 'contact', ...d }).toString();
    let delivered = false;
    try {
      // Works when the site is served by Netlify (the hidden form registers the fields).
      const res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      delivered = res.ok;
    } catch (_) { delivered = false; }
    if (delivered) {
      print(`sent. thanks ${d.name.split(' ')[0]} — i'll reply to ${d.email} soon.`, 't-ok');
    } else {
      // Static hosting (GitHub Pages): hand off to the visitor's mail app, pre-filled.
      const mailto = `mailto:${EMAIL}?subject=${encodeURIComponent(`[Portfolio] ${d.topic} — ${d.name}`)}&body=${encodeURIComponent(`${d.message}\n\n— ${d.name} (${d.email})`)}`;
      print('opening your mail app with everything filled in — just hit send.', 't-ok');
      print(['nothing opened? ', { href: mailto, text: 'click here' }, ` or write to ${EMAIL}.`]);
      window.location.href = mailto;
    }
    sending = false;
    endNote();
  }

  /* input handling */
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (sending) return;
    const v = input.value;
    input.value = '';
    run(v);
  });

  input.addEventListener('keydown', e => {
    if (note) return;
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault(); hIndex = Math.max(0, hIndex - 1); input.value = history[hIndex];
    } else if (e.key === 'ArrowDown' && history.length) {
      e.preventDefault(); hIndex = Math.min(history.length, hIndex + 1); input.value = history[hIndex] || '';
    } else if (e.key === 'Tab' && input.value.trim()) {
      const pre = input.value.trim().toLowerCase();
      const names = Object.keys(COMMANDS).filter(k => k.startsWith(pre));
      if (names.length === 1) { e.preventDefault(); input.value = names[0] + ' '; }
      else if (names.length > 1) { e.preventDefault(); print(names.join('   '), 't-dim'); }
    }
  });

  $$('[data-cmd]').forEach(b => b.addEventListener('click', () => {
    if (note && b.dataset.cmd !== 'note') endNote();
    if (b.dataset.cmd === 'note' && note) { input.focus({ preventScroll: true }); return; }
    run(b.dataset.cmd);
    input.focus({ preventScroll: true });
  }));
  $('#term-clear').addEventListener('click', () => { out.replaceChildren(); input.focus({ preventScroll: true }); });
  out.addEventListener('click', e => { if (!e.target.closest('a') && !window.getSelection().toString()) input.focus({ preventScroll: true }); });

  // boot screen
  print('guest~ $ about', 't-cmd'); COMMANDS.about.run();
  print('guest~ $ hello', 't-cmd'); COMMANDS.hello.run();
})();
