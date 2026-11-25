# transposition-aware fork count per main-line attacker node, from the DB trees (read-only)
import sqlite3, json, re, os
def idea(p):
    m = re.match(r'^([FSC]?)([a-h][1-8])$', p)
    if m: return m.group(2)
    s = re.match(r'^\d*([a-h][1-8])([<>+-])', p)
    return s.group(1) + s.group(2) if s else p
def kideas(n): return set(idea(k) for k in n) if isinstance(n, dict) else set()
db = sqlite3.connect('file:' + os.environ.get('DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../data/tinue.db')) + '?mode=ro', uri=True)
for turn in (0, 1):
    with open(f'v2_forks.{turn}.jsonl', 'w') as f:
        for pid, plies, tree in db.execute("SELECT id, plies, tree FROM puzzles WHERE turn=? AND source NOT LIKE 'Ditaktic%'", (turn,)):
            t = json.loads(tree); node = t; R = plies; out = []
            while isinstance(node, dict) and node:
                ks = list(node); X = ks[0]; xi = idea(X)
                rep = {}  # idea -> first move
                for k in ks: rep.setdefault(idea(k), k)
                others = [y for y in rep if y != xi]
                def sub(m):
                    v = node.get(m); return v['n'] if v else None
                tr = [y for y in others if xi in kideas(sub(rep[y])) or y in kideas(sub(X))]
                out.append({'R': R, 'n': len(rep), 'tr': len(tr)})
                if not node[X]: break
                node = node[X]['n']; R -= 2
            f.write(json.dumps({'id': pid, 'fk': out}) + '\n')
