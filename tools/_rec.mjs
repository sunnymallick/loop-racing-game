import * as THREE from 'three';
import { VehicleBody } from '../src/vehicles/physics.js';
import { getHandling } from '../src/vehicles/handling.js';
import { getAudioProfile } from '../src/vehicles/audio_tuning.js';
import { getNitro } from '../src/vehicles/nitrous.js';
const DT=1/60, WB={tuner:2.55,muscle:2.95,suv:3.05,supercar:2.68};
for (const id of ['tuner','muscle','suv','supercar']) {
  const p=getHandling(id);
  const b=new VehicleBody({physics:p,audio:getAudioProfile(id),nitro:getNitro(id)},{wheelbase:WB[id]});
  b.reset(new THREE.Vector3(),0);
  for(let i=0;i<600 && b.speed<40;i++) b.step(DT,{throttle:1},{});
  let f=0; while(f<34 && Math.abs(b.slip)<p.slipMax*0.45/57.3){ b.step(DT,{throttle:0.3,steer:1,handbrake:true},{}); f++; }
  for(let i=0;i<120;i++) b.step(DT,{throttle:0.85,steer:-0.55},{});
  const peak=b.slip*57.3;
  // recovery A: lift + centre
  const t=[];
  for(let i=0;i<120;i++){ b.step(DT,{throttle:0.25,steer:0},{}); if(i%20===0)t.push((b.slip*57.3).toFixed(1)); }
  // then drive away
  for(let i=0;i<60;i++) b.step(DT,{throttle:1,steer:0},{});
  console.log(`${id.padEnd(9)} drift ${peak.toFixed(0)}° → recovery ${t.join(' ')} → end slip ${(b.slip*57.3).toFixed(1)}° yaw ${b.yawRate.toFixed(2)} mph ${b.speedMph.toFixed(0)}`);
}
// impact recovery: hit a wall at speed, then drive on
for (const id of ['muscle','supercar']) {
  const p=getHandling(id);
  const b=new VehicleBody({physics:p,audio:getAudioProfile(id),nitro:getNitro(id)},{wheelbase:WB[id]});
  b.reset(new THREE.Vector3(),0);
  for(let i=0;i<400 && b.speed<45;i++) b.step(DT,{throttle:1},{});
  const n=new THREE.Vector3(-1,0,-0.25).normalize();
  const s=b.impact(n,0.28,0.62);
  const tr=[];
  for(let i=0;i<180;i++){ b.step(DT,{throttle:1,steer:0},{}); if(i%30===0)tr.push(`${(b.slip*57.3).toFixed(0)}°/${b.yawRate.toFixed(2)}`); }
  console.log(`${id} impact ${s.toFixed(2)} → ${tr.join(' ')} → mph ${b.speedMph.toFixed(0)} slip ${(b.slip*57.3).toFixed(1)}`);
}
