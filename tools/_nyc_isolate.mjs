// Builder probe (nyc): hide one top-level city child at a time and re-shoot, to find which band
// owns the object filling the supercar chase frame. Not shipped code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, ROOT } from './harness.mjs';

const OUT = 'shots/_nyciso';
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'muscle' });
  await load(h.page, { city: 'nyc', car: 'muscle' });
  await fs.mkdir(path.resolve(ROOT, OUT), { recursive: true });
  const names = await h.page.evaluate(async () => {
    await window.__GAME.scenario('chase', {});
    const g = window.__GAME.game;
    return g.city.group.children.map((c, i) => `${i}:${c.name || c.type}:${c.children.length}`);
  });
  console.log(names.join('\n'));
  for (let i = 0; i < names.length; i++) {
    await h.page.evaluate((idx) => {
      const g = window.__GAME.game;
      g.city.group.children.forEach((c, k) => { c.visible = k !== idx; });
    }, i);
    await h.page.evaluate(() => { const u = document.getElementById('ui'); if (u) u.style.display = 'none'; });
    await h.page.evaluate(() => window.__GAME.render());
    await h.page.evaluate(() => window.__GAME.render());
    await h.page.screenshot({ path: path.resolve(ROOT, OUT, `hide-${i}.png`), type: 'png' });
  }
} finally {
  await h.close();
}
