// Verifier probe: ablate the 2D HUD overlay and the WebGL scene independently.
import { boot, open, load, scenario } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITIES = String(arg('cities', 'la,vegas')).split(',');
const CAR = arg('car', 'supercar');
const N = Number(arg('frames', 110));

const h = await boot({ gpu: true, width: 1600, height: 900 });
for (const city of CITIES) {
  await open(h.page, h.url, { city, car: CAR });
  const r = await h.page.evaluate(async (n) => {
    const g = window.__GAME.game;
    const e = g.engine;
    const hud = g.hud;
    const out = {};
    const run = async (label, setup, teardown) => {
      const undo = setup ? setup() : null;
      const t = [];
      let last = performance.now();
      for (let i = 0; i < n; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        if (i > 20) t.push(now - last);
        last = now;
        g.update(1 / 60);
        g.render(1 / 60);
      }
      if (teardown) teardown(undo);
      const s = t.sort((a, b) => a - b);
      out[label] = 1000 / s[Math.floor(s.length / 2)];
    };

    await run('baseline');

    // 1. HUD draw off entirely
    const realDraw = hud.draw.bind(hud);
    await run('no HUD draw', () => { hud.draw = () => { }; }, () => { hud.draw = realDraw; });

    // 2. HUD drawn but no supersample buffer (draw straight to visible canvas at dpr)
    await run('HUD, no supersample', () => {
      const b = hud.bctx; const bs = hud.scale;
      hud.bctx = null; hud.scale = hud.dpr; return [b, bs];
    }, ([b, bs]) => { hud.bctx = b; hud.scale = bs; });

    // 3. WebGL scene off, HUD on
    const realRender = e.render.bind(e);
    await run('no 3D scene (HUD only)', () => { e.render = () => { }; }, () => { e.render = realRender; });

    out._ss = { scale: hud.scale, dpr: hud.dpr, bufW: hud.buf?.width || 0, bufH: hud.buf?.height || 0, canW: hud.canvas.width, canH: hud.canvas.height };
    return out;
  }, N);
  console.log(`\n── ${city} ──`);
  const ss = r._ss; delete r._ss;
  const base = r['baseline'];
  for (const [k, v] of Object.entries(r)) {
    const d = k === 'baseline' ? '' : `  (${v - base >= 0 ? '+' : ''}${(v - base).toFixed(1)} fps)`;
    console.log(`  ${k.padEnd(24)} ${v.toFixed(1)} fps${d}`);
  }
  console.log(`  HUD supersample: scale ${ss.scale.toFixed(2)}  buffer ${ss.bufW}x${ss.bufH}  visible ${ss.canW}x${ss.canH}`);
}
await h.close();
