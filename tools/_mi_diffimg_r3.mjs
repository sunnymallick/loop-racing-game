import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [a,b,out,gainS] = process.argv.slice(2);
const gain = Number(gainS)||6;
const A=(await fs.readFile(a)).toString('base64'), B=(await fs.readFile(b)).toString('base64');
const br=await chromium.launch(); const p=await br.newPage({viewport:{width:1600,height:900}});
await p.setContent('<style>body{margin:0}</style><canvas id=x width=1600 height=900></canvas>');
await p.evaluate(async({A,B,gain})=>{
  const load=async(d)=>{const i=new Image();await new Promise(r=>{i.onload=r;i.src='data:image/png;base64,'+d});return i;};
  const ia=await load(A), ib=await load(B);
  const c=document.getElementById('x'); const cx=c.getContext('2d',{willReadFrequently:true});
  cx.drawImage(ia,0,0); const da=cx.getImageData(0,0,1600,900);
  cx.drawImage(ib,0,0); const db=cx.getImageData(0,0,1600,900);
  const o=cx.createImageData(1600,900);
  for(let i=0;i<da.data.length;i+=4){
    for(let k=0;k<3;k++) o.data[i+k]=Math.min(255,Math.abs(da.data[i+k]-db.data[i+k])*gain);
    o.data[i+3]=255;
  }
  cx.putImageData(o,0,0);
},{A,B,gain});
await p.screenshot({path:out});
await br.close();
console.log(out);
