// Vortex: Brick in a circle, after the one on the classic iPods. The paddle rides the outer ring and the wheel steers it; the
// paddle eases toward where the wheel points instead of jumping a step per
// tick, which is what makes it feel smoother than Brick. Bricks sit in
// rings in the middle that turn, alternate rings the other way. Some
// bricks drop a power-up that drifts outward; catch it with the paddle.
// Center button launches and pauses, MENU leaves. Original code and art.
//
// Game units: the arena is a circle of radius 1 around (0, 0); angles in
// radians, 0 pointing right, growing clockwise (screen y is down).
import * as scores from './scores.js';
import { canvasFont as font, runCanvas } from './util.js';

const LIVES = 3;
const PAD_R = 0.94;                 // the paddle's radius (its inner face)
const PAD_T = 0.035;                // paddle thickness
const BALL_R = 0.025;
const PAD_HALF = 0.32;              // half the paddle's arc, normal size
const STEP = Math.PI / 18;          // one wheel tick moves the target 10 degrees
const EASE = 20;                    // how fast the paddle catches up (per second)
const RING_COLORS = ['#ff4d6d', '#ffb703', '#3ddc84', '#38bdf8', '#a78bfa'];
const DROP_CHANCE = 0.16;
const DROP_SPEED = 0.35;
// Power-ups. "Shrink" is the bad one; catching it is a choice.
const POWERS = [
  { id: 'wide', label: 'W', color: '#38bdf8', weight: 3 },
  { id: 'multi', label: 'M', color: '#a78bfa', weight: 3 },
  { id: 'slow', label: 'S', color: '#3ddc84', weight: 2 },
  { id: 'fire', label: 'F', color: '#ff7b00', weight: 2 },
  { id: 'life', label: '+', color: '#ff4d6d', weight: 1 },
  { id: 'shrink', label: '-', color: '#9aa0a6', weight: 2 },
];
const LASTS = { wide: 15, slow: 12, fire: 8, shrink: 10 };   // seconds

const TAU = Math.PI * 2;
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;

export class Vortex {
  constructor(feedback) {
    this.title = 'Vortex';
    this.feedback = feedback;       // click + buzz, as on the wheel
    this.canvas = null;             // runCanvas's (util.js), with raf
    this.raf = 0;
    this.best = scores.localBest('vortex');
    this.newGame();
  }

  newGame() {
    this.sent = false;              // this game's score went to the board
    this.result = null;             // what the board said back
    this.score = 0;
    this.lives = LIVES;
    this.level = 1;
    this.pad = -Math.PI / 2;        // paddle angle, starts at the top
    this.aim = this.pad;            // where the wheel wants it
    this.buildLevel();
  }

  // Rings get more numerous, faster and tougher as the levels go.
  buildLevel() {
    const L = this.level;
    const rings = Math.min(2 + L, 5);
    this.rings = [];
    this.bricks = [];
    for (let i = 0; i < rings; i++) {
      const spin = (i % 2 ? -1 : 1) * Math.min(0.5, 0.12 + 0.05 * L) * (1 - i * 0.08);
      this.rings.push({ rot: 0, spin });
      const n = 6 + i * 3;
      const r0 = 0.2 + i * 0.09;
      for (let s = 0; s < n; s++) {
        if (L % 3 === 2 && i === rings - 1 && s % 3 === 0) continue;   // gaps on some levels
        const tough = (L >= 3 && i === rings - 1) || (L >= 5 && s % 2 === 0);
        this.bricks.push({ ring: i, r0, r1: r0 + 0.065, a0: (s / n) * TAU + 0.04, a1: ((s + 1) / n) * TAU - 0.04, hits: tough ? 2 : 1 });
      }
    }
    this.drops = [];
    this.fx = {};
    this.t = 0;
    this.resetBall();
  }

  resetBall() {
    this.balls = [];                // the ball sits on the paddle until launched
    this.state = this.lives > 0 ? 'ready' : 'over';
  }

  attach(ui) { this.ui = ui; }

  leave() {
    // Leaving throws the game away, so a game in progress counts as ended.
    if (this.score > 0) scores.gameOver(this, 'vortex');
    if (this.state === 'play') this.state = 'paused';
  }

  // ---------- wheel ----------

  turn(dir) {
    if (this.state === 'over' || this.state === 'paused') return false;
    this.aim += dir * STEP;
    return true;
  }

  select() {
    if (this.state === 'over') { this.newGame(); return; }
    if (this.state === 'ready') { this.launch(); return; }
    this.state = this.state === 'play' ? 'paused' : 'play';
  }

  launch() {
    const p = this.restPos();
    const a = this.pad + Math.PI + (Math.random() * 0.6 - 0.3);
    const sp = this.speed();
    this.balls = [{ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp }];
    this.state = 'play';
  }

  // ---------- rules ----------

  speed() {
    const base = Math.min(1.5, 0.9 * (1 + (this.level - 1) * 0.08));
    return this.on('slow') ? base * 0.7 : base;
  }

  on(id) { return (this.fx[id] || 0) > this.t; }

  padHalf() {
    if (this.on('wide')) return PAD_HALF * 1.55;
    if (this.on('shrink')) return PAD_HALF * 0.6;
    return PAD_HALF;
  }

  restPos() {
    const r = PAD_R - BALL_R - 0.005;
    return { x: Math.cos(this.pad) * r, y: Math.sin(this.pad) * r };
  }

  power(id) {
    this.feedback();
    if (id === 'life') { this.lives++; return; }
    if (id === 'multi') {
      const more = [];
      for (const b of this.balls.slice(0, 3)) {
        for (const turn of [-0.45, 0.45]) {
          const c = Math.cos(turn), s = Math.sin(turn);
          more.push({ x: b.x, y: b.y, vx: b.vx * c - b.vy * s, vy: b.vx * s + b.vy * c });
        }
      }
      this.balls.push(...more);
      return;
    }
    // Wide and shrink undo each other.
    if (id === 'wide') this.fx.shrink = 0;
    if (id === 'shrink') this.fx.wide = 0;
    this.fx[id] = this.t + LASTS[id];
    if (id === 'slow') this.setSpeeds();
  }

  setSpeeds() {
    const sp = this.speed();
    for (const b of this.balls) {
      const k = sp / (Math.hypot(b.vx, b.vy) || 1);
      b.vx *= k; b.vy *= k;
    }
  }

  // ---------- loop ----------

  render(view) { runCanvas(this, view); }

  step(dt) {
    if (this.state === 'paused' || this.state === 'over') return;
    // The paddle glides toward the wheel's aim.
    const d = this.aim - this.pad;
    this.pad += d * (1 - Math.exp(-dt * EASE));
    if (Math.abs(d) > TAU * 4) { this.pad = wrap(this.pad); this.aim = this.pad + wrap(d); }
    if (this.state !== 'play') return;
    const slowBefore = this.on('slow');
    this.t += dt;
    for (const ring of this.rings) ring.rot += ring.spin * dt;
    // Small steps so a fast ball can't skip through a thin brick.
    const n = Math.ceil(dt / (1 / 240));
    for (let k = 0; k < n; k++) this.physics(dt / n);
    if (slowBefore && !this.on('slow')) this.setSpeeds();
    this.moveDrops(dt);
    if (!this.balls.length) {
      this.lives--;
      this.feedback();
      scores.keepBest(this, 'vortex');
      this.drops = [];
      this.fx = {};
      this.resetBall();
      if (this.state === 'over') scores.gameOver(this, 'vortex');
      return;
    }
    if (!this.bricks.length) {
      this.level++;
      this.buildLevel();
    }
  }

  physics(h) {
    const half = this.padHalf();
    const fire = this.on('fire');
    for (const b of this.balls) {
      b.x += b.vx * h;
      b.y += b.vy * h;
      const r = Math.hypot(b.x, b.y) || 1e-6;
      const a = Math.atan2(b.y, b.x);
      const ux = b.x / r, uy = b.y / r;
      const vr = b.vx * ux + b.vy * uy;          // outward speed
      // Paddle: the further from its middle, the sharper the return.
      if (vr > 0 && r + BALL_R >= PAD_R && r + BALL_R <= PAD_R + PAD_T + 0.02) {
        const off = wrap(a - this.pad) / (half + BALL_R / r);
        if (Math.abs(off) <= 1) {
          const out = a + Math.PI + off * (Math.PI / 3);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(out) * sp;
          b.vy = Math.sin(out) * sp;
          const back = PAD_R - BALL_R;
          b.x = ux * back; b.y = uy * back;
          this.feedback();
          continue;
        }
      }
      if (r > 1.1) { b.gone = true; continue; }
      this.hitBrick(b, r, a, ux, uy, vr, fire);
    }
    if (this.balls.some((b) => b.gone)) this.balls = this.balls.filter((b) => !b.gone);
  }

  // One brick per step. A brick is a slice of a ring: radius r0..r1, angle
  // a0..a1 plus its ring's turn.
  hitBrick(b, r, a, ux, uy, vr, fire) {
    for (let i = 0; i < this.bricks.length; i++) {
      const k = this.bricks[i];
      if (r < k.r0 - BALL_R || r > k.r1 + BALL_R) continue;
      const rot = this.rings[k.ring].rot;
      const mid = k.a0 + (k.a1 - k.a0) / 2 + rot;
      const span = (k.a1 - k.a0) / 2 + BALL_R / r;
      const da = wrap(a - mid);
      if (Math.abs(da) > span) continue;
      k.hits--;
      this.feedback();
      if (k.hits <= 0 || fire) {
        this.bricks.splice(i, 1);
        this.score += (5 - k.ring) * 10 + (this.level - 1) * 5;
        if (Math.random() < DROP_CHANCE) this.drop(mid, (k.r0 + k.r1) / 2);
        if (fire) return;                      // burns straight through
      }
      // Bounce off whichever face it went in less deeply: the curved
      // inner/outer edge, or a straight side.
      const radialDepth = Math.min(r - (k.r0 - BALL_R), k.r1 + BALL_R - r);
      const sideDepth = (span - Math.abs(da)) * r;
      if (radialDepth <= sideDepth) {
        const wantOut = r > (k.r0 + k.r1) / 2;
        if ((vr > 0) !== wantOut) { b.vx -= 2 * vr * ux; b.vy -= 2 * vr * uy; }
      } else {
        const tx = -uy, ty = ux;               // clockwise tangent
        const vt = b.vx * tx + b.vy * ty;
        if ((vt > 0) !== (da > 0)) { b.vx -= 2 * vt * tx; b.vy -= 2 * vt * ty; }
      }
      return;
    }
  }

  drop(angle, r) {
    let w = Math.random() * POWERS.reduce((s, p) => s + p.weight, 0);
    const p = POWERS.find((q) => (w -= q.weight) < 0) || POWERS[0];
    this.drops.push({ a: angle, r, p });
  }

  moveDrops(dt) {
    const half = this.padHalf();
    for (const d of this.drops) {
      d.r += DROP_SPEED * dt;
      if (d.r >= PAD_R - 0.02 && d.r <= PAD_R + PAD_T && Math.abs(wrap(d.a - this.pad)) <= half + 0.05) {
        d.done = true;
        this.power(d.p.id);
      } else if (d.r > 1.1) d.done = true;
    }
    this.drops = this.drops.filter((d) => !d.done);
  }

  // ---------- drawing ----------

  draw({ g, w, h, dpr }) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#05060d';
    g.fillRect(0, 0, w, h);
    // score line
    g.fillStyle = '#e8ecff';
    g.font = font(h * 0.065);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(`Score ${this.score}`, w * 0.03, h * 0.05);
    g.textAlign = 'right';
    g.fillText(`Lives ${'●'.repeat(Math.max(0, this.lives))}  Level ${this.level}`, w * 0.97, h * 0.05);

    const cx = w / 2;
    const cy = h * 0.55;
    const S = Math.min(w / 2, h * 0.45) * 0.97;
    const X = (x) => cx + x * S;
    const Y = (y) => cy + y * S;
    // the arena edge and a faint swirl
    g.strokeStyle = 'rgba(120,140,255,.18)';
    g.lineWidth = 1;
    for (const rr of [0.35, 0.65, 1]) { g.beginPath(); g.arc(cx, cy, rr * S, 0, TAU); g.stroke(); }
    // bricks
    for (const k of this.bricks) {
      const rot = this.rings[k.ring].rot;
      g.beginPath();
      g.arc(cx, cy, k.r1 * S, k.a0 + rot, k.a1 + rot);
      g.arc(cx, cy, k.r0 * S, k.a1 + rot, k.a0 + rot, true);
      g.closePath();
      g.fillStyle = RING_COLORS[k.ring % RING_COLORS.length];
      g.fill();
      if (k.hits > 1) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
    // power-ups on their way out
    for (const d of this.drops) {
      const x = X(Math.cos(d.a) * d.r), y = Y(Math.sin(d.a) * d.r);
      g.fillStyle = d.p.color;
      g.beginPath(); g.arc(x, y, S * 0.045, 0, TAU); g.fill();
      g.fillStyle = '#05060d';
      g.font = font(S * 0.06);
      g.textAlign = 'center';
      g.fillText(d.p.label, x, y + 0.5);
    }
    // paddle, glowing while a power-up is running
    const half = this.padHalf();
    g.lineCap = 'round';
    g.lineWidth = PAD_T * S;
    g.strokeStyle = this.on('wide') ? '#38bdf8' : this.on('shrink') ? '#9aa0a6' : '#f4f6ff';
    g.shadowColor = g.strokeStyle;
    g.shadowBlur = 10;
    g.beginPath();
    g.arc(cx, cy, (PAD_R + PAD_T / 2) * S, this.pad - half, this.pad + half);
    g.stroke();
    // balls
    const fire = this.on('fire');
    g.fillStyle = fire ? '#ff7b00' : '#ffffff';
    g.shadowColor = g.fillStyle;
    const balls = this.balls.length ? this.balls : [this.restPos()];
    for (const b of balls) { g.beginPath(); g.arc(X(b.x), Y(b.y), BALL_R * S, 0, TAU); g.fill(); }
    g.shadowBlur = 0;
    g.lineCap = 'butt';
    // messages
    if (this.state === 'over') scores.drawBox(g, scores.overLines(this.score, this.best, this.result), cx, cy, h);
    else if (this.state !== 'play') scores.drawBox(g, [this.state === 'ready' ? 'Press the center button to launch' : 'Paused'], cx, cy, h);
  }
}
