// Wallet connection without a wallet kit: EIP-6963 discovery (+ window.ethereum fallback), Robinhood Chain 4663.
// WalletConnect is not wired yet (needs a project id): call registerConnector({info, provider}) with an EIP-1193
// provider (e.g. from @walletconnect/ethereum-provider) and it shows up in the picker like any injected wallet.
import { loadDeployments, loadToken, esc, short, eth, toast, ZERO } from './core.js';

const SEL_BAL = '70a08231'; // balanceOf(address)
const KEY = 'pm-wallet';
const providers = new Map(); // uuid -> {info, provider}
const subs = new Set();
export const W = { entry: null, account: null, chainId: null, balances: {}, ready: false };

const store = { get() { try { return localStorage.getItem(KEY); } catch { return null; } }, set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} } };
const emit = () => subs.forEach((f) => { try { f(W); } catch {} });
export const onWallet = (f) => { subs.add(f); f(W); return () => subs.delete(f); };
const safeIcon = (s) => (typeof s === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(s) ? s : '');

addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail; if (!d?.info?.uuid || !d.provider) return;
  providers.set(d.info.uuid, { info: d.info, provider: d.provider });
  emit(); restore();
});
dispatchEvent(new Event('eip6963:requestProvider'));
export function registerConnector(entry) { if (entry?.info?.uuid && entry.provider) { providers.set(entry.info.uuid, entry); emit(); } }
export function walletList() {
  const list = [...providers.values()];
  if (!list.length && typeof window.ethereum !== 'undefined') list.push({ info: { uuid: 'injected', name: 'Browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum });
  return list;
}

let restored = false;
async function restore() {
  if (restored || W.account) return;
  const want = store.get(); if (!want) return;
  const e = walletList().find((x) => x.info.rdns === want); if (!e) return;
  restored = true;
  try { const acc = await e.provider.request({ method: 'eth_accounts' }); if (acc?.[0]) await attach(e, acc[0]); } catch {}
}
setTimeout(restore, 400);

async function attach(e, account) {
  if (W.entry && W.entry !== e) detach();
  W.entry = e; W.account = account;
  try { W.chainId = parseInt(await e.provider.request({ method: 'eth_chainId' }), 16); } catch { W.chainId = null; }
  store.set(e.info.rdns || e.info.uuid);
  if (!e._wired && e.provider.on) {
    e._wired = true;
    e.provider.on('accountsChanged', (a) => { if (W.entry !== e) return; if (!a?.length) disconnect(); else { W.account = a[0]; refreshBalances(); emit(); } });
    e.provider.on('chainChanged', (c) => { if (W.entry !== e) return; W.chainId = parseInt(c, 16); emit(); });
  }
  emit(); refreshBalances();
}
function detach() { W.entry = null; W.account = null; W.chainId = null; W.balances = {}; }
export async function connect(e) {
  const acc = await e.provider.request({ method: 'eth_requestAccounts' });
  if (!acc?.[0]) throw new Error('No account');
  await attach(e, acc[0]);
  return W;
}
export function disconnect() {
  try { W.entry?.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {}); } catch {}
  detach(); store.set(null); emit();
}
export async function switchChain() {
  const d = await loadDeployments(); const p = W.entry?.provider; if (!p) return;
  try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: d.chainIdHex }] }); }
  catch (e) {
    if (e && (e.code === 4902 || e.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ''))) {
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: d.chainIdHex, chainName: d.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [d.rpcUrl], blockExplorerUrls: [d.explorer] }] });
    } else throw e;
  }
  try { W.chainId = parseInt(await p.request({ method: 'eth_chainId' }), 16); } catch {}
  emit();
}
export async function onRightChain() { const d = await loadDeployments(); return W.chainId === d.chainId; }

// balances are read from the public RPC (works whatever network the wallet is on)
export async function rpc(method, params) {
  const d = await loadDeployments();
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 5000);
  const r = await fetch(d.rpcUrl, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
export async function tokenList() {
  const [d, t] = await Promise.all([loadDeployments(), loadToken()]);
  const marq = t.launched && /^0x[0-9a-fA-F]{40}$/.test(t.address || '') && t.address !== ZERO ? t.address : null;
  return [
    { symbol: 'ETH', address: null, decimals: 18 },
    { symbol: 'USDG', address: d.tokens?.USDG?.address || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: d.tokens?.USDG?.decimals ?? 6 },
    { symbol: 'MARQ', address: marq, decimals: d.tokens?.MARQ?.decimals ?? 18, disabled: !marq },
  ];
}
export async function balanceOf(tok, who) {
  if (!tok.address) return BigInt(await rpc('eth_getBalance', [who, 'latest']));
  const r = await rpc('eth_call', [{ to: tok.address, data: '0x' + SEL_BAL + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  return BigInt(r && r !== '0x' ? r : 0);
}
export async function refreshBalances() {
  if (!W.account) return;
  const acc = W.account;
  for (const tok of await tokenList()) {
    if (tok.disabled) continue;
    balanceOf(tok, acc).then((b) => { if (W.account === acc) { W.balances[tok.symbol] = { v: b, d: tok.decimals }; emit(); } }).catch(() => {});
  }
}
export const fmtUnits = (v, d, dp = 4) => {
  try { const b = BigInt(v); const w = b / 10n ** BigInt(d); const f = (b % 10n ** BigInt(d)).toString().padStart(d, '0').slice(0, dp).replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; } catch { return '?'; }
};

// ---------- UI: picker (used in the header panel and the tip modal) ----------
export function pickerHTML() {
  const list = walletList();
  if (list.length) return `<ul class="wl">${list.map((e) => `<li><button type="button" class="wl-btn" data-wl="${esc(e.info.uuid)}">${safeIcon(e.info.icon) ? `<img src="${safeIcon(e.info.icon)}" alt="" width="24" height="24">` : '<span class="wl-dot"></span>'}<span>${esc(e.info.name || 'Wallet')}</span></button></li>`).join('')}</ul>`;
  const path = location.host + location.pathname + location.search;
  const url = location.href;
  return `<p class="small muted">No browser wallet found.</p><p class="small">Open in your wallet's browser:</p>
  <div class="wl-links">
    <a class="btn btn-ghost sm" href="https://metamask.app.link/dapp/${esc(path)}" rel="noopener">MetaMask</a>
    <a class="btn btn-ghost sm" href="okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}" rel="noopener">OKX Wallet</a>
    <a class="btn btn-ghost sm" href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}" rel="noopener">Coinbase Wallet</a>
  </div>`;
}
export function wirePicker(root, after) {
  root.querySelectorAll('[data-wl]').forEach((b) => b.addEventListener('click', async () => {
    const e = walletList().find((x) => x.info.uuid === b.dataset.wl); if (!e) return;
    b.disabled = true;
    try { await connect(e); after?.(); } catch (err) { toast(err?.code === 4001 ? 'Cancelled' : 'Wallet error'); } finally { b.disabled = false; }
  }));
}
export async function accountHTML() {
  const d = await loadDeployments();
  const ok = W.chainId === d.chainId;
  const bals = Object.entries(W.balances).map(([s, b]) => `<span class="wbal"><b>${fmtUnits(b.v, b.d)}</b> ${s === 'MARQ' ? '$MARQ' : s}</span>`).join('');
  return `<div class="wacc">
    <div class="wacc-row">${safeIcon(W.entry?.info.icon) ? `<img src="${safeIcon(W.entry.info.icon)}" alt="" width="20" height="20">` : ''}<code>${esc(short(W.account, 5))}</code><button class="copy" type="button" data-copy="${esc(W.account)}"><span>Copy</span></button></div>
    <div class="wacc-row"><span class="netb ${ok ? 'ok' : 'bad'}">${ok ? `● ${esc(d.name)}` : '● Wrong network'}</span>${ok ? '' : '<button class="btn btn-live sm" type="button" data-switch>Switch to Robinhood Chain</button>'}</div>
    <div class="wacc-row wbals">${bals || '<span class="small muted">…</span>'}</div>
  </div>`;
}

// ---------- header button + panel (all pages) ----------
export function mountHeader() {
  const nav = document.querySelector('.nav nav'); if (!nav || nav.querySelector('[data-wallet-btn]')) return;
  const wrap = document.createElement('div'); wrap.className = 'wbox';
  wrap.innerHTML = '<button class="btn btn-ghost wbtn" type="button" data-wallet-btn aria-haspopup="dialog" aria-expanded="false">Connect wallet</button><div class="wpanel" data-wpanel hidden role="dialog" aria-label="Wallet"></div>';
  nav.insertBefore(wrap, nav.querySelector('.btn-live'));
  const btn = wrap.querySelector('[data-wallet-btn]'); const panel = wrap.querySelector('[data-wpanel]');
  const paint = async () => {
    btn.innerHTML = W.account ? `<span class="wdot"></span>${esc(short(W.account, 4))}` : 'Connect wallet';
    if (panel.hidden) return;
    if (!W.account) { panel.innerHTML = `<p class="wp-h">Connect wallet</p>${pickerHTML()}`; wirePicker(panel); return; }
    panel.innerHTML = `${await accountHTML()}<button class="btn btn-ghost sm" type="button" data-disc>Disconnect</button>`;
    panel.querySelector('[data-switch]')?.addEventListener('click', () => switchChain().catch(() => toast('Switch failed')));
    panel.querySelector('[data-disc]').addEventListener('click', () => { disconnect(); panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  };
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) { dispatchEvent(new Event('eip6963:requestProvider')); refreshBalances(); } paint(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  onWallet(paint);
}
