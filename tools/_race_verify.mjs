/**
 * RACE VERIFICATION PROBE — does the classification match who actually crossed the line?
 *
 * Runs a full race from the grid and, INDEPENDENTLY OF THE DIRECTOR, timestamps the frame on
 * which every car (player included) completes its final lap, using one clock: the probe's own
 * frame counter, zeroed on the green. That is the ground truth. It then prints:
 *
 *   · TRUE ORDER    — sorted by that measured crossing time
 *   · CLASSIFIED    — race.results, i.e. what the game says happened
 *   · a MISMATCH line for every car whose classified place disagrees with the truth
 *
 * Also reports: whether the race terminated at all (bug 2), shortcut entries/completions per
 * driver (bug 4), the tactic histogram, the finishing spread, and per-class pace.
 *
 *   node tools/_race_verify.mjs --city la [--laps 3] [--idle] [--seconds 300]
 */
import { boot, open, load } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const has = (k) => argv.includes(`--${k}`);
const CITY = String(arg('city', 'la'));
const CAR = String(arg('car', 'muscle'));
const LAPS = +arg('laps', 3);
const SECONDS = +arg('seconds', 360);
const IDLE = has('idle');
const SKILL = +arg('skill', 0.92);   // how well the autopilot player drives (fraction of the solve)
const ABLATE = JSON.parse(String(arg('ablate', '{}')));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async ([laps, seconds, idle, skill, ablate]) => {
    const M = await import('/src/race/race.js');
    Object.assign(M.AI_TUNE, { shortcuts: 1, flick: 1, slide: 1, mistakes: 1, traffic: 1, band: 1, nitro: 1 }, ablate);
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.startRace();
    G.race.laps = laps;
    const t = G.city.track;
    const R = G.race;

    const truth = new Map();          // name -> probe-measured crossing time, seconds since green
    const tactics = {};
    const cutEnter = {}, cutDone = {};
    const lapWas = new Map();
    const posWas = new Map(), churn = {}, seen = new Map();
    let green = null;                 // probe frame index of the green light
    let ended = null;                 // probe time the state left 'racing'
    let flagField = null;
    const atFinish = {};
    const pl = { n: 0, v: 0, off: 0, slow: 0, blocked: 0 };
    const trace = [];
    let lastKey = null;
    const N = Math.round(60 * seconds);

    for (let i = 0; i < N; i++) {
      const now = i / 60;
      if (green == null && R.state === 'racing') green = now;
      const raceT = green == null ? 0 : now - green;

      // ---- the reference player: a corner-aware racing-line autopilot
      if (idle) {
        G.input.setScripted({ steer: 0, throttle: 0, brake: 0, nitro: false, handbrake: false });
      } else {
        // A REFERENCE DRIVER THAT STAYS ON THE ROAD. The first cut of this aimed at a point ~93 m
        // up the lap and corrected on the raw main-track lateral: at 150 mph a whole car width of
        // error is a couple of degrees of steering, so it ran wide everywhere, and while the car
        // was up on an elevated shortcut (main-track lateral −3.3) it wound on full lock and came
        // off pointing at the far barrier. Same shape as the AI's own steering instead: a short
        // distance-based look-ahead onto the centreline, a slip damper, and a lift when wide.
        const near = t.nearest(G.body.pos, R?.playerU ?? null);
        const lat = clamp(near.lateral, -1.4, 1.4);
        const wide = clamp((Math.abs(lat) - 0.70) / 0.45, 0, 1);
        const v = G.body.speed;
        const aimDist = clamp(10 + Math.abs(v) * 0.72, 12, 62) * (1 - wide * 0.35);
        const aim = t.at(near.u + aimDist / t.length);
        const to = aim.pos.clone().sub(G.body.pos);
        const f = G.body.forward;
        const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
        let target = G.body.p.topSpeed;
        for (let d2 = 5; d2 < 340; d2 += 8) {
          const k = Math.abs(t.turnRate(near.u + d2 / t.length));
          if (k < 2e-4) continue;
          const vc = Math.sqrt(10.5 * Math.min(1 / k, 4000));
          const allow = Math.sqrt(vc * vc + 2 * 16 * d2);
          if (allow < target) target = allow;
        }
        target *= skill * (1 - wide * 0.30);
        const slipK = G.body.drift > 0.4 ? 0.7 : -0.6;
        G.input.setScripted({
          steer: clamp(-ang * 2.0 + G.body.slip * slipK, -1, 1),
          throttle: v < target ? 1 : 0,
          brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
          nitro: false, handbrake: false,
        });
            }

      G.update(1 / 60);

      // ---- ground truth: who has completed `laps` laps, measured on ONE clock
      const cars = [{ name: 'YOU', lap: R._playerCounter.lap, d: null },
        ...R.drivers.map((d) => ({ name: d.name, lap: d.counter.lap, d }))];
      for (const c of cars) {
        const prev = lapWas.get(c.name);
        lapWas.set(c.name, c.lap);
        if (prev != null && c.lap >= laps && prev < laps && !truth.has(c.name)) truth.set(c.name, raceT);
      }
      for (const d of R.drivers) {
        tactics[d.tactic] = (tactics[d.tactic] || 0) + 1;
        const on = !!d.branch;
        if (on && !d._probeOn) cutEnter[d.name] = (cutEnter[d.name] || 0) + 1;
        if (!on && d._probeOn && (d._branchT ?? 0) > 0.9) cutDone[d.name] = (cutDone[d.name] || 0) + 1;
        d._probeOn = on;
      }

      // what the PLAYER's race actually looks like: blocked, off the road, or flying
      if (R.state === 'racing' && green != null) {
        pl.n++; pl.v += Math.abs(G.body.speed);
        if (Math.abs(R.playerLateral || 0) > 1.05) pl.off++;
        if (Math.abs(G.body.speed) < 18) pl.slow++;
        let block = 1e9;
        for (const d of R.drivers) {
          const dx = d.body.pos.x - G.body.pos.x, dz = d.body.pos.z - G.body.pos.z;
          const along = dx * G.body.forward.x + dz * G.body.forward.z;
          const side = Math.abs(dx * G.body.right.x + dz * G.body.right.z);
          if (along > 0 && along < block && side < 3.2) block = along;
        }
        if (block < 14) pl.blocked++;
      }

      // position churn: how often each car's classified place actually changes
      if (R.standings.length) {
        for (let k = 0; k < R.standings.length; k++) {
          const s = R.standings[k];
          if (posWas.get(s.name) !== k + 1) {
            if (posWas.has(s.name) && R.state === 'racing') churn[s.name] = (churn[s.name] || 0) + 1;
            posWas.set(s.name, k + 1);
            const set = seen.get(s.name) || new Set();
            set.add(k + 1); seen.set(s.name, set);
          }
        }
      }

      const key = `${R.state}/${R.phase}/${R.playerLap}/${R.playerPos}`;
      if (key !== lastKey) { trace.push(`${raceT.toFixed(1)}s ${key}`); lastKey = key; }
      if (ended == null && green != null && R.state !== 'racing' && R.state !== 'countdown') {
        ended = raceT;
        // the field AS IT WAS AT THE FLAG — after it, everybody drives a cool-down lap and the
        // off-track / hit counters keep climbing, which is not the race
        flagField = R.telemetry().field;
      }
      // …and each driver's own numbers frozen the moment THEY finished
      for (const d of R.drivers) {
        if (d.finished && !atFinish[d.name]) {
          atFinish[d.name] = { off: +d.offT.toFixed(1), hits: d.hits, cuts: d.shortcuts };
        }
      }
      if (ended != null && raceT > ended + 6) break;
    }

    const fin = [...truth.entries()].sort((a, b) => a[1] - b[1]);
    return {
      city: G.cityId, laps, ended, state: R.state, phase: R.phase,
      rec: { record: R.record, over: R.overRecord, beaten: R.recordBeaten, winner: R.winnerTime, dnf: R.dnf },
      raceTime: +R.time.toFixed(2), wall: +R.wall.toFixed(2),
      finishTime: R.finishTime == null ? null : +R.finishTime.toFixed(2),
      playerFinishPos: R.playerFinishPos,
      trueOrder: fin.map(([n, s]) => `${n} ${s.toFixed(2)}s`),
      classified: (R.results || []).map((r) => `${r.pos} ${r.name}${r.finished ? ` FIN ${(r.finishTime ?? 0).toFixed(2)}` : (r.dnf ? ' DNF' : ' —')} lap=${r.lap}`),
      classifiedNames: (R.results || []).map((r) => r.name),
      standingsNames: R.standings.map((s) => s.name),
      truth: Object.fromEntries(fin),
      internalFinish: Object.fromEntries(R.drivers.map((d) => [d.name, d.finishTime == null ? null : +d.finishTime.toFixed(2)])),
      tactics, cutEnter, cutDone,
      field: flagField || R.telemetry().field, atFinish,
      contacts: R.contacts,
      recov: Object.fromEntries(R.drivers.map((d) => [d.name, d.recoveries || 0])),
      cars: Object.fromEntries(R.drivers.map((d) => [d.name, d.vehicleId])),
      lapTimes: Object.fromEntries(R.drivers.map((d) => [d.name, d.counter.lapTimes.map((x) => +x.toFixed(1))])),
      player: { mph: +(pl.v / Math.max(1, pl.n) * 2.2369).toFixed(1), offS: +(pl.off / 60).toFixed(1), slowS: +(pl.slow / 60).toFixed(1), blockedS: +(pl.blocked / 60).toFixed(1), contacts: R.playerContacts },
      churn, places: Object.fromEntries([...seen].map(([k, v]) => [k, [...v].sort((a, b) => a - b).join('/')])),
      skill: Object.fromEntries(R.drivers.map((d) => [d.name, +d.skill.toFixed(2)])),
      lens: Object.fromEntries(R.drivers.map((d) => [d.name, d.lensPushes || 0])),
      playerLaps: R.lapTimes.map((x) => +x.toFixed(1)),
      fieldPace: +R.fieldPace.toFixed(3),
      trace,
      err: (window.__ERRORS || []).slice(0, 4),
    };
  }, [LAPS, SECONDS, IDLE, SKILL, ABLATE]);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`=== ${out.city}  laps=${out.laps}  ${IDLE ? 'IDLE PLAYER' : 'racing player'} ===`);
  console.log(out.trace.join('\n'));
  console.log(`state=${out.state}/${out.phase} raceClock=${out.raceTime}s wall=${out.wall}s ended@${out.ended == null ? 'NEVER' : `${out.ended.toFixed(1)}s`} playerFinishPos=${out.playerFinishPos}`);
  console.log('\nTRUE ORDER (probe clock, from the green):');
  out.trueOrder.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('\nCLASSIFIED (race.results):');
  out.classified.forEach((s) => console.log(`  ${s}`));
  console.log('\nInternal finishTime stamps:', JSON.stringify(out.internalFinish));

  // mismatch check
  const trueNames = Object.keys(out.truth);
  const cls = out.classifiedNames.length ? out.classifiedNames : out.standingsNames;
  let bad = 0;
  for (let i = 0; i < trueNames.length; i++) {
    const want = trueNames[i];
    const got = cls[i];
    // a tie inside one 60 Hz frame is a tie: the probe cannot resolve it and neither can a viewer
    if (want !== got && Math.abs((out.truth[want] ?? 0) - (out.truth[got] ?? 1e9)) > 1 / 60) {
      console.log(`  MISMATCH place ${i + 1}: crossed=${want} (${out.truth[want]}) classified=${got} (${out.truth[got]})`);
      bad++;
    }
  }
  console.log(bad ? `\n*** ${bad} PLACES WRONG ***` : '\nclassification matches the crossing order for every finisher.');

  console.log('\nfield:');
  for (const f of out.field) {
    console.log(`  ${pad(f.name, 7)} ${pad(out.cars[f.name], 9)} sk=${out.skill[f.name]} lap=${f.lap} gap=${pad(f.gapM, 8)} off=${pad((out.atFinish[f.name]||f).off, 6)} hits=${pad((out.atFinish[f.name]||f).hits, 3)} cuts=${(out.atFinish[f.name]||f).cuts} skipSec=${f.skipped} lens=${out.lens[f.name]} churn=${out.churn[f.name] || 0} places=${out.places[f.name]} laps=${JSON.stringify(out.lapTimes[f.name])}`);
  }
  console.log(`  ${pad('YOU', 7)} ${pad('', 9)} churn=${out.churn.YOU || 0} places=${out.places.YOU}`);
  console.log('record:', JSON.stringify(out.rec));
  console.log('player:', JSON.stringify(out.player));
  console.log('player laps:', JSON.stringify(out.playerLaps), 'fieldPace', out.fieldPace);
  console.log('tactics:', JSON.stringify(out.tactics), 'contacts', out.contacts);
  if (out.err?.length) console.log('ERRORS', out.err);
} finally { await h.close(); }
