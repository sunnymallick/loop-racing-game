// MENU r2: the garage mutates pooled car materials — prove they are put back on close.
import { boot, open, scenario, errors } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
const snap = (page) => page.evaluate(() => {
  const g = window.__GAME.game;
  const out = [];
  g.car.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || m.name !== 'glass') continue;
      out.push({ o: +(m.opacity).toFixed(3), dw: m.depthWrite, c: m.color.getHexString(), ccr: m.clearcoatRoughness });
    }
  });
  const paint = g.car.userData.paintMaterial;
  return { glass: out, paintCcr: paint?.clearcoatRoughness, paintRough: paint?.roughness };
});
try {
  await open(h.page, h.url, { city: 'vegas', car: 'muscle' });
  const before = await snap(h.page);
  await scenario(h.page, 'menu');
  const during = await snap(h.page);
  // start a race the way the player does
  await h.page.evaluate(() => {
    const g = window.__GAME.game;
    g.menu._start();
  });
  await h.page.evaluate(async () => { for (let i = 0; i < 30; i++) window.__GAME.game.update(1 / 60); });
  const after = await snap(h.page);
  console.log(JSON.stringify({ before, during, after }, null, 1));
  console.log('menuOpen after start:', await h.page.evaluate(() => window.__GAME.game.menu.open_));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
