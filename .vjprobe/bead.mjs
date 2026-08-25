import * as THREE from 'three';
import { panelReturn, chromeMaterial } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/kit.js';
const bp = (await import('/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/muscle.js')).blueprint;
const w = bp.deck.wells[0];
const m = panelReturn(w.w, w.d, { r: w.r, bead: w.beadR, rise: 0, mat: chromeMaterial({}) });
const p = m.geometry.attributes.position;
let x0=9,x1=-9,y0=9,y1=-9,z0=9,z1=-9;
for (let i=0;i<p.count;i++){ x0=Math.min(x0,p.getX(i)); x1=Math.max(x1,p.getX(i)); y0=Math.min(y0,p.getY(i)); y1=Math.max(y1,p.getY(i)); z0=Math.min(z0,p.getZ(i)); z1=Math.max(z1,p.getZ(i)); }
console.log('bead verts', p.count, 'tris', m.geometry.index.count/3);
console.log('x', x0.toFixed(3), x1.toFixed(3), '| y', y0.toFixed(3), y1.toFixed(3), '| z', z0.toFixed(3), z1.toFixed(3));
console.log('world y span', (w.beadY+y0).toFixed(4), (w.beadY+y1).toFixed(4), ' rim at |x|', (w.w/2).toFixed(3));
