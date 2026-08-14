// Critic probe: race systems behaviour over a full race. Generates its own evidence.
import { boot, open } from './harness.mjs';

const AUTOPILOT = `
window.__CRITIC = {
  reset() {
    const g = window.__GAME.game;
    g.startRace();
    return window.__GAME.telemetry();
  },
  idle(n) {
    const g = window.__GAME.game;
    const out = [];
    for (let i = 0; i < n; i++) {
      g.input.setScripted({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false });
      g.update(1/60);
      if (i % 10 === 0) { const t = window.__GAME.telemetry(); out.push({ t: +(i/60).toFixed(2), state: t.race.state, mph: t.mph, pos: t.race.pos, time: t.race.time }); }
    }
    return out;
  },
  drive(seconds, frac, sample) {
    const g = window.__GAME.game;
    const clamp = (v,a,b) => v<a?a:v>b?b:v;
    const n = Math.round(seconds * 60);
    const every = Math.round((sample||0.5) * 60);
    const out = [];
    const top = g.body.spec && g.body.spec.topSpeed ? g.body.spec.topSpeed : 70;
    const target = top * frac;
    for (let i = 0; i < n; i++) {
      const t = g.city.track;
      const near = t.nearest(g.body.pos, g.race ? g.race.playerU : null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(g.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(g.body.pos);
      const f = g.body.forward;
      const ang = Math.atan2(f.x*to.z - f.z*to.x, f.x*to.x + f.z*to.z);
      const v = g.body.speed;
      g.input.setScripted({
        steer: clamp(-ang*2.2,-1,1),
        throttle: v < target ? 1 : 0,
        brake: v > target*1.05 ? clamp((v-target)*0.22,0,1) : 0,
        nitro: false, handbrake: false,
      });
      g.update(1/60);
      if (i % every === 0) {
        const tel = window.__GAME.telemetry();
        const r = tel.race;
        const gaps = r.field.map(x => x.gapM);
        const nearest = r.field.reduce((a,b) => Math.abs(b.gapM) < Math.abs(a.gapM) ? b : a);
        out.push({
          t: +(i/60).toFixed(1), state: r.state, pos: r.pos, lap: r.lap, u: r.u,
          mph: tel.mph, packAhead: r.packAhead, packWithin: r.packWithin,
          contacts: r.contacts, cuts: r.cuts,
          leadGap: +Math.max(...gaps).toFixed(1), lastGap: +Math.min(...gaps).toFixed(1),
          nearGap: nearest.gapM, nearMph: nearest.mph, nearTactic: nearest.tactic,
          fieldMph: r.field.map(x => x.mph),
          fieldGap: gaps.map(x => +x.toFixed(0)),
          fieldLap: r.field.map(x => x.lap),
          fieldHits: r.field.map(x => x.hits),
          fieldOff: r.field.map(x => x.off),
          tactics: r.field.map(x => x.tactic),
          names: r.field.map(x => x.name),
        });
      }
      if (window.__GAME.telemetry().race.state === 'finished') break;
    }
    return out;
  },
};
`;

const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await h.page.evaluate(AUTOPILOT);

  // --- start sequence ---
  const start = await h.page.evaluate(() => window.__CRITIC.reset());
  console.log('START state:', JSON.stringify(start.race && { state: start.race.state, pos: start.race.pos, lap: start.race.lap, laps: start.race.laps, time: start.race.time }));
  const idle = await h.page.evaluate(() => window.__CRITIC.idle(360));
  console.log('IDLE 6s:', JSON.stringify(idle));

  // --- fast player, full race ---
  await h.page.evaluate(() => window.__CRITIC.reset());
  const fast = await h.page.evaluate(() => window.__CRITIC.drive(400, 0.98, 2));
  console.log('\n=== FAST RUN (' + fast.length + ' samples) ===');
  for (const s of fast) console.log(JSON.stringify(s));

  // --- slow player, 90s ---
  await h.page.evaluate(() => window.__CRITIC.reset());
  const slow = await h.page.evaluate(() => window.__CRITIC.drive(90, 0.55, 3));
  console.log('\n=== SLOW RUN ===');
  for (const s of slow) console.log(JSON.stringify(s));

  console.log('\nERRORS:', JSON.stringify(h.logs.slice(0, 10)));
} finally {
  await h.close();
}
