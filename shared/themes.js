// Puzzle themes. Results from theme-filtered sessions move ratings less (themeWeight in rating.js), except themes
// marked fullWeight: those are a challenge, not a drill, and count in full (Sasha, 2026-11-20: Deep tinuë).
// desc: what the tag selects (shared/analyze.js tagPuzzle, on the stored main line), under the Theme menu and on a finished
// puzzle's tags. The spread/throw split (regular/irregular) is Boris's (USTA), 2026-11-17.
export const THEMES = {
  roadIn1:   { name: 'Road in 1',     group: 'Length', desc: 'You can complete a road this move.' },
  tinueIn2:  { name: 'Road in 2',     group: 'Length', desc: 'A forced win in two of your moves, ending with a road.' },
  tinueIn3:  { name: 'Road in 3',     group: 'Length', desc: 'A forced win in three of your moves, ending with a road.' },
  tinueIn4:  { name: 'Road in 4+',    group: 'Length', desc: 'A forced win in four or more of your moves, ending with a road.' },
  deep:      { name: 'Deep tinuë',    group: 'Length', fullWeight: true, desc: 'A forced road six to eight of your moves long. A solver found no first move outside the solution that forces one as fast.' }, // the ids: scripts/deep-proven.jsonl
  gaelet:    { name: 'Flat win',      group: 'Goal',   desc: 'The solution wins on flats, komi included: its last move fills the board or places your last piece. A forced flat win is called a gaelet.' },
  fork:      { name: 'Fork',          group: 'Motif',  desc: 'One of your moves leaves two or more empty squares where a placement would win next turn.' }, // USTA's term; was 'Double threat'
  quietMove: { name: 'Non-Tak tinuë', group: 'Motif',  desc: 'A road win where at least one of your moves before the last isn’t Tak: it doesn’t threaten to win next turn.' },
  smash:     { name: 'Smash',         group: 'Motif',  desc: 'Your capstone flattens a wall, yours or your opponent’s.' },
  spread:    { name: 'Spread',        group: 'Motif',  desc: 'You spread a stack over two or more squares, and all of them end up showing your colour (a regular spread).' },
  throw:     { name: 'Throw',         group: 'Motif',  desc: 'You spread a stack over two or more squares, and at least one ends up showing your opponent’s colour (an irregular spread).' },
  stackRoad: { name: 'Stack road',    group: 'Motif',  desc: 'The winning move is a spread or throw, and at least two squares it drops on are joined to the road.' },
  reveal:    { name: 'Drawbridge',    group: 'Motif',  desc: 'You move a stack topped by your wall off your own flat. That square ends up joined to the road.' }, // key stays 'reveal' (stored on puzzles); USTA's term is drawbridge
  capture:   { name: 'Capture',       group: 'Motif',  desc: 'Your first move is a stack move, and the first square it drops on is your opponent’s.' },
  wallBlock: { name: 'Defend first',  group: 'Motif',  desc: 'Your opponent threatens to win next move, so your first move has to stop it.' },
  placement: { name: 'Placement only', group: 'Motif', desc: 'All your moves in the solution are placements.' },
  dragon:    { name: 'Dragon clause', group: 'Motif',  desc: 'The solution’s last move completes roads for both players. The player who moved wins.' },
  s4: { name: '4×4', group: 'Board' },
  s5: { name: '5×5', group: 'Board' },
  s6: { name: '6×6', group: 'Board' },
  s7: { name: '7×7', group: 'Board' },
  s8: { name: '8×8', group: 'Board' },
};
