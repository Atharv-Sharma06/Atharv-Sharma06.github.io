/* ─────────────────────────────────────────────────────────────
   Atharv Sharma — portfolio interactions
   ───────────────────────────────────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const html = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer  = matchMedia('(hover: hover) and (pointer: fine)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp  = (a, b, t) => a + (b - a) * t;

function seeded(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── Year + Eastern-time clock ────────────────────────────── */
$$('.js-year').forEach(el => { el.textContent = new Date().getFullYear(); });

const clockFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
function tickClock() {
  const t = clockFmt.format(new Date());
  const c = $('#clock');
  if (c) c.textContent = t;
  $$('.js-clock').forEach(el => { el.textContent = t; });
}
tickClock();
setInterval(tickClock, 15000);

/* ── Smooth scroll (Lenis, if it loaded) ──────────────────── */
let lenis = null;
function initLenis() {
  if (reduceMotion || !window.Lenis) return;
  lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true });
  (function raf(t) { lenis.raf(t); requestAnimationFrame(raf); })(performance.now());
}
initLenis();

function scrollToTarget(target) {
  const offset = target.id === 'top' ? 0 : -20;
  if (lenis) lenis.scrollTo(target, { offset, duration: 1.4 });
  else target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}

$$('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href');
    const target = id === '#' ? null : $(id);
    if (!target) return;
    e.preventDefault();
    closeMenu();
    scrollToTarget(target);
  });
});
$('#to-top')?.addEventListener('click', () => scrollToTarget($('#top')));

/* ── Split text helpers ───────────────────────────────────── */
// Wraps every word in `el` while keeping inline elements like <em> intact.
function splitWords(el, makeWord) {
  const nodes = [...el.childNodes];
  el.textContent = '';
  let i = 0;
  nodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent.split(/(\s+)/).forEach(tok => {
        if (!tok) return;
        if (/^\s+$/.test(tok)) { el.appendChild(document.createTextNode(' ')); return; }
        el.appendChild(makeWord(document.createTextNode(tok), i++));
      });
    } else {
      el.appendChild(makeWord(node, i++));
    }
  });
  return i;
}

$$('.split').forEach(el => {
  el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
  splitWords(el, (node, i) => {
    const w = document.createElement('span');
    w.className = 'w';
    w.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('span');
    inner.style.setProperty('--i', i);
    inner.appendChild(node);
    w.appendChild(inner);
    return w;
  });
});

const scrubEls = $$('[data-scrub]').map(el => {
  const words = [];
  splitWords(el, node => {
    const s = document.createElement('span');
    s.className = 'sw';
    s.appendChild(node);
    words.push(s);
    return s;
  });
  return { el, words };
});

/* ── Reveal on scroll ─────────────────────────────────────── */
const io = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in');
    io.unobserve(entry.target);
  });
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

function observeReveals() {
  $$('.reveal-up, .split, .contact-h').forEach(el => {
    if (!el.closest('.hero')) io.observe(el);
  });
}

/* ── Count-up stats ───────────────────────────────────────── */
function countUp(el, to) {
  const suffix = el.dataset.suffix || '';
  if (reduceMotion) { el.textContent = to.toLocaleString() + suffix; return; }
  const dur = 1600;
  const start = performance.now();
  (function step(now) {
    const p = clamp((now - start) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = Math.round(to * eased).toLocaleString() + suffix;
    if (p < 1) requestAnimationFrame(step);
  })(start);
}

const statIO = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    el.dataset.seen = '1';
    const to = parseInt(el.dataset.count, 10);
    if (to > 0) countUp(el, to);
    statIO.unobserve(el);
  });
}, { threshold: 0.6 });
$$('[data-count]').forEach(el => statIO.observe(el));

/* ── Hero chart line ──────────────────────────────────────── */
const heroPath = $('#hero-path');
const heroArea = $('#hero-area');
const heroDot  = $('#hero-dot');

function buildHeroLine() {
  if (!heroPath) return;
  const rand = seeded(42);
  const W = 1400, H = 400, N = 70;
  const pts = [];
  let y = 330;
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * W;
    y += (rand() - 0.62) * 34;
    y = clamp(y, 30, 370);
    pts.push([x, y]);
  }
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  heroPath.setAttribute('d', d);
  heroArea.setAttribute('d', `${d} L${W},${H} L0,${H} Z`);
  heroPath.setAttribute('pathLength', '1');
  heroPath.style.strokeDasharray = '1';
  heroPath.style.strokeDashoffset = '1';
  heroArea.style.opacity = '0';
  heroDot.style.left = (pts[N][0] / W * 100) + '%';
  heroDot.style.top = (pts[N][1] / H * 100) + '%';
}

function drawHeroLine() {
  if (!heroPath) return;
  const dur = reduceMotion ? 0 : 2600;
  heroPath.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(.7,0,.2,1)`;
  heroArea.style.transition = `opacity 1200ms ease ${dur * 0.6}ms`;
  requestAnimationFrame(() => {
    heroPath.style.strokeDashoffset = '0';
    heroArea.style.opacity = '1';
  });
  setTimeout(() => heroDot.classList.add('on'), dur);
}
buildHeroLine();

/* ── Preloader ────────────────────────────────────────────── */
function runLoader() {
  const loader = $('#loader');
  const num = $('#loader-num');
  const bar = $('#loader-bar');
  let seen = false;
  try { seen = sessionStorage.getItem('as-loaded') === '1'; sessionStorage.setItem('as-loaded', '1'); } catch (_) {}
  const dur = reduceMotion ? 0 : (seen ? 700 : 1900);
  if (lenis) lenis.stop();

  const finish = () => {
    loader.classList.add('done');
    html.classList.remove('is-loading');
    setTimeout(() => {
      html.classList.add('is-ready');
      drawHeroLine();
      observeReveals();
      if (lenis) lenis.start();
    }, reduceMotion ? 0 : 350);
    setTimeout(() => loader.remove(), 1400);
  };

  if (!dur) { finish(); return; }
  const start = performance.now();
  (function step(now) {
    const p = clamp((now - start) / dur, 0, 1);
    // Stepped easing makes the counter feel like data arriving in chunks.
    const eased = p < 1 ? Math.floor((1 - Math.pow(1 - p, 3)) * 100 / 3) * 3 : 100;
    num.textContent = Math.min(eased, 100);
    bar.style.width = eased + '%';
    if (p < 1) requestAnimationFrame(step);
    else setTimeout(finish, 180);
  })(start);
}
window.addEventListener('DOMContentLoaded', runLoader);

/* ── Header: hide on scroll down, show on up ──────────────── */
const header = $('#header');
let lastY = 0;
let scrollVel = 0;

function onScroll() {
  const y = window.scrollY;
  const dy = y - lastY;
  scrollVel = dy;
  if (!html.classList.contains('menu-open')) {
    header.classList.toggle('hide', dy > 0 && y > 200);
  }
  lastY = y;
  updateScrub();
  heroParallax(y);
}
window.addEventListener('scroll', onScroll, { passive: true });

function updateScrub() {
  const vh = window.innerHeight;
  scrubEls.forEach(({ el, words }) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) return;
    const p = clamp((vh * 0.85 - r.top) / (r.height + vh * 0.3), 0, 1);
    const lit = Math.round(p * words.length);
    words.forEach((w, i) => w.classList.toggle('lit', i < lit));
  });
}

const heroTitle = $('.hero-title');
const heroLine  = $('.hero-line-wrap');
function heroParallax(y) {
  if (reduceMotion || y > window.innerHeight * 1.2) return;
  if (heroTitle) heroTitle.style.transform = `translate3d(0, ${y * 0.18}px, 0)`;
  if (heroLine) heroLine.style.transform = `translate3d(0, ${y * 0.32}px, 0)`;
}

/* ── Mobile menu ──────────────────────────────────────────── */
const menuBtn = $('#menu-btn');
const menu = $('#menu');
function closeMenu() {
  html.classList.remove('menu-open');
  menuBtn?.setAttribute('aria-expanded', 'false');
  menu?.setAttribute('aria-hidden', 'true');
  if (lenis && !$('#resume-modal:not([hidden])')) lenis.start();
}
menuBtn?.addEventListener('click', () => {
  const open = !html.classList.contains('menu-open');
  if (!open) { closeMenu(); return; }
  html.classList.add('menu-open');
  header.classList.remove('hide');
  menuBtn.setAttribute('aria-expanded', 'true');
  menu.setAttribute('aria-hidden', 'false');
  if (lenis) lenis.stop();
});

/* ── Marquee (speeds up / reverses with scroll) ───────────── */
(function marquee() {
  const track = $('#marquee-track');
  if (!track) return;
  track.innerHTML += track.innerHTML;
  if (reduceMotion) return;
  let x = 0;
  let dir = -1;
  let last = performance.now();
  (function loop(now) {
    const dt = Math.min(now - last, 50);
    last = now;
    if (scrollVel > 1) dir = -1;
    else if (scrollVel < -1) dir = 1;
    const boost = clamp(Math.abs(scrollVel) * 0.4, 0, 12);
    scrollVel *= 0.9;
    x += dir * (0.05 * dt + boost);
    const half = track.scrollWidth / 2;
    if (x <= -half) x += half;
    if (x > 0) x -= half;
    track.style.transform = `translate3d(${x}px,0,0)`;
    requestAnimationFrame(loop);
  })(last);
})();

/* ── Cursor + magnetic elements ───────────────────────────── */
const cursor = $('#cursor');
const cursorLabel = $('#cursor-label');
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };

if (finePointer && !reduceMotion) {
  const pos = { x: mouse.x, y: mouse.y };
  document.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    cursor.classList.add('on');
  });
  document.addEventListener('mouseleave', () => cursor.classList.remove('on'));
  (function loop() {
    pos.x = lerp(pos.x, mouse.x, 0.22);
    pos.y = lerp(pos.y, mouse.y, 0.22);
    cursor.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    requestAnimationFrame(loop);
  })();

  document.addEventListener('mouseover', e => {
    const row = e.target.closest('.proj-row');
    const interactive = e.target.closest('a, button, input, textarea, .chip');
    cursor.classList.toggle('label', !!row);
    cursor.classList.toggle('hover', !row && !!interactive);
    if (row) cursorLabel.textContent = row.parentElement.classList.contains('open') ? 'Close' : 'Open';
  });

  $$('[data-magnetic]').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      el.style.transform = `translate(${dx * 0.25}px, ${dy * 0.35}px)`;
    });
    el.addEventListener('mouseleave', () => {
      el.style.transition = 'transform .6s cubic-bezier(.16,1,.3,1)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 600);
    });
  });
}

/* ── Project visuals (generated SVG charts) ───────────────── */
const VW = 400, VH = 250, PAD = { l: 22, r: 22, t: 44, b: 26 };
const sx = (i, n) => PAD.l + (i / (n - 1)) * (VW - PAD.l - PAD.r);
const sy = (v, min, max) => PAD.t + (1 - (v - min) / (max - min)) * (VH - PAD.t - PAD.b);
const toPath = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');

function frame(title, value, hue, body) {
  let grid = '';
  for (let i = 0; i < 5; i++) {
    const y = PAD.t + i * (VH - PAD.t - PAD.b) / 4;
    grid += `<line x1="${PAD.l}" x2="${VW - PAD.r}" y1="${y}" y2="${y}" stroke="rgba(236,232,225,.07)" />`;
  }
  return `<svg class="viz" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${title} chart">
    <rect width="${VW}" height="${VH}" fill="#121214" />
    <rect width="${VW}" height="${VH}" fill="${hue}" opacity=".035" />
    ${grid}
    <text x="${PAD.l}" y="26" class="viz-t">${title}</text>
    <text x="${VW - PAD.r}" y="26" class="viz-v" fill="${hue}" text-anchor="end">${value}</text>
    ${body}
  </svg>`;
}

const VIZ = {
  macro(hue) {
    const rand = seeded(7);
    const n = 44;
    const cpi = [], un = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      cpi.push(1.6 + 6.6 * Math.exp(-Math.pow((t - 0.75) / 0.1, 2)) + t * 1.6 + (rand() - 0.5) * 0.5);
      un.push(6.2 - t * 2.4 + 9 * Math.exp(-Math.pow((t - 0.58) / 0.035, 2)) + (rand() - 0.5) * 0.3);
    }
    const a = toPath(cpi.map((v, i) => [sx(i, n), sy(v, 0, 15)]));
    const b = toPath(un.map((v, i) => [sx(i, n), sy(v, 0, 15)]));
    return frame('CPI YoY vs UNRATE · 2014–24', '9.1% peak', hue, `
      <path d="${b}" fill="none" stroke="#ece8e1" stroke-opacity=".45" stroke-width="1.5" pathLength="1" class="draw" />
      <path d="${a}" fill="none" stroke="${hue}" stroke-width="2" pathLength="1" class="draw" />
      <g class="viz-legend"><circle cx="${PAD.l + 4}" cy="${VH - 10}" r="3" fill="${hue}" /><text x="${PAD.l + 12}" y="${VH - 7}">CPI</text>
      <circle cx="${PAD.l + 48}" cy="${VH - 10}" r="3" fill="#ece8e1" opacity=".5" /><text x="${PAD.l + 56}" y="${VH - 7}">Unemployment</text></g>`);
  },

  candles(hue) {
    const rand = seeded(11);
    const n = 34;
    let c = 100;
    const data = [];
    for (let i = 0; i < n; i++) {
      const o = c;
      c = o + (rand() - 0.42) * 6;
      data.push({ o, c, h: Math.max(o, c) + rand() * 3, l: Math.min(o, c) - rand() * 3 });
    }
    const min = Math.min(...data.map(d => d.l)) - 2;
    const max = Math.max(...data.map(d => d.h)) + 2;
    const w = (VW - PAD.l - PAD.r) / n * 0.56;
    let body = '';
    data.forEach((d, i) => {
      const x = sx(i, n);
      const col = d.c >= d.o ? hue : '#ff6b5b';
      const y1 = sy(Math.max(d.o, d.c), min, max);
      const y2 = sy(Math.min(d.o, d.c), min, max);
      body += `<g class="pop" style="--i:${i}"><line x1="${x}" x2="${x}" y1="${sy(d.h, min, max)}" y2="${sy(d.l, min, max)}" stroke="${col}" stroke-width="1" />
        <rect x="${x - w / 2}" y="${y1}" width="${w}" height="${Math.max(y2 - y1, 1)}" fill="${col}" rx="1" /></g>`;
    });
    const sma = data.map((_, i) => {
      const s = data.slice(Math.max(0, i - 6), i + 1);
      return [sx(i, n), sy(s.reduce((a, d) => a + d.c, 0) / s.length, min, max)];
    });
    const chg = ((data[n - 1].c / data[0].o - 1) * 100).toFixed(1);
    return frame('NVDA · 1D · SMA(7)', `${chg > 0 ? '+' : ''}${chg}%`, hue, `${body}
      <path d="${toPath(sma)}" fill="none" stroke="#ece8e1" stroke-width="1.4" stroke-dasharray="3 3" opacity=".7" />`);
  },

  forecast(hue) {
    const rand = seeded(23);
    const hist = 30, fut = 14, n = hist + fut;
    const ys = [];
    let v = 50;
    for (let i = 0; i < hist; i++) { v += (rand() - 0.45) * 4; ys.push(v); }
    const fc = [ys[hist - 1]];
    for (let i = 1; i < fut; i++) fc.push(fc[i - 1] + 0.55 + (rand() - 0.5) * 0.8);
    const all = ys.concat(fc);
    const min = Math.min(...all) - 14, max = Math.max(...all) + 14;
    const H = toPath(ys.map((y, i) => [sx(i, n), sy(y, min, max)]));
    const F = toPath(fc.map((y, i) => [sx(hist - 1 + i, n), sy(y, min, max)]));
    const up = fc.map((y, i) => [sx(hist - 1 + i, n), sy(y + Math.sqrt(i) * 3.2, min, max)]);
    const lo = fc.map((y, i) => [sx(hist - 1 + i, n), sy(y - Math.sqrt(i) * 3.2, min, max)]).reverse();
    const xT = sx(hist - 1, n);
    return frame('LSTM forecast · 95% CI', '↑ 0.62 conf.', hue, `
      <path d="${toPath(up.concat(lo))}Z" fill="${hue}" opacity=".16" class="fade" />
      <line x1="${xT}" x2="${xT}" y1="${PAD.t - 6}" y2="${VH - PAD.b}" stroke="#ece8e1" stroke-opacity=".25" stroke-dasharray="2 4" />
      <text x="${xT + 6}" y="${PAD.t + 4}" class="viz-t">today</text>
      <path d="${H}" fill="none" stroke="#ece8e1" stroke-width="1.6" pathLength="1" class="draw" />
      <path d="${F}" fill="none" stroke="${hue}" stroke-width="2" stroke-dasharray="4 4" class="fade" />`);
  },

  sentiment(hue) {
    const rand = seeded(31);
    const n = 28;
    const mid = PAD.t + (VH - PAD.t - PAD.b) / 2;
    const bw = (VW - PAD.l - PAD.r) / n * 0.62;
    let body = `<line x1="${PAD.l}" x2="${VW - PAD.r}" y1="${mid}" y2="${mid}" stroke="#ece8e1" stroke-opacity=".2" />`;
    const price = [];
    let p = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.sin(i / 4) * 0.55 + (rand() - 0.5) * 0.9;
      const h = Math.abs(s) * 70;
      const x = sx(i, n);
      body += `<rect class="pop" style="--i:${i}" x="${x - bw / 2}" y="${s > 0 ? mid - h : mid}" width="${bw}" height="${h}" rx="1.5" fill="${s > 0 ? hue : '#ff6b5b'}" opacity=".85" />`;
      p += s * 0.8 + 0.15;
      price.push([x, p]);
    }
    const pm = Math.min(...price.map(q => q[1])) - 1, px = Math.max(...price.map(q => q[1])) + 1;
    body += `<path d="${toPath(price.map(q => [q[0], sy(q[1], pm, px)]))}" fill="none" stroke="#ece8e1" stroke-width="1.6" pathLength="1" class="draw" />`;
    return frame('VADER compound vs price', 'Greed · 64', hue, body);
  },

  frontier(hue) {
    const rand = seeded(5);
    const xMin = 0.08, xMax = 0.34, yMin = 0.02, yMax = 0.26;
    const X = x => PAD.l + (x - xMin) / (xMax - xMin) * (VW - PAD.l - PAD.r);
    const Y = y => sy(y, yMin, yMax);
    const front = x => 0.03 + 0.42 * Math.sqrt(Math.max(x - 0.09, 0)) - 0.15 * (x - 0.09);
    let dots = '';
    for (let i = 0; i < 240; i++) {
      const x = 0.1 + rand() * 0.23;
      const y = front(x) - Math.pow(rand(), 0.6) * 0.12;
      const sharpe = (y - 0.02) / x;
      dots += `<circle class="pop" style="--i:${i % 40}" cx="${X(x).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="1.8" fill="${hue}" opacity="${clamp(sharpe / 1.4, 0.12, 0.9).toFixed(2)}" />`;
    }
    const curve = [];
    for (let x = 0.095; x <= 0.33; x += 0.005) curve.push([X(x), Y(front(x))]);
    // Max-Sharpe tangency point (rf = 2%)
    let best = { s: 0, x: 0, y: 0 };
    for (let x = 0.1; x <= 0.33; x += 0.002) { const s = (front(x) - 0.02) / x; if (s > best.s) best = { s, x, y: front(x) }; }
    const cmlEnd = 0.33;
    return frame('Efficient frontier · 10k sims', `Sharpe ${best.s.toFixed(2)}`, hue, `${dots}
      <line x1="${X(xMin)}" y1="${Y(0.02 + best.s * xMin)}" x2="${X(cmlEnd)}" y2="${Y(0.02 + best.s * cmlEnd)}" stroke="#ece8e1" stroke-opacity=".35" stroke-dasharray="3 4" />
      <path d="${toPath(curve)}" fill="none" stroke="#ece8e1" stroke-width="1.8" pathLength="1" class="draw" />
      <g class="fade"><circle cx="${X(best.x)}" cy="${Y(best.y)}" r="9" fill="${hue}" opacity=".25" /><circle cx="${X(best.x)}" cy="${Y(best.y)}" r="4" fill="${hue}" /></g>`);
  },
};

function renderViz(container, type, hue) {
  if (VIZ[type]) container.innerHTML = VIZ[type](hue);
}

/* ── Work list: accordion, hover preview, filters ─────────── */
const projects = $$('.proj');
const workList = $('#work-list');

projects.forEach(p => {
  const row = $('.proj-row', p);
  const visual = $('.proj-visual', p);
  row.addEventListener('click', () => {
    const open = !p.classList.contains('open');
    projects.forEach(o => {
      if (o !== p && o.classList.contains('open')) {
        o.classList.remove('open');
        $('.proj-row', o).setAttribute('aria-expanded', 'false');
      }
    });
    p.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
    if (open) renderViz(visual, p.dataset.preview, p.dataset.hue);
    cursorLabel.textContent = open ? 'Close' : 'Open';
    preview.classList.toggle('on', !open && hovering === p);
    setTimeout(() => lenis?.resize(), 850);
  });
});

const preview = $('#preview');
const previewInner = $('#preview-inner');
let hovering = null;

if (finePointer && !reduceMotion) {
  const pp = { x: mouse.x, y: mouse.y, r: 0 };
  (function loop() {
    const nx = lerp(pp.x, mouse.x, 0.12);
    pp.r = lerp(pp.r, clamp((mouse.x - pp.x) * 0.06, -10, 10), 0.15);
    pp.x = nx;
    pp.y = lerp(pp.y, mouse.y, 0.12);
    preview.style.translate = `${pp.x}px ${pp.y}px`;
    preview.style.rotate = `${pp.r}deg`;
    requestAnimationFrame(loop);
  })();

  projects.forEach(p => {
    $('.proj-row', p).addEventListener('mouseenter', () => {
      hovering = p;
      p.classList.add('hovered');
      workList.classList.add('list-hovering');
      if (p.classList.contains('open')) { preview.classList.remove('on'); return; }
      renderViz(previewInner, p.dataset.preview, p.dataset.hue);
      preview.classList.add('on');
    });
    $('.proj-row', p).addEventListener('mouseleave', () => {
      hovering = null;
      p.classList.remove('hovered');
      workList.classList.remove('list-hovering');
      preview.classList.remove('on');
    });
  });
}

$$('.wf').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.wf').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', String(b === btn)); });
    const f = btn.dataset.f;
    projects.forEach((p, i) => {
      const show = f === 'all' || p.dataset.cat.split(' ').includes(f);
      p.classList.toggle('filtered-out', !show);
      if (show && !reduceMotion) {
        p.animate([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }],
          { duration: 700, delay: i * 50, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      }
    });
    setTimeout(() => lenis?.resize(), 100);
  });
});

/* ── Watchlist sparklines ─────────────────────────────────── */
$$('[data-spark]').forEach(svg => {
  const rand = seeded(+svg.dataset.spark * 97);
  let v = 12;
  const pts = [];
  for (let i = 0; i < 24; i++) { v = clamp(v + (rand() - 0.5) * 5, 2, 22); pts.push([i * (80 / 23), v]); }
  const up = pts[23][1] < pts[0][1];
  svg.innerHTML = `<path d="${toPath(pts)}" stroke="${up ? 'var(--accent)' : 'var(--red)'}" />`;
});

/* ── Record tabs ──────────────────────────────────────────── */
function indexRecords(list) { $$('li', list).forEach((li, i) => li.style.setProperty('--i', i)); }
$$('.rec-list').forEach(indexRecords);
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); });
    $$('.rec-list').forEach(l => l.classList.toggle('active', l.dataset.panel === tab.dataset.tab));
    setTimeout(() => lenis?.resize(), 50);
  });
});

/* ── Résumé modal ─────────────────────────────────────────── */
const modal = $('#resume-modal');
function openModal() {
  const frameEl = $('iframe', modal);
  if (!frameEl.src) frameEl.src = frameEl.dataset.src;
  modal.hidden = false;
  lenis?.stop();
  $('[data-close]:not(.modal-backdrop)', modal).focus();
}
function closeModal() {
  modal.hidden = true;
  lenis?.start();
  $('#resume-open').focus();
}
$('#resume-open')?.addEventListener('click', openModal);
$$('[data-close]', modal).forEach(el => el.addEventListener('click', closeModal));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) closeModal();
  if (html.classList.contains('menu-open')) closeMenu();
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
      const branch = (p.ref || '').replace('refs/heads/', '');
      return `pushed to ${branch || 'main'}`;
    }
    case 'CreateEvent': return p.ref_type === 'repository' ? 'created repository' : `created ${p.ref_type} ${p.ref || ''}`;
    case 'PullRequestEvent': return `${p.action} PR: ${p.pull_request?.title || ''}`;
    case 'IssuesEvent': return `${p.action} issue: ${p.issue?.title || ''}`;
    case 'ReleaseEvent': return `released ${p.release?.tag_name || ''}`;
    case 'ForkEvent': return 'forked repository';
    case 'WatchEvent': return 'starred repository';
    case 'PublicEvent': return 'made repository public';
    default: return null;
  }
}

(async function loadGitHubActivity() {
  const list = $('#commit-list');
  const reposEl = $('#gh-repos');
  try {
    const [eventsRes, userRes] = await Promise.all([
      fetch('https://api.github.com/users/Kingbob609420/events/public?per_page=40'),
      fetch('https://api.github.com/users/Kingbob609420'),
    ]);
    if (!eventsRes.ok) throw new Error('GitHub API ' + eventsRes.status);
    const events = await eventsRes.json();
    const user = userRes.ok ? await userRes.json() : {};

    if (reposEl && Number.isFinite(user.public_repos)) {
      reposEl.dataset.count = user.public_repos;
      if (reposEl.dataset.seen) countUp(reposEl, user.public_repos);
      else reposEl.textContent = '0';
    }

    const rows = (Array.isArray(events) ? events : [])
      .map(e => ({ e, msg: describeEvent(e) }))
      .filter(r => r.msg)
      .slice(0, 9);

    if (!rows.length) {
      list.innerHTML = '<li class="term-muted">No recent public activity — check back soon.</li>';
      return;
    }
    list.innerHTML = rows.map(({ e, msg }, i) => `<li style="--i:${i}">
        <span class="t-time">${timeAgo(new Date(e.created_at))}</span>
        <span class="t-repo">${escapeHTML(e.repo.name.split('/')[1])}</span>
        <span class="t-msg">${escapeHTML(msg.slice(0, 80))}</span>
      </li>`).join('');
  } catch (_) {
    list.innerHTML = '<li class="term-muted">Activity unavailable right now — <a href="https://github.com/Kingbob609420" target="_blank" rel="noopener">see GitHub ↗</a></li>';
  }
})();

/* ── Copy email ───────────────────────────────────────────── */
const EMAIL = 'atharv.eck@gmail.com';
const copyBtn = $('#copy-email');
copyBtn?.addEventListener('click', async () => {
  const hint = $('#copy-hint');
  try {
    await navigator.clipboard.writeText(EMAIL);
    copyBtn.classList.add('copied');
    hint.textContent = 'Copied to clipboard ✓';
  } catch (_) {
    window.location.href = `mailto:${EMAIL}`;
    return;
  }
  setTimeout(() => { copyBtn.classList.remove('copied'); hint.textContent = 'Click to copy'; }, 2200);
});

/* ── Conversational contact flow ──────────────────────────── */
(function contactFlow() {
  const form = $('#flow');
  if (!form) return;
  const steps = $$('.step', form);
  const total = 4;
  const nextBtn = $('#flow-next');
  const backBtn = $('#flow-back');
  const bar = $('#flow-bar');
  const count = $('#flow-step');
  const topicInput = $('#topic-input');
  let current = 1;

  const value = name => (form.elements[name]?.value || '').trim();

  function setStep(n) {
    const prev = steps[current - 1];
    const next = steps[n - 1];
    prev.classList.remove('active');
    prev.classList.toggle('leave-up', n > current);
    next.classList.remove('leave-up');
    next.classList.add('active');
    current = n;

    const shown = Math.min(n, total);
    count.textContent = String(shown).padStart(2, '0');
    bar.style.width = (n > total ? 100 : (shown / total) * 100) + '%';
    backBtn.disabled = n === 1;
    $('span', nextBtn).textContent = n === total ? 'Send message' : 'Next';
    form.classList.toggle('complete', n > total);

    const name = value('name') || 'friend';
    $$('.js-name', form).forEach(el => { el.textContent = name.split(' ')[0]; });

    const field = $('.step-input, .chip', next);
    if (field && n <= total) setTimeout(() => field.focus({ preventScroll: true }), 350);
  }

  function fail(msg) {
    const step = steps[current - 1];
    $('.step-err', step).textContent = msg;
    step.classList.remove('shake');
    void step.offsetWidth;
    step.classList.add('shake');
  }

  function validate() {
    $('.step-err', steps[current - 1]).textContent = '';
    if (current === 1 && value('name').length < 2) return fail('I’ll need at least a first name.');
    if (current === 2 && !topicInput.value) return fail('Pick whichever fits best.');
    if (current === 3 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) return fail('That email doesn’t look quite right.');
    if (current === 4 && value('message').length < 10) return fail('A sentence or two helps me reply properly.');
    return true;
  }

  $$('.chip', form).forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.chip', form).forEach(c => c.classList.toggle('sel', c === chip));
      topicInput.value = chip.dataset.v;
      $('.step-err', steps[1]).textContent = '';
      setTimeout(() => { if (current === 2) setStep(3); }, 380);
    });
  });

  $('#f-msg').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });

  backBtn.addEventListener('click', () => { if (current > 1) setStep(current - 1); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!validate()) return;
    if (current < total) { setStep(current + 1); return; }

    nextBtn.disabled = true;
    $('span', nextBtn).textContent = 'Sending…';
    const data = new FormData(form);
    const subject = `[Portfolio] ${topicInput.value} — ${value('name')}`;
    const mailto = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${value('message')}\n\n— ${value('name')} (${value('email')})`)}`;

    let delivered = false;
    try {
      // Works when the site is served by Netlify (form is registered via data-netlify).
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
      });
      delivered = res.ok;
    } catch (_) { delivered = false; }

    $$('.js-email', form).forEach(el => { el.textContent = value('email'); });
    const sub = $('#done-sub');
    const q = $('.step-done .step-q', form);
    if (delivered) {
      q.innerHTML = `Thanks, <span class="js-name">${escapeHTML(value('name').split(' ')[0])}</span> — message received.`;
      sub.innerHTML = `I'll reply to <strong>${escapeHTML(value('email'))}</strong> soon.`;
    } else {
      // Static hosting (GitHub Pages): hand off to the visitor's mail app, pre-filled.
      q.innerHTML = `Almost there, <span class="js-name">${escapeHTML(value('name').split(' ')[0])}</span>.`;
      sub.innerHTML = `Your email app should open with everything filled in — just hit send. If it didn't, <a href="${mailto}">open it here</a> or write to ${EMAIL}.`;
      window.location.href = mailto;
    }
    nextBtn.disabled = false;
    setStep(total + 1);
  });

  $('#flow-reset').addEventListener('click', () => {
    form.reset();
    topicInput.value = '';
    $$('.chip', form).forEach(c => c.classList.remove('sel'));
    steps.forEach(s => s.classList.remove('active', 'leave-up'));
    steps[0].classList.add('active');
    current = 1;
    setStep(1);
  });
})();
