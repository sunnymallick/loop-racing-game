// MENU r2: confirm the garage glazing treatment reached every pooled glass material (hero + tiles).
import { boot, open, scenario, errors } from './harness.mjs';

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'vegas', car: 'muscle' });
  await scenario(h.page, 'menu');
  const info = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const m = g.menu;
    const out = { touched: (m._matTouched || []).length, rows: [] };
    for (const rec of m._matTouched || []) {
      out.rows.push({
        name: rec.m.name, type: rec.m.type,
        now: { o: +(rec.m.opacity ?? 1).toFixed(3), dw: rec.m.depthWrite, c: rec.m.color?.getHexString?.(), env: +(rec.m.envMapIntensity ?? 0).toFixed(2), ccr: rec.m.clearcoatRoughness, r: rec.m.roughness },
        saved: Object.fromEntries(Object.entries(rec.props).map(([k, v]) => [k, v?.getHexString ? v.getHexString() : v])),
      });
    }
    out.thumbs = Object.keys(m.thumbs || {});
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
