// Builder probe (nyc): landmark frame with the HUD hidden, so the hero's silhouette can be
// measured against the frame rather than against the countdown plate. Not shipped code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, scenario, ROOT } from './harness.mjs';

const OUT = process.argv[2] || 'shots/_nycprobe';
const CAR = process.argv[3] || 'muscle';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: CAR });
  await load(h.page, { city: 'nyc', car: CAR });
  await fs.mkdir(path.resolve(ROOT, OUT), { recursive: true });
  for (const shot of ['landmark', 'chase']) {
    await scenario(h.page, shot, {});
    await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [1600, 900]);
    await h.page.evaluate(() => window.__GAME.render());
    await h.page.evaluate(() => window.__GAME.render());
    await h.page.screenshot({ path: path.resolve(ROOT, OUT, `nohud-${shot}.png`), type: 'png' });
    await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = ''; });
  }
  console.log('probe written to', OUT);
} finally {
  await h.close();
}
