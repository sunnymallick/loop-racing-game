import { boot, open, scenario, load } from './harness.mjs';
const h = await boot({ gpu: true, width: 1600, height: 900 });
const city = process.argv[2] || 'la';
try {
  await open(h.page, h.url, { city, car: 'supercar' });
  await load(h.page, { city, car: 'supercar' });
  await scenario(h.page, 'chase');
  const out = await h.page.evaluate(async () => {
    const g = window.__GAME.game, e = g.engine;
    const run = async (fn, n = 70) => {
      let last = performance.now(); const t = [];
      for (let i = 0; i < n; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now(); if (i > 18) t.push(now - last); last = now;
        fn(i);
      }
      t.sort((a, b) => a - b);
      return +(1000 / (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1);
    };
    g.input.setScripted({ throttle: 1, steer: 0.05, nitro: false });
    const res = {};
    res.full = await run(() => { g.update(1 / 60); g.render(1 / 60); });
    res.noHudDraw = await run(() => { g.update(1 / 60); e.render(1 / 60); });
    res.hudEvery4 = await run((i) => { g.update(1 / 60); e.render(1 / 60); if (i % 4 === 0) g.hud.draw(g.hudState(), 1 / 60); });
    res.hudOnly = await run(() => { g.hud.draw(g.hudState(), 1 / 60); });
    res.full2 = await run(() => { g.update(1 / 60); g.render(1 / 60); });
    // time the JS side of hud.draw
    let acc = 0;
    for (let i = 0; i < 30; i++) { const a = performance.now(); g.hud.draw(g.hudState(), 1 / 60); acc += performance.now() - a; }
    res.hudDrawJsMs = +(acc / 30).toFixed(2);
    g.input.clearScripted();
    return res;
  });
  console.log((process.argv[2] || 'la') + ' ' + JSON.stringify(out));
} finally { await h.close(); }
