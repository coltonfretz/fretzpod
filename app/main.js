// Wires the pieces together: settings -> body color, the player, the wheel,
// the screen stack, sign-in/out, and the battery icon.
import * as api from './api.js';
import { settings, BITRATE } from './settings.js';
import { Player, streamType } from './player.js';
import { Wheel } from './wheel.js';
import { UI } from './ui.js';
import { CoverFlow } from './coverflow.js';
import { Output } from './speakers.js';
import { log } from './util.js';

const $ = (s) => document.querySelector(s);

function applyBody() { document.documentElement.dataset.body = settings.get('body'); }
applyBody();
window.addEventListener('fp-setting', (e) => { if (e.detail === 'body') applyBody(); });

const phone = new Player($('#audio'), {
  bitrate: () => BITRATE[settings.get('quality')],
  repeat: () => settings.get('repeat'),
});
// Everything else talks to `player`: the phone, or a Sonos once one is picked
// under Speakers (optional, allowed accounts only; speakers.js).
const player = new Output(phone, { repeat: () => settings.get('repeat') });

let ui = null;
const wheel = new Wheel($('#wheel'), $('#center'), {
  turn: (dir) => ui.turn(dir),
  press: (b) => ui.press(b),
  hold: (b) => ui.hold(b),
  holdEnd: (b) => ui.holdEnd(b),
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
function applyOrientation() {
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
// Test hook for the dev server only (Claude's browser pane has no rotation).
if (location.hostname === 'localhost') {
  window.fpDebug = {
    coverflow(on) { forceCoverFlow = on; applyOrientation(); },
    basic() { player.basic = true; },
    player: phone,
    ui: () => ui,
    // Tiki Golf: fpDebug.golf().startHole(6) jumps to hole 7.
    golf() { return ui.top; },
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
