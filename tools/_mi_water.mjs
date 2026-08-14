// Column scan: print rgb down a few columns so the water band can be located and measured.
import fs from 'fs';
import { PNG } from 'pngjs';

const file = process.argv[2];
const cols = (process.argv[3] || '120,300,520').split(',').map(Number);
const y0 = Number(process.argv[4] ?? 280);
const y1 = Number(process.argv[5] ?? 460);
const png = PNG.sync.read(fs.readFileSync(file));
const { width: W, data } = png;
const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
for (let y = y0; y <= y1; y += 2) {
  const parts = cols.map((x) => {
    const [r, g, b] = px(x, y);
    return `x${x}:${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)}`;
  });
  console.log(`y${String(y).padStart(3)}  ${parts.join('  ')}`);
}
