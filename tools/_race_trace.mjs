import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const SECS = Number(arg('secs', 30));
const WHO = Number(arg('who', 0));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async ([secs, who]) => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const rows = [];
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      const t = G.city.track;
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + 0.02);
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed; const target = G.body.p.topSpeed * 0.92;
      G.input.setScripted({ steer: clamp(-ang * 2.2, -1, 1), throttle: v < target ? 1 : 0, brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0, nitro: false, handbrake: false });
      G.update(1 / 60);
      if (i % 12 === 0) {
        const d = G.race.drivers[who];
        rows.push([+(i / 60).toFixed(1), +d.u.toFixed(3), +d.lateral.toFixed(2), Math.round(d.body.speedMph), Math.round(d.targetSpeed * 2.237), +d.throttle.toFixed(2), +d.brake.toFixed(2), +d.body.steerAngle.toFixed(2), +d.body.slip.toFixed(2), d.tactic, d.branch ? 'B' : (d.wantBranch ? 'w' : '-'), +(d.body.aLat / 9.81).toFixed(2)]);
      }
    }
    return { rows, name: G.race.drivers[who].name, skill: G.race.drivers[who].skill, car: G.race.drivers[who].vehicleId };
  }, [SECS, WHO]);
  console.log(`driver ${out.name} ${out.car} skill=${out.skill.toFixed(2)}`);
  console.log('   t      u    lat  mph  tgt  thr  brk steer  slip  tactic  br  gLat');
  for (const r of out.rows) console.log(r.map((x, i) => String(x).padStart(i === 9 ? 8 : 6)).join(''));
} finally { await h.close(); }
