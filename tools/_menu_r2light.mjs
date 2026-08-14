// MENU r2: where does the pale blue-white wash on the bodywork come from?
import path from 'node:path';
import { boot, open, scenario, capture, ROOT, errors } from './harness.mjs';

const OUT = path.resolve(ROOT, 'shots/menu-r2-light');
const h = await boot({ width: 1600, height: 900 });
const which = process.argv[2] || 'base';
try {
  await open(h.page, h.url, { city: 'vegas', car: 'muscle' });
  await scenario(h.page, 'menu');
  const info = await h.page.evaluate((w) => {
    const g = window.__GAME.game;
    const stage = g.menu.stage.group;
    const lights = [];
    stage.traverse((o) => { if (o.isLight) lights.push(o); });
    const emissivePlanes = [];
    stage.traverse((o) => {
      if (o.isMesh && o.material?.emissiveIntensity > 1.4 && o.geometry?.type === 'PlaneGeometry') emissivePlanes.push(o);
    });
    if (w === 'noenv') g.engine.scene.environment = null;
    if (w === 'nobloom') g.engine.bloom.strength = 0;
    if (w === 'nohead') { const L = g.car.userData.lights||{}; for (const b of [L.head,L.tail,L.reverse,L.brake]) for (const u of b||[]) u.visible = false; }
    if (w === 'nokey') for (const l of lights) if (l.isSpotLight && l.intensity > 60) l.intensity = 0;
    if (w === 'nospot') for (const l of lights) if (l.isSpotLight) l.intensity = 0;
    if (w === 'nobox') for (const o of emissivePlanes) o.visible = false;
    if (w === 'nohemi') for (const l of lights) if (l.isHemisphereLight || l.isAmbientLight) l.intensity = 0;
    if (w === 'onlyenv') { for (const l of lights) l.intensity = 0; for (const o of emissivePlanes) o.visible = false; }
    return {
      lights: lights.map((l) => [l.type, +l.intensity.toFixed(1)]),
      planes: emissivePlanes.length,
      envInt: g.engine.scene.environmentIntensity,
    };
  }, which);
  console.log(which, JSON.stringify(info));
  await capture(h.page, path.join(OUT, `${which}.png`));
  console.log('errors:', await errors(h.page));
} finally {
  await h.close();
}
