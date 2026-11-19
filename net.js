'use strict';
/* Serverless two-player transport: a WebRTC data channel set up by swapping two short codes
   (offer / answer) through any chat app. No signalling server involved.
   Google's public STUN server is used only to discover the public address for the connection. */
(function (root) {

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pipe(data, stream) {
  const w = stream.writable.getWriter(); w.write(data); w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
async function encode(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'undefined') return 'z' + b64(await pipe(raw, new CompressionStream('deflate')));
  return 'r' + b64(raw);
}
async function decode(code) {
  code = code.replace(/\s+/g, '');
  const kind = code[0], bytes = unb64(code.slice(1));
  const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

class Peer {
  constructor(h) {
    this.h = h; this.dc = null;
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc.onconnectionstatechange = () => { const s = this.pc.connectionState; if (h.state) h.state(s); if (s === 'failed' || s === 'closed' || s === 'disconnected') { if (h.close) h.close(s); } };
  }
  _gathered() {
    return new Promise(res => {
      const pc = this.pc, done = () => { pc.removeEventListener('icegatheringstatechange', f); res(); };
      const f = () => { if (pc.iceGatheringState === 'complete') done(); };
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', f); setTimeout(done, 5000);
    });
  }
  _setup(dc) {
    this.dc = dc; dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.h.open && this.h.open();
    dc.onclose = () => this.h.close && this.h.close('closed');
    dc.onmessage = e => {
      const d = e.data;
      if (typeof d === 'string') { try { this.h.msg && this.h.msg(JSON.parse(d)); } catch {} }
      else if (this.h.bin) this.h.bin(new Uint8Array(d));
    };
  }
  async host() {
    this._setup(this.pc.createDataChannel('gb', { ordered: false })); // reliable but unordered: lower latency under loss
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gathered();
    return encode(this.pc.localDescription.toJSON());
  }
  async join(code) {
    this.pc.ondatachannel = e => this._setup(e.channel);
    await this.pc.setRemoteDescription(await decode(code));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gathered();
    return encode(this.pc.localDescription.toJSON());
  }
  async accept(code) { await this.pc.setRemoteDescription(await decode(code)); }
  send(o) { if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(o)); }
  sendBin(u8) { if (this.dc && this.dc.readyState === 'open') this.dc.send(u8); }
  get open() { return !!this.dc && this.dc.readyState === 'open'; }
  close() { try { this.dc && this.dc.close(); } catch {} try { this.pc.close(); } catch {} }
}

/* Short join codes. The two devices meet through a public pub/sub topic named after a random 6-character
   code (Crockford base32, 30 bits): the host publishes its connection offer there, the guest answers.
   Only the random code and the (already-public-address) connection descriptions pass through the relay; the
   game itself is a direct peer-to-peer link. Relay: ntfy.sh (free, no account). */
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RELAY = 'https://ntfy.sh/';
function newCode() { const a = new Uint8Array(6); crypto.getRandomValues(a); return Array.from(a, v => ALPHA[v & 31]).join(''); }
function normCode(s) { return String(s).toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, ''); }
const topic = code => 'gbmp-' + code.toLowerCase();
async function publish(code, text) {
  const r = await fetch(RELAY + topic(code), { method: 'POST', body: text });
  if (!r.ok) throw new Error('relay ' + r.status);
}
// Calls cb(text) for every message on the topic (including ones sent before we joined). Returns a close function.
// Streams the relay's JSON feed with fetch so we see HTTP errors (e.g. 429 rate limit), and reconnects with
// backoff (resuming after the last message) instead of the browser's endless instant retries.
// onError(code): HTTP status, 0 = network error, -1 = gave up.
function subscribe(code, cb, onError) {
  const ac = new AbortController(); let stopped = false, tries = 0, last = 'all';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = async () => {
    while (!stopped) {
      try {
        const r = await fetch(RELAY + topic(code) + '/json?since=' + last, { signal: ac.signal });
        if (!r.ok) { if (onError) onError(r.status); tries += r.status === 429 ? 3 : 1; }
        else {
          tries = 0; const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true }); let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
              try { const m = JSON.parse(line); if (m.id) last = m.id; if (m.event === 'message' && typeof m.message === 'string') cb(m.message); } catch {}
            }
          }
        }
      } catch (e) { if (stopped) return; if (onError) onError(0); tries++; }
      if (stopped) return;
      if (tries > 6) { if (onError) onError(-1); return; }
      await sleep(Math.min(30000, 1500 * 2 ** Math.max(0, tries)));
    }
  };
  run();
  return () => { stopped = true; try { ac.abort(); } catch {} };
}

const fnv = (arr, step = 1) => { let h = 0x811C9DC5; for (let i = 0; i < arr.length; i += step) { h ^= arr[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };

root.Net = { Peer, fnv, newCode, normCode, publish, subscribe };
})(window);
