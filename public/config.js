// Where the API lives. Empty = same origin (local dev). The static build for shydrie.xyz overwrites this.
window.TINUE_API = '';
// The analysis view after a puzzle (app.js ANALYSIS): on in local development; the static build writes it, off for the
// production build, on for the beta (scripts/build-static.sh ANALYSIS, scripts/build-beta.sh).
window.TINUE_ANALYSIS = true;
