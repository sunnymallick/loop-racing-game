import { bodySection } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/assemble.js';
import { loftTub } from '/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/kit.js';
for (const car of ['muscle','tuner','supercar','suv']) {
  const bp = (await import(`/Users/sunnymallick/sunny_personal_projects/gauntlet-test/src/vehicles/${car}.js`)).blueprint;
  const secs = bp.body.map((s)=>bodySection(s.z,s));
  const mk = (wells) => loftTub(secs, { openings: [], noseCap: bp.nose||{}, tailCap: bp.tail||{}, deckWells: wells });
  const a = mk([]), b = mk(bp.deck?.wells||[]);
  const tri = (g)=> (g.shell? g.shell.index.count/3:0) + (g.bay? g.bay.index.count/3:0);
  console.log(car, 'tub tris without wells', tri(a), '-> with', tri(b), `(+${(100*(tri(b)/tri(a)-1)).toFixed(1)}%)`);
}
