// The Settings page's example board: PTN Ninja's own board (the puzzle page's frame, lent: ninja.js lend) in the player's
// theme and look, so what it shows is what a puzzle will look like. Three positions between them have every kind of
// thing a look can change: flats, walls and capstones of both colours, stacks (one taller than the carry limit), the last move
// (a stack move over several squares), a hint square, the side to move, the flat counts with komi and the pieces left; a
// finished road; and a board won on flats. It takes no moves.
import { buildPTN } from './board-kit.js';
import { SAYS } from './ninja.js';

export const KOMI = 2;
export const EXAMPLES = {
  play: { name: 'In play', tps: '2,x,1,2S,x,1/x,12,1,x,2,x/1,x,1121122C,2,x,1S/x,2,1,12121C,1,x/2,1,x,121,2,x/1,x,2,2,x,1 1 20', move: '3d2<12', hint: ['e6'] },
  road: { name: 'Road', tps: '2,x,1,2S,x,1/x,12,1,x,2,x/1,x,1121122C,2,x,1S/1,121,1,12121C,1,x/2,1,x,121,2,x/1,x,2,2,x,1 1 20', move: 'f3', roads: true },
  flats: { name: 'Flat win', tps: '2,1,1,2S,2,1/1,12,1,2,2,2/1,1,1121122C,2,1,1S/2S,2,1,12121C,1,2/2,1,1,121,2,1/1,1,2,2,x,1 1 20', move: 'e1' },
};
export const examplePTN = (k) => buildPTN({ size: 6, komi: KOMI, tps: EXAMPLES[k].tps, moves: [EXAMPLES[k].move] });

// el: an empty element on the Settings page; frame: the puzzle page's NinjaBoard.
// enter() when the page is shown, leave() when another is, relook() after the look changed.
export class ExampleBoard {
  constructor(el, frame) {
    this.frame = frame; this.at = 'play'; this.gen = 0; this.on = false;
    el.innerHTML = `<div class="set-ex-tabs" role="group" aria-label="Example board">${Object.entries(EXAMPLES).map(([k, x]) => `<button type="button" data-ex="${k}" aria-pressed="${k === this.at}">${x.name}</button>`).join('')}</div>
      <div class="set-ex-board"><div class="board-host"></div><p class="set-ex-msg" role="status"></p></div>`;
    this.msg = el.querySelector('.set-ex-msg');
    this.board = frame.lend(el.querySelector('.board-host'), { onMove() {}, onDead: () => this.down() });
    this.board.ui({ disableBoard: true });
    for (const b of el.querySelectorAll('[data-ex]')) b.onclick = () => {
      this.at = b.dataset.ex;
      for (const x of el.querySelectorAll('[data-ex]')) x.setAttribute('aria-pressed', x === b);
      this.draw();
    };
  }
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
  leave() { this.gen++; this.on = false; this.say(''); this.board.giveBack(); }
  async draw() {
    const x = EXAMPLES[this.at], g = this.gen;
    if (!this.board.borrowed) return;
    this.board.ui({ showRoads: !!x.roads });
    await this.board.load(examplePTN(this.at));
    if (g === this.gen && x === EXAMPLES[this.at] && this.board.borrowed) this.board.highlight(x.hint || []);
  }
  relook() { if (this.on) this.board.relook(); }
  // PTN Ninja isn't there: said in the board's place, with Retry; coming up late, the board takes it back by itself.
  down() {
    if (!this.on) return;
    const g = ++this.gen;
    this.board.giveBack();
    this.say(this.board.iframe.dataset.down === 'stopped' ? SAYS.stopped : SAYS.load, true);
    this.board.whenUp().then(() => { if (g === this.gen && this.on) this.enter(); });
  }
  say(text, retry = false) {
    this.msg.textContent = text;
    if (!retry) return;
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Retry' });
    b.onclick = () => { this.say(SAYS.note); this.board.retry(); };
    this.msg.append(b);
  }
}
