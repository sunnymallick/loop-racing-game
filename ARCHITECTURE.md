# ARCHITECTURE.md — how to work in this codebase

Read this plus your piece's section of `ART_DIRECTION.md`. You should not need to read the whole
tree.

## Running it

```bash
pnpm dev                         # http://localhost:5180 — real GPU, for feeling the game
node tools/shot.mjs --city la --car muscle --shots chase,drift,nitrous --out shots/mine
node tools/shot.mjs --all --out shots/sweep        # 4 cities x 4 cars
node tools/functest.mjs          # control/crash/menu/leak checks; exit 1 on failure
node tools/functest.mjs --quick  # one city, all cars — fast iteration
```

`tools/shot.mjs` boots its own Vite server on a random free port and its own headless Chromium, so
many agents can run it concurrently. Screenshots are deterministic: fixed seed, fixed timestep,
scripted input.

Scenarios available to `--shots`: `chase`, `drift`, `nitrous`, `nitrous-long`, `crash`, `landmark`,
`still`, `menu`. Add `--u 0.42` to place the car at a specific point on the lap, `--telemetry` to
dump the trace as JSON.

**Look at the PNGs you produce.** A change you cannot see in a screenshot did not happen.

## Hard constraints (violating any is a project-level failure)

- Every mesh, texture, sound and font is generated in code at load time. No `.glb/.png/.mp3/.ttf`,
  no CDN, no data-URI that is really a baked asset. Three.js is the only third-party code.
- Textures: `CanvasTexture`/`DataTexture` from our own generators in `src/core/textures.js`.
- Audio: Web Audio oscillators + noise buffers we fill ourselves.
- Fonts: our own vector glyph tables in `src/core/font.js`. **Never** set `ctx.font` to a system
  family like Arial/Impact — that counts as an imported asset.
- Keep it running at ≥50 fps at 1600×900 on a real GPU, and don't leak on city/car swaps.

## Module map

```
src/core/
  engine.js      renderer + post-processing chain + camera            [LIGHTING piece]
  post.js        GradeShader (tonemap/grade/vignette/CA), SpeedShader [LIGHTING piece]
  textures.js    procedural texture toolkit — asphalt, concrete, brick, facade, sprites, sky
  font.js        vector glyph font + seven-segment face               [HUD piece]
  audio.js       Web Audio synthesis: engines, nitrous, impacts, UI   [AUDIO piece]
  input.js       keyboard/gamepad/scripted input (harness drives this)
  rng.js         seeded RNG + value noise + fbm. ALWAYS use this, never Math.random()
  steps.js       step generators: drive() (yields frames) / runSync() (one task) — see Loading

src/vehicles/
  kit.js         materials, loftBody(), wheels, lights, rounded boxes [VEHICLE-ART piece]
  assemble.js    blueprint → car scene graph                          [VEHICLE-ART piece]
  tuner|muscle|suv|supercar.js   identity + geometry blueprint        [VEHICLE-ART piece]
  handling.js    per-class physics table                              [HANDLING piece]
  physics.js     the driving model                                    [HANDLING piece]
  nitrous.js     NITRO table + Nitrous state machine + NitrousJet FX  [NITROUS piece]
  audio_tuning.js per-class engine voicing                            [AUDIO piece]
  index.js       merges the four sources into one spec — do not edit lightly

src/cities/
  track.js       spline, road ribbon, curbs, branches, road textures  [CITY-KIT piece]
  kit.js         buildings, skyline, lamps, palms, barriers, gates,
                 ramps, boost pads, billboards, buildCity()           [CITY-KIT piece]
  losangeles.js  lasvegas.js  miami.js  newyork.js                    [one CITY piece each]

src/fx/
  particles.js   pooled rotating-sprite particle system + skid ribbons [FX piece]
  effects.js     FX director: smoke, sparks, nitro trail, crash, shake [FX piece]

src/ui/
  hud.js         race HUD                                             [HUD piece]
  menu.js        garage / car select                                  [MENU piece]
  loading.js     the loading plate — own canvas + rAF loop, font.js glyphs only

src/boot.js      entry: puts the plate up, then dynamic-imports main.js

src/race/race.js AI opponents + race director                         [RACE piece]
src/main.js      game shell, camera, collisions, window.__GAME harness API
```

## File ownership — the rule that keeps parallel work safe

**Edit only the files listed for your piece.** If you need a change in someone else's file, say so
in your report instead of making it. The one exception: `src/main.js` wiring changes that your piece
genuinely requires are allowed, but keep them minimal and surgical.

Per-class tuning lives in four *separate* tables so four builders never collide:

| What | Where | Owner |
|---|---|---|
| identity, colours, geometry blueprint | `tuner.js` / `muscle.js` / `suv.js` / `supercar.js` | vehicle-art |
| mass, grip, top speed, drift feel | `handling.js` | handling |
| nitrous thrust/ramp/duration/colour | `nitrous.js` → `NITRO` | nitrous |
| cylinders, redline, engine character | `audio_tuning.js` | audio |

`vehicles/index.js` merges them into one spec at runtime. **Never move these numbers back into the
car files.**

## Key contracts

**A built car** (`assemble.js`) returns a `THREE.Group` whose `userData` is read by physics, camera,
FX and race code:

```js
{ spec, blueprint, wheels:[FL,FR,RL,RR], steerWheels:[FL,FR], body, 
  lights:{head,tail,brake,reverse}, exhausts:[Object3D], dims, paintMaterial }
```

**A built city** (`cities/kit.js buildCity`) returns:

```js
{ group, track, fog, sun, envMap, look, name, spawn:{pos,yaw,u}, boostPads, update(t,camera) }
```

**Track**: `track.at(u)` → `{pos,tan,right}`; `track.point(u,lateral)`; `track.nearest(worldPos)` →
`{u,lateral,dist}` where `|lateral| > 1` is off the road; `track.spaced(spacing,{side,offset})` is a
generator for evenly placing props; `track.curvature(u)` is signed.

**Harness API** (`window.__GAME`): `load({city,car,color})`, `step(n,input)`, `scenario(name,opts)`,
`telemetry()`, `render()`, `setSize(w,h)`, `renderAudio(kind,seconds,carId)`.

## Loading

Boot, a destination change and a race start each run behind the loading plate
(`Game.withLoading`). The heavy builds are written as **step generators** that
`yield { p, label }` at natural boundaries — `buildCitySteps` (cities/kit.js), each city's
`buildSteps`, `Game.citySteps` / `raceSteps` / `bootSteps`, `Engine.captureEnvironmentSteps`, the
garage's `ensureStageSteps` / `thumbSteps`. The sync APIs (`setCity`, `startRace`, `buildCity`,
`captureEnvironment`, …) are those generators run through `runSync`, unchanged.

On a real GPU the cost is mostly shader programs, not geometry, so the plate path (`warm`) also
runs `Engine.compileSteps` (parallel compile via `KHR_parallel_shader_compile`, polled per frame)
and `Engine.drawSteps` (every program's first draw, fence-paced in small batches — the GPU pipeline
build that compile cannot reach). Both must run with the scene in the exact state it will be drawn
in (visible lights, fog, environment, target), or the real frame recompiles.

- The headless harness (`?shot`) never sees the plate or the warm path: it runs every generator
  through `runSync`, so captures are byte-identical to the single-task build.
- `?loadlog` prints each step's duration, the bar value at its end, and its longest freeze. The `p`
  tables (`CITY_SPLIT`, kit.js `P`, the spans in main.js) are calibrated from it — re-measure if you
  add a heavy phase. For cold-cache numbers, salt the shader chunks per run rather than deleting the
  system Metal cache.
- A new heavy step belongs in a generator with a `yield` before it, not in a constructor.

## Conventions

- +Z is forward, +Y is up, and **+X is the driver's LEFT** — not the right. Vehicle origin is the
  centre of the wheelbase on the ground.

  This line used to read "+X right". It is worth knowing why it was wrong, because the mistake
  cost a real bug. In a right-handed Y-up scene the driver's right is `forward × up`, and
  `Z × Y = −X`. So +X renders on the LEFT of the screen, positive yaw is a LEFT turn, and
  `physics.js`'s `get right()` in fact returns the driver's left. Measured three ways that agree:
  the chase camera's `matrixWorld` column 0 (screen right) dotted with `forward × up` is +1, and
  dotted with `body.right` is −1.

  **The convention stays as it is.** 157 uses across 11 files — `body.right`, `track.right`, the
  FL/FR wheel names, the signed track lateral — are all consistent with it, and they are consistent
  with each other, which is why nothing ever visibly disagreed. Renaming it would be a large,
  risky, zero-benefit change. What matters is that exactly one boundary reconciles the engine's
  sign with a human's: the keyboard and gamepad mapping in `core/input.js`, where RIGHT produces
  `steer < 0`. See the STEERING SIGN note there before touching anything steering-related, and
  note that `Input.steer` is in ENGINE sign — scripted input from `tools/` is too.
- Colour maps get `THREE.SRGBColorSpace`; normal/roughness/metalness maps get `NoColorSpace`.
- Seed every generator from `RNG` so screenshots stay reproducible between runs.
- Emissive materials + `UnrealBloomPass` is how anything glows. Bloom threshold is ~0.6–0.75, so an
  emissive needs `emissiveIntensity` above ~1.5 to actually bloom.
- Dispose GPU resources when you replace something — `disposeObject()` in `core/engine.js`.
