// The iPod screen: a stack of screens (menus, Now Playing, sign-in) with the
// iPod's slide-in/slide-out, the title bar, and every menu in the app.
//
// Lists show ROWS rows at a time and only build those rows, so a 9,500-song
// list costs the same as a 5-song one. Long lists load from Jellyfin in pages
// as the selection gets near them.
import * as api from './api.js';
import { settings } from './settings.js';
import { el, fmt, log, logLines } from './util.js';
import { Vortex } from './vortex.js';
import { SpaceSheep } from './spacesheep.js';
import * as scores from './scores.js';
import { streamType } from './player.js';
import { listSpeakers } from './speakers.js';
import { Tv, tvData } from './tv.js';
import { Golf, SHOP, golfSave, shopPick, courseOpen } from './golf.js';
import { COURSES } from './golf-holes.js';

const ROWS = 8;            // like the iPod Classic's 320x240 screen
const PAGE = 100;
const SLIDE_MS = 220;
const SWIPE_PX = 40;       // Now Playing: a sideways swipe this long turns the card over

// ---------- screens ----------

// A menu. rows: [{label, sub, arrow, value(), select(ui)}]. For big lists
// pass fetch(start, count) -> {rows, total} instead and rows load in pages.
class List {
  constructor(title, { rows = null, fetch = null, empty = 'Nothing here', split = false, letters = null, visible = ROWS } = {}) {
    this.title = title;
    this.lettersFn = letters;   // async () => [{l, i}]: where each letter starts
    this.letterIdx = null;
    this.visible = visible;
    this.rows = rows || [];
    this.total = rows ? rows.length : null;   // null = still loading
    this.fetchPage = fetch;
    this.empty = empty;
    this.split = split;
    this.sel = 0;
    this.top = 0;
    this.pages = new Set();
    this.error = null;
  }

  get length() { return this.total || 0; }

  attach(ui) {
    this.ui = ui;
    if (this.fetchPage && this.total === null) this.need(0);
  }

  need(i) {
    const page = Math.floor(i / PAGE);
    // Lists that load everything at once fill all rows in the first call.
    if (!this.fetchPage || this.pages.has(page) || this.rows[i]) return;
    if (this.total !== null && i >= this.total) return;
    this.pages.add(page);
    this.fetchPage(page * PAGE, PAGE).then(({ rows, total }) => {
      rows.forEach((r, j) => { this.rows[page * PAGE + j] = r; });
      this.total = total;
      this.ui.refresh(this);
    }).catch((e) => {
      this.pages.delete(page);
      this.error = e.message;
      log(`loading a list failed: ${e.message}`);
      this.ui.refresh(this);
    });
  }

  turn(dir, step) { return this.moveTo(this.sel + dir * step); }

  moveTo(i) {
    const n = this.length;
    if (!n) return false;
    const sel = Math.max(0, Math.min(n - 1, i));
    if (sel === this.sel) return false;
    this.sel = sel;
    if (sel < this.top) this.top = sel;
    if (sel >= this.top + this.visible) this.top = sel - this.visible + 1;
    return true;
  }

  // Spinning fast in a long sorted list jumps a letter at a time, like the
  // iPod. Letter positions come from Jellyfin the first time they're needed;
  // until they arrive, plain acceleration does the work.
  letterJump(dir) {
    if (!this.lettersFn) return false;
    if (!this.letterIdx) {
      if (!this.letterLoading) {
        this.letterLoading = true;
        this.lettersFn().then((idx) => { this.letterIdx = idx; })
          .catch((e) => { log(`letters: ${e.message}`); this.lettersFn = null; });
      }
      return false;
    }
    const idx = this.letterIdx;
    return this.moveTo(dir > 0
      ? idx.find((x) => x.i > this.sel)?.i ?? this.length - 1
      : idx.findLast((x) => x.i < this.sel)?.i ?? 0);
  }

  letterAt(i) {
    if (this.letterIdx) return (this.letterIdx.findLast((x) => x.i <= i) ?? this.letterIdx[0]).l;
    const r = this.rows[i];
    if (!r) return '';
    const c = r.label.trim().replace(/^the\s+/i, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : '#';
  }

  select(ui) {
    this.rows[this.sel]?.select?.(ui, this.sel);
  }

  render(view) {
    view.replaceChildren();
    view.classList.toggle('split', this.split);
    const list = el('div', 'list');
    if (this.visible !== ROWS) list.style.gridTemplateRows = `repeat(${this.visible}, 1fr)`;
    if (this.total === null || (this.error && !this.length)) {
      list.append(el('div', 'note', this.error ? `Couldn't load: ${this.error}` : 'Loading…'));
    } else if (!this.length) {
      list.append(el('div', 'note', this.empty));
    }
    for (let i = this.top; i < Math.min(this.top + this.visible, this.length); i++) {
      const r = this.rows[i];
      if (!r) this.need(i);
      // Keep the next page coming before the selection reaches it.
      if (i === this.top + this.visible - 1) this.need(i + this.visible);
      const row = el('div', 'row' + (i === this.sel ? ' sel' : ''));
      const text = el('div', 'text');
      text.append(el('span', 'label', r ? r.label : '…'));
      if (r?.sub) text.append(el('span', 'sub', r.sub));
      row.append(text);
      if (r?.value) row.append(el('span', 'value', r.value()));
      if (r?.arrow) row.append(el('span', 'arrow', '›'));
      list.append(row);
    }
    view.append(list);
    if (this.length > this.visible) {
      const bar = el('div', 'scroll');
      const thumb = el('div', 'thumb');
      thumb.style.height = `${Math.max(8, (this.visible / this.length) * 100)}%`;
      thumb.style.top = `${(this.top / this.length) * 100}%`;
      bar.append(thumb);
      view.append(bar);
    }
    if (this.split) view.append(this.ui.artPane);
  }
}

// Now Playing, laid out like the 6th/7th-gen iPod Classic. The wheel is the
// volume; the center button switches it to scrubbing through the song.
//
// Hold the center button to heart the song (a Jellyfin
// favorite; a small heart on the art shows it), and swipe the screen
// sideways to turn the art over to the lyrics, like a card. The screen stays
// a display otherwise: nothing on it to tap.
class NowPlaying {
  constructor(player) {
    this.title = 'Now Playing';
    this.player = player;
    this.mode = 'progress';      // 'progress' | 'volume' | 'scrub'
    this.modeTimer = null;
    this.scrubTo = 0;
    this.songId = null;
    this.parts = null;
    this.fav = new Map();        // song id -> true | false | 'loading'
    this.lyricCache = new Map(); // song id -> lines | null | 'loading'
    this.lyricsOn = false;      // the card is turned over to the lyrics
    this.flipping = false;
    this.raf = 0;
  }

  attach(ui) { this.ui = ui; }

  // A few seconds after the last turn, the bottom goes back to the progress bar.
  settle(ms) {
    clearTimeout(this.modeTimer);
    this.modeTimer = setTimeout(() => {
      if (this.mode === 'scrub') this.player.seek(this.scrubTo);
      this.mode = 'progress';
      this.ui.refresh(this);
    }, ms);
  }

  turn(dir) {
    if (!this.player.playing) return false;
    // No volume control from a web page (iPhone): the wheel scrubs instead,
    // and the phone's own buttons do the volume.
    if (this.mode !== 'scrub' && !this.player.canVolume) {
      this.mode = 'scrub';
      this.scrubTo = this.player.position();
    }
    if (this.mode === 'scrub') {
      // Faster the longer the song, so a 10-minute track isn't a chore.
      const step = Math.max(2, this.player.duration() / 120);
      this.scrubTo = Math.max(0, Math.min(this.player.duration() - 1, this.scrubTo + dir * step));
      this.settle(1500);
      return true;
    }
    const before = this.player.volume;
    this.player.volume = Math.round((before + dir * 0.04) * 100) / 100;
    this.mode = 'volume';
    this.settle(2000);
    return this.player.volume !== before;
  }

  // Center button cycles like the 7th-gen iPod: normal -> scrub -> lyrics
  // (only for songs that have them in Jellyfin) -> normal.
  select() {
    const item = this.player.current;
    if (!item) return;
    if (this.mode === 'scrub') {
      this.player.seek(this.scrubTo);
      this.mode = 'progress';
      clearTimeout(this.modeTimer);
      if (item.HasLyrics) this.flip(true);
      return;
    }
    if (this.lyricsOn) { this.flip(false); return; }
    this.mode = 'scrub';
    this.scrubTo = this.player.position();
    this.settle(4000);
  }

  // Hold center: heart the song, or un-heart it. Adding one that's already a
  // favorite is harmless, so this doesn't wait for Jellyfin's answer on
  // whether it is one.
  holdSelect() {
    const item = this.player.current;
    if (!item) return false;
    const was = this.fav.get(item.Id) === true;
    const on = !was;
    this.fav.set(item.Id, on);
    this.pop(on);
    api.setFavorite(item.Id, on).then((now) => { this.fav.set(item.Id, now); this.ui.refresh(this); })
      .catch((e) => { log(`favorite: ${e.message}`); this.fav.set(item.Id, was); this.ui.refresh(this); });
    return true;
  }

  // A big heart that blooms and fades over the screen.
  pop(on) {
    if (!this.parts) return;
    const p = el('div', 'np-pop' + (on ? ' on' : ''));
    p.append(el('div', 'np-pop-heart', on ? '♥' : '♡'), el('div', 'np-pop-text', on ? 'Added to Favorites' : 'Removed from Favorites'));
    this.parts.root.append(p);
    p.animate([
      { opacity: 0, transform: 'scale(.6)' },
      { opacity: 1, transform: 'scale(1.08)', offset: 0.25 },
      { opacity: 1, transform: 'scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'scale(1)' },
    ], { duration: 1100, easing: 'ease-out' }).finished.then(() => p.remove(), () => p.remove());
  }

  // Turns the card: art side to lyrics side or back, a quarter turn out and
  // a quarter turn in. dir 1 turns it right to left (a swipe to the left).
  // A song without lyrics just wobbles: there's nothing on the back.
  async flip(on, dir = 1) {
    const item = this.player.current;
    if (!this.parts || this.flipping) return;
    const turn = (card, deg, opts) => card.animate(deg.map((d) => ({ transform: `rotateY(${d}deg)` })), opts);
    if (on && !item?.HasLyrics) {
      turn(this.parts.card, [0, -dir * 14, 0], { duration: 260, easing: 'ease-out' });
      return;
    }
    if (on === this.lyricsOn) return;
    this.flipping = true;
    // Each half holds its end angle (fill) until the next step takes over.
    const half = (easing) => ({ duration: 160, easing, fill: 'forwards' });
    const out = turn(this.parts.card, [0, -dir * 90], half('ease-in'));
    try {
      await out.finished;
      this.lyricsOn = on;
      this.ui.refresh(this);                     // draws the other side, edge-on
      if (this.parts) {                          // gone if the screen closed meanwhile
        const back = turn(this.parts.card, [dir * 90, 0], half('ease-out'));
        await back.finished;
        back.cancel();
      }
    } catch { /* an animation was cancelled: the card just ends up flat */ }
    out.cancel();
    this.flipping = false;
    this.ui.refresh(this);
  }

  // With timed lyrics up, follow the song every frame: the player only
  // ticks once a second, too coarse for words (and late for lines).
  followLoop() {
    if (this.raf) return;
    const step = () => {
      if (this.ui.top !== this || !this.lyricsOn || !this.parts?.synced) { this.raf = 0; return; }
      this.followLyrics(this.player.position());
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // Lyrics are fetched once per song and kept for the session.
  lyricsFor(item) {
    const c = this.lyricCache;
    if (!c.has(item.Id)) {
      c.set(item.Id, 'loading');
      api.lyrics(item.Id).then((l) => { c.set(item.Id, l); this.songId = null; this.ui.refresh(this); });
    }
    return c.get(item.Id);
  }

  // Press-and-hold next/previous: move through the song, seek on release.
  hold(button) {
    if (!this.player.playing) return;
    if (this.mode !== 'scrub') { this.mode = 'scrub'; this.scrubTo = this.player.position(); }
    this.scrubTo = Math.max(0, Math.min(this.player.duration() - 1, this.scrubTo + (button === 'next' ? 4 : -4)));
    clearTimeout(this.modeTimer);
  }

  holdEnd() {
    if (this.mode !== 'scrub') return;
    this.player.seek(this.scrubTo);
    this.mode = 'progress';
  }

  render(view) {
    const p = this.player;
    const item = p.current;
    if (!item) {
      view.replaceChildren(el('div', 'note', 'Nothing playing'));
      this.parts = null;
      this.songId = null;
      return;
    }
    // Build once per song; each tick only updates text and bar widths, so the
    // album art doesn't flicker.
    if (!this.parts || this.songId !== item.Id || !view.contains(this.parts.root)) {
      const root = el('div', 'np');
      const count = el('div', 'np-count');
      const main = el('div', 'np-main');
      const art = el('div', 'np-art');
      const img = el('img');
      img.alt = '';
      img.src = api.artUrl(item, 300);
      img.addEventListener('error', () => img.classList.add('missing'));
      const heart = el('div', 'np-heart', '♥');
      art.append(img, heart);
      const text = el('div', 'np-text');
      text.append(
        el('div', 'np-title', item.Name),
        el('div', 'np-artist', api.artistOf(item)),
        el('div', 'np-album', item.Album || ''),
      );
      main.append(art, text);
      const lyr = el('div', 'np-lyrics');
      const lines = el('div', 'lines');
      lyr.append(lines);
      const lyrics = item.HasLyrics ? this.lyricsFor(item) : null;
      const synced = Array.isArray(lyrics) && lyrics.some((l) => l.start !== null);
      const words = [];             // per line: its word spans, when it has word timing
      if (Array.isArray(lyrics)) lyrics.forEach((l) => { const [n, w] = lyricLine(l); lines.append(n); words.push(w); });
      else lines.append(el('div', 'line', lyrics === 'loading' ? 'Loading lyrics…' : 'No lyrics for this song'));
      // Lyrics without timing are a page you scroll with your finger, like
      // the real iPod's. WHY not scroll them along with the song: an even pace
      // is a guess that intros, hooks and breaks throw off, and wrong lyrics
      // on screen are worse than still ones. The wheel
      // stays volume either way.
      if (Array.isArray(lyrics) && !synced) lyr.classList.add('plain');
      // The art side and the lyrics side are the two faces of one card.
      const card = el('div', 'np-card');
      card.append(main, lyr);
      this.swipe(card);
      const bottom = el('div', 'np-bottom');
      root.append(count, card, bottom);
      view.replaceChildren(root);
      view.classList.remove('split');
      this.parts = {
        root, count, bottom, card, heart, lyr, lines, words,
        lyrics: Array.isArray(lyrics) ? lyrics : null,
        synced,
      };
      this.songId = item.Id;
      if (!this.fav.has(item.Id)) {
        this.fav.set(item.Id, 'loading');
        api.isFavorite(item.Id).then((v) => { this.fav.set(item.Id, v); this.ui.refresh(this); })
          .catch(() => this.fav.set(item.Id, false));
      }
    }
    this.parts.heart.classList.toggle('on', this.fav.get(item.Id) === true);
    const { count, bottom } = this.parts;
    count.textContent = `${p.index + 1} of ${p.queue.length}` + (p.outputName ? `  ·  ${p.outputName}` : '')
      + (item.HasLyrics ? '  ·  lyrics' : '');
    if (this.lyricsOn && !item.HasLyrics) this.lyricsOn = false;
    this.parts.root.classList.toggle('lyrics-on', this.lyricsOn);
    if (this.lyricsOn && this.parts.synced) { this.followLyrics(p.position()); this.followLoop(); }
    const dur = p.duration();
    bottom.replaceChildren();
    bottom.className = 'np-bottom ' + this.mode;
    if (this.mode === 'volume') {
      bottom.append(el('span', 'vol-icon', '🔈'), bar(p.volume), el('span', 'vol-icon', '🔊'));
      return;
    }
    const pos = this.mode === 'scrub' ? this.scrubTo : p.position();
    bottom.append(bar(dur ? pos / dur : 0, this.mode === 'scrub'));
    const times = el('div', 'np-times');
    times.append(el('span', '', fmt(pos)), el('span', '', '-' + fmt(dur - pos)));
    bottom.append(times);
  }

  // A sideways swipe across the card turns it over.
  swipe(card) {
    let x0 = null;
    let y0 = 0;
    card.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; });
    card.addEventListener('pointercancel', () => { x0 = null; });
    card.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      this.flip(!this.lyricsOn, dx < 0 ? 1 : -1);
      this.ui.wheel.feedback();
    });
  }

  // Highlights the current line of synced lyrics and keeps it in the middle;
  // on lines with word timing, each word lights up as it's sung. Synced
  // lyrics only: untimed ones are scrolled by hand (render).
  followLyrics(pos) {
    const { lyrics, lines, lyr, words } = this.parts;
    let cur = 0;
    lyrics.forEach((l, i) => { if (l.start !== null && l.start <= pos + 0.3) cur = i; });
    const spans = words[cur];
    if (spans) lyrics[cur].cues.forEach((c, k) => spans[k].classList.toggle('sung', c.start <= pos + 0.05));
    if (cur === this.parts.cur) return;
    this.parts.cur = cur;
    [...lines.children].forEach((n, i) => n.classList.toggle('now', i === cur));
    const line = lines.children[cur];
    const y = line.offsetTop + line.offsetHeight / 2 - lyr.clientHeight / 2;
    lines.style.transform = `translateY(${-Math.max(0, y)}px)`;
  }
}

// One line of lyrics. With word timing, each timed word is its own span
// (the text between them stays plain), so words can light up as they're
// sung. Returns [the line, its word spans or null].
function lyricLine(l) {
  const n = el('div', 'line');
  if (!l.cues.length) { n.textContent = l.text || ' '; return [n, null]; }
  const spans = [];
  let at = 0;
  for (const c of l.cues) {
    if (c.from > at) n.append(l.text.slice(at, c.from));
    const w = el('span', 'w', l.text.slice(c.from, c.to));
    spans.push(w);
    n.append(w);
    at = Math.max(at, c.to);
  }
  if (at < l.text.length) n.append(l.text.slice(at));
  n.classList.add('worded');
  return [n, spans];
}

function bar(frac, knob = false) {
  const b = el('div', 'meter');
  const fill = el('div', 'fill');
  fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  b.append(fill);
  if (knob) {
    const k = el('div', 'knob');
    k.style.left = fill.style.width;
    b.append(k);
  }
  return b;
}

// Quick Connect: show the code, wait for approval in the person's Jellyfin app.
class QuickConnect {
  constructor() { this.title = 'Quick Connect'; this.code = null; this.msg = 'Getting a code…'; }
  attach(ui) {
    this.ui = ui;
    if (this.qc) return;
    api.quickConnect().then((qc) => {
      this.qc = qc;
      this.code = qc.code;
      this.msg = 'In your Jellyfin app, open your profile, then Quick Connect, and enter:';
      ui.refresh(this);
      qc.done.catch(() => { this.code = null; this.msg = 'That code expired. Press MENU and try again.'; ui.refresh(this); });
    }).catch((e) => { this.msg = `Couldn't reach Jellyfin: ${e.message}`; ui.refresh(this); });
  }
  leave() { if (this.qc) this.qc.cancel(); }
  render(view) {
    const box = el('div', 'qc');
    box.append(el('p', '', this.msg));
    if (this.code) box.append(el('div', 'qc-code', this.code));
    view.replaceChildren(box);
  }
}

// Search, the iPod way: the wheel runs along a strip of letters, the center
// adds one, and results update as you go. "Done" (or ⏭) moves into the
// results; MENU from the results goes back to the letters.
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ' ', '⌫', 'Done'];
const KEY_WINDOW = 11;      // letters visible in the strip at once

class Search {
  constructor(ui) {
    this.title = 'Search';
    this.ui = ui;
    this.query = '';
    this.key = 0;
    this.focus = 'keys';
    this.results = new List('', { rows: [], empty: 'No matches', visible: 5 });
    this.timer = null;
    this.ctrl = null;
    this.status = 'Pick letters with the wheel';
  }

  attach(ui) { this.ui = ui; this.results.ui = ui; }

  turn(dir, step) {
    if (this.focus === 'results') return this.results.turn(dir, step);
    const k = Math.max(0, Math.min(KEYS.length - 1, this.key + dir));
    if (k === this.key) return false;
    this.key = k;
    return true;
  }

  select(ui) {
    if (this.focus === 'results') { this.results.select(ui); return; }
    const k = KEYS[this.key];
    if (k === 'Done') { this.enterResults(); return; }
    if (k === '⌫') this.query = this.query.slice(0, -1);
    else if (this.query.length < 40) this.query += k;
    this.schedule();
  }

  // ⏭ is a shortcut into the results, like scrolling to Done.
  next() { if (this.focus === 'keys') { this.enterResults(); return true; } return false; }

  enterResults() {
    if (!this.results.length) return;
    this.focus = 'results';
  }

  // MENU from the results goes back to the letters instead of leaving.
  back() {
    if (this.focus !== 'results') return false;
    this.focus = 'keys';
    return true;
  }

  schedule() {
    clearTimeout(this.timer);
    const q = this.query.trim();
    if (q.length < 2) {
      this.results.rows = [];
      this.results.total = 0;
      this.status = q ? 'Keep going…' : 'Pick letters with the wheel';
      return;
    }
    this.status = 'Searching…';
    this.timer = setTimeout(() => this.run(q), 350);
  }

  async run(q) {
    if (this.ctrl) this.ctrl.abort();
    const ctrl = this.ctrl = new AbortController();
    try {
      const r = await api.search(q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const ui = this.ui;
      const rows = [
        ...r.artists.map((a) => ({ label: a.Name, sub: 'Artist', arrow: true, select: (u) => u.push(u.artist(a)) })),
        ...r.albums.map((a) => ({ ...ui.albumRow(a), sub: `Album · ${a.AlbumArtist || ''}` })),
        ...r.songs.map((s, i) => ({ label: s.Name, sub: s.AlbumArtist || '', select: (u) => u.playSongs(r.songs, i) })),
      ];
      this.results.rows = rows;
      this.results.total = rows.length;
      this.results.sel = 0;
      this.results.top = 0;
      this.status = rows.length ? `${rows.length} found` : 'No matches';
      ui.refresh(this);
    } catch (e) {
      if (e.name !== 'AbortError') { this.status = `Couldn't search: ${e.message}`; this.ui.refresh(this); }
    }
  }

  render(view) {
    view.replaceChildren();
    view.classList.remove('split');
    const box = el('div', 'search' + (this.focus === 'results' ? ' in-results' : ''));
    const q = el('div', 'search-query');
    q.append(el('span', 'q', this.query), el('span', 'caret'), el('span', 'search-status', this.status));
    const res = el('div', 'search-results');
    if (this.results.length) this.results.render(res);
    else res.append(el('div', 'note', this.query.trim().length >= 2 ? this.status : ''));
    if (this.focus !== 'results') res.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
    const strip = el('div', 'keys');
    const start = Math.max(0, Math.min(KEYS.length - KEY_WINDOW, this.key - Math.floor(KEY_WINDOW / 2)));
    for (let i = start; i < start + KEY_WINDOW; i++) {
      const k = KEYS[i];
      strip.append(el('span', 'key' + (i === this.key && this.focus === 'keys' ? ' on' : '') + (k.length > 1 ? ' word' : ''), k === ' ' ? '␣' : k));
    }
    box.append(q, res, strip);
    view.append(box);
  }
}

// ---------- the screen stack ----------

export class UI {
  constructor(screenEl, { player, wheel, onPassword }) {
    this.root = screenEl;
    this.player = player;
    this.wheel = wheel;
    this.onPassword = onPassword;
    this.stack = [];
    this.ticks = [];
    this.titleEl = screenEl.querySelector('.bar-title');
    this.stateEl = screenEl.querySelector('.bar-state');
    this.views = screenEl.querySelector('.views');
    this.letterEl = el('div', 'letter');
    screenEl.append(this.letterEl);
    this.view = el('div', 'view');
    this.views.append(this.view);
    this.artPane = this.makeArtPane();
    player.on((what) => {
      const top = this.top;
      if (what === 'state' || what === 'song') this.renderBar();
      if (top instanceof NowPlaying) {
        if (what === 'song' && !player.playing) { this.back(); return; }
        this.render();
      }
      if (what === 'song') this.refresh(this.homeList);   // its Now Playing row comes and goes
    });
  }

  get top() { return this.stack[this.stack.length - 1]; }

  reset(screen) {
    for (const s of this.stack) s.leave?.();
    this.stack = [screen];
    screen.attach(this);
    this.render();
  }

  push(screen) {
    this.stack.push(screen);
    screen.attach(this);
    this.slide(1);
  }

  back() {
    const top = this.top;
    if (top?.back?.()) { this.render(); return; }
    if (this.stack.length < 2) return;
    const s = this.stack.pop();
    s.leave?.();
    this.slide(-1);
  }

  // The iPod's sideways slide: new screens come in from the right, MENU goes
  // back to the left. The old view animates out on top of the new one.
  slide(dir) {
    const old = this.view;
    this.view = el('div', 'view');
    this.views.append(this.view);
    this.render();
    const opts = { duration: SLIDE_MS, easing: 'ease-out' };
    this.view.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: 'translateX(0)' }], opts);
    old.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 100}%)` }], opts)
      .finished.then(() => old.remove(), () => old.remove());
  }

  refresh(screen) { if (screen === this.top) this.render(); }

  render() {
    const top = this.top;
    if (!top) return;
    this.titleEl.textContent = top.title;
    top.render(this.view);
    this.renderBar();
  }

  renderBar() {
    const p = this.player;
    this.stateEl.textContent = !p.playing ? '' : p.paused ? '❚❚' : '▶';
  }

  // ---------- wheel input ----------

  turn(dir) {
    // Spin faster, move further: the iPod's acceleration, roughly.
    const now = performance.now();
    this.ticks = this.ticks.filter((t) => now - t < 500);
    this.ticks.push(now);
    const rate = this.ticks.length * 2;     // ticks per second
    const top = this.top;
    if (!top || !top.turn) return;
    const long = top instanceof List && top.length > 60;
    const stride = top.length > 1000 ? 25 : 8;    // per tick when spinning fast
    let moved;
    if (long && rate > 24 && top.lettersFn) {
      // One letter per ~150 ms however fast the thumb goes, so the letters
      // can be read as they pass.
      if (now - (this.lastJump || 0) < 150) return;
      moved = top.letterJump(dir);
      if (moved) this.lastJump = now;
      else moved = top.turn(dir, stride);
    } else {
      let step = 1;
      if (long && rate > 24) step = stride;
      else if (long && rate > 14) step = 3;
      moved = top.turn(dir, step);
    }
    if (!moved) return;
    this.wheel.feedback();
    this.render();
    if (long && rate > 14) this.showLetter(top.letterAt(top.sel));
  }

  // The big letter in the middle of the screen while spinning fast.
  showLetter(l) {
    if (!l) return;
    this.letterEl.textContent = l;
    this.letterEl.classList.add('on');
    clearTimeout(this.letterTimer);
    this.letterTimer = setTimeout(() => this.letterEl.classList.remove('on'), 700);
  }

  // MENU goes back. The others go to the top screen's method of the same
  // name if it has one (select, play, next, prev); play/next/prev returning
  // true means the screen kept the button (TV, the games, Search's ⏭), and
  // otherwise they drive the music.
  press(button) {
    const top = this.top;
    if (button === 'menu') { this.back(); return; }
    if (button === 'select') { if (top?.select) { top.select(this); this.render(); } return; }
    if (top?.[button]?.()) { this.render(); return; }
    if (button === 'play') this.player.toggle();
    else if (button === 'next') this.player.next();
    else if (button === 'prev') this.player.prev();
  }

  // Returns true when a screen took a center hold (the wheel then doesn't
  // count the release as a press).
  hold(button) {
    let top = this.top;
    if (button === 'select') {
      if (!top?.holdSelect?.()) return false;
      this.render();
      return true;
    }
    if (button !== 'next' && button !== 'prev') return;
    // Holding next/previous scrubs the song on Now Playing, opening it from
    // anywhere else, except on screens with their own hold (TV, Space Sheep,
    // Tiki Golf).
    if (!(top instanceof NowPlaying)) {
      if (top?.hold) { top.hold(button); return; }
      if (!this.player.playing) return;
      this.push(top = new NowPlaying(this.player));
    }
    top.hold(button);
    this.render();
  }

  holdEnd(button) {
    if (this.top instanceof NowPlaying && (button === 'next' || button === 'prev')) {
      this.top.holdEnd();
      this.render();
    }
  }

  // ---------- home screen art ----------

  // The right half of the main menu: album covers slowly drifting and
  // crossfading, like the 6th-gen iPod's main menu.
  makeArtPane() {
    const pane = el('div', 'art-pane');
    const imgs = [el('img'), el('img')];
    imgs.forEach((i) => { i.alt = ''; pane.append(i); });
    let pool = [];
    let n = 0;
    const show = () => {
      if (!pool.length || !pane.isConnected || document.hidden) return;
      const img = imgs[n % 2];
      const other = imgs[(n + 1) % 2];
      img.onload = () => {
        img.classList.remove('drift-a', 'drift-b');
        void img.offsetWidth;                  // restart the drift animation
        img.classList.add('on', n % 2 ? 'drift-a' : 'drift-b');
        other.classList.remove('on');
      };
      img.src = api.artUrl(pool[n % pool.length], 400);
      n++;
    };
    this.loadArt = () => {
      api.randomAlbumsWithArt(30).then((d) => { pool = d.Items; show(); }).catch(() => {});
    };
    setInterval(show, 6000);
    return pane;
  }

  // ---------- menus ----------

  signIn() {
    return new List('Fretzpod', {
      rows: [
        { label: 'Sign in with Quick Connect', arrow: true, select: (ui) => ui.push(new QuickConnect()) },
        { label: 'Sign in with password', arrow: true, select: () => this.onPassword() },
      ],
    });
  }

  home() {
    this.loadArt();
    const p = this.player;
    // Same order as the iPod Classic's main menu.
    const rows = [
      { label: 'Music', arrow: true, select: (ui) => ui.push(ui.music()) },
      { label: 'TV', arrow: true, select: (ui) => ui.push(ui.tv()) },
      { label: 'Extras', arrow: true, select: (ui) => ui.push(ui.extras()) },
      { label: 'Settings', arrow: true, select: (ui) => ui.push(ui.settings()) },
      { label: 'Shuffle Songs', select: (ui) => ui.shuffleSongs() },
    ];
    const nowPlaying = { label: 'Now Playing', arrow: true, select: (ui) => ui.push(new NowPlaying(p)) };
    const list = this.homeList = new List('Fretzpod', { rows, split: true });
    // Speakers only shows up for accounts fretzpod-speakers allows (and only
    // if that optional service runs); speakers.js. Added when the answer comes back.
    // TV needs the Tuner plugin on the Jellyfin server. Its row comes out
    // only on a 404 (plugin not installed), not on a passing hiccup.
    api.request('/Tuner/tv').catch((e) => {
      if (!/^404 /.test(e.message)) return;
      rows.splice(rows.findIndex((r) => r.label === 'TV'), 1);
      if (this.top === list) this.render();
    });
    listSpeakers().then((sps) => {
      if (!sps.length) return;
      rows.splice(rows.findIndex((r) => r.label === 'Settings'), 0,
        { label: 'Speakers', arrow: true, select: (ui) => ui.push(ui.speakers(sps)) });
      if (this.top === list) this.render();
    });
    // The Now Playing row only exists while something is queued, like the iPod.
    const render = list.render.bind(list);
    list.render = (view) => {
      const has = rows.includes(nowPlaying);
      if (p.playing && !has) rows.push(nowPlaying);
      if (!p.playing && has) rows.splice(rows.indexOf(nowPlaying), 1);
      list.total = rows.length;
      list.sel = Math.min(list.sel, rows.length - 1);
      render(view);
    };
    return list;
  }

  // Where the music plays: this phone, or one or both Sonos. Picking the
  // phone or a first speaker moves whatever is playing there (same song,
  // same spot); picking another speaker adds it or takes it out (speakers.js).
  speakers(sps) {
    const p = this.player;
    const row = (label, sp) => ({
      label,
      value: () => ((sp ? p.speakerIds.includes(sp.id) : !p.speaker) ? '✓' : ''),
      select: (ui) => { p.pick(sp); ui.render(); },
    });
    return new List('Speakers', { rows: [row('This phone', null), ...sps.map((s) => row(s.name, { id: s.id, name: s.name }))] });
  }

  // TV: the Tuner plugin's free channels (tv.js). The list shows what's on.
  tv() {
    return new List('TV', {
      empty: 'No channels right now',
      fetch: () => tvData.load().then((chs) => ({
        rows: chs.map((ch, i) => ({
          label: `${ch.number}  ${ch.name}`,
          sub: tvData.now(ch),
          select: (ui) => ui.push(new Tv(i, { player: ui.player, feedback: () => ui.wheel.feedback() })),
        })),
        total: chs.length,
      })),
    });
  }

  // Tiki Golf's title menu (golf.js).
  golf() {
    return new List('Tiki Golf', {
      rows: [
        { label: 'Start Game', arrow: true, select: (ui) => ui.push(ui.golfCourses()) },
        { label: 'Shop', arrow: true, select: (ui) => ui.push(ui.golfShop()) },
        { label: 'Exit Game', select: (ui) => ui.back() },
      ],
    });
  }

  // Courses, each showing its best round; later ones open with a round at
  // par or better on the one before (golf.js courseOpen).
  golfCourses() {
    return new List('Courses', {
      rows: COURSES.map((c, i) => ({
        label: c.name,
        value: () => {
          if (!courseOpen(i)) return 'Locked';
          const b = golfSave.load().best[c.id];
          return b ? `Best ${b}` : '';
        },
        select: (ui) => { if (courseOpen(i)) ui.push(new Golf(i, (press) => ui.wheel.feedback(press))); },
      })),
    });
  }

  // Coins buy balls and trails; picking one you own wears it.
  golfShop() {
    const rows = [{ label: 'Coins', value: () => String(golfSave.load().coins) }];
    for (const item of SHOP) {
      rows.push({
        label: item.name,
        value: () => {
          const d = golfSave.load();
          if (d[item.kind] === item.id) return '✓';
          return d.owned.includes(item.id) ? 'Owned' : String(item.price);
        },
        select: () => { shopPick(item); },
      });
    }
    return new List('Shop', { rows });
  }

  extras() {
    return new List('Extras', {
      rows: [
        { label: 'Vortex', arrow: true, select: (ui) => ui.push(new Vortex(() => ui.wheel.feedback())) },
        { label: 'Space Sheep', arrow: true, select: (ui) => ui.push(new SpaceSheep(() => ui.wheel.feedback())) },
        { label: 'Tiki Golf', arrow: true, select: (ui) => ui.push(ui.golf()) },
        { label: 'High Scores', arrow: true, select: (ui) => ui.push(ui.highScores()) },
      ],
    });
  }

  // The shared boards (scores.js): pick a game, see its top 10 and, further
  // down than that, where you are.
  highScores() {
    return new List('High Scores', {
      rows: [
        ...scores.BOARDS.map((b) => ({ label: b.name, arrow: true, select: (ui) => ui.push(ui.scoreBoard(b)) })),
        {
          label: 'Your Name',
          value: () => scores.me().name,
          select: (ui) => ui.push(new scores.NameEntry(scores.me())),
        },
      ],
    });
  }

  scoreBoard(b) {
    return new List(b.name, {
      empty: 'No scores yet',
      fetch: async () => {
        const d = await scores.board(b.id);
        const rows = d.top.map((e, i) => ({ label: `${i + 1}. ${e.name}${e.you ? ' (you)' : ''}`, value: () => String(e.score) }));
        if (d.you?.rank > d.top.length) rows.push({ label: `${d.you.rank}. You`, value: () => String(d.you.score) });
        return { rows, total: rows.length };
      },
    });
  }

  music() {
    return new List('Music', {
      rows: [
        { label: 'Playlists', arrow: true, select: (ui) => ui.push(ui.playlists()) },
        { label: 'Favorites', arrow: true, select: (ui) => ui.push(ui.favorites()) },
        { label: 'Artists', arrow: true, select: (ui) => ui.push(ui.artists()) },
        { label: 'Albums', arrow: true, select: (ui) => ui.push(ui.albums()) },
        { label: 'Songs', arrow: true, select: (ui) => ui.push(ui.allSongs()) },
        { label: 'Genres', arrow: true, select: (ui) => ui.push(ui.genres()) },
        { label: 'Search', arrow: true, select: (ui) => ui.push(new Search(ui)) },
      ],
    });
  }

  // Play a list of songs starting at index i, then show Now Playing.
  playSongs(items, i) {
    this.player.play(items, i, { shuffle: settings.get('shuffle') === 'songs' });
    this.push(new NowPlaying(this.player));
  }

  shuffleSongs() {
    api.randomSongs(100).then((d) => {
      if (!d.Items.length) return;
      this.player.play(d.Items, 0, { refill: () => api.randomSongs(100).then((r) => r.Items) });
      this.push(new NowPlaying(this.player));
    }).catch((e) => log(`shuffle: ${e.message}`));
  }

  songRows(items, withArtist = true) {
    return items.map((s) => ({
      label: s.Name,
      sub: withArtist ? api.artistOf(s) : '',
      select: (ui, i) => ui.playSongs(items, i),
    }));
  }

  // A list that loads all its songs at once (albums, playlists, an artist).
  songList(title, load, withArtist, empty = 'No songs') {
    return new List(title, {
      empty,
      fetch: () => load().then((d) => ({ rows: this.songRows(d.Items, withArtist), total: d.Items.length })),
    });
  }

  albumRow(a) {
    return {
      label: a.Name, sub: a.AlbumArtist || '', arrow: true,
      select: (ui) => ui.push(ui.songList(a.Name, () => api.albumSongs(a.Id), false)),
    };
  }

  // Songs hearted on Now Playing (or in any Jellyfin app).
  favorites() { return this.songList('Favorites', () => api.favoriteSongs(), true, 'No favorites yet'); }

  playlists() {
    return new List('Playlists', {
      empty: 'No playlists',
      fetch: () => api.playlists().then((d) => ({
        rows: d.Items.map((pl) => ({
          label: pl.Name, arrow: true,
          select: (ui) => ui.push(ui.songList(pl.Name, () => api.playlistSongs(pl.Id), true)),
        })),
        total: d.Items.length,
      })),
    });
  }

  artists() {
    return new List('Artists', {
      letters: api.artistLetters,
      fetch: (start, n) => api.albumArtists(start, n).then((d) => ({
        rows: d.Items.map((a) => ({ label: a.Name, arrow: true, select: (ui) => ui.push(ui.artist(a)) })),
        total: d.TotalRecordCount,
      })),
    });
  }

  artist(a) {
    return new List(a.Name, {
      fetch: () => api.artistAlbums(a.Id).then((d) => {
        const rows = [{
          label: 'All Songs', arrow: true,
          select: (ui) => ui.push(ui.songList(a.Name, () => api.artistSongs(a.Id), false)),
        }, ...d.Items.map((al) => ({ ...this.albumRow(al), sub: al.ProductionYear ? String(al.ProductionYear) : '' }))];
        return { rows, total: rows.length };
      }),
    });
  }

  albums() {
    return new List('Albums', {
      letters: api.albumLetters,
      fetch: (start, n) => api.albums(start, n).then((d) => ({ rows: d.Items.map((a) => this.albumRow(a)), total: d.TotalRecordCount })),
    });
  }

  // Picking a song from the full list plays it and the 199 after it.
  allSongs() {
    return new List('Songs', {
      fetch: (start, n) => api.songs(start, n).then((d) => ({
        rows: d.Items.map((s, j) => ({
          label: s.Name, sub: s.AlbumArtist || '',
          select: (ui) => api.songs(start + j, 200).then((r) => ui.playSongs(r.Items, 0)).catch((e) => log(`songs: ${e.message}`)),
        })),
        total: d.TotalRecordCount,
      })),
    });
  }

  genres() {
    return new List('Genres', {
      fetch: (start, n) => api.genres(start, n).then((d) => ({
        rows: d.Items.map((g) => ({
          label: g.Name, arrow: true,
          select: (ui) => ui.push(new List(g.Name, {
            empty: 'No albums',
            fetch: () => api.genreAlbums(g.Id).then((r) => ({ rows: r.Items.map((a) => this.albumRow(a)), total: r.Items.length })),
          })),
        })),
        total: d.TotalRecordCount,
      })),
    });
  }

  settings() {
    const opt = (k) => ({
      label: settings.defs[k].label,
      value: () => settings.name(k),
      select: () => { settings.cycle(k); window.dispatchEvent(new CustomEvent('fp-setting', { detail: k })); },
    });
    const rows = [opt('shuffle'), opt('repeat'), opt('quality'), opt('clicker')];
    // Firefox on Android ignores web vibration (and Safari has none), so say
    // so rather than offer a setting that does nothing.
    const firefox = /Firefox\//.test(navigator.userAgent);
    if (navigator.vibrate && !firefox) rows.push(opt('haptics'));
    else rows.push({ label: 'Haptics', value: () => (firefox ? 'Not in Firefox' : 'Not supported') });
    rows.push(
      opt('body'),
      { label: 'About', arrow: true, select: (ui) => ui.push(ui.about()) },
      { label: 'Sign Out', arrow: true, select: (ui) => ui.push(ui.confirmSignOut()) },
    );
    return new List('Settings', { rows });
  }

  about() {
    const s = api.getSession();
    const info = (label, value) => ({ label, value: () => value });
    return new List('About', {
      rows: [
        info('Fretzpod', api.VERSION),
        info('Signed in as', s ? s.name : '-'),
        info('Server', api.AWAY ? 'Away' : 'Home'),
        info('Playback', this.player.basic ? 'Basic' : streamType.mux ? 'Stream (MP4)' : 'Stream'),
        { label: 'Log', arrow: true, select: (ui) => ui.push(new List('Log', { rows: logLines().map((l) => ({ label: l })), empty: 'Empty' })) },
      ],
    });
  }

  confirmSignOut() {
    return new List('Sign Out', {
      rows: [
        { label: 'Cancel', select: (ui) => ui.back() },
        { label: 'Sign Out', select: () => { this.player.stop(); api.signOut(); } },
      ],
    });
  }
}
