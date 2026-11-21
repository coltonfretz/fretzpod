// Software Update (the sideloaded Android app only; android Updater.java).
// The app looks for a newer version on the site it came from, at most every
// 6 hours while it's in use, and offers it once on the main menu; Later
// holds that version off for a day. Settings > About > Software Update
// checks by hand and installs.

const NATIVE = typeof window !== 'undefined' && window.FretzpodAndroid?.updateCan ? window.FretzpodAndroid : null;
let can = false;
try { can = !!NATIVE?.updateCan(); } catch { can = false; }
export const CAN_UPDATE = can;

const CHECKED = 'fp.updateChecked', LATER = 'fp.updateLater';
const EVERY = 6 * 3600e3, LATER_FOR = 24 * 3600e3;
const get = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not kept */ } };

// The latest news from the app: {state, version, code, current, pct, error}.
export let status = { state: 'idle' };

if (CAN_UPDATE) {
  window.fretzpodUpdate = (json) => {
    try { status = JSON.parse(json); } catch { return; }
    if (status.state === 'none' || status.state === 'available') put(CHECKED, Date.now());
    window.dispatchEvent(new CustomEvent('fp-update', { detail: status }));
  };
}

export function check() {
  try { NATIVE?.updateCheck(); } catch { /* no bridge */ }
}

export function install() {
  try { NATIVE?.updateInstall(); } catch { /* no bridge */ }
}

// For main.js: look again if it's been a while (or never).
export function checkIfDue() {
  if (CAN_UPDATE && Date.now() - (get(CHECKED) || 0) > EVERY) check();
}

// Whether to put Software Update on screen by itself for this news.
export function shouldOffer(s = status) {
  if (s.state !== 'available') return false;
  const l = get(LATER);
  return !(l && l.code === s.code && Date.now() < l.until);
}

export function later() {
  if (status.code) put(LATER, { code: status.code, until: Date.now() + LATER_FOR });
}

// One line on where things stand, for the screens.
export function describe(s = status) {
  switch (s.state) {
    case 'checking': return 'Checking';
    case 'none': return 'Up to Date';
    case 'available': return `${s.version} Available`;
    case 'downloading': return `Downloading ${s.pct || 0}%`;
    case 'installing': return 'Installing';
    case 'allow': return 'Allow, then Install';
    case 'failed': return 'Failed';
    default: return '';
  }
}
