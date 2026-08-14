// MENU r2 ablation: is the see-through car a depth problem, a material problem, or post?
import path from 'node:path';
import { boot, open, scenario, capture, ROOT, errors } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/menu-r2-ab');
const h = await boot({ width: 1600, height: 900 });
const mode = process.argv[2] || 'all';
try {
  await open(h.page, h.url, { city: 'vegas', car: 'muscle' });
  await scenario(h.page, 'menu');

  if (mode === 'z') await capture(h.page, path.join(OUT, 'z-base.png'));

  // A: force every car material opaque
  if (mode === 'all' || mode === 'a') {
    const n = await h.page.evaluate(() => {
      const g = window.__GAME.game;
      let k = 0;
      g.car.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!m || m.blending !== 1) continue;   // leave additive glows alone
          if (!m.transparent) continue;
          m.transparent = false; m.opacity = 1; m.depthWrite = true; m.needsUpdate = true;
          o.renderOrder = 0;
          k++;
        }
      });
      return k;
    });
    await capture(h.page, path.join(OUT, 'a-opaque.png'));
    console.log('materials forced opaque:', n);
  }

  // B: hide the interior group
  if (mode === 'all' || mode === 'b') {
    const b = await h.page.evaluate(() => {
      const g = window.__GAME.game;
      const found = [];
      g.car.traverse((o) => { if (o.name === 'interior') { o.visible = false; found.push(o.name); } });
      return found;
    });
    await capture(h.page, path.join(OUT, 'b-nointerior.png'));
    console.log('interior groups hidden:', b);
  }

  // C: hide every transparent-physical mesh (the glasshouse)
  if (mode === 'all' || mode === 'c') {
    const c = await h.page.evaluate(() => {
      const g = window.__GAME.game;
      g.car.traverse((o) => { if (o.name === 'interior') o.visible = true; });
      let hid = 0;
      g.car.traverse((o) => {
        if (!o.isMesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        if (ms.some((m) => m && m.transparent && m.type === 'MeshPhysicalMaterial')) { o.visible = false; hid++; }
      });
      return hid;
    });
    await capture(h.page, path.join(OUT, 'c-noglass.png'));
    console.log('glass meshes hidden:', c);
  }

  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
