// Spawns the server over stdio and exercises every tool. Run: npm test
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-smoke-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: Object.assign({}, process.env, { SFX_DIR: dir }) });
let buf = '', nextId = 1; const pending = new Map();
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); } });
srv.stderr.on('data', (d) => process.stderr.write(d));
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error || r.result.isError) throw new Error(name + ': ' + JSON.stringify(r.error || r.result.content));
  return r.result;
};
const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); console.log('  ok  ' + m); };

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  ok(init.result.serverInfo.name === 'sfx-mcp', 'initialize');
  const tl = await rpc('tools/list', {});
  ok(tl.result.tools.length === 14, 'tools/list (' + tl.result.tools.length + ' tools)');
  await call('list_categories', {});
  const g = await call('generate_sound', { category: 'punch', seed: 7, id: 'p1' });
  ok(g.content[1].type === 'image' && fs.existsSync(path.join(dir, 'p1.wav')), 'generate_sound → wav + png');
  const e = await call('edit_sound', { id: 'p1', patch: { master: { reverb: 0.2 } }, layers: [{ layer: 'body', set: { freq: 120 } }], add_layers: [{ name: 'click', wave: 'noise', hits: [{ t: 0, len: 0.01 }] }] });
  ok(JSON.parse(e.content[0].text).sound.layers.length === 4, 'edit_sound');
  await call('apply_macro', { id: 'p1', macro: 'grit', value: 0.5, save_as: 'p1-grit' });
  await call('mutate_sound', { id: 'p1', amount: 0.3, seed: 3, save_as: 'p1-mut' });
  const rnd = await call('generate_sound', { category: 'random', seed: 99, wildness: 0.8, id: 'rnd' });
  ok(JSON.parse(rnd.content[0].text).sound.category === 'random', 'generate_sound random + wildness');
  const rv = await call('variations', { category: 'random', wildness: 0.2, count: 2 });
  ok(rv.content.filter(c => c.type === 'image').length === 2, 'variations random');
  const mu = await call('generate_music', { style: 'chiptune', seconds: 30, seed: 5, id: 'song' });
  const mj = JSON.parse(mu.content[0].text);
  ok(mj.analysis.duration > 24 && mj.analysis.duration < 40 && mj.music.bpm > 100, 'generate_music (' + mj.analysis.duration + ' s @ ' + mj.music.bpm + ' bpm)');
  await call('apply_macro', { id: 'song', macro: 'length', value: 1.2, save_as: 'song-slow' });
  const v = await call('variations', { category: 'coin', count: 3 });
  ok(v.content.filter(c => c.type === 'image').length === 3, 'variations');
  const full = JSON.parse((await call('get_sound', { id: 'p1' })).content[0].text);
  await call('set_sound', { sound: full, id: 'p1-copy' });
  await call('render_sound', { id: 'p1-copy', mono: true, sampleRate: 22050, out: 'renders/p1.wav' });
  ok(fs.existsSync(path.join(dir, 'renders', 'p1.wav')), 'render_sound mono 22k');
  const pk = JSON.parse((await call('export_pack', { dir: 'pack' })).content[0].text);
  ok(pk.count >= 6 && fs.existsSync(path.join(dir, 'pack', 'manifest.json')), 'export_pack (' + pk.count + ' sounds)');
  await call('delete_sound', { id: 'p1-copy' });
  ok(!JSON.parse((await call('list_sounds', {})).content[0].text).sounds.some(s => s.id === 'p1-copy'), 'delete_sound + list_sounds');
  const bad = await rpc('tools/call', { name: 'get_sound', arguments: { id: '../etc' } });
  ok(bad.result.isError, 'rejects path traversal');
  console.log('\nall good — files in ' + dir);
  srv.kill();
})().catch((e) => { console.error(e.message); srv.kill(); process.exit(1); });
