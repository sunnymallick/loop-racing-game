/** CPU cost of the race piece: game.update() with 7 opponents vs with none. */
import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 640, height: 360 });
const city = process.argv[2] || 'la';
try {
  await open(h.page, h.url, { city, car: 'muscle' });
  await load(h.page, { city, car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const t = G.city.track;
    const drive = () => {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + 0.01);
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      G.input.setScripted({ steer: clamp(-ang * 2, -1, 1), throttle: 1, brake: 0, nitro: false, handbrake: false });
    };
    const run = (n) => {
      for (let i = 0; i < 90; i++) { drive(); G.update(1 / 60); }         // warm
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { drive(); G.update(1 / 60); }
      return (performance.now() - t0) / n;
    };
    G.startRace({ opponents: 7 });
    G.race.state = 'racing'; G.race.countdown = 0;
    const with7 = run(600);
    G.startRace({ opponents: 0 });
    G.race.state = 'racing'; G.race.countdown = 0;
    const with0 = run(600);
    return { with7: +with7.toFixed(3), with0: +with0.toFixed(3) };
  });
  console.log(`${city}: update() ${out.with7} ms with 7 opponents, ${out.with0} ms with none → race piece ${(out.with7 - out.with0).toFixed(3)} ms/frame`);
} finally { await h.close(); }
