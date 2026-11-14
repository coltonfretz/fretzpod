// The pause menu all three games share. A fresh-eyes
// playtest found MENU did something different in each game: Star Pinball
// quit on one tap (a thumb slipping up off a flipper ended the run), Fishing
// Trip wanted MENU held to leave, and Tiki Golf paused. Now they all work
// the same way:
// - Mid-game, a MENU tap only shows "Hold MENU to pause". Thumbs are on the
//   ring the whole time in these games, and a stray tap at the top shouldn't
//   stop anything.
// - Holding MENU about a second opens the pause menu: Resume, or quit.
// - In the pause menu, the wheel picks, center chooses, a MENU tap resumes.
// - End screens (Game Over, the scorecard) still leave on a MENU tap.
// Play/pause also opens it in Tiki Golf. Fishing Trip and Star Pinball leave
// play/pause alone mid-game: the reel spins right past it, and a thumb sliding
// off a flipper hits it (pinball counts a touch the moment it lands).
//
// Times here are wall-clock (performance.now), not game time: a paused game's
// clock stops, and the hint has to fade either way.
import { canvasFont as font } from './util.js';

const HINT_MS = 1500;
const HOLD_LONG_MS = 550;   // on top of the wheel's 450 ms hold: about a second in all
const HOLD_GAP_MS = 300;    // hold repeats come every 180 ms; a longer gap is a new hold

export class Pause {
  constructor(quitLabel) {
    this.labels = ['Resume', quitLabel];
    this.open = false;
    this.sel = 0;
    this.hintUntil = 0;
    this.held = null;
  }

  // A MENU tap mid-game.
  tap() { this.hintUntil = performance.now() + HINT_MS; }

  // Called on each MENU hold repeat (ui.js hold). True once it has been held
  // long enough, and only once per hold: the repeats keep coming while the
  // thumb stays down, and they mustn't close the menu again.
  hold() {
    const now = performance.now();
    if (!this.held || now - this.held.last > HOLD_GAP_MS) this.held = { start: now, last: now, done: false };
    this.held.last = now;
    if (this.held.done || this.open) return false;
    this.hintUntil = now + 600;
    if (now - this.held.start < HOLD_LONG_MS) return false;
    this.held.done = true;
    return true;
  }

  show() { this.open = true; this.sel = 0; this.hintUntil = 0; }
  hide() { this.open = false; }

  turn(dir) {
    const before = this.sel;
    this.sel = Math.max(0, Math.min(this.labels.length - 1, this.sel + dir));
    return this.sel !== before;
  }

  quitting() { return this.sel === 1; }

  // iPod-style: a white box, the chosen row in blue. Canvas size w x h.
  draw(g, w, h) {
    if (!this.open) return;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, w, h);
    const bw = w * 0.6, rh = h * 0.12;
    const x = (w - bw) / 2, y = h * 0.28;
    g.fillStyle = '#ffffff';
    roundRect(g, x, y, bw, rh * 3, h * 0.02);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#222';
    g.font = font(h * 0.065);
    g.fillText('Paused', w / 2, y + rh / 2);
    this.labels.forEach((label, i) => {
      const ry = y + rh * (i + 1);
      if (this.sel === i) {
        const grad = g.createLinearGradient(0, ry, 0, ry + rh);
        grad.addColorStop(0, '#5aa2f0');
        grad.addColorStop(1, '#2a6fd0');
        g.fillStyle = grad;
        g.fillRect(x, ry, bw, rh);
      }
      g.fillStyle = this.sel === i ? '#ffffff' : '#222';
      g.font = font(h * 0.058, 600);
      g.fillText(label, w / 2, ry + rh / 2);
    });
  }

  // "Hold MENU to pause", near the top, while a tap's reminder lasts.
  drawHint(g, w, h) {
    if (this.open || performance.now() > this.hintUntil) return;
    g.font = font(h * 0.05, 700);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const text = 'Hold MENU to pause', tw = g.measureText(text).width;
    g.fillStyle = 'rgba(5,10,20,.8)';
    g.fillRect(w / 2 - tw / 2 - 10, h * 0.13, tw + 20, h * 0.08);
    g.fillStyle = '#f4f6ff';
    g.fillText(text, w / 2, h * 0.17);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
