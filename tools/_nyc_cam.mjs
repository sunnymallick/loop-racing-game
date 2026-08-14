// Builder probe (nyc): how far off the centreline does the chase/drift rig actually swing?
// Anything parked inside that radius gets flown through. Not shipped code.
import { boot, open, load } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'muscle' });
  for (const car of ['muscle', 'supercar']) {
    await load(h.page, { city: 'nyc', car });
    for (const shot of ['chase', 'drift', 'nitrous']) {
      const info = await h.page.evaluate(async ([s]) => {
        await window.__GAME.scenario(s, {});
        const g = window.__GAME.game;
        if (!g) return null;
        const t = g.city.track;
        const cam = g.engine.camera.position.clone();
        const nc = t.nearest(cam);
        const nb = t.nearest(g.body.pos);
        return {
          camLat: +(nc.lateral * t.halfWidth).toFixed(2),
          camY: +cam.y.toFixed(2),
          bodyLat: +(nb.lateral * t.halfWidth).toFixed(2),
          u: +nb.u.toFixed(3),
          half: t.halfWidth,
          wallOffset: t.wallOffset,
        };
      }, [shot]);
      console.log(car, shot, JSON.stringify(info));
    }
  }
} finally {
  await h.close();
}
