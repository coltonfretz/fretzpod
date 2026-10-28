// Which Media Source formats each engine accepts (Fretzpod's stream player picks from these).
import { firefox, webkit, chromium } from 'playwright';
const types = ['audio/aac', 'audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"'];
for (const [name, engine] of [['firefox', firefox], ['webkit', webkit]]) {
  try {
    const b = await engine.launch();
    const p = await b.newPage();
    const r = await p.evaluate((types) => {
      const MS = window.MediaSource || window.ManagedMediaSource;
      return { ua: navigator.userAgent, ms: !!window.MediaSource, mms: !!window.ManagedMediaSource,
               support: Object.fromEntries(types.map((t) => [t, MS ? MS.isTypeSupported(t) : null])) };
    }, types);
    console.log(name, JSON.stringify(r));
    await b.close();
  } catch (e) { console.log(name, 'FAILED:', e.message.split('\n').slice(0, 3).join(' | ')); }
}
