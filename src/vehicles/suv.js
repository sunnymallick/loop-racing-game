import { assembleCar } from './assemble.js';

/**
 * BRUTUS H2 — high-clearance off-road 4x4. Hummer silhouette: a square jaw, flat slab sides with
 * no tumblehome at all, a near-vertical windscreen, a roof that runs dead level to a vertical
 * tailgate, enormous fender flares over knobbly tyres, a roof rack, a light bar and a snorkel.
 *
 * Silhouette test (§2.3): from a black outline this must be a BOX on huge wheels — tallest car in
 * the game, widest track, biggest arch-to-body gap filled by tyre.
 *
 * Handling: heavy, high centre of gravity, lots of body roll, unbothered by kerbs and dirt.
 * Nitrous = slow-building freight-train push that keeps pulling at the top end.
 */
export const spec = {
  id: 'suv',
  name: 'BRUTUS',
  full: 'BRUTUS H2 OVERLAND',
  klass: 'OFF-ROAD',
  colors: ['#dfb03c', '#4a5a34', '#38414c', '#a83d20', '#e2ddcf', '#22497a'],
  stats: { speed: 0.62, accel: 0.58, traction: 0.74, weight: 1.0 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

const V = (z) => (z + 2.46) / 4.92;

export const blueprint = {
  id: 'suv', spec, colors: spec.colors,
  /**
   * ROUND-5 TRACK. Verbatim: "the far-side rear wheel sits fully outboard of the rear bumper corner
   * with a visible gap and no fender or flare above it — the rear track is wider than the body."
   *
   * At 1.895 the outer sidewall stood at 1.1475 against a 1.058 body and a 0.96 bumper corner, i.e.
   * 187 mm of tyre hanging outboard of the back of the truck. The flare was reaching it (the tub
   * solves the lip against `tyreX`, so it always does) but a satin-black flare over a black tyre
   * against the arch's own shadow is three dark things in a row and the eye reads one gap. Three
   * changes together, none of which alone was enough: the track comes in 40 mm, the bumper goes out
   * 100 mm so its corner is under the tyre rather than a hand's width inboard of it, and the flare
   * itself is now a mid-dark satin with a lit crown (kit.js `flareBand`, and `archBlackBand` below).
   */
  dims: { length: 4.92, width: 2.30, height: 2.08, wheelbase: 3.05, track: 1.855, trackRear: 1.855, rideHeight: 0.34 },
  // the truck stays the least glossy thing in the game — satin utility paint, not a show car —
  // but it still needs enough of the probe in it to read as metal rather than as matt vinyl
  paint: { metalness: 0.20, roughness: 0.52, clearcoat: 0.72, clearcoatRoughness: 0.50, flake: 0.30, envIntensity: 0.86 },
  livery: {
    // the lower cladding was #3b4048: on the shadowed flank that plus the rocker gradient made the
    // bottom two thirds of the truck one black void with the gold cab floating on top of it
    style: 'offroad', stripe: '#e6e2d4', accent: '#3a3f49',
    panels: {
      doors: [V(0.86), V(-0.30), V(-1.32)],
      hood: [V(1.02), V(2.30)],
      boot: [V(-2.34), V(-1.98)],
      arches: [V(1.525), V(-1.525)],
      fuelCap: [0.30, V(-1.86)],
    },
  },
  /**
   * (COHERENCE PASS) 0.54 -> 0.68, and see `cabin.interior` below — the two are one change.
   *
   * The fleet-wide 0.54 exists to keep the cabin readable through the pane (§7 caps an empty black
   * void at 72) and on the three CARS it is the right number. On this truck it was not: this body
   * carries roughly twice the glazed area of any of them, in one uninterrupted band that runs from
   * the A-pillar to the tailgate, and behind it sat a SAND-coloured interior. 46 % transmission of
   * a large, evenly-lit, pale surface is not a window — it is a pale panel with a slight sheen, and
   * a tall body with a pale band round the top of it is a minibus. Measured over the sixteen-frame
   * set that is most of why the truck reads as a delivery van rather than as a 4x4.
   *
   * 0.68 with a dark cabin behind it is a privacy screen: the seats, the head restraints and the
   * rear bulkhead are all still there to be seen (the black-void tell is about an EMPTY cabin, not
   * a dim one), but the greenhouse now has a value of its own and the body reads as one solid mass.
   */
  glass: { tint: '#0a1017', opacity: 0.68 },

  body: [
    { z: -2.46, w: 0.975, y0: 0.72, floor: 0.66, rocker: 0.97, ySill: 0.98, yBelt: 1.44, belt: 0.985, yDeck: 1.44, deck: 0.955, crown: 0.004 },
    { z: -2.38, w: 1.030, y0: 0.66, floor: 0.70, rocker: 0.97, ySill: 0.92, yBelt: 1.46, belt: 0.985, yDeck: 1.46, deck: 0.945, crown: 0.006 },
    { z: -2.22, w: 1.048, y0: 0.62, floor: 0.72, rocker: 0.965, ySill: 0.89, yBelt: 1.48, belt: 0.985, yDeck: 1.475, deck: 0.94, crown: 0.008, flare: 1.01 },
    { z: -2.04, w: 1.052, y0: 0.60, floor: 0.72, rocker: 0.96, ySill: 0.88, yBelt: 1.49, belt: 0.985, yDeck: 1.485, deck: 0.94, crown: 0.008, flare: 1.02 },
    { z: -1.98, w: 1.052, y0: 0.60, floor: 0.72, rocker: 0.96, ySill: 0.88, yBelt: 1.49, belt: 0.985, yDeck: 1.265, deck: 0.90, crown: 0.006, flare: 1.022 },
    { z: -1.72, w: 1.056, y0: 0.60, floor: 0.72, rocker: 0.955, ySill: 0.875, yBelt: 1.50, belt: 0.985, yDeck: 1.265, deck: 0.90, crown: 0.006, flare: 1.055 },
    { z: -1.525, w: 1.058, y0: 0.60, floor: 0.72, rocker: 0.95, ySill: 0.87, yBelt: 1.50, belt: 0.985, yDeck: 1.265, deck: 0.90, crown: 0.006, flare: 1.078 },
    { z: -1.30, w: 1.054, y0: 0.60, floor: 0.72, rocker: 0.95, ySill: 0.87, yBelt: 1.50, belt: 0.985, yDeck: 1.262, deck: 0.90, crown: 0.006, flare: 1.040 },
    { z: -0.90, w: 1.046, y0: 0.60, floor: 0.72, rocker: 0.945, ySill: 0.868, yBelt: 1.50, belt: 0.985, yDeck: 1.260, deck: 0.90, crown: 0.006 },
    { z: -0.10, w: 1.044, y0: 0.60, floor: 0.72, rocker: 0.945, ySill: 0.868, yBelt: 1.50, belt: 0.985, yDeck: 1.258, deck: 0.90, crown: 0.006 },
    { z: 0.60, w: 1.046, y0: 0.60, floor: 0.72, rocker: 0.945, ySill: 0.868, yBelt: 1.50, belt: 0.985, yDeck: 1.260, deck: 0.90, crown: 0.006 },
    { z: 0.94, w: 1.048, y0: 0.60, floor: 0.72, rocker: 0.948, ySill: 0.87, yBelt: 1.50, belt: 0.985, yDeck: 1.265, deck: 0.90, crown: 0.006 },
    { z: 1.02, w: 1.048, y0: 0.60, floor: 0.72, rocker: 0.948, ySill: 0.87, yBelt: 1.50, belt: 0.985, yDeck: 1.505, deck: 0.93, crown: 0.010 },
    { z: 1.30, w: 1.052, y0: 0.60, floor: 0.72, rocker: 0.95, ySill: 0.872, yBelt: 1.50, belt: 0.985, yDeck: 1.505, deck: 0.93, crown: 0.010, flare: 1.038 },
    { z: 1.525, w: 1.058, y0: 0.60, floor: 0.72, rocker: 0.95, ySill: 0.874, yBelt: 1.50, belt: 0.985, yDeck: 1.505, deck: 0.93, crown: 0.010, flare: 1.078 },
    { z: 1.80, w: 1.054, y0: 0.605, floor: 0.72, rocker: 0.955, ySill: 0.878, yBelt: 1.495, belt: 0.985, yDeck: 1.50, deck: 0.93, crown: 0.010, flare: 1.048 },
    { z: 2.10, w: 1.048, y0: 0.62, floor: 0.72, rocker: 0.96, ySill: 0.885, yBelt: 1.49, belt: 0.985, yDeck: 1.495, deck: 0.935, crown: 0.008 },
    { z: 2.34, w: 1.032, y0: 0.66, floor: 0.70, rocker: 0.965, ySill: 0.92, yBelt: 1.47, belt: 0.985, yDeck: 1.475, deck: 0.945, crown: 0.006 },
    { z: 2.46, w: 0.985, y0: 0.74, floor: 0.66, rocker: 0.97, ySill: 1.00, yBelt: 1.45, belt: 0.99, yDeck: 1.45, deck: 0.955, crown: 0.004 },
  ],

  cabin: {
    stations: [
      { z: 1.02, hw: 0.995, rw: 0.960, yBelt: 1.502, yRoof: 1.522 },
      { z: 0.92, hw: 0.998, rw: 0.955, yBelt: 1.502, yRoof: 1.640 },
      { z: 0.66, hw: 1.000, rw: 0.948, yBelt: 1.502, yRoof: 1.960 },
      { z: 0.50, hw: 1.002, rw: 0.945, yBelt: 1.502, yRoof: 2.060 },
      { z: -0.20, hw: 1.004, rw: 0.945, yBelt: 1.502, yRoof: 2.075 },
      { z: -1.20, hw: 1.004, rw: 0.945, yBelt: 1.500, yRoof: 2.070 },
      /**
       * (coherence pass) THE TAILGATE GLASS, AND WHY THE TRUCK READ AS A DELIVERY VAN.
       *
       * The old rear ran z -1.72 (roof 2.010) → -1.90 (1.600) → -1.98 (1.510): a 0.47 m drop over a
       * 0.26 m run, i.e. a backlight raked 28 deg off vertical. Two things follow from that rake and
       * both of them are what the sixteen-frame set kept showing.
       *
       *   1. A section that is falling away that fast has a long, near-horizontal TOP, and the roof
       *      band (`roof` below, and the rails above it) is drawn over the top 6/16 of every section
       *      it spans — so it came down over the upper HALF of the rear window. Rendered dead astern
       *      that is a body-coloured panel with a glazed slit under it, which is exactly the back of
       *      a panel van (measured: tools/_coh4_suv2.mjs colour-codes the cabin meshes — the roof
       *      band covered ~45 % of the backlight opening).
       *   2. A raked backlight over a long rear deck is a WAGON. §2.3 asks for a "tall square
       *      high-clearance 4x4"; an H2's tailgate glass is within a few degrees of vertical and
       *      runs from the roof gutter straight down to the tailgate lip.
       *
       * So the roof is held dead level 140 mm further aft to a proper rear header at z -1.86, and
       * the whole drop is taken in the 0.12 m behind it — 14 deg off vertical instead of 28. The
       * roof band's z0 is the header, so it now stops ON the header instead of sliding down the
       * glass, and every square metre of the opening is glazed. The tailgate itself, the high-mount
       * lamp and the chrome garnish below are all untouched.
       */
      { z: -1.78, hw: 1.001, rw: 0.948, yBelt: 1.498, yRoof: 2.056 },
      { z: -1.86, hw: 0.997, rw: 0.954, yBelt: 1.495, yRoof: 1.988 },   // rear header
      { z: -1.94, hw: 0.991, rw: 0.962, yBelt: 1.492, yRoof: 1.706 },
      { z: -1.98, hw: 0.985, rw: 0.968, yBelt: 1.490, yRoof: 1.510 },
    ],
    roof: { z0: -1.86, z1: 0.54, a: 5, offset: 0.016 },
    wipers: { z: 0.950, w: 0.54, x: 0.32, sweep: 0.20 },
    pillars: [
      // full-length bright roof rails — the detail that says "wagon" from a silhouette, and the
      // line that separates a 2.07 m roof from the tall flat side glass under it
      { z0: -1.86, z1: 0.56, a: 5, b: 6, mat: 'chrome', steps: 10, offset: 0.020 },
      { z0: 0.54, z1: 1.02, a: 2, b: 5, mat: 'paint', steps: 4 },      // A — near vertical
      { z0: 0.26, z1: 0.40, a: 2, b: 5, mat: 'dark', steps: 2 },       // B
      { z0: -0.72, z1: -0.58, a: 2, b: 5, mat: 'dark', steps: 2 },     // C
      { z0: -1.86, z1: -1.98, a: 2, b: 5, mat: 'paint', steps: 3 },    // D — now a true tailgate-glass surround
    ],
    beltZ0: -1.80, beltZ1: 0.56, beltMat: 'dark',
    // Utility cabin — and it stays a cabin, with the rear bench, its head restraints and the
    // bulkhead directly behind the tailgate window, which is what fills the black slot every chase
    // frame used to show there.
    //
    // (COHERENCE PASS) …but it stopped being sand. 0x6d6152 is a 42 %-value taupe, the brightest
    // interior in the game, sitting behind the largest glass area in the game — through a pane
    // passing 46 % of it, the whole greenhouse rendered as a flat mid-tone band the same value as
    // the body, i.e. as PAINT. On the LA chase capture the tailgate window measured within four
    // code values of the tailgate panel below it: two surfaces, one apparent material, and the eye
    // resolves that as a van's blank back door. Down two stops to a dark utility khaki: still lit,
    // still legible through the glass at any range the chase camera works at, but now clearly
    // BEHIND something. The cluster stays green because it is the one thing in there that emits.
    interior: { seat: 0x3d382f, trim: 0x2a2721, accent: 0x34302a, floorY: 1.275, headY: 1.815, dashY: 1.505, wheelY: 1.545, shelfY: 1.55, seatZ: 0.28, dashZ: 0.78, dashW: 1.76, seatX: 0.46, shelfZ: 1.70, shelfD: 0.66, clusterColor: '#9fe8a0' },
  },

  wheels: {
    // gunmetal six-spoke beadlocks — the ONLY class that wears a knobby off-road carcass
    // gunmetal six-spoke BEADLOCKS — a bronze clamp ring and twelve bolts round the outer rim, the
    // single most readable wheel detail at distance, on the only knobby carcass in the game
    style: 'offroad', rimColor: '#666d78', caliperColor: '#33383f', capColor: '#c4a24a', tire: 'knobby',
    beadlock: true,
    front: { radius: 0.500, width: 0.40, spokes: 6, tireProfile: 0.335 },
    rear: { radius: 0.500, width: 0.40, spokes: 6, tireProfile: 0.335 },
  },
  // Square bolt-on flares, riveted round the opening. Cut into the tub (kit.js `loftTub`) rather
  // than bolted onto it: the truck has the flattest slab sides in the game, so a ring standing off
  // that slab was the most obviously detached thing on any of the four cars. archProud is the
  // biggest here — a 4x4's flares deliberately stand outboard of the tyre to throw mud clear.
  // archBlackBand 0.38 → 0.60: the satin plastic now stops at the lip and its return, and the CROWN
  // of the flare — the part that arcs over the top of the tyre and is what you read as a fender —
  // stays body colour. On a gold truck that is a bright arc over each wheel where there used to be
  // an unbroken black mass from the door shut line to the tread.
  archGap: 1.090, archFlare: 0.205, archLip: 0.030, archProud: 0.026, archInset: 0.068,
  archDepth: 0.16, archSpan: 1.04, blackArches: true, archBolts: 7, archBlackBand: 0.72,

  lights: {
    head: [
      { x: 0.70, y: 1.13, z: 2.455, w: 0.30, h: 0.30, shape: 'round', color: '#f4f8ff', intensity: 3.0 },
      // DRIVING LAMPS in the bumper. The front bumper is 1.98 x 0.26 m of unbroken dark plastic
      // sitting under the widest, flattest nose in the game — the single largest blank surface on
      // any of the four cars. Same colour, intensity and halo as the head units, so they join that
      // bank and cost no draw call; they sit either side of the intake below.
      { x: 0.62, y: 0.835, z: 2.598, w: 0.17, h: 0.17, shape: 'round', color: '#f4f8ff', intensity: 3.0 },
    ],
    // Four-segment stacked lens. A 0.20 x 0.46 m lens is 2.4x the area of the muscle car's round
    // lamps, so at the same emissive it carries 2.4x the energy into the bloom pass: the two rear
    // corners of the truck rendered as solid red domes wider than the tailgate, with no lens, no
    // bezel and no tailgate detail visible inside them. Lower intensity plus one more divider rib
    // keeps the total light about the same while leaving the SHAPE of the lamp readable.
    tail: [
      { x: 0.86, y: 1.16, z: -2.475, w: 0.20, h: 0.46, color: '#ff2a14', intensity: 1.35, glow: 0.35, segs: 4 },
      // high-mount stop lamp on the tailgate top lip — same colour/intensity/glow as the corner
      // lamps so it joins their bank, and a bright red line above the tailgate in every chase frame
      { x: 0, y: 1.507, z: -2.505, w: 0.46, h: 0.05, color: '#ff2a14', intensity: 1.35, glow: 0.35, segs: 4, mirror: false, bezel: false },
    ],
    reverse: [{ x: 0.86, y: 0.86, z: -2.475, w: 0.18, h: 0.12, color: '#fff2d8', intensity: 1.5, glow: 0.3 }],
    // (the high-mount stop lamp is declared in `tail` above so it shares that bank's lens and halo
    //  materials and costs no extra draw call)
  },

  grilles: [
    { w: 1.30, h: 0.46, d: 0.16, y: 1.13, z: 2.46, slats: 7, vertical: true, frame: 'chrome' },
    // …and the intake between the driving lamps, so the bumper has a mouth
    { w: 0.86, h: 0.115, d: 0.10, y: 0.835, z: 2.592, slats: 3, mesh: true, frame: 'dark' },
  ],
  // above the bull bar's tube (y 1.16) so it is not hidden behind it
  badges: [{ x: 0, y: 1.295, z: 2.526, w: 0.112, h: 0.090, d: 0.022 }],
  vents: [
    { x: 0.0, y: 1.505, z: 1.72, w: 0.62, h: 0.22, fins: 4, angle: 0.5, rx: -1.5708, mirror: false },
    { x: 1.06, y: 1.12, z: 1.18, w: 0.30, h: 0.20, fins: 3, angle: 0.4, ry: 1.5708 },
  ],
  mirrors: { x: 1.06, y: 1.60, z: 0.96, painted: false },
  handles: [{ x: 1.055, y: 1.40, z: 0.30 }, { x: 1.055, y: 1.40, z: -0.86 }],

  trim: [
    { w: 2.04, h: 0.26, d: 0.30, y: 0.86, z: 2.44, mat: 'dark', r: 0.05 },     // front bumper
    { w: 2.02, h: 0.24, d: 0.28, y: 0.86, z: -2.42, mat: 'dark', r: 0.05 },    // rear bumper
    // Body-colour caps along the top of both bumpers. A 2 m black bar under a gold truck welded the
    // bumper, the flares and the tyres into one silhouette in every chase frame; a painted upper
    // half splits that bar in two and carries the car's colour all the way down the tailgate.
    { w: 1.98, h: 0.075, d: 0.30, y: 1.005, z: 2.442, mat: 'paint', r: 0.026 },
    { w: 1.96, h: 0.070, d: 0.28, y: 0.995, z: -2.422, mat: 'paint', r: 0.026 },
    // and a satin blade along the bottom of each, so the bumper has a lit lower edge
    { w: 1.78, h: 0.032, d: 0.26, y: 0.730, z: 2.446, mat: 'chrome', r: 0.011 },
    { w: 1.74, h: 0.032, d: 0.25, y: 0.740, z: -2.426, mat: 'chrome', r: 0.011 },
    // ROCK SLIDER. At x 1.16 its inner face was 109 mm outboard of the rocker it is meant to be
    // welded to, so the truck had a black bar hovering under each door with the garage floor
    // visible behind it. Pulled in to overlap the body; the tread edge rides its top outer corner.
    { x: 1.045, w: 0.14, h: 0.18, d: 2.70, y: 0.82, z: 0, mat: 'dark', mirror: true, r: 0.04 },  // rock slider
    { x: 1.085, w: 0.055, h: 0.024, d: 2.50, y: 0.916, z: 0, mat: 'chrome', mirror: true, r: 0.009 }, // slider tread edge
    /**
     * SKID PLATES, raised 80 mm. At y 0.60 the plate's top sat 140 mm below the bumper's underside,
     * so from a chase camera the truck had a bright 1.44 m plank hanging in mid-air under its tail
     * with daylight above it — and being polished, its top edge picked up a dashed aliased highlight
     * along its whole length. They now tuck up against the bumper they are bolted to, and the rear
     * one is dark alloy: it is the piece directly under the tail lamps in every chase frame and a
     * mirror there was the brightest thing on the back of the car.
     */
    { w: 1.38, h: 0.10, d: 0.66, y: 0.682, z: 2.06, mat: 'chrome', r: 0.03 },   // front skid plate
    { w: 1.30, h: 0.10, d: 0.58, y: 0.682, z: -2.08, mat: 'dark', r: 0.03 },    // rear skid plate
    { w: 1.72, h: 0.055, d: 0.10, y: 1.435, z: -2.485, mat: 'dark', r: 0.02 },  // tailgate top lip
    // chrome garnish bridging the two lamp stacks: at night this is the only thing back here with
    // a specular, so it is what stops the tailgate reading as one black quad in Vegas and NYC
    { w: 1.44, h: 0.075, d: 0.06, y: 1.245, z: -2.535, mat: 'chrome', r: 0.026 },
    { w: 1.60, h: 0.045, d: 0.05, y: 0.905, z: -2.520, mat: 'chrome', r: 0.018 },
  ],
  exhaust: [{ x: 0.78, y: 0.74, z: -2.46, r: 0.075, len: 0.24 }],
  extras: [
    { type: 'bullbar', w: 1.90, h: 0.60, y: 1.16, z: 2.53 },
    { type: 'rack', w: 1.78, d: 2.10, y: 2.11, z: -0.62, jerry: true },
    { type: 'lightbar', w: 1.56, count: 7, y: 2.24, z: 0.42 },
    { type: 'snorkel', x: 1.07, y: 1.66, z: 1.34, h: 1.05 },
    // the tailgate: shut gap, two swage seams, a pull handle, a lit plate recess and a badge bar
    { type: 'tailgate', w: 1.62, h: 0.62, d: 0.07, y: 1.085, z: -2.478, plateX: -0.30, ry: 3.14159 },
    // …and the spare on the back of it. See assemble.js `sparewheel` for why this one detail is
    // worth a draw call: it is the cue that separates a tall box with a roof rack from a van.
    // Sited so its crown clears the high-mount stop lamp (raised 45 mm to make room) and its
    // hinge post stands on the right-hand side of the tailgate, clear of the plate recess.
    { type: 'sparewheel', r: 0.395, w: 0.22, hinge: 0.44, x: 0.10, y: 1.035, z: -2.66 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
