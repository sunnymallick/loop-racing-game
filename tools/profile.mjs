#!/usr/bin/env node
/**
 * Where is the frame going? Ablates the post-processing chain and the scene one layer at a time
 * on the REAL GPU, so an optimisation pass has numbers to aim at instead of guesses.
 *
 *   node tools/profile.mjs --city vegas
 */
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas')).split(',');
const CAR = arg('car', 'supercar');
const FRAMES = Number(arg('frames', 90));
const W = 1600, H = 900;

async function measure(page, frames, mutate) {
  return page.evaluate(async ([n, mutName, W, H]) => {
    const g = window.__GAME.game;
    const e = g.engine;
    // renderer.info.reset() runs at the end of Engine.render(), so reading after a render gives
    // zeros. This used to suppress reset() outright for the whole sample — which made every
    // printed count a SUM over all N frames, overstating draw calls by ~100x and inventing a
    // draw-call crisis that did not exist. Instead, let reset() run as normal and sample the
    // counters the instant before it fires, giving a true PER-FRAME number.
    const realReset = e.renderer.info.reset.bind(e.renderer.info);
    const callSamples = [], triSamples = [];
    e.renderer.info.reset = () => {
      callSamples.push(e.renderer.info.render.calls);
      triSamples.push(e.renderer.info.render.triangles);
      realReset();
    };

    const saved = {
      post: e.postEnabled,
      passes: e.composer.passes.map((p) => p.enabled),
    };
    const byName = (frag) => e.composer.passes.filter((p) => (p.constructor.name + (p.material?.name || '')).toLowerCase().includes(frag));

    if (mutName === 'nopost') e.postEnabled = false;
    if (mutName === 'nobloom') for (const p of byName('bloom')) p.enabled = false;
    if (mutName === 'nospill') for (const p of byName('spill')) p.enabled = false;
    if (mutName === 'nosmaa') for (const p of byName('smaa')) p.enabled = false;
    if (mutName === 'noatmos') for (const p of byName('atmos')) p.enabled = false;
    if (mutName === 'noshadow') e.renderer.shadowMap.enabled = false;
    if (mutName === 'half') e.resize(W / 2, H / 2);
    // The 2D HUD is drawn to a separate overlay canvas and never touches WebGL, so every ablation
    // above is blind to it. Without these two rows this profiler will happily report that nothing
    // in the renderer costs anything and leave you with no idea where the frame went.
    let hudDraw = null, blurDesc = null;
    if (mutName === 'nohud') { hudDraw = g.hud.draw; g.hud.draw = () => {}; }
    if (mutName === 'noblur') {
      // Neutralise canvas2D shadowBlur everywhere without editing the HUD source.
      const proto = Object.getPrototypeOf(g.hud.ctx);
      blurDesc = Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
      Object.defineProperty(g.hud.ctx, 'shadowBlur', { configurable: true, get: () => 0, set: () => {} });
    }

    g.input.setScripted({ throttle: 1, steer: 0.05, nitro: false });
    const times = [];
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      if (i > 15) times.push(now - last);
      last = now;
      g.update(1 / 60);
      g.render(1 / 60);
    }
    const median = (a) => {
      if (!a.length) return 0;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length / 2)];
    };
    const info = {
      calls: median(callSamples),
      tris: median(triSamples),
      geometries: e.renderer.info.memory.geometries,
      textures: e.renderer.info.memory.textures,
      programs: e.renderer.info.programs?.length ?? -1,
    };
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;

    // restore
    e.postEnabled = saved.post;
    e.composer.passes.forEach((p, i) => { p.enabled = saved.passes[i]; });
    e.renderer.shadowMap.enabled = true;
    e.renderer.info.reset = realReset;
    if (hudDraw) g.hud.draw = hudDraw;
    if (blurDesc) delete g.hud.ctx.shadowBlur;
    g.input.clearScripted();
    return { fps: 1000 / mean, ms: mean, ...info };
  }, [frames, mutate, W, H]);
}

const MUTATIONS = [
  ['baseline', null],
  ['no post chain', 'nopost'],
  ['no bloom', 'nobloom'],
  ['no emissive spill', 'nospill'],
  ['no SMAA', 'nosmaa'],
  ['no atmosphere', 'noatmos'],
  ['no shadows', 'noshadow'],
  ['half resolution', 'half'],
  ['no HUD (2D overlay)', 'nohud'],
  ['no canvas shadowBlur', 'noblur'],
];

async function main() {
  const h = await boot({ gpu: true, width: W, height: H });
  try {
    await open(h.page, h.url, { city: CITIES[0], car: CAR });
    const gpu = await h.page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log(`GPU: ${gpu}\nViewport: ${W}x${H}   bar: 50 fps\n`);

    for (const city of CITIES) {
      await load(h.page, { city, car: CAR });
      await scenario(h.page, 'chase');
      console.log(`── ${city} ──`);
      let base = null;
      for (const [label, mut] of MUTATIONS) {
        await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
        const r = await measure(h.page, FRAMES, mut);
        if (!base) base = r.fps;
        const delta = mut ? `  (${r.fps > base ? '+' : ''}${(r.fps - base).toFixed(1)} fps)` : '';
        console.log(`  ${label.padEnd(20)} ${r.fps.toFixed(1).padStart(6)} fps   ${r.ms.toFixed(1).padStart(6)} ms${delta}`);
        if (!mut) {
          console.log(`  ${''.padEnd(20)} ${r.calls} draw calls/frame · ${(r.tris / 1000).toFixed(0)}k tris/frame · ${r.geometries} geo · ${r.textures} tex · ${r.programs} shaders`);
        }
      }
      console.log('');
    }
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
