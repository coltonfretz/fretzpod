// iPhone haptics (app/util.js vibrate()): in WebKit dressed as an iPhone,
// checks the switch trick is chosen, each tick toggles the hidden switch, and
// a pattern gives one tick per buzz. Whether the phone actually buzzes can
// only be felt on a real iPhone. Usage: node haptics-check.mjs <url of a page that sets window.u = util.js>
import { webkit, devices } from 'playwright';
const url = process.argv[2];
const b = await webkit.launch();
const ios18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const ios17 = ios18.replace(/18_6/, '17_5').replace('Version/18.6', 'Version/17.5');
for (const [name, opts] of [
  ['iPhone iOS 18', { ...devices['iPhone 15'], userAgent: ios18 }],
  ['iPhone iOS 17', { ...devices['iPhone 15'], userAgent: ios17 }],
  ['desktop Safari', devices['Desktop Safari']],
]) {
  const p = await (await b.newContext(opts)).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => window.u);
  const r = await p.evaluate(async () => {
    const out = { switchSupported: 'switch' in HTMLInputElement.prototype, canVibrate: window.u.canVibrate };
    out.single = window.u.vibrate(8);
    const box = document.querySelector('head label input[switch]');
    out.hiddenSwitch = !!box;
    if (!box) return out;
    let flips = 0;
    box.addEventListener('change', () => flips++);
    window.u.vibrate(14);
    out.afterOne = flips;
    window.u.vibrate([14, 70, 14]);
    await new Promise((r) => setTimeout(r, 300));
    out.afterPattern = flips - 1;
    out.focusStolen = document.activeElement === box;
    return out;
  });
  console.log(name, JSON.stringify(r), errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no page errors');
}
await b.close();
