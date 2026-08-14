// Where does an opponent actually leave the road? Per-driver off-track episode log.
import { boot, open, load } from './harness.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const CITY = String(arg('city', 'la'));
const WHO = String(arg('who', ''));
const h = await boot({ width: 640, height: 360 });
try {
  await open(h.page, h.url, { city: CITY, car: 'muscle' });
  await load(h.page, { city: CITY, car: 'muscle' });
  const out = await h.page.evaluate(async ([who]) => {
    const G = window.__GAME.game;
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    G.startRace();
    G.race.laps = 3;
    const t = G.city.track;
    const eps = {};   // name -> episodes
    const open_ = {};
    for (const d of G.race.drivers) { eps[d.name] = []; open_[d.name] = null; }
    for (let i = 0; i < 60 * 200; i++) {
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
      G.input.setScripted({
        steer: clamp(-ang * 2.0 - near.lateral * 0.35 - G.body.slip * 0.5, -1, 1),
        throttle: v < target ? 1 : 0,
        brake: v > target * 1.02 ? clamp((v - target) * 0.12, 0, 1) : 0,
        nitro: false, handbrake: false,
      });
      G.update(1 / 60);
      for (const d of G.race.drivers) {
        const off = Math.abs(d.lateral) > 1.05;
        if (off && !open_[d.name]) {
          open_[d.name] = {
            t0: +time.toFixed(1), u0: +d.u.toFixed(3), mph0: Math.round(d.body.speedMph),
            lat0: +d.lateral.toFixed(2), branch: !!d.branch, want: !!d.wantBranch,
            tactic: d.tactic, drift0: +d.body.drift.toFixed(2), trim: +d.trim.toFixed(2),
            maxLat: Math.abs(d.lateral), hits: 0,
          };
        } else if (off && open_[d.name]) {
          open_[d.name].maxLat = Math.max(open_[d.name].maxLat, Math.abs(d.lateral));
          if (d.wallHit > 0.02) open_[d.name].hits++;
        } else if (!off && open_[d.name]) {
          const e = open_[d.name];
          e.dur = +(time - e.t0).toFixed(1);
          e.maxLat = +e.maxLat.toFixed(2);
          if (e.dur > 0.4) eps[d.name].push(e);
          open_[d.name] = null;
        }
      }
      if (G.race.state === 'finished') break;
    }
    const tot = {};
    for (const d of G.race.drivers) tot[d.name] = { off: +d.offT.toFixed(1), car: d.vehicleId, skill: +d.skill.toFixed(2) };
    return { eps, tot, who };
  }, [WHO]);
  for (const [n, v] of Object.entries(out.tot)) {
    console.log(`${n} ${v.car} skill=${v.skill} offT=${v.off}`);
    const list = out.eps[n].sort((a, b) => b.dur - a.dur).slice(0, 6);
    for (const e of list) {
      console.log(`   t=${e.t0}s dur=${e.dur}s u=${e.u0} mph=${e.mph0} lat0=${e.lat0}→${e.maxLat} drift=${e.drift0} tactic=${e.tactic} branch=${e.branch}/${e.want} trim=${e.trim} hits=${e.hits}`);
    }
  }
} finally { await h.close(); }
