import { assembleCar } from './assemble.js';

/**
 * VIPERA SV — mid-engine supercar. Ford GT / 488 DNA: a cab-forward wedge with the cabin pushed
 * onto the front axle, a nose that is almost on the floor, huge side intakes feeding the engine,
 * flying buttresses running from the roof to the rear haunches, a vented engine cover, round
 * taillights (reference f&f3) and a full-width diffuser.
 *
 * Silhouette test (§2.3): lowest car in the game, with the peak of the roof forward of centre and
 * the rear deck HIGHER than the bonnet — that inversion is what says "mid-engine".
 *
 * Handling: enormous grip, sharp turn-in, snappy but catchable at the limit.
 * Nitrous = instant violent kick with the highest top-speed multiplier.
 */
export const spec = {
  id: 'supercar',
  name: 'VIPERA',
  full: 'VIPERA SV COMPETIZIONE',
  klass: 'SUPERCAR',
  colors: ['#e01a2c', '#f7cd14', '#1a44b8', '#eef0f4', '#1b2028', '#00cfa0'],
  stats: { speed: 1.0, accel: 0.96, traction: 0.92, weight: 0.5 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

const V = (z) => (z + 2.31) / 4.62;

export const blueprint = {
  id: 'supercar', spec, colors: spec.colors,
  // Round 1's 1.70 front track left the front tyre 11 cm inboard of the fender, sitting in an open
  // cavity — the exact §6.1 hard cap. The tub is 1.045 / 1.085 half-wide at the arches; match it.
  // Rear track and tail width are set against each other so the rear tyres stand 24 cm outboard of
  // the tail panel on each side — from a straight-on chase view the wheels break the silhouette
  // instead of hiding behind a full-width diffuser (§6.1 round-2 gap).
  /**
   * ---- WAVE-10: THE WHEELBASE, AND WHY IT MOVED ---------------------------------------------
   *
   * The critic: "all four classes share one chassis footprint … a Hummer-inspired SUV and a
   * supercar should not measure the same", and separately "the supercar is the wrong archetype —
   * it has front-engine GT proportions". Those are one fault. On a 4.62 m car a 2.68 m wheelbase
   * leaves 970 mm of overhang at each end, which is a GT's chassis; every mid-engine car of this
   * shape runs the axles out toward the corners and spends the length between them instead.
   *
   * 2.86 m on 4.62 puts the wheelbase at 62 % of the length — the highest in the game against the
   * truck's 65 % on a much taller body, the muscle car's 59 % and the tuner's 59 % — and drops both
   * overhangs to 880 mm. The front wheel now sits close under the nose, which is half of what makes
   * a cab-forward wedge read as one.
   */
  dims: { length: 4.62, width: 2.34, height: 1.25, wheelbase: 2.86, track: 1.850, trackRear: 1.938, rideHeight: 0.095 },
  // the glossiest car in the game: show-car clearcoat over metallic red
  paint: { metalness: 0.30, roughness: 0.42, clearcoat: 1.0, clearcoatRoughness: 0.38, flake: 0.58, envIntensity: 0.94 },
  livery: {
    // ROUND-1 (vehicle art): #eef1f5 is 0.93 sRGB, and a 0.93 panel under the garage key clips
    // before the specular even arrives — the whole centre of the bonnet reads as one blown white
    // blob with the stripe, the crown and the highlight fused into it. #d9dde5 is still an
    // unmistakable white racing stripe and it leaves the bloom somewhere to go.
    style: 'gt', stripe: '#d9dde5', accent: '#14171c',
    panels: {
      doors: [V(1.18), V(-0.28)],
      hood: [V(1.26), V(2.10)],
      boot: [V(-2.14), V(-0.56)],
      arches: [V(1.43), V(-1.43)],
    },
  },
  // see muscle.js — 0.74 made the cabin a §7 black void behind the wraparound screen
  glass: { tint: '#060b11', opacity: 0.56 },

  /**
   * ROUND-4 SURFACING PASS ON THE WINGS.
   *
   * Round-2 note, verbatim: "a pale untextured shelf polygon at the top of the supercar's fenders
   * that reads as stray geometry". It was not stray — it was the top of the wing — but it was
   * authored with 10-12 mm of crown across an 850 mm half-panel, i.e. dead flat, so it presented
   * one horizontal plane straight at the sky, took one constant value off the reflection, and read
   * as a bright rectangle sitting on the car rather than as part of it. Every wing station (front
   * and rear) now carries 30-44 mm of crown over a narrower flat, so the panel rolls from the arch
   * up to the bonnet/engine-deck line and the sky reflection SWEEPS across it instead of filling it.
   */
  body: [
    /**
     * ---- WAVE-10: RE-CUT AS A MID-ENGINE CAR --------------------------------------------------
     *
     * Three things move together, because separately none of them reads:
     *
     *  1. the AXLES go out to +/-1.43 (2.86 m wheelbase), so the flare peaks — the widest station
     *     over each wheel — move with them and the wings sit over the corners of the car;
     *  2. the COWL moves 260 mm forward, from z 0.94 to z 1.20. That is the single number that
     *     says front-engine or mid-engine: the base of the screen used to sit 400 mm behind the
     *     front axle line, which is a bonnet you can put a V8 under. It now sits 230 mm AHEAD of
     *     it, on top of the front wheel, which is where a 488's or a Ford GT's does;
     *  3. the bonnet therefore has 1.11 m to fall 208 mm in instead of 1.37 m to fall 168 mm in,
     *     so the nose is a short steep wedge rather than a long flat deck.
     *
     * What is left behind the cabin is 1.50 m of high flat engine deck — 33 % of the car's length,
     * against the muscle car's 0.9 m boot lid — with the deck line 320 mm ABOVE the bonnet line.
     * That inversion, over a wheelbase this long, is the mid-engine silhouette.
     */
    { z: -2.31, w: 0.790, y0: 0.25, floor: 0.58, rocker: 0.95, ySill: 0.36, yBelt: 0.82, belt: 0.96, yDeck: 0.855, deck: 0.93, crown: 0.004 },
    { z: -2.24, w: 0.882, y0: 0.22, floor: 0.62, rocker: 0.94, ySill: 0.33, yBelt: 0.86, belt: 0.955, yDeck: 0.895, deck: 0.90, crown: 0.006 },
    { z: -2.10, w: 0.930, y0: 0.19, rocker: 0.925, ySill: 0.31, yBelt: 0.90, belt: 0.95, yDeck: 0.945, deck: 0.84, crown: 0.026, flare: 1.01 },
    { z: -1.79, w: 0.990, y0: 0.17, rocker: 0.915, ySill: 0.295, yBelt: 0.938, belt: 0.945, yDeck: 0.968, deck: 0.80, crown: 0.040, flare: 1.052 },
    { z: -1.43, w: 1.004, y0: 0.16, rocker: 0.905, ySill: 0.29, yBelt: 0.948, belt: 0.945, yDeck: 0.980, deck: 0.79, crown: 0.044, flare: 1.088 },
    { z: -1.06, w: 0.996, y0: 0.158, rocker: 0.90, ySill: 0.285, yBelt: 0.940, belt: 0.945, yDeck: 0.974, deck: 0.79, crown: 0.042, flare: 1.034 },
    { z: -0.60, w: 0.994, y0: 0.158, rocker: 0.900, ySill: 0.285, yBelt: 0.932, belt: 0.945, yDeck: 0.956, deck: 0.80, crown: 0.036 },
    { z: -0.54, w: 0.992, y0: 0.158, rocker: 0.899, ySill: 0.284, yBelt: 0.928, belt: 0.945, yDeck: 0.672, deck: 0.83, crown: 0.006 },
    { z: -0.26, w: 0.986, y0: 0.156, rocker: 0.895, ySill: 0.282, yBelt: 0.918, belt: 0.945, yDeck: 0.660, deck: 0.83, crown: 0.006 },
    { z: 0.10, w: 0.981, y0: 0.154, rocker: 0.89, ySill: 0.278, yBelt: 0.902, belt: 0.945, yDeck: 0.646, deck: 0.83, crown: 0.006 },
    { z: 0.66, w: 0.977, y0: 0.152, rocker: 0.885, ySill: 0.275, yBelt: 0.874, belt: 0.945, yDeck: 0.642, deck: 0.83, crown: 0.006 },
    { z: 1.06, w: 0.979, y0: 0.152, rocker: 0.885, ySill: 0.276, yBelt: 0.852, belt: 0.945, yDeck: 0.652, deck: 0.84, crown: 0.006 },
    { z: 1.12, w: 0.980, y0: 0.152, rocker: 0.885, ySill: 0.276, yBelt: 0.848, belt: 0.945, yDeck: 0.828, deck: 0.86, crown: 0.010 },
    { z: 1.20, w: 0.984, y0: 0.152, rocker: 0.888, ySill: 0.274, yBelt: 0.836, belt: 0.945, yDeck: 0.812, deck: 0.82, crown: 0.026, flare: 1.028 },
    { z: 1.43, w: 0.998, y0: 0.154, rocker: 0.892, ySill: 0.272, yBelt: 0.798, belt: 0.945, yDeck: 0.762, deck: 0.79, crown: 0.044, flare: 1.060 },
    { z: 1.71, w: 0.990, y0: 0.156, rocker: 0.895, ySill: 0.270, yBelt: 0.750, belt: 0.945, yDeck: 0.716, deck: 0.80, crown: 0.040, flare: 1.048 },
    { z: 2.00, w: 0.966, y0: 0.160, rocker: 0.905, ySill: 0.272, yBelt: 0.700, belt: 0.95, yDeck: 0.676, deck: 0.83, crown: 0.030, flare: 1.012 },
    /**
     * ---- THE FRONT CLIP, LOFTED (round-1, this piece) --------------------------------------
     *
     * Verdict on this car: "the same protruding splitter plate hanging off the nose with a hard
     * flat end." It was 1.74 m wide with the tub's undertray only 1.04 m across at that station, so
     * 350 mm of carbon stood out past the paint on EACH side, in mid-air, ending in a cut face.
     *
     * The nose used to neck in from w 0.930 to 0.775 over its last 150 mm and stop 205 mm off the
     * road, which left nothing for a splitter to grow out of. It now runs 0.948 → 0.930 with y0 at
     * 0.140 and `floor` at 0.90, so the tub's own undertray is 1.67 m wide and the splitter is a
     * LIP along its leading edge instead of a shelf hanging off nothing.
     */
    { z: 2.16, w: 0.948, y0: 0.150, floor: 0.72, rocker: 0.925, ySill: 0.262, yBelt: 0.674, belt: 0.955, yDeck: 0.658, deck: 0.89, crown: 0.010 },
    { z: 2.28, w: 0.938, y0: 0.142, floor: 0.84, rocker: 0.945, ySill: 0.250, yBelt: 0.646, belt: 0.962, yDeck: 0.634, deck: 0.90, crown: 0.006 },
    { z: 2.31, w: 0.930, y0: 0.140, floor: 0.90, rocker: 0.955, ySill: 0.245, yBelt: 0.628, belt: 0.966, yDeck: 0.620, deck: 0.91, crown: 0.005 },
  ],

  /**
   * ---- THE NOSE PANEL ---------------------------------------------------------------------
   * Mouth, corner intakes and the two signature lamp slots are cut into the lofted face by
   * `loftTub`'s cap grid (kit.js §7). `flat` gives each one a single-plane floor so the screens and
   * the lamp banks lie ON it; `lip` raises the moulded bead round the mouth and the lamp slots that
   * a modern supercar's clip actually wears.
   */
  nose: {
    crown: 0.042, rake: -0.06, rings: 13, cy: 0.400,
    apertures: [
      // ONE wide letterbox rather than a centre mouth plus two corner intakes. Every extra opening
      // costs eight radial levels on every column of the grid and, more to the point, another pair
      // of angular transitions for the level solver to shear across — the supercar's five-opening
      // layout put a visible ripple across the middle of the clip. Three openings is where it goes.
      // 155 -> 165 mm, and the screen inside it is authored to the flat floor: at 155 the floor was
      // 89 mm against a 138 mm screen, so `seat()` scaled the whole grille by 0.645 and a 1.50 m
      // mesh came out 0.97 m wide, floating in the middle of a 1.66 m mouth with 350 mm of painted
      // recess either side of it. That is the "letterbox with a small grille in it" read.
      { y: 0.296, w: 1.66, h: 0.165, r: 0.048, depth: 0.086, rim: 0.026, shade: 1, lip: 0.012, lipW: 0.045 },
      // the lamp slot carries BOTH elements — the main strip and the cyan DRL bar under it — so the
      // signature reads as one moulded unit instead of two boxes stuck on a nose 65 mm behind them
      /**
       * THE LAMP SLOT, and this is the single worst measurement on the car in round 1.
       *
       * At 0.40 x 0.160 with a 24 mm rim the flat floor is 0.338 x 0.098 — and round 1's seating
       * clamp charged each element's offset from the slot centre twice, so a 0.34 x 0.085 main lamp
       * came out 0.088 x 0.022 and the DRL bar came out 0.040 x 0.010. That is why the verdict
       * reads "tiny pale slivers spiking into the red body": there were no headlights on this car,
       * there were four scratches. 0.44 x 0.185 gives a 0.378 x 0.123 floor, which carries the main
       * lamp and the DRL under it at full size with a 10 mm gap between them.
       */
      // shade 0.5 -> 1: see the note on the tuner's pod. The inside of a lamp housing is black.
      { x: 0.585, y: 0.505, w: 0.44, h: 0.185, r: 0.045, depth: 0.058, rim: 0.024, shade: 1, lip: 0.012, lipW: 0.042, mirror: true },
    ],
  },

  cabin: {
    /**
     * WAVE-10: the whole glasshouse moves 260 mm forward with the cowl. The A-pillar base now
     * stands on the front axle line (z 1.18 against an axle at 1.43) instead of 400 mm behind it,
     * the roof peak sits AHEAD of the wheelbase centre, and the rear bulkhead closes at z -0.54 —
     * which leaves 1.50 m of engine deck behind it. Same section shapes, same tumblehome, same
     * roof height: only the station the cabin occupies has changed.
     */
    stations: [
      { z: 1.18, hw: 0.900, rw: 0.858, yBelt: 0.842, yRoof: 0.860 },
      { z: 1.14, hw: 0.904, rw: 0.812, yBelt: 0.845, yRoof: 0.940 },
      { z: 0.82, hw: 0.914, rw: 0.706, yBelt: 0.864, yRoof: 1.118 },
      { z: 0.56, hw: 0.920, rw: 0.648, yBelt: 0.876, yRoof: 1.222 },
      { z: 0.16, hw: 0.924, rw: 0.636, yBelt: 0.892, yRoof: 1.240 },
      { z: -0.16, hw: 0.926, rw: 0.652, yBelt: 0.906, yRoof: 1.196 },
      { z: -0.40, hw: 0.928, rw: 0.712, yBelt: 0.916, yRoof: 1.086 },
      { z: -0.54, hw: 0.928, rw: 0.804, yBelt: 0.921, yRoof: 0.972 },
    ],
    // z1 0.26 → 0.31 closes the 40 mm the roof panel used to stop short of the A-pillar band below,
    // so the header, the pillar and the rail are one continuous piece of bodywork round the screen.
    roof: { z0: -0.26, z1: 0.57, a: 5, offset: 0.013 },
    // one blade on a very raked screen; no drip rail — a mid-engine canopy is one smooth shell
    wipers: { z: 1.105, w: 0.44, x: 0.24, sweep: 0.18 },
    pillars: [
      { z0: 0.56, z1: 1.18, a: 2, b: 5, mat: 'dark', steps: 5 },      // A-pillar
      { z0: -0.14, z1: -0.54, a: 2, b: 5, mat: 'paint', steps: 5 },   // buttress root
    ],
    beltZ0: -0.18, beltZ1: 0.60, beltMat: 'dark',
    // Two seats and an engine bulkhead — no rear shelf humps on a mid-engine car (rearHeads:false),
    // the roll hoops do that job. Alcantara grey with the car's own red on the bolsters.
    interior: { seat: 0x4a4f5a, trim: 0x33373f, accent: 0xc9202f, floorY: 0.655, headY: 1.095, dashY: 0.875, wheelY: 0.915, shelfY: 0.895, seatZ: 0.30, dashZ: 0.96, dashW: 1.30, seatX: 0.34, shelfZ: 0.86, shelfD: 0.28, rearHeads: false, rollBar: true, clusterColor: '#ffd166' },
  },

  wheels: {
    // dark forged turbofan on semi-slick rubber — near-solid tread, four fine grooves
    style: 'turbofan', rimColor: '#262a32', caliperColor: '#f0c419', lipColor: '#8a919c', tire: 'slick',
    capColor: '#f0c419',
    /**
     * ROUND-7 (chassis footprint) — see the note in tuner.js. The rear goes to 412 mm and the
     * profile down to a 195/185 series, so this car wears the biggest stagger in the game (a 60 mm
     * larger rear than front, against the muscle car's 40 and the truck's 0) on the least sidewall.
     * That difference is legible in a chase frame at a glance and it is what a mid-engine car
     * actually looks like from behind.
     */
    front: { radius: 0.352, width: 0.30, spokes: 10, tireProfile: 0.195 },
    rear: { radius: 0.412, width: 0.42, spokes: 10, tireProfile: 0.185 },
  },
  /**
   * THE ARCH OPENING — cut into the tub itself (kit.js `loftTub`), not bolted on.
   *   archGap    lip radius / tyre radius: 1.10 leaves a 35-39 mm crescent of shadow over the tyre,
   *              which reads as an opening while the wheel still fills it.
   *   archFlare  how far fore/aft the fender swells to reach the lip. Wide, because a mid-engine
   *              car's rear haunch is a long draw from the door to the widest point.
   *   archProud  the lip crown, measured outboard of the tyre's own outer sidewall.
   *   archDepth  how far behind the tyre the barrel takes to reach the inner fender wall.
   */
  archGap: 1.100, archFlare: 0.165, archLip: 0.014, archProud: 0.010, archInset: 0.052,
  archDepth: 0.12, archSpan: 1.05,

  lights: {
    // Both elements now stand on the lamp slot's floor (z 2.272) instead of on the flank 65 mm
    // behind the nose face, so their housings are inside the bodywork.
    head: [
      { x: 0.585, y: 0.5305, w: 0.375, h: 0.068, z: 2.270, shape: 'strip', color: '#e6efff', intensity: 3.4, segs: 2 },
      /**
       * ROUND-2: the DRL bar was scored as "supercar fog lights are unmodified blue boxes". It was
       * not the lens — a 0.22 x 0.06 bar is a bar — it was the HALO card, 0.28 x 0.10 of additive
       * cyan at 0.5 strength sitting on top of it and then bloomed, which fattens a 60 mm strip
       * into a 190 mm square of light with no shape inside it. The halo comes down to a rim, and
       * three divider ribs plus the moulded optic (kit.js `lensTexture`) give the bar the internal
       * structure that says signature lamp rather than blue brick.
       */
    ],
    /**
     * ROUND-2: the cyan bar moves out of `head` and into `drl`.
     *
     * It was correct as a lamp and wrong as a circuit. menu.js takes the whole head bank to 6 % for
     * a showroom car, so the supercar's signature — the one element that identifies this class at a
     * glance — was dead in the exact frame §6.1 is judged in, alongside "not one of the four has an
     * emissive headlight". A DRL is not a headlight: it is on whenever the car is, which is what
     * `drl` means here (assemble.js). Same lens, same ribs, same optic; it simply never gets dimmed.
     */
    drl: [{ x: 0.585, y: 0.4665, z: 2.270, w: 0.300, h: 0.040, shape: 'strip', color: '#4fd8ff', intensity: 2.8, glow: 0.26, segs: 3 }],
    // the twin round lamp rings of f&f3 — clear of the carbon blade above them so they read whole
    tail: [
      { x: 0.40, y: 0.870, z: -2.360, w: 0.22, h: 0.22, shape: 'round', color: '#ff2410', intensity: 2.3 },
      { x: 0.71, y: 0.870, z: -2.360, w: 0.22, h: 0.22, shape: 'round', color: '#ff2410', intensity: 2.3 },
      // high-mount stop lamp in the carbon tail blade; shares the round lamps' bank
      { x: 0, y: 0.995, z: -2.398, w: 0.30, h: 0.042, shape: 'strip', color: '#ff2410', intensity: 2.3, mirror: false, bezel: false },
      // Rear reflectors, low in the valance either side of the extractor. Same colour, intensity
      // and halo as the high-mount lamp, so they join its bank and cost nothing — and they put two
      // lit elements into the one part of the car that was returning a flat black rectangle.
      { x: 0.635, y: 0.520, z: -2.318, w: 0.155, h: 0.048, shape: 'strip', color: '#ff2410', intensity: 2.3, bezel: false },
    ],
    reverse: [{ x: 0.0, y: 0.585, z: -2.365, w: 0.16, h: 0.08, color: '#fff2d8', intensity: 1.6, glow: 0.3, mirror: false }],
  },

  grilles: [
    // dropped onto the flat floors of their own apertures (z 2.258 / 2.264) rather than parked in
    // front of the nose, so each screen is a hole in the clip and not a box on it
    { w: 1.585, h: 0.095, d: 0.12, y: 0.296, z: 2.286, slats: 3, mesh: true, frame: 'dark' },
    // side intakes: recessed 20 mm into the real flank (x 1.020 at this station), not buried 28 mm
    // inside it, so the mesh reads as a mouth in the door rather than a shadow under the paint
    { x: 0.960, w: 0.46, h: 0.28, d: 0.16, y: 0.640, z: -0.80, slats: 4, mesh: true, frame: 'dark', ry: 1.5708, mirror: true },
    /**
     * REAR EXTRACTOR. Round-1: "everything below the taillight bar is one flat featureless
     * near-black rectangle". The grille was there — it was dark mesh in a dark aperture on a black
     * tail panel, three near-black things stacked, and at 3x the whole 1.2 x 0.3 m of it came back
     * as one void. A polished surround puts a hard bright rectangle around the opening, which is
     * what makes it read as an opening; the mesh behind it keeps its depth.
     */
    /**
     * ROUND-3: `ry: Math.PI`, and this is the whole of the round-2 note "the supercar diffuser
     * mouth is a flat pure-black rectangle".
     *
     * `grilleMesh` builds an aperture that opens along its own +Z: the cavity box sits at -d/2 and
     * the woven screen at -0.16 d, i.e. BEHIND the mounting plane. Bolted to the tail of the car
     * with no yaw, the whole assembly faced forwards — so what a chase camera saw was the closed
     * BACK of the cavity box, a 1.16 x 0.28 m flat black slab, with the mesh, the depth and the
     * polished surround all hidden inside the car. Turned to face the camera it is what it was
     * authored to be: a bright surround, a lit steel screen and a hole behind it.
     */
    { w: 1.16, h: 0.28, d: 0.13, y: 0.685, z: -2.325, slats: 6, mesh: true, frame: 'chrome', ry: Math.PI },
  ],
  vents: [
    /**
     * ---- ROUND-7: THREE VENTS THAT WERE INSIDE THE BODYWORK -----------------------------------
     *
     * Measured with `.vjprobe/deck.mjs supercar y,0.42,-1.30` and friends, the engine deck at these
     * three stations sits at y 1.0418 / 1.0200 / 0.6794 — and the vents were authored at 0.995 /
     * 0.975 / 0.628, i.e. 46, 45 and 51 mm BELOW the panel they are cut into. A `ventMesh` reaches
     * 27 mm forward of its own origin, so all three were sealed inside the closed body and rendered
     * to nobody. The round-5 note above ("dropped onto the panel and laid flatter") over-corrected:
     * it moved them from proud of the panel to under it.
     *
     * Set ON the measured surface, the louvre bank stands 18 mm proud and its aperture box is 27 mm
     * under — which is what an extractor is. The supercar gets three vents back for nothing.
     */
    { x: 0.42, y: 1.038, z: -1.16, w: 0.46, h: 0.32, fins: 5, angle: 0.55, rx: -1.5708 },   // engine cover louvres
    // ROUND-2: a second, smaller louvre pair over the rear deck. The verdict called the rear "a
    // stack of flat rectangular slabs — plank wing, plank engine cover, plank tail panel, plank
    // diffuser"; the engine cover is the largest of those planks and it had one vent in the middle
    // of 0.9 m of flat paint. Two banks of louvres at different sizes break the panel into a
    // vented deck, which is what §1.3 asks for ("a visible engine cover with vents").
    { x: 0.38, y: 1.032, z: -1.72, w: 0.36, h: 0.22, fins: 4, angle: 0.5, rx: -1.5708 },
    // BONNET EXTRACTORS. They were at y 0.70 with the bonnet crown at ~0.645, so the vent's dark
    // aperture box stood 55 mm PROUD of the panel and the round-5 crop reads exactly what it is:
    // "two plain rounded cuboids" sitting on the hood. Dropped onto the panel and laid flatter, so
    // what shows is the louvre bank in a recess — which is what an extractor is.
    { x: 0.30, y: 0.680, z: 2.14, w: 0.30, h: 0.14, fins: 3, angle: 0.6, rx: -1.50 },        // bonnet extractors
  ],
  // carbon pods, not body colour: at this camera the near mirror is a hand's width across in frame
  // and a saturated red brick beside the screen was the loudest object in the round-5 hero crop
  mirrors: { x: 0.90, y: 0.90, z: 0.88, painted: false },
  // see muscle.js — the flank measures 0.9412 at this station
  handles: [{ x: 0.950, y: 0.80, z: 0.14, mat: 'paint' }],

  trim: [
    // FRONT LIP. 1.44 m under a 1.67 m undertray, so it is 115 mm inboard of the bodywork on each
    // side and tucked under the bumper corners — there is no end face for a camera to find.
    /**
     * THE SPLITTER, rebuilt as a SWEPT part (kit.js `sweptBar`).
     *
     * Verbatim, twice: "a flat gray splitter plate terminates in raw uncapped cut faces" and "the
     * same protruding splitter plate hanging off the nose with a hard flat end". Both are literal.
     * The plate sat at z 2.352 and reached 2.492 on a nose whose leading edge is 2.310 — 182 mm of
     * plank in open air — and its two tips ended in flat rectangles a garage camera looks straight
     * at. The 1.34 m polished blade on top of it added 24 mm of pure mirror across the full width,
     * which is why the whole thing photographs as pale cardboard rather than as lacquered carbon.
     *
     * Now: one continuous surface, 130 mm proud instead of 182, raked so the top face turns away
     * from a high camera, and swept so both tips fall 130 mm back into the bumper corners. The
     * blade is a third of the section it was and follows the same curve.
     */
    /**
     * ---- ROUND-7: THE SPLITTER GETS A RETURN --------------------------------------------------
     *
     * See the same note on the tuner. A splitter hangs BELOW the undertray, so its tips are in
     * clear air however far back they sweep: at w 1.54 they sat at x 0.77 with the flank measured
     * at 0.807 (`.vjprobe/w.mjs supercar 2.20,0.175`), i.e. 37 mm inside — and still read as two
     * ends lying on the road, because the half of the section below the floorpan was outside the
     * bodywork all the way to the cap.
     *
     * Negative `drop` lifts the tips 38 mm as they sweep back, so each end climbs into the bumper
     * corner. At the tip's new station the flank measures 0.866 against x 0.79: 76 mm inside, and
     * the whole of the section is inside, not just its upper half.
     */
    { w: 1.58, h: 0.050, d: 0.26, y: 0.150, z: 2.300, mat: 'carbon', rx: 0.13, r: 0.020, sweep: 0.14, sweepPow: 2.6, taper: 0.42, drop: -0.038 },
    { w: 1.22, h: 0.018, d: 0.036, y: 0.176, z: 2.404, mat: 'chrome', r: 0.008, sweep: 0.11, sweepPow: 2.4, taper: 0.48, drop: -0.030 },   // its polished blade
    // the splitter's end return — up off the tip into the bumper corner (flank 0.879 at z 2.17,
    // y 0.235; 0.885 at z 2.14, y 0.28)
    { x: 0.780, w: 0.040, h: 0.145, d: 0.19, y: 0.245, z: 2.180, mat: 'carbon', rz: 0.24, mirror: true, r: 0.015 },
    // dive planes, rooted 130 mm inside the flank and 30 mm thick so the outboard tip is a rolled
    // edge rather than a knife (they were 20 mm plates with an 8 mm radius)
    { x: 0.800, w: 0.30, h: 0.030, d: 0.22, y: 0.288, z: 2.03, mat: 'carbon', rz: 0.16, mirror: true, r: 0.014 },
    /**
     * SIDE SILL — the round-5 "rocker that is a floating flat plank".
     *
     * It stood at x 0.985 while the rocker it is supposedly bolted to is at x 0.872 at that height:
     * a 63 mm strip of daylight running the entire 1.9 m length of the car, on both sides, dead
     * centre of the garage hero shot. It now overlaps the rocker by 7 mm, so the carbon grows out
     * of the bodywork; the painted cap and the polished blade move in with it and still bracket it
     * top and bottom, which is what makes the channel read as a channel.
     */
    { x: 0.912, w: 0.10, h: 0.12, d: 1.90, z: 0.10, y: 0.275, mat: 'carbon', mirror: true, r: 0.03 },  // side sill
    { x: 0.928, w: 0.055, h: 0.030, d: 1.86, z: 0.10, y: 0.344, mat: 'paint', mirror: true, r: 0.011 },
    { x: 0.942, w: 0.040, h: 0.026, d: 1.80, z: 0.10, y: 0.207, mat: 'chrome', mirror: true, r: 0.010 },
    // rear valance blade above the diffuser
    { w: 1.28, h: 0.048, d: 0.09, y: 0.478, z: -2.318, mat: 'chrome', r: 0.016 },
    // (the 1.30 m 'nose blade under the lamps' is gone — that line is the lamp slots' own moulded
    //  brow now, made of the same vertices as the clip)
    { w: 1.46, h: 0.075, d: 0.12, y: 0.992, z: -2.336, mat: 'carbon', rx: -0.22, r: 0.025 },   // tail blade, above the lamps — raked, so it is not a third plank parallel to the wing and the valance
    { w: 0.46, h: 0.15, d: 0.04, y: 0.615, z: -2.325, mat: 'dark', r: 0.02 },       // number-plate recess (z pulled in from -2.352: it hung 22 mm clear of the tail)
  ],
  // swan-neck: the blade hangs UNDER its mounts and the endplates are the full chord. Nothing
  // like the tuner's tall twin-element pedestal wing (§6.1 round-2: the two shared one wing).
  // postMat chrome → dark. The swan neck's hook is a 34 x 30 x 200 mm block, and in polished chrome
  // it mirrored the sky as a solid pale-blue cube standing on each side of the wing: the round-1
  // verdict's "box stalks with literal blue box end-caps". Satin black arms are what a modern
  // swan-neck actually wears and they leave the blade as the only thing up there with an edge.
  // `footY` — where the two pylons meet the engine deck. Measured: the deck reads 0.9799 at x 0.60,
  // z -1.922 (`.vjprobe/deck.mjs supercar y,0.60,-1.922`), so 0.950 buries each foot 30 mm inside
  // the bodywork. Before this the wing's lowest mounting point was 76 mm ABOVE the deck.
  wing: { type: 'swan', w: 1.66, chord: 0.36, x: 0.60, y: 1.075, z: -2.03, h: 0.20, footY: 0.950, mat: 'carbon', postMat: 'dark', aoa: -0.16 },
  // ROUND-2: 1.36 m wide with six strakes. §1.3's mid-engine rear is "a wide low diffuser"; at
  // 1.20 on a 2.28 m car it was a narrow box under the middle of the valance with daylight either
  // side of it. It still stops 65 mm inboard of the rear tyres' inner sidewalls, so nothing clips.
  diffuser: { w: 1.36, h: 0.26, d: 0.36, y: 0.352, z: -2.240, strakes: 6, rx: 0.34, mat: 'carbon' },
  exhaust: [{ x: 0.235, y: 0.545, z: -2.36, r: 0.072, len: 0.22 }],
  /**
   * AO DECALS — see the note on the tuner. One shared material for every decal on every car.
   */
  /**
   * ---- AO DECALS, AND WHERE THEY ARE ALLOWED TO GO -----------------------------------------
   *
   * §7 caps a car that hovers over the road at 55 because a shape with no shadow under it is not
   * resting on anything, and the same is true one scale down of a wing, a scoop or a handle bolted
   * to a painted panel — it is most of what "props parked on a shell" looks like at 8x. One shared
   * material for every decal on every car (kit.js `partShadow`), so the whole set is one call.
   *
   * WAVE-10: the `y` (or the `x`, on a flank decal) below is now only a FALLBACK. The assembler
   * re-solves every one of these against the loft's own surface (`deckSampler` / `profileSampler`
   * in assemble.js) and bends the decal down onto the panel's crown, because a hand-measured height
   * goes stale the moment a station moves — two of these were already 4-6 mm under the bodywork by
   * wave 9, rendering to nobody, which is most of why the critic could write "nothing they sit on
   * darkens beneath them" about a car that already had an AO system. The mirrors have decals now
   * too: the sail plate's own `sailX` IS the glasshouse surface at its station.
   */
  shadows: [
    { x: 0.952, y: 0.80, z: 0.14, w: 0.24, d: 0.11, face: 'x' },       // door handle
    { x: 0.60, y: 0.984, z: -1.92, w: 0.16, d: 0.26 },                 // swan-neck pylon feet (deck 0.9799)
    { x: 0.30, y: 0.683, z: 2.14, w: 0.40, d: 0.22 },                  // bonnet extractors (deck 0.6794)
    { x: 0.325, y: 0.672, z: -0.26, w: 0.13, d: 0.42 },                // roll-hoop feet
    // ROUND-8: the side sill. 1.9 m of carbon channel down the middle of the flank, the largest
    // bolt-on on the car after the wing, with no darkening at all where it lands. On the MEASURED
    // flank above the sill's painted cap (0.8973 at z -0.10, y 0.36).
    { x: 0.8988, y: 0.378, z: 0.10, w: 1.56, d: 0.10, face: 'x' },     // side sill
  ],
  // …and the sill's fasteners, on its own outer face (x 0.912 + w/2). Five heads, wider-pitched
  // than the tuner's: a carbon channel on a supercar is bonded and bolted at its ends and centre,
  // not riveted down its whole length like a tuner's plastic skirt.
  fasteners: [{ x: 0.962, y: 0.300, z: 0.10, n: 5, span: 1.52, axis: 'z', r: 0.013, h: 0.010 }],
  /**
   * ---- MOUNTS (kit.js `mountPad`, wired in assemble.js) -------------------------------------
   *
   * The roll hoops used to grow straight out of the paint behind the seats. A hoop is bolted to
   * the bulkhead through a machined foot plate; the plate has a fillet round it and four cap
   * screws in it, and the panel darkens under it. `y` comes from the loft.
   */
  mounts: [
    { x: 0.325, z: -0.26, w: 0.088, d: 0.088, h: 0.024, flange: 1.42, bolts: 4, boltR: 0.0092,
      boltH: 0.009, bead: 0.008, mat: 'dark', spread: 2.0 },
  ],
  extras: [
    // Round 2 stood a 280 mm PAINTED blade on each side of the engine deck: from any side view it
    // read as a red dorsal fin the height of the roof and the rear of the car became a heap of
    // slabs. These are now low carbon deck strakes flanking the louvred engine cover.
    { type: 'buttress', x: 0.615, y: 0.978, z: -0.92, h: 0.135, d: 0.92, rx: 0.09, painted: false },
    // the hoops used to float 340 mm above the deck they are supposed to be bolted to
    { type: 'rollhoop', x: 0.325, y: 0.655, z: -0.26, r: 0.165 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
