// The real server (server/server.js) on a throwaway database, for tests.
//   const { PORT, base, env, boot, stop } = testServer(dir);   dir: the test's temp directory (access.log goes there)
//   const child = await boot(db, { TINUE_JUDGE: 'shadow' });   resolves once it listens; child.out(), child.err() so far, child.ms it took
//   await stop(child);
// One server at a time (one port: TINUE_TEST_PORT, where a sandbox allows only some, else a random one). No TINUE_* of the
// shell's reaches it: every switch is the server's default unless given to boot. One left running is killed on exit.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function testServer(dir, { root = ROOT, quiet = false } = {}) { // root: another checkout's server; quiet: its stderr only in child.err()
  const PORT = +process.env.TINUE_TEST_PORT || 20000 + Math.floor(Math.random() * 20000);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TINUE_'))),
    PORT: String(PORT), TINUE_ACCESS_LOG: path.join(dir, 'access.log'), TINUE_SYNTAKS: '/nonexistent' };
  const children = new Set();
  process.on('exit', () => { for (const c of children) c.kill(); });
  const boot = (db, extra = {}) => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, ['--no-warnings', path.join(root, 'server/server.js')], { env: { ...env, TINUE_DB: db, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '', err = '';
    child.out = () => out; child.err = () => err;
    child.stdout.on('data', (d) => { out += d; if (!child.ms && out.includes('tinue on')) { child.ms = performance.now() - t0; resolve(child); } });
    child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
    child.on('exit', (c) => { children.delete(child); reject(new Error('server exited ' + c + (quiet ? '\n' + err : ''))); });
  });
  const stop = async (child) => {
    if (child.exitCode != null || child.signalCode != null) return;
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await done;
  };
  return { PORT, base: `http://127.0.0.1:${PORT}`, env, boot, stop };
}
