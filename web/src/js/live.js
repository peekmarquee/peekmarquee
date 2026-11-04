import { boot, getJSON, esc, dur, num, utc } from './core.js';

boot();
const liveEl = document.querySelector('[data-live]');
const recEl = document.querySelector('[data-recent]');
const startOwn = '<div class="cmd"><span class="cmd-prompt" aria-hidden="true">$</span><code>npx peekmarquee</code><button class="copy" type="button" data-copy="npx peekmarquee"><span>Copy</span></button></div>';

const card = (s, replay) => `
<a class="lcard${s.featured ? ' featured' : ''}" href="/s/${esc(s.id)}">
  <span class="lc-state">${replay ? `replay · ended ${utc(s.endedAt)}` : `<span class="dot"></span>LIVE <span class="mono" data-since="${s.startedAt || ''}">${dur(Date.now() - (s.startedAt || Date.now()))}</span>`}</span>
  <h3>${esc(s.title || 'Untitled session')}</h3>
  <span class="lc-meta">${esc(s.agent === 'claude' ? 'Claude Code' : s.agent || '')}${replay ? '' : ` · ${num(s.viewers)} watching`} · ${num(s.toolCalls)} tool calls</span>
  <span class="lc-chips"><span class="chip lit">${num(s.red)} secrets hidden</span>${s.wallet ? '<span class="chip gold">tips on</span>' : ''}${s.featured ? '<span class="chip">featured</span>' : ''}${s.holder ? '<span class="chip">holder</span>' : ''}</span>
</a>`;

async function load() {
  const [l, r] = await Promise.all([getJSON('/api/live'), getJSON('/api/recent')]);
  if (!l.ok) liveEl.innerHTML = `<div class="sv-empty"><p>Can't reach the relay right now.</p></div>`;
  else if (!l.body.length) liveEl.innerHTML = `<div class="sv-empty nostream"><p>No public stream right now. Start one: <code>npx peekmarquee</code></p>${startOwn}</div>`;
  else liveEl.innerHTML = l.body.map((s) => card(s, false)).join('');
  if (r.ok && r.body.length) recEl.innerHTML = r.body.map((s) => card(s, true)).join('');
  else recEl.innerHTML = '<p class="muted">No replays right now.</p>';
}
load();
setInterval(load, 15000);
setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { if (el.dataset.since) el.textContent = dur(Date.now() - Number(el.dataset.since)); }), 1000);
