import { assembleCar } from './assemble.js';

/**
 * KATANA GT-R — compact Japanese tuner. Civic Type-R / Focus RS / Lancer Evo DNA: short overhangs,
 * a stubby bonnet, a TALL cab-forward greenhouse, a near-vertical hatch tail, a wide body kit with
 * flared arches and canards, and a huge pedestal GT wing.
 *
 * Silhouette test (§2.3): shortest car in the game, tallest cabin relative to its length, a hard
 * kink where the roof meets the backlight, and a wing standing over a tailgate rather than a boot.
 *
 * ---------------------------------------------------------------------------------------------
 * WAVE-13 REBUILD — THE ARCHETYPE, AND THE FACE.
 *
 * Two findings, both scored off real screenshots, both still open after twelve waves:
 *
 *   1. "The tuner and the supercar share ONE IDENTICAL FRONT CLIP. Same lamp pod, same grille slat
 *      pattern, same chrome under-lip. Head-on they are the same car in two colours." True to the
 *      millimetre: both cars carried a wide low letterbox mouth with a woven 3-slat screen in it, a
 *      shallow HORIZONTAL lamp slot either side of it holding a strip lamp with a strip DRL bar
 *      under it, and a chrome blade across the splitter. Four decisions, four matches.
 *   2. "The tuner is the wrong archetype … a generic wide-body 2-door coupe wearing a tuner kit,
 *      and from directly behind at chase distance it converges with the muscle car." Also true, and
 *      the `_vs_silo` outline test says why: the roof crested at 42 % of the car's length and then
 *      fell in ONE CONTINUOUS CURVE into the tail — 770 mm of backlight at 18 degrees off
 *      horizontal, which is a fastback, which is the muscle car's own profile.
 *
 * ---- WHAT CHANGED, IN ORDER OF HOW MUCH IT MOVES THE SILHOUETTE -----------------------------
 *
 *   A. THE BACKLIGHT IS A HATCH'S, AND THERE IS A KINK ABOVE IT. The roof tapers gently to z -1.44
 *      (1.322 -> 1.288, about 5 degrees) and then falls 248 mm over 280 mm to the belt at z -1.72:
 *      48 degrees from vertical, against the old 71. The 43-degree corner between those two runs is
 *      the single thing that separates a hatch from a fastback in a chase crop, and there is now a
 *      satin roof spoiler standing on it so it cannot be missed.
 *   B. TALLER AND THICKER, ON A SHORTER CAR. Roof peak 1.336 -> 1.390 and length 4.24 -> 3.96, so
 *      height/length goes 0.315 -> 0.351. The four classes read 0.257 (supercar) / 0.281 (muscle) /
 *      0.351 (this) / 0.435 (truck) — monotonic, and no two within 8 %. The belt comes up 55 mm
 *      through the cabin with it: a tall glasshouse on a thin body is a crossover, and the first cut
 *      of this wave was one. Glass depth over body depth is 0.37 now, against 0.51 then.
 *   C. A STEEPER SCREEN. The A-pillar foot stays at the cowl but its head comes back to z 0.58
 *      instead of 0.34, so the windscreen is 49 degrees off vertical rather than 62. A laid-back
 *      screen over a long bonnet is a coupe; an upright one over a short bonnet is a hatch.
 *   D. A SHORTER BONNET AND A BLUNT NOSE. Nose tip 2.16 -> 2.00, so the bonnet is 1.00 m of a
 *      3.96 m car (25 %) against the muscle's 34 %. And it no longer WEDGES: the deck falls 38 mm
 *      from cowl to tip instead of 102, which leaves a 676 mm tall front face — a pedestrian-era
 *      hatch nose, and the exact opposite of the supercar's 400 mm-high knife.
 *   E. WHEELS AT THE CORNERS. Overhangs 0.85/0.77 -> 0.69/0.65 on an unchanged 2.62 m wheelbase.
 *      Nothing in `handling.js` sees a different number.
 *
 * ---- AND THE FACE ---------------------------------------------------------------------------
 *
 * kit.js can now warp an aperture before it cuts it (`taper`, a trapezoid; `shear`, a lean), which
 * is what makes a different face possible at all — until this wave the only front-clip vocabulary
 * any car had was where the rounded rectangles go. Head-on, the two cars now share nothing:
 *
 *                       supercar                        this car
 *   mouth               one wide LETTERBOX, low         one tall SHIELD, a trapezoid 26 % wider at
 *                       (1.66 x 0.165, flat sided)      its base than its top (0.94 x 0.355)
 *   screen              3 horizontal slats, woven       7 VERTICAL bars, woven
 *   upper aperture      none                            a narrow badge slot between the lamps
 *   lamp opening        a shallow horizontal SLOT       a tall angular WEDGE, leaning 0.52 x per y,
 *                       (0.44 x 0.185)                  tapering to a point low-inboard (0.245 x 0.285)
 *   lamp lens           one wide strip + a strip DRL    one TALL lens, three stacked chambers, two
 *                       under it, both horizontal       vertically stacked projector barrels
 *   DRL                 a horizontal bar under the lamp a vertical blade outboard of it
 *   under-lip           a chrome blade                  a body-colour lip
 *
 * Handling: nimble, high grip, quick to rotate and quick to catch. Nitrous = short sharp bursts.
 */
export const spec = {
  id: 'tuner',
  name: 'KATANA',
  full: 'KATANA GT-R SPEC-V',
  klass: 'TUNER',
  colors: ['#18b6e8', '#e8342b', '#f5f2ea', '#7d2ce0', '#1b1d22', '#d8f218'],
  stats: { speed: 0.72, accel: 0.84, traction: 0.88, weight: 0.42 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

const V = (z) => (z + 1.96) / 3.96;

export const blueprint = {
  id: 'tuner', spec, colors: spec.colors,
  // track is set so the outer sidewall sits ~5 mm inboard of the real flank at the arch station
  // (the tub reaches 0.958 / 0.969 half-width at z = ±1.31) — a tucked-in tyre caps §6.1 at 60.
  // staggered: 1.66 front / 1.744 rear, so the rear tyres stand ~9 cm outboard of the hatch tail and
  // break the silhouette from behind (§6.1 round-2: no wheel was readable in any harness frame)
  // WAVE-13: length 4.24 -> 3.96 and height 1.36 -> 1.46. `dims` feeds the collision hull and the
  // camera, not the physics model — only `wheelbase` reaches VehicleBody, and it has not moved.
  dims: { length: 3.96, width: 2.10, height: 1.42, wheelbase: 2.62, track: 1.660, trackRear: 1.744, rideHeight: 0.115 },
  // envIntensity 0.70 (0.88 after the lighting piece's 1.25x) on a 0.15-metalness body put almost
  // no city into the paint, so the car sat in the frame as a flat coloured shape and went to a grey
  // silhouette in NYC. §1.6.3 wants "a sky reflection above and a dark ground reflection below" —
  // that is the env probe, and it needs metalness to carry it and a tight clearcoat over it.
  paint: { metalness: 0.26, roughness: 0.45, clearcoat: 0.92, clearcoatRoughness: 0.42, flake: 0.50, envIntensity: 0.90 },
  livery: {
    style: 'rally', stripe: '#f4f6f8', accent: '#15171c',
    panels: {
      doors: [V(0.96), V(-0.84)],
      hood: [V(1.02), V(1.86)],
      // the "boot" shut line is the TAILGATE's, and it runs from the tail panel up to the base
      // of the hatch glass rather than across a boot lid
      boot: [V(-1.90), V(-1.74)],
      arches: [V(1.31), V(-1.31)],
      fuelCap: [0.31, V(-1.52)],
    },
    // A time-attack car is the one class that really is covered in decals: a small door number in
    // a roundel and three sponsor marks down the sill. See kit.js `drawBodyPaint` §1b.
    marks: {
      number: '21', numberU: 0.250, numberV: 0.495, numberR: 0.028,
      disc: '#f4f6f8', discEdge: '#15171c', numberColor: '#15171c', numberItalic: 0.20,
      sponsors: [
        { text: 'NITRO CIRCUIT', u: 0.206, v: 0.360, size: 0.0135, color: '#f4f6f8' },
        { text: 'TURBO 4G63', u: 0.206, v: 0.628, size: 0.0125, color: '#f4f6f8' },
      ],
    },
  },
  // see muscle.js — 0.72 opacity made the cabin a §7 black void; 0.56 keeps the tint and the env
  // reflection but lets the roll cage, the door cards and the shelf read through the hatch glass
  glass: { tint: '#070c12', opacity: 0.56 },

  /**
   * THE TUB. Read the yDeck column: it is high (bonnet) from z 1.00 forward, drops into the cabin
   * recess for 2.66 m — the whole middle of the car — and comes back up for only 240 mm at the very
   * back. That is a two-box car. The muscle's equivalent column has 1.4 m of deck behind the recess.
   *
   * And read the yBelt column, which is the other half of the archetype. It RISES 72 mm from the
   * cowl (0.962) to the tail (1.034, and 1.018 at the very last station where the panel rolls
   * under): a rising belt under a falling roof is the wedge every hot hatch has, and it is what
   * makes the tail panel TALL — 640 mm of near-vertical bodywork from the bumper to the glass,
   * where the muscle car has a boot lid at 0.86.
   */
  /**
   * ---- THE FLANK, CROWNED (wave-11) -------------------------------------------------------
   *
   * See `flankField` in assemble.js. A compact hatch has a shallower, higher-set swage than a
   * muscle car: it starts just above the front wheel centre, rises gently through the single long
   * door, and drops away over the rear arch where the wide-body flare takes over. The shoulder
   * break is what gives a small car its "thick" look — a narrow tumblehome band and a hard roll
   * into the belt, so the sky lands in a tight strip along the top of the door instead of washing
   * the whole panel.
   */
  flank: {
    crease: [
      [-1.96, 0.625], [-1.76, 0.600], [-1.50, 0.545], [-1.31, 0.500], [-1.05, 0.585],
      [-0.90, 0.700], [-0.20, 0.665], [0.50, 0.600], [0.94, 0.545], [1.31, 0.485],
      [1.58, 0.535], [2.00, 0.600],
    ],
    shoulder: [
      [-1.96, 0.09], [-1.50, 0.15], [-0.95, 0.26], [-0.20, 0.28],
      [0.60, 0.25], [1.31, 0.15], [2.00, 0.09],
    ],
    swell: [
      [-1.96, 0], [-1.50, 0.007], [-1.05, 0.010], [-0.20, 0.012],
      [0.50, 0.011], [1.16, 0.006], [1.80, 0.001], [2.00, 0],
    ],
    bow: [
      [-1.96, 0], [-1.72, 0.005], [-1.20, 0.010], [-0.20, 0.012],
      [0.94, 0.009], [1.58, 0.004], [2.00, 0],
    ],
  },

  body: [
    // tail panel: TALL and near-vertical (yBelt 0.985 against the nose's 0.900) — a tailgate, not a
    // boot lid, and the single most legible difference from the muscle car in a chase crop
    { z: -1.96, w: 0.770, y0: 0.375, floor: 0.55, rocker: 0.95, ySill: 0.545, yBelt: 1.018, belt: 0.96, yDeck: 1.013, deck: 0.92, crown: 0.005 },
    { z: -1.90, w: 0.852, y0: 0.325, floor: 0.58, rocker: 0.94, ySill: 0.49, yBelt: 1.028, belt: 0.95, yDeck: 1.023, deck: 0.90, crown: 0.008 },
    { z: -1.82, w: 0.886, y0: 0.290, rocker: 0.92, ySill: 0.445, yBelt: 1.034, belt: 0.945, yDeck: 1.030, deck: 0.88, crown: 0.010, flare: 1.02 },
    // the base of the hatch glass. Deck and belt meet here: the glass starts where the panel ends.
    { z: -1.72, w: 0.896, y0: 0.275, rocker: 0.912, ySill: 0.432, yBelt: 1.034, belt: 0.942, yDeck: 1.032, deck: 0.87, crown: 0.010, flare: 1.03 },
    { z: -1.66, w: 0.901, y0: 0.268, rocker: 0.905, ySill: 0.425, yBelt: 1.033, belt: 0.940, yDeck: 0.812, deck: 0.86, crown: 0.008, flare: 1.036 },
    { z: -1.48, w: 0.906, y0: 0.252, rocker: 0.898, ySill: 0.415, yBelt: 1.028, belt: 0.939, yDeck: 0.798, deck: 0.85, crown: 0.008, flare: 1.048 },
    { z: -1.31, w: 0.914, y0: 0.235, rocker: 0.89, ySill: 0.405, yBelt: 1.022, belt: 0.938, yDeck: 0.784, deck: 0.85, crown: 0.008, flare: 1.062 },
    { z: -1.05, w: 0.902, y0: 0.235, rocker: 0.885, ySill: 0.40, yBelt: 1.014, belt: 0.936, yDeck: 0.776, deck: 0.85, crown: 0.008, flare: 1.028 },
    { z: -0.50, w: 0.888, y0: 0.230, rocker: 0.875, ySill: 0.395, yBelt: 0.998, belt: 0.935, yDeck: 0.762, deck: 0.85, crown: 0.008 },
    { z: 0.20, w: 0.888, y0: 0.230, rocker: 0.875, ySill: 0.395, yBelt: 0.980, belt: 0.935, yDeck: 0.754, deck: 0.85, crown: 0.008 },
    { z: 0.94, w: 0.893, y0: 0.235, rocker: 0.878, ySill: 0.40, yBelt: 0.965, belt: 0.936, yDeck: 0.760, deck: 0.85, crown: 0.008 },
    // — cowl. The bonnet behind the windscreen is 1.00 m of a 3.96 m car; the muscle's is 34 %. —
    { z: 1.00, w: 0.894, y0: 0.235, rocker: 0.878, ySill: 0.40, yBelt: 0.962, belt: 0.938, yDeck: 0.944, deck: 0.86, crown: 0.012 },
    { z: 1.16, w: 0.898, y0: 0.237, rocker: 0.882, ySill: 0.405, yBelt: 0.955, belt: 0.938, yDeck: 0.940, deck: 0.86, crown: 0.014, flare: 1.026 },
    { z: 1.31, w: 0.905, y0: 0.240, rocker: 0.885, ySill: 0.41, yBelt: 0.948, belt: 0.938, yDeck: 0.934, deck: 0.86, crown: 0.014, flare: 1.058 },
    /**
     * THE NOSE, BLUNT — and this is a reversal of round 1, deliberately.
     *
     * Round 1 found "a long-nose, long-overhang 80s coupe" and answered it by WEDGING the bonnet:
     * the deck fell 102 mm over the last 1.16 m so the nose came to a point. That worked on the
     * length problem and made the class problem worse, because a low pointed nose is what the
     * SUPERCAR is (its nose panel is centred at y 0.400 and 400 mm tall). A modern hot hatch has
     * the opposite front end — a short, TALL, near-vertical face, because that is what pedestrian
     * regulation and a transverse four in a 3.96 m car produce.
     *
     * The overhang problem is solved by moving the tip instead: 2.16 -> 2.00, i.e. 690 mm of front
     * overhang on a 2.62 m wheelbase. The deck now falls 38 mm from cowl to tip, which leaves a
     * 676 mm tall x 1.78 m wide front panel — the canvas the new face needs, and 276 mm taller
     * than the one the supercar cuts its letterbox into.
     */
    { z: 1.52, w: 0.900, y0: 0.250, rocker: 0.89, ySill: 0.42, yBelt: 0.940, belt: 0.94, yDeck: 0.922, deck: 0.86, crown: 0.014, flare: 1.032 },
    /**
     * ---- THE FRONT CLIP, LOFTED (round-1, this piece) --------------------------------------
     *
     * These three stations ARE the bumper. Verbatim finding: "a matte black bumper beam floats
     * clear of the cyan bodywork with a dark gap under it, a flat gray splitter plate terminates
     * in raw uncapped cut faces, black brackets visibly interpenetrate the fender".
     *
     * All of that came from one number: the old nose necked in to w 0.740 and RAN UP to y0 0.365,
     * so the tub's front face was a small rounded snout 390 mm tall floating 140 mm above the
     * road, and everything a front end actually is — the beam, the valance, the splitter, the lamp
     * pads — was a `roundedBox` parked around it. A box in front of a closed surface either floats
     * or interpenetrates; there is no third option.
     *
     * The clip runs nearly parallel-sided from z 1.76 to the leading edge (w 0.896 -> 0.892) and
     * the floor drops to y0 0.218 with `floor` opened to 0.90, so the last cross-section is a
     * BUMPER SECTION: full width, full height, ground to bonnet, with a broad flat undertray. The
     * mouth, the badge slot and the lamp wedges are cut INTO that face by `nose.apertures` below,
     * which is the same operation `loftTub` already performs for the wheel openings.
     *
     * ONE RULE ON THE LAST STATION: yDeck must MEET yBelt there (0.894 against 0.900). The cap grid
     * is a fan of rays out of one centre, so if the boundary ring turns back on itself — which is
     * what a 100 mm bonnet-to-fender step at the very tip does — consecutive rays cross and the
     * panel folds through itself. The bonnet/fender step is still authored, it just develops over
     * the two stations BEHIND the tip (0.932/0.902 -> 0.922/0.892 -> 0.900/0.894).
     */
    { z: 1.76, w: 0.896, y0: 0.242, rocker: 0.905, ySill: 0.400, yBelt: 0.926, belt: 0.945, yDeck: 0.896, deck: 0.87, crown: 0.012 },
    { z: 1.90, w: 0.898, y0: 0.228, floor: 0.78, rocker: 0.930, ySill: 0.375, yBelt: 0.910, belt: 0.955, yDeck: 0.880, deck: 0.86, crown: 0.010 },
    { z: 2.00, w: 0.892, y0: 0.218, floor: 0.90, rocker: 0.958, ySill: 0.358, yBelt: 0.880, belt: 0.968, yDeck: 0.874, deck: 0.86, crown: 0.008 },
  ],

  /**
   * ---- THE GREENHOUSE, AND THE KINK -------------------------------------------------------
   *
   * ROUND-5 found the roof was a PLATEAU and a plateau is a wagon: 1.44 m dead level at 1.374-1.380
   * on a 4.24 m car. Its answer was to CREST the roof at z 0.05 and let it fall continuously into
   * the tail — which fixed the wagon and built a fastback, because a roof and a backlight that are
   * one smooth curve is the definition of one. That is the profile wave-13 was sent to fix.
   *
   * A hatch is three straight runs and two corners:
   *
   *     windscreen   z 1.00 -> 0.58    0.976 -> 1.348     49 deg off vertical
   *     roof         z 0.42 -> -1.44   1.390 -> 1.288      3 deg off horizontal, gently falling
   *     backlight    z -1.44 -> -1.72  1.288 -> 1.040     48 deg off vertical
   *
   * The 43-degree corner at z -1.44 is the whole read. It is not left to the eye either: the roof
   * spoiler in `trim` stands on it, and the high-mount stop lamp sits under its lip.
   *
   * The roof itself is NOT level — 102 mm of fall over 1.86 m — because that is the difference
   * between a hatch and an estate, and the estate is the failure mode round 5 was looking at.
   *
   * The belt is shared with the tub's own `yBelt` column and is checked against it station by
   * station; a cabin that does not sit on the belt opens a seam along the whole flank.
   */
  cabin: {
    stations: [
      { z: 1.00, hw: 0.800, rw: 0.766, yBelt: 0.962, yRoof: 0.976 },
      { z: 0.92, hw: 0.806, rw: 0.748, yBelt: 0.964, yRoof: 1.072 },
      { z: 0.74, hw: 0.816, rw: 0.702, yBelt: 0.969, yRoof: 1.246 },
      { z: 0.58, hw: 0.822, rw: 0.676, yBelt: 0.973, yRoof: 1.348 },
      { z: 0.42, hw: 0.826, rw: 0.668, yBelt: 0.977, yRoof: 1.390 },
      { z: -0.40, hw: 0.828, rw: 0.664, yBelt: 0.996, yRoof: 1.374 },
      { z: -1.06, hw: 0.824, rw: 0.668, yBelt: 1.014, yRoof: 1.322 },
      { z: -1.44, hw: 0.816, rw: 0.686, yBelt: 1.026, yRoof: 1.288 },
      { z: -1.60, hw: 0.808, rw: 0.740, yBelt: 1.031, yRoof: 1.152 },
      { z: -1.72, hw: 0.798, rw: 0.792, yBelt: 1.034, yRoof: 1.040 },
    ],
    roof: { z0: -1.42, z1: 0.52, a: 5, offset: 0.014 },
    wipers: { z: 0.920, w: 0.44, x: 0.26, sweep: 0.22 },
    pillars: [
      // roof-edge rail in satin black — see the note in muscle.js. On a JDM hatch it is the
      // moulded gutter, not a bright strip, so it takes the dark trim the pillars already use.
      { z0: -1.46, z1: 0.58, a: 5, b: 6, mat: 'dark', steps: 9, offset: 0.018 },
      { z0: 0.58, z1: 1.00, a: 2, b: 5, mat: 'dark', steps: 5 },      // A
      /**
       * ROUND-5: the B-pillar is gone, and that is what makes this a THREE-DOOR.
       *
       * With A, B, C and D there were FOUR panes of glass down each side, and four panes on a
       * 4 m car is a five-door family hatch — half of why the outline test read "estate". A hot
       * hatch (Type R, Focus RS, Integra) has one long door glass and a small quarter light,
       * i.e. three panes: the B is deleted so the door glass runs 1.30 m from z 0.50 to -0.80,
       * the C stays as the divider ahead of the quarter light, and the D wraps the tailgate.
       * One fewer pillar is also one fewer bucket of geometry.
       */
      { z0: -0.80, z1: -0.96, a: 2, b: 5, mat: 'dark', steps: 2 },    // C
      { z0: -1.48, z1: -1.72, a: 2, b: 5, mat: 'paint', steps: 5 },   // D
    ],
    beltZ0: -1.46, beltZ1: 0.54, beltMat: 'dark',
    // stripped-out JDM cabin: grey buckets, black cage, the car's own cyan on the harnesses and
    // door pulls. Authored light enough to survive being read through 56%-opaque hatch glass.
    // shelfZ/shelfD are a BOOT FLOOR running back to z -1.60 — with the glass dropping onto the
    // tailgate there is a metre of cabin behind the seats in every chase frame's sightline, and an
    // unfilled one would show the inside of the tub through the hatch.
    interior: { seat: 0x4e535e, trim: 0x35393f, accent: 0x18b6e8, floorY: 0.762, headY: 1.208, dashY: 0.972, wheelY: 1.018, shelfY: 1.010, seatZ: -0.20, dashZ: 0.88, dashW: 1.34, seatX: 0.33, shelfZ: 1.10, shelfD: 0.60, rollBar: true, rhd: true, clusterColor: '#ff4d3d' },
  },

  /**
   * ---- THE NOSE PANEL ---------------------------------------------------------------------
   *
   * `loftTub`'s cap grid (kit.js §7) crowns the front face into a real pressing and cuts these
   * openings INTO it: each one is a signed-distance field pushed `depth` inboard over a `rim`-wide
   * fillet, so the metal turns in behind its own edge exactly the way it does behind an arch lip —
   * same surface, same vertices, same `aWell` overhang shading (kit.js archReturn). There is no
   * rim, no bezel and no bracket to bolt on, so there is nothing that can float and nothing that
   * can interpenetrate.
   *
   * `crown` is the bumper's forward bulge and `rake` leans the top of it back. This car's rake is
   * almost nothing (-0.03 against the supercar's -0.06 and the old -0.10) because a hot hatch's
   * front face STANDS UP; the wedge belongs to the other class.
   *
   * `cy` 0.560 is where the fan centre wants to be on a face that now runs from y 0.218 to 0.894 —
   * and it is solved from there anyway (kit.js `solveCentre`), because the fan's origin may not
   * lie inside an opening.
   */
  nose: {
    // `rings` is the radial resolution of the panel grid. The crown is a paraboloid in t, so at the
    // kit default of 5 the dome is four flat facets and the whole clip photographs as a fan of long
    // triangles; 13 is where the highlight sweeps instead of stepping.
    crown: 0.042, rake: -0.03, rings: 13, cy: 0.560,
    /**
     * ROUND-2 SIZING RULE, and it still governs every number here.
     *
     * An aperture's FLAT FLOOR is `(w - 2*rim - 14 mm) x (h - 2*rim - 14 mm)`; outside that the
     * surface is climbing the fillet back out to the panel, and assemble.js `seat()` guarantees
     * nothing ever lies on that ramp — by SHRINKING, which is how round 1 ended up with a 0.72 m
     * screen floating in a 1.16 m mouth. Everything below is authored to fit at full size.
     *
     * WAVE-13: `taper` and `shear` (kit.js `apSD`). Both are coordinate warps applied before the
     * rounded-rect field is evaluated, so the recess, the moulded brow, the ray-band solver and
     * the fit measurement all see the warped shape; `ehw` carries its real x extent.
     */
    apertures: [
      /**
       * THE SHIELD. A TRAPEZOID — 26 % wider at its base than at its top — standing 355 mm tall in
       * the middle of the bumper, where the supercar has a 165 mm letterbox lying across the whole
       * width of its nose. This is the single biggest shape on the front of the car and it is the
       * one a thumbnail reads first.
       */
      { y: 0.442, w: 0.96, h: 0.330, r: 0.058, taper: -0.32, depth: 0.098, rim: 0.030, shade: 1, lip: 0.015, lipW: 0.056 },
      // THE BADGE SLOT — a narrow opening at bonnet-shut height between the two lamps, which is
      // where a hatch carries its marque. Slightly wider at the top so it agrees with the lamps
      // leaning away from it.
      { y: 0.766, w: 0.56, h: 0.098, r: 0.030, taper: 0.16, depth: 0.052, rim: 0.020, shade: 1 },
      /**
       * THE LAMP WEDGE, and this is the aperture the whole finding turns on.
       *
       * `shear: 0.40` leans it — the opening's centre moves 40 mm outboard for every 100 mm up —
       * and `taper: 0.24` makes it 24 % wider at the top than at its middle and 24 % narrower at
       * the bottom, so the shape is a WEDGE that comes to a point low and inboard, pointing down
       * into the shield. `mirror` flips the lean as well as the position (kit.js), or both eyes
       * would look the same way.
       *
       * IT IS SIZED BY WHAT STANDS IN IT, not by its own outline. The first cut of this wave was
       * 245 x 285 — a genuinely tall hole — and it photographed as "a small pale pill floating in a
       * black cavity", which is the round-1 verdict word for word. The reason is `seat()`: it takes
       * the NARROWEST row of the flat floor across the part's whole y band, and on a 30 %-tapered
       * 245 mm opening that row is 124 mm, so a 135 mm lens came out at 124 and the DRL had nowhere
       * to go at all. At 340 x 280 with a 24 % taper the narrowest row is 198 mm, which carries a
       * 120 mm tall lens AND a 32 mm DRL blade beside it with 26 mm of black between them. The
       * opening is the shape; the two tall elements standing in it are the signature.
       */
      { x: 0.625, y: 0.690, w: 0.320, h: 0.270, r: 0.042, taper: 0.24, shear: 0.36, depth: 0.058, rim: 0.026, shade: 1, lip: 0.013, lipW: 0.046, mirror: true },
    ],
  },

  wheels: {
    // bronze 10-spoke mesh on low-profile street rubber — the JDM tuner signature
    style: 'mesh', rimColor: '#b47a2c', caliperColor: '#e0b21c', lipColor: '#bcc2cc', tire: 'street',
    capColor: '#18b6e8',
    /**
     * ROUND-7 (chassis footprint). Verdict: "all four share ONE chassis footprint — identical
     * wheelbase, identical wheel diameter and identical beltline height across a lifted 4x4 and a
     * supercar." The wheelbase and the beltline were already apart; the WHEELS were not far enough.
     *
     * The four fronts measure 664 / 704 / 730 / 1040 mm of rolling diameter (tuner, supercar,
     * muscle, truck) and the rears 684 / 824 / 810 / 1040, so no two classes share a wheel and the
     * truck is 57 % larger than the smallest car in the game — which, since wave 13, is 3.96 m long.
     */
    front: { radius: 0.322, width: 0.275, spokes: 5, tireProfile: 0.248 },
    rear: { radius: 0.334, width: 0.315, spokes: 5, tireProfile: 0.242 },
  },
  // Bolt-on over-fenders: satin black, riveted all round. `blackArches` no longer bolts a ring onto
  // the wing — it tells loftTub to hand the flare band of the SHELL to the plastic material, so the
  // over-fender is literally made of the same vertices as the door skin it grows out of and there
  // is no gap to see through. The arc of fasteners is what still reads as "widebody kit".
  archGap: 1.105, archFlare: 0.150, archLip: 0.022, archProud: 0.014, archInset: 0.050,
  archDepth: 0.12, archSpan: 1.06, blackArches: true, archBolts: 9, archBlackBand: 0.58,

  lights: {
    /**
     * ---- THE TALL LAMP, WAVE-13 -------------------------------------------------------------
     *
     * The old unit was a 428 x 66 mm horizontal strip with a 340 x 34 mm horizontal DRL bar under
     * it — element for element the supercar's, which is most of why the two clips photographed the
     * same. This one is 135 x 215: TALLER than it is wide, so `lightUnit` runs its divider ribs
     * HORIZONTALLY (three stacked chambers) and, since wave-13, stacks its projector barrels
     * VERTICALLY too. Two lit chambers over a barrel each, standing up inside a leaning wedge.
     *
     * It sits on the lamp wedge's own floor, so its housing is entirely behind the panel — the
     * round-1 "black shard poking through" was that housing mounted on the FLANK, where the
     * bodywork is turning away hard.
     */
    head: [{ x: 0.626, y: 0.690, z: 1.964, w: 0.118, h: 0.185, shape: 'rect', color: '#dfe9ff', intensity: 3.2, segs: 3 }],
    /**
     * THE DRL BLADE — the one lit element on the front of this car in the garage, and now a
     * VERTICAL one.
     *
     * `drl` is a bucket nothing dims (assemble.js): the head units are correctly taken to 6 % on a
     * showroom turntable, and a modern hatch's answer to that is a running lamp that is on whenever
     * the car is. It is the tuner's own cyan, four segments so the bloom does not fuse it into one
     * lozenge, and it stands on its END alongside the main lens, down at the narrow inboard point
     * of the wedge — where the supercar's sits horizontally UNDER its strip.
     */
    drl: [{ x: 0.532, y: 0.690, z: 1.964, w: 0.040, h: 0.180, shape: 'strip', color: '#54e4ff', intensity: 2.7, glow: 0.30, segs: 4 }],
    /**
     * TALL CORNER CLUSTERS, standing up the outer edges of the tailgate — the lamp shape that goes
     * with a hatch, and nothing like the muscle's four round lenses or the supercar's two rings.
     * `segs` splits each into three lit elements, or at this size the bloom fuses the lens into one
     * orange lozenge and the shape of the lamp is lost.
     */
    /**
     * ---- WHERE A TAIL LAMP HAS TO STAND, MEASURED ---------------------------------------------
     *
     * WAVE-13. `seat()` solves the FRONT clip's inserts against the loft's own measurement; the tail
     * cap has no such service, so these three z values are hand-set against `tools/_t13_tailz.mjs`,
     * which reports the rear-most surface of the tub by (x, y). It measures -1.960 flat across the
     * middle of this panel, curving forward to -1.930 at the outer edge.
     *
     * `lightUnit` puts its lens 6 mm BEHIND its own origin, and a tail lamp is yawed by pi, so the
     * lens ends up at `z + 0.006` — i.e. INSIDE the car relative to the origin. The first cut of
     * this tail put the x 0.34 strip lamp at -1.945, so its lens landed 2 mm proud of a panel at
     * -1.960 and the pair photographed as two dark rectangles with bright rims: a bezel standing
     * out of the bodywork with its lens z-fighting the panel behind it. Everything back here now
     * clears the measured surface by at least 12 mm.
     */
    tail: [
      { x: 0.665, y: 0.845, z: -1.957, w: 0.235, h: 0.270, color: '#ff2a18', intensity: 1.75, segs: 3 },
      /**
       * THE BAR BETWEEN THEM. A modern hatch ties its two corner clusters together across the
       * tailgate, which is a signature no other car in this game has — the muscle's tail is four
       * round lenses, the supercar's is two rings, the truck's is a pair of vertical stacks. It
       * also gets the lamp OUT of the extractor grille's footprint: the strip pair it replaces sat
       * at x 0.34 / y 0.796, inside the 0.90 x 0.115 m vent, so two dark meshes and two lamps were
       * stacked in the same 60 mm of z.
       */
      { x: 0, y: 0.918, z: -1.965, w: 1.02, h: 0.040, shape: 'strip', color: '#ff2a18', intensity: 1.8, glow: 0.3, segs: 5, mirror: false },
      // the high-mount stop lamp, under the lip of the roof spoiler at the top of the hatch glass —
      // which is where a hatchback's third lamp lives and where a fastback's cannot be
      { x: 0, y: 1.264, z: -1.478, w: 0.42, h: 0.042, shape: 'strip', color: '#ff2a18', intensity: 1.9, segs: 3, mirror: false, bezel: false },
    ],
    reverse: [{ x: 0.62, y: 0.664, z: -1.968, w: 0.155, h: 0.052, color: '#fff2d8', intensity: 1.4, glow: 0.25 }],
  },

  grilles: [
    // Each of these is a WOVEN SCREEN DROPPED INTO A HOLE that the bodywork already has (see
    // `nose.apertures`) — the aperture carries the surround, the depth and the shadow, and the
    // grille contributes only the mesh, generated from the hole's MEASURED cut row by row, so a
    // trapezoid opening gets a trapezoid weave for free.
    /**
     * `vertical: true` WITHOUT `mesh` on the shield, and the pair matters: `mesh` draws both
     * directions and ignores `vertical` (kit.js `grilleMesh`), which is what the supercar's mouth
     * is and what the first cut of this one was — a woven grid, i.e. the same texture. Twelve
     * VERTICAL bars and no horizontals is a JDM slat grille, and `grilleMesh` gives an unwoven
     * pack the extra value range it needs on its own: 62 % of the bars take the frame's own
     * material and the rest take the darker mesh steel, sitting 22 % further back.
     *
     * `dark`, not `chrome`, and that was measured rather than assumed: A/B'd in the garage hero
     * (`shots/tun_menu/grille_ab.png`), kit.js's `chrome` bar is a light satin steel and under the
     * garage's warm key twelve of them across a 0.96 m shield came back CREAM — the front of the
     * car read as a picket fence, and the grille became the brightest thing on the lower clip,
     * which on this car the lamps are supposed to be.
     */
    // `perRow` (assemble.js `seat`): a woven screen fits any shape of hole on its own, bar by bar,
    // so it is placed rather than shrunk. Without it a rectangle-fit clamps this one to the
    // trapezoid's NARROWEST row — measured 0.658 against a 1.13 m floor.
    { w: 1.28, h: 0.315, d: 0.11, y: 0.442, z: 1.944, slats: 12, vertical: true, frame: 'dark', perRow: true },
    { w: 0.600, h: 0.056, d: 0.07, y: 0.766, z: 1.972, slats: 2, mesh: true, frame: 'dark', perRow: true },
    // tailgate extractor mesh under the lamps, so the tall tail panel has a hole in it
    // ry: PI — see the note on the supercar's rear extractor. A rear-facing aperture built to open
    // along +Z shows a chase camera the closed back of its own cavity box unless it is turned round.
    { w: 0.90, h: 0.115, d: 0.10, y: 0.700, z: -1.982, slats: 3, mesh: true, frame: 'dark', ry: Math.PI },
  ],
  vents: [
    { x: 0.40, y: 0.915, z: 1.60, w: 0.28, h: 0.16, fins: 3, angle: 0.6, rx: -1.5708 },
    { x: 0.898, y: 0.62, z: 1.05, w: 0.24, h: 0.15, fins: 3, angle: 0.4, ry: 1.5708 },
  ],
  mirrors: { x: 0.82, y: 1.012, z: 0.74, painted: false },
  // see muscle.js: the flank measures 0.8466 here, so at x 0.90 the handle's inner face was 36 mm
  // clear of the door skin
  handles: [{ y: 0.925, z: -0.24 }],

  trim: [
    /**
     * THE FRONT LIP — and this is now the ONLY thing bolted to the front of the car.
     *
     * Round 1 had five parts here: a 1.72 m splitter plank, its chrome leading lip, two vertical
     * fences and a 1.62 m black beam above them, and the verdict found every failure mode a
     * bolt-on has. The plank's job now belongs to the tub: `floor` opens to 0.90 at z 2.00, so the
     * undertray IS the splitter and it is the same surface as the wing. What remains is the lip
     * along its leading edge — `sweep` bends it in plan so its tips fall back inside the bumper
     * corners where there is no end face to photograph, and negative `drop` LIFTS those tips into
     * the corner rather than leaving them lying on the road (round-7).
     */
    { w: 1.42, h: 0.052, d: 0.26, y: 0.222, z: 1.960, mat: 'carbon', rx: 0.05, r: 0.024, sweep: 0.12, sweepPow: 2.6, taper: 0.42, drop: -0.035 },  // front lip
    /**
     * ITS BLADE, IN BODY COLOUR — the fourth of the four things the front clips had in common.
     *
     * Verbatim: "same lamp pod, same grille slat pattern, same CHROME UNDER-LIP". Both cars wore a
     * polished blade along the leading edge of the splitter, and head-on that is a bright horizontal
     * line under the nose in both frames. The blade still has to exist — the lower body of a car
     * needs one lit edge or it dissolves into its own contact shadow, which is the round-3 "painted
     * shell over a black silhouette" — but it does not have to be chrome. A colour-matched lip on a
     * carbon splitter is what a Type R actually wears, and cyan against carbon reads as a hard edge
     * without being the supercar's mirror.
     */
    { w: 1.16, h: 0.022, d: 0.038, y: 0.244, z: 2.072, mat: 'paint', r: 0.009, sweep: 0.10, taper: 0.45, drop: -0.030 },
    // the splitter's end return: up off the tip into the bumper corner, its top 90 mm inside the
    // flank (measured 0.833 at z 2.03 / y 0.30, 0.847 at y 0.38 on the pre-wave body)
    { x: 0.700, w: 0.042, h: 0.150, d: 0.19, y: 0.292, z: 1.870, mat: 'carbon', rz: 0.26, mirror: true, r: 0.016 },
    // CANARDS. Kept — they are the widebody signature — but rooted 180 mm inside the flank instead
    // of sitting on top of a plank, and 30 mm thick with a 14 mm radius so the outboard tip is a
    // rolled edge rather than a knife.
    { x: 0.700, w: 0.30, h: 0.030, d: 0.20, y: 0.344, z: 1.825, mat: 'carbon', rz: 0.30, mirror: true, r: 0.014 },
    // SIDE SKIRT. It sat at x 0.912 with the rocker at 0.771 — 91 mm of open air under the doors,
    // the whole length of the car. Pulled in until it overlaps the rocker; the polished blade under
    // it moves with it.
    { x: 0.800, w: 0.10, h: 0.11, d: 1.96, y: 0.360, z: -0.06, mat: 'carbon', mirror: true, r: 0.028 },  // side skirt
    // A polished blade along the BOTTOM edge of the skirt — the car's one bright lower line, and
    // the reason the front lip is allowed to give up its chrome.
    { x: 0.832, w: 0.048, h: 0.040, d: 1.88, y: 0.296, z: -0.06, mat: 'chrome', mirror: true, r: 0.014 },
    /**
     * ---- THE ROOF SPOILER, AND THE KINK IT STANDS ON ------------------------------------------
     *
     * The corner between roof and backlight at z -1.40 is the whole archetype fix, and a corner in
     * a lofted surface is worth about four pixels of shading at chase distance. A hot hatch puts a
     * spoiler on exactly that corner, so this is one: a swept carbon blade that GROWS OUT of the
     * roof's trailing edge and reaches 200 mm back over the glass, with a gurney on its own trailing
     * edge and the high-mount stop lamp under its lip.
     *
     * Two cuts of this went wrong and both are worth writing down. The first sat at z -1.436 /
     * y 1.334 and was INVISIBLE: the roof panel at that station is at 1.312 plus the roof band's
     * 14 mm offset, so a 50 mm bar centred 8 mm above it is half buried for its whole length. The
     * second was 50 mm thick carbon and photographed as a pale grey LOZENGE lying on the glass —
     * a section that deep, swept and tapered at both ends, has no straight edge left to read as a
     * blade, and `carbon` blows out to grey under a specular at this angle. 36 mm of satin black
     * with a gurney on its trailing edge is a spoiler; anything thicker is a fairing.
     *
     * `drop` is POSITIVE here and negative on the splitter, and that is not a typo: a roof is
     * crowned, so the tips have to fall to stay on it, where a splitter's have to rise to get
     * inside the bumper corner.
     */
    { w: 1.38, h: 0.036, d: 0.20, y: 1.294, z: -1.464, mat: 'dark', r: 0.012, sweep: 0.05, sweepPow: 2.0, taper: 0.34, drop: 0.028 },
    { w: 1.24, h: 0.048, d: 0.020, y: 1.328, z: -1.556, mat: 'dark', r: 0.008, sweep: 0.05, taper: 0.38, drop: 0.026 },
    /**
     * ---- THE BUMPER STEP, AND THE PLATE THAT IS BOLTED TO IT --------------------------------
     *
     * The plate recess used to be its own y band under this bar, and at 5x dead astern it was
     * simply GONE: the bar is 140 mm deep and reaches z -2.025, so a 30 mm recess seated at -1.968
     * was inside it. A number plate on a hatch is bolted to the bumper skin, so it is now on this
     * bar's own face — same y, 12 mm proud of it — and the bar is deep enough (120 mm) to carry it.
     */
    { w: 1.50, h: 0.12, d: 0.14, y: 0.575, z: -1.955, mat: 'dark', r: 0.03 },
    { w: 0.44, h: 0.100, d: 0.03, y: 0.575, z: -2.022, mat: 'dark', r: 0.014 },    // plate recess, on the bar
    { w: 0.38, h: 0.075, d: 0.03, y: 0.575, z: -2.032, mat: 'chrome', r: 0.010 },
    // rear valance: a satin bar across the bottom of the bumper, above the diffuser, so the tail
    // has three tonal steps (paint / bar / diffuser) instead of one black mass
    { w: 1.34, h: 0.055, d: 0.10, y: 0.464, z: -1.936, mat: 'chrome', r: 0.018 },
    // the tailgate's own shut line, across the top of the panel under the glass
    { w: 1.44, h: 0.030, d: 0.05, y: 0.992, z: -1.948, mat: 'chrome', r: 0.010 },
  ],
  // The wing stands on the tailgate's top edge rather than on a boot lid, and it is TALL — the
  // blade sits at 1.412 against a roof crest of 1.390, i.e. ABOVE the roofline, on posts standing
  // 380 mm off a tailgate top at 1.031. No other car in the game carries its wing over its roof.
  wing: { type: 'pedestal', w: 1.46, chord: 0.30, x: 0.52, y: 1.412, z: -1.856, h: 0.38, mat: 'carbon', postMat: 'dark', aoa: -0.20 },
  // narrow and lifted: the rear tyres are the widest thing back here, not the bodykit
  diffuser: { w: 1.06, h: 0.22, d: 0.30, y: 0.318, z: -1.875, strakes: 4, rx: 0.30, mat: 'carbon' },
  exhaust: [{ x: 0.0, y: 0.330, z: -1.980, r: 0.098, len: 0.24, mirror: false }],
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
   * goes stale the moment a station moves — which is exactly what wave-13 did to every one of them.
   */
  shadows: [
    { y: 0.925, z: 1.44, w: 0.56, d: 0.52, mirror: false },            // bonnet scoop
    { x: 0.852, y: 0.925, z: -0.24, w: 0.26, d: 0.12, face: 'x' },     // door handle
    { x: 0.52, y: 1.032, z: -1.856, w: 0.20, d: 0.30 },                // wing pedestals
    { x: 0.40, y: 0.913, z: 1.60, w: 0.38, d: 0.24 },                  // bonnet extractors
    // ROUND-8: the side skirt. 2 m of carbon along the bottom of both doors with nothing under it —
    // the same "moulding glued to a shell" read the muscle car's spear had.
    { x: 0.7955, y: 0.437, z: -0.06, w: 1.56, d: 0.10, face: 'x' },    // side skirt
  ],
  /**
   * …and its fasteners. The round-1 verdict paid this car for exactly this vocabulary on the arch
   * flares ("visible bolt heads along the flare"); a bolt-on skirt wears the same hardware and had
   * none of it. Six heads on the skirt's own outer face (x 0.800 + w/2), sized to match the rivets
   * `archBolts` already puts round the arches so the two rows read as one kit.
   */
  fasteners: [{ x: 0.850, y: 0.392, z: -0.06, n: 6, span: 1.64, axis: 'z', r: 0.0145, h: 0.012 }],
  /**
   * ---- MOUNTS (kit.js `mountPad`, wired in assemble.js) -------------------------------------
   *
   * WAVE-9, verbatim: "their mounts are bare unfilleted slabs". A bonded bonnet scoop wears a
   * flange a few millimetres proud of the panel with a rolled edge on it and four fasteners
   * through the corners — that flange is the whole reason a scoop reads as fitted rather than as
   * a lump resting on the paint. `y` comes from the loft, so it cannot drift off the bonnet.
   */
  mounts: [
    { x: 0, z: 1.44, w: 0.46, d: 0.42, h: 0.015, flange: 1.13, bolts: 4, boltR: 0.0105,
      boltH: 0.009, bead: 0.0085, boss: false, mat: 'dark', mirror: false, spread: 1.72 },
  ],
  extras: [{ type: 'scoop', w: 0.44, h: 0.10, d: 0.40, y: 0.940, z: 1.44, painted: true }],
};

export function build(opts) { return assembleCar(blueprint, opts); }
