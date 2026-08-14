import fs from 'node:fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(fs.readFileSync(process.argv[2]));
for (const spec of process.argv.slice(3)) {
  const [x, y, w, h] = spec.split(',').map(Number);
  const ch = [[], [], []];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const k = (j * png.width + i) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(png.data[k + c]);
  }
  const out = ch.map((a) => {
    const m = a.reduce((p, q) => p + q, 0) / a.length;
    const sd = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length);
    a.sort((p, q) => p - q);
    return `${m.toFixed(0)}±${sd.toFixed(0)}[${a[(a.length*0.05)|0]}..${a[(a.length*0.95)|0]}]`;
  });
  console.log(spec, out.join('  '));
}
