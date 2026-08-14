import { chromium } from 'playwright';
import fs from 'fs';
const [png, xs, ys, ws, hs] = process.argv.slice(2);
const b64 = fs.readFileSync(png).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ([b64, x, y, w, h]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(x, y, w, h).data;
  let r=0,g=0,b=0,n=0, mn=[255,255,255], mx=[0,0,0];
  for (let i=0;i<d.length;i+=4){ r+=d[i];g+=d[i+1];b+=d[i+2];n++;
    for(let k=0;k<3;k++){ if(d[i+k]<mn[k])mn[k]=d[i+k]; if(d[i+k]>mx[k])mx[k]=d[i+k]; } }
  return { mean:[r/n|0,g/n|0,b/n|0], min:mn, max:mx };
}, [b64, +xs, +ys, +ws, +hs]);
console.log(JSON.stringify(out));
await browser.close();
