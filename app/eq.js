// EQ and crossfeed (Settings > EQ, Settings > Crossfeed), from RepriseOS, the
// iPod Classic firmware mod (2026-11-25).
//
// The phone's <audio> element is run through Web Audio: a preamp (the
// precut), ten peaking filters like iTunes' graphic EQ, then crossfeed. Only
// the phone's own playback; a Sonos has its own EQ in the Sonos app.
//
// WHY it waits for a running AudioContext before taking the audio: once an
// element is given to Web Audio (createMediaElementSource) it can't be taken
// back, and a context the browser holds suspended (no tap yet, the autoplay
// rule) passes on silence. So nothing is rerouted until the context says
// it's running, and nothing at all happens until EQ or Crossfeed is turned on.
//
// WHY not on iPhone: Safari suspends Web Audio when the phone locks, so the
// music would go quiet with the screen off. Basic mode (a plain <audio> from
// Jellyfin's address, player.js) is left alone too: audio from another
// address reaches Web Audio as silence.
import { settings } from './settings.js';
import { log, store } from './util.js';

export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const Q = 1.41;                    // an octave wide, like a 10-band graphic EQ
export const GAIN_MAX = 12;        // dB, either way, for Custom

// dB per band. The shapes of iTunes' and the iPod's presets, by ear and
// common description, not copied numbers.
export const PRESETS = {
  acoustic: [4, 4, 3, 1, 1.5, 1, 2.5, 3, 2.5, 1.5],
  bassBoost: [5.5, 4.5, 3.5, 2.5, 1, 0, 0, 0, 0, 0],
  bassCut: [-5.5, -4.5, -3.5, -2.5, -1, 0, 0, 0, 0, 0],
  classical: [4.5, 3.5, 3, 2.5, -1.5, -1.5, 0, 2, 3, 3.5],
  dance: [3.5, 6.5, 5, 0, 2, 3.5, 5, 4.5, 3.5, 0],
  deep: [5, 3.5, 1.5, 1, 3, 2.5, 1.5, -2, -3.5, -4.5],
  electronic: [4, 3.5, 1, 0, -2, 2, 1, 1, 4, 5],
  hipHop: [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
  jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 3.5],
  latin: [4.5, 3, 0, 0, -1.5, -1.5, -1.5, 0, 3, 4.5],
  loudness: [6, 4, 0, 0, -2, 0, -1, -5, 5, 1],
  lounge: [-3, -1.5, -0.5, 1.5, 4, 2.5, 0, -1.5, 2, 1],
  piano: [3, 2, 0, 2.5, 3, 1.5, 3.5, 4.5, 3, 3.5],
  pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
  rnb: [2.5, 7, 5.5, 1.5, -2.5, -1.5, 2.5, 3, 3, 3.5],
  rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5],
  smallSpeakers: [5.5, 4, 3.5, 2.5, 1, 0, -1, -2, -3, -4],
  spokenWord: [-3.5, -0.5, 0, 0.5, 3.5, 4.5, 4, 2, 0, -3],
  trebleBoost: [0, 0, 0, 0, 0, 1, 2.5, 3.5, 4.5, 5.5],
  trebleCut: [0, 0, 0, 0, 0, -1, -2.5, -3.5, -4.5, -5.5],
  vocal: [-1.5, -3, -3, 1.5, 3.5, 3.5, 3, 1.5, 0, -1.5],
};

const CUSTOM_KEY = 'fp.eq.custom';
export function customGains() {
  let g = null;
  try { g = JSON.parse(store.get(CUSTOM_KEY)); } catch { g = null; }
  return Array.isArray(g) && g.length === BANDS.length && g.every((x) => typeof x === 'number')
    ? g.map((x) => Math.max(-GAIN_MAX, Math.min(GAIN_MAX, x))) : BANDS.map(() => 0);
}
export function setCustomGains(g) { store.set(CUSTOM_KEY, JSON.stringify(g)); }

// The gains Settings > EQ picks, or null for Off.
export function chosenGains() {
  const k = settings.get('eq');
  if (k === 'off') return null;
  if (k === 'custom') return customGains();
  return PRESETS[k] || null;
}

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const IOS = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
// Whether Settings offers EQ here at all (ui.js).
export const EQ_WORKS = !!Ctx && !IOS;

// Crossfeed, after Jan Meier's idea (as in Rockbox and RepriseOS): each ear
// also gets the other channel, low-passed and a fraction of a millisecond
// late, the way a speaker across the room would reach it. Hard-panned
// stereo stops sounding like it's inside your head. DIRECT + CROSS = 1 so
// bass (which both paths carry) stays the same level.
const CROSS = 0.28;
const DIRECT = 1 - CROSS;
const CROSS_HZ = 700;
const CROSS_DELAY = 0.0003;

export class Eq {
  // player: the phone's Player (player.js); its <audio> element is player.el.
  constructor(player) {
    this.player = player;
    this.ctx = null;
    this.g = null;             // the graph, once the audio is ours
    this.silentTicks = 0;
    if (!EQ_WORKS) return;
    window.addEventListener('fp-setting', (e) => {
      if (['eq', 'crossfeed'].includes(e.detail)) this.apply();
    });
    // The autoplay rule: a context can only start on a tap or key. Any one
    // will do, so keep trying on each until it runs.
    const kick = () => { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, kick, true);
    player.el.addEventListener('play', kick);
    player.on((what) => { if (what === 'tick') this.tick(); });
    this.apply();
  }

  get wanted() { return EQ_WORKS && (chosenGains() !== null || settings.get('crossfeed') === 'on'); }

  // Settings changed (or startup): build what's needed, then set it.
  apply() {
    if (!this.wanted && !this.g) return;            // never used: leave the audio alone
    if (!this.ctx) {
      try {
        this.ctx = new Ctx({ latencyHint: 'playback' });
      } catch (e) { log(`eq: no audio context (${e.message})`); return; }
      this.ctx.addEventListener('statechange', () => {
        log(`eq: audio ${this.ctx.state}`);
        if (this.ctx.state === 'running') this.take();
      });
      this.ctx.resume().catch(() => {});
    }
    if (this.ctx.state === 'running') this.take();
    this.set();
  }

  // Reroutes the <audio> through the filters. Once only, and only into a
  // running context (see the top).
  take() {
    if (this.g || !this.wanted || this.ctx.state !== 'running' || this.player.basic) return;
    const c = this.ctx;
    let src;
    try { src = c.createMediaElementSource(this.player.el); } catch (e) { log(`eq: ${e.message}`); return; }
    const pre = c.createGain();
    // Mono songs come out on both sides, so crossfeed's splitter has two to split.
    pre.channelCount = 2;
    pre.channelCountMode = 'explicit';
    pre.channelInterpretation = 'speakers';
    const filters = BANDS.map((f) => {
      const b = c.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = f;
      b.Q.value = Q;
      b.gain.value = 0;
      return b;
    });
    src.connect(pre);
    let last = pre;
    for (const b of filters) { last.connect(b); last = b; }
    // Crossfeed: L and R each split into a direct path and a crossed path
    // (low-passed, delayed) to the other side. Off = crossed paths at 0.
    const split = c.createChannelSplitter(2);
    const merge = c.createChannelMerger(2);
    last.connect(split);
    const direct = [0, 1].map(() => c.createGain());
    const cross = [0, 1].map((ch) => {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = CROSS_HZ;
      lp.Q.value = 0.5;
      const d = c.createDelay(0.01);
      d.delayTime.value = CROSS_DELAY;
      const g = c.createGain();
      split.connect(lp, ch);
      lp.connect(d).connect(g);
      g.connect(merge, 0, 1 - ch);
      return g;
    });
    direct.forEach((g, ch) => { split.connect(g, ch); g.connect(merge, 0, ch); });
    // Taps the output to tell real silence from a quiet song (tick()).
    const meter = c.createAnalyser();
    meter.fftSize = 2048;
    merge.connect(c.destination);
    merge.connect(meter);
    this.g = { pre, filters, direct, cross, meter, buf: new Float32Array(meter.fftSize) };
    log('eq: audio goes through EQ now');
    this.set();
  }

  set() {
    const g = this.g;
    if (!g) return;
    const gains = chosenGains() || BANDS.map(() => 0);
    gains.forEach((db, i) => { g.filters[i].gain.value = db; });
    const cf = settings.get('crossfeed') === 'on';
    g.direct.forEach((d) => { d.gain.value = cf ? DIRECT : 1; });
    g.cross.forEach((x) => { x.gain.value = cf ? CROSS : 0; });
    // Precut, like RepriseOS's Auto: lower the whole thing by the curve's
    // highest boost, so a boosted band can't push a loud song into clipping.
    const peak = Math.max(0, peakBoost(g.filters));
    g.pre.gain.value = Math.pow(10, -(peak + (peak ? 0.5 : 0)) / 20);
    this.precut = peak ? -(peak + 0.5) : 0;
  }

  // The combined curve in dB at n points from 20 Hz to 20 kHz (the Custom EQ
  // screen's picture). Without a context yet, worked out from the gains alone
  // by a context made just for that.
  static curve(gains, n = 64) {
    const freqs = new Float32Array(n);
    for (let i = 0; i < n; i++) freqs[i] = 20 * Math.pow(1000, i / (n - 1));
    const c = curveCtx();
    if (!c) return Array.from(freqs, () => 0);
    const filters = BANDS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = 'peaking'; b.frequency.value = f; b.Q.value = Q; b.gain.value = gains[i];
      return b;
    });
    return respond(filters, freqs);
  }

  // Once a second (the player's tick): logs when the EQ's output has been silent for
  // 10 s while the music plays, the failure the screen-off test looks for.
  tick() {
    const g = this.g;
    if (!g) return;
    const playing = !this.player.el.paused && this.player.playing;
    if (!playing) { this.silentTicks = 0; return; }
    g.meter.getFloatTimeDomainData(g.buf);
    let sum = 0;
    for (const x of g.buf) sum += x * x;
    const rms = Math.sqrt(sum / g.buf.length);
    this.lastRms = rms;
    if (rms > 1e-5) { this.silentTicks = 0; return; }
    if (++this.silentTicks === 10) log(`eq: 10 s of silence while playing (audio ${this.ctx.state}, volume ${this.player.el.volume})`);
  }
}

let offline = null;
function curveCtx() {
  if (offline) return offline;
  const O = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  try { offline = O ? new O(1, 128, 44100) : null; } catch { offline = null; }
  return offline;
}

function respond(filters, freqs) {
  const total = new Float32Array(freqs.length);
  const mag = new Float32Array(freqs.length);
  const ph = new Float32Array(freqs.length);
  for (const b of filters) {
    b.getFrequencyResponse(freqs, mag, ph);
    for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(mag[i] || 1e-9);
  }
  return Array.from(total);
}

function peakBoost(filters) {
  const n = 200;
  const freqs = new Float32Array(n);
  for (let i = 0; i < n; i++) freqs[i] = 20 * Math.pow(1000, i / (n - 1));
  return Math.max(...respond(filters, freqs));
}
