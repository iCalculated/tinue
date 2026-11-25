// Small checks the server's modules share.
export const PTN_RE = /^[1-8]?[SCF]?[a-h][1-8](?:[<>+-][1-8]*)?[*'!?]*$/; // a move's shape (stored logs depend on it; the board decides the rest)
export const GID_RE = /^[a-f0-9]{32}$/; // a browser's random guest id
// A client's time: untrusted, at most an hour, else null.
export const cleanMs = (v) => (Number.isFinite(v) && v >= 0 && v <= 3600e3 ? Math.round(v) : null);
export const httpError = (status, message) => Object.assign(new Error(message), { status });
export const pacificDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t); // YYYY-MM-DD
