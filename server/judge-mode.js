// TINUE_JUDGE, parsed once for every reader (server/move.js, server/shadow.js). PLAN §3.1 "Switches".
//   off (default) | shadow | veto | decide. Surrounding blanks are trimmed and case is ignored (' Shadow' is shadow).
//   Unset or empty: off, silently. Anything else ('on', '1', 'shadwo'): off, with one warning on stderr per process,
//   so a typo in the plist never turns judging on and never goes unnoticed.
// What each mode does is up to the reader:
//   move.js   off: no routes. shadow: shadow routes. veto: the same as shadow (S5, the /api/result veto, is not built
//             yet; until it is, veto must behave exactly like shadow). decide: shadow judging plus C1b's guest binding.
//   shadow.js shadow, veto, decide: the post-hoc re-judge runs; off: nothing.
export const MODES = new Set(['off', 'shadow', 'veto', 'decide']);

// The mode for a raw value, and whether the value was unrecognised (pure).
export function parseJudgeMode(v) {
  if (v == null) return { mode: 'off', unknown: false };
  const s = String(v).trim().toLowerCase();
  if (s === '') return { mode: 'off', unknown: false };
  return MODES.has(s) ? { mode: s, unknown: false } : { mode: 'off', unknown: true };
}

let warned = false;
// The mode for v (default: the environment). An unrecognised value warns once per process.
export function judgeMode(v = process.env.TINUE_JUDGE, warn = (m) => console.warn(m)) {
  const { mode, unknown } = parseJudgeMode(v);
  if (unknown && !warned) {
    warned = true;
    warn(`TINUE_JUDGE=${JSON.stringify(String(v).slice(0, 40))} is not one of off, shadow, veto, decide: judging stays off`);
  }
  return mode;
}
