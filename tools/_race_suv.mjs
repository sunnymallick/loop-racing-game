/**
 * WHERE THE SUV LOSES ITS RACE. Logs every off-track excursion of one named driver: where it
 * started, how long it lasted, how far off it got, and the car's state going in (speed against its
 * own target, drift, boost, on a shortcut or not).
 *
 *   node tools/_race_suv.mjs --city la --who IKE [--ablate '{"band":0}']
 */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const WHO = String(arg('who', 'IKE'));
const SECONDS = +arg('seconds', 200);
const ABLATE = JSON.parse(String(arg('ablate', '{"band":0}')));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async ([who, seconds, ablate]) => {
    const M = await import('/src/race/race.js');
    Object.assign(M.AI_TUNE, { shortcuts: 1, flick: 1, slide: 1, mistakes: 1, traffic: 1, band: 1, nitro: 1 }, ablate);
    const G = window.__GAME.game;
    G.startRace();
    const R = G.race;
    const d = R.drivers.find((x) => x.name === who);
    if (!d) return { err: `no driver ${who}` };
    const runs = [];
    let cur = null;
    const N = Math.round(seconds * 60);
    for (let i = 0; i < N; i++) {
      G.input.setScripted({ steer: 0, throttle: 0, brake: 0, nitro: false, handbrake: false });
      G.update(1 / 60);
      const off = Math.abs(d.lateral) > 1.05;
      if (off && !cur) {
        cur = {
          t: +(i / 60).toFixed(1), u: +d.u.toFixed(3), branch: !!d.branch,
          mph: Math.round(d.body.speedMph), targetMph: Math.round(d.targetSpeed * 2.2369),
          over: +(d.body.speed - d.targetSpeed).toFixed(1),
          drift: +d.body.drift.toFixed(2), slip: +d.body.slip.toFixed(2),
          boost: +d.nitro.ramp.toFixed(2), peak: Math.abs(d.lateral), n: 0, hits0: d.hits,
        };
      } else if (off && cur) {
        cur.n++; cur.peak = Math.max(cur.peak, Math.abs(d.lateral));
      } else if (!off && cur) {
        cur.secs = +(cur.n / 60).toFixed(2);
        cur.peak = +cur.peak.toFixed(2);
        cur.hit = d.hits - cur.hits0;
        delete cur.n; delete cur.hits0;
        if (cur.secs > 0.15) runs.push(cur);
        cur = null;
      }
      if (d.finished) break;
    }
    runs.sort((a, b) => b.secs - a.secs);
    return {
      who, car: d.vehicleId, skill: +d.skill.toFixed(2), off: +d.offT.toFixed(1), hits: d.hits,
      laps: d.counter.lapTimes.map((x) => +x.toFixed(1)), runs: runs.slice(0, 14),
      total: +runs.reduce((a, b) => a + b.secs, 0).toFixed(1), count: runs.length,
    };
  }, [WHO, SECONDS, ABLATE]);
  if (out.err) { console.log(out.err); } else {
    console.log(`${out.who} (${out.car}) skill=${out.skill} offT=${out.off}s hits=${out.hits} laps=${JSON.stringify(out.laps)}`);
    console.log(`${out.count} excursions, ${out.total}s total. Longest:`);
    for (const r of out.runs) console.log(`  t=${String(r.t).padStart(6)}s u=${r.u} ${r.branch ? 'BRANCH' : 'street'} ${String(r.secs).padStart(5)}s peak=${r.peak} mph=${r.mph}/${r.targetMph} over=${r.over} drift=${r.drift} slip=${r.slip} boost=${r.boost} hits=${r.hit}`);
  }
} finally { await h.close(); }
