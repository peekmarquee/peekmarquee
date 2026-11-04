// Page shells + static content. Every public sentence comes from the spec (claim numbers in comments).
const SITE = 'https://peekmarquee.live';
const X = 'https://x.com/peekmarquee';
const NPM = 'https://www.npmjs.com/package/peekmarquee';

const icon = {
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7"/></svg>',
};
const escA = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const copyBtn = (value, label = 'Copy') => `<button class="copy" type="button" data-copy="${escA(value)}" aria-label="${escA(label)}">${icon.copy}<span>Copy</span></button>`;

const nav = (active) => `
<header class="nav" role="banner">
  <a class="wordmark" href="/" aria-label="PEEKMARQUEE home"><span class="bulb" aria-hidden="true"></span>PEEKMARQUEE</a>
  <nav aria-label="Main">
    <a href="/live/"${active === 'live' ? ' aria-current="page"' : ''}>Live</a>
    <a href="/docs/"${active === 'docs' ? ' aria-current="page"' : ''}>Docs</a>
    <a href="/token/"${active === 'token' ? ' aria-current="page"' : ''}>Token</a>
    <a href="${X}" rel="noopener" target="_blank">X</a>
    <a class="btn btn-live" href="/#go-live">Go live</a>
  </nav>
</header>`;

const footer = () => `
<footer class="foot">
  <div class="foot-cols">
    <div><h3>Product</h3><a href="/live/">Live</a><a href="/docs/">Docs</a><a href="/token/">Token</a><a href="/proof/">Proof</a></div>
    <div><h3>Use</h3><a href="${NPM}" rel="noopener" target="_blank">npm</a><a href="/docs/#dry-run"><code>--dry-run</code></a><a href="/docs/#delete">Delete a stream</a><a href="/docs/#report">Report</a></div>
    <div><h3>Chain</h3><a href="/proof/" data-href="blockscout" hidden rel="noopener" target="_blank">Contract on explorer</a><a href="/token/#ca">CA</a><a href="/token/" data-href="buy" hidden rel="noopener" target="_blank">Buy on Pons</a></div>
    <div><h3>Social</h3><a href="${X}" rel="noopener" target="_blank">X</a><a href="/llms.txt">llms.txt</a></div>
  </div>
  <p class="foot-agents">Built for agents too: <a href="/llms.txt"><code>llms.txt</code></a>, <a href="/api"><code>/api</code></a>.</p>
  <p class="foot-legal">No promise of returns. Not affiliated with Anthropic or OpenAI.</p>
</footer>`;

export function shell(p, v) {
  const url = SITE + (p.path || '/');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<meta name="description" content="${p.desc}">
<meta name="theme-color" content="#150A11">
<meta name="pm-api" content="">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PEEKMARQUEE">
<meta property="og:title" content="${p.ogTitle || p.title}">
<meta property="og:description" content="${p.desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/og.jpg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@peekmarquee">
<meta name="twitter:title" content="${p.ogTitle || p.title}">
<meta name="twitter:description" content="${p.desc}">
<meta name="twitter:image" content="${SITE}/assets/og.jpg">
<link rel="preload" href="/assets/fonts/bricolage-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/manrope-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/dmmono-400.woff2" as="font" type="font/woff2" crossorigin>
${p.preload || ''}
<link rel="stylesheet" href="/css/site.css?v=${v}">
</head>
<body class="page-${p.id}">
<div class="bgfx" aria-hidden="true"><i class="au a1"></i><i class="au a2"></i><i class="au a3"></i><div class="grid"></div></div>
<a class="skip" href="#main">Skip to content</a>
${nav(p.id)}
<main id="main">
${p.body}
</main>
${footer()}
<div class="toast" role="status" aria-live="polite"></div>
<script type="module" src="/js/${p.js}.js?v=${v}"></script>
</body>
</html>`;
}

const DESC = 'Your coding agent, live. Anyone can watch it build. One command: npx peekmarquee. $MARQ · PEEKMARQUEE.';
const cmd = (c, id = '') => `<div class="cmd"${id ? ` id="${id}"` : ''}><span class="cmd-prompt" aria-hidden="true">$</span><code>${escA(c)}</code>${copyBtn(c, `Copy ${c}`)}</div>`;

// ---- token block (hero + /token) ----
export const tokenBlock = (where) => `
<div class="ticket" data-token="${where}">
  <div class="tk tk-sym"><b>$MARQ</b><span>PEEKMARQUEE</span></div>
  <div class="tk tk-ca"><span class="lbl">CA</span><code data-ca>0x0000…0000</code><button class="copy" type="button" data-copy-ca aria-label="Copy contract address">${icon.copy}<span>Copy</span></button><span class="tok-note" data-ca-note>CA at launch</span></div>
  <div class="tk tk-time">
    <div class="countdown" data-countdown aria-label="Countdown to launch">
      <span class="cd"><b data-d>0</b><i>d</i></span><span class="cd"><b data-h>00</b><i>h</i></span><span class="cd"><b data-m>00</b><i>m</i></span><span class="cd"><b data-s>00</b><i>s</i></span>
    </div>
    <span class="cd-label" data-cd-label>Fri 6 Nov 2026 · 15:00 UTC</span>
    <a class="btn btn-tip" href="/token/" data-buy hidden rel="noopener" target="_blank">Buy on Pons</a>
  </div>
  <p class="tok-official">Official CA is only posted on peekmarquee.live and @peekmarquee. Anything else is not us.</p>
</div>`;

// ---- landing ----
const landing = `
<section class="hero" aria-labelledby="h1">
  <div class="hero-stage" aria-hidden="true">
    <picture>
      <source media="(max-width: 768px)" srcset="/assets/hero-poster-m.webp">
      <img class="poster" src="/assets/hero-poster.webp" alt="" width="1920" height="1080" fetchpriority="high" decoding="async">
    </picture>
    <div class="stage-gl"></div>
    <div class="scrim"></div>
  </div>
  <div class="hero-copy">
    <h1 id="h1">Your coding agent, live. <span>Anyone can watch it build.</span></h1>
    <p class="lede">One command. <code>npx peekmarquee</code> in the folder where Claude Code is running prints a public link in seconds.</p>
    <div class="pill" id="go-live"><span class="cmd-prompt" aria-hidden="true">$</span><code>npx peekmarquee</code>${copyBtn('npx peekmarquee', 'Copy npx peekmarquee')}</div>
    <p class="sub">See exactly what would be sent: <code>npx peekmarquee --dry-run</code>.</p>
    ${tokenBlock('hero')}
    <a class="now" href="#watch" data-now><span class="now-state">…</span><span class="now-title"></span><span class="now-go">Watch</span></a>
  </div>
</section>

<section class="embed" id="watch" aria-labelledby="watch-h">
  <h2 id="watch-h" class="sr">Live now: who is building what.</h2>
  <div class="screen">
    <canvas class="sign" data-sign width="672" height="72" aria-hidden="true"></canvas>
    <div class="embed-box" data-embed><div class="embed-loading">…</div></div>
  </div>
  <p class="embed-more"><a href="/live/">Live now: who is building what.</a></p>
</section>

<section class="stats" data-stats hidden aria-label="Totals">
  <p>Streams so far: <b data-st="streamsTotal">–</b> · hours live: <b data-st="hoursStreamed">–</b> · secrets hidden: <b data-st="secretsHidden">–</b></p>
</section>

<section class="cards" data-reveal aria-label="How it works">
  <article class="card" data-card="stream">
    <img src="/assets/card-stream.webp" alt="" width="800" height="600" loading="lazy" decoding="async">
    <div class="card-body">
      <span class="num">01</span><h3>Stream</h3>
      <p>One command. <code>npx peekmarquee</code> in the folder where Claude Code is running prints a public link in seconds.</p>
      <ol class="mini-tl" data-mini aria-label="Latest events"></ol>
      <p class="first" data-first hidden>no public streams yet — be the first: <code>npx peekmarquee</code></p>
      <p class="foot-note">Read-only. Viewers can't type into your session; there is no channel from the page back to your terminal.</p>
    </div>
  </article>
  <article class="card" data-card="redact">
    <img src="/assets/card-redact.webp" alt="" width="800" height="600" loading="lazy" decoding="async">
    <div class="card-body">
      <span class="num">02</span><h3>Redact</h3>
      <p>Secrets are hidden on your machine, before anything leaves it. The relay runs the same filter again.</p>
      <canvas class="card-sign" data-red-sign width="384" height="56" aria-hidden="true"></canvas>
      <p class="first" data-first hidden>no public streams yet — be the first: <code>npx peekmarquee</code></p>
      <p class="big-num" data-secrets hidden><b>0</b> <span>secrets hidden</span></p>
      <div class="chips" data-chips>
        <span class="chip" data-cls="api_key">api_key</span><span class="chip" data-cls="token">token</span><span class="chip" data-cls="private_key">private_key</span><span class="chip" data-cls="seed_phrase">seed_phrase</span><span class="chip" data-cls="credential_url">credential_url</span><span class="chip" data-cls="jwt">jwt</span><span class="chip" data-cls="high-entropy">high-entropy</span><span class="chip" data-cls="env_value">env_value</span>
      </div>
      <p class="foot-note"><a href="/docs/#limits">What it can't catch</a></p>
    </div>
  </article>
  <article class="card" data-card="tip">
    <img src="/assets/card-tip.webp" alt="" width="800" height="600" loading="lazy" decoding="async">
    <div class="card-body">
      <span class="num">03</span><h3>Tip</h3>
      <p>Tips go straight to the streamer's wallet through a tiny contract that holds nothing.</p>
      <p class="tip-total" data-tip-total></p>
      <ol class="tip-list" data-tip-list></ol>
      <p class="foot-note"><a href="/proof/">Proof</a></p>
    </div>
  </article>
</section>

<section class="works" data-reveal aria-labelledby="works-h">
  <h2 id="works-h">Works with Claude Code.</h2>
  <p class="works-chip"><span class="dot"></span>Claude Code</p>
  <p class="muted">Codex support is being verified against real session files; not claimed yet.</p>
</section>

<section class="compare" data-reveal aria-labelledby="cmp-h">
  <h2 id="cmp-h">How it compares — as documented on 5 Nov 2026</h2>
  <div class="table-wrap" tabindex="0" role="region" aria-labelledby="cmp-h">
  <table>
    <thead><tr><th scope="col"></th><th scope="col">One command, no self-host</th><th scope="col">Secrets filtered before leaving your machine</th><th scope="col">Read-only for viewers</th><th scope="col">Public live directory</th><th scope="col">On-chain tips</th><th scope="col">Works with</th></tr></thead>
    <tbody>
      <tr class="us"><th scope="row">PEEKMARQUEE</th><td>Yes</td><td>Yes, then the relay filters again</td><td>Yes</td><td>Yes, <a href="/live/">/live</a></td><td>Yes, Robinhood Chain</td><td>Claude Code</td></tr>
      <!-- source: https://raw.githubusercontent.com/terryso/cc-live/main/README.md (read 5 Nov 2026): "Sharing" needs ngrok / Cloudflare Tunnel; "secrets are automatically redacted from displayed content"; "Read-only — viewers cannot interact with the session"; "Real-time viewer for Claude Code sessions" -->
      <tr><th scope="row"><a href="https://github.com/terryso/cc-live" rel="noopener" target="_blank">cc-live</a></th><td>No, needs a tunnel (ngrok or Cloudflare)</td><td>Redacts displayed content</td><td>Yes</td><td class="nd">not documented</td><td class="nd">not documented</td><td>Claude Code</td></tr>
      <!-- source: https://raw.githubusercontent.com/gotcs108/claude-live/master/README.md (read 5 Nov 2026): "Going public" = cloudflared tunnel or deploy server/; "the hook scrubs API keys, tokens, JWTs, and private keys before anything leaves your machine"; "By default the feed is read-only" + opt-in input mode "Anyone who can open the page can type into your session" -->
      <tr><th scope="row"><a href="https://github.com/gotcs108/claude-live" rel="noopener" target="_blank">claude-live</a></th><td>No, tunnel or your own server</td><td>Yes, in the hook</td><td>By default; an opt-in mode lets viewers type</td><td class="nd">not documented</td><td class="nd">not documented</td><td>Claude Code</td></tr>
      <!-- source: https://raw.githubusercontent.com/sderosiaux/twitch-terminal/main/README.md (read 5 Nov 2026): "./start.sh stream"; "Requires cloudflared for sharing"; "Read-only is server-enforced"; "run Claude Code, Codex, Aider, whatever" -->
      <tr><th scope="row"><a href="https://github.com/sderosiaux/twitch-terminal" rel="noopener" target="_blank">twitch-terminal</a></th><td>One command; runs a local server and a cloudflared tunnel</td><td class="nd">not documented</td><td>Yes</td><td class="nd">not documented</td><td class="nd">not documented</td><td>Any terminal</td></tr>
      <!-- source: https://raw.githubusercontent.com/brkalow/openctl/main/README.md (read 5 Nov 2026): openctl share, self-host "bun run start", "openctl config set server URL"; "storing, viewing, and sharing Claude Code sessions"; no redaction, read-only or directory section -->
      <tr><th scope="row"><a href="https://github.com/brkalow/openctl" rel="noopener" target="_blank">openctl</a></th><td class="nd">not documented (self-host documented)</td><td class="nd">not documented</td><td class="nd">not documented</td><td class="nd">not documented</td><td class="nd">not documented</td><td>Claude Code</td></tr>
    </tbody>
  </table>
  </div>
</section>

<section class="faq" data-reveal aria-labelledby="faq-h">
  <h2 id="faq-h">FAQ</h2>
  <details><summary>Can viewers type into my session?</summary><p>Read-only. Viewers can't type into your session; there is no channel from the page back to your terminal.</p></details>
  <details><summary>What gets hidden?</summary><p>Secrets are hidden on your machine, before anything leaves it. The relay runs the same filter again.</p><p>See exactly what would be sent: <code>npx peekmarquee --dry-run</code>. <a href="/docs/#redaction">Redaction classes</a></p></details>
  <details><summary>What can't it catch?</summary><p>What it can't catch: <a href="/docs/#limits">the full list</a>.</p><ul class="limits-short"><li>Secrets without a known prefix and with low entropy, unless a keyword is on the same line.</li><li>Secrets split across lines, spelled out, or inside an image.</li><li>Private content that isn't a secret, unless you use <code>--hide</code>.</li></ul></details>
  <details><summary>Who can see my stream?</summary><p>Anyone with the link. Live now: who is building what. Unlisted streams: <code>--private</code> keeps the link out of the directory and the stats.</p></details>
  <details><summary>How long do replays stay?</summary><p>Replays stay 24 hours, then they're deleted. Delete earlier with <code>npx peekmarquee delete &lt;id&gt;</code>.</p></details>
  <details><summary>Do I need a wallet?</summary><p>PEEKMARQUEE is free. Nothing here needs the token. Add <code>--wallet 0x…</code> only if you want a Tip button. Tips go straight to the streamer's wallet through a tiny contract that holds nothing.</p></details>
  <details><summary>Is this an official Anthropic product?</summary><p>No. Not affiliated with Anthropic or OpenAI. Works with Claude Code.</p></details>
  <details><summary>What does the token do?</summary><p>PEEKMARQUEE is free. Nothing here needs the token. Holder perks switch on after launch; until then everything is the same for everyone. No promise of returns. Creator fee goes to the team wallet and pays for the relay and domain.</p><p><a href="/token/">Token</a></p></details>
</section>`;

// ---- /live ----
const live = `
<section class="page-head"><h1>Live now: who is building what.</h1></section>
<section class="live-grid" data-live aria-live="polite"><p class="muted">…</p></section>
<section class="page-sec"><h2>Recent replays</h2><div class="live-grid" data-recent></div>
<p class="muted small">Replays stay 24 hours, then they're deleted. Delete earlier with <code>npx peekmarquee delete &lt;id&gt;</code>.</p></section>`;

// ---- /s/<id> ----
const viewer = `<section class="viewer-page" data-viewer-page><div class="embed-loading">…</div></section>`;

// ---- /docs ----
const flags = [
  ['npx peekmarquee', 'Stream the active Claude Code session for the current folder (public, listed in /live).'],
  ['--file <path>', 'Tail a specific JSONL file (skips detection).'],
  ['--agent claude', 'Only claude in this version; other values exit with "not supported in this version".'],
  ['--title "<≤80 chars>"', 'Title in the viewer and directory. Default "Untitled session". The folder name is never sent.'],
  ['--wallet 0x…', 'Wallet for tips (checksum validated). Without it there is no Tip button.'],
  ['--private', 'Unlisted link: not in /live, not in /api/live, not in public stats.'],
  ['--no-replay', 'The relay keeps nothing; the stream is gone when it ends.'],
  ['--no-prompts', 'Your prompts are not sent (agent actions only).'],
  ['--hide <glob|/regex/>', 'Extra redaction (repeatable).'],
  ['--dry-run', 'Does not connect to the relay; prints to stdout exactly the events that would be sent, already redacted.'],
  ['delete <id>', 'Delete a stream and its replay now.'],
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const docs = `
<div class="docs">
<aside class="docs-toc" aria-label="On this page">
  <a href="#install">Install &amp; run</a><a href="#flags">Flags</a><a href="#dry-run">Dry run</a><a href="#redaction">Redaction</a><a href="#limits">Limits</a><a href="#read-only">Read-only</a><a href="#chat">Chat</a><a href="#delete">Replay &amp; delete</a><a href="#tips">Tips &amp; contract</a><a href="#api">API</a><a href="#privacy">Privacy</a><a href="#report">Report</a><a href="#source">Source</a>
</aside>
<article class="docs-body">
<h1>Docs</h1>
<svg class="rule" viewBox="0 0 600 8" aria-hidden="true"><g>${Array.from({ length: 60 }, (_, i) => `<circle cx="${5 + i * 10}" cy="4" r="2.2" class="${i % 7 === 0 ? 'on' : i % 13 === 0 ? 'gold' : ''}"/>`).join('')}</g></svg>
<section id="install"><h2>Install &amp; run</h2>
<p>One command. <code>npx peekmarquee</code> in the folder where Claude Code is running prints a public link in seconds.</p>
${cmd('npx peekmarquee')}
<pre class="term"><code>npx peekmarquee
→ Streaming  https://peekmarquee.live/s/&lt;id&gt;   (viewers 0 · 0 secrets hidden)</code></pre>
<p>Node 18 or newer. Works with Claude Code.</p></section>
<section id="flags"><h2>Flags</h2><div class="table-wrap"><table class="flags"><tbody>${flags.map(([f, d]) => `<tr><th scope="row"><code>${esc(f)}</code></th><td>${esc(d)}</td></tr>`).join('')}</tbody></table></div></section>
<section id="dry-run"><h2>Dry run</h2><p>See exactly what would be sent: <code>npx peekmarquee --dry-run</code>.</p>${cmd('npx peekmarquee --dry-run')}</section>
<section id="redaction"><h2>What gets redacted</h2>
<p>Secrets are hidden on your machine, before anything leaves it. The relay runs the same filter again.</p>
<p>Each hidden value becomes a chip with its class; the value itself, its length and its hash are never sent.</p>
<div class="chips on">${['api_key', 'token', 'private_key', 'seed_phrase', 'credential_url', 'jwt', 'high-entropy', 'env_value'].map((c) => `<span class="chip lit">[redacted:${c}]</span>`).join('')}</div>
<ul>
<li>Results of tools that touch sensitive paths are hidden whole: <code>.env</code>, <code>.env.*</code>, <code>*.pem</code>, <code>*.key</code>, <code>id_rsa*</code>, <code>id_ed25519*</code>, <code>.npmrc</code>, <code>.netrc</code>, <code>.aws/*</code>, <code>.ssh/*</code>, <code>.gnupg/*</code>, <code>.kube/config</code>, <code>wallet*.json</code>, <code>keystore/*</code>, <code>.claude/settings*.json</code>, <code>.docker/config.json</code> and similar.</li>
<li>Commands that dump the environment or credentials (<code>printenv</code>, <code>env</code>, <code>gh auth token</code>, <code>security find-*</code> and others) have their output hidden.</li>
<li>Known key formats (OpenAI/Anthropic, GitHub, GitLab, AWS, Slack, Google, Stripe, SendGrid, npm, PyPI, Hugging Face, Replicate, JWT, PEM private keys, Telegram and Discord bot tokens), 12+ word seed phrases, credentials in URLs, paid RPC keys, <code>Authorization</code> headers and <code>password=</code>-style pairs.</li>
<li>Long high-entropy strings. Transaction hashes, addresses and UUIDs stay visible.</li>
<li>Your own patterns with <code>--hide</code>.</li>
</ul>
<p>Thinking blocks are never streamed.</p></section>
<section id="limits"><h2>What it can't catch</h2><ul>
<li>Secrets without a known prefix and with low entropy (a password like <code>hunter2</code>, a username) are not caught unless a keyword is on the same line.</li>
<li>Secrets split across lines, spelled out character by character, or inside an image or screenshot are not caught.</li>
<li>Content that is private but not a secret (customer names, emails, database rows printed to the terminal) is not hidden unless you use <code>--hide</code>.</li>
<li>Redaction uses regular expressions, not an understanding of context. Transaction hashes and addresses are left visible on purpose.</li>
<li><code>--dry-run</code> exists so you can check for yourself before you stream. Don't stream a session that holds production credentials.</li>
<li>The relay filters again with the same patterns, but it never sees anything already hidden on your machine; it is a safety net, not a replacement.</li>
</ul></section>
<section id="read-only"><h2>Read-only</h2><p>Read-only. Viewers can't type into your session; there is no channel from the page back to your terminal.</p>
<p>The CLI only accepts three message types from the relay: <code>ack</code>, <code>viewers</code> and <code>error</code>. It never executes anything it receives. The only POST a viewer can make is a report.</p></section>
<section id="chat"><h2>Chat</h2><p>Live chat for viewers. Chat never reaches the streamer's machine. Addresses and links in chat are removed.</p><p>Messages are plain text (nick up to 24 characters, message up to 280). Each message has a report button; the streamer can delete messages, set slow mode or turn chat off from the manage link. Chat is deleted with the replay.</p></section>
<section id="delete"><h2>Replay &amp; delete</h2><p>Replays stay 24 hours, then they're deleted. Delete earlier with <code>npx peekmarquee delete &lt;id&gt;</code>.</p>${cmd('npx peekmarquee delete <id>')}
<p>Unlisted streams: <code>--private</code> keeps the link out of the directory and the stats.</p>
<p>A secret slipped through? Run <code>npx peekmarquee delete &lt;id&gt;</code> right away. Viewers can report it as <code>secret_leaked</code>, which unlists the stream and turns its replay off until we check.</p></section>
<section id="tips"><h2>Tips &amp; contract</h2><p>Tips go straight to the streamer's wallet through a tiny contract that holds nothing.</p>
<p>Tip in ETH or USDG now; $MARQ after launch. ETH is one transaction (<code>tip</code>); a token tip is two: approve the exact amount, then <code>tipToken</code>.</p>
<p>Not audited. The contract has two functions, <code>tip</code> (ETH) and <code>tipToken</code> (tokens), and holds no ETH and no tokens. <span data-verify-line>Source verified on Sourcify (exact match).</span></p>
<p data-contract-line class="mono small"></p>
<p>Totals are gross and unfiltered: anyone can tip anyone, including themselves. A recipient whose wallet rejects ETH makes the tip transaction fail; no funds get stuck. <a href="/proof/">Proof</a></p></section>
<section id="api"><h2>API</h2><p>Built for agents too: <a href="/llms.txt"><code>llms.txt</code></a>, <a href="/api"><code>/api</code></a>.</p>
<div class="table-wrap"><table class="flags"><tbody>
<tr><th scope="row"><code>GET /api/live</code></th><td>Public live streams.</td></tr>
<tr><th scope="row"><code>GET /api/recent</code></th><td>Last 20 public replays that haven't expired.</td></tr>
<tr><th scope="row"><code>GET /api/stats</code></th><td>Totals from real streams only.</td></tr>
<tr><th scope="row"><code>GET /api/s/&lt;id&gt;</code></th><td>Stream meta.</td></tr>
<tr><th scope="row"><code>GET /api/s/&lt;id&gt;/events?from=&lt;seq&gt;</code></th><td>Server-sent events, live and replay.</td></tr>
<tr><th scope="row"><code>GET /api/s/&lt;id&gt;/replay.jsonl</code></th><td>Full replay download (after redaction).</td></tr>
<tr><th scope="row"><code>GET /api/tips/top</code></th><td>Tips read from the chain.</td></tr>
<tr><th scope="row"><code>POST /api/s/&lt;id&gt;/report</code></th><td><code>{"reason":"illegal|secret_leaked|spam|other"}</code></td></tr>
</tbody></table></div>
<pre class="term"><code>curl -s https://peekmarquee.live/api/live
curl -N https://peekmarquee.live/api/s/&lt;id&gt;/events</code></pre></section>
<section id="privacy"><h2>Privacy</h2><ul>
<li>Stored: stream events after redaction, for the replay window. Nothing before redaction.</li>
<li>Your folder name, working directory and git branch are never sent.</li>
<li>IP addresses are kept only as hashes for rate limits, for 24 hours.</li>
<li>No accounts.</li></ul></section>
<section id="report"><h2>Report &amp; takedown</h2><p>Every stream page has a Report a stream button (illegal, secret leaked, spam, other). Three reports unlist a stream from /live; a secret-leaked report unlists it and turns its replay off until we check.</p></section>
<section id="source"><h2>Source</h2><p>The CLI's source is readable in the npm tarball (no minification).</p><p><a href="${NPM}" rel="noopener" target="_blank">npm: peekmarquee</a></p></section>
</article></div>`;

// ---- /token ----
const token = `
<section class="page-head"><h1>$MARQ · PEEKMARQUEE</h1><p class="lede">PEEKMARQUEE is free. Nothing here needs the token.</p></section>
<section class="page-sec" id="ca">${tokenBlock('token')}</section>
<section class="page-sec token-facts">
  <dl>
    <div><dt>Holder perks</dt><dd data-perks>Holder perks switch on after launch; until then everything is the same for everyone.</dd></div>
    <div><dt>Fees</dt><dd>No promise of returns. Creator fee goes to the team wallet and pays for the relay and domain. <span data-tax hidden>Tax 2%.</span></dd></div>
    <div><dt>Contract</dt><dd>Not audited. The contract has two functions, <code>tip</code> (ETH) and <code>tipToken</code> (tokens), and holds no ETH and no tokens. <span data-verify-line>Source verified on Sourcify (exact match).</span> <span data-contract-line class="mono small"></span></dd></div>
    <div><dt>Team wallets</dt><dd data-team class="mono small"></dd></div>
  </dl>
</section>`;

// ---- /proof ----
const proof = `
<section class="page-head"><h1>Proof</h1><p class="lede">Tips go straight to the streamer's wallet through a tiny contract that holds nothing.</p>
<p class="muted">Not audited. The contract has two functions, <code>tip</code> (ETH) and <code>tipToken</code> (tokens), and holds no ETH and no tokens. <span data-verify-line>Source verified on Sourcify (exact match).</span></p></section>
<section class="page-sec proof-grid">
  <article class="pcard" data-reveal>
    <h2>Contract</h2>
    <dl class="kv" data-contract-kv><div><dt>TipJarV2</dt><dd class="mono">–</dd></div></dl>
    <p class="big-stat"><b data-balance>…</b><span>ETH held by the contract <i class="src" data-balance-src></i></span></p>
  </article>
  <article class="pcard" data-reveal>
    <h2>Live, from our relay</h2>
    <dl class="kv" data-relay-kv><div><dt>streams</dt><dd>…</dd></div></dl>
    <p class="small muted"><a href="/api/stats" rel="noopener" target="_blank"><code>/api/stats</code></a></p>
  </article>
</section>
<section class="page-sec" data-reveal>
  <h2>Tips</h2>
  <p class="proof-total" data-proof-total></p>
  <p class="muted small">On-chain tips, unfiltered. <span class="chip lit">counted</span> = sent to the wallet the stream registered · <span class="chip gold">team</span> = our own wallet.</p>
  <div class="table-wrap"><table class="tips"><thead><tr><th>Time (UTC)</th><th>Stream</th><th>Amount</th><th>From</th><th></th><th>Tx</th></tr></thead><tbody data-proof-tips></tbody></table></div>
</section>
<section class="page-sec proof-grid" data-reveal>
  <article class="pcard">
    <h2>Verify it yourself</h2>
    <p>See exactly what would be sent: <code>npx peekmarquee --dry-run</code>.</p>
    <p class="small muted">Sample output (synthetic session):</p>
    <pre class="term">[dry-run] not connecting to anything. Events below (JSON lines on stdout) are exactly what would be sent, already redacted.
{"v":1,"seq":6,"type":"tool_call","data":{"tool":"Bash","summary":"npm test","args":{"command":"npm test"}},"red":0}
{"v":1,"seq":7,"type":"tool_result","data":{"text":"tests 4 pass 4 fail 0 OPENAI_API_KEY=[redacted:api_key]","bytes":77,"truncated":false,"isError":false,"hidden":null},"red":1}
{"v":1,"seq":9,"type":"edit","data":{"path":"web/src/js/landing.js","added":2,"removed":1,"snippet":"-a\\n+b\\n+c"},"red":1}</pre>
    <p class="small" data-verify-links><a href="${NPM}" rel="noopener" target="_blank">npm: peekmarquee</a> <span data-npm-ver></span></p>
    <p class="small" data-repo hidden></p>
    <p class="small muted" data-tests hidden></p>
    <p class="small">The CLI's source is readable in the npm tarball (no minification).</p>
  </article>
  <article class="pcard">
    <h2>Team wallets</h2>
    <div data-team class="mono small"></div>
    <p class="small muted">No promise of returns. Creator fee goes to the team wallet and pays for the relay and domain.</p>
  </article>
</section>
<section class="page-sec"><h2>Stream id → bytes32</h2><p class="muted small"><code>streamId = keccak256(bytes(id))</code></p><div class="table-wrap"><table class="ids"><thead><tr><th>id</th><th>bytes32</th></tr></thead><tbody data-proof-ids></tbody></table></div></section>`;

const plain = (h, body) => `<section class="page-head"><h1>${h}</h1>${body}</section>`;
const startOwn = `<p>Start one:</p>${cmd('npx peekmarquee')}<p><a href="/live/">Live now: who is building what.</a></p>`;

export const pages = [
  { id: 'home', out: 'index.html', path: '/', title: 'PEEKMARQUEE ($MARQ) · Your coding agent, live', ogTitle: 'PEEKMARQUEE · Your coding agent, live. Anyone can watch it build.', desc: DESC, body: landing, js: 'landing', preload: '<link rel="preload" as="image" href="/assets/hero-poster-m.webp" media="(max-width: 768px)" fetchpriority="high"><link rel="preload" as="image" href="/assets/hero-poster.webp" media="(min-width: 769px)" fetchpriority="high">' },
  { id: 'live', out: 'live/index.html', path: '/live', title: 'Live · PEEKMARQUEE', desc: 'Live now: who is building what. PEEKMARQUEE streams coding agent sessions, read-only.', body: live, js: 'live' },
  { id: 'viewer', out: 's/index.html', path: '/s/', title: 'Live session · PEEKMARQUEE', desc: 'A coding agent session, live and read-only. PEEKMARQUEE.', body: viewer, js: 'viewer' },
  { id: 'docs', out: 'docs/index.html', path: '/docs', title: 'Docs · PEEKMARQUEE', desc: 'Install, flags, redaction, limits, replay, tips and API for PEEKMARQUEE.', body: docs, js: 'docs' },
  { id: 'token', out: 'token/index.html', path: '/token', title: '$MARQ · PEEKMARQUEE token', desc: 'PEEKMARQUEE is free. Nothing here needs the token. $MARQ · Fri 6 Nov 2026 15:00 UTC.', body: token, js: 'token' },
  { id: 'proof', out: 'proof/index.html', path: '/proof', title: 'Proof · PEEKMARQUEE', desc: 'TipJarV2 contract, on-chain tip totals and the last 50 tips.', body: proof, js: 'proof' },
  { id: 'expired', out: 'expired.html', path: '/expired', title: 'Expired · PEEKMARQUEE', desc: DESC, body: plain('This stream has expired.', startOwn), js: 'plain' },
  { id: 'notfound', out: '404.html', path: '/404', title: 'Not found · PEEKMARQUEE', desc: DESC, body: plain('Not found.', startOwn), js: 'plain' },
];
