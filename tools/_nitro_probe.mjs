// (nitrous piece, scratch) measure the plume's ACTUAL projected screen extent, per class/city.
// node tools/_nitro_probe.mjs [--shot nitrous-long]
import { boot, open } from './harness.mjs';

const i = process.argv.indexOf('--shot');
const shot = i > 0 ? process.argv[i + 1] : 'nitrous-long';
const cities = ['la', 'vegas', 'miami', 'nyc'];
const cars = ['tuner', 'muscle', 'suv', 'supercar'];

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: cities[0], car: cars[0] });
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [1600, 900]);
  for (const city of cities) {
    for (const car of cars) {
      await h.page.evaluate((s) => window.__GAME.load(s), { city, car });
      await h.page.evaluate((n) => window.__GAME.scenario(n, {}), shot);
      const d = await h.page.evaluate(() => {
        const G = window.__GAME.game;
        const jet = G.jet, cam = G.engine.camera;
        cam.updateMatrixWorld();
        const n0 = jet.nozzles[0];
        const p = n0.group.position.clone();
        n0.group.getWorldPosition(p);
        const q = n0.group.quaternion.clone();
        n0.group.getWorldQuaternion(q);
        const axis = p.clone().set(0, 0, -1).applyQuaternion(q);
        const L = (jet._baseLen || 0) * 0.62;
        const a = p.clone(), b = p.clone().addScaledVector(axis, L);
        const aspect = cam.aspect;
        const nd = cam.position.distanceTo(a), td = cam.position.distanceTo(b);
        a.project(cam); b.project(cam);
        // NDC → fraction of FRAME HEIGHT
        const dx = (b.x - a.x) * 0.5 * aspect, dy = (b.y - a.y) * 0.5;
        return {
          gLen: +(jet._gLen ?? 1).toFixed(2), gRad: +(jet._gRad ?? 1).toFixed(2),
          ax: +(jet._gAx ?? 0).toFixed(2),
          baseLen: +L.toFixed(2),
          camDist: +cam.position.distanceTo(G.body.pos).toFixed(2),
          nozDist: +nd.toFixed(2), tipDist: +td.toFixed(2),
          scale: [G.container.clientWidth, G.container.clientHeight],
          camUp: +(cam.position.y - G.body.pos.y).toFixed(2),
          fov: +cam.fov.toFixed(1),
          tipPx: [Math.round((b.x * 0.5 + 0.5) * 1600), Math.round((0.5 - b.y * 0.5) * 900)],
          nozPx: [Math.round((a.x * 0.5 + 0.5) * 1600), Math.round((0.5 - a.y * 0.5) * 900)],
          frameH: +Math.hypot(dx, dy).toFixed(3),
          flame: +G.nitro.flame.toFixed(2), ramp: +G.nitro.ramp.toFixed(2),
          mph: Math.round(Math.abs(G.body.speed) * 2.23694),
        };
      });
      console.log(`${city.padEnd(6)} ${car.padEnd(9)} frameH=${String(d.frameH).padEnd(6)} L=${String(d.baseLen).padEnd(6)} gLen=${String(d.gLen).padEnd(5)} gRad=${d.gRad} ax=${d.ax} dist=${d.camDist} nozD=${d.nozDist} tipD=${d.tipDist} up=${d.camUp} fov=${d.fov} vp=${d.scale} mph=${d.mph} flame=${d.flame}`);
    }
  }
} finally {
  await h.close();
}
