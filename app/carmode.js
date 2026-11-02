// Car mode: Fretzpod for a phone on the dashboard, next to Maps.
//
// Android can show two apps at once (split screen), so the idea is Maps in one
// half and this in the other. iPhones have no split screen; there it runs full
// screen and Maps is a swipe away. Either way the layout fits roughly a square
// (half a phone, held either way up) and stretches to a whole phone.
//
// WHY not the iPod screen with its click wheel: turning a ring with a fingertip
// takes eyes and precision, the two things a driver can't spare. So the wheel
// keeps its look but becomes four big buttons where the iPod had its labels
// (MENU on top, previous and next on the sides, play/pause at the bottom) and
// the center button. Nothing turns. The screen above shows Now Playing in big
// type, or a short menu: Shuffle Songs, Favorites, Playlists, Shuffle a Genre.
// No search, no typing and no long A-Z lists: those wait for a parked car.
//
// The music itself is the same player as everywhere else (Speakers included),
// so the lock screen, Bluetooth and the steering wheel buttons keep working
// while Maps is in front. The screen is kept awake while car mode shows
// (Wake Lock; Chrome only allows it on https, so the home copy relies on the
// phone's own timeout).
import * as api from './api.js';
import { settings } from './settings.js';
import { el, fmt, log, store, prettyGenre } from './util.js';

const KEY = 'fp.car';
const ROWS = 4;             // menu rows in view: big enough to hit while driving
const SHUFFLE_N = 100;      // songs per shuffle batch; more load as it plays

// The wheel: four ring segments and the center, as an SVG so each segment is
// its own big tap target in exactly the iPod's places.
const SVG = 'http://www.w3.org/2000/svg';
const R_OUT = 98, R_IN = 36;
function ringPath(from, to) {
  const rad = (d) => (d * Math.PI) / 180;
  const p = (r, d) => `${(100 + r * Math.cos(rad(d))).toFixed(2)} ${(100 + r * Math.sin(rad(d))).toFixed(2)}`;
  return `M${p(R_OUT, from)} A${R_OUT} ${R_OUT} 0 0 1 ${p(R_OUT, to)} L${p(R_IN, to)} A${R_IN} ${R_IN} 0 0 0 ${p(R_IN, from)}Z`;
}
// Angles in SVG terms (0 = right, clockwise, y down).
const SEGMENTS = [
  { b: 'menu', from: 225, to: 315, x: 100, y: 33 },
  { b: 'next', from: -45, to: 45, x: 167, y: 100 },
  { b: 'play', from: 45, to: 135, x: 100, y: 167 },
  { b: 'prev', from: 135, to: 225, x: 33, y: 100 },
];
// The same shapes as the iPod wheel's labels (index.html), plus up/down for menus.
const ICONS = {
  next: 'M0 0 L9 6 L0 12Z M9 0 L18 6 L9 12Z M19 0 h2.5 v12 H19Z',
  prev: 'M24 0 L15 6 L24 12Z M15 0 L6 6 L15 12Z M2.5 0 h2.5 v12 H2.5Z',
  play: 'M2 0 L11 6 L2 12Z M14 0 h3 v12 h-3Z M19.5 0 h3 v12 h-3Z',
  up: 'M12 0 L22 12 H2Z',
  down: 'M2 0 H22 L12 12Z',
};

export class CarMode {
  // feedback(): the wheel's click and buzz. onChange(): car mode turned on or off.
  constructor(root, { player, feedback, onChange }) {
    this.root = root;
    this.player = player;
    this.feedback = feedback;
    this.onChange = onChange;
    this.menu = [];          // open menus, innermost last; empty = Now Playing
    this.lock = null;        // screen wake lock
    this.fav = null;         // { id, on } for the current song
    this.build();
    player.on((what) => { if (!this.root.hidden && (what === 'song' || what === 'state' || what === 'tick')) this.render(what); });
    document.addEventListener('visibilitychange', () => this.keepAwake());
  }

  get on() { return store.get(KEY) === '1'; }

  // Turn car mode on or off (remembered on this phone).
  set(on) {
    if (on) store.set(KEY, '1'); else store.del(KEY);
    log(`car mode ${on ? 'on' : 'off'}`);
    this.menu = [];
    this.onChange();
  }

  show() {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    document.body.classList.add('car-on');
    this.render('song');
    this.keepAwake();
  }

  hide() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    document.body.classList.remove('car-on');
    this.keepAwake();
  }

  // ---------- screen and wheel ----------

  build() {
    const r = this.root;
    const inner = el('div', 'car-in');
    const screen = el('div', 'car-screen');
    this.bar = el('div', 'car-bar');
    this.barState = el('span', 'car-bar-state');
    this.barTitle = el('span', 'car-bar-title');
    this.barCount = el('span', 'car-bar-count');
    this.bar.append(this.barState, this.barTitle, this.barCount);
    this.view = el('div', 'car-view');
    screen.append(this.bar, this.view);

    const wrap = el('div', 'car-wheel');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    this.icons = {};
    for (const s of SEGMENTS) {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', `seg seg-${s.b}`);
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', ringPath(s.from, s.to));
      g.append(path);
      if (s.b === 'menu') {
        const t = document.createElementNS(SVG, 'text');
        t.setAttribute('x', s.x);
        t.setAttribute('y', s.y + 5);
        t.textContent = 'MENU';
        g.append(t);
      } else {
        const icon = document.createElementNS(SVG, 'path');
        icon.setAttribute('class', 'icon');
        icon.setAttribute('transform', `translate(${s.x - 16} ${s.y - 8}) scale(1.33)`);
        icon.setAttribute('d', ICONS[s.b]);
        g.append(icon);
        this.icons[s.b] = icon;
      }
      this.tap(g, s.b);
      svg.append(g);
    }
    const center = document.createElementNS(SVG, 'circle');
    center.setAttribute('class', 'seg seg-center');
    center.setAttribute('cx', 100);
    center.setAttribute('cy', 100);
    center.setAttribute('r', R_IN - 4);
    this.tap(center, 'select');
    svg.append(center);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    wrap.append(svg);
    inner.append(screen, wrap);
    r.append(inner);
  }

  // A segment acts on release, and only if the finger is still on it, so
  // brushing past one while reaching for another does nothing.
  tap(node, button) {
    node.addEventListener('pointerdown', (e) => { e.preventDefault(); node.classList.add('pressed'); });
    node.addEventListener('pointerleave', () => node.classList.remove('pressed'));
    node.addEventListener('pointercancel', () => node.classList.remove('pressed'));
    node.addEventListener('pointerup', () => {
      if (!node.classList.contains('pressed')) return;
      node.classList.remove('pressed');
      this.feedback(true);
      this.press(button);
    });
  }

  // ---------- buttons (the wheel above, and the keyboard through wheel.js) ----------

  press(b) {
    const m = this.menu[this.menu.length - 1];
    if (b === 'menu') {
      if (m) this.menu.pop(); else this.menu.push(this.rootMenu());
    } else if (b === 'play') {
      this.player.toggle();
    } else if (m && (b === 'prev' || b === 'next')) {
      this.turn(b === 'prev' ? -1 : 1);
      return;
    } else if (b === 'prev') {
      this.player.prev();
    } else if (b === 'next') {
      this.player.next();
    } else if (b === 'select') {
      if (m) { const row = m.rows[m.sel]; if (row) row.go(); } else this.centerOnNowPlaying();
    }
    this.render('song');
  }

  turn(dir) {
    const m = this.menu[this.menu.length - 1];
    if (!m || !m.rows.length) return;
    m.sel = Math.max(0, Math.min(m.rows.length - 1, m.sel + dir));
    this.render('song');
  }

  // Nothing to hold in the car: a hold is just a press (keyboard Enter held).
  hold(b) { if (b === 'select') return false; return undefined; }
  holdEnd() {}

  // Center on Now Playing: start Shuffle Songs when nothing plays (one tap to
  // music), otherwise heart the song or take the heart off.
  centerOnNowPlaying() {
    const item = this.player.current;
    if (!item) { this.shuffle('Shuffle Songs', (n) => api.randomSongs(n)); return; }
    const on = !(this.fav && this.fav.id === item.Id && this.fav.on);
    this.fav = { id: item.Id, on };
    this.pop(on);
    api.setFavorite(item.Id, on).then((v) => { if (this.fav?.id === item.Id) { this.fav.on = v; this.render('song'); } })
      .catch((e) => log(`car favorite: ${e.message}`));
  }

  pop(on) {
    const p = el('div', 'car-pop');
    p.append(el('div', 'car-pop-heart', on ? '♥' : '♡'), el('div', 'car-pop-text', on ? 'Added to Favorites' : 'Removed from Favorites'));
    this.view.append(p);
    setTimeout(() => p.remove(), 1400);
  }

  // ---------- menus ----------

  rootMenu() {
    return {
      title: 'Car', sel: 0, rows: [
        { label: 'Shuffle Songs', go: () => this.shuffle('Shuffle Songs', (n) => api.randomSongs(n)) },
        { label: 'Favorites', arrow: false, go: () => this.playList('Favorites', () => api.favoriteSongs(), true) },
        { label: 'Playlists', arrow: true, go: () => this.open('Playlists', () => api.playlists().then((d) => d.Items.map((pl) => ({
          label: pl.Name, go: () => this.playList(pl.Name, () => api.playlistSongs(pl.Id), settings.get('shuffle') === 'songs'),
        })))) },
        { label: 'Shuffle a Genre', arrow: true, go: () => this.open('Genres', () => api.genres(0, 300).then((d) => d.Items.map((g) => ({
          label: prettyGenre(g.Name), go: () => this.shuffle(prettyGenre(g.Name), (n) => api.randomGenreSongs(g.Id, n)),
        })))) },
        { label: 'Leave Car Mode', go: () => this.set(false) },
      ],
    };
  }

  // A submenu whose rows load from Jellyfin.
  open(title, load) {
    const m = { title, sel: 0, rows: [], loading: true };
    this.menu.push(m);
    load().then((rows) => { m.rows = rows; m.loading = false; this.render('song'); })
      .catch((e) => { m.loading = false; m.error = e.message; log(`car ${title}: ${e.message}`); this.render('song'); });
  }

  // Music picked: play it and go back to Now Playing.
  shuffle(name, load) {
    this.menu = [];
    load(SHUFFLE_N).then((d) => {
      if (!d.Items.length) return;
      this.player.play(d.Items, 0, { refill: () => load(SHUFFLE_N).then((r) => r.Items) });
    }).catch((e) => log(`car ${name}: ${e.message}`));
    this.render('song');
  }

  playList(name, load, shuffle) {
    this.menu = [];
    load().then((d) => {
      if (d.Items.length) this.player.play(d.Items, 0, { shuffle });
    }).catch((e) => log(`car ${name}: ${e.message}`));
    this.render('song');
  }

  // ---------- drawing ----------

  render(what) {
    if (this.root.hidden) return;
    const p = this.player;
    const m = this.menu[this.menu.length - 1];
    this.barState.textContent = p.playing ? (p.paused ? '❚❚' : '▶') : '';
    // Side segments move the menu highlight while a menu is open.
    this.icons.prev.setAttribute('d', m ? ICONS.up : ICONS.prev);
    this.icons.next.setAttribute('d', m ? ICONS.down : ICONS.next);
    if (m) {
      // A menu only changes when a button does; redrawing it every second could
      // swallow a tap that lands mid-redraw.
      if (what === 'tick') return;
      this.barTitle.textContent = m.title;
      this.barCount.textContent = '';
      this.drawMenu(m);
      this.np = null;
      return;
    }
    this.barTitle.textContent = 'Now Playing';
    this.barCount.textContent = p.playing && p.queue.length ? `${p.index + 1} of ${p.queue.length}` : '';
    if (what === 'tick' && this.np) { this.tickNowPlaying(); return; }
    this.drawNowPlaying();
  }

  drawMenu(m) {
    const list = el('div', 'car-list');
    if (m.loading) list.append(el('div', 'car-note', 'Loading…'));
    else if (m.error) list.append(el('div', 'car-note', `Couldn't load: ${m.error}`));
    else if (!m.rows.length) list.append(el('div', 'car-note', 'Nothing here'));
    // Only a window of ROWS rows around the highlight, like the iPod's screen.
    const start = Math.max(0, Math.min(m.sel - 1, m.rows.length - ROWS));
    m.rows.slice(start, start + ROWS).forEach((row, j) => {
      const i = start + j;
      const n = el('div', 'car-row' + (i === m.sel ? ' sel' : ''));
      n.append(el('span', 'car-row-label', row.label));
      if (row.arrow) n.append(el('span', 'car-row-arrow', '›'));
      // Rows can be tapped directly too.
      n.addEventListener('pointerup', () => { this.feedback(true); m.sel = i; row.go(); this.render('song'); });
      list.append(n);
    });
    if (m.rows.length > ROWS) {
      const sb = el('div', 'car-scroll');
      const thumb = el('div', 'car-scroll-thumb');
      thumb.style.height = `${(ROWS / m.rows.length) * 100}%`;
      thumb.style.top = `${(start / m.rows.length) * 100}%`;
      sb.append(thumb);
      list.append(sb);
    }
    this.view.replaceChildren(list);
  }

  drawNowPlaying() {
    const item = this.player.current;
    if (!item) {
      const idle = el('div', 'car-idle');
      idle.append(el('div', 'car-idle-title', 'Nothing playing'),
        el('div', 'car-idle-hint', 'Center: Shuffle Songs'), el('div', 'car-idle-hint', 'MENU: more'));
      this.view.replaceChildren(idle);
      this.np = null;
      return;
    }
    if (!this.np || this.np.id !== item.Id || !this.view.contains(this.np.root)) {
      const root = el('div', 'car-np');
      const art = el('div', 'car-art');
      const img = el('img');
      img.alt = '';
      img.src = api.artUrl(item, 400);
      img.addEventListener('error', () => img.classList.add('missing'));
      const heart = el('div', 'car-heart', '♥');
      art.append(img, heart);
      const text = el('div', 'car-text');
      text.append(el('div', 'car-title', item.Name), el('div', 'car-artist', api.artistOf(item)), el('div', 'car-album', item.Album || ''));
      const top = el('div', 'car-np-top');
      top.append(art, text);
      const meter = el('div', 'meter');
      const fill = el('div', 'fill');
      meter.append(fill);
      const times = el('div', 'car-times');
      const at = el('span'), left = el('span');
      times.append(at, left);
      root.append(top, meter, times);
      this.view.replaceChildren(root);
      this.np = { id: item.Id, root, fill, at, left, heart };
      // Song lists load without user data, so ask whether this one is a favorite.
      if (this.fav?.id !== item.Id) {
        this.fav = { id: item.Id, on: false };
        api.isFavorite(item.Id).then((on) => { if (this.fav?.id === item.Id) { this.fav.on = on; this.tickNowPlaying(); } }).catch(() => {});
      }
    }
    this.tickNowPlaying();
  }

  tickNowPlaying() {
    const np = this.np;
    if (!np) return;
    const p = this.player;
    const pos = p.position(), dur = p.duration();
    np.fill.style.width = `${dur > 0 ? Math.min(100, (pos / dur) * 100) : 0}%`;
    np.at.textContent = fmt(pos);
    np.left.textContent = `-${fmt(Math.max(0, dur - pos))}`;
    np.heart.classList.toggle('on', !!(this.fav && this.fav.id === np.id && this.fav.on));
  }

  // ---------- screen awake ----------

  async keepAwake() {
    const want = !this.root.hidden && document.visibilityState === 'visible';
    if (!want) {
      if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
      return;
    }
    if (this.lock || !('wakeLock' in navigator)) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      // The browser drops it when the page is hidden; visibilitychange asks again.
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch (e) {
      log(`car wake lock: ${e.name}`);
    }
  }
}
