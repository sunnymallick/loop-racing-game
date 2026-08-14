/** Real-GPU A/B: what the opponents cost the frame, and what their nitrous costs on top. */
import { boot, open, load, scenario } from './harness.mjs';
const CITY = process.argv[2] || 'la';
const h = await boot({ width: 1600, height: 900, gpu: true });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const measure = async (mode) => h.page.evaluate(async (m) => {
    const g = window.__GAME.game;
    if (m === 'none') { g.startRace({ opponents: 0 }); g.race.state = 'racing'; g.race.countdown = 0; }
    else { g.startRace({ opponents: 7 }); g.race.state = 'racing'; g.race.countdown = 0; }
    g.race.reformPack(g.body, { speed: 60 });
    g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
    const times = [];
    let last = performance.now();
    for (let i = 0; i < 160; i++) {
      await new Promise((res) => requestAnimationFrame(res));
      const now = performance.now();
      if (i > 25) times.push(now - last);
      last = now;
      if (m === 'noboost') for (const d of g.race.drivers) { d.nitro.active = false; d.nitro.ramp = 0; d.nitro.flame = 0; d.boostCool = 99; }
      g.update(1 / 60);
      g.render(1 / 60);
    }
    g.input.clearScripted();
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return +(1000 / mean).toFixed(1);
  }, mode);
  const full = await measure('full');
  const noboost = await measure('noboost');
  const none = await measure('none');
  console.log(`${CITY}: 7 opponents ${full} fps · same but no AI nitrous ${noboost} fps · no opponents at all ${none} fps`);
} finally { await h.close(); }
