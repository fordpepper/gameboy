'use strict';
(() => {
const $ = id => document.getElementById(id);
const canvas = $('lcd'), ctx = canvas.getContext('2d', { alpha: false });
const root = document.documentElement;
const APP_VERSION = '12';   // bump together with index.html (?v=) and sw.js; both players must match
const IS_IPAD = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------------------------------------------------- settings */
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); } catch {} },
};
// The four LCD shades of a DMG-01 (no backlight: muted olive greens, darkest shade not quite black).
const DMG = ['#9cb243', '#7b963f', '#4b6338', '#202f24'];
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toABGR = h => { const [r, g, b] = hex(h); return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; };
const PAL32 = new Uint32Array(DMG.map(toABGR));
let volume = store.get('vol', 0.8), ff = false, showFps = store.get('fps', false);
let lcdFx = store.get('fx', true), clickFb = store.get('click', true);
let ctrlSize = store.get('csize', 1), ctrlLift = store.get('clift', 0.35);
let ghostOn = store.get('ghost', true);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
   The canvas is just 160x144; the browser scales it (nearest-neighbour, whole device pixels), and the
   dot grid + bezel shadow are a static CSS overlay. So per frame we only upload 23k pixels, and only when
   something on screen actually changed (battery). Ghosting = slow liquid-crystal response, done by moving
   each pixel part-way to its new value over a few frames. */
const shown = new ImageData(160, 144);
const shown32 = new Uint32Array(shown.data.buffer);
let fb32 = null, glassDirty = true;
function resetGlass() { shown32.fill(PAL32[0]); ctx.putImageData(shown, 0, 0); }
resetGlass();
let blendK = 0.62;
function present() {
  const a = fb32, s = shown32, o = shown.data, K = blendK;
  let dirty = glassDirty;
  if (lcdFx && !ff) {
    for (let i = 0; i < 23040; i++) {
      const t = a[i]; if (t === s[i]) continue;
      dirty = true; const j = i << 2;
      o[j] += ((t & 255) - o[j]) * K; o[j + 1] += (((t >> 8) & 255) - o[j + 1]) * K; o[j + 2] += (((t >> 16) & 255) - o[j + 2]) * K;
    }
  } else {
    for (let i = 0; i < 23040; i++) if (a[i] !== s[i]) { s[i] = a[i]; dirty = true; }
  }
  if (dirty) { ctx.putImageData(shown, 0, 0); glassDirty = false; }
}
function makeGridImage(kdev) {
  if (kdev < 3) { $('lcdfx').style.backgroundImage = 'none'; return; }
  const t = document.createElement('canvas'); t.width = t.height = kdev;
  const c = t.getContext('2d'), lw = Math.max(1, Math.round(kdev * 0.125));
  c.fillStyle = 'rgba(28,42,12,.24)'; c.fillRect(kdev - lw, 0, lw, kdev); c.fillRect(0, kdev - lw, kdev, lw);
  $('lcdfx').style.backgroundImage = `url(${t.toDataURL()})`;
}

/* ---------------------------------------------------------- emulator state */
let gb = null, romName = null, curBytes = null, romHash = 0;
let paused = false, lastSave = 0;

async function flushSave() {
  if (!gb || !romName || !gb.ramDirty || mp.active) return;
  gb.ramDirty = false;
  try { await savePut(romName, gb.getSave()); } catch { gb.ramDirty = true; }
}
async function startRom(name, bytes, opts = {}) {
  await flushSave();
  const g = new GB(bytes);
  if (g.cgbOnly) { toast('This is a Game Boy Color-only game (not supported yet)'); return; }
  if (g.hasBattery && !opts.fresh) { try { const s = await saveGet(name); if (s) g.loadSave(s.data); } catch {} }
  gb = g; romName = name; curBytes = bytes; romHash = Net.fnv(bytes, 3);
  g.apu.setRate(audio ? audio.ctx.sampleRate : 44100);
  g.pal.set(PAL32);
  // Preview picture from a throw-away emulator so the real one stays at frame 0 (needed for netplay).
  const pv = new GB(bytes); pv.pal.set(PAL32); pv.runFrame(); fb32 = pv.fb; present(); fb32 = g.fb;
  $('hint').textContent = '';
  closeMenu();
  if (!opts.fresh) store.set('last', name);
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
        let pk = 0; for (let i = 0; i < L.length; i += 16) pk = Math.max(pk, Math.abs(L[i])); audio.peak = pk;
      };
      sp.connect(audio.gain); audio.gain.connect(c.destination);
      c.onstatechange = updateSnd;
      if (gb) { gb.apu.setRate(c.sampleRate); gb.apu.flush(); }
      fillAvg = AUDIO_TARGET;
    }
    if (!document.hidden && !paused && audio.ctx.state !== 'running') audio.ctx.resume().then(updateSnd, () => {});
  } catch (e) { console.warn('audio', e); }
  updateSnd();
}
let sndKey = '';
function updateSnd() {
  const ok = audio && audio.ctx.state === 'running';
  const sleeping = audio && paused && audio.ctx.state === 'suspended';
  const key = `${!!audio}|${ok}|${sleeping}|${volume === 0}|${audio ? audio.ctx.state : ''}`;
  if (key === sndKey) return; sndKey = key;
  $('sndBtn').classList.toggle('warn', !ok && !sleeping);
  $('sndWaves').style.display = ok && volume > 0 ? '' : 'none';
  $('sndStatus').textContent = !audio ? 'Not started. Tap anywhere or press Test beep.' : ok ? `Playing at ${audio.ctx.sampleRate} Hz` + (volume === 0 ? ' (volume is 0)' : '') : sleeping ? 'Sleeping while paused (saves battery)' : `Blocked (${audio.ctx.state}). Tap Test beep.`;
}
function beep() {
  unlockAudio(); if (!audio) return;
  audio.ctx.resume();
  const c = audio.ctx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2 * Math.max(0.2, volume), t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.27);
}
function onGesture() { unlockAudio(); goFullscreen(); }
['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(ev => window.addEventListener(ev, onGesture, { passive: true, capture: true }));

// Battery: when nothing is being played (page hidden, or menu open for a while) fade out and suspend the
// audio hardware; bring it back when play resumes.
let sleepT = 0;
function audioSleep(delay) {
  clearTimeout(sleepT);
  if (!audio) return;
  audio.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.012);
  sleepT = setTimeout(() => { if ((document.hidden || paused) && audio) audio.ctx.suspend().then(updateSnd, () => {}); }, delay);
}
function audioWake() {
  clearTimeout(sleepT);
  if (!audio) return;
  audio.ctx.resume().then(updateSnd, () => {});
  audio.gain.gain.setTargetAtTime(1, audio.ctx.currentTime, 0.03);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushSave(); releaseAllInputs(); audioSleep(120); }
  else { if (gb) gb.apu.flush(); if (!paused) audioWake(); kick(); }
});
window.addEventListener('pagehide', () => { flushSave(); releaseAllInputs(); });

/* ---------------------------------------------------------- fullscreen
   Touch devices (iPad): try to go fullscreen on the first tap (and the home-screen app is fullscreen anyway).
   Desktop: only if the browser window is already maximized, only once, and never again after you leave
   fullscreen yourself. */
const TOUCH_PRIMARY = matchMedia('(pointer: coarse)').matches;
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const windowMaximized = () => Math.abs(window.outerWidth - screen.availWidth) <= 16 && Math.abs(window.outerHeight - screen.availHeight) <= 16 && window.outerWidth > 0;
let fsDeclined = false, fsAutoTried = false;
function goFullscreen() {
  if (isFs() || isStandalone()) return;
  if (!TOUCH_PRIMARY) { if (fsDeclined || fsAutoTried || !windowMaximized()) return; fsAutoTried = true; }
  const el = root, f = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!f) return;
  try { const r = f.call(el, { navigationUI: 'hide' }); if (r && r.catch) r.catch(() => {}); } catch {}
}
if (TOUCH_PRIMARY) document.addEventListener('pointerup', function once() {
  document.removeEventListener('pointerup', once);
  setTimeout(() => { if (!isFs() && !isStandalone() && !store.get('fsHint', false)) { store.set('fsHint', true); toast('For true fullscreen: Share → Add to Home Screen, then open it from there.'); } }, 700);
});
const onFsChange = () => { if (!isFs() && fsAutoTried) fsDeclined = true; layout(); };
document.addEventListener('fullscreenchange', onFsChange); document.addEventListener('webkitfullscreenchange', onFsChange);

/* ---------------------------------------------------------- feedback (haptics / click)
   iPads have no vibration motor and Safari has no vibration API, so on an iPad the only physical-feeling
   feedback possible is sound (+ the visual press). Where hardware exists we use it at maximum strength:
   navigator.vibrate (Android), the iOS switch-haptic trick (iPhones only; skipped on iPad), and
   dual-rumble on connected gamepads. */
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
  if (!IS_IPAD) { try { hapl.click(); } catch {} }
  if (down) clickSound();
}
function rumble() {
  if (!clickFb) return;
  try {
    for (const g of navigator.getGamepads()) {
      const a = g && g.vibrationActuator;
      if (a && a.playEffect) a.playEffect('dual-rumble', { startDelay: 0, duration: 35, weakMagnitude: 1, strongMagnitude: 1 }).catch(() => {});
    }
  } catch {}
}

/* ---------------------------------------------------------- input */
const touchHeld = new Map(); // pointerId -> {x, y, role}
let touchMask = 0, kbMask = 0, shownMask = -1, gpPrev = 0, mode = 'touch', lastTouchT = 0, rects = null;
const KEYS = {
  ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, KeyD: 0, KeyA: 1, KeyW: 2, KeyS: 3,
  KeyX: 4, KeyK: 4, KeyZ: 5, KeyJ: 5, ShiftLeft: 6, ShiftRight: 6, Backspace: 6, Enter: 7, Space: 7,
};
window.addEventListener('keydown', e => {
  if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;   // typing a code, etc.
  if (e.code === 'Escape' || e.code === 'KeyM') { if ($('menu').classList.contains('open')) { if (gb) closeMenu(); } else openMenu(); e.preventDefault(); return; }
  if ($('menu').classList.contains('open')) return;
  const b = KEYS[e.code]; if (b === undefined) return; e.preventDefault(); kbMask |= 1 << b;
  if (performance.now() - lastTouchT > 1500) setMode('ext');
});
window.addEventListener('keyup', e => { const b = KEYS[e.code]; if (b === undefined) return; e.preventDefault(); kbMask &= ~(1 << b); });

const dpadEl = $('dpad'), dirEls = [...dpadEl.querySelectorAll('[data-d]')];
const btnEls = [...document.querySelectorAll('[data-b]')];
function getRects() {
  if (!rects) {
    const dr = dpadEl.getBoundingClientRect();
    rects = { dx: dr.left + dr.width / 2, dy: dr.top + dr.height / 2, u: dr.width, btns: btnEls.map(el => {
      const r = el.getBoundingClientRect(); return { bit: +el.dataset.b, pill: el.classList.contains('sm'), r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }) };
  }
  return rects;
}
// Any touch that starts in the left column steers the D-pad relative to its centre; buttons have a
// generous hit radius and the gap between A and B presses both (thumb rolling).
function recomputeTouch() {
  let m = 0;
  const R = getRects();
  for (const p of touchHeld.values()) {
    let hit = false;
    for (const b of R.btns) {
      const inside = b.pill ? (p.x >= b.r.left - 10 && p.x <= b.r.right + 10 && p.y >= b.r.top - 12 && p.y <= b.r.bottom + 12)
                            : Math.hypot(p.x - b.cx, p.y - b.cy) < b.r.width * 0.68;
      if (inside) { m |= 1 << b.bit; hit = true; }
    }
    if (!hit && p.role === 'left') {
      const dx = p.x - R.dx, dy = p.y - R.dy, d = Math.hypot(dx, dy);
      if (d > R.u * 0.16) {
        const rx = dx / d, ry = dy / d;
        if (rx > 0.4) m |= 1; if (rx < -0.4) m |= 2; if (ry < -0.4) m |= 4; if (ry > 0.4) m |= 8;
      }
    }
  }
  if (m & ~touchMask) feedback(true); else if (touchMask & ~m) feedback(false);
  touchMask = m;
}
function releaseAllInputs() { touchHeld.clear(); touchMask = 0; kbMask = 0; recomputeTouch(); }
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
  el.addEventListener('lostpointercapture', e => { if (touchHeld.delete(e.pointerId)) recomputeTouch(); });
}
window.addEventListener('pointermove', e => { const p = touchHeld.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; recomputeTouch(); } });
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, e => { if (touchHeld.delete(e.pointerId)) recomputeTouch(); });
// Safety net against a lost pointerup (iPadOS can swallow them during system gestures): whenever a finger
// leaves, drop any tracked pointer that no longer matches a finger actually on the screen.
function syncTouches(e) {
  const ts = e.touches;
  if (!ts.length) touchHeld.clear();
  else for (const [id, p] of touchHeld) {
    let near = false; for (const t of ts) if (Math.abs(t.clientX - p.x) < 90 && Math.abs(t.clientY - p.y) < 90) { near = true; break; }
    if (!near) touchHeld.delete(id);
  }
  recomputeTouch();
}
window.addEventListener('touchend', syncTouches, { passive: true }); window.addEventListener('touchcancel', syncTouches, { passive: true });
window.addEventListener('blur', releaseAllInputs);
['gesturestart', 'gesturechange', 'dblclick', 'contextmenu'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
document.addEventListener('touchmove', e => { if (!e.target.closest('#sheet')) e.preventDefault(); }, { passive: false });
// Touching the screen brings the on-screen controls back.
window.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') lastTouchT = performance.now(); setMode('touch'); }, true);

// Gamepads: only polled when one is connected (polling allocates every frame). Axes are measured relative to
// their resting value and only trusted on "standard" pads, so a quirky accessory can never fake a held direction.
let gpConnected = 0; const gpBase = new Map();
window.addEventListener('gamepadconnected', e => { gpConnected++; gpBase.delete(e.gamepad.index); });
window.addEventListener('gamepaddisconnected', e => { gpConnected = Math.max(0, gpConnected - 1); gpBase.delete(e.gamepad.index); });
function gamepadMask() {
  if (!gpConnected) return 0;
  let m = 0;
  for (const g of navigator.getGamepads()) {
    if (!g || !g.connected) continue;
    if (!gpBase.has(g.index)) gpBase.set(g.index, Array.from(g.axes));
    const base = gpBase.get(g.index), std = g.mapping === 'standard';
    const ax = i => (g.axes[i] || 0) - (base[i] || 0), b = i => g.buttons[i] && g.buttons[i].pressed;
    if (std) { if (b(15) || ax(0) > 0.6) m |= 1; if (b(14) || ax(0) < -0.6) m |= 2; if (b(12) || ax(1) < -0.6) m |= 4; if (b(13) || ax(1) > 0.6) m |= 8; }
    if (b(1) || b(3)) m |= 16; if (b(0) || b(2)) m |= 32; if (b(8)) m |= 64; if (b(9)) m |= 128;
  }
  return m;
}
function setMode(m) { if (m === mode) return; mode = m; $('app').dataset.mode = m; touchHeld.clear(); touchMask = 0; rects = null; layout(); }
const MASK_NAMES = ['→', '←', '↑', '↓', 'A', 'B', 'Sel', 'Start'];
const maskText = m => MASK_NAMES.filter((_, i) => m & (1 << i)).join(' ') || '–';

/* ---------------------------------------------------------- main loop
   Locked to the screen: every display refresh runs exactly one emulated frame (2 on a 30 Hz low-power
   display, every 2nd on 120 Hz). The refresh rate is measured over long windows of rAF timestamps and
   snapped to a standard rate, so jitter never causes a skipped or doubled frame. Games run at 60 fps
   (hardware: 59.73); audio absorbs the 0.45% difference. When paused the loop stops entirely (no wake-ups). */
const TARGET_FPS = 60, SNAP = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
let raf = 0, last = 0, acc = 0, dispHz = 60, smoothTicks = false;
let frames = 0, fpsT = 0, produced = 0, fillAvg = AUDIO_TARGET, lastMask = 0;
const PERF = { work: new Float32Array(600), dt: new Float32Array(600), i: 0, workMax: 0, late: 0, ticks: 0, multi: 0, skipped: 0 };
function kick() { if (!raf) { last = 0; dtWin.length = 0; raf = requestAnimationFrame(frame); } }

function applyRate() {
  const uneven = Math.abs(dispHz - TARGET_FPS) >= 3 && Math.abs(Math.round(dispHz / TARGET_FPS) - dispHz / TARGET_FPS) > 0.02 && dispHz > TARGET_FPS;
  smoothTicks = uneven && lcdFx;
  blendK = smoothTicks ? 1 - Math.pow(0.38, TARGET_FPS / dispHz) : 0.62;   // same total response time as at 60 Hz
}
const dtWin = [];
let pendingHz = 0;
function measureRefresh(ts, dt) {
  if (dt > 0 && dt < 100) dtWin.push(dt);                 // ignore huge gaps (tab switch, stall of a whole window)
  if (dtWin.length < 90) return;
  dtWin.sort((x, y) => x - y);
  const med = dtWin[dtWin.length >> 1]; dtWin.length = 0;  // median: a few stalls can't move it
  const hz = 1000 / med;
  if (!(hz > 20 && hz < 300)) return;
  const s = SNAP.reduce((x, y) => Math.abs(y - hz) < Math.abs(x - hz) ? y : x);
  const cand = Math.abs(s - hz) / s < 0.05 ? s : Math.round(hz * 10) / 10;
  if (cand === dispHz) { pendingHz = 0; return; }
  if (pendingHz === cand) { dispHz = cand; pendingHz = 0; acc = 0; applyRate(); }   // changed twice in a row: believe it
  else pendingHz = cand;
}
function tuneAudio() {
  const a = gb.apu;
  if (!audio) { a.period = GB.CPU_HZ / a.rate; return; }
  fillAvg += (a.fill() - fillAvg) * 0.05;
  const err = Math.max(-1, Math.min(1, (fillAvg - AUDIO_TARGET) / AUDIO_TARGET));
  a.period = (GB.FRAME_CYCLES * TARGET_FPS / a.rate) * (1 + err * 0.01);
}
function frame(ts) {
  raf = 0;
  if (paused || document.hidden) return;        // stop completely; kick() restarts it
  raf = requestAnimationFrame(frame);
  const dt = last ? ts - last : 1000 / 60; last = ts;
  const w0 = performance.now();
  measureRefresh(ts, dt);
  frames++; fpsT += dt;
  const gp = gamepadMask();
  if (gp & ~gpPrev) { rumble(); if (performance.now() - lastTouchT > 2500) setMode('ext'); }
  gpPrev = gp;
  if (gb) {
    const mask = touchMask | kbMask | gp; lastMask = mask;
    gb.setPad(mask); showPressed(mask);
    let n = 0;
    if (ff && !mp.active) n = 4;
    else if (Math.abs(dispHz - TARGET_FPS) < 3) n = 1;                      // ~60 Hz screen: exactly one frame per refresh, always
    else { acc += TARGET_FPS / dispHz; while (acc >= 0.999 && n < 4) { acc -= 1; n++; } if (acc > 4) acc = 0; }
    if (n > 1 && !ff && Math.abs(dispHz - TARGET_FPS) < 3) PERF.multi++;
    if (mp.active) {
      let adv = 0;
      for (let i = 0; i < n; i++) { if (mpStep(mask)) adv++; else { acc = 0; break; } }
      if (adv) {
        if (!lockstep() && mp.sinceSend >= CADENCE) { mp.sinceSend = 0; ghostCapture(); }
        mpGhost(); present(); produced += adv;
      }
    } else {
      for (let i = 0; i < n; i++) { if (!ff) tuneAudio(); gb.runFrame(); }
      if (n) { present(); produced += n; } else if (smoothTicks) present();
    }
    if (gb.ramDirty && ts - lastSave > 2000) { lastSave = ts; flushSave(); }
  }
  const work = performance.now() - w0, k = PERF.i++ % 600; PERF.work[k] = work; PERF.dt[k] = dt; PERF.ticks++;
  if (work > PERF.workMax) PERF.workMax = work; if (dt > 1.5 * 1000 / dispHz) PERF.late++;
  if (fpsT >= 1000) {
    if (showFps) $('fps').textContent = `${(produced * 1000 / fpsT).toFixed(1)} fps · display ${(frames * 1000 / fpsT).toFixed(1)} Hz · in: ${maskText(lastMask)}` +
      ` · work ${(PERF.work.reduce((s, x) => s + x, 0) / Math.min(600, PERF.ticks)).toFixed(1)}/${PERF.workMax.toFixed(1)} ms · late ${PERF.late}` +
      (audio ? ` · audio ${audio.ctx.state}${gb ? ' buf ' + gb.apu.fill() : ''}` : ' · audio off');
    fpsT = 0; frames = 0; produced = 0; updateSnd();
  }
}
kick();

/* ---------------------------------------------------------- layout
   Touch mode: controls scale with the screen and sit low where thumbs rest; the LCD gets the rest.
   External-controller mode: no controls, LCD as big as the screen allows. Always a whole number of
   device pixels per LCD dot so the dot grid stays razor sharp. */
let kdev = 4;
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
  const k = Math.max(1, Math.floor(fit * dpr + 1e-6)), s = k / dpr;
  canvas.style.width = 160 * s + 'px'; canvas.style.height = 144 * s + 'px';
  st.setProperty('--s', s + 'px');
  if (k !== kdev) { kdev = k; makeGridImage(k); }
  rects = null;
}
let layoutT = 0;
const relayout = () => { clearTimeout(layoutT); layoutT = setTimeout(layout, 60); };
window.addEventListener('resize', () => { relayout(); touchHeld.clear(); touchMask = 0; });
window.addEventListener('orientationchange', () => { relayout(); setTimeout(layout, 300); touchHeld.clear(); touchMask = 0; });

/* ---------------------------------------------------------- multiplayer (up to 8 players)
   Topology: a star. Everyone connects directly to the host over WebRTC; the host relays. Each client sends one
   stream and receives one stream, so per-player traffic doesn't grow with the number of players on the client side.
   Super Mario Land has no multiplayer of its own, so two kinds of session exist:

   RACE   Everybody plays their own game. Each player shares only a few bytes of state about their Mario
          (level, world position, pose) ~10x a second and only when it changed, and everyone sees the others as
          ghost Marios in their own world. Nothing is simulated for other players (no extra CPU/battery) and
          nothing can desync, so pausing is harmless: a paused player's ghost just stops.
   CO-OP  Everybody controls ONE Mario, in lockstep: all devices run the same game and exchange only controller
          inputs (batched, run-length encoded, binary). 'split' hands each player a share of the buttons
          (2 players: D-pad / buttons; up to 8: one button each); 'shared' lets everyone press everything.
          Lockstep means a paused player pauses the game for everyone (the screen says who we're waiting for).

   Data per player is tiny by design (a few hundred bytes/s). The "Low delay" option trades some of that for
   lower input delay (fewer, bigger batches vs. one message per frame). */
const MAXP = 8, GHOST_MS = 110, GHOST_STALE = 3000, CADENCE = 6;
const mp = { role: null, pid: 0, stage: 'idle', code: '', sub: null, peers: new Map(), pending: new Map(), nextPid: 1, guestPeer: null, guestId: '', pendingRom: null,
  lobby: [], seen: new Set(), mode: 'race', prio: 'data', active: false, players: [], D: 6, B: 4, flushMs: 0, frame: 0, queued: 0, sentUpTo: 0, runs: [], inp: {}, inMax: {}, dropFrom: {}, role8: {},
  outbox: [], flushT: 0, posT: 0, stall: 0, waiting: false, mine: {}, remote: {}, checks: 0, desync: false, manual: '',
  ghosts: new Map(), lastPos: '', lastPose: '', sentTile: [], sendCount: 0, sinceSend: 0, hostPos: new Map() };
const nameOf = pid => 'P' + (pid + 1);
const BTN_LABEL = ['Right', 'Left', 'Up', 'Down', 'A', 'B', 'Select', 'Start'];
const roleText = m => m === 0xFF ? 'everything' : BTN_LABEL.filter((_, i) => m & (1 << i)).join(', ');
// Which buttons each player owns in 'split' mode, by number of players.
const SPLIT = { 1: [0xFF], 2: [0x0F, 0xF0], 3: [0x0F, 0x10, 0xE0], 4: [0x03, 0x10, 0x20, 0xCC], 5: [0x02, 0x01, 0x10, 0x20, 0xCC], 6: [0x02, 0x01, 0x10, 0x20, 0x0C, 0xC0],
  7: [0x02, 0x01, 0x10, 0x20, 0x0C, 0x40, 0x80], 8: [0x02, 0x01, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80] };
const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const r16 = (u, o) => u[o] | (u[o + 1] << 8), r32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const isHost = () => mp.role === 'host';
const lockstep = () => mp.mode !== 'race';

function mpStatus(t) { $('mpStatus').textContent = t; }
function toHost(u8) { if (mp.guestPeer) mp.guestPeer.sendBin(u8); }
function toClients(u8, except = -1) { for (const [pid, p] of mp.peers) if (pid !== except) p.sendBin(u8); }
function jsonClients(o) { for (const p of mp.peers.values()) p.send(o); }

/* ---- UI ---- */
function renderPlayers() {
  const el = $('mpPlayers'); el.textContent = '';
  const ids = mp.active ? mp.players : mp.lobby;
  for (const pid of ids) {
    const row = document.createElement('div'); row.className = 'prow';
    const dot = document.createElement('i'); dot.textContent = pid + 1;
    const t = document.createElement('span'); t.textContent = (pid === mp.pid ? 'You' : nameOf(pid)) + (pid === 0 ? ' · host' : '');
    row.append(dot, t);
    if (mp.active && mp.mode === 'split') { const s = document.createElement('small'); s.textContent = roleText(mp.role8[pid]); row.append(s); }
    el.append(row);
  }
}
function mpUi() {
  const idle = !mp.role, host = isHost(), guest = mp.role === 'guest';
  const lobby = !!mp.role && !mp.active && mp.stage !== 'join';
  $('mpStop').hidden = idle; $('mpStop').textContent = host ? 'Close' : 'Leave';
  $('mpBtns').hidden = !idle;
  $('mpHostBox').hidden = !(host && !mp.active);
  $('mpJoinBox').hidden = !(guest && mp.stage === 'join');
  $('mpLobby').hidden = !(mp.role && mp.stage !== 'join');
  $('mpOptsRow').hidden = !(host && !mp.active);
  $('mpStartRow').hidden = !host;
  $('mpStart').hidden = mp.active; $('mpStart').disabled = mp.lobby.length < 2;
  $('mpRestart').hidden = !mp.active;
  $('mpGhostRow').hidden = !(mp.active && mp.mode === 'race');
  $('mpManual').hidden = !(idle || (host && !mp.active));
  $('mpAddM').hidden = !host; $('mpJoinM').hidden = !idle;
  if (!(host && mp.manual === 'add') && !(guest && mp.manual === 'join')) $('mpPanel').hidden = true;
  renderPlayers(); applyRoleUi();
}
function applyRoleUi() {
  const m = mp.active && mp.mode === 'split' ? mp.role8[mp.pid] : 0xFF;
  btnEls.forEach(el => el.classList.toggle('off', !(m & (1 << +el.dataset.b))));
  dirEls.forEach(el => el.classList.toggle('off', !(m & (1 << +el.dataset.d))));
}

/* ---- teardown ---- */
function mpClean() { if (mp.sub) { try { mp.sub(); } catch {} mp.sub = null; } }
function mpStopTimers() { clearInterval(mp.flushT); clearInterval(mp.posT); mp.flushT = mp.posT = 0; }
function mpEnd(msg) {
  mpClean(); mpStopTimers();
  if (mp.guestPeer) { try { mp.guestPeer.send({ t: 'bye' }); } catch {} const p = mp.guestPeer; setTimeout(() => p.close(), 50); }
  for (const p of [...mp.peers.values(), ...mp.pending.values()]) { try { p.send({ t: 'bye' }); } catch {} setTimeout(() => p.close(), 50); }
  Object.assign(mp, { role: null, pid: 0, stage: 'idle', code: '', peers: new Map(), pending: new Map(), nextPid: 1, guestPeer: null, pendingRom: null, lobby: [], active: false, players: [], waiting: false, manual: '', ghosts: new Map(), outbox: [] });
  $('hint').textContent = ''; mpStatus(msg || 'Not connected'); mpUi(); if (msg) toast(msg);
}

/* ---- host: lobby & peers ---- */
function broadcastLobby() { jsonClients({ t: 'lobby', players: mp.lobby, mode: mp.mode, prio: mp.prio }); mpUi(); mpStatus(`${mp.lobby.length} player${mp.lobby.length > 1 ? 's' : ''} in the lobby`); }
function hostMakePeer(joinId) {
  let pid = -1;
  const peer = new Net.Peer({
    open() { pid = mp.nextPid++; mp.peers.set(pid, peer); mp.pending.delete(joinId); peer.send({ t: 'hello', pid, rom: romHash, name: romName, ver: APP_VERSION }); },
    msg(m) {
      if (m.t === 'ready') { if (!mp.lobby.includes(pid)) mp.lobby.push(pid); broadcastLobby(); }
      else if (m.t === 'err') { toast(`${nameOf(pid)}: ${m.msg}`); peer.close(); }
      else if (m.t === 'pong') { if (peer._pr) peer._pr(performance.now() - m.ts); }
      else if (m.t === 'ds') toast(`${nameOf(pid)} reports the games went out of sync`);
      else if (m.t === 'bye') hostDrop(pid);
    },
    bin(u) { hostBin(pid, u); },
    state(s) { if (s === 'failed') { toast('A player couldn’t connect directly (their network may block it). Try manual codes or another network.'); mp.pending.delete(joinId); } },
    close() { hostDrop(pid); mp.pending.delete(joinId); },
  });
  return peer;
}
function hostDrop(pid) {
  if (pid < 0 || !mp.peers.has(pid)) return;
  const p = mp.peers.get(pid); mp.peers.delete(pid); try { p.close(); } catch {}
  mp.lobby = mp.lobby.filter(x => x !== pid); mp.ghosts.delete(pid);
  if (mp.active) {
    if (lockstep()) { mp.dropFrom[pid] = mp.inMax[pid] || 0; jsonClients({ t: 'drop', pid, f: mp.dropFrom[pid] }); }
    toast(`${nameOf(pid)} left`); renderPlayers();
    if (!mp.peers.size) mpEnd('Everyone else left');
  } else broadcastLobby();
}
function relayError(code) {
  mpStatus(code === 429 ? 'The free code service is rate-limited right now (it allows 60 requests per 5 minutes per network). Wait a few minutes, or use manual codes.'
    : code === -1 ? 'Gave up reaching the code service. Check your connection, or use manual codes.' : code ? `Code service error (${code}). Retrying…` : 'Can’t reach the code service. Retrying…');
}
async function hostOpenLobby() {
  if (!gb) { toast('Load a game first'); return; }
  mp.role = 'host'; mp.pid = 0; mp.stage = 'lobby'; mp.lobby = [0]; mp.seen = new Set(); mp.manual = ''; mp.code = Net.newCode();
  $('mpCode').textContent = fmtCode(mp.code); mpStatus('Opening lobby…'); mpUi();
  try {
    mp.sub = Net.subscribe(mp.code, async msg => {
      const k = msg[0], id = msg.slice(1, 5), rest = msg.slice(5);
      if (k === 'j') {
        if (mp.seen.has(id) || mp.peers.size + mp.pending.size >= MAXP - 1 || mp.active) return;
        mp.seen.add(id); const peer = hostMakePeer(id); mp.pending.set(id, peer);
        try { await Net.publish(mp.code, 'o' + id + await peer.host()); } catch (e) { mpStatus('Code service error: ' + e.message); }
      } else if (k === 'a') { const peer = mp.pending.get(id); if (peer) peer.accept(rest).catch(() => {}); }
    }, relayError);
    mpStatus('Lobby open. Friends enter the code to join (up to 7).');
  } catch (e) { mpEnd('Couldn’t reach the code service (' + e.message + '). Try “manual codes” below.'); }
}

/* ---- guest ---- */
function guestHandlers() {
  return {
    msg: async m => {
      switch (m.t) {
        case 'hello': {
          mp.pid = m.pid;
          if (m.ver !== APP_VERSION) { mp.guestPeer.send({ t: 'err', msg: `has app version ${APP_VERSION} but the host has ${m.ver}` }); mpEnd(`Your app version (${APP_VERSION}) differs from the host’s (${m.ver}). Close and reopen the app on both devices, then try again.`); return; }
          const r = await mpFindRom(m.rom);
          if (!r) { mp.guestPeer.send({ t: 'err', msg: `needs “${m.name}” (same ROM file)` }); mpEnd(`You don’t have “${m.name}”. Add the same ROM file first.`); return; }
          mp.pendingRom = r; mp.guestPeer.send({ t: 'ready' }); mp.stage = 'lobby'; mpStatus('Joined. Waiting for the host to start…'); mpUi(); break;
        }
        case 'lobby': mp.lobby = m.players; mp.mode = m.mode; mp.prio = m.prio; mpStatus(`In lobby (${m.players.length} players). Waiting for the host…`); mpUi(); break;
        case 'start': mpBegin(m); break;
        case 'ping': mp.guestPeer.send({ t: 'pong', ts: m.ts }); break;
        case 'h': mp.remote[m.f] = m.h; mpCheck(m.f); break;
        case 'drop': mp.dropFrom[m.pid] = m.f; mp.ghosts.delete(m.pid); mp.players = mp.players.filter(p => p !== m.pid || lockstep()); toast(`${nameOf(m.pid)} left`); break;
        case 'bye': mpEnd('The host closed the game'); break;
      }
    },
    bin: u => guestBin(u),
    close: () => { if (mp.guestPeer) mpEnd(mp.stage === 'active' ? 'Connection lost' : 'Couldn’t connect directly (a network may be blocking it). Try manual codes or another network.'); },
    state: s => { if (!mp.active && s === 'connecting') mpStatus('Connecting…'); },
  };
}
async function guestJoin(code) {
  mp.role = 'guest'; mp.stage = 'join'; mp.guestPeer = new Net.Peer(guestHandlers()); mp.guestId = Net.newCode().slice(0, 4);
  mpStatus('Looking for the host…'); mpUi(); let got = false;
  const timer = setTimeout(() => { if (!got) { mpEnd('No game found for that code. Check the code, that the host has the lobby open, and that you both run the same app version (' + APP_VERSION + ').'); } }, 20000);
  mp.sub = Net.subscribe(code, async msg => {
    if (msg[0] !== 'o' || msg.slice(1, 5) !== mp.guestId || got) return; got = true; clearTimeout(timer);
    try { mpStatus('Connecting…'); const ans = await mp.guestPeer.join(msg.slice(5)); await Net.publish(code, 'a' + mp.guestId + ans); }
    catch (e) { mpEnd('Couldn’t connect: ' + e.message); }
  }, relayError);
  try { await Net.publish(code, 'j' + mp.guestId); } catch (e) { clearTimeout(timer); mpEnd('Couldn’t reach the code service (' + e.message + ')'); }
}
async function mpFindRom(hash) {
  if (curBytes && romHash === hash) return { name: romName, bytes: curBytes };
  try { for (const n of await romList()) { const r = await romGet(n); if (r && Net.fnv(r.data, 3) === hash) return { name: n, bytes: r.data }; } } catch {}
  return null;
}

/* ---- start / restart (host decides everything, including the input delay) ---- */
async function pingPeer(peer) {
  const out = [];
  for (let i = 0; i < 6; i++) out.push(await new Promise(res => { peer._pr = res; peer.send({ t: 'ping', ts: performance.now() }); setTimeout(() => res(NaN), 1500); }));
  const ok = out.filter(x => x === x).sort((a, b) => a - b); return ok.length ? ok[ok.length >> 1] : 100;
}
async function hostStart() {
  if (mp.lobby.length < 2) return;
  mp.mode = $('mpMode').value; mp.prio = $('mpPrio').value;
  if (mp.mode === 'race' && !ghostSupported()) { toast('Race mode needs Super Mario Land (it draws the other players as ghosts). Pick a co-op mode for other games.'); return; }
  $('mpStart').disabled = true; $('mpRestart').disabled = true; mpStatus('Measuring connections…');
  const rtts = await Promise.all(mp.lobby.filter(p => p !== 0).map(p => pingPeer(mp.peers.get(p))));
  const n = mp.lobby.length, srt = rtts.slice().sort((a, b) => b - a);
  const owd = n === 2 ? srt[0] / 2 : (srt[0] + (srt[1] || 0)) / 2;   // worst client->host->client path
  const low = mp.prio === 'delay', B = low ? 1 : 4, flushMs = (low || n === 2) ? 0 : 33;
  const D = clamp(Math.ceil((owd + flushMs + 17) / 16.7) + B, 3, 24);
  const msg = { t: 'start', mode: mp.mode, prio: mp.prio, players: mp.lobby.slice(), D, B, flushMs };
  jsonClients(msg); mpBegin(msg);
  $('mpStart').disabled = false; $('mpRestart').disabled = false;
}
async function mpBegin(m) {
  mpStopTimers();
  Object.assign(mp, { mode: m.mode, prio: m.prio, players: m.players.slice(), D: m.D, B: m.B, flushMs: m.flushMs, frame: 0, stall: 0, waiting: false, desync: false, checks: 0,
    mine: {}, remote: {}, outbox: [], runs: [], inp: {}, inMax: {}, dropFrom: {}, role8: {}, ghosts: new Map(), lastPos: '', lastPose: '', sentTile: [], sendCount: 0, sinceSend: 0, hostPos: new Map() });
  const split = SPLIT[Math.min(8, m.players.length)];
  m.players.forEach((p, i) => { mp.role8[p] = m.mode === 'split' ? split[i] : 0xFF; });
  if (lockstep()) for (const p of m.players) { mp.inp[p] = {}; for (let f = 0; f < mp.D; f++) mp.inp[p][f] = 0; mp.inMax[p] = mp.D; mp.dropFrom[p] = Infinity; }
  mp.queued = mp.sentUpTo = mp.D;
  mp.active = false;
  const r = isHost() ? { name: romName, bytes: curBytes } : mp.pendingRom;
  await startRom(r.name, r.bytes, { fresh: true });
  camReset(); ff = false; $('ffSw').checked = false;
  mp.active = true; mp.stage = 'active'; paused = false; kick();
  if (isHost()) {
    if (lockstep() && mp.flushMs > 0) mp.flushT = setInterval(flushOutbox, mp.flushMs);
    if (!lockstep()) mp.posT = setInterval(hostPosTick, 100);
  }
  const mine = mp.role8[mp.pid];
  mpStatus(`${mp.mode === 'race' ? 'Race' : mp.mode === 'split' ? 'Co-op (split controls)' : 'Co-op (shared controls)'} · ${m.players.length} players` + (lockstep() ? ` · input delay ${mp.D} frames` : ''));
  mpUi();
  toast(mp.mode === 'race' ? 'Race! The other players are ghost Marios in your world.' : mp.mode === 'split' ? `Co-op: you control ${roleText(mine)}.` : 'Co-op: everyone controls everything.');
}

/* ---- lockstep co-op ---- */
function pushMask(m) { const r = mp.runs, l = r[r.length - 1]; if (l && l[1] === m && l[0] < 255) l[0]++; else r.push([1, m]); }
function flushLocal() {
  if (!mp.runs.length) return;
  const f0 = mp.sentUpTo, flat = []; let tot = 0;
  for (const [len, m] of mp.runs) { flat.push(len, m); tot += len; }
  mp.runs = []; mp.sentUpTo += tot;
  if (isHost()) { mp.outbox.push({ pid: 0, f0, n: flat.length >> 1, flat }); if (mp.flushMs === 0) flushOutbox(); }
  else toHost(new Uint8Array([0x10, ...u32(f0), flat.length >> 1, ...flat]));
}
function applyBatch(pid, f0, n, flat) {
  const inp = mp.inp[pid]; if (!inp) return; let f = f0;
  for (let i = 0; i < n; i++) { const len = flat[2 * i], m = flat[2 * i + 1]; for (let k = 0; k < len; k++) inp[f++] = m; }
  mp.inMax[pid] = Math.max(mp.inMax[pid] || 0, f);
}
function flushOutbox() {
  if (!mp.outbox.length) return;
  for (const [cid, peer] of mp.peers) {
    const bs = mp.outbox.filter(b => b.pid !== cid); if (!bs.length) continue;
    const a = [0x11, bs.length]; for (const b of bs) a.push(b.pid, ...u32(b.f0), b.n, ...b.flat);
    peer.sendBin(new Uint8Array(a));
  }
  mp.outbox = [];
}
function parseBatches(u, o, count, out) {
  for (let i = 0; i < count; i++) { const pid = u[o++], f0 = r32(u, o); o += 4; const n = u[o++]; const flat = Array.from(u.subarray(o, o + 2 * n)); o += 2 * n; out.push({ pid, f0, n, flat }); }
}
function mpStep(mask) {
  if (!lockstep()) { tuneAudio(); gb.runFrame(); camTrack(cam.me, gb); mp.sinceSend++; return true; }
  while (mp.queued < mp.frame + mp.D) { mp.inp[mp.pid][mp.queued] = mask; pushMask(mask); mp.queued++; if (mp.queued - mp.sentUpTo >= mp.B) flushLocal(); }
  const f = mp.frame; let comb = 0, miss = null;
  for (const p of mp.players) { const v = mp.inp[p][f]; if (v !== undefined) comb |= v & mp.role8[p]; else if (f < mp.dropFrom[p]) (miss || (miss = [])).push(p); }
  if (miss) {
    if (mp.stall === 0) flushLocal();                    // never sit on inputs the others may be waiting for
    if (++mp.stall === 30) { mp.waiting = true; $('hint').textContent = 'WAITING FOR ' + miss.map(nameOf).join(', ').toUpperCase() + '…'; }
    return false;
  }
  if (mp.waiting) { mp.waiting = false; $('hint').textContent = ''; }
  mp.stall = 0;
  gb.setPad(comb); tuneAudio(); gb.runFrame();
  for (const p of mp.players) delete mp.inp[p][f];
  if ((f + 1) % 240 === 0) {
    const h = Net.fnv(gb.fb);
    if (isHost()) jsonClients({ t: 'h', f, h }); else { mp.mine[f] = h; mpCheck(f); }
  }
  mp.frame++; return true;
}
function mpCheck(k) {
  if (mp.mine[k] === undefined || mp.remote[k] === undefined) return;
  mp.checks++;
  if (mp.mine[k] !== mp.remote[k] && !mp.desync) { mp.desync = true; toast('The games went out of sync. Ask the host to press Restart.'); if (mp.guestPeer) mp.guestPeer.send({ t: 'ds' }); }
  delete mp.mine[k]; delete mp.remote[k];
}

/* ---- ghosts (race) ----
   Camera = the background scroll register as used for the playfield (scanline 100), unwrapped across its 256
   wrap-arounds. A sprite's world X is camera + screen X. Mario is OAM slots 3..6 (small) up to 10 (big).
   World/level are read from the HUD digits. We send: POS {level, world X, Y, visible} (changes only, <= 10/s),
   POSE {sprites relative to Mario: dx, dy, tile, flags} (changes only) and TILE {16 bytes} the first time a tile
   is used. Receivers draw the sprites dithered (a different pattern per player) with a small player number. */
const cam = { me: { prev: -1, abs: 0 } };
function camReset() { cam.me.prev = -1; }
function camTrack(c, emu) {
  const cur = emu.scxLine[100];
  if (c.prev < 0) c.abs = cur;
  else { let d = (cur - c.prev) & 255; if (d > 128) d -= 256; if (Math.abs(d) > 8) c.abs = cur; else c.abs += d; }
  c.prev = cur;
}
const ghostSupported = () => !!gb && /MARIOLAND/i.test(gb.title.replace(/\s+/g, ''));
const lvl8 = e => ((e.vram[0x182C] & 15) << 4) | (e.vram[0x182E] & 15);
function ghostCapture() {
  const o = gb.oam, y3 = o[12], x3 = o[13];
  const vis = ghostSupported() && y3 > 0 && y3 < 160 && x3 > 0 && x3 < 168;
  const lv = lvl8(gb), x = (cam.me.abs + x3) & 0xFFFF, y = y3;
  const spr = [];
  if (vis) for (let i = 3; i <= 10; i++) {
    const yi = o[i * 4], xi = o[i * 4 + 1];
    if (!yi || yi >= 160 || xi - x3 > 12 || xi - x3 < -4 || yi - y3 < -4 || yi - y3 > 40) continue;
    spr.push((xi - x3) & 255, (yi - y3) & 255, o[i * 4 + 2], o[i * 4 + 3]);
  }
  const posKey = `${vis}|${lv}|${x}|${y}`, now = performance.now();
  if (posKey !== mp.lastPos || now - mp.lastSend > 1000) {
    mp.lastPos = posKey; mp.lastSend = now;
    if (isHost()) { mp.hostPos.set(0, { lv, x, y, fl: vis ? 1 : 0, dirty: true }); }
    else toHost(new Uint8Array([0x20, lv, x & 255, x >> 8, y, vis ? 1 : 0]));
  }
  const poseKey = spr.join(',');
  if (vis && poseKey !== mp.lastPose) {
    mp.lastPose = poseKey;
    for (let k = 0; k < spr.length; k += 4) {                       // send any tile graphics the others haven't seen yet
      const id = spr[k + 2], bytes = gb.vram.subarray(id * 16, id * 16 + 16), h = Net.fnv(bytes);
      if (mp.sentTile[id] !== h) { mp.sentTile[id] = h; relayOwn(0x24, [id, ...bytes]); }
    }
    relayOwn(0x22, [spr.length >> 2, ...spr]);
  }
}
// Own POSE/TILE: guests send type 0x22/0x24 to the host; the host broadcasts as 0x23/0x25 with pid 0.
function relayOwn(type, payload) {
  if (isHost()) toClients(new Uint8Array([type + 1, 0, ...payload]));
  else toHost(new Uint8Array([type, ...payload]));
}
function ghostOf(pid) { let g = mp.ghosts.get(pid); if (!g) { g = { init: false, cx: 0, cy: 0, tx: 0, ty: 0, t0: 0, lv: 0, vis: false, last: 0, spr: [], tiles: [] }; mp.ghosts.set(pid, g); } return g; }
function applyPos(pid, lv, x, y, fl) {
  const g = ghostOf(pid), now = performance.now();
  if (!g.init || g.lv !== lv || Math.abs(x - g.tx) > 90) { g.cx = x; g.cy = y; }
  else { const a = clamp((now - g.t0) / GHOST_MS, 0, 1); g.cx = g.cx + (g.tx - g.cx) * a; g.cy = g.cy + (g.ty - g.cy) * a; }
  g.tx = x; g.ty = y; g.t0 = now; g.lv = lv; g.vis = !!(fl & 1); g.last = now; g.init = true;
}
function applyGhostBin(pid, type, u, o) {          // type is the relayed form: 0x23 POSE, 0x25 TILE
  const g = ghostOf(pid);
  if (type === 0x23) { const n = u[o++]; g.spr = []; for (let i = 0; i < n; i++, o += 4) g.spr.push([(u[o] << 24) >> 24, (u[o + 1] << 24) >> 24, u[o + 2], u[o + 3]]); }
  else if (type === 0x25) g.tiles[u[o]] = u.slice(o + 1, o + 17);
}
function hostBin(pid, u) {
  switch (u[0]) {
    case 0x10: { const f0 = r32(u, 1), n = u[5], flat = Array.from(u.subarray(6, 6 + 2 * n)); applyBatch(pid, f0, n, flat); mp.outbox.push({ pid, f0, n, flat }); if (mp.flushMs === 0) flushOutbox(); break; }
    case 0x20: { const lv = u[1], x = r16(u, 2), y = u[4], fl = u[5]; mp.hostPos.set(pid, { lv, x, y, fl, dirty: true }); applyPos(pid, lv, x, y, fl); break; }
    case 0x22: case 0x24: { const rel = new Uint8Array(u.length + 1); rel[0] = u[0] + 1; rel[1] = pid; rel.set(u.subarray(1), 2); toClients(rel, pid); applyGhostBin(pid, u[0] + 1, rel, 2); break; }
  }
}
function guestBin(u) {
  switch (u[0]) {
    case 0x11: { const out = []; parseBatches(u, 2, u[1], out); for (const b of out) if (b.pid !== mp.pid) applyBatch(b.pid, b.f0, b.n, b.flat); break; }
    case 0x21: for (let i = 0, o = 2; i < u[1]; i++, o += 6) { const pid = u[o]; if (pid !== mp.pid) applyPos(pid, u[o + 1], r16(u, o + 2), u[o + 4], u[o + 5]); } break;
    case 0x23: case 0x25: if (u[1] !== mp.pid) applyGhostBin(u[1], u[0], u, 2); break;
  }
}
function hostPosTick() {
  const d = []; for (const [pid, s] of mp.hostPos) if (s.dirty) { s.dirty = false; d.push(pid, s.lv, s.x & 255, s.x >> 8, s.y, s.fl); }
  if (d.length) toClients(new Uint8Array([0x21, d.length / 6, ...d]));
}
const DIGITS = { 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111' };
const keepPx = (pat, x, y) => pat === 0 ? ((x + y) & 1) === 0 : pat === 1 ? ((x + y) & 1) === 1 : pat === 2 ? (y & 1) === 0 : pat === 3 ? (x & 1) === 0 : ((x + y) % 3) !== 0;
function mpGhost() {
  if (mp.mode !== 'race' || !ghostOn) return;
  const dst = gb.fb, now = performance.now(), mylv = lvl8(gb);
  for (const [pid, g] of mp.ghosts) {
    if (!g.vis || g.lv !== mylv || now - g.last > GHOST_STALE || !g.spr.length) continue;
    const a = clamp((now - g.t0) / GHOST_MS, 0, 1), wx = g.cx + (g.tx - g.cx) * a, wy = g.cy + (g.ty - g.cy) * a;
    const sx = Math.round(wx - cam.me.abs), sy = Math.round(wy), pat = pid % 5;
    for (let si = 0; si < g.spr.length; si++) {
      const sp = g.spr[si], dx = sp[0], dy = sp[1], tile = sp[2], fl = sp[3];
      const t = g.tiles[tile]; if (!t) continue;
      const px = sx + dx - 8, py = sy + dy - 16, pv = (fl & 0x10) ? gb.obp1 : gb.obp0;
      for (let r = 0; r < 8; r++) {
        const y = py + r; if (y < 0 || y >= 144) continue;
        const row = (fl & 0x40) ? 7 - r : r, lo = t[row * 2], hi = t[row * 2 + 1];
        for (let p = 0; p < 8; p++) {
          const x = px + p; if (x < 0 || x >= 160 || !keepPx(pat, x, y)) continue;
          const b = (fl & 0x20) ? p : 7 - p, ci = ((lo >> b) & 1) | (((hi >> b) & 1) << 1);
          if (ci) dst[y * 160 + x] = PAL32[(pv >> (ci * 2)) & 3];
        }
      }
    }
    // player number above the head
    const d = DIGITS[pid + 1]; if (d) for (let i = 0; i < 15; i++) if (d[i] === '1') { const x = sx - 4 + (i % 3), y = sy - 22 + ((i / 3) | 0); if (x >= 0 && x < 160 && y >= 0 && y < 144) dst[y * 160 + x] = PAL32[3]; }
  }
}

/* ---- connect UI ---- */
const fmtCode = c => c.slice(0, 3) + ' ' + c.slice(3);
async function copyText(t, btn) {
  try { await navigator.clipboard.writeText(t); } catch { const o = $('mpOut'); o.select(); document.execCommand('copy'); }
  if (btn) { const w = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = w, 1200); }
}
$('mpHost').onclick = hostOpenLobby;
$('mpJoin').onclick = () => { mp.role = 'guest'; mp.stage = 'join'; $('mpCodeIn').value = ''; mpStatus('Enter the host’s 6-character code'); mpUi(); setTimeout(() => $('mpCodeIn').focus(), 50); };
$('mpGo').onclick = () => {
  const code = Net.normCode($('mpCodeIn').value); if (code.length !== 6) { mpStatus('The code has 6 characters, e.g. K7Q X2M'); return; }
  guestJoin(code);
};
$('mpCodeIn').addEventListener('input', e => { const v = Net.normCode(e.target.value).slice(0, 6); e.target.value = v.length > 3 ? fmtCode(v) : v; });
$('mpCopyCode').onclick = e => copyText(mp.code || '', e.target);
if (navigator.share) $('mpShareCode').onclick = () => navigator.share({ text: `Join my Game Boy game: code ${fmtCode(mp.code || '')}` }).catch(() => {}); else $('mpShareCode').hidden = true;
$('mpStart').onclick = hostStart;
$('mpRestart').onclick = hostStart;
$('mpStop').onclick = () => mpEnd(isHost() ? 'Lobby closed' : 'You left');
// manual fallback (no code service): swap two long codes over any chat app
let manualPeer = null, manualId = '';
$('mpAddM').onclick = async () => {
  if (mp.peers.size + mp.pending.size >= MAXP - 1) { toast('Lobby is full'); return; }
  mp.manual = 'add'; manualId = 'm' + Math.random().toString(36).slice(2, 5); manualPeer = hostMakePeer(manualId); mp.pending.set(manualId, manualPeer);
  $('mpOut').value = ''; $('mpIn').value = ''; $('mpOutLbl').textContent = 'Step 1: send this code to your friend'; $('mpInLbl').textContent = 'Step 2: paste their reply code';
  $('mpPanel').hidden = false; mpStatus('Creating code…');
  try { $('mpOut').value = await manualPeer.host(); mpStatus('Waiting for your friend’s reply code'); } catch (e) { mpStatus('Could not create code: ' + e.message); }
};
$('mpJoinM').onclick = () => { mp.role = 'guest'; mp.stage = 'join'; mp.manual = 'join'; mp.guestPeer = new Net.Peer(guestHandlers());
  $('mpOut').value = ''; $('mpIn').value = ''; $('mpOutLbl').textContent = 'Step 2: send this reply code back to the host'; $('mpInLbl').textContent = 'Step 1: paste the host’s code';
  $('mpJoinBox').hidden = true; mpStatus('Paste the host’s code'); mpUi(); $('mpPanel').hidden = false; };
$('mpGoM').onclick = async () => {
  const code = $('mpIn').value.trim(); if (!code) return;
  try {
    if (mp.manual === 'join') { mpStatus('Creating reply…'); $('mpOut').value = await mp.guestPeer.join(code); mpStatus('Send your reply code to the host'); }
    else if (manualPeer) { mpStatus('Connecting…'); await manualPeer.accept(code); $('mpPanel').hidden = true; mp.manual = ''; }
  } catch (e) { mpStatus('That code didn’t work: ' + e.message); }
};
$('mpPaste').onclick = async () => { try { $('mpIn').value = await navigator.clipboard.readText(); } catch { $('mpIn').focus(); toast('Long-press the box and choose Paste'); } };
$('mpCopy').onclick = e => copyText($('mpOut').value, e.target);
if (navigator.share) $('mpShare').onclick = () => navigator.share({ text: $('mpOut').value }).catch(() => {}); else $('mpShare').hidden = true;

/* ---------------------------------------------------------- menu */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 4500); }
function openMenu() {
  $('menu').classList.add('open'); paused = true; releaseAllInputs(); if (gb) flushSave(); refreshLibrary(); updateSnd();
  if (mp.active && lockstep()) flushLocal();   // let the others run ahead on the inputs we already have
  audioSleep(mp.active ? 60000 : 4000);
}
function closeMenu() { if (updateReady && !mp.active) { location.reload(); return; } $('menu').classList.remove('open'); paused = false; if (gb) gb.apu.flush(); audioWake(); kick(); }
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
bindSwitch('fxSw', () => lcdFx, v => { lcdFx = v; store.set('fx', v); $('lcdbox').classList.toggle('plain', !v); glassDirty = true; });
bindSwitch('fpsSw', () => showFps, v => { showFps = v; store.set('fps', v); $('fps').style.display = v ? 'block' : 'none'; });
bindSwitch('ffSw', () => ff, v => { ff = v; glassDirty = true; });
bindSwitch('ghostSw', () => ghostOn, v => { ghostOn = v; store.set('ghost', v); });
$('lcdbox').classList.toggle('plain', !lcdFx); $('fps').style.display = showFps ? 'block' : 'none';
$('resetBtn').onclick = () => { if (gb) { flushSave(); const rn = romName; romGet(rn).then(r => r && startRom(rn, r.data)); } };

// Offline support (HTTPS / localhost only).
let updateReady = false;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  // A new version took over: reload when it's safe (nothing running), otherwise on the next time the menu opens.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    updateReady = true; if (!mp.active && (paused || !gb)) location.reload(); else toast('A new version is ready. Open the menu and tap Done to update.');
  });
}

$('ver').textContent = 'Version ' + APP_VERSION;
mpUi(); layout();
window.__gb = () => ({ gb, audio, dispHz, mode, kdev, mp, cam, touchMask, ghosts: mp.ghosts, PERF });

// Resume the last game (after a tap, so audio and fullscreen are allowed to start), otherwise show the menu.
(async () => {
  const n = store.get('last', null);
  try {
    const r = n && await romGet(n);
    if (r) {
      await startRom(n, r.data);
      paused = true; $('hint').textContent = 'TAP TO PLAY';
      const go = () => { paused = false; $('hint').textContent = ''; window.removeEventListener('pointerup', go); window.removeEventListener('keydown', go); audioWake(); kick(); };
      window.addEventListener('pointerup', go); window.addEventListener('keydown', go);
      return;
    }
  } catch {}
  $('hint').textContent = 'ADD A GAME';
  openMenu();
})();
})();
