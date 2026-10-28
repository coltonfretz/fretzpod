// Just enough browser for the games' imports (api.js reads the page address
// when it loads). Import this first. No session, so nothing is ever sent to
// the score boards from a sim.
globalThis.location ??= { hostname: 'sim', origin: 'http://sim', protocol: 'http:' };

// Math.random made repeatable (mulberry32, seeded by SEED=, default 1): the
// same code prints the same numbers every run, so a cleanup can be checked
// for "no behavior change" by diffing a sim's output against the last
// commit's. Try a few seeds for balance work.
let seed = Number(process.env.SEED || 1) >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
