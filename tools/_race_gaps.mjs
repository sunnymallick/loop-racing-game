/** Gap time-series: what the pack actually looks like around the player, second by second. */
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const SKILL = Number(arg('skill', 0.94));
const SECS = Number(arg('secs', 120));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async ([skill, secs]) => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.startRace();
    G.race.laps = 9;
    const t = G.city.track;
    const rows = [];
    for (let i = 0; i < 60 * secs; i++) {
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
      if (i % 120 === 0) {
        const R = G.race;
        const gaps = R.drivers.map((d) => ({
          n: d.name.slice(0, 3),
          g: Math.round((d.progress - R.playerProgress) * t.length),
          s: Math.round(d.station), t: +d.trim.toFixed(2), v: Math.round(d.body.speedMph),
        })).sort((a, b) => a.g - b.g);
        rows.push(`${R.time.toFixed(0).padStart(3)}s P${R.playerPos} fp=${R.fieldPace.toFixed(3)} pl=${Math.round(G.body.speedMph)}mph | `
          + gaps.map((x) => `${x.n}${x.g >= 0 ? '+' : ''}${x.g}(s${x.s},t${x.t},${x.v})`).join(' '));
      }
    }
    return { rows, lapTimes: G.race.lapTimes.map((x) => +x.toFixed(1)), err: (window.__ERRORS || []).slice(0, 3) };
  }, [SKILL, SECS]);
  console.log(out.rows.join('\n'));
  console.log('player lapTimes', JSON.stringify(out.lapTimes));
  if (out.err?.length) console.log('ERR', out.err);
} finally { await h.close(); }
