'use strict';
(() => {
const $ = id => document.getElementById(id);
const canvas = $('lcd'), ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const root = document.documentElement;
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
let ghostOn = store.get('ghost', true), oppWin = store.get('oppwin', false);
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
function present() {
  const a = fb32, s = shown32, o = shown.data;
  let dirty = glassDirty;
  if (lcdFx && !ff) {
    for (let i = 0; i < 23040; i++) {
      const t = a[i]; if (t === s[i]) continue;
      dirty = true; const j = i << 2;
      o[j] += ((t & 255) - o[j]) * 0.62; o[j + 1] += (((t >> 8) & 255) - o[j + 1]) * 0.62; o[j + 2] += (((t >> 16) & 255) - o[j + 2]) * 0.62;
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
function updateSnd() {
  const ok = audio && audio.ctx.state === 'running';
  const sleeping = audio && paused && audio.ctx.state === 'suspended';
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
  setTimeout(() => { if (!isFs() && !isStandalone() && !store.get('fsHint', false)) { store.set('fsHint', true); toast('For true fullscreen: Share → Add to Home Screen, then open it from there.'); } }, 700);
});
document.addEventListener('fullscreenchange', () => layout()); document.addEventListener('webkitfullscreenchange', () => layout());

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
let raf = 0, last = 0, acc = 0, dispHz = 60, winT0 = 0, winN = 0, winBad = false;
let frames = 0, fpsT = 0, produced = 0, fillAvg = AUDIO_TARGET, lastMask = 0;
function kick() { if (!raf) { last = 0; winN = 0; raf = requestAnimationFrame(frame); } }

function measureRefresh(ts, dt) {
  if (dt > 100) winBad = true;
  if (!winN) { winT0 = ts; winBad = false; }
  if (++winN > 90) {
    if (!winBad) {
      const hz = (winN - 1) * 1000 / (ts - winT0);
      if (hz > 20 && hz < 300) {
        const s = SNAP.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
        dispHz = Math.abs(s - hz) / s < 0.02 ? s : hz;
      }
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
  raf = 0;
  if (paused || document.hidden) return;        // stop completely; kick() restarts it
  raf = requestAnimationFrame(frame);
  const dt = last ? ts - last : 1000 / 60; last = ts;
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
    else { acc += TARGET_FPS / dispHz; while (acc >= 0.999 && n < 4) { acc -= 1; n++; } if (acc > 4) acc = 0; }
    if (mp.active) {
      let adv = 0;
      for (let i = 0; i < n; i++) { if (mpStep(mask)) adv++; else { acc = 0; break; } }
      mpOpp(); if (adv) mpGhost();
      if (adv) { present(); produced += adv; }
    } else {
      for (let i = 0; i < n; i++) { if (!ff) tuneAudio(); gb.runFrame(); }
      if (n) { present(); produced += n; }
    }
    if (gb.ramDirty && ts - lastSave > 2000) { lastSave = ts; flushSave(); }
  }
  if (fpsT >= 1000) {
    if (showFps) $('fps').textContent = `${(produced * 1000 / fpsT).toFixed(1)} fps · display ${(frames * 1000 / fpsT).toFixed(1)} Hz · in: ${maskText(lastMask)}` +
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
  rects = null; mpLayout(dpr);
}
let layoutT = 0;
const relayout = () => { clearTimeout(layoutT); layoutT = setTimeout(layout, 60); };
window.addEventListener('resize', () => { relayout(); touchHeld.clear(); touchMask = 0; });
window.addEventListener('orientationchange', () => { relayout(); setTimeout(layout, 300); touchHeld.clear(); touchMask = 0; });

/* ---------------------------------------------------------- multiplayer
   Super Mario Land has no multiplayer of its own, so this is netplay around the single-player game.
   Both devices run the same ROM from a cold start and only exchange controller inputs (the emulator is
   deterministic, so identical inputs give identical games). Modes:
     race    each player plays their own Mario; the other player's game is replayed on a second emulator and,
             in Super Mario Land, shown as a ghost Mario in your world (plus an optional picture-in-picture)
     split   both control ONE Mario in lockstep: host = D-pad, guest = A/B/Start/Select
     shared  both control ONE Mario in lockstep, every button works for both
   Periodic screen checksums are exchanged to detect desyncs. */
const mp = { peer: null, role: null, mode: 'race', active: false, D: 4, frame: 0, queued: 0, stall: 0, waiting: false, desync: false, sub: null, stage: '',
  hostIn: {}, guestIn: {}, opp: null, oppImg: null, oppIn: [], oppFrame: 0, oppRecv: 0, mine: {}, remote: {}, rtts: [], pendingRom: null, checks: 0 };
const oppCanvas = $('opp'), oppCtx = oppCanvas.getContext('2d', { alpha: false });
const MODE_NAMES = { race: 'Race', split: 'Co-op (split controls)', shared: 'Co-op (shared controls)' };
const mpSend = o => mp.peer && mp.peer.send(o);
function mpStatus(t) { $('mpStatus').textContent = t; }
function mpUi() {
  const live = mp.active || (mp.peer && mp.peer.open);
  const idle = !mp.peer;
  $('mpStop').hidden = idle; $('mpModeRow').hidden = $('mpBtns').hidden = !idle;
  $('mpHostBox').hidden = !(mp.peer && !live && mp.stage === 'host');
  $('mpJoinBox').hidden = !(mp.peer && !live && mp.stage === 'join');
  $('mpPanel').hidden = !(mp.peer && !live && (mp.stage === 'mhost' || mp.stage === 'mjoin'));
  $('mpManual').hidden = !idle;
  $('mpGhostRow').hidden = $('mpWinRow').hidden = !(mp.active && mp.mode === 'race');
}
function mpClean() { if (mp.sub) { try { mp.sub(); } catch {} mp.sub = null; } }
function mpEnd(msg) {
  const was = mp.peer; mpClean();
  if (was) { try { was.send({ t: 'bye' }); } catch {} setTimeout(() => was.close(), 50); }
  mp.peer = null; mp.active = false; mp.opp = null; mp.oppImg = null; mp.waiting = false; mp.stage = '';
  $('oppbox').hidden = true; $('hint').textContent = '';
  mpStatus(msg || 'Not connected'); mpUi(); if (msg) toast(msg);
}
function mpNew() {
  mpClean();
  Object.assign(mp, { active: false, frame: 0, queued: 0, stall: 0, waiting: false, desync: false, hostIn: {}, guestIn: {}, opp: null, oppIn: [], oppFrame: 0, oppRecv: 0, mine: {}, remote: {}, rtts: [], pendingRom: null, checks: 0 });
  mp.peer = new Net.Peer({
    open: () => { mpClean(); mpStatus('Connected. Checking game…'); mpUi(); if (mp.role === 'host') mpSend({ t: 'hello', rom: romHash, name: romName, mode: mp.mode }); },
    msg: mpMsg,
    close: () => { if (mp.peer) mpEnd('Connection lost'); },
    state: s => { if (!mp.active && s === 'connecting') mpStatus('Connecting…'); },
  });
}
async function mpFindRom(hash) {
  if (curBytes && romHash === hash) return { name: romName, bytes: curBytes };
  try { for (const n of await romList()) { const r = await romGet(n); if (r && Net.fnv(r.data, 3) === hash) return { name: n, bytes: r.data }; } } catch {}
  return null;
}
async function mpMsg(m) {
  switch (m.t) {
    case 'hello': {
      mp.mode = m.mode;
      const r = await mpFindRom(m.rom);
      if (!r) { mpSend({ t: 'err', msg: 'Your friend needs the same game' }); mpEnd(`You don’t have “${m.name}” (same ROM file needed)`); return; }
      mp.pendingRom = r; mpSend({ t: 'ready' }); mpStatus('Game found. Waiting for host…'); break;
    }
    case 'err': mpEnd(m.msg); break;
    case 'ready': mpStatus('Measuring connection…'); mpSend({ t: 'ping', n: 0, ts: performance.now() }); break;
    case 'ping': mpSend({ t: 'pong', n: m.n, ts: m.ts }); break;
    case 'pong': {
      mp.rtts.push(performance.now() - m.ts);
      if (mp.rtts.length < 6) { mpSend({ t: 'ping', n: mp.rtts.length, ts: performance.now() }); break; }
      const r = mp.rtts.slice().sort((a, b) => a - b)[3];
      mp.D = clamp(Math.ceil(r / 2 / 16.7) + 2, 3, 12);
      mpSend({ t: 'start', mode: mp.mode, D: mp.D, rtt: r }); mpBegin(); break;
    }
    case 'start': mp.mode = m.mode; mp.D = m.D; mpBegin(); break;
    case 'i':
      if (mp.mode === 'race') { mp.oppIn[m.f] = m.m; mp.oppRecv = Math.max(mp.oppRecv, m.f + 1); }
      else (mp.role === 'host' ? mp.guestIn : mp.hostIn)[m.f] = m.m;
      break;
    case 'h': mp.remote[m.f] = m.h; mpCheck(m.f); break;
    case 'bye': mpEnd('Your friend disconnected'); break;
  }
}
async function mpBegin() {
  mp.frame = 0; mp.stall = 0; mp.desync = false; mp.mine = {}; mp.remote = {};
  if (mp.mode !== 'race') { for (let i = 0; i < mp.D; i++) { mp.hostIn[i] = 0; mp.guestIn[i] = 0; } mp.queued = mp.D; }
  const r = mp.role === 'host' ? { name: romName, bytes: curBytes } : mp.pendingRom;
  mp.active = false;
  await startRom(r.name, r.bytes, { fresh: true });
  camReset();
  if (mp.mode === 'race') {
    mp.opp = new GB(r.bytes); mp.opp.pal.set(PAL32); mp.oppImg = new ImageData(new Uint8ClampedArray(mp.opp.fb.buffer), 160, 144);
    oppCtx.fillStyle = DMG[0]; oppCtx.fillRect(0, 0, 160, 144); updateOppBox();
  }
  ff = false; $('ffSw').checked = false;
  mp.active = true; paused = false; kick();
  mpStatus(`${MODE_NAMES[mp.mode]} · delay ${mp.mode === 'race' ? 0 : mp.D} frames`); mpUi();
  toast(mp.mode === 'race' ? (ghostSupported() ? 'Race! Your friend is the ghost Mario.' : 'Race! Your friend’s screen is in the corner.')
    : mp.role === 'host' ? (mp.mode === 'split' ? 'Co-op: you steer (D-pad), your friend jumps and runs (A/B).' : 'Co-op started.') : (mp.mode === 'split' ? 'Co-op: you have the buttons, your friend steers.' : 'Co-op started.'));
}
function mpCheck(k) {
  if (mp.mine[k] === undefined || mp.remote[k] === undefined) return;
  mp.checks++;
  if (mp.mine[k] !== mp.remote[k] && !mp.desync) { mp.desync = true; toast('The two games went out of sync. Disconnect and start again.'); }
  delete mp.mine[k]; delete mp.remote[k];
}
// Local game advanced one frame; share/compare checksums every 120 frames.
function mpHash(frameIdx, emu, mirrored) {
  if ((frameIdx + 1) % 120) return;
  const h = Net.fnv(emu.fb);
  if (mirrored) { mp.mine[frameIdx] = h; mpCheck(frameIdx); } else mpSend({ t: 'h', f: frameIdx, h });
}
function mpStep(mask) {
  if (mp.mode === 'race') {
    gb.setPad(mask); mpSend({ t: 'i', f: mp.frame, m: mask });
    tuneAudio(); gb.runFrame(); camTrack(cam.me, gb); mpHash(mp.frame, gb, false); mp.frame++; return true;
  }
  const mine = mp.role === 'host' ? mp.hostIn : mp.guestIn;
  while (mp.queued < mp.frame + mp.D) { mine[mp.queued] = mask; mpSend({ t: 'i', f: mp.queued, m: mask }); mp.queued++; }
  const hm = mp.hostIn[mp.frame], gm = mp.guestIn[mp.frame];
  if (hm === undefined || gm === undefined) {
    if (++mp.stall === 40) { mp.waiting = true; $('hint').textContent = 'WAITING FOR PARTNER…'; }
    return false;
  }
  if (mp.waiting) { mp.waiting = false; $('hint').textContent = ''; }
  mp.stall = 0;
  gb.setPad(mp.mode === 'split' ? ((hm & 0x0F) | (gm & 0xF0)) : (hm | gm));
  tuneAudio(); gb.runFrame();
  delete mp.hostIn[mp.frame]; delete mp.guestIn[mp.frame];
  mpHash(mp.frame, gb, false); mpHash(mp.frame, gb, true);
  mp.frame++; return true;
}
// Race: replay the friend's inputs on a second emulator, a few frames behind to absorb network jitter.
function mpOpp() {
  if (!mp.opp) return;
  const avail = mp.oppRecv - mp.oppFrame;
  const k = avail > 60 ? 8 : avail > 30 ? 4 : avail > 6 ? 2 : avail >= 2 ? 1 : 0;
  for (let i = 0; i < k; i++) {
    mp.opp.setPad(mp.oppIn[mp.oppFrame] | 0); mp.opp.runFrame(); camTrack(cam.opp, mp.opp);
    mpHash(mp.oppFrame, mp.opp, true);
    mp.oppIn[mp.oppFrame] = undefined; mp.oppFrame++;
  }
  if (k && !$('oppbox').hidden) oppCtx.putImageData(mp.oppImg, 0, 0);
}

/* ---- ghost: your friend's Mario drawn into your world (Super Mario Land)
   Camera position = the background scroll register as used for the playfield (scanline 100), unwrapped across its 256 wrap-arounds. A sprite's
   world X is camera + screen X, so a friend sprite shows up at (friendCamera - myCamera + its screen X).
   Mario is OAM slots 3..6 (small) or up to 10 (big). Shown only when both are in the same level (read from
   the world/level digits on the HUD). Drawn dithered after the checksum, so it never affects sync. */
const cam = { me: { prev: -1, abs: 0 }, opp: { prev: -1, abs: 0 } };
function camReset() { cam.me.prev = cam.opp.prev = -1; }
function camTrack(c, emu) {
  const cur = emu.scxLine[100];
  if (c.prev < 0) c.abs = cur;
  else { let d = (cur - c.prev) & 255; if (d > 128) d -= 256; if (Math.abs(d) > 8) c.abs = cur; else c.abs += d; }
  c.prev = cur;
}
const ghostSupported = () => !!gb && /MARIOLAND/i.test(gb.title.replace(/\s+/g, ''));
const levelOf = e => (e.vram[0x182C] << 8) | e.vram[0x182E];
function mpGhost() {
  if (mp.mode !== 'race' || !mp.opp || !ghostOn || !ghostSupported()) return;
  const o = mp.opp, m = gb;
  if (levelOf(o) !== levelOf(m) || !m.oam[12] || !o.oam[12]) return;
  const dx = cam.opp.abs - cam.me.abs, ox = o.oam[13], oy = o.oam[12];
  for (let i = 3; i <= 10; i++) {
    const y = o.oam[i * 4], x = o.oam[i * 4 + 1];
    if (!y || y >= 160 || x - ox > 12 || x - ox < -4 || y - oy < -4 || y - oy > 40) continue;
    o.drawGhostSprite(i, m.fb, dx, PAL32);
  }
}
function updateOppBox() { $('oppbox').hidden = !(mp.opp && (oppWin || !ghostSupported() || !ghostOn)); mpLayout(); }
function mpLayout(dpr = window.devicePixelRatio || 1) {
  // Use the empty margin beside the LCD when it's wide enough (no overlap); otherwise a small corner overlay.
  const margin = (window.innerWidth - 160 * kdev / dpr) / 2 - 20;
  let k = Math.floor(margin * dpr / 160); if (k < 2) k = Math.max(1, Math.round(kdev * 0.4));
  const s = k / dpr;
  oppCanvas.style.width = 160 * s + 'px'; oppCanvas.style.height = 144 * s + 'px';
}

// --- connect UI (6-character code via relay; manual long codes as a fallback)
async function copyText(t, btn) {
  try { await navigator.clipboard.writeText(t); } catch { const o = $('mpOut'); o.select(); document.execCommand('copy'); }
  if (btn) { const w = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = w, 1200); }
}
const fmtCode = c => c.slice(0, 3) + ' ' + c.slice(3);
$('mpHost').onclick = async () => {
  if (!gb) { toast('Load a game first'); return; }
  mp.role = 'host'; mp.mode = $('mpMode').value; mpNew(); mp.stage = 'host';
  const code = Net.newCode(); $('mpCode').textContent = fmtCode(code); mp.code = code;
  mpStatus('Creating code…'); mpUi();
  try {
    const offer = await mp.peer.host();
    mp.sub = Net.subscribe(code, msg => { if (msg[0] === 'a' && mp.peer && !mp.peer.open) { mpClean(); mp.peer.accept(msg.slice(1)).catch(e => mpStatus('Connect failed: ' + e.message)); mpStatus('Friend found, connecting…'); } },
      () => mpStatus('Reconnecting to the code service…'));
    await Net.publish(code, 'o' + offer);
    mpStatus('Waiting for your friend. They enter the code on their device.');
  } catch (e) { mpEnd('Couldn’t reach the code service (' + e.message + '). Try “manual codes” below.'); }
};
$('mpJoin').onclick = () => { mp.role = 'guest'; mpNew(); mp.stage = 'join'; $('mpCodeIn').value = ''; mpStatus('Enter the host’s 6-character code'); mpUi(); setTimeout(() => $('mpCodeIn').focus(), 50); };
$('mpGo').onclick = async () => {
  const code = Net.normCode($('mpCodeIn').value); if (code.length !== 6 || !mp.peer) { mpStatus('The code has 6 characters, e.g. K7Q X2M'); return; }
  mpStatus('Looking for the host…'); let got = false;
  const timer = setTimeout(() => { if (!got) { mpClean(); mpStatus('No game found for that code. Check the code and that the host is waiting.'); } }, 20000);
  mp.sub = Net.subscribe(code, async msg => {
    if (msg[0] !== 'o' || got) return; got = true; clearTimeout(timer); mpClean();
    try { mpStatus('Connecting…'); const ans = await mp.peer.join(msg.slice(1)); await Net.publish(code, 'a' + ans); }
    catch (e) { mpEnd('Couldn’t connect: ' + e.message); }
  }, () => mpStatus('Can’t reach the code service. Try “manual codes” below.'));
};
$('mpCodeIn').addEventListener('input', e => { const v = Net.normCode(e.target.value).slice(0, 6); e.target.value = v.length > 3 ? fmtCode(v) : v; });
$('mpCopyCode').onclick = e => copyText(mp.code || '', e.target);
if (navigator.share) $('mpShareCode').onclick = () => navigator.share({ text: `Join my Game Boy game: code ${fmtCode(mp.code || '')}` }).catch(() => {}); else $('mpShareCode').hidden = true;
// manual fallback (no relay): swap two long codes over any chat app
$('mpHostM').onclick = async () => {
  if (!gb) { toast('Load a game first'); return; }
  mp.role = 'host'; mp.mode = $('mpMode').value; mpNew(); mp.stage = 'mhost';
  $('mpOut').value = ''; $('mpIn').value = ''; $('mpOutLbl').textContent = 'Step 1: send this code to your friend'; $('mpInLbl').textContent = 'Step 2: paste your friend’s reply code';
  mpStatus('Creating code…'); mpUi();
  try { $('mpOut').value = await mp.peer.host(); mpStatus('Waiting for your friend’s reply code'); } catch (e) { mpEnd('Could not create code: ' + e.message); }
};
$('mpJoinM').onclick = () => { mp.role = 'guest'; mpNew(); mp.stage = 'mjoin'; $('mpOut').value = ''; $('mpIn').value = '';
  $('mpOutLbl').textContent = 'Step 2: send this reply code back to the host'; $('mpInLbl').textContent = 'Step 1: paste the host’s code'; mpStatus('Paste the host’s code'); mpUi(); };
$('mpGoM').onclick = async () => {
  const code = $('mpIn').value.trim(); if (!code || !mp.peer) return;
  try {
    if (mp.stage === 'mjoin') { mpStatus('Creating reply…'); $('mpOut').value = await mp.peer.join(code); mpStatus('Send your reply code to the host'); }
    else { mpStatus('Connecting…'); await mp.peer.accept(code); }
  } catch (e) { mpStatus('That code didn’t work: ' + e.message); }
};
$('mpPaste').onclick = async () => { try { $('mpIn').value = await navigator.clipboard.readText(); } catch { $('mpIn').focus(); toast('Long-press the box and choose Paste'); } };
$('mpCopy').onclick = e => copyText($('mpOut').value, e.target);
if (navigator.share) $('mpShare').onclick = () => navigator.share({ text: $('mpOut').value }).catch(() => {}); else $('mpShare').hidden = true;
$('mpStop').onclick = () => mpEnd('Disconnected');

/* ---------------------------------------------------------- menu */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 4500); }
function openMenu() {
  $('menu').classList.add('open'); paused = true; releaseAllInputs(); if (gb) flushSave(); refreshLibrary(); updateSnd();
  audioSleep(mp.active ? 60000 : 4000);
}
function closeMenu() { $('menu').classList.remove('open'); paused = false; if (gb) gb.apu.flush(); audioWake(); kick(); }
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
bindSwitch('ghostSw', () => ghostOn, v => { ghostOn = v; store.set('ghost', v); updateOppBox(); });
bindSwitch('winSw', () => oppWin, v => { oppWin = v; store.set('oppwin', v); updateOppBox(); });
$('lcdbox').classList.toggle('plain', !lcdFx); $('fps').style.display = showFps ? 'block' : 'none';
$('resetBtn').onclick = () => { if (gb) { flushSave(); const rn = romName; romGet(rn).then(r => r && startRom(rn, r.data)); } };

// Offline support (HTTPS / localhost only).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});

mpUi(); layout();
window.__gb = () => ({ gb, audio, dispHz, mode, kdev, mp, cam, touchMask });

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
