// Space Sheep: sheep with jetpacks orbiting a sun, shooting lasers at each
// other (inspired by an arcade minigame in Ratchet & Clank 2; the rules are
// the 1962 game Spacewar!). Replaced Brick
// so Extras stays at three games. Original code and art.
//
// Everything falls toward the sun, lasers included, so you can curve a shot
// around it. The screen wraps at the edges. Touching the sun is a lost life.
//
// Wheel: turning aims the sheep (it swings round smoothly toward where the
// wheel points, like the Vortex paddle). Center fires. Next burns the
// jetpack: a tap is a short push, holding keeps it lit. The wheel only follows
// one thumb on the ring, so you can't steer and burn at the same moment;
// aim, then burn. Previous jumps through hyperspace to a random spot (a
// panic button, with a cooldown). Play/pause pauses, MENU leaves.
//
// Game units: the sun at (0, 0), the screen spans x -WX..WX and y -WY..WY;
// angles in radians, 0 pointing right, growing clockwise (screen y is down).
import * as scores from './scores.js';
import { canvasFont as font, runCanvas } from './util.js';

const WX = 1.4;
const WY = 1;
const GM = 0.25;                    // the sun's pull: a circular orbit at r 0.6 takes ~6 s
const SOFT = 0.0004;                // keeps the pull finite right at the center
const SUN_R = 0.09;
const SHEEP_R = 0.08;               // for hits; drawn a little bigger (the wool is fluffy)
const LIVES = 3;
const MAX_LIVES = 5;
const THRUST = 1.1;
const MAX_V = 1.8;
const TAP_BURN = 0.3;               // seconds of burn for a tap on Next
const HOLD_BURN = 0.25;             // each hold repeat (every 180 ms) keeps it lit this long
// One wheel tick (15 degrees of thumb) turns the sheep 7.5 when turning
// slowly, for aiming (a 15 degree step misses a sheep across the screen by a
// few sheep widths), and 15 when spinning, to come round quickly (7.5
// alone felt a little slow). Spinning = ticks under FAST_TICK apart.
const STEP = Math.PI / 24;
const FAST_TICK = 0.09;             // seconds
const EASE = 25;
const SHOT_V = 1.4;
const SHOT_LIFE = 1.4;
const SHOT_GAP = 0.22;              // the player's fastest fire rate
const MAX_SHOTS = 5;                // the player's lasers in flight at once
const HYPER_GAP = 3;
const SAFE_TIME = 2;                // no hits after a respawn
const RESPAWN = 1.5;
const H = 1 / 240;                  // physics step

const TAU = Math.PI * 2;
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
// The sun's pull at (x, y).
const pull = (x, y) => {
  const r2 = x * x + y * y + SOFT;
  const k = -GM / (r2 * Math.sqrt(r2));
  return [x * k, y * k];
};
// Wrapped difference, so distances and aim go the short way across an edge.
const dWrap = (d, half) => d - Math.round(d / (2 * half)) * 2 * half;

export class SpaceSheep {
  constructor(feedback) {
    this.title = 'Space Sheep';
    this.feedback = feedback;       // click + buzz, as on the wheel
    this.canvas = null;             // runCanvas's (util.js), with raf
    this.raf = 0;
    this.best = scores.localBest('sheep');
    this.stars = Array.from({ length: 70 }, () => [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()]);
    this.newGame();
    this.state = 'ready';
  }

  newGame() {
    this.sent = false;              // this game's score went to the board
    this.result = null;             // what the board said back
    this.score = 0;
    this.lives = LIVES;
    this.wave = 0;
    this.t = 0;
    this.lastTurn = -1;
    this.shots = [];
    this.puffs = [];
    this.player = null;
    this.enemies = [];
    this.state = 'play';
    this.spawnPlayer();
    this.nextWave();
  }

  // On a circular orbit, facing the way it's going.
  orbiter(r, a, dir) {
    const v = Math.sqrt(GM / r);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    const vx = -Math.sin(a) * v * dir, vy = Math.cos(a) * v * dir;
    const h = Math.atan2(vy, vx);
    return { x, y, vx, vy, h, aim: h, burn: 0, cool: 0 };
  }

  spawnPlayer() {
    // Across the sun from the nearest enemy.
    const e = this.enemies[0];
    const a = e ? Math.atan2(e.y, e.x) + Math.PI : Math.PI;
    this.player = { ...this.orbiter(0.7, a, 1), safe: this.t + SAFE_TIME, hyper: 0, gone: 0 };
  }

  // Each wave brings more sheep (up to five) and smarter ones.
  nextWave() {
    this.wave++;
    const n = Math.min(5, 1 + Math.floor(this.wave / 2));
    this.skill = Math.min(1, 0.1 * this.wave);           // full skill from wave 10
    const pa = Math.atan2(this.player.y, this.player.x);
    this.enemies = [];
    for (let i = 0; i < n; i++) {
      const a = pa + Math.PI + (i - (n - 1) / 2) * 0.7;
      const r = 0.9 - ((i * 0.37) % 0.35);   // the first one out wide, so it takes a while to come round
      const dir = this.wave >= 3 && i % 2 ? -1 : 1;   // some go the other way round from wave 3
      this.enemies.push({ ...this.orbiter(r, a, dir), cool: this.t + 1 + Math.random(), plan: 0, moveUntil: 0, climb: 1 });
    }
    this.player.safe = Math.max(this.player.safe, this.t + 1);
  }

  attach(ui) { this.ui = ui; }

  leave() {
    // Leaving throws the game away, so a game in progress counts as ended.
    if (this.score > 0) scores.gameOver(this, 'sheep');
    if (this.state === 'play') this.state = 'paused';
  }

  // ---------- wheel ----------

  live() { return this.state === 'play' && this.player && !this.player.gone; }

  turn(dir) {
    if (!this.live()) return false;
    // Game time, not the clock: the same in the sim as on the phone.
    const fast = this.t - this.lastTurn < FAST_TICK;
    this.lastTurn = this.t;
    this.player.aim += dir * (fast ? STEP * 2 : STEP);
    return true;
  }

  select() {
    if (this.state === 'over' || this.state === 'ready') { this.newGame(); return; }
    if (this.state === 'paused') { this.state = 'play'; return; }
    if (this.live()) this.fire(this.player, 'you');
  }

  play() {
    if (this.state === 'play') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'play';
    return true;
  }

  next() {
    if (this.live()) this.player.burn = Math.max(this.player.burn, this.t + TAP_BURN);
    return true;
  }

  hold(button) {
    if (button === 'next' && this.live()) this.player.burn = Math.max(this.player.burn, this.t + HOLD_BURN);
  }

  prev() {
    const p = this.player;
    if (!this.live() || this.t < p.hyper) return true;
    // Anywhere clear of the sun, at orbit speed in a random direction.
    const r = 0.4 + Math.random() * 0.5;
    const a = Math.random() * TAU;
    const o = this.orbiter(r, a, Math.random() < 0.5 ? 1 : -1);
    this.poof(p.x, p.y, '#b9a7ff', 6);
    Object.assign(p, { x: o.x, y: o.y, vx: o.vx, vy: o.vy, hyper: this.t + HYPER_GAP, safe: Math.max(p.safe, this.t + 0.4) });
    this.poof(p.x, p.y, '#b9a7ff', 6);
    return true;
  }

  fire(s, who) {
    if (this.t < s.cool) return;
    if (who === 'you' && this.shots.filter((b) => b.who === 'you').length >= MAX_SHOTS) return;
    s.cool = this.t + (who === 'you' ? SHOT_GAP : this.fireGap());
    const c = Math.cos(s.h), d = Math.sin(s.h);
    this.shots.push({
      x: s.x + c * SHEEP_R * 1.3, y: s.y + d * SHEEP_R * 1.3,
      vx: s.vx + c * SHOT_V, vy: s.vy + d * SHOT_V,
      die: this.t + SHOT_LIFE, who,
    });
  }

  // ---------- enemy sheep ----------

  fireGap() { return 2 - 1.4 * this.skill + Math.random() * 0.4; }

  // Every tenth of a second each enemy decides: get away from the sun if its
  // path is heading in, otherwise turn toward the player (leading the shot
  // once it's smart enough) and fire when lined up.
  think(e) {
    const p = this.player;
    e.plan = this.t + 0.1;
    e.fleeing = e.dodging = e.wantShot = false;
    if (this.falling(e)) {
      // Burn sideways (the way it's already going round) and a little
      // outward: sideways speed is what carries it past the sun. Not along
      // its velocity: falling straight in, that points at the sun.
      const r = Math.hypot(e.x, e.y) || 1;
      const ux = e.x / r, uy = e.y / r;
      const turn = -uy * e.vx + ux * e.vy >= 0 ? 1 : -1;
      e.aim = Math.atan2(ux * turn + 0.5 * uy, -uy * turn + 0.5 * ux);
      // Only burn once it's facing that way: burning mid-turn can push it in.
      if (Math.abs(wrap(e.aim - e.h)) < 0.5) e.burn = this.t + 0.12;
      e.fleeing = true;
      return;
    }
    if (p.gone) { e.aim = Math.atan2(e.vy, e.vx); return; }
    // Smarter sheep sidestep a laser headed their way.
    if (this.skill >= 0.5) {
      for (const b of this.shots) {
        if (b.who !== 'you') continue;
        const bx = dWrap(e.x - b.x, WX), by = dWrap(e.y - b.y, WY);
        const d = Math.hypot(bx, by);
        if (d > 0.4 || bx * b.vx + by * b.vy < 0.7 * d * Math.hypot(b.vx, b.vy)) continue;
        if (Math.random() > this.skill - 0.3) break;
        e.aim = Math.atan2(b.vy, b.vx) + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
        e.burn = this.t + 0.15;
        e.dodging = true;
        return;
      }
    }
    let dx = dWrap(p.x - e.x, WX), dy = dWrap(p.y - e.y, WY);
    const dist = Math.hypot(dx, dy);
    if (this.skill >= 0.3) {
      // Aim where the player will be when the laser gets there.
      const tt = dist / SHOT_V;
      dx += (p.vx - e.vx) * tt * this.skill;
      dy += (p.vy - e.vy) * tt * this.skill;
    }
    // Early waves aim sloppily.
    e.aim = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * 0.3 * (1 - this.skill);
    e.wantShot = dist < 0.9 + 0.6 * this.skill;
    // Now and then, out of range, change orbit toward the player's height:
    // a burn along the orbit climbs, against it drops. Never straight at
    // the player, which so often means through the sun.
    if (this.t < e.moveUntil) { this.orbitBurn(e); return; }
    const rp = Math.hypot(p.x, p.y), r = Math.hypot(e.x, e.y);
    if (!e.wantShot && Math.abs(r - rp) > 0.2 && Math.random() < 0.05 + 0.1 * this.skill) {
      e.moveUntil = this.t + 0.6;
      e.climb = r < rp ? 1 : -1;
      this.orbitBurn(e);
    }
  }

  orbitBurn(e) {
    e.wantShot = false;
    e.aim = Math.atan2(e.vy * e.climb, e.vx * e.climb);
    if (Math.abs(wrap(e.aim - e.h)) < 0.4) e.burn = this.t + 0.12;
  }

  // Coasting for the next 1.5 s (30 steps of 0.05), does it come within
  // 2.4 sun radii of the middle?
  falling(s) {
    let { x, y, vx, vy } = s;
    for (let k = 0; k < 30; k++) {
      const [ax, ay] = pull(x, y);
      vx += ax * 0.05; vy += ay * 0.05;
      x += vx * 0.05; y += vy * 0.05;
      if (x * x + y * y < (SUN_R * 2.4) ** 2) return true;
    }
    return false;
  }

  // ---------- loop ----------

  render(view) { runCanvas(this, view); }

  step(dt) {
    if (this.state !== 'play') return;
    const p = this.player;
    // Your sheep eases toward the wheel's aim, like the Vortex paddle. The aim
    // isn't wrapped (a full spin of the wheel is a full turn), so it's pulled
    // back in now and then before it grows huge.
    if (!p.gone) {
      const d = p.aim - p.h;
      p.h += d * (1 - Math.exp(-dt * EASE));
      if (Math.abs(d) > TAU * 4) { p.h = wrap(p.h); p.aim = p.h + wrap(d); }
    }
    for (const e of this.enemies) {
      // Enemies turn at a fixed rate, quicker as they get smarter.
      const max = (2.2 + 2.5 * this.skill) * dt;
      e.h += Math.max(-max, Math.min(max, wrap(e.aim - e.h)));
      if (this.t >= e.plan) this.think(e);
      if (!e.fleeing && !e.dodging && e.wantShot && Math.abs(wrap(e.aim - e.h)) < 0.18 - 0.1 * this.skill) this.fire(e, 'them');
    }
    const n = Math.ceil(dt / H);
    for (let k = 0; k < n; k++) this.physics(dt / n);
    this.t += dt;
    this.puffs = this.puffs.filter((f) => (f.age += dt) < f.life);
    if (p.gone && this.t >= p.gone) {
      if (this.lives > 0) this.spawnPlayer();
      else { this.state = 'over'; scores.gameOver(this, 'sheep'); }
    }
    if (!this.enemies.length && this.state === 'play' && !p.gone) {
      this.score += 250;
      if (this.wave % 3 === 0 && this.lives < MAX_LIVES) this.lives++;
      this.shots = this.shots.filter((b) => b.who === 'you');
      this.nextWave();
    }
  }

  physics(h) {
    const p = this.player;
    for (const s of p.gone ? this.enemies : [p, ...this.enemies]) {
      let [ax, ay] = pull(s.x, s.y);
      if (this.t < s.burn) { ax += Math.cos(s.h) * THRUST; ay += Math.sin(s.h) * THRUST; }
      s.vx += ax * h; s.vy += ay * h;
      const v = Math.hypot(s.vx, s.vy);
      if (v > MAX_V) { s.vx *= MAX_V / v; s.vy *= MAX_V / v; }
      s.x = dWrap(s.x + s.vx * h, WX);
      s.y = dWrap(s.y + s.vy * h, WY);
      if (s.x * s.x + s.y * s.y < (SUN_R + SHEEP_R * 0.5) ** 2) this.pop(s, null);
    }
    for (const b of this.shots) {
      const [ax, ay] = pull(b.x, b.y);
      b.vx += ax * h; b.vy += ay * h;
      b.x = dWrap(b.x + b.vx * h, WX);
      b.y = dWrap(b.y + b.vy * h, WY);
      if (this.t > b.die || b.x * b.x + b.y * b.y < SUN_R * SUN_R) { b.done = true; continue; }
      // Your lasers hit black sheep, theirs hit you; they don't hit each other.
      const targets = b.who === 'you' ? this.enemies : (p.gone ? [] : [p]);
      for (const s of targets) {
        if (s.dead || Math.hypot(dWrap(b.x - s.x, WX), dWrap(b.y - s.y, WY)) > SHEEP_R) continue;
        b.done = true;
        this.pop(s, b.who);
        break;
      }
    }
    // Ramming: both go.
    if (!p.gone) {
      for (const e of this.enemies) {
        if (e.dead || Math.hypot(dWrap(p.x - e.x, WX), dWrap(p.y - e.y, WY)) > SHEEP_R * 1.6) continue;
        this.pop(e, 'you');
        this.pop(p, 'them');
        break;
      }
    }
    if (this.shots.some((b) => b.done)) this.shots = this.shots.filter((b) => !b.done);
    if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
  }

  // A sheep is hit (by = 'you', 'them', or null for the sun).
  pop(s, by) {
    const p = this.player;
    if (s === p) {
      // Spawn safety covers lasers and ramming, not the sun.
      if (p.gone || (by && this.t < p.safe)) return;
      p.gone = this.t + RESPAWN;
      this.lives--;
      this.poof(s.x, s.y, '#f4f6ff', 14);
      this.feedback();
      return;
    }
    if (s.dead) return;
    s.dead = true;
    this.poof(s.x, s.y, '#6b6480', 12);
    if (by === 'you') { this.score += 100 + 25 * (this.wave - 1); this.feedback(); }
  }

  poof(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = 0.15 + Math.random() * 0.35;
      this.puffs.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color, age: 0, life: 0.6 + Math.random() * 0.4 });
    }
  }

  // ---------- drawing ----------

  draw({ g, w, h, dpr }) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#04050b';
    g.fillRect(0, 0, w, h);
    const S = Math.min(w / (2 * WX), h / (2 * WY));
    const cx = w / 2, cy = h / 2;
    const X = (x) => cx + x * S;
    const Y = (y) => cy + y * S;

    // stars, twinkling a little
    for (const [sx, sy, k] of this.stars) {
      g.fillStyle = `rgba(220,226,255,${0.25 + 0.5 * k * (0.75 + 0.25 * Math.sin(this.t * 2 + k * 40))})`;
      g.fillRect(cx + sx * w / 2, cy + sy * h / 2, k > 0.85 ? 2 : 1, k > 0.85 ? 2 : 1);
    }
    // the sun
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, SUN_R * S * 3.2);
    glow.addColorStop(0, 'rgba(255,214,102,.55)');
    glow.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(cx, cy, SUN_R * S * 3.2, 0, TAU); g.fill();
    g.fillStyle = '#ffd166';
    g.shadowColor = '#ffb703';
    g.shadowBlur = 14;
    g.beginPath(); g.arc(cx, cy, SUN_R * S * (1 + 0.04 * Math.sin(this.t * 3)), 0, TAU); g.fill();
    g.shadowBlur = 0;

    // lasers
    g.lineWidth = Math.max(1.5, S * 0.012);
    g.lineCap = 'round';
    for (const b of this.shots) {
      const v = Math.hypot(b.vx, b.vy) || 1;
      const len = 0.06;
      g.strokeStyle = b.who === 'you' ? '#5dff9d' : '#ff4d6d';
      g.shadowColor = g.strokeStyle;
      g.shadowBlur = 6;
      g.beginPath();
      g.moveTo(X(b.x), Y(b.y));
      g.lineTo(X(b.x - (b.vx / v) * len), Y(b.y - (b.vy / v) * len));
      g.stroke();
    }
    g.shadowBlur = 0;
    g.lineCap = 'butt';

    // sheep
    for (const e of this.enemies) this.drawSheep(g, X(e.x), Y(e.y), e.h, S * SHEEP_R * 1.3, false, this.t < e.burn);
    const p = this.player;
    if (p && !p.gone && (this.t >= p.safe || Math.floor(this.t * 8) % 2 === 0)) {
      this.drawSheep(g, X(p.x), Y(p.y), p.h, S * SHEEP_R * 1.3, true, this.t < p.burn && this.state === 'play');
    }
    // wool flying off a hit sheep
    for (const f of this.puffs) {
      const k = f.age / f.life;
      g.globalAlpha = 1 - k;
      g.fillStyle = f.color;
      g.beginPath(); g.arc(X(f.x + f.vx * f.age), Y(f.y + f.vy * f.age), S * 0.018 * (1 + k * 1.5), 0, TAU); g.fill();
    }
    g.globalAlpha = 1;

    // score line
    g.fillStyle = '#e8ecff';
    g.font = font(h * 0.065);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(`Score ${this.score}`, w * 0.03, h * 0.06);
    g.textAlign = 'right';
    g.fillText(`Lives ${'●'.repeat(Math.max(0, this.lives))}  Wave ${this.wave}`, w * 0.97, h * 0.06);
    // hyperspace charge: a thin bar under the score while it recharges
    if (p && this.t < p.hyper) {
      const k = 1 - (p.hyper - this.t) / HYPER_GAP;
      g.fillStyle = 'rgba(185,167,255,.7)';
      g.fillRect(w * 0.03, h * 0.11, w * 0.18 * k, 2);
    }

    // Start and pause sit low, clear of the sun; Game Over takes the middle.
    if (this.state === 'over') scores.drawBox(g, scores.overLines(this.score, this.best, this.result), cx, cy, h);
    else if (this.state !== 'play') scores.drawBox(g, [this.state === 'ready' ? 'Press the center button to start' : 'Paused'], cx, h * 0.78, h);
  }

  // A sheep facing angle a, size R px: a cloud of wool, a face at the front,
  // and a flame out the back while its jetpack burns. Yours is white; the
  // others are black sheep with red eyes.
  drawSheep(g, x, y, a, R, mine, burning) {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    if (burning) {
      const f = 0.8 + Math.random() * 0.5;
      g.fillStyle = '#ffb703';
      g.beginPath();
      g.moveTo(-R * 0.75, -R * 0.3);
      g.lineTo(-R * (1.3 + 0.6 * f), 0);
      g.lineTo(-R * 0.75, R * 0.3);
      g.fill();
      g.fillStyle = '#fff3c4';
      g.beginPath();
      g.moveTo(-R * 0.75, -R * 0.15);
      g.lineTo(-R * (1.05 + 0.3 * f), 0);
      g.lineTo(-R * 0.75, R * 0.15);
      g.fill();
    }
    // jetpack
    g.fillStyle = '#8a8fa3';
    g.fillRect(-R * 0.85, -R * 0.32, R * 0.3, R * 0.64);
    // wool: seven puffs in a ring, one path so it fills (and outlines) as one
    g.beginPath();
    for (let i = 0; i < 7; i++) {
      const t = (i / 7) * TAU;
      const px = Math.cos(t) * R * 0.45 - R * 0.1, py = Math.sin(t) * R * 0.38;
      g.moveTo(px + R * 0.38, py);
      g.arc(px, py, R * 0.38, 0, TAU);
    }
    // Black sheep get a red edge so they stand out against space: the
    // outline goes on first and the wool over it, so only the outer edge
    // of the puffs shows.
    if (!mine) {
      g.strokeStyle = '#ff4d6d';
      g.lineWidth = Math.max(2, R * 0.16);
      g.shadowColor = '#ff4d6d';
      g.shadowBlur = 8;
      g.stroke();
      g.shadowBlur = 0;
    }
    g.fillStyle = mine ? '#f4f6ff' : '#4a4360';
    g.fill();
    // face, ears and an eye on each side
    g.fillStyle = mine ? '#2b2b33' : '#15131c';
    g.beginPath(); g.ellipse(R * 0.62, 0, R * 0.36, R * 0.3, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(R * 0.42, -R * 0.36, R * 0.18, R * 0.09, -0.6, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(R * 0.42, R * 0.36, R * 0.18, R * 0.09, 0.6, 0, TAU); g.fill();
    g.fillStyle = mine ? '#ffffff' : '#ff4d6d';
    g.beginPath(); g.arc(R * 0.72, -R * 0.12, R * 0.07, 0, TAU); g.fill();
    g.beginPath(); g.arc(R * 0.72, R * 0.12, R * 0.07, 0, TAU); g.fill();
    g.restore();
  }
}
