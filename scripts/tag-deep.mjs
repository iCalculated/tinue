#!/usr/bin/env node
// Put the theme tag 'deep' (shared/themes.js: Deep tinuë) on the puzzles listed in scripts/deep-proven.jsonl, in the
// normalized puzzle files (one JSON puzzle per line, data/puzzles*/*.jsonl; untracked local data). The list is the
// record; this makes the files agree with it, so it is re-run after a file is regenerated. Idempotent: a second run
// changes nothing. Only the tag is added: every other byte of every line stays as it was.
// usage: node scripts/tag-deep.mjs [--dry-run] [--list <file>] [<file-or-dir> ...]
//   paths      files or directories (their *.jsonl); default data/puzzles and data/puzzles-ps6ge7 (pd and ps rows)
//   --dry-run  write nothing; print what would change
//   --list     the list of ids (default scripts/deep-proven.jsonl)
// Refuses (exit 2, nothing written) when a listed id is in none of the files, is in them more than once, or a line
// that needs the tag has no top-level "tags" array. Each file it changes is first copied to <file>.bak-pre-deep-YYYYMMDD
// (kept if it already exists), then replaced in one rename. After it: import the files as usual (scripts/import.mjs)
// and publish (scripts/publish-puzzles.sh).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TAG = 'deep';
export const LIST = fileURLToPath(new URL('deep-proven.jsonl', import.meta.url));

// The ids in a list file (comment lines start with # or //). Throws on a bad line or a repeated id.
export function readList(file = LIST) {
  const ids = new Set();
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    let r; try { r = JSON.parse(t); } catch (e) { throw new Error(`${file} line ${i + 1}: ${e.message}`); }
    if (typeof r?.id !== 'string' || !r.id) throw new Error(`${file} line ${i + 1}: no id`);
    if (ids.has(r.id)) throw new Error(`${file} line ${i + 1}: ${r.id} is listed twice`);
    ids.add(r.id);
  });
  return ids;
}

// Where the top-level "tags" array of one JSON object line starts and ends: [index of '[', index of its ']'], or null.
// A small scanner (strings and nesting) so a "tags" key inside meta, or the text "tags" inside a string, is not taken.
export function tagsSpan(line) {
  let depth = 0, i = 0;
  const str = () => { // at an opening quote: return the index after the closing one
    for (i++; i < line.length; i++) { if (line[i] === '\\') i++; else if (line[i] === '"') return ++i; }
    return i;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      const s = i, e = str();
      if (depth === 1 && line.slice(s, e) === '"tags"') {
        let j = e; while (/\s/.test(line[j] ?? '')) j++;
        if (line[j] !== ':') continue; // a string value "tags", not a key
        j++; while (/\s/.test(line[j] ?? '')) j++;
        if (line[j] !== '[') return null;
        const open = j; let d = 0;
        for (i = j; i < line.length; ) {
          if (line[i] === '"') { str(); continue; }
          if (line[i] === '[') d++; else if (line[i] === ']' && --d === 0) return [open, i];
          i++;
        }
        return null;
      }
      continue;
    }
    if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

// One line with the tag added at the end of its tags (the array's own spacing kept), or the same line if it has it.
// Throws when the line has no usable tags array, or when the result is not exactly "the same puzzle plus the tag".
export function addTag(line, tag = TAG) {
  const before = JSON.parse(line);
  if (Array.isArray(before.tags) && before.tags.includes(tag)) return line;
  const span = tagsSpan(line);
  if (!span || !Array.isArray(before.tags)) throw new Error(`${before.id}: no top-level "tags" array`);
  const [open, close] = span, inner = line.slice(open + 1, close);
  const q = JSON.stringify(tag);
  const out = line.slice(0, close) + (inner.trim() === '' ? q : (/",\s/.test(inner) ? ', ' : ',') + q) + line.slice(close);
  const after = JSON.parse(out);
  if (JSON.stringify({ ...after, tags: null }) !== JSON.stringify({ ...before, tags: null }) || JSON.stringify(after.tags) !== JSON.stringify([...before.tags, tag]))
    throw new Error(`${before.id}: adding the tag would change more than the tags`);
  return out;
}

const ID = /^\s*\{\s*"id"\s*:\s*"([^"\\]*)"/; // every normalized file starts its lines with the id
export const idOf = (line) => { const m = ID.exec(line); if (m) return m[1]; try { return JSON.parse(line)?.id ?? null; } catch { return null; } };

// Plan the change for a set of files: { changes: [{ file, text, ids }], tagged: ids already tagged, problems: [] }.
// Nothing is written. text is the file's new content; a file with nothing to change is not in changes.
export function plan(files, ids, tag = TAG) {
  const seen = new Map(), changes = [], tagged = [], problems = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8'), lines = src.split('\n'), did = [];
    for (let k = 0; k < lines.length; k++) {
      const body = lines[k].endsWith('\r') ? lines[k].slice(0, -1) : lines[k];
      if (!body.trim()) continue;
      const id = idOf(body);
      if (!ids.has(id)) continue;
      if (seen.has(id)) { problems.push(`${id} is in ${seen.get(id)} and again in ${file}:${k + 1}`); continue; }
      seen.set(id, `${file}:${k + 1}`);
      let out; try { out = addTag(body, tag); } catch (e) { problems.push(`${file}:${k + 1}: ${e.message}`); continue; }
      if (out === body) { tagged.push(id); continue; }
      lines[k] = out + lines[k].slice(body.length); did.push(id);
    }
    if (did.length) changes.push({ file, text: lines.join('\n'), ids: did });
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`${id} is in none of the files`);
  return { changes, tagged, problems };
}

export function filesOf(paths) {
  const out = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`no such file or directory: ${p}`);
    if (fs.statSync(p).isDirectory()) out.push(...fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(p, f)));
    else out.push(p);
  }
  return out;
}

// Write a plan: back each file up (once), then replace it by a rename. Returns the backups made.
export function apply(changes, stamp) {
  const backups = [];
  for (const c of changes) {
    const bak = `${c.file}.bak-pre-deep-${stamp}`;
    if (!fs.existsSync(bak)) { fs.copyFileSync(c.file, bak); backups.push(bak); }
    const tmp = `${c.file}.tmp-deep-${process.pid}`;
    fs.writeFileSync(tmp, c.text);
    fs.renameSync(tmp, c.file);
  }
  return backups;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const li = argv.indexOf('--list');
  if (li >= 0 && (!argv[li + 1] || argv[li + 1].startsWith('--'))) { console.error('tag-deep: --list needs a file'); process.exit(2); }
  const list = li >= 0 ? argv.splice(li, 2)[1] : LIST;
  const bad = argv.filter((a) => a.startsWith('--') && a !== '--dry-run');
  if (bad.length) { console.error(`tag-deep: unknown option ${bad.join(' ')}`); process.exit(2); }
  const paths = argv.filter((a) => !a.startsWith('--'));
  let ids, files, p;
  try {
    ids = readList(list);
    files = filesOf(paths.length ? paths : ['data/puzzles', 'data/puzzles-ps6ge7']);
    p = plan(files, ids);
  } catch (e) { console.error(`tag-deep: ${e.message}`); process.exit(2); }
  if (p.problems.length) { console.error(`tag-deep: refusing, nothing written:\n  ${p.problems.join('\n  ')}`); process.exit(2); }
  const n = p.changes.reduce((a, c) => a + c.ids.length, 0);
  for (const c of p.changes) console.log(`${dry ? 'would tag' : 'tagging'} ${c.ids.length} in ${c.file}`);
  if (!dry && n) {
    const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    for (const b of apply(p.changes, stamp)) console.log(`backup: ${b}`);
  }
  console.log(`tag-deep: ${ids.size} listed, ${n} ${dry ? 'to tag' : 'tagged'}, ${p.tagged.length} already had the tag${dry ? ' (dry run: nothing written)' : ''}`);
}
