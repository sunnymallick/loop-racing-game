import { assembleCar } from './assemble.js';

/**
 * VELOCE DOMINATOR — American muscle. 1970 Charger / Mustang fastback DNA:
 * a very long bonnet, a short deck, a high beltline with a coke-bottle kink, enormous rear
 * haunches over the back wheels, a fastback roof that runs all the way to the tail panel,
 * four round taillights and a supercharger through the bonnet.
 *
 * Silhouette test (§2.3): the outline must read long-hood / short-deck with the cabin pushed
 * right to the back axle. Every station below is placed for that.
 *
 * Handling: heavy, torque-rich, tail-happy. Nitrous = brutal sustained shove.
 */
export const spec = {
  id: 'muscle',
  name: 'DOMINATOR',
  full: '1970 DOMINATOR 440',
  klass: 'MUSCLE',
  // The reference hero (f&f1) is a MINT-TEAL fastback with twin white stripes. Round 3's #1d7f60
  // was a bottle green that went black in three of the four cities and is most of why the hero car
  // "reads small and dark in almost every frame" — a hero colour has to hold value under a night
  // grade, not just under a studio light.
  colors: ['#16a984', '#b32222', '#2a4272', '#f0ae1e', '#1b1d23', '#7b39a0'],
  stats: { speed: 0.86, accel: 0.78, traction: 0.55, weight: 0.92 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

/**
 * z runs -2.58 (tail) … +2.48 (nose). v in the paint texture = (z + 2.58) / 5.06.
 *
 * ROUND-2: the nose came back 100 mm. The verdict — "at 3x its front overhang ahead of the front
 * wheel is enormous and the nose is a flat vertical slab, reading as a 70s land-yacht rather than
 * long-hood/short-deck fastback" — was measuring 1.09 m of car ahead of the front wheel centre, on
 * a 2.98 m wheelbase. A '70 fastback runs about 0.95-1.00 there; 1.09 is a Continental. It is now
 * 0.99, and the last two stations rake the nose down and tuck the valance under it, so the front
 * is a wedge with a leading edge instead of a wall.
 */
const V = (z) => (z + 2.58) / 5.06;

export const blueprint = {
  id: 'muscle', spec, colors: spec.colors,
  // Track and tail are set against each other so the REAR TYRES BREAK THE SILHOUETTE from a
  // straight-on chase view (§6.1 round-2: the wheels were invisible in every harness frame). The
  // rear tyre's outer sidewall sits at 1.085 while the tail panel tucks in to 0.914 — 17 cm of
  // haunch and rubber outboard of the bodywork on each side.
  dims: { length: 5.06, width: 2.24, height: 1.42, wheelbase: 2.98, track: 1.740, trackRear: 1.846, rideHeight: 0.16 },
  // see paintMaterial(): metalness carries the environment into the paint, and the environment is
  // the only light on the back of a car in a chase frame. Deep metallic teal with a hard clearcoat.
  // Round-1 (this round): metalness 0.52 → 0.28 and the probe weighting 1.20 → 0.88. See the note
  // over paintMaterial() — at 0.52 half the teal was being replaced by a blurred capture of
  // whatever room or street the car stood in, which is what put a pale milky wash down the bonnet
  // and across the rear haunch of the hero frame. The reflection now arrives from the analytic
  // horizon instead, which is sharp and carries the paint's own hue.
  /**
   * ROUND-3 (vehicle art): BASE ROUGHNESS 0.29 → 0.46, COAT ROUGHNESS 0.058 → 0.25.
   *
   * The round-2 verdict on the environment reflection — "it resolves as big flat stair-stepped
   * rectangles of pink/teal, a very low-res probe reading as colour patches, not a reflection" —
   * turned out to be the SAME defect as the crumpled rear quarter this round found at 4x. Ablation
   * (`tools/_va3_sweep.mjs chase muscle`): render the identical geometry at metalness 0 with no
   * coat and the haunch is a clean pressing with one crease in it; put a 0.29-roughness metallic
   * coat back on and five parallel "folds" appear across it. They are not geometry. They are the
   * city's cube probe — a 384 px capture whose top mip is degrees per texel — sampled at a mip
   * sharp enough to show its own texels, on a panel that sweeps 90° of reflection direction.
   *
   * Roughness is what chooses that mip, so the fix is to sample the probe where it is smooth and
   * take the SHARP reflection from the analytic horizon instead (`kit.js skyReflect`), which is
   * generated per fragment and has no texels to show. This is also what real metallic paint is: a
   * fairly diffuse flake basecoat under a gloss lacquer, not a mirror-smooth basecoat.
   */
    /**
   * …and the COAT roughness with it (0.058 → 0.44). Same measurement, other layer: the garage key
   * is a spot at intensity 452, and a clearcoat lobe that tight turns it into a soft white plate
   * the size of the rear haunch — the "white-cyan bar smearing across roof, C-pillar and rear
   * quarter" of the round-2 verdict is that plate, not the bloom it was throwing. Spreading the
   * coat leaves the paint its own colour under the highlight and costs nothing that matters,
   * because the SHARP reflection on these cars is the analytic horizon, not the coat.
   */
  paint: { metalness: 0.28, roughness: 0.46, clearcoat: 0.95, clearcoatRoughness: 0.44, flake: 0.62, envIntensity: 0.92 },
  livery: {
    style: 'stripes', stripe: '#f2efe6',
    panels: {
      stripeWidth: 0.038, stripeGap: 0.026,
      doors: [V(0.62), V(-1.02)],
      hood: [V(0.74), V(2.32)],
      boot: [V(-2.44), V(-1.92)],
      arches: [V(1.49), V(-1.49)],
      fuelCap: [0.30, V(-2.10)],
    },
  },
  // The interior has to survive the pane (§7 caps an empty black void at 72), so the opacity stays
  // low — but the TINT goes deep. A privacy screen is a very dark glass you can still see through;
  // a pale tint at the same opacity is a milky panel, which is what the round-1 hero frame shows
  // over all four cabins.
  glass: { tint: '#070c12', opacity: 0.54 },

  // ---- the tub: ground → beltline, with the bonnet, the cabin recess and the boot lid ----
  body: [
    { z: -2.58, w: 0.790, y0: 0.50, floor: 0.55, rocker: 0.95, ySill: 0.62, yBelt: 0.90, belt: 0.96, yDeck: 0.90, deck: 0.92, crown: 0.005 },
    { z: -2.50, w: 0.865, y0: 0.42, floor: 0.58, rocker: 0.95, ySill: 0.56, yBelt: 0.95, belt: 0.96, yDeck: 0.95, deck: 0.90, crown: 0.01 },
    { z: -2.30, w: 0.905, y0: 0.33, rocker: 0.93, ySill: 0.50, yBelt: 0.99, belt: 0.95, yDeck: 0.98, deck: 0.88, crown: 0.015, flare: 1.01 },
    { z: -2.12, w: 0.932, y0: 0.30, rocker: 0.925, ySill: 0.485, yBelt: 0.995, belt: 0.95, yDeck: 0.985, deck: 0.875, crown: 0.015, flare: 1.02 },
    { z: -2.00, w: 0.950, y0: 0.28, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.99, deck: 0.87, crown: 0.015, flare: 1.045 },
    { z: -1.94, w: 0.958, y0: 0.27, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.99, deck: 0.87, crown: 0.015, flare: 1.058 },
    // — cabin recess begins: the deck drops below the belt so the interior is a real hole —
    { z: -1.88, w: 0.962, y0: 0.27, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.79, deck: 0.86, crown: 0.01, flare: 1.068 },
    { z: -1.60, w: 0.980, y0: 0.26, rocker: 0.91, ySill: 0.465, yBelt: 1.00, belt: 0.945, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.086 },
    { z: -1.30, w: 0.976, y0: 0.255, rocker: 0.90, ySill: 0.46, yBelt: 1.005, belt: 0.945, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.075 },
    { z: -0.95, w: 0.958, y0: 0.25, rocker: 0.885, ySill: 0.455, yBelt: 1.01, belt: 0.94, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.012 },
    { z: -0.35, w: 0.948, y0: 0.25, rocker: 0.875, ySill: 0.45, yBelt: 1.015, belt: 0.94, yDeck: 0.78, deck: 0.85, crown: 0.01 },
    { z: 0.25, w: 0.950, y0: 0.25, rocker: 0.875, ySill: 0.45, yBelt: 1.015, belt: 0.94, yDeck: 0.78, deck: 0.85, crown: 0.01 },
    { z: 0.66, w: 0.955, y0: 0.255, rocker: 0.88, ySill: 0.455, yBelt: 1.015, belt: 0.94, yDeck: 0.79, deck: 0.85, crown: 0.01 },
    // — cowl: the deck steps back up to bonnet height, which reads as the base of the screen —
    { z: 0.74, w: 0.956, y0: 0.255, rocker: 0.88, ySill: 0.455, yBelt: 1.015, belt: 0.945, yDeck: 1.005, deck: 0.86, crown: 0.012 },
    { z: 1.05, w: 0.960, y0: 0.255, rocker: 0.885, ySill: 0.455, yBelt: 1.015, belt: 0.945, yDeck: 1.00, deck: 0.86, crown: 0.015, flare: 1.005 },
    { z: 1.42, w: 0.968, y0: 0.26, rocker: 0.89, ySill: 0.46, yBelt: 1.015, belt: 0.945, yDeck: 0.995, deck: 0.86, crown: 0.02, flare: 1.030 },
    { z: 1.80, w: 0.966, y0: 0.27, rocker: 0.895, ySill: 0.47, yBelt: 1.01, belt: 0.945, yDeck: 0.99, deck: 0.86, crown: 0.02, flare: 1.022 },
    { z: 2.12, w: 0.958, y0: 0.30, rocker: 0.90, ySill: 0.49, yBelt: 1.00, belt: 0.95, yDeck: 0.985, deck: 0.87, crown: 0.02, flare: 1.008 },
    /**
     * ---- THE FRONT CLIP, LOFTED (round-1, this piece) --------------------------------------
     *
     * The verdict on this car, verbatim: "the cream grille bar ends in a flat face with a visible
     * dark separation line where it should blend into the green fender, and the valance is a
     * separate slab intersecting the loft."
     *
     * Both were the same construction error the tuner had. The tub's front face used to stop at
     * y0 0.545 — 545 mm off the road — and neck in to w 0.815, so there was NO BODYWORK at all
     * below the bumper or outboard of it, and the 1.50 m valance and the 1.30 m chrome bar were
     * hanging in that empty space. (They were the only thing there: the cap panel itself was being
     * back-face culled — see the winding note in kit.js `capPanel`.)
     *
     * The last three stations now carry the whole clip: y0 drops to 0.295 with `floor` opened to
     * 0.86, and the taper to the tip is 0.958 → 0.928 instead of 0.958 → 0.815, so the face is
     * full-width and reaches the road exactly the way a '70 loop-bumper front end does. The grille
     * mouth and the valance intake are cut into it by `nose.apertures`.
     */
    { z: 2.36, w: 0.950, y0: 0.310, floor: 0.66, rocker: 0.925, ySill: 0.500, yBelt: 0.968, belt: 0.955, yDeck: 0.960, deck: 0.90, crown: 0.012 },
    { z: 2.45, w: 0.938, y0: 0.300, floor: 0.78, rocker: 0.945, ySill: 0.470, yBelt: 0.938, belt: 0.965, yDeck: 0.932, deck: 0.92, crown: 0.007 },
    { z: 2.48, w: 0.928, y0: 0.295, floor: 0.86, rocker: 0.958, ySill: 0.455, yBelt: 0.918, belt: 0.970, yDeck: 0.914, deck: 0.93, crown: 0.005 },
  ],

  // ---- the glasshouse: one continuous piece of glass, with paint bands laid over it ----
  /**
   * ---- THE NOSE PANEL ---------------------------------------------------------------------
   *
   * The grille mouth and the valance intake are cut INTO the lofted face by `loftTub`'s cap grid
   * (kit.js §7) rather than bolted in front of it: one rounded-rect SDF per opening, pushed in over
   * a rim fillet, with `flat` putting each floor on a single plane so a rectangular mesh actually
   * fits the hole. The recess carries its own overhang shading through `aWell` (kit.js
   * `archReturn`), which is the same ramp that darkens the metal behind a wheel-arch lip.
   */
  nose: {
    crown: 0.045, rake: -0.05, rings: 13, cy: 0.640,
    apertures: [
      // THE GRILLE MOUTH — full width, with the four round lamps standing inside it and a chrome
      // centre screen between them, which is the '70 layout and what the old 1.50 m bolted-on
      // rectangle was standing in for.
      // 235 -> 265 mm tall. The flat floor of an aperture is (h - 2·rim - 14 mm); at 235 that is
      // 161 mm, so the 195 mm sealed beams standing in it were scaled to 161 on the way in and the
      // centre screen with them. At 265 the floor is 191 mm and everything inside sits as authored.
      { y: 0.775, w: 1.60, h: 0.265, r: 0.035, depth: 0.055, rim: 0.030, shade: 1, lip: 0.014, lipW: 0.050 },
      // THE VALANCE INTAKE. The old `front valance` was a 1.50 x 0.09 x 0.30 dark slab at y 0.44
      // with the tub's underside 105 mm ABOVE it — a plank hanging in open air under the nose.
      // The bodywork now runs down to y 0.295 and this is the hole in it.
      // …and the valance intake goes 128 -> 160 mm for the same reason, and because it now carries
      // the two amber park lamps as well as its screen (see `lights.drl`).
      { y: 0.410, w: 1.18, h: 0.160, r: 0.040, depth: 0.048, rim: 0.028, shade: 1 },
    ],
  },

  cabin: {
    stations: [
      { z: 0.74, hw: 0.855, rw: 0.800, yBelt: 1.015, yRoof: 1.035 },
      { z: 0.60, hw: 0.858, rw: 0.780, yBelt: 1.015, yRoof: 1.115 },
      { z: 0.32, hw: 0.866, rw: 0.735, yBelt: 1.015, yRoof: 1.290 },
      { z: 0.08, hw: 0.872, rw: 0.712, yBelt: 1.015, yRoof: 1.400 },
      { z: -0.30, hw: 0.878, rw: 0.708, yBelt: 1.015, yRoof: 1.420 },
      { z: -0.80, hw: 0.876, rw: 0.706, yBelt: 1.012, yRoof: 1.412 },
      { z: -1.12, hw: 0.872, rw: 0.712, yBelt: 1.010, yRoof: 1.372 },
      { z: -1.45, hw: 0.885, rw: 0.760, yBelt: 1.005, yRoof: 1.245 },
      { z: -1.72, hw: 0.885, rw: 0.820, yBelt: 1.000, yRoof: 1.090 },
      { z: -1.88, hw: 0.875, rw: 0.850, yBelt: 1.000, yRoof: 1.010 },
    ],
    roof: { z0: -1.34, z1: 0.06, a: 5, offset: 0.015 },
    pillars: [
      { z0: 0.10, z1: 0.74, a: 2, b: 5, mat: 'paint', steps: 5 },     // A-pillar / cowl side
      { z0: -0.30, z1: -0.16, a: 2, b: 5, mat: 'paint', steps: 2 },   // B-pillar
      { z0: -1.32, z1: -1.88, a: 2, b: 5, mat: 'paint', steps: 6 },   // fastback sail
      /**
       * DRIP RAIL. Ring index 5→6 is the outer 60 mm of the roof pressing, so this is a band OF the
       * roof, sharing every vertex with it — one strip per side, proud of the roof panel by 4 mm.
       *
       * A '70 coupe wears a bright rail down each roof edge, and it is doing structural work in the
       * picture: without it the roof paint and the side glass meet on a soft shaded corner and the
       * whole greenhouse reads as one continuous pale dome (which is exactly what the round-1 hero
       * crop shows). A hard bright line there is what tells the eye where the roof STOPS.
       */
      { z0: -1.36, z1: 0.08, a: 5, b: 6, mat: 'chrome', steps: 9, offset: 0.019 },
    ],
    // parked across the bottom of the screen, laid back along the 29-degree rake
    wipers: { z: 0.660, w: 0.50, x: 0.28, sweep: 0.22 },
    beltZ0: -1.36, beltZ1: 0.14, beltMat: 'chrome',
    // Oxblood-and-charcoal cabin. The seats/dash/shelf are authored 3x lighter than round 3 (which
    // had them at 0x14–0x2a) because a cabin is lit by nothing but sky bounce and then hidden
    // behind glass; see buildInterior(). shelfZ pushes the parcel shelf back under the fastback
    // backlight so the rear head restraints sit in the chase camera's line of sight.
    interior: { seat: 0x5c6069, trim: 0x3d414a, accent: 0x8f3038, floorY: 0.80, headY: 1.235, dashY: 1.005, wheelY: 1.045, shelfY: 1.015, seatZ: -0.34, dashZ: 0.90, dashW: 1.44, seatX: 0.36, shelfZ: 0.84, shelfD: 0.56, clusterColor: '#ffb347' },
  },

  wheels: {
    // polished deep-dish chrome five-spoke on raised-sidewall white-letter street rubber, with a
    // staggered rear: 380 mm section on a 405 mm carcass is what fills those haunches.
    style: 'fivespoke', rimColor: '#aeb5bf', caliperColor: '#b81c1c', lipColor: '#c3c9d3', tire: 'muscle',
    capColor: '#b81c1c',
    front: { radius: 0.365, width: 0.30, spokes: 5, tireProfile: 0.320 },
    rear: { radius: 0.405, width: 0.38, spokes: 5, tireProfile: 0.325 },
  },
  // The arch is cut into the tub (kit.js `loftTub`). archFlare is wide because the haunch over a
  // Charger's back wheel is a long, slow draw from the door to the widest point of the car — that
  // swell IS the silhouette, and it is what the rear tyre now sits inside instead of beside.
  archGap: 1.100, archFlare: 0.185, archLip: 0.016, archProud: 0.012, archInset: 0.056,
  archDepth: 0.13, archSpan: 1.02,

  lights: {
    // Both pairs sit ON the grille recess floor (z 2.425), so their housings — 90 mm cylinders —
    // are entirely behind the bodywork instead of standing out of a nose that stopped 35 mm short
    // of them. y comes down to the aperture's centre line for the same reason.
    head: [
      { x: 0.415, y: 0.775, z: 2.436, w: 0.185, h: 0.185, shape: 'round', color: '#f2f6ff', intensity: 2.8 },
      { x: 0.665, y: 0.775, z: 2.436, w: 0.185, h: 0.185, shape: 'round', color: '#f2f6ff', intensity: 2.8 },
    ],
    /**
     * AMBER PARK LAMPS, in the valance intake either side of its screen.
     *
     * Round-1 verdict: "in a dark garage set the front lamps are dead matte while the taillights
     * bloom — §2.3 requires lights emissive on every class". A '70 coupe on a showroom floor does
     * not have its headlamps on and menu.js is right to take them to 6 % — but its park lamps are
     * a separate circuit and they are exactly what is lit in a period showroom photograph. `drl`
     * is the bucket nothing dims (assemble.js), so these two are emissive in every frame the game
     * renders, and amber against a green car is the only warm light on the front of it.
     */
    drl: [{ x: 0.440, y: 0.410, z: 2.440, w: 0.200, h: 0.082, shape: 'strip', color: '#ffa62e', intensity: 2.2, glow: 0.26, segs: 2 }],
    // the four round lamps stand PROUD of the blacked-out tail panel (z −2.585) — round 1 buried
    // them inside it and the signature Charger tail read as one plain black slab
    tail: [
      { x: 0.29, y: 0.865, z: -2.615, w: 0.225, h: 0.225, shape: 'round', color: '#ff1e10', intensity: 2.2 },
      { x: 0.575, y: 0.865, z: -2.615, w: 0.225, h: 0.225, shape: 'round', color: '#ff1e10', intensity: 2.2 },
    ],
    reverse: [{ x: 0.16, y: 0.665, z: -2.615, w: 0.17, h: 0.085, color: '#fff2d8', intensity: 1.4, glow: 0.3 }],
  },

  grilles: [
    // The centre screen, between the two lamp pairs and standing on the mouth's own floor. It used
    // to be 1.50 m wide at z 2.405 — 75 mm BEHIND the nose face — which is why it only ever read
    // through the hole the culled cap panel left.
    { w: 0.60, h: 0.185, d: 0.16, y: 0.775, z: 2.446, slats: 5, vertical: true, frame: 'chrome' },
    // A '70 valance carries the radiator intake below the bumper; this is the screen for it, laid
    // on the valance aperture's floor.
    // narrowed to 0.62 so the two amber park lamps stand either side of it on the same floor
    { w: 0.62, h: 0.086, d: 0.10, y: 0.410, z: 2.448, slats: 2, mesh: true, frame: 'dark' },
  ],
  // marque badge in the middle of the grille — chrome bezel, black enamel field, swept wings
  // z 2.494 -> 2.462: at 2.494 the badge's front face stood 24 mm PROUD of the nose panel it is
  // supposed to be let into, i.e. it was the one thing on the clip still floating in front of it.
  badges: [{ x: 0, y: 0.775, z: 2.462, w: 0.098, h: 0.076, d: 0.020 }],
  vents: [
    { x: 0.48, y: 1.005, z: 1.02, w: 0.30, h: 0.16, fins: 3, angle: 0.55, rx: -1.5708 },  // bonnet extractors
    { x: 0.86, y: 0.74, z: 1.02, w: 0.26, h: 0.18, fins: 3, angle: 0.4, ry: 1.5708 },     // fender gill
  ],
  // chrome bullet mirror, at 84% of the kit's default pod — see the note in assemble.js
  mirrors: { x: 0.86, y: 1.06, z: 0.60, mat: 'chrome', scale: 0.84 },
  handles: [{ x: 0.955, y: 0.94, z: -0.20 }],

  trim: [
    /**
     * THE BUMPER, and the sentence it was written against: "the cream grille bar ends in a flat face
     * with a visible dark separation line where it should blend into the green fender".
     *
     * The centre bar is 1.34 m on a 1.85 m face, so it never reaches the fender at all; the two
     * swept ends carry it out from there and their tips land AT the flank (x 0.933 against a body
     * half-width of ~0.935 at z 2.30), rounded to a 50 mm radius, so the bumper runs into the wing
     * rather than stopping in front of it. Its back face is 120 mm inside the bodywork, so there is
     * no gap under it and nothing to see behind it.
     */
    { w: 1.80, h: 0.135, d: 0.22, y: 0.565, z: 2.492, mat: 'chrome', r: 0.052, sweep: 0.16, sweepPow: 2.8, taper: 0.50 },
    // BUMPER OVERRIDERS. Two vertical chrome guards standing ON the bar — the period detail that
    // breaks a straight bumper into three lit shapes and throws a hard shadow either side of
    // itself. Their back faces are 100 mm inside the bar, so there is no joint to open up.
    { x: 0.315, w: 0.078, h: 0.220, d: 0.140, y: 0.565, z: 2.560, mat: 'chrome', mirror: true, r: 0.026 },
    { w: 1.20, h: 0.135, d: 0.22, y: 0.66, z: -2.585, mat: 'chrome', r: 0.055 },
    { x: 0.635, w: 0.42, h: 0.135, d: 0.20, y: 0.66, z: -2.505, mat: 'chrome', ry: -0.42, mirror: true, r: 0.05 },
    { w: 1.44, h: 0.30, d: 0.05, y: 0.865, z: -2.578, mat: 'dark', r: 0.03 },   // tail panel blackout
    // Ribbed chrome slats across the blackout panel. A '70 tail panel is a RIBBED surface between
    // the lamps; ours was one flat dark rectangle 1.44 m wide sitting dead centre of every chase
    // frame, which is a large share of why the back of the car read as a black cutout. Chrome is
    // already on this car, so the ribs merge into an existing bucket and cost nothing.
    // 22 mm tall was a SUB-PIXEL MIRROR at chase distance — the same failure the sill blade below
    // already carries a note about. A metalness-1 highlight narrower than two samples renders as a
    // dashed row of white specks, and at 5x on la-muscle-chase all four ribs came back as dotted
    // lines across the tail panel, which reads as aliasing (§7, cap 68). 32 mm covers 3-4 px.
    { w: 1.40, h: 0.032, d: 0.065, y: 0.985, z: -2.588, mat: 'chrome', r: 0.010 },
    { w: 1.40, h: 0.032, d: 0.065, y: 0.921, z: -2.588, mat: 'chrome', r: 0.010 },
    { w: 1.40, h: 0.032, d: 0.065, y: 0.809, z: -2.588, mat: 'chrome', r: 0.010 },
    { w: 1.40, h: 0.032, d: 0.065, y: 0.745, z: -2.588, mat: 'chrome', r: 0.010 },
    // number plate in the gap between the inner lamps — the tail panel's centre was a black hole
    { w: 0.40, h: 0.155, d: 0.035, y: 0.865, z: -2.605, mat: 'chrome', r: 0.012 },
    { w: 0.46, h: 0.205, d: 0.03, y: 0.865, z: -2.598, mat: 'dark', r: 0.014 },
    { w: 1.48, h: 0.060, d: 0.06, y: 1.024, z: -2.576, mat: 'chrome', r: 0.018 }, // tail panel top edge
    { x: 0.862, w: 0.062, h: 0.125, d: 2.30, y: 0.470, z: -0.10, mat: 'dark', mirror: true, r: 0.025 },  // rocker
    // chrome sill blade under the rocker: the bright bottom edge every 70s coupe wears, and the
    // line that stops the lower flank fading into the contact shadow
    // 0.028 x 0.022 was a sub-pixel mirror at hero distance: a metalness-1 highlight that fits
    // between two samples renders as a dashed row of white specks along the sill, which is what
    // the 8x crop shows. 0.042 x 0.036 covers 3-4 px and the line is continuous.
    { x: 0.882, w: 0.042, h: 0.036, d: 2.20, y: 0.398, z: -0.10, mat: 'chrome', mirror: true, r: 0.012 },
    { x: 0.950, w: 0.045, h: 0.035, d: 2.10, y: 0.665, z: -0.10, mat: 'chrome', mirror: true, r: 0.014 }, // side spear
    // (the front valance slab is gone — the bodywork reaches the road here now and the intake is
    //  cut into it; what is left is the chin spoiler along the very bottom edge of the panel)
    { w: 1.44, h: 0.050, d: 0.15, y: 0.312, z: 2.462, mat: 'dark', rx: 0.10, r: 0.020, sweep: 0.10, sweepPow: 2.6, taper: 0.55 },
    // Rear valance: deliberately 1.16 m across a 2.19 m car and lifted clear of the road, so the
    // rear tyres stand outboard of it and the road shows underneath (§6.1 round-2 gap).
    { w: 1.16, h: 0.17, d: 0.26, y: 0.415, z: -2.505, mat: 'dark', rx: -0.12, r: 0.045 },
    { w: 1.24, h: 0.045, d: 0.22, y: 0.336, z: -2.500, mat: 'chrome', r: 0.016 },
  ],
  wing: { type: 'ducktail', w: 1.50, chord: 0.30, y: 1.015, z: -2.26, mat: 'paint', aoa: -0.34 },
  exhaust: [{ x: 0.50, y: 0.435, z: -2.585, r: 0.070, len: 0.26 }],
  extras: [
    { type: 'blower', y: 1.19, z: 1.58 },
    /**
     * Period rear-window slat kit — but only across the LOWER third of the backlight now.
     *
     * At d 0.50 centred on z -1.60 it covered two thirds of the glass, and since the cabin behind
     * it was black the critic's read of the whole backlight was "a solid black rectangle with only
     * dotted defroster lines". The slats are a real Mopar detail and worth keeping; they just have
     * to leave the part of the glass the parcel shelf and head restraints are visible through.
     */
    { type: 'louvre', w: 1.26, d: 0.20, count: 4, y: 1.150, z: -1.80, rx: -0.576 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
