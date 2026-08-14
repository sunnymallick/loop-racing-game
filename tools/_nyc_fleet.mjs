// Builder probe (nyc): stand in the road and photograph the parked fleet on one kerb.
// usage: node tools/_nyc_fleet.mjs <outdir> <side> <dist> <u,u,u...>
import fs from 'node:fs';
import { boot, open, load } from './harness.mjs';

const [outDir, sideS, distS, uListS] = process.argv.slice(2);
const side = Number(sideS ?? 1), dist = Number(distS ?? 20);
const us = String(uListS ?? '0.05').split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'muscle' });
  await load(h.page, { city: 'nyc', car: 'muscle' });
  for (const u of us) {
    await h.page.evaluate(async ([u, side, dist]) => {
      const g = window.__GAME.game;
      const t = g.city.track;
      const cam = g.engine.camera;
      const back = t.at((u - dist / t.length + 1) % 1);
      const here = t.at(u);
      cam.position.copy(back.pos)
        .addScaledVector(back.right, -side * (t.halfWidth * 0.55))
        .setY(back.pos.y + 2.1);
      const look = here.pos.clone().addScaledVector(here.right, side * (t.halfWidth + 7.0)).setY(1.5);
      cam.lookAt(look);
      cam.updateMatrixWorld(true);
      window.__GAME.render();
    }, [u, side, dist]);
    const f = `${outDir}/u${String(u).replace('.', '')}s${side > 0 ? 'r' : 'l'}.png`;
    fs.writeFileSync(f, await h.page.screenshot({ type: 'png' }));
    console.log('wrote', f);
  }
} finally {
  await h.close();
}
