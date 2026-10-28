// Full-app playback check in one engine against the dev server (dev/devserver.py).
// Plays 3 random songs muted, jumps to the end of song 1, and confirms the
// player moved to song 2 at the right spot. Usage: node fullapp.mjs <engine> <url> <userId>
import { firefox, webkit, chromium } from 'playwright';
const [name, url, userId] = process.argv.slice(2);
const b = await { firefox, webkit, chromium }[name].launch({ firefoxUserPrefs: { 'media.autoplay.default': 0 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
await p.goto(url);
await p.evaluate((u) => { localStorage['fp.session'] = JSON.stringify({ token: 'dev', userId: u, name: 'test' }); }, userId);
await p.reload();
await p.waitForFunction(() => window.fpDebug, null, { timeout: 15000 });
const r = await p.evaluate(async (u) => {
  const P = fpDebug.player; P.el.muted = true;
  const items = (await fetch(`/jf/Items?UserId=${u}&IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=3`, { headers: { Authorization: 'x' } }).then((r) => r.json())).Items;
  P.play(items, 0);
  await new Promise((r) => setTimeout(r, 5000));
  const early = { pos: +P.position().toFixed(1), paused: P.el.paused };
  const d = P.duration();
  for (let i = 0; i < 40 && !(P.s.segs[1] && P.s.segs[1].start !== undefined); i++) { P.seek(Math.min(d - 6, 60 + i * 30)); await new Promise((r) => setTimeout(r, 700)); }
  P.seek(d - 4);
  await new Promise((r) => setTimeout(r, 8000));
  const { streamType } = await import('./player.js');
  return { mode: P.basic ? 'basic' : streamType.mime, early, songDur: +d.toFixed(2),
           song2Start: P.s.segs[1]?.start === undefined ? null : +P.s.segs[1].start.toFixed(2),
           index: P.index, pos: +P.position().toFixed(1), paused: P.el.paused, err: P.el.error?.code ?? null };
}, userId);
console.log(name, JSON.stringify(r));
await b.close();
