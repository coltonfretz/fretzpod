import './env.mjs';
import { Golf } from '../../app/golf.js';
import { COURSES } from '../../app/golf-holes.js';
const g = new Golf(1, () => {});
for (const hi of [0, 2, 4, 7, 8]) {
  g.startHole(hi);
  const out = [];
  for (let p = 0.5; p <= 1.001; p += 0.05) {
    g.ball = { x: g.hole.tee[0], y: g.hole.tee[1], vx: 0, vy: 0, hidden: false, lift: 0, scale: 1 };
    g.strokes = 0; g.event = null; g.time = 0; g.moleTurn = g.hole.moles.map(() => 0);
    const startAim = g.aim; g.power = p; g.state = 'power'; g.shoot();
    for (let k = 0; k < 4000; k++) { g.step(1 / 60); if (g.state === 'aim' || g.state === 'done') break; }
    out.push(g.state === 'done' ? 'ACE' : `${Math.round(g.ball.x)},${Math.round(g.ball.y)}`);
    g.aim = startAim;
  }
  console.log(hi + 1, g.hole.name, out.join(' '));
}
