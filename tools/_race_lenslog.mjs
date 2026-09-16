/** Per-frame trace of the lens guard for one driver over the chase capture. */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'miami'));
const CAR = String(arg('car', 'muscle'));
const WHO = String(arg('who', 'IKE'));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async ([who]) => {
    const G = window.__GAME.game;
    const R = G.race;
    const d0 = R.drivers.find((x) => x.name === who);
    const rows = [];
    const orig = R._lensClear.bind(R);
    R._lensClear = function patched(dt, pb) {
      const before = { x: d0.body.pos.x, z: d0.body.pos.z };
      orig(dt, pb);
      const cam = this._camAhead || this._camPos;
      if (!cam) return;
      const b = d0.body;
      const hull = d0.hull;
      const px = cam.x - b.pos.x, py = cam.y - b.pos.y, pz = cam.z - b.pos.z;
      const lz = px * b.forward.x + pz * b.forward.z, lx = px * b.right.x + pz * b.right.z;
      const ez = Math.max(0, Math.abs(lz) - hull.hl), ex = Math.max(0, Math.abs(lx) - hull.hw);
      rows.push({
        gap: +Math.hypot(ex, ez).toFixed(2), py: +py.toFixed(2), roof: +hull.top.toFixed(2),
        moved: +Math.hypot(b.pos.x - before.x, b.pos.z - before.z).toFixed(3),
        lat: +d0.lateral.toFixed(2), la: +(d0.lensAvoid || 0).toFixed(2),
        camDist: +Math.hypot(px, py, pz).toFixed(2),
      });
    };
    await window.__GAME.scenario('chase');
    return rows.slice(-46);
  }, [WHO]);
  out.forEach((r, i) => console.log(`${String(i).padStart(3)} gapH=${String(r.gap).padStart(6)} py=${String(r.py).padStart(5)} roof=${r.roof} moved=${String(r.moved).padStart(5)} lat=${String(r.lat).padStart(5)} lensAvoid=${String(r.la).padStart(5)} camDist=${r.camDist}`));
} finally { await h.close(); }
