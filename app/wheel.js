// The click wheel: turning, the four buttons on the ring (MENU, next, play,
// previous), the center button, and press-and-hold on the ring buttons and center.
//
// Turning: the finger's angle around the center (atan2); every TICK of travel
// is one step. 24 steps per turn passed the thumb test on a real phone.
// A touch on the ring that barely turns counts as a button press, decided by
// where it started: top quarter MENU, right next, bottom play, left previous.
//
// On a computer the same controls come from the keyboard and the mouse wheel
// (keys()), so Fretzpod works in a desktop browser without dragging the ring.

import { log } from './util.js';

const TICK = (2 * Math.PI) / 24;
const TAP_SLOP = 0.18;     // radians (~10°) of turning before a touch stops being a press
const HOLD_MS = 450;       // press-and-hold threshold (fast-forward / rewind)
const HOLD_REPEAT_MS = 180;
const SCROLL_PX = 50;      // scroll distance per wheel step: about 2 per mouse notch, smooth on trackpads

// Keyboard layout, iPod-style: arrows up/down turn, left/right are previous/
// next, Enter is the center button, Space play/pause, Esc or Backspace MENU.
const KEYS = {
  ArrowUp: -1, ArrowDown: 1,
  ArrowLeft: 'prev', ArrowRight: 'next', Enter: 'select', ' ': 'play', Escape: 'menu', Backspace: 'menu',
};

// Keeps getting moves after the finger slides off the element. Can throw for
// pointers the browser doesn't consider active (synthetic test events).
function capture(target, id) {
  try { target.setPointerCapture(id); } catch { /* not fatal */ }
}

export class Wheel {
  // handlers: turn(dir), press(button), hold(button), holdEnd(button)
  // prefs: clicker() says whether the click sound is on; haptics() gives the
  // vibration level ('light' | 'strong' | 'off')
  constructor(ring, center, handlers, prefs) {
    this.ring = ring;
    this.center = center;
    this.h = handlers;
    this.prefs = prefs;
    this.audio = null;
    this.clickBuf = null;
    this.touch = null;
    ring.addEventListener('pointerdown', (e) => this.down(e));
    ring.addEventListener('pointermove', (e) => this.move(e));
    ring.addEventListener('pointerup', (e) => this.up(e, false));
    ring.addEventListener('pointercancel', (e) => this.up(e, true));
    // Center press-and-hold (Now Playing: favorite the song). Only screens
    // that use it take it: hold() says whether it did, and anywhere else a
    // slow press still counts as a press when it's let go.
    let centerHold = null;
    let centerHeld = false;
    center.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.unlockAudio();
      center.classList.add('pressed');
      capture(center, e.pointerId);
      centerHeld = false;
      clearTimeout(centerHold);
      centerHold = setTimeout(() => {
        if (this.h.hold('select') === true) { centerHeld = true; this.feedback(true); }
      }, HOLD_MS);
    });
    center.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      clearTimeout(centerHold);
      center.classList.remove('pressed');
      if (centerHeld) return;
      const r = center.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) { this.feedback(true); this.h.press('select'); }
    });
    center.addEventListener('pointercancel', () => { clearTimeout(centerHold); center.classList.remove('pressed'); });
    // A long press would otherwise open the browser's context menu.
    ring.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Keyboard and mouse wheel. A key held past HOLD_MS acts like holding the
  // button (fast-forward, favorite), released sooner it's a press, the same
  // rule as a thumb on the ring. Skipped while typing in a form (password
  // sign-in) or with Ctrl/Cmd/Alt down, so browser shortcuts still work.
  keys(scrollArea) {
    const held = new Map();   // key -> {timer, holding}
    const typing = (e) => e.target.closest?.('input, textarea, select, button');
    window.addEventListener('keydown', (e) => {
      const k = KEYS[e.key];
      if (k === undefined || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      e.preventDefault();
      this.unlockAudio();
      if (typeof k === 'number') { this.h.turn(k); return; }
      if (e.repeat || held.has(e.key)) return;   // auto-repeat: the hold timer handles it
      const h = { holding: false, timer: null };
      held.set(e.key, h);
      h.timer = setTimeout(() => {
        if (k === 'select') {
          if (this.h.hold('select') === true) { h.holding = true; this.feedback(true); }
          return;
        }
        h.holding = true;
        this.feedback(true);
        this.h.hold(k);
        h.timer = setInterval(() => this.h.hold(k), HOLD_REPEAT_MS);
      }, HOLD_MS);
    });
    window.addEventListener('keyup', (e) => {
      const h = held.get(e.key);
      if (!h) return;
      held.delete(e.key);
      clearTimeout(h.timer);
      clearInterval(h.timer);
      const k = KEYS[e.key];
      if (h.holding) { if (k !== 'select') this.h.holdEnd(k); return; }
      this.feedback(true);
      this.h.press(k);
    });
    // Window lost focus mid-hold (alt-tab): let go so nothing keeps seeking.
    window.addEventListener('blur', () => {
      for (const [key, h] of held) {
        clearTimeout(h.timer);
        clearInterval(h.timer);
        if (h.holding && KEYS[key] !== 'select') this.h.holdEnd(KEYS[key]);
      }
      held.clear();
    });
    // Scrolling turns the wheel; trackpads send many small deltas, so they add
    // up to one step per SCROLL_PX. Lines/pages (deltaMode 1/2) step directly.
    let acc = 0;
    scrollArea.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;   // pinch zoom
      e.preventDefault();
      if (e.deltaMode) { this.h.turn(Math.sign(e.deltaY)); return; }
      acc += e.deltaY;
      while (Math.abs(acc) >= SCROLL_PX) {
        const dir = Math.sign(acc);
        acc -= dir * SCROLL_PX;
        this.h.turn(dir);
      }
    }, { passive: false });
  }

  angle(e) {
    const r = this.ring.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }

  sector(a) {
    const deg = (a * 180) / Math.PI;           // screen coordinates: -90 is up
    if (deg >= -135 && deg < -45) return 'menu';
    if (deg >= -45 && deg < 45) return 'next';
    if (deg >= 45 && deg < 135) return 'play';
    return 'prev';
  }

  down(e) {
    if (e.target === this.center || this.center.contains(e.target)) return;
    this.unlockAudio();
    capture(this.ring, e.pointerId);
    const a = this.angle(e);
    const t = { id: e.pointerId, last: a, acc: 0, turned: 0, button: this.sector(a), holding: false, timer: null };
    t.timer = setTimeout(() => {
      if (this.touch !== t || t.turned > TAP_SLOP) return;
      t.holding = true;
      this.ring.classList.add('pressed-' + t.button);
      this.feedback(true);
      this.h.hold(t.button);
      t.timer = setInterval(() => this.h.hold(t.button), HOLD_REPEAT_MS);
    }, HOLD_MS);
    this.touch = t;
  }

  move(e) {
    const t = this.touch;
    if (!t || t.id !== e.pointerId || t.holding) return;
    const a = this.angle(e);
    let d = a - t.last;
    if (d > Math.PI) d -= 2 * Math.PI;         // crossed the ±180° seam
    if (d < -Math.PI) d += 2 * Math.PI;
    t.last = a;
    t.turned += Math.abs(d);
    if (t.turned <= TAP_SLOP) return;          // still could be a press
    t.acc += d;
    while (Math.abs(t.acc) >= TICK) {
      const dir = Math.sign(t.acc);
      t.acc -= dir * TICK;
      this.h.turn(dir);
    }
  }

  up(e, cancelled) {
    const t = this.touch;
    if (!t || t.id !== e.pointerId) return;
    clearTimeout(t.timer);
    clearInterval(t.timer);
    this.touch = null;
    this.ring.classList.remove('pressed-' + t.button);
    if (t.holding) { this.h.holdEnd(t.button); return; }
    if (cancelled || t.turned > TAP_SLOP) return;
    this.ring.classList.add('pressed-' + t.button);
    setTimeout(() => this.ring.classList.remove('pressed-' + t.button), 120);
    this.feedback(true);
    this.h.press(t.button);
  }

  // Browsers only let audio start from a touch, so the click sound's audio
  // context is created on the first one. The click is ~4 ms of decaying noise,
  // played through Web Audio because an <audio> element per click lags.
  unlockAudio() {
    if (this.audio) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audio = new Ctx();
    const n = Math.floor(this.audio.sampleRate * 0.004);
    this.clickBuf = this.audio.createBuffer(1, n, this.audio.sampleRate);
    const d = this.clickBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3) * 0.5;
  }

  // Called by the UI when something actually moved (so the ends of a list are
  // silent, like the iPod), and by the wheel itself for button presses.
  feedback(press = false) {
    if (this.prefs.clicker() && this.audio) {
      if (this.audio.state === 'suspended') this.audio.resume();
      const src = this.audio.createBufferSource();
      src.buffer = this.clickBuf;
      src.connect(this.audio.destination);
      src.start();
    }
    const level = this.prefs.haptics();
    if (level !== 'off' && navigator.vibrate) {
      const ok = navigator.vibrate(level === 'strong' ? (press ? 40 : 25) : (press ? 14 : 8));
      // vibrate() returns false when the browser refuses (no tap on the page
      // yet, page hidden, ...). Logged once per run so Settings > About > Log
      // can tell "Chrome refused" apart from "Chrome accepted but the phone
      // didn't buzz" (2026-10-23, Flip 6 went quiet).
      if (ok !== this.lastVibrate) {
        log(ok ? 'vibrate accepted' : 'vibrate refused by browser');
        this.lastVibrate = ok;
      }
    }
  }
}
