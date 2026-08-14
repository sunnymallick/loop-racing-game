import { boot, open, load, scenario } from './harness.mjs';

const CITIES = ['la', 'vegas'];
const W = 1600, H = 900, N = 120;

const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  for (const city of CITIES) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);

    const r = await h.page.evaluate(async (n) => {
      const g = window.__GAME.game;
      g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });
      const upd = [], ren = [], tot = [], gap = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const raf = performance.now();
        if (i > 20) gap.push(raf - last);
        const a = performance.now();
        g.update(1 / 60);
        const b = performance.now();
        g.render(1 / 60);
        const c = performance.now();
        if (i > 20) { upd.push(b - a); ren.push(c - b); tot.push(c - a); }
        last = raf;
      }
      // now measure update-only (no render) and render-only
      const updOnly = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const a = performance.now(); g.update(1 / 60); updOnly.push(performance.now() - a);
      }
      const renOnly = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const a = performance.now(); g.render(1 / 60); renOnly.push(performance.now() - a);
      }
      g.input.clearScripted();
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const info = g.engine.renderer.info;
      let objs = 0, meshes = 0, inst = 0, pts = 0, lines = 0, lights = 0, spr = 0;
      g.engine.scene?.traverse?.((o) => {
        objs++;
        if (o.isInstancedMesh) inst++;
        else if (o.isMesh) meshes++;
        if (o.isPoints) pts++;
        if (o.isLine || o.isLineSegments) lines++;
        if (o.isLight) lights++;
        if (o.isSprite) spr++;
      });
      return {
        rafGap: mean(gap), update: mean(upd), render: mean(ren), total: mean(tot),
        updateOnly: mean(updOnly), renderOnly: mean(renOnly),
        objs, meshes, inst, pts, lines, lights, spr,
        geometries: info.memory.geometries, textures: info.memory.textures,
        programs: g.engine.renderer.info.programs?.length ?? -1,
      };
    }, N);
    console.log(city, JSON.stringify(r, null, 1));
  }
} finally { await h.close(); }
