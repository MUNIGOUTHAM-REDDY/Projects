// Intro splash: an animated "MUNI MADAGODU" loading screen shown for at least 15 s on every load,
// and until the 3D scene is ready. To remove it, delete this file and the
// <script src="intro.js"> line in index.template.html, then rebuild.
const CSS = `
  /* Intro splash: shown for at least 15 s on every load, and until the scene is ready. */
  #intro {
    position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
    background: radial-gradient(120% 90% at 50% 55%, #14231a 0%, #070c09 70%);
    transition: opacity 1.2s ease, visibility 1.2s;
  }
  #intro.gone { opacity: 0; visibility: hidden; }
  #intro .wrap { width: 100%; padding: 0 16px; text-align: center; }
  #intro .name {
    margin: 0; font: 600 clamp(28px, 6.6vw, 92px)/1 var(--display); letter-spacing: 0.06em; margin-right: -0.1em;
    text-transform: uppercase; white-space: nowrap; color: var(--ink);
    animation: intro-track 15s cubic-bezier(.2,.6,.2,1) both;
  }
  #intro .word { display: inline-block; white-space: nowrap; }
  #intro .gap { display: inline-block; width: 0.42em; }
  #intro .ch {
    display: inline-block; opacity: 0; transform: translateY(0.45em) rotateX(70deg); filter: blur(10px);
    background: linear-gradient(100deg, #cfe3c8 0%, #ffffff 45%, var(--accent) 52%, #cfe3c8 60%, #cfe3c8 100%);
    background-size: 300% 100%; background-position: 100% 0;
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    animation: intro-in 1.1s cubic-bezier(.2,.8,.2,1) forwards, intro-shine 3.2s ease-in-out 2.4s infinite;
    animation-delay: calc(var(--i) * 90ms + 300ms), calc(var(--i) * 70ms + 2.4s);
  }
  #intro .tag {
    margin: 26px 0 34px; font: 400 clamp(11px, 1.4vw, 13px)/1 var(--ui); letter-spacing: 0.42em;
    text-transform: uppercase; color: var(--ink-dim); opacity: 0; animation: intro-fade 1.4s ease 1.8s forwards;
  }
  #intro .meter { width: min(360px, 70vw); margin: 0 auto; opacity: 0; animation: intro-fade 1s ease 1.4s forwards; }
  #intro .track { height: 1px; background: var(--line); overflow: hidden; }
  #intro .fill { height: 100%; background: linear-gradient(90deg, transparent, var(--accent)); transform-origin: left; transform: scaleX(0); }
  #intro .row { display: flex; justify-content: space-between; margin-top: 12px; font: 400 11px/1 var(--ui); letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
  @keyframes intro-in { to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes intro-shine { 0% { background-position: 100% 0; } 60%, 100% { background-position: 0% 0; } }
  @keyframes intro-fade { to { opacity: 1; } }
  @keyframes intro-track { from { letter-spacing: 0.02em; } to { letter-spacing: 0.1em; } }
  @media (prefers-reduced-motion: reduce) {
    #intro .name { animation: none; }
    #intro .ch { animation: intro-fade .6s ease forwards; transform: none; filter: none; }
  }
`;

const MARKUP = `
<div id="intro" role="status" aria-label="MUNI MADAGODU — loading">
  <div class="wrap">
    <h2 class="name" aria-hidden="true"></h2>
    <p class="tag">Hidden River &middot; real-time forest</p>
    <div class="meter">
      <div class="track"><div class="fill"></div></div>
      <div class="row"><span class="msg">Loading</span><span class="num">0%</span></div>
    </div>
  </div>
</div>
`;

const startIntro = () => {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.body.insertAdjacentHTML('afterbegin', MARKUP);
  const intro = document.getElementById('intro');
  if (/[?&]still=1/.test(location.search)) { intro.remove(); return; }
  const NAME = 'MUNI MADAGODU', MIN_MS = 15000;
  const h = intro.querySelector('.name');
  let i = 0;
  NAME.split(' ').forEach((w, wi) => {
    if (wi) { const g = document.createElement('span'); g.className = 'gap'; h.appendChild(g); }
    const word = document.createElement('span'); word.className = 'word';
    for (const c of w) { const s = document.createElement('span'); s.className = 'ch'; s.style.setProperty('--i', i++); s.textContent = c; word.appendChild(s); }
    h.appendChild(word);
  });
  const fill = intro.querySelector('.fill'), num = intro.querySelector('.num'), msg = intro.querySelector('.msg');
  const steps = ['Loading', 'Growing trees', 'Filling the river', 'Scattering leaves', 'Catching the light', 'Almost there'];
  const t0 = performance.now();
  let sceneReady = false;
  const watch = () => {
    const l = document.getElementById('loader');
    if (!l) return;
    const check = () => { if (l.classList.contains('done')) sceneReady = true; };
    check(); new MutationObserver(check).observe(l, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / MIN_MS);
    // ease to 96% over 15 s, then hold until the scene is actually ready
    const p = sceneReady && k >= 1 ? 1 : 0.96 * (1 - Math.pow(1 - k, 2.2));
    fill.style.transform = `scaleX(${p})`;
    num.textContent = `${Math.round(p * 100)}%`;
    msg.textContent = p >= 1 ? 'Enter' : steps[Math.min(steps.length - 1, Math.floor(k * steps.length))];
    if (p >= 1) { setTimeout(() => intro.classList.add('gone'), 450); setTimeout(() => intro.remove(), 1800); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
if (document.body) startIntro(); else document.addEventListener('DOMContentLoaded', startIntro);
