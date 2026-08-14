/**
 * Crash-cam occlusion diagnosis (builder probe).
 *   node tools/_fxocc.mjs vegas supercar
 * Runs the crash scenario and reports what actually sits between the car and the camera.
 */
import { boot, open, ROOT } from './harness.mjs';
import path from 'node:path';

const [city = 'vegas', car = 'supercar'] = process.argv.slice(2);
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city, car });
  const out = await h.page.evaluate(() => {
    const G = window.__GAME, g = G.game;
    G.scenario('crash', {});
    G.render();
    const THREE = g.engine.camera.constructor.prototype.constructor.__proto__ ? null : null;
    const cam = g.engine.camera;
    const from = g.body.pos.clone(); from.y += 0.75;
    const dir = cam.position.clone().sub(from);
    const dist = dir.length();
    dir.divideScalar(dist);
    const ray = new (Object.getPrototypeOf(g.engine.raycaster || {}).constructor || function () {})();
    return { dist, camY: +cam.position.y.toFixed(2), carY: +from.y.toFixed(2) };
  });
  // do the raycast with a Raycaster taken from the page's own three import
  const hits = await h.page.evaluate(async () => {
    const g = window.__GAME.game;
    if (!g._occRay) return 'no raycaster — the crash cam never ran';
    const RC = g._occRay.constructor;
    const V2 = g.engine.camera.position.constructor;   // Vector3; Vector2 taken from ray helper
    const three = { Raycaster: RC, Vector2: null, V3: V2 };
    const cam = g.engine.camera;
    const from = g.body.pos.clone(); from.y += 0.75;
    const dir = cam.position.clone().sub(from);
    const dist = dir.length();
    dir.divideScalar(dist);
    const rc = new three.Raycaster(from, dir, 0.4, dist);
    rc.camera = cam;
    const res = rc.intersectObject(g.city.group, true).slice(0, 8).map((x) => {
      const m = Array.isArray(x.object.material) ? x.object.material[0] : x.object.material;
      return {
        d: +x.distance.toFixed(2), name: x.object.name || x.object.type,
        parent: x.object.parent?.name || '',
        transparent: !!m?.transparent, opacity: m?.opacity, depthWrite: m?.depthWrite,
        side: m?.side, mat: m?.type, colour: m?.color?.getHexString?.(),
      };
    });
    // what does the camera actually see straight ahead?
    const aim = g.camLook.clone().sub(cam.position);
    const aimD = aim.length();
    const rc2 = new three.Raycaster(cam.position.clone(), aim.divideScalar(aimD), 0.05, 400);
    rc2.camera = cam;
    const fwd = rc2.intersectObject(g.city.group, true).slice(0, 3).map((x) => {
      const m = Array.isArray(x.object.material) ? x.object.material[0] : x.object.material;
      return { d: +x.distance.toFixed(2), name: x.object.name || x.object.type, parent: x.object.parent?.name || '', transparent: !!m?.transparent, opacity: m?.opacity, depthWrite: m?.depthWrite, colour: m?.color?.getHexString?.() };
    });
    return { toCam: res, centreOfFrame: fwd, occLift: g._occLift, occLat: g._occLat, occPull: g._occPull, occIdx: g._occIdx, crashT: +g.effects.crashT.toFixed(3), camDist: +dist.toFixed(2) };
  });
  console.log(JSON.stringify(out), '\n', JSON.stringify(hits, null, 1));
} finally { await h.close(); }
void ROOT; void path;
