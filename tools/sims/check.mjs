import './env.mjs';
import { COURSES } from '../../app/golf-holes.js';
const inPoly = (x, y, f) => { let c = false; for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) { const xi=f[i], yi=f[i+1], xj=f[j], yj=f[j+1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const segD = (x, y, [x1,y1,x2,y2]) => { const dx=x2-x1, dy=y2-y1; const t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy))); return Math.hypot(x-x1-t*dx, y-y1-t*dy); };
let bad = 0;
COURSES[Number(process.env.COURSE || 0)].holes.forEach((h, i) => {
  const segs = [];
  for (const g of h.greens) for (let k = 0; k < g.length; k += 2) { const n = (k + 2) % g.length; segs.push([g[k], g[k+1], g[n], g[n+1]]); }
  for (const w of h.walls || []) segs.push(w);
  const ok = (name, x, y, clear = 7) => {
    const on = h.greens.some((g) => inPoly(x, y, g));
    const wet = (h.water || []).some((p) => inPoly(x, y, p));
    const d = Math.min(...segs.map((s) => segD(x, y, s)));
    if (!on || wet || d < clear) { bad++; console.log(`hole ${i + 1} ${h.name}: ${name} (${x},${y}) on=${on} wet=${wet} wallDist=${d.toFixed(1)}`); }
  };
  ok('tee', ...h.tee); ok('cup', ...h.cup, 8);
  for (const t of h.tubes || []) { ok('tube in', ...t.from); const a = t.dir * Math.PI / 180; ok('tube out', t.to[0] + Math.cos(a) * 9, t.to[1] + Math.sin(a) * 9); }
  for (const m of h.moles || []) ok('mole', m.x, m.y, 9);
  for (const b of h.bumpers || []) ok('bumper', b.x, b.y, b.r + 4);
  for (const c of h.cranes || []) {
    const [px, py, pw, ph] = c.pad, [dx, dy, dw, dh] = c.drop;
    for (const [x, y] of [[px, py], [px + pw, py], [px, py + ph], [px + pw, py + ph]]) ok('pad corner', x, y, 3);
    for (const [x, y] of [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]]) ok('drop corner', x, y, 3);
    const rx = (h.cup[0] - dx) / dw, ry = (h.cup[1] - dy) / dh;
    console.log(`hole ${i + 1}: crane hole-in-one spot in pad = (${(px + rx * pw).toFixed(1)}, ${(py + ry * ph).toFixed(1)}) rel ${rx.toFixed(2)},${ry.toFixed(2)}`);
  }
});
console.log(bad ? `${bad} problems` : 'all placements OK', '| par total', COURSES[Number(process.env.COURSE || 0)].holes.reduce((a, h) => a + h.par, 0));
