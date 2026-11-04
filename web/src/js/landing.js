import { boot, getJSON, esc, utc, eth, num, short, loadDeployments, loadToken } from './core.js';
import { mountViewer, lineOf, redClasses } from './stream-view.js';
import { makeSign } from './sign.js';

boot();
// scroll reveal (one 200 ms fade per section)
const rio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('[data-reveal]').forEach((el) => rio.observe(el));

// ---------- marquee feed (2D side; the 3D scene subscribes when it loads) ----------
const feed = { lines: [], subs: new Set(), mode: 'off' };
const pushLine = (text, tone = 'live') => { const l = { text: String(text).toUpperCase().replace(/\s+/g, ' ').slice(0, 64), tone }; feed.lines.push(l); if (feed.lines.length > 30) feed.lines.shift(); feed.subs.forEach((f) => f(l)); };
const setMode = (m) => { feed.mode = m; feed.subs.forEach((f) => f(null, m)); };
window.__pmFeed = feed; // for local tests

function marqueeText(ev) {
  const l = lineOf(ev); if (!l || l.kind === 'text' || l.kind === 'status' || (ev.type === 'tool_call' && l.cls === 'edit')) return null;
  if (l.kind === 'red') return [`[REDACTED ${l.text}]`, 'red'];
  if (l.kind === 'prompt') return null;
  if (l.kind === 'end') return ['OFF AIR · NPX PEEKMARQUEE', 'dim'];
  return [`${l.tool} ${l.text}`.slice(0, 48), 'live'];
}

// ---------- card 01: mini timeline ----------
const mini = document.querySelector('[data-mini]');
const miniRows = [];
function miniPush(ev) {
  const l = lineOf(ev); if (!l || l.kind === 'status' || l.kind === 'text' || (ev.type === 'tool_call' && l.cls === 'edit')) return;
  miniRows.push(l); if (miniRows.length > 12) miniRows.shift();
  mini.innerHTML = miniRows.map((r) => `<li class="tc-${r.cls}"><span class="tool">${esc(r.tool)}</span><span>${esc(r.text.slice(0, 24))}</span></li>`).join('');
}
// ---------- card 02: chips light up when red rises ----------
let lastRed = null;
const redSignEl = document.querySelector('[data-red-sign]');
const redSign = redSignEl ? makeSign(redSignEl, { rows: 9, pitch: 6, speed: 60 }) : null;
redSign?.set('STANDBY', 'dim', 'standby');
function chipsOn(ev) {
  const cls = [...redClasses(ev.data?.text), ...redClasses(ev.data?.summary), ...redClasses(ev.data?.snippet)];
  if (ev.data?.hidden) cls.push(ev.data.hidden === 'env_dump' ? 'env_value' : null);
  if (typeof ev.red === 'number') { if (lastRed !== null && ev.red > lastRed && !cls.length) cls.push('high-entropy'); lastRed = ev.red; }
  if (cls.filter(Boolean).length) redSign?.set(`[REDACTED ${cls.filter(Boolean)[0]}]`, 'red');
  for (const c of cls.filter(Boolean)) {
    const chip = document.querySelector(`[data-chips] [data-cls="${c}"]`); if (!chip) continue;
    chip.classList.remove('lit'); void chip.offsetWidth; chip.classList.add('lit');
  }
}

// ---------- embed: top live → latest replay → standby ----------
const box = document.querySelector('[data-embed]');
const now = document.querySelector('[data-now]');
const signEl = document.querySelector('[data-sign]');
const sign = signEl ? makeSign(signEl, { rows: 9, pitch: 8 }) : null;
const cmdHTML = '<div class="cmd"><span class="cmd-prompt" aria-hidden="true">$</span><code>npx peekmarquee</code><button class="copy" type="button" data-copy="npx peekmarquee"><span>Copy</span></button></div>';
function setNow(mode, state, title) {
  now.dataset.mode = mode;
  now.querySelector('.now-state').innerHTML = state;
  now.querySelector('.now-title').textContent = title || '';
  now.querySelector('.now-go').hidden = mode === 'off';
}
async function embed() {
  const live = await getJSON('/api/live');
  let pick = null; let label = null;
  if (live.ok && Array.isArray(live.body) && live.body.length) pick = live.body[0];
  else {
    const rec = await getJSON('/api/recent');
    if (rec.ok && Array.isArray(rec.body) && rec.body.length) { pick = rec.body[0]; label = `replay · ended ${utc(pick.endedAt, false)}`; }
  }
  if (!pick) {
    const down = live.status === 0;
    box.innerHTML = `<div class="sv-empty nostream">${down ? "<p>Can't reach the relay right now.</p>" : '<p>No public stream right now. Start one: <code>npx peekmarquee</code></p>'}${cmdHTML}</div>`;
    mini.innerHTML = '';
    sign?.set('STANDBY', 'dim', 'standby');
    setNow('off', 'STANDBY', down ? "Can't reach the relay right now." : 'No public stream right now.');
    now.href = '#go-live';
    setMode('off');
    return;
  }
  setMode(label ? 'replay' : 'live');
  sign?.set(label ? 'REPLAY' : 'ON AIR', label ? 'ink' : 'live');
  setNow(label ? 'replay' : 'live', label ? esc(label) : '<span class="dot"></span>LIVE', pick.title || 'Untitled session');
  box.innerHTML = '';
  const host = document.createElement('div'); box.appendChild(host);
  await mountViewer(host, {
    id: pick.id, compact: true, label,
    onEvent: (ev) => {
      miniPush(ev); chipsOn(ev);
      const m = marqueeText(ev);
      if (m) pushLine(m[0], m[1]);
    },
    onMeta: (m, mode) => { if (mode === 'replay' && feed.mode === 'live') { setMode('replay'); sign?.set('REPLAY', 'ink'); } },
  });
}
embed();
loadToken().then((t) => { if (t.launched) { const p = document.querySelector('[data-card="tip"] .card-body > p'); if (p) p.textContent = 'Tip in ETH, USDG or $MARQ. Tips go straight to the streamer; the contract holds nothing.'; } });

// ---------- stats + cards 02/03 ----------
(async () => {
  const s = await getJSON('/api/stats');
  const st = s.ok ? s.body : null;
  if (st && st.streamsTotal >= 3) {
    const row = document.querySelector('[data-stats]');
    row.querySelector('[data-st="streamsTotal"]').textContent = num(st.streamsTotal);
    row.querySelector('[data-st="hoursStreamed"]').textContent = num(Math.round(st.hoursStreamed * 10) / 10);
    row.querySelector('[data-st="secretsHidden"]').textContent = num(st.secretsHidden);
    row.hidden = false;
    if (Number(st.secretsHidden) >= 1) { const big = document.querySelector('[data-secrets]'); big.hidden = false; countUp(big.querySelector('b'), st.secretsHidden); }
  }
  if (!st || !Number(st.streamsTotal)) document.querySelectorAll('[data-first]').forEach((el) => { el.hidden = false; });
  tipsCard(st);
})();

function countUp(el, to) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !to) { el.textContent = num(to); return; }
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return; io.disconnect();
    const t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / 900); el.textContent = num(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
  }); io.observe(el);
}

async function tipsCard(st) {
  const total = document.querySelector('[data-tip-total]'); const list = document.querySelector('[data-tip-list]');
  const d = await loadDeployments();
  const contract = d.address ? ` <a href="${d.explorer}/address/${d.address}" rel="noopener" target="_blank">contract</a>` : '';
  const top = await getJSON('/api/tips/top');
  const t = st?.tips;
  if (!t || t.unavailable || !top.ok || top.body?.unavailable) { total.innerHTML = `tips unavailable right now${t?.lastGoodAt ? ` <span class="muted small">(last good ${utc(t.lastGoodAt)})</span>` : ''}`; return; }
  if (!Number(t.count)) { total.innerHTML = `no tips yet — first one lands here${contract}`; return; }
  const units = (v, d) => { try { const a = BigInt(v); const w = a / 10n ** BigInt(d); const f = (a % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, d === 18 ? 5 : 2).replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; } catch { return '?'; } };
  const sym = (s2) => (s2 === 'MARQ' ? '$MARQ' : s2 || 'ETH');
  const per = t.tokens ? Object.entries(t.tokens).filter(([, v]) => Number(v.count)).map(([k, v]) => `<b class="gold">${units(v.amount ?? v.totalWei ?? 0, v.decimals ?? 18)} ${sym(k)}</b>`).join(' · ') : `<b class="gold">${eth(t.totalWei)} ETH</b>`;
  total.innerHTML = `${per} tipped on-chain across ${num(t.count)} tips${contract}`;
  const recent = top.body.recent || top.body.tips;
  const rows = recent ? recent.slice(0, 5).map((x) => `<li><span class="gold">${units(x.amount, x.token?.decimals ?? 18)} ${sym(x.token?.symbol)}</span><span>${esc(short(x.from))} → ${esc(short(x.streamer))}</span></li>`)
    : (top.body.top || []).slice(0, 5).map((x) => `<li><span class="gold">${eth(x.totalWei)} ETH</span><span>${esc((x.title || x.id).slice(0, 26))}</span></li>`);
  list.innerHTML = rows.join('');
  // new tips also light the board in gold
  if (recent?.[0]) pushLine(`TIP ${units(recent[0].amount, recent[0].token?.decimals ?? 18)} ${recent[0].token?.symbol || 'ETH'}`, 'tip');
}

// ---------- hero 3D: lazy, after load + idle, only when visible, motion allowed, capable device ----------
const stage = document.querySelector('.hero-stage');
function canGL() {
  if (!matchMedia('(prefers-reduced-motion: no-preference)').matches) return false;
  if ((navigator.deviceMemory || 8) <= 2 || navigator.connection?.saveData) return false;
  if (new URLSearchParams(location.search).has('poster')) return false;
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
function startGL() {
  if (!canGL()) return;
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return; io.disconnect();
    import('../scene/marquee.js').then((m) => m.start(stage.querySelector('.stage-gl'), feed, stage)).catch(() => {});
  });
  io.observe(stage);
}
const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
// phones: the (animated) poster until the first touch/scroll keeps the first load light; desktop: after load + idle
const small = matchMedia('(max-width: 768px)').matches;
function arm() {
  if (!small) return idle(startGL);
  let done = false; const go = () => { if (done) return; done = true; idle(startGL); };
  ['pointerdown', 'scroll', 'touchstart'].forEach((t) => addEventListener(t, go, { passive: true, once: true }));
}
if (new URLSearchParams(location.search).has('render')) { feed.fixed = new URLSearchParams(location.search).get('render') || 'ON AIR · NPX PEEKMARQUEE'; document.documentElement.classList.add('render'); }
if (document.readyState === 'complete') arm(); else addEventListener('load', arm, { once: true });
