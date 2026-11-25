// Settings saved to the account (public/prefsync.js): what a device takes from the account and what it sends, and how
// app.js wires it. A setting no page has any more (the beta's old Engine arrows; the Board setting, 2026-11-22: PTN
// Ninja is the only board) passes through untouched.
//   node scripts/test-prefsync.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYNCED, DEFAULTS, OTHER, syncedOf, decide, diff, changesBody, carried, unsentKeys, withUnsent, afterPost, syncStatus } from '../public/prefsync.js';
import { encodeLook, parseLook } from '../public/ninja-look.js';
import { cleanSettings, mergeSettings } from '../server/settings.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };
const root = new URL('..', import.meta.url).pathname;
const app = fs.readFileSync(root + 'public/app.js', 'utf8');
const LOOK = encodeLook(parseLook('&axisLabels=false&theme=zen').look);

test('the synced settings out of prefs: the page\'s own readers, defaults for anything missing or junk', () => {
  assert.deepEqual(SYNCED, ['confirm', 'sound', 'ninja']);
  assert.deepEqual(OTHER, ['arrows', 'board']);
  assert.deepEqual(syncedOf({}), DEFAULTS);
  assert.deepEqual(syncedOf(null), DEFAULTS);
  assert.deepEqual(syncedOf([]), DEFAULTS);
  assert.deepEqual(syncedOf({ size: '6', difficulty: 'hardest', theme: 'road', v2: true }), DEFAULTS, 'the filters are not settings');
  assert.deepEqual(syncedOf({ board: 'ninja', confirm: true, ninja: LOOK }), { confirm: true, sound: 'thunk', ninja: LOOK });
  assert.deepEqual(syncedOf({ board: 'tinue', confirm: true, arrows: false, sound: 'off', ninja: LOOK }), { confirm: true, sound: 'off', ninja: LOOK }, 'Engine arrows and the old Board setting are not read');
  assert.equal(syncedOf({ sound: 'deep' }).sound, 'deep');
  assert.equal(syncedOf({ sound: true }).sound, 'thunk', 'a value from before the voices: the default voice');
  // a server answer is cleaned exactly as storage is: junk of every kind reads as the default
  assert.deepEqual(syncedOf({ board: 'Ninja', confirm: 'true', sound: 'loud', ninja: '<script>' }), DEFAULTS);
  assert.deepEqual(syncedOf({ board: 1, confirm: 1, ninja: 7 }), DEFAULTS);
  assert.equal(syncedOf({ ninja: '&axisLabels=junk&theme=zen' }).ninja, encodeLook({ theme: 'zen' }), 'a look: what is usable of it');
  assert.deepEqual(SYNCED, Object.keys(DEFAULTS));
});

const dev = (o = {}) => ({ ...DEFAULTS, ...o });
test('an unsent change here wins for its own keys; every other key takes the account\'s value', () => {
  const device = dev({ confirm: true });
  assert.deepEqual(decide({ device, dirty: ['confirm'], server: { confirm: false, sound: 'deep', board: 'ninja' } }), { apply: { sound: 'deep' }, post: ['confirm'], first: false });
  assert.deepEqual(decide({ device, dirty: ['confirm'], server: {} }), { apply: {}, post: ['confirm'], first: false });
  // the old Board setting, on the account or marked unsent by an older page: never applied, never sent
  for (const board of ['tinue', 'ninja']) assert.deepEqual(decide({ device: dev(), dirty: ['board'], server: { board } }), { apply: {}, post: [], first: false });
  // only this site's settings are ever unsent here
  assert.deepEqual(decide({ device, dirty: ['size', 'confirm', 'arrows', 'toString'], server: { confirm: false } }).post, ['confirm']);
  assert.deepEqual(decide({ device: dev({ sound: 'off' }), dirty: ['sound'], server: { sound: 'deep' } }), { apply: {}, post: ['sound'], first: false });
});

test('nothing unsent: the account\'s settings win; only what differs is applied, never a setting this site lacks', () => {
  assert.deepEqual(decide({ device: dev(), dirty: [], server: { board: 'tinue', confirm: false, arrows: false, sound: 'deep', ninja: LOOK } }),
    { apply: { sound: 'deep', ninja: LOOK }, post: [], first: false });
  assert.deepEqual(decide({ device: dev({ confirm: true }), server: { board: 'tinue', confirm: true, sound: 'thunk', arrows: false, ninja: '' } }),
    { apply: {}, post: [], first: false }, 'the same: nothing');
  // a key the account lacks is its default
  assert.deepEqual(decide({ device: dev({ confirm: true }), dirty: [], server: { sound: 'thunk' } }), { apply: { confirm: false }, post: [], first: false });
  // junk from the server is never applied as junk
  assert.deepEqual(decide({ device: dev({ confirm: true }), dirty: [], server: { confirm: 'yes', board: '<b>', ninja: 'javascript:alert(1)' } }),
    { apply: { confirm: false }, post: [], first: false });
});

test('an account with nothing stored gets this device\'s settings once, only if any differs from the defaults', () => {
  assert.deepEqual(decide({ device: dev(), dirty: [], server: null }), { apply: {}, post: [], first: true });
  assert.deepEqual(decide({ device: dev({ confirm: true }), dirty: [], server: null }), { apply: {}, post: SYNCED, first: true });
  assert.deepEqual(decide({ device: dev(), dirty: ['confirm'], server: null }), { apply: {}, post: SYNCED, first: true }, 'a change back to the default, unsent');
  for (const server of [undefined, 'x', 7, []]) assert.deepEqual(decide({ device: dev({ confirm: true }), dirty: [], server }).apply, {}, String(server));
});

test('the post: only the keys changed here, which the server lays over the account\'s; the beta\'s settings on it are kept', () => {
  const device = dev({ ninja: LOOK });
  assert.deepEqual(changesBody({ ...device, board: 'ninja' }, ['ninja', 'board']), { changes: { ninja: LOOK } }, 'the old Board setting is never posted');
  assert.deepEqual(changesBody(device, ['size', 'constructor', 'arrows']), { changes: {} });
  assert.deepEqual(changesBody(dev({ sound: 'deep' }), ['sound']), { changes: { sound: 'deep' } });
  // the account holds the beta's old Engine arrows; this site changes Confirm moves: the others stay as they were
  const onServer = JSON.stringify({ board: 'tinue', sound: 'thunk', arrows: false, later: true });
  const merged = mergeSettings(onServer, changesBody(dev({ confirm: true }), ['confirm']).changes);
  assert.deepEqual(JSON.parse(merged.json), { board: 'tinue', sound: 'thunk', arrows: false, later: true, confirm: true });
  // and the answer applies nothing of them here
  assert.deepEqual(decide({ device: dev({ confirm: true }), dirty: [], server: JSON.parse(merged.json) }).apply, {});
  // every body the page can send passes the server's checks, a long custom theme included
  const big = dev({ ninja: encodeLook(parseLook('&theme=' + encodeURIComponent(JSON.stringify({ colors: { primary: '#111111', secondary: '#222222', ui: '#333333', player1: '#444444', player2: '#555555' } }))).look) });
  for (const b of [changesBody(device, SYNCED), changesBody(big, SYNCED), changesBody(dev(), [])]) assert.ok(cleanSettings(b.changes).json, JSON.stringify(b));
  assert.deepEqual(diff(dev(), dev({ confirm: true, ninja: LOOK })), ['confirm', 'ninja']);
});

test('the first post to an empty account carries the settings no page has (Engine arrows, Board) as this browser stores them, nothing else', () => {
  assert.deepEqual(carried({ arrows: false, sound: 'deep', size: '6', board: 'ninja' }), { arrows: false, board: 'ninja' });
  assert.deepEqual(carried({}), {});
  assert.deepEqual(carried(null), {});
  assert.deepEqual(carried({ arrows: true }), { arrows: true }, 'as stored');
  for (const junk of [{ arrows: { a: 1 } }, { arrows: 7 }, { arrows: null }, { arrows: 'x'.repeat(41) }]) assert.deepEqual(carried(junk), {}, JSON.stringify(junk));
  const first = { changes: { ...carried({ arrows: false, sound: 'off' }), ...changesBody(dev({ confirm: true }), SYNCED).changes } };
  assert.deepEqual(first, { changes: { arrows: false, confirm: true, sound: 'thunk', ninja: '' } });
  assert.ok(cleanSettings(first.changes).json);
});

test('the unsent mark: this account\'s keys only; another page\'s unsent keys are kept in it; after a post, what changed again stays unsent', () => {
  assert.deepEqual(unsentKeys({ o: 'abc', k: ['arrows', 'board', 'size', 'sound'] }, 'abc'), ['sound']);
  for (const [mark, o] of [[{ o: 'abc', k: ['confirm'] }, 'xyz'], [{ o: 'abc', k: ['confirm'] }, ''], ['abc', 'abc'], [null, 'abc'], [{ o: 'abc', k: 'confirm' }, 'abc'], [[], 'abc']])
    assert.deepEqual(unsentKeys(mark, o), [], JSON.stringify(mark));
  // another page's unsent key (an old beta's Engine arrows) stays in the mark whatever this page sets of its own
  assert.deepEqual(withUnsent({ o: 'abc', k: ['arrows', 'sound'] }, 'abc', []), { o: 'abc', k: ['arrows'] });
  assert.deepEqual(withUnsent({ o: 'abc', k: ['arrows'] }, 'abc', ['confirm', 'sound']), { o: 'abc', k: ['confirm', 'sound', 'arrows'] });
  assert.deepEqual(withUnsent({ o: 'abc', k: ['sound'] }, 'abc', []), null, 'nothing left: no mark');
  assert.deepEqual(withUnsent({ o: 'xyz', k: ['arrows'] }, 'abc', ['sound']), { o: 'abc', k: ['sound'] }, 'another account\'s mark is not carried over');
  assert.deepEqual(withUnsent({ o: 'abc', k: ['arrows', '__proto__', 7, 'Arrows', 'arrows'] }, 'abc', []), { o: 'abc', k: ['arrows'] });
  assert.deepEqual(withUnsent(null, '', ['sound']), null, 'no account: no mark');
  const sent = { confirm: true, sound: 'deep' };
  assert.deepEqual(afterPost(['confirm', 'sound'], sent, dev({ confirm: true, sound: 'deep' })), []);
  assert.deepEqual(afterPost(['confirm', 'sound', 'ninja'], sent, dev({ confirm: false, sound: 'deep' })), ['confirm', 'ninja']);
});

test('the status line, in plain words', () => {
  assert.equal(syncStatus({ blocked: true, named: true, state: 'saved' }), "Settings can't be saved in this browser.");
  assert.equal(syncStatus({ blocked: false, named: false, state: 'saved' }), 'Saved on this device. Claim a username or sign in to keep them on every device.');
  assert.equal(syncStatus({ blocked: false, named: true, state: 'saved' }), 'Saved to your account.');
  assert.equal(syncStatus({ blocked: false, named: true, state: 'unsent' }), 'Could not save to your account. tinue will try again.');
  assert.equal(syncStatus({ blocked: false, named: true, state: 'saving' }), 'Saving to your account…');
});

test('app.js: one writer, on the Settings page only; the account\'s settings arrive with /api/me, a sign-in and a name claimed', () => {
  // every select on the Settings page goes through setSetting; no other code writes those prefs, and the puzzle page has none
  assert.doesNotMatch(app, /#set-|'set-' \+/, 'no puzzle-page copy of a setting');
  assert.match(app, /s\.onchange = \(e\) => \{ if \(focusedByPointer\(e\.target\)\) e\.target\.blur\(\); setSetting\(k, CTL\[k\]\.read\(e\.target\.value\)\); \};/);
  assert.match(app, /for \(const \[v, t\] of CTL\[k\]\.opts\) s\.append\(new Option\(t, v\)\);/, 'each select\'s options, from CTL');
  assert.doesNotMatch(app.replace('if (c) prefs.ninja = c; else delete prefs.ninja;', ''), /prefs\.(board|confirm|ninja) = /, 'only setSetting writes a setting (and the boot\'s cleaning of the look)');
  // a setting no page has (Engine arrows): never written or posted here, only taken from another tab as it is
  assert.doesNotMatch(app, /prefs\.(sound|arrows) = |prefs\.arrows|arrowsOn/);
  assert.match(app, /for \(const k of OTHER\) if \(stored && Object\.hasOwn\(stored, k\)\) prefs\[k\] = stored\[k\]; else delete prefs\[k\];/);
  // only a change made here is posted; only a named account syncs
  assert.match(app, /if \(from === 'here'\) pushSettings\(\);/);
  assert.match(app, /const named = \(\) => !!\(token && me\?\.name\);/);
  assert.match(app, /async function pushSettings\(keys = \[\], first = false\) \{\n {2}if \(!named\(\)\) return;/);
  assert.match(app, /api\('\/api\/settings', body, /, 'a post sends changes only (changesBody)');
  assert.match(app, /body = changesBody\(deviceNow\(\), dirty\)/);
  assert.match(app, /if \(first\) body\.changes = \{ \.\.\.carried\(prefsNow\(\)\), \.\.\.body\.changes \};/, 'the beta\'s settings only in a first post, under this site\'s');
  assert.match(app, /function settingsArrived\(r\) \{\n {2}if \(!r \|\| typeof r !== 'object' \|\| !\('settings' in r\) \|\| !named\(\)\) return;/);
  for (const re of [/me = r\.user; renderUser\(\); settingsArrived\(r\); if \(S\) renderAll\(\);/, /me = r\.user; renderUser\(\); settingsArrived\(r\); refreshPage\(\);/,
    /serverSettings = null; renderUser\(\); settingsArrived\(r\); refreshPage\(\);/, /me = fresh\.user; renderUser\(\); settingsArrived\(fresh\);/])
    assert.match(app, re);
  assert.equal((app.match(/settingsArrived\(/g) || []).length, 5, 'boot, History, claim, token sign-in, and the function itself');
  // signing out keeps this device's settings (nothing is reset)
  const out = app.slice(app.indexOf("$('#logout-yes').onclick"), app.indexOf('renderUser(); refreshPage(); };', app.indexOf("$('#logout-yes').onclick")));
  assert.doesNotMatch(out, /prefs|setSetting/);
  // the unsent mark belongs to one account (a hash of its token, never the token), and keeps another page's keys
  assert.match(app, /const unsent = \(\) => unsentKeys\(store\.get\('setUnsent', null\), owner\(\)\);/);
  assert.match(app, /const mark = withUnsent\(store\.get\('setUnsent', null\), owner\(\), /);
  // a change here is marked unsent at once; no setting reloads the page any more (there is no Board setting)
  const ss = app.slice(app.indexOf('function setSetting('), app.indexOf('// ---- settings saved to the account'));
  assert.ok(ss.indexOf("if (from === 'here') markUnsent([key]);") > 0);
  assert.doesNotMatch(ss, /reloadInto|'board'/);
  // another tab's change is taken here, never stored again or posted by this tab
  assert.match(app, /window\.addEventListener\('storage', \(e\) => \{\n {2}if \(e\.key !== 'tinue\.prefs'\) return;/);
  assert.match(ss, /if \(from !== 'tab'\) \{\n {4}store\.set\('prefs', prefs\);/);
  assert.match(app, /for \(const k of Object\.keys\(d\.apply\)\) setSetting\(k, d\.apply\[k\], 'account'\);/);
});

test('the Settings page: reached from the account menu, the claim popover and the puzzle page; never as HTML from a paste', () => {
  const html = fs.readFileSync(root + 'public/index.html', 'utf8');
  assert.match(html, /<p class="set-link"><a href="#\/settings">Settings<\/a><\/p>/);
  assert.match(html, /<main id="view-settings" class="page settings-page hidden"><\/main>/);
  assert.match(app, /<a href="#\/me" role="menuitem">History<\/a><a href="#\/settings" role="menuitem">Settings<\/a>/);
  assert.match(app, /<a href="#\/settings" class="link" id="settings-open">Settings<\/a>/);
  assert.match(app, /if \(page === 'settings'\) return settingsPage\(\);/);
  // the look's report and value are only ever text
  const page = app.slice(app.indexOf('function settingsPage()'), app.indexOf('// Stepping in half-moves'));
  assert.doesNotMatch(page.replace(/el\.innerHTML = `[\s\S]*?`;/, ''), /innerHTML/);
  assert.match(page, /msg\.textContent = lookReport\(res\)/);
  // the page's rows: the board's theme and look, Confirm moves, Sound (no Board: PTN Ninja is the only board, 2026-11-22;
  // Engine arrows is no setting: Sasha, 2026-11-21)
  const rows = [...page.matchAll(/sel\('([a-z]+)'|<label for="st-([a-z-]+)">/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(rows.filter((r) => r !== 'k'), ['ninja-theme', 'ninja', 'confirm', 'sound']);
  assert.match(page, /<label for="st-ninja-theme">Board theme<\/label>/); assert.match(page, /<label for="st-ninja">Board look<\/label>/);
  assert.doesNotMatch(page, /PTN Ninja theme|PTN Ninja look|tinue’s own|sel\('board'/);
  assert.doesNotMatch(page, /arrows/i);
});

console.log(`all ${n} passed`);
