// Spectacle audit: how often do opponents the PLAYER CAN SEE fire nitrous or hang a slide?
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.startRace(); G.race.laps = 3;
    const t = G.city.track;
    let frames = 0, boostSeen = 0, driftSeen = 0, wallSeen = 0, anySeen = 0;
    let boostEvents = 0, driftEvents = 0;
    const wasBoost = new Set(), wasDrift = new Set();
    for (let i = 0; i < 60 * 400; i++) {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed;
      let target = G.body.p.topSpeed;
      for (let d2 = 5; d2 < 240; d2 += 8) {
        const k = Math.abs(t.turnRate(near.u + d2 / t.length));
        if (k < 2e-4) continue;
        const vc = Math.sqrt(11 * Math.min(1 / k, 4000));
        const allow = Math.sqrt(vc * vc + 2 * 18 * d2);
        if (allow < target) target = allow;
      }
      G.input.setScripted({
        steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
        nitro: false, handbrake: false,
      });
      G.update(1 / 60);
      const R = G.race;
      if (R.state !== 'racing') { if (R.state === 'finished') break; continue; }
      frames++;
      let b = 0, d = 0, w = 0, a = 0;
      for (const dr of R.drivers) {
        if (dr.onScreen < 0.4) { wasBoost.delete(dr.id); wasDrift.delete(dr.id); continue; }
        a = 1;
        if (dr.nitro.ramp > 0.25) { b = 1; if (!wasBoost.has(dr.id)) { boostEvents++; wasBoost.add(dr.id); } } else wasBoost.delete(dr.id);
        if (dr.body.drift > 0.45) { d = 1; if (!wasDrift.has(dr.id)) { driftEvents++; wasDrift.add(dr.id); } } else wasDrift.delete(dr.id);
        if (dr.wallHit > 0.02) w = 1;
      }
      boostSeen += b; driftSeen += d; wallSeen += w; anySeen += a;
    }
    return { frames, boostSeen, driftSeen, wallSeen, anySeen, boostEvents, driftEvents, secs: frames / 60 };
  });
  const pc = (x) => ((x / Math.max(1, out.frames)) * 100).toFixed(0);
  console.log(`${CITY}: ${out.secs.toFixed(0)}s racing — an opponent is in shot ${pc(out.anySeen)}% of the time.`);
  console.log(`  nitrous plume in shot ${pc(out.boostSeen)}% of frames, ${out.boostEvents} separate boosts`);
  console.log(`  a rival sideways (drift>0.45) in shot ${pc(out.driftSeen)}% of frames, ${out.driftEvents} separate slides`);
  console.log(`  a rival scraping a barrier in shot ${pc(out.wallSeen)}% of frames`);
} finally { await h.close(); }
