import { boot, getJSON, loadDeployments, loadToken, esc, eth, num, short, utc } from './core.js';
import { streamIdHash, minTip } from './tip.js';

boot();
const rio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); } }));
document.querySelectorAll('[data-reveal]').forEach((el) => rio.observe(el));

const fmtTok = (amount, tok) => {
  const d = Number(tok?.decimals ?? 18); const sym = tok?.symbol || 'ETH';
  try { const a = BigInt(amount); const w = a / 10n ** BigInt(d); const f = (a % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, d === 18 ? 5 : 2).replace(/0+$/, ''); return `${f ? `${w}.${f}` : w} ${sym}`; } catch { return `? ${sym}`; }
};
async function rpc(d, method, params) {
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 5000);
  const r = await fetch(d.rpcUrl, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

(async () => {
  const [d, tok] = await Promise.all([loadDeployments(), loadToken()]);
  const team = new Set([...(tok.team_wallets || []), ...d.teamWallets].map((w) => (w.address || w).toLowerCase()));
  const ex = (p, v, txt) => `<a href="${d.explorer}/${p}/${esc(v)}" rel="noopener" target="_blank">${esc(txt || v)}</a>`;

  // ---- contract card (live reads) ----
  const kv = document.querySelector('[data-contract-kv]');
  const rows = [
    [esc(d.contract || 'TipJar'), d.address ? ex('address', d.address) : 'none yet'],
    ['Chain', `${esc(d.name)} · ${d.chainId}`],
    ['Deploy tx', d.deployTx ? ex('tx', d.deployTx, short(d.deployTx, 8)) : '–'],
    ['Deploy block', d.deployBlock ? ex('block', d.deployBlock, num(d.deployBlock)) : '–'],
    ['Source', d.address ? `${d.verified.sourcify ? `<a href="https://sourcify.dev/server/v2/contract/${d.chainId}/${esc(d.address)}" rel="noopener" target="_blank">Sourcify (exact match)</a>` : 'not verified yet'} · ${ex('address', d.address, d.verified.blockscout ? 'Blockscout (verified)' : 'Blockscout explorer')}` : '–'],
    ['MIN_TIP', '<span data-min>…</span> <i class="src">live eth_call</i>'],
    ...d.retired.map((r) => ['Retired', `v1 retired (ETH-only) · ${ex('address', r.address, short(r.address, 6))} · holds <span data-rbal="${esc(r.address)}">…</span> ETH`]),
  ];
  kv.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`).join('');
  minTip(d).then((w) => { kv.querySelector('[data-min]').textContent = `${eth(w, 6)} ETH`; });
  kv.querySelectorAll('[data-rbal]').forEach((el) => rpc(d, 'eth_getBalance', [el.dataset.rbal, 'latest']).then((w) => { el.textContent = eth(BigInt(w), 6); }).catch(() => { el.textContent = '?'; }));
  const bal = document.querySelector('[data-balance]');
  if (!d.address) bal.textContent = '–';
  else rpc(d, 'eth_getBalance', [d.address, 'latest']).then((w) => { bal.textContent = eth(BigInt(w), 6); document.querySelector('[data-balance-src]').innerHTML = `live eth_getBalance · ${ex('address', d.address, 'check')}`; })
    .catch(() => { bal.textContent = '?'; document.querySelector('[data-balance-src]').textContent = 'RPC unavailable right now'; });

  // ---- relay stats ----
  const s = await getJSON('/api/stats');
  const st = s.ok ? s.body : null;
  document.querySelector('[data-relay-kv]').innerHTML = st ? [
    ['Streams total', num(st.streamsTotal)], ['Live now', num(st.streamsLive)], ['Hours streamed', num(st.hoursStreamed)],
    ['Secrets hidden on device', num(st.secretsHidden)], ['Tool calls', num(st.toolCalls)],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`).join('') : '<div><dt>relay</dt><dd>unavailable right now</dd></div>';

  // ---- tips ----
  const top = await getJSON('/api/tips/top');
  const t = st?.tips;
  const total = document.querySelector('[data-proof-total]');
  const tb = top.ok && !top.body?.unavailable ? top.body : null;
  if (!t || t.unavailable || !tb) total.innerHTML = `tips unavailable right now${t?.lastGoodAt ? ` <span class="muted small">(last good ${utc(t.lastGoodAt)})</span>` : ''}`;
  else {
    // counted totals per token = sum of per-stream totals (tips sent to the registered stream wallet)
    const sums = new Map();
    for (const r of tb.top || []) {
      const per = r.totals ? Object.entries(r.totals).map(([sym, v]) => [sym, v]) : [['ETH', { amount: r.totalWei, decimals: 18, count: r.count }]];
      for (const [sym, v] of per) { const c = sums.get(sym) || { amount: 0n, count: 0, decimals: v.decimals ?? 18 }; c.amount += BigInt(v.amount || 0); c.count += Number(v.count || 0); sums.set(sym, c); }
    }
    const gross = t.tokens ? Object.entries(t.tokens).map(([sym, v]) => fmtTok(v.amount ?? v.totalWei ?? 0, { symbol: sym, decimals: v.decimals })).join(' · ') : `${eth(t.totalWei || 0)} ETH`;
    const counted = [...sums].map(([sym, v]) => `<b class="gold">${fmtTok(v.amount, { symbol: sym, decimals: v.decimals })}</b> across ${num(v.count)} tips`).join(' · ');
    total.innerHTML = (counted || 'none yet') + ` <span class="muted small">· counted</span><br><span class="small muted">gross on-chain: ${gross} · block ${num(t.asOfBlock || tb.asOfBlock)}</span>`;
  }
  const body = document.querySelector('[data-proof-tips]');
  const recent = tb ? (tb.recent || []) : null;
  if (!recent) body.innerHTML = '<tr><td colspan="6">tips unavailable right now</td></tr>';
  else if (!recent.length) body.innerHTML = '<tr><td colspan="6" class="muted">none yet</td></tr>';
  else body.innerHTML = recent.slice(0, 50).map((x) => `<tr><td>${x.t ? utc(x.t) : `block ${num(x.block)}`}</td><td class="mono">${x.id ? `<a href="/s/${esc(x.id)}">${esc(x.id)}</a>` : esc(short(x.streamId, 6))}</td><td class="gold">${fmtTok(x.amount, x.token)}</td><td class="mono">${esc(short(x.from))}</td><td>${x.counted ? '<span class="chip lit">counted</span>' : ''}${x.team || team.has(String(x.from).toLowerCase()) ? ' <span class="chip gold">team</span>' : ''}</td><td class="mono">${ex('tx', x.txHash, short(x.txHash, 6))}</td></tr>`).join('');

  // ---- verify ----
  fetch('https://registry.npmjs.org/peekmarquee/latest').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.version) document.querySelector('[data-npm-ver]').textContent = `v${j.version}`; }).catch(() => {});
  if (tok.repo_url && /^https:\/\/github\.com\//.test(tok.repo_url)) { const el = document.querySelector('[data-repo]'); el.innerHTML = `<a href="${esc(tok.repo_url)}" rel="noopener" target="_blank">${esc(tok.repo_url.replace('https://', ''))}</a>`; el.hidden = false; }
  { const j = tok.tests; // optional {cli:n, server:n, contracts:n, asOf} written by the maintainers from real test runs
    const parts = j ? Object.entries(j).filter(([k, v]) => k !== 'asOf' && Number.isFinite(Number(v))).map(([k, v]) => `${k} ${v}`) : [];
    if (parts.length) { const el = document.querySelector('[data-tests]'); el.textContent = `tests passing: ${parts.join(' · ')}${j.asOf ? ` (${j.asOf})` : ''}`; el.hidden = false; } }

  // ---- team wallets ----
  const ws = [...(tok.team_wallets || []), ...d.teamWallets.map((w) => ({ label: 'team', ...w }))];
  const seen = new Set();
  document.querySelector('[data-team]').innerHTML = ws.filter((w) => w?.address && !seen.has(w.address.toLowerCase()) && seen.add(w.address.toLowerCase()))
    .map((w) => `<p><span class="muted">${esc(w.label || 'team')}</span><br>${ex('address', w.address)}</p>`).join('') || 'none yet';

  // ---- id → bytes32 ----
  const ids = new Set();
  const [l, r] = await Promise.all([getJSON('/api/live'), getJSON('/api/recent')]);
  for (const x of [...(l.body || []), ...(r.body || []), ...((tb && tb.top) || []), ...((recent || []))]) if (x?.id) ids.add(x.id);
  document.querySelector('[data-proof-ids]').innerHTML = [...ids].map((id) => `<tr><td class="mono"><a href="/s/${esc(id)}">${esc(id)}</a></td><td class="mono wrap">${streamIdHash(id)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">none yet</td></tr>';
})();
