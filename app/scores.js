// Shared high score boards for Vortex and Space Sheep:
// one board per game for everyone on Fretzpod. The fretzpod-scores service
// (scores/scores.py) keeps each person's best; see DESIGN.md, "High scores".
// Also the parts both games share: the best kept on the phone, sending a
// finished game, and the text boxes drawn over the play area.
//
// A score that can't be sent (offline, service down) waits on the phone and
// goes with the next one, so a good game played on a train still counts.
//
// Names: everyone shows as "Player 3" until they pick one. The first time a
// game posts a score, the name picker opens (once per phone; skipping keeps
// Player 3), and Extras > High Scores > Your Name changes it later. Picked
// on the wheel arcade style, not the phone keyboard, which would squeeze
// the iPod screen.
import * as api from './api.js';
import { store, log, el, canvasFont as font } from './util.js';

export const BOARDS = [
  { id: 'vortex', name: 'Vortex' },
  { id: 'sheep', name: 'Space Sheep' },
];
const PENDING = 'fp.scores.pending';
const ME = 'fp.scores.me';            // {name, named} as the board last said, for the menu
const ASKED = 'fp.scores.asked';      // the picker has opened once on this phone

// Every answer that says who you are on the board is remembered for the menu.
async function call(path, body) {
  const d = await api.podCall('scores', path, body);
  if (d.me?.name) store.set(ME, JSON.stringify(d.me));
  return d;
}

const readJson = (key, fallback) => { try { return JSON.parse(store.get(key, '')) || fallback; } catch { return fallback; } };

// You on the board, as it last said: {name, named}.
export const me = () => readJson(ME, { name: '', named: false });

function setName(name) {
  return call('name', { name }).then((d) => d.me);
}

// After a game's score is posted: open the name picker the first time this
// phone sees a board that still calls you Player N.
function maybeAskName(ui, screen, result) {
  if (!result?.me || result.me.named || store.get(ASKED, '')) return;
  if (ui.top !== screen) return;
  store.set(ASKED, '1');
  ui.push(new NameEntry(result.me, (me) => { result.me = me; }));
}

const pending = () => readJson(PENDING, {});

// Sends a finished game's score. Resolves to the board afterwards
// ({top, you: {rank, score}, players, newBest}), or null if it couldn't be
// sent (it's kept for later).
export async function submit(game, score) {
  if (!api.getSession() || !(score > 0)) return null;
  const p = pending();
  p[game] = Math.max(p[game] || 0, score);
  store.set(PENDING, JSON.stringify(p));
  try {
    const r = await call('submit', { game, score: p[game] });
    const now = pending();
    if ((now[game] || 0) <= p[game]) { delete now[game]; store.set(PENDING, JSON.stringify(now)); }
    return r;
  } catch (e) {
    log(`score not sent yet: ${e.message}`);
    return null;
  }
}

export async function board(game) {
  const p = pending();
  if (p[game]) await submit(game, p[game]);
  return call(`board?game=${encodeURIComponent(game)}`);
}

// ---------- the games' side ----------
//
// `game` is a Vortex or SpaceSheep, which carry score, best, sent (this
// game's score has gone), result (the board's answer) and ui.

export const localBest = (id) => Number(store.get(`fp.${id}.best`, '0')) || 0;

export function keepBest(game, id) {
  if (game.score > game.best) { game.best = game.score; store.set(`fp.${id}.best`, String(game.best)); }
}

// The game is over, or abandoned by leaving (which throws it away): keep
// the best on the phone and send the score once.
export function gameOver(game, id) {
  if (game.sent) return;
  game.sent = true;
  keepBest(game, id);
  const score = game.score;
  submit(id, score).then((r) => {
    if (!game.sent || game.score !== score) return;   // a new game started meanwhile
    game.result = r;
    maybeAskName(game.ui, game, r);
  });
}

// The Game Over box: the score, then where it put you.
export function overLines(score, localBest, result) {
  const lines = [`Game over  ·  ${score}`];
  if (result?.you) {
    const { rank, score: best } = result.you;
    const who = result.me?.name ? ` as ${result.me.name}` : '';
    if (result.newBest) lines.push(`New best! #${rank} of ${result.players}${who}`);
    else lines.push(`Your best ${best}, #${rank} of ${result.players}${who}`);
  } else {
    lines.push(score >= localBest && score > 0 ? 'New best!' : `Best ${localBest}`);
  }
  lines.push('Center to play again');
  return lines;
}

// A dark box of text centered on (cx, cy), canvas height h: the first line
// bold, the rest lighter. Game Over, "Paused", "Press the center button".
export function drawBox(g, lines, cx, cy, h) {
  const style = (i) => { g.font = i ? font(h * 0.05, 500) : font(h * 0.06, 700); };
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lh = h * 0.08;
  const tw = Math.max(...lines.map((l, i) => { style(i); return g.measureText(l).width; }));
  const bh = lh * lines.length + h * 0.03;
  g.fillStyle = 'rgba(5,6,13,.85)';
  g.fillRect(cx - tw / 2 - 10, cy - bh / 2, tw + 20, bh);
  lines.forEach((l, i) => {
    style(i);
    g.fillStyle = i ? '#b9c2e8' : '#e8ecff';
    g.fillText(l, cx, cy - bh / 2 + h * 0.015 + lh * (i + 0.5));
  });
}

// ---------- the name picker ----------

const MAX = 10;
const DEL = '←';
const OK = '✓';
const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ' ', '-', DEL, OK];
const SHOW = { ' ': '␣' };

// Turn to a character, center adds it. ← takes the last one off, ✓ saves
// (saving nothing goes back to Player N). MENU leaves without saving.
export class NameEntry {
  constructor(me, onSaved) {
    this.title = 'Your Name';
    this.name = me?.named ? me.name : '';
    this.i = this.name ? CHARS.indexOf(OK) : 0;
    this.note = me?.name && !me.named ? `Now: ${me.name}` : '';
    this.busy = false;
    this.onSaved = onSaved;
  }

  attach(ui) { this.ui = ui; }

  turn(dir) {
    if (this.busy) return false;
    this.i = (this.i + dir + CHARS.length) % CHARS.length;
    return true;
  }

  select() {
    if (this.busy) return;
    this.note = '';
    const c = CHARS[this.i];
    if (c === DEL) { this.name = this.name.slice(0, -1); return; }
    if (c === OK) { this.save(); return; }
    if (c === ' ' && (!this.name || this.name.endsWith(' '))) return;
    if (this.name.length < MAX) this.name += c;
    if (this.name.length >= MAX) this.i = CHARS.indexOf(OK);
  }

  async save() {
    this.busy = true;
    this.note = 'Saving…';
    this.ui.refresh(this);
    try {
      const me = await setName(this.name.trim());
      this.onSaved?.(me);
      if (this.ui.top === this) this.ui.back();
    } catch (e) {
      this.busy = false;
      this.note = e.status === 409 ? 'Someone has that one' : e.status === 400 ? 'Not allowed' : "Couldn't save, try again";
      this.ui.refresh(this);
    }
  }

  render(view) {
    view.classList.remove('split');
    const c = CHARS[this.i];
    const name = el('div', 'ne-name');
    name.append(this.name, el('span', 'ne-cur' + (c === DEL || c === OK ? ' ne-act' : ''), SHOW[c] || c));
    view.replaceChildren(el('div', 'name-entry'));
    view.firstChild.append(name, el('div', 'ne-note', this.note));
  }
}
