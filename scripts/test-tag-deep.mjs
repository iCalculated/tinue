// The Deep tinuë theme's record and its tagger: scripts/deep-proven.jsonl, scripts/tag-deep.mjs, and the hand grades
// that put its reserve puzzles in the served pool (scripts/grade-overrides.jsonl).   node scripts/test-tag-deep.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { THEMES } from '../shared/themes.js';
import { TAG, LIST, readList, tagsSpan, addTag, idOf, plan, filesOf, apply } from './tag-deep.mjs';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-tag-deep-'));
const CLI = root + 'scripts/tag-deep.mjs';
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('the theme exists, sits in Length right after Road in 4+, and its key is what the tagger writes', () => {
  assert.equal(TAG, 'deep');
  assert.equal(THEMES.deep.group, 'Length');
  const keys = Object.keys(THEMES);
  assert.equal(keys[keys.indexOf('tinueIn4') + 1], 'deep');
  assert.match(TAG, /^[A-Za-z0-9]+$/); // server/pool.js takes its fast path for such a theme
  for (const k of keys) if (k !== TAG) assert.ok(!k.includes(TAG) && !TAG.includes(k), `${k} and ${TAG} must not contain one another`);
});

test('the list: 49 distinct 6x6-length rows, each with its proven first move(s) and proof length', () => {
  const ids = readList();
  assert.equal(ids.size, 49);
  assert.ok(!ids.has('pd654193')); // production rejects it (grade D)
  let flagged = 0, refuted = 0;
  for (const line of fs.readFileSync(LIST, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const r = JSON.parse(line);
    assert.match(r.id, /^p[ds]\d+$/);
    assert.ok([11, 13, 15].includes(r.plies), r.id);
    assert.equal(r.proof.L, r.plies, r.id); // proved to the puzzle's own length
    assert.ok(['gold', 'silver'].includes(r.proof.tier), r.id);
    assert.ok(Array.isArray(r.key) && r.key.length >= 1 && r.key.every((m) => typeof m === 'string' && m), r.id);
    assert.equal(r.date, '2026-11-19');
    assert.ok(Number.isInteger(r.rootUndecided) && r.rootUndecided >= 0, r.id); if (!r.rootUndecided) refuted++;
    if (r.flaggedRootAlt) { flagged++; assert.ok(r.flaggedRootAlt.every((m) => !r.key.includes(m)), r.id); }
  }
  assert.equal(flagged, 7);
  assert.equal(refuted, 12); // rows where every other first move was refuted outright
  assert.ok(!/prove[ds]? that none|only (one|move) that (wins|forces)/.test(THEMES.deep.desc)); // the text claims a search, not a proof of uniqueness
});

test('the hand grades: 34 listed rows made A with a why naming the decision; no hold; none is the rejected row', () => {
  const ids = readList(), deep = [];
  for (const line of fs.readFileSync(root + 'scripts/grade-overrides.jsonl', 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const r = JSON.parse(line);
    if (r['deep-20261119'] === true) deep.push(r);
    else assert.ok(!ids.has(r.id), `${r.id} is listed and has another hand grade`);
  }
  assert.equal(deep.length, 34);
  assert.equal(new Set(deep.map((r) => r.id)).size, 34);
  for (const r of deep) {
    assert.ok(ids.has(r.id), r.id);
    assert.equal(r.tier, 'A');
    assert.match(r.why, /Sasha's decision 2026-11-19/);
    assert.match(r.why, /grader had [BC] \(|not graded before/);
    assert.ok(!Object.keys(r).some((k) => /^hold-/.test(k)));
  }
});

const L = (o) => JSON.stringify(o);
const row = (id, tags, extra = {}) => ({ id, size: 6, tps: 'x6/x6/x6/x6/x6/x6 1 1', komi: 0, plies: 11, tree: { a1: { r: 'b1', n: 'win' } }, tags, rating: 2900, source: 'PlayTak', meta: {}, ...extra });

test('tagsSpan finds only the top-level tags array', () => {
  const a = L(row('pd1', ['s6', 'fork']));
  const [o, c] = tagsSpan(a);
  assert.equal(a.slice(o, c + 1), '["s6","fork"]');
  const nested = L({ id: 'pd2', meta: { tags: ['x'] }, note: '"tags":["y"]', tags: ['s6'] });
  const [o2, c2] = tagsSpan(nested);
  assert.equal(nested.slice(o2, c2 + 1), '["s6"]');
  assert.equal(nested.indexOf('"tags":["s6"]') + 7, o2);
  assert.equal(tagsSpan(L({ id: 'pd3', meta: { tags: ['x'] } })), null);
  assert.equal(tagsSpan(L({ id: 'pd4', tags: 'deep' })), null);
  const tricky = L({ id: 'pd5', a: 'tags', tags: ['a]b', 'c"d', 'e\\'] });
  const [o3, c3] = tagsSpan(tricky);
  assert.deepEqual(JSON.parse(tricky.slice(o3, c3 + 1)), ['a]b', 'c"d', 'e\\']);
});

test('addTag adds the tag last, keeps every other byte, and leaves a tagged line alone', () => {
  const a = L(row('pd1', ['s6', 'fork', 'tinueIn4']));
  const b = addTag(a);
  assert.equal(b, a.replace('"tinueIn4"]', '"tinueIn4","deep"]'));
  assert.equal(addTag(b), b);
  // the file's own spacing
  const spaced = '{"id": "pd2", "tags": ["s6", "tak"], "meta": {"tags": ["m"]}, "tps": "é ü"}';
  assert.equal(addTag(spaced), '{"id": "pd2", "tags": ["s6", "tak", "deep"], "meta": {"tags": ["m"]}, "tps": "é ü"}');
  assert.equal(addTag('{"id":"pd3","tags":[]}'), '{"id":"pd3","tags":["deep"]}');
  assert.equal(addTag('{"id":"pd3","tags":[ ]}'), '{"id":"pd3","tags":[ "deep"]}');
  assert.throws(() => addTag('{"id":"pd4","meta":{"tags":["x"]}}'), /no top-level "tags" array/);
  assert.throws(() => addTag('{"id":"pd5","tags":"s6"}'), /no top-level "tags" array/);
  // a line whose tags key appears twice would not round-trip: refused rather than half-edited
  assert.throws(() => addTag('{"id":"pd6","tags":["a"],"tags":["b"]}'), /would change more than the tags/);
});

test('idOf reads the id whether or not it comes first', () => {
  assert.equal(idOf('{"id":"pd91325","size":6}'), 'pd91325');
  assert.equal(idOf('{"id": "ps7", "x": 1}'), 'ps7');
  assert.equal(idOf('{"size":6,"id":"pd9"}'), 'pd9');
  assert.equal(idOf('not json'), null);
});

test('plan and apply: only the listed ids, only the tag, a backup, nothing on a second run', () => {
  const d = tmp();
  const f1 = path.join(d, 'a.jsonl'), f2 = path.join(d, 'b.jsonl');
  const lines1 = [L(row('pd9132', ['s6'])), L(row('pd91325', ['s6', 'smash'])), '', L(row('pd913250', ['s6'])), L(row('pd7', ['s6', 'deep']))];
  fs.writeFileSync(f1, lines1.join('\n') + '\n');
  fs.writeFileSync(f2, L(row('ps5', ['s6', 'tak'])) + '\r\n' + L(row('ps6', ['s6']))); // CRLF, and no newline at the end
  fs.writeFileSync(path.join(d, 'a.jsonl.skipped'), L(row('pd91325', ['s6'])) + '\n'); // not a .jsonl: never read
  const ids = new Set(['pd91325', 'pd7', 'ps5']);
  const files = filesOf([d]);
  assert.deepEqual(files, [f1, f2]);
  const p = plan(files, ids);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.tagged, ['pd7']);
  assert.deepEqual(p.changes.map((c) => [c.file, c.ids]), [[f1, ['pd91325']], [f2, ['ps5']]]);
  assert.equal(fs.readFileSync(f1, 'utf8'), lines1.join('\n') + '\n'); // planning writes nothing
  const backups = apply(p.changes, '20261119');
  assert.deepEqual(backups, [f1 + '.bak-pre-deep-20261119', f2 + '.bak-pre-deep-20261119']);
  assert.equal(fs.readFileSync(backups[0], 'utf8'), lines1.join('\n') + '\n');
  const want1 = [...lines1]; want1[1] = lines1[1].replace('"smash"]', '"smash","deep"]');
  assert.equal(fs.readFileSync(f1, 'utf8'), want1.join('\n') + '\n'); // pd9132 and pd913250 (a prefix, a longer id) untouched
  assert.equal(fs.readFileSync(f2, 'utf8'), L(row('ps5', ['s6', 'tak'])).replace('"tak"]', '"tak","deep"]') + '\r\n' + L(row('ps6', ['s6'])));
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.includes('.tmp-deep-')), []);
  const again = plan(filesOf([d]), ids); // the backups are not .jsonl, so the directory still reads as two files
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.tagged.sort(), ['pd7', 'pd91325', 'ps5']);
  fs.rmSync(d, { recursive: true });
});

test('plan refuses a missing id, a repeated id and a line with no tags; nothing is written', () => {
  const d = tmp();
  const f1 = path.join(d, 'a.jsonl'), f2 = path.join(d, 'b.jsonl');
  fs.writeFileSync(f1, [L(row('pd1', ['s6'])), L(row('pd2', ['s6'])), L({ id: 'pd3', size: 6 })].join('\n') + '\n');
  fs.writeFileSync(f2, L(row('pd2', ['s6'])) + '\n');
  const p = plan([f1, f2], new Set(['pd1', 'pd2', 'pd3', 'pd4']));
  assert.equal(p.problems.length, 3);
  assert.ok(p.problems.some((x) => /^pd2 is in .*a\.jsonl:2 and again in .*b\.jsonl:1$/.test(x)));
  assert.ok(p.problems.some((x) => /a\.jsonl:3: pd3: no top-level "tags" array/.test(x)));
  assert.ok(p.problems.includes('pd4 is in none of the files'));
  fs.rmSync(d, { recursive: true });
});

test('the command: --dry-run writes nothing; a run tags and backs up; a re-run changes nothing; a refusal exits 2', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'puz'));
  const f = path.join(d, 'puz', 'x.jsonl'), list = path.join(d, 'list.jsonl');
  const src = [L(row('pd1', ['s6'])), L(row('pd2', ['s6', 'fork']))].join('\n') + '\n';
  fs.writeFileSync(f, src);
  fs.writeFileSync(list, '# a comment\n{"id":"pd2"}\n');
  let r = run(['--dry-run', '--list', list, path.join(d, 'puz')], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would tag 1 in .*x\.jsonl/);
  assert.match(r.stdout, /1 listed, 1 to tag, 0 already had the tag \(dry run: nothing written\)/);
  assert.equal(fs.readFileSync(f, 'utf8'), src);
  assert.deepEqual(fs.readdirSync(path.join(d, 'puz')), ['x.jsonl']);
  r = run(['--list', list, f], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 listed, 1 tagged, 0 already had the tag/);
  const out = fs.readFileSync(f, 'utf8');
  assert.equal(out, src.replace('"fork"]', '"fork","deep"]'));
  const baks = fs.readdirSync(path.join(d, 'puz')).filter((x) => /^x\.jsonl\.bak-pre-deep-\d{8}$/.test(x));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(d, 'puz', baks[0]), 'utf8'), src);
  r = run(['--list', list, f], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 listed, 0 tagged, 1 already had the tag/);
  assert.equal(fs.readFileSync(f, 'utf8'), out);
  fs.writeFileSync(list, '{"id":"pd2"}\n{"id":"pd9"}\n');
  r = run(['--list', list, f], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing, nothing written:\n  pd9 is in none of the files/);
  assert.equal(fs.readFileSync(f, 'utf8'), out);
  fs.writeFileSync(list, '{"id":"pd2"}\n{"id":"pd2"}\n');
  r = run(['--list', list, f], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pd2 is listed twice/);
  assert.equal(run(['--nope'], d).status, 2);
  assert.equal(run(['--list', list, path.join(d, 'none')], d).status, 2);
  fs.rmSync(d, { recursive: true });
});

test('the grade-override lines pass the import\'s own checks (tier A-D, a why, no repeated id)', () => {
  const seen = new Set();
  for (const line of fs.readFileSync(root + 'scripts/grade-overrides.jsonl', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const r = JSON.parse(t);
    assert.ok(typeof r.id === 'string' && r.id);
    assert.ok(['A', 'B', 'C', 'D'].includes(r.tier), r.id);
    assert.ok(typeof r.why === 'string' && r.why.trim(), r.id);
    assert.ok(!seen.has(r.id), `${r.id} twice`);
    seen.add(r.id);
  }
});

console.log(`all ${n} passed`);
