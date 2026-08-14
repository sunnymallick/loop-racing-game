import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  for (const car of ['tuner','muscle','suv','supercar']) {
    await load(h.page, { city: 'la', car });
    const r = await h.page.evaluate(() => {
      const G = window.__GAME, game = G.game;
      if (game.state === 'menu') { game.menu.close(); game.startRace(); }
      game.race.state = 'racing'; game.race.countdown = 0;
      const T = game.city.track;
      const run = (sign, u) => {
        const s = T.at(u);
        game.body.reset(s.pos.clone(), Math.atan2(s.tan.x, s.tan.z));
        if (game.race) game.race.playerU = u;
        game._snapCamera();
        G.step(120, { throttle: 1 });
        const y0 = game.body.yaw, v0 = game.body.speed;
        G.step(50, { throttle: 1, steer: sign });
        // unwrap
        let dy = game.body.yaw - y0;
        while (dy > Math.PI) dy -= 2*Math.PI; while (dy < -Math.PI) dy += 2*Math.PI;
        return { dy, v0, lat: T.nearest(game.body.pos, null).lateral };
      };
      // same u for both directions, and a second u as a control
      return { a: { r: run(1, 0.10), l: run(-1, 0.10) },
               b: { r: run(1, 0.55), l: run(-1, 0.55) } };
    });
    for (const k of ['a','b']) {
      const R = r[k].r, L = r[k].l;
      const mn = Math.min(Math.abs(R.dy), Math.abs(L.dy)), mx = Math.max(Math.abs(R.dy), Math.abs(L.dy));
      console.log(`${car.padEnd(9)} u=${k}  right ${R.dy.toFixed(3)} (v0 ${R.v0.toFixed(0)})  left ${L.dy.toFixed(3)} (v0 ${L.v0.toFixed(0)})  ratio ${(mn/mx).toFixed(2)}`);
    }
  }
} finally { await h.close(); }
