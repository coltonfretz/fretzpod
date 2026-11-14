// Prize bodies for Settings > Body: a gold iPod for a
// huge lifetime total in each game, each with that game's symbol pressed
// into the bottom right corner (two flippers, a golf club, a fishing rod),
// and a clear case showing the insides for having all three.
//
// Lifetime totals, kept on the phone by each game:
// - Star Pinball: points from every game (pinball.js pinballSave).
// - Tiki Golf: coins ever earned, which is the coins in hand plus what the
//   owned shop items cost (golf.js only keeps the balance).
// - Fishing Trip: points from every catch (fishing.js fishSave).
// The numbers are meant to take a long while: about 50 to 100 pinball games,
// 50 or so golf rounds, a few hours of fishing.
//
// Locked bodies don't appear in Settings > Body (settings.js asks bodyOpen).
// Each game's title menu has a Gold Body row showing how far along you are;
// once it's open, picking the row puts it on.
//
// Showcase accounts: site.json's prizesOpenFor lists accounts that have
// every prize body open whatever the totals say, so the owner can show them
// off on a fresh install (the totals stay on one phone). Each is
// {server, user}: the Jellyfin username, and the https address of the
// server it must be signed in to. WHY the server too: in the app build
// anyone can point the app at their own Jellyfin and make a user with that
// name; only the https address is trusted, since a look-alike server can't
// get a certificate for it. A site build talks only to its own servers
// (site.json), so there the name is enough. Kept in the untracked
// site.json, never in the repo; build.py copies it into both builds.
import { store, el } from './util.js';
import { getSession, JF, BYOS } from './api.js';
import site from './config.js';
import { pinballSave } from './pinball.js';
import { golfSave, SHOP } from './golf.js';
import { fishSave } from './fishing.js';

const golfCoinsEver = () => {
  const d = golfSave.load();
  return d.coins + SHOP.filter((i) => d.owned.includes(i.id)).reduce((s, i) => s + i.price, 0);
};

export const GOLD = [
  { id: 'gold-pinball', name: 'Gold Pinball', game: 'pinball', need: 5_000_000, have: () => pinballSave.load().points },
  { id: 'gold-golf', name: 'Gold Golf', game: 'golf', need: 1_500, have: golfCoinsEver },
  { id: 'gold-fish', name: 'Gold Fishing', game: 'fish', need: 100_000, have: () => fishSave.load().points },
];
const goldFor = (game) => GOLD.find((b) => b.game === game);

const bare = (url) => (url || '').trim().toLowerCase().replace(/\/+$/, '');
const showcase = () => {
  const name = (getSession()?.name || '').toLowerCase();
  if (!name) return false;
  return (site.prizesOpenFor || []).some((a) => (a.user || '').toLowerCase() === name
    && (!BYOS || (bare(JF).startsWith('https://') && bare(JF) === bare(a.server))));
};

// Is this body open? The usual colors always are.
export function bodyOpen(id) {
  if (showcase()) return true;
  const gold = GOLD.find((b) => b.id === id);
  if (gold) return gold.have() >= gold.need;
  if (id === 'clear') return GOLD.every((b) => b.have() >= b.need);
  return true;
}

// For a game's menu row: "1.2M / 5M", or "Open" once it is.
const short = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.floor(n / 1000)}k` : n.toLocaleString());
export function goldProgress(game) {
  const b = goldFor(game);
  return bodyOpen(b.id) ? 'Open' : `${short(b.have())} / ${short(b.need)}`;
}
export const goldId = (game) => goldFor(game).id;

// Bodies opened since the last time anyone asked, as lines for a game's
// end screen ("New body: Gold Fishing"). Remembered on the phone, so each
// is announced once.
const SEEN = 'fp.bodies.seen';
export function newBodies() {
  let seen = [];
  try { seen = JSON.parse(store.get(SEEN, '[]')) || []; } catch { /* start over */ }
  const open = [...GOLD.map((b) => b.id), 'clear'].filter(bodyOpen);
  const fresh = open.filter((id) => !seen.includes(id));
  if (!fresh.length) return [];
  store.set(SEEN, JSON.stringify(open));
  const name = (id) => (id === 'clear' ? 'Clear' : GOLD.find((b) => b.id === id).name);
  return fresh.map((id) => `New body: ${name(id)}`);
}

// ---------- drawing ----------

// The symbols, 48 x 48, our own drawings. Pressed into the case by the CSS
// (#emblem in pod.css): a darker fill with a light edge below it.
const EMBLEMS = {
  // two flippers and a ball
  'gold-pinball': `<circle cx="24" cy="12" r="4"/>
    <path d="M13.1 22.1 L21.25 32.44 A2 2 0 0 1 18.75 35.56 L6.9 29.9 A5 5 0 0 1 13.1 22.1 Z"/>
    <path d="M34.9 22.1 L26.75 32.44 A2 2 0 0 0 29.25 35.56 L41.1 29.9 A5 5 0 0 0 34.9 22.1 Z"/>`,
  // a club and a ball on a tee
  'gold-golf': `<path d="M13 4 L29 36" stroke-width="3" stroke-linecap="round" fill="none" stroke="currentColor"/>
    <path d="M27 33 h10 q5 0 5 5 q0 4 -4 4 h-11 q-3 0 -3 -3 v-3 q0 -3 3 -3 Z"/>
    <circle cx="11" cy="37" r="4.5"/>
    <path d="M9 42 h4 l-1 4 h-2 Z"/>`,
  // a rod with its reel, the line and a hook
  'gold-fish': `<path d="M7 44 L41 7" stroke-width="2.6" stroke-linecap="round" fill="none" stroke="currentColor"/>
    <path d="M7 44 L14 36.5" stroke-width="5" stroke-linecap="round" fill="none" stroke="currentColor"/>
    <circle cx="16.5" cy="39" r="3.6"/>
    <path d="M41 7 V31 q0 6 -5 5.5 q-3 -0.5 -2.5 -3.5" stroke-width="1.6" stroke-linecap="round" fill="none" stroke="currentColor"/>`,
};

// The insides for the clear case: hard drive up top, the ribbon cable,
// the battery and the logic board with chips and traces. Drawn in a
// 100 x 200 box that covers the window behind the iPod.
function boardSvg() {
  let traces = '';
  // A fixed scatter (no Math.random: the same board every time).
  const r = (n) => { const v = Math.sin(n * 91.7) * 4375.85; return v - Math.floor(v); };
  for (let i = 0; i < 26; i++) {
    const x = 12 + r(i) * 76, y = 120 + r(i + 40) * 64, w = 6 + r(i + 80) * 20, up = 4 + r(i + 120) * 12;
    traces += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} h${w.toFixed(1)} v${(-up).toFixed(1)} h${(w / 2).toFixed(1)}"/>`;
  }
  let caps = '';
  for (let i = 0; i < 18; i++) {
    caps += `<rect x="${(14 + r(i + 200) * 72).toFixed(1)}" y="${(118 + r(i + 240) * 66).toFixed(1)}" width="2.2" height="1.2" rx=".3"/>`;
  }
  const chip = (x, y, w, h, label = '') => {
    let pins = '';
    for (let px = x + 1.2; px < x + w - 0.6; px += 1.6) pins += `<rect x="${px.toFixed(1)}" y="${y - 0.9}" width=".7" height=".9"/><rect x="${px.toFixed(1)}" y="${y + h}" width=".7" height=".9"/>`;
    return `<g fill="#c9ccd2">${pins}</g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx=".6" fill="#15171b"/>`
      + (label ? `<text x="${x + w / 2}" y="${y + h / 2 + 1}" font-size="2.6" fill="#6d7280" text-anchor="middle" font-family="Helvetica, Arial, sans-serif">${label}</text>` : '');
  };
  return `<svg viewBox="0 0 100 200" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bd-platter" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#eef1f5"/><stop offset=".6" stop-color="#a9afb8"/><stop offset="1" stop-color="#7d838c"/></radialGradient>
    <clipPath id="bd-pcb"><rect x="8" y="114" width="84" height="78" rx="3"/></clipPath>
    <linearGradient id="bd-batt" x1="0" x2="1"><stop offset="0" stop-color="#3a3f47"/><stop offset=".5" stop-color="#5a606a"/><stop offset="1" stop-color="#363a42"/></linearGradient>
  </defs>
  <rect width="100" height="200" fill="#16191e"/>
  <!-- hard drive -->
  <rect x="9" y="8" width="82" height="78" rx="3" fill="#8f959e"/>
  <rect x="11" y="10" width="78" height="74" rx="2" fill="#a3a9b2"/>
  <circle cx="50" cy="47" r="30" fill="url(#bd-platter)"/>
  <circle cx="50" cy="47" r="6" fill="#7a808a"/><circle cx="50" cy="47" r="2.2" fill="#c9ced6"/>
  <path d="M83 78 L60 52" stroke="#5f656e" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="83" cy="78" r="4" fill="#5f656e"/>
  <!-- ribbon cable -->
  <rect x="38" y="84" width="24" height="20" fill="#d88a2a" opacity=".9"/>
  <g stroke="#b06a18" stroke-width=".4">${[40, 43, 46, 49, 52, 55, 58].map((x) => `<path d="M${x} 84 v20"/>`).join('')}</g>
  <!-- battery -->
  <rect x="10" y="96" width="80" height="16" rx="2" fill="url(#bd-batt)"/>
  <text x="50" y="106" font-size="3.4" fill="#9aa0aa" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" letter-spacing=".6">Li-ion  3.7V</text>
  <!-- logic board -->
  <rect x="8" y="114" width="84" height="78" rx="3" fill="#1d5a3c"/>
  <g stroke="#c9a54a" stroke-width=".45" fill="none" opacity=".75" clip-path="url(#bd-pcb)">${traces}</g>
  <g fill="#d8c08a">${caps}</g>
  ${chip(38, 132, 22, 22, 'FP-1')}
  ${chip(14, 124, 14, 9)}
  ${chip(70, 124, 14, 10)}
  ${chip(16, 168, 18, 12, 'MEM')}
  ${chip(66, 166, 16, 14)}
  <ellipse cx="62" cy="160" rx="3" ry="1.6" fill="#c9ccd2"/>
  <circle cx="13" cy="187" r="1.6" fill="#0f2a1c" stroke="#c9a54a" stroke-width=".5"/>
  <circle cx="87" cy="187" r="1.6" fill="#0f2a1c" stroke="#c9a54a" stroke-width=".5"/>
</svg>`;
}

// Puts the body's extras on the page: the emblem for a gold one, the
// insides behind a clear one. The colors are all CSS (pod.css, data-body).
export function applyBodyExtras(id) {
  const pod = document.getElementById('pod');
  let emblem = document.getElementById('emblem');
  if (EMBLEMS[id]) {
    if (!emblem) { emblem = el('div'); emblem.id = 'emblem'; pod.append(emblem); }
    emblem.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">${EMBLEMS[id]}</svg>`;
  } else emblem?.remove();
  let board = document.getElementById('board');
  if (id === 'clear') {
    if (!board) { board = el('div'); board.id = 'board'; board.innerHTML = boardSvg(); document.body.prepend(board); }
  } else board?.remove();
}
