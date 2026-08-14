#!/usr/bin/env node
/** Draw-call ablation: what do the 8 cars cost, and which part of a car? */
import { boot, open, scenario } from './harness.mjs';

const h = await boot({ gpu: false, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: process.argv[2] || 'la', car: 'muscle' });
  await scenario(h.page, 'chase');
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const e = g.engine;
    const cars = [g.car, ...(g.aiCars || [])].filter(Boolean);
    const realReset = e.renderer.info.reset.bind(e.renderer.info);
    e.renderer.info.reset = () => {};
    const sample = () => {
      e.renderer.info.render.calls = 0; e.renderer.info.render.triangles = 0;
      g.render(1 / 60);
      return { calls: e.renderer.info.render.calls, tris: e.renderer.info.render.triangles };
    };
    const setVis = (pred, v) => { for (const c of cars) c.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && pred(o, c)) o.visible = v; }); };
    const named = (o, c, name) => { let p = o; while (p && p !== c) { if (p.name === name) return true; p = p.parent; } return false; };

    const res = {};
    res.baseline = sample();
    setVis(() => true, false); res.noCars = sample(); setVis(() => true, true);
    setVis((o, c) => ['FL', 'FR', 'RL', 'RR'].some((n) => named(o, c, n)), false);
    res.noWheels = sample();
    setVis((o, c) => ['FL', 'FR', 'RL', 'RR'].some((n) => named(o, c, n)), true);
    setVis((o, c) => named(o, c, 'body'), false); res.noBodies = sample(); setVis((o, c) => named(o, c, 'body'), true);
    setVis((o) => o.name === 'glow' || o.material?.emissiveIntensity > 1, false); res.noLights = sample();
    setVis((o) => o.name === 'glow' || o.material?.emissiveIntensity > 1, true);
    // visible mesh census in the cars
    let vis = 0, tot = 0;
    for (const c of cars) c.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { tot++; if (o.visible) vis++; } });
    res.carMeshes = { visible: vis, total: tot };
    e.renderer.info.reset = realReset;
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await h.close(); }
