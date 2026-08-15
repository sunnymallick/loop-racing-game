/** What is the amber wash on NYC's near carriageway? Attribute it by ablating one term at a time. */
import { boot, open, load, scenario } from './harness.mjs';
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'nyc', car: 'tuner' });
  await load(h.page, { city: 'nyc', car: 'tuner' });
  await scenario(h.page, 'chase');
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const a = g.engine.atmos.uniforms;
    const read = () => {
      g.render(1 / 60);
      const gl = g.engine.renderer.getContext();
      const w = gl.drawingBufferWidth, hh = gl.drawingBufferHeight;
      const px = new Uint8Array(4 * 200 * 60);
      // near carriageway, left of the car: x 300..500, y (from bottom) 90..150
      gl.readPixels(300, 90, 200, 60, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let r = 0, gg = 0, b = 0, n = 0, mn = 255, mx = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++;
        const l = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
        mn = Math.min(mn, l); mx = Math.max(mx, l);
      }
      return `${(r / n).toFixed(0)},${(gg / n).toFixed(0)},${(b / n).toFixed(0)}  range ${mn.toFixed(0)}-${mx.toFixed(0)}  [${w}x${hh}]`;
    };
    const res = {};
    res.baseline = read();
    const wet = a.uWet.value; a.uWet.value = 0; res.noWet = read(); a.uWet.value = wet;
    const sp = g.engine.spill.enabled; g.engine.spill.enabled = false;
    res.noSpill = read(); g.engine.spill.enabled = sp;
    const bs = g.engine.bloom.strength; g.engine.bloom.strength = 0;
    res.noBloom = read(); g.engine.bloom.strength = bs;
    a.uWet.value = 0; g.engine.spill.enabled = false;
    res.noWetNoSpill = read();
    a.uWet.value = wet; g.engine.spill.enabled = sp;
    res.uWet = wet;
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await h.close(); }
