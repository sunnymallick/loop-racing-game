/**
 * PER-CLASS ENGINE VOICING — owned by the audio piece (ART_DIRECTION.md §6.9).
 *
 * Kept out of the car files so the audio builder and the vehicle-art builder never touch the
 * same file. `character` selects a harmonic/noise profile in src/core/audio.js.
 *
 *   cylinders   sets the firing frequency: rpm/60 * cylinders/2
 *   idleRpm / redline
 *   character   key into CHARACTER in core/audio.js
 *   roughness   0..1 idle irregularity
 */
export const AUDIO = {
  tuner: { cylinders: 4, idleRpm: 900, redline: 8600, character: 'i4-turbo', roughness: 0.28 },
  muscle: { cylinders: 8, idleRpm: 620, redline: 6200, character: 'v8-lopey', roughness: 0.55 },
  suv: { cylinders: 8, idleRpm: 520, redline: 5200, character: 'v8-diesel', roughness: 0.72 },
  supercar: { cylinders: 8, idleRpm: 1000, redline: 9000, character: 'v8-flatplane', roughness: 0.22 },
};

export function getAudioProfile(id) {
  const a = AUDIO[id];
  if (!a) throw new Error(`No audio profile for vehicle "${id}"`);
  return a;
}
