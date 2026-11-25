# /// script
# requires-python = ">=3.10"
# dependencies = ["z3-solver"]
# ///
"""Machine-checked facts about the next-puzzle picker (server/server.js pickNext / pickFrom), with the Z3 SMT solver.

    uv run scripts/verify-picker.py

pickNext works in two stages: it picks from the served pool (turning points and A-grade conversions), and only when
nothing there matches the filters does it fall back to everything else (other conversions, unscored puzzles).
Within a stage, pickFrom ranks each candidate by
    score = |rating - target| + tier penalty (0 served pool, CONVERT conversion, UNSCORED unscored)
            + FLAW if another first move also wins - PLAYED if already played but still unsettled
and picks at random among the candidates that share the best one's tier (category, flaw, played) with a score within
PICK_WINDOW of it. This checks what that guarantees over ALL ratings and targets (real numbers, not samples) and
computes the exact worst cases, each with a witness. Only distances to the target matter, so a candidate is its
distance d >= 0 plus its flags. The constants are read from server.js, so a change there is checked, not assumed.
"""
import re
import sys
from pathlib import Path
from z3 import And, If, Not, Or, Optimize, Real, Int, Bool, Solver, sat, unsat

src = (Path(__file__).resolve().parent.parent / "server" / "server.js").read_text()
const = lambda name: int(re.search(rf"\b{name} = (\d+)", src).group(1))
UNSCORED, CONVERT, FLAW, WINDOW, PLAYED = (const(n) for n in ("UNSCORED", "CONVERT", "FLAW", "PICK_WINDOW", "PLAYED"))
SERVED, CONV, UNSC = 0, 1, 2
NAMES = {SERVED: "served pool", CONV: "conversion", UNSC: "unscored"}


class Cand:
    def __init__(self, name):
        self.name = name
        self.d, self.cat = Real(f"{name}_dist"), Int(f"{name}_cat")
        self.flaw, self.played = Bool(f"{name}_flaw"), Bool(f"{name}_played")
        self.score = self.d + If(self.cat == SERVED, 0, If(self.cat == CONV, CONVERT, UNSCORED)) \
            + If(self.flaw, FLAW, 0) - If(self.played, PLAYED, 0)
        self.wf = And(self.d >= 0, self.cat >= 0, self.cat <= 2)

    def same_tier(self, o):
        return And(self.cat == o.cat, self.flaw == o.flaw, self.played == o.played)

    def fresh(self):
        return Not(self.played)

    def clean(self):
        return And(Not(self.flaw), Not(self.played))

    def describe(self, m):
        flags = [f for f, b in (("slower win too", self.flaw), ("played, unsettled", self.played)) if m.eval(b)]
        return f"{m.eval(self.d)} from target, {NAMES[m.eval(self.cat).as_long()]}" + (f" ({', '.join(flags)})" if flags else "")


# best: the top-ranked candidate of the stage; pick: what pickFrom may return; other: any candidate it could have had.
best, pick, other = Cand("best"), Cand("pick"), Cand("other")
within = And(best.wf, pick.wf, other.wf,
             best.score <= pick.score, best.score <= other.score,  # best ranks first
             pick.same_tier(best), pick.score <= best.score + WINDOW)  # the window rule
STAGES = {
    "served pool": And(within, best.cat == SERVED, pick.cat == SERVED, other.cat == SERVED),
    "fallback (nothing in the pool matches)": And(within, best.cat != SERVED, pick.cat != SERVED, other.cat != SERVED),
}
failures = 0


def prove(stage, claim, statement):
    global failures
    s = Solver()
    s.add(STAGES[stage], Not(statement))
    ok = s.check() == unsat
    failures += not ok
    print(f"  {'PROVED ' if ok else 'REFUTED'}  {claim}")
    if not ok:
        m = s.model()
        print(f"           counterexample: picked {pick.describe(m)}; instead {other.describe(m)}")


def worst(stage, label, extra):
    """The most farther from the target the pick can be than `other` (negative: always at least that much closer)."""
    o = Optimize()
    o.add(STAGES[stage], extra)
    h = o.maximize(pick.d - other.d)
    if o.check() != sat:
        print(f"  {'n/a':>8}  {label}")
        return
    m = o.model()
    print(f"  {str(h.value()):>8}  {label}\n            e.g. picked {pick.describe(m)}; instead {other.describe(m)}")


print(f"constants from server.js: CONVERT {CONVERT}, UNSCORED {UNSCORED}, FLAW {FLAW}, PLAYED {PLAYED}, PICK_WINDOW {WINDOW}")
for stage in STAGES:
    print(f"\n{stage}:")
    prove(stage, f"the pick is within PICK_WINDOW ({WINDOW}) of the best candidate's distance", pick.d <= best.d + WINDOW)
    prove(stage, "the pick shares the best candidate's tier", pick.same_tier(best))

print("\nExact worst cases: how much farther from the target the pick can be than an alternative it passed over")
print("(negative: the pick is always at least that much closer)")
S, F = list(STAGES)
worst(S, "any pick vs. a fresh, clean puzzle", other.clean())
worst(S, "a fresh pick vs. a fresh, clean puzzle", And(pick.fresh(), other.clean()))
worst(S, "a fresh pick with a slower win too vs. a fresh, clean puzzle", And(pick.fresh(), pick.flaw, other.clean()))
worst(S, "any pick vs. a played-but-unsettled clean puzzle", And(other.played, Not(other.flaw)))
worst(F, "fallback: a fresh conversion vs. a fresh, clean unscored puzzle", And(pick.cat == CONV, pick.fresh(), other.cat == UNSC, other.clean()))
worst(F, "fallback: a fresh unscored puzzle vs. a fresh, clean conversion", And(pick.cat == UNSC, pick.fresh(), other.cat == CONV, other.clean()))

sys.exit(1 if failures else 0)
