// Tiki Golf: minigolf for the click wheel, in Extras next to Vortex and Space Sheep.
//
// Inspired by the tiki minigolf in the PS2 game Madagascar (2005). This is an
// original game built around how that one played: an arrow behind the ball that swings as you turn, a power meter
// that rises and falls until you stop it, bamboo borders that keep the ball
// on the course, and gadgets: gates, pool bumpers, tubes, moles, cranes.
// Coins from good holes buy balls and trails in the Shop.
//
// Wheel: turn swings the aim (faster spins swing faster), previous/next nudge
// it a hair, center locks the aim, then center again stops the power meter.
// MENU (or play/pause) pauses; the pause menu can quit the round.
//
// Physics runs in fixed 1/240 s steps in a 400 x 300 world (golf-holes.js),
// and the course is drawn once per hole into an offscreen canvas; each frame
// only draws what moves on top of it.
import { COURSES, coursePar } from './golf-holes.js';
import { store, canvasFont as font, runCanvas } from './util.js';

const W = 400;
const H = 300;
const BALL_R = 3.5;
const WALL_HALF = 3;          // bamboo is 6 units thick, centered on the edge
const CUP_R = 6.5;
const MIN_SPEED = 30;         // units/s at an empty power meter
const MAX_SPEED = 420;        // full meter: rolls about the width of a hole
const STOP_SPEED = 4;
const GREEN = { decel: 120, drag: 0.35 };
const SAND = { decel: 520, drag: 1.5 };
const SINK_SPEED = 170;       // faster than this over the cup and it lips out
const MAX_STROKES = 8;        // then the ball is picked up
const STEP = 1 / 240;
const POWER_PERIOD = 1.4;     // seconds for the meter to go up and back down
const SAVE_KEY = 'fp.golf';
// What a hole's score is called, by strokes against par (3+ under: albatross).
const HOLE_NAMES = { '-3': 'Albatross!', '-2': 'Eagle!', '-1': 'Birdie!', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' };
// The gadget lists a hole may leave out (golf-holes.js); startHole fills in
// the missing ones as empty, so the rest of the game just loops over them.
const GADGETS = ['walls', 'boxes', 'sand', 'water', 'slopes', 'raised', 'bumpers', 'rocks', 'doors',
  'movers', 'tubes', 'moles', 'cranes', 'bridges', 'falls'];

// ---------- coins, shop, best rounds (kept on the phone) ----------

export const SHOP = [
  { id: 'white', kind: 'ball', name: 'White ball', price: 0, color: '#ffffff' },
  { id: 'coconut', kind: 'ball', name: 'Coconut ball', price: 15, color: '#8b5a2b' },
  { id: 'lagoon', kind: 'ball', name: 'Lagoon ball', price: 15, color: '#2ea3e0' },
  { id: 'hibiscus', kind: 'ball', name: 'Hibiscus ball', price: 20, color: '#ff5fa2' },
  { id: 'lava', kind: 'ball', name: 'Lava ball', price: 25, color: '#ff5a1f' },
  { id: 'gold', kind: 'ball', name: 'Gold ball', price: 60, color: '#f2c230' },
  // The far reaches: something to grind for. A round
  // earns somewhere around 20 to 70 coins.
  { id: 'rainbow', kind: 'ball', name: 'Rainbow ball', price: 400, color: null },
  { id: 'none', kind: 'trail', name: 'No trail', price: 0 },
  { id: 'sparkle', kind: 'trail', name: 'Sparkle trail', price: 30 },
  { id: 'flame', kind: 'trail', name: 'Flame trail', price: 45 },
  { id: 'comet', kind: 'trail', name: 'Comet trail', price: 750 },
];

export const golfSave = {
  load() {
    const d = { coins: 0, owned: ['white', 'none'], ball: 'white', trail: 'none', best: {} };
    try { return { ...d, ...JSON.parse(store.get(SAVE_KEY, '{}')) }; } catch { return d; }
  },
  save(d) { store.set(SAVE_KEY, JSON.stringify(d)); },
};

// The first course is always open; each next one opens with a round at par
// or better on the one before.
export function courseOpen(i) {
  if (i === 0) return true;
  const prev = COURSES[i - 1];
  const best = golfSave.load().best[prev.id];
  return !!best && best <= coursePar(prev);
}

// Buys an item, or wears it if it's already owned. False if coins are short.
export function shopPick(item) {
  const d = golfSave.load();
  if (!d.owned.includes(item.id)) {
    if (d.coins < item.price) return false;
    d.coins -= item.price;
    d.owned.push(item.id);
  }
  d[item.kind] = item.id;
  golfSave.save(d);
  return true;
}

// ---------- geometry ----------

function points(flat) {
  const p = [];
  for (let i = 0; i < flat.length; i += 2) p.push([flat[i], flat[i + 1]]);
  return p;
}

function inPoly(x, y, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(x, y, s) {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
  const px = x1 + t * dx, py = y1 + t * dy;
  return { d: Math.hypot(x - px, y - py), px, py };
}

const inRect = (x, y, [rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
const rad = (deg) => (deg * Math.PI) / 180;
const TAU = Math.PI * 2;

// Small seeded random numbers, so a hole's palms grow in the same places.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A gate is closed, swings open, stays open, swings shut, on its own timer.
function doorOpen(d, time) {
  const c = ((time / d.period + (d.phase || 0)) % 1 + 1) % 1;
  if (c < 0.35) return 0;
  if (c < 0.5) return (c - 0.35) / 0.15;
  if (c < 0.85) return 1;
  return 1 - (c - 0.85) / 0.15;
}

function doorSeg(d, time) {
  const f = 1 - doorOpen(d, time);
  const [ax, ay] = d.a, [bx, by] = d.b;
  return [ax, ay, ax + (bx - ax) * f, ay + (by - ay) * f];
}

// ---------- the game ----------

export class Golf {
  constructor(courseIndex, feedback) {
    this.title = 'Tiki Golf';
    this.course = COURSES[courseIndex];
    this.feedback = feedback;           // (press) => click + buzz
    this.save = golfSave.load();
    this.ballColor = (SHOP.find((s) => s.id === this.save.ball) || SHOP[0]).color;
    this.trailKind = this.save.trail;
    this.trailLife = this.trailKind === 'comet' ? 0.9 : 0.45;
    this.scores = [];
    this.coinsEarned = 0;
    this.canvas = null;                 // runCanvas's (util.js), with raf
    this.raf = 0;
    this.time = 0;
    this.aimTicks = [];
    this.pauseSel = 0;
    this.quitting = false;
    this.startHole(0);
  }

  attach(ui) { this.ui = ui; }

  // ---------- holes ----------

  startHole(i) {
    this.holeIdx = i;
    const h = { ...Object.fromEntries(GADGETS.map((k) => [k, []])), ...this.course.holes[i] };
    this.hole = h;
    this.segs = [];
    for (const g of h.greens) {
      const p = points(g);
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        this.segs.push([a[0], a[1], b[0], b[1]]);
      }
    }
    for (const w of h.walls) this.segs.push(w);
    this.bambooCount = this.segs.length;      // crates below get no bamboo
    for (const [x, y, bw, bh] of h.boxes) {
      this.segs.push([x, y, x + bw, y], [x + bw, y, x + bw, y + bh], [x + bw, y + bh, x, y + bh], [x, y + bh, x, y]);
    }
    // The hole's extent (greens), and the patch of world painted around it.
    const xs = h.greens.flatMap((g) => g.filter((_, k) => k % 2 === 0));
    const ys = h.greens.flatMap((g) => g.filter((_, k) => k % 2 === 1));
    this.bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const [bx0, by0, bx1, by1] = this.bounds;
    this.area = [bx0 - 130, by0 - 110, bx1 - bx0 + 260, by1 - by0 + 220];
    this.cam = null;
    this.moleTurn = h.moles.map(() => 0);
    this.bumperFlash = h.bumpers.map(() => 0);
    this.ball = { x: h.tee[0], y: h.tee[1], vx: 0, vy: 0, hidden: false, lift: 0, scale: 1 };
    this.lastPos = [...h.tee];
    this.aim = Math.atan2(h.cup[1] - h.tee[1], h.cup[0] - h.tee[0]);
    this.strokes = 0;
    this.trail = [];
    this.event = null;
    this.layer = null;                  // course picture, redrawn for this hole
    this.decorate(i);
    this.setState('intro');
    this.banner = { title: h.name, sub: `Hole ${i + 1}  ·  Par ${h.par}` };
  }

  setState(s) { this.state = s; this.stateT = 0; }

  // Palms, bushes, torches, tiki statues and huts around the course.
  decorate(i) {
    const r = rng(1000 + i * 7919 + this.course.id.length);
    const h = this.hole;
    const near = (x, y) => Math.min(...this.segs.map((s) => segDist(x, y, s).d));
    this.deco = [];
    const [ax, ay, aw, ah] = this.area;
    for (let gx = ax; gx <= ax + aw; gx += 24) {
      for (let gy = ay; gy <= ay + ah; gy += 24) {
        const x = gx + (r() - 0.5) * 16, y = gy + (r() - 0.5) * 16;
        if (r() > 0.62) continue;
        if (h.greens.some((g) => inPoly(x, y, g))) continue;
        const d = near(x, y);
        if (d < 17) continue;
        const t = r();
        let type;
        if (h.scene === 'sea') type = t < 0.85 ? 'wave' : 'rock';
        else if (h.scene === 'city') type = t < 0.55 && d > 30 ? 'building' : t < 0.8 ? 'bush' : 'lamp';
        else {
          type = t < 0.5 ? 'palm' : t < 0.74 ? 'bush' : t < 0.87 ? 'torch' : t < 0.95 ? 'tiki' : 'hut';
          if (type === 'hut' && d < 32) type = 'palm';
        }
        this.deco.push({ type, x, y, s: 0.8 + r() * 0.5, rot: r() * Math.PI * 2 });
      }
    }
    this.torches = this.deco.filter((d) => d.type === 'torch');   // their flames move
  }

  // ---------- wheel ----------

  turn(dir) {
    if (this.state === 'paused') {
      const before = this.pauseSel;
      this.pauseSel = Math.max(0, Math.min(1, this.pauseSel + dir));
      return this.pauseSel !== before;
    }
    if (this.state !== 'aim') return false;
    // Faster spins swing the arrow further per tick.
    const now = performance.now();
    this.aimTicks = this.aimTicks.filter((t) => now - t < 300);
    this.aimTicks.push(now);
    const n = this.aimTicks.length;
    this.aim += dir * rad(n > 6 ? 6 : n > 3 ? 3 : 1.5);
    return true;
  }

  // Next/previous nudge the aim; always handled here so the music isn't
  // skipped (and, held, doesn't open Now Playing).
  next() { if (this.state === 'aim') this.aim += rad(0.5); return true; }
  prev() { if (this.state === 'aim') this.aim -= rad(0.5); return true; }
  hold() {}
  play() { this.togglePause(); return true; }

  togglePause() {
    if (this.state === 'card') return;
    if (this.state === 'paused') { this.setState(this.resumeTo); this.stateT = this.resumeT; return; }
    this.resumeTo = this.state;
    this.resumeT = this.stateT;
    this.pauseSel = 0;
    this.setState('paused');
  }

  // MENU pauses; MENU again resumes. Quit is in the pause menu.
  back() {
    if (this.quitting || this.state === 'card') return false;
    this.togglePause();
    return true;
  }

  select() {
    switch (this.state) {
      case 'paused':
        if (this.pauseSel === 0) this.togglePause();
        else { this.quitting = true; this.ui.back(); }
        break;
      case 'intro': this.banner = null; this.setState('aim'); break;
      case 'aim': this.setState('power'); break;
      case 'power': this.shoot(); break;
      case 'done':
        if (this.holeIdx + 1 < this.course.holes.length) this.startHole(this.holeIdx + 1);
        else this.finishCourse();
        break;
      case 'card': this.quitting = true; this.ui.back(); break;
      default: break;
    }
  }

  shoot() {
    const p = this.power || 0;
    const speed = MIN_SPEED + p * (MAX_SPEED - MIN_SPEED);
    const b = this.ball;
    this.lastPos = [b.x, b.y];
    b.vx = Math.cos(this.aim) * speed;
    b.vy = Math.sin(this.aim) * speed;
    this.strokes++;
    this.trail = [];
    this.feedback(true);
    this.setState('roll');
  }

  // ---------- simulation ----------

  step(dt) {
    if (this.state === 'paused' || this.state === 'card') return;
    this.time += dt;
    this.stateT += dt;
    this.bumperFlash = this.bumperFlash.map((f) => Math.max(0, f - dt));
    if (this.state === 'power') {
      this.power = 0.5 - 0.5 * Math.cos((this.stateT * 2 * Math.PI) / POWER_PERIOD);
    }
    if ((this.state === 'aim' || this.state === 'power') && this.hole.movers.length) {
      // A bus doesn't stop for a parked ball: it knocks it away.
      for (const m of this.hole.movers) this.bounceMover(m);
      if (Math.hypot(this.ball.vx, this.ball.vy) > STOP_SPEED) this.setState('roll');
    }
    if (this.state === 'roll') {
      let left = dt;
      while (left > 0 && this.state === 'roll') {
        const h = Math.min(STEP, left);
        this.physics(h);
        left -= h;
      }
      const b = this.ball;
      if (this.trailKind !== 'none' && this.state === 'roll') {
        this.trail.push({ x: b.x, y: b.y, t: this.time });
      }
    } else if (this.state === 'event') {
      this.event.t += dt;
      if (this.event.t >= this.event.dur) this.endEvent();
    }
    if (this.trail.length) this.trail = this.trail.filter((p) => this.time - p.t < this.trailLife);
  }

  physics(h) {
    const b = this.ball;
    const hole = this.hole;
    const sandy = hole.sand.some((p) => inPoly(b.x, b.y, p));
    const f = sandy ? SAND : GREEN;
    let s = Math.hypot(b.vx, b.vy);
    if (s > 0) {
      const ns = Math.max(0, s - (f.decel + f.drag * s) * h);
      b.vx *= ns / s;
      b.vy *= ns / s;
      s = ns;
    }
    // Slopes: the ground pulls the ball downhill.
    let gx = 0, gy = 0;
    for (const sl of hole.slopes) {
      if (inPoly(b.x, b.y, sl.poly)) { gx += sl.g[0]; gy += sl.g[1]; }
    }
    b.vx += gx * h;
    b.vy += gy * h;
    s = Math.hypot(b.vx, b.vy);
    b.x += b.vx * h;
    b.y += b.vy * h;

    for (const sg of this.segs) this.bounce(sg, BALL_R + WALL_HALF, 0.7);
    for (const d of hole.doors) this.bounce(doorSeg(d, this.time), BALL_R + WALL_HALF, 0.6);
    hole.bumpers.forEach((bp, k) => {
      // Like a pool cushion with a spring in it: reflects, then shoves.
      // Wooden ones are softer.
      if (this.bounceCircle(bp.x, bp.y, bp.r, 1, bp.wood ? [1, 140] : [1.15, 190])) {
        this.bumperFlash[k] = 0.25;
        this.feedback();
      }
    });
    for (const rk of hole.rocks) this.bounceCircle(rk.x, rk.y, rk.r, 0.55);
    for (const m of hole.movers) this.bounceMover(m);

    if (hole.water.some((p) => inPoly(b.x, b.y, p))) { this.startEvent('splash', 0.9); return; }
    for (const t of hole.tubes) {
      if (Math.hypot(b.x - t.from[0], b.y - t.from[1]) < 7) { this.startEvent('tube', 0.7, { tube: t, speed: s }); return; }
    }
    for (let k = 0; k < hole.moles.length; k++) {
      const m = hole.moles[k];
      if (s < (m.grab || 300) && Math.hypot(b.x - m.x, b.y - m.y) < 7) { this.startEvent('mole', 0.9, { mole: m, k }); return; }
    }

    const [cx, cy] = hole.cup;
    const dc = Math.hypot(b.x - cx, b.y - cy);
    if (dc < CUP_R) {
      if (s < SINK_SPEED) { this.startEvent('sink', 0.35, { from: [b.x, b.y] }); return; }
      if (dc < CUP_R * 0.8 && !(this.lipT > this.time)) {
        // Too fast: catches the lip and skids off a little sideways, slower.
        const side = Math.sign((b.x - cx) * b.vy - (b.y - cy) * b.vx) || 1;
        const a = side * 0.5 * (1 - dc / CUP_R);
        const c = Math.cos(a), sn = Math.sin(a);
        [b.vx, b.vy] = [(b.vx * c - b.vy * sn) * 0.75, (b.vx * sn + b.vy * c) * 0.75];
        this.lipT = this.time + 0.15;
      }
    } else if (dc < CUP_R + 3 && s < SINK_SPEED && s > 0) {
      // The cup's slope pulls a slow ball in.
      b.vx += ((cx - b.x) / dc) * 60 * h;
      b.vy += ((cy - b.y) / dc) * 60 * h;
    }

    // At rest, unless the ground is too steep to hold it.
    if (Math.hypot(b.vx, b.vy) < STOP_SPEED && Math.hypot(gx, gy) <= f.decel * 0.9) {
      b.vx = 0;
      b.vy = 0;
      this.stopped();
    }
  }

  // Round things: e is the bounce; shove [factor, minimum speed] makes it a
  // bumper. True when the ball hit it.
  bounceCircle(x, y, r, e, shove = null) {
    const b = this.ball;
    const dx = b.x - x, dy = b.y - y;
    const dist = Math.hypot(dx, dy);
    const min = r + BALL_R;
    if (dist >= min || dist < 1e-6) return false;
    const nx = dx / dist, ny = dy / dist;
    b.x = x + nx * min;
    b.y = y + ny * min;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return false;
    b.vx -= (1 + e) * vn * nx;
    b.vy -= (1 + e) * vn * ny;
    if (shove) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const out = Math.max(sp * shove[0], shove[1]);
      b.vx = (b.vx / sp) * out;
      b.vy = (b.vy / sp) * out;
    } else if (-vn > 50) this.knock();
    return true;
  }

  // A click + buzz for a hard knock, at most one per 80 ms (a ball pinned
  // against a wall would otherwise buzz every physics step).
  knock() {
    if (this.knockT > this.time) return;
    this.feedback();
    this.knockT = this.time + 0.08;
  }

  // A mover's center and velocity right now (eased back and forth).
  moverAt(m, t = this.time) {
    const ph = 2 * Math.PI * (t / m.period + (m.phase || 0));
    const p = 0.5 - 0.5 * Math.cos(ph);
    const k = (Math.PI / m.period) * Math.sin(ph);
    const [fx, fy] = m.from, [tx, ty] = m.to;
    return { x: fx + (tx - fx) * p, y: fy + (ty - fy) * p, vx: (tx - fx) * k, vy: (ty - fy) * k };
  }

  // A bus knocks the ball with its own speed: bounce in the bus's frame.
  bounceMover(m) {
    const b = this.ball;
    const c = this.moverAt(m);
    const hw = m.w / 2, hh = m.h / 2;
    const qx = Math.max(c.x - hw, Math.min(b.x, c.x + hw));
    const qy = Math.max(c.y - hh, Math.min(b.y, c.y + hh));
    let nx = b.x - qx, ny = b.y - qy;
    let d = Math.hypot(nx, ny);
    if (d >= BALL_R) return;
    if (d < 1e-6) {
      // Center inside the bus: out through the nearest side.
      const ox = hw - Math.abs(b.x - c.x), oy = hh - Math.abs(b.y - c.y);
      if (ox < oy) { nx = Math.sign(b.x - c.x) || 1; ny = 0; b.x = c.x + nx * (hw + BALL_R); }
      else { nx = 0; ny = Math.sign(b.y - c.y) || 1; b.y = c.y + ny * (hh + BALL_R); }
    } else {
      nx /= d; ny /= d;
      b.x = qx + nx * BALL_R;
      b.y = qy + ny * BALL_R;
    }
    const rvx = b.vx - c.vx, rvy = b.vy - c.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      b.vx = rvx - 1.6 * vn * nx + c.vx;
      b.vy = rvy - 1.6 * vn * ny + c.vy;
      this.knock();
    }
  }

  bounce(sg, min, e) {
    const b = this.ball;
    const { d, px, py } = segDist(b.x, b.y, sg);
    if (d >= min || d < 1e-6) return;
    const nx = (b.x - px) / d, ny = (b.y - py) / d;
    b.x = px + nx * min;
    b.y = py + ny * min;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= (1 + e) * vn * nx;
      b.vy -= (1 + e) * vn * ny;
      if (-vn > 50) this.knock();
    }
  }

  stopped() {
    const b = this.ball;
    const crane = this.hole.cranes.find((c) => inRect(b.x, b.y, c.pad));
    if (crane) {
      const [px, py, pw, ph] = crane.pad;
      const [dx, dy, dw, dh] = crane.drop;
      const to = [dx + ((b.x - px) / pw) * dw, dy + ((b.y - py) / ph) * dh];
      this.startEvent('crane', 2.8, { from: [b.x, b.y], to });
      return;
    }
    this.afterStop();
  }

  afterStop() {
    if (this.strokes >= MAX_STROKES) { this.holeDone(true); return; }
    this.setState('aim');
  }

  startEvent(kind, dur, data = {}) {
    this.event = { kind, dur, t: 0, ...data };
    const b = this.ball;
    if (kind === 'tube' || kind === 'mole') b.hidden = true;
    b.vx = 0;
    b.vy = 0;
    if (kind === 'splash') { this.banner = { title: 'Splash!', sub: '+1 stroke' }; this.feedback(true); }
    if (kind === 'crane') this.feedback(true);
    this.setState('event');
  }

  endEvent() {
    const e = this.event;
    const b = this.ball;
    this.event = null;
    switch (e.kind) {
      case 'splash':
        this.strokes++;
        this.banner = null;
        [b.x, b.y] = this.lastPos;
        this.afterStop();
        break;
      case 'tube': {
        const a = rad(e.tube.dir);
        const sp = Math.max(e.speed, 150);
        b.x = e.tube.to[0] + Math.cos(a) * 9;
        b.y = e.tube.to[1] + Math.sin(a) * 9;
        b.vx = Math.cos(a) * sp;
        b.vy = Math.sin(a) * sp;
        b.hidden = false;
        this.setState('roll');
        break;
      }
      case 'mole': {
        const m = e.mole;
        const throws = m.throws;
        const a = rad(throws[this.moleTurn[e.k] % throws.length]);
        this.moleTurn[e.k]++;
        b.x = m.x + Math.cos(a) * 10;
        b.y = m.y + Math.sin(a) * 10;
        const sp = m.speed || 230;
        b.vx = Math.cos(a) * sp;
        b.vy = Math.sin(a) * sp;
        b.hidden = false;
        this.feedback();
        this.setState('roll');
        break;
      }
      case 'crane': {
        [b.x, b.y] = e.to;
        b.lift = 0;
        b.scale = 1;
        const [cx, cy] = this.hole.cup;
        if (Math.hypot(b.x - cx, b.y - cy) < CUP_R) { this.startEvent('sink', 0.35, { from: [b.x, b.y] }); return; }
        this.afterStop();
        break;
      }
      case 'sink':
        b.hidden = true;
        this.holeDone(false);
        break;
      default: break;
    }
  }

  holeDone(pickedUp) {
    const h = this.hole;
    const score = pickedUp ? MAX_STROKES : this.strokes;
    const diff = score - h.par;
    let title;
    if (pickedUp) title = 'Picked up';
    else if (score === 1) title = 'Hole in one!';
    else title = HOLE_NAMES[Math.max(-3, diff)] || `${diff} over par`;
    const coins = pickedUp ? 0 : score === 1 ? 10 : Math.max(0, 3 - diff);
    this.scores[this.holeIdx] = score;
    this.coinsEarned += coins;
    // Coins are banked hole by hole, so quitting a round keeps them.
    const d = golfSave.load();
    d.coins += coins;
    golfSave.save(d);
    this.banner = { title, sub: coins ? `+${coins} coins` : '' };
    this.feedback(true);
    this.setState('done');
  }

  finishCourse() {
    const total = this.scores.reduce((a, b) => a + b, 0);
    const par = coursePar(this.course);
    const ci = COURSES.indexOf(this.course);
    const nextWasOpen = ci + 1 < COURSES.length && courseOpen(ci + 1);
    const d = golfSave.load();
    this.bonus = total < par ? 10 : 0;
    d.coins += this.bonus;
    this.coinsEarned += this.bonus;
    const prev = d.best[this.course.id];
    this.newBest = !prev || total < prev;
    if (this.newBest) d.best[this.course.id] = total;
    golfSave.save(d);
    this.total = total;
    this.par = par;
    this.best = d.best[this.course.id];
    this.coinsNow = d.coins;
    this.unlocked = ci + 1 < COURSES.length && !nextWasOpen && courseOpen(ci + 1) ? COURSES[ci + 1].name : null;
    this.banner = null;
    this.setState('card');
  }

  // ---------- screen ----------

  render(view) { runCanvas(this, view); }

  // A camera, like the original: the whole hole at the start and end of
  // each hole, otherwise zoomed in on the ball (leaning toward where the
  // arrow points while aiming). On a phone the full hole is too small to
  // putt by; the zoomed view keeps the ball a few millimetres across.
  draw({ g, w, h, dpr }) {
    if (this.state === 'card') { this.drawCard(g, w, h, dpr); return; }
    const hud = h * 0.11;
    const vw = w, vh = h - hud;
    const [x0, y0, x1, y1] = this.bounds;
    const m = 18;
    const full = Math.min(vw / (x1 - x0 + 2 * m), vh / (y1 - y0 + 2 * m));
    const close = Math.max(full, vw / 230);
    // The course picture is repainted only when the zoom it needs changes.
    const res = Math.min(4, close * dpr);
    if (!this.layer || this.layerRes !== res) { this.layer = this.paintCourse(res); this.layerRes = res; }
    this.moveCamera(full, close, vw, vh, m);
    const { x, y, sc } = this.cam;
    const S = sc * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#21522a';
    g.fillRect(0, 0, w, h);
    g.setTransform(S, 0, 0, S, (vw / 2) * dpr - x * S, (hud + vh / 2) * dpr - y * S);
    const [ax, ay, aw, ah] = this.area;
    g.drawImage(this.layer, ax, ay, aw, ah);
    this.drawMoving(g);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawHud(g, w, h, hud);
  }

  // Where the action is: the ball, or the crane carrying it, or a tube's far end.
  focus() {
    const e = this.event;
    if (e?.kind === 'crane') { const c = this.crane(e); return [c.x, c.y]; }
    if (e?.kind === 'tube') return e.tube.to;
    return [this.ball.x, this.ball.y];
  }

  moveCamera(full, close, vw, vh, m) {
    const [x0, y0, x1, y1] = this.bounds;
    let tx, ty, ts;
    if (this.state === 'intro' || this.state === 'done') {
      tx = (x0 + x1) / 2; ty = (y0 + y1) / 2; ts = full;
    } else if (this.state === 'paused' && this.cam) {
      return;
    } else {
      [tx, ty] = this.focus();
      if (this.state === 'aim' || this.state === 'power') {
        tx += Math.cos(this.aim) * 40;
        ty += Math.sin(this.aim) * 40;
      }
      ts = close;
      // Keep the view on the course instead of wandering into the jungle.
      const fit = (c, lo, hi, half) => (hi - lo <= 2 * half ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, c)));
      tx = fit(tx, x0 - m, x1 + m, vw / 2 / ts);
      ty = fit(ty, y0 - m, y1 + m, vh / 2 / ts);
    }
    const now = performance.now();
    if (!this.cam) { this.cam = { x: tx, y: ty, sc: ts }; this.camAt = now; return; }
    const k = 1 - Math.exp(-Math.min(0.1, (now - this.camAt) / 1000) * 5);
    this.camAt = now;
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.sc += (ts - this.cam.sc) * k;
  }

  // Everything that stays still, painted once per hole into a picture of the
  // hole's patch of world, sharp enough for the zoomed-in camera (res pixels
  // per world unit, capped so the picture stays within 4096 px).
  paintCourse(want) {
    const [ax, ay, aw, ah] = this.area;
    const res = Math.min(want, 4096 / aw, 4096 / ah);
    const c = document.createElement('canvas');
    c.width = Math.round(aw * res);
    c.height = Math.round(ah * res);
    const g = c.getContext('2d');
    g.setTransform(res, 0, 0, res, -ax * res, -ay * res);
    const scene = this.hole.scene || 'jungle';
    const [top, bot] = { jungle: ['#24592c', '#1c4a24'], sea: ['#2b86c9', '#1d66a3'], city: ['#5a5e63', '#484b50'] }[scene];
    const bg = g.createLinearGradient(0, ay, 0, ay + ah);
    bg.addColorStop(0, top);
    bg.addColorStop(1, bot);
    g.fillStyle = bg;
    g.fillRect(ax, ay, aw, ah);
    const hole = this.hole;
    const path = (flat) => {
      g.beginPath();
      g.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) g.lineTo(flat[i], flat[i + 1]);
      g.closePath();
    };
    // Around each green: a sandy beach, a sidewalk in the city, a ship's
    // hull or a rocky shore at sea.
    g.lineJoin = 'round';
    hole.greens.forEach((gr, i) => {
      path(gr);
      g.strokeStyle = scene === 'city' ? '#b9b4aa' : scene === 'sea' ? (hole.ship === i ? '#5b3a1e' : '#a89a82') : '#d9c184';
      g.lineWidth = hole.ship === i ? 20 : 26;
      g.stroke();
    });
    for (const d of this.deco) this.paintDeco(g, d);
    hole.greens.forEach((gr, i) => {
      g.save();
      path(gr);
      g.clip();
      const rock = hole.volcano === i;
      const deck = hole.ship === i;
      const street = hole.surface === 'asphalt';
      g.fillStyle = rock ? '#6e5a4c' : deck ? '#b08250' : street ? '#4b4f55' : '#3f9d42';
      g.fillRect(0, 0, W, H);
      if (deck) {
        g.strokeStyle = 'rgba(70,40,15,0.35)';
        g.lineWidth = 0.8;
        for (let y = 0; y < H; y += 7) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      } else if (street) {
        // Lane lines.
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.lineWidth = 1.5;
        g.setLineDash([10, 9]);
        for (const y of [123, 177]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
        g.setLineDash([]);
        g.strokeStyle = 'rgba(242,194,48,0.7)';
        g.beginPath(); g.moveTo(0, 150); g.lineTo(W, 150); g.stroke();
      } else if (!rock) {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        for (let y = -20; y < H; y += 24) g.fillRect(0, y, W, 12);   // mowing stripes
      } else {
        const r = rng(77);
        g.fillStyle = 'rgba(0,0,0,0.15)';
        for (let k = 0; k < 60; k++) { dot(g, r() * W, r() * H, 1 + r() * 2.5); }
        const [cx, cy] = hole.cup;
        const glow = g.createRadialGradient(cx, cy, 2, cx, cy, 30);
        glow.addColorStop(0, 'rgba(255,120,30,0.65)');
        glow.addColorStop(1, 'rgba(255,120,30,0)');
        g.fillStyle = glow;
        g.fillRect(cx - 30, cy - 30, 60, 60);
      }
      g.restore();
    });
    // Raised ground looks lighter; slopes shade darker downhill with faint
    // contour lines across them, so the tilt reads from above.
    for (const rz of hole.raised) {
      path(rz);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fill();
    }
    for (const sl of hole.slopes) {
      const p = points(sl.poly);
      const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length;
      const gl = Math.hypot(...sl.g) || 1;
      const ux = sl.g[0] / gl, uy = sl.g[1] / gl;
      const reach = Math.max(...p.map((q) => Math.abs((q[0] - cx) * ux + (q[1] - cy) * uy))) || 1;
      g.save();
      path(sl.poly);
      g.clip();
      const grad = g.createLinearGradient(cx - ux * reach, cy - uy * reach, cx + ux * reach, cy + uy * reach);
      const k = Math.min(1, gl / 150);
      grad.addColorStop(0, `rgba(255,255,255,${0.16 * k})`);
      grad.addColorStop(1, `rgba(0,0,0,${0.28 * k})`);
      g.fillStyle = grad;
      g.fillRect(cx - reach - 60, cy - reach - 60, reach * 2 + 120, reach * 2 + 120);
      g.strokeStyle = 'rgba(0,0,0,0.13)';
      g.lineWidth = 0.7;
      for (let o = -reach; o <= reach; o += 7) {
        const mx = cx + ux * o, my = cy + uy * o;
        g.beginPath(); g.moveTo(mx - uy * 200, my + ux * 200); g.lineTo(mx + uy * 200, my - ux * 200); g.stroke();
      }
      g.restore();
    }
    const r = rng(this.holeIdx + 5);
    for (const s of hole.sand) {
      path(s);
      g.fillStyle = '#ecd791';
      g.fill();
      g.save();
      g.clip();
      g.fillStyle = 'rgba(160,120,40,0.35)';
      for (let k = 0; k < 80; k++) g.fillRect(s[0] + r() * 80, s[1] + r() * 60, 0.9, 0.9);
      g.restore();
    }
    for (const wv of hole.water) {
      path(wv);
      g.fillStyle = '#2e8fd6';
      g.fill();
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(180,225,255,0.45)';
      g.lineWidth = 1;
      for (let k = 0; k < 18; k++) {
        const x = wv[0] + r() * 90, y = wv[1] + r() * 190;
        g.beginPath();
        g.arc(x, y, 5, Math.PI * 1.1, Math.PI * 1.9);
        g.stroke();
      }
      g.restore();
    }
    for (const [x, y, bw, bh] of hole.bridges) {
      g.fillStyle = '#9b6b3a';
      g.fillRect(x, y, bw, bh);
      g.strokeStyle = 'rgba(60,35,12,0.6)';
      g.lineWidth = 0.8;
      for (let px = x + 4; px < x + bw; px += 4) { g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + bh); g.stroke(); }
      g.fillStyle = '#5c3616';
      g.fillRect(x, y - 1, bw, 1.6);
      g.fillRect(x, y + bh - 0.6, bw, 1.6);
    }
    for (const cr of hole.cranes) {
      const [x, y, cw, ch] = cr.pad;
      g.fillStyle = 'rgba(255,205,40,0.28)';
      g.fillRect(x, y, cw, ch);
      g.lineWidth = 2;
      g.setLineDash([4, 4]);
      g.strokeStyle = '#f2c230';
      g.strokeRect(x, y, cw, ch);
      g.lineDashOffset = 4;
      g.strokeStyle = '#222';
      g.strokeRect(x, y, cw, ch);
      g.lineDashOffset = 0;
      const [dx, dy, dw, dh] = cr.drop;
      g.lineWidth = 1;
      g.setLineDash([3, 5]);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.strokeRect(dx, dy, dw, dh);
      g.setLineDash([]);
    }
    for (const t of hole.tubes) {
      const tunnel = t.look === 'tunnel';
      this.pipeMouth(g, t.from[0], t.from[1], tunnel ? '#c9a24a' : '#8e9aa0');
      this.pipeMouth(g, t.to[0], t.to[1], tunnel ? '#e0c070' : '#c9d3d7');
    }
    for (const m of hole.moles) {
      g.fillStyle = '#7b5531';
      dot(g, m.x, m.y, 9);
      g.fillStyle = '#2b1a0c';
      dot(g, m.x, m.y, 5.5);
    }
    const [cx, cy] = hole.cup;
    g.fillStyle = '#151515';
    dot(g, cx, cy, CUP_R);
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 0.8;
    g.stroke();
    // Bamboo along every edge and wall.
    for (const sg of this.segs.slice(0, this.bambooCount)) this.bamboo(g, sg);
    for (const bx of hole.boxes) this.crate(g, bx);
    for (const rk of hole.rocks) this.paintRock(g, rk);
    return c;
  }

  crate(g, [x, y, bw, bh]) {
    // Drawn as thick as the bamboo is, so the ball stops where it looks like it should.
    const o = WALL_HALF;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x - o + 2, y - o + 2, bw + o * 2, bh + o * 2);
    g.fillStyle = '#b5853f';
    g.fillRect(x - o, y - o, bw + o * 2, bh + o * 2);
    g.strokeStyle = '#6e4a1c';
    g.lineWidth = 1.2;
    g.strokeRect(x - o + 0.6, y - o + 0.6, bw + o * 2 - 1.2, bh + o * 2 - 1.2);
    g.beginPath();
    g.moveTo(x - o, y - o); g.lineTo(x + bw + o, y + bh + o);
    g.moveTo(x + bw + o, y - o); g.lineTo(x - o, y + bh + o);
    g.stroke();
  }

  paintRock(g, rk) {
    const { x, y, r, look } = rk;
    g.fillStyle = 'rgba(0,0,0,0.28)';
    dot(g, x + r * 0.15 + 1.5, y + r * 0.2 + 2, r);
    if (look === 'lighthouse') {
      g.fillStyle = '#f4f4f4';
      dot(g, x, y, r);
      g.strokeStyle = '#d23a32';
      g.lineWidth = r * 0.22;
      g.beginPath(); g.arc(x, y, r * 0.72, 0, TAU); g.stroke();
      g.fillStyle = '#333';
      dot(g, x, y, r * 0.45);
    } else if (look === 'baobab') {
      g.fillStyle = '#9c7a58';
      dot(g, x, y, r);
      g.strokeStyle = 'rgba(70,45,25,0.5)';
      g.lineWidth = 0.8;
      for (const f of [0.75, 0.5, 0.25]) { g.beginPath(); g.arc(x, y, r * f, 0, TAU); g.stroke(); }
      // A sparse crown of leaves around the top of the trunk.
      g.fillStyle = 'rgba(70,140,60,0.85)';
      for (let k = 0; k < 7; k++) {
        const a = (k * Math.PI * 2) / 7 + r;
        dot(g, x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r * 1.05, r * 0.32);
      }
    } else if (look === 'stone') {
      // Tsingy: a jagged limestone pinnacle.
      g.fillStyle = '#9a9ca1';
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k * Math.PI) / 5, rr = k % 2 ? r * 0.7 : r * 1.12;
        g[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.fillStyle = '#c7c9cd';
      dot(g, x - r * 0.2, y - r * 0.2, r * 0.35);
    } else if (look === 'mast') {
      g.fillStyle = '#6b4423';
      dot(g, x, y, r);
      g.fillStyle = '#f2ead8';
      g.fillRect(x - r * 2.4, y - 1.2, r * 4.8, 2.4);    // the furled sail's yard
      g.fillStyle = '#8a5a2b';
      dot(g, x, y, r * 0.5);
    } else {
      g.fillStyle = '#8b8f94';
      dot(g, x, y, r);
      g.fillStyle = '#b4b8bc';
      dot(g, x - r * 0.25, y - r * 0.25, r * 0.4);
    }
  }

  drawBus(g, m) {
    const c = this.moverAt(m);
    const x = c.x - m.w / 2, y = c.y - m.h / 2;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(g, x + 2, y + 3, m.w, m.h, 3);
    g.fill();
    g.fillStyle = '#f2b320';
    roundRect(g, x, y, m.w, m.h, 3);
    g.fill();
    g.fillStyle = '#ffd25a';
    g.fillRect(x + 3, y + 4, m.w - 6, m.h - 8);       // roof
    g.fillStyle = 'rgba(40,50,60,0.75)';
    const front = c.vy > 0 ? y + m.h - 4 : y + 1;      // windshield faces the way it's going
    g.fillRect(x + 2, front, m.w - 4, 3);
    g.fillStyle = '#e8e8e8';
    for (let k = 0; k < 3; k++) g.fillRect(x + m.w / 2 - 3, y + 9 + k * 10, 6, 4);   // roof vents
  }

  pipeMouth(g, x, y, ring) {
    g.fillStyle = ring;
    dot(g, x, y, 8.5);
    g.fillStyle = '#16211f';
    dot(g, x, y, 5.5);
  }

  bamboo(g, [x1, y1, x2, y2]) {
    g.lineCap = 'round';
    g.strokeStyle = '#a8842f';
    g.lineWidth = 6.5;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = '#d2ad52';
    g.lineWidth = 4.5;
    g.stroke();
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / (len || 1), uy = (y2 - y1) / (len || 1);
    g.strokeStyle = 'rgba(255,240,180,0.6)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x1 - uy * 1.2, y1 + ux * 1.2); g.lineTo(x2 - uy * 1.2, y2 + ux * 1.2); g.stroke();
    // Joints every 13 units.
    g.strokeStyle = '#7d5f1f';
    g.lineWidth = 1.2;
    for (let s = 6; s < len - 3; s += 13) {
      const x = x1 + ux * s, y = y1 + uy * s;
      g.beginPath(); g.moveTo(x - uy * 3, y + ux * 3); g.lineTo(x + uy * 3, y - ux * 3); g.stroke();
    }
  }

  paintDeco(g, d) {
    const { x, y, s, rot } = d;
    if (d.type === 'palm') {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath(); g.ellipse(x + 4, y + 5, 15 * s, 11 * s, 0, 0, TAU); g.fill();
      for (let k = 0; k < 7; k++) {
        const a = rot + (k * Math.PI * 2) / 7;
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.fillStyle = k % 2 ? '#2f8a3a' : '#3fae4a';
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(9 * s, -5 * s, 17 * s, 0);
        g.quadraticCurveTo(9 * s, 4 * s, 0, 0);
        g.fill();
        g.restore();
      }
      g.fillStyle = '#7a5230';
      dot(g, x, y, 2.6 * s);
      g.fillStyle = '#5a3a1e';
      for (let k = 0; k < 3; k++) { dot(g, x + Math.cos(rot + k * 2.1) * 3 * s, y + Math.sin(rot + k * 2.1) * 3 * s, 1.4 * s); }
    } else if (d.type === 'bush') {
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.beginPath(); g.ellipse(x + 2, y + 3, 9 * s, 7 * s, 0, 0, TAU); g.fill();
      const cols = ['#2c7a33', '#358f3c', '#2a6e30'];
      for (let k = 0; k < 3; k++) {
        g.fillStyle = cols[k];
        dot(g, x + Math.cos(rot + k * 2.1) * 3.5 * s, y + Math.sin(rot + k * 2.1) * 3.5 * s, 5 * s);
      }
      if (rot > 4) {   // some flower
        g.fillStyle = '#ff6fa8';
        dot(g, x + 2 * s, y - 1 * s, 1.5 * s);
      }
    } else if (d.type === 'torch') {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.ellipse(x + 2, y + 2, 3.5, 2.5, 0, 0, TAU); g.fill();
      g.fillStyle = '#5b3a1d';
      dot(g, x, y, 2.4);
    } else if (d.type === 'tiki') {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x - 4 + 2, y - 6 + 3, 9 * s, 13 * s);
      g.fillStyle = '#8a5a2b';
      g.fillRect(x - 4, y - 6, 9 * s, 13 * s);
      g.fillStyle = '#3a220e';
      g.fillRect(x - 2.5, y - 3, 2 * s, 1.5 * s);
      g.fillRect(x + 1.5, y - 3, 2 * s, 1.5 * s);
      g.fillRect(x - 2, y + 2, 5 * s, 2 * s);
    } else if (d.type === 'wave') {
      g.strokeStyle = 'rgba(200,235,255,0.45)';
      g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, 6 * s, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
      g.beginPath(); g.arc(x + 8 * s, y + 3, 4 * s, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    } else if (d.type === 'rock') {
      g.fillStyle = 'rgba(0,0,0,0.2)';
      dot(g, x + 2, y + 2, 6 * s);
      g.fillStyle = '#7f8388';
      dot(g, x, y, 6 * s);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.beginPath(); g.arc(x, y, 8 * s, 0.3, 1.4); g.stroke();
    } else if (d.type === 'building') {
      const bw = 26 * s, bh = 20 * s + (rot % 1) * 10;
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(x - bw / 2 + 4, y - bh / 2 + 5, bw, bh);
      const roofs = ['#8d6e63', '#7b8794', '#a1887f', '#6d7a86'];
      g.fillStyle = roofs[Math.floor(rot) % roofs.length];
      g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(x - bw / 2, y - bh / 2, bw, 2);
      g.fillStyle = '#5b636b';
      g.fillRect(x - 4 + (rot % 2) * 4, y - 3, 6, 5);  // a rooftop unit
    } else if (d.type === 'lamp') {
      g.fillStyle = '#2f3237';
      dot(g, x, y, 1.8);
      g.fillStyle = 'rgba(255,230,150,0.25)';
      dot(g, x, y, 5);
    } else if (d.type === 'hut') {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      dot(g, x + 4, y + 5, 17 * s);
      g.fillStyle = '#d9b26a';
      dot(g, x, y, 16 * s);
      g.strokeStyle = '#b08a45';
      g.lineWidth = 1;
      for (let k = 0; k < 16; k++) {
        const a = rot + (k * Math.PI) / 8;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 16 * s, y + Math.sin(a) * 16 * s); g.stroke();
      }
      g.fillStyle = '#9a7436';
      dot(g, x, y, 3 * s);
    }
  }

  // Whatever moves, on top of the course picture (world units).
  drawMoving(g) {
    const hole = this.hole;
    const t = this.time;
    // Torch flames flicker.
    for (const d of this.torches) {
      const f = 1 + Math.sin(t * 13 + d.rot * 5) * 0.18;
      g.fillStyle = 'rgba(255,150,40,0.35)';
      dot(g, d.x, d.y - 1, 5 * f);
      g.fillStyle = '#ffb02e';
      dot(g, d.x, d.y - 1, 2.6 * f);
      g.fillStyle = '#fff1a8';
      dot(g, d.x, d.y - 1, 1.2);
    }
    hole.bumpers.forEach((bp, k) => {
      const fl = this.bumperFlash[k] > 0;
      g.fillStyle = 'rgba(0,0,0,0.25)';
      dot(g, bp.x + 1.5, bp.y + 2, bp.r);
      const [outer, inner] = bp.wood ? ['#7a4a21', '#c08a4e'] : ['#c62828', '#f5f5f5'];
      g.fillStyle = fl ? '#ffd0a0' : outer;
      dot(g, bp.x, bp.y, bp.r);
      g.fillStyle = fl ? '#ffffff' : inner;
      dot(g, bp.x, bp.y, bp.r * 0.55);
      g.fillStyle = outer;
      dot(g, bp.x, bp.y, bp.r * 0.2);
    });
    for (const [x, y, fw, fh] of hole.falls) {
      // Water pouring down into the pool.
      g.fillStyle = '#3d9ee0';
      g.fillRect(x, y, fw, fh);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      for (let k = 0; k < 7; k++) {
        const fx = x + 3 + k * (fw - 6) / 6;
        const off = ((t * 60 + k * 23) % fh);
        g.fillRect(fx, y + off, 1.4, 10);
        g.fillRect(fx, y + ((off + fh / 2) % fh), 1.4, 7);
      }
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.ellipse(x + fw / 2, y + fh, fw / 2 + 4, 5, 0, 0, TAU); g.fill();
    }
    for (const rk of hole.rocks) {
      if (rk.look !== 'lighthouse') continue;
      // The beacon's beam sweeping round.
      const a = t * 1.2;
      g.fillStyle = 'rgba(255,240,160,0.18)';
      g.beginPath();
      g.moveTo(rk.x, rk.y);
      g.arc(rk.x, rk.y, 160, a - 0.18, a + 0.18);
      g.closePath();
      g.fill();
      g.fillStyle = '#ffe680';
      dot(g, rk.x, rk.y, rk.r * 0.32);
    }
    for (const m of hole.movers) this.drawBus(g, m);
    for (const d of hole.doors) {
      const [x1, y1, x2, y2] = doorSeg(d, t);
      g.lineCap = 'round';
      g.strokeStyle = '#5c3616';
      g.lineWidth = 6.5;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      g.strokeStyle = '#8f5a2a';
      g.lineWidth = 4;
      g.stroke();
      g.fillStyle = '#3e230c';
      dot(g, d.a[0], d.a[1], 4.5);
    }
    // Mole popping up to throw the ball.
    const e = this.event;
    if (e?.kind === 'mole') {
      const m = e.mole;
      const up = Math.sin(Math.min(1, e.t / e.dur) * Math.PI);
      g.fillStyle = '#6d5a4a';
      dot(g, m.x, m.y - up * 3, 4 + up * 2.5);
      g.fillStyle = '#ffb3c1';
      dot(g, m.x, m.y - up * 3 + 2.5, 1.3);
      g.fillStyle = '#111';
      g.fillRect(m.x - 2.2, m.y - up * 3 - 1.5, 1, 1);
      g.fillRect(m.x + 1.2, m.y - up * 3 - 1.5, 1, 1);
    }
    // Flag, waving.
    const [cx, cy] = hole.cup;
    g.strokeStyle = '#eeeeee';
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + 4, cy - 24); g.stroke();
    const wave = Math.sin(t * 4) * 1.5;
    g.fillStyle = '#e53935';
    g.beginPath();
    g.moveTo(cx + 4, cy - 24);
    g.quadraticCurveTo(cx + 9, cy - 22 + wave, cx + 14, cy - 20);
    g.lineTo(cx + 3.3, cy - 16);
    g.fill();
    if (e?.kind === 'splash') {
      const k = e.t / e.dur;
      g.strokeStyle = `rgba(255,255,255,${1 - k})`;
      g.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(this.ball.x, this.ball.y, 3 + k * 14 + i * 4, 0, TAU); g.stroke(); }
    }
    this.drawTrail(g);
    this.drawBall(g);
    if (this.state === 'aim' || this.state === 'power') this.drawArrow(g);
  }

  drawTrail(g) {
    for (const p of this.trail) {
      const k = 1 - (this.time - p.t) / this.trailLife;
      if (this.trailKind === 'sparkle') {
        g.fillStyle = `rgba(255,250,200,${k})`;
        dot(g, p.x + Math.sin(p.t * 50) * 2, p.y + Math.cos(p.t * 40) * 2, 1 * k + 0.4);
      } else if (this.trailKind === 'flame') {
        g.fillStyle = `rgba(255,${Math.round(90 + 120 * k)},30,${k * 0.8})`;
        dot(g, p.x, p.y, BALL_R * (0.4 + k * 0.7));
      } else if (this.trailKind === 'comet') {
        // A long blue-white tail with a soft glow around it.
        g.fillStyle = `rgba(120,190,255,${k * 0.25})`;
        dot(g, p.x, p.y, BALL_R * (0.6 + k * 1.2));
        g.fillStyle = `rgba(235,245,255,${k * 0.9})`;
        dot(g, p.x, p.y, BALL_R * k * 0.6);
      }
    }
  }

  drawBall(g) {
    const b = this.ball;
    const e = this.event;
    let { x, y } = b;
    let scale = 1;
    let lift = 0;
    if (b.hidden && e?.kind !== 'crane') return;
    if (e?.kind === 'sink') {
      const k = Math.min(1, e.t / e.dur);
      const [cx, cy] = this.hole.cup;
      x = e.from[0] + (cx - e.from[0]) * k;
      y = e.from[1] + (cy - e.from[1]) * k;
      scale = 1 - k * 0.8;
    }
    if (e?.kind === 'crane') {
      const c = this.crane(e);
      x = c.x; y = c.y; lift = c.ballLift;
      if (c.carrying || c.phase < 0.18) scale = 1 + lift * 0.04;
      this.drawClaw(g, c);
    }
    g.fillStyle = 'rgba(0,0,0,0.3)';
    dot(g, x + 1 + lift * 0.6, y + 1.5 + lift * 0.9, BALL_R * scale);
    // The Rainbow ball has no color of its own; it cycles.
    g.fillStyle = this.ballColor || `hsl(${Math.round(this.time * 120) % 360}, 90%, 60%)`;
    dot(g, x, y - lift, BALL_R * scale);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 0.7;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    dot(g, x - 1.1 * scale, y - lift - 1.1 * scale, 0.9 * scale);
  }

  // Where the claw and ball are during the crane ride: the claw comes down,
  // grabs, lifts, carries the ball over, lowers it and lets go.
  crane(e) {
    const k = e.t / e.dur;
    const [fx, fy] = e.from, [tx, ty] = e.to;
    const ease = (u) => u * u * (3 - 2 * u);
    let x = fx, y = fy, clawH = 0, ballLift = 0, carrying = false;
    if (k < 0.18) clawH = 30 * (1 - k / 0.18);                       // coming down
    else if (k < 0.32) { clawH = 0; ballLift = 12 * ((k - 0.18) / 0.14); carrying = true; }
    else if (k < 0.8) {
      const u = ease((k - 0.32) / 0.48);
      x = fx + (tx - fx) * u;
      y = fy + (ty - fy) * u;
      ballLift = 12;
      carrying = true;
    } else if (k < 0.92) { x = tx; y = ty; ballLift = 12 * (1 - (k - 0.8) / 0.12); carrying = true; }
    else { x = tx; y = ty; clawH = 30 * ((k - 0.92) / 0.08); }
    return { x, y, clawH, ballLift, carrying, phase: k };
  }

  drawClaw(g, c) {
    const cy = c.y - c.ballLift - 5 - c.clawH;
    g.strokeStyle = '#333';
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(c.x, -40); g.lineTo(c.x, cy); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    dot(g, c.x + 4, c.y + 4, 6);
    g.strokeStyle = '#8d969b';
    g.lineWidth = 1.6;
    const open = c.carrying ? 2 : 5;
    g.beginPath();
    g.moveTo(c.x, cy); g.lineTo(c.x - open, cy + 6);
    g.moveTo(c.x, cy); g.lineTo(c.x + open, cy + 6);
    g.moveTo(c.x, cy); g.lineTo(c.x, cy + 6.5);
    g.stroke();
    g.fillStyle = '#f2c230';
    g.fillRect(c.x - 3, cy - 3, 6, 3);
  }

  // The arrow sits behind the ball, its tip at the ball, and swings around it.
  drawArrow(g) {
    const b = this.ball;
    const dx = Math.cos(this.aim), dy = Math.sin(this.aim);
    const tipX = b.x - dx * (BALL_R + 2), tipY = b.y - dy * (BALL_R + 2);
    const tailX = b.x - dx * 36, tailY = b.y - dy * 36;
    const neckX = tipX - dx * 7, neckY = tipY - dy * 7;
    const pulse = this.state === 'power' ? 0.75 + 0.25 * Math.sin(this.time * 12) : 1;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 4.2;
    g.beginPath(); g.moveTo(tailX, tailY); g.lineTo(neckX, neckY); g.stroke();
    g.strokeStyle = `rgba(255,210,63,${pulse})`;
    g.lineWidth = 2.6;
    g.stroke();
    g.fillStyle = `rgba(255,210,63,${pulse})`;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(tipX, tipY);
    g.lineTo(neckX - dy * 5, neckY + dx * 5);
    g.lineTo(neckX + dy * 5, neckY - dx * 5);
    g.closePath();
    g.fill();
    g.stroke();
  }

  drawHud(g, w, h, hud) {
    g.fillStyle = 'rgba(16,40,20,0.82)';
    g.fillRect(0, 0, w, hud);
    g.fillStyle = '#ffffff';
    g.font = font(hud * 0.52);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(`Hole ${this.holeIdx + 1}  ·  Par ${this.hole.par}`, w * 0.03, hud / 2);
    g.textAlign = 'right';
    g.fillText(`Strokes ${this.strokes}`, w * 0.97, hud / 2);
    if (this.state === 'power') {
      const x = w * 0.925, bw = w * 0.04, top = hud + h * 0.08, bot = h * 0.93;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x - 2, top - 2, bw + 4, bot - top + 4);
      const grad = g.createLinearGradient(0, bot, 0, top);
      grad.addColorStop(0, '#44d16a');
      grad.addColorStop(0.6, '#ffd23f');
      grad.addColorStop(1, '#ff4b3e');
      g.fillStyle = grad;
      const fill = (bot - top) * this.power;
      g.fillRect(x, bot - fill, bw, fill);
      g.fillStyle = '#ffffff';
      g.fillRect(x - 4, bot - fill - 1, bw + 8, 2);
    }
    if (this.banner) this.drawBanner(g, w, h);
    if (this.state === 'paused') this.drawPause(g, w, h);
  }

  drawBanner(g, w, h) {
    const { title, sub } = this.banner;
    const bh = h * (sub ? 0.24 : 0.16);
    const bw = w * 0.78;
    const x = (w - bw) / 2, y = h * 0.5 - bh / 2;
    g.fillStyle = 'rgba(255,248,230,0.94)';
    roundRect(g, x, y, bw, bh, h * 0.03);
    g.fill();
    g.strokeStyle = '#a8842f';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#3a2a10';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = font(h * 0.085);
    g.fillText(title, w / 2, sub ? y + bh * 0.36 : y + bh / 2);
    if (sub) {
      g.font = font(h * 0.058, 600);
      g.fillStyle = '#6b5124';
      g.fillText(sub, w / 2, y + bh * 0.72);
    }
  }

  drawPause(g, w, h) {
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, w, h);
    const bw = w * 0.6, rh = h * 0.12;
    const x = (w - bw) / 2, y = h * 0.28;
    g.fillStyle = '#ffffff';
    roundRect(g, x, y, bw, rh * 3, h * 0.02);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#222';
    g.font = font(h * 0.065);
    g.fillText('Paused', w / 2, y + rh / 2);
    ['Resume', 'Quit round'].forEach((label, i) => {
      const ry = y + rh * (i + 1);
      if (this.pauseSel === i) {
        const grad = g.createLinearGradient(0, ry, 0, ry + rh);
        grad.addColorStop(0, '#5aa2f0');
        grad.addColorStop(1, '#2a6fd0');
        g.fillStyle = grad;
        g.fillRect(x, ry, bw, rh);
      }
      g.fillStyle = this.pauseSel === i ? '#ffffff' : '#222';
      g.font = font(h * 0.058, 600);
      g.fillText(label, w / 2, ry + rh / 2);
    });
  }

  drawCard(g, w, h, dpr) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1c4a24';
    g.fillRect(0, 0, w, h);
    const pad = w * 0.04;
    g.fillStyle = '#fbf4e2';
    roundRect(g, pad, pad, w - pad * 2, h - pad * 2, h * 0.03);
    g.fill();
    g.fillStyle = '#3a2a10';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = font(h * 0.075);
    g.fillText(`${this.course.name}  ·  Scorecard`, w / 2, h * 0.14);
    const holes = this.course.holes;
    const left = pad * 1.8, right = w - pad * 1.8;
    const colW = (right - left) / (holes.length + 2);
    const rows = [['Hole', ...holes.map((_, i) => String(i + 1)), 'Tot'],
      ['Par', ...holes.map((x) => String(x.par)), String(this.par)],
      ['You', ...this.scores.map(String), String(this.total)]];
    g.font = font(h * 0.05, 600);
    rows.forEach((row, ri) => {
      const y = h * (0.3 + ri * 0.1);
      row.forEach((cell, ci) => {
        const x = ci === 0 ? left + colW * 0.6 : left + colW * (ci + 0.5) + colW * 0.5;
        if (ri === 2 && ci > 0 && ci <= holes.length) {
          const diff = this.scores[ci - 1] - holes[ci - 1].par;
          g.fillStyle = diff < 0 ? '#1f8a3a' : diff > 0 ? '#c0392b' : '#3a2a10';
        } else g.fillStyle = ri === 0 ? '#8a6a2a' : '#3a2a10';
        g.fillText(cell, x, y);
      });
    });
    g.fillStyle = '#3a2a10';
    g.font = font(h * 0.058, 600);
    const diff = this.total - this.par;
    g.fillText(`${diff === 0 ? 'Even par' : diff < 0 ? `${-diff} under par` : `${diff} over par`}${this.newBest ? '  ·  New best!' : `  ·  Best ${this.best}`}`, w / 2, h * 0.67);
    g.fillText(`+${this.coinsEarned} coins${this.bonus ? ' (under par bonus!)' : ''}  ·  ${this.coinsNow} total`, w / 2, h * 0.78);
    if (this.unlocked) {
      g.fillStyle = '#1f8a3a';
      g.font = font(h * 0.062);
      g.fillText(`${this.unlocked} is open!`, w / 2, h * 0.88);
    }
  }
}

// A filled circle.
function dot(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
