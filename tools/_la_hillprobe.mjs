import { RNG, clamp, smoothstep, makeNoise2D, fbm2D } from '../src/core/rng.js';
const seed = 3, height = 268;
const n1 = makeNoise2D(seed), n2 = makeNoise2D(seed + 17);
const rng = new RNG(seed * 13 + 5);
const massif = [], swell = [];
for (let i = 0; i < 5; i++) massif.push({ c: rng.range(0.06, 0.94), w: rng.range(0.13, 0.28), a: rng.range(0.55, 1.0) });
for (let i = 0; i < 9; i++) swell.push({ c: rng.range(0.05, 0.95), w: rng.range(0.045, 0.10), a: rng.range(0.08, 0.24) });
const crestOf = (u) => 0.55 + fbm2D(n2, u * 2.6, 7.3, 3) * 0.30;
const massOf = (u) => {
  let m = 0.09; for (const p of massif) { const d = (u - p.c) / p.w; m += p.a * Math.exp(-d * d); }
  let s = 0; for (const p of swell) { const d = (u - p.c) / p.w; s += p.a * Math.exp(-d * d); }
  return clamp(Math.min(m, 1.02) + s, 0, 1.3);
};
const NS = 1 / 0.30;
const shape = (u, v) => {
  const ends = smoothstep(0, 0.15, u) * smoothstep(0, 0.15, 1 - u);
  const cv = crestOf(u);
  const front = smoothstep(-0.03, cv, v);
  const back = 1 - smoothstep(cv, cv + 0.62, v) * 0.40;
  const mass = massOf(u) * ends * Math.pow(front, 1.30) * back;
  const rn = Math.min(1, Math.abs(fbm2D(n1, u * 16, v * 3.2, 4) * NS));
  const rn2 = Math.min(1, Math.abs(fbm2D(n1, u * 44 + 11, v * 9 + 3, 3) * NS));
  const fine = fbm2D(n2, u * 160, v * 46, 3) * NS;
  const crown = 1 - smoothstep(0.60, 1.0, mass) * 0.66;
  const relief = (-0.21 + rn * 0.36 + rn2 * 0.10 + fine * 0.035) * crown;
  return { h: clamp(mass * (1 + relief), 0, 2), mass, rn, rn2 };
};
const stat = (name, arr) => { arr.sort((a,b)=>a-b); const m = arr.reduce((a,b)=>a+b,0)/arr.length;
  console.log(name.padEnd(9), `p05 ${arr[(arr.length*0.05)|0].toFixed(3)} p50 ${arr[(arr.length*0.5)|0].toFixed(3)} p95 ${arr[(arr.length*0.95)|0].toFixed(3)} mean ${m.toFixed(3)}`); };
const H=[],M=[],RN=[],HO=[],NO=[],DE=[],PA=[],SH=[];
let brushN = 0, tot = 0;
for (let j = 0; j <= 130; j++) for (let i = 0; i <= 300; i++) {
  const u = i/300, v = 1 - j/130;
  const s = shape(u, v);
  if (s.h < 0.05) continue;
  tot++;
  const hollow = smoothstep(0.42, 0.06, s.rn), nose = smoothstep(0.38, 0.88, s.rn);
  const patch = clamp(0.5 + fbm2D(n2, u*9+40, v*4+5, 4) * NS * 0.55, 0, 1);
  const density = clamp(hollow*0.58 + patch*0.62 - nose*0.26, 0, 1);
  const shade = 0.84 + (patch-0.5)*0.30 + (0.45 - s.rn2)*0.34;
  H.push(s.h); M.push(s.mass); RN.push(s.rn); HO.push(hollow); NO.push(nose); DE.push(density); PA.push(patch); SH.push(shade);
  if (density > 0.48) brushN++;
}
stat('h',H); stat('mass',M); stat('rn',RN); stat('hollow',HO); stat('nose',NO); stat('patch',PA); stat('density',DE); stat('shade',SH);
console.log('on-hill verts', tot, 'brush sites', brushN);
