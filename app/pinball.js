// Star Pinball: a space pinball table for the click wheel, in Extras with
// Fishing Trip and Tiki Golf. It replaced Vortex: the ask was
// a pinball game in the spirit of the old Windows space pinball. Original
// table, rules and art; nothing is copied from that game.
//
// Wheel: previous and next are the left and right flippers. They go up the
// moment the ring is touched and drop when it's let go, both at once with
// two thumbs. That needs the wheel's raw mode (rawButtons below, wheel.js),
// because a normal press only counts when the thumb lifts. Hold center to
// pull the plunger back, let go to launch: the longer the pull, the harder
// the shot. Play/pause, or MENU held, opens the pause menu (pause.js, the
// same in all three games); a MENU tap mid-game only says to hold it
// (a thumb slipping up off a flipper quit the game).
// While paused the wheel works normally (not raw), so it can pick Resume or
// Quit game.
//
// The table is drawn in perspective, looking up it from behind the
// flippers: the far end is narrower and the ball gets smaller as it rolls
// away (the flat first version felt too 2D). Walls,
// bumpers and the ramp have height, and the ball has a shadow.
//
// Three tables and five balls (points unlock two more
// maps and different balls). Every point scored adds to a running total
// kept on the phone; a table or ball opens once the total reaches its
// `need`. The balls only look different, so scores stay comparable on the
// one shared board. The tables share the lower half (flippers, slingshots,
// inlanes, plunger) so the flippers feel the same on all of them.
//
// Rules: missions in a loop, and each finished one flies you on to the next
// stop for a bonus. Lighting all three top lanes raises the multiplier
// (the flippers shift the lit lanes along, so you can line up the gap); it
// goes back to x1 when a ball is lost. The black hole mission ends in a
// two-ball multiball, and a full loop of missions gives an extra ball.
// A ball lost in its first few seconds comes back (ball save).
//
// Game units: the table is 1 wide and 1.8 tall, (0, 0) its top-left corner,
// y down; z is height above the table. The physics is flat (x, y); only the
// ramps and the drawing use z.
import * as scores from './scores.js';
import { Pause } from './pause.js';
import { canvasFont as font, runCanvas, store } from './util.js';
import { newBodies } from './bodies.js';

const ID = 'pinball';               // the score board's name for it
const TH = 1.8;                     // table height (width is 1)
const R = 0.025;                    // ball radius
const G = 2.6;                      // the table's slope pulling balls down, units/s²
const H = 1 / 480;                  // physics step: at top speed a ball moves under half its radius
const MAX_V = 5.5;
const BALLS = 3;
const SAVE_TIME = 6;                // seconds of ball save after a launch
const STILL_TIME = 3;               // a ball resting this long somewhere odd gets a nudge

// Plunger lane, on the right behind a divider at x 0.92.
const LANE_X = 0.96;
const PLUNGER_Y = 1.75;             // the plunger's face at rest
const PULL = 0.06;                  // how far it draws back at a full pull
const PULL_TIME = 0.8;              // seconds to a full pull
const LAUNCH_MIN = 2.2;             // a tap: falls back into the lane
const LAUNCH_MAX = 3.9;

// Flippers: angle 0 points right, growing clockwise; the right one is the
// left one mirrored. Their tips at rest leave a gap a ball just fits through.
const FLIP_LEN = 0.14;
const FLIP_R = 0.016;
const FLIP_REST = 0.55;
const FLIP_UP = -0.45;
const FLIP_UP_SPEED = 28;           // rad/s: up in about 35 ms
const FLIP_DOWN_SPEED = 14;
const FLIP_E = 0.45;

const BUMPER_R = 0.055;
const BUMPER_KICK = 2.2;            // the least speed a bumper sends a ball off at
const SLING_KICK = 1.8;
const MOON_KICK = 1.6;
const RAMP_LIFT = 6;                // how much harder climbing a ramp is than rolling up the table
const RAMP_EXIT = 3;                // top speed coming off one
const RAMP_W = 0.035;               // half a ramp's width, for drawing
const LANES = [0.3, 0.46, 0.62];    // top lane centers
const LANE_Y = 0.18;                // a ball crossing this line downward rolls over the lane
const TARGET_RESET = 1.5;           // seconds the target bank stays down
const HOLD = 1;                     // seconds the black hole keeps a ball
const HOLE_R = 0.03;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- the table ----------

const seg = (ax, ay, bx, by, o = {}) => ({ ax, ay, bx, by, e: 0.45, t: 0.004, ...o });
const mirror = (x) => 0.92 - x;     // left and right halves of the playfield

// What every table has: the outer walls, the plunger lane, the lower half
// and the top lane posts, plus the table's own walls (`extra`).
function baseWalls(extra) {
  const w = [seg(0, TH, 0, 0.5)];
  // The top is a half circle, so a launched ball curves round into the field.
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI + (Math.PI * i) / N, a1 = Math.PI + (Math.PI * (i + 1)) / N;
    w.push(seg(0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0), 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1)));
  }
  w.push(seg(1, 0.5, 1, TH));
  w.push(seg(0.92, 0.45, 0.92, TH));                              // plunger lane divider
  w.push(seg(0.92, PLUNGER_Y, 1, PLUNGER_Y, { e: 0.2, floor: true }));
  // Inlane guides: from the side walls down to the flippers. Each ends level
  // with the top of its flipper (pivot y minus the flipper's thickness), or a
  // slow ball rolling down stops in the step between them.
  const GY = 1.58 - (FLIP_R - 0.004);
  w.push(seg(0, 1.41, 0.29, GY), seg(0.92, 1.41, mirror(0.29), GY));
  // Top lane posts.
  for (const x of [0.22, 0.38, 0.54, 0.7]) w.push(seg(x, 0.12, x, 0.24, { t: 0.008, h: 0.035 }));
  w.push(...extra);                                               // the table's own
  // Slingshots: triangles above the flippers; the face toward the middle kicks.
  for (const m of [(x) => x, mirror]) {
    // Kept clear of the guide below by more than a ball, so none wedges under them.
    const A = [m(0.1), 1.24], B = [m(0.1), 1.37], C = [m(0.22), 1.45];
    w.push(seg(...A, ...B), seg(...B, ...C), seg(...A, ...C, { kick: SLING_KICK, sling: m === mirror ? 1 : 0 }));
  }
  return w;
}

// Ramps (the first added 2026-11-08 with the perspective view): the
// entrance is a box, open at the bottom, with a peaked roof. A ball rolling in fast enough climbs
// above the table, runs over the top and drops into the far inlane, onto
// that side's flipper; too slow and it rolls back out. Points are x, y, z.
//
// Left: in on the left, over the top past the bumpers, down into the right inlane.
const RAMP_L = {
  pts: [[0.17, 0.76, 0], [0.16, 0.56, 0.05], [0.19, 0.4, 0.07], [0.3, 0.34, 0.075], [0.6, 0.34, 0.075],
    [0.78, 0.37, 0.075], [0.86, 0.47, 0.07], [0.87, 0.75, 0.06], [0.87, 1.08, 0.03], [0.87, 1.3, 0]],
  box: { x0: 0.1, x1: 0.24, y0: 0.7, y1: 0.78 },
};
// Right: the left one mirrored, but further up the table and higher across
// the top, so on Event Horizon it passes over the left one.
const RAMP_R = {
  pts: [[0.75, 0.76, 0], [0.76, 0.56, 0.06], [0.73, 0.4, 0.09], [0.62, 0.28, 0.11], [0.32, 0.28, 0.11],
    [0.14, 0.31, 0.11], [0.06, 0.42, 0.1], [0.05, 0.75, 0.08], [0.05, 1.08, 0.04], [0.05, 1.3, 0]],
  box: { x0: 0.68, x1: 0.82, y0: 0.7, y1: 0.78 },
};

// A ramp as a smooth path (Catmull-Rom through its points), each point
// [x, y, z, distance along it].
function sampleRamp(P) {
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < 8; k++) {
      const t = k / 8, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((j) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t
        + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(P[P.length - 1].slice());
  out[0].push(0);
  for (let i = 1; i < out.length; i++) out[i].push(out[i - 1][3] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return out;
}

// Where distance s along a ramp's path is: position, height, direction
// (tx, ty) and how steeply it climbs (dz per unit along).
function rampAt(path, s) {
  let i = 0;
  while (i < path.length - 2 && path[i + 1][3] <= s) i++;
  const a = path[i], b = path[i + 1], len = b[3] - a[3] || 1e-9;
  const f = clamp((s - a[3]) / len, 0, 1);
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f,
    tx: (b[0] - a[0]) / len, ty: (b[1] - a[1]) / len, dz: (b[2] - a[2]) / len };
}
// Closes the plunger lane once a ball has left it, so it can't fall back in.
const GATE = seg(0.92, 0.45, 0.985, 0.4);
const FLIPPERS = [{ x: 0.295, y: 1.58, dir: 1 }, { x: mirror(0.295), y: 1.58, dir: -1 }];

// Where each table's missions fly you. `glow` draws a star, `galaxy` a
// spiral seen from the side, `ring` gives a planet rings.
const PLANETS = [
  { name: 'the Moon', color: '#c9ccd6' },
  { name: 'Mars', color: '#e0663f' },
  { name: 'Jupiter', color: '#d9a066' },
  { name: 'Saturn', color: '#e8cf8a', ring: true },
  { name: 'Uranus', color: '#8fd8e8' },
  { name: 'Neptune', color: '#4f7ae8' },
  { name: 'Pluto', color: '#b8a08a' },
];
const STARS = [
  { name: 'Sirius', color: '#cfe3ff', glow: true },
  { name: 'Vega', color: '#e8f0ff', glow: true },
  { name: 'Betelgeuse', color: '#ff7a4f', glow: true },
  { name: 'Rigel', color: '#9fc4ff', glow: true },
  { name: 'Antares', color: '#ff5a3c', glow: true },
  { name: 'Polaris', color: '#fff2c8', glow: true },
  { name: 'Deneb', color: '#dfe8ff', glow: true },
];
const GALAXIES = [
  { name: 'Andromeda', color: '#d8c8ff', galaxy: true },
  { name: 'the Whirlpool', color: '#9fd0ff', galaxy: true },
  { name: 'the Sombrero', color: '#ffe0a8', galaxy: true },
  { name: 'Triangulum', color: '#c8f0ff', galaxy: true },
  { name: 'the Pinwheel', color: '#ffc8e8', galaxy: true },
  { name: 'the Cartwheel', color: '#ffd28a', galaxy: true },
];

const M = {
  lanes: { id: 'lanes', text: 'Light all three lanes', need: () => 1 },
  bumpers: { id: 'bumpers', text: 'Hit the bumpers', need: (lap) => 12 + 6 * lap },
  ramp: { id: 'ramp', text: 'Ride the ramp', need: (lap) => 2 + lap },
  ramps: { id: 'ramp', text: 'Ride the ramps', need: (lap) => 3 + lap },
  moon: { id: 'moon', text: 'Hit the moon', need: (lap) => 4 + 2 * lap },
  moons: { id: 'moon', text: 'Hit the moons', need: (lap) => 6 + 3 * lap },
  targets: { id: 'targets', text: 'Knock down the targets', need: () => 1 },
  hole: { id: 'hole', text: 'Shoot the black hole', need: () => 1 },
};

// The tables. Bumpers are [x, y, radius]. Moons are bumpers that circle a
// point: center, orbit radius, own radius, rad/s, starting angle. Targets
// are a bank of four drop targets on a side wall (face: which way they
// point). The hole's `out` is the speed it spits the ball out at, toward a
// flipper. Clearances: a ball (0.05 across) passes anywhere there's 0.06
// between two things, and can't get into anything narrower than 0.05; a
// moon's orbit is kept tight enough to its planet that no ball fits between.
const TABLES = [
  {
    id: 'run', name: 'Star Run', need: 0,
    ramps: [RAMP_L],
    bumpers: [[0.32, 0.5, BUMPER_R], [0.6, 0.5, BUMPER_R], [0.46, 0.68, BUMPER_R]],
    moons: [],
    targets: { x: 0.04, face: 1 },
    hole: { x: 0.8, y: 0.95, out: [-1.1, 1.65] },
    missions: [M.lanes, M.bumpers, M.ramp, M.targets, M.hole],
    stops: PLANETS,
    theme: {
      floor: ['#07081a', '#161a3d'], grid: '155,123,255', wall: '155,123,255', edge: '#b9a6ff', ramp: '79,209,232',
      bumper: { side: '#123a4a', top: '#1b2246', rim: '#4fd1e8', cap: '#2e6f86', lit: '#bff4ff' },
      lane: ['#4fd1e8', '#262b52'], hole: '#7b5cff', target: ['#f5c26b', '#c98f2e', '245,194,107'],
    },
  },
  {
    // A planet with a moon going round it in the middle, two bumpers beside
    // them, the ramp on the right.
    id: 'nebula', name: 'Nebula', need: 200_000,
    ramps: [RAMP_R],
    bumpers: [[0.46, 0.56, 0.06], [0.18, 0.44, BUMPER_R], [0.74, 0.44, BUMPER_R]],
    moons: [{ cx: 0.46, cy: 0.56, orbit: 0.14, r: 0.04, w: 1.3, a0: 0 }],
    targets: { x: 0.88, face: -1 },
    hole: { x: 0.15, y: 0.95, out: [1.1, 1.65] },
    missions: [M.lanes, M.moon, M.ramp, M.bumpers, M.targets, M.hole],
    stops: STARS,
    theme: {
      floor: ['#12061a', '#341040'], grid: '255,120,210', wall: '255,120,210', edge: '#ff9fe0', ramp: '61,220,132',
      bumper: { side: '#3a1240', top: '#2a0f33', rim: '#ff7ad1', cap: '#8a2f73', lit: '#ffd6f3' },
      lane: ['#3ddc84', '#3a1d45'], hole: '#ff5fa2', target: ['#8fe8b0', '#2f9e5f', '143,232,176'],
    },
  },
  {
    // A star with two moons going round it, both ramps crossing over the
    // top, and the black hole in the middle where center shots go.
    id: 'horizon', name: 'Event Horizon', need: 500_000,
    ramps: [RAMP_L, RAMP_R],
    bumpers: [[0.46, 0.56, 0.06]],
    moons: [
      { cx: 0.46, cy: 0.56, orbit: 0.14, r: 0.04, w: 1.5, a0: 0 },
      { cx: 0.46, cy: 0.56, orbit: 0.14, r: 0.04, w: 1.5, a0: Math.PI },
    ],
    targets: { x: 0.04, face: 1 },
    hole: { x: 0.46, y: 0.95, out: [-0.5, 1.6] },
    missions: [M.lanes, M.moons, M.ramps, M.targets, M.hole],
    stops: GALAXIES,
    theme: {
      floor: ['#080503', '#2b170a'], grid: '255,170,90', wall: '255,170,90', edge: '#ffbf80', ramp: '79,209,232',
      bumper: { side: '#4a2a0a', top: '#2a1606', rim: '#ffb347', cap: '#a85d12', lit: '#fff0c8' },
      lane: ['#ffb347', '#3a2410'], hole: '#ff7a3c', target: ['#7fe0f0', '#2b8fa3', '127,224,240'],
    },
  },
];

// A table's walls, ramp paths and targets, worked out once.
function build(def) {
  const extra = [];
  const ramps = def.ramps.map((r) => {
    const { x0, x1, y0, y1 } = r.box;
    // The back is a peaked roof: a flat one across the slope is a shelf a
    // slow ball comes to rest on (the sim found balls sitting there).
    const mx = (x0 + x1) / 2, peak = y0 - 0.045, o = { h: 0.05, ramp: 1 };
    extra.push(seg(x0, y1, x0, y0, o), seg(x0, y0, mx, peak, o), seg(mx, peak, x1, y0, o), seg(x1, y0, x1, y1, o));
    const path = sampleRamp(r.pts);
    return { box: r.box, path, len: path[path.length - 1][3] };
  });
  const walls = baseWalls(extra);
  const { x } = def.targets;
  const targets = [0, 1, 2, 3].map((i) => seg(x, 0.86 + i * 0.06, x, 0.915 + i * 0.06, { t: 0.01, e: 0.3 }));
  return { ...def, walls, ramps, targetSegs: targets };
}
const BUILT = new Map();
const table = (i) => { if (!BUILT.has(i)) BUILT.set(i, build(TABLES[i])); return BUILT.get(i); };

// ---------- balls ----------
//
// Looks only. `trail` leaves a fading tail (an rgb triple), `glow` a halo,
// `craters` dark spots.
const BALL_STYLES = [
  { id: 'steel', name: 'Steel', need: 0, light: '#ffffff', dark: '#8a90ab' },
  { id: 'moon', name: 'Moon Rock', need: 50_000, light: '#eceef3', dark: '#5f626e', craters: true },
  { id: 'mars', name: 'Red Planet', need: 125_000, light: '#ffc09a', dark: '#9c3518' },
  { id: 'comet', name: 'Comet', need: 300_000, light: '#ffffff', dark: '#4fb6e8', trail: '150,220,255' },
  { id: 'sun', name: 'Sun', need: 700_000, light: '#fffbe0', dark: '#ff8a1f', glow: true, trail: '255,170,60' },
];

// ---------- what's kept on the phone ----------
//
// {points: every game's score added up, ball: the one in use, best: per table}.
// Points start from the best score already on the phone, so games played
// before tables and balls existed still count for something.
const SAVE_KEY = 'fp.pinball.save';
export const pinballSave = {
  load() {
    let d = {};
    try { d = JSON.parse(store.get(SAVE_KEY, '{}')) || {}; } catch { /* start over */ }
    return { points: scores.localBest(ID), ball: 'steel', best: {}, ...d };
  },
  save(d) { store.set(SAVE_KEY, JSON.stringify(d)); },
};
const isOpen = (thing) => pinballSave.load().points >= thing.need;
export const PINBALL_TABLES = TABLES;
export const PINBALL_BALLS = BALL_STYLES;
export { isOpen as pinballOpen };

// What a locked one shows in the menu: "Locked · 200k".
export const lockText = (thing) => `Locked · ${thing.need >= 1e6 ? thing.need / 1e6 + 'M' : thing.need / 1000 + 'k'}`;

// Where (x, y) touches segment s, pushed out: the outward normal, or null.
function touchSeg(b, s, r = R) {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const t = clamp(((b.x - s.ax) * dx + (b.y - s.ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return touchPoint(b, s.ax + t * dx, s.ay + t * dy, r + s.t);
}

function touchPoint(b, px, py, min) {
  let nx = b.x - px, ny = b.y - py;
  const d = Math.hypot(nx, ny);
  if (d >= min || d === 0) return null;
  nx /= d; ny /= d;
  b.x = px + nx * min;
  b.y = py + ny * min;
  return { nx, ny, px, py };
}

// Bounces b off a surface with normal n moving at (sx, sy). Returns how hard
// it hit (speed into the surface), 0 if it was already moving away.
function bounce(b, n, e, sx = 0, sy = 0) {
  const vn = (b.vx - sx) * n.nx + (b.vy - sy) * n.ny;
  if (vn >= 0) return 0;
  b.vx -= (1 + e) * vn * n.nx;
  b.vy -= (1 + e) * vn * n.ny;
  return -vn;
}

export class StarPinball {
  constructor(tableIndex, feedback) {
    this.T = table(tableIndex);
    this.title = this.T.name;
    this.pause = new Pause('Quit game');
    this.feedback = feedback;       // click + buzz, as on the wheel
    this.canvas = null;             // runCanvas's (util.js), with raf
    this.raf = 0;
    this.best = scores.localBest(ID);
    const pick = pinballSave.load().ball;
    this.style = BALL_STYLES.find((s) => s.id === pick && isOpen(s)) || BALL_STYLES[0];
    // Stars on the table and in the sky around it (x, y as fractions).
    this.stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * TH, a: 0.25 + Math.random() * 0.6 }));
    this.sky = Array.from({ length: 60 }, () => ({ x: Math.random(), y: Math.random(), a: 0.15 + Math.random() * 0.5 }));
    this.newGame();
  }

  newGame() {
    this.sent = false;              // this game's score went to the board
    this.banked = false;            // this game's points went on the total
    this.unlocked = [];             // what those points opened, for the Game Over box
    this.result = null;             // what the board said back
    this.score = 0;
    this.left = BALLS;              // balls still to play, counting the one on the plunger
    this.ballNo = 1;
    this.mult = 1;
    this.done = 0;                  // missions finished
    this.progress = 0;
    this.t = 0;
    this.pt = 0;                    // physics time, which the moons go round by
    this.lanes = [false, false, false];
    this.targets = [true, true, true, true];
    this.targetsBack = 0;           // when the dropped bank stands up again
    this.flash = {};                // what lights up for a moment: key -> until
    this.flips = FLIPPERS.map(() => ({ a: FLIP_REST, w: 0, held: false }));
    this.banner = null;             // {text, until}
    this.pulling = false;
    this.pull = 0;
    this.saveUntil = 0;
    this.extraAt = this.T.missions.length;
    this.state = 'play';
    this.balls = [];
    this.newBall();
  }

  newBall() {
    // ramp: distance along ramp ri while riding it (rv its speed), else undefined; z its height
    this.balls.push({ x: LANE_X, y: PLUNGER_Y - R, z: 0, vx: 0, vy: 0, plunger: true, lane: true, fresh: true, held: 0, cool: 0, still: 0, trail: [] });
  }

  get mission() { return this.T.missions[this.done % this.T.missions.length]; }
  get planet() { return this.T.stops[this.done % this.T.stops.length]; }
  need() { return this.mission.need(Math.floor(this.done / this.T.missions.length)); }

  // Where moon i is now, and how fast it's moving.
  moonAt(i) {
    const m = this.T.moons[i], a = m.a0 + m.w * this.pt;
    return { x: m.cx + Math.cos(a) * m.orbit, y: m.cy + Math.sin(a) * m.orbit, vx: -Math.sin(a) * m.orbit * m.w, vy: Math.cos(a) * m.orbit * m.w, r: m.r };
  }

  attach(ui) { this.ui = ui; }

  // Flippers need press and release as they happen (wheel.js raw mode), but
  // the pause menu needs the wheel to turn and click like a list.
  get rawButtons() { return !this.pause.open; }

  leave() {
    // Leaving throws the game away, so a game in progress counts as ended.
    if (this.score > 0) this.finish();
    if (this.state === 'play') this.state = 'paused';
    this.pause.hide();
    this.release();
  }

  // A game ended: its points go on the total (opening whatever they reach)
  // and its score to the board.
  finish() {
    if (!this.banked) {
      this.banked = true;
      const d = pinballSave.load(), before = d.points;
      d.points = before + this.score;
      d.best[this.T.id] = Math.max(d.best[this.T.id] || 0, this.score);
      pinballSave.save(d);
      const opened = (list, kind) => list.filter((x) => x.need > before && x.need <= d.points).map((x) => `New ${kind}: ${x.name}`);
      this.unlocked = [...opened(TABLES, 'table'), ...opened(BALL_STYLES, 'ball'), ...newBodies()];
    }
    scores.gameOver(this, ID);
  }

  release() {
    for (const f of this.flips) f.held = false;
    this.pulling = false;
  }

  // ---------- wheel (raw: down/up as they happen) ----------

  down(button) {
    if (button === 'select') {
      if (this.state === 'over') { this.newGame(); return; }
      if (this.state === 'paused') { this.resume(); return; }
      if (this.balls.some((b) => b.plunger)) { this.pulling = true; this.pull = 0; }
      return;
    }
    const i = button === 'prev' ? 0 : button === 'next' ? 1 : -1;
    if (i < 0 || this.state !== 'play') return;
    this.flips[i].held = true;
    // Lane change: each flip shifts the lit lanes one way round.
    this.lanes = i === 0 ? [...this.lanes.slice(1), this.lanes[0]] : [this.lanes[2], ...this.lanes.slice(0, 2)];
  }

  up(button) {
    if (button === 'select') {
      if (this.pulling && this.state === 'play') this.launch();
      this.pulling = false;
      return;
    }
    const i = button === 'prev' ? 0 : button === 'next' ? 1 : -1;
    if (i >= 0) this.flips[i].held = false;
  }

  play() {
    if (this.state === 'play') this.openPause(); else if (this.state === 'paused') this.resume();
    return true;
  }

  openPause() {
    if (this.state !== 'play') return;
    this.state = 'paused';
    this.release();
    this.pause.show();
  }

  resume() { this.pause.hide(); this.state = 'play'; }

  // MENU (pause.js): Game Over leaves on a tap; mid-game a tap only shows
  // "Hold MENU to pause" (or resumes, paused), and a hold opens the menu.
  back() {
    if (this.state === 'over') return false;
    if (this.state === 'paused') this.resume();
    else this.pause.tap();
    return true;
  }

  holdMenu() {
    if (this.state === 'over') return true;
    if (this.pause.hold()) this.openPause();
    return false;
  }

  // The pause menu, with the wheel out of raw mode.
  turn(dir) { return this.pause.open ? this.pause.turn(dir) : false; }

  select() {
    if (!this.pause.open) return;
    if (this.pause.quitting()) this.ui.leaveTop();
    else this.resume();
  }

  // Keep the buttons in the game while paused: unclaimed, ⏮/⏭ would skip
  // the song and a hold would open Now Playing.
  prev() { return true; }
  next() { return true; }
  hold() {}

  launch() {
    const b = this.balls.find((q) => q.plunger);
    if (!b) return;
    b.plunger = false;
    // Drawn pulled back with the plunger, but it's launched from above the
    // lane's floor: from below it, the floor would push it down and out.
    b.y = PLUNGER_Y - R - 0.005;
    b.vy = -(LAUNCH_MIN + (LAUNCH_MAX - LAUNCH_MIN) * this.pull);
    if (b.fresh) { b.fresh = false; this.saveUntil = this.t + SAVE_TIME; }
    this.pull = 0;
  }

  // ---------- rules ----------

  add(points) { this.score += points * this.mult; }

  say(text, secs = 2.2) { this.banner = { text, until: this.t + secs }; }

  advance(id, n = 1) {
    if (this.mission.id !== id) return;
    this.progress += n;
    if (this.progress < this.need()) return;
    const bonus = 5000 * (this.done + 1);
    this.score += bonus;
    this.say(`Reached ${this.planet.name}! +${bonus.toLocaleString()}`, 2.8);
    this.feedback();
    this.done++;
    this.progress = 0;
    if (id === 'hole') this.multiball();
    if (this.done >= this.extraAt) {
      this.extraAt += this.T.missions.length;
      this.left++;
      this.say('Extra ball!', 2.4);
    }
  }

  multiball() {
    this.newBall();
    const b = this.balls[this.balls.length - 1];
    b.fresh = false;
    b.auto = 0.6;                   // fires itself after this long
    this.saveUntil = Math.max(this.saveUntil, this.t + 8);
    this.say('Multiball!', 2.4);
  }

  laneOver(i) {
    if (this.lanes[i]) return;
    this.lanes[i] = true;
    this.add(500);
    if (this.lanes.every(Boolean)) {
      this.lanes = [false, false, false];
      this.add(1000);
      if (this.mult < 5) { this.mult++; this.say(`Multiplier x${this.mult}`); }
      this.advance('lanes');
    }
  }

  rampDone(ri) {
    this.add(2000);
    this.flash['ramp' + ri] = this.t + 0.6;
    this.feedback();
    this.advance('ramp');
  }

  hitTarget(i) {
    this.targets[i] = false;
    this.add(250);
    this.feedback();
    if (this.targets.some(Boolean)) return;
    this.add(1500);
    this.targetsBack = this.t + TARGET_RESET;
    this.advance('targets');
  }

  drained() {
    if (this.balls.length) return;  // multiball: play on with the rest
    this.release();
    if (this.t < this.saveUntil) {
      this.saveUntil = 0;
      this.newBall();
      this.balls[0].fresh = false;
      this.say('Ball saved');
      return;
    }
    this.left--;
    this.mult = 1;
    this.feedback();
    scores.keepBest(this, ID);
    if (this.left <= 0) {
      this.state = 'over';
      this.finish();
      return;
    }
    this.ballNo++;
    this.newBall();
  }

  // ---------- loop ----------

  render(view) { runCanvas(this, view); }

  step(dt) {
    if (this.state !== 'play') return;
    this.t += dt;
    if (this.pulling) this.pull = Math.min(1, this.pull + dt / PULL_TIME);
    if (this.targetsBack && this.t >= this.targetsBack) { this.targets = [true, true, true, true]; this.targetsBack = 0; }
    const n = Math.ceil(dt / H);
    for (let k = 0; k < n; k++) this.physics(dt / n);
    if (this.style.trail) {
      for (const b of this.balls) {
        b.trail.unshift({ x: b.x, y: b.y, z: b.z });
        if (b.trail.length > 9 || b.plunger || b.held > 0) b.trail.length = b.plunger || b.held > 0 ? 0 : 9;
      }
    }
  }

  physics(h) {
    this.pt += h;
    for (const f of this.flips) {
      const target = f.held ? FLIP_UP : FLIP_REST;
      const before = f.a;
      f.a = f.a > target ? Math.max(target, f.a - FLIP_UP_SPEED * h) : Math.min(target, f.a + FLIP_DOWN_SPEED * h);
      f.w = (f.a - before) / h;
    }
    for (const b of this.balls) this.move(b, h);
    this.ballsMeet();
    const before = this.balls.length;
    this.balls = this.balls.filter((b) => b.y < TH + 0.06);
    if (this.balls.length < before) this.drained();
  }

  move(b, h) {
    const T = this.T;
    if (b.plunger) {
      if (b.auto !== undefined) {
        b.auto -= h;
        if (b.auto <= 0) { delete b.auto; b.plunger = false; b.vy = -LAUNCH_MAX; }
      }
      b.x = LANE_X;
      b.y = PLUNGER_Y - R + (this.pulling && !b.auto ? this.pull * PULL : 0);
      return;
    }
    if (b.ramp !== undefined) { this.rideRamp(b, h); return; }
    if (b.held > 0) {
      b.held -= h;
      if (b.held <= 0) { b.vx = T.hole.out[0]; b.vy = T.hole.out[1]; b.cool = 0.5; }
      return;
    }
    b.cool = Math.max(0, b.cool - h);
    const y0 = b.y;
    b.vy += G * h;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > MAX_V) { b.vx *= MAX_V / sp; b.vy *= MAX_V / sp; }
    b.x += b.vx * h;
    b.y += b.vy * h;
    if (b.lane && b.x < 0.9) b.lane = false;

    for (const s of T.walls) {
      const n = touchSeg(b, s);
      if (!n) continue;
      const hit = bounce(b, n, s.e);
      if (s.kick && hit > 0.3) {
        b.vx += n.nx * s.kick; b.vy += n.ny * s.kick;
        this.add(10);
        this.flash['sling' + s.sling] = this.t + 0.12;
        this.feedback();
      }
      if (s.floor && Math.abs(b.vy) < 0.4 && b.x > 0.92) { b.plunger = true; b.vx = b.vy = 0; return; }
    }
    if (!b.lane) { const n = touchSeg(b, GATE); if (n) bounce(b, n, 0.4); }
    this.targets.forEach((up, i) => {
      if (!up) return;
      const s = T.targetSegs[i], n = touchSeg(b, s);
      if (n && bounce(b, n, s.e) > 0.2) this.hitTarget(i);
    });
    T.bumpers.forEach(([x, y, r], i) => {
      const n = touchPoint(b, x, y, R + r);
      if (!n) return;
      bounce(b, n, 0.6);
      const out = b.vx * n.nx + b.vy * n.ny;
      if (out < BUMPER_KICK) { b.vx += n.nx * (BUMPER_KICK - out); b.vy += n.ny * (BUMPER_KICK - out); }
      this.flash['b' + i] = this.t + 0.12;
      this.add(100);
      this.advance('bumpers');
      this.feedback();
    });
    // Moons: bumpers on the move, so the kick is worked out against how fast
    // the moon itself is going.
    T.moons.forEach((_, i) => {
      const m = this.moonAt(i);
      const n = touchPoint(b, m.x, m.y, R + m.r);
      if (!n) return;
      bounce(b, n, 0.6, m.vx, m.vy);
      const out = (b.vx - m.vx) * n.nx + (b.vy - m.vy) * n.ny;
      if (out < MOON_KICK) { b.vx += n.nx * (MOON_KICK - out); b.vy += n.ny * (MOON_KICK - out); }
      this.flash['m' + i] = this.t + 0.15;
      this.add(300);
      this.advance('moon');
      this.feedback();
    });
    this.flipperHits(b);
    // Into a ramp's entrance, going up the table.
    if (b.vy < 0) {
      const ri = T.ramps.findIndex(({ box }) => b.x > box.x0 && b.x < box.x1 && b.y > box.y0 && b.y < box.y1);
      if (ri >= 0) {
        b.ramp = 0;
        b.ri = ri;
        b.rv = Math.hypot(b.vx, b.vy);
        return;
      }
    }
    // Rolling over a top lane.
    if (y0 < LANE_Y && b.y >= LANE_Y) {
      const i = LANES.findIndex((x) => Math.abs(b.x - x) < 0.075);
      if (i >= 0) this.laneOver(i);
    }
    // The black hole holds the ball a moment, then spits it out toward a flipper.
    const { hole } = T;
    if (!b.cool && Math.hypot(b.x - hole.x, b.y - hole.y) < HOLE_R && Math.hypot(b.vx, b.vy) < 3.5) {
      b.x = hole.x; b.y = hole.y; b.vx = b.vy = 0;
      b.held = HOLD;
      this.add(2500);
      this.flash.hole = this.t + HOLD;
      this.feedback();
      this.advance('hole');
    }
    // Resting somewhere it shouldn't (on a post, in a corner): a nudge, like a
    // real machine's ball search. Not while it's cradled on a raised flipper.
    const cradled = FLIPPERS.some((F, i) => this.flips[i].held && Math.hypot(b.x - F.x, b.y - F.y) < FLIP_LEN + 0.05);
    if (Math.hypot(b.vx, b.vy) < 0.08 && !cradled) {
      b.still += h;
      if (b.still > STILL_TIME) { b.vx = (Math.random() - 0.5) * 1.6; b.vy = -1.5; b.still = 0; }
    } else b.still = 0;
  }

  // Along a ramp: slowed while it climbs (the table's slope and the ramp's
  // own), sped up coming down. Off the far end into an inlane, or back out
  // of the entrance if it ran out of speed.
  rideRamp(b, h) {
    const ramp = this.T.ramps[b.ri];
    const p = rampAt(ramp.path, b.ramp);
    b.rv += (G * p.ty - RAMP_LIFT * p.dz - 0.25 * Math.sign(b.rv)) * h;
    b.ramp += b.rv * h;
    if (b.ramp <= 0) {
      delete b.ramp;
      b.x = (ramp.box.x0 + ramp.box.x1) / 2; b.y = ramp.box.y1 + R + 0.01; b.z = 0;
      b.vx = 0; b.vy = Math.max(0.3, -b.rv);
      return;
    }
    if (b.ramp >= ramp.len) {
      const e = rampAt(ramp.path, ramp.len - 1e-6), v = Math.min(b.rv, RAMP_EXIT);
      delete b.ramp;
      b.x = e.x; b.y = e.y; b.z = 0;
      b.vx = e.tx * v; b.vy = e.ty * v;
      this.rampDone(b.ri);
      return;
    }
    const q = rampAt(ramp.path, b.ramp);
    b.x = q.x; b.y = q.y; b.z = q.z;
  }

  flipperHits(b) {
    FLIPPERS.forEach((F, i) => {
      const f = this.flips[i];
      const ang = F.dir === 1 ? f.a : Math.PI - f.a;
      const w = F.dir * f.w;        // the mirrored flipper turns the other way
      const tx = F.x + Math.cos(ang) * FLIP_LEN, ty = F.y + Math.sin(ang) * FLIP_LEN;
      const n = touchSeg(b, { ax: F.x, ay: F.y, bx: tx, by: ty, t: FLIP_R });
      if (!n) return;
      // The flipper's surface moves at w x r where the ball touches it.
      bounce(b, n, FLIP_E, -w * (n.py - F.y), w * (n.px - F.x));
    });
  }

  ballsMeet() {
    const B = this.balls;
    for (let i = 0; i < B.length; i++) {
      for (let j = i + 1; j < B.length; j++) {
        const a = B[i], c = B[j];
        if (a.plunger || c.plunger || a.held > 0 || c.held > 0 || a.ramp !== undefined || c.ramp !== undefined) continue;
        let nx = c.x - a.x, ny = c.y - a.y;
        const d = Math.hypot(nx, ny);
        if (d >= 2 * R || d === 0) continue;
        nx /= d; ny /= d;
        const push = (2 * R - d) / 2;
        a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
        const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
        if (vn < 0) { a.vx += vn * nx; a.vy += vn * ny; c.vx -= vn * nx; c.vy -= vn * ny; }
      }
    }
  }

  // ---------- drawing ----------
  //
  // A fixed camera behind the flippers, looking up the table. A point d
  // units up the table from the near edge shrinks by N / (N + d), which is a
  // true perspective view of a flat table (straight lines stay straight), and
  // the near end is drawn 15% shorter than wide, as seen from above at a
  // slant. Height (z) lifts a point up the screen by its shrunk size.

  draw({ g, w, h, dpr }) {
    const T = this.T, C = T.theme;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#05060d';
    g.fillRect(0, 0, w, h);
    for (const s of this.sky) { g.fillStyle = `rgba(220,226,255,${s.a})`; g.fillRect(s.x * w, s.y * h, 1, 1); }

    const N = 3.2;
    const F = (0.85 * N * TH) / (N + TH);           // the table's screen height per unit of near width
    const Sb = Math.min(w * 0.6, (h * 0.9) / F);     // px per unit across the near edge
    const K = 0.85 * N * Sb;
    const ox = w * 0.025, cx = ox + Sb / 2;
    const yb = (h + F * Sb) / 2 + h * 0.015;
    const k = (y) => N / (N + TH - y);               // how much a point at y is shrunk
    const P = (x, y, z = 0) => { const d = TH - y, s = N / (N + d); return [cx + (x - 0.5) * Sb * s, yb - (K * d) / (N + d) - z * Sb * s * 0.9]; };
    const across = (y) => Sb * k(y);                 // px per unit across, at y
    const along = (y) => K * k(y) * k(y) / N;        // px per unit up the table, at y
    const on = (key) => (this.flash[key] || 0) > this.t;
    const path = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
    const flat = (x, y, r) => { const [px, py] = P(x, y); g.beginPath(); g.ellipse(px, py, r * across(y), r * along(y), 0, 0, TAU); };

    // the table's floor, darker toward the far end
    const outline = [[0, TH], [0, 0.5]];
    for (let i = 0; i <= 28; i++) { const a = Math.PI + (Math.PI * i) / 28; outline.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]); }
    outline.push([1, TH]);
    const floorPts = outline.map(([x, y]) => P(x, y));
    const shade = g.createLinearGradient(0, P(0, 0)[1], 0, yb);
    shade.addColorStop(0, C.floor[0]);
    shade.addColorStop(1, C.floor[1]);
    g.save();
    path(floorPts);
    g.closePath();
    g.fillStyle = shade;
    g.fill();
    g.clip();
    for (const s of this.stars) { const [x, y] = P(s.x, s.y); g.fillStyle = `rgba(220,226,255,${s.a})`; g.fillRect(x, y, 1.1, 1.1); }
    // a faint grid on the floor sells the slant
    g.strokeStyle = `rgba(${C.grid},.07)`;
    g.lineWidth = 1;
    g.beginPath();
    for (let y = 0.2; y < TH; y += 0.2) { g.moveTo(...P(0, y)); g.lineTo(...P(1, y)); }
    for (let x = 0.1; x < 1; x += 0.1) { g.moveTo(...P(x, 0)); g.lineTo(...P(x, TH)); }
    g.stroke();
    // floor markings: lane lights, the moons' orbits, the black hole
    LANES.forEach((x, i) => { flat(x, 0.29, 0.018); g.fillStyle = this.lanes[i] ? C.lane[0] : C.lane[1]; g.fill(); });
    g.strokeStyle = `rgba(${C.grid},.25)`;
    g.setLineDash([3, 4]);
    for (const m of T.moons) { flat(m.cx, m.cy, m.orbit); g.stroke(); }
    g.setLineDash([]);
    const { hole } = T;
    const [hx, hy] = P(hole.x, hole.y), hrx = 0.045 * across(hole.y), hry = 0.045 * along(hole.y);
    const glow = g.createRadialGradient(hx, hy, 0, hx, hy, hrx * 1.6);
    glow.addColorStop(0, '#000');
    glow.addColorStop(0.55, '#000');
    glow.addColorStop(0.7, on('hole') ? '#ffffff' : C.hole);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.beginPath(); g.ellipse(hx, hy, hrx * 1.6, hry * 1.6, 0, 0, TAU); g.fill();
    const spin = this.t * (this.mission.id === 'hole' ? 6 : 1.5);
    g.strokeStyle = 'rgba(255,255,255,.55)';
    for (let j = 0; j < 3; j++) {
      const f = 0.75 + j * 0.2;
      g.beginPath(); g.ellipse(hx, hy, hrx * f, hry * f, 0, spin + j * 2, spin + j * 2 + 1.6); g.stroke();
    }
    g.restore();

    // walls with height, far ones first
    for (const s of this.wallsFarFirst()) {
      const ht = s.h ?? 0.045;
      const a0 = P(s.ax, s.ay), b0 = P(s.bx, s.by), a1 = P(s.ax, s.ay, ht), b1 = P(s.bx, s.by, ht);
      const kick = s.kick !== undefined;
      path([a0, b0, b1, a1]);
      g.closePath();
      g.fillStyle = kick ? 'rgba(255,143,177,.22)' : s.ramp ? `rgba(${C.ramp},.2)` : `rgba(${C.wall},.16)`;
      g.fill();
      g.strokeStyle = kick ? (on('sling' + s.sling) ? '#ffffff' : '#ff8fb1') : s.ramp ? `rgb(${C.ramp})` : C.edge;
      g.lineWidth = kick ? 2 : 1.4;
      g.beginPath(); g.moveTo(...a1); g.lineTo(...b1); g.stroke();
    }
    // drop targets: little blocks (face toward the field, and top) that drop flat
    const face = T.targets.face;
    this.targets.forEach((up, i) => {
      const s = T.targetSegs[i], ht = up ? 0.05 : 0.004, xb = s.ax - 0.012 * face, xf = s.ax + 0.012 * face;
      path([P(xf, s.ay), P(xf, s.by), P(xf, s.by, ht), P(xf, s.ay, ht)]);
      g.closePath();
      g.fillStyle = up ? C.target[1] : `rgba(${C.target[2]},.15)`;
      g.fill();
      path([P(xb, s.ay, ht), P(xf, s.ay, ht), P(xf, s.by, ht), P(xb, s.by, ht)]);
      g.closePath();
      g.fillStyle = up ? C.target[0] : `rgba(${C.target[2]},.2)`;
      g.fill();
    });
    // bumpers (short cylinders, lit on top when hit) and moons (floating
    // balls with a shadow), far ones first
    const things = [
      ...T.bumpers.map(([x, y, r], i) => ({ y, draw: () => this.drawBumper(g, P, across, along, x, y, r, on('b' + i)) })),
      ...T.moons.map((_, i) => { const m = this.moonAt(i); return { y: m.y, draw: () => this.drawMoon(g, P, across, along, m, on('m' + i)) }; }),
    ];
    for (const t of things.sort((a, b) => a.y - b.y)) t.draw();
    // plunger
    const pullNow = this.pulling ? this.pull * PULL : 0;
    g.strokeStyle = '#8c90a6';
    g.lineWidth = 0.035 * across(TH);
    g.beginPath(); g.moveTo(...P(LANE_X, PLUNGER_Y + pullNow, 0.015)); g.lineTo(...P(LANE_X, TH, 0.015)); g.stroke();
    // flippers: a dark side under a white top
    FLIPPERS.forEach((F, i) => {
      const a = F.dir === 1 ? this.flips[i].a : Math.PI - this.flips[i].a;
      const tip = [F.x + Math.cos(a) * FLIP_LEN, F.y + Math.sin(a) * FLIP_LEN];
      g.lineWidth = FLIP_R * 2 * across(F.y);
      g.strokeStyle = '#5b5f7a';
      g.beginPath(); g.moveTo(...P(F.x, F.y)); g.lineTo(...P(tip[0], tip[1])); g.stroke();
      g.strokeStyle = '#f4f6ff';
      g.beginPath(); g.moveTo(...P(F.x, F.y, 0.02)); g.lineTo(...P(tip[0], tip[1], 0.02)); g.stroke();
      g.fillStyle = C.edge;
      g.beginPath(); g.arc(...P(F.x, F.y, 0.02), FLIP_R * across(F.y) * 0.6, 0, TAU); g.fill();
    });
    // balls on the table, then each ramp with the balls riding it, lower
    // ramp first. A ramp is lit while you ride it, and pulses while it's the
    // mission.
    for (const b of this.balls) if (b.ramp === undefined) this.drawBall(g, b, P, across, along);
    const pulse = this.mission.id === 'ramp' ? 0.5 + 0.5 * Math.sin(this.t * 5) : 0;
    T.ramps.forEach((r, ri) => {
      this.drawRamp(g, P, r.path, C.ramp, on('ramp' + ri), pulse);
      for (const b of this.balls) if (b.ramp !== undefined && b.ri === ri) this.drawBall(g, b, P, across, along);
    });

    this.drawPanel(g, ox + Sb + w * 0.03, w - w * 0.025, h);
    if (this.state === 'over') {
      const lines = scores.overLines(this.score, this.best, this.result);
      lines.splice(lines.length - 1, 0, ...this.unlocked);
      scores.drawBox(g, lines, w / 2, h * 0.5, h);
    }
    this.pause.drawHint(g, w, h);
    this.pause.draw(g, w, h);
  }

  // The walls in drawing order, far end of the table first, so a near
  // wall's face covers the ones behind it. Fixed, so worked out once.
  wallsFarFirst() {
    if (!this.wallOrder) this.wallOrder = this.T.walls.slice().sort((a, b) => Math.max(a.ay, a.by) - Math.max(b.ay, b.by));
    const gate = !this.balls.some((b) => b.lane);
    return gate ? [GATE, ...this.wallOrder] : this.wallOrder;
  }

  drawBumper(g, P, across, along, x, y, r, lit) {
    const B = this.T.theme.bumper;
    const rx = r * across(y), ry = r * along(y);
    const [bx, by] = P(x, y), [tx, ty] = P(x, y, 0.05);
    g.fillStyle = B.side;
    g.beginPath(); g.ellipse(bx, by, rx, ry, 0, 0, TAU); g.fill();
    g.fillRect(bx - rx, ty, rx * 2, by - ty);
    g.fillStyle = lit ? B.lit : B.top;
    g.beginPath(); g.ellipse(tx, ty, rx, ry, 0, 0, TAU); g.fill();
    g.strokeStyle = B.rim;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = lit ? B.rim : B.cap;
    g.beginPath(); g.ellipse(tx, ty, rx * 0.42, ry * 0.42, 0, 0, TAU); g.fill();
  }

  drawMoon(g, P, across, along, m, lit) {
    const r = m.r * across(m.y);
    const [sx, sy] = P(m.x + 0.012, m.y + 0.01);
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath(); g.ellipse(sx, sy, r, m.r * along(m.y), 0, 0, TAU); g.fill();
    const [x, y] = P(m.x, m.y, m.r + 0.01);
    const shine = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    shine.addColorStop(0, lit ? '#ffffff' : '#e4e6ee');
    shine.addColorStop(1, lit ? this.T.theme.bumper.rim : '#5d6070');
    g.fillStyle = shine;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.fillStyle = 'rgba(40,42,56,.35)';
    for (const [dx, dy, f] of [[0.3, 0.1, 0.22], [-0.25, 0.35, 0.16], [0.05, -0.4, 0.13]]) {
      g.beginPath(); g.arc(x + dx * r, y + dy * r, r * f, 0, TAU); g.fill();
    }
  }

  drawBall(g, b, P, across, along) {
    if (b.held > 0) return;
    const S = this.style, r = R * across(b.y);
    // a comet's or a sun's tail: where it was the last few frames, fading
    if (S.trail) {
      b.trail.forEach((p, i) => {
        if (!i) return;
        const [tx, ty] = P(p.x, p.y, R + p.z), f = 1 - i / b.trail.length;
        g.fillStyle = `rgba(${S.trail},${0.35 * f})`;
        g.beginPath(); g.arc(tx, ty, R * across(p.y) * (0.4 + 0.6 * f), 0, TAU); g.fill();
      });
    }
    // shadow on the table (or on the ramp under it), further off the higher it is
    const [sx, sy] = P(b.x + 0.012 + b.z * 0.3, b.y + 0.01, b.ramp !== undefined ? b.z : 0);
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath(); g.ellipse(sx, sy, r, R * along(b.y), 0, 0, TAU); g.fill();
    const [bx, by] = P(b.x, b.y, R + b.z);
    if (S.glow) {
      const halo = g.createRadialGradient(bx, by, r * 0.8, bx, by, r * 2.2);
      halo.addColorStop(0, 'rgba(255,190,80,.5)');
      halo.addColorStop(1, 'rgba(255,190,80,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(bx, by, r * 2.2, 0, TAU); g.fill();
    }
    const shine = g.createRadialGradient(bx - r * 0.35, by - r * 0.35, r * 0.1, bx, by, r);
    shine.addColorStop(0, S.light);
    shine.addColorStop(1, S.dark);
    g.fillStyle = shine;
    g.beginPath(); g.arc(bx, by, r, 0, TAU); g.fill();
    if (S.craters) {
      g.fillStyle = 'rgba(40,42,56,.3)';
      for (const [dx, dy, f] of [[0.3, 0.15, 0.24], [-0.3, 0.3, 0.17], [0.05, -0.35, 0.14]]) {
        g.beginPath(); g.arc(bx + dx * r, by + dy * r, r * f, 0, TAU); g.fill();
      }
    }
  }

  // A ramp: a see-through track on posts, with glowing rails.
  drawRamp(g, P, RAMP, rgb, lit, pulse) {
    const side = (sgn) => RAMP.map((p, i) => {
      const q = RAMP[Math.min(RAMP.length - 1, i + 1)], o = RAMP[Math.max(0, i - 1)];
      const dx = q[0] - o[0], dy = q[1] - o[1], d = Math.hypot(dx, dy) || 1;
      return [p[0] - (dy / d) * RAMP_W * sgn, p[1] + (dx / d) * RAMP_W * sgn, p[2]];
    });
    const L = side(1), Rt = side(-1);
    g.strokeStyle = `rgba(${rgb},.35)`;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 6; i < RAMP.length - 4; i += 9) for (const e of [L[i], Rt[i]]) { g.moveTo(...P(e[0], e[1], e[2])); g.lineTo(...P(e[0], e[1], 0)); }
    g.stroke();
    g.beginPath();
    L.forEach((e, i) => (i ? g.lineTo(...P(...e)) : g.moveTo(...P(...e))));
    for (let i = Rt.length - 1; i >= 0; i--) g.lineTo(...P(...Rt[i]));
    g.closePath();
    g.fillStyle = lit ? `rgba(${rgb},.32)` : `rgba(${rgb},${0.12 + pulse * 0.14})`;
    g.fill();
    g.strokeStyle = lit ? '#ffffff' : `rgb(${rgb})`;
    g.lineWidth = 1.5;
    for (const rail of [L, Rt]) {
      g.beginPath();
      rail.forEach((e, i) => (i ? g.lineTo(...P(e[0], e[1], e[2] + 0.012)) : g.moveTo(...P(e[0], e[1], e[2] + 0.012))));
      g.stroke();
    }
  }

  // Score, balls, multiplier, where you're flying and what gets you there.
  drawPanel(g, x0, x1, h) {
    const pw = x1 - x0;
    const line = (text, y, px, color, weight = 700) => {
      g.font = font(px, weight);
      g.fillStyle = color;
      g.fillText(text, x0, y, pw);
    };
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    line('SCORE', h * 0.1, h * 0.045, '#8f88b8');
    line(this.score.toLocaleString(), h * 0.2, h * 0.085, '#f4f6ff');
    line(`Ball ${this.ballNo}`, h * 0.31, h * 0.05, '#e8ecff');
    g.fillStyle = this.T.theme.edge;
    for (let i = 0; i < Math.max(0, this.left - 1); i++) {
      g.beginPath(); g.arc(x0 + pw * 0.5 + i * h * 0.04, h * 0.295, h * 0.013, 0, TAU); g.fill();
    }
    g.textAlign = 'right';
    g.font = font(h * 0.05);
    g.fillStyle = this.mult > 1 ? this.T.theme.lane[0] : '#5b5680';
    g.fillText(`x${this.mult}`, x1, h * 0.31);
    g.textAlign = 'left';
    // where the next mission takes you
    const p = this.planet, pr = h * 0.045, px = x0 + pr, py = h * 0.44;
    if (p.glow) {
      const halo = g.createRadialGradient(px, py, pr * 0.3, px, py, pr * 1.3);
      halo.addColorStop(0, p.color);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(px, py, pr * 1.3, 0, TAU); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(px, py, pr * 0.4, 0, TAU); g.fill();
    } else if (p.galaxy) {
      const disc = g.createRadialGradient(px, py, 0, px, py, pr * 1.4);
      disc.addColorStop(0, '#ffffff');
      disc.addColorStop(0.25, p.color);
      disc.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = disc;
      g.beginPath(); g.ellipse(px, py, pr * 1.4, pr * 0.55, -0.4, 0, TAU); g.fill();
    } else {
      g.fillStyle = p.color;
      g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
    }
    if (p.ring) {
      g.strokeStyle = '#f5e2b0';
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(px, py, pr * 1.7, pr * 0.45, -0.3, 0, TAU); g.stroke();
    }
    g.textBaseline = 'middle';
    g.font = font(h * 0.05);
    g.fillStyle = '#e8ecff';
    g.fillText(`To ${p.name}`, x0 + pr * 2.9, py, pw - pr * 2.9);
    g.textBaseline = 'alphabetic';
    const mission = this.mission, need = this.need();
    line(mission.text, h * 0.58, h * 0.042, '#b9c2e8', 500);
    if (need > 1) line(`${Math.min(this.progress, need)} / ${need}`, h * 0.65, h * 0.042, '#b9c2e8', 500);
    if (this.saveUntil > this.t && this.state === 'play') line(`Ball save ${Math.ceil(this.saveUntil - this.t)}`, h * 0.75, h * 0.042, '#3ddc84');
    if (this.banner && this.banner.until > this.t) line(this.banner.text, h * 0.86, h * 0.05, '#f5c26b');
    else if (this.state === 'play' && this.balls.length === 1 && this.balls[0].plunger && !this.balls[0].auto) {
      line(this.pulling ? 'Let go to launch' : 'Hold center to pull', h * 0.86, h * 0.042, '#8f88b8', 500);
    }
  }
}
