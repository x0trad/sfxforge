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
// Chrome's WebMCP origin trial: register sfxforge.vercel.app at
// https://developer.chrome.com/origintrials and set the token as WEBMCP_OT_TOKEN (e.g. a Vercel env var).
const ot = (process.env.WEBMCP_OT_TOKEN || '').trim();
if (ot && !/^[A-Za-z0-9+/=]+$/.test(ot)) throw new Error('WEBMCP_OT_TOKEN does not look like an origin trial token');
const otMeta = ot ? '<meta http-equiv="origin-trial" content="' + ot + '">' : '';
const out = '<!doctype html><html lang="en"><head><meta charset="utf-8">' + otMeta
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>[hidden]{display:none!important}body{margin:0}</style></head><body>\n' + body + '\n</body></html>\n';
// Vercel Web Analytics: ship the @vercel/analytics browser module and call inject() on every page.
// The package has no imports, so it runs as a plain ES module without a bundler.
let analytics = '';
try {
  const mod = require.resolve('@vercel/analytics').replace(/index\.js$/, 'index.mjs');
  fs.mkdirSync(path.join(root, 'dist', 'va'), { recursive: true });
  fs.copyFileSync(mod, path.join(root, 'dist', 'va', 'analytics.mjs'));
  analytics = '<script type="module">import { inject } from "/va/analytics.mjs"; inject();</script>';
} catch (e) { console.warn('@vercel/analytics not installed: building without Web Analytics (run npm install)'); }
const withAnalytics = (html) => analytics ? html.replace(/<\/body>(?![\s\S]*<\/body>)/, analytics + '\n</body>') : html;
for (const name of ['index.html', 'sfx-forge.html']) fs.writeFileSync(path.join(root, 'dist', name), withAnalytics(out));
console.log('dist/index.html + dist/sfx-forge.html', (out.length / 1024).toFixed(0) + ' KB', ot ? '(WebMCP origin trial token included)' : '(no WebMCP origin trial token)');
// Static pages that ship as-is.
for (const page of ['connect.html']) fs.writeFileSync(path.join(root, 'dist', page), withAnalytics(fs.readFileSync(path.join(__dirname, page), 'utf8')));
console.log('dist/connect.html', analytics ? '(Web Analytics on)' : '(Web Analytics off)');
