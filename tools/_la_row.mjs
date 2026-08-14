import fs from 'node:fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(fs.readFileSync(process.argv[2]));
const y = +process.argv[3], x0 = +process.argv[4], x1 = +process.argv[5];
let s = '';
for (let x = x0; x <= x1; x += 2) {
  const k = (y * png.width + x) * 4;
  s += `${x}:${png.data[k]},${png.data[k+1]},${png.data[k+2]}  `;
}
console.log(s);
