/** Captures the START and FINISH sequences, which no standard scenario covers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, capture, ROOT } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const OUT = path.resolve(ROOT, String(arg('out', 'shots/race-seq')));
await fs.mkdir(OUT, { recursive: true });
const h = await boot({ width: 1600, height: 900 });
const drive = async (frames, input) => h.page.evaluate(([n, inp]) => {
  const G = window.__GAME.game;
  for (let i = 0; i < n; i++) { G.input.setScripted({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, ...inp }); G.update(1 / 60); }
  const R = G.race;
  return { state: R.state, phase: R.phase, cd: +R.countdown.toFixed(2), pos: R.playerPos, t: +R.time.toFixed(1) };
}, [frames, input || {}]);
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  await h.page.evaluate(() => { window.__GAME.game.startRace(); });
  // --- lights: hold on the grid until one second is left
  console.log('grid  ', await drive(Math.round(60 * 3.5)));
  await capture(h.page, path.join(OUT, `${CITY}-start-lights.png`));
  // --- launch: 0.9 s after the lights go out
  console.log('launch', await drive(Math.round(60 * 1.55), { throttle: 1 }));
  await capture(h.page, path.join(OUT, `${CITY}-start-launch.png`));
  console.log('go+2  ', await drive(Math.round(60 * 2.2), { throttle: 1 }));
  await capture(h.page, path.join(OUT, `${CITY}-start-run.png`));
  // --- finish: one-lap race on autopilot, captured just after the flag
  const fin = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.race.laps = 1;
    const t = G.city.track;
    let flagAt = null;
    for (let i = 0; i < 60 * 200; i++) {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed;
      let target = G.body.p.topSpeed;
      for (let d2 = 5; d2 < 260; d2 += 6) {
        const k = Math.abs(t.turnRate(near.u + d2 / t.length));
        if (k < 2e-4) continue;
        const vc = Math.sqrt(11.5 * Math.min(1 / k, 4000));
        const allow = Math.sqrt(vc * vc + 2 * 19 * d2);
        if (allow < target) target = allow;
      }
      target *= 0.94;
      G.input.setScripted({
        steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
        nitro: v > target * 0.9 && G.nitro.tanks > 0, handbrake: false,
      });
      G.update(1 / 60);
      if (G.race.state === 'finished') { if (flagAt == null) flagAt = i; if (i - flagAt > 40) break; }
    }
    const R = G.race;
    return {
      pos: R.playerPos, frozen: R.playerFinishPos, phase: R.phase,
      results: (R.results || []).map((r) => `${r.pos} ${r.name}${r.you ? '*' : ''} lap=${r.lap} ${r.finished ? (r.finishTime ?? 0).toFixed(1) : 'DNF'}`),
      lapTimes: R.lapTimes.map((x) => +x.toFixed(2)),
    };
  });
  console.log('finish', JSON.stringify(fin, null, 1));
  await capture(h.page, path.join(OUT, `${CITY}-finish.png`));
  console.log('→', OUT);
} finally { await h.close(); }
