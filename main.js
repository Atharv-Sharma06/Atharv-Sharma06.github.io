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

// If main.js arrives late, the CSS fallback may already have revealed the page; don't hide it again.
const fellBack = !reduceMotion && getComputedStyle($('.intro-step')).opacity === '1';
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

/* ── Pinned header ────────────────────────────────────────── */
const headerEl = $('.header');
const onScrollHeader = () => headerEl.classList.toggle('stuck', window.scrollY > 24);
window.addEventListener('scroll', onScrollHeader, { passive: true });
onScrollHeader();

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
  if (e.key !== 'Escape' || !nav.classList.contains('open') || !$('#modal').hidden) return;
  const inHeader = nav.contains(document.activeElement) || document.activeElement === menuBtn;
  setMenu(false);
  if (inHeader) menuBtn.focus();
});
const wideMQ = matchMedia('(min-width: 961px)');
const onWide = e => { if (e.matches) setMenu(false); };
if (wideMQ.addEventListener) wideMQ.addEventListener('change', onWide); else wideMQ.addListener(onWide);

/* ── Intro: a font roulette that lands on the name, then the profile steps in ── */
const hero = $('#hero');
const heroName = $('#hero-name');
const typeEl = $('.type', heroName);
const avatar = $('.avatar', hero);
const introSteps = $$('.intro-step', hero);
let introRaf = 0;

// The name flips through pixel typefaces, slot-machine style, before settling on the display face.
const ROLL_FONTS = ['Silkscreen', 'VT323', 'Jacquard 12', 'Sixtyfour', 'Pixelify Sans', 'Micro 5', 'Workbench', 'DotGothic16', 'Jersey 10', 'Handjet'];
const ROLL_MS = 110;
const roll = el('span', { class: 'name-roll', 'aria-hidden': 'true' });
heroName.append(roll);

function endIntro() {
  cancelAnimationFrame(introRaf);
  typeEl.textContent = typeEl.dataset.text;
  heroName.classList.remove('rolling');
  heroName.removeAttribute('aria-label');
  roll.textContent = '';
  roll.removeAttribute('style');
  hero.classList.remove('intro');
  introSteps.forEach(s => s.classList.add('shown'));
  avatar.classList.add('in');
}

function playIntro() {
  cancelAnimationFrame(introRaf);
  if (reduceMotion) { endIntro(); return; }
  const full = typeEl.dataset.text;
  const ROLL_END = ROLL_FONTS.length * ROLL_MS;
  const STEP_MS = 120;
  const AVATAR_AT = ROLL_END + STEP_MS * 3;
  const DURATION = ROLL_END + STEP_MS * (introSteps.length + 1);
  heroName.setAttribute('aria-label', full);
  hero.classList.add('intro');
  introSteps.forEach(s => s.classList.remove('shown'));
  avatar.classList.remove('in');
  // Every face is scaled toward the width the final name will occupy (line by line where it wraps), without growing much taller than it.
  const target = Math.min(heroName.clientWidth, typeEl.getBoundingClientRect().width);
  const wraps = typeEl.getClientRects().length > 1;
  heroName.classList.add('rolling');
  roll.textContent = wraps ? full.replace(' ', '\n') : full;
  let face = -1;
  const t0 = performance.now();
  const tick = now => {
    const t = now - t0;
    const k = Math.min(ROLL_FONTS.length, Math.floor(t / ROLL_MS));
    if (k !== face) {
      face = k;
      if (k < ROLL_FONTS.length) {
        // A face that is still downloading is skipped: the roll keeps the previous one.
        if (!document.fonts || document.fonts.check(`400 64px "${ROLL_FONTS[k]}"`, full)) {
          roll.style.fontFamily = `"${ROLL_FONTS[k]}", var(--px-d)`;
          roll.style.transform = `translateX(-50%) scale(${clamp(target / roll.scrollWidth, 0.4, 1.25)})`;
        }
      } else {
        heroName.classList.remove('rolling');
        roll.textContent = '';
      }
    }
    introSteps.forEach((s, i) => { if (t > ROLL_END + STEP_MS + i * STEP_MS) s.classList.add('shown'); });
    if (t > AVATAR_AT) avatar.classList.add('in');
    if (t < DURATION + 300) introRaf = requestAnimationFrame(tick);
    else endIntro();
  };
  introRaf = requestAnimationFrame(tick);
}

if (fellBack) {
  endIntro();
} else {
  // Wait (briefly) for the display face only; the roulette faces load alongside and late ones are skipped.
  heroName.style.visibility = 'hidden';
  const load = f => document.fonts.load(`400 64px "${f}"`, typeEl.dataset.text);
  if (document.fonts) ROLL_FONTS.forEach(f => load(f).catch(() => {}));
  const display = document.fonts ? load('Press Start 2P') : Promise.resolve();
  Promise.race([display, new Promise(r => setTimeout(r, 1200))])
    .catch(() => {}).then(() => { heroName.style.visibility = ''; playIntro(); });
}

$('#replay').addEventListener('click', () => {
  heroName.setAttribute('tabindex', '-1');
  heroName.focus({ preventScroll: true });
  if (reduceMotion || window.scrollY < 4) { window.scrollTo(0, 0); playIntro(); return; }
  // Start once the page is back at the top, so the roulette is actually seen.
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    window.removeEventListener('scroll', onScroll);
    clearTimeout(fallback);
    playIntro();
  };
  const onScroll = () => { if (window.scrollY < 4) go(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  const fallback = setTimeout(go, 1600);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ── Reveals + heading scramble ───────────────────────────── */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=?';
function scramble(node) {
  if (reduceMotion) return;
  const final = node.textContent;
  node.setAttribute('aria-label', final);
  node.style.height = node.offsetHeight + 'px';
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
    else { node.textContent = final; node.style.height = ''; }
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
if (fellBack) $$('.rv').forEach(n => n.classList.add('in'));
$$('.rv, [data-scramble]').forEach(n => io.observe(n));

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
let shown = null; // the project row on show in the window
const cards = $$('.entry.project');
// The window's commands are a small menu: the ▶ cursor marks the selected one. The key legend means what it says,
// pressed or tapped: Esc closes, Tab moves the cursor to the next command, Enter selects it.
const keyFor = name => $(`.key[data-key="${name}"]`, modal);
const commands = $$('.modal-actions .btn', modal);
const modalWin = $('.modal-win', modal);
let cmd = 0;
function markCommand(i) {
  cmd = (i + commands.length) % commands.length;
  commands.forEach((c, k) => {
    c.classList.toggle('sel', k === cmd);
    if (k === cmd) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
  });
  // the on-screen Enter says what it will select
  keyFor('Enter').setAttribute('aria-label', `Select: ${commands[cmd].textContent.trim()} (Enter)`);
}
function selectCommand(i) {
  markCommand(i);
  commands[cmd].focus({ preventScroll: true });
}

function fillProject(card) {
  shown = card;
  const link = $('.e-link', card).href;
  const title = $('.e-title', card).textContent;
  $('#modal-file').textContent = title.toLowerCase().replace(/\W+/g, '_') + '.py';
  $('#modal-title').textContent = title;
  $('#modal-tag').textContent = `${$('.e-tagline', card).textContent} · ${$('.e-when', card).textContent.trim()}`;
  $('#modal-desc').textContent = $('.e-desc', card).textContent;
  $('#modal-stack').textContent = $$('.e-tags li', card).map(li => li.textContent).join(' · ');
  const list = $('#modal-features');
  list.replaceChildren(...$$('.e-more li', card).map(li => el('li', { text: li.textContent })));
  $('#modal-link').href = link;
  $('#modal-link').firstChild.textContent = card.dataset.repo ? 'View source ' : 'View GitHub ';
  const shot = $('#modal-shot');
  renderShot(shot, card.dataset.project);
  if (!$('.shot-tag', shot)) shot.append(el('span', { class: 'shot-tag', text: 'Preview · illustrative' }));
}
function openProject(card) {
  fillProject(card);
  if (modal.hidden) {
    modalReturn = document.activeElement;
    modal.hidden = false;
    html.classList.add('modal-open');
    setInert(['.skip', '.header', 'main', '.footer'], true);
  }
  // start at the top of the window, on its title, with the cursor on the first command
  modalWin.scrollTop = 0;
  markCommand(0);
  $('#modal-title').focus({ preventScroll: true });
}
function closeProject() {
  if (modal.hidden) return;
  modal.hidden = true;
  html.classList.remove('modal-open');
  setInert(['.skip', '.header', 'main', '.footer'], false);
  if (modalReturn) modalReturn.focus();
}
cards.forEach(card => $('.explore', card).addEventListener('click', () => openProject(card)));
$$('[data-close]', modal).forEach(n => n.addEventListener('click', closeProject));
$('#modal-next').addEventListener('click', () => {
  const i = (cards.indexOf(shown) + 1) % cards.length;
  fillProject(cards[i]);
  modalWin.scrollTop = 0;
  $('#modal-status').textContent = `${$('#modal-title').textContent}, project ${i + 1} of ${cards.length}`;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProject(); });

// The on-screen keys press down when the real key is pressed, and do the same thing when tapped.
function pressKey(name) {
  const k = keyFor(name);
  if (!k) return;
  k.classList.add('down');
  setTimeout(() => k.classList.remove('down'), 140);
}
function runKey(name) {
  if (name === 'Escape') closeProject();
  else if (name === 'Tab') selectCommand(cmd + 1);
  else if (name === 'Enter') commands[cmd].click();
}
modal.addEventListener('focusin', e => { const k = commands.indexOf(e.target); if (k >= 0) markCommand(k); });
// on the document, so the keys keep working wherever focus sits while the window is open
document.addEventListener('keydown', e => {
  if (modal.hidden) return;
  if (e.key === 'Tab') {
    // Tab cycles the cursor through the commands and never leaves the window
    e.preventDefault();
    pressKey('Tab');
    selectCommand(cmd + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Enter') {
    pressKey('Enter');
    // a focused command handles Enter itself; anywhere else in the window, Enter selects the command under the cursor
    if (!e.target.closest('a, button')) { e.preventDefault(); commands[cmd].click(); }
  }
});
$$('.key', modal).forEach(k => {
  k.addEventListener('mousedown', e => e.preventDefault()); // keep focus (and the cursor) on the selected command
  k.addEventListener('click', () => { pressKey(k.dataset.key); runKey(k.dataset.key); });
});

/* ── Sections: dropdowns under the profile ───────────────── */
// Like the reference, every section starts folded. A toggle drops its section open below the menu and folds whichever
// was open; pressing it again rolls it back up. Header links, the skip link, #hashes and the terminal open them too.
const secs = $$('.sec');
const togglesEl = $('#toggles');
const tgs = $$('.tg');
const navLinks = $$('.nav a[href^="#"]');
const OLD_IDS = { about: 'experience', quests: 'awards', term: 'contact' }; // anchors from the previous layout
const sectionId = id => (secs.some(s => s.id === id) ? id : OLD_IDS[id] || null);
const narrowMQ = matchMedia('(max-width: 720px)');
const FOLD_MS = 200;
let openSec = null;
let turn = 0;

// Counts follow the rows ("6 entries", "4 ways"), so they can't drift when rows are added.
$$('.sec-count').forEach(c => {
  const list = $('.entries', c.closest('.sec'));
  const m = c.textContent.trim().match(/^\d+\s+(\w+)$/);
  if (!list || !m) return;
  const one = m[1].replace(/ies$/, 'y').replace(/s$/, '');
  const many = /[^aeiou]y$/.test(one) ? one.replace(/y$/, 'ies') : `${one}s`;
  const n = list.children.length;
  c.textContent = `${n} ${n === 1 ? one : many}`;
});

function syncSections() {
  const id = openSec ? openSec.id : '';
  tgs.forEach(t => t.setAttribute('aria-expanded', String(t.getAttribute('aria-controls') === id)));
  navLinks.forEach(a => { if (a.hash === `#${id}`) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
}

// Land with the toggles just under the pinned header, clear of its fade. On phones the section itself goes there,
// unless the toggles hold keyboard focus, which must stay in view.
function bringIntoView(sec) {
  const clear = headerEl.getBoundingClientRect().bottom + 36;
  const top = sec.getBoundingClientRect().top;
  if (top >= clear - 8 && top < window.innerHeight * 0.55) return;
  const anchor = narrowMQ.matches && !togglesEl.querySelector(':focus-visible') ? sec : togglesEl;
  const y = anchor.getBoundingClientRect().top + window.scrollY - clear;
  window.scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? 'auto' : 'smooth' });
}

function openSection(id, { toggle = false, focus = false, scroll = true, animate = !reduceMotion } = {}) {
  const sid = sectionId(id);
  const next = sid ? document.getElementById(sid) : null;
  const prev = openSec;
  clearTimeout(turn);
  // pressing the open section's toggle folds it away again
  openSec = toggle && next === prev ? null : next;
  syncSections();
  history.replaceState(null, '', openSec ? `#${openSec.id}` : location.pathname + location.search);
  const drop = () => {
    secs.forEach(s => { s.classList.remove('folding', 'dropping'); if (s !== openSec) s.classList.remove('open'); });
    if (!openSec) return;
    openSec.classList.add('open');
    if (animate && openSec !== prev) {
      $$('.entries > li, .term, .sec-sub', openSec).forEach((n, i) => n.style.setProperty('--i', Math.min(i, 10)));
      void openSec.offsetWidth;
      openSec.classList.add('dropping');
    }
    if (scroll) bringIntoView(openSec);
    if (focus) {
      const h = $('h2', openSec);
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  };
  // the open section rolls up first, then the new one drops down
  if (animate && prev && prev !== openSec) { prev.classList.remove('dropping'); prev.classList.add('folding'); turn = setTimeout(drop, FOLD_MS); }
  else drop();
}

const plainClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
tgs.forEach(t => t.addEventListener('click', e => {
  if (!plainClick(e)) return;
  e.preventDefault();
  openSection(t.getAttribute('aria-controls'), { toggle: true });
}));
// Any other link to a section (header, skip link) opens it and moves focus there.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.classList.contains('tg') || !plainClick(e) || !sectionId(a.hash.slice(1))) return;
  e.preventDefault();
  openSection(a.hash.slice(1), { focus: true });
});
window.addEventListener('hashchange', () => {
  const id = sectionId(location.hash.slice(1));
  if (id && document.getElementById(id) !== openSec) openSection(id, { focus: true });
});

(function firstOpen() {
  const id = sectionId(location.hash.slice(1));
  if (!html.classList.contains('one-sec')) {
    // main.js arrived so late that every section was unfolded for reading. Keep open the section under the reading
    // line (a third of the way down, below the header), fold the rest, and hold what's being read where it is.
    // The URL is left alone, so the browser doesn't jump to a #hash at load.
    const top = headerEl.getBoundingClientRect().bottom;
    const line = top + (window.innerHeight - top) / 3;
    const keep = secs.find(s => { const r = s.getBoundingClientRect(); return r.top <= line && r.bottom > line; });
    const hold = keep && (document.elementFromPoint(window.innerWidth / 2, line)?.closest('.entry, .sec-head, .sec-sub, .term') || keep);
    const before = hold ? hold.getBoundingClientRect().top : 0;
    if (keep) { openSec = keep; keep.classList.add('open'); }
    html.style.overflowAnchor = 'none';
    html.classList.add('one-sec');
    if (hold) window.scrollBy({ top: hold.getBoundingClientRect().top - before, behavior: 'instant' });
    html.style.overflowAnchor = '';
    syncSections();
    return;
  }
  if (!id) { syncSections(); return; }
  openSection(id, { scroll: false, animate: false });
  // A link straight to a section (…/#awards) was followed while the section was still folded, so jump to it now;
  // on reload or Back, leave the browser's restored scroll position alone.
  const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  if (!nav || nav.type === 'navigate') requestAnimationFrame(() => openSec.scrollIntoView());
})();

/* ── GitHub activity ──────────────────────────────────────── */
function timeAgo(date) {
  const s = Math.max(0, Math.floor((Date.now() - date) / 1000));
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
      return commit ? commit.message.split('\n')[0] : null;
    }
    // Branch/tag creation is noise in a feed; only new repositories are worth showing.
    case 'CreateEvent': return p.ref_type === 'repository' ? 'created repository' : null;
    // The public events API no longer always includes titles, so fall back to the number.
    case 'PullRequestEvent': {
      const pr = p.pull_request || {};
      const action = p.action === 'closed' && pr.merged ? 'merged' : p.action;
      return pr.title ? `${action} PR: ${pr.title}` : null;
    }
    case 'IssuesEvent': {
      const issue = p.issue || {};
      return issue.title ? `${p.action} issue: ${issue.title}` : null;
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
].map(c => ({ ...c, ago: new Date(`${c.date}T12:00:00`).toLocaleString('en-US', { month: 'short', year: 'numeric' }) }));

function renderCommits() {
  $('#commit-list').replaceChildren(...commits.slice(0, 7).map(c => el('li', { class: 'entry' }, [
    el('p', { class: 'e-when', text: c.ago }),
    el('div', { class: 'e-body' }, [el('p', { class: 'e-desc', text: c.msg.slice(0, 80) })]),
    el('div', { class: 'e-meta', title: c.repo, text: c.repo }),
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
    if (Number.isFinite(user.public_repos)) { $('#gh-repos').textContent = user.public_repos; $('.repos').hidden = false; }
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
    if (rows.length >= 3) { commits = rows; renderCommits(); }
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
  // A reply taller than the window is read from its first line, not its last.
  const readFromTop = top => { if (top) out.scrollTop += top.getBoundingClientRect().top - out.getBoundingClientRect().top - 16; };

  const PROJECTS = $$('#projects > .entries:not(.commits) > .entry').map(row => ({
    row, name: $('.e-title', row).textContent, link: $('.e-link', row)?.href, windowed: row.classList.contains('project'),
  }));

  const COMMANDS = {
    help: { desc: 'list commands', run() {
      const top = out.lastElementChild;
      Object.entries(COMMANDS).filter(([, c]) => c.desc).forEach(([k, c]) => print(`${k} --> ${c.desc}`));
      print('tip: tab completes, up/down browses history.', 't-dim');
      readFromTop(top);
    } },
    about: { desc: 'a little about me', run() {
      print('Atharv Sharma. Software engineer at Moonshot (YC). 9th grade at Cuthbertson High School. Charlotte, NC.');
      print('I build software end to end — APIs, data pipelines, dashboards and ML models — mostly pointed at markets and AI safety.');
    } },
    hello: { desc: 'say hello', run() {
      print('Hey, player 2. Welcome to my corner of the internet. Try "projects", or "note" to send me a message.');
    } },
    projects: { desc: 'see what i have built', run() {
      const top = out.lastElementChild;
      PROJECTS.forEach((p, i) => print([`${i + 1}. ${p.name} `, ...(p.link ? [{ href: p.link, text: p.row.dataset.repo ? 'code' : 'github', ext: true }] : [])]));
      print('type "open 1" (or any number) to explore one.', 't-dim');
      readFromTop(top);
    } },
    open: { run(arg) {
      const p = PROJECTS[parseInt(arg, 10) - 1];
      if (!p) { print('usage: open <1-' + PROJECTS.length + '>', 't-err'); return; }
      print(`opening ${p.name}…`, 't-ok');
      if (p.windowed) { openProject(p.row); return; }
      // no project window for this one: show its row in the projects section, with focus on it
      openSection('projects');
      setTimeout(() => {
        const t = $('.e-title', p.row);
        t.setAttribute('tabindex', '-1');
        t.focus({ preventScroll: true });
        p.row.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }, reduceMotion ? 0 : FOLD_MS + 80);
    } },
    skills: { desc: 'my skill tree', run() {
      print('engineering: python, javascript / typescript, react / next.js, sql, git/github, apis, web scraping, streamlit');
      print('ml / data: llm fine-tuning (qlora), pandas, numpy, scikit-learn, tensorflow, matplotlib, plotly, tableau / power bi');
      print('quant: backtesting, factor models, tf-idf on sec filings, portfolio theory, monte carlo, volatility, sharpe ratio, options basics, fred api, yfinance');
    } },
    awards: { desc: 'awards & courses', run() {
      $$('#awards .entry:not(.course)').forEach(r => {
        const place = $('.e-when .state', r);
        print(`★ ${place ? `${place.textContent}, ` : ''}${$('.e-title', r).textContent}`);
      });
      $$('#awards .entry.course').forEach(c => print(`· ${$('.e-title', c).textContent} (${$('.e-when', c).textContent.trim().toLowerCase()})`, 't-dim'));
    } },
    log: { desc: 'recent github activity', run() {
      commits.slice(0, 6).forEach(c => print([{ cls: 't-dim', text: `${c.ago} ` }, { cls: 't-ok', text: c.repo }, ` ${c.msg}`]));
    } },
    cd: { desc: 'open a section — cd research', run(arg) {
      const id = sectionId(arg.trim().toLowerCase().replace(/^[#/.]+|\/$/g, ''));
      if (!id) { print(`usage: cd <${secs.map(s => s.id).join(' | ')}>`, 't-err'); return; }
      print(`opening ${id}…`, 't-ok');
      // the terminal lives in contact: only move focus when it is about to fold away
      openSection(id, { focus: document.getElementById(id) !== openSec });
    } },
    note: { desc: 'write me a note', run() { startNote(); } },
    copy: { desc: 'copy my email', async run() {
      try { await navigator.clipboard.writeText(EMAIL); print(`copied ${EMAIL} to your clipboard.`, 't-ok'); }
      catch (_) { print(['clipboard blocked — here it is: ', { href: `mailto:${EMAIL}`, text: EMAIL }]); }
    } },
    follow: { desc: 'find me elsewhere', run() {
      print(['github   ', { href: `https://github.com/${GH_USER}`, text: `github.com/${GH_USER}`, ext: true }]);
      print(['linkedin ', { href: 'https://www.linkedin.com/in/atharv-sharma-150232408', text: 'linkedin.com/in/atharv-sharma-150232408', ext: true }]);
      print(['email    ', { href: `mailto:${EMAIL}`, text: EMAIL }]);
      print(['resume   ', { href: 'resume.pdf', text: 'resume.pdf', ext: true }]);
    } },
    resume: { desc: 'open my resume', run() {
      print(['opening ', { href: 'resume.pdf', text: 'resume.pdf', ext: true }, '…'], 't-ok');
      window.open('resume.pdf', '_blank', 'noopener');
    } },
    clear: { desc: 'a fresh terminal', run() { out.replaceChildren(); } },
    replay: { desc: 'play the intro again', run() { $('#replay').click(); } },
    whoami: { run() { print('guest. (the site belongs to atharv — swe at moonshot. try "about" or "note".)'); } },
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
    { key: 'topic', q: `what's this about? ${TOPICS.map((t, i) => `${i + 1} ${t.toLowerCase()}`).join(' · ')}`, ph: '1-4 or your own', map: v => (/^[1-4]$/.test(v) ? TOPICS[Number(v) - 1] : v) },
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
    const steps = NOTE_STEPS.filter(s => !(note.preset && s.key === 'topic'));
    setPrompt(`note ${steps.indexOf(step) + 1}/${steps.length} >`);
    input.placeholder = step.ph;
    input.setAttribute('aria-label', `Note: ${step.ph}`);
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
    input.setAttribute('aria-label', 'Terminal command');
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
    } else if (e.key === 'Tab' && !e.shiftKey && /^\s*cd\s+\S*$/i.test(input.value)) {
      // cd completes section names
      const pre = (input.value.match(/^\s*cd\s+(\S*)/i) || [, ''])[1].toLowerCase();
      const names = secs.map(s => s.id).filter(k => k.startsWith(pre));
      // only hold on to Tab when it completes something; otherwise it moves focus on as usual
      if (names.length === 1 && names[0] !== pre) { e.preventDefault(); input.value = `cd ${names[0]}`; }
      else if (names.length > 1) { e.preventDefault(); print(names.join('   '), 't-dim'); }
    } else if (e.key === 'Tab' && !e.shiftKey && input.value.trim()) {
      const pre = input.value.trim().toLowerCase();
      const names = Object.keys(COMMANDS).filter(k => k.startsWith(pre));
      if (names.length === 1 && input.value !== names[0] + ' ') { e.preventDefault(); input.value = names[0] + ' '; }
      else if (names.length > 1) { e.preventDefault(); print(names.join('   '), 't-dim'); }
    }
  });

  $$('[data-cmd]').forEach(b => b.addEventListener('click', () => {
    if (sending) return;
    if (note && b.dataset.cmd !== 'note') { print('note cancelled.', 't-dim'); endNote(); }
    if (b.dataset.cmd === 'note' && note) { input.focus({ preventScroll: true }); return; }
    run(b.dataset.cmd);
    if (b.dataset.cmd === 'note' || !matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true });
  }));
  $('#term-clear').addEventListener('click', () => { out.replaceChildren(); input.focus({ preventScroll: true }); });
  out.addEventListener('click', e => { if (!e.target.closest('a') && !window.getSelection().toString()) input.focus({ preventScroll: true }); });

  // boot screen
  print('guest~ $ about', 't-cmd'); COMMANDS.about.run();
  print('guest~ $ hello', 't-cmd'); COMMANDS.hello.run();
  // Start reading at the top; line heights change once the pixel font arrives, so re-apply then.
  const bootTop = () => { if (!history.length && !note) out.scrollTop = 0; };
  bootTop();
  if (document.fonts) document.fonts.ready.then(bootTop);
})();
