// The sleep screen (Settings > Sleep Screen): after a while with no input
// while music plays, the screen turns into just the album art on black and
// the wheel dims, like a docked iPod. Any touch or key wakes it, and that
// first touch only wakes it (it doesn't also scroll or press anything).
//
// WHY only on calm screens: menus and Now Playing are fine to cover, but a
// game, TV, Car Mode or Cover Flow is something you're watching or playing.
//
// It doesn't keep the phone awake: the phone's own screen timeout still
// turns the screen off. With a long timeout (or a phone that stays on while
// charging) it's a nightstand display.
import * as api from './api.js';
import { settings } from './settings.js';
import { el } from './util.js';

const AFTER = { s30: 30e3, m2: 120e3 };

export class Sleep {
  // screenEl: #screen. hooks.calm(): true when the screen showing may be
  // covered (ui.js UI.calm plus Car Mode and Cover Flow, main.js).
  constructor(screenEl, player, hooks) {
    this.player = player;
    this.hooks = hooks;
    this.asleep = false;
    this.swallowing = false;
    this.last = Date.now();
    this.songId = null;

    this.root = el('div', 'sleep');
    this.art = el('img', 'sleep-art');
    this.art.alt = '';
    this.art.addEventListener('error', () => this.art.classList.add('missing'));
    this.title = el('div', 'sleep-title');
    this.artist = el('div', 'sleep-artist');
    // The art and text drift inside the black (pod.css); the black itself
    // stays put so the screen underneath never shows at an edge.
    const inner = el('div', 'sleep-in');
    inner.append(this.art, this.title, this.artist);
    this.root.append(inner);
    this.root.hidden = true;
    screenEl.append(this.root);

    // Capture: these run before the wheel's own listeners, so a waking touch
    // can be kept from also doing something (swallow()).
    const input = () => {
      this.last = Date.now();
      if (!this.asleep) return false;
      this.wake();
      return true;
    };
    document.addEventListener('pointerdown', () => { if (input()) this.swallowing = true; }, true);
    // Cleared after the wheel has seen the lift too (its press fires on it).
    const lift = () => { if (this.swallowing) setTimeout(() => { this.swallowing = false; }, 0); };
    document.addEventListener('pointerup', lift, true);
    document.addEventListener('pointercancel', lift, true);
    window.addEventListener('keydown', (e) => {
      if (input()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // A new song changes the art; the music stopping ends the sleep screen.
    player.on((what) => {
      if (what !== 'song' || !this.asleep) return;
      if (player.playing) this.fill(); else this.wake();
    });
    setInterval(() => this.check(), 1000);
  }

  // True while the touch that woke the screen is still down: main.js drops
  // the wheel's turns and presses for it.
  swallow() { return this.swallowing; }

  check() {
    const after = AFTER[settings.get('sleep')];
    if (this.asleep || !after) return;
    const p = this.player;
    if (!p.playing || p.paused || document.hidden || !this.hooks.calm()) { this.last = Date.now(); return; }
    if (Date.now() - this.last >= after) this.sleep();
  }

  sleep() {
    this.asleep = true;
    this.fill();
    this.root.hidden = false;
    document.body.classList.add('asleep');
    this.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: 'ease-out' });
  }

  wake() {
    this.asleep = false;
    this.root.hidden = true;
    document.body.classList.remove('asleep');
  }

  fill() {
    const item = this.player.current;
    if (!item || item.Id === this.songId) return;
    this.songId = item.Id;
    this.art.classList.remove('missing');
    this.art.src = api.artUrl(item, 500);
    this.title.textContent = item.Name;
    this.artist.textContent = api.artistOf(item);
  }
}
