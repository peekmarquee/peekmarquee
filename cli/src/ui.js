import pc from 'picocolors';

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

export function statusLine({ startedAt, viewers, red, last, state, now = Date.now() }) {
  const dot = state === 'reconnecting' ? pc.yellow('●') : pc.red('●');
  const label = state === 'reconnecting' ? pc.yellow('RECONNECTING') : pc.bold(pc.red('LIVE'));
  const parts = [`${dot} ${label} ${fmtDuration(now - startedAt)}`];
  if (viewers !== null) parts.push(`${viewers} viewer${viewers === 1 ? '' : 's'}`);
  parts.push(`${red} secret${red === 1 ? '' : 's'} hidden`);
  if (last) parts.push(`last: ${last}`);
  return parts.join(' · ');
}

export async function printQr(url, out) {
  try {
    const { default: qr } = await import('qrcode-terminal');
    await new Promise((resolve) => qr.generate(url, { small: true }, (s) => { out.write(`${s}\n`); resolve(); }));
  } catch { /* QR is optional */ }
}
