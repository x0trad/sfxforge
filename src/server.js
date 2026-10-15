#!/usr/bin/env node
// sfx-mcp — MCP server (stdio, zero dependencies) for designing game SFX in the
// "sfx-forge/1" format and rendering them to WAV with the shared SFX Forge engine.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SFX = require('./engine');
const { preview } = require('./png');

const SFX_DIR = path.resolve(process.env.SFX_DIR || path.join(process.cwd(), 'sfx'));
fs.mkdirSync(SFX_DIR, { recursive: true });

// ---------- storage ----------
const safeId = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_\-.]{1,64}$/.test(id) || id.startsWith('.')) throw new Error('id must be 1-64 chars of letters, digits, _ - .');
  return id;
};
const fileOf = (id) => path.join(SFX_DIR, safeId(id) + '.sfx.json');
const wavOf = (id) => path.join(SFX_DIR, safeId(id) + '.wav');
function load(id) {
  const f = fileOf(id);
  if (!fs.existsSync(f)) throw new Error(`No sound "${id}". Use list_sounds or generate_sound.`);
  return SFX.normalize(JSON.parse(fs.readFileSync(f, 'utf8')));
}
function save(snd) { const s = SFX.normalize(snd); fs.writeFileSync(fileOf(s.id), JSON.stringify(s, null, 2)); return s; }
function list() {
  return fs.readdirSync(SFX_DIR).filter(f => f.endsWith('.sfx.json')).sort().map(f => {
    try { const s = JSON.parse(fs.readFileSync(path.join(SFX_DIR, f), 'utf8')); return { id: s.id, name: s.name, category: s.category, layers: (s.layers || []).length, rendered: fs.existsSync(wavOf(s.id)) }; }
    catch (e) { return { file: f, error: e.message }; }
  });
}
const uniqueId = (base) => { base = base.replace(/[^a-zA-Z0-9_\-.]/g, '-').slice(0, 56); let id = base, n = 2; while (fs.existsSync(fileOf(id))) id = `${base}-${n++}`; return id; };

// ---------- render helpers ----------
function renderTo(snd, opts) {
  opts = opts || {};
  const r = SFX.render(snd, { sampleRate: opts.sampleRate || 44100 });
  const out = opts.out ? path.resolve(SFX_DIR, opts.out) : wavOf(snd.id);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, SFX.encodeWav(r, { mono: !!opts.mono }));
  return { r, out, analysis: SFX.analyze(r, 24) };
}
function summary(snd) {
  return {
    id: snd.id, name: snd.name, category: snd.category, style: snd.styleLabel || snd.style, bpm: snd.bpm, key: snd.key, seed: snd.seed, length: snd.length, steps: snd.steps, swing: snd.swing || undefined, master: snd.master,
    layers: snd.layers.map((l, i) => ({ index: i, id: l.id, name: l.name, wave: l.wave, freq: +l.freq.toFixed(1), freqEnd: +l.freqEnd.toFixed(1), slide: l.slide,
      filter: l.filter.type === 'none' ? 'none' : `${l.filter.type} ${Math.round(l.filter.cutoff)}→${Math.round(l.filter.cutoffEnd)}Hz`,
      hits: l.hits.length > 24 ? `${l.hits.length} hits (steps ${l.hits[0].t}–${l.hits[l.hits.length - 1].t}; use get_sound for all)` : l.hits.map(h => `${h.t}${h.note ? (h.note > 0 ? '+' : '') + h.note : ''}`).join(' '), mute: l.mute || undefined })),
  };
}
function result(snd, rendered, extra, withAudio) {
  const content = [{ type: 'text', text: JSON.stringify(Object.assign({ sound: summary(snd) }, rendered ? { wav: rendered.out, analysis: rendered.analysis } : {}, extra || {}), null, 2) }];
  if (rendered) content.push({ type: 'image', data: preview(rendered.r).toString('base64'), mimeType: 'image/png' });
  if (rendered && withAudio) content.push({ type: 'audio', data: fs.readFileSync(rendered.out).toString('base64'), mimeType: 'audio/wav' });
  return { content };
}
function musicInfo(s) { return { style: s.styleLabel || s.style, bpm: s.bpm, key: s.key, bars: s.bars, sections: s.sections, swing: s.swing, parts: s.compose && s.compose.parts }; }
function deepMerge(a, b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  const o = Object.assign({}, a && typeof a === 'object' && !Array.isArray(a) ? a : {});
  for (const k of Object.keys(b)) o[k] = deepMerge(o[k], b[k]);
  return o;
}
function findLayer(snd, ref) {
  const i = typeof ref === 'number' ? ref : snd.layers.findIndex(l => l.id === ref || l.name === ref);
  if (i < 0 || i >= snd.layers.length) throw new Error(`No layer ${JSON.stringify(ref)}. Layers: ${snd.layers.map((l, k) => k + ':' + l.id + '/' + l.name).join(', ')}`);
  return i;
}
function play(file) {
  const cmd = process.platform === 'darwin' ? ['afplay', [file]]
    : process.platform === 'win32' ? ['powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]]
      : ['aplay', ['-q', file]];
  return new Promise((res) => {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
    p.on('error', (e) => res(`Could not play (${cmd[0]}: ${e.message}). Open ${file} manually.`));
    p.on('exit', () => res('played ' + file));
  });
}

// ---------- tools ----------
const layerDoc = 'Layer: {name, wave: sine|square|saw|triangle|noise|pulse|fm|metal, duty (pulse 0-1), freq Hz, freqEnd Hz, slide sec (pitch sweep time; 0 = jump straight to freqEnd), curve (sweep shape, <1 fast start), jump {at sec, ratio} (coin-style pitch step), vib {rate Hz, depth semitones}, fm {ratio, index}, amp {a,h,d sec, s 0-1 sustain, r sec}, filter {type none|lp|hp|bp, cutoff Hz, cutoffEnd Hz, q, time sec}, crush {bits 1-16, rate 1-16 sample-hold}, drive 0-1, gain, pan -1..1, repeat {count, interval sec, decay, pitch semitones per repeat}, hits [{t step index, note semitones, vel 0-2, len gate sec}], mute}. Noise uses freq as grain rate (low = crunchy).';
const TOOLS = [
  { name: 'list_categories', description: 'List SFX generator categories, macros, wave types and the sfx-forge/1 format reference. Call first if unsure what to generate.', inputSchema: { type: 'object', properties: {} },
    run: () => ({ content: [{ type: 'text', text: JSON.stringify({ format: SFX.FORMAT, categories: SFX.CATEGORIES, musicStyles: Object.fromEntries(Object.entries(SFX.MUSIC_STYLES).map(([k, v]) => [k, v.blurb + ` ${v.bpm[0]}-${v.bpm[1]} bpm`])), waves: SFX.WAVES,
      macros: Object.fromEntries(Object.entries(SFX.MACROS).map(([k, v]) => [k, v.blurb])), sfxDir: SFX_DIR,
      sound: 'Sound: {id, name, category, seed, length sec (grid span), steps (grid columns; step time = length/steps), master {gain, reverb 0-1, room 0-1, delay 0-1 mix, delayTime sec, feedback, normalize}, layers [Layer]}. Render auto-extends for tails and trims silence.',
      layer: layerDoc }, null, 2) }] }) },
  { name: 'list_sounds', description: 'List saved sounds in SFX_DIR.', inputSchema: { type: 'object', properties: {} },
    run: () => ({ content: [{ type: 'text', text: JSON.stringify({ dir: SFX_DIR, sounds: list() }, null, 2) }] }) },
  { name: 'generate_sound', description: 'Create a new sound from a category generator (deterministic per seed), save it, render WAV and return analysis + a preview image (score strip on top, waveform below). Category "random" builds a sound from scratch out of 1-4 random layers; tune it with wildness.',
    inputSchema: { type: 'object', required: ['category'], properties: { category: { type: 'string', description: 'random, or e.g. coin, jump, laser, punch, explosion, ko — see list_categories' }, seed: { type: 'integer' }, wildness: { type: 'number', description: 'random only: 0 = tidy and short, 1 = more layers, bigger sweeps, crush, echo. Default 0.5' }, id: { type: 'string' }, name: { type: 'string' }, include_audio: { type: 'boolean' } } },
    run: (a) => {
      if (!SFX.CATEGORIES.includes(a.category)) throw new Error('Unknown category. Use one of: ' + SFX.CATEGORIES.join(', '));
      const seed = Number.isInteger(a.seed) ? a.seed >>> 0 : (Math.random() * 1e9) >>> 0;
      const s = SFX.gen(a.category, seed, { wildness: a.wildness });
      s.id = a.id ? safeId(a.id) : uniqueId(a.category === 'random' ? `${s.name}-${seed.toString(36)}` : `${a.category}-${seed.toString(36)}`); if (a.name) s.name = a.name;
      const saved = save(s); return result(saved, renderTo(saved), null, a.include_audio);
    } },
  { name: 'generate_music', description: 'Compose a full arranged track (drums, bass, chords, lead melody, arps; intro → A → B → break → outro, with possible cold opens, half-time sections, key changes and different endings) of about `seconds` long, rounded to whole 4-bar phrases. style "random" picks one and, with higher wildness, can mix two styles. Same format as SFX, so edit_sound / apply_macro / render_sound / export_pack all work on it. Use remix_music to reroll one part. Styles: ' + Object.entries(SFX.MUSIC_STYLES).map(([k, v]) => `${k} (${v.blurb})`).join(' '),
    inputSchema: { type: 'object', properties: { style: { type: 'string', enum: ['random'].concat(Object.keys(SFX.MUSIC_STYLES)) }, seconds: { type: 'number', description: '8-60, default 32' }, wildness: { type: 'number', description: '0-1, default 0.4: more drum mutation, generated progressions, key changes, extra percussion, hybrids' }, bpm: { type: 'number', description: 'optional; defaults to a style-typical tempo' }, seed: { type: 'integer' }, id: { type: 'string' }, name: { type: 'string' }, include_audio: { type: 'boolean' } } },
    run: (a) => {
      const seed = Number.isInteger(a.seed) ? a.seed >>> 0 : (Math.random() * 1e9) >>> 0;
      const s = SFX.gen('music', seed, { style: a.style, seconds: a.seconds, bpm: a.bpm, wildness: a.wildness });
      s.id = a.id ? safeId(a.id) : uniqueId(`${s.style}-${seed.toString(36)}`); if (a.name) s.name = a.name;
      const saved = save(s); const rd = renderTo(saved);
      return result(saved, rd, { music: musicInfo(saved) }, a.include_audio);
    } },
  { name: 'remix_music', description: 'Reroll parts of a composed track while keeping the rest: parts drums, bass, chords (also moves bass and melody notes to the new harmony, keeping their rhythm), lead (melody + arp). Can also transpose (semitones) or change bpm. Overwrites unless save_as is given.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, parts: { type: 'array', items: { type: 'string', enum: SFX.MUSIC_PARTS } }, transpose: { type: 'integer' }, bpm: { type: 'number' }, wildness: { type: 'number' }, seed: { type: 'integer' }, save_as: { type: 'string' }, include_audio: { type: 'boolean' } } },
    run: (a) => {
      const s = SFX.remix(load(a.id), { parts: a.parts, transpose: a.transpose, bpm: a.bpm, wildness: a.wildness, seed: a.seed });
      s.id = a.save_as ? safeId(a.save_as) : a.id;
      const saved = save(s); const rd = renderTo(saved);
      return result(saved, rd, { music: musicInfo(saved) }, a.include_audio);
    } },
  { name: 'variations', description: 'Generate N candidates (different seeds) for a category, or N mutations of an existing sound. Saves and renders each; returns one preview per candidate so you can pick. Delete the losers with delete_sound.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'random for from-scratch rolls, or a category' }, wildness: { type: 'number', description: 'random only, 0-1' }, from_id: { type: 'string', description: 'mutate this sound instead of using a category' }, count: { type: 'integer', minimum: 1, maximum: 8 }, amount: { type: 'number', description: 'mutation amount 0-1 (from_id only), default 0.3' }, prefix: { type: 'string' } } },
    run: (a) => {
      const n = Math.min(8, Math.max(1, a.count || 4)); const content = []; const made = [];
      const base = a.from_id ? load(a.from_id) : null;
      if (!base && !SFX.CATEGORIES.includes(a.category)) throw new Error('Give category (see list_categories) or from_id.');
      for (let i = 0; i < n; i++) {
        const seed = (Math.random() * 1e9) >>> 0;
        const s = base ? SFX.mutate(base, a.amount == null ? 0.3 : a.amount, seed) : SFX.gen(a.category, seed, { wildness: a.wildness });
        s.id = uniqueId((a.prefix || (base ? base.id + '-v' : a.category)) + '-' + seed.toString(36)); s.name = s.id;
        const saved = save(s); const rd = renderTo(saved);
        made.push({ id: saved.id, duration: rd.analysis.duration, character: rd.analysis.character, rmsDb: rd.analysis.rmsDb, wav: rd.out });
        content.push({ type: 'text', text: `#${i + 1} ${saved.id}` }, { type: 'image', data: preview(rd.r, 480, 120).toString('base64'), mimeType: 'image/png' });
      }
      content.unshift({ type: 'text', text: JSON.stringify({ made }, null, 2) });
      return { content };
    } },
  { name: 'get_sound', description: 'Return the full sfx-forge/1 JSON of a sound (paste into the SFX Forge editor JSON dialog or write to the artifact DB).', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (a) => ({ content: [{ type: 'text', text: JSON.stringify(load(a.id), null, 2) }] }) },
  { name: 'set_sound', description: 'Create or replace a sound from full sfx-forge/1 JSON (e.g. exported from the editor). Renders it.', inputSchema: { type: 'object', required: ['sound'], properties: { sound: { type: 'object' }, id: { type: 'string', description: 'overrides sound.id' } } },
    run: (a) => { const s = Object.assign({}, a.sound); s.id = safeId(a.id || s.id || uniqueId('sound')); const saved = save(s); return result(saved, renderTo(saved)); } },
  { name: 'edit_sound', description: 'Patch a sound and re-render. `patch` deep-merges into top-level fields (name, length, steps, master). `layers` deep-merges into existing layers by index/id/name (arrays such as hits are replaced whole). `add_layers` appends new layers; `remove_layers` deletes by index/id. ' + layerDoc,
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, patch: { type: 'object' },
      layers: { type: 'array', items: { type: 'object', properties: { layer: { description: 'index, id or name' }, set: { type: 'object' } }, required: ['layer', 'set'] } },
      add_layers: { type: 'array', items: { type: 'object' } }, remove_layers: { type: 'array', items: {} }, save_as: { type: 'string' }, include_audio: { type: 'boolean' } } },
    run: (a) => {
      let s = load(a.id);
      if (a.patch) { const p = Object.assign({}, a.patch); delete p.layers; delete p.id; s = deepMerge(s, p); }
      for (const e of a.layers || []) { const i = findLayer(s, e.layer); s.layers[i] = deepMerge(s.layers[i], e.set); }
      for (const l of a.add_layers || []) s.layers.push(Object.assign({ id: 'L' + (s.layers.length + 1) }, l));
      if (a.remove_layers) { const idx = a.remove_layers.map(r => findLayer(s, r)); s.layers = s.layers.filter((_, i) => !idx.includes(i)); }
      if (a.save_as) s.id = safeId(a.save_as);
      const saved = save(s); return result(saved, renderTo(saved), null, a.include_audio);
    } },
  { name: 'mutate_sound', description: 'Randomly nudge pitch, timing, filters and gains (like sfxr "mutate"). Overwrites unless save_as is given.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, amount: { type: 'number', description: '0-1, default 0.2' }, seed: { type: 'integer' }, save_as: { type: 'string' } } },
    run: (a) => { const s = SFX.mutate(load(a.id), a.amount, a.seed); s.id = a.save_as ? safeId(a.save_as) : a.id; const saved = save(s); return result(saved, renderTo(saved)); } },
  { name: 'apply_macro', description: 'Apply a one-knob macro: pitch (semitones), length (time-stretch factor), punch, grit, space, distance, retro (0-1). Overwrites unless save_as is given.',
    inputSchema: { type: 'object', required: ['id', 'macro', 'value'], properties: { id: { type: 'string' }, macro: { type: 'string', enum: Object.keys(SFX.MACROS) }, value: { type: 'number' }, save_as: { type: 'string' } } },
    run: (a) => { const s = SFX.applyMacro(load(a.id), a.macro, a.value); s.id = a.save_as ? safeId(a.save_as) : a.id; const saved = save(s); return result(saved, renderTo(saved)); } },
  { name: 'render_sound', description: 'Render a sound to WAV (16-bit) and return analysis + preview. Optional mono, sampleRate (22050/44100/48000) and out path relative to SFX_DIR.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, mono: { type: 'boolean' }, sampleRate: { type: 'integer', enum: [22050, 44100, 48000] }, out: { type: 'string' }, include_audio: { type: 'boolean' } } },
    run: (a) => { const s = load(a.id); return result(s, renderTo(s, a), null, a.include_audio); } },
  { name: 'play_sound', description: 'Play a sound through the local speakers (afplay / PowerShell SoundPlayer / aplay) so the human can audition it.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: async (a) => { const s = load(a.id); const rd = renderTo(s); return { content: [{ type: 'text', text: await play(rd.out) }] }; } },
  { name: 'export_pack', description: 'Render several (or all) sounds into a folder with a manifest.json for a game engine (id, file, duration, category, peak/rms). Folder is relative to SFX_DIR unless absolute.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, dir: { type: 'string', description: 'default "pack"' }, mono: { type: 'boolean' }, sampleRate: { type: 'integer', enum: [22050, 44100, 48000] } } },
    run: (a) => {
      const dir = path.resolve(SFX_DIR, a.dir || 'pack'); fs.mkdirSync(dir, { recursive: true });
      const ids = a.ids && a.ids.length ? a.ids : list().filter(x => x.id).map(x => x.id);
      const manifest = { format: SFX.FORMAT, generated: new Date().toISOString(), sounds: [] };
      for (const id of ids) {
        const s = load(id); const rd = renderTo(s, { out: path.join(dir, id + '.wav'), mono: a.mono, sampleRate: a.sampleRate });
        fs.writeFileSync(path.join(dir, id + '.sfx.json'), JSON.stringify(s, null, 2));
        manifest.sounds.push({ id, name: s.name, category: s.category, file: id + '.wav', source: id + '.sfx.json', duration: rd.analysis.duration, peakDb: rd.analysis.peakDb, rmsDb: rd.analysis.rmsDb });
      }
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return { content: [{ type: 'text', text: JSON.stringify({ dir, count: manifest.sounds.length, manifest: path.join(dir, 'manifest.json'), sounds: manifest.sounds.map(x => x.file) }, null, 2) }] };
    } },
  { name: 'delete_sound', description: 'Delete a sound JSON and its WAV.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (a) => { const f = fileOf(a.id); if (!fs.existsSync(f)) throw new Error('No sound ' + a.id); fs.unlinkSync(f); if (fs.existsSync(wavOf(a.id))) fs.unlinkSync(wavOf(a.id)); return { content: [{ type: 'text', text: 'deleted ' + a.id }] }; } },
];

// ---------- JSON-RPC over stdio ----------
const SERVER = { name: 'sfx-mcp', version: '1.0.0' };
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (r) => id !== undefined && send({ jsonrpc: '2.0', id, result: r });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER,
          instructions: 'Design game sound effects and music. For music use generate_music, then remix_music to reroll a part. For SFX start with generate_sound or variations (look at the preview image), refine with edit_sound / apply_macro / mutate_sound, then export_pack. Sounds use the sfx-forge/1 JSON shared with the SFX Forge editor.' });
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const t = TOOLS.find(x => x.name === params.name);
        if (!t) return fail(-32602, 'Unknown tool ' + params.name);
        try { return reply(await t.run(params.arguments || {})); }
        catch (e) { return reply({ isError: true, content: [{ type: 'text', text: 'Error: ' + e.message }] }); }
      }
      default: return fail(-32601, 'Method not found: ' + method);
    }
  } catch (e) { fail(-32603, e.message); }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
