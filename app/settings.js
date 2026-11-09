// Settings, kept per phone in localStorage. Each one has a fixed list of
// values; the Settings menu cycles through them with the center button, the
// way the iPod's Shuffle and Repeat rows did.
import { store } from './util.js';
import { AWAY } from './api.js';
import site from './config.js';
import { bodyOpen } from './bodies.js';

const DEFS = {
  shuffle: { label: 'Shuffle', values: ['off', 'songs'], names: { off: 'Off', songs: 'Songs' }, def: 'off' },
  repeat: { label: 'Repeat', values: ['off', 'one', 'all'], names: { off: 'Off', one: 'One', all: 'All' }, def: 'off' },
  // Away from home (opened over https) defaults to Data saver: people on
  // mobile data and slow connections.
  quality: { label: 'Streaming', values: ['high', 'saver'], names: { high: 'High', saver: 'Data saver' }, def: AWAY ? 'saver' : 'high' },
  clicker: { label: 'Clicker', values: ['on', 'off'], names: { on: 'On', off: 'Off' }, def: 'on' },
  // Light is the 8 ms tick that felt right on a Galaxy Z Flip 6 (a crisp modern
  // vibration motor). Older phones' motors need 20-30 ms just to spin up, so
  // Light can't be felt there at all; Strong is for them.
  haptics: { label: 'Haptics', values: ['light', 'strong', 'off'], names: { light: 'Light', strong: 'Strong', off: 'Off' }, def: 'light' },
  // Wheel and Selection colors (pod.css, main.js applyBody). Original / Blue
  // are the body's own wheel and the iPod's highlight. WHY "Original" and
  // not "Matching": the real Silver, Blue and Red iPods had white wheels, and
  // a tester read Matching as "a blue wheel on a blue body" (2026-11-09). Wheel is ignored on the prize bodies.
  wheel: {
    label: 'Wheel', values: ['body', 'white', 'black', 'red', 'blue', 'green', 'purple'],
    names: { body: 'Original', white: 'White', black: 'Black', red: 'Red', blue: 'Blue', green: 'Green', purple: site.purpleName },
    def: 'body',
  },
  accent: {
    label: 'Selection', values: ['blue', 'green', 'purple', 'red', 'orange', 'graphite'],
    names: { blue: 'Blue', green: 'Green', purple: site.purpleName, red: 'Red', orange: 'Orange', graphite: 'Graphite' },
    def: 'blue',
  },
  // The screen's colors (main.js applyScreen, pod.css "dark screen").
  // Scheduled: dark between darkFrom and darkTo, set by the person ('night'
  // is its key: it was At Night, fixed 8 PM-7 AM, before 0.24.2; fixed hours
  // don't suit someone who works nights). Match Phone follows the phone's
  // own dark mode.
  screen: {
    label: 'Screen', values: ['light', 'dark', 'night', 'phone'],
    names: { light: 'Light', dark: 'Dark', night: 'Scheduled', phone: 'Match Phone' }, def: 'light',
  },
  darkFrom: { label: 'Starts', ...quarterHours(), def: '20:00' },
  darkTo: { label: 'Ends', ...quarterHours(), def: '07:00' },
  // How long with no input, while music plays, before the Art Screen
  // (sleep.js). The key is still 'sleep': it was called Sleep Screen in 0.21,
  // and renaming the key would lose people's choice.
  sleep: {
    label: 'Art Screen', values: ['off', 's30', 'm2'],
    names: { off: 'Off', s30: '30 Seconds', m2: '2 Minutes' }, def: 'off',
  },
  // Sleep Mode, the dim clock (sleep.js): by hand only (hold Play/Pause, or
  // Sleep in the main menu), or also on its own between two times. Off by
  // default. 'night' is the key for Scheduled (it was At Night, fixed hours,
  // before 0.24.1); the hours are Starts and Ends below, set by the person
  // (Colton works nights, 2026-11-09).
  sleepMode: {
    label: 'Sleep Mode', values: ['off', 'hand', 'night'],
    names: { off: 'Off', hand: 'By Hand', night: 'Scheduled' }, def: 'off',
  },
  sleepFrom: { label: 'Starts', ...quarterHours(), def: '22:00' },
  sleepTo: { label: 'Ends', ...quarterHours(), def: '07:00' },
  // The gold bodies and the clear case are prizes from the games (bodies.js):
  // they're only offered once open.
  body: {
    label: 'Body',
    values: ['silver', 'black', 'blue', 'red', 'purple', 'gold-pinball', 'gold-golf', 'gold-fish', 'clear'],
    names: { silver: 'Silver', black: 'Black', blue: 'Blue', red: 'Red', purple: site.purpleName,
      'gold-pinball': 'Gold Pinball', 'gold-golf': 'Gold Golf', 'gold-fish': 'Gold Fishing', clear: 'Clear' },
    open: bodyOpen,
    def: 'silver',
  },
};

// Every quarter hour of the day as a setting's values ('HH:MM', 24-hour, so
// they sort and compare), shown in the phone's own clock style ("10:00 PM").
// A function declaration, so DEFS above can use it before this line.
function quarterHours() {
  const values = [];
  const names = {};
  for (let m = 0; m < 1440; m += 15) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    values.push(v);
    names[v] = new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return { values, names };
}

// Minutes after midnight for an 'HH:MM' value.
export const minutesOf = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

// Whether now is between two quarter-hour settings (Sleep Mode's and the dark
// screen's Starts and Ends). Hours that cross midnight wrap; Starts equal to
// Ends means never.
export function inHours(fromKey, toKey) {
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  const from = minutesOf(settings.get(fromKey));
  const to = minutesOf(settings.get(toKey));
  return from < to ? now >= from && now < to : from > to && (now >= from || now < to);
}

export const BITRATE = { high: 320000, saver: 128000 };

export const settings = {
  defs: DEFS,
  get(k) {
    const v = store.get('fp.set.' + k);
    return DEFS[k].values.includes(v) && (DEFS[k].open?.(v) ?? true) ? v : DEFS[k].def;
  },
  set(k, v) { store.set('fp.set.' + k, v); },
  // dir 1 is on to the next value, -1 back; either way it wraps round.
  cycle(k, dir = 1) {
    const vals = DEFS[k].values.filter((v) => DEFS[k].open?.(v) ?? true);
    const v = vals[(vals.indexOf(this.get(k)) + dir + vals.length) % vals.length];
    this.set(k, v);
    return v;
  },
  name(k) { return DEFS[k].names[this.get(k)]; },
};
