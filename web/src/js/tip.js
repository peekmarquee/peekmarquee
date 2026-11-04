// Tip modal: ETH via tip(), USDG / $MARQ via exact approve → tipToken(). No wallet kit.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { loadDeployments, loadToken, esc, eth, getJSON, short } from './core.js';
import { W, onWallet, pickerHTML, wirePicker, switchChain, tokenList, balanceOf, fmtUnits, refreshBalances, accountHTML } from './wallet.js';

const SEL_TIP = '52c7bf27';      // tip(bytes32,address)
const SEL_TIPTOKEN = '418b23d7'; // tipToken(bytes32,address,address,uint256)
const SEL_APPROVE = '095ea7b3';  // approve(address,uint256)
const SEL_ALLOW = 'dd62ed3e';    // allowance(address,address)
const SEL_MIN = 'bba042e6';      // MIN_TIP()
const FALLBACK_MIN = 10n ** 13n; // 0.00001 ETH
const pad = (hex) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
export const streamIdHash = (id) => '0x' + bytesToHex(keccak_256(new TextEncoder().encode(id)));
export const calldata = (id, wallet) => '0x' + SEL_TIP + streamIdHash(id).slice(2) + pad(wallet);
const tokenCalldata = (id, wallet, token, amount) => '0x' + SEL_TIPTOKEN + streamIdHash(id).slice(2) + pad(wallet) + pad(token) + u256(amount);

let minP;
export function minTip(d) {
  return (minP ||= (async () => {
    if (!d.address) return FALLBACK_MIN;
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(d.rpcUrl, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: d.address, data: '0x' + SEL_MIN }, 'latest'] }) });
      const j = await r.json();
      if (j.result && j.result !== '0x') return BigInt(j.result);
    } catch {}
    return FALLBACK_MIN;
  })());
}
export function toUnits(s, dec = 18) {
  const m = String(s).trim().match(new RegExp(`^(\\d*)(?:\\.(\\d{0,${dec}}))?$`)); if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(dec) + BigInt((m[2] || '').padEnd(dec, '0') || '0');
}
export const toWei = (s) => toUnits(s, 18);
const PRESETS = { ETH: ['0.001', '0.005', '0.02'], USDG: ['1', '5', '20'], MARQ: [] };

async function waitReceipt(p, hash, out, label) {
  for (let i = 0; i < 90; i++) {
    try { const r = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] }); if (r) return r.status === '0x1'; } catch {}
    out.textContent = `${label} · waiting for confirmation… ${i * 2}s`;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

export async function openTip(_host, meta) {
  const [d, t, toks] = await Promise.all([loadDeployments(), loadToken(), tokenList()]);
  const min = await minTip(d);
  document.querySelector('.tipm')?.remove();
  const m = document.createElement('div'); m.className = 'tipm'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Tip');
  const claim = t.launched ? 'Tip in ETH, USDG or $MARQ. Tips go straight to the streamer; the contract holds nothing.' : "Tips go straight to the streamer's wallet through a tiny contract that holds nothing.";
  m.innerHTML = `<div class="tipm-card">
    <button class="x" type="button" data-close aria-label="Close">×</button>
    <h2>Tip</h2>
    <p class="small muted">${esc(claim)}</p>
    <p class="mono small">to <a href="${d.explorer}/address/${esc(meta.wallet)}" rel="noopener" target="_blank">${esc(short(meta.wallet, 6))}</a> · ${esc(d.name)}</p>
    <div class="ttabs" role="tablist">${toks.map((k, i) => `<button type="button" role="tab" class="ttab${i === 0 ? ' on' : ''}" data-tok="${k.symbol}" ${k.disabled ? 'disabled' : ''}>${k.symbol === 'MARQ' ? '$MARQ' : k.symbol}${k.disabled ? ' <small>after launch</small>' : ''}</button>`).join('')}</div>
    <div class="amts" data-amts role="group" aria-label="Amount"></div>
    <p class="small muted" data-hint></p>
    <div class="tipm-wallet" data-wallet></div>
    <button class="btn btn-tip" type="button" data-send hidden>Send tip</button>
    <p class="tp-out small" data-out aria-live="polite"></p>
    <details class="raw-d"><summary class="small">No wallet here? Send it yourself</summary>
      <p class="small">Send ETH on Robinhood Chain to <code>tip(...)</code> — or install a wallet</p>
      <dl class="raw"><dt>Contract</dt><dd><code class="wrap">${esc(d.address || '')}</code><button class="copy" type="button" data-copy="${esc(d.address || '')}"><span>Copy</span></button></dd>
      <dt>Calldata</dt><dd><code class="wrap">${esc(calldata(meta.id, meta.wallet))}</code><button class="copy" type="button" data-copy="${esc(calldata(meta.id, meta.wallet))}"><span>Copy</span></button></dd>
      <dt>Chain</dt><dd><code>${d.chainId}</code></dd></dl></details>
    <div class="tp-list" data-tips></div>
  </div>`;
  document.body.appendChild(m);
  const $ = (s) => m.querySelector(s); const out = $('[data-out]');
  let tok = toks[0]; let amt = PRESETS.ETH[0]; let busy = false;
  const close = () => { m.remove(); unsub(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  $('[data-close]').addEventListener('click', close);
  m.addEventListener('click', (e) => { if (e.target === m) close(); });

  function paintAmts() {
    const p = PRESETS[tok.symbol] || [];
    $('[data-amts]').innerHTML = p.map((a, i) => `<button type="button" class="amt${i === 0 ? ' on' : ''}" data-amt="${a}">${a} ${tok.symbol === 'MARQ' ? '$MARQ' : tok.symbol}</button>`).join('') +
      `<label class="amt-custom"><span class="sr">Custom amount</span><input inputmode="decimal" placeholder="custom" data-custom></label>`;
    amt = p[0] || '';
    $('[data-amts]').querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => { amt = b.dataset.amt; $('[data-amts]').querySelectorAll('[data-amt]').forEach((x) => x.classList.toggle('on', x === b)); $('[data-custom]').value = ''; }));
    $('[data-custom]').addEventListener('input', (e) => { amt = e.target.value; $('[data-amts]').querySelectorAll('[data-amt]').forEach((x) => x.classList.remove('on')); });
    $('[data-hint]').textContent = tok.symbol === 'ETH' ? `min ${eth(min, 6)} ETH · one transaction` : `two transactions: approve this exact amount, then tip${tok.symbol === 'MARQ' ? ' · the streamer may receive less if the token takes a fee' : ''}`;
  }
  m.querySelectorAll('[data-tok]').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; tok = toks.find((k) => k.symbol === b.dataset.tok); m.querySelectorAll('[data-tok]').forEach((x) => x.classList.toggle('on', x === b)); paintAmts(); paintWallet(); }));
  paintAmts();

  const selfTip = () => W.account && meta.wallet && W.account.toLowerCase() === meta.wallet.toLowerCase();
  async function paintWallet() {
    const box = $('[data-wallet]'); const send = $('[data-send]');
    if (!d.address) { box.innerHTML = '<p class="warn small">tips unavailable right now</p>'; send.hidden = true; return; }
    if (!W.account) { box.innerHTML = `<p class="small">Connect wallet</p>${pickerHTML()}`; wirePicker(box); send.hidden = true; return; }
    box.innerHTML = await accountHTML();
    box.querySelector('[data-switch]')?.addEventListener('click', () => switchChain().catch(() => { out.textContent = 'Switch failed.'; }));
    send.hidden = false;
    send.disabled = busy || (tok.symbol !== 'ETH' && selfTip());
    if (tok.symbol !== 'ETH' && selfTip()) out.textContent = 'Token tips to your own wallet are not possible.';
    else if (!busy && /own wallet/.test(out.textContent)) out.textContent = '';
  }
  const unsub = onWallet(() => paintWallet());

  $('[data-send]').addEventListener('click', async () => {
    if (busy) return;
    const p = W.entry?.provider; if (!p || !W.account) return;
    const units = toUnits(amt, tok.decimals);
    if (units == null || units <= 0n) { out.textContent = 'Enter an amount.'; return; }
    if (tok.symbol === 'ETH' && units < min) { out.textContent = `min ${eth(min, 6)} ETH`; return; }
    busy = true; paintWallet();
    try {
      if (W.chainId !== d.chainId) { out.textContent = 'Switching to Robinhood Chain…'; await switchChain(); }
      const from = W.account;
      const bal = await balanceOf(tok, from).catch(() => null);
      if (bal != null && bal < units) throw new Error(`Not enough ${tok.symbol} (balance ${fmtUnits(bal, tok.decimals)}).`);
      let hash;
      if (!tok.address) {
        out.textContent = 'Confirm in your wallet…';
        hash = await p.request({ method: 'eth_sendTransaction', params: [{ from, to: d.address, value: '0x' + units.toString(16), data: calldata(meta.id, meta.wallet) }] });
      } else {
        // step 1/2: exact approve (never unlimited) when the allowance is short
        const allowance = BigInt((await p.request({ method: 'eth_call', params: [{ to: tok.address, data: '0x' + SEL_ALLOW + pad(from) + pad(d.address) }, 'latest'] })) || 0);
        if (allowance < units) {
          out.textContent = `Step 1/2 · approve ${amt} ${tok.symbol} — confirm in your wallet…`;
          const ah = await p.request({ method: 'eth_sendTransaction', params: [{ from, to: tok.address, data: '0x' + SEL_APPROVE + pad(d.address) + u256(units) }] });
          if (!(await waitReceipt(p, ah, out, 'Step 1/2 · approve'))) throw new Error('Approve failed.');
        }
        // simulate before sending (review S2)
        const data = tokenCalldata(meta.id, meta.wallet, tok.address, units);
        try { await p.request({ method: 'eth_call', params: [{ from, to: d.address, data }, 'latest'] }); }
        catch { throw new Error(tok.symbol === 'USDG' ? 'USDG transfer blocked for this wallet.' : 'Token transfer failed.'); }
        out.textContent = 'Step 2/2 · tip — confirm in your wallet…';
        hash = await p.request({ method: 'eth_sendTransaction', params: [{ from, to: d.address, data }] });
      }
      out.innerHTML = `Sent: <a href="${d.explorer}/tx/${esc(hash)}" rel="noopener" target="_blank">${esc(short(hash, 6))}</a> on Blockscout`;
      waitReceipt(p, hash, { set textContent(v) {} }, '').then((ok) => { if (!ok) out.innerHTML += ' · failed on-chain'; refreshBalances(); });
      let n = 0; const poll = setInterval(() => { refreshTips(m, meta.id, d); if (++n > 8 || !m.isConnected) clearInterval(poll); }, 8000);
    } catch (e) {
      out.textContent = e?.code === 4001 ? 'Cancelled.' : String(e?.message || e).slice(0, 160);
    } finally { busy = false; paintWallet(); }
  });
  refreshTips(m, meta.id, d);
  $('[data-close]').focus();
}

async function refreshTips(host, id, d) {
  const el = host.querySelector('[data-tips]'); if (!el) return;
  const r = await getJSON(`/api/tips?stream=${encodeURIComponent(id)}`);
  if (!r.ok || !r.body || r.body.unavailable) { el.innerHTML = '<p class="small muted">tips unavailable right now</p>'; return; }
  const t = r.body;
  const tot = t.totals ? Object.entries(t.totals).map(([s, v]) => `<b class="gold">${fmtUnits(v.amount || 0, v.decimals ?? 18)} ${s === 'MARQ' ? '$MARQ' : s}</b> · ${v.count || 0}`).join(' · ') : `<b class="gold">${eth(t.totalWei || '0')} ETH</b> · ${t.count || 0}`;
  el.innerHTML = `<p class="small">${tot}</p>` + (t.tips || []).slice(0, 5).map((x) => `<p class="mono small"><a href="${d.explorer}/tx/${esc(x.txHash)}" rel="noopener" target="_blank">${fmtUnits(x.amount, x.token?.decimals ?? 18)} ${esc(x.token?.symbol || 'ETH')}</a> from ${esc(short(x.from))}</p>`).join('');
}
