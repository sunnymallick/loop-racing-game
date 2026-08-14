#!/usr/bin/env node
/**
 * Private Miami smoke test — the coverage tools/functest.mjs --quick does not have (it only ever
 * loads LA). Loads Miami with every car, drives, brakes, steers, fires nitrous, and checks for
 * console errors, NaNs, and that the car is still on the road afterwards.
 */
import { boot, open, load } from './harness.mjs';

const h = await boot({ width: 1280, height: 720 });
const errors = [];
h.page.on('pageerror', (e) => errors.push(String(e.message)));
h.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let bad = 0;
try {
  await open(h.page, h.url, { city: 'miami', car: 'muscle' });
  for (const car of ['muscle', 'supercar', 'tuner', 'suv']) {
    await load(h.page, { city: 'miami', car });
    const r = await h.page.evaluate(async () => {
      const G = window.__GAME;
      const out = {};
      G.step(60, { throttle: 1 });
      out.afterThrottle = G.telemetry().speed;
      G.step(40, { throttle: 1, steer: 0.6 });
      out.afterSteer = G.telemetry().speed;
      G.step(30, { throttle: 1, nitro: true });
      const t = G.telemetry();
      out.nitroActive = t.nitro.active;
      out.afterNitro = t.speed;
      G.step(40, { brake: 1 });
      out.afterBrake = G.telemetry().speed;
      const g = G.game;
      const n = g.city.track.nearest(g.body.pos);
      out.lateral = +n.lateral.toFixed(2);
      out.finite = Number.isFinite(g.body.pos.x) && Number.isFinite(g.body.pos.y)
        && Number.isFinite(g.body.pos.z) && Number.isFinite(g.body.speed);
      G.render();
      return out;
    });
    // Brake is checked against the speed it was actually braking FROM (post-nitrous), not against
    // the pre-nitrous number — nitrous adds more than 40 frames of braking takes away.
    const ok = r.finite && r.afterThrottle > 5 && r.afterBrake < r.afterNitro && Math.abs(r.lateral) < 4;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} miami x ${car}  ${JSON.stringify(r)}`);
  }
} finally {
  await h.close();
}
console.log(errors.length ? `console errors:\n  ${errors.slice(0, 8).join('\n  ')}` : 'no console errors');
process.exit(bad || errors.length ? 1 : 0);
