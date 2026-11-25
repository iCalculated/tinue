// Back up the live database (tinue-backup.timer, every 10 minutes, as tinue). latest.db is replaced whole; the hour's
// first and the day's first copy are kept as hard links: 48 hourly, 30 daily. crux pulls latest.db (ops/move/crux.sh pull).
//   node ops/backup.mjs [--dry-run]    back up
//   node ops/backup.mjs --verify       restore drill: copy latest.db elsewhere, open it for writing, check it
// env TINUE_DB (/var/lib/tinue/tinue.db), TINUE_BACKUP (/var/lib/tinue-backup)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDb, manifest } from './move/db.mjs';

const DB = process.env.TINUE_DB || '/var/lib/tinue/tinue.db', DIR = process.env.TINUE_BACKUP || '/var/lib/tinue-backup';
const LATEST = path.join(DIR, 'latest.db'), KEEP = { hourly: 48, daily: 30 };
if (process.argv.includes('--verify')) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'tinue-restore-')), f = path.join(t, 'tinue.db');
  try {
    fs.copyFileSync(LATEST, f);
    const m = manifest(f);
    if (m.integrity !== 'ok' || m.missing.length) throw new Error(`integrity ${m.integrity}, missing ${m.missing}`);
    const d = new DatabaseSync(f);
    d.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; CREATE TABLE restore_drill (x); DROP TABLE restore_drill; COMMIT'); d.close();
    console.log(`restore drill: ok, ${m.tables.attempts.n} attempts, last ${new Date(m.lastAttempt).toISOString()}, backup made ${fs.statSync(LATEST).mtime.toISOString()}`);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
} else if (process.argv.includes('--dry-run')) console.log(`[dry-run] copy ${DB} to ${LATEST}; keep ${KEEP.hourly} hourly and ${KEEP.daily} daily`);
else {
  await copyDb(DB, LATEST);
  const at = new Date().toISOString();
  for (const [kind, stamp] of [['hourly', at.slice(0, 13)], ['daily', at.slice(0, 10)]]) {
    const f = path.join(DIR, `${kind}-${stamp}.db`);
    if (!fs.existsSync(f)) fs.linkSync(LATEST, f);
    for (const old of fs.readdirSync(DIR).filter((x) => x.startsWith(kind + '-')).sort().slice(0, -KEEP[kind])) fs.rmSync(path.join(DIR, old));
  }
  // one line for crux, which reads it with the backup and says so if it is not "ok"
  let md = ''; try { md = fs.readFileSync('/proc/mdstat', 'utf8'); } catch {}
  const st = fs.statfsSync(DIR);
  fs.writeFileSync(path.join(DIR, 'health'), ([/\[[U_]*_[U_]*\]/.test(md) && 'a disk mirror is degraded', st.bavail / st.blocks < 0.1 && 'the disk is nearly full'].filter(Boolean).join('; ') || 'ok') + '\n');
  console.log(`backup: ${fs.statSync(LATEST).size} bytes`);
}
