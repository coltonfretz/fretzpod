// The dedicated players' phone bits (android Phone.java): with Fretzpod as
// the home screen there's no app drawer, so Extras has the flashlight and
// opens the phone's camera, photos, clock and calculator, and Settings has
// Phone Settings. Nothing here shows in a browser or on an ordinary phone.

const NATIVE = typeof window !== 'undefined' && window.FretzpodAndroid?.phoneHome ? window.FretzpodAndroid : null;
const call = (f, ...a) => { try { return NATIVE ? NATIVE[f](...a) : false; } catch { return false; } };

// Asked each time: dedicated.sh can make Fretzpod the home screen while it runs.
export const isHome = () => !!call('phoneHome');
export const hasTorch = () => !!call('phoneHasTorch');
export const torchOn = () => !!call('phoneTorch');
export const setTorch = (on) => !!call('phoneSetTorch', on);
export const open = (what) => !!call('phoneOpen', what);
