#!/usr/bin/env node
/**
 * INDEPENDENT race verifier. Runs a real race from the grid (countdown included) to a terminal
 * state, recording MY OWN crossing order by watching each car's accumulated progress cross the
 * lap target, then compares that to the game's classification.
 */
import { boot, open, load } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = arg('city', 'la');
const CAR = arg('car', 'muscle');
const MODE = arg('mode', 'drive');   // drive | idle
const PACE = Number(arg('pace', 0.9));
const MAXS = Number(arg('maxs', 420));

const h = await boot({ gpu: false, width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  await load(h.page, { city: CITY, car: CAR });

  const out = await h.page.evaluate(async ({ mode, pace, maxs }) => {
    const G = window.__GAME, g = G.game;
    const DT = 1 / 60;
    g.state = 'racing';
    g.startRace();
    const race = g.race;
    const laps = race.laps;
    // start from the grid: countdown intact
    const names = race.drivers.map((d) => d.name);
    const cross = {};            // name -> {raceTime, wall, frame}
    let frame = 0;
    const tac = {}; let tacN = 0; const spread = [];
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const steer = () => {
      if (mode === 'idle') return { throttle: 0, brake: 0, steer: 0 };
      const t = g.city.track;
      const near = t.nearest(g.body.pos, race.playerU ?? null);
      const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(g.body.speed) * 0.00042));
      const to = aim.pos.clone().sub(g.body.pos);
      const f = g.body.forward;
      const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
      const target = g.body.p.topSpeed * pace;
      const v = g.body.speed;
      return {
        steer: clamp(-ang * 2.2, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0,
      };
    };

    const maxFrames = Math.ceil(maxs / DT);
    let terminalFrame = null;
    const trail = [];
    while (frame < maxFrames) {
      g.input.setScripted({ nitro: false, handbrake: false, ...steer() });
      g.update(DT);
      frame++;
      // ---- MY OWN crossing detector: accumulated progress reaching the lap target ----
      if (!cross.YOU && race.playerProgress >= laps) {
        cross.YOU = { raceTime: race.raceTime, wall: race.wall, frame, progress: race.playerProgress };
      }
      for (const d of race.drivers) {
        if (!cross[d.name] && d.progress >= laps) {
          cross[d.name] = { raceTime: race.raceTime, wall: race.wall, frame, progress: d.progress };
        }
      }
      if (frame % 10 === 0 && race.state === 'racing') {
        for (const d of race.drivers) {
          tac[d.tactic] = (tac[d.tactic] || 0) + 1;
          tacN++;
        }
        const ps = race.drivers.map((x) => x.progress);
        spread.push(+((Math.max(...ps) - Math.min(...ps))).toFixed(4));
      }
      if (frame % 60 === 0) {
        trail.push({
          t: +race.raceTime.toFixed(1), state: race.state, pos: race.playerPos,
          plap: +race.playerProgress.toFixed(2),
          lead: +Math.max(...race.drivers.map((d) => d.progress)).toFixed(2),
          last: +Math.min(...race.drivers.map((d) => d.progress)).toFixed(2),
        });
      }
      if (race.state !== 'countdown' && race.state !== 'racing') {
        if (terminalFrame == null) terminalFrame = frame;
        if (frame > terminalFrame + 60) break;   // let the flag settle a second
      }
    }
    g.input.clearScripted();
    const tel = race.telemetry();
    return {
      laps, names, cross, frames: frame, terminalFrame,
      state: race.state, dnf: race.dnf, playerFinished: race.playerFinished,
      finishTime: race.finishTime, winnerTime: race.winnerTime, raceTime: race.raceTime,
      results: (race.results || []).map((r) => ({
        pos: r.pos, name: r.name, you: !!r.you, finished: r.finished,
        finishTime: r.finishTime == null ? null : +r.finishTime.toFixed(2),
        dnf: !!r.dnf, lap: r.lap, progress: +(r.progress ?? 0).toFixed(3),
      })),
      field: tel.field.map((f) => ({ name: f.name, car: f.car, gapM: f.gapM, cuts: f.cuts, lap: f.lap, fin: f.fin })),
      timeout: race.timeout, tac, tacN, spread, trackLen: g.city.track.length,
    };
  }, { mode: MODE, pace: PACE, maxs: MAXS });

  console.log(JSON.stringify(out, null, 1));
} finally {
  await h.close();
}
