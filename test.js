// Headless runner: node test.js <rom> [frames] [out.png]
// Prints serial output (blargg-style tests) and writes a screenshot.
const fs = require('fs'), zlib = require('zlib');
const { GB } = require('./gb.js');

const [rom, frames = '600', out] = process.argv.slice(2);
const gb = new GB(new Uint8Array(fs.readFileSync(rom)));
gb.pal.set([0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]);
const t0 = process.hrtime.bigint();
const n = +frames;
let i = 0;
for (; i < n; i++) {
  gb.runFrame();
  if (/Passed|Failed/.test(gb.serial)) break;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(gb.serial.trim());
console.log(`${i + 1} frames in ${ms.toFixed(0)}ms (${(ms / (i + 1)).toFixed(2)} ms/frame)`);

if (out) {
  const w = 160, h = 144, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const p = gb.fb[y * w + x], o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = p & 255; raw[o + 1] = (p >> 8) & 255; raw[o + 2] = (p >> 16) & 255; raw[o + 3] = 255;
    }
  }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
