'use strict';
(() => {
const $ = id => document.getElementById(id);
const canvas = $('lcd'), ictx = canvas.getContext('2d', { alpha: false });
const root = document.documentElement;

/* ---------------------------------------------------------- settings */
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); } catch {} },
};
// The four LCD shades of a DMG-01 (no backlight: muted olive greens, darkest shade not quite black).
const DMG = ['#9cb243', '#7b963f', '#4b6338', '#202f24'];
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toABGR = h => { const [r, g, b] = hex(h); return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; };
canvas.style.background = DMG[0];
let volume = store.get('vol', 0.8), ff = false, showFps = store.get('fps', false);
let lcdFx = store.get('fx', true), clickFb = store.get('click', true);
let ctrlSize = store.get('csize', 1), ctrlLift = store.get('clift', 0.35);

/* ---------------------------------------------------------- storage (IndexedDB) */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    try {
      const q = indexedDB.open('gbemu', 1);
      q.onupgradeneeded = () => { q.result.createObjectStore('roms', { keyPath: 'name' }); q.result.createObjectStore('saves', { keyPath: 'name' }); };
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
const idb = (store, mode, fn) => db().then(d => new Promise((res, rej) => {
  const t = d.transaction(store, mode), r = fn(t.objectStore(store));
  t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));
const romPut = (name, data) => idb('roms', 'readwrite', s => s.put({ name, data }));
const romGet = name => idb('roms', 'readonly', s => s.get(name));
const romDel = name => idb('roms', 'readwrite', s => s.delete(name));
const romList = () => idb('roms', 'readonly', s => s.getAllKeys());
const saveGet = name => idb('saves', 'readonly', s => s.get(name));
const savePut = (name, data) => idb('saves', 'readwrite', s => s.put({ name, data }));
const saveDel = name => idb('saves', 'readwrite', s => s.delete(name));

/* ---------------------------------------------------------- LCD rendering
   The real panel: 160x144 dots separated by thin dark gaps, slow liquid-crystal response (ghosting),
   and a shadow from the bezel on the top/left edges. We draw at full device resolution so the dot grid
   is sharp at any size. */
const src = document.createElement('canvas'); src.width = 160; src.height = 144;
const sctx = src.getContext('2d', { alpha: false });
const shown = new ImageData(160, 144);       // what the glass currently displays (blended)
let fb8 = null, kdev = 4, gridPat = null;
function resetGlass() { const [r, g, b] = hex(DMG[0]); for (let i = 0; i < shown.data.length; i += 4) { shown.data[i] = r; shown.data[i + 1] = g; shown.data[i + 2] = b; shown.data[i + 3] = 255; } sctx.putImageData(shown, 0, 0); }
resetGlass();
function makeGrid() {
  gridPat = null;
  if (kdev < 3) return;
  const t = document.createElement('canvas'); t.width = t.height = kdev;
  const c = t.getContext('2d'), lw = Math.max(1, Math.round(kdev * 0.125));
  c.fillStyle = 'rgba(28,42,12,.24)';
  c.fillRect(kdev - lw, 0, lw, kdev); c.fillRect(0, kdev - lw, kdev, lw);
  gridPat = ictx.createPattern(t, 'repeat');
}
function blit() {
  const W = canvas.width, H = canvas.height;
  ictx.imageSmoothingEnabled = false;
  ictx.drawImage(src, 0, 0, W, H);
  if (lcdFx && gridPat) { ictx.fillStyle = gridPat; ictx.fillRect(0, 0, W, H); }
}
function present() {
  const a = fb8, o = shown.data;
  if (lcdFx && !ff) { for (let i = 0; i < a.length; i++) o[i] += (a[i] - o[i]) * 0.62; } else o.set(a);
  sctx.putImageData(shown, 0, 0);
  blit();
}

/* ---------------------------------------------------------- emulator state */
let gb = null, romName = null;
let paused = false, lastSave = 0;

async function flushSave() {
  if (!gb || !romName || !gb.ramDirty) return;
  gb.ramDirty = false;
  try { await savePut(romName, gb.getSave()); } catch { gb.ramDirty = true; }
}
async function startRom(name, bytes) {
  await flushSave();
  const g = new GB(bytes);
  if (g.cgbOnly) { toast('This is a Game Boy Color-only game (not supported yet)'); return; }
  if (g.hasBattery) { try { const s = await saveGet(name); if (s) g.loadSave(s.data); } catch {} }
  gb = g; romName = name;
  g.apu.setRate(audio ? audio.ctx.sampleRate : 44100);
  g.pal.set(DMG.map(toABGR));
  fb8 = new Uint8ClampedArray(g.fb.buffer);
  g.runFrame(); shown.data.set(fb8); present();
  $('hint').textContent = '';
  closeMenu();
  store.set('last', name);
  document.title = name.replace(/\.(gbc?|bin)$/i, '');
}

/* ---------------------------------------------------------- audio
   iOS/iPadOS quirks handled here:
   - audio must be started from a touch/click gesture,
   - Web Audio is silenced by the mute / "silent mode" switch unless the page declares a "playback"
     audio session (navigator.audioSession, or an inaudible looping <audio> element on older iOS). */
let audio = null, silentEl = null;
const AUDIO_TARGET = 4096;
function setPlaybackSession() {
  try { if (navigator.audioSession) { navigator.audioSession.type = 'playback'; return; } } catch {}
  try {
    if (silentEl) return;
    const n = 8000, buf = new ArrayBuffer(44 + n), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    silentEl = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    silentEl.loop = true; silentEl.volume = 0.01; silentEl.setAttribute('playsinline', '');
    silentEl.play().catch(() => { silentEl = null; });
  } catch {}
}
function unlockAudio() {
  try {
    setPlaybackSession();
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const c = new AC({ latencyHint: 'interactive' });
      const sp = c.createScriptProcessor(2048, 2, 2);
      audio = { ctx: c, sp, gain: c.createGain(), peak: 0, cb: 0 };
      sp.onaudioprocess = e => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        audio.cb++;
        if (!gb) { L.fill(0); R.fill(0); return; }
        if (paused || ff || document.hidden) { gb.apu.silence(L, R); if (ff) gb.apu.flush(); return; }
        gb.apu.read2(L, R, volume);
        let pk = 0; for (let i = 0; i < L.length; i += 8) pk = Math.max(pk, Math.abs(L[i])); audio.peak = pk;
      };
      sp.connect(audio.gain); audio.gain.connect(c.destination);
      c.onstatechange = updateSnd;
      if (gb) { gb.apu.setRate(c.sampleRate); gb.apu.flush(); }
      fillAvg = AUDIO_TARGET;
    }
    if (!document.hidden && audio.ctx.state !== 'running') audio.ctx.resume().then(updateSnd, () => {});
  } catch (e) { console.warn('audio', e); }
  updateSnd();
}
function updateSnd() {
  const ok = audio && audio.ctx.state === 'running';
  $('sndBtn').classList.toggle('warn', !ok);
  $('sndWaves').style.display = ok && volume > 0 ? '' : 'none';
  $('sndStatus').textContent = !audio ? 'Not started. Tap anywhere or press Test beep.' : ok ? `Playing at ${audio.ctx.sampleRate} Hz` + (volume === 0 ? ' (volume is 0)' : '') : `Blocked (${audio.ctx.state}). Tap Test beep.`;
}
function beep() {
  unlockAudio(); if (!audio) return;
  const c = audio.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2 * Math.max(0.2, volume), t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.27);
}
function onGesture() { unlockAudio(); goFullscreen(); }
['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(ev => window.addEventListener(ev, onGesture, { passive: true, capture: true }));

// Silent while the page is hidden: fade out + suspend, then fade back in.
let suspendT = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(suspendT);
  if (document.hidden) {
    flushSave();
    if (audio) { audio.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.012); suspendT = setTimeout(() => { if (document.hidden && audio) audio.ctx.suspend(); }, 120); }
  } else {
    last = 0; if (gb) gb.apu.flush();
    if (audio) { audio.ctx.resume(); audio.gain.gain.setTargetAtTime(1, audio.ctx.currentTime, 0.03); }
  }
});
window.addEventListener('pagehide', flushSave);

/* ---------------------------------------------------------- fullscreen */
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function goFullscreen() {
  if (isFs() || isStandalone()) return;
  const el = root, f = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!f) return;
  try { const r = f.call(el, { navigationUI: 'hide' }); if (r && r.catch) r.catch(() => {}); } catch {}
}
document.addEventListener('pointerup', function once() {
  document.removeEventListener('pointerup', once);
  // If the browser won't do real fullscreen (iOS Safari tab), say how to get it, once.
  setTimeout(() => { if (!isFs() && !isStandalone() && !store.get('fsHint', false)) { store.set('fsHint', true); toast('For true fullscreen: Share → Add to Home Screen, then open it from there.'); } }, 700);
});
document.addEventListener('fullscreenchange', () => layout()); document.addEventListener('webkitfullscreenchange', () => layout());

/* ---------------------------------------------------------- feedback (haptics / click)
   Honest limits: iPads have no vibration motor and Safari has no vibration API, so on an iPad the
   only physical-feeling feedback possible is sound (+ the visual press). Where hardware exists we
   use it at maximum strength: navigator.vibrate (Android), the iOS switch-haptic trick (iPhones),
   and dual-rumble on connected gamepads. */
const hapl = $('hapl');
function clickSound() {
  if (!audio || audio.ctx.state !== 'running') return;
  const c = audio.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(1700, t); o.frequency.exponentialRampToValueAtTime(260, t + 0.03);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3 * Math.max(0.3, volume), t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.05);
}
function feedback(down) {
  if (!clickFb) return;
  try { navigator.vibrate && navigator.vibrate(down ? 20 : 8); } catch {}
  try { hapl.click(); } catch {}
  if (down) clickSound();
}
function rumble() {
  if (!clickFb) return;
  try {
    for (const g of (navigator.getGamepads ? navigator.getGamepads() : [])) {
      const a = g && g.vibrationActuator;
      if (a && a.playEffect) a.playEffect('dual-rumble', { startDelay: 0, duration: 35, weakMagnitude: 1, strongMagnitude: 1 }).catch(() => {});
    }
  } catch {}
}

/* ---------------------------------------------------------- input */
const touchHeld = new Map(); // pointerId -> {x, y, role}
let touchMask = 0, kbMask = 0, shownMask = -1, gpPrev = 0, mode = 'touch';
const KEYS = {
  ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, KeyD: 0, KeyA: 1, KeyW: 2, KeyS: 3,
  KeyX: 4, KeyK: 4, KeyZ: 5, KeyJ: 5, ShiftLeft: 6, ShiftRight: 6, Backspace: 6, Enter: 7, Space: 7,
};
window.addEventListener('keydown', e => {
  if ($('menu').classList.contains('open')) return;
  const b = KEYS[e.code]; if (b === undefined) return; e.preventDefault(); kbMask |= 1 << b;
});
window.addEventListener('keyup', e => { const b = KEYS[e.code]; if (b === undefined) return; e.preventDefault(); kbMask &= ~(1 << b); });
window.addEventListener('blur', () => { kbMask = 0; });

const dpadEl = $('dpad'), dirEls = [...dpadEl.querySelectorAll('[data-d]')];
const btnEls = [...document.querySelectorAll('[data-b]')];
// Any touch that starts in the left column steers the D-pad relative to its centre; buttons have a
// generous hit radius and the gap between A and B presses both (thumb rolling).
function recomputeTouch() {
  let m = 0;
  const dr = dpadEl.getBoundingClientRect(), cx = dr.left + dr.width / 2, cy = dr.top + dr.height / 2, u = dr.width;
  const info = btnEls.map(el => {
    const r = el.getBoundingClientRect();
    return { bit: +el.dataset.b, pill: el.classList.contains('sm'), r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  for (const p of touchHeld.values()) {
    let hit = false;
    for (const b of info) {
      const inside = b.pill ? (p.x >= b.r.left - 10 && p.x <= b.r.right + 10 && p.y >= b.r.top - 12 && p.y <= b.r.bottom + 12)
                            : Math.hypot(p.x - b.cx, p.y - b.cy) < b.r.width * 0.68;
      if (inside) { m |= 1 << b.bit; hit = true; }
    }
    if (!hit && p.role === 'left') {
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
      if (d > u * 0.16) {
        const rx = dx / d, ry = dy / d;
        if (rx > 0.4) m |= 1; if (rx < -0.4) m |= 2; if (ry < -0.4) m |= 4; if (ry > 0.4) m |= 8;
      }
    }
  }
  if (m & ~touchMask) feedback(true); else if (touchMask & ~m) feedback(false);
  touchMask = m;
}
function showPressed(m) {
  if (m === shownMask) return; shownMask = m;
  btnEls.forEach(el => el.classList.toggle('on', !!(m & (1 << +el.dataset.b))));
  dirEls.forEach(el => el.classList.toggle('on', !!(m & (1 << +el.dataset.d))));
}
for (const id of ['left', 'right']) {
  const el = $(id);
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch {}
    touchHeld.set(e.pointerId, { x: e.clientX, y: e.clientY, role: id }); recomputeTouch();
  });
}
window.addEventListener('pointermove', e => { const p = touchHeld.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; recomputeTouch(); } });
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, e => { if (touchHeld.delete(e.pointerId)) recomputeTouch(); });
['gesturestart', 'gesturechange', 'dblclick', 'contextmenu'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (!e.target.closest('#sheet')) e.preventDefault(); }, { passive: false });
// Touching the screen brings the on-screen controls back.
window.addEventListener('pointerdown', () => setMode('touch'), true);

function gamepadMask() {
  let m = 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const g of pads) {
    if (!g || !g.connected) continue;
    const b = i => g.buttons[i] && g.buttons[i].pressed;
    if (b(15) || g.axes[0] > 0.5) m |= 1; if (b(14) || g.axes[0] < -0.5) m |= 2;
    if (b(12) || g.axes[1] < -0.5) m |= 4; if (b(13) || g.axes[1] > 0.5) m |= 8;
    if (b(1) || b(3)) m |= 16; if (b(0) || b(2)) m |= 32; if (b(8)) m |= 64; if (b(9)) m |= 128;
  }
  return m;
}
function setMode(m) { if (m === mode) return; mode = m; $('app').dataset.mode = m; touchHeld.clear(); touchMask = 0; layout(); }

/* ---------------------------------------------------------- main loop
   Locked to the screen: every display refresh runs exactly one emulated frame (2 on a 30 Hz low-power
   display, every 2nd on 120 Hz). The refresh rate is measured over long windows of rAF timestamps and
   snapped to a standard rate, so jitter never causes a skipped or doubled frame. Games run at 60 fps
   (hardware: 59.73); audio absorbs the 0.45% difference. */
const TARGET_FPS = 60, SNAP = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
let last = 0, acc = 0, dispHz = 60, winT0 = 0, winN = 0, winBad = false;
let frames = 0, fpsT = 0, produced = 0, fillAvg = AUDIO_TARGET;

function measureRefresh(ts, dt) {
  if (dt > 100) winBad = true;
  if (!winN) { winT0 = ts; winBad = false; }
  if (++winN > 90) {
    if (!winBad) {
      const hz = (winN - 1) * 1000 / (ts - winT0);
      const s = SNAP.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
      dispHz = Math.abs(s - hz) / s < 0.02 ? s : hz;
    }
    winN = 0;
  }
}
function tuneAudio() {
  const a = gb.apu;
  if (!audio) { a.period = GB.CPU_HZ / a.rate; return; }
  fillAvg += (a.fill() - fillAvg) * 0.05;
  const err = Math.max(-1, Math.min(1, (fillAvg - AUDIO_TARGET) / AUDIO_TARGET));
  a.period = (GB.FRAME_CYCLES * TARGET_FPS / a.rate) * (1 + err * 0.01);
}
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = last ? ts - last : 1000 / 60; last = ts;
  measureRefresh(ts, dt);
  frames++; fpsT += dt;
  const gp = gamepadMask();
  if (gp & ~gpPrev) rumble();
  gpPrev = gp;
  if ((gp | kbMask) && mode !== 'ext' && !paused) setMode('ext');
  if (gb && !paused) {
    const mask = touchMask | kbMask | gp;
    gb.setPad(mask); showPressed(mask);
    let n = 0;
    if (ff) n = 4;
    else { acc += TARGET_FPS / dispHz; while (acc >= 0.999 && n < 4) { acc -= 1; n++; } if (acc > 4) acc = 0; }
    for (let i = 0; i < n; i++) { if (!ff) tuneAudio(); gb.runFrame(); }
    if (n) { present(); produced += n; }
    if (gb.ramDirty && ts - lastSave > 2000) { lastSave = ts; flushSave(); }
  }
  if (fpsT >= 1000) {
    if (showFps) $('fps').textContent = `${(produced * 1000 / fpsT).toFixed(1)} fps · display ${(frames * 1000 / fpsT).toFixed(1)} Hz` +
      (audio ? ` · audio ${audio.ctx.state}${gb ? ' buf ' + gb.apu.fill() : ''}` : ' · audio off');
    fpsT = 0; frames = 0; produced = 0; updateSnd();
  }
}
requestAnimationFrame(frame);

/* ---------------------------------------------------------- layout
   Touch mode: controls scale with the screen and sit low where thumbs rest; the LCD gets the rest.
   External-controller mode: no controls, LCD as big as the screen allows. Always a whole number of
   device pixels per LCD dot so the dot grid stays razor sharp. */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function layout() {
  const app = $('app'), cs = getComputedStyle(app), dpr = window.devicePixelRatio || 1, st = root.style;
  const W = app.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const land = W > H; app.dataset.land = land ? '1' : '0';
  let u, stageW, stageH;
  if (mode === 'ext') { u = 150; stageW = W; stageH = H; }
  else if (land) {
    u = clamp(Math.min(0.19 * W, 0.3 * H) * ctrlSize, 110, 280);
    const padw = u * 1.14 + 10, lift = ctrlLift * 0.2 * H;
    st.setProperty('--padw', padw + 'px'); st.setProperty('--lift', lift + 'px');
    stageW = W - 2 * padw - 8; stageH = H - 24;
  } else {
    u = clamp(Math.min(0.3 * W, 0.2 * H) * ctrlSize, 100, 280);
    const lift = ctrlLift * 0.06 * H, ctrlh = u * 1.5 + 8 + lift * 0.5;
    st.setProperty('--ctrlh', ctrlh + 'px'); st.setProperty('--lift', lift + 'px');
    stageW = W - 8; stageH = H - ctrlh - 16;
  }
  st.setProperty('--u', u + 'px');
  const fit = Math.min(stageW / 160, stageH / 144);
  kdev = Math.max(1, Math.floor(fit * dpr + 1e-6));
  const s = kdev / dpr;
  canvas.width = 160 * kdev; canvas.height = 144 * kdev;
  canvas.style.width = 160 * s + 'px'; canvas.style.height = 144 * s + 'px';
  st.setProperty('--s', s + 'px');
  makeGrid(); blit();
}
window.addEventListener('resize', layout); window.addEventListener('orientationchange', () => setTimeout(layout, 150));

/* ---------------------------------------------------------- menu */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 4500); }
function openMenu() { $('menu').classList.add('open'); paused = true; touchHeld.clear(); touchMask = 0; if (gb) flushSave(); refreshLibrary(); updateSnd(); }
function closeMenu() { $('menu').classList.remove('open'); paused = false; if (gb) gb.apu.flush(); }
$('menuBtn').addEventListener('click', openMenu);
$('closeMenu').addEventListener('click', closeMenu);
$('menu').addEventListener('click', e => { if (e.target.id === 'menu' && gb) closeMenu(); });
$('sndBtn').addEventListener('click', () => { beep(); });
$('testSnd').addEventListener('click', beep);

const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
async function refreshLibrary() {
  const el = $('library'); el.textContent = '';
  let names = [];
  try { names = (await romList()).sort(); } catch { el.innerHTML = '<div class="empty">Storage unavailable (private browsing?). Use “Add game” each time.</div>'; return; }
  if (!names.length) { el.innerHTML = '<div class="empty">No games yet. Add a ROM file and it will be kept here.</div>'; return; }
  for (const n of names) {
    const pretty = n.replace(/\.(gbc?|bin)$/i, '');
    const row = document.createElement('div'); row.className = 'item';
    const cart = document.createElement('div'); cart.className = 'cart'; cart.textContent = pretty.trim()[0] || '?'; cart.style.background = `hsl(${hue(n)} 38% 62%)`;
    const name = document.createElement('button'); name.className = 'name';
    name.append(pretty); if (n === romName) { const s = document.createElement('small'); s.textContent = 'Playing'; name.append(s); }
    name.onclick = async () => { const r = await romGet(n); if (r) startRom(n, r.data); };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete');
    del.onclick = async () => { if (confirm(`Delete “${pretty}” and its save data?`)) { await romDel(n); await saveDel(n); if (n === romName) { gb = null; romName = null; } refreshLibrary(); } };
    row.append(cart, name, del); el.append(row);
  }
}
async function loadFiles(files) {
  let first = null;
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length < 0x150) { toast(`${f.name}: not a Game Boy ROM`); continue; }
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) { toast(`${f.name}: unzip it first`); continue; }
    try { await romPut(f.name, bytes); } catch {}
    if (!first) first = [f.name, bytes];
  }
  if (first) startRom(first[0], first[1]);
}
$('file').addEventListener('change', e => { loadFiles([...e.target.files]); e.target.value = ''; });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files]); });

function bindSwitch(id, get, set) { const el = $(id); el.checked = get(); el.onchange = () => set(el.checked); }
$('csize').value = ctrlSize; $('clift').value = ctrlLift; $('vol').value = volume;
$('csize').oninput = e => { ctrlSize = +e.target.value; store.set('csize', ctrlSize); layout(); };
$('clift').oninput = e => { ctrlLift = +e.target.value; store.set('clift', ctrlLift); layout(); };
$('vol').oninput = e => { volume = +e.target.value; store.set('vol', volume); updateSnd(); };
bindSwitch('clickSw', () => clickFb, v => { clickFb = v; store.set('click', v); if (v) feedback(true); });
bindSwitch('fxSw', () => lcdFx, v => { lcdFx = v; store.set('fx', v); $('lcdbox').classList.toggle('plain', !v); blit(); });
bindSwitch('fpsSw', () => showFps, v => { showFps = v; store.set('fps', v); $('fps').style.display = v ? 'block' : 'none'; });
bindSwitch('ffSw', () => ff, v => { ff = v; });
$('lcdbox').classList.toggle('plain', !lcdFx); $('fps').style.display = showFps ? 'block' : 'none';
$('resetBtn').onclick = () => { if (gb) { flushSave(); const rn = romName; romGet(rn).then(r => r && startRom(rn, r.data)); } };

// Offline support (HTTPS / localhost only).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});

layout();
window.__gb = () => ({ gb, audio, dispHz, mode, kdev });

// Resume the last game (after a tap, so audio and fullscreen are allowed to start), otherwise show the menu.
(async () => {
  const n = store.get('last', null);
  try {
    const r = n && await romGet(n);
    if (r) {
      await startRom(n, r.data);
      paused = true; $('hint').textContent = 'TAP TO PLAY';
      const go = () => { paused = false; $('hint').textContent = ''; window.removeEventListener('pointerup', go); window.removeEventListener('keydown', go); };
      window.addEventListener('pointerup', go); window.addEventListener('keydown', go);
      return;
    }
  } catch {}
  $('hint').textContent = 'ADD A GAME';
  openMenu();
})();
})();
