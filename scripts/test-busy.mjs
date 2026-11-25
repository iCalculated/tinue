// The input lock (public/busy.js) and its use in app.js: each guard's duration, the same answer as the guard it
// replaced for every (now, since), and every call site.   node scripts/test-busy.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUSY_MS, busy, busyUntil, endLocked, barHide } from '../public/busy.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const app = fs.readFileSync(root + 'public/app.js', 'utf8');

test('each lock\'s duration', () => {
  assert.deepEqual({ ...BUSY_MS }, { board: 700, actions: 1000, next: 600, giveup: 1500, ended: 1000, confirm: 600 });
  assert.ok(Object.isFrozen(BUSY_MS));
  for (const [cls, ms] of Object.entries(BUSY_MS)) {
    for (const since of [0, 1000, 12345.678, 9.87654321e6]) {
      assert.equal(busy(cls, since, since), true, `${cls} at its start`);
      assert.equal(busy(cls, since, since + ms - 0.01), true, `${cls} just before ${ms} ms`);
      assert.equal(busy(cls, since, since + ms), false, `${cls} at ${ms} ms`);
      assert.equal(busy(cls, since, since + ms + 0.01), false, `${cls} after`);
      assert.equal(busyUntil(cls, since), since + ms);
    }
    assert.equal(busy(cls, undefined, 5), false, `${cls}: no start (NaN) is not busy, as before`);
  }
  // the default clock is performance.now()
  assert.equal(busy('giveup', performance.now()), true);
  assert.equal(busy('giveup', performance.now() - 2000), false);
});

test('the same answer as each guard it replaced (8e3eaab), boundaries and random values included', () => {
  const old = {
    tooSoon: (now, born) => now - (born ?? 0) < 700, // (500 in 8e3eaab; input-guard raised it to 700)
    fresh: (now, t0) => t0 == null || now - t0 < 1000,
    justViewed: (now, viewT0) => viewT0 != null && now - viewT0 < 600,
    giveupClick: (now, t0) => now - (t0 ?? 0) < 1500,
    giveupRender: (now, t0) => now - t0 < 1500,
  };
  const neu = {
    tooSoon: (now, born) => busy('board', born ?? 0, now),
    fresh: (now, t0) => t0 == null || busy('actions', t0, now),
    justViewed: (now, viewT0) => viewT0 != null && busy('next', viewT0, now),
    giveupClick: (now, t0) => busy('giveup', t0 ?? 0, now),
    giveupRender: (now, t0) => busy('giveup', t0, now),
  };
  let seed = 11, cases = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sinces = [undefined, null, 0, 0.1, 499.9, 1e3, 123456.789];
  for (let i = 0; i < 2000; i++) sinces.push(rnd() * 1e7);
  for (const since of sinces) {
    const s = since ?? 0, nows = [s, s + 0.1, s + 499.99, s + 500, s + 599.99, s + 600, s + 999.99, s + 1000, s + 1499.99, s + 1500, s + 1e4, s + rnd() * 2000];
    for (const now of nows) for (const k of Object.keys(old)) { assert.equal(neu[k](now, since), old[k](now, since), `${k} now=${now} since=${since}`); cases++; }
  }
  assert.ok(cases > 100000);
  // where now - since < ms and now < since + ms disagree (float rounding): the lock must answer as the old guards did
  for (const [since, now] of [[8388352.220789452, 8388852.220789451], [2096786.3872128346, 2097286.3872128343]]) {
    assert.notEqual(now - since < 500, now < since + 500); // (a real rounding case)
    assert.equal(busy('next', since, now + 100), now + 100 - since < 600);
  }
});

test('the result lock (ended): Next, Enter and Reload wait 1000 ms from the result first drawn, then let go by themselves', () => {
  for (const t of [0, 5000.5, 123456.789]) {
    assert.equal(endLocked(t, t), true);
    assert.equal(endLocked(t, t + 999.99), true);
    assert.equal(endLocked(t, t + 1000), false);
    assert.equal(endLocked(t, t + 60e3), false, 'never held for good');
  }
  assert.equal(endLocked(null, 1e9), true, 'solved but not drawn yet: locked');
  assert.equal(endLocked(undefined, 1e9), true);
  // the board lock: a tap 600 ms after the switch (one that follows a tap on Next by accident) is dropped; 700 is not
  assert.equal(busy('board', 1000, 1600), true);
  assert.equal(busy('board', 1000, 1700), false);
  assert.ok(BUSY_MS.board > 650, 'outlasts the intro (start: 650 ms), so a puzzle without one is no quicker to take a move');
});

test('app.js: every guard goes through the lock; none of the old constants or literals is left', () => {
  assert.match(app, /^import \{ BUSY_MS, busy, busyUntil, endLocked, barHide \} from '\.\/busy\.js';$/m);
  for (const gone of ['TOO_SOON_MS', 'FRESH_MS', '< 600', '< 1500', '< 500', '< 1000', ', 1600)', 'FRESH_MS + 30'])
    assert.ok(!app.includes(gone), `app.js still has ${gone}`);
  const count = (s) => app.split(s).length - 1;
  assert.equal(count("const tooSoon = (s) => busy('board', s.born ?? 0);"), 1);
  assert.equal(count("const fresh = (s) => s.t0 == null || busy('actions', s.t0);"), 1);
  assert.equal(count("const justViewed = () => S?.viewT0 != null && busy('next', S.viewT0);"), 1);
  assert.equal(count("busy('giveup', po.t0) ? ' disabled' : ''"), 1); // the Give up button, one for the proven and unproven cards (acts)
  assert.equal(count("if (busy('giveup', S.playOn?.t0 ?? 0)) return; return endPlayOn(S, 'gaveup');"), 1);
  assert.equal(count('BUSY_MS.actions + 30'), 1); // Hint and Solution redrawn enabled at 1030 ms
  assert.equal(count('BUSY_MS.giveup + 100'), 1); // Give up redrawn enabled at 1600 ms
  assert.equal(count("busy('"), 5);
  // where each guard is consulted (unchanged): moves, Hint/Solution, Next (card and dock, not Enter), Give up
  assert.equal(count('if (tooSoon(S))'), 1);
  assert.equal(count("(act === 'hint' || act === 'solution') && (fresh(S) || !board.available)"), 1); // (and never without the board: PTN Ninja loading or down)
  assert.equal(count('fresh(S) || !board.available ? \' disabled\''), 1);
  // the solve clock: paused while the board is loading or down (PTN Ninja's message in its place), resumed when it's back
  assert.equal(count("const offScreen = () => document.hidden || $('#view-puzzle').classList.contains('hidden') || !board.available;"), 1);
  assert.equal(count("onState: () => { syncClock(); "), 1);
  assert.equal(count("s.hiddenAt = offScreen() ? s.t0 : null;"), 1); // (a puzzle started with the board down starts paused)
  assert.equal(count('if (justViewed()) return;'), 0);
  assert.equal(count('if (justViewed() || justEnded()) return;'), 2); // Next: the card's and the dock's
  assert.equal(count("const justEnded = () => S?.status === 'solved' && !S.placeholder && endLocked(S.endT0);"), 1);
  assert.equal(count("if (S.status === 'solved' && S.endT0 == null && !loading) S.endT0 = performance.now();"), 1);
  assert.equal(count('if (!e.repeat && !justEnded()) loadNext();'), 1); // Enter
  assert.equal(count('if (justEnded()) return;'), 1); // the update bar's Reload
  assert.equal(count('loadNext('), 10, 'a new way to the next puzzle needs the result lock too');
  assert.equal(count('board.forget();'), 1); // start(): nothing in hand carries over
  assert.equal(count("board.lock(busyUntil('board', s.born));"), 1); // start(): the board itself takes nothing meanwhile
  assert.equal(count('renderBuildBar(true)'), 1); // start(): the update bar may appear with a new puzzle, not later in it
});

test('the update bar never newly appears over an untouched puzzle once it started (it would push the board down)', () => {
  const s = (o = {}) => ({ status: 'play', moves: [], misses: [], ...o });
  const hide = (o) => barHide({ newBuild: 7, dismissed: false, s: s(), shown: false, fresh: false, ...o });
  assert.equal(hide({}), true, 'the version check answered after the board was playable');
  assert.equal(hide({ fresh: true }), false, 'as the puzzle starts (start())');
  assert.equal(hide({ shown: true }), false, 'up already: it stays');
  assert.equal(hide({ s: s({ moves: ['a1'] }), shown: true }), true, 'a move made');
  assert.equal(hide({ s: s({ status: 'retry', misses: [1] }), shown: true }), true);
  assert.equal(hide({ s: s({ status: 'playon' }), fresh: true }), true);
  assert.equal(hide({ s: s({ status: 'solved' }) }), false, 'at the result');
  assert.equal(hide({ s: null }), false, 'before any puzzle');
  assert.equal(hide({ s: { placeholder: true } }), false);
  assert.equal(hide({ newBuild: 0, fresh: true }), true);
  assert.equal(hide({ dismissed: true, fresh: true }), true);
});

console.log(`all ${n} passed`);
