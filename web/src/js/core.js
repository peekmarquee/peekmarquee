// Shared runtime: API base, fetch helpers, token/deployments, copy, countdown, formatting.
// API base: <meta name="pm-api"> (default same origin). On localhost only: ?api=<url> (remembered) and ?scenario=<name> (dev mock server).
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const qs = new URLSearchParams(location.search);
let base = document.querySelector('meta[name="pm-api"]')?.content || '';
if (isLocal) {
  try { if (qs.has('api')) localStorage.setItem('pm-api', qs.get('api')); base = localStorage.getItem('pm-api') || base; } catch {}
}
base = base.replace(/\/$/, '');
const scenario = isLocal ? qs.get('scenario') : null;
const withScenario = (u) => (scenario ? u + (u.includes('?') ? '&' : '?') + 'scenario=' + encodeURIComponent(scenario) : u);
export const apiUrl = (p) => withScenario(base + p);

export async function getJSON(p, { timeout = 6000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(apiUrl(p), { signal: ctl.signal, headers: { accept: 'application/json' } });
    let body = null; try { body = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body };
  } catch { return { ok: false, status: 0, body: null }; } finally { clearTimeout(t); }
}
export const sseUrl = (id, from) => apiUrl(`/api/s/${encodeURIComponent(id)}/events${from != null ? `?from=${from}` : ''}`);

// static JSON served next to the pages
async function staticJSON(p) {
  try { const r = await fetch(withScenario(p), { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
}
let tokP, depP;
export const loadToken = () => (tokP ||= staticJSON('/token.json').then((t) => t || { address: ZERO, symbol: 'MARQ', launched: false, launch_at: '2026-11-06T15:00:00Z' }));
export const ZERO = '0x0000000000000000000000000000000000000000';
// deployments.json (CONTRACTS): { defaultChainId, chains:{ "4663":{address,deployBlock,deployTx,deployer,explorer,rpcUrl,chainIdHex,verified}}, teamWallets? }
export const loadDeployments = () => (depP ||= staticJSON('/deployments.json').then((d) => {
  const id = String(d?.defaultChainId || 4663);
  const c = d?.chains?.[id] || {};
  const addr = /^0x[0-9a-fA-F]{40}$/.test(c.address || '') ? c.address : null;
  return {
    chainId: Number(id), chainIdHex: c.chainIdHex || '0x1237', name: c.name || 'Robinhood Chain',
    rpcUrl: c.rpcUrl || 'https://robinhood-rpc.publicnode.com', explorer: (c.explorer || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
    address: addr, deployBlock: c.deployBlock ?? null, deployTx: c.deployTx || null, deployer: c.deployer || null,
    verified: c.verified || {}, contract: d?.contract || 'TipJar', tokens: d?.tokens || {}, retired: (c.retired || []).filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r?.address || '')),
    teamWallets: (d?.teamWallets || []).map((w) => (typeof w === 'string' ? { address: w } : w)).filter((w) => w?.address),
  };
}));

// ---------- formatting ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (a, n = 4) => (a && a.length > 2 * n + 4 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a || '');
export const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const utc = (ms, withDate = true) => {
  if (!ms) return '';
  const d = new Date(ms);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${hm} UTC` : `${hm} UTC`;
};
export const dur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
export const fmtKB = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export function eth(wei, dp = 5) {
  try {
    const w = BigInt(wei);
    const whole = w / 10n ** 18n; const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return '?'; }
}
export const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));

// ---------- toast + copy ----------
export function toast(msg) {
  const t = document.querySelector('.toast'); if (!t) return;
  t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1600);
}
async function copyText(v) {
  try { await navigator.clipboard.writeText(v); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = v; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy],[data-copy-ca]'); if (!b) return;
  const v = b.hasAttribute('data-copy-ca') ? b.dataset.value || ZERO : b.dataset.copy;
  if (await copyText(v)) { b.classList.add('done'); toast('Copied'); setTimeout(() => b.classList.remove('done'), 1200); }
});

// ---------- token block (CA + countdown + buy) ----------
export async function initToken() {
  const t = await loadToken();
  const blocks = document.querySelectorAll('[data-token]');
  const ca = /^0x[0-9a-fA-F]{40}$/.test(t.address || '') ? t.address : ZERO;
  const launched = !!t.launched && ca !== ZERO;
  const launchAt = Date.parse(t.launch_at || '2026-11-06T15:00:00Z');
  const buy = t.buy_url || (launched ? `https://ponsfamily.com/token/${ca}` : null);
  for (const b of blocks) {
    b.querySelector('[data-ca]').textContent = launched ? ca : '0x0000…0000';
    b.querySelector('[data-ca]').title = ca;
    b.querySelector('[data-copy-ca]').dataset.value = ca;
    const note = b.querySelector('[data-ca-note]');
    if (launched) { note.hidden = true; b.querySelector('[data-countdown]').hidden = true; b.querySelector('[data-cd-label]').hidden = true; const a = b.querySelector('[data-buy]'); a.href = buy; a.hidden = false; b.classList.add('launched'); }
  }
  document.querySelectorAll('[data-href="buy"]').forEach((a) => { if (launched && buy) { a.href = buy; a.hidden = false; } });
  document.querySelectorAll('[data-tax]').forEach((el) => { el.hidden = !launched; });
  if (launched) return t;
  const tick = () => {
    const left = launchAt - Date.now();
    for (const b of blocks) {
      const cd = b.querySelector('[data-countdown]');
      if (left <= 0) { cd.innerHTML = '<span class="cd-now">Launching now — CA posted here first</span>'; continue; }
      const s = Math.floor(left / 1000);
      cd.querySelector('[data-d]').textContent = Math.floor(s / 86400);
      cd.querySelector('[data-h]').textContent = pad(Math.floor((s % 86400) / 3600));
      cd.querySelector('[data-m]').textContent = pad(Math.floor((s % 3600) / 60));
      cd.querySelector('[data-s]').textContent = pad(s % 60);
    }
    if (left > 0) setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
  return t;
}

// footer/contract links from deployments.json
export async function initChainLinks() {
  const d = await loadDeployments();
  document.querySelectorAll('[data-href="blockscout"]').forEach((a) => { if (d.address) { a.href = `${d.explorer}/address/${d.address}`; a.hidden = false; } });
  document.querySelectorAll('[data-contract-line]').forEach((el) => {
    if (d.address) el.innerHTML = `${esc(d.contract)} <a href="${d.explorer}/address/${d.address}" rel="noopener" target="_blank">${esc(d.address)}</a>${d.verified.blockscout ? ' · verified on Blockscout' : ''}`;
    else el.hidden = true;
  });
  document.querySelectorAll('[data-verify-line]').forEach((el) => {
    if (d.address && d.verified.sourcify) el.innerHTML = `Source verified on Sourcify (exact match): <a href="https://sourcify.dev/server/v2/contract/${d.chainId}/${d.address}" rel="noopener" target="_blank">sourcify.dev</a>.`;
    else el.hidden = true;
  });
  return d;
}

document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('paused', document.hidden));

export function boot() {
  import('./wallet.js').then((m) => m.mountHeader()).catch(() => {});
  initChainLinks();
  if (document.querySelector('[data-token]')) initToken();
  else loadToken().then((t) => { if (t.launched) initToken(); });
}
