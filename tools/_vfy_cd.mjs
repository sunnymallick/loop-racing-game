import { boot, open, load, capture, ROOT } from './harness.mjs';
import path from 'node:path';
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  for (let k = 0; k < 4; k++) {
    const info = await h.page.evaluate((k) => {
      const G = window.__GAME, game = G.game;
      if (k === 0) { if (game.state==='menu'){game.menu.close();} game.startRace(); }
      else { for (let i=0;i<55;i++) game.update(1/60); }
      return { state: game.race?.state, countdown: game.race?.countdown, time: game.race?.time };
    }, k);
    await capture(h.page, path.join(ROOT, 'shots/_vfy_motion', `cd${k}.png`), {});
    console.log(k, JSON.stringify(info));
  }
} finally { await h.close(); }
