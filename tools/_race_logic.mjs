/** Lap / checkpoint / position logic tests — §6.10's "correct lap logic", checked rather than claimed. */
import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const G = window.__GAME.game;
    const R = () => G.race;
    const log = [];
    const ok = (name, cond, detail) => log.push(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    const M = await import('/src/race/race.js');
    const Progress = M.Progress;

    // ---- unit: the counter itself
    const p = new Progress(0.0);
    ok('grid starts on lap -1 (formation lap)', p.lap === -1, `lap=${p.lap} raw=${p.raw.toFixed(3)}`);
    for (let i = 1; i <= 12; i++) p.advance(i / 12 % 1, i);
    ok('one clean lap credits one lap', p.lap === 0, `lap=${p.lap} cuts=${p.cuts}`);
    for (let i = 1; i <= 12; i++) p.advance(((i / 12) + 1e-9) % 1, 12 + i);
    ok('second clean lap credits', p.lap === 1 && p.lapTimes.length === 1, `lap=${p.lap} times=${p.lapTimes.length}`);
    // reverse across the line: must NOT credit a lap
    const before = p.lap;
    for (let i = 11; i >= 0; i--) p.advance(i / 12, 30);
    ok('driving backwards over the line loses the lap, never gains one', p.lap <= before, `lap=${p.lap} (was ${before})`);
    // cut the course: jump half a lap forward
    const q = new Progress(0.0);
    for (let i = 1; i <= 6; i++) q.advance(i / 12, i);
    q.advance(0.98, 8);        // teleport most of the way round
    const cutLap = q.lap, cuts = q.cuts;
    q.advance(0.02, 9);
    ok('cutting the course is recorded, not rewarded', cuts > 0 && cutLap < 0, `cuts=${cuts} lap=${cutLap}`);

    // ---- integration: a real race
    G.startRace();
    G.race.laps = 1;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const t = G.city.track;
    let sawCountdownOrder = null;
    let finishedAt = null;
    let posAfterFinish = [];
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
        nitro: false, handbrake: false,
      });
      G.update(1 / 60);
      if (G.race.state === 'countdown' && sawCountdownOrder == null && G.race.countdown < 1) {
        sawCountdownOrder = { pos: G.race.playerPos, speed: Math.abs(G.body.speed) };
      }
      if (G.race.state === 'finished') {
        if (finishedAt == null) finishedAt = i;
        posAfterFinish.push(G.race.playerPos);
        if (i - finishedAt > 240) break;
      }
    }
    const r = R();
    ok('player starts at the back of the grid', sawCountdownOrder && sawCountdownOrder.pos >= 7, JSON.stringify(sawCountdownOrder));
    ok('nobody moves before the lights', sawCountdownOrder && sawCountdownOrder.speed < 0.5, `${sawCountdownOrder?.speed.toFixed(2)} m/s`);
    ok('race ends after the set number of laps', r.state === 'finished' && r.playerLap === r.laps, `lap=${r.playerLap}/${r.laps}`);
    ok('finishing position is frozen at the flag', posAfterFinish.length > 60 && new Set(posAfterFinish).size === 1, `positions after flag: ${[...new Set(posAfterFinish)].join(',')}`);
    ok('results are complete and ordered', (r.results || []).length === 8 && r.results.every((x, i2) => x.pos === i2 + 1), (r.results || []).map((x) => `${x.pos}${x.you ? '*' : ''}`).join(' '));
    ok('the player is credited a full lap in the results', (r.results || []).find((x) => x.you)?.lap === r.laps, `lap=${(r.results || []).find((x) => x.you)?.lap}`);
    ok('no player course cuts on a clean lap', r.telemetry().cuts === 0, `cuts=${r.telemetry().cuts}`);
    ok('every opponent is on the same lap or one down', r.drivers.every((d) => d.lap >= r.laps - 1), r.drivers.map((d) => d.lap).join(','));
    ok('nobody was recovered in view of the player', r.drivers.every((d) => !d.recoveries || d.recoveries < 3), r.drivers.map((d) => d.recoveries || 0).join(','));
    return { log, standings: r.standings.map((s) => `${s.pos} ${s.name} lap${s.lap} ${s.finished ? 'FIN' : ''}`), err: (window.__ERRORS || []).slice(0, 3) };
  });
  console.log(out.log.join('\n'));
  console.log('final standings:', out.standings.join(' | '));
  if (out.err?.length) console.log('ERRORS', out.err);
  console.log(out.log.some((l) => l.startsWith('FAIL')) ? '\nSOME TESTS FAILED' : '\nall lap/position logic tests pass');
} finally { await h.close(); }
