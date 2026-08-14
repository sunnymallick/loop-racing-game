import { boot, open, load, capture, scenario, ROOT } from './harness.mjs';
import path from 'node:path';
const OUT = process.argv[2];
const h = await boot({ width: 1600, height: 900 });
h.page.on('console', m => { if (m.type()==='error') console.log('[err]', m.text()); });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'chase');
  const step = async (n) => h.page.evaluate((n) => {
    const G = window.__GAME, game = G.game;
    for (let i = 0; i < n; i++) {
      game.input.setScripted({ throttle: 1, steer: 0.05, nitro: i > n*0.5 });
      game.update(1/60);
    }
    game.input.clearScripted();
    const t = G.telemetry();
    return { mph: t.mph, drift: t.drift, nitro: t.nitro, lap: t.lap, pos: t.pos,
             raceTime: game.race?.time ?? game.race?.elapsed ?? null,
             countdown: game.race?.countdown ?? null };
  }, n);
  for (let k = 0; k < 4; k++) {
    const info = await step(k === 0 ? 2 : 70);
    await capture(h.page, path.join(ROOT, OUT, `t${k}.png`), {});
    console.log(k, JSON.stringify(info));
  }
} finally { await h.close(); }
