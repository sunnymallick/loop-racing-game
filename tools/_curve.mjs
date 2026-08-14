#!/usr/bin/env node
/**
 * Static drift-equilibrium map. For each class, at fixed ground speed and throttle with the wheel
 * STRAIGHT, sweep slip angle beta. At each beta solve for the yaw rate r* that holds beta constant
 * (aLat = r*·vLong), then report the residual yaw acceleration there. Same sign as r* = the slide
 * feeds itself; opposite sign = the slide winds down.
 */
import { getHandling } from '../src/vehicles/handling.js';
const R2D = 57.29578, D2R = 1/R2D, G = 9.81;
const WB = { tuner:2.55, muscle:2.95, suv:3.05, supercar:2.68 };
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const smoothstep=(e0,e1,x)=>{const t=clamp((x-e0)/(e1-e0),0,1);return t*t*(3-2*t);};
const sat=(x)=>x/Math.sqrt(1+x*x);

function engineForce(p, v, throttle) {
  const norm = clamp(v/p.topSpeed,0,1.35), gears=p.gears, gPos=norm*gears;
  const gIdx = clamp(Math.floor(gPos),0,gears-1);
  const gearFrac = clamp(gPos-gIdx,0,1.06), rpmN=clamp(0.26+0.74*gearFrac,0,1.1);
  const bw=Math.max(0.08,p.bandWidth);
  const band=Math.exp(-((rpmN-p.peakAt)**2)/(2*bw*bw));
  let torque=p.torqueLow+(p.torquePeak-p.torqueLow)*band;
  torque*=1-0.34*smoothstep(0.94,1.06,rpmN);
  const ratio=p.gearLow*Math.pow(p.gearHigh/p.gearLow, gIdx/Math.max(1,gears-1));
  return { engine: throttle*p.power*torque*ratio, norm };
}
function evalBeta(id, v, beta, throttle, escOn=true, commit=0.18, floor=0.24) {
  const p=getHandling(id), L=WB[id], a=L*(1-p.weightFront), b=L*p.weightFront;
  const massN=p.mass/1400, alphaPeak=Math.max(0.04,p.alphaPeak);
  const vLong=v*Math.cos(beta), vLat=v*Math.sin(beta);
  const { engine, norm } = engineForce(p, Math.abs(vLong), throttle);
  const gripCap=p.traction*massN*(1+p.downforce*norm*norm*0.6);
  const rearLoad=clamp(engine/Math.max(1e-3,gripCap),0,1.8);
  const df=1+p.downforce*norm*norm;
  const muF0=p.gripFront*G*df, muR0=p.gripRear*G*df;
  const circle=Math.sqrt(Math.max(0.02,1-Math.pow(clamp(rearLoad*p.powerOversteer,0,0.99),2)));
  const allow=p.slipMax*D2R*(floor+(1-floor)*commit);
  let r = 0;
  let out=null;
  for (let it=0; it<200; it++) {
    const alphaR=Math.atan2(vLat-r*b, v), alphaF=Math.atan2(vLat+r*a, v);
    const rearBeyond=clamp(Math.abs(alphaR)/alphaPeak-1,0,2)*0.5;
    const kinetic=1-p.driftFade*rearBeyond*(0.35+0.65*throttle);
    const esc=escOn?smoothstep(allow,allow+0.23,Math.abs(beta)):0;
    const rearCut=clamp(Math.max(p.driftGrip,circle*kinetic)+esc*p.escGrip,0.05,1.6);
    const muF=muF0, muR=muR0*rearCut;
    const biteF=1+p.driftBite*rearBeyond;
    const fyf=-muF*sat(alphaF/alphaPeak), fyr=-muR*sat(alphaR/alphaPeak);
    const aLat=fyf*biteF+fyr;
    const rNew=aLat/vLong;
    out={alphaF,alphaR,fyf,fyr,aLat,rearCut,muF,muR,biteF,kinetic,circle,esc,rearBeyond};
    if (Math.abs(rNew-r)<1e-9) { r=rNew; break; }
    r = r + 0.35*(rNew-r);
  }
  const M=(a*out.fyf-b*out.fyr)/p.yawInertia - r*p.yawDamp;
  return { r, M, feed: M*Math.sign(r||1), ...out };
}
const ids=['tuner','muscle','suv','supercar'];
console.log('Saturated-drift moment ratio  needRearCut = (a/b)·(gripF/gripR) = ((1-wF)/wF)·(gripF/gripR)');
for(const id of ids){const p=getHandling(id);
  console.log(`  ${id.padEnd(9)} wF ${p.weightFront}  gripF/R ${(p.gripFront/p.gripRear).toFixed(3)}  ->  needRearCut ${(((1-p.weightFront)/p.weightFront)*(p.gripFront/p.gripRear)).toFixed(3)}`);}
for (const escOn of [true,false]) {
 console.log(`\n=== residual yaw accel at the beta-holding yaw rate,  v=45 m/s, throttle 0.6, steer 0   [ESC ${escOn?'on':'OFF'}] ===`);
 console.log('           ' + [5,10,15,20,25,30,35,40].map(d=>String(d+'°').padStart(9)).join(''));
 for(const id of ids){
  const row=[5,10,15,20,25,30,35,40].map(d=>{const e=evalBeta(id,45,d*D2R,0.6,escOn);return (e.feed>0?'+':'')+e.feed.toFixed(2);});
  console.log('  '+id.padEnd(9)+row.map(s=>s.padStart(9)).join(''));
 }
 console.log('  (+ = the slide feeds itself,  - = it winds down)');
}
console.log('\n=== rearCut vs needRearCut at beta=20°, v=45, throttle 0.6 ===');
for(const id of ids){const e=evalBeta(id,45,20*D2R,0.6,true);const p=getHandling(id);
  const need=((1-p.weightFront)/p.weightFront)*(p.gripFront/p.gripRear);
  console.log(`  ${id.padEnd(9)} rearCut ${e.rearCut.toFixed(3)} (circle ${e.circle.toFixed(3)} x kinetic ${e.kinetic.toFixed(3)}, esc ${e.esc.toFixed(2)})  need ${need.toFixed(3)}  ${e.rearCut>=need?'RESTORES':'SUSTAINS'}`);}
