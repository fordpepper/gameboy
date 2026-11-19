'use strict';
/* Game Boy (DMG) emulator core. No DOM dependencies, so it also runs under Node for testing.
   CPU: instruction-stepped with per-instruction cycle counts. PPU: scanline renderer.
   APU: 4 channels, box-filtered to the output sample rate. MBC: none/1/2/3/5. */
(function (root) {

const CPU_HZ = 4194304;
const FRAME_CYCLES = 70224;

/* ------------------------------------------------------------------ APU */
const DUTY = [[0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,1],[1,0,0,0,0,1,1,1],[0,1,1,1,1,1,1,0]];
const WAVE_SHIFT = [4, 0, 1, 2];
const NR_MASK = [0x80,0x3F,0x00,0xFF,0xBF, 0xFF,0x3F,0x00,0xFF,0xBF, 0x7F,0xFF,0x9F,0xFF,0xBF,
                 0xFF,0xFF,0x00,0x00,0xBF, 0x00,0x00];
const RING = 16384, RING_MASK = RING - 1;

class Square {
  constructor(sweep) { this.sweep = sweep; this.reset(); }
  reset() {
    this.en = false; this.dac = false; this.freq = 0; this.duty = 0; this.dpos = 0; this.timer = 0;
    this.vol = 0; this.envInit = 0; this.envDir = 0; this.envPer = 0; this.envT = 0;
    this.len = 0; this.lenEn = false;
    this.swPer = 0; this.swDir = 0; this.swShift = 0; this.swT = 0; this.swEn = false; this.swShadow = 0;
  }
  out() { return this.en ? DUTY[this.duty][this.dpos] * this.vol : 0; }
  step(c) {
    this.timer -= c;
    if (this.timer <= 0) {
      const p = (2048 - this.freq) * 4;
      const n = ((-this.timer / p) | 0) + 1;
      this.dpos = (this.dpos + n) & 7;
      this.timer += n * p;
    }
  }
  lenClock() { if (this.lenEn && this.len > 0 && --this.len === 0) this.en = false; }
  envClock() {
    if (this.envPer && --this.envT <= 0) {
      this.envT = this.envPer;
      if (this.envDir) { if (this.vol < 15) this.vol++; } else if (this.vol > 0) this.vol--;
    }
  }
  swCalc() {
    const d = this.swShadow >> this.swShift;
    const nf = this.swDir ? this.swShadow - d : this.swShadow + d;
    if (nf > 2047) this.en = false;
    return nf;
  }
  swClock() {
    if (--this.swT <= 0) {
      this.swT = this.swPer || 8;
      if (this.swEn && this.swPer) {
        const nf = this.swCalc();
        if (nf <= 2047 && this.swShift) { this.swShadow = nf; this.freq = nf; this.swCalc(); }
      }
    }
  }
  trigger() {
    this.en = this.dac;
    if (this.len === 0) this.len = 64;
    this.timer = (2048 - this.freq) * 4;
    this.vol = this.envInit; this.envT = this.envPer;
    if (this.sweep) {
      this.swShadow = this.freq; this.swT = this.swPer || 8;
      this.swEn = this.swPer > 0 || this.swShift > 0;
      if (this.swShift) this.swCalc();
    }
  }
}

class Wave {
  constructor() { this.wave = new Uint8Array(16); this.reset(); }
  reset() { this.en = false; this.dac = false; this.freq = 0; this.vc = 0; this.len = 0; this.lenEn = false; this.timer = 0; this.pos = 0; }
  out() {
    if (!this.en) return 0;
    const b = this.wave[this.pos >> 1];
    return ((this.pos & 1) ? b & 15 : b >> 4) >> WAVE_SHIFT[this.vc];
  }
  step(c) {
    this.timer -= c;
    if (this.timer <= 0) {
      const p = (2048 - this.freq) * 2;
      const n = ((-this.timer / p) | 0) + 1;
      this.pos = (this.pos + n) & 31;
      this.timer += n * p;
    }
  }
  lenClock() { if (this.lenEn && this.len > 0 && --this.len === 0) this.en = false; }
  trigger() { this.en = this.dac; if (this.len === 0) this.len = 256; this.timer = (2048 - this.freq) * 2; this.pos = 0; }
}

class Noise {
  constructor() { this.reset(); }
  reset() {
    this.en = false; this.dac = false; this.vol = 0; this.envInit = 0; this.envDir = 0; this.envPer = 0; this.envT = 0;
    this.len = 0; this.lenEn = false; this.lfsr = 0x7FFF; this.width = 0; this.period = 8; this.timer = 0;
  }
  out() { return this.en && !(this.lfsr & 1) ? this.vol : 0; }
  step(c) {
    this.timer -= c;
    while (this.timer <= 0) {
      this.timer += this.period;
      const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (x << 14);
      if (this.width) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
    }
  }
  lenClock() { if (this.lenEn && this.len > 0 && --this.len === 0) this.en = false; }
  envClock() { Square.prototype.envClock.call(this); }
  trigger() {
    this.en = this.dac; if (this.len === 0) this.len = 64;
    this.lfsr = 0x7FFF; this.timer = this.period; this.vol = this.envInit; this.envT = this.envPer;
  }
}

class APU {
  constructor() {
    this.ring = new Float32Array(RING * 2);
    this.wp = 0; this.rp = 0;
    this.c1 = new Square(true); this.c2 = new Square(false); this.c3 = new Wave(); this.c4 = new Noise();
    this.regs = new Uint8Array(0x16);
    this.setRate(44100);
    this.on = false; this.fs = 0; this.fsT = 0; this.sT = 0;
    this.lastL = 0; this.lastR = 0; this.fadeIn = 256;
    this.accL = 0; this.accR = 0; this.accN = 0; this.ml = 0; this.mr = 0; this.capL = 0; this.capR = 0;
  }
  setRate(r) { this.rate = r; this.period = CPU_HZ / r; this.hpf = Math.pow(0.999958, this.period); }
  fill() { return this.wp - this.rp; }
  flush() { this.rp = this.wp; }
  // Pull samples for the audio device. Never cuts abruptly: on underrun the last value decays to 0,
  // and the next audible block fades in, so there are no clicks when the tab stalls or pauses.
  read2(L, R, vol) {
    const n = L.length, take = Math.min(n, this.wp - this.rp), ring = this.ring;
    let i = 0;
    for (; i < take; i++) {
      const k = ((this.rp + i) & RING_MASK) << 1;
      let l = ring[k] * vol, r = ring[k + 1] * vol;
      if (this.fadeIn > 0) { const f = 1 - this.fadeIn / 256; l *= f; r *= f; this.fadeIn--; }
      L[i] = l; R[i] = r; this.lastL = l; this.lastR = r;
    }
    this.rp += take;
    if (i < n) this.silence(L, R, i);
  }
  silence(L, R, from = 0) {
    let l = this.lastL, r = this.lastR;
    for (let i = from; i < L.length; i++) { l *= 0.99; r *= 0.99; L[i] = l; R[i] = r; }
    this.lastL = l; this.lastR = r; this.fadeIn = 256;
  }
  power(on) {
    if (!on) { this.regs.fill(0); this.c1.reset(); this.c2.reset(); this.c4.reset(); const w = this.c3; w.reset(); }
    else if (!this.on) { this.fs = 0; this.fsT = 0; }
    this.on = on;
  }
  clockFS() {
    const s = this.fs; this.fs = (s + 1) & 7;
    if (!(s & 1)) { this.c1.lenClock(); this.c2.lenClock(); this.c3.lenClock(); this.c4.lenClock(); }
    if (s === 2 || s === 6) this.c1.swClock();
    if (s === 7) { this.c1.envClock(); this.c2.envClock(); this.c4.envClock(); }
  }
  write(a, v) {
    if (a >= 0xFF30) { this.c3.wave[a - 0xFF30] = v; return; }
    if (a === 0xFF26) { this.power((v & 0x80) !== 0); return; }
    if (!this.on) return;
    this.regs[a - 0xFF10] = v;
    const c1 = this.c1, c2 = this.c2, c3 = this.c3, c4 = this.c4;
    switch (a) {
      case 0xFF10: c1.swPer = (v >> 4) & 7; c1.swDir = (v >> 3) & 1; c1.swShift = v & 7; break;
      case 0xFF11: c1.duty = v >> 6; c1.len = 64 - (v & 63); break;
      case 0xFF12: c1.envInit = v >> 4; c1.envDir = (v >> 3) & 1; c1.envPer = v & 7; c1.dac = (v & 0xF8) !== 0; if (!c1.dac) c1.en = false; break;
      case 0xFF13: c1.freq = (c1.freq & 0x700) | v; break;
      case 0xFF14: c1.freq = (c1.freq & 0xFF) | ((v & 7) << 8); c1.lenEn = (v & 0x40) !== 0; if (v & 0x80) c1.trigger(); break;
      case 0xFF16: c2.duty = v >> 6; c2.len = 64 - (v & 63); break;
      case 0xFF17: c2.envInit = v >> 4; c2.envDir = (v >> 3) & 1; c2.envPer = v & 7; c2.dac = (v & 0xF8) !== 0; if (!c2.dac) c2.en = false; break;
      case 0xFF18: c2.freq = (c2.freq & 0x700) | v; break;
      case 0xFF19: c2.freq = (c2.freq & 0xFF) | ((v & 7) << 8); c2.lenEn = (v & 0x40) !== 0; if (v & 0x80) c2.trigger(); break;
      case 0xFF1A: c3.dac = (v & 0x80) !== 0; if (!c3.dac) c3.en = false; break;
      case 0xFF1B: c3.len = 256 - v; break;
      case 0xFF1C: c3.vc = (v >> 5) & 3; break;
      case 0xFF1D: c3.freq = (c3.freq & 0x700) | v; break;
      case 0xFF1E: c3.freq = (c3.freq & 0xFF) | ((v & 7) << 8); c3.lenEn = (v & 0x40) !== 0; if (v & 0x80) c3.trigger(); break;
      case 0xFF20: c4.len = 64 - (v & 63); break;
      case 0xFF21: c4.envInit = v >> 4; c4.envDir = (v >> 3) & 1; c4.envPer = v & 7; c4.dac = (v & 0xF8) !== 0; if (!c4.dac) c4.en = false; break;
      case 0xFF22: { const d = v & 7; c4.period = (d ? d * 16 : 8) << (v >> 4); c4.width = (v >> 3) & 1; break; }
      case 0xFF23: c4.lenEn = (v & 0x40) !== 0; if (v & 0x80) c4.trigger(); break;
    }
  }
  read(a) {
    if (a >= 0xFF30) return this.c3.wave[a - 0xFF30];
    if (a === 0xFF26) return 0x70 | (this.on ? 0x80 : 0) | (this.c1.en ? 1 : 0) | (this.c2.en ? 2 : 0) | (this.c3.en ? 4 : 0) | (this.c4.en ? 8 : 0);
    if (a > 0xFF25) return 0xFF;
    return this.regs[a - 0xFF10] | NR_MASK[a - 0xFF10];
  }
  step(c) {
    if (this.on) {
      this.fsT += c;
      while (this.fsT >= 8192) { this.fsT -= 8192; this.clockFS(); }
      const c1 = this.c1, c2 = this.c2, c3 = this.c3, c4 = this.c4;
      c1.step(c); c2.step(c); c3.step(c); c4.step(c);
      const o1 = c1.out(), o2 = c2.out(), o3 = c3.out(), o4 = c4.out();
      const pan = this.regs[0x15], vol = this.regs[0x14];
      const l = ((pan & 0x10 ? o1 : 0) + (pan & 0x20 ? o2 : 0) + (pan & 0x40 ? o3 : 0) + (pan & 0x80 ? o4 : 0)) * (((vol >> 4) & 7) + 1);
      const r = ((pan & 1 ? o1 : 0) + (pan & 2 ? o2 : 0) + (pan & 4 ? o3 : 0) + (pan & 8 ? o4 : 0)) * ((vol & 7) + 1);
      this.ml = l / 480; this.mr = r / 480; // 4 ch * 15 * 8 = 480 -> 0..1
    } else { this.ml = 0; this.mr = 0; }
    this.accL += this.ml * c; this.accR += this.mr * c; this.accN += c;
    this.sT += c;
    if (this.sT >= this.period) {
      this.sT -= this.period;
      const n = this.accN, l = this.accL / n, r = this.accR / n;
      this.accL = 0; this.accR = 0; this.accN = 0;
      const ol = l - this.capL; this.capL = l - ol * this.hpf;
      const or = r - this.capR; this.capR = r - or * this.hpf;
      if (this.wp - this.rp < RING) {
        const k = (this.wp & RING_MASK) << 1;
        this.ring[k] = ol * 0.8; this.ring[k + 1] = or * 0.8;
        this.wp++;
      }
    }
  }
}

/* ------------------------------------------------------------------ GB */
const TAC_MASK = [0x200, 0x08, 0x20, 0x80];

class GB {
  constructor(romData) {
    this.apu = new APU();
    this.fb = new Uint32Array(160 * 144);
    this.pal = new Uint32Array([0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]);
    this.bgc = new Uint8Array(160);
    this.scxLine = new Uint8Array(144);
    this.claimed = new Uint8Array(160);
    this.spr = new Int32Array(10);
    this.serial = '';
    this.onSerial = null;
    this.ramDirty = false;
    this.loadRom(romData);
    this.reset();
  }

  loadRom(data) {
    let size = 32768; while (size < data.length) size <<= 1;
    this.rom = new Uint8Array(size); this.rom.set(data);
    this.romMask = size - 1;
    const t = data[0x147]; this.cartType = t;
    this.mbc = t === 0 || t === 8 || t === 9 ? 0 : t <= 3 ? 1 : t <= 6 ? 2 : (t >= 0x0F && t <= 0x13) ? 3 : (t >= 0x19 && t <= 0x1E) ? 5 : 0;
    this.hasBattery = [3, 6, 9, 0x0F, 0x10, 0x13, 0x1B, 0x1E].includes(t);
    this.hasRtc = t === 0x0F || t === 0x10;
    this.cgbOnly = data[0x143] === 0xC0;
    let title = ''; for (let i = 0x134; i < 0x143; i++) { const c = data[i]; if (c >= 32 && c < 127) title += String.fromCharCode(c); }
    this.title = title.trim();
    const rs = [0, 2048, 8192, 32768, 131072, 65536][data[0x149]] || 0;
    this.ramSize = this.mbc === 2 ? 512 : rs;
    this.ram = new Uint8Array(this.ramSize);
    this.ramMask = this.ramSize ? this.ramSize - 1 : 0;
    this.rtcBase = Date.now(); this.rtcLatched = [0, 0, 0, 0, 0]; this.rtcLatch = 1;
  }

  reset() {
    this.vram = new Uint8Array(0x2000); this.wram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xA0); this.hram = new Uint8Array(0x7F);
    this.r = new Uint8Array(8); // B C D E H L (unused) A
    const r = this.r; r[7] = 0x01; r[1] = 0x13; r[3] = 0xD8; r[4] = 0x01; r[5] = 0x4D;
    this.zf = 1; this.nf = 0; this.hf = 1; this.cf = 1;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.ime = false; this.imeNext = false; this.halted = false; this.haltBug = false;
    this.IF = 0xE1; this.ie = 0;
    this.div = 0xABCC; this.tima = 0; this.tma = 0; this.tac = 0;
    this.sb = 0; this.sc = 0; this.p1sel = 0x30; this.pad = 0;
    this.lcdc = 0x91; this.stat = 0; this.scy = 0; this.scx = 0; this.ly = 0; this.lyc = 0;
    this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF; this.wy = 0; this.wx = 0; this.dma = 0xFF;
    this.mode = 2; this.lcnt = 0; this.winLine = 0; this.statPrev = false; this.frameDone = false;
    this.romBank = 1; this.rom0Bank = 0; this.ramBank = 0; this.ramEn = false; this.mbc1Mode = 0; this.bank1 = 1; this.bank2 = 0;
    this.updateRomOff();
    const a = this.apu; a.power(true); a.write(0xFF25, 0xF3); a.write(0xFF24, 0x77);
  }

  updateRomOff() {
    this.rom0Off = (this.rom0Bank << 14) & this.romMask;
    this.romNOff = (this.romBank << 14) & this.romMask;
  }

  /* ---- external save RAM (+RTC base) ---- */
  getSave() {
    if (!this.ramSize) return null;
    const out = new Uint8Array(this.ramSize + (this.hasRtc ? 8 : 0)); out.set(this.ram);
    if (this.hasRtc) new DataView(out.buffer).setFloat64(this.ramSize, this.rtcBase);
    return out;
  }
  loadSave(d) {
    if (!d || !this.ramSize) return;
    this.ram.set(d.subarray(0, this.ramSize));
    if (this.hasRtc && d.length >= this.ramSize + 8) this.rtcBase = new DataView(d.buffer, d.byteOffset).getFloat64(this.ramSize);
  }

  /* ---- input ---- bits: 0 right 1 left 2 up 3 down 4 A 5 B 6 select 7 start */
  setPad(m) {
    // A real D-pad can't press opposite directions at once; many games misbehave if they see it.
    if ((m & 3) === 3) m &= ~3;
    if ((m & 12) === 12) m &= ~12;
    const n = m & ~this.pad; this.pad = m;
    if (n && ((!(this.p1sel & 0x10) && (n & 0x0F)) || (!(this.p1sel & 0x20) && (n & 0xF0)))) this.IF |= 0x10;
  }

  /* Draw OAM entry `i` into `dst` (a 160x144 ABGR buffer) shifted by dx pixels, as a dithered 'ghost'.
     Uses this emulator's VRAM/palettes for the tile data but the caller's colour table. */
  drawGhostSprite(i, dst, dx, pal) {
    const o = i * 4, oam = this.oam, vram = this.vram, h = (this.lcdc & 4) ? 16 : 8;
    const y0 = oam[o] - 16, x0 = oam[o + 1] - 8 + dx, fl = oam[o + 3];
    if (oam[o] === 0 || oam[o] >= 160) return;
    let tile = oam[o + 2]; if (h === 16) tile &= 0xFE;
    const pv = (fl & 0x10) ? this.obp1 : this.obp0;
    for (let r = 0; r < h; r++) {
      const y = y0 + r; if (y < 0 || y >= 144) continue;
      const row = (fl & 0x40) ? h - 1 - r : r, a = tile * 16 + row * 2, lo = vram[a], hi = vram[a + 1];
      for (let p = 0; p < 8; p++) {
        const x = x0 + p; if (x < 0 || x >= 160 || ((x + y) & 1)) continue;
        const b = (fl & 0x20) ? p : 7 - p, ci = ((lo >> b) & 1) | (((hi >> b) & 1) << 1);
        if (ci) dst[y * 160 + x] = pal[(pv >> (ci * 2)) & 3];
      }
    }
  }

  /* ---- memory ---- */
  rd(a) {
    switch (a >> 12) {
      case 0: case 1: case 2: case 3: return this.rom[(a & 0x3FFF) + this.rom0Off];
      case 4: case 5: case 6: case 7: return this.rom[(a & 0x3FFF) + this.romNOff];
      case 8: case 9: return this.vram[a & 0x1FFF];
      case 0xA: case 0xB: return this.ramRead(a);
      case 0xC: case 0xD: case 0xE: return this.wram[a & 0x1FFF];
      default:
        if (a < 0xFE00) return this.wram[a & 0x1FFF];
        if (a < 0xFEA0) return this.oam[a - 0xFE00];
        if (a < 0xFF00) return 0xFF;
        return this.ioRead(a);
    }
  }
  wr(a, v) {
    switch (a >> 12) {
      case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: this.mbcWrite(a, v); return;
      case 8: case 9: this.vram[a & 0x1FFF] = v; return;
      case 0xA: case 0xB: this.ramWrite(a, v); return;
      case 0xC: case 0xD: case 0xE: this.wram[a & 0x1FFF] = v; return;
      default:
        if (a < 0xFE00) this.wram[a & 0x1FFF] = v;
        else if (a < 0xFEA0) this.oam[a - 0xFE00] = v;
        else if (a >= 0xFF00) this.ioWrite(a, v);
    }
  }
  ramRead(a) {
    if (!this.ramEn) return 0xFF;
    if (this.mbc === 2) return this.ram[a & 0x1FF] | 0xF0;
    if (this.mbc === 3 && this.ramBank >= 8) return this.rtcLatched[this.ramBank - 8] | 0;
    if (!this.ramSize) return 0xFF;
    return this.ram[((this.ramBank << 13) + (a & 0x1FFF)) & this.ramMask];
  }
  ramWrite(a, v) {
    if (!this.ramEn) return;
    if (this.mbc === 2) { this.ram[a & 0x1FF] = v & 15; this.ramDirty = true; return; }
    if (this.mbc === 3 && this.ramBank >= 8) return;
    if (!this.ramSize) return;
    this.ram[((this.ramBank << 13) + (a & 0x1FFF)) & this.ramMask] = v; this.ramDirty = true;
  }
  mbcWrite(a, v) {
    switch (this.mbc) {
      case 1:
        if (a < 0x2000) this.ramEn = (v & 0xF) === 0xA;
        else if (a < 0x4000) { this.bank1 = (v & 0x1F) || 1; }
        else if (a < 0x6000) this.bank2 = v & 3;
        else this.mbc1Mode = v & 1;
        this.romBank = (this.bank2 << 5) | this.bank1;
        this.rom0Bank = this.mbc1Mode ? this.bank2 << 5 : 0;
        this.ramBank = this.mbc1Mode ? this.bank2 : 0;
        this.updateRomOff(); break;
      case 2:
        if (a < 0x4000) {
          if (a & 0x100) { this.romBank = (v & 0xF) || 1; this.updateRomOff(); }
          else this.ramEn = (v & 0xF) === 0xA;
        } break;
      case 3:
        if (a < 0x2000) this.ramEn = (v & 0xF) === 0xA;
        else if (a < 0x4000) { this.romBank = (v & 0x7F) || 1; this.updateRomOff(); }
        else if (a < 0x6000) this.ramBank = v & 0xF;
        else {
          if (this.rtcLatch === 0 && v === 1) this.latchRtc();
          this.rtcLatch = v;
        } break;
      case 5:
        if (a < 0x2000) this.ramEn = (v & 0xF) === 0xA;
        else if (a < 0x3000) { this.romBank = (this.romBank & 0x100) | v; this.updateRomOff(); }
        else if (a < 0x4000) { this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8); this.updateRomOff(); }
        else if (a < 0x6000) this.ramBank = v & 0xF;
        break;
    }
  }
  latchRtc() {
    const t = Math.max(0, Math.floor((Date.now() - this.rtcBase) / 1000)), days = Math.floor(t / 86400);
    this.rtcLatched = [t % 60, Math.floor(t / 60) % 60, Math.floor(t / 3600) % 24, days & 255, ((days >> 8) & 1) | (days > 511 ? 0x80 : 0)];
  }

  ioRead(a) {
    if (a >= 0xFF80) return a === 0xFFFF ? this.ie : this.hram[a - 0xFF80];
    switch (a) {
      case 0xFF00: {
        let v = 0xC0 | (this.p1sel & 0x30) | 0x0F;
        if (!(this.p1sel & 0x10)) v &= ~(this.pad & 0x0F);
        if (!(this.p1sel & 0x20)) v &= ~((this.pad >> 4) & 0x0F);
        return v;
      }
      case 0xFF01: return this.sb;
      case 0xFF02: return this.sc | 0x7E;
      case 0xFF04: return this.div >> 8;
      case 0xFF05: return this.tima;
      case 0xFF06: return this.tma;
      case 0xFF07: return this.tac | 0xF8;
      case 0xFF0F: return this.IF | 0xE0;
      case 0xFF40: return this.lcdc;
      case 0xFF41: return 0x80 | (this.stat & 0x78) | (this.ly === this.lyc ? 4 : 0) | ((this.lcdc & 0x80) ? this.mode : 0);
      case 0xFF42: return this.scy;
      case 0xFF43: return this.scx;
      case 0xFF44: return this.ly;
      case 0xFF45: return this.lyc;
      case 0xFF46: return this.dma;
      case 0xFF47: return this.bgp;
      case 0xFF48: return this.obp0;
      case 0xFF49: return this.obp1;
      case 0xFF4A: return this.wy;
      case 0xFF4B: return this.wx;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) return this.apu.read(a);
    return 0xFF;
  }
  ioWrite(a, v) {
    if (a >= 0xFF80) { if (a === 0xFFFF) this.ie = v; else this.hram[a - 0xFF80] = v; return; }
    switch (a) {
      case 0xFF00: this.p1sel = v & 0x30; return;
      case 0xFF01: this.sb = v; return;
      case 0xFF02:
        this.sc = v & 0x7F;
        if ((v & 0x81) === 0x81) {
          const ch = String.fromCharCode(this.sb); this.serial += ch; if (this.onSerial) this.onSerial(ch);
          this.sb = 0xFF; this.IF |= 8;
        }
        return;
      case 0xFF04:
        if ((this.tac & 4) && (this.div & TAC_MASK[this.tac & 3])) this.timaInc(1);
        this.div = 0; return;
      case 0xFF05: this.tima = v; return;
      case 0xFF06: this.tma = v; return;
      case 0xFF07: this.tac = v & 7; return;
      case 0xFF0F: this.IF = v & 0x1F; return;
      case 0xFF40: {
        const was = this.lcdc & 0x80; this.lcdc = v;
        if (was && !(v & 0x80)) { this.ly = 0; this.mode = 0; this.lcnt = 0; this.winLine = 0; this.statPrev = false; this.fb.fill(this.pal[0]); }
        else if (!was && (v & 0x80)) { this.ly = 0; this.mode = 2; this.lcnt = 0; this.winLine = 0; this.updateStat(); }
        return;
      }
      case 0xFF41: this.stat = v & 0x78; return;
      case 0xFF42: this.scy = v; return;
      case 0xFF43: this.scx = v; return;
      case 0xFF45: this.lyc = v; if (this.lcdc & 0x80) this.updateStat(); return;
      case 0xFF46: {
        this.dma = v; const src = v << 8;
        for (let i = 0; i < 160; i++) this.oam[i] = this.rd(src + i);
        return;
      }
      case 0xFF47: this.bgp = v; return;
      case 0xFF48: this.obp0 = v; return;
      case 0xFF49: this.obp1 = v; return;
      case 0xFF4A: this.wy = v; return;
      case 0xFF4B: this.wx = v; return;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) this.apu.write(a, v);
  }

  /* ---- timers / PPU / APU ---- */
  timaInc(e) {
    while (e-- > 0) { if (++this.tima > 255) { this.tima = this.tma; this.IF |= 4; } }
  }
  tick(c) {
    const old = this.div;
    this.div = (old + c) & 0xFFFF;
    if (this.tac & 4) {
      const p = TAC_MASK[this.tac & 3] << 1;
      const e = (((old + c) / p) | 0) - ((old / p) | 0);
      if (e > 0) this.timaInc(e);
    }
    this.ppuStep(c);
    this.apu.step(c);
  }
  updateStat() {
    const s = this.stat, m = this.mode;
    const line = ((s & 0x40) && this.ly === this.lyc) || (m === 0 && (s & 8)) || (m === 1 && (s & 0x10)) || (m === 2 && (s & 0x20));
    if (line && !this.statPrev) this.IF |= 2;
    this.statPrev = line;
  }
  ppuStep(c) {
    if (!(this.lcdc & 0x80)) return;
    this.lcnt += c;
    switch (this.mode) {
      case 2: if (this.lcnt >= 80) this.mode = 3; break;
      case 3: if (this.lcnt >= 252) { this.mode = 0; this.renderLine(); this.updateStat(); } break;
      case 0:
        if (this.lcnt >= 456) {
          this.lcnt -= 456; this.ly++;
          if (this.ly === 144) { this.mode = 1; this.IF |= 1; this.frameDone = true; } else this.mode = 2;
          this.updateStat();
        } break;
      case 1:
        if (this.lcnt >= 456) {
          this.lcnt -= 456; this.ly++;
          if (this.ly > 153) { this.ly = 0; this.mode = 2; this.winLine = 0; }
          this.updateStat();
        } break;
    }
  }
  renderLine() {
    const ly = this.ly, fb = this.fb, base = ly * 160, lcdc = this.lcdc, vram = this.vram, pal = this.pal, bgc = this.bgc;
    this.scxLine[ly] = this.scx;
    if (lcdc & 1) {
      const bgp = this.bgp, signed = !(lcdc & 16);
      const y = (ly + this.scy) & 255, mrow = ((lcdc & 8) ? 0x1C00 : 0x1800) + ((y >> 3) << 5), ty = y & 7;
      const useWin = (lcdc & 0x20) && ly >= this.wy && this.wx <= 166;
      const wStart = this.wx - 7, winX = useWin ? Math.max(0, wStart) : 160;
      let tx = -1, lo = 0, hi = 0, px = this.scx;
      for (let x = 0; x < winX; x++, px++) {
        const p = px & 255;
        if (tx !== (p >> 3)) {
          tx = p >> 3; const t = vram[mrow + tx];
          const addr = (signed ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + ty * 2;
          lo = vram[addr]; hi = vram[addr + 1];
        }
        const bit = 7 - (p & 7), ci = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        bgc[x] = ci; fb[base + x] = pal[(bgp >> (ci * 2)) & 3];
      }
      if (useWin) {
        const wrow = ((lcdc & 0x40) ? 0x1C00 : 0x1800) + ((this.winLine >> 3) << 5), wty = this.winLine & 7;
        tx = -1;
        for (let x = winX; x < 160; x++) {
          const wc = x - wStart;
          if (tx !== (wc >> 3)) {
            tx = wc >> 3; const t = vram[wrow + tx];
            const addr = (signed ? 0x1000 + ((t << 24) >> 24) * 16 : t * 16) + wty * 2;
            lo = vram[addr]; hi = vram[addr + 1];
          }
          const bit = 7 - (wc & 7), ci = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          bgc[x] = ci; fb[base + x] = pal[(bgp >> (ci * 2)) & 3];
        }
        this.winLine++;
      }
    } else {
      const w = pal[0]; for (let x = 0; x < 160; x++) { bgc[x] = 0; fb[base + x] = w; }
    }
    if (lcdc & 2) {
      const h = (lcdc & 4) ? 16 : 8, oam = this.oam, list = this.spr, claimed = this.claimed;
      let n = 0;
      for (let i = 0; i < 40 && n < 10; i++) {
        const sy = oam[i * 4] - 16;
        if (ly >= sy && ly < sy + h) {
          // insertion sort by x (stable w.r.t. OAM index)
          const sx = oam[i * 4 + 1]; let j = n++;
          while (j > 0 && oam[list[j - 1] * 4 + 1] > sx) { list[j] = list[j - 1]; j--; }
          list[j] = i;
        }
      }
      if (n) {
        claimed.fill(0);
        for (let k = 0; k < n; k++) {
          const i = list[k], o = i * 4, sy = oam[o] - 16, sx = oam[o + 1] - 8, fl = oam[o + 3];
          let tile = oam[o + 2], row = ly - sy;
          if (fl & 0x40) row = h - 1 - row;
          if (h === 16) tile &= 0xFE;
          const addr = tile * 16 + row * 2, lo = vram[addr], hi = vram[addr + 1];
          const pv = (fl & 0x10) ? this.obp1 : this.obp0;
          for (let p = 0; p < 8; p++) {
            const x = sx + p;
            if (x < 0 || x >= 160 || claimed[x]) continue;
            const bit = (fl & 0x20) ? p : 7 - p, ci = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
            if (!ci) continue;
            claimed[x] = 1;
            if ((fl & 0x80) && bgc[x]) continue;
            fb[base + x] = pal[(pv >> (ci * 2)) & 3];
          }
        }
      }
    }
  }

  /* ---- CPU ---- */
  push(v) { this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xFFFF; this.wr(this.sp, v & 255); }
  pop() { const l = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF; const h = this.rd(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return (h << 8) | l; }
  imm8() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  imm16() { const l = this.rd(this.pc), h = this.rd((this.pc + 1) & 0xFFFF); this.pc = (this.pc + 2) & 0xFFFF; return (h << 8) | l; }
  getRR(i) { const r = this.r; return i === 0 ? (r[0] << 8) | r[1] : i === 1 ? (r[2] << 8) | r[3] : i === 2 ? (r[4] << 8) | r[5] : this.sp; }
  setRR(i, v) {
    const r = this.r;
    if (i === 0) { r[0] = v >> 8; r[1] = v & 255; } else if (i === 1) { r[2] = v >> 8; r[3] = v & 255; }
    else if (i === 2) { r[4] = v >> 8; r[5] = v & 255; } else this.sp = v;
  }
  cond(cc) { return cc === 0 ? !this.zf : cc === 1 ? !!this.zf : cc === 2 ? !this.cf : !!this.cf; }
  getF() { return (this.zf << 7) | (this.nf << 6) | (this.hf << 5) | (this.cf << 4); }
  setF(v) { this.zf = (v >> 7) & 1; this.nf = (v >> 6) & 1; this.hf = (v >> 5) & 1; this.cf = (v >> 4) & 1; }

  alu(k, v) {
    const a = this.r[7]; let res;
    switch (k) {
      case 0: res = a + v; this.hf = ((a & 15) + (v & 15)) > 15 ? 1 : 0; this.cf = res > 255 ? 1 : 0; this.nf = 0; break;
      case 1: { const c = this.cf; res = a + v + c; this.hf = ((a & 15) + (v & 15) + c) > 15 ? 1 : 0; this.cf = res > 255 ? 1 : 0; this.nf = 0; break; }
      case 2: case 7: res = a - v; this.hf = (a & 15) < (v & 15) ? 1 : 0; this.cf = res < 0 ? 1 : 0; this.nf = 1; break;
      case 3: { const c = this.cf; res = a - v - c; this.hf = ((a & 15) - (v & 15) - c) < 0 ? 1 : 0; this.cf = res < 0 ? 1 : 0; this.nf = 1; break; }
      case 4: res = a & v; this.hf = 1; this.cf = 0; this.nf = 0; break;
      case 5: res = a ^ v; this.hf = 0; this.cf = 0; this.nf = 0; break;
      default: res = a | v; this.hf = 0; this.cf = 0; this.nf = 0; break;
    }
    res &= 255; this.zf = res === 0 ? 1 : 0;
    if (k !== 7) this.r[7] = res;
  }
  inc8(v) { v = (v + 1) & 255; this.zf = v === 0 ? 1 : 0; this.nf = 0; this.hf = (v & 15) === 0 ? 1 : 0; return v; }
  dec8(v) { v = (v - 1) & 255; this.zf = v === 0 ? 1 : 0; this.nf = 1; this.hf = (v & 15) === 15 ? 1 : 0; return v; }

  step() {
    let c;
    const pend = this.ie & this.IF & 0x1F;
    if (pend && (this.halted || this.ime)) {
      this.halted = false;
      if (this.ime) {
        this.ime = false;
        let n = 0; while (!(pend & (1 << n))) n++;
        this.IF &= ~(1 << n);
        this.push(this.pc); this.pc = 0x40 + (n << 3);
        this.tick(20); return 20;
      }
    }
    if (this.halted) c = 4;
    else {
      const en = this.imeNext;
      c = this.exec();
      if (en && this.imeNext) { this.ime = true; this.imeNext = false; }
    }
    this.tick(c);
    return c;
  }

  exec() {
    const r = this.r;
    let op;
    if (this.haltBug) { this.haltBug = false; op = this.rd(this.pc); }
    else { op = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; }
    switch (op >> 6) {
      case 1: {
        if (op === 0x76) {
          if (!this.ime && (this.ie & this.IF & 0x1F)) this.haltBug = true; else this.halted = true;
          return 4;
        }
        const s = op & 7, d = (op >> 3) & 7;
        if (s === 6) { r[d] = this.rd((r[4] << 8) | r[5]); return 8; }
        if (d === 6) { this.wr((r[4] << 8) | r[5], r[s]); return 8; }
        r[d] = r[s]; return 4;
      }
      case 2: {
        const s = op & 7;
        if (s === 6) { this.alu((op >> 3) & 7, this.rd((r[4] << 8) | r[5])); return 8; }
        this.alu((op >> 3) & 7, r[s]); return 4;
      }
      case 0:
        switch (op & 7) {
          case 0:
            if (op === 0x00) return 4;
            if (op === 0x08) { const a = this.imm16(); this.wr(a, this.sp & 255); this.wr((a + 1) & 0xFFFF, this.sp >> 8); return 20; }
            if (op === 0x10) { this.pc = (this.pc + 1) & 0xFFFF; return 4; }
            { const e = (this.imm8() << 24) >> 24;
              if (op === 0x18 || this.cond((op >> 3) & 3)) { this.pc = (this.pc + e) & 0xFFFF; return 12; }
              return 8; }
          case 1: {
            const k = (op >> 4) & 3;
            if (op & 8) {
              const hl = (r[4] << 8) | r[5], v = this.getRR(k), s = hl + v;
              this.hf = ((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF ? 1 : 0; this.cf = s > 0xFFFF ? 1 : 0; this.nf = 0;
              r[4] = (s >> 8) & 255; r[5] = s & 255; return 8;
            }
            this.setRR(k, this.imm16()); return 12;
          }
          case 2: {
            const k = (op >> 4) & 3; let a;
            if (k === 0) a = (r[0] << 8) | r[1];
            else if (k === 1) a = (r[2] << 8) | r[3];
            else { a = (r[4] << 8) | r[5]; const n = (k === 2 ? a + 1 : a - 1) & 0xFFFF; r[4] = n >> 8; r[5] = n & 255; }
            if (op & 8) r[7] = this.rd(a); else this.wr(a, r[7]);
            return 8;
          }
          case 3: {
            const k = (op >> 4) & 3, v = this.getRR(k);
            this.setRR(k, (op & 8 ? v - 1 : v + 1) & 0xFFFF); return 8;
          }
          case 4: {
            const d = (op >> 3) & 7;
            if (d === 6) { const a = (r[4] << 8) | r[5]; this.wr(a, this.inc8(this.rd(a))); return 12; }
            r[d] = this.inc8(r[d]); return 4;
          }
          case 5: {
            const d = (op >> 3) & 7;
            if (d === 6) { const a = (r[4] << 8) | r[5]; this.wr(a, this.dec8(this.rd(a))); return 12; }
            r[d] = this.dec8(r[d]); return 4;
          }
          case 6: {
            const d = (op >> 3) & 7, v = this.imm8();
            if (d === 6) { this.wr((r[4] << 8) | r[5], v); return 12; }
            r[d] = v; return 8;
          }
          default: {
            let a = r[7], c;
            switch ((op >> 3) & 7) {
              case 0: c = a >> 7; a = ((a << 1) | c) & 255; this.zf = 0; this.nf = 0; this.hf = 0; this.cf = c; break;
              case 1: c = a & 1; a = (a >> 1) | (c << 7); this.zf = 0; this.nf = 0; this.hf = 0; this.cf = c; break;
              case 2: c = a >> 7; a = ((a << 1) | this.cf) & 255; this.zf = 0; this.nf = 0; this.hf = 0; this.cf = c; break;
              case 3: c = a & 1; a = (a >> 1) | (this.cf << 7); this.zf = 0; this.nf = 0; this.hf = 0; this.cf = c; break;
              case 4:
                if (!this.nf) {
                  if (this.cf || a > 0x99) { a += 0x60; this.cf = 1; }
                  if (this.hf || (a & 15) > 9) a += 6;
                } else { if (this.cf) a -= 0x60; if (this.hf) a -= 6; }
                a &= 255; this.zf = a === 0 ? 1 : 0; this.hf = 0; break;
              case 5: a ^= 255; this.nf = 1; this.hf = 1; break;
              case 6: this.nf = 0; this.hf = 0; this.cf = 1; break;
              default: this.nf = 0; this.hf = 0; this.cf ^= 1; break;
            }
            r[7] = a; return 4;
          }
        }
      default: // 0xC0-0xFF
        switch (op & 7) {
          case 0:
            if (op < 0xE0) { if (this.cond((op >> 3) & 3)) { this.pc = this.pop(); return 20; } return 8; }
            if (op === 0xE0) { this.wr(0xFF00 | this.imm8(), r[7]); return 12; }
            if (op === 0xF0) { r[7] = this.rd(0xFF00 | this.imm8()); return 12; }
            { const e = (this.imm8() << 24) >> 24, sp = this.sp, res = (sp + e) & 0xFFFF;
              this.zf = 0; this.nf = 0; this.hf = ((sp & 15) + (e & 15)) > 15 ? 1 : 0; this.cf = ((sp & 255) + (e & 255)) > 255 ? 1 : 0;
              if (op === 0xE8) { this.sp = res; return 16; }
              r[4] = res >> 8; r[5] = res & 255; return 12; }
          case 1:
            if (!(op & 8)) {
              const v = this.pop(), k = (op >> 4) & 3;
              if (k === 3) { r[7] = v >> 8; this.setF(v & 0xF0); } else this.setRR(k, v);
              return 12;
            }
            if (op === 0xC9) { this.pc = this.pop(); return 16; }
            if (op === 0xD9) { this.pc = this.pop(); this.ime = true; return 16; }
            if (op === 0xE9) { this.pc = (r[4] << 8) | r[5]; return 4; }
            this.sp = (r[4] << 8) | r[5]; return 8;
          case 2:
            if (op < 0xE0) { const a = this.imm16(); if (this.cond((op >> 3) & 3)) { this.pc = a; return 16; } return 12; }
            if (op === 0xE2) { this.wr(0xFF00 | r[1], r[7]); return 8; }
            if (op === 0xF2) { r[7] = this.rd(0xFF00 | r[1]); return 8; }
            if (op === 0xEA) { this.wr(this.imm16(), r[7]); return 16; }
            r[7] = this.rd(this.imm16()); return 16;
          case 3:
            if (op === 0xC3) { this.pc = this.imm16(); return 16; }
            if (op === 0xCB) return this.execCB();
            if (op === 0xF3) { this.ime = false; this.imeNext = false; return 4; }
            if (op === 0xFB) { this.imeNext = true; return 4; }
            return 4;
          case 4:
            if (op < 0xE0) { const a = this.imm16(); if (this.cond((op >> 3) & 3)) { this.push(this.pc); this.pc = a; return 24; } return 12; }
            return 4;
          case 5:
            if (!(op & 8)) {
              const k = (op >> 4) & 3;
              this.push(k === 3 ? (r[7] << 8) | this.getF() : this.getRR(k)); return 16;
            }
            if (op === 0xCD) { const a = this.imm16(); this.push(this.pc); this.pc = a; return 24; }
            return 4;
          case 6: this.alu((op >> 3) & 7, this.imm8()); return 8;
          default: this.push(this.pc); this.pc = op & 0x38; return 16;
        }
    }
  }

  execCB() {
    const r = this.r, op = this.imm8(), z = op & 7, y = (op >> 3) & 7, hl = z === 6;
    const addr = (r[4] << 8) | r[5];
    let v = hl ? this.rd(addr) : r[z];
    switch (op >> 6) {
      case 0: {
        let c;
        switch (y) {
          case 0: c = v >> 7; v = ((v << 1) | c) & 255; break;
          case 1: c = v & 1; v = (v >> 1) | (c << 7); break;
          case 2: c = v >> 7; v = ((v << 1) | this.cf) & 255; break;
          case 3: c = v & 1; v = (v >> 1) | (this.cf << 7); break;
          case 4: c = v >> 7; v = (v << 1) & 255; break;
          case 5: c = v & 1; v = (v >> 1) | (v & 0x80); break;
          case 6: c = 0; v = ((v << 4) | (v >> 4)) & 255; break;
          default: c = v & 1; v >>= 1; break;
        }
        this.zf = v === 0 ? 1 : 0; this.nf = 0; this.hf = 0; this.cf = c; break;
      }
      case 1: this.zf = (v & (1 << y)) ? 0 : 1; this.nf = 0; this.hf = 1; return hl ? 12 : 8;
      case 2: v &= ~(1 << y) & 255; break;
      default: v |= 1 << y; break;
    }
    if (hl) this.wr(addr, v); else r[z] = v;
    return hl ? 16 : 8;
  }

  /* Run until a full frame has been produced. */
  runFrame() {
    this.frameDone = false;
    let cyc = 0;
    while (!this.frameDone) {
      cyc += this.step();
      if (cyc >= FRAME_CYCLES && !(this.lcdc & 0x80)) { this.fb.fill(this.pal[0]); break; }
      if (cyc >= FRAME_CYCLES * 3) break;
    }
  }
}

GB.CPU_HZ = CPU_HZ; GB.FRAME_CYCLES = FRAME_CYCLES;
root.GB = GB;
if (typeof module !== 'undefined') module.exports = { GB };

})(typeof window !== 'undefined' ? window : globalThis);
