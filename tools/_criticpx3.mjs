import {chromium} from 'playwright';import fs from 'node:fs/promises';
const f=process.argv[2];const pts=JSON.parse(process.argv[3]);
const b64=(await fs.readFile(f)).toString('base64');
const br=await chromium.launch();const p=await br.newPage();
await p.setContent(`<canvas id=c width=1600 height=900></canvas><script>const i=new Image();i.onload=()=>{document.getElementById('c').getContext('2d').drawImage(i,0,0);window.__d=1};i.src='data:image/png;base64,${b64}'</script>`);
await p.waitForFunction('window.__d===1');
const out=await p.evaluate((pts)=>{const c=document.getElementById('c').getContext('2d');return pts.map(([x,y])=>{const d=c.getImageData(x,y,1,1).data;return `${x},${y}: ${d[0]},${d[1]},${d[2]}`})},pts);
console.log(out.join('\n'));await br.close();
