import { boot, open, load, scenario } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const CAR = String(arg('car', 'muscle'));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const t = G.city.track;
    const s = t.at(0.05);
    G.body.reset(s.pos.clone(), Math.atan2(s.tan.x, s.tan.z));
    G.race.playerU = 0.05; G._snapCamera();
    const rows = [];
    const top = G.body.p.topSpeed;
    for (let i = 0; i < 260; i++) {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed, target = top * 0.92;
      G.input.setScripted({ steer: clamp(-ang * 2.2, -1, 1), throttle: v < target ? 1 : 0, brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0, nitro: false, handbrake: false });
      G.update(1 / 60);
      if (i % 20 === 0) {
        rows.push({
          t: +(i / 60).toFixed(1), mph: Math.round(G.body.speedMph),
          d: G.race.drivers.map((d) => `${d.name.slice(0, 3)}:${Math.round((d.progress - G.race.playerProgress) * t.length)}m/${Math.round(d.body.speedMph)}/${d.lateral.toFixed(1)}${d.tactic[0]}`),
        });
      }
    }
    return { rows, contacts: G.race.contacts };
  });
  console.log('contacts', out.contacts);
  for (const r of out.rows) console.log(String(r.t).padStart(5), String(r.mph).padStart(4), r.d.map((x) => x.padStart(19)).join(''));
} finally { await h.close(); }
