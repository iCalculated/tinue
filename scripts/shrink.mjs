#!/usr/bin/env node
// The last step of a static build (scripts/build-static.sh): make the first visit lighter. The source is untouched.
//   node scripts/shrink.mjs <out dir>
// - every module app.js imports statically is listed in index.html (modulepreload), so they load in one round, not three
// - with esbuild: our modules are minified (over half their bytes are comments), and so are the two stylesheets, which go
//   into the page itself: the board's iframe is started by an inline script, and a script waits for the stylesheets
//   before it, so as files they held PTN Ninja back a round trip and more
// esbuild: $TINUE_ESBUILD, or node_modules/.bin/esbuild (not in git; any 0.2x: no syntax is lowered, --target=esnext).
// Without it only the first is done (TINUE_ESBUILD=none: on purpose, the tests' builds read the modules).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = process.argv[2];
if (!out) { console.error('usage: shrink.mjs <out dir>'); process.exit(2); }
const at = (f) => path.join(out, f), page = at('index.html');
let html = fs.readFileSync(page, 'utf8');
const once = (a, b) => { if (html.split(a).length !== 2) throw new Error('shrink: index.html has not exactly one ' + a); html = html.replace(a, () => b); };

const app = html.match(/<script type="module" src="(app\.js[^"]*)">/);
if (!app) throw new Error('shrink: no app.js in index.html');
const seen = new Set();
(function walk(url) { // addresses as the modules import them, ?v and all: another address would be another copy
  if (seen.has(url)) return;
  seen.add(url);
  const src = fs.readFileSync(at(url.replace(/\?.*/, '')), 'utf8'), dir = path.posix.dirname(url);
  for (const [, spec] of src.matchAll(/^(?:import|export)\b[^;]*?\bfrom '(\.\/[^']+)'/gm)) walk(path.posix.join(dir, spec));
})(app[1]);
seen.delete(app[1]);
once(app[0], [...seen].map((u) => `<link rel="modulepreload" href="${u}">`).join('\n') + '\n' + app[0]);

const local = path.join(import.meta.dirname, '../node_modules/.bin/esbuild'), want = process.env.TINUE_ESBUILD;
const bin = want === 'none' ? null : want || (fs.existsSync(local) ? local : null);
if (!bin) console.error('shrink: not minified (no esbuild: ' + local + ')');
else {
  const min = (f) => execFileSync(bin, [f, '--minify', '--target=esnext', '--charset=utf8', '--legal-comments=inline', '--log-level=error'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
  const js = [...fs.readdirSync(out).filter((f) => f.endsWith('.js') && f !== 'config.js'), ...fs.readdirSync(at('shared')).map((f) => 'shared/' + f).filter((f) => f.endsWith('.js'))];
  const done = js.map((f) => [f, min(at(f))]); // all of it before any is written: a failure leaves a build that works
  for (const name of ['board.css', 'style.css']) {
    const link = html.match(new RegExp(`<link rel="stylesheet" href="${name.replace('.', '\\.')}[^"]*">`))?.[0], css = min(at(name)).trim();
    if (!link || /<\/style/i.test(css) || /url\((?!["']?(?:data:|%23|#))/.test(css)) throw new Error('shrink: cannot put ' + name + ' into the page');
    once(link, `<style>${css}</style>`);
  }
  for (const [f, code] of done) fs.writeFileSync(at(f), code);
}
fs.writeFileSync(page, html);
console.log(`shrink: ${seen.size} modules listed${bin ? ', minified, styles in the page' : ''}`);
