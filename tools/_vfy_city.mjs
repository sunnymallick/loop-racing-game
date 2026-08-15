import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, scenario, capture } from './harness.mjs';
const OUT = process.argv[2];
await fs.mkdir(OUT, { recursive: true });
const h = await boot({ gpu: false, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'muscle' });
  const info = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    return {
      branches: (g.city.track.branches || []).map((b, i) => ({ i, u0: b.enterU, u1: b.exitU, kind: b.kind })),
      keys: Object.keys(g.city.track),
      landmarkU: g.city.landmarkU,
    };
  });
  console.log('NYC', JSON.stringify(info));
    for (const b of info.branches) {
    const u = ((b.u0 - 0.020) % 1 + 1) % 1;
    await scenario(h.page, 'landmark', { u });
    await capture(h.page, path.join(OUT, `nyc-branch${b.i}-${b.kind}.png`));
  }
} finally { await h.close(); }
