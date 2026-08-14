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
    // a real race from the grid: countdown, 2 laps, flag
    G.startRace();
    G.race.laps = 2;
    const log = [];
    let last = null;
    const t = G.city.track;
    for (let i = 0; i < 60 * 260; i++) {
      const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(G.body.pos);
      const f = G.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const v = G.body.speed;
      // corner-aware target so the reference player does not simply drive into every barrier
      let target = G.body.p.topSpeed;
      for (let d2 = 5; d2 < 240; d2 += 8) {
        const k = Math.abs(t.turnRate(near.u + d2 / t.length));
        if (k < 2e-4) continue;
        const vc = Math.sqrt(11 * Math.min(1 / k, 4000));
        const allow = Math.sqrt(vc * vc + 2 * 18 * d2);
        if (allow < target) target = allow;
      }
      target *= 0.92;
      G.input.setScripted({ steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1), throttle: v < target ? 1 : 0, brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0, nitro: false, handbrake: false });
      G.update(1 / 60);
      const key = `${G.race.state}/${G.race.playerLap}/${G.race.playerPos}`;
      if (key !== last) { log.push(`${(i / 60).toFixed(1)}s  ${key}  standings=${G.race.standings.map((s) => s.name).join(',')}`); last = key; }
      if (G.race.state === 'finished' && i % 60 === 0 && log.length < 60) { /* keep running */ }
      if (G.race.state === 'finished' && G.race.finishTime && (i / 60) > G.race.finishTime + 8) break;
    }
    return {
      log, finishTime: G.race.finishTime, lapTimes: G.race.lapTimes.map((x) => +x.toFixed(2)),
      results: (G.race.results || []).map((r) => `${r.pos} ${r.name} lap=${r.lap} ${r.finished ? 'FIN' : ''}`),
      tele: G.race.telemetry(),
      cuts: G.race.telemetry().cuts,
      recov: G.race.drivers.map((d) => d.recoveries || 0),
      err: window.__ERRORS,
    };
  });
  console.log(out.log.join('\n'));
  console.log('finishTime', out.finishTime, 'lapTimes', JSON.stringify(out.lapTimes));
  console.log('results:', out.results.join(' | '));
  console.log('cuts', out.cuts, 'recoveries', JSON.stringify(out.recov), 'contacts', out.tele.contacts);
  console.log('field:', out.tele.field.map((f) => `${f.name} lap=${f.lap} gap=${f.gapM} cuts=${f.cuts} hits=${f.hits} off=${f.off}`).join('\n        '));
  if (out.err?.length) console.log('ERRORS', out.err.slice(0, 5));
} finally { await h.close(); }
