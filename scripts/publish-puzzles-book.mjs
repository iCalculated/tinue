#!/usr/bin/env node
// Book rows as content, for scripts/publish-puzzles.sh (PLAN B2, §1.1 "Publishing"): which of the local book's rows crux
// does not hold yet. The book is insert-only and versioned (server/book.js): a publish never edits or deletes a row on
// crux; it adds the rows below as crux's next book version, and a stronger row retires a weaker one by setting its
// retired_ver (the only column ever written on an existing row). Crux serves a version only once TINUE_BOOK_VER (the
// pointer, in the launchd plist) reaches it, and lowering the pointer hides it again, retirements included.
// Reads databases read-only; writes only files it is told to. The manifest step loads no server code, so it runs on crux
// from deploy/bin/ before any code is shipped; the delta step (local only) uses server/book.js's compareRows, the rule
// crux's import applies again when it writes.
//   manifest <db>                    print crux's live book rows: a "#book <newest complete ver> <incomplete ver or 0>"
//                                    line, then "pos<TAB>win_len<TAB>exact<TAB>model<TAB>proof<TAB>checked" per row,
//                                    then the same fields after "#retired<TAB>" for each row retired by a complete
//                                    version at a pos with no live row (rejudge's retirements without a replacement)
//   delta <local db> <remote manifest> <out dir>
//                                    write <out>/book/book.jsonl (the rows to ship, scripts/import.mjs --book's format)
//                                    and <out>/book-shipped.tsv (their manifest lines); exit 1 on a length conflict with
//                                    crux or an incomplete book version on crux (nothing to write then)
//   verify <book-shipped.tsv> <remote manifest>
//                                    after a publish: every shipped row is now live on crux, field for field (exit 3 if not)
// Live rows: of a complete version (it has a book_ver row) and not retired by a complete version. A local row is shipped
// when crux has no live row for its pos, or when every live row there is weaker (compareRows 'replace'); a row crux
// already holds or holds stronger is not. Local retirements without a replacement are not shipped (nothing does that yet).
// A pos crux retired without a replacement (no live row, a retired one) is not new: the local row is held unless it is
// stronger (compareRows 'replace') than every row crux retired there, so a publish never revives a disproved row.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FIELDS = ['pos', 'win_len', 'exact', 'model', 'proof', 'checked'];
const LIVE = `SELECT * FROM book WHERE ver IN (SELECT ver FROM book_ver)
  AND (retired_ver IS NULL OR retired_ver NOT IN (SELECT ver FROM book_ver)) ORDER BY pos, ver`;
const RETIRED = `SELECT * FROM book WHERE ver IN (SELECT ver FROM book_ver) AND retired_ver IN (SELECT ver FROM book_ver)
  AND pos NOT IN (SELECT pos FROM (${LIVE})) ORDER BY pos, ver`;
function die(msg, code = 2) { console.error('publish-puzzles-book: ' + msg); process.exit(code); }
const open = (f) => { if (!fs.existsSync(f)) die(`no database at ${f}`); return new DatabaseSync(f, { readOnly: true }); };
const hasBook = (db) => ['book', 'book_ver'].every((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
function versions(db) {
  if (!hasBook(db)) return { complete: 0, incomplete: 0 };
  const complete = db.prepare('SELECT MAX(ver) v FROM book_ver').get().v ?? 0;
  const any = db.prepare('SELECT MAX(ver) v FROM book').get().v ?? 0;
  return { complete, incomplete: any > complete ? any : 0 };
}
const line = (r) => FIELDS.map((k) => (r[k] == null ? '' : String(r[k]))).join('\t');
function parse(l) {
  const [pos, win_len, exact, model, proof, checked] = l.split('\t');
  if (!pos || checked === undefined) die('bad book manifest line: ' + l.slice(0, 80));
  return { pos, win_len: win_len === '' ? null : +win_len, exact: +exact, model, proof, checked: +checked };
}
function readManifest(f) {
  const rows = new Map(), retired = new Map(); let head = null;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    if (l.startsWith('#book ')) { const [, c, i] = l.split(' '); head = { complete: +c, incomplete: +i }; continue; }
    const isRetired = l.startsWith('#retired\t'), r = parse(isRetired ? l.slice(9) : l), m = isRetired ? retired : rows;
    if (!m.has(r.pos)) m.set(r.pos, []);
    m.get(r.pos).push(r);
  }
  return { head: head ?? { complete: 0, incomplete: 0 }, rows, retired };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'manifest') {
  const db = open(args[0] || die('usage: manifest <db>'));
  const v = versions(db);
  let out = `#book ${v.complete} ${v.incomplete}\n`;
  if (hasBook(db)) {
    for (const r of db.prepare(LIVE).iterate()) out += line(r) + '\n';
    for (const r of db.prepare(RETIRED).iterate()) out += '#retired\t' + line(r) + '\n';
  }
  process.stdout.write(out);
} else if (cmd === 'delta') {
  const [dbFile, remoteFile, outDir] = args;
  if (!dbFile || !remoteFile || !outDir) die('usage: delta <local db> <remote manifest> <out dir>');
  const { compareRows } = await import('../server/book.js'); // local only: crux's deploy/bin/ has no server/
  const db = open(dbFile), remote = readManifest(remoteFile), lv = versions(db);
  fs.mkdirSync(path.join(outDir, 'book'), { recursive: true });
  const ship = [], conflicts = [];
  let local = 0, fresh = 0, stronger = 0, held = 0, heldRetired = 0;
  if (hasBook(db)) for (const r of db.prepare(LIVE).iterate()) {
    local++;
    const there = remote.rows.get(r.pos) || [];
    const cs = there.map((a) => compareRows(a, r));
    if (cs.includes('conflict')) { conflicts.push({ pos: r.pos, local: line(r), crux: there.map(line) }); continue; }
    if (cs.includes('keep')) { held++; continue; }
    const gone = there.length ? [] : remote.retired.get(r.pos) || [];
    if (gone.some((a) => compareRows(a, r) !== 'replace')) { heldRetired++; continue; }
    if (there.length || gone.length) stronger++; else fresh++;
    ship.push(r);
  }
  fs.writeFileSync(path.join(outDir, 'book', 'book.jsonl'), ship.map((r) => JSON.stringify({ pos: r.pos, win_len: r.win_len, exact: r.exact, model: r.model,
    proof: r.proof, checked: r.checked, puzzle_id: r.puzzle_id ?? null, commit_sha: r.commit_sha }) + '\n').join(''));
  fs.writeFileSync(path.join(outDir, 'book-shipped.tsv'), ship.map((r) => line(r) + '\n').join(''));
  const crux = [...remote.rows.values()].reduce((n, a) => n + a.length, 0);
  console.log(`book: ${local} live local rows (version ${lv.complete}${lv.incomplete ? `; local version ${lv.incomplete} is incomplete and not shipped` : ''}); ` +
    `crux has ${crux} (version ${remote.head.complete}). new ${fresh}, stronger ${stronger}, already there or weaker ${held}; shipping ${ship.length}`);
  if (heldRetired) console.log(`book: ${heldRetired} rows crux retired without a replacement are held (not shipped back; a stronger row would be)`);
  if (remote.head.incomplete && (ship.length || conflicts.length)) die(`crux has an incomplete book version ${remote.head.incomplete} (a book-init killed while writing?); finish it there first (run book-init again on crux's database). Nothing written.`, 1);
  if (conflicts.length) {
    console.log(`book: ${conflicts.length} LENGTH CONFLICTS with crux (same model, lengths that cannot both be right); nothing written:`);
    for (const c of conflicts.slice(0, 20)) console.log(`  ${c.pos}\n    here: ${c.local}\n    crux: ${c.crux.join(' | ')}`);
    process.exit(1);
  }
} else if (cmd === 'verify') {
  const [shippedFile, remoteFile] = args;
  if (!shippedFile || !remoteFile) die('usage: verify <book-shipped.tsv> <remote manifest>');
  const remote = readManifest(remoteFile);
  const shipped = fs.readFileSync(shippedFile, 'utf8').split('\n').filter(Boolean);
  const bad = shipped.filter((l) => !(remote.rows.get(parse(l).pos) || []).some((a) => line(a) === l));
  console.log(`book verify: ${shipped.length - bad.length} of ${shipped.length} shipped rows now live on crux (book version ${remote.head.complete})`);
  if (bad.length) { console.log(`book verify: MISMATCH ${bad.length}, e.g. ${bad.slice(0, 3).map((l) => l.split('\t')[0]).join(' ')}`); process.exit(3); }
} else die('usage: publish-puzzles-book.mjs manifest|delta|verify …');
