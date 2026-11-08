// Star Pinball on autopilot: flips when a ball comes down near a flipper,
// launches at a random pull. Checks the table holds the ball (no escapes
// through walls), nothing gets stuck, and the rules move along.
//   node pinball.mjs [games]        (SEED= for other runs)
import './env.mjs';
import { StarPinball } from '../../app/pinball.js';
globalThis.performance ??= { now: () => 0 };

const GAMES = Number(process.argv[2] || 20);
const MISS = Number(process.env.MISS ?? 0.25);
const REACT = 0.1;   // seconds
const FL = [{ x: 0.295, y: 1.58 }, { x: 0.625, y: 1.58 }];
const out = { games: 0, scores: [], seconds: [], missions: [], escapes: 0, nudges: 0, holes: 0, ramps: 0, rollbacks: 0, multiballs: 0, saves: 0, maxBalls: 0, topHits: 0, flips: 0 };
for (let n = 0; n < GAMES; n++) {
  const p = new StarPinball(() => {});
  let t = 0, pullFor = 0;
  const cool = [{ hold: 0, wait: 0, react: undefined }, { hold: 0, wait: 0, react: undefined }];
  const say = p.say.bind(p);
  p.say = (text, s) => { if (text === 'Multiball!') out.multiballs++; if (text === 'Ball saved') out.saves++; say(text, s); };
  const rd = p.rampDone.bind(p);
  p.rampDone = () => { out.ramps++; rd(); };
  const adv = p.advance.bind(p);
  p.advance = (id, k) => { if (id === 'hole') out.holes++; adv(id, k); };
  while (p.state !== 'over' && t < 900) {
    // plunger
    if (p.balls.some((b) => b.plunger && b.auto === undefined)) {
      if (!p.pulling) { p.down('select'); pullFor = 0.3 + Math.random() * 0.6; }
      else if ((pullFor -= 1 / 60) <= 0) p.up('select');
    }
    // flippers: like a person, a short flip a moment after a ball comes down
    // near one, missing some (MISS=, default 0.25; 0 plays perfectly)
    FL.forEach((f, i) => {
      const btn = i ? 'next' : 'prev';
      const c = cool[i];
      if (p.flips[i].held) { if ((c.hold -= 1 / 60) <= 0) { p.up(btn); c.wait = 0.25; } return; }
      if ((c.wait -= 1 / 60) > 0) return;
      const near = p.balls.some((b) => !b.plunger && Math.hypot(b.x - f.x, b.y - f.y) < 0.19 && b.y > 1.45 && b.vy > -0.3 && (i === 0 ? b.x < 0.47 : b.x > 0.45));
      if (!near) { c.react = undefined; return; }
      if (c.react === undefined) c.react = Math.random() < MISS ? Infinity : REACT;
      if ((c.react -= 1 / 60) <= 0) { p.down(btn); c.hold = 0.15; c.react = undefined; out.flips++; }
    });
    for (const b of p.balls) {
      if (b.x < -0.01 || b.x > 1.01 || b.y < -0.01) { out.escapes++; b.x = 0.46; b.y = 0.9; b.vx = b.vy = 0; }
      if (b.y < 0.3 && !b.plunger) b.top = true;
      if (b.still > 2.9) out.nudges++;
    }
    out.maxBalls = Math.max(out.maxBalls, p.balls.length);
    p.step(1 / 60);
    t += 1 / 60;
  }
  out.games++;
  out.scores.push(p.score);
  out.seconds.push(Math.round(t));
  out.missions.push(p.done);
}
const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
console.log({ games: out.games, avgScore: avg(out.scores), maxScore: Math.max(...out.scores), avgSeconds: avg(out.seconds),
  avgMissions: (out.missions.reduce((s, x) => s + x, 0) / out.games).toFixed(1), maxMissions: Math.max(...out.missions),
  escapes: out.escapes, nudges: out.nudges, holes: out.holes, ramps: out.ramps, multiballs: out.multiballs, saves: out.saves, maxBalls: out.maxBalls });
