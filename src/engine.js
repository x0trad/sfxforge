/*
 * SFX Forge engine — format "sfx-forge/1"
 * Deterministic, dependency-free sample-by-sample renderer shared by the
 * SFX Forge editor (browser) and sfx-mcp (Node). Same JSON in → same samples out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'sfx-forge/1';
  const WAVES = ['sine', 'square', 'saw', 'triangle', 'noise', 'pulse', 'fm', 'metal'];
  const MAX_SECONDS = 64;

  // ---------- seeded RNG ----------
  function mulberry32(a) {
    a = (a >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  // ---------- defaults / normalisation ----------
  function defaultLayer(i) {
    return {
      id: 'L' + (i + 1), name: 'layer ' + (i + 1), mute: false,
      wave: 'square', duty: 0.5,
      freq: 440, freqEnd: 440, slide: 0, curve: 1,
      jump: null, vib: { rate: 0, depth: 0 }, fm: { ratio: 2, index: 2 },
      amp: { a: 0.002, h: 0, d: 0.15, s: 0, r: 0.05 },
      filter: { type: 'none', cutoff: 8000, cutoffEnd: 8000, q: 0.7 },
      crush: { bits: 16, rate: 1 }, drive: 0,
      gain: 0.7, pan: 0,
      repeat: { count: 0, interval: 0.06, decay: 0.6, pitch: 0 },
      hits: [{ t: 0, note: 0, vel: 1, len: 0.15 }],
    };
  }
  function defaultSound(id) {
    return {
      format: FORMAT, id: id || 'sfx', name: id || 'untitled', category: 'custom', seed: 1,
      length: 0.6, steps: 16, swing: 0,
      master: { gain: 0.9, reverb: 0, room: 0.5, delay: 0, delayTime: 0.12, feedback: 0.3, normalize: true },
      layers: [defaultLayer(0)],
    };
  }
  function normalizeLayer(l, i) {
    const d = defaultLayer(i);
    l = l || {};
    const out = Object.assign({}, d, l);
    out.wave = WAVES.includes(out.wave) ? out.wave : 'square';
    for (const k of ['vib', 'fm', 'amp', 'filter', 'crush', 'repeat']) out[k] = Object.assign({}, d[k], l[k] || {});
    out.jump = l.jump && num(l.jump.at, -1) >= 0 ? { at: num(l.jump.at, 0.05), ratio: num(l.jump.ratio, 1.5) } : null;
    out.hits = Array.isArray(l.hits) && l.hits.length
      ? l.hits.map(h => ({ t: num(h.t, 0), note: num(h.note, 0), vel: clamp(num(h.vel, 1), 0, 2), len: Math.max(0.001, num(h.len, 0.15)) }))
      : [];
    out.freq = clamp(num(out.freq, 440), 1, 20000);
    out.freqEnd = clamp(num(out.freqEnd, out.freq), 1, 20000);
    return out;
  }
  function normalize(s) {
    const d = defaultSound(s && s.id);
    s = s || {};
    const out = Object.assign({}, d, s);
    out.format = FORMAT;
    out.master = Object.assign({}, d.master, s.master || {});
    out.length = clamp(num(out.length, 0.6), 0.02, MAX_SECONDS);
    out.steps = clamp(Math.round(num(out.steps, 16)), 1, 1024);
    out.swing = clamp(num(out.swing, 0), 0, 0.5);
    out.layers = (Array.isArray(s.layers) ? s.layers : d.layers).slice(0, 16).map(normalizeLayer);
    return out;
  }

  // ---------- voice rendering ----------
  const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

  function envLevel(a, h, d, s, tt) {
    if (tt < a) return tt / a;
    if (tt < a + h) return 1;
    if (tt < a + h + d) { const x = 1 - (tt - a - h) / d; return s + (1 - s) * x * x; }
    return s;
  }
  function envAt(amp, t, gate) {
    const a = amp.a > 0.0005 ? amp.a : 0.0005, h = amp.h > 0 ? amp.h : 0, d = amp.d > 0.0005 ? amp.d : 0.0005;
    const s = amp.s < 0 ? 0 : amp.s > 1 ? 1 : amp.s, r = amp.r > 0.001 ? amp.r : 0.001;
    if (t < gate) return envLevel(a, h, d, s, t);
    const x = (t - gate) / r;
    if (x >= 1) return 0;
    const y = 1 - x;
    return envLevel(a, h, d, s, gate) * y * y;
  }

  // Renders one voice (a hit or repeat) of a layer, mixing into L/R buffers.
  function renderVoice(L, R, sr, layer, start, hit, gainMul, semis, rng) {
    const gate = Math.max(hit.len, layer.amp.a + 0.001);
    const dur = gate + Math.max(0.001, layer.amp.r);
    const i0 = Math.round(start * sr);
    const n = Math.min(Math.round(dur * sr), L.length - i0);
    if (n <= 0) return;
    const pan = clamp(layer.pan, -1, 1);
    const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
    const g = layer.gain * hit.vel * gainMul;
    const pitchMul = Math.pow(2, (hit.note + semis) / 12);
    const f0 = layer.freq * pitchMul, f1 = layer.freqEnd * pitchMul;
    const slide = Math.max(0, layer.slide), curve = Math.max(0.05, layer.curve);
    const ratio = f1 / f0;
    const vib = layer.vib, fm = layer.fm, flt = layer.filter, crush = layer.crush;
    const duty = clamp(layer.duty, 0.02, 0.98);
    const bits = clamp(Math.round(crush.bits), 1, 16), q = Math.pow(2, bits - 1);
    const holdN = Math.max(1, Math.round(crush.rate));
    const drive = Math.max(0, layer.drive), dk = 1 + drive * 12, dn = Math.tanh(dk);
    const fType = flt.type;
    const fTime = flt.time > 0 ? flt.time : dur;
    let ph = 0, mph = 0, nph = 0, nval = rng() * 2 - 1;
    const mph6 = new Float64Array(6);
    let ic1 = 0, ic2 = 0, gC = 0, k = 1 / Math.max(0.1, flt.q), a1 = 0, a2 = 0, a3 = 0;
    let held = 0;
    const wave = layer.wave;
    for (let j = 0; j < n; j++) {
      const t = j / sr;
      // pitch
      let f = f0;
      if (slide > 0 && ratio !== 1) f = f0 * Math.pow(ratio, Math.pow(Math.min(t / slide, 1), curve));
      else if (slide === 0 && ratio !== 1) f = f1;
      if (layer.jump && t >= layer.jump.at) f *= layer.jump.ratio;
      if (vib.depth) f *= Math.pow(2, vib.depth * Math.sin(2 * Math.PI * vib.rate * t) / 12);
      f = clamp(f, 1, sr * 0.45);
      const env = envAt(layer.amp, t, gate);
      const inc = f / sr;
      ph += inc; if (ph >= 1) ph -= Math.floor(ph);
      let x;
      switch (wave) {
        case 'sine': x = Math.sin(2 * Math.PI * ph); break;
        case 'square': x = ph < 0.5 ? 1 : -1; break;
        case 'pulse': x = ph < duty ? 1 : -1; break;
        case 'saw': x = 2 * ph - 1; break;
        case 'triangle': x = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
        case 'noise': {
          nph += inc * 32;
          if (nph >= 1) { nph -= Math.floor(nph); nval = rng() * 2 - 1; }
          x = nval; break;
        }
        case 'fm': {
          mph += inc * fm.ratio; if (mph >= 1) mph -= Math.floor(mph);
          const idx = fm.index * (0.25 + 0.75 * env);
          x = Math.sin(2 * Math.PI * ph + idx * Math.sin(2 * Math.PI * mph)); break;
        }
        case 'metal': {
          let s = 0;
          for (let m = 0; m < 6; m++) {
            mph6[m] += inc * METAL_RATIOS[m]; if (mph6[m] >= 1) mph6[m] -= Math.floor(mph6[m]);
            s += mph6[m] < 0.5 ? 1 : -1;
          }
          x = s / 6; break;
        }
        default: x = 0;
      }
      // filter (TPT state-variable), coefficients every 16 samples
      if (fType !== 'none') {
        if ((j & 15) === 0) {
          const c = flt.cutoff * Math.pow(flt.cutoffEnd / flt.cutoff, Math.min(t / fTime, 1));
          gC = Math.tan(Math.PI * clamp(c, 20, sr * 0.45) / sr);
          a1 = 1 / (1 + gC * (gC + k)); a2 = gC * a1; a3 = gC * a2;
        }
        const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        x = fType === 'lp' ? v2 : fType === 'hp' ? x - k * v1 - v2 : fType === 'bp' ? v1 : x - k * v1; // notch fallback
      }
      if (drive > 0) x = Math.tanh(x * dk) / dn;
      if (bits < 16) x = Math.round(x * q) / q;
      if (holdN > 1) { if (j % holdN === 0) held = x; x = held; }
      x *= env * g;
      L[i0 + j] += x * pl; R[i0 + j] += x * pr;
    }
  }

  // ---------- master FX ----------
  function applyDelay(L, R, sr, time, fb, mix) {
    const D = Math.max(1, Math.round(time * sr));
    const bl = new Float32Array(D), br = new Float32Array(D);
    let p = 0;
    for (let i = 0; i < L.length; i++) {
      const dl = bl[p], dr = br[p];
      bl[p] = L[i] + dr * fb; // ping-pong
      br[p] = R[i] + dl * fb;
      L[i] += dl * mix; R[i] += dr * mix;
      p = (p + 1) % D;
    }
  }
  function applyReverb(L, R, sr, room, mix) {
    const sc = sr / 44100;
    const combs = [1116, 1188, 1277, 1356], aps = [556, 441];
    const fb = 0.7 + 0.28 * clamp(room, 0, 1), damp = 0.25;
    const mk = (spread) => ({
      c: combs.map(c => ({ b: new Float32Array(Math.round((c + spread) * sc)), p: 0, s: 0 })),
      a: aps.map(a => ({ b: new Float32Array(Math.round((a + spread) * sc)), p: 0 })),
    });
    const chans = [mk(0), mk(23)];
    const bufs = [L, R];
    for (let ch = 0; ch < 2; ch++) {
      const st = chans[ch], X = bufs[ch];
      for (let i = 0; i < X.length; i++) {
        const inp = (L[i] + R[i]) * 0.5 * 0.15;
        let out = 0;
        for (const c of st.c) {
          const y = c.b[c.p];
          c.s = y * (1 - damp) + c.s * damp;
          c.b[c.p] = inp + c.s * fb;
          c.p = (c.p + 1) % c.b.length;
          out += y;
        }
        for (const a of st.a) {
          const y = a.b[a.p];
          a.b[a.p] = out + y * 0.5;
          out = y - out;
          a.p = (a.p + 1) % a.b.length;
        }
        X[i] = X[i] + out * mix;
      }
    }
  }

  // ---------- render ----------
  function voiceSchedule(snd) {
    const stepDur = snd.length / snd.steps;
    const out = [];
    snd.layers.forEach((layer, li) => {
      if (layer.mute) return;
      const hits = layer.hits.length ? layer.hits : [];
      for (const hit of hits) {
        const t = hit.t * stepDur + (snd.swing && (Math.round(hit.t) % 2 === 1) ? snd.swing * stepDur : 0);
        const rep = layer.repeat;
        const cnt = clamp(Math.round(rep.count), 0, 32);
        for (let r = 0; r <= cnt; r++) {
          out.push({ li, start: t + r * Math.max(0.005, rep.interval), hit,
            gain: Math.pow(clamp(rep.decay, 0, 1.5), r), semis: r * rep.pitch,
            end: t + r * Math.max(0.005, rep.interval) + Math.max(hit.len, layer.amp.a) + layer.amp.r });
        }
      }
    });
    return out;
  }

  function render(input, opts) {
    opts = opts || {};
    const snd = normalize(input);
    const sr = opts.sampleRate || 44100;
    const voices = voiceSchedule(snd);
    const m = snd.master;
    let end = voices.reduce((a, v) => Math.max(a, v.end), 0.02);
    end = Math.max(end, Math.min(snd.length, end));
    let tail = 0;
    if (m.reverb > 0) tail += 0.3 + clamp(m.room, 0, 1) * 1.6;
    if (m.delay > 0) tail += m.delayTime * Math.ceil(Math.log(0.01) / Math.log(clamp(m.feedback, 0.05, 0.95)));
    const total = Math.min(MAX_SECONDS, end + tail);
    const N = Math.max(1, Math.round(total * sr));
    const L = new Float32Array(N), R = new Float32Array(N);
    voices.forEach((v, vi) => {
      const rng = mulberry32((snd.seed >>> 0) * 31 + v.li * 977 + vi * 7919 + 1);
      renderVoice(L, R, sr, snd.layers[v.li], v.start, v.hit, v.gain, v.semis, rng);
    });
    if (m.delay > 0) applyDelay(L, R, sr, clamp(m.delayTime, 0.01, 1), clamp(m.feedback, 0, 0.95), clamp(m.delay, 0, 1));
    if (m.reverb > 0) applyReverb(L, R, sr, m.room, clamp(m.reverb, 0, 1) * 2.2);
    // gain, soft clip, normalise
    let peak = 0;
    const gn = num(m.gain, 0.9);
    for (let i = 0; i < N; i++) {
      L[i] = softClip(L[i] * gn); R[i] = softClip(R[i] * gn);
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    if (m.normalize !== false && peak > 1e-6) {
      const s = 0.89 / peak;
      for (let i = 0; i < N; i++) { L[i] *= s; R[i] *= s; }
    }
    // trim trailing silence (-66 dB) and fade last 4 ms
    let last = N - 1;
    while (last > 0 && Math.abs(L[last]) < 5e-4 && Math.abs(R[last]) < 5e-4) last--;
    const len = Math.min(N, last + Math.round(0.01 * sr));
    const fade = Math.min(len, Math.round(0.004 * sr));
    for (let i = 0; i < fade; i++) { const g = i / fade; L[len - 1 - i] *= g; R[len - 1 - i] *= g; }
    return { sampleRate: sr, left: L.subarray(0, len), right: R.subarray(0, len), duration: len / sr, sound: snd };
  }
  function softClip(x) { return x > 1 || x < -1 ? Math.tanh(x) : x - (x * x * x) / 30; }

  // ---------- analysis ----------
  function analyze(r, bins) {
    bins = bins || 64;
    const L = r.left, R = r.right, N = L.length;
    let peak = 0, sum = 0, zc = 0, prev = 0, stereo = 0;
    const env = new Array(bins).fill(0);
    for (let i = 0; i < N; i++) {
      const m = (L[i] + R[i]) * 0.5;
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      peak = Math.max(peak, a); sum += m * m; stereo += Math.abs(L[i] - R[i]);
      if ((m >= 0) !== (prev >= 0)) zc++;
      prev = m;
      const b = Math.min(bins - 1, Math.floor(i / N * bins));
      env[b] = Math.max(env[b], a);
    }
    const rms = Math.sqrt(sum / Math.max(1, N));
    const db = (v) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);
    let attackMs = 0;
    for (let i = 0; i < N; i++) if (Math.max(Math.abs(L[i]), Math.abs(R[i])) >= peak * 0.9) { attackMs = Math.round(i / r.sampleRate * 1000); break; }
    const bright = zc / 2 / (N / r.sampleRate);
    return {
      duration: Math.round(r.duration * 1000) / 1000, peakDb: db(peak), rmsDb: db(rms),
      attackMs, approxPitchOrBrightnessHz: Math.round(bright),
      character: bright > 4000 ? 'bright/noisy' : bright > 1200 ? 'mid' : bright > 300 ? 'warm' : 'deep',
      stereoWidth: Math.round(stereo / Math.max(1, N) / Math.max(1e-6, peak) * 100) / 100,
      envelope: env.map(v => Math.round(v * 100) / 100),
    };
  }

  // ---------- WAV ----------
  function encodeWav(r, opts) {
    opts = opts || {};
    const ch = opts.mono ? 1 : 2, sr = r.sampleRate, N = r.left.length;
    const bytes = 44 + N * ch * 2;
    const buf = new ArrayBuffer(bytes), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, N * ch * 2, true);
    let o = 44;
    const s16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    for (let i = 0; i < N; i++) {
      if (ch === 1) { dv.setInt16(o, s16((r.left[i] + r.right[i]) / 2), true); o += 2; }
      else { dv.setInt16(o, s16(r.left[i]), true); dv.setInt16(o + 2, s16(r.right[i]), true); o += 4; }
    }
    return new Uint8Array(buf);
  }

  // ---------- generators ----------
  // Each returns a full sound for a game-SFX category, deterministic in seed.
  function gen(category, seed, opts) {
    if (category === 'random') return randomize(seed, opts && opts.wildness);
    if (category === 'music') return compose(seed, opts || {});
    const rng = mulberry32(seed);
    const R = (a, b) => a + (b - a) * rng();
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const chance = (p) => rng() < p;
    const L = (o) => Object.assign(defaultLayer(0), o);
    const s = defaultSound(category + '-' + seed);
    s.category = category; s.seed = seed; s.name = category + ' ' + seed.toString(36);
    let layers = [], length = 0.5, master = {};
    switch (category) {
      case 'coin': {
        const f = R(700, 1300);
        layers = [L({ name: 'ping', wave: pick(['square', 'pulse', 'triangle']), duty: R(0.2, 0.5), freq: f, freqEnd: f,
          jump: { at: R(0.04, 0.09), ratio: pick([1.335, 1.5, 2]) }, amp: { a: 0.001, h: R(0.03, 0.08), d: R(0.15, 0.35), s: 0, r: 0.04 },
          hits: [{ t: 0, note: 0, vel: 1, len: 0.3 }] })];
        length = 0.4; break;
      }
      case 'pickup': {
        const f = R(500, 900);
        layers = [L({ name: 'rise', wave: pick(['square', 'triangle', 'sine']), freq: f, freqEnd: f * R(1.5, 2.5), slide: R(0.06, 0.15),
          amp: { a: 0.002, h: 0.02, d: R(0.1, 0.2), s: 0, r: 0.03 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.15 }],
          repeat: { count: chance(0.5) ? 2 : 0, interval: R(0.05, 0.08), decay: 0.6, pitch: pick([5, 7, 12]) } })];
        length = 0.35; break;
      }
      case 'jump': {
        const f = R(180, 380);
        layers = [L({ name: 'hop', wave: pick(['square', 'pulse']), duty: R(0.25, 0.5), freq: f, freqEnd: f * R(2, 3.5), slide: R(0.12, 0.22), curve: R(0.5, 1),
          amp: { a: 0.002, h: 0.02, d: R(0.15, 0.25), s: 0, r: 0.03 }, filter: { type: 'lp', cutoff: 5000, cutoffEnd: 2500, q: 0.7 },
          hits: [{ t: 0, note: 0, vel: 1, len: 0.22 }] })];
        length = 0.3; break;
      }
      case 'laser': case 'shoot': {
        const f = R(900, 2200);
        layers = [L({ name: 'zap', wave: pick(['saw', 'square', 'pulse']), duty: R(0.1, 0.4), freq: f, freqEnd: f * R(0.08, 0.25), slide: R(0.1, 0.25), curve: R(0.4, 0.8),
          vib: chance(0.3) ? { rate: R(20, 50), depth: R(0.5, 2) } : { rate: 0, depth: 0 },
          amp: { a: 0.001, h: 0.01, d: R(0.12, 0.25), s: 0, r: 0.03 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.2 }] })];
        if (category === 'shoot') layers.push(L({ name: 'burst', wave: 'noise', freq: R(2000, 5000), freqEnd: 800, slide: 0.1, gain: 0.4,
          amp: { a: 0.001, h: 0, d: 0.06, s: 0, r: 0.02 }, filter: { type: 'hp', cutoff: 1500, cutoffEnd: 1500, q: 0.7 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.05 }] }));
        master = { delay: chance(0.4) ? 0.25 : 0, delayTime: R(0.06, 0.12), feedback: 0.3 };
        length = 0.35; break;
      }
      case 'explosion': {
        layers = [
          L({ name: 'blast', wave: 'noise', freq: R(60, 200), freqEnd: R(15, 40), slide: R(0.4, 0.8), amp: { a: 0.002, h: R(0.02, 0.08), d: R(0.5, 1), s: 0, r: 0.2 },
            filter: { type: 'lp', cutoff: R(3000, 7000), cutoffEnd: R(150, 400), q: 0.8 }, drive: R(0.2, 0.6), gain: 0.9, hits: [{ t: 0, note: 0, vel: 1, len: 0.8 }] }),
          L({ name: 'thump', wave: 'sine', freq: R(90, 140), freqEnd: R(30, 45), slide: R(0.15, 0.3), amp: { a: 0.001, h: 0.03, d: R(0.3, 0.5), s: 0, r: 0.1 },
            drive: R(0.2, 0.5), gain: 0.8, hits: [{ t: 0, note: 0, vel: 1, len: 0.4 }] }),
        ];
        if (chance(0.5)) layers.push(L({ name: 'debris', wave: 'noise', freq: R(800, 2000), freqEnd: 400, slide: 0.3, gain: 0.25,
          amp: { a: 0.01, h: 0, d: 0.25, s: 0, r: 0.1 }, filter: { type: 'bp', cutoff: 2500, cutoffEnd: 900, q: 2 },
          hits: [{ t: 3, note: 0, vel: 0.8, len: 0.2 }, { t: 6, note: 0, vel: 0.5, len: 0.2 }] }));
        master = { reverb: R(0.15, 0.35), room: R(0.5, 0.9) };
        length = 1.4; break;
      }
      case 'hit': case 'punch': case 'kick': {
        const heavy = category === 'kick' ? 1.3 : category === 'punch' ? 1 : 0.7;
        layers = [
          L({ name: 'smack', wave: 'noise', freq: R(1500, 4000), freqEnd: R(300, 800), slide: 0.08, amp: { a: 0.0005, h: 0.005, d: R(0.04, 0.09) * heavy, s: 0, r: 0.03 },
            filter: { type: 'lp', cutoff: R(4000, 9000), cutoffEnd: R(800, 2000), q: 1 }, drive: R(0.3, 0.7), gain: 0.8, hits: [{ t: 0, note: 0, vel: 1, len: 0.06 }] }),
          L({ name: 'body', wave: pick(['sine', 'triangle']), freq: R(140, 260) / heavy, freqEnd: R(40, 70), slide: R(0.06, 0.14) * heavy, amp: { a: 0.0005, h: 0.01, d: R(0.1, 0.2) * heavy, s: 0, r: 0.04 },
            drive: R(0.3, 0.8), gain: 0.9, hits: [{ t: 0, note: 0, vel: 1, len: 0.12 }] }),
        ];
        if (category === 'punch' || chance(0.4)) layers.push(L({ name: 'swish', wave: 'noise', freq: 3000, freqEnd: 6000, slide: 0.05, gain: 0.25,
          amp: { a: 0.02, h: 0, d: 0.03, s: 0, r: 0.01 }, filter: { type: 'bp', cutoff: 1500, cutoffEnd: 5000, q: 1.5 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.04 }] }));
        // swish leads the impact for punch
        if (category === 'punch') { layers[0].hits[0].t = 1; layers[1].hits[0].t = 1; }
        master = { reverb: chance(0.5) ? R(0.05, 0.15) : 0, room: 0.3 };
        length = 0.32; s.steps = 16; break;
      }
      case 'block': {
        layers = [
          L({ name: 'clang', wave: 'metal', freq: R(300, 600), freqEnd: R(280, 560), slide: 0.2, amp: { a: 0.0005, h: 0.01, d: R(0.2, 0.4), s: 0, r: 0.1 },
            filter: { type: 'hp', cutoff: 800, cutoffEnd: 1500, q: 0.7 }, gain: 0.6, hits: [{ t: 0, note: 0, vel: 1, len: 0.3 }] }),
          L({ name: 'tick', wave: 'noise', freq: 6000, freqEnd: 6000, amp: { a: 0.0005, h: 0, d: 0.02, s: 0, r: 0.01 }, gain: 0.5, hits: [{ t: 0, note: 0, vel: 1, len: 0.02 }] }),
        ];
        master = { reverb: R(0.1, 0.25), room: 0.4 };
        length = 0.6; break;
      }
      case 'hurt': {
        const f = R(300, 600);
        layers = [L({ name: 'ouch', wave: pick(['saw', 'square']), freq: f, freqEnd: f * R(0.3, 0.5), slide: R(0.15, 0.3),
          vib: { rate: R(15, 35), depth: R(0.5, 2) }, crush: { bits: Math.round(R(4, 8)), rate: 1 },
          amp: { a: 0.002, h: 0.02, d: R(0.15, 0.3), s: 0, r: 0.05 }, filter: { type: 'lp', cutoff: 4000, cutoffEnd: 1200, q: 1 },
          hits: [{ t: 0, note: 0, vel: 1, len: 0.25 }] })];
        length = 0.4; break;
      }
      case 'whoosh': case 'dash': {
        const up = R(400, 900);
        layers = [L({ name: 'air', wave: 'noise', freq: 5000, freqEnd: 5000, amp: { a: R(0.05, 0.12), h: 0, d: R(0.12, 0.25), s: 0, r: 0.05 },
          filter: { type: 'bp', cutoff: up, cutoffEnd: up * R(4, 8), q: R(1.5, 3), time: 0.15 }, gain: 0.9, pan: R(-0.3, 0.3),
          hits: [{ t: 0, note: 0, vel: 1, len: 0.2 }] })];
        if (category === 'dash') layers.push(L({ name: 'kick-off', wave: 'sine', freq: 180, freqEnd: 60, slide: 0.06, gain: 0.5,
          amp: { a: 0.001, h: 0, d: 0.06, s: 0, r: 0.02 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.05 }] }));
        length = 0.4; break;
      }
      case 'powerup': {
        const f = R(250, 450), step = pick([[0, 4, 7, 12], [0, 5, 7, 12], [0, 3, 7, 10, 12], [0, 7, 12, 19]]);
        layers = [L({ name: 'arp', wave: pick(['square', 'pulse', 'triangle']), duty: R(0.25, 0.5), freq: f, freqEnd: f * 1.06, slide: 0.08,
          vib: { rate: R(6, 10), depth: 0.2 }, amp: { a: 0.002, h: 0.03, d: 0.08, s: 0.4, r: 0.05 },
          hits: step.map((n, i) => ({ t: i * 2, note: n, vel: 0.8 + i * 0.05, len: 0.07 })) })];
        master = { delay: R(0.1, 0.3), delayTime: R(0.07, 0.11), feedback: 0.3 };
        s.steps = 16; length = 0.7; break;
      }
      case 'blip': case 'select': {
        const f = R(600, 1600);
        layers = [L({ name: 'blip', wave: pick(['square', 'pulse', 'sine', 'triangle']), duty: R(0.2, 0.5), freq: f, freqEnd: f,
          amp: { a: 0.001, h: R(0.01, 0.04), d: R(0.03, 0.08), s: 0, r: 0.02 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.05 }] })];
        if (category === 'select') layers[0].hits.push({ t: 2, note: pick([5, 7, 12]), vel: 0.9, len: 0.06 });
        length = 0.25; s.steps = 16; break;
      }
      case 'confirm': case 'cancel': {
        const f = R(500, 900), up = category === 'confirm';
        layers = [L({ name: 'ui', wave: pick(['square', 'triangle', 'sine']), freq: f, freqEnd: f,
          amp: { a: 0.002, h: 0.02, d: 0.08, s: 0.2, r: 0.04 },
          hits: up ? [{ t: 0, note: 0, vel: 0.9, len: 0.06 }, { t: 2, note: pick([7, 12]), vel: 1, len: 0.12 }]
            : [{ t: 0, note: 0, vel: 1, len: 0.06 }, { t: 2, note: pick([-5, -7]), vel: 0.8, len: 0.1 }] })];
        length = 0.3; s.steps = 16; break;
      }
      case 'magic': {
        const f = R(500, 1000);
        layers = [
          L({ name: 'sparkle', wave: 'fm', fm: { ratio: pick([3.5, 4.01, 5.03, 7]), index: R(1.5, 4) }, freq: f, freqEnd: f * R(1.2, 2), slide: 0.4,
            amp: { a: 0.01, h: 0.02, d: 0.2, s: 0.1, r: 0.15 }, hits: [0, 1, 2, 3, 4].map(i => ({ t: i, note: [0, 4, 7, 11, 14][i], vel: 0.8, len: 0.12 })) }),
          L({ name: 'shimmer', wave: 'noise', freq: 8000, freqEnd: 8000, gain: 0.15, amp: { a: 0.05, h: 0, d: 0.3, s: 0, r: 0.1 },
            filter: { type: 'hp', cutoff: 6000, cutoffEnd: 9000, q: 0.7 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.3 }] }),
        ];
        master = { reverb: R(0.25, 0.45), room: R(0.6, 0.9), delay: 0.2, delayTime: 0.09, feedback: 0.35 };
        s.steps = 16; length = 0.5; break;
      }
      case 'ko': case 'victory': case 'gameover': {
        const root = R(200, 330);
        const scale = category === 'gameover' ? [12, 7, 3, 0] : category === 'ko' ? [0, 0, 7, 12] : [0, 4, 7, 12, 7, 12];
        layers = [
          L({ name: 'lead', wave: pick(['square', 'pulse']), duty: 0.33, freq: root, freqEnd: root, vib: { rate: 6, depth: 0.15 },
            amp: { a: 0.003, h: 0.02, d: 0.1, s: 0.5, r: 0.08 }, filter: { type: 'lp', cutoff: 4500, cutoffEnd: 4500, q: 0.7 },
            hits: scale.map((n, i) => ({ t: i * 3, note: n, vel: 0.9, len: i === scale.length - 1 ? 0.5 : 0.13 })) }),
          L({ name: 'bass', wave: 'triangle', freq: root / 2, freqEnd: root / 2, gain: 0.6, amp: { a: 0.003, h: 0.02, d: 0.2, s: 0.4, r: 0.1 },
            hits: [{ t: 0, note: 0, vel: 1, len: 0.3 }, { t: (scale.length - 1) * 3, note: scale[scale.length - 1] % 12, vel: 1, len: 0.5 }] }),
        ];
        if (category === 'ko') layers.push(L({ name: 'boom', wave: 'noise', freq: 120, freqEnd: 30, slide: 0.4, gain: 0.7, drive: 0.5,
          amp: { a: 0.001, h: 0.04, d: 0.5, s: 0, r: 0.2 }, filter: { type: 'lp', cutoff: 2500, cutoffEnd: 200, q: 0.8 }, hits: [{ t: 0, note: 0, vel: 1, len: 0.5 }] }));
        master = { reverb: 0.2, room: 0.6 };
        s.steps = 24; length = 1.4; break;
      }
      default: return gen('blip', seed);
    }
    s.layers = layers.map((l, i) => Object.assign(l, { id: 'L' + (i + 1) }));
    s.length = length;
    s.master = Object.assign(s.master, master);
    return normalize(s);
  }

  // ---------- randomizer ----------
  // Builds a sound from scratch out of 1-4 layers, each given a random role.
  // wildness 0 = tidy and short, 1 = more layers, bigger sweeps, crush, echo.
  // Rerolls internally (deterministically) until the result is audible and not too long.
  const SYL_A = ['b', 'z', 'k', 'p', 'tw', 'bl', 'fr', 'gl', 'sk', 'dr', 'v', 'pl', 'kr', 'sn', 'w', 'zh'];
  const SYL_B = ['a', 'o', 'i', 'u', 'ee', 'oo', 'ai', 'e'];
  const SYL_C = ['p', 'rp', 'nk', 'zz', 'm', 'b', 'sh', 'x', 't', 'ng', 'k', 'ff'];
  function buildRandom(seed, w, noiseSeed) {
    const rng = mulberry32(seed);
    const R = (a, b) => a + (b - a) * rng();
    const E = (a, b) => a * Math.pow(b / a, rng()); // exponential range
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const chance = (p) => rng() < p;
    const s = defaultSound('random-' + noiseSeed.toString(36));
    s.category = 'random'; s.seed = noiseSeed;
    s.name = pick(SYL_A) + pick(SYL_B) + pick(SYL_C) + (chance(0.3) ? '-' + pick(SYL_A) + pick(SYL_B) + pick(SYL_C) : '');
    s.steps = pick([8, 16, 16, 16, 24, 32]);
    s.length = R(0.2, 0.45 + w * 0.9);
    const scale = pick([[0, 3, 5, 7, 10, 12, 15], [0, 2, 4, 7, 9, 12, 14], [0, 2, 3, 7, 8, 12], [0, 1, 5, 6, 10, 12]]);
    const n = Math.min(4, 1 + Math.floor(rng() * (1.6 + w * 2.6)));
    const roles = ['tone', 'sweep', 'noise', 'thump', 'arp', 'ring', 'zap'];
    const layers = [];
    for (let i = 0; i < n; i++) {
      const role = i === 0 ? pick(['tone', 'sweep', 'zap', 'arp', 'thump', 'noise']) : pick(roles);
      const l = defaultLayer(i);
      l.name = role;
      const startStep = i === 0 ? 0 : (chance(0.55) ? 0 : Math.floor(rng() * s.steps * (0.15 + w * 0.4)));
      const one = (len) => [{ t: startStep, note: 0, vel: 1, len }];
      switch (role) {
        case 'tone': {
          l.wave = pick(['square', 'pulse', 'triangle', 'sine', 'saw']); l.duty = R(0.1, 0.5);
          l.freq = E(160, 1400); l.freqEnd = l.freq * Math.pow(2, R(-1, 1) * w * 1.5); l.slide = R(0, 0.25);
          l.amp = { a: E(0.001, 0.02), h: R(0, 0.06), d: E(0.05, 0.4), s: chance(0.3) ? R(0.1, 0.5) : 0, r: E(0.02, 0.15) };
          const k = 1 + Math.floor(rng() * (1 + w * 2.5));
          l.hits = Array.from({ length: k }, (_, j) => ({ t: Math.min(s.steps - 1, startStep + j * pick([1, 2, 2, 3, 4])), note: j ? pick(scale) : 0, vel: R(0.7, 1), len: E(0.04, 0.2) }));
          break;
        }
        case 'sweep': {
          l.wave = pick(['square', 'saw', 'triangle', 'pulse', 'sine']); l.duty = R(0.15, 0.5);
          l.freq = E(120, 900); l.freqEnd = l.freq * Math.pow(2, (chance(0.5) ? 1 : -1) * R(1, 2.5 + w * 2));
          l.slide = E(0.06, 0.35 + w * 0.4); l.curve = E(0.4, 2);
          l.amp = { a: E(0.001, 0.03), h: R(0, 0.08), d: E(0.1, 0.5), s: 0, r: E(0.02, 0.1) };
          l.hits = one(E(0.1, 0.4));
          break;
        }
        case 'zap': {
          l.wave = pick(['saw', 'square', 'pulse']); l.duty = R(0.08, 0.4);
          l.freq = E(700, 2800); l.freqEnd = l.freq * R(0.05, 0.3); l.slide = E(0.06, 0.3); l.curve = R(0.3, 0.9);
          l.amp = { a: 0.001, h: R(0, 0.02), d: E(0.08, 0.3), s: 0, r: 0.03 };
          l.hits = one(0.15);
          break;
        }
        case 'noise': {
          l.wave = 'noise'; l.freq = E(80, 8000); l.freqEnd = l.freq * Math.pow(2, R(-2, 1));
          l.slide = E(0.05, 0.5);
          const ft = pick(['lp', 'lp', 'bp', 'hp', 'none']);
          const c = E(300, 9000);
          l.filter = { type: ft, cutoff: c, cutoffEnd: c * Math.pow(2, R(-3, 2)), q: E(0.6, ft === 'bp' ? 4 : 2) };
          l.amp = { a: chance(0.25) ? E(0.02, 0.15) : 0.001, h: R(0, 0.05), d: E(0.04, 0.5 + w * 0.5), s: 0, r: E(0.02, 0.2) };
          l.gain = R(0.4, 0.85);
          l.hits = one(E(0.04, 0.3));
          break;
        }
        case 'thump': {
          l.wave = pick(['sine', 'triangle']); l.freq = E(90, 260); l.freqEnd = E(32, 70); l.slide = E(0.04, 0.2);
          l.amp = { a: 0.0008, h: R(0, 0.03), d: E(0.08, 0.35), s: 0, r: 0.04 }; l.drive = R(0.2, 0.7);
          l.hits = one(0.12);
          break;
        }
        case 'arp': {
          l.wave = pick(['square', 'pulse', 'triangle']); l.duty = R(0.15, 0.5);
          l.freq = E(220, 700); l.freqEnd = l.freq;
          l.amp = { a: 0.002, h: R(0.01, 0.03), d: E(0.04, 0.12), s: R(0.2, 0.5), r: 0.04 };
          const k = 3 + Math.floor(rng() * (2 + w * 3)), gap = pick([1, 1, 2, 2, 3]);
          const dir = pick([1, 1, -1, 0]);
          l.hits = Array.from({ length: k }, (_, j) => {
            const idx = dir === 0 ? Math.floor(rng() * scale.length) : dir > 0 ? j % scale.length : (scale.length - 1 - (j % scale.length));
            return { t: Math.min(s.steps - 1, startStep + j * gap), note: scale[idx], vel: R(0.7, 1), len: E(0.04, 0.1) };
          });
          l.gain = 0.6;
          break;
        }
        case 'ring': {
          l.wave = pick(['metal', 'fm', 'fm']); l.fm = { ratio: pick([1.41, 2.76, 3.5, 4.01, 5.03, 7.13]), index: R(1, 6) };
          l.freq = E(200, 1200); l.freqEnd = l.freq * Math.pow(2, R(-0.3, 0.3));
          l.slide = R(0.1, 0.6);
          l.amp = { a: E(0.001, 0.02), h: 0, d: E(0.15, 0.8), s: 0, r: E(0.05, 0.3) };
          if (l.wave === 'metal') l.filter = { type: 'hp', cutoff: E(600, 3000), cutoffEnd: E(600, 4000), q: 0.7 };
          l.gain = R(0.35, 0.6);
          l.hits = one(E(0.1, 0.5));
          break;
        }
      }
      // spices, scaled by wildness
      if (chance(0.12 + w * 0.4)) l.vib = { rate: E(3, 45), depth: E(0.2, 1 + w * 4) };
      if (chance(0.08 + w * 0.35)) l.crush = { bits: Math.round(R(3, 9)), rate: chance(0.5) ? Math.round(R(1, 5)) : 1 };
      if (chance(0.1 + w * 0.3) && role !== 'arp') l.repeat = { count: Math.round(R(1, 2 + w * 5)), interval: E(0.03, 0.15), decay: R(0.4, 0.85), pitch: pick([0, 0, 2, 5, 7, 12, -5, -12]) };
      if (chance(0.15) && (role === 'tone' || role === 'sweep')) l.jump = { at: E(0.03, 0.15), ratio: pick([1.335, 1.5, 2, 0.75, 0.5]) };
      if (role !== 'thump') l.drive = Math.max(l.drive, chance(w * 0.6) ? R(0, w * 0.7) : 0);
      l.pan = n > 1 ? R(-0.5, 0.5) * w : 0;
      l.id = 'L' + (i + 1);
      layers.push(l);
    }
    s.layers = layers;
    if (chance(0.25 + w * 0.35)) { s.master.reverb = R(0.08, 0.2 + w * 0.3); s.master.room = R(0.3, 0.9); }
    if (chance(0.15 + w * 0.25)) { s.master.delay = R(0.12, 0.35); s.master.delayTime = E(0.05, 0.2); s.master.feedback = R(0.2, 0.5); }
    return normalize(s);
  }
  function randomize(seed, wildness) {
    seed = seed >>> 0;
    const w = clamp(num(wildness, 0.5), 0, 1);
    let s = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      s = buildRandom((seed + attempt * 7919) >>> 0, w, seed);
      const a = analyze(render(s), 8);
      if (a.rmsDb > -30 && a.duration < 3.5) break;
    }
    s.wildness = w;
    return s;
  }

  // ---------- music ----------
  // compose(seed, {style, seconds, bpm, root, wildness, borrow, parts}) writes a full arranged track
  // in the same format: one layer per instrument, one 16th-note step per grid column, one chord per bar.
  // Song-level choices (tempo, key, scale, structure) come from `seed`; each part (drums, bass,
  // chords, lead) has its own seed in `parts`, so one part can be rerolled without touching the rest.
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], harmonic: [0, 2, 3, 5, 7, 8, 11], phrygian: [0, 1, 3, 5, 7, 8, 10] };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const HP = (c) => ({ type: 'hp', cutoff: c, cutoffEnd: c, q: 0.7 });

  // drum kits: kick / snare / hat (+ open hat)
  const KITS = {
    chip: { kick: { wave: 'triangle', freq: 220, freqEnd: 45, slide: 0.06, curve: 0.6, amp: { a: 0.001, h: 0.01, d: 0.2, s: 0, r: 0.04 }, crush: { bits: 5, rate: 2 }, gain: 0.95 },
      snare: { wave: 'noise', freq: 1800, freqEnd: 900, slide: 0.1, amp: { a: 0.001, h: 0.005, d: 0.12, s: 0, r: 0.04 }, crush: { bits: 5, rate: 2 }, gain: 0.5 },
      hat: { wave: 'noise', freq: 9000, freqEnd: 9000, amp: { a: 0.0008, h: 0, d: 0.03, s: 0, r: 0.02 }, filter: HP(7000), crush: { bits: 5, rate: 2 }, gain: 0.18 } },
    acoustic: { kick: { wave: 'sine', freq: 160, freqEnd: 45, slide: 0.07, curve: 0.6, amp: { a: 0.001, h: 0.01, d: 0.24, s: 0, r: 0.05 }, drive: 0.35, gain: 0.95 },
      snare: { wave: 'noise', freq: 5500, freqEnd: 3000, slide: 0.1, amp: { a: 0.001, h: 0.005, d: 0.14, s: 0, r: 0.05 }, filter: { type: 'lp', cutoff: 7000, cutoffEnd: 2200, q: 0.8 }, gain: 0.55 },
      hat: { wave: 'noise', freq: 9000, freqEnd: 9000, amp: { a: 0.0008, h: 0, d: 0.035, s: 0, r: 0.02 }, filter: HP(7000), gain: 0.18 } },
    tr808: { kick: { wave: 'sine', freq: 75, freqEnd: 40, slide: 0.05, amp: { a: 0.001, h: 0.03, d: 0.55, s: 0, r: 0.1 }, drive: 0.25, gain: 1 },
      snare: { wave: 'noise', freq: 4000, freqEnd: 4000, amp: { a: 0.001, h: 0.004, d: 0.16, s: 0, r: 0.05 }, filter: { type: 'bp', cutoff: 1600, cutoffEnd: 1300, q: 0.9 }, repeat: { count: 2, interval: 0.011, decay: 0.8, pitch: 0 }, gain: 0.55 },
      hat: { wave: 'noise', freq: 9000, freqEnd: 9000, amp: { a: 0.0008, h: 0, d: 0.025, s: 0, r: 0.015 }, filter: HP(8000), gain: 0.16 } },
    house: { kick: { wave: 'sine', freq: 140, freqEnd: 48, slide: 0.04, amp: { a: 0.001, h: 0.015, d: 0.3, s: 0, r: 0.05 }, drive: 0.4, gain: 0.95 },
      snare: { wave: 'noise', freq: 4500, freqEnd: 4500, amp: { a: 0.001, h: 0.004, d: 0.12, s: 0, r: 0.04 }, filter: { type: 'bp', cutoff: 1800, cutoffEnd: 1500, q: 0.9 }, repeat: { count: 2, interval: 0.01, decay: 0.8, pitch: 0 }, gain: 0.5 },
      hat: { wave: 'noise', freq: 9000, freqEnd: 9000, amp: { a: 0.0008, h: 0, d: 0.02, s: 0, r: 0.015 }, filter: HP(8000), gain: 0.13 },
      ohat: { wave: 'noise', freq: 8000, freqEnd: 8000, amp: { a: 0.001, h: 0, d: 0.18, s: 0, r: 0.05 }, filter: HP(6500), gain: 0.13 } },
    lofi: { kick: { wave: 'sine', freq: 150, freqEnd: 45, slide: 0.07, amp: { a: 0.002, h: 0.01, d: 0.18, s: 0, r: 0.05 }, drive: 0.15, crush: { bits: 8, rate: 2 }, gain: 0.9 },
      snare: { wave: 'noise', freq: 5000, freqEnd: 3000, slide: 0.1, amp: { a: 0.002, h: 0.005, d: 0.13, s: 0, r: 0.05 }, filter: { type: 'lp', cutoff: 3200, cutoffEnd: 2000, q: 0.8 }, crush: { bits: 8, rate: 2 }, gain: 0.42 },
      hat: { wave: 'noise', freq: 9000, freqEnd: 9000, amp: { a: 0.001, h: 0, d: 0.03, s: 0, r: 0.02 }, filter: HP(6500), crush: { bits: 8, rate: 2 }, gain: 0.16 } },
    breaks: { kick: { wave: 'sine', freq: 150, freqEnd: 50, slide: 0.05, amp: { a: 0.001, h: 0.01, d: 0.2, s: 0, r: 0.04 }, drive: 0.5, gain: 0.95 },
      snare: { wave: 'noise', freq: 4000, freqEnd: 2500, slide: 0.12, amp: { a: 0.001, h: 0.006, d: 0.16, s: 0, r: 0.05 }, filter: { type: 'lp', cutoff: 8000, cutoffEnd: 3000, q: 0.8 }, drive: 0.3, gain: 0.6 },
      hat: { wave: 'noise', freq: 10000, freqEnd: 10000, amp: { a: 0.0008, h: 0, d: 0.025, s: 0, r: 0.015 }, filter: HP(8000), gain: 0.15 } },
  };
  const BASSES = {
    tri: { wave: 'triangle', amp: { a: 0.002, h: 0.02, d: 0.1, s: 0.6, r: 0.03 }, gain: 0.62 },
    sawlp: { wave: 'saw', amp: { a: 0.002, h: 0.01, d: 0.12, s: 0.5, r: 0.03 }, filter: { type: 'lp', cutoff: 1100, cutoffEnd: 500, q: 1.2, time: 0.12 }, drive: 0.3, gain: 0.55 },
    slap: { wave: 'fm', fm: { ratio: 1, index: 2.6 }, amp: { a: 0.002, h: 0.01, d: 0.18, s: 0.3, r: 0.04 }, gain: 0.6 },
    sub: { wave: 'sine', amp: { a: 0.005, h: 0.02, d: 0.35, s: 0.5, r: 0.08 }, drive: 0.15, gain: 0.7 },
    square: { wave: 'square', amp: { a: 0.002, h: 0.01, d: 0.1, s: 0.5, r: 0.03 }, filter: { type: 'lp', cutoff: 900, cutoffEnd: 600, q: 1 }, gain: 0.45 },
    reese: { wave: 'saw', vib: { rate: 0.3, depth: 0.25 }, amp: { a: 0.01, h: 0.02, d: 0.3, s: 0.8, r: 0.1 }, filter: { type: 'lp', cutoff: 700, cutoffEnd: 400, q: 2.5, time: 0.4 }, drive: 0.4, gain: 0.5 },
    boom: { wave: 'sine', glide: 0.94, slide: 0.12, amp: { a: 0.002, h: 0.05, d: 0.7, s: 0.5, r: 0.15 }, drive: 0.35, gain: 0.85 },
    pluck: { wave: 'pulse', duty: 0.3, amp: { a: 0.001, h: 0, d: 0.12, s: 0, r: 0.03 }, filter: { type: 'lp', cutoff: 2400, cutoffEnd: 500, q: 2, time: 0.12 }, gain: 0.55 },
  };
  const KEYS = {
    pulse: { wave: 'pulse', duty: 0.25, amp: { a: 0.002, h: 0.02, d: 0.08, s: 0.4, r: 0.04 }, gain: 0.11 },
    sawstab: { wave: 'saw', amp: { a: 0.002, h: 0.02, d: 0.12, s: 0.4, r: 0.05 }, filter: { type: 'lp', cutoff: 3200, cutoffEnd: 1800, q: 0.9, time: 0.15 }, drive: 0.35, gain: 0.13 },
    epiano: { wave: 'fm', fm: { ratio: 1, index: 1.3 }, amp: { a: 0.003, h: 0.02, d: 0.5, s: 0.25, r: 0.15 }, gain: 0.14 },
    pad: { wave: 'saw', amp: { a: 0.25, h: 0, d: 0.5, s: 0.7, r: 0.5 }, filter: { type: 'lp', cutoff: 1900, cutoffEnd: 1500, q: 0.8 }, vib: { rate: 0.4, depth: 0.08 }, gain: 0.1 },
    soft: { wave: 'triangle', amp: { a: 0.01, h: 0.02, d: 0.6, s: 0.3, r: 0.3 }, filter: { type: 'lp', cutoff: 2200, cutoffEnd: 1600, q: 0.7 }, crush: { bits: 9, rate: 2 }, gain: 0.16 },
    organ: { wave: 'square', amp: { a: 0.004, h: 0.02, d: 0.1, s: 0.8, r: 0.06 }, filter: { type: 'lp', cutoff: 2600, cutoffEnd: 2600, q: 0.7 }, gain: 0.08 },
    bell: { wave: 'fm', fm: { ratio: 3.5, index: 1.8 }, amp: { a: 0.002, h: 0.01, d: 0.8, s: 0.1, r: 0.3 }, gain: 0.12 },
    strings: { wave: 'saw', amp: { a: 0.35, h: 0, d: 0.6, s: 0.8, r: 0.6 }, vib: { rate: 5, depth: 0.1 }, filter: { type: 'lp', cutoff: 2600, cutoffEnd: 2200, q: 0.6 }, gain: 0.09 },
  };
  const LEADS = {
    square: { wave: 'square', vib: { rate: 6, depth: 0.15 }, amp: { a: 0.003, h: 0.02, d: 0.1, s: 0.6, r: 0.05 }, gain: 0.26 },
    pulse: { wave: 'pulse', duty: 0.25, vib: { rate: 6, depth: 0.15 }, amp: { a: 0.003, h: 0.02, d: 0.1, s: 0.6, r: 0.05 }, gain: 0.3 },
    saw: { wave: 'saw', vib: { rate: 5.5, depth: 0.14 }, amp: { a: 0.005, h: 0.02, d: 0.12, s: 0.6, r: 0.08 }, filter: { type: 'lp', cutoff: 4200, cutoffEnd: 4200, q: 1 }, drive: 0.15, gain: 0.23 },
    bell: { wave: 'fm', fm: { ratio: 2, index: 1.6 }, amp: { a: 0.003, h: 0.02, d: 0.25, s: 0.35, r: 0.12 }, gain: 0.28 },
    flute: { wave: 'sine', vib: { rate: 5, depth: 0.2 }, amp: { a: 0.03, h: 0.02, d: 0.2, s: 0.7, r: 0.12 }, gain: 0.32 },
    soft: { wave: 'triangle', amp: { a: 0.01, h: 0.02, d: 0.3, s: 0.4, r: 0.2 }, crush: { bits: 10, rate: 1 }, gain: 0.3 },
    pluck: { wave: 'pulse', duty: 0.4, amp: { a: 0.001, h: 0, d: 0.15, s: 0.05, r: 0.05 }, filter: { type: 'lp', cutoff: 5000, cutoffEnd: 1200, q: 1.5, time: 0.15 }, gain: 0.3 },
    sync: { wave: 'saw', amp: { a: 0.003, h: 0.02, d: 0.15, s: 0.5, r: 0.06 }, filter: { type: 'bp', cutoff: 2600, cutoffEnd: 900, q: 3, time: 0.2 }, drive: 0.3, gain: 0.3 },
  };
  const R8 = [0, 2, 4, 6, 8, 10, 12, 14], R16 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], OFF8 = [2, 6, 10, 14];
  // bass patterns are [step, semitones above the chord root]; comp patterns are [step, length in steps]
  const MUSIC_STYLES = {
    chiptune: { label: 'CHIPTUNE', kanji: '電', blurb: '8-bit battle theme: square lead, triangle bass, crunchy noise drums, fast arpeggios.', bpm: [140, 165], swing: [0, 0], scales: ['minor', 'dorian', 'harmonic'],
      prog: [[0, 5, 2, 6], [0, 3, 4, 4], [0, 6, 5, 4], [0, 5, 3, 4], [0, 3, 6, 4]], kits: ['chip'], kick: [[0, 8, 10], [0, 6, 8], [0, 8]], snare: 'back', hats: [R8],
      bass: { t: ['tri', 'square'], pat: [[[0, 0], [2, 12], [4, 0], [6, 12], [8, 0], [10, 12], [12, 0], [14, 12]], [[0, 0], [3, 0], [6, 0], [8, 7], [10, 0], [12, 12], [14, 7]]] },
      keys: { t: ['pulse'], comp: [[[0, 2], [6, 2], [12, 2]], [[0, 2], [4, 2], [8, 2], [12, 2]]], size: 3 }, lead: { t: ['square', 'pulse'], dens: 0.75 }, arp: 0.9, crash: 1, master: { reverb: 0.06, room: 0.3 } },
    fight: { label: 'FIGHT', kanji: '闘', blurb: 'Versus-screen energy: driving bass, power-chord stabs, busy hats, a crash on every section.', bpm: [150, 174], swing: [0, 0], scales: ['minor', 'harmonic', 'dorian'],
      prog: [[0, 0, 5, 6], [0, 6, 5, 4], [0, 3, 0, 4], [0, 5, 3, 4]], kits: ['acoustic'], kick: [[0, 3, 6, 10], [0, 7, 10], [0, 3, 8, 11]], snare: 'back', hats: [R16, R8],
      bass: { t: ['sawlp', 'square'], pat: [[[0, 0], [2, 0], [3, 0], [6, 0], [8, 0], [10, 12], [11, 0], [14, 7]], [[0, 0], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0], [12, 0], [14, 0]]] },
      keys: { t: ['sawstab'], comp: [[[0, 2], [3, 2], [6, 2], [10, 2]], [[0, 3], [3, 3], [6, 4], [12, 2]]], size: 'power' }, lead: { t: ['saw', 'sync'], dens: 0.75 }, arp: 0.6, crash: 1, master: { reverb: 0.1, room: 0.4 } },
    citypop: { label: 'CITY POP', kanji: '街', blurb: 'Swung groove, FM electric-piano sevenths, bouncy bass and a bell lead.', bpm: [96, 112], swing: [0.08, 0.14], scales: ['major', 'dorian', 'mixolydian'],
      prog: [[3, 4, 2, 5], [1, 4, 0, 5], [3, 2, 1, 4], [0, 5, 1, 4]], kits: ['acoustic'], kick: [[0, 7, 10], [0, 6, 10], [0, 10]], snare: 'back', hats: [R8], shaker: 1,
      bass: { t: ['slap'], pat: [[[0, 0], [3, 12], [6, 0], [8, 7], [10, 0], [14, 12]], [[0, 0], [2, 0], [6, 12], [8, 0], [11, 7], [14, 0]]] },
      keys: { t: ['epiano', 'bell'], comp: [[[0, 4], [6, 2], [10, 4]], [[2, 2], [6, 2], [10, 2], [14, 2]]], size: 4 }, lead: { t: ['bell', 'flute'], dens: 0.6 }, arp: 0, crash: 0, master: { reverb: 0.16, room: 0.6, delay: 0.08, echo: 3, feedback: 0.25 } },
    synthwave: { label: 'SYNTHWAVE', kanji: '夜', blurb: 'Night drive: four-on-the-floor, saw pad, 16th-note arp, echoing lead.', bpm: [96, 118], swing: [0, 0], scales: ['minor', 'dorian'],
      prog: [[0, 5, 2, 6], [0, 3, 5, 6], [5, 3, 0, 6], [0, 6, 5, 6]], kits: ['acoustic'], kick: [[0, 4, 8, 12]], snare: 'back', hats: [OFF8],
      bass: { t: ['sawlp', 'reese'], pat: [R8.map(s => [s, 0]), [[0, 0], [2, 0], [4, 12], [6, 0], [8, 0], [10, 0], [12, 12], [14, 0]]] },
      keys: { t: ['pad', 'strings'], comp: [[[0, 16]]], size: 3 }, lead: { t: ['saw', 'sync'], dens: 0.55 }, arp: 0.9, crash: 1, master: { reverb: 0.26, room: 0.8, delay: 0.12, echo: 3, feedback: 0.35 } },
    lofi: { label: 'LO-FI', kanji: '雨', blurb: 'Menu or lobby loop: lazy swung beat, soft crushed keys, round bass, vinyl hiss.', bpm: [76, 90], swing: [0.12, 0.18], scales: ['major', 'dorian', 'minor'],
      prog: [[1, 4, 0, 5], [3, 2, 1, 4], [0, 5, 3, 4], [3, 4, 2, 5]], kits: ['lofi'], kick: [[0, 7, 9], [0, 10], [0, 6, 9]], snare: 'back', hats: [R8], shaker: 1, vinyl: 1,
      bass: { t: ['sub'], pat: [[[0, 0], [7, 0], [10, 7]], [[0, 0], [6, 0], [10, 0]]] },
      keys: { t: ['soft', 'epiano'], comp: [[[0, 8], [10, 4]], [[0, 6], [8, 6]]], size: 4 }, lead: { t: ['soft', 'flute'], dens: 0.45 }, arp: 0, crash: 0, master: { reverb: 0.14, room: 0.5 } },
    house: { label: 'HOUSE', kanji: '舞', blurb: 'Club floor: four-on-the-floor kick, clap, open hats on the off-beat, organ stabs and a pluck bass.', bpm: [118, 126], swing: [0, 0.05], scales: ['minor', 'dorian', 'major'],
      prog: [[0, 0, 5, 5], [0, 5, 3, 4], [1, 4, 0, 0], [0, 6, 5, 6]], kits: ['house'], kick: [[0, 4, 8, 12]], snare: 'clap', hats: [R16], ohat: 1,
      bass: { t: ['pluck', 'square', 'sawlp'], pat: [[[2, 0], [6, 0], [10, 0], [14, 0]], [[2, 0], [3, 12], [6, 0], [10, 0], [11, 12], [14, 0]]] },
      keys: { t: ['organ', 'epiano', 'sawstab'], comp: [[[3, 1], [6, 1], [10, 1], [14, 1]], [[2, 2], [6, 2], [10, 3]]], size: 4 }, lead: { t: ['pluck', 'bell'], dens: 0.45 }, arp: 0.3, crash: 1, master: { reverb: 0.14, room: 0.5, delay: 0.1, echo: 3, feedback: 0.3 } },
    dnb: { label: 'DRUM & BASS', kanji: '速', blurb: 'Fast breakbeat at 170+, rolling reese bass, wide pads and a floating lead.', bpm: [168, 176], swing: [0, 0], scales: ['minor', 'dorian'],
      prog: [[0, 5, 3, 4], [0, 0, 6, 5], [0, 3, 5, 6], [5, 6, 0, 0]], kits: ['breaks'], kick: [[0, 10], [0, 7, 10], [0, 9, 10]], snare: 'dnb', hats: [R8],
      bass: { t: ['reese', 'sub'], pat: [[[0, 0], [8, 0]], [[0, 0], [6, 0], [10, 0]], [[0, 0], [10, 0], [14, 7]]] },
      keys: { t: ['pad', 'strings', 'bell'], comp: [[[0, 16]], [[0, 8], [8, 8]]], size: 4 }, lead: { t: ['flute', 'bell', 'soft'], dens: 0.4 }, arp: 0.4, crash: 1, master: { reverb: 0.22, room: 0.7 } },
    trap: { label: 'TRAP', kanji: '影', blurb: 'Half-time 808s, rolling triplet hats, dark bells and a breathy lead.', bpm: [130, 150], swing: [0, 0], scales: ['minor', 'harmonic', 'phrygian'],
      prog: [[0, 5, 3, 4], [0, 0, 5, 6], [0, 1, 0, 6], [0, 3, 5, 4]], kits: ['tr808'], kick: [[0, 7, 10], [0, 3, 10], [0, 6, 11]], snare: 'half', hats: [R8], rolls: 1,
      bass: { t: ['boom'], pat: [], follow: 1 },
      keys: { t: ['bell', 'pad', 'strings'], comp: [[[0, 16]], [[0, 8], [8, 8]]], size: 3 }, lead: { t: ['flute', 'pluck', 'bell'], dens: 0.45 }, arp: 0.2, crash: 0, master: { reverb: 0.16, room: 0.6 } },
    boss: { label: 'BOSS', kanji: '王', blurb: 'Final-boss battle: galloping bass, strings, driving drums with rolls, a screaming lead.', bpm: [150, 170], swing: [0, 0], scales: ['harmonic', 'minor', 'phrygian'],
      prog: [[0, 1, 0, 6], [0, 5, 1, 4], [0, 6, 5, 4], [0, 3, 1, 4]], kits: ['acoustic'], kick: [[0, 2, 8, 10], [0, 3, 6, 8, 11, 14]], snare: 'back', hats: [R8], fills: 1,
      bass: { t: ['sawlp', 'reese'], pat: [[[0, 0], [2, 0], [3, 0], [4, 0], [6, 0], [7, 0], [8, 0], [10, 0], [11, 0], [12, 0], [14, 0], [15, 0]], R8.map(s => [s, 0])] },
      keys: { t: ['strings', 'sawstab'], comp: [[[0, 16]], [[0, 4], [4, 4], [8, 4], [12, 4]]], size: 'power' }, lead: { t: ['saw', 'square', 'sync'], dens: 0.7 }, arp: 0.7, crash: 1, master: { reverb: 0.2, room: 0.7 } },
  };
  const CELLS = [[0], [0, 2], [0, 3], [0, 1, 2, 3], [2], [0, 2, 3], [1, 3], [], [0, 1], [3]];
  const PARTS = ['drums', 'bass', 'chords', 'lead'];
  const partSeed = (seed, name) => (Math.imul(seed ^ hashStr(name), 2654435761) >>> 0) || 1;

  function compose(seed, opts) {
    seed = seed >>> 0; opts = opts || {};
    const ids = Object.keys(MUSIC_STYLES);
    const w = clamp(num(opts.wildness, 0.4), 0, 1);
    // song-level draws: always the same count, in the same order, whatever overrides are given
    const song = mulberry32(seed ^ 0x9e3779b9);
    const D = []; for (let i = 0; i < 16; i++) D.push(song());
    const randomStyle = !MUSIC_STYLES[opts.style];
    const styleId = randomStyle ? ids[Math.floor(D[0] * ids.length)] : opts.style;
    const others = ids.filter(x => x !== styleId);
    const borrowId = opts.borrow !== undefined ? (MUSIC_STYLES[opts.borrow] ? opts.borrow : null)
      : (randomStyle && D[1] < w * 0.6 ? others[Math.floor(D[2] * others.length)] : null);
    const st = MUSIC_STYLES[styleId], bs = borrowId ? MUSIC_STYLES[borrowId] : null;
    const bpm = Math.round(clamp(num(opts.bpm, st.bpm[0] + (st.bpm[1] - st.bpm[0]) * D[3]), 50, 220));
    const root = Math.round(clamp(num(opts.root, 40 + Math.floor(D[4] * 12)), 28, 64));
    const scaleName = st.scales[Math.floor(D[5] * st.scales.length)];
    const scale = SCALES[scaleName];
    const swing = st.swing[0] + (st.swing[1] - st.swing[0]) * D[6];
    const target = clamp(num(opts.seconds, 32), 8, 60);
    let bars = Math.max(4, Math.round(target * bpm / 240 / 4) * 4);
    while (bars > 4 && bars * 240 / bpm > MAX_SECONDS - 4) bars -= 4;
    const stepDur = 60 / bpm / 4, barDur = stepDur * 16;
    const nSec = bars / 4;
    const coldOpen = D[7] < 0.15 + w * 0.25;
    const keyUp = D[8] < 0.12 + w * 0.38 ? (D[9] < 0.5 ? 1 : 2) : 0;
    const halfTimeSec = D[10] < w * 0.45 ? 1 + Math.floor(D[11] * Math.max(1, nSec - 2)) : -1;
    const ending = D[12] < 0.6 ? 'hit' : D[12] < 0.85 ? 'fade' : 'stop';
    const breakAsDrop = D[13] < 0.5;
    // structure
    const plan = [];
    for (let i = 0; i < nSec; i++) {
      let type;
      if (nSec >= 3 && i === 0 && !coldOpen) type = 'intro';
      else if (nSec >= 3 && i === nSec - 1) type = 'outro';
      else if (nSec >= 6 && i === nSec - 2 && breakAsDrop) type = 'break';
      else type = ((i - (coldOpen ? 0 : 1)) % 2 === 0) ? 'A' : 'B';
      plan.push(type);
    }
    if (nSec >= 6 && plan[nSec - 2] === 'break') plan[nSec - 3] = 'B';
    let lastB = -1; plan.forEach((t, i) => { if (t === 'B') lastB = i; });
    const shiftAt = keyUp && lastB > 1 ? lastB : 99;

    const parts = {};
    PARTS.forEach(p => { parts[p] = (opts.parts && Number.isFinite(opts.parts[p])) ? opts.parts[p] >>> 0 : partSeed(seed, p); });
    const rngOf = (p) => { const r = mulberry32(parts[p] ^ hashStr(p)); return { r, R: (a, b) => a + (b - a) * r(), pick: (arr) => arr[Math.floor(r() * arr.length)], chance: (q) => r() < q }; };
    const dr = rngOf('drums'), ba = rngOf('bass'), ch = rngOf('chords'), le = rngOf('lead');
    // which style each part follows (hybrids borrow some parts)
    const from = (g) => (bs && g.chance(0.5) ? bs : st);
    const dSt = from(dr), bSt = from(ba), cSt = from(ch), lSt = from(le);
    const deg = (d) => scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    const L = (name, o, extra) => Object.assign(defaultLayer(0), { name, hits: [] }, JSON.parse(JSON.stringify(o)), extra || {});
    const pitched = (name, preset, base, extra) => {
      const l = L(name, preset, extra); const f = mtof(base);
      l.freq = f; l.freqEnd = preset.glide ? f * preset.glide : f; delete l.glide; return l;
    };
    const jit = (g, v) => clamp(v * (1 - w * 0.15 + g.r() * w * 0.3), 0.05, 1.5);

    // ---- chords part: progressions, voicing, comp rhythm, sound
    const genProg = () => { const pool = [3, 4, 5, 6, 1, 2]; const p = [0]; while (p.length < 4) { const d = ch.pick(pool); if (d !== p[p.length - 1]) p.push(d); } return p; };
    const progA = ch.chance(w * 0.7) ? genProg() : ch.pick(cSt.prog);
    const progB = ch.chance(0.6) ? (ch.chance(w * 0.7) ? genProg() : ch.pick(cSt.prog)) : progA;
    const keysT = ch.pick(cSt.keys.t), compA = ch.pick(cSt.keys.comp), compB = ch.chance(0.5) ? ch.pick(cSt.keys.comp) : compA;
    const sizeMode = cSt.keys.size, add7 = sizeMode === 3 && ch.chance(w * 0.5);
    const chordTones = (d) => {
      if (sizeMode === 'power') { const r0 = deg(d) % 12; return [r0, r0 + 7, r0 + 12]; }
      const n = sizeMode === 4 || add7 ? 4 : 3; const t = []; for (let i = 0; i < n; i++) t.push(deg(d + 2 * i) % 12);
      return t.sort((a, b) => a - b);
    };
    const chords = pitched('chords', KEYS[keysT], root + 12, { pan: -0.15 });

    // ---- drums part
    const kitId = dr.pick(dSt.kits), kit = KITS[kitId];
    const kick = L('kick', kit.kick), snare = L(dSt.snare === 'clap' || kitId === 'tr808' || kitId === 'house' ? 'clap' : 'snare', kit.snare), hat = L('hat', kit.hat, { pan: 0.2 });
    const ohat = (dSt.ohat || dr.chance(w * 0.2)) ? L('open hat', kit.ohat || KITS.house.ohat, { pan: -0.2 }) : null;
    const rolls = (dSt.rolls || dr.chance(w * 0.25)) ? L('hat roll', kit.hat, { pan: 0.25, repeat: { count: 2, interval: stepDur / 3, decay: 0.75, pitch: 0 } }) : null;
    const crash = (dSt.crash || dr.chance(w * 0.4)) ? L('crash', { wave: 'noise', freq: 7000, freqEnd: 5000, slide: 1, amp: { a: 0.001, h: 0.02, d: 1.1, s: 0, r: 0.2 }, filter: { type: 'hp', cutoff: 3500, cutoffEnd: 5000, q: 0.7 }, crush: kit.hat.crush || { bits: 16, rate: 1 }, gain: 0.2, pan: -0.2 }) : null;
    const shaker = (dSt.shaker || dr.chance(w * 0.3)) ? L('shaker', { wave: 'noise', freq: 7000, freqEnd: 7000, amp: { a: 0.006, h: 0, d: 0.035, s: 0, r: 0.02 }, filter: { type: 'bp', cutoff: 6500, cutoffEnd: 6500, q: 1.5 }, gain: 0.11, pan: -0.3 }) : null;
    const perc = dr.chance(0.1 + w * 0.4) ? L('perc', { wave: dr.pick(['metal', 'fm', 'triangle']), fm: { ratio: 3.7, index: 3 }, freq: dr.R(300, 900), freqEnd: dr.R(250, 800), slide: 0.05, amp: { a: 0.001, h: 0, d: dr.R(0.03, 0.09), s: 0, r: 0.02 }, filter: HP(600), gain: 0.14, pan: dr.R(-0.5, 0.5) }) : null;
    const vinyl = (dSt.vinyl || cSt.vinyl) ? L('vinyl', { wave: 'noise', freq: 45, freqEnd: 45, amp: { a: 0.05, h: 0, d: 0.1, s: 1, r: 0.2 }, filter: HP(1500), gain: 0.05 }) : null;
    const kickBase = dr.pick(dSt.kick), hatBase = dr.pick(dSt.hats);
    const percPat = perc ? R16.filter(s => s % 4 && dr.chance(0.18 + w * 0.15)) : [];
    const kickBar = (b) => { // occasional per-bar variation
      let k = kickBase.slice();
      if (dr.chance(w * 0.3)) { const s = 1 + Math.floor(dr.r() * 15); k = k.includes(s) ? k.filter(x => x !== s) : k.concat(s); }
      return k.sort((a, b2) => a - b2);
    };

    // ---- bass part
    const bassT = ba.pick(bSt.bass.t), bassPat = bSt.bass.follow ? null : ba.pick(bSt.bass.pat), bassFollow = !!bSt.bass.follow;
    const bass = pitched('bass', BASSES[bassT], bassT === 'boom' ? root - 12 : root);
    const approach = ba.chance(0.3 + w * 0.4);

    // ---- lead part
    const leadT = le.pick(lSt.lead.t), dens = clamp(lSt.lead.dens + (le.r() - 0.5) * w * 0.4, 0.25, 0.9);
    const lead = pitched('lead', LEADS[leadT], root + 24, { pan: 0.05 });
    const hasArp = le.chance(lSt.arp);
    const arp = hasArp ? pitched('arp', le.pick([{ wave: 'pulse', duty: 0.15, amp: { a: 0.001, h: 0.01, d: 0.06, s: 0.2, r: 0.03 }, gain: 0.11 }, KEYS.bell, LEADS.pluck]), root + 24, { pan: 0.3, gain: 0.11 }) : null;
    const leap = 0.1 + w * 0.2;
    function motif(dn) {
      const notes = []; let d = le.pick([2, 4, 7]);
      for (let beat = 0; beat < 8; beat++) {
        let cell = beat === 0 ? le.pick([[0], [0, 2], [0, 3]]) : (le.chance(dn) ? le.pick(CELLS) : []);
        if (beat === 7 && le.chance(0.6)) cell = [];
        for (const c of cell) {
          const r = le.r();
          d += r < 0.3 ? 1 : r < 0.6 ? -1 : r < 0.6 + leap ? (le.chance(0.5) ? 2 : -2) : r < 0.9 ? 0 : (le.chance(0.5) ? 4 : -3);
          d = clamp(d, -2, 10);
          notes.push([beat * 4 + c, 1, d]);
        }
      }
      for (let i = 0; i < notes.length; i++) notes[i][1] = Math.max(1, Math.min(6, (i + 1 < notes.length ? notes[i + 1][0] : 32) - notes[i][0]));
      return notes;
    }
    const motA = motif(dens), motB = motif(clamp(dens + 0.1, 0, 0.95));
    const motA2 = motA.map(n => n.slice()); // answer phrase: reroll the tail
    for (let i = Math.max(0, motA2.length - 3); i < motA2.length; i++) motA2[i][2] = clamp(motA2[i][2] + le.pick([-2, -1, 1, 2]), -2, 10);
    const leadInIntro = le.chance(w * 0.4), arpShape = le.pick([[0, 1, 2, 1], [0, 1, 2, 3], [0, 2, 1, 2], [3, 2, 1, 0]]);
    const snapToChord = (d, cd) => { let best = d, bd = 99; for (let x = d - 3; x <= d + 3; x++) { const rel = ((x - cd) % 7 + 7) % 7; if ((rel === 0 || rel === 2 || rel === 4) && Math.abs(x - d) < bd) { bd = Math.abs(x - d); best = x; } } return best; };

    // ---- arrange
    for (let b = 0; b < bars; b++) {
      const sec = Math.floor(b / 4), type = plan[sec], inSec = b % 4, base = b * 16;
      const shift = sec >= shiftAt ? keyUp : 0;
      const prog = type === 'B' ? progB : progA, cd = prog[inSec];
      const lastBar = b === bars - 1, secEnd = inSec === 3 && !lastBar;
      const full = type === 'A' || type === 'B';
      const fadeV = type === 'outro' && ending === 'fade' ? 1 - inSec * 0.2 : 1;
      if (lastBar && nSec >= 2) {
        const fin = progA[0], froot = deg(fin) % 12 + shift;
        kick.hits.push({ t: base, note: 0, vel: 1, len: 0.1 });
        if (crash) crash.hits.push({ t: base, note: 0, vel: 1, len: 0.5 });
        if (ending !== 'stop') {
          bass.hits.push({ t: base, note: froot, vel: 1, len: barDur * 0.9 });
          chordTones(fin).forEach(n => chords.hits.push({ t: base, note: n + shift, vel: 0.9 * fadeV, len: barDur * 1.2 }));
          lead.hits.push({ t: base, note: deg(snapToChord(7, fin)) + shift, vel: 0.85 * fadeV, len: barDur * 0.8 });
        } else bass.hits.push({ t: base, note: froot, vel: 1, len: stepDur * 2 });
        if (vinyl) vinyl.hits.push({ t: base, note: 0, vel: 1, len: barDur });
        break;
      }
      // drums
      const half = sec === halfTimeSec && full;
      if (type !== 'break') {
        const kp = type === 'intro' ? [0] : type === 'outro' ? [0, 8] : half ? [0, 10] : kickBar(b);
        kp.forEach(s => kick.hits.push({ t: base + s, note: 0, vel: jit(dr, s === 0 ? 1 : 0.85) * fadeV, len: 0.1 }));
        if (bassFollow && type !== 'intro') kp.forEach(s => bass.hits.push({ t: base + s, note: deg(cd) % 12 + shift, vel: 1, len: Math.max(0.15, stepDur * 5) }));
        if (type !== 'intro') {
          const mode = half ? 'half' : dSt.snare;
          const hits = mode === 'half' ? [8] : mode === 'dnb' ? [4, 12] : [4, 12];
          const fill = secEnd && (full || type === 'break') && dr.chance(0.55 + w * 0.3);
          hits.forEach(s => snare.hits.push({ t: base + s, note: 0, vel: jit(dr, 1) * fadeV, len: 0.08 }));
          if (mode === 'dnb') [7, 9].forEach(s => { if (dr.chance(0.5)) snare.hits.push({ t: base + s, note: 0, vel: 0.35, len: 0.05 }); });
          if (fill) {
            const style = dr.pick(dSt.fills ? ['roll', 'roll', 'flam'] : ['roll', 'flam', 'ghost']);
            const fs = style === 'roll' ? [13, 14, 15] : style === 'flam' ? [14, 15] : [10, 15];
            fs.forEach((s, i) => snare.hits.push({ t: base + s, note: 0, vel: 0.5 + i * 0.18, len: 0.05 }));
          } else if (dr.chance(0.15 + w * 0.2)) snare.hits.push({ t: base + dr.pick([3, 7, 11, 14, 15]), note: 0, vel: 0.3, len: 0.05 });
        }
      }
      const hatPat = half ? R8 : hatBase;
      hatPat.forEach(s => { if (type === 'outro' && s % 4) return; if (type === 'intro' && s % 2) return; hat.hits.push({ t: base + s, note: 0, vel: jit(dr, s % 4 === 0 ? 0.9 : 0.6) * fadeV, len: 0.03 }); });
      if (full && dr.chance(w * 0.3)) { const s = 1 + 2 * Math.floor(dr.r() * 8); if (!hatPat.includes(s)) hat.hits.push({ t: base + s, note: 0, vel: 0.4, len: 0.02 }); }
      if (ohat && full) OFF8.forEach(s => ohat.hits.push({ t: base + s, note: 0, vel: 0.8, len: 0.1 }));
      if (rolls && full && dr.chance(0.55)) rolls.hits.push({ t: base + dr.pick([6, 10, 13, 14]), note: 0, vel: 0.7, len: 0.02 });
      if (shaker && type === 'B') for (let s = 1; s < 16; s += 2) shaker.hits.push({ t: base + s, note: 0, vel: 0.7, len: 0.03 });
      if (perc && full) percPat.forEach(s => perc.hits.push({ t: base + s, note: 0, vel: jit(dr, 0.7), len: 0.04 }));
      if (crash && inSec === 0 && (full || type === 'outro') && (sec > 0 || coldOpen)) crash.hits.push({ t: base, note: 0, vel: 0.9, len: 0.4 });
      if (vinyl && inSec === 0) vinyl.hits.push({ t: base, note: 0, vel: 1, len: barDur * 4 });
      // bass
      if (!bassFollow && type !== 'intro') {
        const pat = type === 'break' || type === 'outro' ? [[0, 0], [8, 0]] : bassPat;
        const nextRoot = deg(prog[(inSec + 1) % 4]) % 12;
        pat.forEach(([s, off], i) => {
          const next = i + 1 < pat.length ? pat[i + 1][0] : 16;
          const legato = bassT === 'reese' || bassT === 'sub' ? 0.95 : bassT === 'slap' ? 0.55 : 0.85;
          bass.hits.push({ t: base + s, note: (deg(cd) % 12) + off + shift, vel: jit(ba, s === 0 ? 1 : 0.85) * fadeV, len: Math.max(0.05, (next - s) * stepDur * legato) });
        });
        if (approach && full && ba.chance(0.4) && !pat.some(p => p[0] === 15)) bass.hits.push({ t: base + 15, note: nextRoot + ba.pick([-1, 1, 2, -2]) + shift, vel: 0.7, len: stepDur * 0.8 });
      }
      // chords
      const tones = chordTones(cd);
      const comp = type === 'break' || type === 'intro' && keysT !== 'pulse' ? [[0, 16]] : (type === 'B' ? compB : compA);
      comp.forEach(([s, ln]) => tones.forEach(n => chords.hits.push({ t: base + s, note: n + shift, vel: (s === 0 ? 0.9 : 0.75) * fadeV, len: ln * stepDur * 0.9 })));
      // lead
      const leadOn = full || (type === 'outro' && inSec < 2) || (type === 'break' && inSec >= 2) || (type === 'intro' && leadInIntro && inSec >= 2);
      if (leadOn) {
        const mot = type === 'B' ? motB : (inSec >= 2 ? motA2 : motA), halfIdx = inSec % 2;
        mot.filter(n => Math.floor(n[0] / 16) === halfIdx).forEach(([pos, ln, d], k, arr) => {
          let dd = d;
          if (pos % 8 === 0) dd = snapToChord(d, cd);
          if (inSec === 3 && k === arr.length - 1) dd = snapToChord(0, cd);
          lead.hits.push({ t: base + (pos % 16), note: deg(dd) + shift, vel: jit(le, pos % 4 === 0 ? 0.95 : 0.8) * fadeV, len: ln * stepDur * 0.92 });
        });
      }
      if (arp && (type === 'B' || type === 'break')) {
        for (let s = 0; s < 16; s++) {
          const i = arpShape[s % 4]; const n = i === 3 ? tones[0] + 12 : tones[i % tones.length];
          arp.hits.push({ t: base + s, note: n + shift, vel: s % 4 === 0 ? 0.9 : 0.6, len: stepDur * 0.8 });
        }
      }
    }

    const layers = [kick, snare, hat, ohat, rolls, perc, bass, chords, lead, arp, crash, shaker, vinyl].filter(l => l && l.hits.length);
    layers.forEach((l, i) => { l.id = 'L' + (i + 1); l.hits.sort((a, b2) => a.t - b2.t); });
    const m = Object.assign({}, st.master);
    if (m.echo) { m.delayTime = stepDur * m.echo; delete m.echo; }
    const s = defaultSound(styleId + '-' + seed.toString(36));
    const label = st.label + (bs ? ' × ' + bs.label : '');
    s.name = label.toLowerCase() + ' ' + seed.toString(36);
    s.category = 'music'; s.style = styleId; s.styleLabel = label; s.bpm = bpm; s.bars = bars; s.seed = seed;
    s.key = NOTE_NAMES[root % 12] + ' ' + scaleName + (keyUp && shiftAt < 99 ? ` (+${keyUp} at section ${shiftAt + 1})` : '');
    s.sections = plan.map((t, i) => (i === halfTimeSec && (t === 'A' || t === 'B') ? t + ' ½' : t) + (i === shiftAt ? ' ↑' : ''));
    s.compose = { seed, style: styleId, borrow: borrowId, wildness: w, seconds: target, bpm, root, parts };
    s.length = bars * barDur; s.steps = bars * 16; s.swing = swing;
    s.master = Object.assign(s.master, { gain: 0.8 }, m);
    s.layers = layers;
    return normalize(s);
  }

  // Reroll some parts of a composed track (and/or change key or tempo), keeping everything else.
  function remix(input, opts) {
    opts = opts || {};
    const c = input && input.compose;
    if (!c) throw new Error('This track has no composer data (made with an older version). Generate a new one to remix it.');
    const parts = Object.assign({}, c.parts);
    const rng = mulberry32(num(opts.seed, (Math.random() * 1e9) >>> 0));
    for (const p of opts.parts || []) { if (!PARTS.includes(p)) throw new Error('Unknown part ' + p + '. Parts: ' + PARTS.join(', ')); parts[p] = (rng() * 4294967296) >>> 0; }
    const out = compose(c.seed, { style: c.style, borrow: c.borrow, wildness: num(opts.wildness, c.wildness), seconds: c.seconds,
      bpm: num(opts.bpm, c.bpm), root: c.root + Math.round(num(opts.transpose, 0)), parts });
    out.id = input.id; out.name = input.name;
    return out;
  }

  const CATEGORIES = ['random', 'coin', 'pickup', 'jump', 'laser', 'shoot', 'explosion', 'hit', 'punch', 'kick', 'block', 'hurt',
    'whoosh', 'dash', 'powerup', 'blip', 'select', 'confirm', 'cancel', 'magic', 'ko', 'victory', 'gameover'];

  // ---------- mutate & macros ----------
  function mutate(input, amount, seed) {
    const s = JSON.parse(JSON.stringify(normalize(input)));
    const rng = mulberry32(seed || ((Date.now() & 0xffffffff) >>> 0));
    amount = clamp(num(amount, 0.2), 0, 1);
    const j = (v, lo, hi) => clamp(v * Math.pow(2, (rng() * 2 - 1) * amount * 1.5), lo, hi);
    for (const l of s.layers) {
      if (s.category !== 'music') { l.freq = j(l.freq, 20, 16000); l.freqEnd = j(l.freqEnd, 20, 16000); }
      l.slide = j(l.slide || 0.0001, 0, 2); l.amp.d = j(l.amp.d, 0.005, 3); l.amp.h = j(l.amp.h || 0.0001, 0, 1);
      if (l.filter.type !== 'none') { l.filter.cutoff = j(l.filter.cutoff, 40, 18000); l.filter.cutoffEnd = j(l.filter.cutoffEnd, 40, 18000); }
      if (l.vib.depth) l.vib.rate = j(l.vib.rate, 0.5, 60);
      if (l.wave === 'pulse') l.duty = clamp(l.duty + (rng() - 0.5) * amount, 0.05, 0.95);
      if (l.jump) l.jump.at = j(l.jump.at, 0.005, 1);
      l.gain = clamp(l.gain * (1 + (rng() - 0.5) * amount * 0.5), 0.05, 1.5);
    }
    s.seed = (rng() * 1e9) >>> 0;
    return normalize(s);
  }

  const MACROS = {
    pitch: { blurb: 'Transpose every layer by N semitones (-24..24).', apply: (s, v) => { const r = Math.pow(2, v / 12); s.layers.forEach(l => { l.freq *= r; l.freqEnd *= r; }); } },
    length: { blurb: 'Stretch time: decays, slides, gates and grid (0.25..4).', apply: (s, v) => {
      s.length *= v; s.layers.forEach(l => { l.slide *= v; l.amp.d *= v; l.amp.h *= v; l.amp.r *= v; l.hits.forEach(h => h.len *= v); l.repeat.interval *= v; if (l.jump) l.jump.at *= v; }); } },
    punch: { blurb: 'Snappier attack plus drive (0..1).', apply: (s, v) => s.layers.forEach(l => { l.amp.a = Math.max(0.0005, l.amp.a * (1 - v * 0.9)); l.drive = clamp(l.drive + v * 0.6, 0, 1); }) },
    grit: { blurb: 'Bit-crush and sample-rate reduce (0..1).', apply: (s, v) => s.layers.forEach(l => { l.crush.bits = Math.round(16 - v * 12); l.crush.rate = Math.round(1 + v * 6); }) },
    space: { blurb: 'More room: reverb and size (0..1).', apply: (s, v) => { s.master.reverb = clamp(v * 0.5, 0, 1); s.master.room = clamp(0.3 + v * 0.65, 0, 1); } },
    distance: { blurb: 'Played far away: softer, darker, wetter (0..1).', apply: (s, v) => {
      s.master.reverb = clamp(0.1 + v * 0.45, 0, 1); s.master.room = clamp(0.5 + v * 0.45, 0, 1);
      s.layers.forEach(l => { l.amp.a += v * 0.02; if (l.filter.type === 'none') l.filter = { type: 'lp', cutoff: 9000 - v * 7000, cutoffEnd: 9000 - v * 7000, q: 0.7 }; else { l.filter.cutoff *= 1 - v * 0.6; l.filter.cutoffEnd *= 1 - v * 0.6; } }); } },
    retro: { blurb: 'NES-ify: square/pulse waves, 4-bit (0..1 strength).', apply: (s, v) => s.layers.forEach(l => {
      if (v > 0.5 && ['saw', 'sine', 'fm'].includes(l.wave)) l.wave = 'square'; l.crush.bits = Math.round(16 - v * 12); l.filter.type = 'none'; }) },
  };
  function applyMacro(input, name, value) {
    const s = JSON.parse(JSON.stringify(normalize(input)));
    const m = MACROS[name];
    if (!m) throw new Error('Unknown macro ' + name + '. Known: ' + Object.keys(MACROS).join(', '));
    m.apply(s, num(value, 0));
    return normalize(s);
  }

  const GLYPHS = { sine: 'ring', square: 'block', saw: 'hatch', triangle: 'wedge', noise: 'dots', pulse: 'bars', fm: 'cross', metal: 'grid' };

  return { FORMAT, WAVES, CATEGORIES, MACROS, GLYPHS, defaultSound, defaultLayer, normalize, render, analyze, encodeWav, gen, randomize, compose, remix, MUSIC_STYLES, MUSIC_PARTS: PARTS, mutate, applyMacro, mulberry32, hashStr };
});
