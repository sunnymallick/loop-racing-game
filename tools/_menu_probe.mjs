// MENU piece scratch probe: city switch inside the garage, swap transition frame, perf.
import path from 'node:path';
import { boot, open, scenario, capture, ROOT, errors } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/menu-r1');
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');

  // ---- switch the destination to Las Vegas from inside the garage
  await h.page.evaluate(async () => {
    const m = window.__GAME.game.menu;
    m.focus = 'city';
    m._move(1);
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < 90; i++) window.__GAME.game.update(1 / 60);
  });
  await capture(h.page, path.join(OUT, 'probe-city-vegas.png'));

  // ---- mid-swap frame (0.18 s after pressing right on the car column)
  await h.page.evaluate(() => {
    const g = window.__GAME.game;
    g.menu.focus = 'car';
    g.menu._move(1);
    for (let i = 0; i < 11; i++) g.update(1 / 60);
  });
  await capture(h.page, path.join(OUT, 'probe-swap.png'));

  // ---- settled on the new car
  await h.page.evaluate(() => {
    const g = window.__GAME.game;
    for (let i = 0; i < 80; i++) g.update(1 / 60);
  });
  await capture(h.page, path.join(OUT, 'probe-settled.png'));

  // ---- draw-call / triangle budget for the garage frame, and a menu fps sample
  const info = await h.page.evaluate(async () => {
    const g = window.__GAME.game;
    g.engine.renderer.info.reset();
    g.engine.renderer.render(g.engine.scene, g.engine.camera);
    const r = { ...g.engine.renderer.info.render };
    const t0 = performance.now();
    for (let i = 0; i < 24; i++) { g.update(1 / 60); g.render(1 / 60); await new Promise((k) => requestAnimationFrame(k)); }
    const menuFps = 24000 / (performance.now() - t0);
    // and the same measurement in a race, with the garage hidden
    await window.__GAME.load({ city: 'la', car: 'muscle' });
    await window.__GAME.scenario('chase');
    const t1 = performance.now();
    for (let i = 0; i < 24; i++) { g.update(1 / 60); g.render(1 / 60); await new Promise((k) => requestAnimationFrame(k)); }
    const raceFps = 24000 / (performance.now() - t1);
    return { menuFrame: r, menuFps: +menuFps.toFixed(2), raceFps: +raceFps.toFixed(2) };
  });
  console.log(JSON.stringify(info, null, 2));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
