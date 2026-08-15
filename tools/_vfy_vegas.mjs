import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, scenario, capture } from './harness.mjs';
const OUT = process.argv[2];
await fs.mkdir(OUT, { recursive: true });
const h = await boot({ gpu: false, width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'vegas', car: 'muscle' });
  for (const u of [0.05, 0.30, 0.55, 0.80]) {
    await scenario(h.page, 'chase', { u, offset: 0.85 });
    await capture(h.page, path.join(OUT, `vegas-off-${u}.png`));
  }
  // sample the raw ground colour off-track: shoot a ray straight down beside the road
  const stat = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const cv = g.engine.renderer.domElement;
    const off = document.createElement('canvas');
    off.width = 1600; off.height = 900;
    const c = off.getContext('2d');
    c.drawImage(cv, 0, 0, 1600, 900);
    const px = c.getImageData(0, 0, 1600, 900).data;
    // histogram of the lower-left quadrant (off-track shoulder) minus HUD region
    const out = [];
    for (let y = 500; y < 880; y += 4) for (let x = 40; x < 500; x += 4) {
      const o = (y * 1600 + x) * 4;
      out.push([px[o], px[o + 1], px[o + 2]]);
    }
    const L = out.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).sort((a, b) => a - b);
    return {
      n: L.length, p05: +L[Math.floor(L.length * 0.05)].toFixed(1),
      med: +L[Math.floor(L.length * 0.5)].toFixed(1),
      p95: +L[Math.floor(L.length * 0.95)].toFixed(1),
      meanRGB: [0, 1, 2].map((i) => +(out.reduce((a, p) => a + p[i], 0) / out.length).toFixed(1)),
    };
  });
  console.log('vegas shoulder luminance', JSON.stringify(stat));
} finally { await h.close(); }
