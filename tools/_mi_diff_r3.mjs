import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const [a,b] = process.argv.slice(2);
const A=(await fs.readFile(a)).toString('base64'), B=(await fs.readFile(b)).toString('base64');
const br=await chromium.launch(); const p=await br.newPage();
await p.setContent('<canvas id=x width=1600 height=900></canvas><canvas id=y width=1600 height=900></canvas>');
console.log(JSON.stringify(await p.evaluate(async({A,B})=>{
  const load=async(d)=>{const i=new Image();await new Promise(r=>{i.onload=r;i.src='data:image/png;base64,'+d});return i;};
  const ia=await load(A), ib=await load(B);
  const cx=document.getElementById('x').getContext('2d',{willReadFrequently:true});
  const cy=document.getElementById('y').getContext('2d',{willReadFrequently:true});
  cx.drawImage(ia,0,0); cy.drawImage(ib,0,0);
  const da=cx.getImageData(0,0,1600,900).data, db=cy.getImageData(0,0,1600,900).data;
  let n=0, maxd=0, mx=0,my=0, sum=0;
  for(let i=0;i<da.length;i+=4){
    const d=Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2]);
    if(d>6){n++; sum+=d; if(d>maxd){maxd=d; const px=(i/4)|0; mx=px%1600; my=(px/1600)|0;}}
  }
  return {changedPx:n, meanDelta:+(sum/Math.max(n,1)).toFixed(1), maxDelta:maxd, at:[mx,my]};
},{A,B}))); await br.close();
