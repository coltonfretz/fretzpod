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
