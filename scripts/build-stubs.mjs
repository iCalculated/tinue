#!/usr/bin/env node
// Per-puzzle pages for the static site, so a puzzle's address unfurls in Discord & co.:
// <out>/puzzle/<id>.html (GitHub Pages also serves it as /puzzle/<id>) carries the puzzle's embed tags (title,
// last moves, or the unplayed line for a dragon sub-position, board picture from the API's /p/<id>.png) and forwards
// to the app at ../#/puzzle/<id>, which then shows /puzzle/<id> in the address bar again. Content is stable (no live
// ratings) so rebuilds don't churn git.
//   node scripts/build-stubs.mjs <out dir> <site url, e.g. https://shydrie.xyz/tinue/> <api url> [--all] [--dry-run]
// By default a page whose file already holds exactly its content is left alone, and files in <out>/puzzle/ that no
// puzzle produces are removed, so the directory ends up byte-for-byte what a fresh build writes (build-static.sh keeps
// the old puzzle/ across builds for this). --all writes every page (the behaviour before 2026-11-17). --dry-run counts
// what would be written and removed and touches nothing. Database: $TINUE_DB or data/tinue.db, read-only.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sharePage } from '../server/share.js';

const argv = process.argv.slice(2), flag = (f) => { const i = argv.indexOf(f); return i >= 0 && argv.splice(i, 1).length > 0; };
const ALL = flag('--all') || process.env.STUBS === 'all', DRY = flag('--dry-run') || !!(process.env.DRY_RUN && process.env.DRY_RUN !== '0');
const [OUT, SITE_URL, API] = argv;
if (!OUT || !SITE_URL || !API) { console.error('usage: build-stubs.mjs <out> <site url> <api url> [--all] [--dry-run]'); process.exit(2); }
const DB = process.env.TINUE_DB || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'tinue.db');
const db = new DatabaseSync(DB, { readOnly: true });
const dir = path.join(OUT, 'puzzle');
if (!DRY) fs.mkdirSync(dir, { recursive: true });
const keep = new Set();
let n = 0, wrote = 0;
for (const p of db.prepare("SELECT id, size, tps, plies, themes, source, komi, meta FROM puzzles WHERE source NOT LIKE 'Ditaktic%'").iterate()) {
  if (!/^[\w.-]+$/.test(p.id)) continue;
  const file = path.join(dir, p.id + '.html'), html = sharePage(p, {
    shareUrl: SITE_URL + 'puzzle/' + p.id, imageUrl: API.replace(/\/$/, '') + '/p/' + p.id + '.png', puzzleUrl: '../#/puzzle/' + p.id,
  });
  keep.add(p.id + '.html');
  n++;
  if (!ALL) { let old = null; try { old = fs.readFileSync(file, 'utf8'); } catch {} if (old === html) continue; }
  wrote++;
  if (!DRY) fs.writeFileSync(file, html);
}
// Anything else in puzzle/ (a puzzle since removed, a stray file): a fresh build would not have it.
let removed = 0;
for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
  if (keep.has(e.name)) continue;
  removed++;
  if (!DRY) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
}
console.log(`${DRY ? '[dry-run] would write' : 'wrote'} ${wrote} of ${n} puzzle pages to ${dir}` + (ALL ? ' (--all)' : `, ${n - wrote} unchanged`) +
  (removed ? `, ${DRY ? 'would remove' : 'removed'} ${removed} stale` : ''));
