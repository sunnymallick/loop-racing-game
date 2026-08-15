/** Shortcut geometry per city: is a branch actually shorter than the road it replaces? */
import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  for (const city of ['la', 'vegas', 'miami', 'nyc']) {
    await load(h.page, { city, car: 'muscle' });
    const out = await h.page.evaluate(() => {
      const t = window.__GAME.game.city.track;
      return {
        L: Math.round(t.length), half: +t.halfWidth.toFixed(2),
        br: (t.branches || []).map((b) => {
          const span = ((b.exitU - b.enterU) % 1 + 1) % 1 * t.length;
          return {
            kind: b.kind, enterU: b.enterU, exitU: b.exitU,
            len: Math.round(b.length), main: Math.round(span),
            saveM: Math.round(span - b.length), hw: +b.halfWidth.toFixed(2),
          };
        }),
      };
    });
    console.log(`${city.padEnd(6)} L=${out.L}m half=${out.half}`);
    for (const b of out.br) {
      console.log(`   ${b.kind.padEnd(9)} u ${b.enterU}→${b.exitU}  branch=${b.len}m main=${b.main}m  saves ${b.saveM}m  halfWidth=${b.hw}`);
    }
  }
} finally { await h.close(); }
