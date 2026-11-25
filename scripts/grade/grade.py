"""Conversion grade v2 for tinue (turn=0): tier A/B/C/D + continuous score.  -> grades.jsonl {id, tier, score, why}

usage: uv run --with pandas --with numpy python grade.py [--tp] [--ids a,b,...]
inputs (this dir): feats.jsonl, tp-feats.jsonl, composer_ideas.jsonl, composer_tpideas.jsonl (v1 idea walk),
  search_out/cheap{0,1}.jsonl (real blocks per defender node), v2_walk.{0,1}.*.jsonl (v2_walk.mjs: per-key motifs,
  root precision decoys, forcing/quiet root alts, later slower alts within +2 plies), v2_forks.{0,1}.jsonl
  (v2_forks.py: transposition-aware forks from the trees).

Everything is counted in IDEAS (placement = square; stack move = square+direction; drop counts/stone types = one idea).
Below-root "looseness" counts only attacker nodes with >= 5 plies left (a choice between two finishing double threats
at 3 plies left is mop-up), drops forks that are transpositions (the other key is played next in the other order), and
is judged against the turning points of the same length, so long lines aren't capped for being long.

D (never serve): road-in-1 | ends on flat count / gaelet | a node accepts >= 10 moves | 3+ fastest first ideas
   | 5+ winning first ideas counting forcing slower ones
cap C: 3-4 winning first ideas incl. forcing slower ones | exactly 2 fastest first ideas
   | no decoy at the root (key is the only Tak threat idea and no wrong drop count of it is a threat)
   | reserves run out (last move can also win on flat count)
   | seesaw ladder: >= half the later keys re-play a square already used on the line and >= 2 defender nodes have
     <= 1 real block idea (fires on 0-10% of TPs per length)
   | ladder: >= 2 padding moves and >= half the later moves are padding (padding = the defender had <= 1 real block
     idea and the key is the only threat or re-plays a square the attacker already used on this line)
   | loose: loose nodes above the same-plies TP 90th pct (loose node = a non-transposed second winning idea or a slower
     win within +2 plies, at a node with >= 5 plies left)
cap B: one forcing slower first move | one root decoy idea in all | loose nodes above the same-plies TP 75th pct
   | slower first moves never checked
score (logit, length excluded; refit on real non-bot PlayTak first-move decisions on clean conversions):
   s = 0.45 ln(1 + most real block ideas at any defender node) + 0.5 rootMotif + 1.0 laterMotif + 0.5 finalOnlyMotif(forced: every final road move uses it)
       + 0.35 ln(1 + wrong-drop threats of the key idea) - 0.45 rootCapture - 0.55 wallBlock + game nudge
   (motif = spread/throw/smash; root/later motif count only when every key at that node uses one; real block = a reply
    after which the attacker has no road-in-1 and the game goes on; game nudge +0.4 if a non-bot 1000+ human missed the
    key, -0.15 if they found it and won, 0 if they found it but did not win the game)
   score = s - median s of same-plies TPs.  Tier by mid-rank percentile among same-plies TPs: A >= 0.5, B >= 0.25,
   else C; then lowered to the cap.
"""
import sys, json, re, glob
import numpy as np, pandas as pd

TP = '--tp' in sys.argv
IDS = sys.argv[sys.argv.index('--ids') + 1].split(',') if '--ids' in sys.argv else None
# refit coefficients (v2_fit.py; rounded)
COEF = dict(blk=0.45, rMot=0.5, lMot=1.0, finOnly=0.5, pdec=0.35, rCap=-0.45, wallBlock=-0.55)
NUDGE_MISS, NUDGE_FOUND = 0.4, -0.15

def idea(p):
    m = re.match(r'^([FSC]?)([a-h][1-8])$', p)
    if m: return m.group(2)
    s = re.match(r'^\d*([a-h][1-8])([<>+-])', p)
    return s.group(1) + s.group(2) if s else p

def jl(f): return pd.read_json(f, lines=True)
def walk_rows(turn):
    rows = []
    for f in sorted(glob.glob(f'v2_walk.{turn}.*.jsonl')):
        for l in open(f):
            try: rows.append(json.loads(l))
            except Exception: pass
    return pd.DataFrame(rows)[['id', 'nodes']].rename(columns={'nodes': 'wn'})

def load(turn):
    F = jl('feats.jsonl' if turn == 0 else 'tp-feats.jsonl')
    W = jl('composer_ideas.jsonl' if turn == 0 else 'composer_tpideas.jsonl')
    C = jl(f'search_out/cheap{turn}.jsonl').rename(columns={'nodes': 'cn'})
    K = jl(f'v2_forks.{turn}.jsonl')
    V = walk_rows(turn)
    d = (F.merge(W[['id', 'ideasAt', 'decoyAt', 'endKind', 'finMoves', 'finRoadMoves']], on='id', how='left')
          .merge(C, on='id', how='left').merge(K, on='id', how='left').merge(V, on='id', how='left'))
    return d

has = lambda d, t: d.themes.apply(lambda x: t in x).astype(int)
MOT = ('spread', 'throw', 'smash')

def feats(d):
    first = lambda a: a[0] if isinstance(a, list) and a else 0
    L = lambda v: v if isinstance(v, list) else []
    d['rootIdeas'] = d.ideasAt.apply(first)
    d['rootDecoy'] = d.decoyAt.apply(first)
    d['nAtt'] = d.ideasAt.apply(lambda a: len(a) if isinstance(a, list) else 0)
    d['flatFin'] = (d.finMoves > d.finRoadMoves).fillna(False)
    d['flatEnd'] = (d.endKind != 'road') | has(d, 'gaelet').astype(bool)
    def per(r):
        wn, cn, fk = L(r.wn), L(r.cn), L(r.fk)
        o = {}
        n0 = wn[0] if wn else {}
        kI0 = set(n0.get('kI', []))
        alts = n0.get('rootAlts') or []
        # a slower first move is a competing route unless no threat-only tinue follows it within plies+4 (tin False:
        # it wins only through quiet moves or much later); tin is only computed for 3-9 ply, otherwise counted
        o['altF'] = len({idea(a['m']) for a in alts if a.get('tin') is not False} - kI0)
        o['altQ'] = len({idea(a['m']) for a in alts if a.get('tin') is False} - kI0 - {idea(a['m']) for a in alts if a.get('tin') is not False})
        o['pdec'] = n0.get('pdec', 0) or 0
        m0 = n0.get('mot', {})
        mot = lambda m: any(k in m for k in MOT)
        forced = lambda x: bool(x.get('motAll')) and all(mot(m) for m in x['motAll'])   # every key at the node uses it
        o['rMot'] = int(bool(wn) and forced(wn[0])); o['rCap'] = int('cap' in m0)
        o['lMot'] = int(any(forced(x) for x in wn[1:]))
        anyKey = any(mot(m) for x in wn for m in (x.get('motAll') or []))
        o['finOnly'] = int(any(t in r.themes for t in MOT) and not anyKey)    # motif only on the final road move
        o['lpdec'] = float(np.log1p(o['pdec']))
        # real blocks (defender replies after which the attacker has no road-in-1 and the game goes on)
        o['maxBlkI'] = max([x.get('blockI', 0) for x in cn if 'blockI' in x], default=0)
        o['maxDefsLive'] = max([x['defs'] for x in cn if 'defs' in x and x.get('blocks', 0) > 0], default=0)
        # looseness below the root (R >= 5), transpositions dropped, later slower alts within +2
        loose, wide, forks, lalt = 0, 0, 0, 0
        for j in range(1, len(fk)):
            f = fk[j]
            if f['R'] < 5: continue
            nI = f['n'] - f['tr']
            a = len((wn[j].get('altI') or [])) if j < len(wn) else 0
            forks += nI >= 2; lalt += a
            if nI >= 2 or a: loose += 1
            if nI + a >= 3: wide += 1
        o['loose'], o['wide'], o['forksR5'], o['laterAlt'] = loose, wide, forks, lalt
        # padding / ladder
        mi = [x['kI'][0] if x.get('kI') else None for x in wn]
        dec = L(r.decoyAt)
        pad = 0
        for j in range(1, len(wn)):
            pb = cn[j - 1].get('blockI', 9) if j - 1 < len(cn) else 9
            only = j < len(dec) and dec[j] == 0
            refill = mi[j] in mi[:j]
            if pb <= 1 and (only or refill): pad += 1
        o['pad'] = pad; o['later'] = max(len(wn) - 1, 0)
        o['refill'] = sum(1 for j in range(1, len(mi)) if mi[j] is not None and mi[j] in mi[:j])
        o['forcedD'] = sum(1 for x in cn[:-1] if 'blockI' in x and x['blockI'] <= 1)
        return pd.Series(o)
    d = pd.concat([d, d.apply(per, axis=1)], axis=1)
    # final-only motif counts only when EVERY road-in-1 at the end of the line uses it (v2_fin.mjs)
    fin = jl('v2_fin.jsonl'); forcedFin = set(fin[(fin.n > 0) & (fin.mot == fin.n)].id)
    d['finOnly'] = (d.finOnly.astype(bool) & d.id.isin(forcedFin)).astype(int)
    d['routes'] = d.rootIdeas + d.altF
    d['decoyEff'] = d.rootDecoy + d.pdec.clip(upper=2)
    return d

def structure(d):
    return (COEF['blk'] * np.log1p(d.maxBlkI) + COEF['rMot'] * d.rMot + COEF['lMot'] * d.lMot + COEF['finOnly'] * d.finOnly
            + COEF['pdec'] * d.lpdec + COEF['rCap'] * d.rCap + COEF['wallBlock'] * has(d, 'wallBlock'))

def game(d):
    human = (~d.attBot.astype(bool)) & (d.attRating >= 1000) & d.found.notna()
    conv = d.wonGame.fillna(1) > 0               # found the key but then lost/drew the game: no credit either way
    return pd.Series(np.where(human, np.where(d.found == False, NUDGE_MISS, np.where(conv, NUDGE_FOUND, 0.0)), 0.0), index=d.index)

df = feats(load(1 if TP else 0))
ft = feats(load(1))
ft = ft[(ft.plies >= 3) & (ft.endKind == 'road')].copy(); ft['s'] = structure(ft) + game(ft)   # same nudge on both sides
ref = ft.groupby('plies').s.quantile([0.25, 0.5]).unstack()
lref = ft.groupby('plies').loose.quantile([0.5, 0.75, 0.9]).unstack()

df['game'] = game(df)
df['s'] = structure(df) + df.game
df['score'] = (df.s - df.plies.map(ref[0.5])).round(3)
# mid-rank percentile among same-plies TPs (ties count half: at 3 ply ~37% of TPs sit exactly on the median)
tps = {p: np.sort(g.s.round(6).values) for p, g in ft.groupby('plies')}
def pct(p, x):
    a = tps.get(p)
    if a is None or x != x: return 0.0
    x = round(x, 6); return (np.searchsorted(a, x, 'left') + np.searchsorted(a, x, 'right')) / 2 / len(a)
df['pct'] = [pct(p, x) for p, x in zip(df.plies, df.s)]
l75 = df.plies.map(lref[0.75]).fillna(0); l90 = df.plies.map(lref[0.9]).fillna(0)

ORDER = 'ABCD'
def grade(r, q25m, l75m, l90m):
    if r.plies == 1: return 'D', 'road-in-1'
    if r.flatEnd: return 'D', 'ends on flat count'
    if r.maxKeys >= 10: return 'D', f'giveaway node ({r.maxKeys} accepted moves)'
    if r.rootIdeas >= 3: return 'D', f'{r.rootIdeas} different first ideas win fastest'
    if r.routes >= 5: return 'D', f'{r.routes} winning first ideas incl. slower'
    cap, why = 'A', []
    def lim(t, w):
        nonlocal cap
        if ORDER.index(t) > ORDER.index(cap): cap = t
        why.append(w)
    if r.routes >= 3: lim('C', f'{r.routes} winning first ideas incl. slower')
    elif r.rootIdeas == 2: lim('C', '2 first ideas win fastest')
    elif r.routes == 2: lim('B', 'a forcing slower first move also wins')
    if r.decoyEff == 0: lim('C', 'no decoy at the root')
    elif r.decoyEff == 1: lim('B', 'one decoy at the root')
    if r.flatFin: lim('C', 'reserves run out: last move can also win on flat count')
    if r.later >= 2 and r.pad >= 2 and 2 * r.pad >= r.later: lim('C', f'ladder ({r.pad}/{r.later} later moves are padding)')
    elif r.later >= 3 and r.forcedD >= 2 and r.refill >= 2 and 2 * r.refill >= r.later:
        lim('C', f'seesaw ladder ({r.refill}/{r.later} later keys re-play a square, {r.forcedD} one-block defences)')
    if r.loose >= 1 and r.loose > l90m: lim('C', f'loose below the root ({r.loose} nodes; TP p90 {l90m:g})')
    elif r.loose >= 1 and r.loose > l75m: lim('B', f'loose below the root ({r.loose} nodes; TP p75 {l75m:g})')
    if r.alts != r.alts or r.alts is None: lim('B', 'slower first moves never checked')
    t = 'A' if r.pct >= 0.5 else 'B' if r.pct >= 0.25 else 'C'
    why.append(f'score at TP pct {r.pct:.2f} of same length')
    if r.altQ: why.append(f'{r.altQ} quiet slower first move(s) ignored')
    if isinstance(r.reasons, list) and not r.reasons: why.append('no conversion reason: recheck as turning point')
    return ORDER[max(ORDER.index(t), ORDER.index(cap))], '; '.join(why)

res = [grade(r, None, b, c) for r, b, c in zip(df.itertuples(), l75, l90)]
df['tier'] = [a for a, _ in res]; df['why'] = [b for _, b in res]
df['score'] = df.score.fillna(-9.0)
if IDS:
    pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 200)
    cols = ['id', 'plies', 'tier', 'score', 'pct', 's', 'maxBlkI', 'finOnly', 'maxDefsLive', 'rMot', 'lMot', 'rCap', 'game', 'routes', 'altQ', 'decoyEff', 'pdec', 'loose', 'pad', 'later', 'why']
    print(df[df.id.isin(IDS)][cols].set_index('id').loc[[i for i in IDS if i in set(df.id)]].to_string())
elif not TP:
    with open('grades.jsonl', 'w') as f:
        for r in df[['id', 'tier', 'score', 'why']].itertuples(index=False):
            f.write(json.dumps({'id': r.id, 'tier': r.tier, 'score': round(float(r.score), 3), 'why': r.why}) + '\n')
if not IDS:
    pd.set_option('display.width', 200)
    print('TP structure quantiles by plies:'); print(ref.round(3)); print('TP loose quantiles:'); print(lref)
    print('tiers', df.tier.value_counts().sort_index().to_dict(), 'n', len(df))
    print(pd.crosstab(df.src, df.tier, margins=True)); print(pd.crosstab(df.plies, df.tier, margins=True))
    if '--why' in sys.argv: print(df[df.tier.isin(['C', 'D'])].why.str.split('; ').str[0].value_counts().head(20))
