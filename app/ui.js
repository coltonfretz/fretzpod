// The iPod screen: a stack of screens (menus, Now Playing, sign-in) with the
// iPod's slide-in/slide-out, the title bar, and every menu in the app.
//
// Lists show ROWS rows at a time and only build those rows, so a 9,500-song
// list costs the same as a 5-song one. Long lists load from Jellyfin in pages
// as the selection gets near them.
import * as api from './api.js';
import { settings } from './settings.js';
import { el, fmt, log, logLines, prettyGenre, canVibrate } from './util.js';
import { StarPinball, PINBALL_TABLES, PINBALL_BALLS, pinballSave, pinballOpen, lockText } from './pinball.js';
import { goldProgress, goldId, bodyOpen } from './bodies.js';
import { Fishing, FISH_SPOTS, FISH_LURES, FISH_KINDS, fishSave, fishOpen, fishLockText } from './fishing.js';
import * as scores from './scores.js';
import { streamType } from './player.js';
import { listSpeakers } from './speakers.js';
import { HOLD_MS, HOLD_REPEAT_MS } from './wheel.js';
import { Tv, tvData } from './tv.js';
import { Golf, SHOP, golfSave, shopPick, courseOpen } from './golf.js';
import { COURSES } from './golf-holes.js';
import { CoverFlow } from './coverflow.js';
import { TIMER_CHOICES } from './alarms.js';

const ROWS = 8;            // like the iPod Classic's 320x240 screen
const PAGE = 100;
const SLIDE_MS = 220;
const SWIPE_PX = 40;       // Now Playing: a sideways swipe this long turns the card over

// ---------- screens ----------

// A menu. rows: [{label, sub, arrow, value(), select(ui)}]. For big lists
// pass fetch(start, count) -> {rows, total} instead and rows load in pages.
// arrow: true draws "›" (opens a menu); a string draws that instead ("↗" for
// a row that leaves the app). start: the row the highlight begins on.
class List {
  constructor(title, { rows = null, fetch = null, empty = 'Nothing here', split = false, letters = null, visible = ROWS, start = 0 } = {}) {
    this.title = title;
    this.lettersFn = letters;   // async () => [{l, i}]: where each letter starts
    this.letterIdx = null;
    this.visible = visible;
    this.rows = rows || [];
    this.total = rows ? rows.length : null;   // null = still loading
    this.fetchPage = fetch;
    this.empty = empty;
    this.split = split;
    this.sel = start;
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
      // main.js checks whether the server is there at all.
      window.dispatchEvent(new Event('fp-loadfail'));
    });
  }

  // The server is back: load again what failed.
  retry() {
    if (!this.error || !this.fetchPage) return;
    this.error = null;
    if (this.total === null) this.need(0);
    this.ui.refresh(this);
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

  // Hold center on a song, album, artist or playlist: its menu (HoldMenu).
  holdSelect() {
    const r = this.rows[this.sel];
    if (!r?.menu) return false;
    this.ui.push(r.menu());
    return true;
  }

  // A row with a step (Settings rows) takes ⏮/⏭; otherwise they're the
  // music's previous and next as usual.
  prev() { return this.step(-1); }
  next() { return this.step(1); }
  step(dir) {
    const r = this.rows[this.sel];
    if (!r?.step) return false;
    r.step(dir);
    return true;
  }

  render(view) {
    // The main menu's art pane stays put while the list redraws. WHY: taking
    // it out and putting it back on every wheel tick restarts its drift
    // animation and cuts its crossfade short, so scrolling hard made the
    // cover jump and tear mid-frame on phones.
    const pane = this.split ? this.ui.artPane : null;
    for (const c of [...view.children]) if (c !== pane) c.remove();
    if (pane && pane.parentNode !== view) view.append(pane);
    const add = (node) => view.insertBefore(node, pane);   // before the pane, or last
    view.classList.toggle('split', this.split);
    const list = el('div', 'list');
    if (this.visible !== ROWS) list.style.gridTemplateRows = `repeat(${this.visible}, 1fr)`;
    if (this.total === null || (this.error && !this.length)) {
      // The why (a status code) is in Settings > About > Log; need() logs it.
      list.append(el('div', 'note', this.error ? "Couldn't load. Try again later." : 'Loading…'));
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
      if (r?.arrow) row.append(el('span', 'arrow', r.arrow === true ? '›' : r.arrow));
      list.append(row);
    }
    add(list);
    if (this.length > this.visible) {
      const bar = el('div', 'scroll');
      const thumb = el('div', 'thumb');
      thumb.style.height = `${Math.max(8, (this.visible / this.length) * 100)}%`;
      thumb.style.top = `${(this.top / this.length) * 100}%`;
      bar.append(thumb);
      add(bar);
    }
  }
}

// The hold menu: what can be done with a song, album, artist or playlist
// (UI.songMenu and the rest build the rows), in a box over the list it was
// held on. The list stays in sight behind it so it's clear what the menu is
// about. MENU closes it; a menu opened from it (Add to Playlist) sits in the
// same spot, and MENU goes back to the first.
const MENU_ROWS = 6;
class HoldMenu extends List {
  constructor(head, opts) {
    super('', { ...opts, visible: Math.min(MENU_ROWS, opts.rows?.length || MENU_ROWS) });
    this.head = head;
    this.overlay = true;      // UI.push / leaveTop: no slide
  }

  attach(ui) {
    if (!this.under) {
      const below = ui.stack[ui.stack.length - 2];
      this.under = below.overlay ? below.under : below;
      this.title = this.under.title;
    }
    super.attach(ui);
  }

  render(view) {
    this.under.render(view);
    // A screen that keeps its page between renders (Now Playing) would keep
    // the last box too; only one belongs on screen.
    view.querySelectorAll(':scope > .hm, :scope > .hm-scrim').forEach((n) => n.remove());
    const box = el('div', 'hm');
    const body = el('div', 'hm-body');
    body.style.height = `${this.visible * 9.4}cqh`;
    super.render(body);
    box.append(el('div', 'hm-head', this.head), body);
    view.append(el('div', 'hm-scrim'), box);
  }
}

// Now Playing, laid out like the 6th/7th-gen iPod Classic. The wheel is the
// volume; the center button switches it to scrubbing through the song.
//
// Hold the center button for the song's hold menu, the same one as in the
// lists (Favorites, Instant Mix, Add to Playlist, Go to Artist/Album; a small
// heart on the art shows a favorite), and swipe the screen
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

  // Hold center: the song's hold menu (UI.songMenu). It used to heart the
  // song straight away; the menu has Favorites too, plus the rest (asked
  // for 2026-11-09), so holding means the same thing everywhere.
  holdSelect() {
    const item = this.player.current;
    if (!item) return false;
    this.ui.push(this.ui.songMenu(item, { np: this }));
    return true;
  }

  // Favorites from the hold menu: the heart on the art changes right away
  // and a big heart blooms, without waiting for Jellyfin.
  setFav(on) {
    const item = this.player.current;
    if (!item) return;
    const was = this.fav.get(item.Id) === true;
    this.fav.set(item.Id, on);
    this.pop(on);
    api.setFavorite(item.Id, on).then((now) => { this.fav.set(item.Id, now); this.ui.refresh(this); })
      .catch((e) => { log(`favorite: ${e.message}`); this.fav.set(item.Id, was); this.ui.refresh(this); });
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
    }).catch((e) => {
      // Jellyfin answers 401 when its admin has Quick Connect switched off.
      this.msg = /^40[13]/.test(e.message)
        ? `Quick Connect is off on ${api.SERVER_NAME}. Its admin can turn it on under Dashboard, General; or press MENU and sign in with your password.`
        : `Couldn't reach ${api.SERVER_NAME}: ${e.message}`;
      ui.refresh(this);
    });
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

  holdSelect() { return this.focus === 'results' && this.results.holdSelect(); }

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
        ...r.artists.map((a) => ({ ...ui.artistRow(a), sub: 'Artist' })),
        ...r.albums.map((a) => ({ ...ui.albumRow(a), sub: `Album · ${a.AlbumArtist || ''}` })),
        ...r.songs.map((s, i) => ({
          label: s.Name, sub: s.AlbumArtist || '', select: (u) => u.playSongs(r.songs, i), menu: () => ui.songMenu(s),
        })),
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

// Cover Flow inside the iPod screen, phone upright, driven by the wheel
// (Music > Cover Flow), like the 6th-gen iPod's. Same albums, order and A-Z
// bar as the sideways one (coverflow.js); swiping works here too. The wheel
// moves a cover per tick and a letter at a time when spun fast; center turns
// the cover over to its songs; MENU turns it back.
class CoverFlowScreen {
  constructor(ui) {
    this.title = 'Cover Flow';
    this.ticks = [];
    // tick: no-op, since UI.turn already clicks and buzzes once per turn.
    this.cf = new CoverFlow(el('div', 'cf-mini'), { play: (items, i) => ui.playSongs(items, i), tick: () => {} });
  }

  attach(ui) { this.ui = ui; }

  render(view) {
    view.classList.remove('split');
    // Only the hold menu's box gets cleared away: taking the covers out of
    // the page and back on every tick would make the browser redo them.
    const root = this.cf.root;
    for (const c of [...view.children]) if (c !== root) c.remove();
    if (root.parentNode !== view) view.append(root);
    this.cf.show();
  }

  turn(dir) {
    const now = performance.now();
    this.ticks = this.ticks.filter((t) => now - t < 500);
    this.ticks.push(now);
    if (this.cf.flipped) return this.cf.backStep(dir);
    // Spinning fast (as in UI.turn): a letter per ~150 ms, so they can be read.
    if (this.ticks.length * 2 > 24) {
      if (now - (this.lastJump || 0) < 150) return false;
      const moved = this.cf.jumpLetter(dir);
      if (moved) this.lastJump = now;
      return moved;
    }
    return this.cf.step(dir);
  }

  select() {
    if (this.cf.flipped) this.cf.backPlay();
    else this.cf.openBack(this.cf.centerIndex());
  }

  back() {
    if (!this.cf.flipped) return false;
    this.cf.closeBack();
    return true;
  }

  // The hold menu for the song highlighted, or for the album in the middle.
  holdSelect() {
    const song = this.cf.flipped && this.cf.backSong();
    const album = !this.cf.flipped && this.cf.centerAlbum();
    if (song) this.ui.push(this.ui.songMenu(song, { albumId: song.AlbumId }));
    else if (album) this.ui.push(this.ui.albumMenu(album));
    else return false;
    return true;
  }

  leave() { this.cf.hide(); }
}

// Setting a time with the wheel, like the iPod's alarm clock: one step of the
// setting's values per tick (a quarter hour, or 5 minutes for the alarm);
// center or MENU keeps it. key: a setting whose
// values are quarter hours (settings.js quarterHours).
class TimePicker {
  constructor(title, key) {
    this.title = title;
    this.key = key;
    this.values = settings.defs[key].values;
    this.i = this.values.indexOf(settings.get(key));
  }

  attach(ui) { this.ui = ui; }

  turn(dir) {
    this.i = (this.i + dir + this.values.length) % this.values.length;
    return true;
  }

  // Center and MENU both keep the time shown: a tester set 9:30, pressed
  // MENU and lost it without a word (2026-11-09).
  save() {
    settings.set(this.key, this.values[this.i]);
    window.dispatchEvent(new CustomEvent('fp-setting', { detail: this.key }));
  }

  select(ui) { this.save(); ui.back(); }

  back() { this.save(); return false; }

  render(view) {
    view.classList.remove('split');
    const box = el('div', 'tp');
    box.append(el('div', 'tp-time', settings.defs[this.key].names[this.values[this.i]]));
    view.replaceChildren(box);
  }
}

// ---------- the screen stack ----------

export class UI {
  constructor(screenEl, { player, wheel, onPassword, onServer }) {
    this.root = screenEl;
    this.player = player;
    this.wheel = wheel;
    this.onPassword = onPassword;
    this.onServer = onServer;
    this.stack = [];
    this.ticks = [];
    this.titleEl = screenEl.querySelector('.bar-title');
    this.stateEl = screenEl.querySelector('.bar-state');
    this.views = screenEl.querySelector('.views');
    this.letterEl = el('div', 'letter');
    this.toastEl = el('div', 'toast');
    screenEl.append(this.letterEl, this.toastEl);
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

  // A screen the sleep screen may cover (sleep.js): menus, Now Playing and
  // Search, not a game, TV or sign-in.
  // Lyrics being read count as busy, not calm.
  calm() {
    const t = this.top;
    if (t instanceof NowPlaying) return !t.lyricsOn;
    return t instanceof List || t instanceof Search || t instanceof CoverFlowScreen;
  }

  // Lyrics up while music plays: the screen is kept on (sleep.js) so it
  // doesn't time out mid-song.
  reading() {
    const t = this.top;
    return t instanceof NowPlaying && t.lyricsOn && this.player.playing && !this.player.paused;
  }

  reset(screen) {
    for (const s of this.stack) s.leave?.();
    this.stack = [screen];
    screen.attach(this);
    this.render();
  }

  push(screen) {
    this.stack.push(screen);
    screen.attach(this);
    if (screen.overlay) this.render(); else this.slide(1);
  }

  back() {
    const top = this.top;
    if (top?.back?.()) { this.render(); return; }
    this.leaveTop();
  }

  // Off the top screen, whatever it would rather do with MENU.
  leaveTop() {
    if (this.stack.length < 2) return;
    const s = this.stack.pop();
    s.leave?.();
    if (s.overlay) this.render(); else this.slide(-1);
  }

  // Shuts every hold menu that's open (after picking something in one).
  closeMenus() {
    let shut = false;
    while (this.top?.overlay) { this.stack.pop(); shut = true; }
    if (shut) this.render();
  }

  // A short note over the screen ("Playing Next"), gone after a moment.
  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('on'), 1600);
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

  // Raw buttons (wheel.js), for a game that needs each press and release as
  // it happens (Star Pinball's flippers and plunger). MENU and play still
  // act on the touch, like a press. The wheel doesn't time holds in raw
  // mode, so MENU's hold (the games' pause menu, pause.js) is timed here
  // the same way: from HOLD_MS, repeating every HOLD_REPEAT_MS.
  raw() { return this.top?.rawButtons === true; }

  down(button) {
    if (button === 'menu') {
      this.press(button);
      this.endRawMenu();
      this.rawMenu = setTimeout(() => {
        this.hold('menu');
        this.rawMenu = setInterval(() => this.hold('menu'), HOLD_REPEAT_MS);
      }, HOLD_MS);
      return;
    }
    if (button === 'play') { this.press(button); return; }
    this.top?.down?.(button);
  }

  up(button) {
    if (button === 'menu') { this.endRawMenu(); return; }
    this.top?.up?.(button);
  }

  endRawMenu() { clearTimeout(this.rawMenu); clearInterval(this.rawMenu); this.rawMenu = null; }

  // Returns true when a screen took a center hold (the wheel then doesn't
  // count the release as a press).
  hold(button) {
    let top = this.top;
    if (button === 'select') {
      if (!top?.holdSelect?.()) return false;
      this.render();
      return true;
    }
    // Holding MENU in a game opens its pause menu (pause.js); the game does
    // that itself and returns false. holdMenu returns true only where a tap
    // would leave anyway (end screens). The hold repeats while the thumb
    // stays down; after leaving, the repeats land on the screen below,
    // which has no holdMenu, so it leaves only once.
    if (button === 'menu') {
      if (top?.holdMenu?.()) { this.wheel.feedback(true); this.leaveTop(); }
      else this.render();
      return;
    }
    // Holding Play/Pause about a second: Sleep Mode, the way holding it
    // switched the old iPod off (sleep.js; only when Sleep Mode isn't Off).
    // The hold repeats while the thumb stays down; it fires once.
    if (button === 'play') {
      const now = performance.now();
      if (!this.playHeld || now - this.playHeld.last > HOLD_REPEAT_MS * 3) this.playHeld = { from: now, done: false };
      this.playHeld.last = now;
      if (!this.playHeld.done && now - this.playHeld.from >= 700) {
        this.playHeld.done = true;
        window.dispatchEvent(new Event('fp-sleep'));
      }
      return;
    }
    if (button !== 'next' && button !== 'prev') return;
    // Holding next/previous scrubs the song on Now Playing, opening it from
    // anywhere else, except on screens with their own hold (TV,
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
      // Hidden under car mode too: no art downloads on a drive's mobile data.
      if (!pool.length || !pane.isConnected || document.hidden || document.body.classList.contains('car-on')) return;
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
    // The app build asks for the person's own server first (api.js BYOS).
    if (api.BYOS && !api.hasServer()) {
      return new List('Fretzpod', {
        rows: [{ label: 'Connect to your server', arrow: true, select: () => this.onServer() }],
      });
    }
    const rows = [
      { label: 'Sign in with Quick Connect', arrow: true, select: (ui) => ui.push(new QuickConnect()) },
      { label: 'Sign in with password', arrow: true, select: () => this.onPassword() },
    ];
    if (api.BYOS) rows.push({ label: 'Server', value: () => api.SERVER_NAME, select: () => this.onServer() });
    return new List('Fretzpod', { rows });
  }

  // Signed in, but the server isn't answering (main.js checkServer). Opens
  // over whatever was showing; closes itself once the server answers.
  unreachable(retry) {
    const rows = [
      { label: `Can't reach ${api.SERVER_NAME}` },
      { label: 'Try again', select: () => retry() },
    ];
    if (api.BYOS) rows.push({ label: 'Change server', arrow: true, select: () => this.onServer() });
    rows.push({ label: 'Sign out', arrow: true, select: (ui) => ui.push(ui.confirmSignOut()) });
    const screen = new List(api.SERVER_NAME, { rows, start: 1 });
    // MENU stays put: behind it is only menus that can't load. It closes
    // itself when the server answers (main.js).
    screen.back = () => true;
    return screen;
  }

  home() {
    this.loadArt();
    const p = this.player;
    // Same order as the iPod Classic's main menu.
    const rows = [
      { label: 'Music', arrow: true, select: (ui) => ui.push(ui.music()) },
      { label: 'Extras', arrow: true, select: (ui) => ui.push(ui.extras()) },
      { label: 'Settings', arrow: true, select: (ui) => ui.push(ui.settings()) },
      { label: 'Shuffle Songs', select: (ui) => ui.shuffleSongs() },
    ];
    const nowPlaying = { label: 'Now Playing', arrow: true, select: (ui) => ui.push(new NowPlaying(p)) };
    // Sleep Mode by hand (sleep.js), when it's on in Settings.
    const sleepRow = { label: 'Sleep', select: () => window.dispatchEvent(new Event('fp-sleep')) };
    const list = this.homeList = new List('Fretzpod', { rows, split: true });
    // Speakers only shows up for accounts fretzpod-speakers allows (and only
    // if that optional service runs); speakers.js. Added when the answer comes back.
    // TV needs the Tuner plugin on the Jellyfin server, so its row only
    // goes in once the server says the plugin is there. Waiting for a yes,
    // not a 404: some servers' "not found" reaches a web page as a bare
    // network error (no CORS header on it), the Jellyfin demo's for one.
    api.request('/Tuner/tv').then((d) => {
      if (!d?.enabled || rows.some((r) => r.label === 'TV')) return;
      rows.splice(1, 0, { label: 'TV', arrow: true, select: (ui) => ui.push(ui.tv()) });
      if (this.top === list) this.render();
    }).catch(() => {});
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
      // Sleep sits right after Settings, away from Now Playing at the bottom,
      // so spinning down to Now Playing doesn't land on it (tester, 2026-11-09).
      const wantSleep = settings.get('sleepMode') !== 'off';
      if (wantSleep && !rows.includes(sleepRow)) rows.splice(rows.findIndex((r) => r.label === 'Settings') + 1, 0, sleepRow);
      if (!wantSleep && rows.includes(sleepRow)) rows.splice(rows.indexOf(sleepRow), 1);
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

  // A game's prize body (bodies.js): how far along the lifetime total is, and
  // once it's open, picking the row puts it on (✓ while it's on).
  goldRow(game) {
    const id = goldId(game);
    return {
      label: 'Gold Body',
      value: () => (settings.get('body') === id ? '✓' : goldProgress(game)),
      select: (ui) => {
        if (!bodyOpen(id)) return;
        settings.set('body', id);
        window.dispatchEvent(new CustomEvent('fp-setting', { detail: 'body' }));
        ui.render();
      },
    };
  }

  // Star Pinball's title menu (pinball.js). Tables and balls open as the
  // points from every game add up; Total points shows the total so far.
  pinball() {
    return new List('Star Pinball', {
      rows: [
        { label: 'Start Game', arrow: true, select: (ui) => ui.push(ui.pinballTables()) },
        { label: 'Balls', arrow: true, select: (ui) => ui.push(ui.pinballBalls()) },
        this.goldRow('pinball'),
        { label: 'Exit Game', select: (ui) => ui.back() },
      ],
    });
  }

  pinballTables() {
    return new List('Tables', {
      start: 1,   // the first table: Total points above it only shows a number
      rows: [
        { label: 'Total points', value: () => pinballSave.load().points.toLocaleString() },
        ...PINBALL_TABLES.map((t, i) => ({
          label: t.name,
          value: () => {
            if (!pinballOpen(t)) return lockText(t);
            const b = pinballSave.load().best[t.id];
            return b ? `Best ${b.toLocaleString()}` : '';
          },
          select: (ui) => { if (pinballOpen(t)) ui.push(new StarPinball(i, () => ui.wheel.feedback())); },
        })),
      ],
    });
  }

  // Looks only; picking an open one uses it from the next game.
  pinballBalls() {
    return new List('Balls', {
      start: 1,   // the first ball: Total points above it only shows a number
      rows: [
        { label: 'Total points', value: () => pinballSave.load().points.toLocaleString() },
        ...PINBALL_BALLS.map((b) => ({
          label: b.name,
          value: () => {
            if (!pinballOpen(b)) return lockText(b);
            return pinballSave.load().ball === b.id ? '✓' : '';
          },
          select: (ui) => {
            if (!pinballOpen(b)) return;
            const d = pinballSave.load();
            d.ball = b.id;
            pinballSave.save(d);
            ui.render();
          },
        })),
      ],
    });
  }

  // Fishing Trip's title menu (fishing.js). Spots and lures open as the
  // points from every catch add up; the Fish Log is the collection.
  fishing() {
    return new List('Fishing Trip', {
      rows: [
        { label: 'Go Fishing', arrow: true, select: (ui) => ui.push(ui.fishingSpots()) },
        { label: 'Lures', arrow: true, select: (ui) => ui.push(ui.fishingLures()) },
        { label: 'Fish Log', arrow: true, select: (ui) => ui.push(ui.fishLog()) },
        this.goldRow('fish'),
        { label: 'Exit Game', select: (ui) => ui.back() },
      ],
    });
  }

  fishingSpots() {
    return new List('Spots', {
      start: 1,   // the first spot: Total points above it only shows a number
      rows: [
        { label: 'Total points', value: () => fishSave.load().points.toLocaleString() },
        ...FISH_SPOTS.map((s, i) => ({
          label: s.name,
          value: () => {
            if (!fishOpen(s)) return fishLockText(s);
            const log = fishSave.load().log, kinds = FISH_KINDS.filter((f) => f.spot === s.id);
            return `${kinds.filter((f) => log[f.id]).length} / ${kinds.length}`;
          },
          select: (ui) => { if (fishOpen(s)) ui.push(new Fishing(i, () => ui.wheel.feedback(), () => ui.wheel.bite())); },
        })),
      ],
    });
  }

  // Picking an open one uses it from the next cast.
  fishingLures() {
    return new List('Lures', {
      start: 1,   // the first lure: Total points above it only shows a number
      rows: [
        { label: 'Total points', value: () => fishSave.load().points.toLocaleString() },
        ...FISH_LURES.map((l) => ({
          label: l.name,
          value: () => (!fishOpen(l) ? fishLockText(l) : fishSave.load().lure === l.id ? '✓' : ''),
          select: (ui) => {
            if (!fishOpen(l)) return;
            const d = fishSave.load();
            d.lure = l.id;
            fishSave.save(d);
            ui.render();
          },
        })),
      ],
    });
  }

  // Every kind of fish, in spot order: unknown ones show only where they
  // live; caught ones show the lures they take and the biggest so far.
  fishLog() {
    const log = fishSave.load().log;
    const spotName = (id) => FISH_SPOTS.find((s) => s.id === id).name;
    const lureName = (id) => FISH_LURES.find((l) => l.id === id).name;
    return new List('Fish Log', {
      rows: [
        { label: 'Caught', value: () => `${FISH_KINDS.filter((f) => log[f.id]).length} / ${FISH_KINDS.length}` },
        ...FISH_KINDS.map((f) => (log[f.id]
          ? { label: f.name, sub: f.lures.map(lureName).join(', '), value: () => `${log[f.id].best} cm` }
          : { label: '???', sub: spotName(f.spot) })),
      ],
    });
  }

  // Tiki Golf's title menu (golf.js).
  golf() {
    return new List('Tiki Golf', {
      rows: [
        { label: 'Start Game', arrow: true, select: (ui) => ui.push(ui.golfCourses()) },
        { label: 'Shop', arrow: true, select: (ui) => ui.push(ui.golfShop()) },
        this.goldRow('golf'),
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
        { label: 'Star Pinball', arrow: true, select: (ui) => ui.push(ui.pinball()) },
        { label: 'Fishing Trip', arrow: true, select: (ui) => ui.push(ui.fishing()) },
        { label: 'Tiki Golf', arrow: true, select: (ui) => ui.push(ui.golf()) },
        // The shared boards run beside a site's server (scores/); the app build has none.
        ...(api.HELPERS ? [{ label: 'High Scores', arrow: true, select: (ui) => ui.push(ui.highScores()) }] : []),
        { label: 'Alarms', arrow: true, select: (ui) => ui.push(ui.alarmsMenu()) },
      ],
    });
  }

  // Extras > Alarms (alarms.js; this.alarms is set by main.js): the alarm,
  // its time, repeat and music, and the sleep timer.
  alarmsMenu() {
    const a = this.alarms;
    const opt = (k) => this.settingRow(k);
    return new List('Alarms', {
      rows: [
        opt('alarmOn'),
        { ...opt('alarmTime'), arrow: true, select: (ui) => ui.push(new TimePicker('Alarm Time', 'alarmTime')) },
        opt('alarmRepeat'),
        { label: 'Plays', value: () => a.plays.name, arrow: true, select: (ui) => ui.push(ui.alarmPlays()) },
        { label: 'Sleep Timer', value: () => a.timerText(), arrow: true, select: (ui) => ui.push(ui.sleepTimer()) },
      ],
    });
  }

  // What the alarm plays: Shuffle Songs, Favorites (shuffled) or a playlist.
  alarmPlays() {
    const a = this.alarms;
    const pick = (plays) => ({
      label: plays.name,
      value: () => (a.plays.kind === plays.kind && a.plays.id === plays.id ? '✓' : ''),
      select: (ui) => { a.plays = plays; ui.back(); },
    });
    return new List('Plays', {
      fetch: () => api.playlists().then((d) => {
        const rows = [pick({ kind: 'shuffle', name: 'Shuffle Songs' }), pick({ kind: 'favorites', name: 'Favorites' }),
          ...d.Items.map((pl) => pick({ kind: 'playlist', id: pl.Id, name: pl.Name }))];
        return { rows, total: rows.length };
      }),
    });
  }

  sleepTimer() {
    return new List('Sleep Timer', {
      rows: TIMER_CHOICES.map((c) => ({
        label: c.name,
        select: (ui) => {
          ui.alarms.setTimer(c.id);
          ui.back();
          if (c.id !== 'off') ui.toast(c.id === 'song' ? 'Stops after this song' : `Stops in ${c.name.toLowerCase()}`);
        },
      })),
    });
  }

  // The alarm's music (alarms.js ring()).
  alarmMusic(plays) {
    if (plays.kind === 'shuffle') { this.shuffleSongs(); return; }
    const load = plays.kind === 'favorites' ? api.favoriteSongs() : api.playlistSongs(plays.id);
    load.then((d) => {
      if (!d.Items.length) { this.shuffleSongs(); return; }   // an empty pick still wakes you
      this.player.play(d.Items, 0, { shuffle: plays.kind === 'favorites' || settings.get('shuffle') === 'songs' });
      this.showNowPlaying();
    }).catch((e) => { log(`alarm music: ${e.message}`); this.shuffleSongs(); });
  }

  showNowPlaying() {
    if (!(this.top instanceof NowPlaying)) this.push(new NowPlaying(this.player));
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
        { label: 'Cover Flow', arrow: true, select: (ui) => ui.push(new CoverFlowScreen(ui)) },
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
  // Already on Now Playing (Instant Mix from its hold menu): stay on it
  // rather than stacking a second one.
  playSongs(items, i) {
    this.player.play(items, i, { shuffle: settings.get('shuffle') === 'songs' });
    this.showNowPlaying();
  }

  shuffleSongs() {
    api.randomSongs(100).then((d) => {
      if (!d.Items.length) return;
      this.player.play(d.Items, 0, { refill: () => api.randomSongs(100).then((r) => r.Items) });
      this.showNowPlaying();
    }).catch((e) => log(`shuffle: ${e.message}`));
  }

  // ctx: where the list is ({albumId} inside an album, {artistId} under an
  // artist), so the hold menu leaves out "Go to" the place you're already in.
  songRows(items, withArtist = true, ctx = {}) {
    return items.map((s) => ({
      label: s.Name,
      sub: withArtist ? api.artistOf(s) : '',
      select: (ui, i) => ui.playSongs(items, i),
      menu: () => this.songMenu(s, ctx),
    }));
  }

  // A list that loads all its songs at once (albums, playlists, an artist).
  songList(title, load, withArtist, empty = 'No songs', ctx = {}) {
    return new List(title, {
      empty,
      fetch: () => load().then((d) => ({ rows: this.songRows(d.Items, withArtist, ctx), total: d.Items.length })),
    });
  }

  albumRow(a, ctx = {}) {
    return {
      label: a.Name, sub: a.AlbumArtist || '', arrow: true,
      select: (ui) => ui.push(ui.album(a, ctx)),
      menu: () => this.albumMenu(a, ctx),
    };
  }

  album(a, ctx = {}) {
    return this.songList(a.Name, () => api.albumSongs(a.Id), false, undefined, { ...ctx, albumId: a.Id });
  }

  artistRow(a) {
    return { label: a.Name, arrow: true, select: (ui) => ui.push(ui.artist(a)), menu: () => this.artistMenu(a) };
  }

  // ---------- the hold menu (HoldMenu) ----------
  //
  // Hold center on a song: Play Next, Play Later, Instant Mix, Add to
  // Playlist, Favorites, Go to Artist, Go to Album. Albums, artists and
  // playlists get the ones that make sense for a whole bunch of songs.

  // ctx.np: opened on Now Playing for the song playing. Play Next and Play
  // Later are left out there (it's already playing), and Favorites goes
  // through Now Playing so its heart and bloom show it.
  songMenu(s, ctx = {}) {
    const one = () => Promise.resolve([s]);
    const fav = {
      label: 'Add to Favorites',
      select: (ui) => {
        if (!ctx.np) { ui.setFav(s, fav.on !== true); return; }
        ui.closeMenus();
        ctx.np.setFav(fav.on !== true);
      },
    };
    const rows = [...(ctx.np ? [] : this.queueRows(one)), this.mixRow(s.Id), this.playlistRow(one), fav];
    const artist = s.AlbumArtists?.[0];
    if (artist?.Id && artist.Id !== ctx.artistId) rows.push(this.goRow('Go to Artist', (ui) => ui.artist(artist)));
    if (s.AlbumId && s.AlbumId !== ctx.albumId) {
      rows.push(this.goRow('Go to Album', (ui) => ui.album({ Id: s.AlbumId, Name: s.Album || 'Album' })));
    }
    const menu = new HoldMenu(s.Name, { rows });
    const show = (on) => { fav.on = on; fav.label = on ? 'Remove from Favorites' : 'Add to Favorites'; };
    // Now Playing already knows; lists load without favorites (faster), so
    // ask now, while the menu is up.
    const known = ctx.np?.fav.get(s.Id);
    if (known === true || known === false) show(known);
    else api.isFavorite(s.Id).then((on) => { show(on); this.refresh(menu); }).catch(() => {});
    return menu;
  }

  albumMenu(a, ctx = {}) {
    const songs = () => api.albumSongs(a.Id).then((d) => d.Items);
    const rows = [...this.queueRows(songs), this.mixRow(a.Id), this.playlistRow(songs)];
    const artist = a.AlbumArtists?.[0];
    if (artist?.Id && artist.Id !== ctx.artistId) rows.push(this.goRow('Go to Artist', (ui) => ui.artist(artist)));
    return new HoldMenu(a.Name, { rows });
  }

  artistMenu(a) {
    const songs = () => api.artistSongs(a.Id).then((d) => d.Items);
    return new HoldMenu(a.Name, { rows: [...this.queueRows(songs), this.mixRow(a.Id)] });
  }

  playlistMenu(pl) {
    const songs = () => api.playlistSongs(pl.Id).then((d) => d.Items);
    return new HoldMenu(pl.Name, { rows: this.queueRows(songs) });
  }

  // Play Next / Play Later. With nothing playing, both just play the songs.
  // The menu shuts right away; loading an album's songs can take a moment.
  queueRows(load) {
    const row = (label, how, note) => ({
      label,
      select: (ui) => {
        ui.closeMenus();
        load().then((items) => {
          if (!items.length) return;
          if (!ui.player.playing) { ui.playSongs(items, 0); return; }
          ui.player[how](items);
          ui.toast(note);
        }).catch((e) => { log(`${how}: ${e.message}`); ui.toast("Couldn't load the songs"); });
      },
    });
    return [row('Play Next', 'playNext', 'Playing Next'), row('Play Later', 'playLater', 'Playing Later')];
  }

  // Jellyfin's Instant Mix: songs like this one, played right away.
  mixRow(id) {
    return {
      label: 'Instant Mix',
      select: (ui) => {
        ui.closeMenus();
        api.instantMix(id).then((d) => {
          if (d.Items.length) ui.playSongs(d.Items, 0); else ui.toast('No mix for this one');
        }).catch((e) => { log(`instant mix: ${e.message}`); ui.toast("Couldn't make a mix"); });
      },
    };
  }

  // Add to Playlist: the person's playlists, in the same box.
  playlistRow(load) {
    return {
      label: 'Add to Playlist', arrow: true,
      select: (ui) => ui.push(new HoldMenu('Add to Playlist', {
        empty: 'No playlists',
        fetch: () => api.playlists().then((d) => ({
          rows: d.Items.map((pl) => ({
            label: pl.Name,
            select: (u) => {
              u.closeMenus();
              load().then((items) => api.addToPlaylist(pl.Id, items.map((x) => x.Id)))
                .then(() => u.toast(`Added to ${pl.Name}`))
                .catch((e) => {
                  log(`add to playlist: ${e.message}`);
                  u.toast(/^403 /.test(e.message) ? "That playlist isn't yours to change" : "Couldn't add it");
                });
            },
          })),
          total: d.Items.length,
        })),
      })),
    };
  }

  goRow(label, make) {
    return { label, arrow: true, select: (ui) => { ui.closeMenus(); ui.push(make(ui)); } };
  }

  setFav(item, on) {
    this.closeMenus();
    api.setFavorite(item.Id, on)
      .then(() => this.toast(on ? 'Added to Favorites' : 'Removed from Favorites'))
      .catch((e) => { log(`favorite: ${e.message}`); this.toast("Couldn't change Favorites"); });
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
          menu: () => this.playlistMenu(pl),
        })),
        total: d.Items.length,
      })),
    });
  }

  artists() {
    return new List('Artists', {
      letters: api.artistLetters,
      fetch: (start, n) => api.albumArtists(start, n).then((d) => ({
        rows: d.Items.map((a) => this.artistRow(a)),
        total: d.TotalRecordCount,
      })),
    });
  }

  artist(a) {
    return new List(a.Name, {
      fetch: () => api.artistAlbums(a.Id).then((d) => {
        const rows = [{
          label: 'All Songs', arrow: true,
          select: (ui) => ui.push(ui.songList(a.Name, () => api.artistSongs(a.Id), false, undefined, { artistId: a.Id })),
          menu: () => this.artistMenu(a),
        }, ...d.Items.map((al) => ({
          ...this.albumRow(al, { artistId: a.Id }), sub: al.ProductionYear ? String(al.ProductionYear) : '',
        }))];
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
          menu: () => this.songMenu(s),
        })),
        total: d.TotalRecordCount,
      })),
    });
  }

  genres() {
    const pretty = prettyGenre;   // capitals back on lowercase genre names (util.js)
    return new List('Genres', {
      fetch: (start, n) => api.genres(start, n).then((d) => ({
        rows: d.Items.map((g) => ({
          label: pretty(g.Name), arrow: true,
          select: (ui) => ui.push(new List(pretty(g.Name), {
            empty: 'No albums',
            fetch: () => api.genreAlbums(g.Id).then((r) => ({ rows: r.Items.map((a) => this.albumRow(a)), total: r.Items.length })),
          })),
        })),
        total: d.TotalRecordCount,
      })),
    });
  }

  // A row for one setting: center goes on to the next value, ⏮/⏭ step back
  // or on, wrapping round (with up to nine bodies, one way round was a long
  // trip).
  settingRow(k) {
    return {
      label: settings.defs[k].label,
      value: () => settings.name(k),
      select: () => { settings.cycle(k); window.dispatchEvent(new CustomEvent('fp-setting', { detail: k })); },
      step: (dir) => { settings.cycle(k, dir); window.dispatchEvent(new CustomEvent('fp-setting', { detail: k })); },
    };
  }

  settings() {
    const opt = (k) => this.settingRow(k);
    const rows = [opt('shuffle'), opt('repeat'), opt('quality'), opt('clicker')];
    // Firefox on Android ignores web vibration (and Safari has none), so say
    // so rather than offer a setting that does nothing. The Android app
    // vibrates natively, whatever browser the phone uses.
    const firefox = /Firefox\//.test(navigator.userAgent);
    if (canVibrate) rows.push(opt('haptics'));
    else rows.push({ label: 'Haptics', value: () => (firefox ? 'Not in Firefox' : 'Not supported') });
    rows.push(
      opt('body'),
      this.wheelRow(opt('wheel')),
      opt('accent'),
      { label: 'Screen', value: () => settings.name('screen'), arrow: true, select: (ui) => ui.push(ui.scheduleMenu(opt, 'Screen', 'screen', 'darkFrom', 'darkTo')) },
      opt('sleep'),
      { label: 'Sleep Mode', value: () => settings.name('sleepMode'), arrow: true, select: (ui) => ui.push(ui.scheduleMenu(opt, 'Sleep Mode', 'sleepMode', 'sleepFrom', 'sleepTo')) },
      { label: 'In the Car', arrow: true, select: (ui) => ui.push(ui.car()) },
      { label: 'About', arrow: true, select: (ui) => ui.push(ui.about()) },
      { label: 'Sign Out', arrow: true, select: (ui) => ui.push(ui.confirmSignOut()) },
    );
    return new List('Settings', { rows });
  }

  // Settings > Sleep Mode and Settings > Screen: the Mode, plus Starts and
  // Ends, which only show while Mode is Scheduled (its key is 'night' in
  // both): elsewhere they'd be rows that do nothing (tester, 2026-11-09). A
  // time row opens the picker (TimePicker); ⏮/⏭ on it step a quarter hour.
  scheduleMenu(opt, title, modeKey, fromKey, toKey) {
    const time = (k) => ({
      ...opt(k),
      arrow: true,
      select: (ui) => ui.push(new TimePicker(settings.defs[k].label, k)),
    });
    const list = new List(title, { rows: [] });
    const mode = opt(modeKey);
    const build = () => {
      const rows = [{ ...mode, label: 'Mode', select: (ui) => { mode.select(ui); build(); }, step: (dir) => { mode.step(dir); build(); } }];
      if (settings.get(modeKey) === 'night') rows.push(time(fromKey), time(toKey));
      list.rows = rows;
      list.total = rows.length;
    };
    build();
    return list;
  }

  // Settings > Wheel: on a prize body it says so instead of a color, since
  // the gold and clear wheels stay as they are (main.js applyBody).
  wheelRow(row) {
    const prize = () => { const b = settings.get('body'); return b.startsWith('gold') || b === 'clear'; };
    return {
      ...row,
      value: () => (prize() ? 'Prize body' : row.value()),
      select: (ui) => { if (!prize()) row.select(ui); },
      step: (dir) => { if (!prize()) row.step(dir); },
    };
  }

  // Android Auto and CarPlay only list apps built for car screens, which a
  // web page can never be, so those two rows open the store page for Jellify
  // (a free Jellyfin app that has both); it signs in with the same server and
  // account as Fretzpod. Plain Bluetooth needs no row: the car shows the song
  // and the steering wheel buttons reach the Media Session handlers in
  // player.js on their own, and a web page can't open the phone's Bluetooth
  // settings to help with pairing (Chrome only launches apps that ask to be
  // opened from the web, which Settings doesn't).
  car() {
    // window.open, not location: leaving the page would stop the music. The
    // store links open the phone's own store app.
    const store = (label, url) => ({
      // "↗", not "›": these leave the app rather than open a menu. The
      // FE0E keeps phones from drawing it as an emoji.
      label, value: () => 'Jellify', arrow: '\u2197\uFE0E',
      select: () => window.open(url, '_blank', 'noopener'),
    });
    const stores = [
      store('Android Auto', 'https://play.google.com/store/apps/details?id=com.cosmonautical.jellify'),
      store('CarPlay', 'https://apps.apple.com/us/app/jellify/id6736884612'),
    ];
    if (/iPhone|iPad/.test(navigator.userAgent)) stores.reverse();
    return new List('In the Car', {
      rows: [
        // Big buttons and Now Playing for a phone on the dashboard (carmode.js).
        { label: 'Enter Car Mode', arrow: true, select: () => window.dispatchEvent(new CustomEvent('fp-car', { detail: true })) },
        ...stores,
      ],
    });
  }

  about() {
    const s = api.getSession();
    const info = (label, value) => ({ label, value: () => value });
    return new List('About', {
      rows: [
        info('Fretzpod', api.VERSION),
        info('Signed in as', s ? s.name : '-'),
        info('Server', api.BYOS ? api.SERVER_NAME : api.AWAY ? 'Away' : 'Home'),
        info('Playback', this.player.basic ? 'Basic' : streamType.mux ? 'Stream (MP4)' : 'Stream'),
        { label: 'Log', arrow: true, select: (ui) => ui.push(new List('Log', { rows: logLines().map((l) => ({ label: l })), empty: 'Empty' })) },
        // The User Guide (app/guide/, served at /guide/). A new tab or window:
        // leaving this page would stop the music.
        { label: 'User Guide', arrow: '\u2197\uFE0E', select: () => window.open('guide/', '_blank', 'noopener') },
        // Google Play wants the policy reachable from inside the app too.
        { label: 'Privacy Policy', arrow: '\u2197\uFE0E', select: () => window.open('https://coltonfretz.github.io/fretzpod/privacy.html', '_blank', 'noopener') },
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
