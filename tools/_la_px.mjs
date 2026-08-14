import fs from 'node:fs';
import { PNG } from 'pngjs';
const f = process.argv[2];
const png = PNG.sync.read(fs.readFileSync(f));
for (const spec of process.argv.slice(3)) {
  const [x, y, w = 8, h = 8] = spec.split(',').map(Number);
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const k = (j * png.width + i) * 4;
    r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
  }
  console.log(spec, '->', (r / n).toFixed(1), (g / n).toFixed(1), (b / n).toFixed(1));
}
