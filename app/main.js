// Wires the pieces together: settings -> body color, the player, the wheel,
// the screen stack, sign-in/out, and the battery icon.
import * as api from './api.js';
import { settings, BITRATE } from './settings.js';
import { Player, streamType } from './player.js';
import { Wheel } from './wheel.js';
import { UI } from './ui.js';
import { CoverFlow } from './coverflow.js';
import { CarMode } from './carmode.js';
import { Output } from './speakers.js';
import { log } from './util.js';
import { applyBodyExtras } from './bodies.js';
import { Sleep } from './sleep.js';

const $ = (s) => document.querySelector(s);

function applyBody() {
  const body = settings.get('body');
  document.documentElement.dataset.body = body;
  applyBodyExtras(body);   // a gold body's emblem, the clear case's insides (bodies.js)
}
applyBody();
window.addEventListener('fp-setting', (e) => { if (e.detail === 'body') applyBody(); });

// Settings > Screen: light or dark menus (pod.css "dark screen").
const NIGHT_FROM = 20;   // 8 PM
const NIGHT_TO = 7;      // 7 AM
const phoneDark = matchMedia('(prefers-color-scheme: dark)');
function applyScreen() {
  const v = settings.get('screen');
  const h = new Date().getHours();
  const dark = v === 'dark' || (v === 'night' && (h >= NIGHT_FROM || h < NIGHT_TO)) || (v === 'phone' && phoneDark.matches);
  document.documentElement.dataset.screen = dark ? 'dark' : 'light';
}
applyScreen();
window.addEventListener('fp-setting', (e) => { if (e.detail === 'screen') applyScreen(); });
phoneDark.addEventListener('change', applyScreen);
// At Night turns over on the hour; a minute's check catches it, and a phone
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
  press: (b) => awake() && target().press(b),
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

ui = new UI($('#screen'), { player, wheel, onPassword: showPassword });
window.addEventListener('fp-signin', () => ui.reset(ui.home()));
window.addEventListener('fp-signout', () => { player.stop(); ui.reset(ui.signIn()); });
ui.reset(api.getSession() ? ui.home() : ui.signIn());

// ---------- Cover Flow: a touch phone turned sideways ----------

// pointer: coarse keeps it to phones and tablets; a PC window is "landscape"
// too, and friends on a computer should get the iPod, not a wall of covers.
const sideways = matchMedia('(orientation: landscape) and (pointer: coarse)');
let forceCoverFlow = false;
const cf = new CoverFlow($('#coverflow'), {
  play: (items, i) => ui.playSongs(items, i),
  tick: () => wheel.feedback(),
});
// Car mode (Settings > In the car) wins over everything: half of a split screen
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
if ('serviceWorker' in navigator && window.isSecureContext && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch((e) => log(`service worker: ${e.message}`));
}

log(`opened v${api.VERSION} (${streamType ? streamType.mime : 'no stream support'}, ${api.AWAY ? 'away' : 'home'})`);
