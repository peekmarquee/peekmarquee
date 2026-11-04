import { boot, esc } from './core.js';
import { mountViewer } from './stream-view.js';

boot();
const root = document.querySelector('[data-viewer-page]');
const m = location.pathname.match(/^\/s\/([0-9A-Za-z]{4,32})\/?$/);
const qs = new URLSearchParams(location.search);
if (!m) {
  root.innerHTML = '<div class="sv-empty"><h2>Not found.</h2></div>';
} else {
  const key = qs.get('key');
  if (key) history.replaceState(null, '', location.pathname); // keep the manage key out of screenshots/history
  mountViewer(root, { id: m[1], manageKey: key }).then((v) => {
    if (v?.state?.meta?.title) document.title = `${v.state.meta.title} · PEEKMARQUEE`;
  });
}
