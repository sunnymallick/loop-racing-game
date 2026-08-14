import fs from 'node:fs';
import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 800, height: 450 });
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  const url = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    let ridge = null;
    g.city.group.traverse((o) => {
      if (o.isMesh && o.geometry.attributes.position.count === 39431) ridge = o;
    });
    return ridge && ridge.material.map ? ridge.material.map.image.toDataURL('image/png') : null;
  });
  if (!url) throw new Error('no map');
  fs.writeFileSync(process.argv[2] || 'hillmap.png', Buffer.from(url.split(',')[1], 'base64'));
  console.log('written');
} finally { await h.close(); }
