/* ── Stock Ticker ─────────────────────────────────────────── */
const STOCKS = [
  { sym:'AAPL',  price:189.30 },
  { sym:'MSFT',  price:415.75 },
  { sym:'GOOGL', price:175.44 },
  { sym:'TSLA',  price:248.60 },
  { sym:'NVDA',  price:875.40 },
  { sym:'SPY',   price:525.12 },
  { sym:'QQQ',   price:445.30 },
  { sym:'META',  price:512.80 },
  { sym:'AMZN',  price:190.55 },
  { sym:'BTC',   price:68420.00 },
  { sym:'ETH',   price:3840.25 },
  { sym:'BRK.B', price:408.60 },
];

function buildTicker() {
  const track = document.getElementById('ticker-track');
  if (!track) return;
  const items = [...STOCKS, ...STOCKS];
  track.innerHTML = items.map(s => {
    const chg = (Math.random() * 4 - 2).toFixed(2);
    const dir = chg >= 0 ? 'up' : 'dn';
    const arrow = chg >= 0 ? '▲' : '▼';
    return `<span class="ticker-item">
      <span class="ticker-sym">${s.sym}</span>
      <span class="ticker-price">$${s.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      <span class="ticker-change ${dir}">${arrow} ${Math.abs(chg)}%</span>
    </span>`;
  }).join('');

  // Live flicker update every 3s
  setInterval(() => {
    document.querySelectorAll('.ticker-item').forEach((el, i) => {
      const s = items[i % STOCKS.length];
      const chg = (Math.random() * 4 - 2).toFixed(2);
      const dir = chg >= 0 ? 'up' : 'dn';
      const arrow = chg >= 0 ? '▲' : '▼';
      const newPrice = (s.price * (1 + parseFloat(chg) / 100)).toFixed(2);
      el.querySelector('.ticker-price').textContent = `$${parseFloat(newPrice).toLocaleString('en-US',{minimumFractionDigits:2})}`;
      const ch = el.querySelector('.ticker-change');
      ch.className = `ticker-change ${dir}`;
      ch.textContent = `${arrow} ${Math.abs(chg)}%`;
    });
  }, 3000);
}

buildTicker();

/* ── Custom Cursor ────────────────────────────────────────── */
(function initCursor() {
  const dot  = document.getElementById('cursor-dot');
  const ring = document.getElementById('cursor-ring');
  if (!dot || !ring) return;

  let mx = -100, my = -100, rx = -100, ry = -100, shown = false;

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;
    dot.style.left = mx + 'px';
    dot.style.top  = my + 'px';
    if (!shown) {
      shown = true;
      dot.style.opacity  = '1';
      ring.style.opacity = '1';
    }
  });

  (function loop() {
    rx += (mx - rx) * 0.10;
    ry += (my - ry) * 0.10;
    ring.style.left = Math.round(rx) + 'px';
    ring.style.top  = Math.round(ry) + 'px';
    requestAnimationFrame(loop);
  })();

  const sel = 'a, button, .proj-card, .ach-card, .int-card, .speak-card, .learn-card, .sk-col, .hm-cell, input, textarea';
  document.querySelectorAll(sel).forEach(el => {
    el.addEventListener('mouseenter', () => { dot.classList.add('hov'); ring.classList.add('hov'); });
    el.addEventListener('mouseleave', () => { dot.classList.remove('hov'); ring.classList.remove('hov'); });
  });

  document.addEventListener('mouseleave', () => { dot.style.opacity = '0'; ring.style.opacity = '0'; shown = false; });
  document.addEventListener('mouseenter', () => { /* shows on next mousemove */ });
})();

/* ── Hero Canvas Particles ────────────────────────────────── */
(function initCanvas() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = canvas.parentElement.offsetHeight;
  }
  resize();
  window.addEventListener('resize', () => { resize(); init(); });

  function Particle() {
    this.x  = Math.random() * W;
    this.y  = Math.random() * H;
    this.vx = (Math.random() - .5) * .4;
    this.vy = (Math.random() - .5) * .4;
    this.r  = Math.random() * 1.8 + .6;
    this.alpha = Math.random() * .5 + .15;
  }

  function init() {
    const count = Math.floor(W * H / 14000);
    particles = Array.from({ length: count }, () => new Particle());
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(59,130,246,${p.alpha})`;
      ctx.fill();
    });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(59,130,246,${.12 * (1 - dist/120)})`;
          ctx.lineWidth = .6;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }

  init();
  draw();
})();

/* ── Typing Animation ─────────────────────────────────────── */
(function typing() {
  const el = document.getElementById('type-target');
  if (!el) return;
  const phrases = [
    'Quantitative Analyst',
    'Finance & AI Enthusiast',
    'Student Developer',
    'Data Science Explorer',
    'Python Developer',
  ];
  let pi = 0, ci = 0, deleting = false;

  function tick() {
    const phrase = phrases[pi];
    if (!deleting) {
      el.textContent = phrase.slice(0, ++ci);
      if (ci === phrase.length) { deleting = true; setTimeout(tick, 1800); return; }
    } else {
      el.textContent = phrase.slice(0, --ci);
      if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; }
    }
    setTimeout(tick, deleting ? 55 : 90);
  }
  tick();
})();

/* ── Counter animation ────────────────────────────────────── */
function animateCounters() {
  document.querySelectorAll('.h-num').forEach(el => {
    const target = parseInt(el.dataset.target);
    let cur = 0;
    const step = () => {
      cur = Math.min(cur + 1, target);
      el.textContent = cur;
      if (cur < target) requestAnimationFrame(step);
    };
    step();
  });
}

/* ── Navbar ───────────────────────────────────────────────── */
const navbar    = document.getElementById('navbar');
const tickerBar = document.getElementById('ticker-bar');
const navLinks  = document.querySelectorAll('.nav-link');
const sections  = document.querySelectorAll('section[id]');
let lastScrollY = 0;

function onScroll() {
  const sy = window.scrollY;
  navbar.classList.toggle('pinned', sy > 30);

  const heroSection = document.getElementById('hero');
  const pastHero = heroSection && sy > heroSection.offsetHeight * 0.85;
  tickerBar.classList.toggle('ticker-hidden', pastHero);
  navbar.classList.toggle('ticker-gone', pastHero);
  lastScrollY = sy;

  let cur = '';
  sections.forEach(s => { if (sy >= s.offsetTop - 120) cur = s.id; });
  navLinks.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${cur}`));
}

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const navToggle = document.getElementById('nav-toggle');
const navLinksEl = document.getElementById('nav-links');

navToggle.addEventListener('click', () => {
  const open = navLinksEl.classList.toggle('open');
  navToggle.classList.toggle('open', open);
});

navLinks.forEach(l => l.addEventListener('click', () => {
  navLinksEl.classList.remove('open');
  navToggle.classList.remove('open');
}));

/* ── IntersectionObserver — scroll animations ─────────────── */
let countersAnimated = false;

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => entry.target.classList.add('in'), i * 70);
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

const skillObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.querySelectorAll('.sk-fill').forEach(bar => {
        bar.style.width = bar.dataset.w + '%';
      });
      skillObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.3 });

const heroObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting && !countersAnimated) {
      countersAnimated = true;
      animateCounters();
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.int-card, .about-card, .proj-card, .ach-card, .learn-card, .speak-card, .speak-quote, .ci-card, .chart-card, .sh, .sk-col, .hero-content, .hero-terminal').forEach(el => {
  el.classList.add('fade-up');
  observer.observe(el);
});

document.querySelectorAll('.sk-col').forEach(col => skillObserver.observe(col));

const heroStats = document.querySelector('.hero-stats');
if (heroStats) heroObserver.observe(heroStats);

/* ── Project Filtering ────────────────────────────────────── */
document.querySelectorAll('.pf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.f;
    document.querySelectorAll('.proj-card').forEach(card => {
      const cats = card.dataset.cat || '';
      const show = filter === 'all' || cats.includes(filter);
      card.classList.toggle('hidden', !show);
    });
  });
});

/* ── Chart.js — Global Dark Theme ────────────────────────── */
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 11;

/* ── Macro Economic Chart ─────────────────────────────────── */
(function macroChart() {
  const ctx = document.getElementById('macro-chart');
  if (!ctx) return;
  const years = ['2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024'];
  const cpi   = [1.6, 0.1, 2.1, 2.1, 2.4, 1.8, 1.2, 7.0, 8.0, 3.4, 3.1];
  const unemp = [6.2, 5.3, 4.9, 4.4, 3.9, 3.7, 6.8, 5.4, 3.6, 3.7, 3.9];

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: years,
      datasets: [
        {
          label: 'CPI Inflation (%)',
          data: cpi,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#ef4444',
          fill: true,
          tension: .4,
        },
        {
          label: 'Unemployment (%)',
          data: unemp,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#3b82f6',
          fill: true,
          tension: .4,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#94a3b8', usePointStyle: true, padding: 16 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: 'rgba(255,255,255,.08)', borderWidth: 1 },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b' } },
        y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b', callback: v => v + '%' } },
      },
    },
  });
})();

/* ── Stock Comparison Chart ───────────────────────────────── */
(function stockChart() {
  const ctx = document.getElementById('stock-chart');
  if (!ctx) return;

  const months = ['Jan 20','Apr 20','Jul 20','Oct 20','Jan 21','Apr 21','Jul 21','Oct 21',
                  'Jan 22','Apr 22','Jul 22','Oct 22','Jan 23','Apr 23','Jul 23','Oct 23','Jan 24','Apr 24'];

  function genReturns(seed, vol, trend) {
    let v = 100;
    return months.map((_, i) => {
      v = v * (1 + (Math.sin(i * seed) * vol + trend));
      return parseFloat(v.toFixed(2));
    });
  }

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        { label: 'AAPL', data: genReturns(1.1, 0.06, 0.012), borderColor: '#a78bfa', borderWidth: 2, pointRadius: 0, tension: .4 },
        { label: 'TSLA', data: genReturns(2.3, 0.12, 0.008), borderColor: '#f59e0b', borderWidth: 2, pointRadius: 0, tension: .4 },
        { label: 'SPY',  data: genReturns(0.7, 0.04, 0.009), borderColor: '#10b981', borderWidth: 2, pointRadius: 0, tension: .4 },
        { label: 'NVDA', data: genReturns(1.7, 0.09, 0.022), borderColor: '#3b82f6', borderWidth: 2, pointRadius: 0, tension: .4 },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#94a3b8', usePointStyle: true, padding: 16 } },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: 'rgba(255,255,255,.08)',
          borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} (normalized)` },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b', maxRotation: 45 } },
        y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b' } },
      },
    },
  });
})();

/* ── Portfolio Pie Chart ──────────────────────────────────── */
(function pieChart() {
  const ctx = document.getElementById('pie-chart');
  if (!ctx) return;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Tech', 'Finance', 'Energy', 'Healthcare', 'Bonds', 'Cash'],
      datasets: [{
        data: [35, 20, 12, 13, 12, 8],
        backgroundColor: ['#3b82f6','#8b5cf6','#f59e0b','#10b981','#64748b','#374151'],
        borderColor: '#080b14',
        borderWidth: 3,
      }],
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: '#94a3b8', usePointStyle: true, padding: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: 'rgba(255,255,255,.08)',
          borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}%` },
        },
      },
    },
  });
})();

/* ── VIX Chart ────────────────────────────────────────────── */
(function vixChart() {
  const ctx = document.getElementById('vix-chart');
  if (!ctx) return;

  const labels = ['Jan 22','Apr 22','Jul 22','Oct 22','Jan 23','Apr 23','Jul 23','Oct 23','Jan 24','Apr 24'];
  const vix    = [22, 33, 25, 29, 20, 18, 15, 19, 14, 17];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'VIX',
        data: vix,
        backgroundColor: vix.map(v => v > 25 ? 'rgba(239,68,68,.7)' : v > 20 ? 'rgba(245,158,11,.7)' : 'rgba(16,185,129,.7)'),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: 'rgba(255,255,255,.08)',
          borderWidth: 1,
          callbacks: { label: ctx => ` VIX: ${ctx.parsed.y} — ${ctx.parsed.y > 25 ? 'High Fear' : ctx.parsed.y > 20 ? 'Elevated' : 'Calm'}` },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b', maxRotation: 45 } },
        y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#64748b' } },
      },
    },
  });
})();

/* ── Market Heatmap ───────────────────────────────────────── */
(function buildHeatmap() {
  const container = document.getElementById('heatmap');
  if (!container) return;
  const sectors = [
    { name: 'Technology',   pct: +3.2 },
    { name: 'Financials',   pct: +1.8 },
    { name: 'Energy',       pct: -0.9 },
    { name: 'Health Care',  pct: +0.5 },
    { name: 'Consumer',     pct: +2.1 },
    { name: 'Utilities',    pct: -1.4 },
    { name: 'Industrials',  pct: +1.1 },
    { name: 'Materials',    pct: -0.3 },
    { name: 'Real Estate',  pct: -2.1 },
    { name: 'Comm Svcs',    pct: +2.7 },
  ];
  container.innerHTML = sectors.map(s => {
    const intensity = Math.min(Math.abs(s.pct) / 4, 1);
    const bg = s.pct >= 0
      ? `rgba(16,185,129,${0.18 + intensity * 0.52})`
      : `rgba(239,68,68,${0.18 + intensity * 0.52})`;
    const border = s.pct >= 0 ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
    const sign = s.pct >= 0 ? '+' : '';
    return `<div class="hm-cell" style="background:${bg};border:1px solid ${border}" title="${s.name}: ${sign}${s.pct}%">
      <span class="hm-name">${s.name}</span>
      <span class="hm-pct">${sign}${s.pct}%</span>
    </div>`;
  }).join('');
})();

/* ── Contact Form ─────────────────────────────────────────── */
const form = document.getElementById('contact-form');
const formOk = document.getElementById('form-ok');

if (form) {
  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const orig = btn.innerHTML;
    btn.textContent = 'Sending…';
    btn.disabled = true;

    setTimeout(() => {
      form.reset();
      btn.innerHTML = orig;
      btn.disabled = false;
      formOk.classList.remove('hidden');
      setTimeout(() => formOk.classList.add('hidden'), 5000);
    }, 1200);
  });
}

/* ── Footer year ──────────────────────────────────────────── */
const yrEl = document.getElementById('yr');
if (yrEl) yrEl.textContent = new Date().getFullYear();
