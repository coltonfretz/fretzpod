// Star Pinball: a space pinball table for the click wheel, in Extras with
// Space Sheep and Tiki Golf. It replaced Vortex (2026-11-08): Colton wanted
// a pinball game in the spirit of the old Windows space pinball. Original
// table, rules and art; nothing is copied from that game.
//
// Wheel: previous and next are the left and right flippers. They go up the
// moment the ring is touched and drop when it's let go, both at once with
// two thumbs. That needs the wheel's raw mode (rawButtons below, wheel.js),
// because a normal press only counts when the thumb lifts. Hold center to
// pull the plunger back, let go to launch: the longer the pull, the harder
// the shot. Play/pause pauses, MENU leaves.
//
// The table is drawn in perspective, looking up it from behind the
// flippers: the far end is narrower and the ball gets smaller as it rolls
// away (Colton, 2026-11-08: the flat first version felt too 2D). Walls,
// bumpers and the ramp have height, and the ball has a shadow.
//
// Rules: missions in a loop, and each finished one flies you on to the next
// planet for a bonus. Lighting all three top lanes raises the multiplier
// (the flippers shift the lit lanes along, so you can line up the gap); it
// goes back to x1 when a ball is lost. The black hole mission ends in a
// two-ball multiball, and a full loop of four missions gives an extra ball.
// A ball lost in its first few seconds comes back (ball save).
//
// Game units: the table is 1 wide and 1.8 tall, (0, 0) its top-left corner,
// y down; z is height above the table. The physics is flat (x, y); only the
// ramp and the drawing use z.
import * as scores from './scores.js';
import { canvasFont as font, runCanvas } from './util.js';

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
const HOLE = { x: 0.8, y: 0.95, r: 0.03, hold: 1 };
// The ramp (added 2026-11-08 with the perspective view): its entrance is a
// box on the left. A ball rolling in fast enough climbs above the table, runs
// over the top past the bumpers and drops into the right inlane, onto the
// right flipper; too slow and it rolls back out. Points are x, y, z.
const RAMP_PTS = [[0.17, 0.76, 0], [0.16, 0.56, 0.05], [0.19, 0.4, 0.07], [0.3, 0.34, 0.075], [0.6, 0.34, 0.075],
  [0.78, 0.37, 0.075], [0.86, 0.47, 0.07], [0.87, 0.75, 0.06], [0.87, 1.08, 0.03], [0.87, 1.3, 0]];
const RAMP_BOX = { x0: 0.1, x1: 0.24, y0: 0.7, y1: 0.78 };
const RAMP_LIFT = 6;                // how much harder climbing the ramp is than rolling up the table
const RAMP_EXIT = 3;                // top speed coming off it
const RAMP_W = 0.035;               // half the ramp's width, for drawing
const LANES = [0.3, 0.46, 0.62];    // top lane centers
const LANE_Y = 0.18;                // a ball crossing this line downward rolls over the lane
const TARGET_RESET = 1.5;           // seconds the target bank stays down

const MISSIONS = [
  { id: 'lanes', text: 'Light all three lanes', need: () => 1 },
  { id: 'bumpers', text: 'Hit the bumpers', need: (lap) => 12 + 6 * lap },
  { id: 'ramp', text: 'Ride the ramp', need: (lap) => 2 + lap },
  { id: 'targets', text: 'Knock down the targets', need: () => 1 },
  { id: 'hole', text: 'Shoot the black hole', need: () => 1 },
];
const PLANETS = [
  { name: 'the Moon', color: '#c9ccd6' },
  { name: 'Mars', color: '#e0663f' },
  { name: 'Jupiter', color: '#d9a066' },
  { name: 'Saturn', color: '#e8cf8a', ring: true },
  { name: 'Uranus', color: '#8fd8e8' },
  { name: 'Neptune', color: '#4f7ae8' },
  { name: 'Pluto', color: '#b8a08a' },
];

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- the table ----------

const seg = (ax, ay, bx, by, o = {}) => ({ ax, ay, bx, by, e: 0.45, t: 0.004, ...o });
const mirror = (x) => 0.92 - x;     // left and right halves of the playfield

function buildWalls() {
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
  // The ramp's entrance: open at the bottom, where balls go in.
  const { x0, x1, y0, y1 } = RAMP_BOX;
  w.push(seg(x0, y1, x0, y0, { h: 0.05, ramp: 1 }), seg(x0, y0, x1, y0, { h: 0.05, ramp: 1 }), seg(x1, y0, x1, y1, { h: 0.05, ramp: 1 }));
  // Slingshots: triangles above the flippers; the face toward the middle kicks.
  for (const m of [(x) => x, mirror]) {
    // Kept clear of the guide below by more than a ball, so none wedges under them.
    const A = [m(0.1), 1.24], B = [m(0.1), 1.37], C = [m(0.22), 1.45];
    w.push(seg(...A, ...B), seg(...B, ...C), seg(...A, ...C, { kick: SLING_KICK, sling: m === mirror ? 1 : 0 }));
  }
  return w;
}
const WALLS = buildWalls();

// The ramp as a smooth path (Catmull-Rom through RAMP_PTS), each point
// [x, y, z, distance along it].
function sampleRamp() {
  const P = RAMP_PTS, out = [];
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
const RAMP = sampleRamp();
const RAMP_LEN = RAMP[RAMP.length - 1][3];

// Where distance s along the ramp is: position, height, direction (tx, ty)
// and how steeply it climbs (dz per unit along).
function rampAt(s) {
  let i = 0;
  while (i < RAMP.length - 2 && RAMP[i + 1][3] <= s) i++;
  const a = RAMP[i], b = RAMP[i + 1], len = b[3] - a[3] || 1e-9;
  const f = clamp((s - a[3]) / len, 0, 1);
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f,
    tx: (b[0] - a[0]) / len, ty: (b[1] - a[1]) / len, dz: (b[2] - a[2]) / len };
}
// Closes the plunger lane once a ball has left it, so it can't fall back in.
const GATE = seg(0.92, 0.45, 0.985, 0.4);
const BUMPERS = [[0.32, 0.5], [0.6, 0.5], [0.46, 0.68]];
const FLIPPERS = [{ x: 0.295, y: 1.58, dir: 1 }, { x: mirror(0.295), y: 1.58, dir: -1 }];
const TARGETS = [0, 1, 2, 3].map((i) => seg(0.04, 0.86 + i * 0.06, 0.04, 0.915 + i * 0.06, { t: 0.01, e: 0.3 }));

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
  constructor(feedback) {
    this.title = 'Star Pinball';
    this.rawButtons = true;         // flippers need press and release as they happen (wheel.js)
    this.feedback = feedback;       // click + buzz, as on the wheel
    this.canvas = null;             // runCanvas's (util.js), with raf
    this.raf = 0;
    this.best = scores.localBest(ID);
    // Stars on the table and in the sky around it (x, y as fractions).
    this.stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * TH, a: 0.25 + Math.random() * 0.6 }));
    this.sky = Array.from({ length: 60 }, () => ({ x: Math.random(), y: Math.random(), a: 0.15 + Math.random() * 0.5 }));
    this.newGame();
  }

  newGame() {
    this.sent = false;              // this game's score went to the board
    this.result = null;             // what the board said back
    this.score = 0;
    this.left = BALLS;              // balls still to play, counting the one on the plunger
    this.ballNo = 1;
    this.mult = 1;
    this.done = 0;                  // missions finished
    this.progress = 0;
    this.t = 0;
    this.lanes = [false, false, false];
    this.targets = [true, true, true, true];
    this.targetsBack = 0;           // when the dropped bank stands up again
    this.flash = {};                // what lights up for a moment: key -> until
    this.flips = FLIPPERS.map(() => ({ a: FLIP_REST, w: 0, held: false }));
    this.banner = null;             // {text, until}
    this.pulling = false;
    this.pull = 0;
    this.saveUntil = 0;
    this.extraAt = 4;
    this.state = 'play';
    this.balls = [];
    this.newBall();
  }

  newBall() {
    // ramp: distance along the ramp while riding it (rv its speed), else undefined; z its height
    this.balls.push({ x: LANE_X, y: PLUNGER_Y - R, z: 0, vx: 0, vy: 0, plunger: true, lane: true, fresh: true, held: 0, cool: 0, still: 0 });
  }

  get mission() { return MISSIONS[this.done % MISSIONS.length]; }
  get planet() { return PLANETS[this.done % PLANETS.length]; }
  need() { return this.mission.need(Math.floor(this.done / MISSIONS.length)); }

  attach(ui) { this.ui = ui; }

  leave() {
    // Leaving throws the game away, so a game in progress counts as ended.
    if (this.score > 0) scores.gameOver(this, ID);
    if (this.state === 'play') this.state = 'paused';
    this.release();
  }

  release() {
    for (const f of this.flips) f.held = false;
    this.pulling = false;
  }

  // ---------- wheel (raw: down/up as they happen) ----------

  down(button) {
    if (button === 'select') {
      if (this.state === 'over') { this.newGame(); return; }
      if (this.state === 'paused') { this.state = 'play'; return; }
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
    if (this.state === 'play') { this.state = 'paused'; this.release(); } else if (this.state === 'paused') this.state = 'play';
    return true;
  }

  turn() { return false; }

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
      this.extraAt += MISSIONS.length;
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

  rampDone() {
    this.add(2000);
    this.flash.ramp = this.t + 0.6;
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
      scores.gameOver(this, ID);
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
  }

  physics(h) {
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
      if (b.held <= 0) { b.vx = -1.1; b.vy = 1.65; b.cool = 0.5; }
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

    for (const s of WALLS) {
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
      const n = touchSeg(b, TARGETS[i]);
      if (n && bounce(b, n, TARGETS[i].e) > 0.2) this.hitTarget(i);
    });
    BUMPERS.forEach(([x, y], i) => {
      const n = touchPoint(b, x, y, R + BUMPER_R);
      if (!n) return;
      bounce(b, n, 0.6);
      const out = b.vx * n.nx + b.vy * n.ny;
      if (out < BUMPER_KICK) { b.vx += n.nx * (BUMPER_KICK - out); b.vy += n.ny * (BUMPER_KICK - out); }
      this.flash['b' + i] = this.t + 0.12;
      this.add(100);
      this.advance('bumpers');
      this.feedback();
    });
    this.flipperHits(b);
    // Into the ramp's entrance, going up the table.
    if (b.vy < 0 && b.x > RAMP_BOX.x0 && b.x < RAMP_BOX.x1 && b.y > RAMP_BOX.y0 && b.y < RAMP_BOX.y1) {
      b.ramp = 0;
      b.rv = Math.hypot(b.vx, b.vy);
      return;
    }
    // Rolling over a top lane.
    if (y0 < LANE_Y && b.y >= LANE_Y) {
      const i = LANES.findIndex((x) => Math.abs(b.x - x) < 0.075);
      if (i >= 0) this.laneOver(i);
    }
    // The black hole holds the ball a moment, then spits it out toward the left flipper.
    if (!b.cool && Math.hypot(b.x - HOLE.x, b.y - HOLE.y) < HOLE.r && Math.hypot(b.vx, b.vy) < 3.5) {
      b.x = HOLE.x; b.y = HOLE.y; b.vx = b.vy = 0;
      b.held = HOLE.hold;
      this.add(2500);
      this.flash.hole = this.t + HOLE.hold;
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

  // Along the ramp: slowed while it climbs (the table's slope and the ramp's
  // own), sped up coming down. Off the far end into the right inlane, or
  // back out of the entrance if it ran out of speed.
  rideRamp(b, h) {
    const p = rampAt(b.ramp);
    b.rv += (G * p.ty - RAMP_LIFT * p.dz - 0.25 * Math.sign(b.rv)) * h;
    b.ramp += b.rv * h;
    if (b.ramp <= 0) {
      delete b.ramp;
      b.x = (RAMP_BOX.x0 + RAMP_BOX.x1) / 2; b.y = RAMP_BOX.y1 + R + 0.01; b.z = 0;
      b.vx = 0; b.vy = Math.max(0.3, -b.rv);
      return;
    }
    if (b.ramp >= RAMP_LEN) {
      const e = rampAt(RAMP_LEN - 1e-6), v = Math.min(b.rv, RAMP_EXIT);
      delete b.ramp;
      b.x = e.x; b.y = e.y; b.z = 0;
      b.vx = e.tx * v; b.vy = e.ty * v;
      this.rampDone();
      return;
    }
    const q = rampAt(b.ramp);
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
    shade.addColorStop(0, '#07081a');
    shade.addColorStop(1, '#161a3d');
    g.save();
    path(floorPts);
    g.closePath();
    g.fillStyle = shade;
    g.fill();
    g.clip();
    for (const s of this.stars) { const [x, y] = P(s.x, s.y); g.fillStyle = `rgba(220,226,255,${s.a})`; g.fillRect(x, y, 1.1, 1.1); }
    // a faint grid on the floor sells the slant
    g.strokeStyle = 'rgba(155,123,255,.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (let y = 0.2; y < TH; y += 0.2) { g.moveTo(...P(0, y)); g.lineTo(...P(1, y)); }
    for (let x = 0.1; x < 1; x += 0.1) { g.moveTo(...P(x, 0)); g.lineTo(...P(x, TH)); }
    g.stroke();
    // floor markings: lane lights, the black hole, the plunger lane
    LANES.forEach((x, i) => { flat(x, 0.29, 0.018); g.fillStyle = this.lanes[i] ? '#4fd1e8' : '#262b52'; g.fill(); });
    const [hx, hy] = P(HOLE.x, HOLE.y), hrx = 0.045 * across(HOLE.y), hry = 0.045 * along(HOLE.y);
    const glow = g.createRadialGradient(hx, hy, 0, hx, hy, hrx * 1.6);
    glow.addColorStop(0, '#000');
    glow.addColorStop(0.55, '#000');
    glow.addColorStop(0.7, on('hole') ? '#ffffff' : '#7b5cff');
    glow.addColorStop(1, 'rgba(155,123,255,0)');
    g.fillStyle = glow;
    g.beginPath(); g.ellipse(hx, hy, hrx * 1.6, hry * 1.6, 0, 0, TAU); g.fill();
    const spin = this.t * (this.mission.id === 'hole' ? 6 : 1.5);
    g.strokeStyle = 'rgba(190,170,255,.7)';
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
      g.fillStyle = kick ? 'rgba(255,143,177,.22)' : s.ramp ? 'rgba(79,209,232,.2)' : 'rgba(155,123,255,.16)';
      g.fill();
      g.strokeStyle = kick ? (on('sling' + s.sling) ? '#ffffff' : '#ff8fb1') : s.ramp ? '#4fd1e8' : '#b9a6ff';
      g.lineWidth = kick ? 2 : 1.4;
      g.beginPath(); g.moveTo(...a1); g.lineTo(...b1); g.stroke();
    }
    // drop targets: little blocks (face toward the field, and top) that drop flat
    this.targets.forEach((up, i) => {
      const s = TARGETS[i], ht = up ? 0.05 : 0.004, x0 = s.ax - 0.012, x1 = s.ax + 0.012;
      path([P(x1, s.ay), P(x1, s.by), P(x1, s.by, ht), P(x1, s.ay, ht)]);
      g.closePath();
      g.fillStyle = up ? '#c98f2e' : 'rgba(245,194,107,.15)';
      g.fill();
      path([P(x0, s.ay, ht), P(x1, s.ay, ht), P(x1, s.by, ht), P(x0, s.by, ht)]);
      g.closePath();
      g.fillStyle = up ? '#f5c26b' : 'rgba(245,194,107,.2)';
      g.fill();
    });
    // bumpers: short cylinders, lit on top when hit
    for (const [i, [x, y]] of [...BUMPERS.entries()].sort((a, b) => a[1][1] - b[1][1])) {
      const rx = BUMPER_R * across(y), ry = BUMPER_R * along(y);
      const [bx, by] = P(x, y), [tx, ty] = P(x, y, 0.05);
      g.fillStyle = '#123a4a';
      g.beginPath(); g.ellipse(bx, by, rx, ry, 0, 0, TAU); g.fill();
      g.fillRect(bx - rx, ty, rx * 2, by - ty);
      const lit = on('b' + i);
      g.fillStyle = lit ? '#bff4ff' : '#1b2246';
      g.beginPath(); g.ellipse(tx, ty, rx, ry, 0, 0, TAU); g.fill();
      g.strokeStyle = '#4fd1e8';
      g.lineWidth = 1.5;
      g.stroke();
      g.fillStyle = lit ? '#4fd1e8' : '#2e6f86';
      g.beginPath(); g.ellipse(tx, ty, rx * 0.42, ry * 0.42, 0, 0, TAU); g.fill();
    }
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
      g.fillStyle = '#9b7bff';
      g.beginPath(); g.arc(...P(F.x, F.y, 0.02), FLIP_R * across(F.y) * 0.6, 0, TAU); g.fill();
    });
    // balls on the table, then the ramp over them, then balls riding it
    for (const b of this.balls) if (b.ramp === undefined) this.drawBall(g, b, P, across, along);
    // Lit while you ride it, and pulsing while it's the mission.
    const pulse = this.mission.id === 'ramp' ? 0.5 + 0.5 * Math.sin(this.t * 5) : 0;
    this.drawRamp(g, P, on('ramp'), pulse);
    for (const b of this.balls) if (b.ramp !== undefined) this.drawBall(g, b, P, across, along);

    this.drawPanel(g, ox + Sb + w * 0.03, w - w * 0.025, h);
    if (this.state === 'over') scores.drawBox(g, scores.overLines(this.score, this.best, this.result), w / 2, h * 0.5, h);
    else if (this.state === 'paused') scores.drawBox(g, ['Paused'], cx, h * 0.5, h);
  }

  // The walls in drawing order, far end of the table first, so a near
  // wall's face covers the ones behind it. Fixed, so worked out once.
  wallsFarFirst() {
    if (!this.wallOrder) this.wallOrder = WALLS.slice().sort((a, b) => Math.max(a.ay, a.by) - Math.max(b.ay, b.by));
    const gate = !this.balls.some((b) => b.lane);
    return gate ? [GATE, ...this.wallOrder] : this.wallOrder;
  }

  drawBall(g, b, P, across, along) {
    if (b.held > 0) return;
    const r = R * across(b.y);
    // shadow on the table (or on the ramp under it), further off the higher it is
    const [sx, sy] = P(b.x + 0.012 + b.z * 0.3, b.y + 0.01, b.ramp !== undefined ? b.z : 0);
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath(); g.ellipse(sx, sy, r, R * along(b.y), 0, 0, TAU); g.fill();
    const [bx, by] = P(b.x, b.y, R + b.z);
    const shine = g.createRadialGradient(bx - r * 0.35, by - r * 0.35, r * 0.1, bx, by, r);
    shine.addColorStop(0, '#ffffff');
    shine.addColorStop(1, '#8a90ab');
    g.fillStyle = shine;
    g.beginPath(); g.arc(bx, by, r, 0, TAU); g.fill();
  }

  // The ramp: a see-through track on posts, with glowing rails.
  drawRamp(g, P, lit, pulse) {
    const side = (sgn) => RAMP.map((p, i) => {
      const q = RAMP[Math.min(RAMP.length - 1, i + 1)], o = RAMP[Math.max(0, i - 1)];
      const dx = q[0] - o[0], dy = q[1] - o[1], d = Math.hypot(dx, dy) || 1;
      return [p[0] - (dy / d) * RAMP_W * sgn, p[1] + (dx / d) * RAMP_W * sgn, p[2]];
    });
    const L = side(1), Rt = side(-1);
    g.strokeStyle = 'rgba(79,209,232,.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 6; i < RAMP.length - 4; i += 9) for (const e of [L[i], Rt[i]]) { g.moveTo(...P(e[0], e[1], e[2])); g.lineTo(...P(e[0], e[1], 0)); }
    g.stroke();
    g.beginPath();
    L.forEach((e, i) => (i ? g.lineTo(...P(...e)) : g.moveTo(...P(...e))));
    for (let i = Rt.length - 1; i >= 0; i--) g.lineTo(...P(...Rt[i]));
    g.closePath();
    g.fillStyle = lit ? 'rgba(79,209,232,.32)' : `rgba(79,209,232,${0.12 + pulse * 0.14})`;
    g.fill();
    g.strokeStyle = lit ? '#ffffff' : '#4fd1e8';
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
    g.fillStyle = '#9b7bff';
    for (let i = 0; i < Math.max(0, this.left - 1); i++) {
      g.beginPath(); g.arc(x0 + pw * 0.5 + i * h * 0.04, h * 0.295, h * 0.013, 0, TAU); g.fill();
    }
    g.textAlign = 'right';
    g.font = font(h * 0.05);
    g.fillStyle = this.mult > 1 ? '#4fd1e8' : '#5b5680';
    g.fillText(`x${this.mult}`, x1, h * 0.31);
    g.textAlign = 'left';
    // destination planet
    const p = this.planet, pr = h * 0.045, py = h * 0.44;
    g.fillStyle = p.color;
    g.beginPath(); g.arc(x0 + pr, py, pr, 0, TAU); g.fill();
    if (p.ring) {
      g.strokeStyle = '#f5e2b0';
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(x0 + pr, py, pr * 1.7, pr * 0.45, -0.3, 0, TAU); g.stroke();
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
