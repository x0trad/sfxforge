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
const out = src.replace('/*__ENGINE__*/', () => engine);
fs.writeFileSync(path.join(root, 'dist', 'sfx-forge.html'), out);
console.log('dist/sfx-forge.html', (out.length / 1024).toFixed(0) + ' KB');
