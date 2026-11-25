#!/usr/bin/env node
// DM Shy on Discord (as Nyx's bot) when a new anonymous guest plays tinue. Guests are users without a name (their
// attempts), plus, from clients before 2026-11-15, gids in guest_attempts that never got a users row. Runs on crux every 5 minutes (launchd
// com.shy.tinue-guestwatch). Reads the DB read-only; remembers guests it has announced in data/guest-watch.json.
//   node scripts/guest-watch.mjs            check and DM
//   node scripts/guest-watch.mjs --dry-run  print what it would send
//   node scripts/guest-watch.mjs --seed     mark every current guest as seen, send nothing
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'data', 'guest-watch.json');
const ENV = path.join(os.homedir(), 'Projects/nanoclaw/.env');
const TO = process.env.TINUE_DM_USER; // the Discord user id to write to; only needed once (the DM channel it opens is kept in STATE)
const dry = process.argv.includes('--dry-run'), seed = process.argv.includes('--seed');

const db = new DatabaseSync(process.env.TINUE_DB || path.join(ROOT, 'data', 'tinue.db'), { readOnly: true });
// Before the server has migrated (no users.gid yet), only guest_attempts.
const guestUsers = db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'gid');
const guests = db.prepare(`${guestUsers ? `SELECT COALESCE(u.gid, 'u' || u.id) gid, count(*) n, sum(a.win) wins, min(a.ts) first,
    max(a.ts) last, u.games games, group_concat(a.puzzle_id) ids FROM users u JOIN attempts a ON a.user_id = u.id
    WHERE u.name IS NULL GROUP BY u.id UNION ALL ` : ''}SELECT gid, count(*) n, sum(win) wins, min(ts) first, max(ts) last,
  max(guest_games) games, group_concat(puzzle_id) ids FROM guest_attempts
  ${guestUsers ? 'WHERE gid NOT IN (SELECT gid FROM users WHERE gid IS NOT NULL)' : ''} GROUP BY gid`).all();
let state = { seen: [] };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const seen = new Set(state.seen);
const fresh = guests.filter((g) => !seen.has(g.gid));
const save = () => { state.seen = guests.map((g) => g.gid); fs.writeFileSync(STATE, JSON.stringify(state)); };
if (seed || !fresh.length) { if (seed) save(); console.log(seed ? `seeded ${guests.length}` : 'no new guests'); process.exit(0); }

const size = (id) => { const r = db.prepare('SELECT size FROM puzzles WHERE id = ?').get(id); return r ? `${r.size}×${r.size}` : '?'; };
const today = guests.filter((g) => Date.now() - g.last < 24 * 3600e3).length;
const lines = fresh.map((g) => {
  const sizes = [...new Set(g.ids.split(',').map(size))].join('/');
  return `• ${g.n} puzzle${g.n > 1 ? 's' : ''} (${g.wins} solved) on ${sizes}, started <t:${Math.round(g.first / 1000)}:t>`;
});
const msg = `tinue: ${fresh.length > 1 ? `${fresh.length} new guests` : 'a new guest'} played\n${lines.join('\n')}\n${today} guest${today > 1 ? 's' : ''} active in the last 24h · ${guests.length} all-time`;
if (dry) { console.log(msg); process.exit(0); }

const token = fs.readFileSync(ENV, 'utf8').match(/^DISCORD_BOT_TOKEN=["']?([^"'\n]+)/m)?.[1];
if (!token) throw new Error('no DISCORD_BOT_TOKEN in ' + ENV);
const api = async (p, body) => {
  const r = await fetch('https://discord.com/api/v10' + p, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://tinue.me, 1.0)' } });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return r.json();
};
if (!state.dm && !TO) throw new Error('no DM channel yet: set TINUE_DM_USER');
const dm = state.dm || (state.dm = (await api('/users/@me/channels', { recipient_id: TO })).id);
await api(`/channels/${dm}/messages`, { content: msg, allowed_mentions: { parse: [] } });
save();
console.log('sent', fresh.length);
