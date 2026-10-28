// Cover Flow: turn the phone sideways and the albums fan out in 3D, like the
// iPod touch/iPhone did it. Swipe to flick through (with momentum), tap the
// middle cover to flip it over to its songs, tap a song to play it.
//
// Only a window of covers around the middle exists in the page (POOL of them,
// reused as you move), so 1,700 albums cost the same as 15.
//
// The A-Z bar along the top follows along and jumps when tapped or swiped.
// WHY the album list is loaded whole and sorted here: Jellyfin's "by album
// artist" order doesn't follow the artist it displays ("Her Loss" shows Drake
// but sorts under 21 Savage), and its artist-letter filter is ignored, so
// letters would jump around. One request (~200 KB compressed) and a local sort
// by the displayed artist keeps the bar, the caption and the order agreeing.
import * as api from './api.js';
import { el, fmt, log } from './util.js';

const POOL = 15;            // cover elements kept, centered on the middle one
const FRICTION = 0.95;      // momentum decay per frame
const SNAP = 0.18;          // how hard it settles onto the nearest cover
const TAP_SLOP = 16;        // px a finger may wobble and still count as a tap
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export class CoverFlow {
  // hooks.play(items, i): start songs; hooks.tick(): click + buzz per cover
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.albums = [];
    this.letters = [];        // letter of each album, same order
    this.letterStart = {};    // letter -> index of its first album
    this.total = null;          // album count; null until loaded
    this.loading = false;
    this.lastTick = 0;
    this.pos = 0;            // float: index of the cover in the middle
    this.vel = 0;
    this.target = null;      // index to glide to (tap on a side cover)
    this.dragging = null;
    this.raf = 0;
    this.lastCenter = -1;
    this.flipped = null;
    this.size = 0;           // cover width in px (measure())

    this.stage = el('div', 'cf-stage');
    this.caption = el('div', 'cf-caption');
    this.captionTitle = el('div', 'cf-title');
    this.captionArtist = el('div', 'cf-artist');
    this.caption.append(this.captionTitle, this.captionArtist);
    this.covers = [];
    for (let k = 0; k < POOL; k++) {
      const c = el('div', 'cf-cover');
      const img = el('img');
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => img.removeAttribute('src'));
      c.append(img);
      c.dataset.index = '-1';
      this.stage.append(c);
      this.covers.push(c);
    }
    this.back = el('div', 'cf-back');
    this.back.hidden = true;
    this.bar = el('div', 'cf-letters');
    for (const l of LETTERS) { const sp = el('span', '', l); sp.dataset.l = l; this.bar.append(sp); }
    root.append(this.bar, this.stage, this.caption, this.back);
    this.setupLetterBar();

    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('pointercancel', (e) => this.up(e));
  }

  show() {
    if (this.total === null) this.load();
    this.root.hidden = false;
    this.resize();
  }

  // The cover size comes from the screen size (the --s CSS variable), so
  // it's read here, on show and on resize, not every frame: reading a size
  // right after moving the covers makes the browser redo its style work on
  // the spot, sixty times a second during a flick.
  resize() {
    if (this.root.hidden) return;
    this.size = this.covers[0].offsetWidth || this.root.clientHeight * 0.54;
    this.layout();
  }

  hide() {
    this.root.hidden = true;
    this.closeBack();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---------- data ----------

  load() {
    if (this.loading) return;
    this.loading = true;
    this.captionTitle.textContent = 'Loading albums…';
    api.allAlbums().then((d) => {
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const list = d.Items.map((a) => {
        const k = (a.AlbumArtist || '').trim().replace(/^the\s+/i, '');
        const c = k.charAt(0).toUpperCase();
        return { a, k, l: /[A-Z]/.test(c) ? c : '#' };
      });
      // Numbers, symbols and non-Latin names first under "#", then A-Z by
      // artist, then album name.
      list.sort((x, y) => (x.l === '#' ? 0 : 1) - (y.l === '#' ? 0 : 1)
        || coll.compare(x.k, y.k) || coll.compare(x.a.Name, y.a.Name));
      this.albums = list.map((x) => x.a);
      this.letters = list.map((x) => x.l);
      this.letterStart = {};
      list.forEach((x, i) => { if (!(x.l in this.letterStart)) this.letterStart[x.l] = i; });
      for (const sp of this.bar.children) sp.classList.toggle('empty', !(sp.dataset.l in this.letterStart));
      this.total = this.albums.length;
      this.lastCenter = -1;
      this.layout();
    }).catch((e) => {
      this.loading = false;
      log(`cover flow: ${e.message}`);
      this.captionTitle.textContent = `Couldn't load albums: ${e.message}`;
    });
  }

  // Tap a letter to jump there, or slide a finger along the bar to skim.
  setupLetterBar() {
    const bar = this.bar;
    let active = false;
    const pick = (e) => {
      if (!this.total) return;
      let best = null;
      let dist = Infinity;
      for (const sp of bar.children) {
        const r = sp.getBoundingClientRect();
        const d = Math.abs(e.clientX - (r.left + r.width / 2));
        if (d < dist) { dist = d; best = sp; }
      }
      // An empty letter goes to the next letter that has albums.
      let k = LETTERS.indexOf(best.dataset.l);
      while (k < LETTERS.length && !(LETTERS[k] in this.letterStart)) k++;
      const i = k < LETTERS.length ? this.letterStart[LETTERS[k]] : this.total - 1;
      if (Math.round(this.pos) === i) return;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.vel = 0;
      this.target = null;
      this.pos = i;
      this.layout();
    };
    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (this.flipped) { this.closeBack(); return; }
      active = true;
      try { bar.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      pick(e);
    });
    bar.addEventListener('pointermove', (e) => { if (active) pick(e); });
    bar.addEventListener('pointerup', () => { active = false; });
    bar.addEventListener('pointercancel', () => { active = false; });
  }

  // ---------- touch ----------

  down(e) {
    // With a cover flipped over, a tap anywhere outside it flips it back.
    if (this.flipped) { if (!this.back.contains(e.target)) this.closeBack(); return; }
    this.dragging = { id: e.pointerId, x: e.clientX, startX: e.clientX, t: performance.now(), t0: performance.now(), moved: 0, target: e.target };
    this.vel = 0;
    this.target = null;
    try { this.root.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }

  move(e) {
    const d = this.dragging;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const now = performance.now();
    d.x = e.clientX;
    d.moved += Math.abs(dx);
    // One cover per ~third of the screen width feels like the original.
    const delta = -dx / this.spacing();
    this.pos = this.clamp(this.pos + delta);
    // Velocity per frame at 60 fps, smoothed and capped: touch events can
    // arrive a millisecond apart, which would otherwise read as a huge flick.
    const v = delta / Math.max(4, now - d.t) * 16;
    this.vel = Math.max(-3, Math.min(3, this.vel * 0.5 + v * 0.5));
    d.t = now;
    this.layout();
  }

  up(e) {
    const d = this.dragging;
    if (!d || d.id !== e.pointerId) return;
    this.dragging = null;
    if (d.moved < TAP_SLOP && performance.now() - d.t0 < 450) { this.tap(d.target); return; }
    this.animate();
  }

  tap(target) {
    if (this.flipped) return;
    const cover = target.closest?.('.cf-cover');
    if (!cover) return;
    const i = Number(cover.dataset.index);
    if (i < 0) return;
    if (i === Math.round(this.pos)) { this.openBack(i); return; }
    // A long way off: start most of the way there so the glide stays short.
    if (Math.abs(i - this.pos) > 10) this.pos = i - Math.sign(i - this.pos) * 6;
    this.target = i;
    this.animate();
  }

  clamp(p) { return Math.max(0, Math.min((this.total || 1) - 1, p)); }
  // Pixels of finger travel per cover: about the gap between side covers, so
  // the covers move with the finger and a full swipe goes 10+ covers.
  spacing() { return (this.size || 200) * 0.3; }

  // Momentum after a flick, then a spring onto the nearest cover.
  animate() {
    if (this.raf) return;
    const step = () => {
      if (this.dragging) { this.raf = 0; return; }
      if (this.target !== null) {
        const diff = this.target - this.pos;
        this.pos += diff * 0.2;
        if (Math.abs(diff) < 0.002) { this.pos = this.target; this.target = null; }
      } else if (Math.abs(this.vel) > 0.02) {
        this.pos = this.clamp(this.pos + this.vel);
        this.vel *= FRICTION;
      } else {
        const diff = Math.round(this.pos) - this.pos;
        this.pos += diff * SNAP;
        this.vel = 0;
        if (Math.abs(diff) < 0.002) { this.pos = Math.round(this.pos); this.layout(); this.raf = 0; return; }
      }
      this.layout();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ---------- drawing ----------

  layout() {
    if (this.root.hidden || !this.total) {
      if (this.total === 0) this.captionTitle.textContent = 'No albums';
      return;
    }
    const S = this.size;     // spacing scales with the cover size
    const center = Math.round(this.pos);
    if (center !== this.lastCenter) {
      // A click + buzz per cover, but not a buzz storm on a fast flick.
      const now = performance.now();
      if (this.lastCenter >= 0 && now - this.lastTick > 45) { this.hooks.tick(); this.lastTick = now; }
      this.lastCenter = center;
      const a = this.albums[center];
      this.captionTitle.textContent = a ? a.Name : '…';
      this.captionArtist.textContent = a ? (a.AlbumArtist || '') : '';
      const l = this.letters[center];
      for (const sp of this.bar.children) sp.classList.toggle('on', sp.dataset.l === l);
    }
    const first = center - Math.floor(POOL / 2);
    for (let k = 0; k < POOL; k++) {
      const i = first + k;
      // Each cover element is tied to i mod POOL, so a cover keeps its element
      // (and loaded image) while it moves across the screen.
      const c = this.covers[((i % POOL) + POOL) % POOL];
      if (i < 0 || i >= this.total) { c.style.visibility = 'hidden'; c.dataset.index = '-1'; continue; }
      c.style.visibility = '';
      if (c.dataset.index !== String(i) || !c.dataset.loaded) {
        const a = this.albums[i];
        c.dataset.index = String(i);
        const img = c.firstChild;
        if (a) { img.src = api.artUrl(a, 300); c.dataset.loaded = '1'; } else { img.removeAttribute('src'); delete c.dataset.loaded; }
      }
      const d = i - this.pos;
      const ad = Math.abs(d);
      const side = Math.sign(d);
      // Middle cover faces you; neighbours turn 70° and stack behind it.
      let x; let rot; let z;
      if (ad < 1) {
        x = d * S * 0.82;
        rot = -d * 70;
        z = (1 - ad) * S * 0.45;
      } else {
        x = side * (S * 0.82 + (ad - 1) * S * 0.24);
        rot = -side * 70;
        z = 0;
      }
      c.style.transform = `translateX(${x}px) translateZ(${z}px) rotateY(${rot}deg)`;
      c.style.zIndex = String(1000 - Math.round(ad * 10));
    }
  }

  // ---------- the flipped cover: track list ----------

  async openBack(i) {
    const a = this.albums[i];
    if (!a) return;
    this.flipped = a;
    const back = this.back;
    back.replaceChildren();
    const head = el('div', 'cf-back-head');
    head.append(el('div', 'cf-back-title', a.Name), el('div', 'cf-back-artist', a.AlbumArtist || ''));
    const list = el('div', 'cf-tracks');
    list.append(el('div', 'cf-loading', 'Loading…'));
    back.append(head, list);
    back.hidden = false;
    back.animate([{ transform: 'rotateY(-180deg) scale(.6)', opacity: 0 }, { transform: 'rotateY(0) scale(1)', opacity: 1 }], { duration: 380, easing: 'ease-out' });
    head.addEventListener('click', () => this.closeBack());
    try {
      const d = await api.albumSongs(a.Id);
      if (this.flipped !== a) return;
      list.replaceChildren();
      d.Items.forEach((s, j) => {
        const row = el('div', 'cf-track');
        row.append(el('span', 'n', String(s.IndexNumber || j + 1)), el('span', 'name', s.Name), el('span', 't', fmt(s.RunTimeTicks / 1e7)));
        row.addEventListener('click', () => {
          list.querySelectorAll('.cf-track.on').forEach((r) => r.classList.remove('on'));
          row.classList.add('on');
          this.hooks.play(d.Items, j);
        });
        list.append(row);
      });
    } catch (e) {
      list.replaceChildren(el('div', 'cf-loading', `Couldn't load songs: ${e.message}`));
    }
  }

  closeBack() {
    if (!this.flipped) return;
    this.flipped = null;
    const back = this.back;
    back.animate([{ transform: 'rotateY(0) scale(1)', opacity: 1 }, { transform: 'rotateY(180deg) scale(.6)', opacity: 0 }], { duration: 300, easing: 'ease-in' })
      .finished.then(() => { if (!this.flipped) back.hidden = true; }, () => { back.hidden = true; });
  }
}
