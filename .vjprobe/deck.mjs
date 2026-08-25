// analytic surface height of the tub's top deck at (x, z), straight off bodySection
import { bodySection } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/assemble.js';
const car = process.argv[2];
const bp = (await import(`/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/${car}.js`)).blueprint;
const secs = bp.body.map((s) => bodySection(s.z, s)).sort((a,b)=>a.z-b.z);
const lerp=(a,b,t)=>a+(b-a)*t;
const deckY = (pts, x) => {          // pts 9,10,11 are the deck: edge -> crown -> centre
  const P = [pts[9], pts[10], pts[11]];
  const ax = Math.abs(x);
  if (ax >= P[0][0]) return P[0][1];
  for (let i=1;i<3;i++) if (ax >= P[i][0]) { const t=(P[i-1][0]-ax)/((P[i-1][0]-P[i][0])||1); return lerp(P[i-1][1],P[i][1],t); }
  return P[2][1];
};
const flankX = (pts, y) => { if(y<=pts[0][1])return pts[0][0]; for(let k=1;k<pts.length;k++){ if(y<=pts[k][1]){const t=(y-pts[k-1][1])/((pts[k][1]-pts[k-1][1])||1); return lerp(pts[k-1][0],pts[k][0],t);} } return pts[pts.length-1][0]; };
const at = (z, fn) => {
  if (z<=secs[0].z) return fn(secs[0].pts);
  const L=secs[secs.length-1]; if (z>=L.z) return fn(L.pts);
  for(let k=1;k<secs.length;k++) if (z<=secs[k].z){const a=secs[k-1],b=secs[k],t=(z-a.z)/((b.z-a.z)||1); return lerp(fn(a.pts),fn(b.pts),t);}
  return fn(L.pts);
};
for (const a of process.argv.slice(3)) {
  const [m,p1,p2]=a.split(',');
  if (m==='y') console.log(`${car} deck y @ x=${p1} z=${p2} -> ${at(+p2,(pts)=>deckY(pts,+p1)).toFixed(4)}`);
  else console.log(`${car} flank x @ z=${p1} y=${p2} -> ${at(+p1,(pts)=>flankX(pts,+p2)).toFixed(4)}`);
}
