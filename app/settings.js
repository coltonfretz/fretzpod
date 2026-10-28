// Settings, kept per phone in localStorage. Each one has a fixed list of
// values; the Settings menu cycles through them with the center button, the
// way the iPod's Shuffle and Repeat rows did.
import { store } from './util.js';
import { AWAY } from './api.js';
import site from './config.js';

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
  body: { label: 'Body', values: ['silver', 'black', 'blue', 'red', 'purple'], names: { silver: 'Silver', black: 'Black', blue: 'Blue', red: 'Red', purple: site.purpleName }, def: 'silver' },
};

export const BITRATE = { high: 320000, saver: 128000 };

export const settings = {
  defs: DEFS,
  get(k) {
    const v = store.get('fp.set.' + k);
    return DEFS[k].values.includes(v) ? v : DEFS[k].def;
  },
  set(k, v) { store.set('fp.set.' + k, v); },
  cycle(k) {
    const vals = DEFS[k].values;
    const v = vals[(vals.indexOf(this.get(k)) + 1) % vals.length];
    this.set(k, v);
    return v;
  },
  name(k) { return DEFS[k].names[this.get(k)]; },
};
