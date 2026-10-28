import './env.mjs';
// Space Sheep balance check. Six runs per mode, up to 5 game-minutes each:
// - idle: you never touch the wheel. Enemies should get you, but not instantly.
// - bot: a decent player (aims with lead, fires, burns out of falls, hyperspaces
//   when a laser is close). Should clear several waves and still lose sometimes.
// Also counts enemies that fall into the sun on their own (should be rare).
import { SpaceSheep } from '../../app/spacesheep.js';
globalThis.performance ??= { now: () => 0 };
const TAU = Math.PI * 2;
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;

function run(mode, minutes = 5) {
  const g = new SpaceSheep(() => {});
  g.select();                                   // start
  frame = 0; lastShot = 0;
  const stats = { sunEnemy: 0, sunYou: 0, shotYou: 0, rammed: 0, kills: 0, fired: 0, firstDeath: null };
  const of = g.fire.bind(g);
  g.fire = (s, w) => { const n = g.shots.length; of(s, w); if (w === 'you' && g.shots.length > n) stats.fired++; };
  const orig = g.pop.bind(g);
  g.pop = (s, by) => {
    const before = g.player.gone, dead = s.dead;
    orig(s, by);
    if (s === g.player && !before && g.player.gone) {
      if (by === null) stats.sunYou++; else if (g.enemies.some((e) => e.dead)) stats.rammed++; else stats.shotYou++;
      stats.firstDeath ??= g.t;
    } else if (s !== g.player && !dead && s.dead) {
      if (by === null) stats.sunEnemy++; else if (by === 'you') stats.kills++;
    }
  };
  for (let f = 0; f < minutes * 60 * 60 && g.state !== 'over'; f++) {
    if (mode === 'bot') bot(g);
    g.step(1 / 60);
  }
  return { mode, wave: g.wave, score: g.score, lives: g.lives, state: g.state, t: Math.round(g.t), ...stats, firstDeath: stats.firstDeath && Math.round(stats.firstDeath) };
}

// Human-ish hands: a wheel tick at most every 2 frames (~225 degrees a
// second), a shot at most every 0.3 s, aim off by a few degrees.
let frame = 0, lastShot = 0;
function bot(g) {
  const p = g.player;
  frame++;
  if (!p || p.gone) return;
  if (g.falling(p)) {
    const v = Math.hypot(p.vx, p.vy) || 1, r = Math.hypot(p.x, p.y) || 1;
    p.aim = p.h + wrap(Math.atan2(p.vy / v + 0.7 * p.y / r, p.vx / v + 0.7 * p.x / r) - p.h);
    if (Math.abs(wrap(p.aim - p.h)) < 0.5) g.hold('next');
    return;
  }
  // A laser about to hit: hyperspace.
  for (const b of g.shots) if (b.who === 'them' && Math.hypot(b.x - p.x, b.y - p.y) < 0.12) { g.prev(); break; }
  const e = g.enemies.slice().sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
  if (!e) return;
  const dist = Math.hypot(e.x - p.x, e.y - p.y), tt = dist / 1.4;
  const want = Math.atan2(e.y + (e.vy - p.vy) * tt - p.y, e.x + (e.vx - p.vx) * tt - p.x);
  // The wheel turns in 15-degree ticks.
  // Spin fast while far off (15 degree ticks), then slow ticks to fine-aim.
  const ticks = Math.round(wrap(want + (Math.random() - 0.5) * 0.2 - p.aim) / (Math.PI / 24));
  if (ticks && frame % (Math.abs(ticks) > 2 ? 2 : 7) === 0) g.turn(Math.sign(ticks));
  if (Math.abs(wrap(want - p.h)) < 0.15 && dist < 1.3 && g.t - lastShot > 0.3) { lastShot = g.t; g.select(); }
}

for (const mode of ['idle', 'bot']) for (let i = 0; i < 6; i++) console.log(run(mode));
