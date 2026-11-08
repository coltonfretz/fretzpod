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
// Rules: missions in a loop, and each finished one flies you on to the next
// planet for a bonus. Lighting all three top lanes raises the multiplier
// (the flippers shift the lit lanes along, so you can line up the gap); it
// goes back to x1 when a ball is lost. The black hole mission ends in a
// two-ball multiball, and a full loop of four missions gives an extra ball.
// A ball lost in its first few seconds comes back (ball save).
//
// Game units: the table is 1 wide and 1.8 tall, (0, 0) its top-left corner,
// y down. The screen shows as much of the height as fits at a size you can
// play on a phone, and follows the ball.
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
const LANES = [0.3, 0.46, 0.62];    // top lane centers
const LANE_Y = 0.18;                // a ball crossing this line downward rolls over the lane
const TARGET_RESET = 1.5;           // seconds the target bank stays down

const MISSIONS = [
  { id: 'lanes', text: 'Light all three lanes', need: () => 1 },
  { id: 'bumpers', text: 'Hit the bumpers', need: (lap) => 12 + 6 * lap },
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
  for (const x of [0.22, 0.38, 0.54, 0.7]) w.push(seg(x, 0.12, x, 0.24, { t: 0.008 }));
  // Slingshots: triangles above the flippers; the face toward the middle kicks.
  for (const m of [(x) => x, mirror]) {
    // Kept clear of the guide below by more than a ball, so none wedges under them.
    const A = [m(0.1), 1.24], B = [m(0.1), 1.37], C = [m(0.22), 1.45];
    w.push(seg(...A, ...B), seg(...B, ...C), seg(...A, ...C, { kick: SLING_KICK, sling: m === mirror ? 1 : 0 }));
  }
  return w;
}
const WALLS = buildWalls();
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
    this.cam = TH;                  // top of the view, table units; starts low, on the plunger
    this.viewH = 1.15;              // how much table height the screen showed last frame
    this.stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * TH, a: 0.25 + Math.random() * 0.6 }));
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
    this.balls.push({ x: LANE_X, y: PLUNGER_Y - R, vx: 0, vy: 0, plunger: true, lane: true, fresh: true, held: 0, cool: 0, still: 0 });
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
    this.follow(dt);
  }

  // The view follows the lowest ball, keeping more room below a falling one
  // so the flippers come into sight before it gets there.
  follow(dt) {
    const room = TH + 0.04 - this.viewH;
    if (room <= 0) { this.cam = room / 2; return; }
    const b = this.balls.reduce((p, q) => (!p || q.y > p.y ? q : p), null);
    const want = b ? b.y - this.viewH * (b.vy > 0.3 ? 0.35 : 0.55) : TH;
    this.cam += (clamp(want, -0.02, room) - this.cam) * (1 - Math.exp(-dt * 7));
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
        if (a.plunger || c.plunger || a.held > 0 || c.held > 0) continue;
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

  draw({ g, w, h, dpr }) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#05060d';
    g.fillRect(0, 0, w, h);
    // The table on the left at a size that plays on a phone, the panel right.
    const S = Math.min(h / 1.15, w * 0.58);
    this.viewH = h / S;
    const ox = w * 0.025;
    const X = (x) => ox + x * S;
    const Y = (y) => (y - this.cam) * S;
    const on = (k) => (this.flash[k] || 0) > this.t;

    g.save();
    g.beginPath();
    g.rect(ox, 0, S, h);
    g.clip();
    g.fillStyle = '#0a0b1a';
    g.fillRect(ox, 0, S, h);
    for (const s of this.stars) { g.fillStyle = `rgba(220,226,255,${s.a})`; g.fillRect(X(s.x), Y(s.y), 1.2, 1.2); }

    // walls
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#9b7bff';
    g.lineWidth = Math.max(1.5, S * 0.008);
    g.shadowColor = '#9b7bff';
    g.shadowBlur = 6;
    g.beginPath();
    for (const s of WALLS) { if (s.kick) continue; g.moveTo(X(s.ax), Y(s.ay)); g.lineTo(X(s.bx), Y(s.by)); }
    if (!this.balls.some((b) => b.lane)) { g.moveTo(X(GATE.ax), Y(GATE.ay)); g.lineTo(X(GATE.bx), Y(GATE.by)); }
    g.stroke();
    g.shadowBlur = 0;
    // slingshot faces
    for (const s of WALLS) {
      if (!s.kick) continue;
      g.strokeStyle = on('sling' + s.sling) ? '#ffffff' : '#ff8fb1';
      g.lineWidth = Math.max(2, S * 0.014);
      g.beginPath(); g.moveTo(X(s.ax), Y(s.ay)); g.lineTo(X(s.bx), Y(s.by)); g.stroke();
    }
    // top lane lights
    LANES.forEach((x, i) => {
      g.fillStyle = this.lanes[i] ? '#4fd1e8' : '#262b52';
      g.beginPath(); g.arc(X(x), Y(0.29), S * 0.016, 0, TAU); g.fill();
    });
    // drop targets
    this.targets.forEach((up, i) => {
      const s = TARGETS[i];
      g.strokeStyle = up ? '#f5c26b' : 'rgba(245,194,107,.18)';
      g.lineWidth = Math.max(2, S * 0.02);
      g.lineCap = 'butt';
      g.beginPath(); g.moveTo(X(s.ax), Y(s.ay)); g.lineTo(X(s.bx), Y(s.by)); g.stroke();
    });
    g.lineCap = 'round';
    // the black hole, swirling faster while it's the mission
    const hx = X(HOLE.x), hy = Y(HOLE.y), hr = S * 0.045;
    const glow = g.createRadialGradient(hx, hy, 0, hx, hy, hr * 1.6);
    glow.addColorStop(0, '#000');
    glow.addColorStop(0.55, '#000');
    glow.addColorStop(1, on('hole') ? 'rgba(255,255,255,0)' : 'rgba(155,123,255,0)');
    glow.addColorStop(0.7, on('hole') ? '#ffffff' : '#7b5cff');
    g.fillStyle = glow;
    g.beginPath(); g.arc(hx, hy, hr * 1.6, 0, TAU); g.fill();
    const spin = this.t * (this.mission.id === 'hole' ? 6 : 1.5);
    g.strokeStyle = 'rgba(190,170,255,.7)';
    g.lineWidth = 1;
    for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(hx, hy, hr * (0.75 + k * 0.2), spin + k * 2, spin + k * 2 + 1.6); g.stroke(); }
    // bumpers
    BUMPERS.forEach(([x, y], i) => {
      const lit = on('b' + i);
      g.fillStyle = lit ? '#bff4ff' : '#171b38';
      g.beginPath(); g.arc(X(x), Y(y), BUMPER_R * S, 0, TAU); g.fill();
      g.strokeStyle = '#4fd1e8';
      g.lineWidth = Math.max(1.5, S * 0.012);
      g.stroke();
      g.fillStyle = lit ? '#4fd1e8' : '#2e6f86';
      g.beginPath(); g.arc(X(x), Y(y), BUMPER_R * S * 0.42, 0, TAU); g.fill();
    });
    // plunger
    const pullNow = this.pulling ? this.pull * PULL : 0;
    g.fillStyle = '#8c90a6';
    g.fillRect(X(0.935), Y(PLUNGER_Y + pullNow), S * 0.05, S * 0.012);
    g.strokeStyle = '#5d6178';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 0; k < 5; k++) {
      const y = PLUNGER_Y + pullNow + 0.012 + k * ((TH - PLUNGER_Y - pullNow) / 5);
      g.moveTo(X(0.94), Y(y)); g.lineTo(X(0.98), Y(y + 0.006));
    }
    g.stroke();
    // flippers
    FLIPPERS.forEach((F, i) => {
      const a = F.dir === 1 ? this.flips[i].a : Math.PI - this.flips[i].a;
      g.strokeStyle = '#f4f6ff';
      g.lineWidth = FLIP_R * 2 * S;
      g.beginPath(); g.moveTo(X(F.x), Y(F.y)); g.lineTo(X(F.x + Math.cos(a) * FLIP_LEN), Y(F.y + Math.sin(a) * FLIP_LEN)); g.stroke();
      g.fillStyle = '#9b7bff';
      g.beginPath(); g.arc(X(F.x), Y(F.y), FLIP_R * S * 0.6, 0, TAU); g.fill();
    });
    // balls
    for (const b of this.balls) {
      if (b.held > 0) continue;
      const bx = X(b.x), by = Y(b.y), br = R * S;
      const shine = g.createRadialGradient(bx - br * 0.35, by - br * 0.35, br * 0.1, bx, by, br);
      shine.addColorStop(0, '#ffffff');
      shine.addColorStop(1, '#8a90ab');
      g.fillStyle = shine;
      g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
    }
    g.restore();

    this.drawPanel(g, ox + S + w * 0.03, w - w * 0.025, h);
    const cx = ox + S / 2, cy = h * 0.5;
    if (this.state === 'over') scores.drawBox(g, scores.overLines(this.score, this.best, this.result), w / 2, cy, h);
    else if (this.state === 'paused') scores.drawBox(g, ['Paused'], cx, cy, h);
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
