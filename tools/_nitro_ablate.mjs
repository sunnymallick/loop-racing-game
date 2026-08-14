// (nitrous piece, scratch) Which layer is flooding the frame? Capture the same boost frame with
// individual plume layers switched off.
// node tools/_nitro_ablate.mjs --city la --car muscle --shot nitrous-long --out shots/_nab
import fs from 'node:fs/promises';
import { boot, open, capture } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const city = arg('city', 'la'), car = arg('car', 'muscle');
const shot = arg('shot', 'nitrous-long'), out = arg('out', 'shots/_nab');

await fs.mkdir(out, { recursive: true });
const h = await boot({ width: 1600, height: 900 });
try {
  await open(h.page, h.url, { city, car });
  await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [1600, 900]);
  const modes = ['full', 'nopool', 'nocards', 'noshells', 'nostreaks', 'nolines', 'noboostgrade'];
  for (const m of modes) {
    await h.page.evaluate((s) => window.__GAME.load(s), { city, car });
    await h.page.evaluate((n) => window.__GAME.scenario(n, {}), shot);
    await h.page.evaluate((mode) => {
      const G = window.__GAME.game, jet = G.jet;
      if (mode === 'nopool') jet.pool.visible = false;
      if (mode === 'nostreaks') jet.streaks.mesh.visible = false;
      if (mode === 'nocards') for (const n of jet.nozzles) for (const c of n.cards) c.mesh.visible = false;
      if (mode === 'noshells') for (const n of jet.nozzles) for (const s of n.shells) s.visible = false;
      if (mode === 'nolines') G.engine.speed.uniforms.uLines.value = 0;
      if (mode === 'noboostgrade') { G.engine.grade.uniforms.uBoost.value = 0; G.engine.speed.uniforms.uAmount.value = 0; G.engine.speed.uniforms.uLines.value = 0; }
    }, m);
    await capture(h.page, `${out}/${city}-${car}-${m}.png`);
    console.log(m);
  }
  console.log(h.logs.slice(0, 5).join('\n'));
} finally { await h.close(); }
