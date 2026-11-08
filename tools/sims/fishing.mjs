// Fishing Trip on autopilot, playing like a person: aims at a fish that
// likes the lure, casts past it, reels slowly to draw it in, hooks a bite
// after a human reaction time, and fights by spinning forward or back to keep
// the tension marker in the green (capped at a thumb's spin speed), tapping
// center to break hard runs. Reports catches, losses and points per minute,
// which is what the unlock points in fishing.js are set against.
//   SPOT=0|1|2 LURE=worm|spinner|frog|jig node fishing.mjs [minutes]   (SEED= for other runs)
// SKILL=0.5 plays slower and sloppier; SPAM=1 spins forward through every
// fight without watching the bar, which should lose most bigger fish.
import './env.mjs';
import { Fishing, fishSave } from '../../app/fishing.js';
globalThis.performance ??= { now: () => 0 };

const MIN = Number(process.argv[2] || 10);
const SPOT = Number(process.env.SPOT || 0);
const SKILL = Number(process.env.SKILL ?? 1);   // 0.5: slower and sloppier
const DT = 1 / 60;
fishSave.save({ points: 1e9, lure: process.env.LURE || 'worm', log: {} });   // everything open
const g = new Fishing(SPOT, () => {});
fishSave.save({ points: 0, lure: g.lure.id, log: {} });

const out = { catches: 0, points: 0, snapped: 0, spat: 0, missedBites: 0, scared: 0, fightSecs: [], kinds: {} };
let t = 0, wait = 0, target = null, tickBudget = 0, fightStart = 0, biteSeen = 0, cardAt = 0;
const lose = g.lose.bind(g);
g.lose = (text) => { if (text.includes('snapped')) out.snapped++; else out.spat++; lose(text); };
const caught = g.caught.bind(g);
g.caught = (f) => { out.catches++; out.kinds[f.kind.name] = (out.kinds[f.kind.name] || 0) + 1; out.fightSecs.push(t - fightStart); caught(f); };

while (t < MIN * 60) {
  tickBudget = Math.min(tickBudget + DT * 12 * SKILL, 2);   // a thumb spins at most ~12 ticks/s
  if ((wait -= DT) <= 0) {
    if (g.state === 'aim') {
      target = g.fish.filter((f) => f.state === 'swim' && f.kind.lures.includes(g.lure.id))
        .sort((a, b) => Math.hypot(a.x - 0.5, a.y - 0.93) - Math.hypot(b.x - 0.5, b.y - 0.93))[0] || g.fish[0];
      const want = Math.atan2(target.x - 0.5, 0.93 - target.y);
      if (Math.abs(want - g.aim) > 0.05 && tickBudget >= 1) { g.turn(Math.sign(want - g.aim)); tickBudget--; } else if (Math.abs(want - g.aim) <= 0.05) g.select();
    } else if (g.state === 'power') {
      const dist = Math.hypot(target.x - 0.5, 0.93 - target.y) + 0.05;
      const p = (dist - 0.12) / 0.78;
      if (Math.abs(g.power - p) < 0.04 + 0.06 * (1 - SKILL)) { g.select(); wait = 0.3; }
    } else if (g.state === 'lure') {
      const bite = g.fish.find((f) => f.state === 'bite');
      if (bite) {
        if (!biteSeen) biteSeen = t + 0.3 / SKILL + Math.random() * 0.15;
        if (t >= biteSeen) { g.select(); biteSeen = 0; fightStart = t; }
      } else {
        if (biteSeen) out.missedBites++;
        biteSeen = 0;
        const busy = g.fish.some((f) => f.state === 'chase' || f.state === 'nibble');
        // reel a click every half second or so; still while one is nibbling
        if (!busy && Math.random() < DT * 2.2 && tickBudget >= 1) { g.turn(1); tickBudget--; }
      }
    } else if (g.state === 'fight') {
      const F = g.fight, lo = 0.5 - F.zone * 0.5, hi = 0.5 + F.zone * 0.5;
      // SPAM=1: just spins forward the whole fight, never watching the bar (should lose a lot).
      if (process.env.SPAM) { if (tickBudget >= 1) { g.turn(1); tickBudget--; } g.step(DT); t += DT; continue; }
      const seen = F.tension + (Math.random() - 0.5) * 0.08 * (2 - SKILL);
      if (seen < lo && tickBudget >= 1) { g.turn(1); tickBudget--; }
      else if (seen > hi && tickBudget >= 1) { g.turn(-1); tickBudget--; }
      else if (seen > 0.35 && seen < hi && tickBudget >= 1 && Math.random() < 0.3) { g.turn(1); tickBudget--; }
      if (F.phase === 'run' && F.tension > 0.78 && Math.random() < DT * 6 * SKILL) g.select();
    } else if (g.state === 'card') {
      if (!cardAt) cardAt = t + 1.2;
      if (t >= cardAt) { cardAt = 0; g.select(); }
    }
  }
  g.step(DT);
  t += DT;
}
out.points = fishSave.load().points;
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
console.log({ spot: g.spot.name, lure: g.lure.name, minutes: MIN, catches: out.catches, perMin: +(out.catches / MIN).toFixed(2),
  pointsPerMin: Math.round(out.points / MIN), snapped: out.snapped, spat: out.spat, missedBites: out.missedBites,
  avgFightSecs: avg(out.fightSecs), maxFightSecs: Math.round(Math.max(0, ...out.fightSecs)), kinds: out.kinds });
