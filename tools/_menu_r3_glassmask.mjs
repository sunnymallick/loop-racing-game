// Paint the glasshouse solid magenta so its exact screen coverage is unambiguous.
import path from 'node:path';
import { boot, open, scenario, capture, ROOT } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/menu-r3-mask');
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');
  for (const [tag, side] of [['double', 2], ['front', 0], ['back', 1]]) {
    await h.page.evaluate((s) => {
      const g = window.__GAME.game;
      g.car.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m && m.name === 'glass') {
            m.color.set('#ff00c8'); m.opacity = 1; m.transparent = false;
            m.clearcoat = 0; m.envMapIntensity = 0; m.side = s; m.needsUpdate = true;
          }
        }
      });
      g.render(1 / 60);
    }, side);
    await capture(h.page, path.join(OUT, `glass-${tag}.png`));
  }
} finally {
  await h.close();
}
