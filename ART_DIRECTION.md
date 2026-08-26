# ART_DIRECTION.md
### The rubric for *NITRO CIRCUIT* — an arcade driving game in the spirit of Fast & Furious: Arcade Edition

This document is the **single source of truth** for every critic agent in this project. It is written
once, from a single grounded pass over the five reference screenshots in `./references/`, and it is
not revised to accommodate what the build happens to produce. Builders do not score themselves.
Critics score **rendered screenshots from the real running build**, never a builder's description of
their own work.

---

## 0. How this document is used

- **Builders** read §2–§4 to know what "correct" looks like, and §6 for their piece's specific bar.
- **Critics** read §5 (scoring discipline), §6 (their piece's rubric), §7 (hard caps), and score.
- A critic outputs: a **number 0–100**, the **single biggest gap**, and a **concrete instruction**
  for the builder. Not a list of ten things. One gap — the one whose fix moves the score most.
- If the score is below the piece's target band, it goes back to the builder. There is no fixed
  round count. The loop ends when the target band is met, or when three consecutive rounds fail to
  move the score by more than 2 points (a plateau — escalate to a human decision instead of grinding).

> **Generous scoring produces a worse game.** A critic that hands out 85 for competent work removes
> the only pressure that would have made it good. Every point above 75 must be *earned against a
> specific named quality* in this document. If you find yourself wanting to give a high score because
> the builder clearly worked hard, that is precisely the moment to give the honest lower number.
> Almost nothing should score 88+ on an early round. A first-round 90 is a bug in the critic.

---

## 1. What the reference actually looks like

*Written from the five screenshots in `./references/`, viewed once. These descriptions — not the
image files — are the comparison target for the rest of the project.*

### 1.1 `f&f1.jpeg` — coastal fortress circuit, bright day

A tropical harbor road at midday. The sky is a deep saturated cyan-blue with crisp white cumulus,
clearly a **strong single sun** high and slightly behind-left of camera. Left of the road: turquoise
harbor water and a large white motor yacht at a dock, with blue-and-white barrier panels lining the
track edge. Center-left: a **sandstone Spanish colonial fortress** — layered ochre stone towers with
crenellations and arched gun ports — sitting on a rocky bluff, the unmistakable landmark that tells
you *where you are* in one glance. Right of the road: a row of tall palms and a cream stucco
colonnade with regular arches, warm-lit.

The road is dark near-black asphalt, wet-looking with a broad specular sheen. Down the center runs a
**boost strip**: a rectangular panel of red-orange chevrons that is visibly emissive, throwing a
dense stream of **yellow-orange spark particles** that arc up and backward past the player car and
fade over roughly a car length. The right shoulder is a **red-and-white striped rumble curb**.

The player car is a **teal/mint muscle coupe with twin white racing stripes** — a real fastback
silhouette, long hood, short deck, wide rear haunches. It has chrome rear bumper trim, four round
taillights glowing red, a black rear spoiler, and visible chrome exhaust tips. A red mid-engine
supercar is overtaking on the right, close enough to read its rear diffuser. Both cars have
**glossy clearcoat paint** — a bright sharp sky reflection sits on the upper body panels and a dark
ground reflection on the lower, which is what separates real car paint from flat colored plastic.

HUD: top-left, a black **angled-parallelogram plate** with a yellow-orange accent chevron holding
`1st` in heavy italic white. Below it `02:13:88` in cyan digits in a thin cyan-bordered box, then an
8-entry leaderboard of driver names, the player's row highlighted. Top-center: a red seven-segment
countdown `08:87` on a black plate. Bottom-right: a large **circular analog speedometer** — white
and cyan ring, radial tick marks numbered 0–8, a needle, `150` large in white with `MPH` beneath,
and a red danger arc across the top-right of the dial; below it a small orange `NITRO X3` badge.
Bottom-center: two pale triangular arrow indicators.

### 1.2 `f&f2.jpeg` — mountain canyon, day, mid-pack spectacle

A dusty warm-gray canyon road. Left: a tall layered rock cliff with horizontal strata and patches of
green scrub and pine. Right: **red-and-white striped concrete jersey barriers** with a sheer drop
behind. Overhead light is bright and neutral, with real shadow contact under every car.

This frame is about **spectacle density**: four cars ahead in a tight pack — a pink coupe, a
purple-blue lifted truck, a red muscle car with a **supercharger blower through the hood**, and the
player's blue-and-red liveried supercar, which is firing **white-hot blue nitrous plumes** from twin
rear outlets. The plumes are not soft puffs; they are bright, banded, cone-shaped jets with a white
core and blue fringe, throwing **yellow-white spark streaks** and light-streak trails that smear with
motion. Tire smoke and speed lines fill the lower third. Black rubber skid arcs are baked into the
road behind the pack.

HUD adds a top-right element: an orange-and-black angled banner reading `YELLOWSTONE` with
`MISSION RECORD: 2:09:00` beneath it — **the location is named on screen**.

### 1.3 `f&f3.jpeg` — old-town fortress circuit, night, neon

Night. Cool deep blue-gray ambient. A stone castle wall and towers occupy the right and background,
lit from below by warm amber floods. The road is **wet cobblestone** with strong vertical specular
streaks — every light source in the scene draws a long reflection down the stone, which is doing most
of the work of making the night read as expensive.

The landmark spectacle: **three enormous green neon torus gates** arcing over the road, glowing hard
enough to bloom, with visible light spill on the wall behind them. Magenta-purple neon signage glows
on the left building; blue-white spotlights beam upward into the haze; warm amber street lamps line
the road. The palette is deliberately **three-color neon** — green, magenta, blue-white — against
near-black stone, with the warm amber lamps as the only tie to daylight color.

The player car is a **dark maroon mid-engine supercar** from behind: two large round red taillight
rings, a visible engine cover with vents, a roll hoop, a wide low diffuser. Its brake lights bloom
into the wet road. A car far ahead leaves a blue nitrous trail. The nitro badge reads `NITRO x0` and
is dimmed — **the HUD shows depletion state, not just a static graphic**.

### 1.4 `f&f4.jpeg` — car select / garage

Interior garage: **teal-turquoise painted brick wall**, wooden workbench with scattered tools, a red
oil drum, gray concrete floor with subtle reflections. Warm practical lights from above.

Center stage: a hero **1970 Dodge Charger in green over black**, supercharger through the hood,
three-quarter front view, lit with a strong warm key from the front-left and a cool rim from behind
that separates it from the wall. Around it, a **radial fan of ~10 angled parallelogram thumbnail
tiles**, each holding a different car — red supercar, blue coupe, green muscle, yellow classic, teal
coupe, black-red lifted truck, gray off-roader. The selected tile carries a **gold-yellow glow
border**. Top-right: a `Mission Recap` list of destinations (Swiss Alps, Abu Dhabi, Hong Kong, Havana,
Yellowstone, Colombia) with colored bullets. Bottom-left: three gradient stat bars — `SPEED` in
red-pink, `TRACTION` in magenta-purple, `ACCELERATION` in blue-cyan. Bottom bar: black, with
`NAVIGATION / SELECT CAR / CHANGE COLOR / BACK` beside button glyphs, and the car name
`1970 DODGE CHARGER` set large in **beveled metallic italic capitals**. A `P1` badge sits top-left.

### 1.5 `f&f5.jpeg` — coastal boulevard, day, set-piece

Warm afternoon light on a palm-lined coastal boulevard with cream colonial buildings and a dark rocky
headland. A **CH-47 Chinook helicopter hovers low directly over the road ahead of the player** — the
scripted set piece, rotors turning, close enough to dominate the frame. Beyond it, an ornate black
iron gate and a cluster of **magenta-purple glowing panels** on a structure to the right.

The player car is a **bright turquoise metallic fastback muscle car caught mid-drift** — body yawed
maybe 20° from its direction of travel, front wheels counter-steered, a **white puff of tire smoke**
blooming off the inside rear wheel, chrome five-spoke wheels, black rear wing, four round taillights.
The road is dark asphalt with a **double yellow center line** and red-and-white striped barriers on
the left. A dark red muscle car sits at the right edge of frame.

### 1.6 What all five frames share

1. **Saturated, high-contrast, candy color grading.** Nothing is desaturated or gray-flat. Shadows
   keep color (cool blue at night, warm brown in day) and never crush to pure black.
2. **A strong, obvious key light** plus visible bloom on every emissive. Highlights blow out on
   purpose.
3. **Real-world car silhouettes.** These are recognizably a Charger, a Mustang, a GT, a lifted truck.
   Proportion — hood length, roofline, wheel arch fill, ride height, track width — is doing the work.
   The cars are *glossy*, with a sky reflection above and a dark ground reflection below.
4. **Roads read as roads:** dark asphalt, painted lane lines, striped rumble curbs, jersey barriers,
   baked-in skid marks, and at night, wet specular streaks.
5. **Spectacle is constant and large:** neon gates over the track, a helicopter in the road, boost
   strips throwing sparks, nitrous plumes, tire smoke, packs of cars close enough to touch.
6. **Every environment is identifiably a real place** within one second of looking at it, because of
   one or two large silhouette landmarks plus a committed palette.
7. **The HUD is angled, layered, and busy** — parallelogram plates, italic heavy type, cyan/orange
   accents, a big circular gauge bottom-right, a numbered leaderboard top-left, a named location.

---

## 2. The distilled visual language (the build target)

### 2.1 Color and grading
- Every scene commits to a **named palette of 3–5 hues** and repeats them across sky, lights, props,
  and emissives. Anything that is "just gray" or "just brown" is a failure.
- Deep shadows are **tinted**, never `#000`. Day shadows lean warm-brown or cool-blue-violet;
  night shadows lean deep indigo.
- Final image passes through a **filmic tonemap + saturation lift + slight S-curve**. Highlights roll
  off rather than clipping to flat white. A vignette darkens corners ~15–25%.
- Bloom is applied to emissives only (threshold-based), strong enough to halo neon and taillights but
  never so wide that the whole frame fogs.

### 2.2 Light
- One dominant directional key with a warm or cool bias per city, plus a hemisphere/ambient fill
  carrying the **sky color into the shadows**.
- Cars receive an environment reflection — a procedurally generated cube/equirect env map matching
  the city's sky and ground — so paint reads as clearcoat, not vinyl.
- Night cities are lit by **emissive geometry** (signs, windows, neon tubes, headlights) and their
  spill, not by a bright ambient term. Wet road reflection is mandatory at night.

### 2.3 Cars
- Silhouette first. A class is only correct if you can name it from a black-on-white outline:
  low compact hatch/sedan; long-hood short-deck fastback; tall square high-clearance 4×4; low
  cab-forward wedge with a mid-engine deck.
- Required detail on every class: separate glass with its own material, wheel arches that the tires
  actually fill, chrome/dark trim strips, headlights and taillights as **emissive** elements,
  side mirrors, exhaust outlets, a visible rocker/sill line, and wheels with real spokes and a
  distinct dark tire with a sidewall.
- Paint: metallic base + clearcoat, class-appropriate roughness. Livery (stripes, two-tone, panels)
  drawn procedurally into the texture, not implied by vertex color.

### 2.4 Track and world
- Roads are ribbon meshes with painted markings, shoulder curbs, and edge geometry — never a flat
  untextured plane. Skid marks accumulate.
- The world is layered for depth: **near props** (barriers, lamps, signs, palms, hydrants) →
  **mid buildings** with real facade texture → **far skyline silhouette** → **sky**. All three
  distances must be populated or the world reads as a diorama.
- Each city needs **at least two large landmarks** legible in silhouette from the road.
- Shortcuts and ramps must be *visible as opportunities* — a lit alley mouth, a broken barrier, a
  ramp with chevrons — not invisible geometry the player discovers by accident.

### 2.5 Spectacle
- Nitrous: a bright banded jet with a white core, class-tinted fringe, sparks, heat-haze or streak
  trails, a camera FOV punch, and a grade shift. It must be readable as "the biggest thing on screen".
- Crashes: sparks at the contact point, debris, smoke, screen shake, and a brief slow/impact frame.
- Drifting: smoke from the loaded wheels, skid marks laid to the road, sparks on wall scrapes.

### 2.6 UI and type
- All type is generated in code. Heavy, italic, condensed capitals for headings; a seven-segment face
  for countdowns; a clean geometric face for lists.
- Panels are **angled parallelograms** with a 2–3px accent edge, black or near-black fills at 70–90%
  opacity, cyan and orange accents.
- The HUD must show, at minimum: position, lap/total time, an 8-entry leaderboard, the city name, a
  circular speedometer with needle and MPH readout, and a nitro charge indicator that visibly
  depletes and recharges.

---

## 3. Non-negotiable constraints

Violating any of these is an automatic **hard fail** regardless of how the frame looks:

1. **Every mesh, texture, sound, and font is generated in code at load time.** No `.glb`, `.gltf`,
   `.obj`, `.fbx`, `.png`, `.jpg`, `.hdr`, `.exr`, `.mp3`, `.wav`, `.ogg`, `.ttf`, `.woff`, no
   data-URI-encoded asset that is really a baked file, no CDN fetch, no external font stack. The
   Three.js library itself is the only third-party code.
2. Textures come from `CanvasTexture` / `DataTexture` written by our own procedural generators.
3. Audio comes from the Web Audio API — oscillators, noise buffers we fill ourselves, and filters.
4. Fonts come from our own vector glyph tables rendered to canvas. Using a browser-installed system
   font family (`Arial`, `Impact`, …) counts as an imported asset and is a hard fail.
5. The game must run at **≥ 50 fps at 1600×900** on the target machine, and must not leak memory
   across a city or vehicle change.

---

## 4. Global scoring bands (calibrated)

These bands describe the **whole frame or the whole system** for the piece being judged. Anchor
against them literally; do not drift upward out of politeness.

| Band | Name | What it looks like |
|---|---|---|
| **0–40** | *Programmer art* | Untextured or single-flat-color primitives. Box cars. Default Three.js lighting or `MeshBasicMaterial`. No post-processing. Flat gray road plane. A HUD of unstyled browser text. It is instantly obvious that this is a technical test, not a game. |
| **40–60** | *Competent hobby project* | Recognizable shapes, some texture, a directional light and a shadow. But: proportions are off, materials are uniformly matte or uniformly shiny, the palette is muddy or arbitrary, the world is sparse and repetitive, FX are billboard sprites with visible seams, and the UI is aligned but unstyled. Obviously not commercial. Most first-round builder output lands here. **Be willing to score in this band.** |
| **60–75** | *Good indie arcade racer* | A committed palette, real post-processing (bloom + tonemap), cars with correct silhouettes and glass/lights/wheels as separate materials, a road with markings and curbs, populated mid-ground, a styled HUD. Reads as a finished small game. The tells are density and polish: repeated props, thin far distance, FX that don't layer, type that isn't quite designed. |
| **75–88** | *Near-professional* | Strong art direction with per-city identity, layered depth to the horizon, believable car paint with env reflections, multi-element FX (core + fringe + sparks + trails), skid marks and smoke that persist, a HUD with real typographic hierarchy and animated state. **A trained eye still spots the tells**: a landmark that's a bit crude up close, particle sprites that pop in, an interior that's a black void, shadow acne, a curve in the road where the mesh pinches. |
| **88–95** | *Shipped arcade AAA* | Nothing in frame reads as procedural. Every distance band is populated and art-directed. Light, color, and spectacle are composed as a picture, not accumulated as features. FX read as physical events with weight. The UI looks like a designer owned it. You could screenshot any random frame and it would sell the game. |
| **95–100** | *Reserved* | Effectively unreachable in this project. Do not award. |

**Anti-inflation rules for critics:**
- Start from 50 and justify every move up with a specific named quality **and where you see it in the
  screenshot**. "Looks good" is not justification.
- A single hard tell from §7 caps the score at the value listed there, no matter what else is right.
- If you cannot name the specific thing that would take the piece from its current score to +10, the
  score you gave is too high — you are not looking closely enough.
- Round 1 ceiling: **75**. Round 2 ceiling: **85**. 88+ requires at least three completed rounds and
  an explicit statement of what was fixed in each.

---

## 5. Scoring discipline

1. **Score the screenshot, not the summary.** If you were handed a builder's write-up and no image,
   your score is invalid. Re-run the capture harness yourself.
2. **Look at the actual pixels.** Zoom into the car body, the road surface, the horizon, the HUD
   edges. Most of the difference between 65 and 85 is visible only at that level.
3. **Name one gap.** The instruction back to the builder is one sentence describing the single
   change with the largest score impact, plus one sentence of concrete direction on how.
4. **Functional failures are separate.** If the harness reports a control bug, a stuck menu, a
   console error, or a crash, report it alongside the visual score. A frame that looks like 80 in a
   build where nitrous doesn't fire is still a broken build.
5. **State the round number and what changed since the last round.** If nothing visibly changed,
   say so and do not move the score.

---

## 6. Per-piece rubrics and target bands

Each piece is scored on its own dimensions. `Target` is the band the piece must reach before the loop
for that piece ends.

### 6.1 Vehicle models — 4 classes · **Target 82**
Dimensions: silhouette accuracy per class (25) · paint and material realism, incl. env reflection and
clearcoat (20) · detail completeness — glass, lights, mirrors, exhaust, trim, sills (20) · wheels and
tires — spokes, sidewall, arch fill, correct track width (15) · class differentiation at a glance (10)
· livery and color design (10).
*Caps:* any car whose body is visibly a stack of unmodified boxes → **max 45**. No separate glass
material → **max 55**. Wheels that don't fill the arches or float → **max 60**.

### 6.2 Handling and drift feel — 4 classes · **Target 80**
Judged from telemetry traces + a drift screenshot sequence, not one still.
Dimensions: four classes measurably distinct in top speed / accel curve / grip / mass (25) · drift
initiates predictably and is *held* with counter-steer rather than spinning out (25) · weight
transfer visible in body roll, pitch under brake, squat under throttle (20) · speed sensation —
camera pullback, FOV, screen effects scale with velocity (15) · recovery and controllability after a
slide or hit (15).
*Caps:* car spins uncontrollably on any drift input → **max 45**. No visible body roll or pitch →
**max 65**. All four classes feel the same in telemetry → **max 55**.

### 6.3 Nitrous mechanic — **Target 85**
Dimensions: the jet itself — core, fringe, banding, length, flicker (25) · supporting FX — sparks,
trails, heat distortion, ground light spill (20) · camera and grade response — FOV punch, shake,
saturation/speed-line shift (20) · per-class differentiation in both feel and look (15) · audio —
spool, ignition crack, sustained roar, cutoff (10) · HUD charge/deplete feedback (10).
*Caps:* nitrous is a single expanding transparent sprite → **max 50**. No camera response → **max 65**.
Identical across all four classes → **max 70**.

### 6.4 Cities — LA · Las Vegas · Miami · NYC · **Target 84 each**
Dimensions: instant geographic legibility — could a stranger name the city in one second (25) ·
landmark quality and silhouette (15) · palette and lighting identity distinct from the other three (15)
· depth layering: near props / mid buildings / far skyline / sky all populated (15) · road surface and
furniture quality — markings, curbs, barriers, lamps, signage (15) · track design: corner variety,
readable shortcuts and ramps, route variation (15).
*Caps:* buildings are untextured extruded boxes → **max 50**. No far skyline layer → **max 62**.
Two cities that could be swapped without anyone noticing → both **max 60**. No visible shortcut or
ramp → **max 70**.

### 6.5 Lighting and post-processing look — **Target 85**
Dimensions: grading — palette commitment, tinted shadows, filmic rolloff (25) · bloom quality —
threshold, spread, no full-frame fog (20) · env reflection and specular behavior on cars and wet road
(20) · atmosphere — fog/haze depth cueing, god rays or light shafts where appropriate (15) ·
supporting effects — vignette, chromatic aberration, motion blur, speed lines, all subtle (10) ·
consistency across all four cities and both times of day (10).
*Caps:* no tonemapping / raw sRGB output → **max 45**. No bloom → **max 55**. Identical grade in all
four cities → **max 65**.

### 6.6 Collision and crash spectacle — **Target 82**
Dimensions: impact FX — sparks with correct direction, debris, smoke (25) · camera response — shake,
kick, brief time dilation (20) · vehicle response — spin, deformation or damage state, recovery (20) ·
environment response — props that move, break, or scatter (15) · audio — impact layers by severity
(10) · it never breaks the race: no clipping through the world, no unrecoverable stuck state (10).
*Caps:* collision is a hard stop with no FX → **max 40**. Car can pass through walls → **max 50**.
No screen shake → **max 65**.

### 6.7 HUD — **Target 85**
Dimensions: typographic quality of the procedural font — weight, italic, spacing, no jaggies (25) ·
layout and hierarchy matching §2.6 (20) · the speedometer as a designed object — ticks, needle
motion, danger arc, readout (20) · state animation — position changes, nitro depletion, lap flash,
countdown (15) · panel styling — angles, accents, opacity, edges (10) · legibility over a bright
moving scene (10).
*Caps:* uses a system font family → **hard fail per §3**. Unstyled rectangular boxes → **max 50**.
Static HUD with no animated state → **max 65**.

### 6.8 Menu / car select — **Target 80**
Dimensions: staged 3D hero car with dedicated lighting (25) · tile/selector design and layout (20) ·
type and stat-bar design (20) · transition and motion polish (15) · city select clarity (10) ·
input responsiveness, no dead ends (10).

### 6.9 Audio — **Target 80**
Judged by listening to captured WAV renders, plus code review of the synthesis graph.
Dimensions: four engines audibly distinct in character, not just pitch (25) · RPM/load response —
convincing acceleration, off-throttle, upshift (25) · nitrous sound design (15) · tire squeal, impacts,
surface changes (15) · mix — nothing clipping, nothing buried, sensible spatialization (10) ·
music/ambience bed (10).

### 6.10 Race systems and feel — **Target 78**
Opponent AI that is close and aggressive without being unfair, rubber-banding that isn't obvious,
checkpoints, lap logic, position tracking, race start/finish sequences.

### 6.11 Whole-game coherence — **Target 84**
Judged only by the integration agent between waves. Do all four cars work in all four cities? Is the
grade consistent? Do menus flow into races and back? Does anything visibly regress when systems are
combined?

---

## 7. Hard caps — the tells that give it away

If any of these is visible in the screenshot, the score for that piece cannot exceed the listed value,
no matter how good the rest is. These exist because they are the specific things that separate 75 from
88 and they are otherwise easy to hand-wave past.

| Tell | Cap |
|---|---|
| Untextured `MeshStandardMaterial` in a flat color on any large surface | 50 |
| Visible texture tiling repeat on the road or a facade within one screen | 65 |
| Z-fighting, shadow acne, or peter-panning shadows | 60 |
| Geometry seams — a gap between road and shoulder, a pinched mesh on a tight corner | 62 |
| Particles as unrotated camera-facing squares with visible hard edges | 58 |
| Emissive surfaces with no bloom, or bloom with no emissive source | 60 |
| Car interior is an empty black void through the glass | 72 |
| No contact shadow under the car — the car appears to hover | 55 |
| Horizon is a hard line between two flat colors | 58 |
| Anything visibly popping in or out as the camera moves | 70 |
| Aliased, jaggy text or UI edges | 68 |
| The same prop mesh repeated at a visible regular interval | 66 |
| Frame rate below 50 fps at 1600×900 | 70 |

---

## 8. Screenshot protocol

Critics must capture from the **real running build** via `node tools/shot.mjs`, never from a
builder-supplied image. Standard captures:

- **Chase** — default follow camera, car at speed, mid-track.
- **Drift** — mid-slide with visible yaw angle and smoke.
- **Nitrous** — 0.4 s into a boost, rear three-quarter.
- **Landmark** — a framing that includes the city's primary landmark.
- **Night/lighting** — the city's most lighting-dependent viewpoint.
- **HUD** — full 1600×900 frame, unscaled, for reading type quality.
- **Crash** — 0.2 s after a wall impact.
- **Menu** — car select with a car highlighted.

Capture at **1600×900**, PNG, with the game's fixed seed and deterministic time-step so two runs of
the same command produce the same frame. Always look at the full-resolution file, not a thumbnail.

---

## 9. Blind comparison — the tie-breaker when a score moves

An absolute score from a fresh critic carries **±5–8 points of inter-judge variance**. That is
smaller than the gap between bands, so absolute scoring is fine for answering *"is this piece good
yet?"*. It is **not** reliable for answering *"did this round make it better or worse?"*, because a
round's score and the previous round's score come from two different judges, and the difference
between them is inside the noise.

Wave 10 proved this in both directions at once. Nitrous scored 76 → 74 → 68 across three critics,
which looked like a collapse; vehicles scored 69 → 76 → 71, which looked like a round-2 regression.
A blind A/B/C judge then found that the nitrous "collapse" was **real and worse than it looked**
(the pre-wave jet beat both later rounds by a full category, 72 vs 62 vs 58, because both rounds had
deleted the white-hot core) while the vehicles "regression" was **only 3 points and barely
defensible** — the judge would not defend more than that, and the actual defect was one narrow,
repairable fault in the dark end rather than a reason to revert the round.

Two opposite conclusions, neither of which the absolute scores supported correctly.

**So: when a piece's score moves and the decision is whether to keep, repair or revert, do not act
on the score. Run a blind comparison.**

The protocol:

1. **Render the same scenarios from each git revision** into separate worktrees, sequentially — one
   browser at a time, so timing differences are not mistaken for code differences. Verify each
   revision renders a real, non-black frame before capturing; a silent black frame poisons the set.
2. **Anonymize.** Shuffle the revisions onto labels A/B/C in an order that is neither chronological
   nor alphabetical. Keep the original scenario filenames so like is compared with like, and strip
   everything else that identifies a revision — manifests, xattrs, PNG text chunks, mtimes. Confirm
   the labels are pairwise distinct by hash, so a duplicate render cannot be ranked against itself.
3. **One judge ranks all three**, using `tools/crop.mjs a.png b.png c.png --rect … --scale 8`, which
   stacks all three sets on the *same* rect. One judge across all three sets removes the variance
   entirely — the comparison is internal to a single context.
4. The judge must be told **it is allowed to say they are the same**, and must not speculate about
   which set is newest. That is not knowable from the pixels, and guessing it corrupts the answer.

**Prefer measured pixel statistics to impressions** wherever the question admits them — luminance
minima in a cavity, count of pixels above a brightness, apparent width at stations along an axis.
Those are comparable across sets in a way that adjectives are not.

### 9.1 A metric is not the objective

Wave 10's nitrous rounds were asked to make the plume's *rendered* half-width narrow monotonically,
because the critic said it read as a constant-width bar. Both rounds succeeded — they flared *wider*
than the version they replaced (peak half-width 151 px and 133 px against 97 px) — and both scored
far worse, because the extra width was unlit gas and the white-hot throat was gone.

When you hand a builder a number to optimise, hand it the **floor it must not trade away** in the
same breath. A metric introduced to describe a problem becomes the target, and whatever the metric
does not measure is what gets spent to satisfy it.

---

*Written once, from `./references/f&f1–5.jpeg`. Do not re-open the reference images per round; this
document is the target.*
