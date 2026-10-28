// Speakers: Fretzpod playing on Sonos speakers through Home Assistant
// (optional; allowed accounts only). DESIGN.md "Speakers".
//
// The phone never sends audio to a speaker. It asks fretzpod-speakers (through
// this page's own nginx, /speakers/api/) to load songs into the speaker's own
// queue; the speaker then downloads each song by itself. So while a speaker
// plays, this page is a remote control: it polls the speaker's state every 2 s
// and maps the speaker's queue position back onto Fretzpod's queue.
//
// SpeakerPlayer has the same face as Player (current, index, queue, paused,
// position(), play(), next(), ...), and Output sits in front of both, so the
// menus, Now Playing and the wheel don't care where the music is.
//
// The speakers keep playing when the app closes, but Android reloads the page
// when it's opened again. So the speaker session (which speakers, the queue,
// where the speaker's queue sits in it) is saved on the phone and picked back
// up on open (without it, reopening showed "This phone" and no Now
// Playing). Gone again on This phone, Sign Out, or when the speaker turns out
// to be playing something else. It holds song names, only on an allowed account's own phone.
import * as api from './api.js';
import { arrange } from './player.js';
import { log, store, Emitter } from './util.js';

const POLL_MS = 2000;
const BEHIND = 5;      // songs before the current one loaded too, so Previous works
const AHEAD = 40;      // songs after it loaded at the start
const TOPUP = 25;      // added when the speaker gets within LOW songs of the end
const LOW = 5;
const SAVE_KEY = 'fp.speakers';
const LINK_LIFE_MS = 11 * 3600e3;   // song links last 12 h (speakers.py); reload before then
const GRACE_MS = 15000;             // after a load, the speaker may still show its old track

const call = (path, body) => api.podCall('speakers', path, body);

// The speakers this person may use, or [] (friends, the dev server, or the
// service being down all land here). Works on both copies: the account is
// the lock, not the address.
export async function listSpeakers() {
  if (!api.getSession()) return [];
  try { return await call('list'); } catch { return []; }
}

class SpeakerPlayer extends Emitter {
  constructor(speaker, opts) {
    super();
    this.speaker = speaker;       // {id, name}: the lead; its queue is what plays
    this.members = [speaker];     // every speaker playing it (Sonos group)
    this.solo = true;             // first load takes the lead out of any old group
    this.opts = opts;             // same as Player's: repeat()
    this.queue = [];
    this.index = -1;
    this.refill = null;
    this.base = 0;                // Fretzpod queue index of the speaker's first queued song
    this.sent = 0;                // how many songs the speaker's queue holds
    this.st = { state: 'idle', position: 0, at: 0 };
    this.vol = null;
    this.volTimer = null;
    this.timer = null;
    this.growing = false;
    this.basic = false;
    this.loadedAt = 0;
    this.notOurs = 0;             // polls in a row where the speaker played something else
  }

  // ---------- surviving a reopened app ----------

  save() {
    const keep = (x) => ({
      Id: x.Id, Name: x.Name, AlbumArtist: x.AlbumArtist, Artists: x.Artists, Album: x.Album,
      AlbumId: x.AlbumId, RunTimeTicks: x.RunTimeTicks, HasLyrics: x.HasLyrics,
    });
    store.set(SAVE_KEY, JSON.stringify({
      lead: this.speaker, members: this.members, queue: this.queue.map(keep),
      index: this.index, base: this.base, sent: this.sent, loadedAt: this.loadedAt,
      // Shuffle Songs keeps topping itself up with random songs.
      random: !!this.refill,
    }));
  }

  static restore(opts) {
    if (!api.getSession()) return null;
    let d = null;
    try { d = JSON.parse(store.get(SAVE_KEY, 'null')); } catch { /* bad save: start fresh */ }
    if (!d || !d.lead || !Array.isArray(d.queue) || !d.queue.length || !(d.index >= 0)) return null;
    const sp = new SpeakerPlayer(d.lead, opts);
    Object.assign(sp, {
      members: d.members?.length ? d.members : [d.lead],
      queue: d.queue, index: d.index, base: d.base || 0, sent: d.sent || 0, loadedAt: d.loadedAt || 0, solo: false,
    });
    if (d.random) sp.refill = () => api.randomSongs(100).then((r) => r.Items);
    sp.st = { state: 'paused', position: 0, at: Date.now() };   // until the first poll answers
    log(`back on ${sp.outputName}`);
    return sp;
  }

  get outputName() { return this.members.map((m) => m.name).join(' + '); }

  get current() { return this.queue[this.index] || null; }
  get playing() { return this.index >= 0; }
  get paused() { return this.st.state !== 'playing'; }

  // The speaker reports where it was at some moment; count on from there.
  position() {
    const s = this.st;
    const run = s.state === 'playing' ? (Date.now() - s.at) / 1000 : 0;
    return Math.max(0, Math.min((s.position || 0) + run, this.duration()));
  }
  duration() { return this.current ? this.current.RunTimeTicks / 1e7 : 0; }

  get canVolume() { return true; }   // Sonos group volume over UPnP
  get volume() { return this.vol ?? 0.3; }
  // Wheel turns come fast; the speaker gets the latest value at most ~4x a second.
  set volume(v) {
    this.vol = Math.min(1, Math.max(0, v));
    if (this.volTimer) return;
    this.volTimer = setTimeout(() => {
      this.volTimer = null;
      this.cmd('volume', this.vol);
    }, 250);
  }

  cmd(cmd, value) {
    return call('command', { speaker: this.speaker.id, cmd, value }).catch((e) => log(`speaker ${cmd}: ${e.message}`));
  }

  // ---------- controls ----------

  play(items, index = 0, { shuffle = false, refill = null, offset = 0 } = {}) {
    const a = arrange(items, index, shuffle);
    this.queue = a.queue;
    this.refill = refill;
    this.load(a.index, offset);
  }

  // Loads a window of the queue into the speaker and starts at song qi.
  load(qi, offset = 0) {
    this.index = qi;
    this.base = Math.max(0, qi - BEHIND);
    const ids = this.queue.slice(this.base, qi + 1 + AHEAD).map((s) => s.Id);
    this.sent = ids.length;
    this.st = { state: 'playing', position: offset, at: Date.now() };
    this.loadedAt = Date.now();
    this.notOurs = 0;
    this.save();
    this.emit('song');
    this.emit('state');
    const alone = this.solo;
    this.solo = false;
    this.startPolling();
    return call('play', { speaker: this.speaker.id, ids, start: qi - this.base, offset, alone })
      .then(() => log(`playing on ${this.speaker.name}`))
      .catch((e) => { log(`speaker play: ${e.message}`); this.st.state = 'idle'; this.emit('state'); });
  }

  toggle() {
    if (!this.playing) return;
    const pause = !this.paused;
    // Paused for most of a day: the links in the speaker's queue are about to
    // run out, so load fresh ones at the same spot instead of resuming.
    if (!pause && Date.now() - this.loadedAt > LINK_LIFE_MS) { this.load(this.index, this.position()); return; }
    this.st = { state: pause ? 'paused' : 'playing', position: this.position(), at: Date.now() };
    this.emit('state');
    this.cmd(pause ? 'pause' : 'play');
  }

  next() {
    if (!this.playing) return;
    if (this.index + 1 >= this.base + this.sent) {
      // Past what the speaker holds (end of the list): Repeat All starts over.
      if (this.opts.repeat() === 'all' && this.queue.length) this.load(0);
      return;
    }
    this.cmd('next');
  }

  // Like the iPod: more than 3 s in restarts the song, otherwise goes back one.
  prev() {
    if (!this.playing) return;
    if (this.position() > 3) { this.seek(0); return; }
    if (this.index > this.base) { this.cmd('prev'); return; }
    if (this.index > 0) this.load(this.index - 1);    // before the loaded window
    else this.seek(0);
  }

  seek(sec) {
    if (!this.playing) return;
    sec = Math.max(0, Math.min(sec, this.duration() - 1));
    this.st = { ...this.st, position: sec, at: Date.now() };
    this.emit('tick');
    this.cmd('seek', sec);
  }

  // Stops following the speaker. pause: also pause it (handing the music on).
  stop(pause = true) {
    clearInterval(this.timer);
    this.timer = null;
    if (pause && this.playing) this.cmd('pause');
    store.del(SAVE_KEY);
    this.queue = [];
    this.index = -1;
    this.emit('song');
    this.emit('state');
  }

  // ---------- both speakers ----------

  // Another speaker joins in: Sonos plays the lead's queue on it too, in
  // sync, with no restart.
  join(sp) {
    this.members.push(sp);
    this.save();
    this.emit('song');
    call('join', { speaker: this.speaker.id, member: sp.id }).catch((e) => log(`speaker join: ${e.message}`));
  }

  // A speaker drops out; the rest keep playing. If it's the lead (whose queue
  // is playing), the music is handed to the other speaker at the same spot
  // first, then the old lead is paused.
  leave(sp) {
    if (this.members.length < 2) return;
    this.members = this.members.filter((m) => m.id !== sp.id);
    if (sp.id !== this.speaker.id) {
      this.save();
      this.emit('song');
      call('unjoin', { speaker: sp.id }).catch((e) => log(`speaker unjoin: ${e.message}`));
      return;
    }
    const old = this.speaker;
    this.speaker = this.members[0];
    this.solo = true;
    const p = this.playing ? this.load(this.index, this.position()) : null;
    Promise.resolve(p).then(() => call('command', { speaker: old.id, cmd: 'pause' })).catch(() => {});
  }

  // ---------- following the speaker ----------

  startPolling() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  async poll() {
    let s;
    try { s = await call('state?speaker=' + encodeURIComponent(this.speaker.id)); } catch { return; }
    if (!this.playing) return;
    if (this.vol === null && s.volume !== null) this.vol = s.volume;
    const was = this.st.state;
    this.st = {
      state: s.state,
      position: s.position || 0,
      at: s.positionAt ? Date.parse(s.positionAt) : Date.now(),
    };
    // Which song: the speaker's current track is one of our links, which
    // carry the song id. Matched near where the queue position says first,
    // since a playlist can hold the same song twice.
    if (s.songId) {
      this.notOurs = 0;
      if (!this.current || this.current.Id !== s.songId) {
        const guess = this.base + (s.queuePosition || 1) - 1;
        const qi = this.queue[guess] && this.queue[guess].Id === s.songId
          ? guess : this.queue.findIndex((x, i) => i >= this.base && x.Id === s.songId);
        if (qi >= 0) {
          this.index = qi;
          this.save();
          this.emit('song');
        }
      }
    } else if (Date.now() - this.loadedAt > GRACE_MS && ++this.notOurs >= 2) {
      // Twice in a row on something that isn't ours (the PC stream, the Sonos
      // app, grouped under another speaker): the speakers moved on. Let go
      // without pausing whatever they're playing now.
      log('the speakers are playing something else now');
      this.stop(false);
      this.emit('gone');
      return;
    }
    if (s.state !== was) this.emit('state');
    this.topUp();
    this.emit('tick');
  }

  // Keeps a few songs queued ahead on the speaker, the way the phone keeps
  // 90 s of audio ahead.
  async topUp() {
    const end = this.base + this.sent;
    if (end - this.index > LOW || this.growing) return;
    if (end >= this.queue.length && this.refill) {
      this.growing = true;
      try { this.queue.push(...await this.refill()); } catch (e) { log(`refill: ${e.message}`); }
      this.growing = false;
    }
    const more = this.queue.slice(end, end + TOPUP).map((s) => s.Id);
    if (!more.length) return;
    this.sent += more.length;
    this.save();
    call('add', { speaker: this.speaker.id, ids: more }).catch((e) => log(`speaker add: ${e.message}`));
  }
}

// What the rest of the app talks to: the phone's Player, or a SpeakerPlayer
// after a speaker was picked. Switching carries the queue, song and spot over.
export class Output extends Emitter {
  constructor(phone, opts) {
    super();
    this.phone = phone;
    this.opts = opts;
    this.p = phone;
    this.watch(phone);
    // Speakers playing from before the app was closed: follow them again.
    const back = SpeakerPlayer.restore(opts);
    if (back) {
      this.watch(back);
      this.p = back;
      back.startPolling();
      back.poll();
    }
  }

  watch(p) {
    p.on((what) => {
      if (p !== this.p) return;
      if (what === 'gone') {     // the speakers moved on: back to an idle phone
        this.p = this.phone;
        this.emit('song');
        this.emit('state');
        return;
      }
      this.emit(what);
    });
  }

  get speaker() { return this.p === this.phone ? null : this.p.speaker; }
  // Ids of the speakers playing (none: the phone is).
  get speakerIds() { return this.p === this.phone ? [] : this.p.members.map((m) => m.id); }
  get outputName() { return this.p.outputName || ''; }
  get current() { return this.p.current; }
  get index() { return this.p.index; }
  get queue() { return this.p.queue; }
  get paused() { return this.p.paused; }
  get playing() { return this.p.playing; }
  get basic() { return this.phone.basic; }
  position() { return this.p.position(); }
  duration() { return this.p.duration(); }
  get volume() { return this.p.volume; }
  set volume(v) { this.p.volume = v; }
  get canVolume() { return this.p.canVolume; }
  play(...a) { return this.p.play(...a); }
  toggle() { return this.p.toggle(); }
  next() { return this.p.next(); }
  prev() { return this.p.prev(); }
  seek(s) { return this.p.seek(s); }
  stop() {
    this.p.stop();
    if (this.p !== this.phone) this.use(null);
  }

  // What the Speakers menu does. This phone: music back to the phone. A
  // speaker while on the phone: music moves to it. A speaker while speakers
  // play: it joins in, or drops out if it was already playing (never the last
  // one; pick This phone for that). Phone and speakers never play together.
  pick(speaker) {
    if (!speaker || this.p === this.phone) { this.use(speaker); return; }
    if (this.speakerIds.includes(speaker.id)) this.p.leave(speaker);
    else this.p.join(speaker);
  }

  // speaker: {id, name} or null for this phone.
  use(speaker) {
    const from = this.p;
    const already = speaker ? from.speaker?.id === speaker.id : from === this.phone;
    if (already) return;
    const take = from.playing
      ? { queue: from.queue.slice(), index: from.index, offset: from.position(), refill: from.refill }
      : null;
    let to = this.phone;
    if (speaker) {
      to = new SpeakerPlayer(speaker, this.opts);
      this.watch(to);
    }
    // Switch first, then stop the old one: its "nothing playing" events are
    // ignored (they'd close Now Playing mid-handoff).
    this.p = to;
    from.stop();
    // Picking an output means "play here", so a paused song starts playing.
    if (take) to.play(take.queue, take.index, { refill: take.refill, offset: take.offset });
    this.emit('song');
    this.emit('state');
  }
}
