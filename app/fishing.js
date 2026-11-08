// Fishing Trip: fishing from the shore, in Extras with Star Pinball and Tiki
// Golf. It replaced Space Sheep (2026-11-08): Colton found Space Sheep asked
// for too many buttons in too small a ring, and wanted fishing that plays
// like the old console RPG minigames he liked, where the fun is spotting the
// fish you want, getting it to take the lure, and collecting every kind.
// Original fish art, places and rules; nothing is copied from any game.
//
// Wheel:
// - Aiming: turn to swing the cast left or right. Center starts the power
//   bar, center again casts (further right on the bar, further out).
// - Lure in the water: turning forward reels it in, which moves it, and a
//   moving lure is what draws fish. Previous and next steer it sideways.
//   Center twitches it. A fish that likes the lure comes over and nibbles;
//   the phone buzzes when it bites, and center then hooks it. Center during
//   the nibble is too early and scares it off; miss the bite and it's too
//   late. Reeling fast spooks fish: a slow, steady reel draws them in.
// - The fight: a tension bar. Turning forward reels (tension up), turning
//   back gives line (tension down). Keep the marker in the green while the
//   fish tires and the line comes in. The green drifts about, more and
//   faster for harder fish. Too high for too long snaps the line,
//   too slack lets the fish throw the hook. Tapping center during a run
//   jerks the rod and breaks the fish's pull.
// - MENU leaves. Play/pause does nothing (a stray press shouldn't stop the
//   music either).
//
// Collecting: every kind caught goes in the Fish Log (biggest and how many).
// Points from every catch add up on the phone; they open two more spots and
// three more lures, and each kind of fish only takes certain lures. The
// total is also what goes on the shared high score board.
//
// Game units: the view is 1 x 1, (0, 0) top-left, y down toward the shore.
import * as scores from './scores.js';
import { canvasFont as font, runCanvas, store } from './util.js';

const ID = 'fish';                  // the score board's name for it
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (a, b) => a + Math.random() * (b - a);

const ROD = { x: 0.5, y: 0.93 };    // the rod's tip, where the line starts
const AIM_STEP = Math.PI / 40;      // per wheel tick
const AIM_MAX = 1.05;
const POWER_TIME = 1.1;             // seconds for the power bar to fill
const CAST_TIME = 0.55;             // seconds in the air
const REEL_STEP = 0.012;            // how far one tick reels the lure in
const STEER = 0.035;                // how far previous/next move it sideways
const SIGHT = 0.24;                 // how far a fish notices a moving lure
const MOVED = 1.6;                  // seconds a lure counts as moving after it last moved
// Reeling FAST_TICKS ticks (a quarter turn) within FAST_WINDOW seconds is
// too fast and spooks fish. Thumbs turn in flicks, so a short flick alone
// doesn't count; a steady reel is about 2 to 4 ticks a second.
const FAST_WINDOW = 1;
const FAST_TICKS = 6;
const LINE_M = 40;                  // meters of line per unit, for the readout

// The fight's tension bar (0 slack .. 1 breaking).
const SLACK = 0.1;
const SNAP = 0.88;
const REEL_KICK = 0.18;             // effort per tick forward
const GIVE_KICK = 0.18;             // per tick back

// ---------- lures, fish, spots ----------

const LURES = [
  { id: 'worm', name: 'Worm', need: 0, color: '#d07a62' },
  { id: 'spinner', name: 'Spinner', need: 300, color: '#e6e9f2' },
  { id: 'frog', name: 'Frog', need: 1500, color: '#63c24c' },
  { id: 'jig', name: 'Glow Jig', need: 4000, color: '#8ff0ff', glow: true },
];

// size in cm; str how hard it pulls (0..1); wild how often it runs; pts at
// average size; rarity is its share of the fish in its spot; look is for
// drawing (deep = height for its length, mark = stripes | bars | spots).
const FISH = [
  { id: 'bluegill', name: 'Bluegill', spot: 'pond', size: [12, 24], str: 0.15, wild: 0.4, pts: 25, rarity: 30, lures: ['worm', 'spinner'],
    look: { body: '#4f7fa0', belly: '#f0a050', deep: 0.5, mark: 'bars' } },
  { id: 'perch', name: 'Yellow Perch', spot: 'pond', size: [15, 32], str: 0.25, wild: 0.5, pts: 40, rarity: 24, lures: ['worm', 'spinner'],
    look: { body: '#c8b040', belly: '#f2e6b0', deep: 0.34, mark: 'bars', fin: '#e07030' } },
  { id: 'carp', name: 'Common Carp', spot: 'pond', size: [35, 80], str: 0.5, wild: 0.2, pts: 80, rarity: 16, lures: ['worm'],
    look: { body: '#9a7a3a', belly: '#e0c890', deep: 0.36, whiskers: true } },
  { id: 'bass', name: 'Largemouth Bass', spot: 'pond', size: [25, 58], str: 0.45, wild: 0.6, pts: 100, rarity: 16, lures: ['spinner', 'frog'],
    look: { body: '#5a8040', belly: '#e8eac0', deep: 0.34, mark: 'stripe' } },
  { id: 'catfish', name: 'Channel Catfish', spot: 'pond', size: [40, 95], str: 0.6, wild: 0.3, pts: 140, rarity: 10, lures: ['worm', 'frog'],
    look: { body: '#6a7078', belly: '#d8dce0', deep: 0.26, whiskers: true, mark: 'spots' } },
  { id: 'koi', name: 'Golden Koi', spot: 'pond', size: [50, 85], str: 0.55, wild: 0.35, pts: 500, rarity: 1.5, lures: ['worm'], legend: true,
    look: { body: '#f2b632', belly: '#fff0c0', deep: 0.33, whiskers: true, mark: 'spots', markColor: '#e05a2a' } },

  { id: 'rainbow', name: 'Rainbow Trout', spot: 'river', size: [25, 55], str: 0.35, wild: 0.6, pts: 70, rarity: 28, lures: ['worm', 'spinner'],
    look: { body: '#7a9a8a', belly: '#f4e8e0', deep: 0.27, mark: 'stripe', markColor: '#e07a8a' } },
  { id: 'brown', name: 'Brown Trout', spot: 'river', size: [30, 65], str: 0.45, wild: 0.5, pts: 95, rarity: 20, lures: ['spinner', 'frog'],
    look: { body: '#8a6a3a', belly: '#f0dcae', deep: 0.27, mark: 'spots', markColor: '#5a3418' } },
  { id: 'smallmouth', name: 'Smallmouth Bass', spot: 'river', size: [25, 50], str: 0.45, wild: 0.7, pts: 90, rarity: 20, lures: ['spinner', 'frog'],
    look: { body: '#8a7a40', belly: '#e8dcae', deep: 0.33, mark: 'bars' } },
  { id: 'pike', name: 'Northern Pike', spot: 'river', size: [50, 110], str: 0.7, wild: 0.8, pts: 200, rarity: 12, lures: ['spinner', 'frog'],
    look: { body: '#4f6a3a', belly: '#e0e6c0', deep: 0.2, mark: 'spots', markColor: '#d8e0a0' } },
  { id: 'salmon', name: 'Chinook Salmon', spot: 'river', size: [60, 110], str: 0.75, wild: 0.6, pts: 240, rarity: 9, lures: ['spinner', 'jig'],
    look: { body: '#6a7a8a', belly: '#f2f4f6', deep: 0.28, mark: 'spots', markColor: '#2a3440' } },
  { id: 'sturgeon', name: 'White Sturgeon', spot: 'river', size: [120, 260], str: 0.9, wild: 0.25, pts: 1000, rarity: 1.2, lures: ['worm'], legend: true,
    look: { body: '#7a8088', belly: '#e8eaec', deep: 0.2, whiskers: true, mark: 'scutes' } },

  { id: 'mackerel', name: 'Mackerel', spot: 'sea', size: [25, 42], str: 0.35, wild: 0.8, pts: 110, rarity: 28, lures: ['spinner', 'jig'],
    look: { body: '#3a7a8a', belly: '#f0f4f4', deep: 0.24, mark: 'waves' } },
  { id: 'seabass', name: 'Sea Bass', spot: 'sea', size: [35, 72], str: 0.5, wild: 0.5, pts: 160, rarity: 22, lures: ['worm', 'jig'],
    look: { body: '#4a5a6a', belly: '#d8dee4', deep: 0.33 } },
  { id: 'snapper', name: 'Red Snapper', spot: 'sea', size: [40, 85], str: 0.55, wild: 0.5, pts: 200, rarity: 18, lures: ['jig', 'frog'],
    look: { body: '#d85a50', belly: '#f8d0c8', deep: 0.38 } },
  { id: 'tuna', name: 'Yellowfin Tuna', spot: 'sea', size: [80, 170], str: 0.85, wild: 0.75, pts: 420, rarity: 9, lures: ['jig'],
    look: { body: '#2a4a7a', belly: '#e8eef4', deep: 0.3, fin: '#f2d040', mark: 'stripe', markColor: '#f2d040' } },
  { id: 'swordfish', name: 'Swordfish', spot: 'sea', size: [150, 300], str: 0.95, wild: 0.8, pts: 800, rarity: 3, lures: ['jig'],
    look: { body: '#4a4a6a', belly: '#c8ccd8', deep: 0.22, sword: true } },
  { id: 'opah', name: 'Opah', spot: 'sea', size: [80, 150], str: 0.75, wild: 0.4, pts: 1400, rarity: 1.2, lures: ['jig'], legend: true,
    look: { body: '#c05a6a', belly: '#f0a8b0', deep: 0.62, mark: 'spots', markColor: '#f4f0f0', fin: '#e8302a' } },
];

// Water runs from `top` (the far bank or the horizon) down to the shore at 0.9.
const SPOTS = [
  { id: 'pond', name: 'Lily Pond', need: 0, top: 0.05, current: 0, count: 7,
    water: ['#2c6a5e', '#1e4d46'], deco: 'pond' },
  { id: 'river', name: 'Rocky River', need: 2000, top: 0.12, current: 0.035, count: 7,
    water: ['#2d6c98', '#1f4e76'], deco: 'river' },
  { id: 'sea', name: 'Sea Cliffs', need: 6000, top: 0.14, current: 0, count: 8,
    water: ['#1c5c96', '#0c2f5c'], deco: 'sea' },
];
const SHORE = 0.9;

// ---------- what's kept on the phone ----------
//
// {points: every catch added up, lure: the one in use, log: {fish id: {n, best}}}.
const SAVE_KEY = 'fp.fish.save';
export const fishSave = {
  load() {
    let d = {};
    try { d = JSON.parse(store.get(SAVE_KEY, '{}')) || {}; } catch { /* start over */ }
    return { points: 0, lure: 'worm', log: {}, ...d };
  },
  save(d) { store.set(SAVE_KEY, JSON.stringify(d)); },
};
export const fishOpen = (thing) => fishSave.load().points >= thing.need;
export const FISH_SPOTS = SPOTS;
export const FISH_LURES = LURES;
export const FISH_KINDS = FISH;
export const fishLockText = (thing) => `Locked · ${thing.need.toLocaleString()}`;

// ---------- the game ----------

export class Fishing {
  constructor(spotIndex, feedback) {
    this.spot = SPOTS[spotIndex];
    this.title = this.spot.name;
    this.feedback = feedback;       // click + buzz, as on the wheel
    this.canvas = null;             // runCanvas's (util.js), with raf
    this.raf = 0;
    const pick = fishSave.load().lure;
    this.lure = LURES.find((l) => l.id === pick && fishOpen(l)) || LURES[0];
    this.kinds = FISH.filter((f) => f.spot === this.spot.id);
    this.t = 0;
    this.sent = false;              // for scores.gameOver: the total goes up after each catch
    this.score = 0;
    this.best = scores.localBest(ID);
    this.result = null;
    this.fish = [];
    for (let i = 0; i < this.spot.count; i++) this.fish.push(this.newFish(false));
    this.respawns = [];             // times a replacement fish swims in
    this.rotateAt = 30;             // every so often one fish leaves and another comes
    this.ripples = [];
    this.reels = [];                // when the lure was last reeled, for "too fast"
    this.note = null;               // {text, until}: Too early, Too late, Too fast
    this.deco = this.makeDeco();
    this.toAim();
  }

  attach(ui) { this.ui = ui; }
  leave() { /* nothing in progress is worth keeping: catches are saved as they happen */ }
  render(view) { runCanvas(this, view); }

  toAim() {
    this.state = 'aim';
    this.aim = this.aim || 0;
    this.lureAt = null;
    this.hooked = null;
    this.card = null;
  }

  // A fish of this spot, by rarity; bigger ones are rarer. Swims in from a
  // side when `enter`, else starts anywhere.
  newFish(enter) {
    const total = this.kinds.reduce((s, k) => s + k.rarity, 0);
    let r = Math.random() * total, kind = this.kinds[0];
    for (const k of this.kinds) { if ((r -= k.rarity) < 0) { kind = k; break; } }
    const size = Math.round(kind.size[0] + (kind.size[1] - kind.size[0]) * Math.random() ** 1.6);
    const top = this.spot.top + 0.06;
    const side = Math.random() < 0.5 ? -0.08 : 1.08;
    return {
      kind, size,
      x: enter ? side : rand(0.08, 0.92), y: rand(top, SHORE - 0.12),
      h: enter ? (side < 0 ? 0 : Math.PI) : rand(0, TAU),
      speed: rand(0.025, 0.05) * (0.8 + kind.wild * 0.5),
      state: 'swim', timer: 0, cool: enter ? 0 : rand(0, 2), interest: 0, wob: rand(0, TAU),
    };
  }

  // Fixed scenery for the spot, laid out once.
  makeDeco() {
    const d = { pads: [], rocks: [], reeds: [] };
    if (this.spot.deco === 'pond') {
      for (let i = 0; i < 9; i++) d.pads.push({ x: rand(0.05, 0.95), y: rand(0.08, 0.75), r: rand(0.025, 0.045), a: rand(0, TAU) });
      for (let i = 0; i < 26; i++) d.reeds.push({ x: i < 13 ? rand(0, 0.06) : rand(0.94, 1), y: rand(0.05, 0.9), h: rand(0.05, 0.1) });
    }
    if (this.spot.deco !== 'pond') {
      for (let i = 0; i < 7; i++) {
        const left = i % 2 === 0;
        d.rocks.push({ x: left ? rand(-0.02, 0.07) : rand(0.93, 1.02), y: rand(this.spot.top + 0.05, 0.85), r: rand(0.025, 0.05) });
      }
    }
    return d;
  }

  // ---------- wheel ----------

  turn(dir) {
    if (this.state === 'aim') {
      this.aim = clamp(this.aim + dir * AIM_STEP, -AIM_MAX, AIM_MAX);
    } else if (this.state === 'lure' && dir > 0) {
      const L = this.lureAt, dx = ROD.x - L.x, dy = ROD.y - L.y, d = Math.hypot(dx, dy);
      if (d < REEL_STEP + 0.05) { this.toAim(); return true; }
      L.x += (dx / d) * REEL_STEP;
      L.y += (dy / d) * REEL_STEP;
      this.moved();
      this.reels.push(this.t);
    } else if (this.state === 'fight') {
      const F = this.fight;
      F.effort = clamp(F.effort + (dir > 0 ? REEL_KICK : -GIVE_KICK), -1, 1);
    }
    return true;                    // the games keep the wheel (no volume or scrubbing)
  }

  select() {
    if (this.state === 'aim') { this.state = 'power'; this.power = 0; this.powerDir = 1; return; }
    if (this.state === 'power') { this.cast(); return; }
    if (this.state === 'lure') {
      const f = this.fish.find((q) => q.state === 'bite');
      if (f) { this.hook(f); return; }
      const nib = this.fish.find((q) => q.state === 'nibble');
      if (nib) { this.scare(nib, 4); this.say('Too early'); return; }
      this.moved();                 // a twitch
      this.ripple(this.lureAt.x, this.lureAt.y, 0.5);
      return;
    }
    if (this.state === 'fight') { this.jerk(); return; }
    if (this.state === 'card') this.toAim();
  }

  prev() { this.steer(-1); return true; }
  next() { this.steer(1); return true; }
  play() { return true; }

  steer(dir) {
    if (this.state === 'aim') { this.aim = clamp(this.aim + dir * AIM_STEP * 4, -AIM_MAX, AIM_MAX); return; }
    if (this.state !== 'lure') return;
    this.lureAt.x = clamp(this.lureAt.x + dir * STEER, 0.03, 0.97);
    this.moved();
  }

  moved() { this.lastMove = this.t; }

  ripple(x, y, size = 1) { this.ripples.push({ x, y, t: this.t, size }); }

  say(text) { this.note = { text, until: this.t + 1.4 }; }

  // ---------- casting and the lure ----------

  cast() {
    const dist = 0.12 + this.power * 0.78;
    const tx = clamp(ROD.x + Math.sin(this.aim) * dist, 0.04, 0.96);
    const ty = clamp(ROD.y - Math.cos(this.aim) * dist, this.spot.top + 0.03, SHORE - 0.04);
    this.flight = { x0: ROD.x, y0: ROD.y, x1: tx, y1: ty, t0: this.t };
    this.state = 'cast';
  }

  land() {
    const F = this.flight;
    this.lureAt = { x: F.x1, y: F.y1 };
    this.state = 'lure';
    this.moved();
    this.ripple(F.x1, F.y1, 1.3);
    // A splash right on top of a fish startles it (a legend from further off).
    for (const f of this.fish) if (Math.hypot(f.x - F.x1, f.y - F.y1) < (f.kind.legend ? 0.1 : 0.05)) this.scare(f, 2);
  }

  scare(f, secs) {
    f.state = 'flee';
    f.timer = 0.9;
    f.cool = secs;
    f.interest = 0;
    if (this.lureAt) f.h = Math.atan2(f.y - this.lureAt.y, f.x - this.lureAt.x);
  }

  hook(f) {
    f.state = 'hooked';
    this.hooked = f;
    const dx = f.x - ROD.x, dy = f.y - ROD.y;
    this.fight = {
      d: Math.hypot(dx, dy), ang: Math.atan2(dx, -dy),
      tension: 0.45, effort: 0, pull: f.kind.str * 0.5, phase: 'rest', phaseT: 0.6, run: 0, runDir: 1,
      stam: 1, snap: 0, slack: 0, jerkCool: 0,
      zone: 0.18 - 0.08 * f.kind.str,   // half the green's width; strong fish have less
      center: 0.5, centerTo: 0.5,       // where the green is, and where it's drifting to
    };
    this.state = 'fight';
    this.feedback();
  }

  // ---------- the fight ----------

  jerk() {
    const F = this.fight;
    if (F.jerkCool > 0) return;
    F.jerkCool = 0.15;
    F.tension = Math.max(0, F.tension - 0.05);
    if (F.phase === 'run') { F.run *= 0.6; F.phaseT = Math.min(F.phaseT, 0.8); }
  }

  fightStep(dt) {
    const F = this.fight, f = this.hooked, k = f.kind;
    F.jerkCool -= dt;
    if ((F.phaseT -= dt) <= 0) {
      // A worn-out fish (stamina under 15%) stops running.
      if (F.phase === 'rest' && F.stam > 0.15) {
        F.phase = 'run';
        F.phaseT = rand(0.8, 1.6) * (0.6 + k.wild);
        F.run = k.str * rand(0.75, 1.25);
        F.runDir = Math.random() < 0.5 ? -1 : 1;
        F.tension = Math.min(1, F.tension + 0.25 * k.str);   // the jolt as it takes off
      } else {
        F.phase = 'rest';
        F.phaseT = rand(0.8, 2.2) * (1.5 - k.wild);
      }
    }
    const want = F.phase === 'run' ? F.run * (0.2 + 0.8 * F.stam) : k.str * 0.2 * (0.3 + 0.7 * F.stam);
    F.pull += (want - F.pull) * Math.min(1, 5 * dt);
    F.effort *= Math.exp(-2.5 * dt);
    // Tension climbs while you reel and while the fish pulls, and sags
    // otherwise. No steady pace holds it: reeling hard all fight snaps the
    // line, stopping lets it go slack, so you have to watch the bar.
    F.tension = clamp(F.tension + (0.9 * F.effort + 0.8 * F.pull - 0.45) * dt, 0, 1);
    // The green drifts: harder fish (stronger, wilder) move it further and
    // faster, and faster still while they run. It never reaches the red or
    // the slack end.
    const diff = (k.str + k.wild) / 2;
    if (Math.abs(F.centerTo - F.center) < 0.01) {
      F.centerTo = clamp(0.5 + rand(-1, 1) * (0.04 + 0.2 * diff), SLACK + F.zone + 0.02, SNAP - F.zone - 0.02);
    }
    const drift = (0.04 + 0.22 * diff) * (F.phase === 'run' ? 1.5 : 1) * dt;
    F.center += clamp(F.centerTo - F.center, -drift, drift);
    const green = Math.abs(F.tension - F.center) < F.zone;
    // Line: the fish takes it on a run; reeling brings it in, faster as it tires.
    const reel = F.tension < SNAP ? Math.max(0, F.effort) * 0.1 * (0.35 + 0.65 * (1 - F.stam)) : 0;
    F.d = clamp(F.d + (F.pull * (F.phase === 'run' ? 0.1 : 0.03) - reel) * dt, 0, 0.95);
    F.stam = Math.max(0, F.stam - (dt / (8 + 20 * k.str)) * (green ? 1 : 0.5));
    if (F.phase === 'run') {
      F.ang += F.runDir * F.pull * 0.35 * dt;
      if (Math.abs(F.ang) > AIM_MAX) { F.ang = Math.sign(F.ang) * AIM_MAX; F.runDir *= -1; }
    }
    F.ang += this.spot.current * 0.4 * dt;
    // Where the fish is, for drawing: at the end of the line, never past the far edge.
    f.x = clamp(ROD.x + Math.sin(F.ang) * F.d, 0.03, 0.97);
    f.y = clamp(ROD.y - Math.cos(F.ang) * F.d, this.spot.top + 0.02, SHORE + 0.02);
    f.h = F.phase === 'run' ? Math.atan2(-Math.cos(F.ang), Math.sin(F.ang)) + F.runDir * 1.2 : Math.atan2(f.y - ROD.y, f.x - ROD.x);
    F.snap = F.tension > SNAP ? F.snap + dt / 0.7 : Math.max(0, F.snap - dt * 0.5);
    F.slack = F.tension < SLACK ? F.slack + dt / 1.6 : Math.max(0, F.slack - dt * 0.5);
    if (Math.random() < dt * 3) this.ripple(f.x, f.y, 0.6);
    if (F.snap >= 1) { this.lose('The line snapped'); return; }
    if (F.slack >= 1) { this.lose('It threw the hook'); return; }
    if (F.d <= 0.07) this.caught(f);
  }

  lose(text) {
    const f = this.hooked;
    this.fish = this.fish.filter((q) => q !== f);
    this.respawns.push(this.t + rand(2, 4));
    this.feedback();
    this.card = { lost: text, kind: f.kind };
    this.state = 'card';
  }

  // ---------- a catch ----------

  caught(f) {
    this.fish = this.fish.filter((q) => q !== f);
    this.respawns.push(this.t + rand(2, 4));
    const k = f.kind, avg = (k.size[0] + k.size[1]) / 2;
    const d = fishSave.load(), before = d.points;
    const entry = d.log[k.id] || { n: 0, best: 0 };
    const isNew = entry.n === 0, record = !isNew && f.size > entry.best;
    let pts = Math.max(5, Math.round((k.pts * f.size) / avg));
    if (isNew) pts *= 2;
    entry.n++;
    entry.best = Math.max(entry.best, f.size);
    d.log[k.id] = entry;
    d.points = before + pts;
    fishSave.save(d);
    const opened = [
      ...SPOTS.filter((s) => s.need > before && s.need <= d.points).map((s) => `${s.name} is open`),
      ...LURES.filter((l) => l.need > before && l.need <= d.points).map((l) => `New lure: ${l.name}`),
    ];
    this.card = { kind: k, size: f.size, pts, isNew, record, opened };
    this.state = 'card';
    this.feedback();
    // The board keeps everyone's total: it only goes up, so each catch sends it.
    this.score = d.points;
    this.sent = false;
    scores.gameOver(this, ID);
  }

  // ---------- loop ----------

  step(dt) {
    this.t += dt;
    if (this.state === 'power') {
      this.power += (this.powerDir * dt) / POWER_TIME;
      if (this.power >= 1) { this.power = 1; this.powerDir = -1; }
      if (this.power <= 0) { this.power = 0; this.powerDir = 1; }
    }
    if (this.state === 'cast' && this.t - this.flight.t0 >= CAST_TIME) this.land();
    this.reels = this.reels.filter((at) => this.t - at < FAST_WINDOW);
    this.fastReel = this.reels.length >= FAST_TICKS;
    if (this.state === 'lure') {
      this.lureAt.x = clamp(this.lureAt.x + this.spot.current * 0.5 * dt, 0.03, 0.97);
    }
    if (this.state === 'fight') this.fightStep(dt);
    for (const f of this.fish) this.swim(f, dt);
    // Fresh fish swim in for the ones caught or lost, and now and then one
    // leaves and another comes, so the rare ones get their turn.
    this.respawns = this.respawns.filter((at) => { if (this.t < at) return true; this.fish.push(this.newFish(true)); return false; });
    if (this.t > this.rotateAt) {
      this.rotateAt = this.t + rand(25, 40);
      const idle = this.fish.filter((f) => f.state === 'swim');
      if (idle.length) { const f = idle[Math.floor(Math.random() * idle.length)]; f.state = 'leave'; }
    }
    this.ripples = this.ripples.filter((r) => this.t - r.t < 1.4);
  }

  swim(f, dt) {
    if (f.state === 'hooked') return;
    f.cool = Math.max(0, f.cool - dt);
    f.wob += dt * 3;
    const L = this.state === 'lure' ? this.lureAt : null;
    const busy = this.fish.some((q) => q !== f && (q.state === 'nibble' || q.state === 'bite' || q.state === 'chase'));
    if (f.state === 'leave') {
      f.h = f.x < 0.5 ? Math.PI : 0;
      f.x += Math.cos(f.h) * f.speed * 2 * dt;
      if (f.x < -0.1 || f.x > 1.1) { this.fish = this.fish.filter((q) => q !== f); this.fish.push(this.newFish(true)); }
      return;
    }
    if ((f.state === 'chase' || f.state === 'nibble' || f.state === 'bite') && !L) { f.state = 'swim'; f.interest = 0; }
    if (f.state === 'swim') {
      // Wander, turning back from the edges.
      f.h += Math.sin(f.wob * 0.7 + f.size) * 0.6 * dt;
      const top = this.spot.top + 0.05;
      if (f.x < 0.06) f.h += turnToward(f.h, 0, 1.5 * dt);
      if (f.x > 0.94) f.h += turnToward(f.h, Math.PI, 1.5 * dt);
      if (f.y < top) f.h += turnToward(f.h, Math.PI / 2, 1.5 * dt);
      if (f.y > SHORE - 0.1) f.h += turnToward(f.h, -Math.PI / 2, 1.5 * dt);
      f.x += Math.cos(f.h) * f.speed * dt + this.spot.current * 0.3 * dt;
      f.y += Math.sin(f.h) * f.speed * dt;
      // A moving lure it likes, close enough: it gets curious, then comes over.
      if (L && !f.cool && !busy) {
        const d = Math.hypot(L.x - f.x, L.y - f.y);
        const likes = f.kind.lures.includes(this.lure.id);
        const moving = this.t - this.lastMove < MOVED;
        if (this.fastReel && d < SIGHT) f.interest = Math.max(0, f.interest - dt * 2);   // a lure racing past isn't food
        else if (d < SIGHT * (this.lure.glow ? 1.3 : 1) && moving) {
          // Legends are warier: slower to come over.
          if (likes) { f.interest += dt * (f.kind.legend ? 0.6 : 1.4); if (f.interest > 1) f.state = 'chase'; } else if (d < 0.07) this.scare(f, 3);
        } else f.interest = Math.max(0, f.interest - dt * 0.3);
      }
      return;
    }
    if (f.state === 'flee') {
      f.x += Math.cos(f.h) * 0.16 * dt;
      f.y += Math.sin(f.h) * 0.16 * dt;
      f.x = clamp(f.x, 0.02, 0.98);
      f.y = clamp(f.y, this.spot.top + 0.03, SHORE - 0.05);
      if ((f.timer -= dt) <= 0) f.state = 'swim';
      return;
    }
    // chase, nibble, bite: around the lure. Reeling fast scares it off.
    if (this.fastReel) { this.scare(f, 3); this.say('Too fast'); return; }
    const dx = L.x - f.x, dy = L.y - f.y, d = Math.hypot(dx, dy);
    const reach = fishLen(f) * 0.5;
    if (f.state === 'chase') {
      f.h = Math.atan2(dy, dx);
      const v = Math.min(d, 0.1 * dt);
      f.x += Math.cos(f.h) * v;
      f.y += Math.sin(f.h) * v;
      if (d < reach + 0.01) { f.state = 'nibble'; f.timer = rand(0.8, 2); }
      return;
    }
    // Nose on the lure: it follows if the lure moves a little, and gives up
    // if it's pulled away.
    if (d > reach + 0.06) { this.scare(f, 2); return; }
    f.h = Math.atan2(dy, dx);
    f.x = L.x - Math.cos(f.h) * reach;
    f.y = L.y - Math.sin(f.h) * reach;
    if (f.state === 'nibble') {
      if (Math.random() < dt * 4) this.ripple(L.x, L.y, 0.35);
      if ((f.timer -= dt) <= 0) {
        f.state = 'bite';
        f.timer = 0.95 - 0.25 * f.kind.wild;   // a press counts when the thumb lifts, so not too tight
        this.ripple(L.x, L.y, 0.9);
        this.feedback();
      }
      return;
    }
    if ((f.timer -= dt) <= 0) { this.scare(f, 3); this.say('Too late'); }   // it spat the lure
  }

  // ---------- drawing ----------

  draw({ g, w, h, dpr }) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = this.spot, X = (x) => x * w, Y = (y) => y * h, U = h;   // U: px per unit for sizes
    this.drawScene(g, w, h, X, Y, U);
    // ripples
    for (const r of this.ripples) {
      const a = (this.t - r.t) / 1.4;
      g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - a)})`;
      g.lineWidth = 1.2;
      g.beginPath(); g.ellipse(X(r.x), Y(r.y), U * 0.05 * r.size * (0.3 + a), U * 0.025 * r.size * (0.3 + a), 0, 0, TAU); g.stroke();
    }
    // fish shadows (the hooked one too)
    for (const f of this.fish) {
      const len = fishLen(f) * U;
      const sway = f.state === 'swim' || f.state === 'chase' ? Math.sin(f.wob * 2) * 0.12 : Math.sin(this.t * 14) * 0.08;
      drawFish(g, X(f.x), Y(f.y), len, f.h, f.kind.look, true, sway);
      if (f.kind.legend && f.state !== 'hooked' && Math.sin(this.t * 2 + f.wob) > 0.6) {
        g.fillStyle = 'rgba(255,240,170,.8)';
        g.beginPath(); g.arc(X(f.x) + Math.cos(f.h) * len * 0.2, Y(f.y) + Math.sin(f.h) * len * 0.2, 1.6, 0, TAU); g.fill();
      }
    }
    // line and lure
    const tip = [X(ROD.x), Y(ROD.y)];
    let end = null;
    if (this.state === 'cast') {
      const F = this.flight, a = clamp((this.t - F.t0) / CAST_TIME, 0, 1);
      end = [X(F.x0 + (F.x1 - F.x0) * a), Y(F.y0 + (F.y1 - F.y0) * a) - Math.sin(a * Math.PI) * h * 0.18];
    } else if (this.state === 'lure') end = [X(this.lureAt.x), Y(this.lureAt.y)];
    else if (this.state === 'fight') end = [X(this.hooked.x), Y(this.hooked.y)];
    if (end) {
      const F = this.fight;
      g.strokeStyle = this.state === 'fight' && F.tension > SNAP ? '#ff8a7a' : 'rgba(240,244,255,.75)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(...tip);
      const sag = this.state === 'fight' ? (1 - F.tension) * 0.06 * h : 0.03 * h;
      g.quadraticCurveTo((tip[0] + end[0]) / 2, (tip[1] + end[1]) / 2 + sag, ...end);
      g.stroke();
      if (this.state !== 'fight') {
        const bob = this.fish.some((f) => f.state === 'nibble' || f.state === 'bite') ? Math.sin(this.t * 30) * 1.5 : 0;
        if (this.lure.glow) {
          const gl = g.createRadialGradient(end[0], end[1], 0, end[0], end[1], U * 0.03);
          gl.addColorStop(0, 'rgba(143,240,255,.6)'); gl.addColorStop(1, 'rgba(143,240,255,0)');
          g.fillStyle = gl; g.beginPath(); g.arc(end[0], end[1], U * 0.03, 0, TAU); g.fill();
        }
        g.fillStyle = this.lure.color;
        g.beginPath(); g.arc(end[0], end[1] + bob, Math.max(2.5, U * 0.011), 0, TAU); g.fill();
      }
    }
    // a "!" over a biting fish
    const biter = this.fish.find((f) => f.state === 'bite');
    if (biter && this.state === 'lure') {
      g.font = font(h * 0.08, 800);
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillStyle = '#ffd84a';
      g.fillText('!', X(this.lureAt.x), Y(this.lureAt.y) - h * 0.03);
    }
    // Too early / Too late / Too fast, over where the lure is
    if (this.note && this.note.until > this.t && this.lureAt) {
      g.font = font(h * 0.05, 700);
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillStyle = `rgba(255,190,170,${Math.min(1, (this.note.until - this.t) * 2)})`;
      g.fillText(this.note.text, X(this.lureAt.x), Y(this.lureAt.y) - h * 0.03);
    }
    this.drawRod(g, X, Y, h);
    if (this.state === 'aim') this.drawAim(g, X, Y, h);
    if (this.state === 'power') { this.drawAim(g, X, Y, h); this.drawPower(g, w, h); }
    if (this.state === 'fight') this.drawFight(g, w, h);
    this.drawHud(g, w, h);
    if (this.state === 'card') this.drawCard(g, w, h);
  }

  drawScene(g, w, h, X, Y, U) {
    const S = this.spot;
    // sky or far bank
    if (S.deco === 'sea') {
      const sky = g.createLinearGradient(0, 0, 0, Y(S.top));
      sky.addColorStop(0, '#f4a86a'); sky.addColorStop(1, '#ffd9a0');
      g.fillStyle = sky; g.fillRect(0, 0, w, Y(S.top));
      g.fillStyle = '#fff4d0';
      g.beginPath(); g.arc(X(0.75), Y(S.top), h * 0.06, Math.PI, TAU); g.fill();
    } else if (S.deco === 'river') {
      g.fillStyle = '#4a7a3a'; g.fillRect(0, 0, w, Y(S.top));
      g.fillStyle = '#3a6a2e';
      for (let i = 0; i < 14; i++) { g.beginPath(); g.arc(X(i / 13), Y(S.top * 0.35), h * 0.045, 0, TAU); g.fill(); }
      g.fillStyle = '#8a7a5a'; g.fillRect(0, Y(S.top) - h * 0.012, w, h * 0.012);
    } else {
      g.fillStyle = '#3f6a32'; g.fillRect(0, 0, w, Y(S.top) + 2);
    }
    // water
    const water = g.createLinearGradient(0, Y(S.top), 0, Y(SHORE));
    water.addColorStop(0, S.water[0]); water.addColorStop(1, S.water[1]);
    g.fillStyle = water; g.fillRect(0, Y(S.top), w, Y(SHORE) - Y(S.top));
    // moving light on the water: current streaks, waves, or still glints
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 18; i++) {
      const y = S.top + 0.04 + ((i * 0.37) % 1) * (SHORE - S.top - 0.08);
      const speed = S.deco === 'river' ? 0.12 : S.deco === 'sea' ? 0.03 : 0.008;
      const x = (((i * 0.61 + this.t * speed) % 1.2) + 1.2) % 1.2 - 0.1;
      const len = S.deco === 'river' ? 0.08 : 0.04;
      if (S.deco === 'sea') {
        g.moveTo(X(x), Y(y));
        g.quadraticCurveTo(X(x + len / 2), Y(y) - 3, X(x + len), Y(y));
      } else { g.moveTo(X(x), Y(y)); g.lineTo(X(x + len), Y(y)); }
    }
    g.stroke();
    // scenery
    for (const p of this.deco.pads) {
      g.fillStyle = '#4f9a48';
      g.beginPath(); g.moveTo(X(p.x), Y(p.y)); g.ellipse(X(p.x), Y(p.y), p.r * U, p.r * U * 0.7, 0, p.a + 0.3, p.a + TAU - 0.3); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(30,70,30,.5)'; g.stroke();
    }
    for (const r of this.deco.rocks) {
      g.fillStyle = '#6f7378';
      g.beginPath(); g.ellipse(X(r.x), Y(r.y), r.r * U, r.r * U * 0.75, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.15)';
      g.beginPath(); g.ellipse(X(r.x) - r.r * U * 0.3, Y(r.y) - r.r * U * 0.25, r.r * U * 0.4, r.r * U * 0.25, 0, 0, TAU); g.fill();
    }
    g.strokeStyle = '#6a8a3a';
    g.lineWidth = 2;
    g.beginPath();
    for (const r of this.deco.reeds) { g.moveTo(X(r.x), Y(r.y)); g.lineTo(X(r.x) + 2, Y(r.y - r.h)); }
    g.stroke();
    // the shore
    const shoreColor = S.deco === 'sea' ? '#5a5048' : S.deco === 'river' ? '#9a8a6a' : '#6a8a40';
    g.fillStyle = shoreColor;
    g.fillRect(0, Y(SHORE), w, h - Y(SHORE));
    g.fillStyle = S.deco === 'sea' ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)';
    g.beginPath();
    for (let x = 0; x <= 1.001; x += 0.02) g.lineTo(X(x), Y(SHORE) + Math.sin(x * 40 + this.t * (S.deco === 'sea' ? 2 : 0.6)) * 1.5);
    g.lineTo(w, Y(SHORE) + 3); g.lineTo(0, Y(SHORE) + 3); g.closePath(); g.fill();
    if (S.deco === 'pond') {
      // a little dock under the rod
      g.fillStyle = '#8a6440';
      g.fillRect(X(0.44), Y(0.86), X(0.12), h - Y(0.86));
      g.strokeStyle = '#5e4128'; g.lineWidth = 1;
      g.beginPath();
      for (let y = 0.86; y < 1; y += 0.025) { g.moveTo(X(0.44), Y(y)); g.lineTo(X(0.56), Y(y)); }
      g.stroke();
    }
  }

  drawRod(g, X, Y, h) {
    const bend = this.state === 'fight' ? this.fight.tension * 0.4 : 0;
    const a = (this.state === 'fight' ? this.fight.ang : this.aim) * 0.5;
    g.strokeStyle = '#3a2a1a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(X(ROD.x) - Math.sin(a) * h * 0.12, h * 1.02);
    g.quadraticCurveTo(X(ROD.x) - Math.sin(a) * h * 0.05, Y(ROD.y) + h * 0.05 + bend * h * 0.05, X(ROD.x), Y(ROD.y));
    g.stroke();
  }

  drawAim(g, X, Y, h) {
    const len = 0.22;
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.setLineDash([4, 5]);
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(ROD.x), Y(ROD.y)); g.lineTo(X(ROD.x + Math.sin(this.aim) * len), Y(ROD.y - Math.cos(this.aim) * len)); g.stroke();
    g.setLineDash([]);
  }

  drawPower(g, w, h) {
    const bw = w * 0.4, bh = h * 0.045, x = w * 0.3, y = h * 0.8;
    g.fillStyle = 'rgba(5,10,20,.7)'; g.fillRect(x - 3, y - 3, bw + 6, bh + 6);
    const grad = g.createLinearGradient(x, 0, x + bw, 0);
    grad.addColorStop(0, '#3ddc84'); grad.addColorStop(0.7, '#f5c26b'); grad.addColorStop(1, '#ff6b5a');
    g.fillStyle = grad; g.fillRect(x, y, bw * this.power, bh);
  }

  drawFight(g, w, h) {
    const F = this.fight;
    const bw = w * 0.62, bh = h * 0.055, x = (w - bw) / 2, y = h * 0.82;
    g.fillStyle = 'rgba(5,10,20,.75)'; g.fillRect(x - 4, y - 4, bw + 8, bh + 8);
    g.fillStyle = '#2a3346'; g.fillRect(x, y, bw, bh);
    g.fillStyle = 'rgba(255,107,90,.55)'; g.fillRect(x + bw * SNAP, y, bw * (1 - SNAP), bh);
    g.fillStyle = 'rgba(160,170,190,.35)'; g.fillRect(x, y, bw * SLACK, bh);
    g.fillStyle = 'rgba(61,220,132,.75)'; g.fillRect(x + bw * (F.center - F.zone), y, bw * F.zone * 2, bh);
    const warn = F.snap > 0.05 || F.slack > 0.05;
    const mx = x + bw * F.tension;
    g.fillStyle = warn && Math.sin(this.t * 25) > 0 ? '#ff6b5a' : '#f4f6ff';
    g.fillRect(mx - 2.5, y - 5, 5, bh + 10);
    // line out, and how much fight it has left
    g.font = font(h * 0.045, 700);
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillStyle = '#e8ecff';
    g.fillText(`${Math.round(F.d * LINE_M)} m`, x, y - 8);
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x + bw * 0.6, y - 14, bw * 0.4, 5);
    g.fillStyle = '#f5c26b'; g.fillRect(x + bw * 0.6, y - 14, bw * 0.4 * F.stam, 5);
  }

  drawHud(g, w, h) {
    const d = fishSave.load();
    g.font = font(h * 0.045, 700);
    g.textBaseline = 'top';
    g.textAlign = 'right';
    g.fillStyle = 'rgba(5,10,20,.55)';
    const text = `${d.points.toLocaleString()} pts`;
    const tw = g.measureText(text).width;
    g.fillRect(w - tw - h * 0.05, h * 0.02, tw + h * 0.04, h * 0.065);
    g.fillStyle = '#f4f6ff';
    g.fillText(text, w - h * 0.03, h * 0.032);
    g.textAlign = 'left';
    const lt = this.lure.name;
    const lw = g.measureText(lt).width;
    g.fillStyle = 'rgba(5,10,20,.55)';
    g.fillRect(h * 0.01, h * 0.02, lw + h * 0.075, h * 0.065);
    g.fillStyle = this.lure.color;
    g.beginPath(); g.arc(h * 0.035, h * 0.052, h * 0.012, 0, TAU); g.fill();
    g.fillStyle = '#f4f6ff';
    g.fillText(lt, h * 0.06, h * 0.032);
  }

  // After a catch (the fish, how big, the points) or a lost one.
  drawCard(g, w, h) {
    const C = this.card;
    const bw = Math.min(w * 0.8, h * 1.3), bh = h * 0.7, x = (w - bw) / 2, y = h * 0.12;
    g.fillStyle = 'rgba(5,10,20,.88)';
    g.fillRect(x, y, bw, bh);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (C.lost) {
      g.font = font(h * 0.065, 700); g.fillStyle = '#e8ecff';
      g.fillText(C.lost, w / 2, y + bh * 0.4);
      g.font = font(h * 0.045, 500); g.fillStyle = '#9aa4c4';
      g.fillText('Center to cast again', w / 2, y + bh * 0.62);
      return;
    }
    const k = C.kind;
    drawFish(g, w / 2, y + bh * 0.3, Math.min(bw * 0.55, h * 0.45), 0, k.look, false, 0);
    g.font = font(h * 0.065, 700); g.fillStyle = k.legend ? '#ffd84a' : '#f4f6ff';
    g.fillText(k.name, w / 2, y + bh * 0.58);
    g.font = font(h * 0.05, 500); g.fillStyle = '#b9c2e8';
    const tag = C.isNew ? '  ·  New!' : C.record ? '  ·  Biggest yet' : '';
    g.fillText(`${C.size} cm  ·  +${C.pts.toLocaleString()}${tag}`, w / 2, y + bh * 0.7);
    g.fillStyle = '#3ddc84';
    C.opened.forEach((t, i) => g.fillText(t, w / 2, y + bh * (0.82 + i * 0.09)));
  }
}

// ---------- helpers ----------

function angDiff(a, b) { return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }
function turnToward(h, target, max) { return clamp(-angDiff(h, target), -max, max); }

// A fish's length on screen (units of view height): grows with size, capped.
// Big enough to tell a bluegill from a bass on an iPod-sized screen.
function fishLen(f) { return clamp(0.045 + f.size * 0.0007, 0.055, 0.19); }

// A fish facing angle a, len px long. As a shadow (dark, for the water) or
// in color (the catch card). sway bends the tail.
function drawFish(g, x, y, len, a, look, shadow, sway) {
  const ht = len * look.deep;
  g.save();
  g.translate(x, y);
  g.rotate(a);
  const body = shadow ? 'rgba(5,15,20,.45)' : look.body;
  // tail
  g.fillStyle = shadow ? body : (look.fin || look.body);
  g.save();
  g.translate(-len * 0.42, 0);
  g.rotate(sway);
  g.beginPath(); g.moveTo(0, 0); g.lineTo(-len * 0.2, -ht * 0.55); g.lineTo(-len * 0.14, 0); g.lineTo(-len * 0.2, ht * 0.55); g.closePath(); g.fill();
  g.restore();
  // body
  if (!shadow) {
    const grad = g.createLinearGradient(0, -ht / 2, 0, ht / 2);
    grad.addColorStop(0, look.body); grad.addColorStop(0.55, look.body); grad.addColorStop(1, look.belly);
    g.fillStyle = grad;
  } else g.fillStyle = body;
  g.beginPath(); g.ellipse(0, 0, len * 0.45, ht / 2, 0, 0, TAU); g.fill();
  if (look.sword) {
    g.strokeStyle = shadow ? body : look.body;
    g.lineWidth = Math.max(1, ht * 0.08);
    g.beginPath(); g.moveTo(len * 0.4, -ht * 0.05); g.lineTo(len * 0.85, -ht * 0.1); g.stroke();
  }
  if (shadow) { g.restore(); return; }
  // fins
  g.fillStyle = look.fin || look.body;
  g.beginPath(); g.moveTo(-len * 0.1, -ht * 0.45); g.quadraticCurveTo(len * 0.05, -ht * 0.85, len * 0.15, -ht * 0.42); g.closePath(); g.fill();
  // markings, kept inside the body
  g.save();
  g.beginPath(); g.ellipse(0, 0, len * 0.45, ht / 2, 0, 0, TAU); g.clip();
  const mc = look.markColor || 'rgba(20,30,20,.35)';
  g.fillStyle = mc;
  g.strokeStyle = mc;
  if (look.mark === 'bars') for (let i = -2; i <= 2; i++) g.fillRect(i * len * 0.12 - len * 0.025, -ht / 2, len * 0.05, ht * 0.75);
  if (look.mark === 'stripe') g.fillRect(-len * 0.45, -ht * 0.06, len * 0.9, ht * 0.12);
  if (look.mark === 'spots') {
    const hash = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); };   // scattered, the same every time
    for (let i = 0; i < 14; i++) {
      const sx = (hash(i + 1) - 0.5) * len * 0.75, sy = (hash(i + 50) - 0.6) * ht * 0.8;
      g.beginPath(); g.arc(sx, sy, Math.max(1, len * 0.018), 0, TAU); g.fill();
    }
  }
  if (look.mark === 'waves') {
    g.lineWidth = Math.max(1, len * 0.012);
    for (let i = 0; i < 6; i++) {
      g.beginPath(); g.moveTo(-len * 0.35 + i * len * 0.11, -ht * 0.45); g.quadraticCurveTo(-len * 0.3 + i * len * 0.11, -ht * 0.2, -len * 0.35 + i * len * 0.11, -ht * 0.05); g.stroke();
    }
  }
  if (look.mark === 'scutes') for (let i = -3; i <= 3; i++) { g.beginPath(); g.arc(i * len * 0.1, -ht * 0.3, Math.max(1, len * 0.02), 0, TAU); g.fill(); }
  g.restore();
  // eye and whiskers
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(len * 0.3, -ht * 0.1, Math.max(1.5, ht * 0.1), 0, TAU); g.fill();
  g.fillStyle = '#111';
  g.beginPath(); g.arc(len * 0.31, -ht * 0.1, Math.max(1, ht * 0.055), 0, TAU); g.fill();
  if (look.whiskers) {
    g.strokeStyle = 'rgba(30,30,30,.7)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(len * 0.42, ht * 0.05); g.quadraticCurveTo(len * 0.5, ht * 0.3, len * 0.44, ht * 0.5);
    g.moveTo(len * 0.4, ht * 0.08); g.quadraticCurveTo(len * 0.42, ht * 0.35, len * 0.34, ht * 0.5);
    g.stroke();
  }
  g.restore();
}
