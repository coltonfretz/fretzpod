import './env.mjs';
import { Golf } from '../../app/golf.js';
import { COURSES } from '../../app/golf-holes.js';
const CI = Number(process.env.COURSE || 0);
const g = new Golf(CI, () => {});
function shot(pos, angle, power, time, moleTurn) {
  g.ball = { x: pos[0], y: pos[1], vx: 0, vy: 0, hidden: false, lift: 0, scale: 1 };
  g.strokes = 0; g.moleTurn = [...moleTurn]; g.event = null; g.banner = null; g.time = time;
  g.aim = angle; g.power = power; g.state = 'power'; g.shoot();
  for (let k = 0; k < 4000; k++) { g.step(1 / 60); if (g.state === 'aim' || g.state === 'done') break; }
  return { state: g.state, x: g.ball.x, y: g.ball.y, strokes: g.strokes, mt: [...g.moleTurn], time: g.time };
}
const holes = COURSES[CI].holes;
const only = process.argv[2] ? [Number(process.argv[2]) - 1] : holes.map((_, i) => i);
for (const hi of only) {
  const t0 = Date.now();
  g.startHole(hi);
  const h = holes[hi];
  let frontier = [{ pos: h.tee, strokes: 0, mt: h.moles ? h.moles.map(() => 0) : [], time: 0 }];
  let best = null, aces = 0, firstLevelSinks = 0;
  for (let depth = 1; depth <= h.par + 2 && !best; depth++) {
    const next = new Map();
    for (const f of frontier) {
      for (let a = 0; a < 360; a += 5) {
        for (let p = 0.08; p <= 1.001; p += 0.092) {
          const r = shot(f.pos, a * Math.PI / 180, p, f.time + Math.random() * 4, f.mt);
          const total = f.strokes + r.strokes;
          if (r.state === 'done') { if (!best || total < best) best = total; if (total === 1) aces++; if (depth === 1) firstLevelSinks++; continue; }
          const key = `${Math.round(r.x / 6)},${Math.round(r.y / 6)}`;
          if (!next.has(key) || next.get(key).strokes > total) next.set(key, { pos: [r.x, r.y], strokes: total, mt: r.mt, time: r.time });
        }
      }
    }
    // Keep a spread: the 14 positions closest to the cup by straight line plus 10 random.
    const all = [...next.values()];
    const d = (q) => Math.hypot(q.pos[0] - h.cup[0], q.pos[1] - h.cup[1]);
    all.sort((x, y) => d(x) - d(y));
    frontier = all.slice(0, 14).concat(all.slice(14).sort(() => Math.random() - 0.5).slice(0, 10));
  }
  console.log(`hole ${hi + 1} ${h.name.padEnd(15)} par ${h.par}: best found ${best ?? 'NONE'}${aces ? `  (hole-in-one shots: ${aces})` : ''}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
