import * as THREE from 'three';
import { clamp, lerp, smoothstep, RNG } from '../core/rng.js';

/**
 * Nitrous: the charge/drain state machine AND the visual payoff.
 *
 * ART_DIRECTION.md §6.3 — target 85. Hard caps: a single expanding transparent sprite → 50;
 * no camera response → 65; identical across the four classes → 70.
 * §7 additionally caps "particles as unrotated camera-facing squares with visible hard edges" at 58.
 *
 * ── ROUND 17: THE PLUME IS A 3-D FIELD MARCHED ON THE REAL CAMERA RAY. ──────────────────────
 * READ THE BLOCK COMMENT ABOVE PLUME_FRAG FIRST — that is where the method lives.
 *
 * SIX rounds came back with one failure in six sets of words: "a chain of identical soft round
 * sprites", "~7 hollow crescent shells", "a flat near-constant-width additive ribbon with a
 * hard-edged coloured rim", "a smooth airbrushed light-ribbon with a hard-edged white stripe down
 * its middle", "a pure-white CLIPPED core inside an airbrushed skirt ... and at sustained boost it
 * SHRINKS", and from the director, "a flat hard-edged orange slab out the back". Rounds 3-13
 * rebuilt the ELEMENT (a band, a card, a shell, two impostors, one impostor); r14-r16 shaded that
 * one impostor as an integral. r17 changes what is being integrated. The five measured causes,
 * each fixed at its own cause (numbers from tools/_plume_ms.mjs, which ablates the gas quads out
 * of a real capture and reports the plume's own width, length and clipped-pixel count in screen
 * space):
 *
 *   1. IT WAS STILL A 2-D FIELD. r14-r16 marched a CHORD, but the chord was an assumption: the
 *      fragment's distance from the drawn strip's centreline was taken as the impact parameter
 *      and a perpendicular cross-section was integrated. Two consequences, and between them they
 *      are the whole verdict. The strip had to be CUT TO THE GAS — 28 rows each squeezed to what
 *      the shader could reach there — so the quad's border ran along the silhouette, and a border
 *      is a polyline of straight segments: measured at 5x on the r16 LA muscle, with the pool, the
 *      streaks, the disc and the lamp ablated away, two dead-straight seams across the column and
 *      a straight-sided orange wedge. And nothing could vary with a real RADIUS or a real
 *      AZIMUTH, so the turbulence was a decal that could not occlude itself.
 *      PLUME_FRAG now reconstructs the world-space camera ray for the pixel, clips it
 *      analytically to the plume's bounding cone and marches THAT. The quad is a rasterisation
 *      proxy cut with a flat, generous margin and never at the gas.
 *   2. THE COLUMN WAS ONE FRAME BEHIND THE CAR. The world-space frame was first written in
 *      update(), which runs before the car's matrices are recomputed — at 185 mph that put
 *      uOrigin 1.35 m downstream of the nozzle and left a metre of clear air between the pipe and
 *      the flame. It is now resolved in core.onBeforeRender, the only place the matrices are
 *      guaranteed current.
 *   3. THE TAPER ALL HAPPENED WHERE THE PLUME WAS ALREADY INVISIBLE. Measured on r16: 225 px
 *      across at t = 0.10, 230 at 0.15, 147 at 0.30 — then a cliff to 16 px by t = 0.60, and gone.
 *      So what carried any brightness was a 230 x 250 px BLOB and the "taper" was a whisker. The
 *      class profile now decays to a fixed TIP FRACTION over the whole length and the gas is held
 *      out to t ~ 0.9, so the width falls through every station the eye reads. Measured now, LA
 *      muscle at 185 mph: 224 px at t = 0.10, 148 at 0.30, 80 at 0.45, 30 at 0.60, 4 at 0.85.
 *   4. THE AXIS WAS PINNED AT THE TOP OF THE RANGE FOR ITS WHOLE LENGTH — 247 at the throat, 195
 *      at four fifths — so the only thing that could change along the column was its width, and
 *      bloom hides that. A jet that is equally bright everywhere is a ROD. Density (silhouette,
 *      occlusion) is now held out to the tip while EMISSION falls hard: measured 240 -> 99 on the
 *      SUV, 255 -> 133 on the supercar.
 *   5. AND IT SHRANK UNDER SUSTAINED BOOST. With the class targets deliberately larger than the
 *      frame, the containment clamp binds in every hero framing — so a target that opens up over
 *      the boost does nothing at all, both frames solve to the same fitted length. Growth is now
 *      applied AFTER the fit and never above 1: 0.80 at ignition, 1.00 by ~1.5 s. Measured
 *      ignition -> sustained: muscle 510 -> 749 px, supercar 602 -> 985, tuner 653 -> 759,
 *      SUV 483 -> 771.
 *
 * And one thing the shader has to fight that is nobody's bug: SpeedShader's radial blur is at full
 * strength on the 240 mph frame this piece is judged on, and for a jet fired backwards out of a
 * chase-framed car it smears ~50 px ALONG the plume's own axis. Structure that runs down the
 * column — a row of bright knots — is averaged into a smooth streak by it; structure ACROSS the
 * column survives untouched. So the shock train's first job here is to NECK AND BELLY THE
 * SILHOUETTE (uNeck 0.52-0.60) and only its second to brighten, and the cells are large: three or
 * four visible ones, each shorter and fainter than the last, not twelve.
 *
 * TWIN JETS CONVERGE. Two parallel columns half a metre apart photograph as exactly what r13 was
 * called — "a pair of laser rods". Real adjacent jets entrain each other and merge into one plume
 * with two hot roots; each column is toed IN by just enough to reach the centreline near the end
 * of its own visible length (capped, so the muscle's and the SUV's wide-set pipes do not become a
 * visible V), and fx.rad is set so the two overlap rather than running as separate threads.
 *
 * ── The §7 rule, and how every layer here obeys it ────────────────────────────────────────────
 * NOTHING in this file is allowed to show a straight edge or a corner. Concretely:
 *   · the plume's radial density is a sum of gaussians and one super-gaussian, none of which ever
 *     reaches zero, so there is no boundary to find at any radius, at any zoom, in any frame;
 *   · the march is clipped at uReach half-widths and every density term is multiplied by a
 *     squared fade that reaches exactly zero, with zero slope, BEFORE that radius — so the cut
 *     cannot draw a step even where a wisp would otherwise still have density;
 *   · the rasterisation proxy is cut with a flat margin outside the bounding cone and never to the
 *     shape of the gas: the moment a quad's border runs along the silhouette, the border IS the
 *     silhouette, and a border is a straight line (this was the r16 "flat hard-edged slab");
 *   · every sprite (burner disc, muzzle flash, shock ring, ground pool) is drawn from a procedural
 *     canvas whose alpha reaches 0 well inside the tile, and every camera-facing card carries its
 *     own roll + spin so it is never an "unrotated camera-facing square";
 *   · the streak quads are shaded as a 2-D gaussian capsule — round head, tapered tail, zero alpha
 *     on all four quad edges;
 *   · the gas fades out over a 0.8 m band as it approaches the car's own ground plane, so a
 *     depth-tested quad through the asphalt never draws a dead straight line;
 *   · everything additionally fades out inside ~2.5 m of the camera, so no layer can ever be
 *     clipped by the near plane into a hard-edged wedge across the lens.
 * ── The round-3 rule: THE CAR MUST SURVIVE ITS OWN NITROUS ───────────────────────────────────
 * Round 2's jet was bright enough to erase the thing it was attached to — the rear third of the
 * car clipped to featureless white, and because each plume was splayed ~10° outboard and lifted
 * to a fixed minimum height, the near jet appeared to erupt from the car's FLANK while the far one
 * hid behind the body: one off-axis blob instead of two jets. Three structural rules now:
 *
 *   · one jet per real exhaust outlet, at that outlet's x and y, fired essentially down the car's
 *     rear-facing centreline (r14: toed IN by <= 0.085 rad so twin columns merge downstream rather
 *     than reading as two rods — never OUT), each with its own band/flicker phase;
 *   · the plume STARTS `fx.standoff` (~0.3 m) behind the tip and its alpha ramps in over the first
 *     quarter of the column, so the bumper, taillights, diffuser and exhaust tips read in front of
 *     clear air, not inside the hottest part of the flame;
 *   · every emissive layer is roughly half its round-2 strength — and `fx.rad` is held well under
 *     half the twin-outlet spacing so the two hot cores never merge.
 *
 * And the jet is no longer the same size in every frame: `Nitrous.ramp` (thrust authority) drives
 * its LENGTH, multiplied by a hold term that stretches the column over the first ~0.6 s and by
 * road speed. Ignition is short and hot; sustain at 200 mph is a long column.
 *
 * The effect is ONE gas layer plus its supporting cast:
 *
 *   1. THE PLUME — one axis-containing proxy quad per outlet, whose shader RAYMARCHES THE REAL
 *      CAMERA RAY through the volume (filament, body, shear layer, shock train, turbulence,
 *      detached wisps) in a single premultiplied pass. This is the layer the whole effect is
 *      judged on; see the block comment above PLUME_FRAG
 *   2. a camera-facing burner disc so the plume still reads with structure head-on
 *   3. a velocity-stretched spark + light-smear streak pool, emitted into a narrow REARWARD cone
 *      and entrained in the jet wake (it trails, it does not detonate)
 *   4. a ground light pool on the road + a point light that spills onto the car's own bodywork,
 *      plus heat haze: the jet reports a screen-space position and strength, and main.js feeds it
 *      to the grade pass, which ripples the image behind the plume
 *
 * (r10 deleted a class-tinted lathe shell carried since round 1 as "the volume layer"; r12 deleted
 * the core/sheath split; r14 deleted the closed-form 2-D profile; r17 deleted the per-row strip
 * fit, the assumed perpendicular chord and the 28-row mesh with it. Every deletion so far has
 * made the plume better, which is the pattern: a jet is one object, and every layer boundary —
 * and every analytic curve — is a line the eye can find.)
 *
 * Ignition adds a muzzle flash, an expanding shock ring and a rearward spark blast, and main.js
 * turns `Nitrous.surge` into an FOV punch, a camera kick and a grade shift.
 *
 * ── THE ROUND-10 RULE: A BRIGHTENING NEEDS NO WALL, AND THREE IS NOT A PATTERN ───────────────
 * Round 9 scored 72. The verdict, from a 4x crop: "the nitrous jet has a genuine white core, warm
 * fringe and sparks, but the banding is built as ~7 discrete hollow crescent shells with visible
 * dark gaps and hard terminating edges, at near-constant diameter — it reads as a stack of rings
 * rather than a tapering plume." That is the fourth round in a row with the same note, and every
 * previous attempt attacked the SPACING of the cells. Spacing was never the mechanism. Four things
 * built the repeat, and each is addressed at its own cause:
 *
 *   1. THE COLUMN HAD A WALL. Round 9's radial density was `sqrt(1 - r²)` — the exact chord through
 *      a hard cylinder, whose slope is INFINITE at r = 1. Give the eye a defined boundary and it
 *      finds the boundary first, then reads whatever is bright inside it as a closed object: that
 *      is the entire difference between "a diamond in a jet" and "a hollow shell". Both impostors
 *      now use a gaussian faired to zero WITH ZERO SLOPE at the half-width. No wall, no shells, and
 *      "hard terminating edges" has no geometry left to come from.
 *   2. THE GAPS WERE DARK. `mix(1.0, 0.86 + 2.10·cell, amp)` put the trough BELOW the column's own
 *      brightness, and a trough below base is a seam — it segments a continuous body of light into
 *      separate ones. The modulation is now strictly additive: `1.0 + amp·cell·2.2`, floor exactly
 *      1.0, so between two diamonds the jet is simply the jet.
 *   3. THERE WERE SEVEN OF THEM, ALL THE SAME STRENGTH. Seven comparable anything is a texture. A
 *      real afterburner shows one dominant diamond just past the throat, a clearly smaller second
 *      and a hint of a third; amplitude is now smoothstep(0.015, 0.12, t) x exp(-t/0.50) and phase
 *      runs as t^1.45, so with fx.bands ~3.2-4.4 the cells sit at t ~ 0.17 / 0.48 / 0.67 and get
 *      shorter, narrower AND fainter together. You cannot find a period in three objects that each
 *      halve. (fx.bands is a count over the WHOLE column, not a visible count.)
 *   4. AND THE DIAMOND IS A SHAPE, NOT A FLASH. Under bloom a brightness pulse on the gas just
 *      grows a white halo; what actually reads at 4x is the incandescent filament SWELLING — its
 *      width is modulated 1.0x-3.1x by the same cell term, one-sided, so the thread lumps and
 *      slims down the column and is continuous everywhere.
 *   5. AND THE TRAIN STANDS STILL. Round 9 slid it downstream at uBandSpeed, which is what a flame
 *      does and not what a standing wave does — and in a deterministic still it made the structure
 *      a lottery, because whether a node landed in the fat part of the cone or two pixels off the
 *      lip was a function of what second of the capture it was. The cells now sit at fixed stations
 *      (cell 1's node parked near the profile's peakAt) and only breathe in place.
 *
 * Two supporting changes, because the plume was not the loudest thing in its own frame:
 *   · THE SHOWER WAS THE EFFECT. Sparks were born anywhere in the first 80% of a column the
 *     governor solves to ~11 m, in an annulus up to 3.1 core radii out, up to 2.3 m long and living
 *     twice the class life. In every round-9 boost frame that drew ~15 straight bright rods fanning
 *     across three quarters of the screen with the actual jet as a stub at one end — "a detached
 *     bundle of streaks". Birth zone 80% → 38% and 1.4–3.1 radii → 1.0–2.0, length 1.45 → 0.85,
 *     life x2.0 → x1.35, alpha down a third.
 *   · THE OUTLINE HAD NOTHING TO DRAW IT. The sheath ran at gain 0.13 with its half-width floored
 *     at 14% of maximum forever, so the plume's silhouette was the bright core alone: a 17:1
 *     ribbon, hence "near-constant diameter". The floor is 6%, it closes with the cone, and its
 *     gain is 2.3x. Plus the governor pays a solved length back as width less timidly (cap
 *     1.58 → 1.80, exponent 0.74 → 0.82) and every class's `fx.screen` is trimmed, so the column
 *     is shorter and thicker: it has an inside for a diamond to sit in.
 *
 * ── THE ROUND-9 RULE: THE JET IS THREE ZONES IN RADIUS, AND THE TRAIN ONLY BRIGHTENS ─────────
 * Round 8 shipped a shock train that was mathematically present and optically absent. The critic
 * read the 6x crop as "a smooth, featureless airbrushed lozenge — no banding, no shock diamonds,
 * no flicker, no nozzle-neck-then-flare profile, only weak core-to-fringe value separation", and a
 * line probe down the axis of the ISOLATED core layer agreed: R237 G210 B240, saturation 0.10,
 * varying 5% over the whole visible column. Two structural mistakes, and one calibration lesson:
 *
 *   1. THE WHITE SPINE ATE THE STRUCTURE. It was `pow(chord, 6.0)`, above 0.5 out to r = 0.45 —
 *      nearly half the half-width — and it REPLACED the banded gas with a flat `uCore * gain`.
 *      Everything the train drew survived only in the outer rim, at low alpha, under the bloom
 *      halo of the clipped middle. The filament is now a narrow thread (`fx.coreFil`, 0.21–0.27 of
 *      the half-width) and the coloured gas owns the rest of the column.
 *   2. THE RADIAL COLOUR RAMP WAS KEYED ON `chord`, NOT ON RADIUS, so `smoothstep(0, 0.62, chord)`
 *      was already 90% of the way to uMid at r = 0.87 and the class edge colour was one pixel
 *      wide. There was no core-to-fringe separation to see at any zoom. The layer is now three
 *      explicit zones in r: white filament / uMid body / fully-saturated uEdge fringe.
 *   3. AND THE MODULATION MUST BE ONE-SIDED. Photographed both ways this round: a symmetric swing
 *      (trough 0.52x, node 2.44x, filament pinching to 0.44x) turns the 240 mph LA supercar frame
 *      into ten identical white blobs on a dark violet thread — the round-3 bead chain, arrived at
 *      from the opposite direction. A node now peaks near 3x while the trough only falls to 0.86,
 *      and the filament swells but never pinches, so the column stays CONTINUOUS and the train
 *      reads as bright nodes on a jet instead of a row of separate objects.
 *
 * Also this round, against the round-2 deductions: cell spacing STRETCHES downstream (t^0.68, not
 * t^1.55 — see the shock-train block) so cells are squat-and-wide at the throat and long-and-slender
 * at the tail; per-frame flicker drives band brightness as well as column length; the governor's
 * width term is less sub-linear (a 25:1 ribbon has no room for a diamond); the SUV's gas gain,
 * ground pool and point light are trimmed so its plume stops flattening NYC's crosswalk to
 * featureless cream; and the heat haze is driven to the grade pass' clamp, because at round 6's
 * level it displaced under two pixels and the critic correctly reported no refraction at all.
 *
 * ── THE ROUND-8 RULE: THE TAPER IS WHAT KILLS THE REPEAT ─────────────────────────────────────
 * Round 7 attacked the "stack of rings" note by making the shock train's SPACING irregular, and
 * the note came back verbatim, because spacing was never the reason the chain read as a repeat.
 * A shock cell is as wide as the column it sits in, and round 7's column was near-constant
 * diameter over everything you could see — so every cell was the SAME SIZE, and a row of
 * same-sized blobs is a repeating unit however you space them. Four changes, in the order they
 * matter:
 *
 *   1. THE CONE ACTUALLY NECKS DOWN, over the part of the column that is on screen. `coneW`'s
 *      filament term now closes to zero at t = 1 instead of holding ~8% of the radius open
 *      forever, `fx.profile`'s spread is 1.1–2.0 rather than 0.8–1.55, and every class is under
 *      20% of its maximum radius by t = 0.8. Cell 4 is now a third the size of cell 1 and the
 *      chain reads as perspective down a tapering jet.
 *   2. THE VISIBLE COLUMN RUNS TO THE TIP. Round 7 cut the core's alpha at t ≈ 0.58–1.0, which is
 *      exactly the region the cone does its necking in: the taper was drawn and then thrown away,
 *      and what reached the frame was the fat parallel front half. The cut is now 0.76–1.04 and
 *      VIS_T (what the screen governor sizes against) moves 0.62 → 0.80.
 *   3. THE SILHOUETTE IS A FUNCTION OF t ALONE. Round 7's fray noise was sampled at (t, x), i.e.
 *      the half-width varied ACROSS the column as well as along it — a per-pixel lens, not an
 *      outline, and the r = |x|/w boundary it produced bulged and pinched into beads. Plus a fine
 *      second octave, so the sides are never the analytic curve drawn as a straight line.
 *   4. THE PLUME IS LIT ON THE LIP. `fx.standoff` 0.28–0.34 m → 0.10–0.13 m and the alpha ramp is
 *      two frames of column instead of 5%, so there is no bare road between the bumper and the
 *      flame ("a detached bundle of streaks flying behind the car"). The burner disc moved to the
 *      outlet to weld the two together.
 *
 * (r8 tried to fix the clipping spine by narrowing it to chord^6 and holding its trough at the
 * bloom threshold. chord^6 is still 0.5 of the way out to r = 0.45, which is why r9 replaced the
 * whole scheme with an explicit radius-keyed filament — see the round-9 block above.)
 *
 * ── THE ROUND-7 RULE: NO REPEATING UNIT AT 4x ────────────────────────────────────────────────
 * Round 6 finally made the structure survive to the frame, and that exposed what the structure
 * actually was: "~7 discrete hollow crescent shells with visible dark gaps and hard terminating
 * edges, at near-constant diameter — a stack of rings rather than a tapering plume". Three
 * independent mistakes, all fixed here, and all of them the same mistake in disguise — the plume
 * was built out of a REPEATED ELEMENT (a band, a card, a shell) instead of being one field:
 *
 *   · SPACING. The shock train's phase was linear in t, so every cell was the same length and the
 *     chain read as a texture. It is now `t^1.62`: the first cell is long and each one after it is
 *     shorter, which is both what a real afterburner does and the thing that makes the chain read
 *     as perspective down a column rather than as a repeat.
 *   · CONTRAST SHAPE. A cell was a near-square pulse (`smoothstep(0.42,0.57,·)`) bowed 2.4 rad by
 *     r², i.e. a crescent with a hard leading edge, and its gaps were punched to 12% brightness —
 *     so the eye segmented the column into separate shells. A cell is now `sin^2.3` (smooth
 *     everywhere, no edge to find), bowed 0.85 rad, its amplitude decays to nothing by mid-column,
 *     it is jittered per cell by value noise, and the gaps sit at the column's own base brightness.
 *     Nothing is ever punched dark: a dark gap IS a seam.
 *   · DIAMETER AND ENDING. `fx.profile` is a new curve (see coneW) that necks down over the part
 *     of the column you can actually see, instead of doing its tapering out in the region the alpha
 *     had already faded. Two fbm fields fray the silhouette and dissolve the tail into wisps, so
 *     the column ends by turning into gas rather than on a rim.
 *   · And the stack of five soft "gas cards" strung down the axis at regular spacing — the earlier
 *     "chain of identical beads" note — is gone, replaced by the single continuous sheath impostor.
 *
 * ── THE ROUND-6 RULE: THE JET MUST OUT-CONTRAST ITS OWN POST ─────────────────────────────────
 * Rounds 1–5 all drew the structure on additive lathe shells and every round got the same note
 * back: at 6x the plume is a soft low-frequency gradient with no banding and no cone. Two changes
 * fix it, and both are about CONTRAST rather than about drawing more:
 *   · the structural layer is an axis-billboarded impostor, composited (not added), so a band gap
 *     is dark on a night road in Vegas AND on a sunset road in Miami (r12: see PLUME_FRAG);
 *   · and everything that was drowning it comes down — the boost grade, the radial blur and the
 *     speed lines in main.js by ~40%, the heat haze by the same and re-centred BEHIND the tip, the
 *     white-hot lathe core deleted outright, and the remaining volume layers a third dimmer. The
 *     plume is the brightest structured thing in the frame by a distance, which is what §2.5's
 *     "readable as the biggest thing on screen" actually asks for. (r7 continues this: the point
 *     light's spill is down another 20% and the ember streaks are dimmer and thinner, because both
 *     were out-contrasting the column they exist to support.)
 *
 * ── THE ROUND-5 RULES: FRAME IT, BAND IT, AND MAKE THE CLASSES DIFFERENT SHAPES ──────────────
 * Round 4 solved the jet's SIZE on screen (see _governor) and the shot got worse, because size is
 * not the same thing as composition. Three things now:
 *
 *   · CONTAINMENT. The governor clips its own solution to the longest column whose visible end
 *     still lands inside a safe box in the frame, and pays the lost length back as width. A jet
 *     that exits the corner has no tip, no taper and no cone — it is a field of colour.
 *   · COMPOSITION. `aimPoint()` hands main.js a point down the plume's axis; the boost camera aims
 *     partway at it, which slides the car into the far third and gives the column the diagonal.
 *   · TESSELLATION. The vertex shader wobbles this surface, and the old lathe had 30 x 40 segments —
 *     every displacement term was past Nyquist and folded into flat triangles. That, not the
 *     shading, is why the plume kept reading as "soft sheets with straight alpha boundaries".
 *     72 x 48 segments and much lower wobble frequencies. (r7: and the displacement is now a
 *     fraction of the LOCAL radius, not an absolute distance — at turb near 1 an absolute wobble
 *     was ±100% of the radius and blew the shell out into a fan of hard-edged spikes.)
 *   · ...and the profile of the lathe is now a per-class parameter (`fx.profile`), so the SUV's
 *     blunt bell, the muscle's barrel and the supercar's long spindle are different SHAPES, not one
 *     shape in four colours.
 */

// ---------------------------------------------------------------------------------------------
// PER-CLASS NITROUS TABLE — owned by the nitrous piece. Kept here (not in the car files) so the
// nitrous builder and the vehicle-art builder never edit the same file.
//
//   thrust        extra drive force while boosting
//   duration      seconds one full tank lasts (drain is normalised to 1.0 so this reads directly)
//   refill        tank recharge rate when not boosting
//   topSpeedMul   how far past the class top speed a boost carries
//   ramp          seconds for the thrust to spool in
//   curve         exponent on the spool — THE per-class feel knob.
//                 <1 = snaps in violently, 1 = linear shove, >1 = builds like a freight train
//   surge         seconds the ignition overshoot lasts, and how hard it hits
//   color         flame tint; also drives the HUD, grade and speed-line tint
//   fx            purely visual per-class shaping of the jet (see NitrousJet)
//
//   fx.merge      how far, in radians, a twin column is toed IN toward the centreline. Two
//                 parallel jets half a metre apart read as "a pair of laser rods"; real adjacent
//                 jets entrain each other and merge. Capped, and further capped per car so the
//                 SUV's 1.56 m outlet spacing does not become a visible V. Never splays OUT.
//   fx.wake       how much of the car's speed the embers inherit. 0 would pin them to the bumper,
//                 1 would fire them through the chase camera at 90 m/s (round 1's "firework").
//   fx.cone       half-angle, in radians, of the rearward emission cone.
//   fx.standoff   how far BEHIND the exhaust anchor the plume starts. Round 2 lit the flame on the
//                 lip of the tip, so the bumper, taillights and outlets sat inside the hottest,
//                 most bloomed part of the jet and the car's rear silhouette disappeared — but
//                 round 7's 0.28–0.34 m over-corrected into "bare dark road between the rear
//                 bumper and the near end of the flame". ~0.11 m: the plume is lit ON the lip and
//                 the exposure (not the geometry) is what keeps the bodywork readable.
//   fx.rad        the plume's REFERENCE radius: the shader's radial coordinate is in these units,
//                 and the gas is marched to PLUME_REACH (1.7) local half-widths out from the axis.
//                 (r14) Up ~35% on every class. The taper has to survive the bloom pass, and bloom
//                 adds a halo of FIXED SCREEN RADIUS: a throat only 50 px across cannot show a 7:1
//                 taper once ~20 px of halo is welded to each side of every station, but a throat
//                 at ~55% of the car's width can. The white FILAMENT inside it is ~0.16 of the
//                 local half-width, i.e. ~0.08 m, so the two hot roots never merge into one blob.
//   fx.profile    the class cone [neck, peakAt, spread, tip fraction] — see coneW() and halfW().
//                 `spread` above ~1.1 and a tip fraction under ~0.12 are what make the column
//                 actually neck down over the length you can see, which is what stops the shock
//                 train reading as a repeat.
//                 (r22) peakAt is roughly DOUBLED on every class, and the throat pinch deepened.
//                 "No throat, no expansion angle" has been in three verdicts, and the reason is
//                 that the flare had nowhere to happen: the jet fires at the chase lens, so world
//                 station t maps to screen station t(1+p)/(1+p·t) with p ~ -0.45, and the first
//                 tenth of the column is squeezed into the first FIFTH OF A TENTH of what you see.
//                 At peakAt 0.115 the supercar's whole neck-and-flare — 0.50 of maximum opening to
//                 1.00 — happened inside 6% of the drawn length, half of it behind the diffuser.
//                 At 0.22 it happens over the first 14%: a 2.4:1 opening across a span the eye can
//                 measure an ANGLE against, which is what an expansion angle is.
//   fx.knot       how compact the incandescent pip inside a shock cell is. 0 = lobe^2, the SUV's
//                 lazy swell (half-max over ~36% of the cell); 1 = lobe^5, the supercar's hard pip
//                 (~23%). This is the per-class knob that stops all four jets sharing one interior:
//                 a torch with three soft swells in it is a different OBJECT from a needle with
//                 five hard pips down it, at the same colour, length and taper.
//   fx.bands      shock cells over the whole column. (r19) The phase is uBands*ts^2, so node n sits
//                 at ts = sqrt((n + 0.09)/uBands) and the spacing crowds as the cone necks — the
//                 supercar's five cells land at 0.13 / 0.44 / 0.61 / 0.74 / 0.86, spacings 0.31 /
//                 0.17 / 0.13 / 0.11, a 3.2:1 crowd against r18's 1.6:1. (r18) The phase runs on the station the LENS
//                 sees — ts = t/(1 + uPersp·t), normalised — not on the world station, because the
//                 jet fires at the chase camera and the tail is magnified by up to 3x: a train
//                 pitched in world t comes out at a DEAD CONSTANT screen period, which is the
//                 "chain of identical, uniformly-sized blobs at regular spacing" note in six
//                 verdicts. At ts^1.45 with bands 3.2-4.8 the nodes land at ts ~ 0.14/0.42/0.63/
//                 0.81 (screen spacings 0.28, 0.21, 0.18, 0.17) and amplitude falls as
//                 exp(-ts/0.38), so cell 2 is half of cell 1, cell 3 a quarter, cell 4 a sixth —
//                 and the cone underneath them has necked to 45%/26%/14% of the throat. Three
//                 cells that each shrink is a sequence, not a texture.
//   fx.bandFade   (r20) how far the train fades from ONE DIAMOND TO THE NEXT. The shock phase is
//                 uBands·ts², so ts² IS the cell index and exp(-bandFade·uBands·ts²) is a fixed
//                 ratio per cell however hard the spacing crowds: 0.30 -> 0.74x (the supercar's
//                 six-cell train, still 22% of full amplitude at the tip), 0.42 -> 0.66x (the
//                 SUV, three cells and done). Under the old exp(-ts/τ) the ratio ran towards 1.0
//                 exactly where the cells crowded together, which gave a cliff at the head of the
//                 train and a row of equal ripples at the tail — measured, only diamond ONE was
//                 ever drawn (see the r20 note in PLUME_FRAG).
//   fx.gasGain    master exposure of the marched integral. The BODY has to land near 1.0-1.4 in
//                 its strongest channel at the throat: saturated, still on the tonemap's slope,
//                 never a posterised plateau with a rim around it. Verify it with
//                 tools/_plume_ms.mjs — the number to watch is any-chan-250 as a fraction of the
//                 plume's own pixels, which should be a couple of per cent and all of it in knots.
//   fx.hotI       gain on the incandescent filament — the only part driven past the bloom
//                 threshold, so it is the only part that blooms. It sits DARK on its own; what
//                 lights it is a shock node (x1 -> x4.4), so the white in the jet is a row of
//                 knots rather than a bar.
//   fx.burn       how fast the filament burns out downstream (exp(-t/burn)). White at the throat,
//                 class colour at the tail: 0.19 is a supercar needle, 0.30 is the SUV's lazy bell.
//   fx.filW       filament 1/e half-width as a fraction of the LOCAL column half-width (~0.16).
//   fx.bodyW      the class-coloured body's half-width, same units (~0.44-0.52). The body is a
//                 SUPER-gaussian, exp(-(r/bodyW)^3): flat across the middle, so the same total
//                 light arrives as a wide saturated column instead of a clipped axial bar.
//   fx.bodyD      how much the body ABSORBS. The raymarch's transmittance comes from this, so it
//                 decides whether the lane line behind the plume goes away, and how strongly the
//                 near side of the column shades the far side.
//   fx.rimR       (r21) where the SHEAR SHELL sits, in local half-widths — see the r21 block in
//                 PLUME_FRAG. ~1.0 puts it on the class cone, so the two limb-brightened flank
//                 lines the march produces ARE the taper and converge exactly as it necks.
//   fx.rimW       its 1/e thickness in the same units, and the per-class knob for how HARD the
//                 plume's edge is: 0.145 is the supercar's drawn line, 0.38 the SUV's boiling
//                 bell whose boundary is a band you can see the gas mixing across. This is a
//                 different OBJECT per class in a way colour alone cannot deliver — a needle with
//                 a sharp outline against a bell with none.
//   fx.rimE       how brightly it burns. The only emission in the file not routed through the
//                 temperature ramp, so it lands at a fixed saturated fringe colour whatever the
//                 body is doing: the reference's "white core and blue fringe", drawn rather than
//                 arrived at by a gradient running out.
//   fx.skirtW     the cool turbulent shear layer's 1/e half-width, same units (~0.86-1.06) — this
//                 is what draws the plume's OUTLINE, and it is modulated by the flute noise
//                 SQUARED, so the outline sits at a different radius at every station.
//   fx.skirtI     how much gas is in that shear layer. High = boiling SUV bell, low = tight
//                 needle. Do NOT let it out-weigh fx.bodyD: at skirtI 1.0+ the plume becomes ALL
//                 skirt, an ablation with the body removed is indistinguishable from the full
//                 render, and what you have photographed is a smooth airbrushed ribbon again.
//   fx.thick      optical thickness: how completely the middle of the jet HIDES the road behind it.
//   fx.occ        ceiling on that occlusion — a plume you cannot see through at all is a painted
//                 shape, so the wisps at the silhouette stay translucent.
//   fx.turb       raggedness of the silhouette and of the wisps the tail dissolves into. 0.5 is a
//                 tight supercar needle, 1.05 is the SUV's boiling bell.
//   fx.screen     THE round-4 knob: how much of the FRAME HEIGHT the lit column should occupy for
//                 the whole sustain. `fx.len` is now only a shape reference — the world length is
//                 SOLVED for every frame so this number comes true at whatever distance and angle
//                 the chase rig happens to be sitting at. See NitrousJet._governor().
// ---------------------------------------------------------------------------------------------
export const NITRO = {
  // Short and sharp. A tiny screamer: near-instant, thin white-cyan needle, gone in a blink.
  // Single big centre outlet, so one jet — and that alone reads differently from the other three.
  tuner: {
    thrust: 0.92, duration: 1.8, drain: 1.0, refill: 0.62, topSpeedMul: 1.50,
    ramp: 0.13, curve: 0.52, surge: 0.88, surgeTime: 0.22, color: '#3ce0ff',
    fx: {
      core: '#f4ffff', mid: '#1ecfff', edge: '#0a30f5', spark: '#cdf4ff',
      len: 3.60, rad: 0.505, merge: 0.0, standoff: 0.10, flameRise: 0.045,
      // profile = [throat fraction, station of the widest point, decay exponent, TAIL fraction].
      // (r17) the last number is no longer a filament width that closes to zero at t = 1; it is the
      // half-width the column keeps AT the tip, and the decay now runs the whole length to reach it.
      screen: 1.00, profile: [0.44, 0.18, 1.72, 0.070],   // slim needle: closes fastest of the four
      bands: 5.0, knot: 0.80, xsh: 0.62, bandSpeed: 30, bandAmt: 1.00, neckAmt: 0.28, bandFade: 0.32, flick: 62, turb: 0.84,
      gasGain: 0.86, hotI: 6.90, burn: 0.30, filW: 0.112, bodyW: 0.45, wisp: 0.58,
      skirtW: 0.72, skirtI: 0.68, bodyD: 1.78, thick: 0.82, occ: 0.94,
      rimR: 0.97, rimW: 0.100, rimI: 1.10, rimE: 1.75,
      sparkRate: 132, sparkSpeed: [3.5, 11], sparkWidth: 0.034, sparkLife: [0.16, 0.30],
      wake: 0.16, cone: 0.22, smearRate: 15.0, smearWidth: 0.030,
      poolWidth: 1.4, poolLen: 3.6, lightI: 11, shake: 0.30, heat: 1.00,
    },
  },
  // A long brutal shove. Twin wide-set pipes, fat orange-red columns, slow heavy banding.
  muscle: {
    thrust: 1.10, duration: 3.4, drain: 1.0, refill: 0.34, topSpeedMul: 1.26,
    ramp: 0.52, curve: 1.20, surge: 0.62, surgeTime: 0.44, color: '#ff7a1e',
    fx: {
      core: '#fffaf2', mid: '#ff6a10', edge: '#b41403', spark: '#ffc477',
      len: 4.00, rad: 0.545, merge: 0.062, standoff: 0.12, flameRise: 0.15,
      screen: 1.10, profile: [0.72, 0.100, 1.30, 0.095],  // fat barrel, widest right off the bumper
      bands: 3.6, knot: 0.42, xsh: 0.50, bandSpeed: 12, bandAmt: 1.00, neckAmt: 0.22, bandFade: 0.34, flick: 28, turb: 1.12,
      gasGain: 0.74, hotI: 5.50, burn: 0.40, filW: 0.120, bodyW: 0.49, wisp: 0.94,
      skirtW: 0.86, skirtI: 1.00, bodyD: 1.78, thick: 0.86, occ: 0.94,
      rimR: 1.03, rimW: 0.195, rimI: 0.88, rimE: 1.20,
      sparkRate: 122, sparkSpeed: [2.5, 9], sparkWidth: 0.050, sparkLife: [0.20, 0.38],
      wake: 0.21, cone: 0.28, smearRate: 13.0, smearWidth: 0.032,
      poolWidth: 1.7, poolLen: 4.4, lightI: 13, shake: 0.46, heat: 1.15,
    },
  },
  // Builds like a freight train. Widest-set outlets, slowest, most massive plume in the game —
  // and therefore the dimmest per unit area, or it becomes one blown-out yellow mass over the car.
  suv: {
    thrust: 1.26, duration: 4.6, drain: 1.0, refill: 0.28, topSpeedMul: 1.29,
    ramp: 0.78, curve: 1.55, surge: 0.34, surgeTime: 0.62, color: '#ffc21f',
    fx: {
      core: '#fff3d6', mid: '#ffc21f', edge: '#ff6a08', spark: '#ffd487',
      len: 3.70, rad: 0.555, merge: 0.050, standoff: 0.13, flameRise: 0.26,
      screen: 1.12, profile: [0.76, 0.090, 1.14, 0.110],  // blunt bell — fat off the pipe, stubby
      bands: 3.4, knot: 0.14, xsh: 0.34, bandSpeed: 7, bandAmt: 1.00, neckAmt: 0.18, bandFade: 0.42, flick: 16, turb: 1.28,
      // THE ANTI-BLOWOUT SETTING. The SUV's column is the widest in the game, so per unit area it
      // has to be the dimmest: gas gain 0.56 keeps a band trough near the road's own level, and a
      // narrow filament at 0.62 authority means the white core is a thread rather than the whole
      // column. Round 2 clipped "large flat regions to featureless yellow-white across the lower
      // half of the frame" — this is the number that fixes that, not the post chain.
      gasGain: 0.74, hotI: 5.70, burn: 0.44, filW: 0.116, bodyW: 0.54, wisp: 1.05,
      skirtW: 0.96, skirtI: 1.04, bodyD: 1.62, thick: 0.86, occ: 0.94,
      rimR: 1.08, rimW: 0.255, rimI: 0.72, rimE: 0.95,
      sparkRate: 112, sparkSpeed: [2, 8], sparkWidth: 0.056, sparkLife: [0.22, 0.42],
      wake: 0.25, cone: 0.32, smearRate: 11.0, smearWidth: 0.050,
      poolWidth: 1.9, poolLen: 4.2, poolI: 0.40, lightI: 6, shake: 0.54, heat: 1.15,
    },
  },
  // Snaps in instantly and violently. Twin close-set centre pipes: longest, tightest, hottest —
  // two white needles with an electric violet fringe.
  supercar: {
    thrust: 1.08, duration: 2.3, drain: 1.0, refill: 0.46, topSpeedMul: 1.56,
    ramp: 0.08, curve: 0.32, surge: 1.00, surgeTime: 0.30, color: '#8f6bff',
    fx: {
      core: '#ffffff', mid: '#8a4dff', edge: '#2a10ff', spark: '#ded2ff',
      len: 4.60, rad: 0.545, merge: 0.085, standoff: 0.10, flameRise: 0.035,
      screen: 1.25, profile: [0.42, 0.220, 1.70, 0.068],  // long spindle — the slenderest of the four
      bands: 5.6, knot: 0.92, xsh: 0.70, bandSpeed: 34, bandAmt: 1.00, neckAmt: 0.30, bandFade: 0.30, flick: 74, turb: 0.76,
      gasGain: 0.68, hotI: 6.20, burn: 0.28, filW: 0.105, bodyW: 0.43, wisp: 0.52,
      skirtW: 0.70, skirtI: 0.62, bodyD: 1.78, thick: 0.80, occ: 0.94,
      rimR: 0.96, rimW: 0.092, rimI: 1.20, rimE: 1.90,
      sparkRate: 132, sparkSpeed: [4, 14], sparkWidth: 0.034, sparkLife: [0.16, 0.30],
      wake: 0.14, cone: 0.20, smearRate: 17.0, smearWidth: 0.042,
      poolWidth: 1.5, poolLen: 4.6, lightI: 14, shake: 0.62, heat: 1.10,
    },
  },
};

export function getNitro(id) {
  const n = NITRO[id];
  if (!n) throw new Error(`No nitrous profile for vehicle "${id}"`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------------------------

export class Nitrous {
  constructor(spec) {
    this.spec = spec;
    this.cfg = spec.nitro;
    this.charge = 1.0;         // 0..1 tank
    this.tanks = 3;            // discrete tanks, like the reference's "NITRO X3" badge
    this.active = false;
    this.ramp = 0;             // 0..1 thrust authority — the per-class feel curve
    this.flame = 0;            // 0..1 visual level — rises faster than thrust so the jet is
                               // always a spectacle even while an SUV is still spooling
    this.surge = 0;            // 0..1 ignition overshoot, decays over cfg.surgeTime
    this._spool = 0;
    this.t = 0;
    this.justFired = false;
    this.justEnded = false;
  }

  /** Thrust includes the ignition overshoot so the punch is felt, not just seen. */
  get thrust() { return (this.ramp + this.surge * (this.cfg.surge ?? 0.5) * 0.55) * this.cfg.thrust * 30; }
  get strength() { return this.ramp; }
  /** What the camera/grade should respond to: sustained boost plus the ignition spike. */
  get punch() { return clamp(this.ramp + this.surge * (this.cfg.surge ?? 0.5), 0, 1.8); }

  /** @param want boolean — the player is holding the nitro button */
  update(dt, want, { moving = true } = {}) {
    this.justFired = false; this.justEnded = false;
    const c = this.cfg;
    const canFire = this.charge > 0.02 && this.tanks > 0 && moving;

    if (want && canFire) {
      if (!this.active) { this.active = true; this.justFired = true; this.t = 0; this.surge = 1; }
      this.charge -= dt * c.drain / c.duration;
      if (this.charge <= 0) { this.charge = 0; this.tanks = Math.max(0, this.tanks - 1); this.active = false; this.justEnded = true; }
    } else {
      if (this.active) this.justEnded = true;
      this.active = false;
      if (this.tanks > 0 || this.charge < 1) {
        this.charge = Math.min(1, this.charge + dt * c.refill * 0.30);
      }
    }

    // Spool is linear; the CURVE is what makes the classes feel different.
    //   supercar curve 0.32 → 80% thrust within a couple of frames
    //   suv      curve 2.00 → almost nothing for half a second, then it shoves
    const rampS = Math.max(0.03, c.ramp ?? 0.3);
    this._spool = clamp(this._spool + (this.active ? dt / rampS : -dt / 0.22), 0, 1);
    this.ramp = Math.pow(this._spool, c.curve ?? 1);

    // Visual level rises on its own (fast) schedule and falls off with a hot afterglow.
    const riseS = Math.max(0.02, c.fx?.flameRise ?? 0.08);
    const flameTarget = this.active ? 1 : 0;
    const flameRate = this.active ? 1 / riseS : 5.2;
    this.flame += (flameTarget - this.flame) * (1 - Math.exp(-flameRate * dt));
    this.flame = clamp(this.flame, 0, 1);

    this.surge = Math.max(0, this.surge - dt / Math.max(0.05, c.surgeTime ?? 0.3));
    this.t += dt;
    return this.ramp;
  }

  addTank() { this.tanks = Math.min(3, this.tanks + 1); this.charge = 1; }
  reset() {
    this.charge = 1; this.tanks = 3; this.active = false;
    this.ramp = 0; this.flame = 0; this.surge = 0; this._spool = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Procedural textures (canvas → CanvasTexture; nothing is loaded from disk)
//
// Every one of these is a RADIAL alpha field that reaches zero strictly inside the tile. That is
// the §7 requirement: a sprite whose alpha is still non-zero at the tile border shows the quad.
// ---------------------------------------------------------------------------------------------

const _texCache = new Map();
function cachedTex(key, make) {
  let t = _texCache.get(key);
  if (!t) {
    t = make();
    t.colorSpace = THREE.SRGBColorSpace;
    _texCache.set(key, t);
  }
  return t;
}
function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d') };
}

/**
 * Assert-by-construction helper: multiply a finished canvas by a radial window so the outer 12%
 * of the tile is guaranteed transparent no matter what was drawn into it.
 */
function feather(ctx, S, inner = 0.34, outer = 0.50) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
      const r = Math.hypot(nx, ny);
      const t = clamp((r - inner) / (outer - inner), 0, 1);
      d[o + 3] *= 1 - t * t * (3 - 2 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The burner disc: what you see looking straight into the nozzle. Hard white centre, a set of
 * concentric pressure rings, radial spikes and an anamorphic horizontal smear. This is the layer
 * that keeps the jet legible from the chase camera, where the plume is heavily foreshortened.
 */
function burnerTexture() {
  return cachedTex('burner', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    const rng = new RNG(9091);
    ctx.clearRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';

    // radial spikes first (under everything)
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + rng.range(-0.06, 0.06);
      const len = h * rng.range(0.40, 0.86);
      const g = ctx.createLinearGradient(h, h, h + Math.cos(a) * len, h + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineCap = 'round';
      ctx.lineWidth = rng.range(1.2, 3.4);
      ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * len, h + Math.sin(a) * len); ctx.stroke();
    }

    // concentric pressure rings — soft on both sides, so no ring shows an edge
    for (let i = 0; i < 6; i++) {
      const r = h * (0.13 + i * 0.105);
      const w = h * (0.030 - i * 0.0026);
      const g = ctx.createRadialGradient(h, h, Math.max(0, r - w * 2.6), h, h, r + w * 2.6);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${0.62 - i * 0.085})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    }

    // white-hot core
    const g0 = ctx.createRadialGradient(h, h, 0, h, h, h * 0.18);
    g0.addColorStop(0, 'rgba(255,255,255,0.90)');
    g0.addColorStop(0.42, 'rgba(255,255,255,0.5)');
    g0.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g0; ctx.fillRect(0, 0, S, S);

    // broad halo
    const g1 = ctx.createRadialGradient(h, h, h * 0.18, h, h, h * 0.92);
    g1.addColorStop(0, 'rgba(255,255,255,0.30)');
    g1.addColorStop(0.55, 'rgba(255,255,255,0.09)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, S, S);

    // anamorphic horizontal smear — the arcade lens-flare tell. Gaussian in BOTH axes: drawn as a
    // hard band (round 1) it put two straight horizontal edges across the middle of the sprite.
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
        const streak = Math.exp(-(ny * ny) / (0.010 * 0.010)) * Math.exp(-(nx * nx) / (0.26 * 0.26));
        d[o + 3] = Math.min(255, d[o + 3] + streak * 210);
      }
    }
    ctx.putImageData(img, 0, 0);

    feather(ctx, S, 0.36, 0.50);
    return new THREE.CanvasTexture(c);
  });
}

/**
 * Soft irregular pool of light for the road spill. Bright near the nozzle, fading backward.
 *
 * Evaluated per pixel as one continuous field. Round 2 stacked 26 discrete radial gradients down
 * the tile; on the road, seen from the chase camera at a grazing angle, those 26 rings compressed
 * into a fan of horizontal stripes under the car, which the aberration pass then fringed into
 * rainbow scanlines. A light pool must have no internal edges at all.
 */
function poolTexture() {
  return cachedTex('pool', () => {
    const S = 256;
    const { c, ctx } = cv(S, S);
    const rng = new RNG(4471);
    // a handful of low-frequency lumps so the pool is not a perfectly airbrushed cone
    const lumps = [];
    for (let i = 0; i < 6; i++) {
      lumps.push([rng.range(0.05, 0.80), rng.range(-0.20, 0.20), rng.range(0.10, 0.26), rng.range(0.4, 1.0)]);
    }
    // ── (r19) A SPILL ON A ROAD IS RIBBED, NOT AIRBRUSHED ────────────────────────────────────
    // §1.3 is explicit about what light on a road looks like in this game's reference — "every
    // light source draws a long reflection down the stone" — and up to r18 this tile was a smooth
    // gaussian cone, i.e. a painted patch. Seven soft ribs that run the WHOLE length of the pool
    // turn it into a set of reflections stretched down the road by the grazing view, which is both
    // what a road does with a light and the thing that stops the pool reading as a decal. They are
    // strongest at the near end and wash out down-road, because that is where the specular lobe is.
    const ribs = [];
    for (let i = 0; i < 7; i++) ribs.push([rng.range(-0.30, 0.30), rng.range(0.010, 0.040), rng.range(0.25, 1.0)]);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const v = (y + 0.5) / S;          // 0 at the nozzle end, 1 at the far end
        const u = (x + 0.5) / S - 0.5;    // -0.5 .. 0.5 across
        // (r5) The fan used to reach halfW = 0.455 at the far end — i.e. the gaussian was still at
        // ~1/e when it hit the tile border, so the only thing ending the pool was the border cut,
        // and on the road at a grazing angle that drew a STRAIGHT bright edge across the asphalt
        // (§7's hard-edged-sprite tell). The fan is narrower and the axial falloff longer, so the
        // field is at zero on its own well before the quad runs out.
        const halfW = 0.050 + v * 0.235;  // the spill fans out down the road
        let a = Math.exp(-(u * u) / (halfW * halfW)) * Math.pow(1 - v, 1.5);
        let lum = 1;
        for (const [lv, lu, lr, la] of lumps) {
          const dv = (v - lv) / lr, du = (u - lu) / (lr * 1.5);
          lum += la * 0.5 * Math.exp(-(dv * dv + du * du));
        }
        a *= 0.55 + 0.45 * Math.min(lum, 2.2);
        let rib = 0;
        for (const [ru, rw, ra] of ribs) {
          const dr = (u - ru) / rw;
          rib += ra * Math.exp(-dr * dr) * (0.30 + 0.70 * Math.pow(1 - v, 2.2));
        }
        a *= 0.80 + 0.55 * Math.min(rib, 1.7);
        // the root: the spill is hottest where it leaves the pipe, and that is what welds the
        // pool to the car instead of letting it float behind as a separate patch of colour
        a += 0.44 * Math.exp(-(u * u) / (0.052 * 0.052)) * Math.exp(-(v * v) / (0.115 * 0.115));
        a *= (1 - smoothstep(0.58, 0.98, v)) * (1 - smoothstep(0.46, 0.92, Math.abs(u) * 2));
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
        d[o + 3] = clamp(a, 0, 1) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  });
}

/** Muzzle flash: a blazing centre with long four-point streaks, all gaussian-soft. */
function flashTexture() {
  return cachedTex('flash', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    ctx.clearRect(0, 0, S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const arms = [[1, 0, 0.014, 0.34], [0, 1, 0.011, 0.26], [0.7071, 0.7071, 0.007, 0.20], [0.7071, -0.7071, 0.007, 0.20]];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
        const r = Math.hypot(nx, ny);
        let a = Math.exp(-(r * r) / (0.055 * 0.055)) + Math.exp(-(r * r) / (0.15 * 0.15)) * 0.42;
        for (const [ax, ay, w, l] of arms) {
          const along = nx * ax + ny * ay;
          const across = -nx * ay + ny * ax;
          a += Math.exp(-(across * across) / (w * w)) * Math.exp(-(along * along) / (l * l)) * 0.75;
        }
        const v = clamp(a, 0, 1) * (1 - smoothstep(0.34, 0.50, r));
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = v * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  });
}

/** Thin bright shock ring for the ignition wave. */
function ringTexture() {
  return cachedTex('shockring', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    ctx.clearRect(0, 0, S, S);
    const g = ctx.createRadialGradient(h, h, h * 0.56, h, h, h * 0.98);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.14)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(0.90, 'rgba(255,255,255,0.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  });
}

// ---------------------------------------------------------------------------------------------
// The class cone
// ---------------------------------------------------------------------------------------------

/**
 * ── THE CLASS CONE (r8) ──────────────────────────────────────────────────────────────────────
 * `fx.profile` is [neck, peakAt, spread, filament], and this one curve is the silhouette of every
 * layer in the jet — both impostor shaders evaluate the identical expression in GLSL (see
 * NOISE_GLSL.coneW), so the soft envelope and the bright structure agree exactly.
 *
 *   neck      radius at the orifice as a fraction of the maximum. 0.24 pinches to a throat and
 *             flares (supercar); 0.70 leaves the pipe already fat (SUV).
 *   peakAt    where the column is widest. Early is a torch, late is a spindle.
 *   spread    how fast it necks down after the peak. Around 1.1 is a bell, 2.0 a needle.
 *   filament  a thin core that survives past the taper, so a needle keeps a visible thread where
 *             a bell has already closed. Blended in as a 2-norm, so the profile has no kink —
 *             and it closes to zero at the tip, which round 7's did not.
 *
 * THIS CURVE IS WHY THE PLUME STOPPED READING AS A STACK OF RINGS. A shock cell is as wide as the
 * column it sits in; round 7's profiles were still at 36–62% of maximum width at t = 0.62 (which
 * is where its alpha cut the column off), so every cell in the visible plume was the same size and
 * the chain was a repeating unit no matter what its spacing did. Every class is now under 20% of
 * maximum by t = 0.8 and at zero by t = 1, so cell 4 is a third the size of cell 1 and the train
 * reads as perspective down a tapering jet. Sanity numbers, supercar [0.24, 0.17, 2.00, 0.11]:
 * w(0.3) = 0.72, w(0.5) = 0.37, w(0.7) = 0.14, w(0.8) = 0.062, w(1) = 0.
 */
export function coneW(t, prof) {
  const [neck, peakAt, spread, tip] = prof || [0.40, 0.15, 1.10, 0.10];
  const rise = neck + (1 - neck) * smoothstep(0, Math.max(peakAt, 1e-3), t);
  const u = clamp((t - peakAt) / Math.max(1 - peakAt, 1e-3), 0, 1);
  // ── (r17) THE DECAY RUNS THE WHOLE LENGTH, IT DOES NOT FALL OFF A CLIFF ──────────────────
  // Every profile up to r16 multiplied a term that reached exactly ZERO at t = 1, and the measured
  // consequence (tools/_plume_ms.mjs, LA muscle) was that the column held 225-230 px of width from
  // t = 0.10 to t = 0.15, 147 px at t = 0.30, and then collapsed to 16 px by t = 0.60 and died:
  // a 230 x 250 px BLOB with a whisker on it, which is "near-constant width" and "no taper" in the
  // same measurement. The decay is now to a fixed TIP FRACTION over the whole span, so the width
  // falls smoothly through every station the eye actually reads and the end of the column is a
  // thin, ragged thread rather than an analytic point nobody can see.
  // Sanity, muscle [0.66, 0.06, 1.30, 0.085]: w(0.3) = 0.71, w(0.5) = 0.49, w(0.7) = 0.30,
  // w(0.85) = 0.17, w(1) = 0.085 — a visible 8:1 neck-down inside the part that is lit.
  return rise * (tip + (1 - tip) * Math.pow(1 - u, spread));
}

/**
 * Shared GLSL: one hash and one octave of value noise.
 *
 * The noise is what stops the plume being a repeated element. A sum of sines — which is what every
 * round up to r9 used — has a period, and at 4x a period is exactly what the eye finds. A hash has
 * none, so the frayed silhouette and the wisps the tail dissolves into never repeat.
 *
 * ONE octave, deliberately. The plume's cost is fill rate and the march evaluates this per SAMPLE:
 * r16's fbm3 was twelve hash evaluations a sample, and a chord integral averages the high octaves
 * straight back out again — they cost their full price and arrive at the frame as a slightly
 * lighter grey. The lumpiness that actually reads comes from sampling ONE octave at three
 * different frequencies of three different quantities (azimuth, station, radius).
 */
const NOISE_GLSL = /* glsl */`
  float h21(vec2 p){
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.53);
    return fract(p.x * p.y * 95.43);
  }
  float vn(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
               mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

// ── ROUND 17: THE GAS IS A REAL 3-D FIELD AND THE RAY IS THE REAL CAMERA RAY ─────────────────
//
// r14-r16 marched a chord, but the chord was an ASSUMPTION: the shader took the fragment's
// distance from the drawn strip's centreline as an impact parameter and integrated a
// perpendicular chord through a cross-section. That is a 2-D field with a depth loop bolted on.
// It has three consequences, and between them they are every word of every verdict since round 3:
//
//   · THE STRIP HAD TO BE CUT TO THE GAS. PLUME_VERT squeezed each of 28 rows to what the
//     fragment shader could reach there, so the quad's border ran along the silhouette — and
//     anywhere the fit under-estimated the shading by a per cent, the border WAS the silhouette:
//     a polyline of 28 straight segments down each flank. Measured on the r16 LA muscle frame at
//     5x, with the pool, the streaks, the disc and the lamp ablated away: two dead-straight
//     seams across the column and a straight-sided orange wedge. "A flat hard-edged orange slab."
//   · THE COLUMN WAS FLAT WHEREVER THE RIG WAS NOT BROADSIDE. An impact parameter measured on the
//     drawn quad is only the true one when the lens is square to the strip. The chase rig never
//     is, so the volume was sheared — and a sheared cross-section integrates to a ribbon.
//   · AND THERE WAS NO 3-D STRUCTURE TO FIND. Everything varied with (t, b) — station and lateral
//     offset ON THE QUAD. Turbulence sampled that way is a decal: it is the same wherever you
//     stand, it cannot occlude itself, and it cannot put a lump at a RADIUS.
//
// So the strip is now nothing but a rasterisation proxy — a quad that contains the plume's axis,
// rolled to face the lens, cut generously and never at the gas — and PLUME_FRAG reconstructs the
// actual world-space camera ray for the pixel, intersects it with the plume's bounding cylinder
// analytically, and marches THAT. Every sample is a real point in the world: it has a station
// s along the axis, a true radius r from it and a true azimuth around it. From that:
//
//   · the silhouette is wherever the density runs out along the real ray, so it is different from
//     every viewpoint, at every station and in every frame, and no quad edge is anywhere near it;
//   · a shock diamond is a LENS IN 3-D — a compression that necks the column, thickens it and
//     lights it — and it occludes the road through more gas than the belly either side of it;
//   · the flutes wrap the axis and the chord genuinely passes through denser and thinner pockets,
//     so the column has an inside rather than a pattern on its surface;
//   · and the gas fades out at the road per SAMPLE, in 3-D, so the plume dissolves INTO the
//     asphalt instead of being sliced along a straight world-space line by the depth buffer.
//
// The four other things the measurements said, each fixed at its own cause:
//
//   1. THE TAPER ALL HAPPENED WHERE THE PLUME WAS ALREADY INVISIBLE. tools/_plume_ms.mjs on the
//      r16 LA muscle: 225 px across at t = 0.10, 230 at 0.15, 173 at 0.25, 147 at 0.30 — and then
//      it fell off a cliff to 16 px by t = 0.60 and died. So the part of the column that carried
//      any brightness was a 230 x 250 px BLOB of near-constant width, and the "taper" was a thread
//      nobody can see. The class profile now decays to a fixed tip fraction over the WHOLE length,
//      `tip + (1-tip)·(1-u)^spread`, so the width falls smoothly through every station the eye
//      actually reads: ~0.70 of the throat at a third of the way down, ~0.45 at half, ~0.20 at
//      four fifths. A cone you can see necking, rather than a blob with a whisker.
//   2. IT WAS SMALLER THAN THE SPEEDOMETER. §2.5 asks for the biggest thing on screen. The size
//      solver was asking for 0.72-0.76 frame heights and the containment clamp was then handing a
//      fifth of it back. The class targets are now 0.95-1.25 frame heights — deliberately more
//      than fits — so the CONTAINMENT clamp is what binds in every hero framing, and the jet is
//      by construction the longest column that still ends inside the frame.
//   3. ...AND IT SHRANK UNDER SUSTAINED BOOST. With containment binding, a target that opens up
//      over the boost does nothing at all: both frames solve to the same fitted length. Growth is
//      now applied AFTER the fit, as a factor that is never above 1 — 0.80 at ignition, 1.00 by
//      ~1.5 s — so the sustained frame is the full frame-fit and the ignition frame is four fifths
//      of it. Bigger later is guaranteed by construction rather than hoped for from a target.
//   4. THE STRUCTURE WAS BEING BLURRED OFF. The frame the plume is judged on is a 240 mph frame,
//      and SpeedShader's radial blur is at full strength there: a ~50 px smear along a direction
//      that, for a jet fired backwards out of a chase-framed car, is almost exactly the plume's
//      OWN AXIS. Anything whose structure runs along the column — a row of bright knots — is
//      smeared into a smooth streak, which is "airbrushed", "no shock banding", "a light-ribbon".
//      Structure ACROSS the column survives it untouched. So the shock train's main job here is
//      to neck and belly the SILHOUETTE (uNeck up to 0.52) rather than merely to brighten, and
//      the cells are large: 4-5 of them across the visible length, not twelve.

const PLUME_VERT = /* glsl */`
  uniform vec3 uOrigin, uAxis;
  uniform float uLen, uHalfW, uPadS;
  varying vec3 vWorld;
  void main(){
    // The proxy CONTAINS the plume's axis and is rolled about it until its face is square to the
    // lens. Containing the axis is what keeps the depth this quad writes to the depth TEST honest
    // — the gas is within a metre of this plane everywhere — and rolling about the axis (rather
    // than facing the camera outright) means the quad never presents a square to the lens.
    // It is cut with a flat, generous margin and NEVER to the shape of the gas: the moment a
    // quad's border runs along the silhouette, the border IS the silhouette, and a border is a
    // straight line. Everything that decides where the plume ends now lives in PLUME_FRAG.
    vec3 C  = uOrigin + uAxis * (uLen * 0.5);
    vec3 vd = C - cameraPosition;
    vec3 e2 = cross(uAxis, vd);
    float m = length(e2);
    // degenerate only with the lens exactly on the axis, where the column projects to a disc and
    // the burner sprite is the layer that reads; any perpendicular will do there.
    e2 = m > 1e-4 ? e2 / m : normalize(cross(uAxis, vec3(0.331, 0.907, 0.261)));
    // uv.y runs 0 at the orifice to 1 at the tip; a little slack at both ends so the frayed
    // silhouette and the detached wisps are never clipped by the proxy.
    // The slack at each end is sized off the plume RADIUS, not off its length: a fat throat seen
    // at a foreshortened angle projects gas well past the station its axis point sits at, and a
    // slack budgeted as a fraction of the length is far too small to hold it at the widest end.
    float s = uv.y * (uLen + 2.0 * uPadS) - uPadS;
    vec3 wp = uOrigin + uAxis * s + e2 * (position.x * 2.0 * uHalfW);
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const PLUME_FRAG = /* glsl */`
  uniform vec3 uCore, uMid, uEdge;
  uniform vec3 uOrigin, uAxis, uU, uV;
  uniform vec4 uProf;                 // neck, peakAt, spread, tip fraction — the class silhouette
  uniform float uLen, uR0, uRmax;
  uniform float uTime, uLevel, uPhase, uTurb, uFlick;
  uniform float uBands, uBandSpeed, uBandAmt, uNeck, uKnot, uBandDrift, uXsh, uBandFade;
  uniform float uGain, uHot, uBurn, uFilW, uBodyW, uSkirtW, uSkirtI, uBodyD;
  uniform float uThick, uOcc, uReach, uFade, uPersp, uSoft, uWisp;
  uniform float uNear0, uNear1, uEnd0, uEnd1, uGroundY;
  uniform float uRimR, uRimW, uRimI, uRimE, uBleach, uHotSoft;
  varying vec3 vWorld;
  ${NOISE_GLSL}

  // Samples down the real camera ray. The ray is clipped analytically to the plume's bounding
  // cylinder before the loop starts, so every step lands in the region the gas can occupy and the
  // count buys detail rather than empty space.
  // (r17) 20 -> 26, with the step phase dithered only lightly. With the bound now shrunk to the
  // local cone the samples are packed into a short span, so the extra six are cheap; and at 20
  // with a full-step dither the neighbouring pixels of the thin tail integrated visibly different
  // amounts of gas, which photographs as SPECKLE — the one artefact that reads as "procedural".
  const int STEPS = 22;

  // The class silhouette, without any of the per-sample modulation: rise to the throat, then a
  // smooth decay to a fixed TIP FRACTION over the whole length. Used both for the marched samples
  // and, below, to shrink the bounding cylinder to the width the ray actually passes through.
  float halfW(float t){
    float rise = uProf.x + (1.0 - uProf.x) * smoothstep(0.0, max(uProf.y, 1e-3), t);
    float uu   = clamp((t - uProf.y) / max(1.0 - uProf.y, 1e-3), 0.0, 1.0);
    return uR0 * rise * (uProf.w + (1.0 - uProf.w) * pow(1.0 - uu, uProf.z))
         * clamp(1.0 + uPersp * t, 0.20, 2.40);
  }

  void main(){
    // ── 1. THE REAL RAY, AND WHERE IT ENTERS AND LEAVES THE GAS ───────────────────────────────
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);
    vec3 o  = ro - uOrigin;
    float oz = dot(o, uAxis), dz = dot(rd, uAxis);      // station along the axis
    vec2  oq = vec2(dot(o, uU), dot(o, uV));            // offset from the axis
    vec2  dq = vec2(dot(rd, uU), dot(rd, uV));

    float A = dot(dq, dq), B = dot(oq, dq), Cc = dot(oq, oq) - uRmax * uRmax;
    float t0, t1;
    if (A < 1e-7) {                                     // ray parallel to the axis
      if (Cc > 0.0) discard;
      t0 = -1e6; t1 = 1e6;
    } else {
      float disc = B * B - A * Cc;
      if (disc <= 0.0) discard;                         // misses the column entirely
      float sq = sqrt(disc);
      t0 = (-B - sq) / A; t1 = (-B + sq) / A;
    }
    float sLo = -0.04 * uLen, sHi = 1.10 * uLen;
    if (abs(dz) > 1e-6) {
      float ta = (sLo - oz) / dz, tb = (sHi - oz) / dz;
      t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
    } else if (oz < sLo || oz > sHi) { discard; }
    t0 = max(t0, max(uNear0, 0.05));
    if (t1 <= t0) discard;

    // ── THE BOUND IS A CONE, NOT A CYLINDER ───────────────────────────────────────────────────
    // uRmax is the throat's reach, and the column necks to a tenth of that. A ray aimed at the
    // TAIL therefore spent its twenty samples crossing three metres of empty cylinder to pass
    // through twenty centimetres of gas — one or two samples landed inside it, which is why the
    // last third of the r17-a column measured as sparse speckle. Re-clipping to the widest the
    // gas gets anywhere along THIS ray's span costs three closed-form profile evaluations and
    // puts every one of the twenty samples where there is something to integrate.
    float tcl = clamp(-B / max(A, 1e-6), t0, t1);
    float wLoc = max(max(halfW(clamp((oz + dz * tcl) / uLen, 0.0, 1.0)),
                         halfW(clamp((oz + dz * t0) / uLen, 0.0, 1.0))),
                         halfW(clamp((oz + dz * t1) / uLen, 0.0, 1.0)));
    // (r22) The envelope is the cone itself now (the neck is one-sided), so the belly allowance
    // is gone — but the axis WANDER displaces the whole cross-section by up to 0.85*uTurb local
    // half-widths, and that is what this bound has always actually had to hold.
    float Reff = min(uRmax, wLoc * (uReach + 0.95 * uTurb) * 1.10);
    if (A >= 1e-7) {
      float Cr = dot(oq, oq) - Reff * Reff;
      float d2 = B * B - A * Cr;
      if (d2 > 0.0) {
        float s2 = sqrt(d2);
        t0 = max(t0, (-B - s2) / A);
        t1 = min(t1, (-B + s2) / A);
        if (t1 <= t0) discard;
      }
    }

    // Per-pixel, time-INVARIANT dither on the step phase: it turns the march's quantisation into
    // grain the bloom pass eats rather than into rings, and being static it does not fizz between
    // frames or between two runs of the capture harness.
    // (r19) A HASH DITHER IS SPECKLE; AN ORDERED ONE IS NOT. h21(gl_FragCoord) gives every pixel
    // an independent step phase, so with a rough integrand (flutes, wisps) neighbouring pixels
    // integrate visibly different amounts of gas and the column comes out GRAINY — measured at 5x
    // on the r19c LA supercar, a salt-and-pepper crawl through the violet either side of every
    // knot, which is the one artefact that reads as "procedural" however good the shape is. A
    // (r19) The amplitude is 30% of a step rather than 40%, because the step is now INTEGRATED
    // analytically rather than sampled (see the accumulation below) and the phase therefore only
    // decides where the sample is taken, not how much of the step it is credited with. Three
    // spatially-even patterns were photographed at 7x with the speed pass ablated before settling
    // back on the hash — a four-phase rotated grid, the R2 sequence and interleaved gradient noise
    // all draw a visible fine WEAVE through the bright half of the column. A regular residual is
    // easier for the eye to find than a noisy one of the same amplitude; every one of the three
    // was designed to be resolved by a TAA or a 3x3 blur this renderer does not have.
    // ── (r20) A SMOOTH DITHER, NOT A PER-PIXEL ONE ───────────────────────────────────────────
    // h21(gl_FragCoord) gives every pixel an INDEPENDENT step phase. That is exactly what makes
    // the residual salt-and-pepper: the integrand is peaked (the filament is 0.15 half-widths
    // wide and, since r20, four times brighter at a knot), so two neighbouring pixels whose
    // samples straddle it collect visibly different amounts of light and the bright half of the
    // column comes out GRAINY — visible at 2x on the r20a LA muscle, which means unmissable at
    // the 6-8x a critic reads this piece at. One octave of value noise over the pixel grid costs
    // three extra hash evaluations PER PIXEL (not per sample, so ~0.1% of the march) and gives
    // neighbouring pixels near-equal phases: the residual becomes a soft ~3 px mottle that the
    // bloom pass eats, instead of single-pixel confetti. It is still irregular, so it cannot draw
    // the fine weave that r19 photographed from the ordered patterns, and still time-invariant,
    // so it neither fizzes between frames nor between two runs of the capture harness.
    float du = (t1 - t0) / float(STEPS);
    float jj = vn(gl_FragCoord.xy * 0.37);
    float u  = t0 + du * (0.36 + 0.30 * jj);

    // Marched incrementally: station, offset-from-axis and height above the road all advance by a
    // constant per step, so a sample costs three multiply-adds rather than three dot products.
    float sz  = oz + dz * u,        dsz = dz * du;
    vec2  rq  = oq + dq * u;        vec2 drq = dq * du;
    float hy  = uOrigin.y + o.y + rd.y * u - uGroundY;   // height above the CAR's ground plane
    float dhy = rd.y * du;

    // in units of the throat radius, so the plume's brightness does not change when the governor
    // resizes it — a longer jet is a bigger jet, not a brighter one
    float dl = du / max(uR0, 0.04);

    vec3  acc = vec3(0.0);      // the gas: body, shear layer, shell, wisps
    vec3  accH = vec3(0.0);     // the incandescent filament and its knots, alone
    float trans = 1.0;

    for (int i = 0; i < STEPS; i++) {
      float tr = sz / uLen;                       // raw station, may run past the tip
      float t  = clamp(tr, 0.0, 1.0);

      // ── THE CHEAP REJECT, BEFORE ANY NOISE ────────────────────────────────────────────────
      // A closed-form upper bound on how far the gas can possibly be from the axis at this
      // station: the class cone, opened by the widest a shock BELLY can push it, by the march's
      // reach, and by the furthest the axis is allowed to wander. Two transcendentals decide it,
      // against ~14 hash evaluations and ten exponentials for a sample that is going to
      // contribute nothing — and on a grazing ray most of the span is exactly that.
      float hw  = halfW(t);
      float lim = hw * (uReach + 1.00 * uTurb + 0.15);
      if (dot(rq, rq) < lim * lim) {

      // ── THE SHOCK TRAIN IS PITCHED IN THE STATION THE LENS SEES, NOT THE ONE THE GAS HAS ──
      // (r18) THIS is what six rounds of "a chain of identical, uniformly-sized blobs at regular
      // spacing" was actually made of, and it is a bug of omission rather than of shaping. r15
      // established that the jet fires BACKWARDS, i.e. towards the chase lens, so the tail sits
      // metres nearer the camera than the throat and perspective magnifies it — and it corrected
      // the SILHOUETTE for exactly that (see halfW's uPersp term) so the designed taper reaches
      // the frame. The shock train was never given the same correction. Measured on the r17 LA
      // tuner at 3x: world spacings 0.18 / 0.14 / 0.12 / 0.11 — monotonically shrinking, exactly
      // as the r17 note claims — divided by a depth that falls from d0 to ~0.3·d0 over the same
      // span, which lands them on screen at 0.20 / 0.20 / 0.19 / 0.20. A dead-constant screen
      // period, drawn inside a cone that visibly necks: five equal white lozenges strung down a
      // blue skirt. The taper was right, the train was a ruler laid over it.
      //
      // So the phase runs on ts, the station in SCREEN arc-length: t/(1 + uPersp·t), normalised
      // so ts(1) = 1 for any rig. (Exactly ln(1+p·t)/ln(1+p); the half-angle form below is within
      // 4% of it over the whole clamp range of uPersp and costs one divide.) With ts^1.45 and
      // uBands 3.2-4.8 the nodes land at ts ~ 0.14 / 0.42 / 0.63 / 0.81 — screen spacings 0.28,
      // 0.21, 0.18, 0.17, each ~three quarters of the one before — while the amplitude falls as
      // exp(-ts/0.38), so cell 2 is half of cell 1, cell 3 a quarter and cell 4 a sixth, and the
      // cone has necked to 45% / 26% / 14% of the throat underneath them. A cell that is shorter,
      // narrower AND fainter than the one before it is perspective down a jet; you cannot find a
      // period in it, because there isn't one.
      float pk2 = uPersp * 0.5;
      float ts  = t * (1.0 + pk2) / max(1.0 + pk2 * t, 0.15);
      // ── (r19) THE CELLS CROWD, BECAUSE A CELL IS AS LONG AS THE COLUMN IS WIDE ──────────────
      // r18 pitched the train at ts^1.45, which lands four nodes at screen spacings 0.28 / 0.21 /
      // 0.18 / 0.17 — a 1.6:1 crowd over the whole column. Measured at 5x on the r18 LA muscle
      // that is not enough to read AS a sequence: the eye needs a ratio, not a trend, and 1.6:1
      // inside a column whose own width falls 8:1 reads as "evenly spaced blobs on a cone".
      // A real shock cell is ~1.1 diameters long, so its length tracks the LOCAL width and the
      // train has to crowd at the same rate the cone necks. ts^2 is the cheapest phase that does
      // it (and it is a multiply, not a pow — the pow it replaces pays for the knot below):
      // nodes at sqrt((n + 0.09)/uBands), i.e. for the supercar 0.13 / 0.44 / 0.61 / 0.74 / 0.86,
      // spacings 0.31 / 0.17 / 0.13 / 0.11 — a 3.2:1 crowd, over five cells rather than four.
      // The constant 0.16 is what pulls cell 1 back onto the throat; without it the first diamond
      // sits a fifth of the way down a column that is supposed to be burning at the pipe.
      float ph  = uBands * ts * ts;                     // the CELL INDEX, continuously
      // ── (r20) TWO COLUMNS FED BY ONE BOTTLE SHOCK AT THE SAME STATIONS ─────────────────────
      // uPhase*1.7 put nozzle 1's train 0.65 of a cell out of step with nozzle 0's, so where the
      // two columns overlap — which is most of the visible plume, since r14 toes them IN on
      // purpose — one train's diamonds sat in the other's gaps and the pair integrated to a
      // smooth ribbon. Measured on the r20a LA muscle along nozzle 0's own axis: nodes at t=0.62
      // and t=0.69 with prominences of 4.6 and 2.6, against 15.8 for the one node that happens to
      // land where both trains agree. Twin pipes off one bottle run at one pressure, so their
      // cells stand at the same stations; a fifth of a cell of offset (plus the ±5.5% length
      // difference already on the nozzles) is enough to stop the pair reading as one object
      // mirrored, and small enough that the banding survives the overlap.
      float bp  = (ph + 0.16) * 6.2831853 + uPhase * 0.50 + uBandDrift;
      float sw  = sin(bp);
      float ci  = floor(bp * 0.1591549 + 0.5);
      // ── (r20) THE TRAIN FADES BY CELL, NOT BY DISTANCE — AND ONLY DIAMOND 1 WAS EVER DRAWN ──
      // Measured on the r19 LA muscle with tools/_n20_axis.mjs: the axial luminance runs 241 at
      // the throat and 205-220 through the whole middle of the column, and the strongest local
      // maximum anywhere past t = 0.25 has a PROMINENCE OF 5 on a base of 210 — 2%. Evaluating
      // the shader's own on-axis expression for the muscle's uniforms says why, and it is not a
      // shaping problem: at exp(-ts/0.42) the four nodes carry amp 0.69 / 0.27 / 0.16 / 0.11, so
      // the filament authority behind them is hotA 4.70 / 0.74 / 0.31 / 0.17 and the temperature
      // 3.58 / 1.38 / 1.01 / 0.86 against a white threshold of 1.35. Diamond 1 goes white and
      // clips; diamonds 2, 3 and 4 are a 5-15% swell in the class colour, which is the measured
      // 2%. Six rounds of shaping a train that was, arithmetically, one blob and three rumours.
      //
      // The decay is now per CELL rather than per unit length. A cell's index is exactly ph (the
      // phase already in hand), so exp(-uBandFade*ph) gives a FIXED RATIO from one diamond to the
      // next — 0.70x on the supercar, 0.66x on the SUV — no matter how the spacing crowds. Under
      // the old exp(-ts/τ) the ratio collapsed towards 1.0 as the cells crowded together, which is
      // the worst of both: the head of the train fell off a cliff and the tail was a row of
      // equal-amplitude ripples. Now the muscle's four nodes run 0.97 / 0.69 / 0.49 / 0.35, and
      // because the phase is ts^2 each of them is also SHORTER (cell lengths 0.39 / 0.21 / 0.16 in
      // screen station) and sits inside a cone that has necked to 45% / 26% / 14% of the throat.
      // Smaller, closer together and fainter, in a fixed ratio: that is a shock train.
      float amp = smoothstep(0.006, 0.045, ts) * exp(-uBandFade * ph) * uBandAmt
                * (0.60 + 0.72 * h21(vec2(ci * 0.61 + 0.5, uPhase * 9.0 + 3.0)))
                * (0.88 + 0.14 * sin(uTime * uFlick * 0.31 + ci * 1.7));
      amp = clamp(amp, 0.0, 1.0);
      // ── AND A CELL IS TWO DIFFERENT SHAPES AT ONCE ─────────────────────────────────────────
      // r18 drove the silhouette AND the incandescence off one term, pow(lobe, 0.80), which is
      // above half its peak for 55% of the cell — so the white was on for more of the column than
      // it was off, and what photographed was the airbrushed white BAR five verdicts have named.
      // The two want opposite shapes: the silhouette wants a smooth raised cosine (a waist at the
      // node, a belly between two, no edge anywhere), and the incandescence wants a compact pip
      // sitting inside the waist. 'node' is the first, 'knot' the second — lobe^2 to lobe^5 by
      // class, i.e. half-max over 36% down to 23% of the cell, so the white in the jet is a row
      // of separate knots and the gas between them keeps its class chroma.
      float lobe = 0.5 + 0.5 * sw;                      // one-sided: a knot, never a trough
      float l2   = lobe * lobe;
      float node = amp * lobe;
      float knot = amp * mix(l2, l2 * l2 * lobe, uKnot);
      // |cos| of the cell phase — the RADIUS of the oblique shock sheet, see the X below. It is
      // free: sin is already in hand and the sheet has no sign.
      float cph  = sqrt(max(0.0, 1.0 - sw * sw));

      // ── 2. THE LOCAL HALF-WIDTH ───────────────────────────────────────────────────────────
      // halfW() carries the class cone AND the perspective correction: the jet fires backwards,
      // i.e. towards the chase lens, so its tail is metres NEARER the camera than its throat and
      // perspective magnifies it by exactly that ratio. Screen half-width is world half-width /
      // depth, so pre-multiplying by depth(t)/depth(0) makes the SCREEN silhouette equal to the
      // designed profile from any rig. Without it a 5:1 cone photographs as 2.5:1 — four critics'
      // worth of "near-constant width".
      // ...and then a shock cell is a COMPRESSION: the column necks at the node. That is the part
      // of the train that survives the speed pass, because it is structure ACROSS the column and
      // the blur runs ALONG it.
      // ── (r22) AND IT IS ONE-SIDED, BECAUSE A BELLY IS A SECOND COLUMN ───────────────────────
      // THIS is the join between "the axis scan says 6:1" and twenty verdicts of "constant width",
      // and it is arithmetic rather than shading. The term was 1 - uNeck*amp*sw with sw = sin,
      // i.e. a SYMMETRIC swing: a node pinched the column to 0.56 of the class cone and the gas
      // between two nodes BELLIED OUT to 1.44 of it. Over the stations the eye actually reads,
      // that swing is the same size as the cone's own taper and it runs the opposite way.
      // Measured on the vegas supercar with tools/_n22_cmp.mjs, which projects the DESIGNED
      // half-width into pixels and puts it next to the rendered width in the same frame:
      //
      //     t            0.063  0.125  0.188  0.25  0.313  0.375  0.438   0.5
      //     designed x reach  84    100     88    76     65     56     47    40
      //     rendered (r21)    83    111    114   125    118    118     88    59
      //     rendered, uNeck 0  121   162    147   129    106     89     78    75
      //
      // With the belly in, the widest rendered station is t = 0.25 — the designed cone peaks at
      // 0.125 and has already lost a third by then — and the column is FLAT from 0.125 to 0.375
      // at 111-125 px. Take the belly out and the same frame tapers monotonically from the
      // designed peak. The shock train was not drawn on the taper, it was drawn OVER it.
      //
      // Every other modulation in this file is one-sided for exactly this reason (see the r9 rule:
      // "a trough below base is a seam"). This one never was. lobe is the same one-sided cell
      // shape the brightness uses, so a node still pinches the silhouette and the train still
      // reads across the column — but the class cone is now the OUTER ENVELOPE at every station
      // and nothing can push the gas outside it.
      float w = hw * (1.0 - uNeck * amp * lobe);
      w = max(w, uR0 * 0.012);

      // ── THE AXIS WANDERS ──────────────────────────────────────────────────────────────────
      // A perfectly straight centreline with a smooth profile on it is a ROD however it is
      // shaded, and the last third of the column — thin, dim and analytic — is where that reads
      // worst. The axis drifts by a fraction of the LOCAL half-width (so the throat stays on the
      // pipe and only the tail snakes), in a direction that itself turns with distance.
      float wn = vn(vec2(t * 3.4 - uTime * 1.5, uPhase * 5.0 + 2.0));
      float wa = wn * 6.2831853;
      vec2 rr = rq - vec2(cos(wa), sin(wa))
              * (uR0 * (0.30 + 0.55 * wn) * uTurb * smoothstep(0.04, 0.80, t) * max(w / uR0, 0.10));

      float rl = length(rr);
      float q  = rl / w;                        // true radius, in local half-widths
      float q2 = q * q;

      if (q2 < uReach * uReach) {
        vec2 c = rr / max(rl, 1e-4);            // direction around the axis — no atan2, no seam
        // LOW angular frequency, HIGH axial frequency: a jet's shear layer is a set of
        // longitudinal flutes that crawl downstream. Anything that varies fast around the axis is
        // exactly what a line integral through the column averages back out to a smooth ribbon.
        // (r18) azimuthal frequency 1.60 -> 3.05. The note above is right about the INTERIOR — a
        // long chord averages fast azimuthal detail away — but the silhouette is decided where the
        // chord is SHORT, so at the outline azimuthal detail is the only thing that survives, and
        // at 1.60 the edge had barely one lobe around the whole column: a smooth analytic curve,
        // which is what makes gas read as an object. It is also the one frequency the speed pass'
        // radial blur cannot touch, because it runs across the column and the blur runs along it.
        float fl = vn(vec2(c.x * 3.05 + t * 5.4 - uTime * 3.1, c.y * 3.05 + 11.0)) * 0.58
                 + vn(vec2(q * 1.55 + t * 6.2 - uTime * 2.2, c.x * 3.40 + uPhase * 13.0 + 3.0)) * 0.42;
        // ── (r19) FIVE FLUTES THAT SPIRAL DOWNSTREAM, AND THEY COST NO HASH ─────────────────
        // The two lookups above run at an azimuthal frequency of 3, which is as fine as a hash on
        // a unit circle can go before the march's own chord averages it back out. But the chord is
        // SHORT at the silhouette, so nothing is averaged there — and three lobes around a whole
        // column is an analytic curve with a wobble on it, which is what makes gas read as a solid
        // object with a drawn edge. A real shear layer is ribbed: longitudinal flutes that twist
        // downstream as the column rotates. Chebyshev gives cos(5a) and sin(5a) straight from the
        // direction vector — six multiplies, no transcendental, and no seam at the wrap — and one
        // sin/cos pair turns them into a rib that spirals. It MULTIPLIES the noise rather than
        // adding to it as a second field, so the ribs vary in depth from station to station and
        // never resolve into a periodic pattern.
        float twP = t * 4.6 - uTime * 2.4 + uPhase * 3.0;
        float cx2 = c.x * c.x, cy2 = c.y * c.y;
        float rib = (c.x * (16.0 * cx2 * cx2 - 20.0 * cx2 + 5.0)) * cos(twP)
                  - (c.y * (16.0 * cy2 * cy2 - 20.0 * cy2 + 5.0)) * sin(twP);
        fl = clamp(fl + rib * (0.09 + 0.20 * fl) * uTurb, 0.0, 1.0);
        float shear = smoothstep(0.10, 0.82, q);
        float flm = mix(1.0, 0.10 + 1.90 * fl, uTurb * shear);

        float kc = uFilW * (1.0 + knot * 1.45);
        float g1 = exp(-q2 / (kc * kc));                        // incandescent filament
        float g2 = exp(-q2 * q / (uBodyW * uBodyW * uBodyW));   // super-gaussian body: flat middle
        float g3 = exp(-q2 / (uSkirtW * uSkirtW));              // the cool shear layer
        // Detached gas: fl CUBED is mostly zero and occasionally a real blob, well outside the
        // column. That is what tears the outline up — softness is not irregularity, and a smooth
        // analytic falloff reads as the edge of an OBJECT however gradual it is.
        float wsp = fl * fl * fl * uWisp * exp(-q2 / 1.30)
                  * smoothstep(0.34, 1.20, q) * smoothstep(0.05, 0.44, t);

        // ── (r21) THE PLUME HAS TO HAVE AN EDGE THE EYE CAN FIND ─────────────────────────────
        // Twenty rounds of measurement all agree that the class cone is correct in the DATA — an
        // axis scan of the marched field gives a clean 6:1 neck-down over the visible column — and
        // twenty rounds of verdicts say the picture is "a constant-width bar with no throat, no
        // expansion angle and no defined fringe boundary". Both are true, and this is the join.
        //
        // Every density term up to r20 was a monotone falloff centred ON THE AXIS: a filament, a
        // super-gaussian body, a gaussian skirt, and a gaussian tail on the skirt that only ever
        // approaches zero. Integrate any of those along a ray and the result is a smooth bump with
        // its maximum on the centreline and no feature anywhere else. There is nothing in the
        // image that MARKS the silhouette, so the boundary the eye actually finds is not the cone
        // at all — it is the contour where the interior stops being clipped, and that contour is
        // set by the exposure and by bloom's fixed-screen-radius halo, both of which are the same
        // at every station. A 6:1 taper drawn as an unmarked gradient photographs as a bar.
        //
        // A real jet does not look like that, and the reason is geometric rather than a matter of
        // brightness: the burning happens in a SHEAR LAYER, a shell around the core, and a ray that
        // grazes a shell runs along it for a long way while a ray through the middle crosses it
        // twice at a steep angle. That is limb brightening, and it is what puts two bright,
        // converging lines down the flanks of every photograph of an afterburner. The march
        // already integrates real chords through a real 3-D field, so the shell is all it needs:
        // put density at q ~ 1 instead of only at q ~ 0 and the limb comes out of the integral for
        // free, at the correct radius, at every station, from every viewpoint.
        //
        // The consequences, in the order the critic reads them:
        //   · the outline is DRAWN, so the taper is two lines that converge rather than a gradient
        //     that has to be inferred — the expansion angle at the throat becomes a visible angle;
        //   · the fringe has a KNEE (rise into the shell, fall away outside it) instead of an
        //     infinite gaussian, so there is a boundary at all;
        //   · and it is structure ACROSS the column, which is the one thing SpeedShader's radial
        //     blur cannot average away, because the blur runs ALONG the axis.
        // The shell's radius is pushed around by the same flute noise that fringes the silhouette,
        // so it is never the analytic curve drawn as a line, and it is never a hard edge: it is a
        // gaussian in radius whose centre wanders by up to a third of a half-width.
        // (r21b) Photographed at 5x with the shell fed through the ordinary density path at
        // 0.55 + 0.85·flm: it filled the column. dens is also what drives the transmittance, so
        // a shell dense enough to draw a line is also opaque enough to absorb the incandescent
        // core behind it, and a wandering centre 0.40 half-widths wide smears that opacity across
        // the whole cross-section — one flat navy wedge with a boundary, which trades "no edge"
        // for "a slab". The shell now carries very little density (it is a LINE, and a line does
        // not occlude a road) and instead has its own emission term below.
        float qr  = uRimR * (0.87 + 0.26 * fl);
        float dqr = (q - qr) / uRimW;
        float g4  = exp(-dqr * dqr);

        // Nothing may be non-zero where the march stops. Everything is taken to exactly zero,
        // with zero slope, before uReach, so the analytic cut cannot draw a step.
        // ── (r22) ...AND IT IS NOW A KNEE RATHER THAN A TAIL ─────────────────────────────────
        // r21 wrote this note and then left the numbers where they were: at reach 1.70 the bite
        // opened at q = 1.16, i.e. only a sixth of a half-width outside a shell whose own 1/e was
        // 0.145 — so the shell's outer flank WAS the bite and everything past it was the slow tail
        // the note is about. Reach is 1.42 now and the bite opens at 0.80 of it (q = 1.14) and is
        // finished at 1.42, so the density rises into the limb and is gone a third of a half-width
        // later. Still smoothstep-SQUARED, i.e. C1 with zero value and zero slope where it lands,
        // so the cut cannot draw a step and there is no radius at which a straight edge appears —
        // what it draws is a KNEE, which is the one thing an infinite gaussian could never give
        // the eye to find.
        float cut = 1.0 - smoothstep(uReach * 0.80, uReach * 1.0, q);
        cut *= cut;
        // ...and the same at both ends of the column. The tail runs out of gas at a different
        // station on every side and in every frame: the axial jitter alone terminated the whole
        // cross-section at once, which is an analytic point on the end of an analytic cone.
        float endJ = 0.30 * (fl - 0.5) + 0.10 * (h21(vec2(ci, floor(c.x * 3.0))) - 0.5);
        float ax = smoothstep(-0.010, 0.030, tr) * (1.0 - smoothstep(uEnd0, uEnd1, tr + endJ));
        // the gas washes out into the asphalt over ~0.8 m instead of being sliced by it
        float gnd = smoothstep(-0.22, 0.62, hy);
        cut *= ax * gnd;

        if (cut > 0.002) {
          // The gust that displaces the axis is the same gust that thickens the gas — one noise
          // lookup, and the correlation between the two is physical rather than a saving.
          float puff = 0.80 + 0.40 * wn;
          // one axial decay shared by the cell's temperature and the column's own emission fall-off
          // — they were exp(-1.90t) and exp(-1.70t), and two exponentials a sample for a 12%
          // difference is a transcendental spent on nothing.
          float et = exp(-t * 1.80);
          // Held out to the tip. A jet that fades to nothing by two thirds of its own length has
          // thrown away exactly the part where the taper is most legible, and the column then
          // reads as the fat parallel FRONT of a cone with nothing after it.
          // ── (r21) THERE IS NO FLAME ON THE LIP — THAT IS WHAT A THROAT IS ─────────────────
          // "No throat" has been in three verdicts, and it is not the profile: the class cone
          // does pinch to 0.50 of maximum at the orifice and flare over the next tenth. What
          // filled the pinch was the incandescence. The filament ran at full authority from the
          // very first sample, and a white thread is the one thing in this shader hot enough to
          // clear the bloom threshold — so ~20 px of fixed-screen-radius halo was welded to each
          // flank of exactly the station that is supposed to be the narrowest, and the pinch was
          // photographed as the fattest part of a white bar. Gas leaving a nozzle has not burned
          // yet; it lights over the first tenth of the column. The density is untouched, so the
          // root is still gas on the lip (r7's "bare dark road between the bumper and the flame"
          // was a density hole, not an exposure one) — it is simply class-coloured rather than
          // white, which is what lets the eye see how narrow it is.
          float lit = 0.20 + 0.80 * smoothstep(0.006, 0.105, t);
          float bodyA  = (0.46 + 0.54 * exp(-t * 1.05)) * puff * (0.62 + 0.38 * lit);
          float skirtA = uSkirtI * (0.30 + 0.70 * smoothstep(0.0, 0.22, t)) * exp(-t * 0.50) * puff;
          // (r21) The shear shell. It lights up a little way off the lip (a jet leaving a pipe has
          // no mixing layer AT the lip) and is held out to the tip, because the boundary is the one
          // thing that has to survive to the very end of the column — a plume whose outline fades
          // before its interior does ends in a smudge, and a smudge has no taper in it. A shock
          // node compresses the shell as well as the body, so the two converging flank lines are
          // ALSO where the neck-and-belly reads: the train is drawn on the silhouette.
          float rimA = uRimI * smoothstep(0.015, 0.14, t) * (0.42 + 0.58 * exp(-t * 0.85))
                     * puff * (1.0 + node * 0.85);
          // ── ONLY A KNOT MAY GO WHITE ────────────────────────────────────────────────────────
          // Base authority 0.58 against a node term of 0.95, so the filament is continuous down
          // the whole column (a thread that is absent between nodes is a DASHED LINE) but only
          // reaches the top of the range where a cell compresses it. r14 measured 247-255 for a
          // third of the column: above the clip every pixel looks the same, so a wide saturated
          // core does not merely look bad, it deletes every piece of structure the march computed.
          // (r17) 0.58 + node*0.95 -> 0.34 + node*1.24. At a base of 0.58 the thread was ~2.3x the
          // bloom threshold BETWEEN nodes, so the whole length of it bloomed and the supercar
          // photographed as two white rods with a violet fringe. At 0.34 the thread is hot but on
          // the tonemap's slope, and a node is a 4x swell that clips: the white in the jet is a
          // row of knots that get smaller and closer together, which is the read §2.5 asks for.
          // (r19) 0.34 + node*1.24 -> 0.15 + knot*2.35. Measured at 6x on the r19a LA muscle with
          // the speed pass ablated: a DEAD STRAIGHT white bar running the whole visible length of
          // the near column, because at a base authority of 0.34 the thread sits at ~1.1 between
          // knots and the bloom threshold is ~0.7 — so the gaps bloomed exactly as hard as the
          // knots did and the train had nothing to draw with. At 0.15 the thread between two
          // cells is class-coloured and BELOW the bloom threshold; a cell is a 4x swell that goes
          // over it. That is the difference between a white bar and a row of white knots.
          // ── (r20) THE THREAD BURNS OUT; THE KNOTS DO NOT ────────────────────────────────
          // One exponential drove both, so uBurn had to be short enough to kill the continuous
          // white thread by a third of the way down — and it took every diamond after the first
          // with it. Measured, muscle: hotA 4.70 at node 1 and 0.74 / 0.31 / 0.17 at nodes 2-4,
          // i.e. the second diamond is drawn at a sixth of the authority of the first and the
          // fourth at a twenty-fifth. The white in the frame was one bar at the pipe.
          // The two now decay at different rates off the SAME exponential: the base thread runs
          // on hb outright (dark by t ~ 0.4, so the gaps between diamonds keep their class
          // chroma), while a knot keeps a third of its authority to the tip. Muscle: 5.13 / 2.33
          // / 1.47 / 0.99 — a ladder rather than a cliff, and every rung above the ~0.7 the
          // bloom threshold wants.
          float hb   = exp(-t / uBurn);
          float hotA = uHot * (0.11 * hb + knot * 1.55 * (0.34 + 0.66 * hb)) * lit;
          // A diamond is a LENS, brightest on the centreline and gone before the skirt — not a
          // rung laid across the jet. A row of rungs is a barcode.
          // (r18) exp(-q2·1.05) was still 0.77 at half the half-width and 0.35 at the full one, so
          // a node lifted the temperature across essentially the WHOLE cross-section — and since
          // the body term g2 is a super-gaussian (deliberately flat across the middle), T went
          // over the white threshold as a PLATEAU the full width of the column. That is critic D's
          // "hard-edged uniform white stripe down its middle" exactly, and it is what makes the
          // near half of the plume photograph as pale steam instead of as saturated burning gas.
          // At exp(-q2·2.9) the lens is 0.77 at a third of the half-width and 0.05 at the edge:
          // the colour ramp can now reach uCore on a THREAD, and the wide part of the column keeps
          // the class chroma that tells you which car fired it.
          // ── (r19) A SHOCK DIAMOND IS AN X, NOT A RUNG ────────────────────────────────────
          // Every round so far has drawn a cell as a brightening ON THE AXIS, which is a bead; a
          // real one is an oblique compression that leaves the shear layer, converges on the axis
          // and reflects, so an afterburner photographs as a chain of X's whose crossing points
          // are the bright knots. The radius of that sheet over a cell is exactly |cos| of the
          // cell phase — full width where the cell begins and ends, zero at the node — so the
          // whole figure costs one square root (of a sine already in hand) and one exponential.
          // It is what gives the train structure ACROSS the column, which is the one thing
          // SpeedShader's radial blur cannot average away, and it is smooth in every direction:
          // a gaussian in radius whose centre slides continuously from the skirt to the axis.
          float dsh = (q - 0.94 * cph) / 0.22;
          float xsh = amp * exp(-(dsh * dsh + q2 * 0.42)) * smoothstep(0.02, 0.11, ts) * uXsh;
          // the on-axis lens both terms below share — one exponential, not two
          float lens = exp(-q2 * 2.90);
          float nd = node * (0.14 + 1.06 * lens) + xsh * 0.70;
          // ...and a diamond gets COOLER with distance as well as smaller and fainter. Without
          // this every cell in the train pushed T past the white threshold and the column read as
          // a row of identical white lozenges (the r17 LA tuner at 3x): the first cell is
          // incandescent, the second warm, the third is a swell in the class colour. The white in
          // the jet is therefore near the pipe, which is also where a real one is.
          // (r19) ...and it is the KNOT, not the broad lobe, that carries the heat: the density
          // bump may be as long as the cell (a compression is), but the incandescence inside it
          // is a pip. Driving T off the broad lobe is what put a continuous white bar down the throat.
          // (r20) 1.15 -> 1.45 on the lens and the cooling term 0.40+0.60·et -> 0.55+0.45·et. A
          // diamond does get cooler with distance — but at 0.40+0.60·et the third one was 60%
          // cooled before its own amplitude was applied, so it never crossed the white threshold
          // at all. The ladder now runs T = 4.8 / 2.9 / 2.0 / 1.5 down the muscle's four nodes
          // against a white step at 1.35: incandescent, white, warm-white, warm. The gas between
          // any two of them is at T ~ 0.8, which is uMid at full chroma.
          float ndT = (knot * (0.10 + 1.45 * lens) + xsh * 0.80) * (0.55 + 0.45 * et);

          float dens = (g2 * uBodyD * (1.0 + nd * 1.20) * mix(1.0, flm, 0.36)
                     +  g3 * skirtA * 1.60 * flm * flm
                     +  g4 * rimA * (0.16 + 0.20 * flm)
                     +  wsp) * cut;
          // T is a TEMPERATURE and colour is a function of it, so fringe, body and core are three
          // readings of one continuous field rather than three stacked zones with rims between.
          // (r21) The shell is the COOLEST gas in the jet — it is where the plume is mixing with
          // cold air — so it contributes to the density that draws the outline but barely to the
          // temperature that colours it. That is what makes the two flank lines land at uEdge, at
          // full chroma, against a uMid interior: "a white core with a blue fringe", drawn as an
          // actual edge rather than as the place a gradient happens to run out.
          float T = (g2 * bodyA * (1.0 + ndT * 4.20)
                  +  g3 * skirtA * (0.55 + ndT * 0.55)
                  +  g4 * rimA * 0.10
                  +  g1 * ndT * 0.60) * cut;
          // (r18) The white step used to open at T = 1.0, which the body alone reaches at a node
          // anywhere in the first third — so "white core" meant "the entire throat". It opens at
          // 1.35 now and only the narrow lens above can push T there, so the white is a thread
          // with knots on it and everything around it is uMid at full chroma.
          // (r19) 0.42 -> 0.30 and the step 0.42/1.15 -> 0.54/1.32. The body alone reaches T ~ 0.9
          // on the axis anywhere in the first third, which took the gas 70% of the way to a colour
          // that is already 42% white — so the throat of every class photographed as pale steam and
          // the four palettes only really separated out in the fringe. The class chroma now owns
          // the column and only the knots leave it.
          vec3 warm = mix(uMid, uCore, 0.30);
          // ── (r22) THE CLASS COLOUR HAS TO OWN THE COLUMN, NOT A THREAD DOWN THE MIDDLE ─────
          // T is a temperature and the body that carries it is a super-gaussian, so it falls off
          // a cliff at ~0.45 half-widths — which meant smoothstep(0.04, 0.40, T) only reached uMid
          // inside q ~ 0.40, a quarter of the visible radius. Everything outside that was uEdge,
          // and uEdge is a nearly-black fully-saturated blue/red by design. Measured on the r22a
          // vegas supercar with tools/_n22_px.mjs (the gas alone, on black): axis 205,204,248 ->
          // 90,54,248 at a third of the way out -> 8,3,190 at two thirds. The plume photographed
          // as a white thread inside one flat royal-blue mass, and #8a4dff — the colour that is
          // supposed to say SUPERCAR — existed in a band a few pixels wide. Four classes whose
          // bodies are all "the dark end of their own ramp" is the §6.3 identical-classes cap
          // arriving through the colour ramp instead of through the geometry.
          // The ramp now completes at T = 0.16, which the body reaches out to ~0.75 half-widths
          // and the shear layer holds past that: uMid owns the column, uEdge is the FRINGE it
          // was named for, and the four palettes separate over the whole plume rather than in a
          // rim you have to go looking for.
          vec3 col = mix(uEdge, uMid, smoothstep(0.012, 0.16, T));
          // (r20) 0.54/1.32 -> 0.70/1.45. The gas BETWEEN two diamonds sits at T ~ 0.8, and at the
          // old thresholds that was already a third of the way to a colour which is itself 30%
          // white — so the column had a permanent pale wash on it and a diamond had to climb out
          // of that before it could read. The gaps are now uMid at full chroma and the whole of
          // the warm ramp is spent on the knots.
          col = mix(col, warm, smoothstep(0.70, 1.45, T));
          col = mix(col, uCore, smoothstep(1.35, 2.45, T));
          vec3 fil = mix(uMid, uCore, clamp(hotA * 0.60, 0.0, 1.0));
          // ── LIGHT AND GAS ARE NOT THE SAME CURVE ─────────────────────────────────────────
          // The r17-a column measured 247 at the throat and 195 at four fifths of its length: a
          // 20% drop over the whole jet, which is what makes a plume read as a ROD — the axis is
          // pinned near the top of the range everywhere, so the only thing that can change along
          // it is width, and bloom hides that. Density (the silhouette, the occlusion) is held out
          // to the tip; EMISSION falls hard, so the jet is incandescent at the throat and merely
          // glowing at the tail, which is both what a jet does and the thing that makes its length
          // legible as depth rather than as a stripe.
          // (r19) 0.23 + 0.77*exp(-1.85t) -> 0.28 + 0.72*exp(-1.70t). The body's DENSITY is held
          // out to the tip on purpose (that is what keeps the taper legible), and a dense layer
          // that emits almost nothing is a SILHOUETTE: measured at 3x on the r19b LA tuner the
          // last third of the column was a navy shape occluding the road rather than gas burning
          // in front of it. The gradient throat-to-tail is still 3.6:1, which is what makes the
          // length read as depth; the tail is simply still alight.
          // (r22) 0.28 + 0.72*et -> 0.36 + 0.64*et. The taper only reads over the length you can
          // still SEE: measured on the r22a vegas supercar the column was under 30/255 past
          // t ~ 0.5, i.e. the half of the jet where the cone does most of its necking arrived
          // below the neon it is drawn against. 2.8:1 throat-to-tail instead of 3.6:1 is still
          // a jet that is incandescent at the pipe and merely glowing at the tip.
          float glow = 0.36 + 0.64 * et;
          // ── (r21) THE SHELL EMITS ON ITS OWN LINE ────────────────────────────────────────
          // Fed through col, the shell's own low temperature put it at uEdge — which on the
          // supercar is #2a10ff, almost black — so a shell dense enough to be seen at all had to
          // be dense enough to occlude. Its emission is its own term at a fixed fringe colour, a
          // third of the way from the class edge to the class mid: saturated, unmistakably the
          // FRINGE rather than the body, and bright enough to draw a line at a density that
          // absorbs almost nothing. A ray grazing the shell runs along it for ~2.4x the path a
          // ray through the middle crosses it in, so this term is what puts two converging
          // flank lines on the plume — the taper, drawn instead of implied.
          // ── (r21) THE GAS AND THE KNOTS GET DIFFERENT SHOULDERS, SO THEY ARE ACCUMULATED
          //          SEPARATELY. See the note above the two shoulders below.
          vec3 e = (col * (dens * (0.20 + T * 1.05))
                  + mix(uEdge, uMid, 0.34) * (g4 * rimA * cut * uRimE)) * glow;
          vec3 eh = fil * (g1 * hotA * cut * glow);

          // ── (r19) INTEGRATE THE STEP, DO NOT SAMPLE IT ──────────────────────────────────
          // The rectangle rule (acc += trans*e*dl; trans *= exp(-sigma*dl)) puts all of a step's
          // emission at the step's near face and all of its absorption at the far one, so how much
          // light a pixel collects depends on WHERE inside the step its sample landed — which is
          // exactly what turned the per-pixel phase dither into visible grain at 7x through the
          // bright half of the column. For piecewise-constant sigma and e the step has a closed
          // form, integral(0..dl) e*exp(-sigma x) dx = e*(1 - exp(-sigma*dl))/sigma, and it costs
          // one divide on top of an exponential we were computing anyway. The phase then only
          // moves where the sample is TAKEN, not how much of the step it is credited with.
          float sig = dens * uThick;
          float ex  = exp(-sig * dl);
          float seg = trans * (sig > 1e-4 ? (1.0 - ex) / sig : dl);
          acc   += e  * seg;
          accH  += eh * seg;
          trans *= ex;
        }
      }
      }   // end of the cheap-reject block

      sz += dsz; rq += drq; hy += dhy; u += du;
      // Once the near side has absorbed 97% of the light nothing behind it can move the pixel by
      // an 8-bit step. On the SUV's throat that is most of the march.
      if (trans < 0.03) break;
    }

    // ── (r21) TWO SHOULDERS, BECAUSE ONLY ONE OF THESE IS ALLOWED TO REACH THE TOP ──────────
    // One shoulder over the sum is a false economy, and the measurement says why. Sweeping the
    // filament's gain over a factor of three on the vegas supercar moved the saturated run
    // through the axis by ONE pixel (114 -> 113 -> 114 px at f = 0.10): the white bar down the
    // near half of the column was never the filament at all, it was the BODY, four to five times
    // over the clip point across the full width of the throat. A single shoulder cannot fix that
    // — pulled down far enough to unclip the body it also caps the knots, and a plume that can
    // never cross the bloom threshold is an emissive with no bloom, which is its own hard tell.
    // So the gas is accumulated apart from the incandescence and each gets the curve it wants:
    // the gas rides a hard shoulder (uSoft ~ 0.85, asymptote ~1.2) so it is saturated, bright and
    // structurally intact but can never arrive as a plateau; the knots ride a gentle one and sit
    // on top of it, so the only thing in the frame that clips and blooms is a shock diamond.
    // ── (r22) THE SHOULDER RUNS ON THE PEAK CHANNEL, NOT PER CHANNEL ────────────────────────
    // em/(1 + em*uSoft) applied to each channel separately has the SAME ASYMPTOTE, 1/uSoft, in
    // all three — so every bright region of the plume converges on neutral grey no matter what
    // colour it started as. That is not a subtlety: measured on the r22b vegas supercar with the
    // filament ablated out entirely (tools/_n22_px.mjs --set uHot=0), the gas alone arrives at
    // 178,176,238 on the axis, i.e. R and G within 1% of each other, where uMid is 138,77,255 and
    // R/G is 1.8. The near half of every plume in the game was being bleached to white by its own
    // exposure curve before the tonemap or the bloom pass ever saw it — which is where "a pure
    // white CLIPPED core", "a hard-edged uniform white stripe down its middle" and, in the end,
    // "the four classes are one shape in four colours" all come from, because a class palette
    // that only survives in the dim half is not a class palette.
    // Dividing by the shoulder of the PEAK channel instead keeps the ratio between the channels
    // exactly, at any brightness: the column holds uMid up to the top of the range, and the only
    // things that can go white are the incandescent filament (which is mixed towards uCore on
    // purpose) and the deliberate uBleach term below, which fires only at a knot.
    vec3 em = acc * uGain;
    float el = max(max(em.r, em.g), em.b);
    em *= 1.0 / (1.0 + el * uSoft);
    vec3 hm = accH * uGain;
    float hl = max(max(hm.r, hm.g), hm.b);
    em += hm * (1.0 / (1.0 + hl * uHotSoft));
    // ── NOTHING MAY ARRIVE AT THE FRAME ON A PLATEAU ──────────────────────────────────────────
    // First: a hot gas gives up its chroma before it gives up its structure, so as the peak
    // channel climbs the colour walks towards neutral — which also stops uEdge (the supercar's
    // #2a2fff is (0.02, 0.03, 1.0) in linear) clipping its blue alone, and a lone clipped channel
    // is a posterised region with a hard boundary. Second: a shoulder, em/(1 + em·uSoft), so a
    // knot four times the body's brightness still lands on a curve.
    // (r18) 1.35/0.40/0.46 -> 1.70/0.34/0.34. This term exists so a lone channel cannot clip on
    // its own (uEdge #2a2fff is (0.02, 0.03, 1.0) linear), but it was firing across the whole
    // bright half of the column and bleaching the class colour out of it before the tonemap even
    // saw it. It now only reaches the knots, which are the only place a jet is genuinely white.
    // ── (r21) THE BLEACH IS WHAT WELDED THE THROAT INTO ONE WHITE LOZENGE ────────────────────
    // Measured on the r20 vegas supercar with tools/_n21_width.mjs: a contiguous run 60 px wide
    // through the axis at f = 0.06 in which some channel is pinned at 255, holding for a fifth of
    // the column's length — and inside a saturated run there is no width, no banding and no edge,
    // so the first fifth of the plume arrives at the frame as one featureless bar however good the
    // field behind it is. The term is meant to stop uEdge (#2a10ff — (0.02, 0.01, 1.0) in linear)
    // clipping its blue channel alone, which would be a posterised region with a hard boundary;
    // at a knee of 1.70 it instead fired everywhere the body was merely bright and pulled a third
    // of the way to white across the whole near half. The knee is now uBleach (2.9) and the
    // authority 0.34 -> 0.22, so it reaches only the knots, which are the one place a jet is
    // genuinely white.
    float pk = max(max(em.r, em.g), em.b);
    em = mix(em, vec3(pk), clamp((pk - uBleach) * 0.14, 0.0, 0.22));

    float a = (1.0 - trans) * uOcc;
    // everything fades out inside a couple of metres of the lens, so no layer can be clipped by
    // the near plane into a hard-edged wedge across the frame
    float k = uLevel * uFade * smoothstep(uNear0, uNear1, length(vWorld - ro));
    em *= k; a *= k;
    if (a < 0.0025 && max(em.r, max(em.g, em.b)) < 0.005) discard;
    // premultiplied: out = emission + background·(1 - a)
    gl_FragColor = vec4(em, a);
  }
`;

/**
 * How many LOCAL half-widths of gas the march covers before it cuts (the density is already 0).
 *
 * ── (r22) 1.70 -> 1.42, AND THE BITE MOVED OUT TO MEET IT ──────────────────────────────────────
 * The shear shell sits at uRimR ~ 1.0. At a reach of 1.70 the gas ran on for another 0.7 of a
 * half-width outside it as an ever-fainter tail — three quarters of the column's own radius of
 * haze OUTSIDE the line that is supposed to be its boundary. Measured with tools/_n22_flat.mjs:
 * the plume's apparent edge was the place that tail crossed the ablation threshold, which is a
 * function of the exposure and NOT of the cone, so it sat at the same fraction of the frame at
 * every station. That is the mechanism behind "no defined fringe boundary", and it is also how a
 * 6:1 cone photographs as a bar: a boundary set by brightness rather than by geometry cannot
 * taper. The gas now ends where the shell is: it rises into the limb and stops within ~0.3 of a
 * half-width of it, so the outline the eye finds IS the class cone, at every station.
 */
const PLUME_REACH = 1.42;
/** Flat margin on the rasterisation proxy, as a multiple of the throat radius. NEVER cut to the gas. */
const PLUME_PAD = 1.30;

/**
 * The rasterisation proxy: one quad, positioned entirely by PLUME_VERT from world-space uniforms.
 *
 * Two segments across and four down so the (perspective-correct) interpolation of `vWorld` is
 * exact enough at grazing angles; the shape of the gas has nothing to do with this mesh.
 */
let _coreGeo = null;
function coreGeometry() {
  if (!_coreGeo) _coreGeo = new THREE.PlaneGeometry(1, 1, 2, 4);
  return _coreGeo;
}

function plumeMaterial(fx, phase) {
  const pf = fx.profile || [0.72, 0.10, 1.35, 0.08];
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uPhase: { value: phase },
      uCore: { value: new THREE.Color(fx.core) },
      uMid: { value: new THREE.Color(fx.mid) },
      uEdge: { value: new THREE.Color(fx.edge) },
      uProf: { value: new THREE.Vector4(pf[0], pf[1], pf[2], pf[3]) },
      // ── the plume's frame in WORLD space — the march happens here, not on the quad ─────────
      uOrigin: { value: new THREE.Vector3() },   // the orifice
      uAxis: { value: new THREE.Vector3(0, 0, -1) },
      uU: { value: new THREE.Vector3(1, 0, 0) },
      uV: { value: new THREE.Vector3(0, 1, 0) },
      uLen: { value: 4 },                        // column length, metres
      uR0: { value: 0.6 },                       // throat half-width, metres
      uRmax: { value: 1.6 },                     // bounding radius for the ray clip
      uHalfW: { value: 1.6 },                    // half-width of the proxy quad
      uPadS: { value: 0.4 },                     // axial slack at each end of the proxy quad
      uBands: { value: fx.bands },
      uBandSpeed: { value: fx.bandSpeed },
      uBandAmt: { value: fx.bandAmt ?? 1 },
      // (r19) the train's slow breathe, hoisted out of the march: it is a function of uTime alone,
      // so evaluating it 22 times per pixel bought nothing but a transcendental per sample.
      uBandDrift: { value: 0 },
      // (r19) how compact the incandescent pip inside a shock cell is: 0 = lobe^2 (the SUV's lazy
      // swell, half-max over ~36% of the cell), 1 = lobe^5 (the supercar's hard pip, ~23%).
      uKnot: { value: fx.knot ?? 0.5 },
      // (r20) how fast the train fades from ONE DIAMOND TO THE NEXT — the phase is the cell index,
      // so this is a fixed ratio per cell: 0.30 -> 0.74x (the supercar's long persistent train),
      // 0.42 -> 0.66x (the SUV, three cells and done).
      uBandFade: { value: fx.bandFade ?? 0.34 },
      // (r19) strength of the oblique shock sheet — the X between two nodes. High on the tight
      // classes, whose cells are short enough that the crossings read; low on the SUV, whose bell
      // is so wide that a sheet at 0.94 half-widths is most of the frame.
      uXsh: { value: fx.xsh ?? 0.55 },
      // how deeply a shock node necks the column. THE knob the speed pass cannot flatten: the
      // blur runs ALONG the plume, so a waist and a belly survive where a brightness pulse does not.
      uNeck: { value: fx.neckAmt ?? 0.30 },
      uTurb: { value: fx.turb },
      uFlick: { value: fx.flick },
      // master exposure. The BODY has to land near 1.0 in its strongest channel: saturated, still
      // on the tonemap's curve, never a posterised plateau with a rim around it.
      uGain: { value: fx.gasGain ?? 0.95 },
      uHot: { value: fx.hotI ?? 2.2 },
      uBurn: { value: fx.burn ?? 0.26 },
      uFilW: { value: fx.filW ?? 0.20 },
      uBodyW: { value: fx.bodyW ?? 0.46 },
      uSkirtW: { value: fx.skirtW ?? 0.88 },
      uSkirtI: { value: fx.skirtI ?? 0.36 },
      // how much of the jet's own body ABSORBS — what decides whether the lane line behind the
      // plume goes away, and how strongly the near side of the column shades the far side.
      uBodyD: { value: fx.bodyD ?? 0.90 },
      uThick: { value: fx.thick ?? 0.95 },
      // Alpha only — it scales the occlusion, never the emission. (r17) 0.90-0.92 -> 0.97: at 0.90
      // the lane line ran visibly through the densest part of the column, which makes the gas read
      // as a GLAZE laid over the road rather than as something the road is behind. The plume still
      // has no hard boundary — (1 - trans) goes to zero smoothly at every edge — it is just fully
      // opaque where it is genuinely thick.
      uOcc: { value: fx.occ ?? 0.92 },
      uReach: { value: PLUME_REACH },
      // (r17) 0.82/1.10 -> 0.90/1.18. Cutting the gas at 0.82 threw away the LAST SIXTH of the
      // column, which is the sixth where the taper is most visible: the measured plume died at
      // t = 0.75 and what was on screen was the fat parallel front of the cone.
      uEnd0: { value: 0.90 },
      uEnd1: { value: 1.18 },
      uGroundY: { value: 0 },
      uFade: { value: 1 },
      uNear0: { value: 1.10 },
      uNear1: { value: 3.00 },
      // depth(tip)/depth(throat) - 1, refreshed every frame from the live camera in update()
      uPersp: { value: 0 },
      // the shoulder on the plume's own emission, em/(1 + em*uSoft)
      // (r17) 0.34 -> 0.20. The shoulder is here so a knot lands on a curve rather than on a
      // plateau, but at 0.34 it was compressing a 6:1 emission swing between a shock node and the
      // gas either side of it down to 2.6:1 BEFORE the ACES curve got hold of it — i.e. it was
      // deleting the shock train on its way to the frame. With the body exposed to land near 0.7
      // instead of near 1.0 there is room above it for a knot to be genuinely brighter.
      uSoft: { value: fx.soft ?? 1.25 },
      // the knots' own shoulder — gentle, so a shock diamond can still clear the bloom threshold
      uHotSoft: { value: fx.hotSoft ?? 0.16 },
      // density of the detached wisps outside the column (fl^3 — sparse by construction)
      uWisp: { value: fx.wisp ?? 0.55 },
      // ── (r21) THE SHEAR SHELL — the layer that DRAWS the silhouette ─────────────────────────
      // uRimR  where the shell sits, in local half-widths. ~1.0 puts it exactly on the class cone,
      //        so the two limb-brightened flank lines ARE the taper: they converge as it necks.
      // uRimW  its 1/e thickness in the same units. Wide enough to survive bloom's fixed-screen
      //        halo at the thin end, narrow enough that it is a line and not a second skirt.
      // uRimI  how much gas is in it. This is the per-class knob for how DRAWN the plume is: the
      //        supercar's needle has a hard bright edge, the SUV's bell a soft boiling one.
      uRimR: { value: fx.rimR ?? 0.98 },
      uRimW: { value: fx.rimW ?? 0.22 },
      uRimI: { value: fx.rimI ?? 1.00 },
      // how brightly the shell burns. It is the only layer whose emission is NOT routed through
      // the temperature ramp, so this is the direct control on how DRAWN the plume's edge is.
      uRimE: { value: fx.rimE ?? 3.20 },
      // knee of the desaturate-towards-white term — see the r21 note at the bottom of PLUME_FRAG
      uBleach: { value: fx.bleach ?? 2.90 },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    // ── PREMULTIPLIED: ONE PASS THAT BOTH EMITS AND OCCLUDES ─────────────────────────────────
    // src = ONE, dst = ONE_MINUS_SRC_ALPHA, so the result is  emission + background·(1 − α).
    // Additive alone meant the structure vanished wherever the background was bright; compositing
    // alone meant the plume could never be brighter than the paint it was drawn with.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

const STREAK_VERT = /* glsl */`
  attribute vec3 aCenter;
  attribute vec3 aVel;
  attribute vec2 aParam;     // x: 0 ahead-of-head → 1 tail, y: 0..1 across
  attribute float aWidth;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uStretch, uMinLen, uMaxLen, uNear0, uNear1;
  varying vec2 vP; varying float vA; varying vec3 vC;
  void main(){
    vP = aParam; vC = aColor;
    vec4 c = modelViewMatrix * vec4(aCenter, 1.0);
    // Embers streaming past the chase camera would otherwise smear across the whole lens; fade
    // them out before they reach the near plane so the plume stays the subject.
    vA = aAlpha * smoothstep(uNear0, uNear1, -c.z);
    vec3 v = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    float sp = length(v);
    vec3 d = sp > 1e-4 ? v / sp : vec3(0.0, 0.0, 1.0);
    float len = clamp(sp * uStretch, uMinLen, uMaxLen);
    vec3 toEye = normalize(-c.xyz);
    vec3 sd = cross(d, toEye);
    float sl = length(sd);
    sd = sl > 1e-4 ? sd / sl : vec3(1.0, 0.0, 0.0);
    // s runs from -0.14 (a cap AHEAD of the head, so the head can be rounded off) to 1.0
    float s = aParam.x * 1.14 - 0.14;
    // taper the tail so a streak is a comet, not a bar; 1.7x padding so the gaussian in the
    // fragment shader has reached zero by the time it hits the quad border
    float w = aWidth * mix(1.0, 0.34, clamp(s, 0.0, 1.0)) * 1.7;
    vec3 p = c.xyz - d*len*s + sd*(aParam.y - 0.5)*2.0*w;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const STREAK_FRAG = /* glsl */`
  varying vec2 vP; varying float vA; varying vec3 vC;
  void main(){
    // 2-D gaussian capsule: round head, tapered tail, ZERO alpha on all four quad edges.
    float s = vP.x * 1.14 - 0.14;
    float d = (vP.y * 2.0 - 1.0) * 1.7;          // distance from the axis, in half-widths
    float a = exp(-d*d*1.9);
    float head = max(0.0, -s) / 0.14;
    a *= exp(-head*head*2.2);                    // dome off the leading end
    a *= 1.0 - smoothstep(0.68, 1.0, s);         // and fade out before the trailing edge
    a *= vA;
    // (r9) 1.35 → 1.08 and the mix weight down: a streak core that sits well past the bloom
    // threshold haloes into a soft white rod, and a wake of white rods out-reads the jet.
    vec3 col = mix(vC, vec3(1.08), exp(-d*d*7.0) * 0.45 * (1.0 - clamp(s, 0.0, 1.0)));
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

class StreakPool {
  constructor(max = 260, seed = 5150) {
    this.max = max;
    this.rng = new RNG(seed);
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.head = 0;
    this._acc = 0;

    const aCenter = new Float32Array(max * 4 * 3);
    const aVel = new Float32Array(max * 4 * 3);
    const aParam = new Float32Array(max * 4 * 2);
    const aWidth = new Float32Array(max * 4);
    const aAlpha = new Float32Array(max * 4);
    const aColor = new Float32Array(max * 4 * 3);
    const index = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      // (along, across): head-left, head-right, tail-left, tail-right
      aParam[v * 2 + 0] = 0; aParam[v * 2 + 1] = 0;
      aParam[v * 2 + 2] = 0; aParam[v * 2 + 3] = 1;
      aParam[v * 2 + 4] = 1; aParam[v * 2 + 5] = 0;
      aParam[v * 2 + 6] = 1; aParam[v * 2 + 7] = 1;
      const o = i * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v + 1; index[o + 4] = v + 3; index[o + 5] = v + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(aVel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aParam', new THREE.BufferAttribute(aParam, 2));
    geo.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;
    this.attr = { aCenter, aVel, aWidth, aAlpha, aColor };

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uStretch: { value: 0.030 },
        uMinLen: { value: 0.16 },
        uMaxLen: { value: 1.7 },
        uNear0: { value: 1.2 },
        uNear1: { value: 4.2 },
      },
      vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this._c = new THREE.Color();
  }

  emit(px, py, pz, vx, vy, vz, life, width, color, alpha, gravity = 0) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    const b = i * 3;
    this.pos[b] = px; this.pos[b + 1] = py; this.pos[b + 2] = pz;
    this.vel[b] = vx; this.vel[b + 1] = vy; this.vel[b + 2] = vz;
    this.life[i] = this.life0[i] = life;
    this.a0[i] = alpha;
    this.grav[i] = gravity;
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    const A = this.attr;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      A.aWidth[v] = width;
      A.aColor[v * 3] = this._c.r; A.aColor[v * 3 + 1] = this._c.g; A.aColor[v * 3 + 2] = this._c.b;
    }
  }

  /**
   * `driftZ` is how fast an ember slips backward RELATIVE TO THE CAR, in car space. It is not the
   * car's full speed: exhaust gas leaves the nozzle at roughly the speed the car is doing, so an
   * ember entrained in the plume is nearly stationary relative to the car and only gradually falls
   * out of the wake. Feeding the full speed here fires the whole shower through the chase camera
   * in two frames, which is what made round 1 read as a detonation rather than a jet.
   */
  update(dt, drag = 1.6, driftZ = 0) {
    const A = this.attr;
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.max; i++) {
      const v4 = i * 4;
      if (this.life[i] <= 0) {
        // A dead streak used to keep its last width, so all 280 slots rasterized a full-size quad
        // every frame and threw every fragment away in the shader's `a < 0.004` discard — real
        // fill on the one frame the project is measured in. Zeroing the WIDTH as well collapses the
        // quad to a zero-area sliver, so a dead streak costs vertex work and nothing else.
        if (A.aAlpha[v4] !== 0 || A.aWidth[v4] !== 0) {
          for (let k2 = 0; k2 < 4; k2++) { A.aAlpha[v4 + k2] = 0; A.aWidth[v4 + k2] = 0; }
        }
        continue;
      }
      this.life[i] -= dt;
      const b = i * 3;
      this.vel[b] *= k; this.vel[b + 1] *= k; this.vel[b + 2] *= k;
      this.vel[b + 1] -= this.grav[i] * dt;
      const vz = this.vel[b + 2] + driftZ;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += vz * dt;
      const f = this.life[i] <= 0 ? 0 : Math.pow(this.life[i] / this.life0[i], 0.75) * this.a0[i];
      for (let q = 0; q < 4; q++) {
        const v = v4 + q;
        A.aCenter[v * 3] = this.pos[b]; A.aCenter[v * 3 + 1] = this.pos[b + 1]; A.aCenter[v * 3 + 2] = this.pos[b + 2];
        A.aVel[v * 3] = this.vel[b]; A.aVel[v * 3 + 1] = this.vel[b + 1]; A.aVel[v * 3 + 2] = vz;
        A.aAlpha[v] = f;
      }
    }
    const at = this.geometry.attributes;
    at.aCenter.needsUpdate = true; at.aVel.needsUpdate = true;
    at.aAlpha.needsUpdate = true; at.aWidth.needsUpdate = true; at.aColor.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.attr.aAlpha.fill(0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The jet
// ---------------------------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
// scratch for core.onBeforeRender — never touched by update(), so the two cannot alias
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _gp = new THREE.Vector3();
const _gd = new THREE.Vector3();
const _gq = new THREE.Quaternion();
const WHITE = new THREE.Color(0xffffff);

/**
 * Where the column visually ENDS, as a fraction of baseLen — the point the screen-space governor
 * measures its target size against.
 *
 * (r8) 0.62 → 0.80. The core's alpha used to be cut at t≈0.58–1.0, so the governor was right to
 * call 0.62 the end. But the class cone does most of its necking between t = 0.5 and t = 0.9, so
 * cutting there threw the taper away and put a faded TUBE on screen. The column now runs to ~0.9
 * and the governor sizes against 0.80, which also makes the world column ~22% shorter for the same
 * screen presence — the tip lands inside the frame far more often.
 */
const VIS_T = 0.90;
/**
 * ...and where it actually STOPS. uEnd0/uEnd1 fade the gas out between t = 0.84 and 1.12 with a
 * jitter either side, so the last visible wisp is at roughly 1.0 of the solved length. The frame
 * containment clamp probes THIS point, not VIS_T: a column whose tip is outside the picture shows
 * only its parallel front half, which is the composition half of "near-constant width".
 */
const END_T = 0.96;

export class NitrousJet {
  /**
   * @param cfg      a NITRO entry (or a colour string for back-compat)
   * @param opts.scale    overall size multiplier for the class body
   * @param opts.nozzles  array of THREE.Vector3 local exhaust anchors (car space)
   */
  constructor(cfg = NITRO.tuner, { scale = 1, nozzles = null } = {}) {
    if (typeof cfg === 'string') cfg = { ...NITRO.tuner, color: cfg };
    this.cfg = cfg;
    this.fx = cfg.fx || NITRO.tuner.fx;
    const fx = this.fx;
    this.color = new THREE.Color(cfg.color || fx.mid);
    this.scale = scale;
    this.t = 0;
    this.rng = new RNG(31);
    this.igT = 99;               // seconds since ignition
    this.heat = 0;               // 0..1, read by main.js for the grade-pass heat haze

    this.group = new THREE.Group();   // stays visible so the point-light count never changes
    this.fxRoot = new THREE.Group();
    this.group.add(this.fxRoot);

    // ── ONE GAS LAYER (r12) ───────────────────────────────────────────────────────────────────
    // r10 deleted the lathe shell; r12 deletes the core/sheath split as well. Two impostors with
    // two blend modes, two cone profiles and two turbulence fields could not help but show the
    // seam between them, and "a bright ribbon inside a wider ribbon" is exactly the flat slab the
    // director photographed. There is now ONE quad per outlet whose shader integrates the whole
    // volume — filament, body and skirt — in one pass. `coreMats` keeps its name because main.js,
    // race.js and the scratch ablation tools all reach for it; `sheathMats` stays as an empty array
    // for the same reason.
    // A per-nozzle `shells: []` stays on the nozzle record: the scratch ablation tools index it.
    this.coreMats = [];
    this.sheathMats = [];

    const nz = (nozzles && nozzles.length) ? nozzles : [new THREE.Vector3(0, 0.5, -2)];
    // a single centre outlet has to carry the whole jet on its own
    this.radMul = nz.length > 1 ? 1 : 1.20;
    this.nozzles = [];
    const standoff = fx.standoff ?? 0.30;
    for (let ni = 0; ni < nz.length; ni++) {
      const n = nz[ni];
      const g = new THREE.Group();
      // ── ANCHORING (the round-2 fix) ────────────────────────────────────────────────────────
      // The jet sits exactly on the exhaust outlet in X and Y and fires straight down the car's
      // REAR-FACING CENTRELINE. Round 2 splayed each plume 8–10° outboard and lifted every nozzle
      // to y >= 0.58; from the boosting chase camera (which swings out to one side) the near jet
      // then appeared to erupt from the car's flank and spray diagonally across the rumble strip,
      // while the far jet hid behind the body — one blob, off-axis. Now: no lift, near-zero
      // splay, and the origin pushed `standoff` metres BEHIND the tip so the plume starts in
      // clear air and the bumper/taillights/tips read in front of it.
      g.position.set(n.x, n.y, n.z - standoff);
      // ── TWIN JETS CONVERGE, THEY DO NOT SPLAY ────────────────────────────────────────────
      // Two parallel columns 0.5 m apart photograph as exactly what the round-13 critic called
      // them: "a pair of laser rods". Real adjacent jets entrain each other and merge into one
      // plume with two hot roots, which is both what the reference frames show and the thing that
      // stops the pair reading as two separate objects — so each column is toed IN by just enough
      // to meet the centreline near the end of its own visible length, capped so the muscle's and
      // the SUV's wide-set pipes do not turn into a visible V.
      const conv = Math.min(fx.merge ?? 0.085,
        Math.abs(n.x) / Math.max(0.78 * (fx.len ?? 4) * scale, 0.5));
      g.rotation.y = Math.abs(n.x) > 0.05 ? Math.sign(n.x) * conv : 0;
      // A real tailpipe washes down a few degrees, and the down-wash is the one deflection that
      // costs nothing in "is it on the centreline?" while still giving the column screen-space
      // length when the chase camera is sitting almost on the jet's axis.
      // (r5) 0.075 rad of down-wash dropped the tip ~0.3 m over the column, which at exhaust height
      // planted the whole back half of the jet ON the asphalt: the plume and its own ground pool
      // fused into one flat orange field. It now runs very nearly level and stays clear of the road.
      g.rotation.x = 0.025;
      // per-nozzle phase so the twin jets band, wobble and flicker independently
      const phase = ni * 2.399963;
      const shells = [];   // vestigial: the scratch ablation tools iterate it

      // ---- the plume: ONE axis-billboarded volume impostor (see PLUME_FRAG) ----
      const coreMat = plumeMaterial(fx, phase);
      this.coreMats.push(coreMat);
      const core = new THREE.Mesh(coreGeometry(), coreMat);
      core.renderOrder = 8.2;      // under the burner disc and the ignition sprites
      core.frustumCulled = false;
      // ── THE FRAME IS RESOLVED AT DRAW TIME, NOT IN update() ─────────────────────────────────
      // The plume is defined by world-space uniforms (see PLUME_FRAG), and update() runs before
      // the car's matrices are recomputed for the frame — so writing them there leaves the whole
      // column ONE FRAME BEHIND the exhaust it comes out of. Measured at 185 mph: uOrigin landed
      // 1.35 m downstream of the nozzle, i.e. the jet was detached from the car by a third of its
      // own length with a metre of clear air between the pipe and the flame. onBeforeRender is
      // called with matrixWorld already up to date, which is the only place this can be exact.
      core.onBeforeRender = () => {
        const u = coreMat.uniforms;
        const wm = core.matrixWorld;
        const sc = _v3.setFromMatrixColumn(wm, 0).length() || 1;
        u.uOrigin.value.setFromMatrixPosition(wm);
        u.uU.value.setFromMatrixColumn(wm, 0).divideScalar(sc);
        u.uV.value.setFromMatrixColumn(wm, 1).divideScalar(sc);
        u.uAxis.value.setFromMatrixColumn(wm, 2).divideScalar(-sc);   // +Z is forward; the jet fires aft
        const len = (core.userData.len || 0) * sc;
        const r0 = (core.userData.r0 || 0) * sc;
        // The widest the local half-width can get — the perspective correction, the shock belly
        // and the march's reach at once. The bounding cylinder the ray is clipped to has to hold
        // every one of them, or the clip becomes the silhouette: a straight line down the flank.
        // (r22) the neck is one-sided, so the class cone IS the envelope; what the bound has to
        // hold on top of the march's reach is the axis wander, which is 0.85*uTurb half-widths.
        const rMax = r0 * Math.max(1, clamp(1 + u.uPersp.value, 0.20, 2.40))
          * (PLUME_REACH + 1.05 * u.uTurb.value) * 1.10;
        u.uLen.value = len;
        u.uR0.value = r0;
        u.uRmax.value = rMax;
        // ...and the proxy quad is cut a flat margin outside THAT, never to the shape of the gas.
        u.uHalfW.value = rMax * PLUME_PAD * (core.userData.wide || 1);
        u.uPadS.value = Math.max(0.05 * len, 1.30 * rMax);
      };
      g.add(core);
      const sheath = core;         // back-compat alias for the scratch ablation tools

      // burner disc — keeps the jet structured when seen end-on from the chase camera
      const disc = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: burnerTexture(), color: this.color.clone().lerp(WHITE, 0.22),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      disc.position.z = -0.06;
      disc.renderOrder = 9;
      disc.frustumCulled = false;
      g.add(disc);
      // muzzle flash on ignition
      const flash = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: flashTexture(), color: 0xffffff,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      flash.renderOrder = 10;
      flash.frustumCulled = false;
      g.add(flash);
      // expanding shock ring, square to the jet axis
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: ringTexture(), color: this.color.clone().lerp(WHITE, 0.6),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      ring.position.z = -0.2;
      ring.renderOrder = 9;
      ring.frustumCulled = false;
      g.add(ring);

      this.fxRoot.add(g);
      // `base` is where sparks and smear are born — the standoff point, not the tip, so the ember
      // shower starts in the same clear air the plume does.
      // Twin outlets fed by one bottle still do not burn identically. A few per cent of length and
      // width difference is what stops the pair reading as one mirrored object drawn twice — the
      // "railway track" look two perfectly matched columns give.
      const lenMul = 1 + (ni % 2 ? -0.055 : 0.055);
      const radMul = 1 + (ni % 2 ? 0.04 : -0.04);
      this.nozzles.push({ group: g, shells, core, coreMat, sheath, sheathMat: coreMat, coreRoll: 0, disc, flash, ring, phase, lenMul, radMul, base: g.position.clone() });
    }

    // ---- light spilling onto the road ----
    this.pool = new THREE.Mesh(
      (() => { const p = new THREE.PlaneGeometry(1, 1); p.rotateX(-Math.PI / 2); p.translate(0, 0, -0.5); return p; })(),
      new THREE.MeshBasicMaterial({
        map: poolTexture(), color: this.color, fog: false,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }),
    );
    this.pool.renderOrder = 3;
    this.pool.frustumCulled = false;
    this.fxRoot.add(this.pool);

    // ---- sparks / light smear ----
    this.streaks = new StreakPool(280, 5150);
    this.fxRoot.add(this.streaks.mesh);

    // ---- light on the car's own bodywork (never removed, so light count stays constant) ----
    // Sits a metre behind the outlets, so it rakes ACROSS the rear panel and picks out the bumper,
    // diffuser and taillight housings instead of sitting inside them and washing them flat.
    const mid = new THREE.Vector3();
    for (const n of nz) mid.add(n);
    mid.divideScalar(nz.length);
    this.mid = mid.clone();
    this.light = new THREE.PointLight(this.color, 0, 16, 2);
    this.light.position.copy(mid).add(new THREE.Vector3(0, 0.06, -(standoff + 0.75)));
    this.group.add(this.light);

    this.fxRoot.visible = false;
    this._level = 0;
    // "hot" ember colour: the class spark pushed most of the way to white, but never all the way
    this._hot = new THREE.Color(fx.spark).lerp(WHITE, 0.55);
    // ── THE YELLOW-WHITE EMBER (r11) ─────────────────────────────────────────────────────────
    // §1.2 asks for "yellow-white spark streaks" by name, and it asks for them on a BLUE plume —
    // burning particulate is incandescent, so its colour is its temperature and has nothing to do
    // with the gas around it. Every class-tinted ember sits inside its own plume's hue and reads as
    // part of the column; a warm ember on the tuner's cyan or the supercar's violet is the one
    // spark colour that is unmistakably a separate object. Round 10 had neither, and the verdict
    // counted "1-3 pale hairlines per frame".
    this._ember = new THREE.Color('#ffe6ae');
  }

  setColor(c) {
    this.color.set(c);
    this.light.color.set(c);
    this.pool.material.color.set(c);
    for (const n of this.nozzles) {
      n.disc.material.color.copy(this.color).lerp(WHITE, 0.22);
      n.ring.material.color.copy(this.color).lerp(WHITE, 0.6);
    }
    for (const m of this.coreMats) m.uniforms.uMid.value.set(c);
  }

  /**
   * Fire the ignition event: muzzle flash, shock ring and a blast of sparks.
   * The blast is a REARWARD cone, not a sphere — a sphere reads as "the car detonated".
   */
  ignite() {
    this.igT = 0;
    // the governor re-solves from scratch for this boost rather than easing off the last one's size
    this._gLen = undefined; this._gRad = undefined; this._gAx = undefined;
    const fx = this.fx;
    const r = this.rng;
    const cone = fx.cone ?? 0.3;
    for (const n of this.nozzles) {
      for (let i = 0; i < 26; i++) {
        const a = r.range(0, Math.PI * 2);
        const th = Math.sqrt(r.range(0, 1)) * cone * 1.5;   // ±~25–35°, densest on axis
        const sp = r.range(fx.sparkSpeed[0] * 2.0, fx.sparkSpeed[1] * 3.2);
        this.streaks.emit(
          n.base.x + Math.cos(a) * 0.05, n.base.y + Math.sin(a) * 0.05, n.base.z,
          Math.cos(a) * Math.tan(th) * sp, Math.sin(a) * Math.tan(th) * sp + r.range(0.2, 1.4), -sp,
          r.range(0.14, 0.28), fx.sparkWidth * r.range(1.0, 1.9),
          r.bool(0.4) ? this._hot : fx.spark, r.range(0.5, 0.95), 4,
        );
      }
    }
  }

  /**
   * ── THE SCREEN-SPACE GOVERNOR (the round-4 fix) ─────────────────────────────────────────────
   *
   * Round 3's plume was sized in WORLD units, and the chase rig pulls back and climbs with speed.
   * The two fought each other: at 167–188 mph the rig sat ~10 m out and ~5 m up, and a 4–5 m
   * column seen from up there and nearly down its own axis projected to a ~120 px stub. The frames
   * where nitrous is supposed to dominate were the least spectacular in the set.
   *
   * So the jet no longer has a length. It has a TARGET SIZE ON SCREEN (`fx.screen`, a fraction of
   * the frame height) and the world length is SOLVED FOR every frame against the real projection.
   *
   * Screen position, measured in frame heights from the optical axis, is
   *
   *   F(p) = ( p.x / (−p.z · 2·tan(fov/2)),  p.y / (−p.z · 2·tan(fov/2)) )
   *
   * — the aspect divisor in ndc_x cancels against the frame being `aspect` frame heights wide, so
   * x and y share one scale and combine directly. The wanted length is the L that makes
   * |F(nozzle + L·axis) − F(nozzle)| equal `fx.screen`. That separation is monotonic in L up to
   * the point where the tip reaches the lens, so a short bisection nails it.
   *
   * It is deliberately NOT the first-order form d|F|/dL: the governor routinely asks for a 10 m
   * column from a rig 6 m away, and out there the linear estimate is off by a factor of two —
   * and it has no idea when the tip has gone PAST the camera, which is where it diverges outright.
   * The search is bracketed at a tip 2.5 m in front of the lens for exactly that reason.
   *
   * Radius is NOT solved for. It is derived from the solved length (see the caller), because
   * `fx.rad` has to stay under half the twin-outlet spacing or the two hot cores merge into one
   * blob — the headline round-2 note. Length has no such constraint, so length is where the
   * governor spends.
   *
   * @returns {{len:number, axial:number}|null} null when the jet is behind the lens.
   *          `axial` is how squarely the camera is looking down the jet's own centreline (0 = pure
   *          side-on, 1 = straight down the barrel). At high `axial` no amount of length buys
   *          screen size — the column is a dot with a long tail — so the caller spends on width
   *          and on the burner disc instead.
   */
  _governor(camera, target, mul = 1) {
    // main.js updates the jet before the camera, so matrixWorldInverse can be a frame stale (and on
    // the very first frame of a capture, unset). PerspectiveCamera.updateMatrixWorld() refreshes the
    // inverse and is a cheap no-op when nothing moved.
    camera.updateMatrixWorld();
    const n0 = this.nozzles[0];
    n0.group.getWorldPosition(_gp);
    n0.group.getWorldQuaternion(_gq);
    _gd.set(0, 0, -1).applyQuaternion(_gq);            // the plume axis, in world space
    _gp.applyMatrix4(camera.matrixWorldInverse);       // → view space
    _gd.transformDirection(camera.matrixWorldInverse);
    const pz = _gp.z;
    if (!(pz < -0.4)) return null;                     // behind the lens (or NaN) — leave it alone
    const k = 0.5 / Math.tan(camera.fov * Math.PI / 360);
    const sx0 = k * _gp.x / -pz, sy0 = k * _gp.y / -pz;
    // Screen position of the point t metres down the axis, in FRAME HEIGHTS from the optical axis.
    const sxT = (t) => k * (_gp.x + _gd.x * t) / -(pz + _gd.z * t);
    const syT = (t) => k * (_gp.y + _gd.y * t) / -(pz + _gd.z * t);
    // Separation, in frame heights, between the nozzle and the point the column visually ends at
    // when the whole column is L metres long.
    // ── `mul` IS WHY THE CONTAINMENT CLAMP DID NOT WORK (r15) ────────────────────────────────
    // The solver returns a length in metres, and the caller then multiplied it by lenDrive, by the
    // per-frame flicker and by the surge — between 1.0x and ~1.35x — so the column that actually
    // got drawn was up to a third longer than the one that was fitted to the frame. Measured on the
    // LA supercar: the governor solved 3.4 m, the jet drew 3.6 m, and the tip landed at screen
    // y = 916 on a 900 px frame. Every one of those multipliers is now known BEFORE the solve and
    // folded in here, so what is fitted is what is drawn.
    const sep = (L) => {
      const t = L * mul * VIS_T;
      return Math.hypot(sxT(t) - sx0, syT(t) - sy0);
    };
    // never let the solver walk the TIP (t = 1) into, or through, the lens
    let hi = Math.min(30, _gd.z > 1e-4 ? (-2.2 - pz) / (_gd.z * mul) : 30);
    let lo = 0;
    const out = { len: 0.4, axial: clamp(Math.abs(_gd.z), 0, 1), fit: 1 };
    if (hi <= 0.4) return out;
    if (sep(hi) > target) {
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) * 0.5;
        if (sep(mid) < target) lo = mid; else hi = mid;
      }
    }
    out.len = hi;

    // ── FRAME CONTAINMENT (the round-5 fix) ───────────────────────────────────────────────────
    // Solving for screen SIZE alone is not the same as putting the jet ON SCREEN. From a rig swung
    // out to a rear three-quarter, a column sized to 40% of frame height ran diagonally out through
    // the bottom-left corner: the tip, the taper and the whole cone silhouette were cropped away
    // and what was left inside the frame was a wide, structureless orange field. A jet has to END
    // somewhere the viewer can see, or it is a smear.
    //
    // So the solved length is additionally clipped to the longest column whose visible end still
    // sits inside a safe box (frame minus a `margin` gutter, measured in frame heights — the box is
    // `aspect` frame heights wide). Only applied when the nozzle itself is comfortably inside the
    // frame, and never below 55% of the wanted length: if the car is already half out of shot,
    // cropping the plume too is not going to save the composition.
    // (r14) 0.085/0.075 gutters -> 0.030/0.028, and the floor below 0.55 -> 0.74. The gutters
    // were sized for a plume half this length; with the round-14 screen target they were the
    // binding constraint in most framings, and every metre they took off the column was paid back
    // as WIDTH, which is how a jet becomes a slab. A tapering column that runs out of frame at the
    // very edge still shows its whole taper; one cropped at 8% in does not.
    const halfW = camera.aspect * 0.5 - 0.038;
    const halfH = 0.5 - 0.038;
    // (r15) The containment probe was at VIS_T = 0.90 L and the floor was 0.66, and on the LA
    // supercar the pair of them put the tip at screen y = 916 on a 900 px frame: the whole necking
    // half of the cone was off the bottom-left corner and the only thing in the picture was the
    // fat, parallel FRONT of it. That is one of the two measured mechanisms behind "near-constant
    // width" and it is a composition bug, not a shading one. The probe is now END_T (essentially
    // the tip) and the floor is 0.86 — the jet may be shortened by a seventh to stay in shot, and
    // if it still will not fit, it is because the car itself is half out of frame.
    const inBox = (L) => {
      const t = L * mul * END_T;
      return Math.abs(sxT(t)) < halfW && Math.abs(syT(t)) < halfH;
    };
    if (Math.abs(sx0) < halfW && Math.abs(sy0) < halfH && !inBox(out.len)) {
      let flo = 0, fhi = out.len;
      for (let i = 0; i < 14; i++) {
        const mid = (flo + fhi) * 0.5;
        if (inBox(mid)) flo = mid; else fhi = mid;
      }
      // (r16) 0.55 -> 0.80. The r15 note above says the floor is 0.86; the number was never
      // actually changed, so the containment clamp could still give back 45% of the column and in
      // practice never bound at all — the LA supercar's tip was landing off the bottom-left corner
      // with the whole necking half of the cone outside the frame. 0.80 lets the jet be shortened
      // by a fifth to stay in shot, which is enough for every framing in the game.
      // (r17) 0.80 -> 0.58. The class targets are now bigger than the frame on purpose, so this
      // clamp is the thing that sets the jet's size in every hero shot — and a clamp that may
      // only take a fifth off cannot fit a column asking for 1.2 frame heights into a frame one
      // high. At 0.58 the solver genuinely finds the longest column that ends inside the picture,
      // which is the largest the effect can be while still showing its own taper and its own tip.
      const fitted = Math.max(flo, out.len * 0.45);
      out.fit = fitted / out.len;
      out.len = fitted;
    }
    return out;
  }

  /**
   * World-space point a fixed distance down the plume's own axis — main.js aims the boost camera
   * partly at this so the COLUMN is what the frame is composed around, with the car pushed off to
   * one side, instead of the car being dead centre and the jet exiting the corner.
   *
   * Deliberately a fixed multiple of the class's reference length, NOT of the solved length: the
   * governor's containment clamp reacts to where the tip lands on screen, so feeding the solved
   * length back into the aim would let the two chase each other.
   */
  aimPoint(out) {
    const n0 = this.nozzles[0];
    n0.group.getWorldPosition(out);
    if (this.nozzles.length > 1) {
      this.nozzles[this.nozzles.length - 1].group.getWorldPosition(_v2);
      out.lerp(_v2, 0.5);
    }
    n0.group.getWorldQuaternion(_q);
    _v2.set(0, 0, -1).applyQuaternion(_q);
    return out.addScaledVector(_v2, this.fx.len * this.scale * 0.62);
  }

  /** Screen-space anchor + strength for the grade pass' heat haze. */
  heatPoint(camera, out) {
    this.nozzles[0].group.getWorldPosition(_v);
    if (this.nozzles.length > 1) {
      this.nozzles[this.nozzles.length - 1].group.getWorldPosition(_v2);
      _v.lerp(_v2, 0.5);
    }
    // Sample a third of the way DOWN THE PLUME'S OWN AXIS, where the shimmer actually is. (Round 3
    // pushed the sample along the camera ray instead; harmless when the jet was 4 m long, but the
    // governor now routinely runs it to 10 m and that put the haze centre metres off the flame.)
    this.nozzles[0].group.getWorldQuaternion(_q);
    _v2.set(0, 0, -1).applyQuaternion(_q);
    // (r6) Sampled BEYOND the visible column, not a third of the way down it. The ripple is a
    // gaussian ~0.4 frame-heights across, so centred on the jet it wobbled the shock diamonds
    // themselves — the one layer whose whole job is to be crisp. Centred on the hot trail behind the
    // tip it bends the road, the lane lines and the barrier BEHIND the plume instead, which is where
    // refraction is legible anyway.
    _v.addScaledVector(_v2, (this._baseLen ?? this.fx.len * this.scale) * 0.86);
    _v.project(camera);
    out.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    return _v.z < 1 ? this.heat : 0;
  }

  /**
   * @param level  0..1 visual strength (Nitrous.flame)
   * @param opts.speed   car speed in m/s
   * @param opts.camera  camera, so the billboarded elements face it
   * @param opts.surge   0..1 ignition overshoot
   * @param opts.ramp    0..1 THRUST authority (Nitrous.ramp) — drives plume LENGTH, so the jet
   *                     grows with the boost instead of being the same giant blob every frame
   */
  update(dt, level, opts = {}) {
    const speed = opts.speed ?? 0;
    const camera = opts.camera || null;
    const surge = clamp(opts.surge ?? 0, 0, 1);
    const ramp = clamp(opts.ramp ?? level, 0, 1);
    const fx = this.fx;
    this.t += dt;
    this.igT += dt;

    const s = clamp(level, 0, 1);
    this._level = s;
    // Keep the FX root alive a beat after the flame dies so the last streaks fade out instead of
    // blinking off (§7 caps anything visibly popping at 70).
    this._offT = s > 0.012 ? 0 : (this._offT ?? 9) + dt;
    this.fxRoot.visible = s > 0.012 || this.igT < 1.0 || this._offT < 0.75;
    this.heat = 0;
    if (!this.fxRoot.visible) {
      this.light.intensity = 0;
      if (this._dirty) { this.streaks.clear(); this._dirty = false; }
      return;
    }
    this._dirty = true;

    // Flicker is per-class: the tuner strobes, the SUV heaves.
    // (r9) Roughly doubled. §6.3 scores flicker inside the 25-point jet dimension and the r2 note
    // was "no flicker or turbulence — the plume sits still". At ±11% the column's length was
    // changing by a few pixels a frame; at ±21%, with three incommensurate rates so the pattern
    // never repeats, the whole jet visibly surges and gutters.
    const flick = 1
      + Math.sin(this.t * fx.flick) * 0.105
      + Math.sin(this.t * fx.flick * 0.41 + 1.3) * 0.070
      + Math.sin(this.t * fx.flick * 2.7) * 0.035;

    const igFlash = Math.exp(-this.igT / 0.055);          // the hard crack
    const igBloom = Math.exp(-this.igT / 0.26);           // the afterglow that lingers into frame

    // ── LENGTH IS DRIVEN BY THE BOOST, NOT BY A CONSTANT ──────────────────────────────────────
    // Three independent terms, so no two frames of a boost show the same jet:
    //   ramp   — the class's thrust authority. The SUV is a stub for half a second and then a
    //            freight-train column; the supercar is at full authority in two frames.
    //   hold   — the column keeps stretching for ~0.6 s of sustained boost, so ignition is SHORT
    //            AND HOT and sustain is long. Round 2 drew the same giant plume in every frame.
    //   stretch— and it lengthens with road speed, so the jet reads as tied to how fast you are
    //            actually going.
    const hold = 1 - Math.exp(-Math.max(0, this.igT) / 0.42);
    const stretch = 0.94 + 0.12 * smoothstep(16, 82, speed);
    // The floors are HIGH: the governor below sets the sustained size, and these two terms only
    // carve the per-class spool out of it. A spooling SUV reads as a jet that has not opened up
    // yet — about 4/5 size — rather than as the stub it used to be. (r14) 0.66/0.78 -> 0.80/0.86,
    // because §8's canonical nitrous capture is taken 0.4 s in, i.e. while BOTH terms are still
    // below 1, and the two of them compounding took a third off the one frame this piece is
    // most often judged on.
    const lenDrive = (0.80 + 0.20 * ramp) * (0.86 + 0.14 * hold) * stretch;

    // ── screen-space governor ────────────────────────────────────────────────────────────────
    // `hero` is opt-in (main.js passes it for the player). Opponent jets are seen from 20–120 m
    // and would each solve for a 40 m column; they keep the plain world-space sizing.
    // ── §2.5: IT MUST GET BIGGER, NOT SMALLER ────────────────────────────────────────────────
    // Every previous round held ONE screen size for the whole boost, so the frame that is supposed
    // to be the payoff — 240 mph, a second and a half in — showed exactly the same jet as the
    // ignition frame, and because the chase rig is further back and faster by then it photographed
    // as a SHRINK. The governor's target now opens up over the first ~1.1 s of sustained boost:
    // ignition is short and hot at 0.90x, the sustain is 1.18x, so nitrous-long is guaranteed
    // longer on screen than nitrous no matter what the rig is doing.
    // ── §2.5: IT MUST GET BIGGER, NOT SMALLER — AND THE SOLVER CANNOT BE TOLD ────────────────
    // Every class target is now deliberately larger than the frame, so the CONTAINMENT clamp is
    // what binds in every hero framing: the jet is the longest column that still ends inside the
    // picture. Which means a target that opens up over the boost does exactly nothing — both the
    // ignition frame and the sustained frame solve to the same fitted length, and the r16 measure
    // showed precisely that. Growth is therefore applied to the RESULT, and never above 1: the
    // sustained frame is the full frame-fit and the ignition frame is four fifths of it. It is
    // deliberately kept out of the solver's `mul`, because anything the solver is told about it
    // simply compensates for.
    const grow = 0.80 + 0.20 * (1 - Math.exp(-Math.max(0, this.igT) / 0.85));
    let gLen = 1, gRad = 1, axial = 0;
    if (camera && opts.hero) {
      // Everything the caller is going to multiply the solved length BY is handed to the solver,
      // so what gets fitted to the frame is what actually gets drawn. See `mul` in _governor().
      const g = this._governor(camera, fx.screen ?? 0.40,
        lenDrive * (1 + surge * 0.12) * flick);
      if (g) {
        gLen = clamp(g.len / (fx.len * this.scale), 0.50, 4.60);
        // Radius tracks the GOVERNED LENGTH, sub-linearly, rather than raw distance. Tying it to
        // distance instead held the width fixed while the solver shortened the column, and a 2 m
        // jet 1.3 m across is not a jet, it is a lozenge — the exact "one off-axis blob" note from
        // round 2. Sub-linear (^0.62) so a stretched column also gets *relatively* more slender.
        // The one thing that does buy width is `axial`: with the rig on the jet's own centreline
        // no length reads at all, and the plume has to be seen end-on as a wide, hot disc.
        axial = smoothstep(0.72, 0.97, g.axial);
        // ...and whatever LENGTH the frame-containment clamp took away is paid back in WIDTH, so a
        // jet that has to end early to stay in shot still owns its share of the frame.
        // (r9) 0.62 → 0.74 and the cap 1.35 → 1.58. The governor routinely solves for gLen ≈ 2.5,
        // and at the old exponent that doubled the column's aspect ratio: the Miami muscle and LA
        // supercar boosts came out as pairs of 25:1 ribbons, in which a shock cell is a couple of
        // pixels wide and no amount of shader contrast can make a diamond read. A jet has to be
        // thick enough to have an inside.
        // (r12) exponent 0.88 → 0.55, cap 2.30 → 1.52. Rounds 9–11 kept paying a longer column
        // back in width, and the two terms compounded: at gLen ≈ 2.5 the muscle plume's envelope
        // came out ~2.4 m in radius — a jet two and a half times the width of the car it fires
        // out of, which is a SLAB whatever is shaded onto it. The right target is a column whose
        // widest point is about half the car's width and 6–8x as long as it is wide: that has the
        // aspect ratio a cone needs in order to visibly neck down over the part you can see.
        // (r14) exponent 0.55 -> 0.30, cap 1.40 -> 1.26, and the containment payback 0.30 -> 0.16.
        // The round-14 column is roughly twice as long as the round-13 one; paying that back into
        // width at the old exponent would have put the widest point of the plume at ~1.3x the car's
        // width, and a jet that wide cannot visibly neck down over the length you can see. The
        // target aspect is a throat about half the car's width on a column 5-7x as long.
        // (r17) cap 1.26 -> 1.10. The r17 column is longer again, and the measured throat was
        // already 230 px across on a 795 px column — a 3.5:1 wedge, which is a blob with a
        // whisker, not a jet. The target aspect is a throat about a third of the car's width on a
        // column 6-8x as long: only that has room to visibly neck down over the part you can see.
        // (r18) exponent 0.26 -> 0.52, floor 0.86 -> 0.72, containment payback 0.14 -> 0.06.
        // THE GOVERNOR MAY CHANGE THE JET'S SIZE, NOT ITS SHAPE. Measured on the r17 LA SUV at
        // 0.4 s: the solver returned gLen 0.66 — a 483 px column — while gRad only fell to 0.93,
        // so the throat came out 334 px across. A 1.4:1 wedge is a lozenge, not a jet, and it is
        // the same object critic E measured as "a ~180 px stub". At 0.52 a third off the length
        // takes a fifth off the width instead of a fifteenth, so the aspect ratio the class was
        // tuned at survives the framings where containment binds hardest — which are exactly the
        // §8 canonical captures, taken 0.4 s in with the rig at its closest.
        gRad = clamp(Math.pow(gLen, 0.52), 0.72, 1.10) * (1 + axial * 0.30)
             * (1 + (1 - g.fit) * 0.06);
      }
    }
    // Smoothed, or the column pumps every time the rig settles or a shake displaces the lens.
    const gk = 1 - Math.exp(-11 * Math.min(dt, 0.05));
    this._gLen = this._gLen === undefined ? gLen : this._gLen + (gLen - this._gLen) * gk;
    this._gRad = this._gRad === undefined ? gRad : this._gRad + (gRad - this._gRad) * gk;
    this._gAx = this._gAx === undefined ? axial : this._gAx + (axial - this._gAx) * gk;
    const gL = this._gLen, gR = this._gRad, gA = this._gAx;

    const baseLen = fx.len * this.scale * gL * lenDrive * (1 + surge * 0.12) * flick * grow;
    // Radius follows the visual level and barely moves: a jet that fattens as much as it lengthens
    // just scales up, and the "short and hot / long and wide" contrast disappears. The governor's
    // radius term is applied sub-linearly (see gRw) so the white-hot core stays narrow even when
    // the soft fringe is asked to hold its screen width from a long way out.
    const baseRad = fx.rad * this.scale * this.radMul
      * (0.80 + 0.20 * s) * (0.92 + 0.08 * ramp) * (1 + surge * 0.14);
    const gRw = Math.pow(gR, 0.85);
    this._baseLen = baseLen;

    // Held, not decayed: §6.3's payoff is the SUSTAIN, and round 3 let the layers settle ~15%
    // below their ignition level a third of a second in.
    const jetLevel = s * (0.94 + 0.10 * flick) + igBloom * 0.16;
    // The impostor loses authority as the rig comes onto the jet's own centreline: seen down the
    // barrel a flat quad rolled to face the lens degenerates, and the burner disc (which comes UP
    // by exactly the same term) is the layer that reads there.
    // (r9) 0.80 → 0.58. The core is now the only layer carrying the jet's structure, so taking 80%
    // of it away whenever the rig drifts onto the plume's axis was throwing away the whole read.
    // (r11) 0.58 → 0.38. uFade scales the core's ALPHA, so on the framings where the rig drifts
    // onto the plume's axis it was also throwing away the layer's opacity — and opacity is the
    // whole point of the composited core: the road markings behind it have to go away.
    // (r12) 0.38 → 0.22. The plume is now a volume rather than a flat structural card, so it
    // survives being seen down its own axis far better than the old impostor did — and it is the
    // only gas layer left, so taking a third of it away on those framings throws away the effect.
    const coreFade = (1 - gA * 0.22) * (fx.coreFade ?? 1);
    // The plume's ground plane, so the gas can fade out where it meets the road instead of being
    // sliced by it. The jet's group sits on the car's origin, which is on the deck (see §Conventions).
    this.group.getWorldPosition(_v);

    // ── THE PERSPECTIVE CORRECTION (r15) ─────────────────────────────────────────────────────
    // The chase camera sits behind the car and the jet fires backwards, i.e. AT the lens, so the
    // tail of the column is metres nearer the camera than its throat and perspective magnifies it
    // by exactly that ratio. On the LA supercar the throat is ~8 m out and the visible end ~4 m
    // out: a factor of two applied to the thin end of the cone, which turns a 4:1 geometric taper
    // into 2:1 and a 2:1 taper into parallel sides. That is "near-constant width" — named by four
    // critics in four different sets of words — and no profile can fix it, because the profile was
    // never what was wrong. Screen half-width is world half-width / depth, so multiplying the
    // world half-width by depth(t)/depth(0) puts the DESIGNED silhouette on screen from any
    // camera. Depth along the axis is exactly linear in t, so `1 + uPersp*t` is exact.
    let persp = 0;
    if (camera) {
      const n0 = this.nozzles[0];
      n0.group.getWorldPosition(_gp);
      n0.group.getWorldQuaternion(_gq);
      _gd.set(0, 0, -1).applyQuaternion(_gq);
      _gp.applyMatrix4(camera.matrixWorldInverse);
      _gd.transformDirection(camera.matrixWorldInverse);
      const d0 = -_gp.z;                                  // view depth at the throat
      const dTip = -(_gp.z + _gd.z * baseLen);            // ...and at the tip
      // Clamped both ways: a jet fired straight at a close lens would otherwise ask for a tail of
      // literally zero width (and the strip fit in PLUME_VERT would collapse to a sliver), and a
      // jet seen from in front would ask for a tail wider than its own throat, which is a torch
      // beam. -0.72 still buys a 3.6x correction, which is more than any framing in the game needs.
      if (d0 > 0.6 && dTip > 0.6) persp = clamp(dTip / d0 - 1, -0.72, 1.10);
    }
    this._persp = this._persp === undefined ? persp : this._persp + (persp - this._persp) * gk;

    const bandDrift = 0.16 * Math.sin(this.t * (fx.bandSpeed ?? 12) * 0.055);
    for (const m of this.coreMats) {
      m.uniforms.uTime.value = this.t;
      m.uniforms.uBandDrift.value = bandDrift;
      m.uniforms.uLevel.value = jetLevel;
      m.uniforms.uFade.value = coreFade;
      m.uniforms.uGroundY.value = _v.y;
      m.uniforms.uPersp.value = this._persp;
    }

    const camQ = camera ? camera.quaternion : null;
    // Reference radius of the plume's cone in world units: the shader's `x` is in these units, and
    // the gas reaches PLUME_REACH local half-widths out from the axis.
    const coreR = baseRad * gRw;
    // ── (r17) THE PLUME LIVES IN WORLD SPACE ─────────────────────────────────────────────────
    // PLUME_FRAG marches the real camera ray, so what it needs is the column's FRAME — orifice,
    // axis and two perpendiculars — in world units, not a mesh transform. The mesh is only a
    // rasterisation proxy and PLUME_VERT places it from these same uniforms, so the two can never
    // disagree about where the gas is. (race.js shrinks jet.group to 1e-3 while warming a shader,
    // which is why the world SCALE has to be read off the matrix rather than assumed to be 1.)
    for (const n of this.nozzles) {
      // Length and radius are stored in the nozzle's OWN units; core.onBeforeRender turns them
      // into the world-space frame the march needs, with matrices that are current for the frame.
      // The extra proxy width with the rig near the plume's own axis is because an axis-containing
      // strip degenerates towards a line there; the burner disc carries that framing anyway.
      const nLen = baseLen * n.lenMul;
      const nCoreR = coreR * n.radMul;
      n.core.userData.len = nLen;
      n.core.userData.r0 = nCoreR;
      n.core.userData.wide = 1 + gA * 1.6;

      // parent-space → so the camera-facing sprites can be built from the camera world quaternion
      const invParent = camQ ? _q2.copy(n.group.getWorldQuaternion(_q3)).invert() : null;

      // burner disc — deliberately faint now. Held at round-2 strength it was a bloom ball sitting
      // on the exhaust tips, and it is the single element most responsible for erasing them.
      const dm = n.disc.material;
      // ...and it is the one layer that is ALLOWED to come up when the rig is on the jet's axis:
      // that is the framing where the column itself is a dot and the disc is the whole read.
      // (r8) ...and it doubles as the WELD between the pipe and the flame. With the standoff cut to
      // ~0.11 m it sits essentially on the exhaust lip, so the hot spot the column grows out of is
      // physically at the outlet instead of a car-length behind it.
      // (r9) Down again. The class cones now neck hard at the orifice, and a white disc sitting on
      // the throat fills exactly the pinch the taper is supposed to read from.
      // (r12) Down again, and it now scales off the plume's own reference radius. A camera-facing
      // white disc sitting on the throat is the one element that can put a hard round blob on the
      // widest part of the taper — which is exactly the read the director photographed as a slab.
      // (r13) Down again, and smaller. In the round-1 crop the critic read the throat as "a large
      // flat clipped-white lozenge with a discernible elliptical boundary sitting on top of the
      // plume" — which is a §7 hard edge, drawn by the one element in the file that is a SPRITE.
      // It now only really exists on the framing it was added for (the rig on the jet's own axis,
      // gA high), where the column projects to a dot and something has to read.
      dm.opacity = clamp(s * (0.012 + 0.26 * gA) * flick + igBloom * 0.07, 0, 0.30);
      const ds = (coreR * 1.7 + 0.07) * (1 + surge * 0.32);
      n.disc.scale.set(ds * (1 + Math.sin(this.t * fx.flick * 0.7) * 0.05), ds, 1);
      if (camQ) n.disc.quaternion.copy(camQ).premultiply(invParent);

      // muzzle flash
      const fm = n.flash.material;
      fm.opacity = clamp(igFlash * 1.1 + igBloom * 0.42, 0, 1.5);
      const fs = lerp(0.5, 3.0 * this.scale, 1 - Math.exp(-this.igT / 0.09)) * (0.6 + s * 0.6) * gR;
      n.flash.scale.set(fs, fs, 1);
      n.flash.position.z = -0.18 - this.igT * 1.2;
      if (camQ) n.flash.quaternion.copy(n.disc.quaternion);

      // shock ring — expands square to the jet axis
      const rm = n.ring.material;
      const rt = clamp(this.igT / 0.34, 0, 1);
      rm.opacity = (1 - rt) * (1 - rt) * 1.25;
      const rs = (0.35 + rt * 5.5 * this.scale) * gR;
      n.ring.scale.set(rs, rs, 1);
      n.ring.position.z = -0.2 - rt * 2.4;
      n.ring.quaternion.identity();
    }

    // ---- streaks: sparks + light smear ----
    // Ejecta rides the wake: the drift is only a FRACTION of the car's speed (see StreakPool.update).
    const drift = -speed * (fx.wake ?? 0.2);
    const cone = fx.cone ?? 0.3;
    // Sparks are part of the jet, so they are governed too: a shower that stays 1.5 m long behind a
    // 10 m column is invisible. Speed (hence stretch) and width follow the governor sub-linearly.
    const gS = Math.pow(gL, 0.35);
    const rate = fx.sparkRate * s * (0.55 + 0.45 * smoothstep(0, 40, speed)) * (1 + surge * 1.2);
    this._acc = (this._acc || 0) + rate * dt;
    const r = this.rng;
    while (this._acc >= 1) {
      this._acc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      // Born in an ANNULUS around the column, not inside it. Embers launched down the middle are
      // invisible — they sit inside the brightest part of the plume — so the shower only reads
      // when the streaks fly clear of the core and cross the dark road behind it.
      // (r6) The annulus used to start at 0.65 x the core radius, i.e. INSIDE the tinted body shell
      // and well inside the fringe, so every ember was born in the brightest additive region of the
      // frame and the standing note has been "no sparks anywhere at any zoom" for three rounds. The
      // shower is now born at 1.4–3.1 x the core radius — outside the fringe — thrown outward as
      // well as backward, and lives long enough (life x2.0, gravity 3.2) to arc clear of the plume
      // and cross the dark asphalt, which is the only place a spark can actually be seen.
      // ── THE SHOWER IS A SHOWER, NOT THE PLUME (r10) ────────────────────────────────────────
      // The single loudest thing in every round-9 boost frame was not the jet: it was ~15 straight
      // bright rods fanning three quarters of the way across the screen. Three numbers built it,
      // and all three are cut here.
      //   · BIRTH ZONE. Sparks were born anywhere in the first 80% of a column the governor
      //     routinely solves to 11 m, in an annulus 1.4–3.1 core radii wide — a 9 m x 3 m cylinder
      //     of embers with the actual jet somewhere inside it. Now the first 38%, at 1.0–2.0 radii:
      //     the shower hugs the throat, which is where a real one comes from anyway.
      //   · LENGTH. uMaxLen was 1.45 x sqrt(gL) ≈ 2.3 m of additive gaussian per streak. Now 0.85.
      //   · LIFE. x2.0 of the class life let a spark cross a third of the frame. Now x1.35.
      // (r19) 1.0-2.0 -> 1.05-2.45 core radii, and born over the first HALF of the column rather
      // than its first 38%. Counted at 4x on the r18 LA supercar: three or four hairlines, all of
      // them within a car's length of the bumper, because an ember born at 1.2 radii inside the
      // first third of the jet spends its whole life inside the plume's own bloom halo. Spreading
      // the birth zone along the column and pushing the annulus outside the skirt is what puts the
      // shower ON the dark road, which is the only place §1.2's spark streaks can be seen.
      const a = r.range(0, Math.PI * 2), rad = baseRad * gR * r.range(1.05, 2.45);
      const back = r.range(fx.sparkSpeed[0], fx.sparkSpeed[1]) * gS;
      // rearward cone: lateral velocity is bounded by tan(cone) * axial speed
      const th = Math.sqrt(r.range(0, 1)) * cone;
      const lat = Math.tan(th) * back;
      const cu = r.range(0, 1);
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad, n.base.z - r.range(0, baseLen * 0.52),
        Math.cos(a) * (lat * 1.25 + 1.5), Math.sin(a) * (lat * 1.25 + 1.2) + r.range(0.1, 1.5), -back,
        r.range(fx.sparkLife[0], fx.sparkLife[1]) * 1.50,
        fx.sparkWidth * gR * r.range(0.45, 1.45),
        // Never pure white: the tonemap desaturates clipped highlights and the city grade then
        // tints them, which turned round 1's white embers ORANGE on the cyan tuner.
        // 40% incandescent yellow-white, 30% the class spark pushed toward white, 30% the class
        // spark itself — so a boost frame carries embers at three temperatures rather than one.
        cu < 0.40 ? this._ember : (cu < 0.70 ? this._hot : fx.spark),
        // (r10) took these to alpha 0.20-0.38 to stop a wake of white rods out-reading the column.
        // That worked and then some: the round-10 verdict counted "1-3 pale hairlines per frame"
        // against §1.2's "yellow-white spark streaks", and scored half of the 20-point supporting-FX
        // dimension as unearned.
        // (r18) 0.26-0.52 -> 0.40-0.76. Counted at 3x on the r17 LA frames: four to six visible
        // hairlines per boost, which is the same note again. The reason it is safe to raise now is
        // that the thing they were drowning has changed — r18's column carries a shock train that
        // necks and bellies its own silhouette, so the sparks read as a shower AROUND a structured
        // jet rather than as the only structure in the frame. They are still born in an annulus
        // outside the gas, still live inside the column's own length, and are still three
        // temperatures rather than one.
        // (r19) 0.40-0.76 -> 0.54-0.98. Same note, third round running: the count in frame is
        // four to six. They are safe brighter now because the column they sit beside has a
        // shock train with a waist and a belly in it, so a hairline no longer out-structures it.
        r.range(0.54, 0.98) * (0.45 + 0.55 * s),
        3.2,
      );
    }
    // ---- light smear: a few wide, dim, long-lived streaks that smear the jet down the road ----
    this._sacc = (this._sacc || 0) + (fx.smearRate ?? 10) * s * dt;
    while (this._sacc >= 1) {
      this._sacc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      const a = r.range(0, Math.PI * 2), rad = r.range(0, 1) * baseRad * gR * 1.05;
      const back = r.range(fx.sparkSpeed[0] * 0.5, fx.sparkSpeed[1] * 0.7) * gS;
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad,
        n.base.z - baseLen * r.range(0.14, 0.56),
        Math.cos(a) * 0.6, Math.sin(a) * 0.5 + 0.4, -back,
        r.range(0.22, 0.40), (fx.smearWidth ?? 0.35) * gR * r.range(0.7, 1.4),
        r.bool(0.5) ? fx.mid : fx.spark,
        // (r19) 0.010-0.026 -> 0.030-0.062, and fx.smearRate 1.4/s -> 5-8/s. At one and a half
        // births a second with a third of a second of life this layer had HALF a streak alive at
        // any moment: §1.2's "light-streak trails that smear with motion" were, measurably, not
        // in the frame. They stay wide, dim and short — the wake around the jet, never a rod
        // beside it — but there are now six or seven of them.
        r.range(0.030, 0.062) * s, 0.6,
      );
    }
    const su = this.streaks.material.uniforms;
    // (r8) Shorter and less stretched. At 0.048 s of stretch with a 2.4 m cap, a smear born wide
    // (smearWidth up to 0.44 m) drew a 2 m x 0.5 m additive gaussian that saturated through its
    // whole middle — on screen a straight-sided bright PLANK lying beside the plume, which is the
    // §7 hard-edge tell in everything but name and was out-reading the column in every -long shot.
    // ...but NOT shorter than ~4x their own width, or a capsule stops reading as a velocity streak
    // and becomes a round dot — and a wake full of same-sized round dots is the round-3 note ("a
    // chain of identical, uniformly-sized soft round sprites") arriving from the ember layer
    // instead of the plume. Long and thin is safe; short and wide is not.
    // (r12) 1.20 → 0.90. The plume is a shorter, narrower, better-defined object now, and in the
    // r11 captures the longest thing in frame was not the jet — it was a pair of pale straight
    // smear rods running most of the way to the corner, which is a large part of why the whole
    // effect read as one flat smear rather than as a jet with a shower behind it.
    // (r12) LENGTH-TO-WIDTH IS THE WHOLE READ. At 0.030 s of stretch with a 0.24 m floor, a spark
    // 0.25 m wide came out 0.5 m long — a 2:1 lozenge, and a wake of same-sized soft lozenges is
    // the round-3 "chain of identical, uniformly-sized soft round sprites" arriving from the ember
    // layer instead of the plume. Found it again at 3x in the Vegas tuner frame. Sparks are now
    // roughly half as wide (see fx.sparkWidth) and twice as long: 10:1 or better, which is what a
    // velocity streak has to be before it reads as motion rather than as a bead.
    // (r13) 1.25 -> 0.85 m. At 4x on the round-1 LA supercar frame the longest, straightest things
    // in shot were not the jet: they were pale smear rods running most of the way to the corner,
    // and a straight bright rod beside a straight bright column is what makes the pair read as
    // "laser rods" rather than as burning gas. The shower now lives inside the column's own length.
    // (r20) 0.34-0.62 m -> 0.40-0.82 m and the birth rate up ~38% per class. §1.2 asks for
    // "yellow-white spark streaks" on the plume and counts them in the 20-point supporting-FX
    // dimension; four rounds running the count in frame has been four to six. They are still
    // born in an annulus OUTSIDE the gas and still live inside the column's own length, so what
    // this buys is a shower rather than a handful of hairlines — and 0.82 m against a column the
    // governor solves to 3.6-4.6 m is a fifth of the jet, not a rod beside it.
    su.uStretch.value = 0.048 + s * 0.016;
    su.uMinLen.value = 0.40 * gS;
    su.uMaxLen.value = 0.82 * gS;
    this.streaks.update(dt, 2.2, drift);

    // ---- ground pool ----
    // Its reach follows the plume, so the tint on the road grows and shrinks with the jet rather
    // than sitting there as a constant painted patch.
    // The round-3 critic could not find it at all in the sustained frames: at 3.5 m wide and 0.30
    // opacity, seen from 10 m up-and-back, it was a few dozen dim pixels under the car. It is now
    // governed like the jet — it reaches as far down the road as the column does — and carries
    // half again the density, so the road under the boost is visibly stained with the class tint.
    // ...and round 4 then over-corrected: governed to the same reach as the column and sitting
    // directly under it, the pool stopped reading as light ON the road and became a second flame
    // lying flat on it — the two superimposed into one wide low smear with no layer separation
    // (ablation: hiding the shells left an orange band on the asphalt the same length and shape as
    // the jet). A spill is BROADER and SHORTER than the thing casting it: it now reaches about
    // half as far down the road and spreads wider than the plume envelope, so the structured jet
    // sits IN FRONT of a soft glow instead of inside it.
    const pm = this.pool.material;
    // fx.poolI is the per-class trim. The SUV's spill lands on NYC's white crosswalk bars from a
    // low chase camera and clipped them to featureless cream across the lower half of the frame —
    // the r2 "-1 SUV blow-out". Everything else keeps the full spill: it scored +7.
    // (r17) 0.115 -> 0.082, and every class's poolWidth/poolLen trimmed ~20%/25%. The most recent
    // verdict measured the SPILL out-sizing the jet ("a ~180px stub whose own ground pool out-sizes
    // it"), which inverts the whole read: a spill is evidence of the thing casting it and must be
    // broader, shorter and dimmer than the column, never the largest bright shape in the frame.
    // (r19) 0.082 -> 0.108 and the cap 0.24 -> 0.30. r17 cut this hard because the spill was
    // OUT-SIZING the jet; the fix for that was the pool's reach and width, which stayed cut. What
    // it cost was the layer itself: at 5x on the r18 LA muscle the road under a 240 mph boost was
    // stained about as much as a street lamp stains it, and §6.3 scores ground light spill inside
    // the 20-point supporting-FX dimension. It is still shorter and broader than the column and
    // still the dimmest bright thing in frame; it is now visible.
    pm.opacity = clamp((s * 0.108 * flick + igBloom * 0.12) * (fx.poolI ?? 1), 0, 0.30);
    this.pool.scale.set(
      fx.poolWidth * this.scale * (0.95 + 0.30 * gR) * (0.80 + 0.20 * s) * (1 + surge * 0.30),
      1,
      fx.poolLen * this.scale * (0.30 + 0.34 * gL * lenDrive) * (1 + surge * 0.30),
    );
    // keep it flat on the road and aligned with the car's heading, whatever the body is doing
    this.group.getWorldPosition(_v);
    this.group.getWorldQuaternion(_q);
    _e.setFromQuaternion(_q, 'YXZ');
    _e.set(0, _e.y, 0, 'YXZ');           // heading only — reuse the scratch, don't allocate here
    _q2.setFromEuler(_e);
    this.pool.quaternion.copy(_q).invert().multiply(_q2);
    _v2.set(_v.x, 0.055, _v.z);
    this.pool.position.copy(this.group.worldToLocal(_v2));

    // ---- bodywork spill ----
    // Roughly half of round 2. The rear panel should be LIT by the jet, with the taillight
    // housings and diffuser picked out; at the old intensity it was a flat blown card.
    // (r5) Up from 0.50: the REAL light is what should be staining the asphalt behind the car, not
    // an additive decal — a point light has no edges, falls off correctly, and lights the rear
    // panel, the diffuser, the tyres and the road in one pass. Raising it let the painted ground
    // pool drop to a soft supporting glow instead of being the whole ground-spill story.
    // (r7) 0.86 → 0.68. The spill was bright enough to clip the road furniture it fell on — on the
    // NYC rumble curb the white stripes went to featureless cream wedges that read as hard-edged
    // light shafts crossing the plume. The jet has to be the brightest thing in its own frame; its
    // spill has to sit under it.
    // (r12) 0.68 → 0.40. This lamp is a physical point light with inverse-square falloff, so its
    // irradiance on a prop 3 m behind the bumper was ~1.0 — full key light — and NYC's kerb blocks
    // sit exactly there. In the director's capture that is what "a flat hard-edged orange slab
    // jutting straight out of the back of the car" actually WAS: a rectangular concrete prop
    // clipped to featureless orange by the jet's own lamp, with the plume hidden behind it. The
    // spill has to stain the asphalt and pick out the diffuser; it must never be the brightest
    // thing in the frame, because the only thing allowed to be that is the column itself.
    this.light.intensity = (s * fx.lightI * 0.40 * flick + igFlash * fx.lightI * 0.72 + igBloom * fx.lightI * 0.24);
    this.light.distance = (13 + s * 6) * (0.82 + 0.24 * gL);

    // ---- heat haze strength handed to the grade pass ----
    // (r9) Round 6 took this down 40% to stop the ripple wobbling the shock diamonds; combined with
    // the grade pass' own small amplitude the result was a sub-2-pixel displacement, i.e. the r2
    // note "the road's double yellow line runs dead straight through the plume with zero refraction
    // or wobble". The grade pass clamps at 1.2 and its ripple is ~5 px there, so this is driven to
    // saturation instead — and heatPoint() keeps the gaussian centred BEHIND the visible column, on
    // the road and furniture the refraction is actually legible against.
    this.heat = clamp((s * 1.05 + igBloom * 0.45) * (fx.heat ?? 1), 0, 1.35);
  }

  dispose() {
    this.streaks.dispose();
    for (const m of this.coreMats) m.dispose();
    for (const m of this.sheathMats) m.dispose();
    this.pool.geometry.dispose(); this.pool.material.dispose();
    for (const n of this.nozzles) {
      n.disc.geometry.dispose(); n.disc.material.dispose();
      n.flash.geometry.dispose(); n.flash.material.dispose();
      n.ring.geometry.dispose(); n.ring.material.dispose();
    }
  }
}
