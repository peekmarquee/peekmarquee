// Hero v2: full-bleed stage. A procedural marquee board (96×14 instanced bulbs + racing chaser border) that writes
// real stream events, mirrored in a glossy floor, with haze, slow sweeping spotlight cones, drifting dust and
// selective bloom. Camera is static apart from a gentle sway + pointer/gyro parallax (≤3°) and drag (±12°).
import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, Shape, ExtrudeGeometry, MeshStandardMaterial, Mesh, PlaneGeometry,
  SphereGeometry, InstancedMesh, MeshBasicMaterial, Object3D, InstancedBufferAttribute, TextureLoader, EquirectangularReflectionMapping,
  SRGBColorSpace, NoToneMapping, BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, CanvasTexture,
  AdditiveBlending, Group, Vector2, Vector3, MathUtils, FogExp2, ConeGeometry, ShaderMaterial, DoubleSide, CylinderGeometry,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { glyph } from './font5x7.js';

const COLS = 96, ROWS = 14, P = 0.1, TEXT_TOP = 4; // text rows 4..10
const TONES = {
  live: [1.0, 0.5, 0.64],  // pink-white: ordinary events
  red: [1.0, 0.2, 0.4],    // deep coral: [REDACTED …]
  tip: [1.0, 0.72, 0.25],  // gold: TIP … ETH
  dim: [1.0, 0.3, 0.5],    // coral, low power: STANDBY
};
const OFF = [0.05, 0.022, 0.04];
const BG = '#13090f';

export function start(host, feed, stage) {
  const small = matchMedia('(max-width: 768px)').matches;
  const LIT = 2.3;
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: small ? 'low-power' : 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1 : 1.5));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping; // ACES would push coral/gold bulbs to white
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new Scene();
  scene.background = new Color(BG);
  scene.fog = new FogExp2(BG, 0.035);
  const camera = new PerspectiveCamera(32, 1.6, 0.1, 120);

  const floorMat = new MeshStandardMaterial({ color: '#0a0408', metalness: 0.2, roughness: 0.4, transparent: true, opacity: 0.9, envMapIntensity: 0.06 });
  new TextureLoader().load('/assets/env.webp', (t) => { t.mapping = EquirectangularReflectionMapping; t.colorSpace = SRGBColorSpace; scene.environment = t; scene.environmentIntensity = 0.5; floorMat.envMap = t; floorMat.needsUpdate = true; });

  // ---------- board geometry ----------
  const W = COLS * P + 0.9, H = ROWS * P + 0.9, R = 0.34;
  const rr = (w, h, r) => {
    const s = new Shape();
    s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return s;
  };
  const frameGeo = new ExtrudeGeometry(rr(W, H, R), { depth: 0.42, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 3, curveSegments: 10 });
  frameGeo.translate(0, 0, -0.5);
  const frameMat = new MeshStandardMaterial({ color: '#4a2640', metalness: 0.85, roughness: 0.28, side: DoubleSide });
  const faceMat = new MeshStandardMaterial({ color: '#0a0307', metalness: 0.3, roughness: 0.75, side: DoubleSide });
  const faceGeo = new PlaneGeometry(W - 0.5, H - 0.5);

  // grid bulbs
  const bulbGeo = new SphereGeometry(P * 0.37, small ? 6 : 8, small ? 5 : 6);
  const bulbMat = new MeshBasicMaterial({ toneMapped: false });
  const bulbs = new InstancedMesh(bulbGeo, bulbMat, COLS * ROWS);
  const o = new Object3D();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    o.position.set((c - (COLS - 1) / 2) * P, ((ROWS - 1) / 2 - r) * P, 0.045); o.updateMatrix();
    bulbs.setMatrixAt(r * COLS + c, o.matrix);
  }
  const colors = new Float32Array(COLS * ROWS * 3);
  bulbs.instanceColor = new InstancedBufferAttribute(colors, 3);

  // chaser bulbs around the frame
  const chase = [];
  const cw = W - 0.24, ch = H - 0.24, step = 0.19;
  for (let x = -cw / 2; x <= cw / 2 + 1e-6; x += step) chase.push([x, ch / 2]);
  for (let y = ch / 2 - step; y >= -ch / 2 - 1e-6; y -= step) chase.push([cw / 2, y]);
  for (let x = cw / 2 - step; x >= -cw / 2 - 1e-6; x -= step) chase.push([x, -ch / 2]);
  for (let y = -ch / 2 + step; y < ch / 2 - 1e-6; y += step) chase.push([-cw / 2, y]);
  const chaseGeo = new SphereGeometry(0.042, small ? 6 : 8, small ? 5 : 6);
  const chaser = new InstancedMesh(chaseGeo, new MeshBasicMaterial({ toneMapped: false }), chase.length);
  chase.forEach(([x, y], i) => { o.position.set(x, y, 0.06); o.updateMatrix(); chaser.setMatrixAt(i, o.matrix); });
  const ccol = new Float32Array(chase.length * 3);
  chaser.instanceColor = new InstancedBufferAttribute(ccol, 3);

  function makeBoard(mirror) {
    const g = new Group();
    g.add(new Mesh(frameGeo, frameMat));
    const face = new Mesh(faceGeo, faceMat); face.position.z = 0.01; g.add(face);
    if (!mirror) { g.add(bulbs); g.add(chaser); return g; }
    const mirrorMat = new MeshBasicMaterial({ toneMapped: false, color: 0x4a4a4a }); // reflection = dimmer copy
    const mb = new InstancedMesh(bulbGeo, mirrorMat, COLS * ROWS); mb.instanceMatrix = bulbs.instanceMatrix; mb.instanceColor = bulbs.instanceColor; g.add(mb);
    const mc = new InstancedMesh(chaseGeo, mirrorMat, chase.length); mc.instanceMatrix = chaser.instanceMatrix; mc.instanceColor = chaser.instanceColor; g.add(mc);
    return g;
  }
  const board = makeBoard(false);
  const legMat = new MeshStandardMaterial({ color: '#2a1424', metalness: 0.9, roughness: 0.3 });
  const legs = [];
  for (const x of [-W * 0.32, W * 0.32]) { const leg = new Mesh(new CylinderGeometry(0.06, 0.06, 1.15, 10), legMat); leg.position.set(x, -H / 2 - 0.575, -0.25); board.add(leg); legs.push(leg); }
  board.rotation.y = MathUtils.degToRad(-26);
  scene.add(board);
  const mirror = makeBoard(true);
  for (const leg of legs) mirror.add(leg.clone());
  mirror.scale.y = -1; mirror.rotation.y = board.rotation.y;
  scene.add(mirror);

  // floor (translucent: the mirrored board shows through as a glossy reflection)
  const floor = new Mesh(new PlaneGeometry(80, 40), floorMat);
  floor.rotation.x = -Math.PI / 2; scene.add(floor);

  // ---------- spotlight cones (additive, sweeping slowly) ----------
  const coneMat = (col) => new ShaderMaterial({
    uniforms: { uColor: { value: new Color(col) }, uI: { value: small ? 0.16 : 0.2 } },
    vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uI; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float edge = pow(abs(dot(vN, vV)), 1.6); float along = pow(vY, 1.4); gl_FragColor = vec4(uColor * uI * edge * along, 1.0); }',
    transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
  });
  const cones = [];
  const coneGeo = new ConeGeometry(2.1, 9, 32, 1, true); coneGeo.translate(0, -4.5, 0); // apex at origin, opening downward
  [['#FF5C8A', -3.2, 0.0], ['#FFC857', 1.4, 1.9], ['#FF5C8A', 5.0, 3.7]].forEach(([c, x, ph]) => {
    const m = new Mesh(coneGeo, coneMat(c)); m.userData = { x, ph }; scene.add(m); cones.push(m);
  });

  // ---------- dust ----------
  const N = small ? 260 : 700; const dp = new Float32Array(N * 3); const dv = new Float32Array(N);
  const sprite = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16); rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(0, 0, 32, 32); return new CanvasTexture(c); })();
  const dg = new BufferGeometry(); dg.setAttribute('position', new Float32BufferAttribute(dp, 3));
  const dust = new Points(dg, new PointsMaterial({ color: '#FFB3C8', map: sprite, size: 0.05, transparent: true, opacity: 0.5, depthWrite: false, blending: AdditiveBlending }));
  scene.add(dust);

  // pool of light on the floor under the board
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  { const g = cv.getContext('2d'); const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64); rg.addColorStop(0, 'rgba(255,92,138,.6)'); rg.addColorStop(1, 'rgba(255,92,138,0)'); g.fillStyle = rg; g.fillRect(0, 0, 128, 128); }
  const pool = new Mesh(new PlaneGeometry(W * 1.2, 3.4), new MeshBasicMaterial({ map: new CanvasTexture(cv), transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: 0.22 }));
  pool.rotation.x = -Math.PI / 2; scene.add(pool);

  // ---------- post ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(256, 256), small ? 0.9 : 1.05, 0.5, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- layout (desktop: board center-right, 3/4; portrait: board high, wide) ----------
  const L = { floorY: -H / 2 - 1.15, target: new Vector3(), dist: 14, elev: 0.6 };
  function layout() {
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    const aspect = w / h; camera.aspect = aspect; camera.updateProjectionMatrix();
    const portrait = aspect < 1.1;
    const tv = Math.tan(MathUtils.degToRad(camera.fov / 2)), th = tv * aspect;
    const cy = portrait ? 0.64 : 0.06;                       // board center, NDC y
    L.elev = portrait ? 0.4 : 0.55;
    // horizontal room: portrait = full width; landscape = right of the text column (+ margin for sway/drag)
    let lo = -0.98, hi = 0.98;
    if (!portrait) {
      const copy = stage.parentElement?.querySelector('.hero-copy')?.getBoundingClientRect();
      const right = copy ? copy.right - rect.left : w * 0.45;
      lo = ((right + Math.max(40, w * 0.035)) / w) * 2 - 1; hi = 0.97;
      if (hi - lo < 0.5) lo = hi - 0.5; // very narrow: keep a readable board (scrim covers the overlap)
    }
    // fit by projecting the board's corners at rest (3/4 view → near end looks bigger), a few iterations
    const f = (hi - lo) / 2, c0 = (hi + lo) / 2; let cx = c0;
    L.dist = (W * Math.cos(board.rotation.y)) / 2 / (th * f);
    L.target.set(-cx * L.dist * th, -cy * L.dist * tv, 0);
    board.updateMatrixWorld(true);
    const corners = []; for (const x of [-W / 2, W / 2]) for (const y of [-H / 2, H / 2]) for (const z of [-0.57, 0.1]) corners.push(new Vector3(x, y, z).applyMatrix4(board.matrixWorld));
    for (let it = 0; it < 5; it++) {
      camera.position.set(L.target.x, L.target.y + L.elev, L.dist); camera.lookAt(L.target); camera.updateMatrixWorld(true);
      let mn = Infinity, mx = -Infinity;
      for (const c of corners) { const v = c.clone().project(camera); mn = Math.min(mn, v.x); mx = Math.max(mx, v.x); }
      const k = (mx - mn) / (hi - lo); L.dist *= k;
      L.target.set(-cx * L.dist * th, -cy * L.dist * tv, 0);
      const mid = (mn + mx) / 2; cx += (c0 - mid); // shift so the projected box is centered in [lo, hi]
      L.target.x = -cx * L.dist * th;
    }
    mirror.position.set(0, 2 * L.floorY, 0);
    floor.position.y = L.floorY; pool.position.set(0.4, L.floorY + 0.01, 0.9); pool.rotation.z = -board.rotation.y;
    for (const c of cones) c.position.set(c.userData.x, 5.2, -1.2);
    for (let i = 0; i < N; i++) { dp[i * 3] = L.target.x + (Math.random() - 0.5) * 22; dp[i * 3 + 1] = L.floorY + Math.random() * 7; dp[i * 3 + 2] = -3 + Math.random() * 6; dv[i] = 0.05 + Math.random() * 0.12; }
    dg.attributes.position.needsUpdate = true;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(Math.round(w / 2), Math.round(h / 2));
  }

  // ---------- tape: columns of 7-bit masks + tone ----------
  const disp = Array.from({ length: COLS }, () => ({ m: 0, t: 'live' }));
  let tape = [];
  const history = [];
  const queue = [];
  let mode = feed.mode || 'off';
  const toCols = (text, tone) => {
    const out = [];
    for (const ch of text.toUpperCase()) { for (const m of glyph(ch)) out.push({ m, t: tone }); out.push({ m: 0, t: tone }); }
    for (let i = 0; i < 12; i++) out.push({ m: 0, t: tone });
    return out;
  };
  let k = 0;
  function nextLine() {
    if (feed.fixed) return toCols(feed.fixed, 'live');
    if (mode === 'off') return toCols('STANDBY · NPX PEEKMARQUEE', 'dim');
    if (queue.length) { const l = queue.shift(); history.push(l); if (history.length > 5) history.shift(); return toCols(l.text, l.tone); }
    if (history.length) { const l = history[(k = (k + 1) % history.length)]; return toCols((mode === 'replay' ? 'REPLAY · ' : '') + l.text, l.tone); }
    return toCols(mode === 'replay' ? 'REPLAY' : 'ON AIR · NPX PEEKMARQUEE', 'live');
  }
  for (const l of feed.lines.slice(-5)) history.push(l);
  feed.subs.add((line, m) => {
    if (m) { mode = m; if (m === 'replay') { history.length = 0; for (const l of feed.lines.slice(-5)) history.push(l); } }
    if (line && mode === 'replay') { history.push(line); if (history.length > 5) history.shift(); }
    else if (line) { queue.push(line); if (queue.length > 6) queue.shift(); }
  });
  tape = nextLine(); for (let c = 0; c < COLS; c++) { disp.shift(); disp.push(tape.length ? tape.shift() : { m: 0, t: 'live' }); }

  let phase = 0; let tw = 0;
  const CH_OFF = [0.09, 0.05, 0.03];
  function paint() {
    let i = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++, i += 3) {
      let col = OFF, pow = 1;
      if (r >= TEXT_TOP && r < TEXT_TOP + 7) {
        const d = disp[c];
        if (d.m & (1 << (r - TEXT_TOP))) { col = TONES[d.t] || TONES.live; pow = d.t === 'dim' ? 1.25 : LIT; }
      }
      if (col === OFF && mode === 'off' && ((c * 7 + r * 13 + tw) % 97) === 0) { col = TONES.dim; pow = 0.5; } // idle twinkle
      colors[i] = col[0] * pow; colors[i + 1] = col[1] * pow; colors[i + 2] = col[2] * pow;
    }
    bulbs.instanceColor.needsUpdate = true;
    const g = mode === 'off' ? 0.9 : 1.6;
    for (let j = 0; j < chase.length; j++) {
      const on = ((j + phase) % 6) < 2;
      const c = on ? TONES.tip : CH_OFF; const p = on ? g : 1;
      ccol[j * 3] = c[0] * p; ccol[j * 3 + 1] = c[1] * p; ccol[j * 3 + 2] = c[2] * p;
    }
    chaser.instanceColor.needsUpdate = true;
  }
  layout(); paint();
  new ResizeObserver(layout).observe(host);

  // ---------- camera motion ----------
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, drag = null, dragYaw = 0;
  const deg = MathUtils.degToRad;
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    tYaw = ((e.clientX - r.left) / r.width - 0.5) * deg(4);
    tPitch = ((e.clientY - r.top) / r.height - 0.5) * deg(3);
    if (drag) dragYaw = MathUtils.clamp(drag.y0 + ((e.clientX - drag.x) / r.width) * deg(40), -deg(6), deg(6));
  }, { passive: true });
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && !e.target.closest('a,button,input,code,.hero-copy')) drag = { x: e.clientX, y0: dragYaw }; });
  addEventListener('pointerup', () => { drag = null; });
  stage.addEventListener('pointerleave', () => { tYaw = 0; tPitch = 0; });
  addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    tYaw = MathUtils.clamp(e.gamma / 30, -1, 1) * deg(3);
    tPitch = MathUtils.clamp((e.beta - 45) / 40, -1, 1) * deg(1.5);
  }, { passive: true });
  function place(t) {
    const a = yaw + dragYaw + Math.sin(t * 0.00011) * deg(1.2);
    const d = L.dist;
    camera.position.set(L.target.x + Math.sin(a) * d, L.target.y + L.elev + Math.sin(pitch) * d + Math.sin(t * 0.00013) * 0.06, Math.cos(a) * d);
    camera.lookAt(L.target);
  }

  // ---------- loop ----------
  let visible = true, running = false, last = performance.now(), acc = 0, chAcc = 0, first = true;
  const stats = { frames: 0, t0: performance.now(), fps: 0 };
  window.__pmScene = stats;
  function loop(now) {
    if (!visible || document.hidden) { running = false; return; }
    if (small && now - last < 30) { requestAnimationFrame(loop); return; } // ~30 fps cap on phones
    const dt = Math.min(100, now - last); last = now;
    acc += dt; chAcc += dt;
    let changed = false;
    while (acc >= 60) { acc -= 60; if (!tape.length) tape = nextLine(); disp.shift(); disp.push(tape.shift()); changed = true; }
    if (chAcc >= (mode === 'off' ? 220 : 90)) { chAcc = 0; phase = (phase + 1) % 6; tw = (tw + 1) % 97; changed = true; }
    if (changed) paint();
    yaw += (tYaw - yaw) * 0.05; pitch += (tPitch - pitch) * 0.05;
    if (!drag) dragYaw *= 0.96;
    place(now);
    for (const c of cones) { c.rotation.z = Math.sin(now * 0.00018 + c.userData.ph) * 0.38; c.rotation.x = Math.cos(now * 0.00013 + c.userData.ph) * 0.12; }
    for (let i = 0; i < N; i++) { const y = i * 3 + 1; dp[y] += dv[i] * dt * 0.001; if (dp[y] > L.floorY + 7) dp[y] = L.floorY; dp[i * 3] += Math.sin(now * 0.0003 + i) * 0.0006; }
    dg.attributes.position.needsUpdate = true;
    composer.render();
    if (first) { first = false; stage.classList.add('gl-on'); }
    stats.frames++; if (now - stats.t0 > 1000) { stats.fps = Math.round((stats.frames * 1000) / (now - stats.t0)); stats.frames = 0; stats.t0 = now; }
    requestAnimationFrame(loop);
  }
  const kick = () => { if (!running && visible && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(loop); } };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(stage);
  document.addEventListener('visibilitychange', kick);
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); visible = false; stage.classList.remove('gl-on'); });
  kick();
}
