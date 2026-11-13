// Wires the pieces together: settings -> body color, the player, the wheel,
// the screen stack, sign-in/out, and the battery icon.
import * as api from './api.js';
import { settings, BITRATE, inHours } from './settings.js';
import { Player, streamType } from './player.js';
import { Wheel } from './wheel.js';
import { UI } from './ui.js';
import { CoverFlow } from './coverflow.js';
import { CarMode } from './carmode.js';
import { Output } from './speakers.js';
import { log } from './util.js';
import { applyBodyExtras } from './bodies.js';
import { Sleep } from './sleep.js';
import { Alarms } from './alarms.js';

const $ = (s) => document.querySelector(s);

function applyBody() {
  const root = document.documentElement;
  const body = settings.get('body');
  root.dataset.body = body;
  applyBodyExtras(body);   // a gold body's emblem, the clear case's insides (bodies.js)
  // Settings > Wheel, except on a prize body (gold, clear), whose wheel is
  // part of the prize; Settings > Selection on every body (pod.css).
  const wheel = settings.get('wheel');
  if (wheel === 'body' || prizeBody(body)) delete root.dataset.wheel; else root.dataset.wheel = wheel;
  root.dataset.accent = settings.get('accent');
}
const prizeBody = (b) => b.startsWith('gold') || b === 'clear';
applyBody();
window.addEventListener('fp-setting', (e) => { if (['body', 'wheel', 'accent'].includes(e.detail)) applyBody(); });

// Settings > Screen: light or dark menus (pod.css "dark screen").
const phoneDark = matchMedia('(prefers-color-scheme: dark)');
function applyScreen() {
  const v = settings.get('screen');
  const dark = v === 'dark' || (v === 'night' && inHours('darkFrom', 'darkTo')) || (v === 'phone' && phoneDark.matches);
  document.documentElement.dataset.screen = dark ? 'dark' : 'light';
}
applyScreen();
window.addEventListener('fp-setting', (e) => { if (['screen', 'darkFrom', 'darkTo'].includes(e.detail)) applyScreen(); });
phoneDark.addEventListener('change', applyScreen);
// Scheduled turns over at its times; a minute's check catches it, and a phone
// waking from sleep fires visibilitychange before anyone looks.
setInterval(applyScreen, 60000);
document.addEventListener('visibilitychange', applyScreen);

const phone = new Player($('#audio'), {
  bitrate: () => BITRATE[settings.get('quality')],
  repeat: () => settings.get('repeat'),
});
// Everything else talks to `player`: the phone, or a Sonos once one is picked
// under Speakers (optional, allowed accounts only; speakers.js).
const player = new Output(phone, { repeat: () => settings.get('repeat') });

let ui = null;
let car = null;
let sleep = null;
// Keys (and the iPod wheel, though car mode covers it) go to car mode while it shows.
const target = () => (car && !car.root.hidden ? car : ui);
// The touch that wakes the sleep screen only wakes it (sleep.js).
const awake = () => !sleep?.swallow();
const wheel = new Wheel($('#wheel'), $('#center'), {
  turn: (dir) => awake() && target().turn(dir),
  // Play/Pause still works on the touch that wakes it (sleep.js).
  press: (b) => (b === 'play' || awake()) && target().press(b),
  hold: (b) => awake() && target().hold(b),
  holdEnd: (b) => awake() && target().holdEnd(b),
  raw: () => target().raw?.() === true,
  down: (b) => awake() && target().down?.(b),
  up: (b) => awake() && target().up?.(b),
}, {
  clicker: () => settings.get('clicker') === 'on',
  haptics: () => settings.get('haptics'),
});
wheel.keys($('#pod'));

// ---------- password sign-in (a real form; typing with a wheel is no fun) ----------

const overlay = $('#pw-overlay');
const form = $('#pw-form');
$('#server-name').textContent = api.SERVER_NAME;
function showPassword() {
  overlay.hidden = false;
  $('#pw-error').textContent = '';
  $('#pw-user').focus();
}
$('#pw-cancel').addEventListener('click', () => { overlay.hidden = true; });
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#pw-pass');
  try {
    await api.passwordSignIn($('#pw-user').value, pass.value);
    overlay.hidden = true;
  } catch (err) {
    $('#pw-error').textContent = err.message.startsWith('401') ? 'Wrong username or password.' : `Couldn't sign in: ${err.message}`;
  } finally {
    pass.value = '';
  }
});

// ---------- the app build: which server (api.js BYOS) ----------

const srvOverlay = $('#srv-overlay');
const srvAddr = $('#srv-addr');
function showServer() {
  srvOverlay.hidden = false;
  $('#srv-error').textContent = '';
  srvAddr.value = api.hasServer() ? api.JF.replace(/^https:\/\//, '') : '';
  srvAddr.focus();
}
$('#srv-cancel').addEventListener('click', () => { srvOverlay.hidden = true; });
$('#srv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#srv-go');
  go.disabled = true;
  $('#srv-error').textContent = 'Looking…';
  try {
    api.useServer(await api.findServer(srvAddr.value));
    srvOverlay.hidden = true;
  } catch (err) {
    $('#srv-error').textContent = err.message;
  } finally {
    go.disabled = false;
  }
});

ui = new UI($('#screen'), { player, wheel, onPassword: showPassword, onServer: showServer });
window.addEventListener('fp-signin', () => ui.reset(ui.home()));
window.addEventListener('fp-signout', () => { player.stop(); ui.reset(ui.signIn()); });
window.addEventListener('fp-server', () => {
  $('#server-name').textContent = api.SERVER_NAME;
  if (!api.getSession()) ui.reset(ui.signIn());
});

// Signed in but the server doesn't answer (down, or the phone is offline):
// say so, over whatever was showing, instead of menus that each fail on
// their own. Checked at startup, on coming back to the app (a phone keeps
// it running for days), when the phone goes offline, and when a menu fails
// to load. Closes itself, and reloads what failed, once the server answers.
let downScreen = null;
let checking = false;
async function checkServer(pressed = false) {
  if (checking || !api.getSession()) return;
  checking = true;
  const up = await api.reachable();
  checking = false;
  if (up) {
    if (downScreen && ui.top === downScreen) {
      downScreen = null;
      ui.leaveTop();
      ui.top?.retry?.();
    }
    return;
  }
  if (!api.getSession()) return;
  if (downScreen && ui.stack.includes(downScreen)) {
    if (pressed) ui.toast(`Still can't reach ${api.SERVER_NAME}`);
    return;
  }
  log("server didn't answer");
  downScreen = ui.unreachable(() => checkServer(true));
  ui.push(downScreen);
}
window.addEventListener('online', checkServer);
window.addEventListener('offline', checkServer);
window.addEventListener('fp-loadfail', checkServer);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkServer(); });

if (api.getSession()) {
  ui.reset(ui.home());
  checkServer();
} else {
  ui.reset(ui.signIn());
}

// ---------- Cover Flow: a touch phone turned sideways ----------

// pointer: coarse keeps it to phones and tablets; a PC window is "landscape"
// too, and friends on a computer should get the iPod, not a wall of covers.
const sideways = matchMedia('(orientation: landscape) and (pointer: coarse)');
let forceCoverFlow = false;
const cf = new CoverFlow($('#coverflow'), {
  play: (items, i) => ui.playSongs(items, i),
  tick: () => wheel.feedback(),
});
// Car mode (Settings > In the Car) wins over everything: half of a split screen
// is often wider than tall, which would otherwise read as "sideways" and open
// Cover Flow next to Maps.
car = new CarMode($('#car'), {
  player,
  feedback: (press) => wheel.feedback(press),
  onChange: () => applyOrientation(),
});
window.addEventListener('fp-car', (e) => car.set(e.detail));
function applyOrientation() {
  if (car.on && api.getSession()) {
    document.body.classList.remove('cf-on');
    cf.hide();
    car.show();
    return;
  }
  car.hide();
  const on = (sideways.matches || forceCoverFlow) && !!api.getSession();
  // Watching TV, sideways means a full-screen picture instead of Cover Flow.
  const tv = ui.top?.setFull ? ui.top : null;
  if (tv) {
    document.body.classList.remove('cf-on');
    cf.hide();
    tv.setFull(on);
    return;
  }
  document.body.classList.toggle('cf-on', on);
  if (on) cf.show(); else cf.hide();
}
sideways.addEventListener('change', applyOrientation);
window.addEventListener('fp-orient', applyOrientation);   // TV opened or closed
window.addEventListener('fp-signin', applyOrientation);
window.addEventListener('fp-signout', applyOrientation);
window.addEventListener('resize', () => cf.resize());
applyOrientation();

sleep = new Sleep($('#screen'), player, {
  calm: () => ui.calm() && !car.on && !document.body.classList.contains('cf-on'),
  reading: () => ui.reading() && !car.on,
});
window.addEventListener('fp-sleep', () => sleep.showClock());

// Extras > Alarms: the alarm wakes the screen and starts its music; the
// sleep timer stops the music (alarms.js).
ui.alarms = new Alarms(player, {
  wake: () => sleep.wake(),
  start: (plays) => ui.alarmMusic(plays),
});

// Test hook for the dev server only (Claude's browser pane has no rotation).
if (location.hostname === 'localhost') {
  window.fpDebug = {
    coverflow(on) { forceCoverFlow = on; applyOrientation(); },
    basic() { player.basic = true; },
    player: phone,
    ui: () => ui,
    // Tiki Golf: fpDebug.golf().startHole(6) jumps to hole 7.
    golf() { return ui.top; },
    sleep: () => sleep,
    alarms: () => ui.alarms,
  };
}

// ---------- battery icon ----------

// navigator.getBattery only exists on https pages in Chrome; on the home copy
// the icon simply stays hidden.
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const icon = $('.bar-batt');
    const fill = icon.querySelector('.batt-fill');
    const upd = () => {
      icon.hidden = false;
      fill.style.width = `${Math.round(b.level * 100)}%`;
      icon.classList.toggle('low', b.level < 0.2 && !b.charging);
    };
    upd();
    b.addEventListener('levelchange', upd);
    b.addEventListener('chargingchange', upd);
  }).catch(() => {});
}

// Installable app + offline shell. Browsers only allow service workers on
// https, so a plain http copy of the app skips it.
// The app build carries its files inside the app already.
if ('serviceWorker' in navigator && window.isSecureContext && location.hostname !== 'localhost' && !api.BYOS) {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`service worker: ${e.message}`));
}

log(`opened v${api.VERSION} (${streamType ? streamType.mime : 'no stream support'}, ${api.AWAY ? 'away' : 'home'})`);
