// Small 2D dot-matrix marquee (canvas) for the cinema screen sign and the cards. Same 5×7 font as the 3D board.
import { glyph } from '../scene/font5x7.js';

const TONE = { live: '#FF5C8A', red: '#FF3D6E', tip: '#FFC857', dim: '#FF5C8A', ink: '#FFD3E0' };

export function makeSign(canvas, { rows = 9, pitch = 8, speed = 70 } = {}) {
  const ctx = canvas.getContext('2d');
  const cols = Math.floor(canvas.width / pitch);
  const top = Math.floor((rows - 7) / 2);
  const offY = (canvas.height - rows * pitch) / 2 + pitch / 2;
  let text = '', tone = 'live', mode = 'static', cols0 = [], x = 0, tw = 0, raf = 0, last = 0, acc = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const build = (t) => { const out = []; for (const ch of t.toUpperCase()) { for (const m of glyph(ch)) out.push(m); out.push(0); } return out; };
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fits = cols0.length <= cols;
    const start = fits ? Math.floor((cols - cols0.length) / 2) : 0;
    for (let c = 0; c < cols; c++) {
      let m = 0;
      if (fits) { const i = c - start; m = i >= 0 && i < cols0.length ? cols0[i] : 0; }
      else { const L = cols0.length + 14; const i = (c + x) % L; m = i < cols0.length ? cols0[i] : 0; }
      for (let r = 0; r < rows; r++) {
        const tr = r - top; const on = tr >= 0 && tr < 7 && (m & (1 << tr));
        const twinkle = !on && mode === 'standby' && ((c * 7 + r * 13 + tw) % 53) === 0;
        const cx = c * pitch + pitch / 2, cy = offY + r * pitch;
        ctx.beginPath(); ctx.arc(cx, cy, pitch * 0.32, 0, Math.PI * 2);
        if (on || twinkle) {
          ctx.fillStyle = TONE[tone] || TONE.live; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = on ? pitch * 0.9 : pitch * 0.5;
          ctx.globalAlpha = on ? (mode === 'standby' ? 0.75 : 1) : 0.45;
        } else { ctx.fillStyle = '#2a1424'; ctx.shadowBlur = 0; ctx.globalAlpha = 1; }
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  function loop(t) {
    raf = 0;
    if (document.hidden || !canvas.isConnected) return;
    acc += t - (last || t); last = t;
    if (acc >= speed) { acc = 0; x++; tw = (tw + 1) % 53; draw(); }
    raf = requestAnimationFrame(loop);
  }
  const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !raf && !reduce) raf = requestAnimationFrame(loop); });
  io.observe(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !raf && !reduce) raf = requestAnimationFrame(loop); });
  return {
    set(t, tn = 'live', m = 'static') { text = t; tone = tn; mode = m; cols0 = build(text); x = 0; draw(); },
  };
}
