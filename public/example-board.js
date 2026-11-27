// The Settings page's example board, in the Board theme block: PTN Ninja's own board (the puzzle page's frame, lent:
// ninja.js lend) in the player's theme and look, so what it shows is what a puzzle will look like. A position in play with
// flats, walls and capstones of both colours, stacks (one taller than the carry limit), the last move (a stack move over
// several squares), a hint square, the side to move, the flat counts with komi and the pieces left. Both sides can be
// played on it (Reset puts it back); nothing is judged or kept.
import { buildPTN } from './board-kit.js';
import { SAYS } from './ninja.js';

export const KOMI = 2;
export const EXAMPLE = { tps: '2,x,1,2S,x,1/x,12,1,x,2,x/1,x,1121122C,2,x,1S/x,2,1,12121C,1,x/2,1,x,121,2,x/1,x,2,2,x,1 1 20', move: '3d2<12', hint: ['e6'] };
export const examplePTN = () => buildPTN({ size: 6, komi: KOMI, tps: EXAMPLE.tps, moves: [EXAMPLE.move] });

// el: an empty element on the Settings page; frame: the puzzle page's NinjaBoard.
// enter() when the page is shown, leave() when another is, relook() after the look changed.
export class ExampleBoard {
  constructor(el, frame) {
    this.frame = frame; this.gen = 0; this.on = false;
    el.innerHTML = '<div class="set-ex-box"><div class="board-host"></div><p class="set-ex-msg" role="status"></p></div><button type="button" class="link set-ex-reset" aria-label="Reset the example board">Reset</button>';
    this.msg = el.querySelector('.set-ex-msg');
    this.board = frame.lend(el.querySelector('.board-host'), { onMove: () => this.moved(), onDead: () => this.down(), steady: 700, zoom: 2, guard: true });
    // (dropOnStray: the page keeps the keyboard, so the board never takes it from the look field)
    this.board.ui({ disableBoard: false, dropOnStray: true });
    this.reset = el.querySelector('.set-ex-reset');
    this.reset.onclick = (e) => {
      if (!e.detail) el.closest('.set-item')?.querySelector('select')?.focus({ preventScroll: true }); // (by keyboard: it is about to hide)
      this.draw();
    };
    this.showReset(false);
  }
  showReset(on) { this.reset.style.visibility = on ? '' : 'hidden'; } // (its room is kept: nothing moves)
  // The next move is the other side's, until the game is over.
  moved() { this.showReset(true); if (!this.board.g.result()) this.board.setPlayer(this.board.g.toMove); }
  async enter() {
    const g = ++this.gen;
    this.on = true;
    this.say(this.board.frameUp ? '' : SAYS.note);
    const up = await this.board.frameReady();
    if (g !== this.gen) return;
    if (!up) return this.down();
    this.say('');
    if (this.board.borrow(6)) this.draw();
  }
  leave() { this.gen++; this.on = false; this.say(''); this.showReset(false); this.board.giveBack(); }
  async draw() {
    const g = this.gen;
    if (!this.board.borrowed) return;
    this.showReset(false);
    this.board.cancel(); // (a stack half spread)
    await this.board.load(examplePTN());
    if (g !== this.gen || !this.board.borrowed) return;
    this.board.setPlayer(this.board.g.toMove);
    if (this.board.cur === 1) this.board.highlight(EXAMPLE.hint); // (not over a move made meanwhile)
  }
  relook() { if (this.on) this.board.relook(); }
  // PTN Ninja isn't there: said in the board's place, with Retry; coming up late, the board takes it back by itself.
  down() {
    if (!this.on) return;
    const g = ++this.gen;
    this.board.giveBack();
    this.showReset(false);
    this.say(this.board.iframe.dataset.down === 'stopped' ? SAYS.stopped : SAYS.load, true);
    this.board.whenUp().then(() => { if (g === this.gen && this.on) this.enter(); });
  }
  say(text, retry = false) {
    this.msg.textContent = text;
    if (!retry) return;
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Retry' });
    b.onclick = () => { this.board.retry(); this.enter(); };
    this.msg.append(b);
  }
}
