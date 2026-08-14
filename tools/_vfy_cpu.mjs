// Verifier probe: split the frame into CPU update / CPU render-submit / wait.
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas')).split(',');
const CAR = arg('car', 'supercar');
const N = Number(arg('frames', 120));

const h = await boot({ gpu: true, width: 1600, height: 900 });
const gpu = await (async () => {
  await h.page.goto('about:blank');
  return h.page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const d = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(d.UNMASKED_RENDERER_WEBGL); });
})();
console.log('GPU:', gpu);

for (const city of CITIES) {
  await open(h.page, h.url, { city, car: CAR });
  if (typeof load === 'function') { try { await load(h.page, { city, car: CAR }); } catch { } }
  if (typeof scenario === 'function') { try { await scenario(h.page, 'chase'); } catch { } }
  const r = await h.page.evaluate(async (n) => {
    const g = window.__GAME.game;
    const e = g.engine;
    const up = [], rn = [], tot = [], fin = [];
    const gl = e.renderer.getContext();
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      if (i > 15) tot.push(t0 - last);
      last = t0;
      g.update(1 / 60);
      const t1 = performance.now();
      g.render(1 / 60);
      const t2 = performance.now();
      gl.finish();
      const t3 = performance.now();
      if (i > 15) { up.push(t1 - t0); rn.push(t2 - t1); fin.push(t3 - t2); }
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    // count scene objects
    let objs = 0, meshes = 0, visible = 0, lights = 0, skinned = 0;
    e.scene.traverse((o) => { objs++; if (o.isMesh) { meshes++; if (o.visible) visible++; } if (o.isLight) lights++; if (o.isSkinnedMesh) skinned++; });
    return {
      total: med(tot), update: med(up), render: med(rn), finish: med(fin),
      objs, meshes, visible, lights,
      calls: e.renderer.info.render.calls,
      shadowLights: e.scene.children.filter(c => c.isLight && c.castShadow).length,
    };
  }, N);
  console.log(`\n── ${city} ──`);
  console.log(`  frame total      ${r.total.toFixed(1)} ms   (${(1000 / r.total).toFixed(1)} fps)`);
  console.log(`  g.update() CPU   ${r.update.toFixed(1)} ms`);
  console.log(`  g.render() CPU   ${r.render.toFixed(1)} ms`);
  console.log(`  gl.finish() GPU  ${r.finish.toFixed(1)} ms`);
  console.log(`  scene: ${r.objs} objects, ${r.meshes} meshes (${r.visible} visible), ${r.lights} lights`);
}
await h.close();
