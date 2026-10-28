import './env.mjs';
import { Vortex } from '../../app/vortex.js';
globalThis.performance ??= { now: () => 0 };
const v = new Vortex(() => {});
let caught = 0; const orig = v.power.bind(v); v.power = (id) => { caught++; orig(id); };
let maxBalls = 0;
for (let t = 0; t < 600 * 60; t++) {
  if (v.state === 'ready') v.launch();
  if (v.state === 'over') break;
  // autopilot: aim at the outermost ball heading out
  const b = v.balls.slice().sort((p, q) => Math.hypot(q.x, q.y) - Math.hypot(p.x, p.y))[0];
  if (b) v.aim = v.pad + (((Math.atan2(b.y, b.x) - v.pad + Math.PI) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI) - Math.PI);
  v.step(1 / 60);
  maxBalls = Math.max(maxBalls, v.balls.length);
}
console.log({ state: v.state, level: v.level, score: v.score, lives: v.lives, bricksLeft: v.bricks.length, caught, maxBalls });
