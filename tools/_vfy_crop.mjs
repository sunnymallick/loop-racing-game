import {PNG} from 'pngjs'; import fs from 'fs';
const [,,src,out,X,Y,W,H,scale=1] = process.argv;
const x=+X,y=+Y,w=+W,h=+H,s=+scale;
const a=PNG.sync.read(fs.readFileSync(src));
const o=new PNG({width:w*s,height:h*s});
for(let j=0;j<h*s;j++)for(let i=0;i<w*s;i++){
  const si=((y+Math.floor(j/s))*a.width+(x+Math.floor(i/s)))*4, di=(j*(w*s)+i)*4;
  for(let k=0;k<4;k++) o.data[di+k]=a.data[si+k];
}
fs.writeFileSync(out, PNG.sync.write(o));
