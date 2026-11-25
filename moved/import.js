// Inlined first in index.html's head when the page is built for its own domain (scripts/build-static.sh, DOMAIN set).
// The other half is handoff.html, on the old address. Rounds (every hop a location.replace):
//   old page  -> here #hs=1&to=<route>                 "you have not been here yet"
//   here      -> old page #hn=<public key>&to=<route>  a one-use key pair made in this tab, its private half kept here
//   old page  -> here #hd=<the payload encrypted for that key>&to=<route>
// Encrypted because a browser keeps every address in its history (and may sync it), replaced or not, and the payload
// holds the player's token. The key is also the nonce: only the old page was told it, it is used once, within two
// minutes, so a link made by someone else can neither sign a visitor in nor replace a player. The payload is off the
// address before anything else runs. app.js waits for window.TINUE_WAIT (true: the page is being left or reloaded).
(function () {
  var OLD = '__OLD__', LS, SS;
  try { LS = localStorage; SS = sessionStorage; } catch (e) { return; }
  var ROUTE = /^#\/(?:puzzle\/[A-Za-z0-9_.-]{1,64}(?:\/[0-7])?|me|leaderboard|rush|settings)?$/;
  var get = function (k) { try { return JSON.parse(LS.getItem('tinue.' + k)); } catch (e) { return null; } };
  var set = function (k, v) { try { LS.setItem('tinue.' + k, JSON.stringify(v)); } catch (e) {} };
  var del = function (k) { try { LS.removeItem('tinue.' + k); } catch (e) {} };
  var isToken = function (t) { return typeof t === 'string' && /^[a-f0-9]{48}$/.test(t); }, isGid = function (g) { return typeof g === 'string' && /^[a-f0-9]{32}$/.test(g); };
  var isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
  var ownerOf = function (t) { var h = 0x811c9dc5, i; if (!t) return ''; for (i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36); }; // (outbox.js)
  var EC = { name: 'ECDH', namedCurve: 'P-256' }, AES = { name: 'AES-GCM', iv: new Uint8Array(12) }; // (a fresh key per message: the iv needn't vary)
  var b64 = function (buf) { var s = '', u = new Uint8Array(buf), i; for (i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var un64 = function (t) { var s = atob(t.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(s.length), i; for (i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  // To the old page for this browser's player there. force: although it was brought before. → whether it leaves.
  async function go(to, force) {
    if (window.top !== window.self) return false;
    try {
      var pair = await crypto.subtle.generateKey(EC, true, ['deriveKey']);
      var s = JSON.stringify({ k: await crypto.subtle.exportKey('jwk', pair.privateKey), t: Date.now() }), pub = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
      SS.setItem('tinue.hs', s);
      if (SS.getItem('tinue.hs') !== s) return false;
      location.replace(OLD + '#hn=' + pub + (force ? '&f=1' : '') + '&to=' + encodeURIComponent(to));
      return true;
    } catch (e) { return false; }
  }
  window.tinueBring = function () { return go('#/', true); };
  async function open(s, d) {
    var u = un64(d), priv = await crypto.subtle.importKey('jwk', s.k, EC, false, ['deriveKey']), eph = await crypto.subtle.importKey('raw', u.slice(0, 65), EC, false, []);
    var key = await crypto.subtle.deriveKey({ name: 'ECDH', public: eph }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(AES, key, u.slice(65))), function (k, v) { return k === '__proto__' ? undefined : v; });
  }
  // A player's settings and identity into this browser. What was played here without a token becomes theirs.
  var OBJ = ['prefs', 'setUnsent', 'rush', 'rushBest', 'me'], ARR = ['ninjaTransform', 'rushHistory'];
  function install(p) {
    ['myRating', 'myProv', 'next', 'queue', 'me'].forEach(del);
    if (isToken(p.token)) { set('token', p.token); del('guest'); del('seen'); } else { if (isObj(p.guest)) set('guest', p.guest); if (Array.isArray(p.seen)) set('seen', p.seen); }
    if (isGid(p.gid)) set('gid', p.gid); else del('gid'); // (a token and its gid are one)
    OBJ.forEach(function (k) { if (isObj(p[k])) set(k, p[k]); });
    ARR.forEach(function (k) { if (Array.isArray(p[k])) set(k, p[k]); });
    if (!isToken(p.token)) return;
    var o = ownerOf(p.token), keys = [], i, q = get('rushQueue');
    for (i = 0; i < LS.length; i++) if (/^tinue\.r\.\./.test(LS.key(i))) keys.push(LS.key(i));
    keys.forEach(function (k) { try { var e = JSON.parse(LS.getItem(k)); e.owner = o; addResult(e); LS.removeItem(k); } catch (x) {} });
    if (Array.isArray(q)) set('rushQueue', q.map(function (x) { if (isObj(x) && x.who === null) x.who = o; return x; }));
  }
  window.tinueInstall = install;
  function addResult(e) { // (results.js checks an entry again when it reads it)
    if (!isObj(e) || !isObj(e.body) || typeof e.puzzleId !== 'string' || !/^[\w.-]{1,64}$/.test(e.puzzleId) || typeof e.owner !== 'string' || !/^[a-z0-9]{0,12}$/.test(e.owner)) return;
    var k = 'tinue.r.' + e.owner + '.' + e.puzzleId;
    try { if (LS.getItem(k) == null) LS.setItem(k, JSON.stringify(e)); } catch (x) {}
  }
  // → whether the identity here changed (the page is loaded again with it).
  function take(p) {
    if (!isObj(p) || p.v !== 1) return false;
    var cur = get('token'), y = isToken(p.token) ? p.token : null, q, seen = {};
    // what was never sent, whoever is signed in here: it goes out only as the player who played it
    if (Array.isArray(p.results)) p.results.slice(0, 50).forEach(addResult);
    if (Array.isArray(p.rushQueue)) {
      q = get('rushQueue'); q = (Array.isArray(q) ? q : []).filter(isObj);
      q.forEach(function (x) { if (isObj(x.body)) seen['r' + x.body.run] = 1; });
      p.rushQueue.slice(0, 20).forEach(function (x) { if (isObj(x) && isObj(x.body) && typeof x.body.run === 'string' && !seen['r' + x.body.run]) { seen['r' + x.body.run] = 1; q.push(x); } });
      if (q.length) set('rushQueue', q);
    }
    if (p.moved || (y && y === cur)) return false; // brought before (signed out here since: stays signed out), or the same player
    if (y && cur) { try { SS.setItem('tinue.hp', JSON.stringify(p)); } catch (e) {} return false; } // two players: app.js asks
    if (!y && (cur || get('gid'))) return false;
    install(p);
    return true;
  }
  var h = location.hash;
  if (!/^#h[sdn]=/.test(h)) return;
  var part = function (k) { var m = new RegExp('[#&]' + k + '=([^&]*)').exec(h); return m ? m[1] : ''; }, to = '#/';
  try { to = decodeURIComponent(part('to')); } catch (e) {}
  if (!ROUTE.test(to)) to = '#/';
  history.replaceState(null, '', location.pathname + to);
  if (part('hs') === '1') { window.TINUE_WAIT = go(to); return; }
  var s = null, d = part('hd');
  try { s = JSON.parse(SS.getItem('tinue.hs')); SS.removeItem('tinue.hs'); } catch (e) {}
  if (!d || !s || !(Date.now() - s.t >= 0 && Date.now() - s.t < 120e3)) return;
  window.TINUE_WAIT = open(s, d).then(take).then(function (again) { if (again) location.reload(); return again; }, function () { return false; });
})();
