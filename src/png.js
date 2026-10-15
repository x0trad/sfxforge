// Minimal RGBA PNG encoder + waveform/score preview in the SFX Forge palette.
'use strict';
const zlib = require('zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PALETTE = ['#6FA3AD', '#9A9D3C', '#E0503A', '#B2A68A', '#EDEAD9', '#93716A', '#4E6E7A', '#D98A3A', '#7C8C5A', '#C9C3B0'];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Top: score strip (one row per layer, a tile per hit/repeat). Bottom: min/max waveform.
function preview(result, W, H) {
  W = W || 640; H = H || 200;
  const img = new Uint8Array(W * H * 4);
  const set = (x, y, c, a) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; const k = a == null ? 1 : a;
    img[i] = img[i] * (1 - k) + c[0] * k; img[i + 1] = img[i + 1] * (1 - k) + c[1] * k; img[i + 2] = img[i + 2] * (1 - k) + c[2] * k; img[i + 3] = 255; };
  const bg = hex('#101010'), grid = hex('#1E1E1E'), ink = hex('#DDDACA');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, (x % 16 === 0 || y % 16 === 0) ? grid : bg);
  const snd = result.sound, dur = result.duration, nl = snd.layers.length;
  const scoreH = Math.min(H * 0.45, 14 * nl + 8), rowH = (scoreH - 8) / Math.max(1, nl);
  const stepDur = snd.length / snd.steps;
  snd.layers.forEach((l, li) => {
    const c = hex(PALETTE[li % PALETTE.length]);
    const y0 = Math.round(4 + li * rowH), hh = Math.max(3, Math.round(rowH - 3));
    l.hits.forEach(hit => {
      for (let r = 0; r <= (l.repeat.count || 0); r++) {
        const t = hit.t * stepDur + r * l.repeat.interval;
        const len = Math.max(hit.len, l.amp.a) + l.amp.r * 0.5;
        const x0 = Math.round(t / dur * W), x1 = Math.max(x0 + 3, Math.round((t + len) / dur * W));
        for (let x = x0; x < x1; x++) for (let y = y0; y < y0 + hh; y++) set(x, y, c, l.mute ? 0.25 : (x - x0 < hh ? 1 : 0.45) * Math.pow(l.repeat.decay, r));
      }
    });
  });
  const top = Math.ceil(scoreH) + 4, mid = top + (H - top) / 2, amp = (H - top) / 2 - 4;
  const L = result.left, R = result.right, N = L.length;
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x / W * N), b = Math.max(a + 1, Math.floor((x + 1) / W * N));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i < N; i++) { const v = (L[i] + R[i]) / 2; if (v < mn) mn = v; if (v > mx) mx = v; }
    for (let y = Math.round(mid - mx * amp); y <= Math.round(mid - mn * amp); y++) set(x, y, ink, 0.9);
  }
  for (let x = 0; x < W; x++) set(x, Math.round(mid), hex('#333333'));
  return encodePng(W, H, img);
}

module.exports = { encodePng, preview, PALETTE };
