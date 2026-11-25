// Account-saved settings (2026-11-20): one JSON object per account in users.settings (NULL: none saved). The server
// checks shape only, never which settings exist, so the page can add one without a server change. Only the caller's
// own answers carry it (/api/me, /api/login, /api/register, /api/result); never a profile, top list or log line.
import { addColumns } from './schema.js';

export const MAX_KEYS = 24, MAX_STRING = 2000, MAX_BYTES = 6000;
const KEY = /^[a-z][A-Za-z0-9]{0,23}$/;

// The column, on a database from before it: added in a transaction, only when missing; no row is rewritten (NULL).
export const addSettingsColumn = (db) => addColumns(db, 'users', [['settings', 'TEXT']]) > 0;

// The object as stored (a JSON string), or { error } with a sentence for the page. JSON.parse already gave us plain
// data; 1e999 parses to Infinity, hence the finite check. Keys can't reach __proto__ (KEY needs a lowercase first letter).
export function cleanSettings(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return { error: 'Settings must be an object.' };
  const keys = Object.keys(v);
  if (keys.length > MAX_KEYS) return { error: `At most ${MAX_KEYS} settings.` };
  for (const k of keys) {
    if (!KEY.test(k)) return { error: 'Setting names are a lowercase letter then up to 23 letters or digits.' };
    const x = v[k];
    if (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) continue;
    if (typeof x === 'string') { if (x.length > MAX_STRING) return { error: `A setting's text is at most ${MAX_STRING} characters.` }; continue; }
    return { error: 'Each setting must be true or false, a number, or text.' };
  }
  const json = JSON.stringify(v);
  if (Buffer.byteLength(json) > MAX_BYTES) return { error: `Settings are at most ${MAX_BYTES} bytes.` };
  return { json };
}

// POST /api/settings { changes }: these keys over the stored object (the rest kept), so a device that changed one
// setting never puts back another device's newer value for the others. changes is checked alone first (its own
// message), then the merged whole against the limits. Own keys only: JSON.parse gives no inherited ones.
export function mergeSettings(stored, changes) {
  const c = cleanSettings(changes);
  if (c.error) return c;
  return cleanSettings({ ...(readSettings(stored) || {}), ...changes });
}

// A stored value back to the object; a row someone edited into something unreadable reads as none saved.
export function readSettings(s) {
  if (s == null) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}
