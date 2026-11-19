// node gen-icon.js  -> icon.png (512x512)
const fs = require('fs'), zlib = require('zlib');
const N = 512, px = Buffer.alloc(N * N * 4);
const set = (x, y, c) => { const o = (y * N + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
const rr = (x, y, x0, y0, x1, y1, r) => { const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r)); return Math.hypot(x - cx, y - cy) <= r && x >= x0 && x <= x1 && y >= y0 && y <= y1; };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  let c = [20, 22, 28];
  if (rr(x, y, 96, 80, 416, 300, 18)) c = [155, 176, 78];
  if (rr(x, y, 124, 106, 388, 274, 6)) c = [122, 145, 64];
  if (rr(x, y, 150, 130, 230, 200, 4)) c = [35, 48, 32];
  if (rr(x, y, 80, 380, 200, 420, 12) || rr(x, y, 120, 340, 160, 460, 12)) c = [220, 220, 228];
  if (Math.hypot(x - 340, y - 430) < 40) c = [229, 82, 127];
  if (Math.hypot(x - 420, y - 372) < 40) c = [229, 166, 82];
  set(x, y, c);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(N, 0); ih.writeUInt32BE(N, 4); ih[8] = 8; ih[9] = 6;
fs.writeFileSync(__dirname + '/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
