import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import {
  AtmosphereShader, SpeedShader, GradeShader, bloomPrefilterFragment,
  SpillPrefilterShader, SpillBlurShader, SpillCompositeShader, SpillMaskShader,
} from './post.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** sRGB hex/string → a THREE.Color in the linear working space. */
const col = (v, fallback = 0xffffff) => new THREE.Color(v === undefined || v === null ? fallback : v);

const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Normalise a colour so its luminance is 1 — turns a palette colour into a pure hue/tint push. */
function unitTint(c, strength = 1) {
  const out = c.clone();
  const l = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (l > 1e-4) out.multiplyScalar(1 / l);
  out.lerp(new THREE.Color(1, 1, 1), 1 - clamp(strength, 0, 1));
  return out;
}

/**
 * Emissive light spill (ART_DIRECTION.md §2.2: night cities are lit by emissive geometry *and their
 * spill*, not by an ambient term).
 *
 * A quarter-resolution threshold → two-lobe gaussian → depth-masked composite. Two lobes because a
 * single one cannot be both "the glow hugging the tube" and "the pool of light on the wall": the
 * tight lobe is ~1.5% of frame height, the wide one ~5%.
 *
 * It sits *after* bloom on purpose. Before it, the spill would feed the bloom threshold and the two
 * would run away into exactly the full-frame fog §6.5 penalises.
 */
class SpillPass extends Pass {
  constructor(depthTexture) {
    super();
    this.needsSwap = true;
    this.pre = new ShaderPass(SpillPrefilterShader);
    this.blur = new ShaderPass(SpillBlurShader);
    // '__none' so ShaderPass does not try to bind the read buffer over a uniform we own
    this.mask = new ShaderPass(SpillMaskShader, '__none');
    this.mask.uniforms.tDepth.value = depthTexture;
    this.comp = new ShaderPass(SpillCompositeShader);

    const opts = { depthBuffer: false, stencilBuffer: false, type: THREE.HalfFloatType };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtWide = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtMask = new THREE.WebGLRenderTarget(1, 1, opts);
    this.comp.uniforms.tMask.value = this.rtMask.texture;
    for (const rt of [this.rtA, this.rtB, this.rtWide, this.rtMask]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
    }
    this._w = 1; this._h = 1;
    this.enabled = false;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width / 4));
    const h = Math.max(1, Math.floor(height / 4));
    this._w = w; this._h = h;
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.rtWide.setSize(w, h);
    this.rtMask.setSize(w, h);
    this.pre.uniforms.uTexel.value.set(0.5 / width, 0.5 / height);
    this.comp.uniforms.uResolution.value.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const tx = 1 / this._w, ty = 1 / this._h;
    const d = this.blur.uniforms.uDir.value;

    this.mask.render(renderer, this.rtMask, null);
    this.pre.render(renderer, this.rtA, readBuffer);
    // tight lobe
    d.set(tx * 1.0, 0); this.blur.render(renderer, this.rtB, this.rtA);
    d.set(0, ty * 1.0); this.blur.render(renderer, this.rtA, this.rtB);
    this.comp.uniforms.tSpill.value = this.rtA.texture;
    // wide lobe — keep blurring the tight one, so the two are guaranteed to be concentric
    d.set(tx * 3.4, 0); this.blur.render(renderer, this.rtB, this.rtA);
    d.set(0, ty * 3.4); this.blur.render(renderer, this.rtWide, this.rtB);
    this.comp.uniforms.tSpillWide.value = this.rtWide.texture;

    this.comp.renderToScreen = this.renderToScreen;
    this.comp.render(renderer, writeBuffer, readBuffer);
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose(); this.rtWide.dispose(); this.rtMask.dispose();
    this.pre.dispose?.(); this.blur.dispose?.(); this.comp.dispose?.(); this.mask.dispose?.();
  }
}

/**
 * Renderer + post stack + camera rig. Owned by the LIGHTING piece (ART_DIRECTION.md §6.5).
 *
 * Tunables live in `engine.grade.uniforms`, `engine.atmos.uniforms` and `engine.bloom`. Cities push
 * their own look through `engine.applyLook(look)`, which does **not** just copy numbers across: it
 * derives a physically sane exposure, haze, shaft and bloom setup from the city's own light rig and
 * palette, then lets `look.grade` / `look.bloom` bias the result. That is what keeps four cities
 * recognisably different while the curve underneath them stays one game (§6.5 caps an identical
 * grade in all four at 65).
 */
export class Engine {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,            // SMAA in the composer instead
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tonemapping AND the sRGB encode happen in GradeShader, at the end of the chain, once.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft is deprecated in this three build
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.environmentIntensity = 1.0;
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 6000);
    this.camera.position.set(0, 5, 12);

    this.composer = new EffectComposer(this.renderer);

    // --- depth for the atmosphere pass -------------------------------------------------------
    // RenderPass writes into the composer's *read* buffer, which is renderTarget2 on a fresh
    // composer. We hang a DepthTexture off exactly that target and force the read buffer back to it
    // at the top of every frame, so the atmosphere pass (the first swapping pass) always samples the
    // depth that was just written and always writes into the *other* target — no feedback loop.
    this.depthBuffer = this.composer.readBuffer;
    this.depthTexture = new THREE.DepthTexture(1, 1);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.depthBuffer.depthTexture = this.depthTexture;
    this.composer.writeBuffer.depthTexture = null;

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.atmos = new ShaderPass(AtmosphereShader);
    this.atmos.uniforms.tDepth.value = this.depthTexture;
    this.composer.addPass(this.atmos);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.32, 1.0);
    // soft-knee prefilter: bloom energy scales with how far past the threshold a pixel is
    this.bloom.materialHighPassFilter.fragmentShader = bloomPrefilterFragment;
    this.bloom.materialHighPassFilter.needsUpdate = true;
    this.bloom.highPassUniforms.smoothWidth.value = 0.30;
    // Weight the tight mips over the wide ones. High `radius` in UnrealBloomPass inverts the mip
    // weights toward the widest blur, which is exactly the "whole frame fogs" failure.
    this.bloomFactors = [1.0, 0.72, 0.42, 0.22, 0.10];
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = this.bloomFactors;
    this.composer.addPass(this.bloom);

    this.spill = new SpillPass(this.depthTexture);
    this.composer.addPass(this.spill);

    this.speed = new ShaderPass(SpeedShader);
    this.composer.addPass(this.speed);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.postEnabled = true;
    this.look = null;
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._sunWorld = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    this._bufSize = new THREE.Vector2();
    this._invViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._paintEnv = 1.25;
    this.nightness = 0;
    this._shaftBase = 0;
    this._sunGlowBase = 0;

    // ---- shadow-caster culling (see _cullShadowCasters) --------------------------------------
    this.shadowCull = true;
    this._casters = [];          // every mesh the scene authored as a shadow caster
    // World-space bounding sphere cache, parallel to _casters: [cx, cy, cz, r] per caster, plus a
    // 5-element fingerprint of the matrix it was built from. A city is ~1000 casters that never
    // move, and re-deriving their world spheres every frame costs more than the cull saves.
    this._casterSphere = new Float32Array(0);
    this._casterMat = new Float32Array(0);
    this._casterBase = new Uint8Array(0);
    this._casterStamp = { n: -1, geo: -1, frame: 1e9 };
    this._frustum = new THREE.Frustum();
    this._planeShadowDot = new Float32Array(6);
    this._cullSphere = new THREE.Sphere();
    this._shadowDir = new THREE.Vector3(0, -1, 0);
    this.shadowCullStats = { total: 0, drawn: 0 };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize(w, h) {
    const width = w || this.container.clientWidth || window.innerWidth;
    const height = h || this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);

    // WebGLRenderTarget.setSize does not resize an attached DepthTexture — do it by hand or the
    // atmosphere pass samples a stale, wrongly-sized depth buffer.
    const buf = this.renderer.getDrawingBufferSize(this._bufSize);
    if (this.depthTexture.image.width !== buf.x || this.depthTexture.image.height !== buf.y) {
      this.depthTexture.image.width = buf.x;
      this.depthTexture.image.height = buf.y;
      this.depthTexture.dispose();
    }
    this.composer.writeBuffer.depthTexture = null;

    this.grade.uniforms.uResolution.value.set(width, height);
    this.speed.uniforms.uResolution.value.set(width, height);
    this.atmos.uniforms.uResolution.value.set(width, height);
  }

  // ------------------------------------------------------------------ per-city look

  /**
   * Apply a city look.
   *
   * `look` is the city's declarative block: `{ sun, ambient, fog, sky, accent, wet, grade, bloom }`.
   * Everything below is derived from it so that a city author only has to describe *the place* and
   * still gets a correct, distinct grade:
   *
   *  - **Exposure** normalises the city's key so "1.0" means a white surface in full key light in
   *    all four cities. Without this a single bloom threshold cannot exist.
   *  - **Shadow tint** comes from the hemisphere sky colour, **highlight tint** from the sun colour,
   *    **midtone balance** from the fog/haze colour. Those three are already different per city, so
   *    the grades come out different by construction rather than by hand-tuning.
   *  - `look.grade` still biases the result (saturation, contrast, vignette, exposure trim, and the
   *    *hue* of lift/gain), and `look.bloom` still biases threshold/strength/radius.
   */
  applyLook(look = {}) {
    this.look = look;
    const sun = look.sun || {};
    const amb = look.ambient || {};
    const g = look.grade || {};

    const sunI = sun.intensity ?? 2.0;
    const ambI = amb.intensity ?? 1.0;
    const fillI = amb.fill?.intensity ?? 0.0;
    const key = sunI * 0.8 + ambI * 0.5 + fillI * 0.3;

    // ---- nightness -------------------------------------------------------------------------
    // A *continuous* 0..1, not a boolean. Key intensity alone gets NYC wrong: its sun is 1.9 (a
    // moon plus sodium spill) yet the city is plainly night, and treating it as day gave it a
    // daylight exposure ceiling and a cool highlight tint on its warm sodium windows. Blending the
    // key with the luminance of the city's own fog/haze colour — which is dark in exactly the two
    // night cities — lands LA 0.0, Miami 0.0, NYC ~0.7, Vegas 1.0, and every constant below is
    // interpolated across that instead of stepping.
    const fogLum = lum(col(look.fog?.color, 0x808080));
    const n = clamp(
      0.55 * (1 - smooth(0.04, 0.30, fogLum)) + 0.45 * (1 - smooth(0.9, 2.6, sunI)), 0, 1,
    );
    this.nightness = n;
    const night = n > 0.5;
    this.night = night;
    const mix2 = (day, nite) => lerp(day, nite, n);

    // ---- exposure ------------------------------------------------------------------------
    // Partial normalisation: full normalisation would flatten Vegas' night into daylight, none at
    // all leaves NYC black. The night ceiling is the important half — a night city that gets lifted
    // until its blacks are grey stops being a night city.
    const auto = clamp(
      Math.pow(2.55 / Math.max(key, 0.30), mix2(0.52, 0.42)), 0.55, mix2(1.30, 0.86),
    );
    const exposure = auto * (g.uExposure ?? 1.0);
    this.atmos.uniforms.uExposure.value = exposure;
    this._exposure = exposure;

    // ---- white balance -------------------------------------------------------------------
    // A hue-only push toward the key colour (unit luminance, so it cannot brighten or darken).
    // Kept small: the scene fog and sky already carry the city's colour, and stacking a strong
    // balance on top is what turned every frame into one monochrome wash.
    const sunCol = col(sun.color, 0xffffff);
    const wb = unitTint(sunCol, 0.55);
    this.atmos.uniforms.uBalance.value.set(
      lerp(1, wb.r, 0.16), lerp(1, wb.g, 0.16), lerp(1, wb.b, 0.16),
    );

    // ---- atmosphere ----------------------------------------------------------------------
    const fogCol = col(look.fog?.color, 0x808080);
    const hazeCol = col(look.sky?.haze, look.fog?.color ?? 0x808080);
    const fogFar = look.fog?.far ?? 1200;
    const a = this.atmos.uniforms;
    a.uHazeColor.value.copy(fogCol).lerp(hazeCol, 0.5).multiplyScalar(mix2(1.0, 0.85));
    a.uHazeSunColor.value.copy(col(look.sky?.sunColor, sun.color ?? 0xffffff))
      .lerp(hazeCol, 0.35).multiplyScalar(mix2(1.25, 0.7));
    // Nothing inside ~60 m may be veiled. r2's haze started at 0.55 × the city's fog near, which put
    // orange scatter on geometry a car length ahead in LA and was the loudest half of "there is no
    // black point anywhere". Depth cueing is a *far*-field job; the mid-ground reads by value
    // separation, not by fog.
    a.uHazeStart.value = Math.max(70, (look.fog?.near ?? 90) * 0.95);
    a.uHazeDensity.value = 1.30 / fogFar;
    a.uHazeCurve.value = mix2(1.30, 1.12);
    // The city's own THREE.Fog already owns the far plane. This only has to carry the *mid* ground,
    // so it stays well under half — push it higher and every frame turns to milk (see the r0 Miami).
    // Day gets MORE far-field haze than r2, not less: with the near-camera veil gone and a real
    // black point under it, aerial perspective is the only thing separating the LA hills and the
    // Miami skyline from the near ground, and they have to sit visibly lighter than it.
    a.uHazeMax.value = clamp(look.haze?.max ?? mix2(0.50, 0.28), 0, 0.85);
    a.uHazeHeight.value = look.haze?.height ?? mix2(0.30, 0.60);
    a.uHazeBase.value = look.haze?.base ?? 0;
    a.uHazeFalloff.value = look.haze?.falloff ?? mix2(0.011, 0.028);
    a.uHazeDesat.value = mix2(0.38, 0.22);

    // ---- wet road ---------------------------------------------------------------------------
    // §2.2 makes a reflective night road mandatory, and the reference's *daylight* road keeps a
    // "broad specular sheen" too. `look.wet` is the city's own 0..1 knob, and everything derived
    // here now actually SCALES with it.
    //
    // (coherence pass) It did not before, and that was the single loudest incoherence in the
    // sixteen-frame set. Vegas, NYC and Miami each authored an explicit `wetLook`; LA — the one
    // daylight city, `wet: 0` — was the only city left on these defaults, and the defaults were a
    // 0.20 floor with the WIDEST spread in the game (0.075, six to nine times any authored city's).
    // So the driest city got the longest, softest mirror smears: a golden-hour boulevard under a
    // turquoise sky over a road that reflected like black glass at midnight, and the sky and the
    // ground disagreed about what time of day it was. A dry road is not a mirror with the gain
    // turned down — it is a TIGHT grazing specular, so the spread comes down with the wetness as
    // well as the strength, and the day threshold goes up so only a genuine highlight streaks.
    const wet = clamp(look.wet ?? 0, 0, 1);
    const w = look.wetLook || {};
    a.uWet.value = clamp(w.strength ?? (0.075 + wet * 0.68) * mix2(0.85, 1.05), 0, 2.2);
    // The streak takes the city's accent, pulled most of the way back to white so a magenta sign
    // still reflects magenta — this only biases the tail of the smear.
    a.uWetTint.value.copy(unitTint(col(look.accent, 0xffffff), mix2(0.14, 0.30)))
      .multiplyScalar(mix2(0.85, 1.0));
    a.uWetPlaneY.value = w.planeY ?? 0.0;
    // Tight: a car roof sits ~1.1 above the road and must NOT pick up a ground-plane reflection.
    a.uWetBand.value = w.band ?? 0.42;
    // Threshold in exposure-normalised units: a lit road surface sits near 0.35, a neon sign 2+.
    // Keeping this above the road's own brightness is what makes it a specular, not a mirror.
    // High threshold, narrow knee, big gain. That combination is what makes a *dark* road with
    // bright vertical streaks under each sign, rather than a uniformly lifted grey mirror: a merely
    // lit wall contributes nothing, an actual neon tube contributes hard.
    // Daytime keeps a threshold low enough that the sky itself reflects: the reference's midday
    // road is "dark near-black asphalt, wet-looking with a broad specular sheen", and that sheen is
    // the sky sitting in the asphalt at grazing angles.
    // Threshold up only a little, gain up a lot. The dark *gaps* between the streaks are now the
    // toe's job, not the threshold's — pushing the threshold to 0.9 to get a black road (tried, r3
    // interim) simply deleted the reflections, and the wet vertical streaks are the single most
    // expensive-looking thing in a night frame.
    a.uWetThresh.value = w.threshold ?? lerp(mix2(0.94, 0.80), mix2(0.70, 0.66), wet);
    a.uWetKnee.value = w.knee ?? (0.40 + wet * 0.45);
    // Tight when dry, broad when soaked. This is the term that draws the long vertical smear, so
    // it is the term that has to know whether there is any water on the road.
    a.uWetSpread.value = w.spread ?? (0.010 + wet * 0.038);
    a.uWetGain.value = w.gain ?? lerp(mix2(1.15, 1.70), mix2(1.55, 2.45), wet);
    // Dry patches matter as much as wet ones — a uniformly wet road is a lake, and the asphalt
    // texture underneath has to keep showing through or the road stops reading as a road.
    a.uWetPatch.value = w.patch ?? clamp(0.86 - wet * 0.10, 0.55, 0.90);
    a.uWetPatchScale.value = w.patchScale ?? 0.055;
    // Dry asphalt only catches a reflection at a real grazing angle, so the Schlick exponent goes
    // up as the water goes away and the sheen retreats to the far half of the road where it belongs.
    a.uWetFresnel.value = w.fresnel ?? lerp(4.8, 2.4, smooth(0.15, 0.55, wet));

    // ---- light shafts --------------------------------------------------------------------
    // A city can force them with look.shafts; otherwise they scale with how strong and how *low*
    // the key light is. LA's raking golden-hour sun gets them, Vegas' moonless night does not.
    this._sunDir.set(...(sun.dir || [0, 1, 0])).normalize();
    const lowSun = 1 - clamp(this._sunDir.y, 0, 1);
    const autoShaft = clamp((sunI - 1.1) * 0.55, 0, 1.25) * (0.45 + 0.55 * lowSun) * (1 - n * 0.7);
    this._shaftBase = look.shafts?.strength ?? autoShaft;
    this._sunGlowBase = look.shafts?.glow ?? clamp((sunI - 0.9) * 0.30, 0, 0.85);
    a.uShaftTint.value.copy(col(look.sky?.sunColor, sun.color ?? 0xffe0b0)).lerp(hazeCol, 0.25);
    a.uShaftDensity.value = look.shafts?.density ?? 0.60;
    a.uShaftDecay.value = look.shafts?.decay ?? 0.958;
    a.uShaftThreshold.value = look.shafts?.threshold ?? 0.90;

    // ---- bloom ---------------------------------------------------------------------------
    // Thresholds are in exposure-normalised units now: 1.0 == white in full key light, so only
    // emissives and specular hits get through. The city's own number biases around that anchor.
    const b = look.bloom || {};
    const tBias = 0.5 + 0.5 * ((b.threshold ?? 0.65) / 0.65);
    const sBias = 0.5 + 0.5 * ((b.strength ?? 0.95) / 0.95);
    const rBias = (b.radius ?? 0.62) / 0.62;
    // Day threshold is deliberately well above 1.0. A white road line in full sun lands around 1.2
    // once exposure-normalised, and at the old 1.05 it bloomed — a painted double-yellow glowing
    // like a neon tube was called out by name in the last critique. Emissives sit at 2+ and still
    // pass comfortably.
    // Night threshold lifted from 0.95 to 1.18 in r3. Below that, ordinary lit window rows in Vegas
    // cleared the bar in bulk and their haloes merged into the magenta wash that covered the left
    // third of the frame — the emissive SPILL pass is the right tool for "the wall near the sign is
    // lit", and bloom is left to do only what it should: halo the source itself.
    this.bloom.threshold = clamp(mix2(1.40, 1.18) * tBias, 0.70, 1.95);
    this.bloom.strength = clamp(mix2(0.44, 0.55) * sBias, 0.15, 1.00);
    this.bloom.radius = clamp(0.28 * rBias, 0.16, 0.40);
    // A hint of the city accent in the two widest mips: neon haloes pick up the city's signature
    // colour instead of every city glowing the same white.
    const accent = unitTint(col(look.accent, 0xffffff), mix2(0.18, 0.34));
    for (let i = 0; i < this.bloom.bloomTintColors.length; i++) {
      const t = i < 3 ? 0 : (i - 2) * 0.35;
      this.bloom.bloomTintColors[i].set(
        lerp(1, accent.r, t), lerp(1, accent.g, t), lerp(1, accent.b, t),
      );
    }

    // ---- grade ---------------------------------------------------------------------------
    const u = this.grade.uniforms;
    const skyAmb = col(amb.sky, 0x8fb4e0);
    // Shadows take the hue of the sky fill. In every one of the four cities that colour is the
    // complement of the key, so this is what puts turquoise in LA's shadows under an orange sky and
    // stops the frame from being one monochrome wash.
    u.uLift.value.copy(unitTint(g.uLift ? col(g.uLift) : skyAmb, 0.92));
    u.uLiftAmount.value = mix2(0.60, 0.62);
    u.uShadowGain.value = mix2(0.34, 0.24);
    // Two orders of magnitude smaller than r2, because it now lands *after* the toe. r2's 0.020–0.030
    // survived the sRGB encode as ~19% grey — that additive term literally was the washed black point
    // the last critique measured with its eye.
    u.uFloor.value = mix2(0.0014, 0.0018);

    // ---- toe / black point -----------------------------------------------------------------
    // The single change this round is meant to turn on. Calibrated against measured r2 pixels: the
    // frame's darkest 1% sat at sRGB 27–29/255 in all four cities (a grey, not a black); this lands
    // it near 10/255 while the median moves less than 10%. Night is bent slightly harder — asphalt
    // between neon reflections is exactly the surface that has to reach the floor.
    const toeBias = clamp(g.uBlackPoint ?? 1.0, 0.6, 1.5);
    u.uToe.value = 1.0;
    u.uToeEnd.value = mix2(0.048, 0.044);
    u.uToePow.value = clamp(mix2(1.30, 1.34) * (0.55 + 0.45 * toeBias), 1.0, 1.75);
    u.uBlack.value = clamp(mix2(0.0058, 0.0052) * toeBias, 0.0, 0.012);

    const nightGain = accent.clone().lerp(new THREE.Color(1, 1, 1), 0.5);
    const gainHue = g.uGain ? col(g.uGain) : sunCol.clone().lerp(nightGain, n);
    u.uGain.value.copy(unitTint(gainHue, mix2(0.62, 0.45)));
    u.uGainAmount.value = mix2(0.44, 0.34);

    u.uMid.value.copy(unitTint(fogCol.clone().lerp(hazeCol, 0.4), 0.6));
    u.uMidAmount.value = mix2(0.05, 0.10);

    u.uSaturation.value = clamp((g.uSaturation ?? 1.24) * 0.90, 1.02, 1.30);
    u.uPreSat.value = mix2(1.12, 1.22);
    u.uVibrance.value = mix2(0.22, 0.30);
    u.uContrast.value = clamp(mix2(1.20, 1.24) * ((g.uContrast ?? 1.08) / 1.08), 1.05, 1.34);
    u.uFilmic.value = g.uFilmic ?? 1.0;
    // Neon cities have more clipped emissive area, so they need more of their hue back.
    u.uHiChroma.value = clamp(g.uHiChroma ?? mix2(0.26, 0.44), 0, 0.7);
    // Paired with the toe below. r2 got most of its apparent brightness from a large *additive*
    // shadow floor, which is a wash, not exposure. Taking the floor away and putting the difference
    // into real exposure instead means the mid-tones land where they did, the highlights get a
    // little more of the ACES shoulder, and the bottom end is free to fall.
    u.uPostExposure.value = (g.uPostExposure ?? 1.0) * mix2(1.20, 1.12);

    // §2.1 asks for 15–25%. Cities occasionally ask for more; clamp rather than obey.
    u.uVignette.value = clamp(g.uVignette ?? 0.20, 0.15, 0.25);
    u.uVigRadius.value = g.uVigRadius ?? 0.26;
    u.uVigTint.value.copy(unitTint(skyAmb, 0.8)).multiplyScalar(mix2(0.045, 0.035));

    u.uAberration.value = g.uAberration ?? 0.0022;
    u.uGrain.value = g.uGrain ?? mix2(0.010, 0.015);

    // ---- emissive spill --------------------------------------------------------------------
    // §2.2. The counterweight to everything above: once the ambient floor and the haze are gone,
    // *something* has to light the facade beside a five-storey window wall, and it should be the
    // window wall. Day cities get a token amount (a lit sign still throws a little light); night
    // cities get enough that the wall around a neon panel visibly falls off into the dark.
    const sp = look.spill || {};
    const spillAmt = clamp(sp.strength ?? mix2(0.10, 0.34), 0, 1.2);
    // Threshold well above a lit surface: a crash spark shower is 10× brighter than neon and at a
    // low threshold it grew a wide orange pool that swallowed the car (§6.5: "a car should not be
    // swallowed by its own brake lights").
    this.spill.pre.uniforms.uThreshold.value = sp.threshold ?? mix2(1.90, 1.55);
    this.spill.pre.uniforms.uKnee.value = sp.knee ?? 0.85;
    const sc = this.spill.comp.uniforms;
    sc.uStrength.value = spillAmt;
    sc.uWide.value = sp.wide ?? mix2(0.34, 0.38);
    sc.uSurface.value = sp.surface ?? 0.72;
    sc.uSky.value = sp.sky ?? mix2(0.05, 0.12);
    // Where the spill stops being added. Only genuinely dark neighbours get filled, so the black
    // point survives everywhere there is no emissive nearby.
    sc.uRolloff.value = sp.rolloff ?? mix2(0.85, 0.55);
    sc.uTint.value.copy(unitTint(col(look.accent, 0xffffff), mix2(0.08, 0.20)));
    this.spill.enabled = spillAmt > 0.005;

    // ---- ambient floor ----------------------------------------------------------------------
    // "Night cities are lit by emissive geometry and their spill, **not by a bright ambient term**."
    // The hemisphere fill is pulled down hard at night and the env probe's diffuse contribution with
    // it; the key (the only shadow-casting light) is left exactly as the city authored it.
    this.tuneAmbient(n);
    this.scene.environmentIntensity = clamp(mix2(1.05, 0.80) + wet * 0.30, 0.5, 2.4);
    // How hard car paint / chrome / glass leans on the env probe. Raised in DAY too this round: the
    // last critique found LA and Miami paint reading matte, and a bright day sky sitting in the
    // clearcoat is exactly the "sky reflection above, dark ground reflection below" of §1.6.3.
    this._paintEnv = mix2(2.15, 2.70) + wet * 0.35;
    this.retuneEnvironment();

    // Escape hatch: a city may force any grade uniform this method does not already derive. Keys we
    // *do* derive (saturation, contrast, lift, gain, exposure, vignette) are deliberately not
    // overridable — they are the ones that have to stay inside a band for the image to hold up.
    const FORCEABLE = ['uPreSat', 'uVibrance', 'uFilmic', 'uPostExposure', 'uHiChroma',
      'uVigRadius', 'uAberration', 'uGrain', 'uBoostTint', 'uMidAmount'];
    for (const k of FORCEABLE) {
      if (g[k] === undefined) continue;
      const uni = this.grade.uniforms[k];
      if (!uni) continue;
      if (uni.value && uni.value.isColor) uni.value.set(g[k]);
      else if (typeof g[k] === 'number') uni.value = g[k];
    }
  }

  // ------------------------------------------------------------------ ambient floor

  /**
   * Scale the scene's *fill* lighting by how much of a night city this is.
   *
   * The city files author one light rig that has to work as a description of the place; the lighting
   * piece owns what the final image does with it, the same way `applyLook` derives exposure rather
   than copying it. At night a hemisphere term of 1.05–1.45 is what makes asphalt read mid-lavender
   * instead of near-black and what makes a facade beside a neon wall look uniformly lit, so it comes
   * down and the SpillPass puts the local light back where it belongs.
   *
   * Deliberately untouched: the shadow-casting key (a city's sun/moon *is* its key), and every
   * PointLight — those are the lamps, floods and sign practicals, which are exactly the emissive-led
   * lighting §2.2 asks for. Bases are cached in userData so repeated city swaps do not compound.
   */
  tuneAmbient(n = 0) {
    const hemiScale = lerp(1.0, 0.52, n);
    const fillScale = lerp(1.0, 0.68, n);
    const pointScale = lerp(1.0, 1.35, n);
    this.scene.traverse((o) => {
      if (!o.isLight) return;
      if (o.userData.__baseIntensity === undefined) o.userData.__baseIntensity = o.intensity;
      const base = o.userData.__baseIntensity;
      if (o.isHemisphereLight || o.isAmbientLight) o.intensity = base * hemiScale;
      else if (o.isPointLight || o.isSpotLight) o.intensity = base * pointScale;
      else if (o.isDirectionalLight && !o.castShadow) o.intensity = base * fillScale;
    });
  }

  // ------------------------------------------------------------------ environment

  /**
   * Push the current env probe and the city's env weighting onto a subtree.
   *
   * Called for the player car and every AI car after they are built, because a car is built *after*
   * the city and would otherwise keep whatever probe existed at build time. The intensity bump is
   * stored against a per-material base so calling this repeatedly (car swap, city swap) is
   * idempotent rather than compounding.
   */
  applyEnvironment(obj, envMap = this.scene.environment) {
    if (!obj) return;
    const paintEnv = this._paintEnv ?? 1.25;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !('envMap' in m)) continue;
        if (envMap && m.envMap !== envMap) { m.envMap = envMap; m.needsUpdate = true; }
        if (m.envMapIntensity === undefined) continue;
        // paint, clearcoat, chrome and glass — the surfaces whose whole job is to reflect
        const reflective = (m.clearcoat ?? 0) > 0.3 || (m.metalness ?? 0) >= 0.6
          || (m.roughness ?? 1) <= 0.12;
        if (!reflective) continue;
        if (m.userData.__envBase === undefined) m.userData.__envBase = m.envMapIntensity;
        m.envMapIntensity = m.userData.__envBase * paintEnv;
      }
    });
  }

  /** Re-apply the current city's env weighting to everything already in the scene. */
  retuneEnvironment() {
    this.applyEnvironment(this.scene, null);
  }

  // ------------------------------------------------------------------ environment capture

  /**
   * Render a one-off cube map of the finished city and use it as the environment for every material
   * that was using the city's flat sky probe.
   *
   * §6.5 scores "env reflection and specular behavior on cars and wet road" at 20. A PMREM of the
   * sky alone cannot pass that: at night the sky is near-black, so a wet Vegas road reflects
   * *nothing* and car paint reads as vinyl. Reflecting the actual buildings, neon and road puts the
   * city back into the clearcoat and into the wet asphalt.
   */
  captureEnvironment(city, { hide = [], size = 384, height = 5 } = {}) {
    if (!city) return null;
    const hidden = [];
    for (const o of hide) {
      if (o && o.visible) { o.visible = false; hidden.push(o); }
    }
    const prevEnv = this.scene.environment;
    this.scene.environment = null;

    let env = null;
    try {
      const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
      const cam = new THREE.CubeCamera(0.5, 4000, rt);
      const p = city.spawn?.pos ? city.spawn.pos.clone() : new THREE.Vector3();
      cam.position.set(p.x, p.y + height, p.z);
      cam.update(this.renderer, this.scene);

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      env = pmrem.fromCubemap(rt.texture).texture;
      pmrem.dispose();
      rt.dispose();
    } catch (e) {
      console.warn('env capture failed', e);
    }

    this.scene.environment = prevEnv;
    for (const o of hidden) o.visible = true;
    if (!env) return null;

    // swap the sky-only probe out from under everything that already had it
    const old = city.envMap;
    // A city marks a surface as wet by pushing its envMapIntensity to 1.0+. Now that the probe
    // actually contains the city's neon instead of a black night sky, amplify exactly those
    // surfaces — the reflection is the whole point of the wet look and it was previously
    // reflecting nothing. Anything the city left below 1.0 is untouched.
    const wetGain = 1 + clamp(city.look?.wet ?? 0, 0, 1) * 0.45;
    if (old) {
      this.scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m || m.envMap !== old) continue;
          m.envMap = env;
          if (m.envMapIntensity >= 1.0) m.envMapIntensity *= wetGain;
          m.needsUpdate = true;
        }
      });
      old.dispose();
    }
    city.envMap = env;
    this.scene.environment = env;
    return env;
  }

  // ------------------------------------------------------------------ shadow-caster culling

  /**
   * Only draw a shadow caster if the volume its shadow sweeps can actually reach the screen.
   *
   * THIS IS THE SINGLE BIGGEST CPU ITEM IN THE FRAME, and it was invisible to the ablation
   * profiler because the profiler only ever toggles whole passes. Measured on the real GPU
   * (M1 Pro, 1600x900, supercar, chase-with-nitro, 260 frames), the *shadow* pass was issuing
   * MORE draw calls than the visible scene:
   *
   *            shadow draws/frame   main draws/frame
   *     LA            663                450
   *     Miami         638                450
   *     NYC           537                505
   *     Vegas         523                539
   *
   * and `renderer.render()` was 6.0–8.1 ms of pure main-thread JavaScript per frame while the
   * entire post chain was 0.1–0.2 ms. The frame is CPU-bound on draw-call submission, not on fill:
   * dropping the render target to 560x315 moved the wall time by under 3 ms.
   *
   * Three.js culls a shadow caster only against the *shadow camera*. Every city here parents the
   * sun's target to the player, so that camera is a 380x380 m box centred on the car — and roughly
   * half of it is behind the camera, where a shadow cannot possibly be seen. This adds the missing
   * test: sweep each caster's bounding sphere along the light direction as far as its own shadow
   * can travel before it hits the road, and keep the caster only if that swept capsule touches the
   * view frustum.
   *
   * It removes no shadow that is on screen — the sweep is a conservative superset of where the
   * shadow can land, the frustum is padded outwards, and the sphere is inflated — so the image is
   * unchanged. What it removes is the shadow of the building behind you.
   */
  _rebuildShadowCasters() {
    // Put every flag back to what its owner last authored *before* re-reading it, or a caster that
    // happens to be culled this frame would be recorded as "never casts".
    this._restoreShadowCasters();
    const list = this._casters;
    list.length = 0;
    this.scene.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      o.userData.__shadowBase = !!o.castShadow;
      if (o.castShadow) list.push(o);
    });
    const n = list.length;
    if (this._casterBase.length < n) {
      this._casterSphere = new Float32Array(n * 4 + 256);
      this._casterMat = new Float32Array(n * 5 + 320);
      this._casterBase = new Uint8Array(n + 64);
    }
    this._casterMat.fill(NaN);      // force every world sphere to be rebuilt on the next cull
    for (let i = 0; i < n; i++) this._casterBase[i] = 1;
    this._casterStamp.n = this.scene.children.length;
    this._casterStamp.geo = this.renderer.info.memory.geometries;
    this._casterStamp.frame = 0;
    this.shadowCullStats.total = n;
  }

  /**
   * Hand every caster back its authored flag. Called at the end of every frame so that anything
   * rendering outside `Engine.render` — the env-map cube capture, a harness screenshot path — sees
   * the scene exactly as its author left it, and so that another system is free to own castShadow.
   */
  _restoreShadowCasters() {
    const list = this._casters;
    const base = this._casterBase;
    for (let i = 0; i < list.length; i++) if (base[i]) list[i].castShadow = true;
  }

  /** Set castShadow=false on every caster whose shadow cannot land inside the view frustum. */
  _cullShadowCasters() {
    if (!this.shadowCull || !this.renderer.shadowMap.enabled) return;
    // The scene changes when a city or a car is swapped in. Both bump the geometry count and/or the
    // scene's child count; the frame counter is the belt-and-braces catch for anything else.
    const st = this._casterStamp;
    if (st.frame++ > 15
        || st.n !== this.scene.children.length
        || st.geo !== this.renderer.info.memory.geometries) {
      this._rebuildShadowCasters();
    }
    const list = this._casters;
    if (!list.length) return;

    // A sun sitting on the horizon throws shadows of unbounded length; below this the test degrades
    // to "keep everything", which is correct, just not a saving.
    const sy = this._sunDir.y;
    if (!(sy > 0.06)) { this.shadowCullStats.drawn = list.length; return; }

    this._frustum.setFromProjectionMatrix(this._viewProj, this.camera.coordinateSystem);
    const planes = this._frustum.planes;
    // Pad the frustum outwards. A shadow whose edge is one pixel off screen must still be drawn,
    // because SMAA and the wet-road reflection both read right up to the border.
    const PAD = 4;
    const dot = this._planeShadowDot;
    const dir = this._shadowDir.copy(this._sunDir).multiplyScalar(-1);   // caster -> ground
    for (let i = 0; i < 6; i++) {
      const n = planes[i].normal;
      // How far this plane's inward normal is pushed by one metre of shadow travel. Only a
      // *positive* projection can carry the shadow back inside the frustum, so clamp at zero.
      const d = n.x * dir.x + n.y * dir.y + n.z * dir.z;
      dot[i] = d > 0 ? d : 0;
    }

    const sphere = this._cullSphere;
    const invSy = 1 / Math.max(sy, 0.15);
    const cache = this._casterSphere;
    const fp = this._casterMat;
    const base = this._casterBase;
    const p0 = planes[0], p1 = planes[1], p2 = planes[2],
          p3 = planes[3], p4 = planes[4], p5 = planes[5];
    const n0 = p0.normal, n1 = p1.normal, n2 = p2.normal,
          n3 = p3.normal, n4 = p4.normal, n5 = p5.normal;
    const d0 = dot[0], d1 = dot[1], d2 = dot[2], d3 = dot[3], d4 = dot[4], d5 = dot[5];
    let drawn = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const j = i * 4, m = i * 5;
      const e = o.matrixWorld.elements;
      // Rebuild this caster's world sphere only when the matrix it came from actually changed.
      // e[0]/e[5] catch any rotation or scale, e[12..14] catch any translation; a static building
      // therefore costs five float compares a frame instead of a matrix transform.
      if (fp[m] !== e[0] || fp[m + 1] !== e[5] || fp[m + 2] !== e[12]
          || fp[m + 3] !== e[13] || fp[m + 4] !== e[14]) {
        const src = o.boundingSphere !== undefined ? o.boundingSphere : o.geometry?.boundingSphere;
        if (!src) { drawn++; continue; }           // unknown extent — never cull blind
        sphere.copy(src).applyMatrix4(o.matrixWorld);
        cache[j] = sphere.center.x; cache[j + 1] = sphere.center.y;
        cache[j + 2] = sphere.center.z; cache[j + 3] = sphere.radius;
        fp[m] = e[0]; fp[m + 1] = e[5]; fp[m + 2] = e[12];
        fp[m + 3] = e[13]; fp[m + 4] = e[14];
      }
      const cx = cache[j], cy = cache[j + 1], cz = cache[j + 2], rad = cache[j + 3];
      const r = rad * 1.05 + PAD;
      // How far this caster's shadow travels before it reaches the road. Clamped: a 10 m prop does
      // not need a 400 m sweep, and nothing in these cities casts usefully past 420 m.
      let len = (cy + rad) * invSy;
      if (!(len > 12)) len = 12; else if (len > 420) len = 420;

      if (n0.x * cx + n0.y * cy + n0.z * cz + p0.constant + d0 * len + r < 0
       || n1.x * cx + n1.y * cy + n1.z * cz + p1.constant + d1 * len + r < 0
       || n2.x * cx + n2.y * cy + n2.z * cz + p2.constant + d2 * len + r < 0
       || n3.x * cx + n3.y * cy + n3.z * cz + p3.constant + d3 * len + r < 0
       || n4.x * cx + n4.y * cy + n4.z * cz + p4.constant + d4 * len + r < 0
       || n5.x * cx + n5.y * cy + n5.z * cz + p5.constant + d5 * len + r < 0) {
        if (base[i]) o.castShadow = false;
      } else drawn++;
    }
    this.shadowCullStats.drawn = drawn;
  }

  // ------------------------------------------------------------------ frame

  render(dt) {
    const a = this.atmos.uniforms;
    const gu = this.grade.uniforms;
    a.uTime.value += dt;
    gu.uTime.value += dt;
    this.speed.uniforms.uTime.value += dt;

    const boost = gu.uBoost.value;
    a.uBoost.value = boost;

    // Both branches need an up-to-date camera and its view-projection: the atmosphere pass samples
    // it, and the shadow-caster cull tests against the frustum it defines.
    const cam = this.camera;
    cam.updateMatrixWorld();
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._cullShadowCasters();

    if (this.postEnabled) {
      this._invViewProj.copy(this._viewProj).invert();
      a.uViewProj.value.copy(this._viewProj);
      a.uInvViewProj.value.copy(this._invViewProj);
      a.uCamPos.value.copy(cam.position);
      a.uSunDir.value.copy(this._sunDir);

      // project the key light onto the screen for the shaft pass.
      // Scratch vectors, not fresh ones: this runs 60 times a second for the whole race, and two
      // Vector3s per frame is 7 kB/s of garbage whose collection lands as a frame-time spike
      // rather than as a lower average.
      this._sunWorld.copy(cam.position).addScaledVector(this._sunDir, 2000);
      const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const facing = fwd.dot(this._sunDir);
      const ndc = this._ndc.copy(this._sunWorld).project(cam);
      a.uSunScreen.value.set(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
      // fade out as the sun leaves the frame — a shaft origin off screen looks like a smear
      // Rays still read when the sun itself sits just outside the frame — they converge on the edge
      // — so the fade runs well past the border rather than cutting at it.
      const off = Math.max(
        Math.max(0, Math.abs(ndc.x) - 1.0),
        Math.max(0, Math.abs(ndc.y) - 1.0),
      );
      const vis = facing > 0 ? clamp(facing * 1.8, 0, 1) * (1 - clamp(off / 1.7, 0, 1)) : 0;
      a.uSunVisible.value = vis;
      a.uShaft.value = this._shaftBase * vis;
      a.uSunGlow.value = this._sunGlowBase * vis;

      // keep the depth-carrying target as the read buffer so RenderPass always writes into it
      if (this.composer.readBuffer !== this.depthBuffer) this.composer.swapBuffers();
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this._restoreShadowCasters();
    this.renderer.info.reset();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.depthTexture?.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * Pre-compute every bounding volume a raycast against `root` will need.
 *
 * THIS IS A FRAME-PACING FIX, not a correctness one. `Mesh.raycast()` computes
 * `geometry.boundingSphere` lazily — the *first* ray that reaches a mesh walks all of its vertices
 * — and it only gets the cheap AABB rejection if `geometry.boundingBox` is non-null, which it never
 * is unless somebody asks. A city is ~1900 meshes and 1.4M triangles of merged chunks, so the first
 * crash-camera occlusion ray after an impact was paying for all of that inside one frame:
 * a 110–156 ms hitch in every city, plus a ~40 ms one every sixth frame after it as the sliding car
 * swept the ray across chunks it had not touched yet.
 *
 * Measured on the real GPU (M1 Pro, 1600x900, 400 frames, supercar, chase-with-nitro):
 *
 *   LA     p95 38.9 → 12.2 ms   worst 145.5 → 21.0 ms   frames >20 ms 7.5% → 0.8%
 *   NYC    p95 23.6 → 13.6 ms   worst 116.7 → 20.0 ms   frames >20 ms 5.9% → 0.0%
 *
 * Doing it at load costs ~10–30 ms once, on a screen that is already loading, and it makes every
 * later query — the crash camera's sightline probe, WorldDamage, BodyDamage — cheap and, more
 * importantly, *evenly priced*. A mean frame rate hides this entirely; it is all tail.
 */
export function prewarmSceneQueries(root) {
  if (!root) return 0;
  let n = 0;
  root.traverse((o) => {
    const g = o.geometry;
    if (!g || !g.attributes?.position) return;
    if (g.boundingSphere === null || g.boundingSphere === undefined) { g.computeBoundingSphere(); n++; }
    // Mesh.raycast only takes the (much tighter) AABB rejection path when this exists. A merged
    // street of buildings has a bounding sphere the size of a block and a box that misses the ray
    // by metres, so this is where most of the saving is.
    if (g.boundingBox === null || g.boundingBox === undefined) g.computeBoundingBox();
    // InstancedMesh keeps its own instance-space bounds, also computed lazily on first ray.
    // (Guarded on count: an empty instanced mesh computes a NaN sphere, which culls it for ever.)
    if (o.isInstancedMesh && o.count > 0 && !o.boundingSphere) {
      o.computeBoundingSphere();
      o.computeBoundingBox?.();
    }
  });
  return n;
}

/** Recursively free GPU resources for a subtree — required so city swaps don't leak (§3.5). */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
  obj.parent?.remove(obj);
}
