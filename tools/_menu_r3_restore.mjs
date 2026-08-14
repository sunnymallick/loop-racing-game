// Does the showroom material pass put everything back? Read the glass + cabin materials before the
// garage is ever opened, then after a garage visit that ends in a race start.
import { boot, open, scenario, errors } from './harness.mjs';

const read = () => {
  const g = window.__GAME.game;
  const out = { glass: null, cabin: [] };
  g.car.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      if (m.name === 'glass' && !out.glass) {
        out.glass = {
          op: +m.opacity.toFixed(4), dw: m.depthWrite, side: m.side,
          col: '#' + m.color.getHexString(), rough: +m.roughness.toFixed(4),
          cc: m.clearcoat, ccr: +m.clearcoatRoughness.toFixed(4),
          env: +m.envMapIntensity.toFixed(4),
        };
      }
      if (m.userData.underRole === 'cabin' && out.cabin.length < 3) {
        out.cabin.push({ col: '#' + m.color.getHexString(), emis: +(m.emissiveIntensity || 0).toFixed(5) });
      }
    }
  });
  return out;
};

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  const before = await h.page.evaluate(read);
  await scenario(h.page, 'menu');
  const inGarage = await h.page.evaluate(read);
  // leave the garage the way the player does: hit select
  await h.page.evaluate(async () => {
    const g = window.__GAME.game;
    g.menu.focus = 'car'; g.menu._move(1);
    for (let i = 0; i < 90; i++) g.update(1 / 60);
    g.menu._start();
    for (let i = 0; i < 120; i++) g.update(1 / 60);
  });
  const after = await h.page.evaluate(read);
  console.log(JSON.stringify({ before, inGarage, after }, null, 2));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
