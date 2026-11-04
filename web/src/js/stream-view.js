// The viewer for /s/<id>; also used compact on the landing embed. No input fields, no channel back to the streamer.
import { getJSON, sseUrl, apiUrl, esc, utc, dur, fmtKB, num, short, toast } from './core.js';
import { loadDeployments } from './core.js';
let TX = 'https://robinhoodchain.blockscout.com/tx/';
loadDeployments().then((d) => { TX = `${d.explorer}/tx/`; });

const MAX_DOM = 1200;            // DOM window (≤5,000 nodes total incl. children)
const TYPES = ['hello', 'status', 'prompt', 'text', 'tool_call', 'tool_result', 'edit', 'end'];

// ---------- text helpers ----------
const RED = /\[redacted:([a-z_-]+)\]/g;
const HID = /\[(file hidden: [^\]\n]{1,120}|edit hidden|image)\]/g;
export const chipify = (html) => html.replace(RED, '<span class="chip lit" title="hidden before it left the machine">[redacted:$1]</span>').replace(HID, '<span class="chip">[$1]</span>');
export const redClasses = (s) => [...String(s || '').matchAll(RED)].map((m) => m[1]);
function md(s) {
  const parts = String(s).split(/```[^\n]*\n?/);
  return parts.map((p, i) => (i % 2 ? `<pre class="code"><code>${chipify(esc(p.replace(/\n$/, '')))}</code></pre>`
    : `<p>${chipify(esc(p.trim()))
      .replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`)).join('').replace(/<p><\/p>/g, '');
}
const TOOL_CLS = (t) => {
  const k = String(t || '').toLowerCase();
  if (k.startsWith('mcp')) return 'mcp';
  return ({ bash: 'bash', read: 'read', write: 'edit', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', grep: 'find', glob: 'find', agent: 'agent', task: 'agent', webfetch: 'web', websearch: 'web' })[k] || 'tool';
};
const toolLabel = (t) => (String(t || 'tool').startsWith('mcp__') ? 'MCP' : String(t || 'tool').toUpperCase().slice(0, 10));

// one-line summary of an event (landing mini timeline + marquee)
export function lineOf(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'tool_call': return { kind: 'tool', tool: toolLabel(d.tool), text: d.summary || '', cls: TOOL_CLS(d.tool) };
    case 'edit': return { kind: 'edit', tool: 'EDIT', text: `${d.path || ''} +${d.added | 0} -${d.removed | 0}`, cls: 'edit' };
    case 'tool_result': if (d.hidden) return { kind: 'red', tool: 'HIDDEN', text: d.hidden, cls: 'red' };
      { const c = redClasses(d.text); return c.length ? { kind: 'red', tool: 'REDACTED', text: c[0], cls: 'red' } : null; }
    case 'prompt': return { kind: 'prompt', tool: 'PROMPT', text: d.text || '', cls: 'prompt' };
    case 'text': { const c = redClasses(d.text); return c.length ? { kind: 'red', tool: 'REDACTED', text: c[0], cls: 'red' } : { kind: 'text', tool: 'SAYS', text: d.text || '', cls: 'text' }; }
    case 'status': return d.state === 'thinking' ? { kind: 'status', tool: 'THINKING', text: '', cls: 'status' } : null;
    case 'end': return { kind: 'end', tool: 'END', text: '', cls: 'status' };
    default: return null;
  }
}

// ---------- component ----------
export async function mountViewer(root, { id, compact = false, manageKey = null, label = null, onEvent = null, onMeta = null } = {}) {
  root.classList.add('sv'); if (compact) root.classList.add('sv-compact');
  const r = await getJSON(`/api/s/${encodeURIComponent(id)}`);
  if (!r.ok) {
    if (r.status === 410) return gone(root, r.body?.msg || 'This stream has expired.');
    if (r.status === 404) return gone(root, 'Not found.');
    root.innerHTML = `<div class="sv-empty"><p>Can't reach the relay right now.</p></div>`;
    return null;
  }
  let meta = r.body;
  const state = { meta, items: [], bySeq: new Map(), calls: new Map(), lastSeq: 0, connected: false, lastFrame: Date.now(), status: null, follow: true, red: meta.red || 0, startSeq: null };
  root.innerHTML = `
  <div class="sv-head">
    <div class="sv-title">
      <span class="sv-state" data-state></span>
      <h2 class="sv-name">${compact ? `<a href="/s/${esc(id)}">${esc(meta.title || 'Untitled session')}</a>` : esc(meta.title || 'Untitled session')}</h2>
      <span class="sv-agent">${esc(meta.agent === 'claude' ? 'Claude Code' : meta.agent || '')}</span>
    </div>
    <div class="sv-facts">
      <span data-viewers></span>
      <span class="sv-red" data-red></span>
      ${meta.wallet ? '<button class="btn btn-tip sm" type="button" data-tip>Tip</button>' : ''}
      ${compact ? `<a class="btn btn-ghost sm" href="/s/${esc(id)}">Open</a>` : '<button class="btn btn-ghost sm" type="button" data-report>Report a stream</button>'}
    </div>
  </div>
  <div class="sv-review" data-review hidden>under review</div>
  <div class="sv-tip" data-tip-host hidden></div>
  <div class="sv-report" data-report-host hidden></div>
  ${manageKey ? `<div class="sv-manage"><p class="small">Holder perks switch on after launch; until then everything is the same for everyone.</p><button class="btn btn-danger sm" type="button" data-delete>Delete stream + replay now</button></div>` : ''}
  ${compact ? '' : '<div class="sv-tabs" role="tablist"><button type="button" role="tab" class="on" data-tab="session">Session</button><button type="button" role="tab" data-tab="chat">Chat <span data-chat-count></span></button></div>'}
  <div class="sv-body${compact ? '' : ' with-chat'}" data-body data-show="session">
    <div class="sv-main">
      <div class="sv-scroll" data-scroll tabindex="0" aria-label="Session timeline"><ol class="sv-tl" data-tl aria-live="off"></ol><div class="sv-empty-tl" data-empty>Waiting for the next event…</div></div>
      <button class="sv-jump" type="button" data-jump hidden>jump to live</button>
    </div>
    ${compact ? '' : `<aside class="sv-chat" aria-label="Chat">
      <div class="chat-h"><b>Chat</b><span class="small muted" data-chat-state></span></div>
      ${manageKey ? '<div class="chat-mod small"><label><input type="checkbox" data-chat-on checked> chat on</label><label>slow mode <select data-chat-slow><option value="0">off</option><option value="5">5s</option><option value="15">15s</option><option value="30">30s</option><option value="60">60s</option><option value="300">5m</option></select></label></div>' : ''}
      <ol class="chat-list" data-chat-list aria-live="polite"></ol>
      <form class="chat-f" data-chat-form autocomplete="off">
        <input name="nick" maxlength="24" placeholder="nick" aria-label="Nick" required>
        <input name="text" maxlength="280" placeholder="Say something" aria-label="Message" required>
        <button class="btn btn-live sm" type="submit">Send</button>
      </form>
      <p class="chat-out small" data-chat-out aria-live="polite"></p>
      <p class="chat-note">Live chat for viewers. Chat never reaches the streamer's machine. Addresses and links in chat are removed.</p>
    </aside>`}
  </div>
  <div class="sv-bar">
    <span class="sv-status" data-status></span>
    ${compact ? '' : '<input class="sv-scrub" type="range" min="0" max="1000" value="1000" data-scrub hidden aria-label="Replay position">'}
    <span class="sv-until" data-until></span>
    <a class="sv-dl" href="#" data-dl hidden download>download replay</a>
  </div>`;
  const $ = (s) => root.querySelector(s);
  const tl = $('[data-tl]'); const scroller = $('[data-scroll]');

  // ---------- header ----------
  function paintHead() {
    const m = state.meta;
    const st = $('[data-state]');
    const conn = state.connected;
    let mode;
    if (m.endedAt) mode = 'replay';
    else if (!conn && state.everConnected) mode = 'reconnecting';
    else if (m.live === false) mode = 'paused';
    else if (Date.now() - state.lastFrame > 90000 && !m.endedAt) mode = 'paused';
    else mode = 'live';
    root.dataset.mode = mode;
    if (mode === 'live') st.innerHTML = `<span class="dot"></span>LIVE <span class="mono" data-clock>${dur(Date.now() - (m.startedAt || Date.now()))}</span>`;
    else if (mode === 'replay') st.textContent = label || `replay · ended ${utc(m.endedAt, false)}`;
    else st.textContent = mode === 'reconnecting' ? 'reconnecting…' : 'paused';
    $('[data-viewers]').textContent = `${num(m.viewers ?? 0)} watching`;
    const red = Math.max(state.red, m.red || 0);
    $('[data-red]').innerHTML = `<b>${num(red)}</b> secrets hidden on device${m.redServer > 0 ? ` · ${num(m.redServer)} hidden by relay` : ''}`;
    $('[data-until]').textContent = m.replay !== false && m.replayUntil ? `replay until ${utc(m.replayUntil)}` : '';
    const dl = $('[data-dl]'); if (m.replay !== false && !m.underReview && !compact) { dl.href = apiUrl(`/api/s/${encodeURIComponent(id)}/replay.jsonl`); dl.hidden = false; } else dl.hidden = true;
    $('[data-review]').hidden = !m.underReview;
    const sc = $('[data-scrub]'); if (sc) sc.hidden = !m.endedAt;
    onMeta?.(m, mode);
  }
  const clock = setInterval(() => { if (!root.isConnected) return clearInterval(clock); const c = root.querySelector('[data-clock]'); if (c) c.textContent = dur(Date.now() - (state.meta.startedAt || Date.now())); if (Date.now() - state.lastFrame > 10000) paintHead(); }, 1000);

  // ---------- timeline ----------
  function node(ev) {
    const d = ev.data || {};
    const li = document.createElement('li');
    li.dataset.seq = ev.seq;
    const time = `<time class="t">${utc(ev.t, false).replace(' UTC', '')}</time>`;
    switch (ev.type) {
      case 'prompt': li.className = 'ev ev-prompt'; li.innerHTML = `${time}<div class="who">prompt</div><div class="body">${md(d.text || '')}</div>`; break;
      case 'text': li.className = 'ev ev-text'; li.innerHTML = `${time}<div class="body md">${md(d.text || '')}</div>`; break;
      case 'tool_call': {
        li.className = `ev ev-tool tc-${TOOL_CLS(d.tool)}`;
        const args = d.args && Object.keys(d.args).length ? JSON.stringify(d.args, null, 2) : '';
        li.innerHTML = `${time}<details class="call"><summary><span class="tool">${esc(toolLabel(d.tool))}</span><span class="sum">${chipify(esc(d.summary || ''))}</span></summary>${args ? `<pre class="args">${chipify(esc(args))}</pre>` : ''}</details><div class="out" data-out></div>`;
        if (d.id) state.calls.set(d.id, li);
        break;
      }
      case 'tool_result': {
        const html = resultHTML(d);
        const host = d.forId && state.calls.get(d.forId);
        if (host && host.isConnected) { host.querySelector('[data-out]').innerHTML = html; return null; }
        li.className = 'ev ev-result'; li.innerHTML = `${time}<div class="out">${html}</div>`; break;
      }
      case 'edit': {
        li.className = 'ev ev-edit';
        const lines = String(d.snippet || '').split('\n').map((l) => `<span class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${chipify(esc(l))}</span>`).join('\n');
        li.innerHTML = `${time}<div class="edit-h"><span class="tool">EDIT</span><span class="sum">${esc(d.path || '')}</span><span class="add">+${d.added | 0}</span><span class="del">-${d.removed | 0}</span></div>${d.snippet ? `<pre class="diff">${lines}</pre>` : ''}`;
        break;
      }
      case 'end': li.className = 'ev ev-end'; li.textContent = `ended · ${utc(ev.t)}`; break;
      case 'hello': li.className = 'ev ev-end'; li.textContent = `started · ${utc(ev.t)}`; break;
      default: return null;
    }
    return li;
  }
  function resultHTML(d) {
    if (d.hidden) return `<span class="chip lit">${esc(d.text || `[${d.hidden}]`)}</span>`;
    const trunc = d.truncated ? `<span class="badge">truncated · ${fmtKB(d.bytes || 0)}</span>` : '';
    const txt = String(d.text || '');
    return `<pre class="term${d.isError ? ' err' : ''}">${chipify(esc(txt)) || '<span class="muted">(no output)</span>'}</pre>${trunc}`;
  }
  let pending = []; let raf = 0;
  function flush() {
    raf = 0; const frag = document.createDocumentFragment();
    for (const ev of pending) { const n = node(ev); if (n) frag.appendChild(n); }
    pending = [];
    if (frag.childNodes.length) { tl.appendChild(frag); $('[data-empty]').hidden = true; }
    while (tl.childElementCount > MAX_DOM) {
      const f = tl.firstElementChild; f.remove();
      if (!tl.querySelector('.ev-trim')) { const t = document.createElement('li'); t.className = 'ev ev-trim'; t.textContent = 'earlier events: download replay'; tl.prepend(t); }
    }
    if (state.follow) scroller.scrollTop = scroller.scrollHeight;
  }
  scroller.addEventListener('scroll', () => {
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    state.follow = atEnd; $('[data-jump]').hidden = atEnd;
  }, { passive: true });
  $('[data-jump]').addEventListener('click', () => { state.follow = true; scroller.scrollTop = scroller.scrollHeight; $('[data-jump]').hidden = true; });

  function setStatus(s) {
    state.status = s;
    const el = $('[data-status]');
    el.className = `sv-status st-${s || 'none'}`;
    el.textContent = s ? ({ thinking: 'thinking…', tool: 'running a tool', idle: 'idle', resumed: 'resumed', ended: 'ended' }[s] || s) : '';
  }

  // ---------- chat (viewers only; never sent to the streamer's machine) ----------
  const chat = {
    ids: new Set(), unread: 0, on: state.meta.chatOn !== false, slow: state.meta.chatSlowSec || 0, until: 0,
    list: () => root.querySelector('[data-chat-list]'),
    badge() { const c = root.querySelector('[data-chat-count]'); if (c) c.textContent = chat.unread ? `· ${chat.unread}` : ''; },
    msg(m) {
      const li = document.createElement('li'); li.dataset.id = m.id;
      li.className = m.system ? 'cm sys' : 'cm';
      const time = `<time>${utc(m.t, false).replace(' UTC', '')}</time>`;
      if (m.system) li.innerHTML = `${time}<span class="cm-t">${esc(m.text)}</span>${m.tx ? ` <a href="${TX}${esc(m.tx)}" rel="noopener" target="_blank">tx</a>` : ''}`;
      else li.innerHTML = `${time}<b class="cm-n">${esc(m.nick || 'anon')}</b><span class="cm-t">${esc(m.text)}</span><span class="cm-a">${manageKey ? '<button type="button" data-del title="Delete">delete</button>' : ''}<button type="button" data-rep title="Report this message">report</button></span>`;
      li.querySelector('[data-rep]')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r = await fetch(apiUrl(`/api/s/${encodeURIComponent(id)}/chat/${encodeURIComponent(m.id)}/report`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
        e.target.textContent = r && r.ok ? 'reported' : 'failed';
      });
      li.querySelector('[data-del]')?.addEventListener('click', async () => {
        const r = await fetch(apiUrl(`/api/s/${encodeURIComponent(id)}/chat/${encodeURIComponent(m.id)}`), { method: 'DELETE', headers: { 'x-manage-key': manageKey } }).catch(() => null);
        if (r && r.ok) chat.del(m.id); else toast('Delete failed');
      });
      return li;
    },
    add(m) {
      const l = chat.list(); if (!l || !m || m.id == null || chat.ids.has(m.id)) return;
      chat.ids.add(m.id);
      const atEnd = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
      l.appendChild(chat.msg(m));
      while (l.childElementCount > 300) l.firstElementChild.remove();
      if (atEnd) l.scrollTop = l.scrollHeight;
      if ($('[data-body]')?.dataset.show !== 'chat') { chat.unread++; chat.badge(); }
      chat.empty();
    },
    del(mid) { chat.list()?.querySelector(`[data-id="${CSS.escape(String(mid))}"]`)?.remove(); chat.empty(); },
    empty() { const l = chat.list(); if (!l) return; l.dataset.empty = l.childElementCount ? '' : 'No messages yet.'; },
    state(on, slow) {
      chat.on = on !== false; chat.slow = slow || 0;
      const st = root.querySelector('[data-chat-state]'); if (!st) return;
      st.textContent = !chat.on ? 'chat is off' : state.meta.endedAt ? 'replay · chat closed' : chat.slow ? `slow mode · ${chat.slow}s` : '';
      const f = root.querySelector('[data-chat-form]');
      const closed = !chat.on || !!state.meta.endedAt;
      f?.querySelectorAll('input,button').forEach((x) => { x.disabled = closed; });
      const onEl = root.querySelector('[data-chat-on]'); if (onEl) onEl.checked = chat.on;
      const sl = root.querySelector('[data-chat-slow]'); if (sl) sl.value = String(chat.slow);
    },
    async load() {
      if (!chat.list()) return;
      const r = await getJSON(`/api/s/${encodeURIComponent(id)}/chat?limit=100`);
      if (r.ok && r.body) { (r.body.messages || []).forEach((m) => chat.add(m)); chat.state(r.body.on, r.body.slowSec); chat.unread = 0; chat.badge(); }
      else chat.state(state.meta.chatOn, state.meta.chatSlowSec);
      chat.empty();
      const f = root.querySelector('[data-chat-form]');
      try { f.nick.value = localStorage.getItem('pm-nick') || ''; } catch {}
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = root.querySelector('[data-chat-out]');
        if (Date.now() < chat.until) { out.textContent = `Slow mode: wait ${Math.ceil((chat.until - Date.now()) / 1000)}s.`; return; }
        const nick = f.nick.value.trim(), text = f.text.value.trim(); if (!nick || !text) return;
        try { localStorage.setItem('pm-nick', nick); } catch {}
        f.querySelector('button').disabled = true;
        const res = await fetch(apiUrl(`/api/s/${encodeURIComponent(id)}/chat`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nick, text }) }).catch(() => null);
        let b = null; try { b = await res?.json(); } catch {}
        f.querySelector('button').disabled = false;
        if (res && res.ok) { f.text.value = ''; out.textContent = ''; if (b?.id != null) chat.add(b); if (chat.slow) chat.until = Date.now() + chat.slow * 1000; return; }
        const code = b?.error;
        out.textContent = !res ? 'Not sent, try again.'
          : res.status === 429 ? (code === 'slow_mode' ? `Slow mode: wait ${b?.retryAfterSec || chat.slow}s.` : `Too many messages, wait ${b?.retryAfterSec || 3}s.`)
          : code === 'bad_nick' ? 'Nick: 1–24 characters.' : code === 'bad_text' || code === 'bad_message' ? 'Message: 1–280 characters, plain text.'
          : code === 'chat_off' ? 'Chat is off for this stream.' : code === 'chat_closed' ? 'Chat is closed (stream ended).' : 'Not sent, try again.';
        if (res.status === 429 && b?.retryAfterSec) chat.until = Date.now() + b.retryAfterSec * 1000;
      });
      const post = async (body) => {
        const r2 = await fetch(apiUrl(`/api/s/${encodeURIComponent(id)}/chat/settings`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-manage-key': manageKey }, body: JSON.stringify(body) }).catch(() => null);
        if (r2 && r2.ok) { const j = await r2.json(); chat.state(j.on, j.slowSec); } else toast('Not saved');
      };
      root.querySelector('[data-chat-on]')?.addEventListener('change', (e) => post({ on: e.target.checked }));
      root.querySelector('[data-chat-slow]')?.addEventListener('change', (e) => post({ slowSec: Number(e.target.value) }));
    },
  };

  // ---------- SSE ----------
  let es = null;
  function connect(from) {
    es?.close();
    es = new EventSource(sseUrl(id, from));
    es.onopen = () => { state.connected = true; state.everConnected = true; paintHead(); };
    es.onerror = () => { state.connected = false; paintHead(); };
    es.addEventListener('meta', (e) => { try { state.meta = { ...state.meta, ...JSON.parse(e.data) }; state.lastFrame = Date.now(); paintHead(); } catch {} });
    es.addEventListener('viewers', (e) => { try { state.meta.viewers = JSON.parse(e.data).n; paintHead(); } catch {} });
    es.addEventListener('deleted', () => { es.close(); gone(root, 'This stream was deleted.'); });
    for (const t of TYPES) es.addEventListener(t, onWire);
    es.addEventListener('chat', (e) => { try { chat.add(JSON.parse(e.data)); } catch {} });
    es.addEventListener('chat_delete', (e) => { try { chat.del(JSON.parse(e.data).id); } catch {} });
    es.addEventListener('chat_state', (e) => { try { const c = JSON.parse(e.data); chat.state(c.on, c.slowSec); } catch {} });
  }
  function onWire(e) {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.seq != null) { if (state.bySeq.has(ev.seq)) return; state.bySeq.set(ev.seq, 1); state.lastSeq = Math.max(state.lastSeq, ev.seq); }
    state.connected = true; state.lastFrame = Date.now();
    if (typeof ev.red === 'number') state.red = Math.max(state.red, ev.red);
    state.items.push({ seq: ev.seq, t: ev.t });
    if (ev.type === 'status') setStatus(ev.data?.state);
    else if (ev.type === 'end') { setStatus('ended'); state.meta.endedAt = state.meta.endedAt || ev.t; }
    else if (ev.type === 'tool_call') setStatus('tool');
    pending.push(ev); if (!raf) raf = requestAnimationFrame(flush);
    onEvent?.(ev, state);
    paintHead();
  }
  connect();
  paintHead();

  // ---------- scrubber (replay) ----------
  $('[data-scrub]')?.addEventListener('change', (e) => {
    const m = state.meta; if (!m.endedAt || !state.items.length) return;
    const tt = m.startedAt + (m.endedAt - m.startedAt) * (e.target.value / 1000);
    const it = state.items.find((x) => x.t >= tt) || state.items[state.items.length - 1];
    tl.innerHTML = ''; state.bySeq.clear(); state.items = []; state.calls.clear(); state.follow = false;
    connect(it.seq);
    scroller.scrollTop = 0;
  });

  // ---------- tip / report / manage ----------
  $('[data-tip]')?.addEventListener('click', () => import('./tip.js').then((m) => m.openTip(null, state.meta)));
  $('[data-report]')?.addEventListener('click', () => {
    const host = $('[data-report-host]'); host.hidden = !host.hidden; if (host.hidden) return;
    host.innerHTML = `<p class="small">Report a stream</p><div class="amts">${['illegal', 'secret_leaked', 'spam', 'other'].map((x) => `<button type="button" class="amt" data-reason="${x}">${x.replace('_', ' ')}</button>`).join('')}</div><p class="small" data-rout aria-live="polite"></p>`;
    host.querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', async () => {
      host.querySelectorAll('[data-reason]').forEach((x) => (x.disabled = true));
      try {
        const res = await fetch(apiUrl(`/api/s/${encodeURIComponent(id)}/report`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: b.dataset.reason }) });
        host.querySelector('[data-rout]').textContent = res.ok ? "Thanks, we'll look." : res.status === 429 ? 'Too many reports from here, try later.' : 'Report failed, try again.';
      } catch { host.querySelector('[data-rout]').textContent = 'Report failed, try again.'; }
    }));
  });
  $('[data-delete]')?.addEventListener('click', async (e) => {
    if (!confirm('Delete this stream and its replay now?')) return;
    e.target.disabled = true;
    const res = await fetch(apiUrl(`/api/streams/${encodeURIComponent(id)}`), { method: 'DELETE', headers: { 'x-manage-key': manageKey } }).catch(() => null);
    if (res && res.ok) { es?.close(); gone(root, 'This stream was deleted.'); } else { e.target.disabled = false; toast('Delete failed'); }
  });

  // ---------- tabs (mobile) ----------
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('[data-body]').dataset.show = b.dataset.tab;
    if (b.dataset.tab === 'chat') { chat.unread = 0; chat.badge(); }
  }));
  chat.load();
  return { state, close: () => es?.close() };
}

function gone(root, msg) {
  root.innerHTML = `<div class="sv-empty"><h2>${esc(msg)}</h2><p>Start one:</p><div class="cmd"><span class="cmd-prompt" aria-hidden="true">$</span><code>npx peekmarquee</code><button class="copy" type="button" data-copy="npx peekmarquee"><span>Copy</span></button></div></div>`;
  return null;
}
