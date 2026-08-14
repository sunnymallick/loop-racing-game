#!/usr/bin/env node
/**
 * RACE piece scratch probe: run a full race headlessly (no rendering) and report how the field
 * behaves — pack spread, off-track time, spins, contacts, lap times, positions.
 *
 *   node tools/_race_probe.mjs --city la --car muscle --secs 60
 */
import { boot, open, load, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const CAR = String(arg('car', 'muscle'));
const SECS = Number(arg('secs', 45));
const PACE = Number(arg('pace', 0.92));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async ([secs, pace]) => {
    const G = window.__GAME.game;
    const T = window.__GAME;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    // start at the grid, then autopilot the player round the lap on the racing line
    const n = Math.round(secs * 60);
    const samples = [];
    const spun = {}; const offs = {}; const maxOff = {};
    for (let i = 0; i < n; i++) {
      const t = G.city.track;
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed;
      const target = G.body.p.topSpeed * pace;
      G.input.setScripted({
        steer: clamp(-ang * 2.2, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0,
        nitro: false, handbrake: false,
      });
      G.update(1 / 60);
      for (const d of G.race.drivers) {
        if (Math.abs(d.body.slip) > 1.1) spun[d.name] = (spun[d.name] || 0) + 1;
        const lat = Math.abs(d.lateral);
        if (lat > 1.05) offs[d.name] = (offs[d.name] || 0) + 1 / 60;
        maxOff[d.name] = Math.max(maxOff[d.name] || 0, lat);
      }
      if (i % 30 === 0) {
        const r = G.race.telemetry();
        samples.push({
          t: +(i / 60).toFixed(1), pos: r.pos, lap: r.lap, ahead: r.packAhead, within: r.packWithin,
          mph: Math.round(G.body.speedMph),
          pu: +G.race.playerProgress.toFixed(3),
          full: +G.city.track.nearest(G.body.pos).u.toFixed(3),
          lat: +G.city.track.nearest(G.body.pos).lateral.toFixed(2),
          xz: [Math.round(G.body.pos.x), Math.round(G.body.pos.z)],
          prog: G.race.drivers.map((d) => +d.progress.toFixed(3)),
          gaps: r.field.map((x) => Math.round(x.gapM)),
          mphs: r.field.map((x) => x.mph),
        });
      }
    }
    const r = G.race.telemetry();
    return {
      final: r, samples, spun, offs, maxOff,
      playerLapTimes: G.race.lapTimes.map((x) => +x.toFixed(2)),
      aiLapTimes: G.race.drivers.map((d) => ({ n: d.name, lt: d.counter.lapTimes.map((x) => +x.toFixed(2)), best: d.counter.best })),
      errors: window.__ERRORS,
    };
  }, [SECS, PACE]);

  const f = out.final;
  console.log(`\n${CITY}/${CAR}  ${SECS}s   pos=${f.pos} lap=${f.lap}/${f.laps} contacts=${f.contacts} reforms=${f.reforms} cuts=${f.cuts}`);
  console.log('\n  t     pos  ahead within  mph   gaps (m, leader→)');
  for (const s of out.samples) {
    console.log(`  ${String(s.t).padStart(5)}  ${String(s.pos).padStart(3)}  ${String(s.ahead).padStart(5)} ${String(s.within).padStart(6)}  ${String(s.mph).padStart(4)}  P=${String(s.pu).padStart(7)} F=${String(s.full).padStart(6)} lat=${String(s.lat).padStart(6)} xz=${s.xz}  ${s.prog.map((g) => String(g.toFixed(2)).padStart(7)).join('')}`);
  }
  console.log('\n  final field:');
  for (const d of f.field) {
    console.log(`   ${d.name.padEnd(8)} ${d.car.padEnd(9)} gap=${String(d.gapM).padStart(8)} ${String(d.mph).padStart(4)}mph drift=${d.drift} boost=${d.boost} ${d.tactic.padEnd(7)} lap=${d.lap} off=${d.off}s hits=${d.hits} cuts=${d.cuts}`);
  }
  console.log('\n  spun frames:', JSON.stringify(out.spun));
  console.log('  off-track s:', JSON.stringify(out.offs));
  console.log('  max |lat| :', JSON.stringify(Object.fromEntries(Object.entries(out.maxOff).map(([k, v]) => [k, +v.toFixed(2)]))));
  console.log('  player laps:', JSON.stringify(out.playerLapTimes));
  console.log('  ai laps:', out.aiLapTimes.map((a) => `${a.n}:${a.lt.join('/')}`).join('  '));
  if (out.errors?.length) console.log('  ERRORS', out.errors.slice(0, 6));
} finally {
  await h.close();
}
void ROOT;
