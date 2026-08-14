// RACE piece round-2 verification probe.
// Drives a full N-lap race from the grid with a competent, nitrous-using racing-line autopilot and
// reports the numbers the round-1 critic measured: pack density over time, rubber-band saturation,
// AI off-track waste, position-flip strobing, and the finishing spread.
import { boot, open, load } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const LAPS = +arg('laps', 3);
const PACE = +arg('pace', 1.0);
const NOS = arg('nos', '1') !== '0';
const ABLATE = String(arg('ablate', ''));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async ([laps, pace, nos, ablate]) => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    if (ablate) {
      const M = await import('/src/race/race.js');
      for (const k of ablate.split(',')) if (k) M.AI_TUNE[k] = 0;
    }
    G.startRace();
    G.race.laps = laps;
    const acc = {};
    for (const d of G.race.drivers) acc[d.name] = { n:0, drift:0, mph:0, tgt:0, thr:0, brk:0, slip:0, hb:0 };
    const t = G.city.track;
    const samples = [];
    const flips = [];
    const rawFlips = [];
    let lastPos = null, lastRaw = null;
    let nosT = 0;
    const events = [];
    let lastKey = null;
    let finishedAt = null;
    let afterFlag = null;
    for (let i = 0; i < 60 * 400; i++) {
      const time = i / 60;
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
      target *= pace;
      // nitrous down anything that looks like a straight
      let straight = 1;
      for (let d2 = 20; d2 < 190; d2 += 24) {
        const k = Math.abs(t.turnRate(near.u + d2 / t.length));
        straight = Math.min(straight, 1 - clamp((k - 0.006) / 0.014, 0, 1));
      }
      nosT -= 1 / 60;
      const wantNos = nos && straight > 0.75 && v > 30 && nosT < 0;
      if (wantNos && !G.nitro.active && G.nitro.tanks > 0) nosT = 4;
      G.input.setScripted({
        steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
        nitro: nos && (nosT > 0),
        handbrake: false,
      });
      G.update(1 / 60);
      const R = G.race;
      const key = `${R.state}/${R.playerLap}/${R.playerPos}`;
      if (key !== lastKey) { events.push(`${time.toFixed(1)}s ${key}`); lastKey = key; }
      // displayed position flips
      if (lastPos != null && R.playerPos !== lastPos) flips.push(+time.toFixed(2));
      lastPos = R.playerPos;
      const rawOrder = R._rawPos != null ? R._rawPos : R.playerPos;
      if (lastRaw != null && rawOrder !== lastRaw) rawFlips.push(+time.toFixed(2));
      lastRaw = rawOrder;

      if (R.state === 'racing') { for (const d of R.drivers) { const a = acc[d.name]; a.n++; a.drift += d.body.drift; a.mph += Math.abs(d.body.speedMph); a.tgt += d.targetSpeed * 2.23694; a.thr += d.throttle; a.brk += d.brake; a.slip += Math.abs(d.body.slip); } }
      if (i % 15 === 0 && R.state !== 'countdown') {
        let n15 = 0, n30 = 0, n60 = 0, ahead60 = 0;
        let maxSeenTrim = 0, maxTrim = 0, railed = 0;
        for (const d of R.drivers) {
          const dist = d.body.pos.distanceTo(G.body.pos);
          if (dist < 15) n15++;
          if (dist < 30) n30++;
          if (dist < 60) n60++;
          const gapM = (d.progress - R.playerProgress) * t.length;
          if (gapM > 0 && gapM < 70) ahead60++;
          if (d.onScreen > 0.4) maxSeenTrim = Math.max(maxSeenTrim, Math.abs(d.trim));
          maxTrim = Math.max(maxTrim, Math.abs(d.trim));
          if (Math.abs(d.trim) > 0.29) railed++;
        }
        const tele = R.telemetry();
        samples.push({
          t: +time.toFixed(2), pos: R.playerPos, lap: R.playerLap,
          onScreen: tele.packOnScreen, ahead: tele.packAhead, within: tele.packWithin,
          n15, n30, n60, ahead60,
          fieldPace: tele.fieldPace, seenTrim: +maxSeenTrim.toFixed(3), maxTrim: +maxTrim.toFixed(3),
          railed,
        });
      }
      if (R.state === 'finished' && finishedAt == null) {
        finishedAt = time;
        afterFlag = { time: R.time, mph: Math.abs(G.body.speedMph), state: R.state };
      }
      if (finishedAt != null && time > finishedAt + 6) {
        afterFlag.time6 = R.time;
        afterFlag.mph6 = Math.abs(G.body.speedMph);
        afterFlag.standings6 = G.race.standings.map((s) => `${s.pos}${s.you ? '*' : ''}${s.name}${s.finished ? 'F' : '-'}`).join(' ');
        break;
      }
    }
    const R = G.race;
    return {
      events, samples, flips, rawFlips, finishedAt, afterFlag,
      lapTimes: R.lapTimes.map((x) => +x.toFixed(2)),
      results: (R.results || []).map((r) => `${r.pos} ${r.name} lap${r.lap} ${r.finished ? 'FIN ' + (r.finishTime || 0).toFixed(1) : 'gap' + Math.round(r.gapM)}`),
      field: R.telemetry().field.map((f) => ({ n: f.name, gap: f.gapM, off: f.off, hits: f.hits, lap: f.lap, cuts: f.cuts })),
      recov: R.drivers.map((d) => d.recoveries || 0),
      acc: Object.entries(acc).map(([k,a]) => `${k} drift=${(a.drift/a.n).toFixed(2)} mph=${(a.mph/a.n).toFixed(0)} tgtMph=${(a.tgt/a.n).toFixed(0)} thr=${(a.thr/a.n).toFixed(2)} brk=${(a.brk/a.n).toFixed(2)} slip=${(a.slip/a.n).toFixed(3)}`),
      laps: R.drivers.map((d) => `${d.name}/${d.vehicleId}/s${d.skill.toFixed(2)} ${d.counter.lapTimes.map((x) => x.toFixed(1)).join(',')} off=${d.offT.toFixed(1)} mist=${(d.mistakes||0)}`),
      contacts: R.contacts, playerContacts: R.playerContacts,
      err: (window.__ERRORS || []).slice(0, 5),
    };
  }, [LAPS, PACE, NOS, ABLATE]);

  const S = out.samples;
  const frac = (f) => (S.length ? (S.filter(f).length / S.length * 100).toFixed(0) : '-');
  // longest stretch (seconds) with nothing on screen ahead
  let run = 0, worst = 0, worstAt = 0;
  for (const s of S) {
    if (s.onScreen === 0) { run += 0.25; if (run > worst) { worst = run; worstAt = s.t; } } else run = 0;
  }
  let run60 = 0, worst60 = 0;
  for (const s of S) { if (s.n60 === 0) { run60 += 0.25; worst60 = Math.max(worst60, run60); } else run60 = 0; }
  const mean = (k) => (S.reduce((a, s) => a + s[k], 0) / Math.max(1, S.length)).toFixed(2);
  console.log(`== ${CITY} laps=${LAPS} pace=${PACE} nos=${NOS ? 'on' : 'off'} ==`);
  console.log(out.events.join('\n'));
  console.log(`\nPACK  mean onScreen=${mean('onScreen')} ahead(<120m)=${mean('ahead')} within150=${mean('within')}`);
  console.log(`      mean cars <15m=${mean('n15')} <30m=${mean('n30')} <60m=${mean('n60')} ahead<70m=${mean('ahead60')}`);
  console.log(`      %frames onScreen>=1: ${frac((s) => s.onScreen >= 1)}%  >=2: ${frac((s) => s.onScreen >= 2)}%  n60>=2: ${frac((s) => s.n60 >= 2)}%  n30>=1: ${frac((s) => s.n30 >= 1)}%`);
  console.log(`      longest 0-on-screen stretch ${worst.toFixed(1)}s (ends ${worstAt}s); longest nothing-within-60m ${worst60.toFixed(1)}s`);
  const fp = S.map((s) => s.fieldPace);
  console.log(`BAND  fieldPace min=${Math.min(...fp).toFixed(3)} max=${Math.max(...fp).toFixed(3)} %at-ceiling=${frac((s) => s.fieldPace >= 1.055)}% %at-floor=${frac((s) => s.fieldPace <= 0.805)}%`);
  console.log(`      max trim on a visible car=${Math.max(...S.map((s) => s.seenTrim)).toFixed(3)}  mean=${mean('seenTrim')}  max any=${Math.max(...S.map((s) => s.maxTrim)).toFixed(3)}  mean drivers railed=${mean('railed')}`);
  console.log(`RANK  displayed flips=${out.flips.length}  worst 3s window=${(() => { let m = 0; for (const f of out.flips) m = Math.max(m, out.flips.filter((g) => g >= f && g < f + 3).length); return m; })()}`);
  console.log(`AI    off-track s: ${out.field.map((f) => `${f.n}=${f.off}`).join(' ')}`);
  console.log(`      hits: ${out.field.map((f) => `${f.n}=${f.hits}`).join(' ')}  recoveries=${JSON.stringify(out.recov)}`);
  console.log(`      contacts=${out.contacts} player=${out.playerContacts}`);
  console.log('LAPS  ' + out.laps.join('\n      '));
  console.log('AVG   ' + out.acc.join('\n      '));
  console.log(`RESULT finish=${out.finishedAt}s lapTimes=${JSON.stringify(out.lapTimes)}`);
  console.log('       ' + out.results.join(' | '));
  console.log(`FLAG  at-flag raceTime=${out.afterFlag?.time?.toFixed(2)} mph=${out.afterFlag?.mph?.toFixed(0)} | +6s raceTime=${out.afterFlag?.time6?.toFixed(2)} mph=${out.afterFlag?.mph6?.toFixed(0)}`);
  console.log(`      +6s standings: ${out.afterFlag?.standings6}`);
  if (out.err?.length) console.log('ERRORS', out.err);
} finally { await h.close(); }
