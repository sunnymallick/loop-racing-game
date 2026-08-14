/**
 * RACE build-pass probe. Runs a full race in a city with a reference-quality autopilot player and
 * reports what §6.10 is actually judged on: pack density in shot, fairness, spectacle, cheating.
 *
 *   node tools/_race_bp.mjs --city la --laps 2 --skill 0.94
 */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const LAPS = Number(arg('laps', 2));
const SKILL = Number(arg('skill', 0.94));
const CAR = String(arg('car', 'muscle'));

const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });
  const out = await h.page.evaluate(async ([laps, skill, ablate]) => {
    const G = window.__GAME.game;
    if (ablate) {
      const M = await import('/src/race/race.js');
      for (const k of ablate.split(',')) M.AI_TUNE[k] = 0;
    }
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.startRace();
    G.race.laps = laps;
    const t = G.city.track;
    const S = { samples: 0, aheadInView: [0, 0, 0, 0, 0, 0, 0, 0, 0], nearAhead: 0, minGap: 1e9 };
    let posLog = [];
    let lastPos = null;
    let visNitro = 0, visDrift = 0, visSamples = 0, visCars = 0;
    let maxStep = 0, stepWho = '';
    const prevSpeed = new Map();
    let bandVis = 0, bandVisMax = 0, bandN = 0;
    let overtakesOnPlayer = 0, playerPasses = 0;
    const startT = performance.now();
    for (let i = 0; i < 60 * 400; i++) {
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
      target *= skill;
      G.input.setScripted({
        steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
        nitro: v > target * 0.9 && G.nitro.tanks > 0, handbrake: false,
      });
      G.update(1 / 60);
      const R = G.race;
      if (i % 12 === 0 && R.state === 'racing') {
        S.samples++;
        const cam = G.engine.camera;
        let inView = 0;
        for (const d of R.drivers) {
          const dist = d.body.pos.distanceTo(cam.position);
          // exact frustum test: project the car through the live camera
          const ndc = d.body.pos.clone().project(cam);
          const gapM = (d.progress - R.playerProgress) * t.length;
          if (gapM > 0) S.minGap = Math.min(S.minGap, gapM);
          const visible = ndc.z < 1 && Math.abs(ndc.x) < 0.96 && Math.abs(ndc.y) < 0.96 && dist < 170;
          if (visible && gapM > 0) inView++;
          if (dist < 90) {
            visSamples++;
            if (d.nitro.ramp > 0.05) visNitro++;
            if (d.body.drift > 0.25) visDrift++;
            bandVis += Math.abs(d.band); bandVisMax = Math.max(bandVisMax, Math.abs(d.band)); bandN++;
          }
          const ps = prevSpeed.get(d.id);
          if (ps != null && dist < 120) {
            const step = Math.abs(d.body.speed - ps) / 0.2;
            if (step > maxStep) { maxStep = step; stepWho = d.name; }
          }
          prevSpeed.set(d.id, d.body.speed);
        }
        S.aheadInView[Math.min(8, inView)]++;
        visCars = Math.max(visCars, inView);
        if (lastPos != null && R.playerPos !== lastPos) {
          if (R.playerPos > lastPos) overtakesOnPlayer++; else playerPasses++;
          posLog.push(`${R.time.toFixed(1)}s P${lastPos}->P${R.playerPos}`);
        }
        lastPos = R.playerPos;
      }
      if (R.state === 'finished' && R.finishTime && (i / 60) > R.finishTime + 4) break;
      if (performance.now() - startT > 240000) break;
    }
    const R = G.race;
    return {
      playerPos: R.playerPos, playerFinish: R.finishTime, lapTimes: R.lapTimes.map((x) => +x.toFixed(2)),
      results: (R.results || R.standings).map((r) => `${r.pos} ${r.name}${r.you ? '*' : ''} ${r.finished ? (r.finishTime ?? 0).toFixed(1) : 'DNF'}`),
      finishTimes: R.drivers.map((d) => `${d.name} ${d.finishTime ? d.finishTime.toFixed(1) : 'DNF'} lap=${d.lap}`),
      inViewHist: S.aheadInView, samples: S.samples,
      inViewMean: +(S.aheadInView.reduce((a, b, i2) => a + b * i2, 0) / Math.max(1, S.samples)).toFixed(2),
      pctTwoToFour: +((S.aheadInView[2] + S.aheadInView[3] + S.aheadInView[4]) / Math.max(1, S.samples) * 100).toFixed(0),
      pctZero: +(S.aheadInView[0] / Math.max(1, S.samples) * 100).toFixed(0),
      pctOneOrMore: +((S.samples - S.aheadInView[0]) / Math.max(1, S.samples) * 100).toFixed(0),
      nitroNearPct: +(visNitro / Math.max(1, visSamples) * 100).toFixed(1),
      driftNearPct: +(visDrift / Math.max(1, visSamples) * 100).toFixed(1),
      bandNearMean: +(bandVis / Math.max(1, bandN)).toFixed(3), bandNearMax: +bandVisMax.toFixed(2),
      maxAccelStep: +maxStep.toFixed(1), stepWho,
      posLog: posLog.slice(0, 30), overtakesOnPlayer, playerPasses,
      contacts: R.contacts, playerContacts: R.playerContacts, reforms: R.reforms, cuts: R.telemetry().cuts,
      field: R.telemetry().field.map((f) => `${f.name} ${f.car} lap=${f.lap} off=${f.off}s hits=${f.hits} cuts=${f.cuts}`),
      recov: R.drivers.map((d) => `${d.name}:${d.recoveries || 0}`).join(' '),
      err: (window.__ERRORS || []).slice(0, 4),
    };
  }, [LAPS, SKILL, String(arg('ablate', ''))]);
  console.log(`--- ${CITY} ${CAR} skill=${SKILL} laps=${LAPS}`);
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) console.log(`${k}:\n  ${v.join('\n  ')}`);
    else console.log(`${k}: ${v}`);
  }
} finally { await h.close(); }
