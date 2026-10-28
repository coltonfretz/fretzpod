// TV: the free channels from the Tuner plugin's Surf TV, on the iPod screen.
// Free (IPTV) channels only, no antenna; straight from the channels' own
// servers (it's their ad money, and viewers' streams shouldn't ride on the
// server's connection); nothing on screen explaining the buttons.
//
// The plugin does the work already: /Tuner/tv gives the lineup plus a ticket,
// /Tuner/tv/guide gives now/next. Channels play straight from their CDNs with
// hls.js; the few CDNs that refuse a web page's request go through the
// plugin's signed relay instead (same fallback as Surf TV, remembered per
// phone so the next visit skips the failed try).
//
// Wheel: turning surfs (the tune waits for the wheel to settle, so a fast
// spin skips past channels instead of starting each one), next/previous step
// one channel, center shows now/next, play/pause pauses, MENU goes back.
// Volume is the phone's own keys. Turn the phone sideways for full screen;
// a swipe there surfs.
import * as api from './api.js';
import { settings } from './settings.js';
import { el, store, log } from './util.js';

const TUNE_DELAY = 350;       // ms after the last wheel tick before tuning
const BANNER_MS = 3500;
const GUIDE_MAX_AGE = 5 * 60e3;
const SWIPE_PX = 60;

let hlsLoading = null;
// hls.js is 600 KB, so it only loads the first time TV is opened.
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = () => { hlsLoading = null; reject(new Error('hls.js did not load')); };
      document.head.append(s);
    });
  }
  return hlsLoading;
}

// Lineup and guide, shared by the channel list and the TV screen.
export const tvData = {
  ticket: '',
  channels: [],
  guide: {},
  guideAt: 0,
  async load() {
    const d = await api.request('/Tuner/tv');
    this.ticket = d?.enabled ? d.ticket : '';
    try { allowed = (await (await fetch('tv-hosts.json')).json()).hosts; } catch { allowed = []; }
    // Channels on servers outside the list are left out rather than relayed:
    // the CSP would block them anyway, and the relay would route their
    // viewing through the home connection.
    const free = d?.enabled ? d.channels.filter((c) => c.kind === 'free') : [];
    this.channels = free.filter((c) => hostOk(c.url));
    if (this.channels.length < free.length) log(`tv: ${free.length - this.channels.length} channels on servers not in tv-hosts.json`);
    // The guide can take a while when the plugin rebuilds it (every 10 min);
    // the channel list doesn't wait more than a moment for it.
    await Promise.race([this.refreshGuide(), new Promise((r) => setTimeout(r, 2000))]);
    return this.channels;
  },
  async refreshGuide() {
    if (Date.now() - this.guideAt < GUIDE_MAX_AGE) return;
    try { this.guide = (await api.request('/Tuner/tv/guide')) || {}; this.guideAt = Date.now(); } catch { /* keep the old one */ }
  },
  now(ch) { return this.guide[ch.number]?.now?.title || ''; },
  logo(ch) { return ch.hasLogo ? `${api.JF}/${ch.logo}?t=${encodeURIComponent(this.ticket)}` : ''; },
};

// The servers TV may stream from (tv-hosts.json, also the page's CSP).
let allowed = [];
const hostOk = (url) => {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
};

const relayed = () => new Set(JSON.parse(store.get('fp.tvrelay', '[]')));
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

export class Tv {
  constructor(index, { player, feedback }) {
    this.title = 'TV';
    this.i = index;
    this.player = player;
    this.feedback = feedback;
    this.parts = null;
    this.hls = null;
    this.tuned = -1;
    this.full = false;
    this.infoOn = false;
  }

  get ch() { return tvData.channels[this.i]; }

  attach(ui) { this.ui = ui; }

  // Built once; when the UI draws into a fresh view (slides), the same
  // screen moves there, so the picture keeps playing.
  render(view) {
    if (!this.parts) {
      this.build();
      // Opened with the phone already sideways: go full screen right away.
      queueMicrotask(() => window.dispatchEvent(new Event('fp-orient')));
    }
    if (!view.contains(this.parts.root)) {
      view.replaceChildren(this.parts.root);
      view.classList.remove('split');
    }
    if (this.tuned !== this.i && !this.tuneTimer) this.tune();
  }

  build() {
    const root = el('div', 'tv');
    const stage = el('div', 'tv-stage');
    const video = el('video', 'tv-video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    const banner = el('div', 'tv-banner');
    const logo = el('img', 'tv-logo');
    logo.alt = '';
    logo.addEventListener('error', () => { logo.hidden = true; });
    const text = el('div', 'tv-banner-text');
    const name = el('div', 'tv-name');
    const now = el('div', 'tv-now');
    text.append(name, now);
    banner.append(logo, text);
    const info = el('div', 'tv-info');
    stage.append(video, banner, info);
    root.append(stage);
    this.parts = { root, stage, video, banner, logo, name, now, info };
    this.showBanner();
    // A swipe across the full-screen picture surfs, since the wheel is hidden.
    let x0 = null;
    stage.addEventListener('pointerdown', (e) => { if (this.full) x0 = e.clientX; });
    stage.addEventListener('pointerup', (e) => {
      if (!this.full || x0 === null) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (Math.abs(dx) >= SWIPE_PX) { this.surf(dx < 0 ? 1 : -1); this.feedback(); }
    });
  }

  // ---------- wheel ----------

  turn(dir) { this.surf(dir); return true; }
  next() { this.surf(1); return true; }
  prev() { this.surf(-1); return true; }
  play() {
    const v = this.parts?.video;
    if (!v) return true;
    if (v.paused) v.play().catch(() => {}); else v.pause();
    return true;
  }
  hold() {}                     // keeps a held next/previous from opening Now Playing

  select() {
    this.infoOn = !this.infoOn;
    this.showInfo();
  }

  surf(dir) {
    const n = tvData.channels.length;
    if (!n) return;
    this.i = (this.i + dir + n) % n;
    this.showBanner();
    clearTimeout(this.tuneTimer);
    this.tuneTimer = setTimeout(() => { this.tuneTimer = null; this.tune(); }, TUNE_DELAY);
  }

  // ---------- picture ----------

  async tune(viaRelay = false) {
    const ch = this.ch;
    const v = this.parts?.video;
    if (!ch || !v) return;
    const i = this.i;
    this.tuned = i;
    store.set('fp.tvlast', String(ch.number));
    this.pauseMusic();
    if (!viaRelay && relayed().has(String(ch.number))) viaRelay = true;
    this.teardown();
    const src = viaRelay ? `${api.JF}/${ch.relay}&t=${encodeURIComponent(tvData.ticket)}` : ch.url;
    let Hls = null;
    try { Hls = await loadHls(); } catch (e) { log(`tv: ${e.message}`); }
    if (this.tuned !== i) return;            // surfed on while hls.js loaded
    const saver = settings.get('quality') === 'saver';
    if (Hls?.isSupported()) {
      const hls = new Hls({
        // Start near the top instead of ramping up from 240p; Data saver
        // starts low and stays at 480p or below.
        abrEwmaDefaultEstimate: saver ? 1e6 : 6e6,
        capLevelToPlayerSize: true,
        backBufferLength: 30,
        manifestLoadingTimeOut: 10000,
        // TV shows no captions, so don't parse them. Left on, hls.js also adds
        // placeholder <track src="data:,WEBVTT"> elements that the CSP blocks
        // (console errors in Firefox and WebKit, 2026-10-27).
        enableCEA708Captions: false,
        enableWebVTT: false,
        enableIMSC1: false,
      });
      this.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (saver) {
          let cap = -1;
          hls.levels.forEach((l, k) => { if ((l.height || 0) <= 480) cap = k; });
          if (cap >= 0) hls.autoLevelCapping = cap;
        }
        v.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || this.hls !== hls) return;
        const failed = data.url || data.frag?.url || data.context?.url || '';
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !viaRelay && (!failed || hostOk(failed))) {
          // Usually the CDN refusing a cross-origin request: use the relay.
          // Not when the failure was a server outside the list (an ad break
          // served from somewhere else): that's the CSP doing its job.
          const r = relayed();
          r.add(String(ch.number));
          store.set('fp.tvrelay', JSON.stringify([...r]));
          this.tune(true);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          this.unavailable();
        }
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      // iPhone: Safari plays these streams itself.
      v.src = src;
      v.onerror = () => { if (!viaRelay && this.tuned === i) this.tune(true); else this.unavailable(); };
      v.play().catch(() => {});
    } else {
      this.unavailable();
    }
  }

  unavailable() {
    if (!this.parts) return;
    this.parts.now.textContent = 'Not available right now';
    this.showBanner(false);
  }

  teardown() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    const v = this.parts?.video;
    if (v) { v.onerror = null; v.removeAttribute('src'); v.load(); }
  }

  // TV takes over from music on the phone. Music on the speakers keeps going.
  pauseMusic() {
    const p = this.player;
    if (!p.speaker && p.playing && !p.paused) p.toggle();
  }

  // ---------- overlays ----------

  showBanner(fill = true) {
    const ch = this.ch;
    if (!this.parts || !ch) return;
    const { banner, logo, name, now } = this.parts;
    name.textContent = `${ch.number}  ${ch.name}`;
    if (fill) now.textContent = tvData.now(ch);
    const src = tvData.logo(ch);
    logo.hidden = !src;
    if (src && logo.getAttribute('src') !== src) logo.src = src;
    banner.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => banner.classList.remove('on'), BANNER_MS);
    if (this.infoOn) this.showInfo();
  }

  showInfo() {
    if (!this.parts) return;
    const { info } = this.parts;
    const g = tvData.guide[this.ch?.number] || {};
    info.replaceChildren();
    const line = (label, p) => {
      if (!p) return;
      const row = el('div', 'tv-info-row');
      row.append(el('span', 'tv-info-when', label === 'Now' ? 'Now' : clock(p.start)), el('span', 'tv-info-title', p.title));
      info.append(row);
    };
    line('Now', g.now);
    line('Next', g.next);
    info.classList.toggle('on', this.infoOn && info.childElementCount > 0);
    tvData.refreshGuide();
  }

  // ---------- sideways ----------

  // Full screen: the picture moves out of the iPod into a layer over the
  // whole phone, and back. Moving a playing <video> keeps it playing.
  setFull(on) {
    if (!this.parts || on === this.full) return;
    this.full = on;
    let layer = document.querySelector('.tv-full');
    if (on) {
      if (!layer) { layer = el('div', 'tv-full'); document.body.append(layer); }
      layer.append(this.parts.stage);
      layer.hidden = false;
    } else {
      this.parts.root.append(this.parts.stage);
      if (layer) layer.hidden = true;
    }
  }

  leave() {
    clearTimeout(this.tuneTimer);
    this.tuneTimer = null;
    this.setFull(false);
    this.teardown();
    this.tuned = -1;
    window.dispatchEvent(new Event('fp-orient'));
  }
}
