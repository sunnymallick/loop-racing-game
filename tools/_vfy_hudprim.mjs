import { boot, open } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = arg('city', 'la');
const N = Number(arg('frames', 100));
const h = await boot({ gpu: true, width: 1600, height: 900 });
await open(h.page, h.url, { city: CITY, car: 'supercar' });
const r = await h.page.evaluate(async (n) => {
  const g = window.__GAME.game, hud = g.hud;
  const out = {}, counts = {};
  const run = async (label, setup, teardown) => {
    const u = setup ? setup() : null;
    const t = []; let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now(); if (i > 20) t.push(now - last); last = now;
      g.update(1 / 60); g.render(1 / 60);
    }
    if (teardown) teardown(u);
    const s = t.sort((a, b) => a - b);
    out[label] = 1000 / s[Math.floor(s.length / 2)];
  };
  const proto = CanvasRenderingContext2D.prototype;
  await run('baseline');

  // A: neutralise shadowBlur (setter no-op -> always 0)
  const sbDesc = Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
  await run('shadowBlur forced 0', () => {
    Object.defineProperty(proto, 'shadowBlur', { configurable: true, get: sbDesc.get, set() { sbDesc.set.call(this, 0); } });
  }, () => Object.defineProperty(proto, 'shadowBlur', sbDesc));

  // B: count primitive calls in one frame
  const names = ['fillText', 'strokeText', 'fill', 'stroke', 'fillRect', 'drawImage', 'createLinearGradient', 'createRadialGradient', 'save', 'beginPath', 'arc', 'measureText'];
  const orig = {};
  for (const nm of names) { orig[nm] = proto[nm]; counts[nm] = 0; proto[nm] = function (...a) { counts[nm]++; return orig[nm].apply(this, a); }; }
  let shadowSets = 0;
  Object.defineProperty(proto, 'shadowBlur', { configurable: true, get: sbDesc.get, set(v) { if (v > 0) shadowSets++; sbDesc.set.call(this, v); } });
  g.update(1 / 60); g.render(1 / 60);
  for (const nm of names) proto[nm] = orig[nm];
  Object.defineProperty(proto, 'shadowBlur', sbDesc);
  counts.shadowBlurSetsNonZero = shadowSets;

  return { out, counts };
}, N);
const base = r.out['baseline'];
console.log(`\n── HUD primitive probe (${CITY}) ──`);
for (const [k, v] of Object.entries(r.out)) console.log(`  ${k.padEnd(24)} ${v.toFixed(1)} fps` + (k === 'baseline' ? '' : `  (${v - base >= 0 ? '+' : ''}${(v - base).toFixed(1)})`));
console.log('\n  per-frame canvas2D calls:');
for (const [k, v] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(24)} ${v}`);
await h.close();
