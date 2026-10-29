import * as THREE from 'three';

/**
 * NITRO CIRCUIT — post-processing shaders. Owned by the LIGHTING/POST piece (ART_DIRECTION.md §6.5).
 *
 * The chain, in order (assembled in core/engine.js):
 *
 *   RenderPass        scene → linear HDR (renderer tonemapping is OFF on purpose)
 *   AtmosphereShader  exposure normalisation + white balance + depth haze + light shafts
 *   UnrealBloomPass   soft-knee threshold in *exposure-normalised* units, tight radius
 *   SpillPass         emissive light spill: neon lights the wall it is bolted to (surfaces only)
 *   SpeedShader       radial motion blur + speed lines (rim only, never the frame centre)
 *   GradeShader       filmic tonemap → toe/black point → creative grade → vignette → CA → sRGB
 *   SMAAPass          edge AA, last, on perceptual data
 *
 * The single most important rule in here: **the scene buffer is linear HDR and the screen is sRGB.**
 * Nothing between RenderPass and GradeShader may assume display-referred values, and GradeShader is
 * the only place that encodes to sRGB. Getting that wrong is what makes a frame "muddy" — mid-tones
 * that should sit at 0.55 land at 0.24.
 */

// ---------------------------------------------------------------------------------------------
// shared GLSL
// ---------------------------------------------------------------------------------------------

const LIB = /* glsl */`
  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  /**
   * Interleaved gradient noise. Unlike hash12 it is *spatially even* — no clumps, no visible
   * columns — which is what a low tap count needs if the reconstruction is not to look dithered.
   */
  float ign(vec2 p){
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  /** Smooth value noise — used world-locked, so wet patches stay nailed to the asphalt. */
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ---------------------------------------------------------------------------------------------
// 1. Atmosphere — exposure, white balance, aerial perspective, light shafts
// ---------------------------------------------------------------------------------------------

/**
 * Runs FIRST, on raw linear HDR.
 *
 * Two jobs that have to happen before bloom:
 *
 *  - **Exposure normalisation.** LA's key light is 3.4 and Vegas' is 0.7. Without normalising, one
 *    threshold cannot possibly mean the same thing in both, which is why the old build fogged Miami
 *    into milk and left NYC nearly black. After this pass, "1.0" means *a white surface in full key
 *    light* in every city, so a bloom threshold near 1.0 catches emissives and specular hits only.
 *  - **Aerial perspective.** Depth-cued haze that tints and desaturates with distance, gets thicker
 *    near the ground, and brightens toward the sun. This is layered on top of the city's own
 *    THREE.Fog: the fog sets the far plane colour, this sets the *depth read* of the mid-ground.
 *
 * Light shafts share the pass because they need the same buffer and want to be bloomed afterwards.
 *
 * It also owns the **wet-road reflection** (§2.2: "Wet road reflection is mandatory at night"). See
 * the WET REFLECTION note in the fragment shader for the geometry — it is an exact mirror for a flat
 * ground plane, done by flipping the world-space view ray, so neon and taillights draw real vertical
 * streaks down the asphalt instead of the road being a dead matte plane.
 */
export const AtmosphereShader = {
  defines: { SHAFT_SAMPLES: 20, WET_TAPS: 9 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },

    uExposure: { value: 1.0 },
    uBalance: { value: new THREE.Vector3(1, 1, 1) },   // white balance, linear multiplier

    uInvViewProj: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },

    // ---- wet road ----
    uWet: { value: 0.0 },          // master strength; 0 skips the whole block
    uWetTint: { value: new THREE.Color(0xffffff) },
    uWetPlaneY: { value: 0.0 },    // road height in world space
    uWetBand: { value: 0.75 },     // how far above the plane still counts as "ground"
    uWetThresh: { value: 0.55 },   // only light this bright reflects — it is a *specular*, not a mirror
    uWetKnee: { value: 1.4 },      // how slowly the threshold ramps in — wide keeps lit walls out
    uWetSpread: { value: 0.055 },  // reflection blur, as a tilt on the mirrored ray
    uWetGain: { value: 1.0 },
    uWetPatch: { value: 0.55 },    // puddle contrast (0 = uniformly wet)
    uWetPatchScale: { value: 0.055 },
    uWetFresnel: { value: 4.0 },
    uWetFloor: { value: 0.14 },    // Fresnel floor: the base reflectance of a WATER FILM (0 = dry)

    uHazeColor: { value: new THREE.Color(0x8fa8c8) },  // ambient scatter colour
    uHazeSunColor: { value: new THREE.Color(0xffd7a8) },// forward-scatter colour near the sun
    uHazeStart: { value: 45.0 },
    uHazeDensity: { value: 0.0016 },
    uHazeCurve: { value: 1.15 },
    uHazeMax: { value: 0.5 },
    uHazeHeight: { value: 0.55 },   // 0 = uniform, 1 = fully ground-hugging
    uHazeBase: { value: 0.0 },
    uHazeFalloff: { value: 0.020 },
    uHazeDesat: { value: 0.35 },

    uSunScreen: { value: new THREE.Vector2(0.5, 1.2) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunVisible: { value: 0.0 },
    uShaft: { value: 0.0 },          // master strength, 0 disables the loop entirely
    uShaftDensity: { value: 0.62 },
    uShaftDecay: { value: 0.955 },
    uShaftThreshold: { value: 0.85 },
    uShaftTint: { value: new THREE.Color(0xffd9a0) },
    uSunGlow: { value: 0.0 },        // sun disc scatter in the sky itself
    uBoost: { value: 0.0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uResolution, uSunScreen;
    uniform float uTime, uExposure, uHazeStart, uHazeDensity, uHazeCurve, uHazeMax,
                  uHazeHeight, uHazeBase, uHazeFalloff, uHazeDesat,
                  uSunVisible, uShaft, uShaftDensity, uShaftDecay, uShaftThreshold, uSunGlow, uBoost,
                  uWet, uWetPlaneY, uWetBand, uWetThresh, uWetKnee, uWetSpread, uWetGain, uWetPatch,
                  uWetPatchScale, uWetFresnel, uWetFloor;
    uniform vec3 uBalance, uHazeColor, uHazeSunColor, uShaftTint, uCamPos, uSunDir, uWetTint;
    uniform mat4 uInvViewProj, uViewProj;
    varying vec2 vUv;

    ${LIB}

    /** World position behind a pixel, reconstructed from the depth buffer. */
    vec3 worldAt(vec2 uv, out float depth){
      depth = texture2D(tDepth, uv).x;
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 wp = uInvViewProj * clip;
      return wp.xyz / ((abs(wp.w) < 1e-6) ? 1e-6 : wp.w);
    }

    /** Screen uv a world-space *direction* from the camera lands on. */
    vec2 projectDir(vec3 dir){
      vec4 clip = uViewProj * vec4(uCamPos + dir * 400.0, 1.0);
      return (clip.xy / max(clip.w, 1e-5)) * 0.5 + 0.5;
    }

    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // ---- exposure + white balance (everything downstream is in these units) ----
      col *= uExposure * (1.0 + uBoost * 0.10);
      col *= uBalance;

      // ---- reconstruct the world position behind this pixel ----
      float d;
      vec3 wpos = worldAt(vUv, d);
      float sky = step(0.9999, d);
      vec4 wp = vec4(wpos, 1.0);
      vec3 ray = wp.xyz - uCamPos;
      float dist = length(ray);
      vec3 rd = dist > 1e-4 ? ray / dist : vec3(0.0, 0.0, 1.0);

      // forward scattering: haze brightens and warms toward the key light
      float sunAlign = max(dot(rd, normalize(uSunDir)), 0.0);
      float scatter = pow(sunAlign, 5.0) * uSunVisible;
      vec3 hazeCol = mix(uHazeColor, uHazeSunColor, clamp(scatter * 1.35, 0.0, 1.0));

      if (sky < 0.5) {
        // -------------------------------------------------------------------------------------
        // WET REFLECTION.  §2.2 makes a reflective night road mandatory and it is the single
        // biggest thing separating "expensive night city" from "flat purple plane under neon".
        //
        // Geometry: for a mirror plane with normal +Y, the reflection seen along view ray rd is
        // whatever the ray (rd.x, -rd.y, rd.z) hits. Both are directions *from the same camera*,
        // so re-projecting the flipped ray gives the exact screen position of the reflected content
        // for an infinite ground plane — no ray march, no mirrored render, correct under any camera
        // pitch/roll. Occlusion is ignored, which is why the source is luminance-thresholded: only
        // genuinely bright things (neon, windows, taillights, headlights) streak, so a missed
        // occlusion never reads as an error.
        // -------------------------------------------------------------------------------------
        // Height slab first: it rejects most of a city frame (walls, towers, sky-adjacent props)
        // before paying for the two extra depth taps the normal reconstruction needs.
        float slab = 1.0 - smoothstep(uWetBand, uWetBand * 2.4, abs(wp.y - uWetPlaneY));
        if (uWet > 0.01 && dist < 420.0 && slab > 0.004) {
          vec2 texel = 1.0 / uResolution;
          float dx, dy;
          vec3 px = worldAt(vUv + vec2(texel.x, 0.0), dx) - wp.xyz;
          vec3 py = worldAt(vUv + vec2(0.0, texel.y), dy) - wp.xyz;
          float lim = dist * 0.06 + 0.5;
          // squared compare: same predicate, two fewer square roots on every ground pixel
          float lim2 = lim * lim;
          float valid = step(dot(px, px), lim2) * step(dot(py, py), lim2);
          vec3 nrm = cross(px, py);
          float nl = length(nrm);
          nrm = nl > 1e-6 ? nrm / nl : vec3(0.0, 1.0, 0.0);
          nrm *= sign(nrm.y + 1e-6);
          // ground = facing up, and sitting within a slab around the road plane. The slab is what
          // keeps the effect off car roofs and awnings, the normal test keeps it off walls.
          float ground = smoothstep(0.84, 0.975, nrm.y) * valid * slab;

          if (ground > 0.004) {
            // World-locked puddles: broad patches, plus an aggregate-scale break-up so the streaks
            // are chopped by the asphalt underneath instead of laying down one uniform mirror. The
            // fine octave fades out with distance or it aliases into shimmer on the far road.
            float p = vnoise(wp.xz * uWetPatchScale) * 0.62
                    + vnoise(wp.xz * uWetPatchScale * 3.3) * 0.38;
            float wetness = mix(1.0 - uWetPatch, 1.0, smoothstep(0.30, 0.66, p));
            // Aggregate break-up. r2's single 2.6/m octave had ~0.4 m cells, which at 3x zoom read
            // as the "blocky dithered columns" the last critique called out. Two finer octaves at
            // half the contrast read as wet asphalt texture instead of as a reconstruction artifact.
            // The aggregate octaves are two thirds of this block's ALU and they are multiplied by
            // exp(-dist*0.03), which is under 1.5% past ~140 m — i.e. they are already invisible
            // there. Skipping them beyond that point changes the wetness term by under half a percent
            // and takes eight hash evaluations off every distant road pixel, which is most of the
            // road area in a chase frame.
            float gfade = exp(-dist * 0.030);
            if (gfade > 0.015) {
              float grain = vnoise(wp.xz * 6.0) * 0.6 + vnoise(wp.xz * 14.0) * 0.4;
              wetness *= mix(1.0, 0.72 + 0.56 * grain, gfade);
            }
            // Schlick, but with a floor: physically a wet road at 50 degrees reflects ~5%, which
            // reads as nothing on screen. Arcade wet asphalt keeps a base term so the road under
            // the car still catches its own brake lights. The floor is the WATER's, though, so it
            // is a uniform: a dry road (LA) sets it to 0, or every bright thing above the horizon
            // comes back as a legible mirror image in the near and mid carriageway.
            float fres = uWetFloor + (1.0 - uWetFloor)
                       * pow(1.0 - clamp(dot(-rd, nrm), 0.0, 1.0), uWetFresnel);

            vec3 rm = vec3(rd.x, -rd.y, rd.z);
            // reflections blur with the distance they travel; near-camera road (steep ray) smears
            // most, which is what draws the long vertical streaks.
            float spread = uWetSpread * (0.30 + 0.85 * clamp(-rd.y * 3.2, 0.0, 1.0));
            // A DENSE vertical ladder with a per-tap lateral dither. The vertical axis stays fully
            // sampled — that is what turns a point of neon into a continuous streak rather than a
            // dotted column — while the lateral jitter, driven by interleaved gradient noise, is
            // what dissolves the stair-stepping the last critique saw at 3x. A golden-angle disc was
            // tried instead and spent too many of its taps sideways: the streaks came apart into
            // beads.
            vec3 tang = normalize(cross(rm, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
            float dith = ign(vUv * uResolution);
            vec3 acc = vec3(0.0);
            float tot = 0.0;
            vec3 expBal = uExposure * uBalance;      // loop-invariant; six mults per tap saved
            for (int i = 0; i < WET_TAPS; i++) {
              float t = (float(i) + dith) / float(WET_TAPS) - 0.5;
              float hx = fract(float(i) * 0.6180339 + dith) - 0.5;
              vec3 rk = normalize(rm + tang * (hx * spread * 0.55)
                                     + vec3(0.0, t * 2.0 * spread, 0.0));
              vec2 suv = projectDir(rk);
              float inside = step(0.0, suv.x) * step(suv.x, 1.0)
                           * step(0.0, suv.y) * step(suv.y, 1.0);
              vec3 s = texture2D(tDiffuse, clamp(suv, 0.0, 1.0)).rgb * expBal * inside;
              float w = 1.0 - abs(t) * 1.15;
              acc += s * smoothstep(uWetThresh, uWetThresh + uWetKnee, luma(s)) * w;
              tot += w;
            }
            acc /= max(tot, 1e-4);
            col += acc * uWetTint * (uWet * uWetGain * fres * ground * wetness);
          }
        }

        // ---- aerial perspective ----
        float t = max(dist - uHazeStart, 0.0) * uHazeDensity;
        float amt = 1.0 - exp(-pow(t, uHazeCurve));
        float h = exp(-max(wp.y - uHazeBase, 0.0) * uHazeFalloff);
        amt *= mix(1.0, h, uHazeHeight);
        amt = clamp(amt, 0.0, 1.0) * uHazeMax;

        // distance desaturation reads as depth even where the haze tint is subtle
        float l = luma(col);
        col = mix(col, vec3(l), amt * uHazeDesat);
        col = mix(col, hazeCol * (0.55 + 0.85 * l), amt);
      } else {
        // sky keeps its own gradient; it only gets the sun's scatter halo so the horizon is never a
        // hard line between two flat colours (§7).
        col += uHazeSunColor * pow(sunAlign, 22.0) * uSunGlow * 1.4;
        col += hazeCol * pow(sunAlign, 3.0) * uSunGlow * 0.18;
      }

      // ---- light shafts (crepuscular rays). Gated well above zero: 20 full-res taps are not worth
      // paying for a contribution nobody can see. ----
      // The radial falloff multiplies the whole accumulation, so a pixel with edge == 0 gets nothing from the
      // loop no matter what it samples. Hoisting it above the loop makes that an early-out instead
      // of twenty wasted full-res taps — and with the sun near or past a frame edge, which is most
      // of the time it is visible at all, that is a large share of the frame.
      float edge = 1.0 - smoothstep(0.35, 1.25, length(vUv - uSunScreen));
      if (uShaft > 0.02 && edge > 0.0015) {
        vec2 delta = (vUv - uSunScreen) * (uShaftDensity / float(SHAFT_SAMPLES));
        vec2 uv = vUv;
        float illum = 1.0;
        vec3 acc = vec3(0.0);
        // dither the start so the 20 taps don't band
        uv -= delta * hash12(vUv * uResolution + uTime);
        for (int i = 0; i < SHAFT_SAMPLES; i++) {
          uv -= delta;
          vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb * uExposure;
          float l = luma(s);
          acc += s * smoothstep(uShaftThreshold, uShaftThreshold + 0.9, l) * illum;
          illum *= uShaftDecay;
        }
        acc /= float(SHAFT_SAMPLES);
        col += acc * uShaftTint * uShaft * uSunVisible * edge;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------------------------
// 2. Emissive spill — neon lights the wall it is bolted to
// ---------------------------------------------------------------------------------------------

/**
 * §2.2: "Night cities are lit by emissive geometry (signs, windows, neon tubes, headlights) **and
 * their spill**, not by a bright ambient term." Round 2 had the emissives but not the spill — a
 * five-storey cyan window wall sat on a facade that stayed dark right up to the panel edge, which is
 * the single loudest "this is a game object, not a light" tell in a night frame.
 *
 * Three passes, all at quarter resolution so the whole thing costs a few hundred microseconds:
 *
 *   Prefilter  4-tap box downsample + soft-knee threshold → only genuinely emissive pixels survive
 *   Blur       separable gaussian, run twice at growing stride → a wide, smooth falloff
 *   Composite  add it back to full res, **modulated by the receiving surface**
 *
 * The composite is what makes it read as light rather than as more bloom:
 *  - depth-masked, so the sky never picks it up (bloom already owns the sky halo);
 *  - multiplied by the receiver's own hue, so brick lit by cyan neon goes cold-brick, not cyan;
 *  - rolled off where the receiver is already bright, so it only ever fills *dark* neighbours —
 *    which is exactly what preserves the black point everywhere there is nothing nearby to glow.
 */
export const SpillPrefilterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uThreshold: { value: 1.25 },
    uKnee: { value: 0.7 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uThreshold, uKnee;
    varying vec2 vUv;
    ${LIB}
    void main(){
      vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb
             + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
      c = max(c * 0.25, 0.0);
      float v = max(c.r, max(c.g, c.b));
      // soft-knee: contribution ramps with how far past the threshold the pixel is, so a merely
      // lit wall adds nothing and an actual neon tube adds a lot
      float w = smoothstep(uThreshold, uThreshold + uKnee, v);
      gl_FragColor = vec4(c * w, 1.0);
    }
  `,
};

/**
 * Quarter-res "is this pixel sky" mask, written into a target the spill pass owns.
 *
 * The composite cannot sample the composer's DepthTexture directly: by the time it runs, the buffer
 * it is *writing into* is the one that carries that depth attachment, and sampling a texture bound to
 * the active framebuffer is a GL feedback loop (an INVALID_OPERATION console error, which the
 * functional harness counts as a failure). Resolving the mask up front, into our own render target,
 * sidesteps it for the cost of one 1/16-area pass.
 */
export const SpillMaskShader = {
  uniforms: { tDepth: { value: null } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDepth;
    varying vec2 vUv;
    void main(){
      gl_FragColor = vec4(step(0.9999, texture2D(tDepth, vUv).x), 0.0, 0.0, 1.0);
    }
  `,
};

export const SpillBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },   // texel-space step, already scaled
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main(){
      // 9-tap gaussian, sigma ~= 2 strides
      vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
      c += (texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb
          + texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
      c += (texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb
          + texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export const SpillCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tSpill: { value: null },
    tSpillWide: { value: null },
    tMask: { value: null },        // r = 1 where the pixel is sky
    uResolution: { value: new THREE.Vector2(1, 1) },
    uStrength: { value: 0.0 },     // 0 disables the pass entirely (engine sets pass.enabled)
    uWide: { value: 0.45 },        // weight of the wider, softer lobe
    uSurface: { value: 0.70 },     // how much the receiver's own hue tints the light it receives
    uSky: { value: 0.10 },         // spill onto the sky — light pollution, kept tiny
    uRolloff: { value: 0.55 },     // receiver brightness at which spill stops being added
    uTint: { value: new THREE.Color(0xffffff) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tSpill, tSpillWide, tMask;
    uniform vec2 uResolution;
    uniform float uStrength, uWide, uSurface, uSky, uRolloff;
    uniform vec3 uTint;
    varying vec2 vUv;
    ${LIB}
    void main(){
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec3 spill = texture2D(tSpill, vUv).rgb + texture2D(tSpillWide, vUv).rgb * uWide;

      float sky = clamp(texture2D(tMask, vUv).r, 0.0, 1.0);
      float recv = mix(1.0, uSky, sky);

      // Do not re-light something that is already lit: the spill fills dark neighbours only, which
      // is what keeps a black point in every part of the frame with no emissive near it.
      float bl = luma(base);
      recv *= 1.0 - smoothstep(uRolloff, uRolloff * 3.4, bl);

      // light * albedo. We have no albedo buffer, but the receiver's own chroma is a good enough
      // stand-in: a warm brick facade takes cyan spill as a cold brick, not as a cyan wash.
      vec3 hue = base / max(bl, 0.03);
      vec3 surf = mix(vec3(1.0), clamp(hue, 0.0, 1.8), uSurface * (1.0 - sky));

      gl_FragColor = vec4(base + spill * uTint * surf * (uStrength * recv), 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------------------------
// 3. Speed — radial motion blur + speed lines
// ---------------------------------------------------------------------------------------------

/**
 * Deliberately a *rim* effect. The old version smeared the whole frame (see the r0 Miami chase shot)
 * because the radial mask started at 10% of the screen radius and the sample stride was 14%. Motion
 * blur you can consciously see is motion blur that is too strong — §6.5 scores these as "all
 * present, none obvious".
 */
export const SpeedShader = {
  defines: { BLUR_TAPS: 8 },
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uAmount: { value: 0.0 },     // 0..1, driven by speed + nitrous
    uLines: { value: 0.0 },      // 0..1 streak overlay
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uTint: { value: new THREE.Color(0x8fd4ff) },
    uScale: { value: 0.055 },    // max sample stride as a fraction of the radius
    uInner: { value: 0.30 },     // radius under which nothing blurs at all
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution, uCenter;
    uniform float uTime, uAmount, uLines, uScale, uInner;
    uniform vec3 uTint;
    varying vec2 vUv;

    ${LIB}

    void main(){
      vec2 dir = vUv - uCenter;
      float d = length(dir);
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      if (uAmount > 0.004) {
        float mask = smoothstep(uInner, 0.78, d);
        float w = uAmount * mask;
        if (w > 0.002) {
          float jitter = hash12(vUv * uResolution + uTime * 60.0) - 0.5;
          vec3 acc = vec3(0.0);
          float tot = 0.0;
          for (int i = 0; i < BLUR_TAPS; i++) {
            float t = (float(i) + jitter * 0.5) / float(BLUR_TAPS - 1);
            float s = 1.0 - t * w * uScale;
            float wt = 1.0 - t * 0.42;
            acc += texture2D(tDiffuse, uCenter + dir * s).rgb * wt;
            tot += wt;
          }
          col = mix(col, acc / tot, clamp(w * 1.25, 0.0, 1.0));
        }
      }

      if (uLines > 0.004) {
        // fine, anisotropic streaks that live in the outer third only
        float a = atan(dir.y, dir.x);
        float bucket = floor(a * 130.0);
        float n = hash12(vec2(bucket, 3.0));
        float flick = hash12(vec2(bucket, floor(uTime * 30.0)));
        float streak = smoothstep(0.72, 1.0, flick) * (0.35 + 0.65 * n);
        float radial = smoothstep(0.34, 0.85, d) * (1.0 - smoothstep(0.92, 1.15, d));
        col += uTint * streak * radial * uLines * 0.55;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ---------------------------------------------------------------------------------------------
// 4. Grade — filmic tonemap, creative grade, vignette, CA, grain, sRGB out
// ---------------------------------------------------------------------------------------------

/**
 * The last creative pass. Order matters:
 *
 *   chromatic aberration (samples the source)  →  pre-saturate  →  ACES fitted tonemap
 *   →  TOE + black point  →  lower-mid recovery  →  shadow tint  →  highlight tint  →  midtone
 *   →  vibrance + saturation  →  S-curve contrast  →  vignette  →  grain  →  linear→sRGB
 *
 * The tonemap is Stephen Hill's ACES fit, which has a real shoulder — highlights desaturate and roll
 * off toward white instead of clipping to a flat plateau. ACES pulls chroma out of bright colour, so
 * a pre-saturation step goes in front of it: that is how you get candy neon *and* a filmic rolloff
 * instead of having to choose.
 *
 * **The toe is the black point.** ACES on its own has a lazy bottom end, and stacking a haze term, a
 * hemisphere fill and a proportional shadow *gain* on top of it (which is what r2 did) leaves a frame
 * with no value below ~13% — LA read as a single orange value and Vegas asphalt read mid-lavender.
 * `uToe*` bends the darkest third of the curve down hard while leaving everything above `uToeEnd`
 * untouched, then `uBlack` subtracts a true black point. What was a shadow *gain* is now a
 * band-limited *lower-mid* recovery that peaks around 0.3 and is zero at both ends, so dark detail
 * still opens up but nothing lifts the floor back off the bottom. The tiny tinted `uFloor` is all
 * that stops the result from being #000 (§2.1).
 */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },

    uPostExposure: { value: 1.0 },
    uPreSat: { value: 1.16 },        // saturation *before* the tonemap — keeps neon from going pastel
    uSaturation: { value: 1.14 },    // display-space saturation
    uVibrance: { value: 0.22 },      // extra push on already-dull pixels only
    uContrast: { value: 1.12 },
    uFilmic: { value: 1.0 },         // 0 = plain rolloff, 1 = full ACES
    uHiChroma: { value: 0.32 },      // how much hue survives the shoulder (0 = plain ACES white)

    // All three tints are unit-luminance, so they rotate hue without changing brightness — that is
    // what lets shadows go turquoise under an orange sky instead of just going grey-blue and flat.
    uLift: { value: new THREE.Color(0x8fc4ff) },   // shadow hue
    uLiftAmount: { value: 0.55 },
    uShadowGain: { value: 0.30 },                  // proportional shadow recovery
    uFloor: { value: 0.0012 },                     // tiny additive floor: black is never #000

    // ---- toe / black point (see the block comment above). Units are DISPLAY-LINEAR, i.e. what the
    // sRGB encode is about to receive: sRGB 20/255 == 0.006 here, sRGB 128/255 == 0.216. ----
    uToe: { value: 1.0 },        // 0 = plain ACES bottom end, 1 = full toe
    uToeEnd: { value: 0.050 },   // luminance above which the toe does nothing at all
    uToePow: { value: 1.28 },    // >1 bends the toe down; 1.6 is very contrasty
    uBlack: { value: 0.0042 },   // true black point, subtracted after the toe
    uGain: { value: new THREE.Color(0xffe8cc) },   // highlight hue
    uGainAmount: { value: 0.40 },
    uMid: { value: new THREE.Color(0xffffff) },    // midtone balance
    uMidAmount: { value: 0.07 },

    uVignette: { value: 0.20 },
    uVigRadius: { value: 0.30 },
    uVigTint: { value: new THREE.Color(0x0a0e1a) },

    uAberration: { value: 0.0022 },
    uGrain: { value: 0.016 },
    uBoost: { value: 0.0 },          // 0..1, driven by nitrous
    uBoostTint: { value: new THREE.Color(0x7fd8ff) },
    // Nitrous heat haze (nitrous piece, §6.3 "supporting FX — heat distortion"). Zero unless the
    // jet is lit, so the pass is a no-op for every other frame in the game.
    uHeat: { value: 0.0 },
    uHeatPos: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uPostExposure, uPreSat, uSaturation, uVibrance, uContrast, uFilmic,
                  uLiftAmount, uShadowGain, uFloor, uGainAmount, uMidAmount, uVignette, uVigRadius,
                  uAberration, uGrain, uBoost, uHeat, uHiChroma,
                  uToe, uToeEnd, uToePow, uBlack;
    uniform vec3 uLift, uGain, uMid, uVigTint, uBoostTint;
    uniform vec2 uHeatPos;
    varying vec2 vUv;

    ${LIB}

    // --- ACES (Stephen Hill fit): real shoulder, highlights desaturate toward white ---
    const mat3 ACES_IN = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777);
    const mat3 ACES_OUT = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602);

    vec3 rrtOdt(vec3 v){
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 acesFitted(vec3 c){
      c = ACES_IN * c;
      c = rrtOdt(c);
      return clamp(ACES_OUT * c, 0.0, 1.0);
    }
    // gentler curve to blend against when a city wants less shoulder
    vec3 softRolloff(vec3 c){ return c / (c + 0.62) * 1.62; }

    vec3 lin2srgb(vec3 c){
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }

    void main(){
      vec2 uv = vUv;

      // ---- nitrous heat haze: the plume boils the air, so whatever is BEHIND it wobbles ----
      // A localised UV ripple centred on the jet, falling off as a gaussian. uHeat is 0 unless a
      // nitrous jet is lit, so this costs nothing the rest of the time.
      // (nitrous piece, r3) round 2's amplitude was 0.0011 UV — under 2 px at 1600 wide, which is
      // to say invisible; a critic looking for refraction found none. The shimmer is now a
      // medium-frequency boil over a slow lens warp, so straight edges (rumble strips, lane lines,
      // crosswalk bars) visibly BEND behind the plume rather than merely buzzing. Frequencies are
      // kept well below the 210/px of the first attempt: that aliased into horizontal scanlines.
      if (uHeat > 0.002) {
        float asp = uResolution.x / max(uResolution.y, 1.0);
        vec2 d = (uv - uHeatPos) * vec2(asp, 1.0);
        float m = exp(-dot(d, d) * 26.0) * min(uHeat, 1.2);
        float w = uTime * 7.0;
        vec2 rip = vec2(
          sin(uv.y * 88.0 + w * 2.6) + 0.55 * sin(uv.y * 41.0 - w * 1.7 + uv.x * 26.0),
          cos(uv.x * 74.0 + w * 3.1) + 0.55 * cos(uv.x * 33.0 + w * 1.3 + uv.y * 21.0));
        vec2 warp = vec2(
          sin(uv.y * 21.0 + w * 0.9) + 0.7 * sin(uv.x * 14.0 - w * 0.6),
          cos(uv.x * 18.0 - w * 1.1) + 0.7 * cos(uv.y * 11.0 + w * 0.7));
        uv += (rip * 0.0013 + warp * 0.0015) * m;
      }

      // NB: the aberration vector is built from the UNDISPLACED uv. Deriving it from the rippled
      // uv modulated the R/B sample offsets with the boil and painted rainbow scanlines across the
      // road under the jet.
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // ---- chromatic aberration: zero in the middle, a few pixels at the corners ----
      float ab = uAberration * (1.0 + uBoost * 4.0) * r2 * 2.6;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab * 1.25).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab * 1.05).b;

      col = max(col, 0.0) * uPostExposure;

      // ---- pre-tonemap saturation, so ACES has chroma left to roll off ----
      float l0 = luma(col);
      col = max(mix(vec3(l0), col, uPreSat * (1.0 + uBoost * 0.18)), 0.0);
      vec3 pre = col;
      float preL = luma(pre);

      // ---- filmic tonemap ----
      col = mix(softRolloff(col), acesFitted(col), uFilmic);
      col = clamp(col, 0.0, 1.0);

      // ---- hue-preserving highlight rolloff ----
      // ACES desaturates hard toward white above ~2.0, which turned every lit shopfront and neon
      // panel into an identical flat white plate. Re-inject the *hue* the pixel had before the
      // tonemap while keeping the tonemapped luminance, so a sodium window rolls off to warm cream
      // and a magenta sign rolls off to hot pink — highlights that still belong to the palette.
      if (uHiChroma > 0.002) {
        vec3 hue = pre / max(preL, 1e-4);
        col = mix(col, clamp(vec3(luma(col)) * hue, 0.0, 1.0),
                  uHiChroma * smoothstep(1.0, 3.4, preL));
      }

      // ---- split tone. The tints are unit-luminance, so these are hue rotations, not brightness
      // changes: shadows go cool/turquoise, highlights go to the key colour, and the frame stops
      // being one monochrome wash of whatever colour the sky happens to be. ----
      float l = luma(col);
      // A wide, soft shadow band on purpose: a road surface sits around 0.35–0.45 and it is exactly
      // that band that has to pick up the cool tint, not just the near-blacks.
      float shadow = pow(1.0 - clamp(l, 0.0, 1.0), 1.4);

      // Shadow recovery, applied as a *gain* rather than an offset: a dark car body or a night road
      // opens up and keeps its detail, while true black is multiplied by something and stays black.
      col *= 1.0 + uShadowGain * shadow;

      col = mix(col, col * uLift, shadow * uLiftAmount);

      float hi = smoothstep(0.50, 1.0, l);
      col = mix(col, col * uGain, hi * uGainAmount);

      // ---- midtone balance: the city's own haze colour, gently ----
      float mid = 1.0 - abs(l * 2.0 - 1.0);
      col = mix(col, col * uMid, mid * uMidAmount);

      // ---- vibrance then saturation ----
      float lv = luma(col);
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float sat = mx - mn;
      col = mix(vec3(lv), col, 1.0 + uVibrance * (1.0 - smoothstep(0.0, 0.55, sat)));
      lv = luma(col);
      col = mix(vec3(lv), col, uSaturation * (1.0 + uBoost * 0.20));

      // ---- S-curve contrast: monotonic, so nothing clips to a flat plateau ----
      vec3 s = clamp(col, 0.0, 1.0);
      s = s * s * (3.0 - 2.0 * s);
      col = mix(col, s, clamp((uContrast - 1.0) * 2.6, 0.0, 0.90));

      // ---- nitrous grade shift ----
      col = mix(col, col * uBoostTint, uBoost * 0.22);

      // ---- TOE + BLACK POINT ---------------------------------------------------------------
      // Runs LAST, immediately before the vignette, and that placement is the whole point: at this
      // spot col is (bar the corners) the value the sRGB encode is about to see, so the toe can be
      // calibrated directly against measured pixels. Round 3's first attempt put it right after the
      // tonemap with uToeEnd=0.4 — but a *median* frame pixel here sits near 0.03 linear, not 0.3,
      // so a 0.4 shoulder swallowed the entire image and LA went to a black silhouette.
      //
      // Hue-preserving: shaped on luminance and re-applied as a ratio, so a deep indigo night shadow
      // gets darker without turning grey. Above uToeEnd the curve is the identity — this steepens
      // the darkest ~15% of the frame and leaves midtones and highlights exactly where the grade
      // put them.
      float lt = luma(col);
      float toeT = clamp(lt / max(uToeEnd, 1e-4), 0.0, 1.0);
      float toed = mix(lt, uToeEnd * pow(toeT, uToePow) + max(lt - uToeEnd, 0.0), uToe);
      toed = max(toed - uBlack, 0.0);
      col *= toed / max(lt, 1e-5);

      // …and only NOW the tinted floor, so what the frame bottoms out on is a deep coloured
      // near-black rather than #000 (§2.1) — and so the toe cannot eat it.
      col += uLift * (uFloor * pow(1.0 - clamp(luma(col) * 6.0, 0.0, 1.0), 2.0));

      // ---- vignette: darkens corners but keeps them tinted, never crushed ----
      float rad = sqrt(r2) * 1.4142;
      float vig = smoothstep(uVigRadius, 1.02, rad);
      float vamt = uVignette * (1.0 + uBoost * 0.7) * vig;
      col = mix(col, uVigTint, clamp(vamt, 0.0, 0.85) * 0.9);
      col += uVigTint * vamt * 0.25;

      // ---- the one and only linear → sRGB encode in the whole chain ----
      vec3 outc = lin2srgb(clamp(col, 0.0, 1.0));

      // Grain goes on *after* the encode. Added before it, the steep sRGB slope near black turns a
      // 1.5% perturbation into visible mush all over every night road.
      float g = hash12(uv * uResolution + fract(uTime) * 511.0) - 0.5;
      outc += g * uGrain * (0.55 + 0.45 * (1.0 - luma(outc)));

      gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Soft-knee bloom prefilter. Replaces UnrealBloomPass' hard luminosity cut.
 *
 * The stock filter passes a pixel's *whole* value through once it crosses the threshold, so a wall
 * at 1.01 contributes as much as neon at 8.0 — that is why the r0 build fogged the frame while the
 * taillights still ate the car. This version passes only the **excess over the threshold**, with a
 * quadratic knee, so bloom energy scales with how far into the highlights a pixel actually is.
 * Uniform names match the stock shader so the rest of UnrealBloomPass is untouched.
 */
export const bloomPrefilterFragment = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec3 defaultColor;
  uniform float defaultOpacity;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  varying vec2 vUv;

  void main(){
    vec4 texel = texture2D(tDiffuse, vUv);
    vec3 col = max(texel.rgb, 0.0);
    float v = max(col.r, max(col.g, col.b));
    float knee = max(smoothWidth, 1e-4);
    float soft = clamp(v - luminosityThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float contrib = max(soft, v - luminosityThreshold) / max(v, 1e-4);
    gl_FragColor = mix(vec4(defaultColor, defaultOpacity), vec4(col * contrib, texel.a), 1.0);
  }
`;
