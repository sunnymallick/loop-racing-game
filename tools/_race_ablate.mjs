import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const CAR = String(arg('car', 'muscle'));
const SECS = Number(arg('secs', 40));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: CAR });
  const configs = JSON.parse(String(arg('cfg', '[{},{"shortcuts":0},{"traffic":0},{"flick":0,"slide":0},{"mistakes":0}]')));
  for (const cfg of configs) {
    await load(h.page, { city: CITY, car: CAR });
    const out = await h.page.evaluate(async ([secs, cfg]) => {
      const M = await import('/src/race/race.js');
      Object.assign(M.AI_TUNE, { shortcuts: 1, flick: 1, slide: 1, mistakes: 1, traffic: 1, band: 1 }, cfg);
      const G = window.__GAME.game;
      const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
      const n = Math.round(secs * 60);
      const offs = {}; const spun = {}; let aheadSum = 0, aheadN = 0, withinSum = 0;
      for (let i = 0; i < n; i++) {
        const t = G.city.track;
        const near = t.nearest(G.body.pos, G.race?.playerU ?? null);
        const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(G.body.speed) * 0.00042));
        const to = aim.pos.clone().sub(G.body.pos);
        const f = G.body.forward;
        const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
        const v = G.body.speed; const target = G.body.p.topSpeed * 0.92;
        G.input.setScripted({ steer: clamp(-ang * 2.2, -1, 1), throttle: v < target ? 1 : 0, brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0, nitro: false, handbrake: false });
        G.update(1 / 60);
        for (const d of G.race.drivers) {
          if (Math.abs(d.lateral) > 1.05) offs[d.name] = (offs[d.name] || 0) + 1 / 60;
          if (Math.abs(d.body.slip) > 1.1) spun[d.name] = (spun[d.name] || 0) + 1;
        }
        if (i % 10 === 0) { const r = G.race.telemetry(); aheadSum += r.packAhead; withinSum += r.packWithin; aheadN++; }
      }
      const r = G.race.telemetry();
      const offTot = Object.values(offs).reduce((a, b) => a + b, 0);
      const spunTot = Object.values(spun).reduce((a, b) => a + b, 0);
      return {
        off: +offTot.toFixed(0), spun: spunTot, contacts: r.contacts,
        ahead: +(aheadSum / aheadN).toFixed(2), within: +(withinSum / aheadN).toFixed(2),
        spread: Math.round(Math.max(...r.field.map((x) => x.gapM)) - Math.min(...r.field.map((x) => x.gapM))),
        laps: G.race.drivers.map((d) => d.counter.best ? +d.counter.best.toFixed(1) : null),
        hits: r.field.reduce((a, b) => a + b.hits, 0),
      };
    }, [SECS, cfg]);
    console.log(`${JSON.stringify(cfg).padEnd(28)} off=${String(out.off).padStart(4)}s spun=${String(out.spun).padStart(4)} hits=${String(out.hits).padStart(3)} contacts=${String(out.contacts).padStart(4)} ahead=${out.ahead} within=${out.within} spread=${out.spread}m best=${JSON.stringify(out.laps)}`);
  }
} finally { await h.close(); }
