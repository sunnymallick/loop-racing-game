#!/usr/bin/env node
// Independent verifier captures: menu hero for all four cars, plus city defect shots.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, scenario, capture } from './harness.mjs';

const OUT = process.argv[2] || '/tmp/vfy';
await fs.mkdir(OUT, { recursive: true });
const h = await boot({ gpu: false, width: 1600, height: 900 });
try {
  for (const car of ['tuner', 'muscle', 'suv', 'supercar']) {
    await open(h.page, h.url, { city: 'la', car });
    await scenario(h.page, 'menu');
    await capture(h.page, path.join(OUT, `menu-${car}.png`), { width: 1600, height: 900 });
    console.log('menu', car);
  }
} finally { await h.close(); }
