// Start/finish sequence capture: grid, lights, green, the flag and a few seconds after it.
import { boot, open, load, capture } from './harness.mjs';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const OUT = String(arg('out', 'shots/race-r2'));
fs.mkdirSync(OUT, { recursive: true });
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  await h.page.evaluate(() => { const G = window.__GAME.game; G.startRace(); G.race.laps = 1; });
  const step = (n) => h.page.evaluate((k) => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const t = G.city.track;
    for (let i = 0; i < k; i++) {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed;
      let target = G.body.p.topSpeed;
      for (let d2 = 5; d2 < 240; d2 += 8) {
        const kk = Math.abs(t.turnRate(near.u + d2 / t.length));
        if (kk < 2e-4) continue;
        const vc = Math.sqrt(11 * Math.min(1 / kk, 4000));
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
    }
    const R = G.race;
    return { state: R.state, phase: R.phase, cd: +R.countdown.toFixed(2), t: +R.time.toFixed(2), lap: R.playerLap, mph: Math.round(Math.abs(G.body.speedMph)) };
  }, n);
  const shots = [];
  const snap = async (name) => { await capture(h.page, `${OUT}/${CITY}-seq-${name}.png`); shots.push(name); };
  console.log('grid  ', await step(6)); await snap('1-grid');
  console.log('lights', await step(120)); await snap('2-lights');
  console.log('green ', await step(150)); await snap('3-green');
  // run to the flag
  let st;
  for (let i = 0; i < 200; i++) { st = await step(30); if (st.state === 'finished') break; }
  console.log('flag  ', st); await snap('4-flag');
  console.log('after ', await step(150)); await snap('5-after');
  console.log('shots', shots.join(', '));
} finally { await h.close(); }
