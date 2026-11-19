'use strict';
(() => {
const $ = id => document.getElementById(id);
const canvas = $('lcd'), ctx = canvas.getContext('2d', { alpha: false });
const NATIVE_HZ = GB.CPU_HZ / GB.FRAME_CYCLES; // 59.7275 on real hardware

/* ---------------------------------------------------------- settings */
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); } catch {} },
};
// Original DMG LCD: four shades of olive green.
const DMG = ['#9bb04e', '#7a9140', '#4c6238', '#233020'];
const toABGR = h => 0xFF000000 | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16);
canvas.style.background = DMG[0];
let volume = store.get('vol', 0.8), ff = false, showFps = store.get('fps', false);

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

/* ---------------------------------------------------------- emulator state */
let gb = null, romName = null, img = null;
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
  img = new ImageData(new Uint8ClampedArray(g.fb.buffer), 160, 144);
  $('hint').textContent = '';
  closeMenu();
  store.set('last', name);
  document.title = name.replace(/\.(gbc?|bin)$/i, '');
}

// Offline support (only available over HTTPS or localhost).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ---------------------------------------------------------- audio */
let audio = null;
const AUDIO_TARGET = 4096; // frames of buffered audio we aim to keep
function unlockAudio() {
  try {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const c = new AC({ latencyHint: 'interactive' });
      const sp = c.createScriptProcessor(2048, 0, 2);
      sp.onaudioprocess = e => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        if (!gb) { L.fill(0); R.fill(0); return; }
        if (paused || ff || document.hidden) { gb.apu.silence(L, R); if (ff) gb.apu.flush(); return; }
        gb.apu.read2(L, R, volume);
      };
      const gain = c.createGain(); sp.connect(gain); gain.connect(c.destination);
      audio = { ctx: c, sp, gain };
      if (gb) { gb.apu.setRate(c.sampleRate); gb.apu.flush(); }
      fillAvg = AUDIO_TARGET;
    }
    if (!document.hidden && audio.ctx.state !== 'running') audio.ctx.resume();
  } catch (e) { console.warn('audio', e); }
}
['pointerup', 'touchend', 'click', 'keydown'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));

// When the page isn't visible nothing is producing audio; fade out and suspend the device so
// it can't glitch or click, then bring it back cleanly.
let suspendT = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(suspendT);
  if (document.hidden) {
    flushSave();
    if (audio) {
      audio.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.012);
      suspendT = setTimeout(() => { if (document.hidden && audio) audio.ctx.suspend(); }, 120);
    }
  } else {
    last = 0;
    if (gb) gb.apu.flush();
    if (audio) { audio.ctx.resume(); audio.gain.gain.setTargetAtTime(1, audio.ctx.currentTime, 0.03); }
  }
});
window.addEventListener('pagehide', flushSave);

/* ---------------------------------------------------------- input */
const touchHeld = new Map(); // pointerId -> {x, y}
let touchMask = 0, kbMask = 0, shownMask = -1;
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
// Every touch that starts in the left column steers the D-pad (relative to its centre), so the thumb
// never has to land exactly on it. Buttons use a generous radius, and the overlap between A and B
// presses both, like a thumb rolling across them.
function recomputeTouch() {
  let m = 0;
  const dr = dpadEl.getBoundingClientRect(), cx = dr.left + dr.width / 2, cy = dr.top + dr.height / 2, u = dr.width;
  const info = btnEls.map(el => {
    const r = el.getBoundingClientRect(), pill = el.classList.contains('sm');
    return { bit: +el.dataset.b, pill, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
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

/* ---------------------------------------------------------- main loop
   Pacing is locked to the screen, not to a clock: every display refresh runs exactly one emulated
   frame (2 per refresh on a 30 Hz low-power display, every 2nd refresh on 120 Hz...). The refresh
   rate is measured continuously from rAF timestamps over long windows and snapped to the nearest
   standard rate, so timestamp jitter can never cause a skipped or doubled frame. Games run at 60 fps
   (real hardware: 59.73); the audio absorbs the 0.45% difference by shaping how many samples each
   frame produces. */
const TARGET_FPS = 60, SNAP = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
let last = 0, acc = 0, dispHz = 60, winT0 = 0, winN = 0, winBad = false;
let frames = 0, fpsT = 0, produced = 0, fillAvg = AUDIO_TARGET;

function measureRefresh(ts, dt) {
  if (dt > 100) winBad = true;               // tab was backgrounded / stalled: discard this window
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
  if (gb && !paused) {
    const mask = touchMask | kbMask | gamepadMask();
    gb.setPad(mask); showPressed(mask);
    let n = 0;
    if (ff) n = 4;
    else { acc += TARGET_FPS / dispHz; while (acc >= 0.999 && n < 4) { acc -= 1; n++; } if (acc > 4) acc = 0; }
    for (let i = 0; i < n; i++) { if (!ff) tuneAudio(); gb.runFrame(); }
    if (n) { ctx.putImageData(img, 0, 0); produced += n; }
    if (gb.ramDirty && ts - lastSave > 2000) { lastSave = ts; flushSave(); }
  }
  if (fpsT >= 1000) {
    if (showFps) $('fps').textContent = `${(produced * 1000 / fpsT).toFixed(1)} fps · display ${(frames * 1000 / fpsT).toFixed(1)} Hz` + (audio && gb ? ` · buf ${gb.apu.fill()}` : '');
    fpsT = 0; frames = 0; produced = 0;
  }
}
requestAnimationFrame(frame);

/* ---------------------------------------------------------- layout
   Sized for hands: controls scale with the screen (and the "Control size" slider), sit low where
   thumbs rest, and the LCD takes everything that's left, snapped to a whole number of device pixels. */
let ctrlSize = store.get('csize', 1), ctrlLift = store.get('clift', 0.35);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function layout() {
  const app = $('app'), cs = getComputedStyle(app), dpr = window.devicePixelRatio || 1, root = document.documentElement.style;
  const W = app.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const land = W > H; app.dataset.land = land ? '1' : '0';
  let u, stageW, stageH;
  if (land) {
    u = clamp(Math.min(0.19 * W, 0.3 * H) * ctrlSize, 110, 280);
    const padw = u * 1.14 + 10, lift = ctrlLift * 0.2 * H;
    root.setProperty('--padw', padw + 'px'); root.setProperty('--lift', lift + 'px');
    stageW = W - 2 * padw - 8; stageH = H - 24;
  } else {
    u = clamp(Math.min(0.3 * W, 0.2 * H) * ctrlSize, 100, 280);
    const lift = ctrlLift * 0.06 * H, ctrlh = u * 1.5 + 8 + lift * 0.5;
    root.setProperty('--ctrlh', ctrlh + 'px'); root.setProperty('--lift', lift + 'px');
    stageW = W - 8; stageH = H - ctrlh - 16;
  }
  root.setProperty('--u', u + 'px');
  let s = Math.min(stageW / 160, stageH / 144);
  s = s >= 1 ? Math.max(1 / dpr, Math.floor(s * dpr) / dpr) : s; // whole device pixels = crisp, even pixels
  canvas.style.width = 160 * s + 'px'; canvas.style.height = 144 * s + 'px';
}
window.addEventListener('resize', layout); window.addEventListener('orientationchange', () => setTimeout(layout, 150));
layout();

/* ---------------------------------------------------------- menu */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 3500); }
function openMenu() { $('menu').classList.add('open'); paused = true; touchHeld.clear(); recomputeTouch(); if (gb) flushSave(); refreshLibrary(); }
function closeMenu() { $('menu').classList.remove('open'); paused = false; if (gb) gb.apu.flush(); }
$('menuBtn').addEventListener('click', openMenu);
$('closeMenu').addEventListener('click', closeMenu);
$('menu').addEventListener('click', e => { if (e.target.id === 'menu' && gb) closeMenu(); });

async function refreshLibrary() {
  const el = $('library'); el.textContent = '';
  let names = [];
  try { names = (await romList()).sort(); } catch { el.innerHTML = '<div class="empty">Storage unavailable (private browsing?). Use “Load ROM file” each time.</div>'; return; }
  if (!names.length) { el.innerHTML = '<div class="empty">No games yet. Load a ROM file and it will be kept here.</div>'; return; }
  for (const n of names) {
    const row = document.createElement('div'); row.className = 'item';
    const play = document.createElement('button'); play.className = 'play'; play.textContent = (n === romName ? '▶ ' : '') + n.replace(/\.(gbc?|bin)$/i, '');
    play.onclick = async () => { const r = await romGet(n); if (r) startRom(n, r.data); };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
    del.onclick = async () => { if (confirm(`Delete “${n}” and its save data?`)) { await romDel(n); await saveDel(n); if (n === romName) { gb = null; romName = null; } refreshLibrary(); } };
    row.append(play, del); el.append(row);
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

$('csize').value = ctrlSize; $('clift').value = ctrlLift;
$('csize').oninput = e => { ctrlSize = +e.target.value; store.set('csize', ctrlSize); layout(); };
$('clift').oninput = e => { ctrlLift = +e.target.value; store.set('clift', ctrlLift); layout(); };
$('vol').value = volume; $('vol').oninput = e => { volume = +e.target.value; store.set('vol', volume); };
const setToggle = (btn, on) => { btn.textContent = on ? 'On' : 'Off'; btn.classList.toggle('primary', on); };
$('ffBtn').onclick = () => { ff = !ff; setToggle($('ffBtn'), ff); };
$('fpsBtn').onclick = () => { showFps = !showFps; store.set('fps', showFps); setToggle($('fpsBtn'), showFps); $('fps').style.display = showFps ? 'block' : 'none'; };
setToggle($('fpsBtn'), showFps); $('fps').style.display = showFps ? 'block' : 'none';
$('resetBtn').onclick = () => { if (gb) { flushSave(); const rn = romName; romGet(rn).then(r => r && startRom(rn, r.data)); } };

// Resume the last game (after a tap, so audio is allowed to start), otherwise show the menu.
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
  $('hint').textContent = 'PRESS ☰ TO LOAD A GAME';
  openMenu();
})();
})();
