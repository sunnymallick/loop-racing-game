/** Read mean luminance of named boxes out of a menu capture. */
import { chromium } from 'playwright';
import fs from 'node:fs';
const [inp, ...rest] = process.argv.slice(2);
const boxes = rest.map((s) => { const [n, x, y, w, h] = s.split(':'); return { n, x: +x, y: +y, w: +w, h: +h }; });
const b64 = fs.readFileSync(inp).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
await page.setContent(`<canvas id=c width=1600 height=900></canvas><script>
window.__go=(boxes)=>new Promise(res=>{const img=new Image();img.onload=()=>{
const x=document.getElementById('c').getContext('2d');x.drawImage(img,0,0);
res(boxes.map(b=>{const d=x.getImageData(b.x,b.y,b.w,b.h).data;let L=0,R=0,G=0,B=0,mx=0;
for(let i=0;i<d.length;i+=4){const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];L+=l;if(l>mx)mx=l;R+=d[i];G+=d[i+1];B+=d[i+2];}
const n=d.length/4;return{n:b.n,lum:+(L/n).toFixed(1),max:+mx.toFixed(0),r:+(R/n).toFixed(0),g:+(G/n).toFixed(0),b:+(B/n).toFixed(0)};}));};
img.src='data:image/png;base64,${b64}';});
</script>`);
console.log(JSON.stringify(await page.evaluate((b) => window.__go(b), boxes), null, 1));
await browser.close();
