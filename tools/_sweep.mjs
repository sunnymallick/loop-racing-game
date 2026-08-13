import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';
const DT=1/60, WB={tuner:2.55,muscle:2.95,suv:3.05,supercar:2.68};
const id=process.argv[2]||'muscle';
const key=process.argv[3]||'driftGrip';
const vals=(process.argv[4]||'0.3,0.35,0.4,0.45,0.5').split(',').map(Number);
const hbFrames=Number(process.argv[5]||20);
const CTR=Number(process.argv[6]||-0.55);
for(const v of vals){
  const ph=getHandling(id); ph[key]=v;
  const b=new VehicleBody({physics:ph,audio:getAudioProfile(id),nitro:getNitro(id)},{wheelbase:WB[id]});
  b.reset(new THREE.Vector3(),0);
  for(let i=0;i<900 && b.speed<40;i++) b.step(DT,{throttle:1},{});
  // adaptive flick: hold the handbrake until the car is sideways enough, like a driver
  let fl=0; const tgt=(ph.slipMax*0.45)/57.3;
  while(fl<hbFrames && Math.abs(b.slip)<tgt){ b.step(DT,{throttle:0.3,steer:1,handbrake:true},{}); fl++; }
  const log=[];
  for(let i=0;i<200;i++){ b.step(DT,{throttle:0.85,steer:CTR},{}); log.push({s:b.slip*57.3,a:b.aLat,v:b.groundSpeed,y:b.yawRate,r:b.rearGrip,as:b.assist*57.3}); }
  const tail=log.slice(120), avg=(f)=>tail.reduce((s,r)=>s+f(r),0)/tail.length;
  const ser=[0,30,60,90,120,150,180].map(i=>`${(log[i].s).toFixed(0)}`).join('/');
  const rr=[0,30,60,90,120,150,180].map(i=>`${(log[i].v/Math.max(0.02,Math.abs(log[i].y))).toFixed(0)}`).join('/');
  console.log(`${key}=${v} flick${fl}  slip@0/.5/1/1.5/2/2.5/3s ${ser}  R ${rr}  gLat ${(avg(r=>r.a)/9.81).toFixed(2)}  mph ${(log[0].v*2.237).toFixed(0)}->${(log[log.length-1].v*2.237).toFixed(0)}  assist ${avg(r=>r.as).toFixed(0)}°`);
}
