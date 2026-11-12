// Small shared helpers: storage that never throws, DOM building, time
// formatting, ids, events, the canvas games' frame loop, and an app log kept
// in localStorage (Settings > About > Log) so a problem during a pocket
// listen can be read afterwards. The log stays on the phone, holds no song
// names, and Sign Out wipes it.

// localStorage can throw (private mode, blocked storage); the app must still work.
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not fatal */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* not fatal */ } },
};

// Builds an element. Text always goes in as text, never HTML: song titles and
// artist names come from files, and a tag in a file name must not run.
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

export function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// crypto.randomUUID only exists on https pages; getRandomValues works on the
// plain-http home copy too.
export function newId(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Jellyfin merges genres whatever their capitals and keeps the spelling it met
// first, often a lowercase one from its online album lookups ("comedy" for the
// songs' "Comedy"). An all-lowercase name gets capitals back for display.
export const prettyGenre = (name) => (name !== name.toLowerCase() ? name
  : name.replace(/(^|[\s\-&])([a-z])/g, (m, sep, c) => sep + c.toUpperCase()).replace(/\bR&b\b/g, 'R&B'));

// on(fn) / emit(what), for the players and Output (speakers.js).
export class Emitter {
  constructor() { this.listeners = new Set(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }
}

// ---------- canvas games (Star Pinball, Fishing Trip, Tiki Golf) ----------

export const canvasFont = (px, weight = 700) => `${weight} ${Math.round(px)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

// Matches the canvas's pixels to its size on screen at the phone's pixel
// density. Returns what a frame draws with ({g, w, h} in CSS pixels, and
// dpr), or null while the canvas has no size (mid-slide, hidden).
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  return { g: cv.getContext('2d'), w, h, dpr };
}

// Puts the game's canvas in the view (once; a later render into the same
// view leaves it be) and runs game.step(dt) and game.draw(frame) every
// frame while the game is the top screen (frame: fitCanvas above). The loop
// is this function's alone: it stops itself the first frame the game isn't
// on top, so games don't cancel it. dt is capped at 50 ms, so a stalled tab
// doesn't jump the game ahead. A paused game still gets frames; its step()
// just does nothing.
export function runCanvas(game, view) {
  if (game.canvas && view.contains(game.canvas)) return;
  view.replaceChildren();
  view.classList.remove('split');
  game.canvas = el('canvas', 'game');
  view.append(game.canvas);
  cancelAnimationFrame(game.raf);
  let last = performance.now();
  const loop = (t) => {
    if (game.ui.top !== game) { game.raf = 0; return; }
    game.step(Math.min(0.05, (t - last) / 1000));
    last = t;
    const frame = fitCanvas(game.canvas);
    if (frame) game.draw(frame);
    game.raf = requestAnimationFrame(loop);
  };
  game.raf = requestAnimationFrame(loop);
}

// ---------- the app log ----------

const LOG_KEY = 'fp.applog';
let lines = store.get(LOG_KEY, '').split('\n').filter(Boolean);

export function log(msg) {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  lines.push(`${t} ${msg}`);
  if (lines.length > 300) lines = lines.slice(-300);
  store.set(LOG_KEY, lines.join('\n'));
  console.info('[fretzpod]', msg);
}

export const logLines = () => lines.slice().reverse();

// Sign Out wipes the log, so nothing of a person's use stays on the phone.
export function clearLog() { lines = []; store.del(LOG_KEY); }
// " (screen off)" while the page is hidden, else "": tacked onto log lines,
// since screen-off playback is what the log is mostly for.
export const screenOffNote = () => (document.visibilityState === 'hidden' ? ' (screen off)' : '');

// Vibration, three ways:
// - Inside the Android app (android/), the page gets a native hook,
//   FretzpodAndroid, that drives the phone's vibrator directly.
// - In Chrome on Android, the Vibration API. Firefox ignores it.
// - On iPhone, Safari has no Vibration API, but since iOS 18 toggling a
//   switch-style checkbox (<input type=checkbox switch>) gives the system's
//   haptic tick, and clicking its label does too. So a tick is a click on a
//   hidden one. Untested on a real iPhone: iOS may only allow it during a
//   tap, not a finger sliding round the wheel (see DESIGN.md, "iPhone").
const nativeShell = typeof window !== 'undefined' ? window.FretzpodAndroid : undefined;
export const inAndroidApp = !!nativeShell;
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
// iPadOS says it's a Mac; touch points give it away.
const ios = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
// The switch's haptic arrived in iOS 18 (the version in the user agent stays
// 18 on later ones). Not feature-tested: an iOS 17 switch exists but is silent.
const iosMajor = +((ua.match(/OS (\d+)_/) || ua.match(/Version\/(\d+)/) || [])[1] || 0);
const iosSwitch = ios && iosMajor >= 18;
export const canVibrate = inAndroidApp || iosSwitch
  || (typeof navigator !== 'undefined' && !!navigator.vibrate && !/Firefox\//.test(ua));

let tickLabel = null;
function iosTick() {
  if (!tickLabel) {
    tickLabel = document.createElement('label');
    tickLabel.hidden = true;
    tickLabel.setAttribute('aria-hidden', 'true');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('switch', '');
    box.tabIndex = -1;
    tickLabel.appendChild(box);
    document.head.appendChild(tickLabel);
  }
  tickLabel.click();
}

export function vibrate(pattern) {
  if (nativeShell) {
    try { nativeShell.vibrate(JSON.stringify([].concat(pattern))); return true; } catch { return false; }
  }
  if (iosSwitch) {
    // The tick has one strength, so a pattern becomes one tick per buzz
    // ([14, 70, 14] is two ticks 84 ms apart).
    const p = [].concat(pattern);
    try {
      iosTick();
      for (let i = 2, at = p[0] + (p[1] || 0); i < p.length; i += 2, at += p[i - 2] + (p[i - 1] || 0)) {
        setTimeout(iosTick, at);
      }
      return true;
    } catch { return false; }
  }
  return navigator.vibrate ? navigator.vibrate(pattern) : false;
}
