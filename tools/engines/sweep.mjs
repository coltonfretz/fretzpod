// Walks through every part of Fretzpod in one engine and reports what broke:
// page errors, console errors, failed requests, and per-step checks, plus a
// screenshot per step in shots/. Run inside the Playwright container with
// dev/devserver.py (see DESIGN.md "Other browsers and computers").
//
//   node sweep.mjs <firefox|webkit|chromium> <url> <userId>
//
// Favorites, high-score posts and Speakers are stubbed so a sweep never
// touches real favorites, the shared board, or the Sonos.
import { firefox, webkit, chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const [name, url, userId] = process.argv.slice(2);
const engine = { firefox, webkit, chromium }[name];
// WebKit dressed as an iPhone (touch, mobile viewport, Safari UA); the others a phone-sized window.
const ctxOpts = name === 'webkit' ? { ...devices['iPhone 15 Pro'] } : { viewport: { width: 412, height: 860 }, hasTouch: name !== 'firefox' };
const b = await engine.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0 } });
const ctx = await b.newContext(ctxOpts);
const p = await ctx.newPage();
mkdirSync('shots', { recursive: true });

const problems = [];
let stepName = 'start';
const checks = [];
p.on('pageerror', (e) => problems.push(`[${stepName}] pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') problems.push(`[${stepName}] console: ${m.text().slice(0, 200)}`); });
p.on('response', (r) => {
  const u = new URL(r.url());
  if (r.status() >= 400 && !u.pathname.startsWith('/speakers/')) problems.push(`[${stepName}] HTTP ${r.status()} ${u.pathname}`);
});
const favCalls = [];
await p.route('**/jf/UserFavoriteItems/**', (r) => { favCalls.push(r.request().method()); r.fulfill({ status: 200, contentType: 'application/json', body: '{"IsFavorite":true}' }); });
await p.route('**/scores/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"games":{},"you":null}' }));
await p.route('**/speakers/api/**', (r) => r.fulfill({ status: 503, body: 'stubbed' }));

const check = (step, ok, detail = '') => checks.push(`${ok ? 'ok  ' : 'FAIL'} ${step}${detail ? ': ' + detail : ''}`);
const shot = (step) => p.screenshot({ path: `shots/${name}-${step}.png` }).catch(() => {});
const wait = (ms) => p.waitForTimeout(ms);
const key = (k, n = 1) => (async () => { for (let i = 0; i < n; i++) await p.keyboard.press(k); })();
// Select a row by its label on the current list, then press Enter (a real key event).
async function go(label) {
  await p.waitForFunction((l) => {
    const t = fpDebug.ui().top;
    return t.rows && t.rows.some((r) => r && r.label === l);
  }, label, { timeout: 15000 }).catch(() => {});
  const found = await p.evaluate((l) => {
    const ui = fpDebug.ui(); const t = ui.top;
    const i = (t.rows || []).findIndex((r) => r && r.label === l);
    if (i < 0) return false;
    t.moveTo(i); ui.refresh(t); return true;
  }, label);
  if (!found) { check(`menu "${label}"`, false, 'row not found'); return false; }
  await key('Enter');
  await wait(600);
  return true;
}
// First loaded row of the current list.
async function first() {
  await p.waitForFunction(() => { const t = fpDebug.ui().top; return t.total > 0 && t.rows[0]; }, null, { timeout: 15000 }).catch(() => {});
  await key('Enter');
  await wait(800);
}
// Back to the main menu between sections, so one stumble doesn't derail the rest.
const home = () => p.evaluate(() => { const ui = fpDebug.ui(); ui.reset(ui.home()); }).then(() => wait(500));
async function section(label, fn) {
  stepName = label;
  try { await home(); await fn(); } catch (e) { check(label, false, `threw: ${e.message.split('\n')[0]}`); }
}
const top = () => p.evaluate(() => { const t = fpDebug.ui().top; return { title: t.title, mode: t.mode, lyricsOn: t.lyricsOn, total: t.total }; });

await p.goto(url);
await p.evaluate((u) => { localStorage.clear(); localStorage['fp.session'] = JSON.stringify({ token: 'dev', userId: u, name: 'test' }); }, userId);
await p.reload();
await p.waitForFunction(() => window.fpDebug, null, { timeout: 15000 });
await p.evaluate(() => { fpDebug.player.el.muted = true; });
await wait(1000);
await p.waitForFunction(() => [...document.images].some((i) => i.classList.contains('on') && i.naturalWidth > 0), null, { timeout: 8000 }).catch(() => {});
check('home screen art shows', await p.evaluate(() => [...document.images].some((i) => i.classList.contains('on') && i.naturalWidth > 0)));
await shot('01-home');

await section('music', async () => {
let t;
// ---- Music: Artists -> first artist -> first album -> first song -> Now Playing
await go('Music'); await go('Artists');
t = await top(); check('Artists list loads', t.total > 0, `${t.total} artists`);
await shot('02-artists');
await first(); await first();
t = await top(); check('album songs load', t.total > 0, `${t.title}, ${t.total} rows`);
await first();
await wait(6000);
const pl = await p.evaluate(() => ({ pos: fpDebug.player.position(), paused: fpDebug.player.el.paused, basic: fpDebug.player.basic }));
t = await top();
check('song plays from a list', pl.pos > 2 && !pl.paused, `pos ${pl.pos.toFixed(1)} s, paused ${pl.paused}, basic ${pl.basic}`);
check('Now Playing opens', t.title === 'Now Playing', t.title);
await shot('03-nowplaying');

// A queue that starts with a song that has lyrics, so swipe and Next have something to do.
await p.evaluate(async (u) => {
  const r = await fetch(`/jf/Items?UserId=${u}&IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=300&Fields=HasLyrics`, { headers: { Authorization: 'x' } }).then((x) => x.json());
  const withLyrics = r.Items.filter((i) => i.HasLyrics);
  const rest = r.Items.filter((i) => !i.HasLyrics).slice(0, 4);
  fpDebug.player.play([withLyrics[0], ...rest], 0);
  const ui = fpDebug.ui(); ui.reset(ui.home());
}, userId);
await wait(4000);
await go('Now Playing'); await wait(1500);

// Wheel on Now Playing (volume, or scrub where volume can't be set)
await key('ArrowDown', 3); await wait(300);
t = await top(); check('wheel on Now Playing', t.mode === 'volume' || t.mode === 'scrub', `mode ${t.mode}`);
await shot('04-np-wheel');
await wait(2500);

// Swipe the card sideways -> lyrics side
const card = await p.$('.np-card');
if (card) {
  const bb = await card.boundingBox();
  await p.mouse.move(bb.x + bb.width * 0.8, bb.y + bb.height / 2); await p.mouse.down();
  await p.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height / 2, { steps: 8 }); await p.mouse.up();
  await wait(900);
  t = await top(); check('swipe flips to lyrics', t.lyricsOn === true);
  await shot('05-lyrics');
  await p.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height / 2); await p.mouse.down();
  await p.mouse.move(bb.x + bb.width * 0.8, bb.y + bb.height / 2, { steps: 8 }); await p.mouse.up();
  await wait(900);
} else check('Now Playing card present', false);

// Hold center (Enter held) -> favorite (stubbed)
await p.keyboard.down('Enter'); await wait(800); await p.keyboard.up('Enter'); await wait(500);
check('hold center hearts the song', favCalls.length > 0, `calls ${favCalls.join(',') || 'none'}`);

// Next / previous
const before = await p.evaluate(() => fpDebug.player.index);
await key('ArrowRight'); await wait(2500);
const after = await p.evaluate(() => fpDebug.player.index);
check('Next skips a song', after === before + 1, `${before} -> ${after}`);

});

// ---- Cover Flow
await section('cover flow', async () => {
await p.evaluate(() => fpDebug.coverflow(true)); await wait(2500);
await shot('06-coverflow');
const cf = await p.evaluate(() => document.body.classList.contains('cf-on') && document.querySelectorAll('.cf-cover').length);
check('Cover Flow shows covers', !!cf, `${cf} elements`);
await p.evaluate(() => fpDebug.coverflow(false)); await wait(500);
});

// ---- Search screen
await section('search', async () => {
await go('Music'); await go('Search'); await wait(500); await shot('07-search');
});

// ---- TV
await section('tv', async () => {
let t;
await go('TV');
await p.waitForFunction(() => fpDebug.ui().top.total !== null, null, { timeout: 15000 }).catch(() => {});
t = await top(); check('TV channel list loads', t.total > 0, `${t.total} rows`);
await first(); await wait(9000);
const tv = await p.evaluate(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, rs: v.readyState, err: v.error && v.error.code, w: v.videoWidth } : null; });
check('TV plays video', !!tv && tv.t > 1 && !tv.err, JSON.stringify(tv));
await shot('08-tv');
});

// ---- Extras
for (const game of ['Vortex', 'Space Sheep']) await section(game, async () => {
  await go('Extras'); await go(game); await wait(1500);
  await key('Enter'); await key('ArrowDown', 4); await key('ArrowRight'); await wait(1500);
  await shot(`09-${game.replace(' ', '').toLowerCase()}`);
  const drawn = await p.evaluate(() => { const c = document.querySelector('canvas.game'); if (!c) return 'no canvas'; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] || d[i + 1] || d[i + 2]) n++; return n; });
  check(`${game} draws`, typeof drawn === 'number' && drawn > 5, String(drawn));
});
await section('golf', async () => {
await go('Extras'); await go('Tiki Golf'); await go('Start Game'); await first(); await wait(2000);
await shot('10-golf');
const golf = await p.evaluate(() => !!document.querySelector('canvas.game'));
check('Tiki Golf starts', golf);
});
await section('high scores', async () => { await go('Extras'); await go('High Scores'); await wait(800); await shot('11-scores'); });

// ---- Settings + About
await section('settings', async () => {
await go('Settings'); await shot('12-settings');
await go('About'); await wait(300); await shot('13-about');
const playback = await p.evaluate(() => fpDebug.ui().top.rows?.find((r) => r.label === 'Playback')?.value());
check('About shows playback mode', !!playback, playback);
});

// ---- Signed out: the sign-in screen
await p.evaluate(() => localStorage.removeItem('fp.session')); await p.reload(); await wait(1500);
await shot('14-signin');
const labels = await p.evaluate(() => fpDebug.ui().top.rows?.map((r) => r.label));
check('sign-in screen', Array.isArray(labels) && labels.some((l) => /Quick Connect/.test(l)), JSON.stringify(labels));

console.log(`===== ${name} (${await p.evaluate(() => navigator.userAgent)})`);
for (const c of checks) console.log(c);
console.log(problems.length ? `problems (${problems.length}):\n  ` + [...new Set(problems)].join('\n  ') : 'no page errors, console errors or failed requests');
await b.close();
