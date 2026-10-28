// Fretzpod player: one <audio> element playing one endless Media Source
// stream, with each song appended right after the previous one.
//
// WHY one continuous stream (phase 0 pocket tests, DESIGN.md "Playback"): on
// Android Chrome, once the screen is off a page may keep playing but cannot
// *start* audio, not in a second player and not by swapping the source of the
// playing one. The moment a song lets go, the page counts as idle and gets
// frozen. Here the player never lets go: to the browser it's one long track.
// Bonus: no gap between songs.
//
// The stream is a series of "segments", one per song played, each appended
// after the last. A segment points at a queue index, so Repeat One is just the
// same index appended again, and Repeat All wraps to index 0.
import * as api from './api.js';
import { Mp4Muxer } from './mp4mux.js';
import { log, newId, screenOffNote, Emitter } from './util.js';

// First one this browser's Media Source takes wins. ADTS AAC as Jellyfin sends
// it (Chrome); the same AAC rewrapped as MP4 in the page (`mux`, mp4mux.js:
// Firefox takes only this, measured 2026-10-27, and it's Apple's native
// format); MP3 last, since it costs quality.
const TYPES = [
  { mime: 'audio/aac', container: 'aac', codec: 'aac' },
  { mime: 'audio/mp4; codecs="mp4a.40.2"', container: 'aac', codec: 'aac', mux: true },
  { mime: 'audio/mpeg', container: 'mp3', codec: 'mp3' },
];
// iPhone Safari (iOS 17.1+) has Media Source only as ManagedMediaSource.
const MS = window.MediaSource || window.ManagedMediaSource;
// Dev server only: ?stream=mp4 tries the MP4 path in a browser that takes raw AAC.
const want = location.hostname === 'localhost' ? new URLSearchParams(location.search).get('stream') : null;
const usable = (t) => (want !== 'mp4' || t.mux) && MS.isTypeSupported(t.mime);
// `let`: a format that claims support but fails hands over to the next one
// (see the error handler). Importers see the change (live binding).
export let streamType = MS ? TYPES.find(usable) || null : null;

// The queue to play, from a list and the picked index. Shuffle keeps the picked
// song first and shuffles the rest. Shared with the speaker player.
export function arrange(items, index, shuffle) {
  const q = items.slice();
  if (!shuffle || q.length < 2) return { queue: q, index };
  const first = q.splice(index, 1)[0];
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  q.unshift(first);
  return { queue: q, index: 0 };
}

// iPhone/iPad: Safari leaves volume to the hardware buttons; setting
// audio.volume does nothing and it always reads 1 (Apple's docs). Checked once
// so Now Playing can use the wheel for something that works there.
const VOLUME_WORKS = (() => { const a = document.createElement('audio'); a.volume = 0.5; return a.volume === 0.5; })();

const KEEP_AHEAD = 90;   // seconds appended past the playhead
const KEEP_BEHIND = 60;  // seconds kept behind it; older audio is trimmed
const RETRIES = 2;

export class Player extends Emitter {
  // opts.bitrate(): bits/s to ask Jellyfin for; opts.repeat(): 'off'|'one'|'all'
  constructor(audio, opts) {
    super();
    this.el = audio;
    this.opts = opts;
    this.queue = [];
    this.index = -1;          // queue index being heard (or about to be)
    this.refill = null;       // async () => more songs (Shuffle Songs)
    this.timer = null;
    this.ticks = 0;
    this.gen = 0;             // bumped on every restart; stale work checks it
    this.s = this.fresh();
    this.basic = !streamType;
    if (this.basic) log('basic mode: no Media Source support for AAC or MP3 here');
    audio.addEventListener('ended', () => this.finished());
    audio.addEventListener('play', () => this.emit('state'));
    audio.addEventListener('pause', () => this.emit('state'));
    audio.addEventListener('error', () => {
      if (!audio.error || !this.playing) return;
      if (this.basic) { log(`player error ${audio.error.code}`); return; }
      // The stream claimed support but can't play. WebKit does this with raw
      // AAC (says yes, then "stream buffer error"; measured 2026-10-27) and
      // plays the MP4 wrapping fine. So try the next format, and only then
      // basic mode, for the rest of the session; restart the current song.
      const next = TYPES.slice(TYPES.indexOf(streamType) + 1).find(usable);
      log(`player error ${audio.error.code}, switching to ${next ? next.mime : 'basic mode'}`);
      if (next) streamType = next; else this.basic = true;
      this.start(this.index, this.position());
    });
    this.setupMediaSession();
  }

  fresh() {
    return {
      ms: null, sb: null, url: null,
      segs: [],          // {qi, ps, offset, start, done, failed}
      cur: -1,           // segment being heard
      chunks: [],        // fetched audio waiting to be appended: {seg, data}
      fetching: false, abort: null, growing: false, ended: false,
      first: { qi: 0, offset: 0 },
    };
  }

  get current() { return this.queue[this.index] || null; }
  get paused() { return this.el.paused; }
  get playing() { return this.index >= 0; }

  // Position within the current song, in seconds.
  position() {
    const seg = this.s.segs[this.s.cur];
    if (!seg || seg.start === undefined) return this.s.first.offset;
    return Math.max(0, this.el.currentTime - seg.start + seg.offset);
  }
  duration() { return this.current ? this.current.RunTimeTicks / 1e7 : 0; }

  get volume() { return this.el.volume; }
  set volume(v) { this.el.volume = Math.min(1, Math.max(0, v)); }
  get canVolume() { return VOLUME_WORKS; }

  // ---------- controls ----------

  // offset: seconds into the first song (music coming back from a speaker).
  play(items, index = 0, { shuffle = false, refill = null, offset = 0 } = {}) {
    const a = arrange(items, index, shuffle);
    this.queue = a.queue;
    this.refill = refill;
    this.start(a.index, offset);
  }

  toggle() {
    if (!this.playing) return;
    if (this.el.paused) this.el.play().catch((e) => log(`resume failed: ${e.name}`));
    else this.el.pause();
  }

  async next() {
    if (!this.playing) return;
    let q = this.index + 1;
    if (q >= this.queue.length && this.refill) await this.grow();
    if (q >= this.queue.length) {
      if (this.opts.repeat() !== 'all') return;
      q = 0;
    }
    this.start(q);
  }

  // Like the iPod: more than 3 s in restarts the song, otherwise goes back one.
  prev() {
    if (!this.playing) return;
    if (this.position() > 3 || this.index === 0) { this.seek(0); return; }
    this.start(this.index - 1);
  }

  seek(sec) {
    if (!this.playing) return;
    sec = Math.max(0, Math.min(sec, this.duration() - 1));
    const seg = this.s.segs[this.s.cur];
    if (seg?.start !== undefined && sec >= seg.offset) {
      const t = seg.start + (sec - seg.offset);
      const b = this.s.sb ? this.s.sb.buffered : this.el.seekable;
      for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) && t < b.end(i) - 0.5) { this.el.currentTime = t; this.emit('tick'); return; }
      }
    }
    // Not buffered (trimmed, or not fetched yet): restart the song partway in.
    this.start(this.index, sec);
  }

  stop() {
    this.teardown();
    this.queue = [];
    this.index = -1;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.emit('song');
    this.emit('state');
  }

  // ---------- the stream ----------

  start(qi, offset = 0) {
    if (this.basic) { this.startBasic(qi, offset); return; }
    this.teardown();
    const s = this.s = this.fresh();
    const gen = this.gen;
    s.first = { qi, offset };
    this.index = qi;
    s.ms = new MS();
    s.url = URL.createObjectURL(s.ms);
    s.ms.addEventListener('sourceopen', () => {
      if (gen !== this.gen) return;
      s.sb = s.ms.addSourceBuffer(streamType.mime);
      // "sequence" lays each append right after the previous one, which is
      // exactly what a playlist needs: ADTS and MP3 carry no timestamps, and
      // each muxed song's MP4 timestamps restart at 0.
      s.sb.mode = 'sequence';
      s.sb.addEventListener('updateend', () => this.pump());
      s.sb.addEventListener('error', () => log('stream buffer error'));
      this.pump();
    }, { once: true });
    // ManagedMediaSource (iPhone) refuses to run unless AirPlay is off or an
    // alternative source is given.
    if (MS === window.ManagedMediaSource) this.el.disableRemotePlayback = true;
    this.begin(s.url);
  }

  // Basic mode: a plain <audio> pointed at one song at a time, for browsers
  // that can't do the continuous stream (no Media Source for AAC/MP3, or it
  // fails to play). Seen with Firefox on Android: it signed in but never
  // played (before the MP4 path existed). Works anywhere, but on Android the music may stop between
  // songs with the screen off (the reason the stream exists; DESIGN.md).
  // Reuses the segment bookkeeping with a single segment starting at 0, so
  // tick() and position() work unchanged.
  startBasic(qi, offset) {
    this.teardown();
    const s = this.s = this.fresh();
    s.basic = true;
    s.first = { qi, offset };
    this.index = qi;
    const seg = { qi, ps: newId(), offset, start: 0, done: true, failed: false };
    s.segs.push(seg);
    this.begin(api.basicStreamUrl(this.queue[qi], seg.ps, { bitrate: this.opts.bitrate(), startSec: offset }));
  }

  // Both modes: point the <audio> at src, play, and start the 1 s tick.
  begin(src) {
    this.el.src = src;
    this.el.play().catch((e) => log(`couldn't start playback: ${e.name}`));
    this.showMetadata();
    this.emit('song');
    clearInterval(this.timer);
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  teardown() {
    const s = this.s;
    clearInterval(this.timer);
    this.gen++;
    if (s.abort) s.abort.abort();
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (s.url) URL.revokeObjectURL(s.url);
    this.s = this.fresh();
  }

  async finished() {
    if (this.s.basic) {
      const last = this.s.segs[0];
      let q = this.nextQi(last);
      if (q === null && this.refill) { await this.grow(); q = this.nextQi(last); }
      if (q === null) { log('end of queue'); this.stop(); return; }
      this.start(q);
      return;
    }
    // In stream mode this only fires after endOfStream(): the queue ran out
    // with no repeat.
    if (!this.s.ended) return;
    log('end of queue');
    this.stop();
  }

  // Which queue index the next segment should play, or null at the end.
  nextQi(last) {
    if (last.failed) return last.qi + 1 < this.queue.length ? last.qi + 1 : null;
    if (this.opts.repeat() === 'one') return last.qi;
    if (last.qi + 1 < this.queue.length) return last.qi + 1;
    if (this.opts.repeat() === 'all' && !this.refill) return 0;
    return null;
  }

  async grow() {
    if (!this.refill || this.s.growing) return;
    this.s.growing = true;
    const gen = this.gen;
    try {
      const more = await this.refill();
      if (gen === this.gen && more.length) this.queue.push(...more);
      if (!more.length) this.refill = null;
    } catch (e) { log(`refill: ${e.message}`); }
    if (gen === this.gen) this.s.growing = false;
  }

  bufferedEnd() {
    const b = this.s.sb.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  // Feeds the stream: trims old audio, appends fetched audio while staying
  // under KEEP_AHEAD, and fetches the next song once the last one is all in.
  // Runs after every append (updateend) and on the 1 s timer.
  pump() {
    const s = this.s;
    if (!s.sb || s.sb.updating || s.ms.readyState !== 'open') return;
    const t = this.el.currentTime;
    const b = s.sb.buffered;
    if (b.length && b.start(0) < t - KEEP_BEHIND - 5) { s.sb.remove(0, t - KEEP_BEHIND); return; }
    if (s.chunks.length) {
      if (this.bufferedEnd() - t > KEEP_AHEAD) return;
      const c = s.chunks.shift();
      // Where the song starts in the stream, read before its first bytes go in.
      // ADTS/MP3: timestampOffset is where the next append lands. MP4 brings
      // its own timestamps, so there the offset only moves once the song's
      // first fragment is in (it read 0 for song 2 in Firefox and WebKit); the
      // end of what's buffered is the same spot, as appends are back to back.
      const first = c.seg.start === undefined;
      if (first) c.seg.start = streamType.mux ? this.bufferedEnd() : s.sb.timestampOffset;
      try {
        s.sb.appendBuffer(c.data);
      } catch (e) {
        s.chunks.unshift(c);
        if (first) c.seg.start = undefined;
        if (e.name !== 'QuotaExceededError') log(`append: ${e.name}`);
      }
      return;
    }
    if (s.fetching || s.growing) return;
    const last = s.segs[s.segs.length - 1];
    if (!last) { this.fetchSeg(s.first.qi, s.first.offset); return; }
    if (!last.done) return;
    const q = this.nextQi(last);
    if (q !== null) { this.fetchSeg(q, 0); return; }
    if (this.refill) { this.grow().then(() => this.pump()); return; }
    if (!s.ended) {
      s.ended = true;
      try { s.ms.endOfStream(); } catch { /* already closed */ }
    }
  }

  // fetch() can send the Authorization header, so the token never goes in a URL.
  async fetchSeg(qi, offset, attempt = 0) {
    const s = this.s;
    const gen = this.gen;
    const item = this.queue[qi];
    let seg = attempt ? s.segs[s.segs.length - 1] : null;
    if (!seg) {
      seg = { qi, ps: newId(), offset, start: undefined, done: false, failed: false };
      s.segs.push(seg);
    }
    s.fetching = true;
    const ctrl = new AbortController();
    s.abort = ctrl;
    let bytes = 0;
    try {
      const url = api.songStreamUrl(item, seg.ps, {
        container: streamType.container, codec: streamType.codec,
        bitrate: this.opts.bitrate(), startSec: offset,
      });
      const res = await fetch(url, { headers: { Authorization: api.authHeader() }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${res.status} from Jellyfin`);
      const reader = res.body.getReader();
      const mux = streamType.mux ? new Mp4Muxer() : null;   // one per song
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== this.gen) return;
        if (done) break;
        bytes += value.length;
        const data = mux ? mux.push(value) : value;
        if (!data.length) continue;   // muxer waiting for the rest of a frame
        s.chunks.push({ seg, data });
        this.pump();
      }
      seg.done = true;
    } catch (e) {
      if (gen !== this.gen || e.name === 'AbortError') return;
      // A retry would duplicate audio already appended, so only songs that
      // never started get retried; a song cut off midway just ends early.
      if (seg.start === undefined && bytes === 0 && attempt < RETRIES) {
        log(`fetching song ${qi + 1} failed (${e.message}), retrying`);
        s.fetching = false;
        setTimeout(() => { if (gen === this.gen) this.fetchSeg(qi, offset, attempt + 1); }, 2000);
        return;
      }
      log(`gave up on song ${qi + 1}: ${e.message}`);
      seg.done = true;
      seg.failed = bytes === 0;
    }
    if (gen === this.gen) { s.fetching = false; this.pump(); }
  }

  // Once a second: notices song changes in the stream,
  // keeps the lock screen current, and keeps the stream fed.
  tick() {
    const s = this.s;
    const t = this.el.currentTime;
    let j = s.cur;
    for (let i = s.cur + 1; i < s.segs.length; i++) {
      if (s.segs[i].start !== undefined && t >= s.segs[i].start) j = i;
    }
    if (j !== s.cur) {
      s.cur = j;
      const seg = s.segs[j];
      this.index = seg.qi;
      log(`playing ${seg.qi + 1}/${this.queue.length}${screenOffNote()}`);
      this.showMetadata();
      this.emit('song');
    }
    this.ticks++;
    if (this.ticks % 300 === 0 && screenOffNote()) log(`still playing${screenOffNote()}`);
    if ('mediaSession' in navigator && this.playing && this.duration() > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: this.duration(), position: Math.min(this.position(), this.duration()), playbackRate: 1,
        });
      } catch { /* rejected mid-change */ }
    }
    this.pump();
    this.emit('tick');
  }

  // ---------- lock screen ----------
  //
  // No play reporting to Jellyfin, on purpose (privacy: gather nothing about
  // listeners that isn't needed). Jellyfin's /Sessions/Playing
  // reports would put every song each person plays in its activity log and
  // play counts. Without them Jellyfin only streams the audio it's asked for.

  showMetadata() {
    const item = this.current;
    if (!item || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.Name,
      artist: api.artistOf(item),
      album: item.Album || '',
      artwork: [{ src: api.artUrl(item, 512), sizes: '512x512', type: 'image/jpeg' }],
    });
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.el.play(),
      pause: () => this.el.pause(),
      nexttrack: () => this.next(),
      previoustrack: () => this.prev(),
      seekto: (d) => this.seek(d.seekTime),
      stop: () => this.stop(),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
    }
  }
}
