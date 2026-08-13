// scratch A/B: render one scenario twice, with an arbitrary tweak applied in between.
import { boot, open, load, scenario, capture } from './harness.mjs';

const city = process.argv[2] || 'la';
const shot = process.argv[3] || 'landmark';
const tweak = process.argv[4] || 'g.engine.bloom.strength = 0;';
const out = process.argv[5] || '/tmp/ab';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city, car: 'supercar' });
  await load(h.page, { city, car: 'supercar' });
  await scenario(h.page, shot, {});
  await capture(h.page, `${out}-a.png`, { width: 1600, height: 900 });
  await h.page.evaluate((t) => { const g = window.__GAME.game; eval(t); }, tweak);
  await capture(h.page, `${out}-b.png`, { width: 1600, height: 900 });
  console.log(`${out}-a.png ${out}-b.png`);
} finally { await h.close(); }
