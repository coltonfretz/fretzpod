// Media Source test: point it at a page that sets window.result (the 2026-10-27 page muxed two ffmpeg-made songs; see DESIGN.md "Other browsers and computers").
// Runs the Media Source test page in an engine and prints its result.
import { firefox, webkit, chromium } from 'playwright';
const engines = { firefox, webkit, chromium };
const name = process.argv[2], url = process.argv[3];
const b = await engines[name].launch({ firefoxUserPrefs: { 'media.autoplay.default': 0 } , ...(name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}) });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(url);
await p.waitForFunction(() => window.result && window.result.done, null, { timeout: 30000 }).catch(() => {});
console.log(name, JSON.stringify(await p.evaluate(() => window.result)));
await b.close();
