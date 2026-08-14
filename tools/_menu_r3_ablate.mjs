// What is actually printing the blue-white plate on the rear side glass? Ablate one source at a
// time and measure the mean luminance of the quarter-light box.
import path from 'node:path';
import { boot, open, scenario, capture, ROOT } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/menu-r3-ablate');
const BOX = { x: 950, y: 288, w: 130, h: 44 };

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await scenario(h.page, 'menu');
  const runs = ['none', 'env', 'lights', 'softbox', 'glasshide'];
  for (const mode of runs) {
    const v = await h.page.evaluate((m) => {
      const g = window.__GAME.game;
      const st = g.menu.stage;
      // restore
      g.engine.scene.environment = st.env;
      st.group.traverse((o) => {
        if (o.isLight) o.visible = true;
        if (o.isMesh && o.material && o.material.emissive && o.material.__savedE !== undefined) {
          o.material.emissiveIntensity = o.material.__savedE;
        }
      });
      let glassMat = null;
      g.car.traverse((o) => {
        if (!o.isMesh) return;
        for (const mm of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (mm && mm.name === 'glass') {
            glassMat = mm;
            if (mm.__savedEnv === undefined) mm.__savedEnv = mm.envMapIntensity;
            mm.envMapIntensity = mm.__savedEnv;
            o.visible = true;
          }
        }
      });
      if (m === 'env') glassMat.envMapIntensity = 0;
      if (m === 'lights') st.group.traverse((o) => { if (o.isLight && o.isSpotLight) o.visible = false; });
      if (m === 'softbox') {
        st.group.traverse((o) => {
          if (o.isMesh && o.material && o.material.emissive && o.material.emissiveIntensity > 1) {
            if (o.material.__savedE === undefined) o.material.__savedE = o.material.emissiveIntensity;
            o.material.emissiveIntensity = 0;
          }
        });
      }
      if (m === 'glasshide') {
        g.car.traverse((o) => {
          if (!o.isMesh) return;
          for (const mm of (Array.isArray(o.material) ? o.material : [o.material])) {
            if (mm && mm.name === 'glass') o.visible = false;
          }
        });
      }
      g.render(1 / 60);
      return 1;
    }, mode);
    void v;
    await capture(h.page, path.join(OUT, `ablate-${mode}.png`));
  }
  console.log('BOX', JSON.stringify(BOX));
} finally {
  await h.close();
}
