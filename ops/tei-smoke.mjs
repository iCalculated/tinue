// Does this Syntaks binary do what server/syntaks.js asks of it? It must offer the options and answer two searches
// (one line, then three) on 6x6 with the same commands the server sends.   node ops/tei-smoke.mjs BINARY
import { spawn } from 'node:child_process';

const bin = process.argv[2];
const OPTIONS = ['Threads', 'Hash', 'MateScores', 'HumanWDL', 'HalfKomi', 'MultiPV'];
const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const fail = (m) => { console.error('tei-smoke: ' + m); p.kill('SIGKILL'); process.exit(1); };
const timer = setTimeout(() => fail('no answer in 30 s'), 30e3);
let buf = '', lines = [], wake = () => {};
p.on('error', (e) => fail(e.message));
p.on('exit', (c, s) => fail(`exited (${s || c})`));
p.stdin.on('error', () => {});
p.stdout.setEncoding('utf8').on('data', (d) => { buf += d; const a = buf.split('\n'); buf = a.pop(); lines.push(...a.map((x) => x.trim())); wake(); });
const send = (s) => p.stdin.write(s + '\n');
async function until(re) { // the lines up to the one that matches
  for (;;) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return lines.splice(0, i + 1);
    await new Promise((r) => (wake = r));
  }
}
send('tei');
const hello = await until(/^teiok/);
const missing = OPTIONS.filter((o) => !hello.some((l) => new RegExp(`^option name ${o}\\b`, 'i').test(l)));
if (missing.length) fail('no option ' + missing.join(', ') + '; it said:\n' + hello.join('\n'));
send('setoption name Threads value 1\nsetoption name Hash value 64\nsetoption name MateScores value true\nsetoption name HumanWDL value true\nsetoption name HalfKomi value 4\nteinewgame 6');
for (const n of [1, 3]) {
  if (n > 1) send('setoption name MultiPV value ' + n);
  send('position tps x6/x6/x6/x6/x6/1,x4,2 1 2\ngo movetime 800');
  const out = await until(/^bestmove/), info = out.filter((l) => l.startsWith('info ') && / score /.test(l) && / pv /.test(l));
  if (!/^bestmove \S+/.test(out.at(-1)) || !info.length) fail('no usable search:\n' + out.slice(-5).join('\n'));
  if (n > 1 && !info.some((l) => / multipv 3 /.test(l))) fail('MultiPV 3 gave no third line');
  if (!info.some((l) => / wdl \d+ \d+ \d+/.test(l))) fail('no wdl in ' + info.at(-1));
  console.log(`tei-smoke: lines ${n}: ${out.at(-1)}; ${info.at(-1).slice(0, 120)}`);
}
clearTimeout(timer);
p.removeAllListeners('exit'); send('quit'); setTimeout(() => { p.kill('SIGKILL'); process.exit(0); }, 500);
