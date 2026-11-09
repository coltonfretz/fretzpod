// Two ways the screen rests, and keeping it on while it should be.
//
// Art Screen (Settings > Art Screen): after a while with no input while music
// plays, the iPod screen turns into just the album art on black and the
// wheel dims, like a docked iPod.
//
// Sleep Mode (Settings > Sleep Mode): the whole phone screen goes black with
// only the time on it in dim gray, the way a phone looks in the moment before
// its screen shuts off, and stays like that (a nightstand clock). The music
// keeps playing. By hand: hold Play/Pause (like switching the old iPod off)
// or pick Sleep in the main menu. At Night: also on its own from 10 PM to
// 7 AM after a minute with no input.
//
// Any touch or key wakes either one, and that first touch only wakes it (it
// doesn't also scroll or press anything).
//
// WHY a wake lock: the phone's own screen timeout would turn the screen off
// long before a clock is any use (and it did, mid-lyrics, Colton 2026-11-09).
// The screen is kept on while Sleep Mode shows, through the night hours with
// At Night, and while the lyrics are up. Browsers only allow it on https, so
// the home http copy still times out.
//
// WHY only on calm screens: menus and Now Playing are fine to cover, but a
// game, TV, Car Mode, Cover Flow sideways or lyrics being read are not.
import * as api from './api.js';
import { settings } from './settings.js';
import { el, log } from './util.js';

const ART_AFTER = { s30: 30e3, m2: 120e3 };
const CLOCK_AFTER = 60e3;           // At Night: a minute with no input
const NIGHT_FROM = 22;              // 10 PM
const NIGHT_TO = 7;                 // 7 AM
const CLOCK_MOVE_MS = 60e3;         // the time moves a little each minute (burn-in)

const atNight = () => { const h = new Date().getHours(); return h >= NIGHT_FROM || h < NIGHT_TO; };

export class Sleep {
  // screenEl: #screen. hooks.calm(): the screen showing may be covered
  // (ui.js UI.calm plus Car Mode and Cover Flow, main.js). hooks.reading():
  // lyrics are up while music plays.
  constructor(screenEl, player, hooks) {
    this.player = player;
    this.hooks = hooks;
    this.asleep = false;          // Art Screen up
    this.clockOn = false;         // Sleep Mode up
    this.swallowing = false;
    this.last = Date.now();
    this.songId = null;
    this.lock = null;

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

    // Sleep Mode covers the whole page, not only the iPod screen.
    this.clock = el('div', 'clock');
    this.clockTime = el('div', 'clock-time');
    this.clock.append(this.clockTime);
    this.clock.hidden = true;
    document.body.append(this.clock);

    // Capture: these run before the wheel's own listeners, so a waking touch
    // can be kept from also doing something (swallow()).
    const input = () => {
      this.last = Date.now();
      if (!this.asleep && !this.clockOn) return false;
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

    // A new song changes the art; the music stopping ends the Art Screen
    // (Sleep Mode stays: it's a clock, music or not).
    player.on((what) => {
      if (what !== 'song' || !this.asleep) return;
      if (player.playing) this.fill(); else this.wake();
    });
    // The browser drops the wake lock when the page is hidden; ask again on return.
    document.addEventListener('visibilitychange', () => { this.refused = false; this.syncLock(); });
    setInterval(() => this.check(), 1000);
  }

  // True while the touch that woke the screen is still down: main.js drops
  // the wheel's turns and presses for it.
  swallow() { return this.swallowing; }

  check() {
    this.syncLock();
    if (this.clockOn) { this.tickClock(); return; }
    if (document.hidden || !this.hooks.calm()) { this.last = Date.now(); return; }
    const idle = Date.now() - this.last;
    if (settings.get('sleepMode') === 'night' && atNight() && idle >= CLOCK_AFTER) { this.showClock(); return; }
    const p = this.player;
    const after = ART_AFTER[settings.get('sleep')];
    if (!this.asleep && after && p.playing && !p.paused && idle >= after) this.sleep();
  }

  // ---------- Art Screen ----------

  sleep() {
    this.asleep = true;
    this.fill();
    this.root.hidden = false;
    document.body.classList.add('asleep');
    this.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: 'ease-out' });
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

  // ---------- Sleep Mode ----------

  // Hold Play/Pause or Sleep in the main menu (main.js), or At Night on its own.
  showClock() {
    if (this.clockOn || settings.get('sleepMode') === 'off') return;
    this.clockOn = true;
    this.movedAt = 0;
    this.clock.hidden = false;      // shown first, so tickClock can measure the digits
    this.tickClock();
    this.clock.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease-out' });
    this.syncLock();
  }

  tickClock() {
    this.clockTime.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    // A new spot each minute, anywhere in the middle of the screen, so a
    // night of it doesn't burn the digits into one place.
    if (Date.now() - this.movedAt < CLOCK_MOVE_MS) return;
    this.movedAt = Date.now();
    // Within the room the digits leave on this screen, so they never run off
    // an edge (a phone upright leaves little room side to side).
    const t = this.clockTime;
    const roomX = Math.max(0, (innerWidth - t.offsetWidth) / 2 - 12);
    const roomY = Math.max(0, (innerHeight - t.offsetHeight) / 2 - 24);
    const x = (Math.random() * 2 - 1) * roomX;
    const y = (Math.random() * 2 - 1) * roomY * 0.6;
    t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------- both ----------

  wake() {
    this.asleep = false;
    this.root.hidden = true;
    document.body.classList.remove('asleep');
    this.clockOn = false;
    this.clock.hidden = true;
    this.syncLock();
  }

  async syncLock() {
    const night = settings.get('sleepMode') === 'night' && atNight() && this.hooks.calm();
    const want = !document.hidden && (this.clockOn || night || this.hooks.reading());
    if (!want) {
      if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
      this.refused = false;     // the next time it's wanted, ask again
      return;
    }
    // refused: the browser said no (battery saver, a page not in front);
    // asked once until the page is hidden and shown again, not every second.
    if (this.lock || this.locking || this.refused || !('wakeLock' in navigator)) return;
    this.locking = true;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch (e) {
      this.refused = true;
      log(`wake lock: ${e.name}`);
    }
    this.locking = false;
  }
}
