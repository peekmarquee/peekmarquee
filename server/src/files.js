import fs from 'node:fs';

/** Reads a small JSON file, caching by mtime. Missing/invalid -> null. */
export function jsonReader(file) {
  let mtime = -1, cache = null;
  return () => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== mtime) { cache = JSON.parse(fs.readFileSync(file, 'utf8')); mtime = st.mtimeMs; }
      return cache;
    } catch { mtime = -1; cache = null; return null; }
  };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

/** Tolerant reader of web/deployments.json -> {address, deployBlock} | null (not deployed). */
export function teamWalletsFrom(dep) {
  return new Set((Array.isArray(dep?.teamWallets) ? dep.teamWallets : []).filter((w) => typeof w === 'string' && ADDR.test(w)).map((w) => w.toLowerCase()));
}

export function tipJarFrom(dep, chainId = 4663) {
  if (!dep || typeof dep !== 'object') return null;
  const ch = dep.chains?.[String(chainId)];
  if (ch && typeof ch.address === 'string' && ADDR.test(ch.address)) {
    const retired = (Array.isArray(ch.retired) ? ch.retired : []).filter((x) => x && typeof x.address === 'string' && ADDR.test(x.address) && !ZERO.test(x.address))
      .map((x) => ({ address: x.address, deployBlock: Number(x.deployBlock ?? 0) || 0 }));
    return ZERO.test(ch.address) ? null : { address: ch.address, deployBlock: Number(ch.deployBlock ?? 0) || 0, minTipWei: dep.minTipWei ?? null, retired };
  }
  if (ch && ch.address === null) return null; // schema present, not deployed yet
  const scope = dep['4663'] ?? dep.mainnet ?? dep.chains?.['4663'] ?? dep.networks?.['4663'] ?? dep.networks?.mainnet ?? dep;
  const find = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const [k, v] of Object.entries(o)) {
      if (/tip.?jar/i.test(k)) {
        if (typeof v === 'string' && ADDR.test(v)) return { address: v, deployBlock: Number(o.deployBlock ?? o.block ?? o[k + 'Block'] ?? 0) };
        if (v && typeof v === 'object' && ADDR.test(v.address || '')) return { address: v.address, deployBlock: Number(v.deployBlock ?? v.block ?? v.blockNumber ?? 0) };
      }
    }
    if (typeof o.address === 'string' && ADDR.test(o.address) && /tip/i.test(o.name || o.contract || '')) return { address: o.address, deployBlock: Number(o.deployBlock ?? o.block ?? 0) };
    for (const v of Object.values(o)) { const r = find(v, depth + 1); if (r) return r; }
    return null;
  };
  const r = find(scope) || (scope !== dep ? find(dep) : null);
  if (!r || ZERO.test(r.address)) return null;
  return { address: r.address, deployBlock: Number.isFinite(r.deployBlock) ? r.deployBlock : 0 };
}
