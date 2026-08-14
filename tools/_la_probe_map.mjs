import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    let ridge = null;
    g.city.group.traverse((o) => {
      if (o.isMesh && o.geometry.attributes.position.count === 39431) ridge = o;
    });
    if (!ridge) return 'no ridge';
    const m = ridge.material;
    const im = m.map && m.map.image;
    let stats = null;
    if (im && im.getContext) {
      const c2 = im.getContext('2d', { willReadFrequently: true });
      const d = c2.getImageData(0, 0, im.width, im.height).data;
      const ch = [[], [], []];
      for (let i = 0; i < d.length; i += 4 * 37) { ch[0].push(d[i]); ch[1].push(d[i+1]); ch[2].push(d[i+2]); }
      stats = ch.map((a) => { a.sort((x,y)=>x-y); const mn = a.reduce((p,q)=>p+q,0)/a.length;
        return `p05 ${a[(a.length*0.05)|0]} p50 ${a[(a.length*0.5)|0]} p95 ${a[(a.length*0.95)|0]} mean ${mn.toFixed(0)}`; });
    }
    return { size: im ? [im.width, im.height] : null, stats,
      fog: { type: g.city.fog.type ?? g.city.fog.constructor.name, near: g.city.fog.near, far: g.city.fog.far, color: g.city.fog.color.getHexString() },
      matFog: m.fog, cs: m.map && m.map.colorSpace, vc: m.vertexColors };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await h.close(); }
