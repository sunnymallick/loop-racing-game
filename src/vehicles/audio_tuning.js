/**
 * PER-CLASS VOICING — owned by the audio piece (ART_DIRECTION.md §6.9).
 *
 * Kept out of the car files so the audio builder and the vehicle-art builder never touch the
 * same file. `character` selects a firing-pattern/pulse-shape profile in src/core/audio.js — see
 * the header note there for why the four engines sound like four different engines rather than
 * four pitches of the same one.
 *
 * A class is NOT just its engine. An SUV crash is a heavy dull boom with suspension in it; a
 * supercar crash is a light, bright carbon-and-glass crack. A tall soft truck tyre roars where a
 * wide sticky supercar tyre howls. Those live here too, in `tyre` / `impact` / `nitrous`, so the
 * four cars stay four cars all the way through the mix.
 *
 *   cylinders   documentation of the layout; the firing ANGLES live in the character profile
 *   idleRpm     where it settles — a diesel idles low and a screamer idles high
 *   redline     where the limiter chops the spark (also drives the HUD tacho scale)
 *   character   key into CHARACTER in core/audio.js
 *   roughness   0..1 idle irregularity — how much the note wanders when it is not being asked
 *               to do anything
 *   trim        per-car level trim on the engine bus, so no one car is buried or shouting
 *
 *   tyre.formant   multiplies the surface squeal formants — wide sticky rubber howls high
 *   tyre.howl      how tonal the squeal is (a race tyre sings, a truck tyre just scrubs)
 *   tyre.roar      broadband scrub weight — tall soft sidewalls move a lot of air
 *   tyre.stick     stick-slip rate multiplier: the "waaah" is slower on a heavy car
 *
 *   impact.mass    body thump level and how low it falls — a 2.6 t truck vs a 1.2 t coupe
 *   impact.thumpHz starting pitch of that thump
 *   impact.modeHz  panel resonance band: steel is low and rings, carbon is high and dead
 *   impact.decay   how long the panel modes ring
 *   impact.glass   glass/debris content on a heavy hit
 *   impact.rattle  loose-junk clatter after the hit — trucks have it, supercars do not
 *   impact.bright  spectral centre of the contact noise
 *
 *   nitrous.color  ignition crack brightness · nitrous.bore jet size / rumble weight
 *
 * The four voices, in one line each:
 *   tuner     — 4-cyl turbo. Small, buzzy, 2nd-order dominant; the induction whistle and the
 *               spool are the drama, and it revs to 8600. Light plastic-bumpered crashes.
 *   muscle    — cross-plane V8. Uneven per-bank firing → the lope. Fat, dark, raspy under load,
 *               and it crashes like a steel body-on-frame coupe: a big low boom that rings.
 *   suv       — big-bore diesel V8. Long fat pulses plus hard combustion knock gated at the
 *               firing rate; revs to 4400 and no further, because diesels don't. Heaviest,
 *               dullest, rattliest impacts of the four.
 *   supercar  — flat-plane V8. Dead-even 180° banks → no half orders at all, so it screams
 *               instead of burbling, all the way to 9000. Light, bright, glassy crashes.
 */
export const AUDIO = {
  tuner: {
    cylinders: 4, idleRpm: 950, redline: 8600, character: 'i4-turbo', roughness: 0.30, trim: 0.88,
    tyre: { formant: 1.10, howl: 0.85, roar: 0.85, stick: 1.15 },
    impact: { mass: 0.62, thumpHz: 1.32, modeHz: 1.34, decay: 0.72, glass: 0.75, rattle: 0.55, bright: 1.25 },
    nitrous: { color: 1.18, bore: 0.78 },
  },
  muscle: {
    cylinders: 8, idleRpm: 660, redline: 6200, character: 'v8-lopey', roughness: 0.62, trim: 1.16,
    tyre: { formant: 0.92, howl: 1.05, roar: 1.15, stick: 0.88 },
    impact: { mass: 1.18, thumpHz: 0.90, modeHz: 0.80, decay: 1.30, glass: 1.0, rattle: 0.85, bright: 0.92 },
    nitrous: { color: 0.92, bore: 1.15 },
  },
  suv: {
    cylinders: 8, idleRpm: 580, redline: 4400, character: 'v8-diesel', roughness: 0.78, trim: 1.06,
    tyre: { formant: 0.70, howl: 0.45, roar: 1.45, stick: 0.70 },
    impact: { mass: 1.50, thumpHz: 0.70, modeHz: 0.62, decay: 1.55, glass: 0.55, rattle: 1.45, bright: 0.68 },
    nitrous: { color: 0.72, bore: 1.45 },
  },
  supercar: {
    cylinders: 8, idleRpm: 1050, redline: 9000, character: 'v8-flatplane', roughness: 0.20, trim: 1.32,
    tyre: { formant: 1.34, howl: 1.35, roar: 0.72, stick: 1.30 },
    impact: { mass: 0.78, thumpHz: 1.15, modeHz: 1.62, decay: 0.58, glass: 1.50, rattle: 0.22, bright: 1.48 },
    nitrous: { color: 1.35, bore: 0.90 },
  },
};

/** Defaults, so a car without a full profile still gets a sane voice rather than a crash. */
export const AUDIO_DEFAULTS = {
  tyre: { formant: 1, howl: 1, roar: 1, stick: 1 },
  impact: { mass: 1, thumpHz: 1, modeHz: 1, decay: 1, glass: 1, rattle: 0.6, bright: 1 },
  nitrous: { color: 1, bore: 1 },
};

export function getAudioProfile(id) {
  const a = AUDIO[id];
  if (!a) throw new Error(`No audio profile for vehicle "${id}"`);
  return a;
}
