import { boot, open, load, scenario } from './harness.mjs';
import * as fs from 'node:fs';

const W = 1600, H = 900, N = 90;
const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  await load(h.page, { city: 'la', car: 'supercar' });
  await scenario(h.page, 'chase');
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);

  const r = await h.page.evaluate(async (n) => {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const g = window.__GAME.game;
    const R = g.engine.renderer;
    const gl = R.getContext();
    const out = { notes: [] };

    async function loop(label, fn) {
      const t = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        if (i > 15) t.push(now - last);
        last = now;
        try { fn(); } catch (e) { out.notes.push(label + ': ' + e.message); }
      }
      out[label] = +mean(t).toFixed(2);
    }

    const emptyScene = Object.getPrototypeOf(g.engine.scene).constructor ? new (Object.getPrototypeOf(g.engine.scene).constructor)() : null;
    const cam = g.engine.camera;

    await loop('idle', () => {});
    await loop('renderer_render_emptyScene', () => { R.render(emptyScene, cam); });
    await loop('renderer_render_realScene_noPost', () => { R.render(g.engine.scene, cam); });

    // composer passes: list them
    out.passes = g.engine.composer.passes.map((p) => p.constructor.name + (p.enabled ? '' : '(off)'));
    out.rtSize = [g.engine.composer.renderTarget1.width, g.engine.composer.renderTarget1.height];

    // disable each composer pass one at a time
    const passes = g.engine.composer.passes;
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      if (!p.enabled) continue;
      p.enabled = false;
      await loop('no_' + i + '_' + p.constructor.name, () => { g.engine.render(1 / 60); });
      p.enabled = true;
    }
    await loop('all_passes_on', () => { g.engine.render(1 / 60); });

    // shadow maps off entirely
    R.shadowMap.enabled = false;
    await loop('shadowMap_disabled', () => { g.engine.render(1 / 60); });
    R.shadowMap.enabled = true;

    // count shadow-casting lights and their map sizes
    out.shadowLights = [];
    g.engine.scene.traverse((o) => {
      if (o.isLight && o.castShadow) out.shadowLights.push([o.type, o.shadow?.mapSize?.width, o.shadow?.mapSize?.height, o.shadow?.autoUpdate]);
    });

    return out;
  }, N);
  console.log(JSON.stringify(r, null, 1));
} finally { await h.close(); }
