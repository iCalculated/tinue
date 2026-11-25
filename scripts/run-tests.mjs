// npm test: every scripts/test-*.mjs in turn (some listen on a port, so never two at once), stopping at the first failure.
// A test still running after 10 minutes is killed and failed.
//   node scripts/run-tests.mjs [--all] [name ...]
//   --all   run on past a failure; every failure is listed at the end either way
//   name    only the tests whose file name contains one of these
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = { 'test-next-model.mjs': ['4', '3000'] };
const argv = process.argv.slice(2), all = argv.includes('--all'), names = argv.filter((a) => a !== '--all');
const bad = names.filter((a) => a.startsWith('--'));
if (bad.length) { console.error(`run-tests: unknown option ${bad.join(' ')}`); process.exit(2); }
const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f) && (!names.length || names.some((n) => f.includes(n)))).sort();
if (!files.length) { console.error(`run-tests: no test matches ${names.join(' ')}`); process.exit(2); }
const t0 = Date.now(), failed = [];
let ran = 0;
for (const f of files) {
  ran++;
  console.log(`\n== ${f}`);
  const r = spawnSync(process.execPath, ['--no-warnings', path.join('scripts', f), ...(ARGS[f] || [])], { cwd: ROOT, stdio: 'inherit', timeout: 600e3, killSignal: 'SIGKILL' });
  if (r.status === 0) continue;
  failed.push(`${f} (${r.error?.code || r.signal || 'exit ' + r.status})`);
  if (r.signal === 'SIGINT' || r.signal === 'SIGTERM' || !all) break;
}
const secs = Math.round((Date.now() - t0) / 1000);
if (failed.length) { console.error(`\nFAILED: ${failed.join(', ')}; ${ran - failed.length} of ${files.length} test files passed, ${files.length - ran} not run, ${secs} s`); process.exit(1); }
console.log(`\nall ${files.length} test files passed, ${secs} s`);
