import { boot, loadToken, loadDeployments, esc } from './core.js';

boot();
(async () => {
  const [t, d] = await Promise.all([loadToken(), loadDeployments()]);
  const ws = [...(t.team_wallets || []), ...d.teamWallets];
  const seen = new Set();
  const rows = ws.filter((w) => w?.address && !seen.has(w.address.toLowerCase()) && seen.add(w.address.toLowerCase()));
  document.querySelector('[data-team]').innerHTML = rows.map((w) => `<span class="tw"><span>${esc(w.label || 'team')}</span> <a href="${d.explorer}/address/${esc(w.address)}" rel="noopener" target="_blank">${esc(w.address)}</a></span>`).join('') || '–';
  if (t.launched && t.holderThreshold) document.querySelector('[data-perks]').textContent = 'Holders (threshold set after launch) get 30-day replays and a featured slot in /live, verified by a wallet signature from the streamer\'s manage link.';
})();
