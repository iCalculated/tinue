// The commit this server runs, as logged with each attempt: scripts/deploy-crux.sh writes deploy/revision.json beside
// the code before it restarts the server, so the file as read once at startup names the running code. A dirty deploy's
// commit is followed by '+' and its diff's hash. TINUE_COMMIT, if set, comes first (a checkout may hold the file of its
// last deploy); no usable file: ''.
import fs from 'node:fs';

export function readCommit(file, env = process.env.TINUE_COMMIT) {
  if (env) return env;
  try {
    const { sha, dirty, diff } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^[0-9a-f]{40}$/.test(sha)) return dirty ? `${sha}+${diff || 'dirty'}` : sha;
  } catch {}
  return '';
}
export const COMMIT = readCommit(new URL('../deploy/revision.json', import.meta.url));
