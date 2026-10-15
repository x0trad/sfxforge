// Inlines src/engine.js into the editor so the page is one self-contained HTML file.
// Usage: npm run build  →  dist/sfx-forge.html
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(__dirname, 'editor.src.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src', 'engine.js'), 'utf8');
if (!src.includes('/*__ENGINE__*/')) throw new Error('editor.src.html is missing the /*__ENGINE__*/ placeholder');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const body = src.replace('/*__ENGINE__*/', () => engine);
// Standalone pages need the document shell that Claude's artifact viewer normally adds.
const out = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>[hidden]{display:none!important}body{margin:0}</style></head><body>\n' + body + '\n</body></html>\n';
for (const name of ['index.html', 'sfx-forge.html']) fs.writeFileSync(path.join(root, 'dist', name), out);
console.log('dist/index.html + dist/sfx-forge.html', (out.length / 1024).toFixed(0) + ' KB');
// Static pages that ship as-is.
for (const page of ['connect.html']) fs.copyFileSync(path.join(__dirname, page), path.join(root, 'dist', page));
console.log('dist/connect.html');
