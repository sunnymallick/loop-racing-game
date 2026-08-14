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
      const T = game.city.track, s = T.at(0.10);
      game.body.reset(s.pos.clone(), Math.atan2(s.tan.x, s.tan.z));
      game.race.playerU = 0.10; game._snapCamera();
      G.step(140, { throttle: 1 });
      G.step(40, { throttle: 1, steer: 0.8, handbrake: true });   // induce
      const peak = Math.abs(G.telemetry().slipDeg ?? 0);
      const maxD = G.telemetry().drift ?? 0;
      // now let go: throttle off, straighten
      const trail = [];
      for (let i = 0; i < 20; i++) { G.step(3, { throttle: 0.2, steer: 0 }); trail.push(+Math.abs(game.body.slipDeg??0).toFixed(1)); }
      return { peak, maxD, trail };
    });
    console.log(`${car.padEnd(9)} peak ${r.peak.toFixed(1)}°  drift ${r.maxD.toFixed(2)}  decay: ${r.trail.join(' ')}`);
  }
} finally { await h.close(); }
