import * as THREE from 'three';
import { VehicleBody } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/physics.js';
import { getHandling } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/handling.js';
import { getAudioProfile } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/audio_tuning.js';
import { getNitro } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/nitrous.js';
import { Track } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/cities/track.js';
const DT=1/60, WB={tuner:2.55,muscle:2.95,suv:3.05,supercar:2.68};
const LA={width:10.5,bank:0.06,main:[[0,0],[140,-18],[270,-70],[350,-170],[355,-290],[300,-380],[190,-430],[60,-430],[-70,-400],[-170,-330],[-230,-230],[-250,-120],[-200,-30],[-100,20],[0,0]]};
const track=new Track(LA);
// radius profile
let out=[];
for(let u=0;u<1;u+=0.02){ const k=track.turnRate(u); out.push(`${u.toFixed(2)}:${k===0?'inf':(1/Math.abs(k)).toFixed(0)}${k<0?'R':'L'}`);}
console.log('radius(m) by u:', out.join(' '));

const mk=(id)=>new VehicleBody({physics:getHandling(id),audio:getAudioProfile(id),nitro:getNitro(id)},{wheelbase:WB[id]});
// flat-plane drift bench: reach speed, flick, then hold a constant counter-steer
for(const id of ['tuner','muscle','suv','supercar']){
  for(const [spd,ctr] of [[40,-0.55],[36,-0.55],[32,-0.55]]){
    const b=mk(id); b.reset(new THREE.Vector3(),0);
    // spin up to speed
    for(let i=0;i<600 && b.speed<spd;i++) b.step(DT,{throttle:1},{});
    for(let i=0;i<20;i++) b.step(DT,{throttle:0.3,steer:1,handbrake:true},{});
    const log=[];
    for(let i=0;i<240;i++){ b.step(DT,{throttle:0.85,steer:ctr},{}); log.push({slip:b.slip*57.3,aLat:b.aLat,v:b.groundSpeed,yaw:b.yawRate,rg:b.rearGrip,as:b.assist*57.3,ws:b.wheelSlip}); }
    const tail=log.slice(150);
    const avg=(f)=>tail.reduce((s,r)=>s+f(r),0)/tail.length;
    const R = avg(r=>r.v)/Math.max(1e-3,Math.abs(avg(r=>r.yaw)));
    console.log(`${id.padEnd(9)} v=${spd} ctr=${ctr}  slip ${avg(r=>r.slip).toFixed(0)}° (min ${Math.min(...tail.map(r=>r.slip)).toFixed(0)} max ${Math.max(...tail.map(r=>r.slip)).toFixed(0)})  gLat ${(avg(r=>r.aLat)/9.81).toFixed(2)}  v ${(avg(r=>r.v)*2.237).toFixed(0)}mph  R ${R.toFixed(0)}m  rear ${avg(r=>r.rg).toFixed(2)}  assist ${avg(r=>r.as).toFixed(0)}°  ws ${avg(r=>r.ws).toFixed(2)}`);
  }
}
