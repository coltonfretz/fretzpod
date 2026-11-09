// Extras > Alarms, like the iPod Classic's: an alarm that wakes you with
// music, and a sleep timer that stops the music.
//
// Sleep timer: 15 minutes to 2 hours, or the end of the song playing. The
// phone fades the music out over FADE_MS and then pauses (and puts the
// volume back, so the next play isn't silent); a speaker just pauses (a fade
// would mean a stream of volume changes to the Sonos).
//
// Alarm: one alarm, at a time set in 5-minute steps, once or every day,
// playing Shuffle Songs, Favorites or a playlist, starting quiet and rising.
//
// WHY the alarm only rings with Fretzpod open and the screen on: a web page
// can't wake a phone, and Android won't let a page start sound once the
// screen is off (DESIGN.md "Playback"). So it's for the nightstand: Fretzpod
// left open, phone on the charger, Sleep Mode keeping the screen on. For an
// alarm that has to work, the phone's own Clock app is the one to trust.
//
// Both run off one check a second, against the clock rather than a timer
// that counts down, so a page the browser slows down still fires on time
// (or as soon as it gets to run).
import { settings } from './settings.js';
import { store, log } from './util.js';

const FADE_MS = 10e3;
const RISE_MS = 30e3;          // the alarm's music rises from quiet over this
const LATE_OK_MS = 5 * 60e3;   // a check that runs late still rings within this
const PLAYS_KEY = 'fp.alarm.plays';
const RANG_KEY = 'fp.alarm.rang';   // "<day> <time>" the alarm last rang (or was set past)

export const TIMER_CHOICES = [
  { id: 'off', name: 'Off' },
  { id: 15, name: '15 Minutes' }, { id: 30, name: '30 Minutes' }, { id: 45, name: '45 Minutes' },
  { id: 60, name: '1 Hour' }, { id: 90, name: '1.5 Hours' }, { id: 120, name: '2 Hours' },
  { id: 'song', name: 'End of Song' },
];

export class Alarms {
  // hooks.start(plays): start the alarm's music ({kind: 'shuffle'|'favorites'|'playlist', id, name}).
  // hooks.wake(): take Sleep Mode / the Art Screen down (sleep.js).
  constructor(player, hooks) {
    this.player = player;
    this.hooks = hooks;
    this.timer = null;           // {until: ms} or {song: true}
    this.fading = null;
    setInterval(() => this.check(), 1000);
    player.on((what) => { if (what === 'song') this.songChanged(); });
    // Turning the alarm on (or moving it) to a time that already went by
    // today means tomorrow, not "ring now" (check() rings up to LATE_OK_MS late).
    window.addEventListener('fp-setting', (e) => {
      if (e.detail !== 'alarmOn' && e.detail !== 'alarmTime') return;
      const [h, m] = settings.get('alarmTime').split(':').map(Number);
      const at = new Date();
      at.setHours(h, m, 0, 0);
      if (at <= new Date()) store.set(RANG_KEY, new Date().toDateString() + ' ' + settings.get('alarmTime'));
    });
  }

  // ---------- sleep timer ----------

  setTimer(choice) {
    this.cancelFade();
    if (choice === 'off') this.timer = null;
    else if (choice === 'song') this.timer = { song: true, songId: this.player.current?.Id };
    else this.timer = { until: Date.now() + choice * 60e3 };
  }

  // What the Sleep Timer row shows: Off, "23 min", or "End of Song".
  timerText() {
    const t = this.timer;
    if (!t) return 'Off';
    if (t.song) return 'End of Song';
    const min = Math.max(0, Math.ceil((t.until - Date.now()) / 60e3));
    return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
  }

  // End of Song: when the stream moves on to another song, stop. A second or
  // so of the next song may be heard; the stream has no gap to stop in.
  songChanged() {
    const t = this.timer;
    if (!t?.song || !this.player.playing) return;
    if (this.player.current?.Id !== t.songId) { this.timer = null; this.stopMusic(false); }
  }

  stopMusic(fade = true) {
    const p = this.player;
    if (!p.playing || p.paused) return;
    // Phone only, where the volume can be set (not iPhone) and it's ours.
    if (!fade || p.speaker || !p.canVolume) { p.toggle(); return; }
    const start = p.volume;
    const t0 = Date.now();
    this.fading = setInterval(() => {
      const k = (Date.now() - t0) / FADE_MS;
      if (k >= 1 || p.paused) {
        this.cancelFade();
        if (!p.paused) p.toggle();
        p.volume = start;
        return;
      }
      p.volume = start * (1 - k);
    }, 200);
    this.fadeBack = () => { p.volume = start; };
  }

  cancelFade() {
    if (!this.fading) return;
    clearInterval(this.fading);
    this.fading = null;
    this.fadeBack?.();
  }

  // ---------- alarm ----------

  get plays() {
    try { return JSON.parse(store.get(PLAYS_KEY, 'null')) || { kind: 'shuffle', name: 'Shuffle Songs' }; } catch {
      return { kind: 'shuffle', name: 'Shuffle Songs' };
    }
  }

  set plays(v) { store.set(PLAYS_KEY, JSON.stringify(v)); }

  ring() {
    log('alarm');
    this.hooks.wake();
    const p = this.player;
    this.hooks.start(this.plays);
    // Start quiet and rise, on the phone where the volume can be set.
    if (p.speaker || !p.canVolume) return;
    const full = p.volume || 1;
    p.volume = full * 0.15;
    const t0 = Date.now();
    const rise = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / RISE_MS);
      p.volume = full * (0.15 + 0.85 * k);
      if (k >= 1) clearInterval(rise);
    }, 500);
  }

  check() {
    const t = this.timer;
    if (t?.until && Date.now() >= t.until) { this.timer = null; this.stopMusic(true); }

    if (settings.get('alarmOn') !== 'on') return;
    const [h, m] = settings.get('alarmTime').split(':').map(Number);
    const now = new Date();
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    const late = now - at;
    // Today's alarm time has come (or passed within LATE_OK_MS, if a check ran
    // late) and it hasn't rung for this day yet.
    const day = now.toDateString();
    if (late < 0 || late > LATE_OK_MS || store.get(RANG_KEY) === day + ' ' + settings.get('alarmTime')) return;
    store.set(RANG_KEY, day + ' ' + settings.get('alarmTime'));
    if (settings.get('alarmRepeat') === 'once') {
      settings.set('alarmOn', 'off');
      window.dispatchEvent(new CustomEvent('fp-setting', { detail: 'alarmOn' }));
    }
    this.ring();
  }
}
