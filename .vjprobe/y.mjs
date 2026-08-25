// deck height (max y) and flank half-width of the finished tub, sampled off the real shell
import * as THREE from 'three';
import { loftTub } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/kit.js';
import { bodySection } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/assemble.js';
const car = process.argv[2];
const mod = await import(`/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/${car}.js`);
const bp = mod.blueprint;
const secs = bp.body.map((s) => bodySection(s.z, s));
const wb = bp.dims.wheelbase, trF = bp.dims.track, trR = bp.dims.trackRear ?? trF;
const S = [...secs].sort((a,b)=>a.z-b.z);
const wA=(pts,y)=>{ if(y<=pts[0][1])return pts[0][0]; for(let k=1;k<pts.length;k++){ if(y<=pts[k][1]){const t=(y-pts[k-1][1])/((pts[k][1]-pts[k-1][1])||1); return pts[k-1][0]+(pts[k][0]-pts[k-1][0])*t;} } return pts[pts.length-1][0]; };
const bodyAt=(z,y)=>{ if(z<=S[0].z)return wA(S[0].pts,y); const L=S[S.length-1]; if(z>=L.z)return wA(L.pts,y);
  for(let k=1;k<S.length;k++){ if(z<=S[k].z){const a=S[k-1],b=S[k],t=(z-a.z)/((b.z-a.z)||1); return wA(a.pts,y)*(1-t)+wA(b.pts,y)*t;} } return wA(L.pts,y); };
const openings = [];
for (let i = 0; i < 2; i++) {
  const isF = i === 0; const cfg = isF ? bp.wheels.front : bp.wheels.rear;
  const hub = (isF ? trF : trR) / 2;
  openings.push({ z: isF ? wb/2 : -wb/2, y: cfg.radius, r: cfg.radius*(bp.archGap??1.09), tyreR: cfg.radius,
    tyreX: hub + cfg.width*0.5, wellX: Math.max(0.10, hub - cfg.width*0.5 - 0.015),
    margin: bp.archProud??0.010, proud: bp.archLip??0.014, flareW: bp.archFlare??0.13,
    inset: bp.archInset??0.048, depth: bp.archDepth??0.11, span: Math.PI*(bp.archSpan??1.04), bodyAt });
}
const g = loftTub(secs, { openings, flareAt: bp.blackArches ? (bp.archBlackBand ?? 0.40) : null,
  noseCap: bp.nose||{}, tailCap: bp.tail||{}, deckWells: bp.deck?.wells||[] });
const P = g.shell.attributes.position;
for (const a of process.argv.slice(3)) {
  const [mode, p1, p2] = a.split(',');   // "y,x,z" -> deck height ; "w,z,y" -> half width
  if (mode === 'y') {
    const x = +p1, z = +p2; let hi = -9;
    for (let i=0;i<P.count;i++){ if (Math.abs(Math.abs(P.getX(i))-Math.abs(x))<0.05 && Math.abs(P.getZ(i)-z)<0.05) hi = Math.max(hi, P.getY(i)); }
    console.log(`${car} deck y at x=${x} z=${z} -> ${hi.toFixed(4)}`);
  } else {
    const z = +p1, y = +p2; let hi = -9;
    for (let i=0;i<P.count;i++){ if (Math.abs(P.getZ(i)-z)<0.04 && Math.abs(P.getY(i)-y)<0.02) hi = Math.max(hi, Math.abs(P.getX(i))); }
    console.log(`${car} halfwidth at z=${z} y=${y} -> ${hi.toFixed(4)}`);
  }
}
