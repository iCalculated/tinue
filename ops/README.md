# The API's Linux host

Players reach the API through Cloudflare: `api.tinue.me` and `tinue-api.shydrie.xyz` (the old name, kept for open tabs,
bots and shared links), both proxied A records -> Caddy -> `127.0.0.1:8642` (node, systemd `tinue.service`, user `tinue`).
`tinue-stats.shydrie.xyz` -> the players page on 8792. No address of the host is in this repository; scripts take it as
`TINUE_HOST=user@host` (an `~/.ssh/config` alias is best).

| | |
|---|---|
| `provision.sh` | Ubuntu 26.04, as root, any number of times: packages, node (pinned tarball), Caddy, accounts, ssh, firewall, units |
| `cloudflare-ranges.txt` | the one list of Cloudflare's ranges, for Caddy and the firewall; a weekly unit fails if Cloudflare's differs |
| `Caddyfile`, `caddy/`, `site.sh`, `upstream.sh` | the proxy; which names are served; whether they go to node or to the gate |
| `gate.mjs`, `gate-ctl.sh` | holds requests while the writer changes; in the path only during a move |
| `backup.mjs` | every 10 minutes, in `/var/lib/tinue-backup`; `--verify` is the restore drill |
| `build-syntaks.sh`, `tei-smoke.mjs` | the engine, built on the host |
| `move/` | the move between crux and the host, both ways |
| `../scripts/deploy-ovh.sh` | code, env (`/etc/tinue/tinue.env`) and restart |

State is `/var/lib/tinue` (only `tinue` reads it; `/srv/tinue/data` links to it). Code in `/srv/tinue` is root's.

**One writer.** This host runs node only while `/var/lib/tinue/WRITER` exists (systemd checks). A host whose database moved
away has a `MOVED` file beside it: the server, `import.mjs` and every deploy script refuse there. `move/` is what sets both.
Never open the live database with the `sqlite3` CLI; use `move/db.mjs` and `backup.mjs`.

**Node** is 24 LTS (crux ran 25, which gets no more fixes). Nothing in the database depends on it: the file format and the SQL
are SQLite's, and `node:sqlite` gives the same JavaScript values in both. Ratings replayed on another CPU may differ in the
last digit: don't compare them byte for byte.

## Set up

    rsync -a ops/ host:ops/
    ssh host 'sudo sh ops/provision.sh --mover-key crux.pub'    # crux's public key
    ssh host 'sudo sh ops/provision.sh --confirm-firewall'      # from a new session, within 5 minutes
    ssh host 'sh ops/build-syntaks.sh'
    TINUE_HOST=host scripts/deploy-ovh.sh                       # no WRITER yet: nothing starts
    ssh host 'sudo systemctl enable --now tinue-gate'           # it holds until told otherwise

Crux needs `rsync` that speaks to the host's (Homebrew's: `CRUX_RSYNC=/opt/homebrew/bin/rsync`); `move.sh tools`, then `preseed`
tries it.

## Certificates

Caddy gets Let's Encrypt certificates by HTTP-01. Cloudflare passes `http://<name>/.well-known/acme-challenge/` on to the
origin's port 80, so it works behind the Cloudflare-only firewall, the first time and for renewals. In both zones: SSL/TLS
mode Full (strict), "Always Use HTTPS" off (a redirect would meet a name with no certificate yet). Failed tries are rate
limited, so enable a name only when its challenge reaches this host:

1. `api.tinue.me`: make the proxied A record, then `sudo sh /srv/tinue/ops/site.sh api.tinue.me`. Nobody uses the name yet.
2. `tinue-api.shydrie.xyz` gets its certificate **before** its DNS changes, while players still go through the tunnel:
   - hop up (below): crux's port 8644 is this host's port 80;
   - in the tunnel's ingress, above the tinue-api rule: hostname `tinue-api.shydrie.xyz`, path `^/\.well-known/acme-challenge/`,
     service `http://127.0.0.1:8644`. (A tunnel configured in the dashboard takes it at once. One with a local file needs a
     restart: start a second `cloudflared` with the new file first, then restart the first, so one is always connected.)
   - `sudo sh /srv/tinue/ops/site.sh tinue-api.shydrie.xyz`; wait for `certificate obtained` in `journalctl -u caddy`;
   - then edit the DNS record to the proxied A. The certificate is already there, so no request is refused.
3. `tinue-stats.shydrie.xyz`: the DNS first, then `site.sh`; the page is away for a minute.

Fallback, if a challenge does not arrive: a Cloudflare Origin CA certificate from the dashboard (a secret: paste it on the host
only, `/etc/caddy/certs/<name>.pem` and `.key`, 0640 root:caddy), and in `/etc/caddy/sites/<name>.caddy` replace `import tls` by
`tls /etc/caddy/certs/<name>.pem /etc/caddy/certs/<name>.key`. provision.sh would write that file again: change `ops/caddy/` too.

Other Cloudflare settings for the API names: Bot Fight Mode and Browser Integrity Check off, nothing cached, "Remove visitor IP
headers" off. Not done yet: per-host Authenticated Origin Pulls (until then another Cloudflare customer who learned the
address could send this host a forged `CF-Connecting-IP`, which is only a rate-limit key).

## The move

From a checkout, with `TINUE_HOST`, `MOVE_DEST=mover@host`, `MOVE_KEY=` crux's key and, if needed, `CRUX_RSYNC`:

1. The **same commit** on both: `scripts/deploy-ovh.sh`, `scripts/deploy-crux.sh` (no dirty tree).
2. `ops/move/move.sh tools`, `hop start`; on the host `sudo sh /srv/tinue/ops/move/ovh.sh pass 8643`. Now gate -> hop -> crux.
3. Certificates and DNS as above. Both ways in end at crux. Wait until the tunnel sees no more tinue-api requests (minutes):
   one that still comes through it after the next step gets a 502.
4. `move.sh check`, `move.sh rehearse` twice. Freeze puzzle publishing and imports. Funnel: check crux's log for use first.
5. `move.sh go`. Requests wait meanwhile, then get their normal answer. If it stops: `go` again goes on, `move.sh abort`
   goes back. Up to its last step (`pass 8642`) nothing has reached the new node, so abort loses nothing.
6. Play one puzzle on each name. `sudo sh /srv/tinue/ops/upstream.sh node` (the gate stays installed); `move.sh hop stop`; on crux
   `crux.sh pull-install` (DEST, KEY, CRUX_RSYNC), then `provision.sh --mover-key … --no-hop` after a week. Funnel off.

Back, with the new host healthy: `move.sh rollback` (hold, fence the new host, crux takes the database back, checks it,
serves). Every write made since comes along. If the host is down but its disk is alive, wait or mount it: take the db, wal and shm
together. If it is lost: crux's `~/Projects/tinue-move/pull/good.db` is at most about 20 minutes old; put it in place of the
fenced database, remove `data/MOVED`, start, and point both names back at the tunnel. Sasha decides between those.
Keep the tunnel and its ingress (add `api.tinue.me` to it, unrouted) for that.

Not covered by the gate: a request through the old tunnel or Funnel while crux is being fenced, and whatever the gate holds
if it or the machine dies. The page's result queue resends those.
