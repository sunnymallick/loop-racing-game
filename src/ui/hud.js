import { drawText, drawSevenSeg, measure, measureSevenSeg, gradientFill } from '../core/font.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';

/**
 * HUD — drawn to a 2D overlay canvas. ART_DIRECTION.md §6.7, target 85.
 *
 * ONE SYSTEM, NOT SIX PANELS
 * --------------------------
 * Everything on screen is generated from a single grid (`GR`), so the HUD reads as one piece of
 * designed hardware rather than a collection of separately-styled boxes:
 *
 *   · one shear      — SHEAR (9.1°) is the only slant used anywhere: plates, rails, pips, meter
 *                      segments, row chips, the gauge yoke. Nothing on screen is axis-aligned.
 *   · one margin     — every cluster's *bottom* corner sits exactly M from the frame edge, and the
 *                      top band, bottom band and column width are shared constants.
 *   · one rail       — RAIL (3 px) accent on the leading edge of every plate. No exceptions.
 *   · one chassis    — the whole top-left cluster (position / race clock / lap / standings) is a
 *                      SINGLE plate with internal decks divided by hairline rules, so its left edge
 *                      is one unbroken slanted line instead of four plates with four indents.
 *   · two faces      — the display italic (NITRO) is reserved for numbers and headings; every
 *                      label and every list row is set in the upright geometric face (CIRCUIT),
 *                      so hierarchy is carried by *face*, not just size and colour.
 *   · live state     — needle spring, nitro drain, lap pips, position delta, drift meter,
 *                      countdown, banner queue: a static HUD caps at 65.
 *
 * THE RESULTS SCREEN lives at the bottom of this file (`_drawResults`). It is deliberately NOT on
 * this grid: it is the race's end card, it takes the whole frame, and it is cut from the GARAGE's
 * parts instead — see the long note above it. The race HUD fades out under it (`draw`).
 *
 * Rasterisation (§7 "aliased, jaggy text or UI edges" → cap 68): the whole HUD is drawn into a
 * backbuffer at SS × CSS pixels and box-filtered down on composite, so every edge — type, plate
 * edges, gauge ticks, needle — gets a real gradient rather than Canvas2D's one-pixel blend step.
 *
 * COST — read this before you add a glow
 * --------------------------------------
 * Measured on an M1 Pro at 1600×900: this HUD used to issue ~140 non-zero canvas2D `shadowBlur`
 * assignments per frame into the supersampled backbuffer, and they were the ENTIRE cost of the
 * piece — ~37 ms of a 45 ms frame. Forcing shadowBlur to 0 on the backbuffer context took the game
 * from 22 fps to 120 (the display cap): exactly as fast as deleting the HUD outright. Everything
 * else — the 1360-call scene behind it, the 9.2 Mpx clear, the high-quality downscale, every path,
 * gradient and glyph — came to under 1 ms combined. Note that patching only the *visible* canvas
 * context moves nothing, because the HUD draws into `bctx`; that is why the shadowBlur lead looks
 * false if you measure it that way.
 *
 * The bill is per-operation as well as per-radius — forcing every radius to 0.01 still left 9 ms on
 * the table — so shrinking the glows does not help. Measured again in wave 3, on the real GPU, with
 * a canvas the exact shape of this one (`tools/_blurcurve.mjs`), the law is sharper than that:
 *
 *     ONE BLURRED OP COSTS ~107 us ON THE 4045x2275 BACKBUFFER, ~28 us AT 1600x900, AND ~13 us ON
 *     ANYTHING 400x220 OR SMALLER — AND IT DOES NOT CARE HOW BIG THE SHAPE IS.
 *
 * Drawing a 12 px chip and drawing a 200 px plate cost the same; a blur radius of 3 and a blur
 * radius of 8 cost the same. The bill is for the shadow scratch surface Skia allocates, and that is
 * sized by the CANVAS, not by the shape. Twenty-eight blurred ops a frame (a nitrous run with the
 * drift meter up and a banner on screen) is 4.2 ms of a 14.9 ms Miami frame — measured by zeroing
 * `shadowBlur` on `CanvasRenderingContext2D.prototype` and re-running, `tools/_hudceil.mjs`.
 *
 * That law has one very cheap consequence, and it is the whole optimisation: A GLOW DOES NOT HAVE
 * TO BE MADE STATIC TO BE MADE CHEAP. It only has to land on a SMALL canvas. Art that genuinely
 * changes every frame can be repainted every frame into a bbox-sized offscreen layer and blitted
 * back bit-exact, and the blur is then 6-8x cheaper for pixel-identical output. That is `_live()`.
 * Three mechanisms carry the HUD's glows, and between them the backbuffer sees 0-2 blurred ops a
 * frame:
 *
 *   · `_patch()`  — art that is not changing this frame is rendered ONCE into an offscreen canvas
 *                   at exactly the backbuffer's resolution and blitted back with the identity
 *                   transform at an integer device pixel. That is a bit-exact copy: no resampling,
 *                   no blur, one op. See the note on ordering above `_patch`.
 *   · `_seg()`    — the two seven-segment clocks re-drew ~62 blurred fills per frame between them
 *                   (seven segments per digit, each one glowed) and they change every frame, so no
 *                   static cache can catch them. Instead each *character* is baked once, glow and
 *                   all, and the clock is blitted a character at a time.
 *
 *   · `_live()`   — art that DOES change every frame and carries a glow: repainted every frame into
 *                   its own bbox-sized layer and blitted back at an integer device pixel. Costs one
 *                   clear + one blit, and moves its blurs off the 9.2 Mpx backbuffer onto a surface
 *                   a twentieth of the size. See the note above `_live`.
 *
 * If you add art here, put it in a `_patch` if it is static and a `_live` if it is not. THE ONE
 * RULE: no `shadowBlur` may be assigned on the backbuffer context (`draw`'s `ctx`) — only inside a
 * `_patch`/`_live` paint or a `_seg` sprite. `this.blurOps` counts violations and `draw()` asserts
 * BLUR_BUDGET against it; `window.__GAME.telemetry().hud` reports it, and functest fails on it.
 * That guard exists because this piece has now been regressed twice by art added straight onto the
 * backbuffer, and a HUD that is quietly 4 ms slow looks exactly like a HUD that is not.
 */

const CYAN = '#39d7f2';
const CYAN_DIM = 'rgba(57,215,242,0.45)';
const ORANGE = '#ff9214';
const AMBER = '#ffc23d';
const RED = '#ff2e2e';
const GREEN = '#39ff88';
const PAPER = '#e9f1f8';
const LABEL = 'rgba(178,201,222,0.86)';
const TAU = Math.PI * 2;

// The results screen's own palette. GOLD is the garage's exact gold (ui/menu.js) — the two screens
// bracket a race and have to look like the same piece of software.
const GOLD = '#ffc23a';
const GOLD_HOT = '#ffe9a8';
const PODIUM = ['#ffc23a', '#cbd7e4', '#d98b4a'];

// ---------------------------------------------------------------- the grid
//
// Design space is 1600×900; draw() scales it to whatever the frame is. Every number a plate needs
// comes from here — if it isn't in this table, it isn't a layout decision.
const GR = {
  M: 26,          // outer margin. EVERY cluster's bottom corner sits here.
  SHEAR: 0.16,    // 9.1° — the one slant. tan(θ) of the plate's leading edge.
  RAIL: 3,        // accent rail width, all plates
  PAD: 14,        // text inset from the plate's leading edge
  // (COHERENCE PASS) ROW 21 -> 22, and COLW deliberately LEFT ALONE.
  //
  // The standings deck read as cramped and as unfinished at the same time — eight 13.5 px names on
  // a 21 px pitch, in a plate whose right two thirds carried nothing at all. Both halves of that
  // are one fault: there was no second column. There is now (`_deckIntervals`), which is what all
  // that dead space was for, and one more pixel of leading is all the air the rows needed once
  // they had something to be a table WITH. Widening the plate was tried first (268) and is the
  // wrong answer twice over: it makes the empty half emptier, and it pushes the deck 43 px further
  // down a frame whose left column is already the tallest cluster on screen.
  COLW: 246,      // left chassis width
  TOP: 22,        // top band starts here
  BAND: 68,       // …and is this tall: position deck, countdown plate and city banner all match
  ROW: 22,        // standings row pitch
  RULE: 'rgba(150,190,220,0.20)',
};
const SKEW = GR.SHEAR;
const RAIL = GR.RAIL;

// Seven-segment character sprites held at once (see _seg). One digit per glow step per display is
// well under this, so the live set is never evicted.
const GLYPH_CAP = 128;

// How many blurred ops the BACKBUFFER is allowed per frame before the HUD complains. At ~107 us
// each (see the COST note) this is a hard 0.2 ms ceiling. The draw path should hit exactly 0: every
// glow in this file belongs in a `_patch`, a `_live` or a `_seg` sprite. The budget is not zero
// only so that a single deliberate exception is possible without tripping the alarm.
const BLUR_BUDGET = 2;

// Quantisation steps for the nitro strip's breath. The rail's halo pulses in RADIUS, which a blit
// alpha cannot fake, so each step is a sprite of its own — baked on the frame it is first reached
// and blitted for ever after. At the strip's 12 rad/s the breath passes through a step roughly
// every 1.5 frames, i.e. finer than the animation is sampled, so nothing about it visibly steps.
const PULSE_STEPS = 12;

// Sprites held for `_stamp` — art drawn from a small recurring set of values, currently just the
// speed readout. Bounded separately from the seven-segment glyphs so a long race cannot evict the
// clock's digits. The live set is the few speeds the needle is passing through, which is well
// inside this; the cap is there so a whole race cannot accumulate all 240 of them.
const STAMP_CAP = 28;

const SS = 3;               // HUD backbuffer supersample, in samples per CSS pixel
const SS_MAX_EDGE = 4096;   // …never wider than the common GPU texture limit: a 2D canvas past
const SS_MAX_PX = 9.2e6;    //    4096 px falls off the accelerated path, and past ~9 Mpx it is
                            //    simply a lot of VRAM to clear every frame. At 1600×900 → 2.5×.

// Gauge scale. 320 mph over a 220° sweep, numerals every 40, majors every 20, minors every 10.
//
// (coherence pass) 240 -> 320, and the redline 190 -> 200. The old scale was solved against the
// four cars' DRY top speeds (`handling.js`: 151/157/167/188 mph) and never against what nitrous
// does to them. Measured on the real build (tools/_coh4_vmax.mjs), a held boost reaches
// suv 195 / muscle 210 / tuner 234 / SUPERCAR 293 mph — so on the fastest car in the game the
// needle sat pinned at the `1.02` clamp and the digital readout ran 53 mph past the highest
// numeral on the face for the whole of every boost (shots/coh2-loop/06-nitro.png reads 256 MPH on
// a dial that stops at 240). An instrument the game drives off the end of is not an instrument.
//
// 320 is chosen so the tick hierarchy is unchanged and the numeral row lands on 0,40,…,320 — NINE
// numerals, which is also what §1.1's reference dial carries ("radial tick marks numbered 0-8").
// The redline moves to 200 because that is the number it was always meant to mean: just above the
// fastest car's un-boosted top speed, i.e. a band you only ever enter on nitrous. It now covers
// 297°-380° of the sweep, which is §1.1's "red danger arc across the top-right of the dial".
const MPH_MAX = 320;
const MPH_RED = 200;

/**
 * Angled parallelogram plate — the signature HUD shape. (x, y) is the plate's BOTTOM-left corner
 * projected to the top edge: the leading edge runs from (x + h·shear, y) down to (x, y + h), so
 * stacking plates that share `x` puts their bottom-left corners on one vertical margin.
 */
function platePath(ctx, x, y, w, h, skew = SKEW) {
  const s = h * skew;
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.lineTo(x + w + s, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

/**
 * A layered plate: shadow, body, inner shadow, top hairline, outer edge, accent rail.
 * The rail is always RAIL wide and always on the leading (left) edge, with a dark separation
 * hairline beside it — that repetition is what makes six clusters read as one system.
 *
 * @param o.fill    [top,bottom] body colours
 * @param o.accent  rail colour — a string, or [[stop,colour],…] for a rail that changes down its
 *                  length (the chassis runs orange at the position deck into cyan at the standings)
 */
function panel(ctx, x, y, w, h, o = {}) {
  const {
    fill = ['rgba(17,23,33,0.90)', 'rgba(6,9,14,0.86)'], edge = 'rgba(190,214,235,0.20)',
    accent = null, skew = SKEW, glow = 0, shadow = 0.5, edgeW = 1.2, railW = RAIL,
  } = o;

  if (shadow > 0) {
    ctx.save();
    ctx.shadowBlur = 12; ctx.shadowColor = `rgba(0,0,0,${shadow})`;
    ctx.shadowOffsetY = 4;
    platePath(ctx, x, y, w, h, skew);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fill();
    ctx.restore();
  }

  platePath(ctx, x, y, w, h, skew);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, fill[0]); g.addColorStop(1, fill[1]);
  ctx.fillStyle = g;
  ctx.fill();

  // inner shadow: a blurred dark stroke clipped to the plate
  ctx.save();
  platePath(ctx, x, y, w, h, skew);
  ctx.clip();
  platePath(ctx, x, y, w, h, skew);
  ctx.shadowBlur = 9; ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // top hairline catches the light
  ctx.beginPath();
  ctx.moveTo(x + h * skew, y + 0.6);
  ctx.lineTo(x + w + h * skew, y + 0.6);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1.1;
  ctx.stroke();

  if (edge) {
    platePath(ctx, x, y, w, h, skew);
    ctx.strokeStyle = edge; ctx.lineWidth = edgeW;
    ctx.stroke();
  }

  if (accent) railOn(ctx, x, y, h, accent, glow, skew, railW);
}

/** The 3 px leading-edge rail, with its dark separation hairline. Used by every plate. */
function railOn(ctx, x, y, h, accent, glow = 0, skew = SKEW, w = RAIL) {
  ctx.save();
  if (glow) { ctx.shadowBlur = glow; ctx.shadowColor = Array.isArray(accent) ? accent[0][1] : accent; }
  platePath(ctx, x, y, w, h, skew);
  const ag = ctx.createLinearGradient(0, y, 0, y + h);
  if (Array.isArray(accent)) for (const [t, c] of accent) ag.addColorStop(t, c);
  else { ag.addColorStop(0, accent); ag.addColorStop(1, shade(accent, 0.55)); }
  ctx.fillStyle = ag;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(x + w + h * skew, y);
  ctx.lineTo(x + w, y + h);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Bake a run of art's GLOW ON ITS OWN, with the ink itself pushed clear off the canvas.
 *
 * THE POINT. A glow whose only animation is its opacity looks like it should be cacheable, and it
 * is not — not as one sprite. Canvas2D's shadow takes its strength from the SOURCE's alpha, so a
 * translucent stroke at alpha A casts a halo at alpha A·blur and then lets that halo glow up
 * through its own ink. Bake ink-and-halo together at full strength and fade the sprite and you get
 * group opacity: the halo is hidden behind the ink instead of showing through it, and the element
 * goes dull exactly where it is supposed to be brightest. (This is the trap noted on the lap pips
 * and on the redline rim.)
 *
 * Split into TWO sprites it is exact. Blitting glow@A and then ink@A gives alpha A·blur and A·cov
 * in that order — which is, term for term, what one blurred stroke at alpha A produces. So the
 * pulse becomes two cached blits at ~22 us instead of a repaint with a blurred op at ~300 us.
 *
 * The mechanism: `shadowOffsetX` and `shadowBlur` are both in DEVICE pixels and are NOT affected by
 * the current transform (verified on this build, `tools/_shadowsem.mjs` — Chrome follows the spec
 * here). So pushing the ink `off` device pixels to the left and offsetting the shadow `off` device
 * pixels to the right lands the halo exactly where it belongs with the ink outside the canvas.
 *
 * `paint` must not set shadowOffsetX/Y itself.
 */
function glowOnly(c, res, widthUnits, paint) {
  const off = Math.ceil(widthUnits * res) + 64;
  c.save();
  c.shadowOffsetX = off;
  c.translate(-off / res, 0);
  paint(c);
  c.restore();
}

/** Darken a hex colour toward black by `k`. */
function shade(hex, k) {
  if (hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

/** Row of small accent chevrons — the reference's repeating speed marks. */
function chevrons(ctx, x, y, n, w, h, color, alpha = 0.55) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  for (let i = 0; i < n; i++) {
    const px = x + i * (w + 3);
    ctx.beginPath();
    ctx.moveTo(px, y + h); ctx.lineTo(px + w, y + h / 2); ctx.lineTo(px, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Soft dark scrim so a cluster stays legible over a blown-out sky. */
function scrim(ctx, x, y, r, a = 0.5) {
  const g = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);
  g.addColorStop(0, `rgba(2,4,8,${a})`);
  g.addColorStop(0.6, `rgba(2,4,8,${a * 0.45})`);
  g.addColorStop(1, 'rgba(2,4,8,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}

// ---------------------------------------------------------------- results-screen typography
//
// Extra optical kerning for the geometric face, on this screen only.
//
// The geo C is a 300° circular band on a 0.82 advance: its terminals fall away from the advance
// line by nearly a tenth of an em, so against a letter whose ink starts hard at x = 0 it leaves a
// hole the eye reads as a word space. `core/font.js` (HUD piece) carries the diagonal pairs but not
// the round ones, and ui/menu.js hit exactly this — its round-1 critic read "TRAC TION" off the
// garage screen. A results screen is a screen of lists set in the geo face, so it needs the same
// table. It is applied through `rtext`/`rmeasure` rather than by shadowing the module's `drawText`,
// so not one glyph of the race HUD's tuned layout moves.
const RKERN = {
  CT: -0.115, CC: -0.085, CE: -0.062, CA: -0.068, CI: -0.090, CU: -0.062, CL: -0.080, CH: -0.062,
  CK: -0.068, CR: -0.062, CS: -0.052, CO: -0.044, CY: -0.090, 'C/': -0.090, 'C ': -0.035,
  AC: -0.058, EC: -0.046, SC: -0.040, LC: -0.044, OC: -0.034, RC: -0.055, TC: -0.052, IC: -0.038,
  'R/': -0.055, '/C': -0.075, '/ ': -0.035, ' /': -0.035, 'T ': -0.025, ' T': -0.025,
  PE: -0.018, TI: -0.020, TY: -0.030, LA: -0.024, LO: -0.020,
};

function rkern(text, size, face) {
  if (face !== 'geo') return 0;
  let d = 0;
  for (let i = 1; i < text.length; i++) {
    const k = RKERN[text[i - 1] + text[i]];
    if (k) d += k * size;
  }
  return d;
}

function rmeasure(text, o = {}) {
  const m = measure(text, o);
  return { width: Math.max(0, m.width + rkern(String(text), o.size ?? 32, o.face)), height: m.height };
}

/** drawText(), laying the geo face out glyph by glyph so the kern table can bite. */
function rtext(ctx, text, o = {}) {
  const str = String(text);
  if (o.face !== 'geo' || str.length < 2 || typeof o.color === 'function') return drawText(ctx, str, o);
  const size = o.size ?? 32;
  const tracking = o.tracking ?? 0.08;
  const width = rmeasure(str, o).width;
  let x = o.align === 'right' ? o.x - width : o.align === 'center' ? o.x - width / 2 : o.x;
  const sub = { ...o, align: 'left' };
  for (let i = 0; i < str.length; i++) {
    if (i > 0) { const k = RKERN[str[i - 1] + str[i]]; if (k) x += k * size; }
    if (str[i] !== ' ') drawText(ctx, str[i], { ...sub, x, y: o.y });
    x += measure(str[i], o).width + tracking * size;
  }
  return { width, height: size };
}

// ---------------------------------------------------------------- the shout's exclamation
//
// `NITRO!` was rendering as `NITROI`, and it is a real typographic fault, not a kerning nit.
//
// `!` is the only glyph in the display master whose counter is INSIDE the mark rather than a bowl:
// a tapered stem from the cap line to 0.68, then a separate dot from 0.835 to the baseline —
// 0.155 cap heights of white between them. Every pen the banner applies grows the ink OUTWARD into
// that gap from both sides at once. At the shout's weight (0.225 against the master's 0.165) the
// mitred pen is 0.060 a side; the black legibility outline is another 0.067 a side; the bevel then
// paints two more offset copies. The dot welds to the stem, the mark becomes a full-height bar —
// and `I` in this face is literally `box(0, 0, ST, 1)`, the same bar. Confirmed at 10x on a real
// capture (shots/hud-r1-shout/c-bang2.png): the dot and stem were separated by one dark hairline
// and the mark sat hard against the O.
//
// The cure is the one every heavy italic face uses: A BANG IS PUNCTUATION AND IS CUT LIGHTER THAN
// THE CAPS BESIDE IT. So the trailing run of exclamation marks is set as its own run — a lighter
// pen, a proportionally thinner outline, and an optical space in front of it, because 0.045 of a
// left side bearing is not enough air after a round O at this weight. Everything else about the
// run (glow, bevel, sheen, gradient, italic, size) is identical, so the mark still belongs to the
// word.
//
// (The alternative fix is one number in core/font.js — move the dot down or shorten the stem — and
// that is the better home for it, but the font is not this piece's to edit this round.)
const BANG_W = 0.20;      // pen for the bang: leaves ~0.085 cap heights of white in the counter
const BANG_OUT = 0.40;    // …and this fraction of the run's outline, so the black cannot flood it
const BANG_LEAD = 0.07;   // optical space ahead of it, in cap heights, on top of the run's tracking

/**
 * WHERE A RAISED ORDINAL SUFFIX STARTS, measured from the end of the numeral's advance.
 *
 * `6th` in the position deck and `8TH` on the results headline are both a numeral plus a smaller
 * suffix set on a raised baseline, and both were colliding: the `t` sat on the 6's shoulder, and
 * the `T` touched the 8's bevel. The old code used a flat +4 / +8 px, which loses to three terms
 * nobody had accounted for:
 *
 *   · THE RAISE COSTS HORIZONTAL ROOM. Everything is sheared `italic` per unit of height about its
 *     OWN baseline, so lifting the suffix by R slides its ink R·italic to the LEFT of the numeral
 *     it is running away from. At the deck's 18 px raise that is 4.3 px — more than the whole gap.
 *   · THE PEN GROWS BOTH RUNS OUTWARD. The numeral is cut at 0.215 against a 0.165 master, so its
 *     ink is (0.215−0.165)·N wider on the right than the outline says.
 *   · THE BEVEL PAINTS AN OFFSET COPY, +0.032·N further right again (see drawText).
 *
 * Figures are tabular (advance 0.80, ink 0.72–0.76), so the side bearings are the only credit:
 * 0.04 of a size at each end. This returns the gap that leaves `clear` cap-heights of daylight
 * after all of it — which is a formula rather than a fudge, so it stays true if a size changes.
 */
function ordinalGap(N, S, R, I = 0.24, wNum = 0.215, wSuf = 0.21, clear = 0.06) {
  const BASE = 0.165, SB = 0.04, BEVEL = 0.032;
  return clear * N + R * I + (wSuf - BASE) * S + (wNum - BASE + BEVEL) * N - SB * N - SB * S;
}

/** Split a trailing run of `!` off a banner string. */
function splitBang(text) {
  const s = String(text);
  const m = /!+$/.exec(s);
  return m ? [s.slice(0, m.index), m[0]] : [s, ''];
}

/** Width of a banner string as `shout()` sets it. */
function shoutWidth(text, size, tracking) {
  const [head, bang] = splitBang(text);
  const hw = head ? measure(head, { size, tracking }).width : 0;
  if (!bang) return hw;
  const bw = measure(bang, { size, tracking }).width;
  return head ? hw + (tracking + BANG_LEAD) * size + bw : bw;
}

/** Draw a banner string LEFT-anchored at `o.x`, with the bang set as punctuation. */
function shout(ctx, text, o) {
  const [head, bang] = splitBang(text);
  const size = o.size ?? 48, tracking = o.tracking ?? 0.10;
  let x = o.x;
  if (head) {
    drawText(ctx, head, { ...o, x, align: 'left' });
    x += measure(head, { size, tracking }).width + (tracking + BANG_LEAD) * size;
  }
  if (bang) {
    drawText(ctx, bang, {
      ...o, x, align: 'left', weight: BANG_W,
      outline: o.outline ? { ...o.outline, width: (o.outline.width ?? size * 0.10) * BANG_OUT } : null,
    });
  }
}

/**
 * The garage's plate: the same leaning parallelogram, chamfered on the top-left and bottom-right.
 * Identical geometry to ui/menu.js `plate()` so the results panels are cut from the same shape as
 * the destination list and the stat block the player saw ninety seconds earlier.
 */
function cutPath(ctx, x, y, w, h, skew = SKEW, cut = 0) {
  const s = h * skew;
  ctx.beginPath();
  if (cut > 0) {
    ctx.moveTo(x + s + cut, y);
    ctx.lineTo(x + w + s, y);
    ctx.lineTo(x + w, y + h - cut);
    ctx.lineTo(x + w - cut, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + s, y + cut);
  } else {
    ctx.moveTo(x + s, y); ctx.lineTo(x + w + s, y);
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
  }
  ctx.closePath();
}

/** A control-hint key, as drawn on the garage's bottom bar. Returns its width. */
function keycap(ctx, x, y, txt, minW = 30) {
  const size = 14, h = 26;
  const w = Math.max(minW, rmeasure(txt, { size, tracking: 0.14, face: 'geo' }).width + 20);
  platePath(ctx, x, y - h, w, h, 0.12);
  ctx.fillStyle = 'rgba(226,238,250,0.14)'; ctx.fill();
  platePath(ctx, x, y - h, w, h, 0.12);
  ctx.strokeStyle = 'rgba(200,222,240,0.55)'; ctx.lineWidth = 1.3; ctx.stroke();
  rtext(ctx, txt, {
    x: x + w / 2 + h * 0.06, y: y - 8, size, weight: 0.16, tracking: 0.14, align: 'center',
    color: '#dfeaf6', face: 'geo',
  });
  return w;
}

/**
 * THE RESULTS LAYOUT — one table, read by the panel and by the finish camera.
 *
 * The round-1 results screen was a full-width two-column panel with NO CAR ON IT: the critic's
 * words were "`_drawResults` is a pure 2D overlay over a darkened cool-down lap, and the player's
 * teal car is a barely-visible sliver hidden behind the LAP TIMES panel". The fix is a third
 * column that holds nothing — a STAGE — and a camera that puts the hero car in it.
 *
 * Because the composition has to be true on both sides of the glass, this function is the single
 * source of it: `_drawResults` lays the panels out from it, and main.js's finish camera reads the
 * same numbers back through `HUD.resultsStageNDC()` and solves for the camera that lands the car
 * exactly there. Move a number here and the car follows it.
 */
export function resultsLayout(VW, VH) {
  const M = 64, BAR = 92, CUT = 26, RS = 0.077;
  const barY = VH - BAR;
  const yT = 250;
  const panelH = barY - 34 - yT;
  const innerW = VW - M * 2;
  // the stage: the right ~30% of the panel band, left empty for the car
  const stageW = Math.round(innerW * 0.300);
  const stageX = VW - M - stageW;
  const usable = innerW - stageW - 30;
  const leftW = Math.round(usable * 0.585);       // classification
  const midX = M + leftW + 26;
  const midW = usable - leftW - 26;               // YOUR RACE + LAP TIMES, stacked
  const cardAH = Math.round(panelH * 0.44);
  return {
    M, BAR, CUT, RS, barY, yT, panelH, innerW,
    leftW, midX, midW, cardAH, cardBY: yT + cardAH + 20, cardBH: panelH - cardAH - 20,
    stageX, stageW,
    // Where the car is composed inside the stage: centre, and how wide it should measure. It sits
    // in the UPPER half — the lower third of this bracket carries the machine block (`_resSpec`),
    // which is what the critic's "empty road filling the rest" was asking for.
    carX: stageX + stageW * 0.465,
    carY: yT + panelH * 0.500,
    carW: stageW * 0.90,
  };
}

/** What goes in a classification row's TIME column. */
function resultTime(row) {
  if (row.dnf) return 'DNF';
  if (row.finished && row.time != null) {
    // the LEADER's row carries the clock; everyone else carries an interval to it. Keyed on the
    // flag main.js sets rather than on `gap <= 0.005`, so a dead heat reads +00.00 instead of
    // putting a second absolute time in a column of intervals.
    return (row.leader || row.gap == null) ? fmtTime(row.time) : `+${fmtSplit(row.gap)}`;
  }
  if (row.gapM > 0.5) return `+${Math.round(row.gapM)}m`;
  return '--';
}

/** M:SS.CS, dropping the minutes when there are none — a split, not a clock. */
export function fmtSplit(t) {
  const v = Math.max(0, t);
  const m = Math.floor(v / 60);
  const s = Math.floor(v % 60);
  const cs = Math.floor((v % 1) * 100);
  const tail = `${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  // …and the minutes are padded, so a split over a minute reads "01:25.00" beside a "02:08:15"
  // rather than "1:25.00". Two clock rhythms one line apart is the same fault as two clock formats.
  return m > 0 ? `${String(m).padStart(2, '0')}:${tail}` : tail;
}

/** Label type: the upright geometric face, one call so every label in the HUD matches. */
function label(ctx, text, x, y, size, color = LABEL, o = {}) {
  return drawText(ctx, text, {
    x, y, size, face: 'geo', weight: o.weight ?? 0.155, tracking: o.tracking ?? 0.22,
    align: o.align || 'left', color, glow: o.glow || null, alpha: o.alpha ?? 1,
    shadow: o.shadow ?? { color: 'rgba(0,0,0,0.55)', dy: size * 0.08, blur: 3 },
  });
}

export class HUD {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0;
    this.needle = 0;
    this.needleV = 0;
    this.posFlash = 0;
    this.posDelta = 0;
    this.lastPos = 1;
    this.lapFlash = 0;
    this.lastLap = 1;
    this.boostPulse = 0;
    this.charge = 1;
    this.lastTanks = 3;
    this.tankFlash = 0;
    this.driftShow = 0;
    this.driftScore = 0;
    this.beat = 0;
    this.lapStart = 0;
    this.lastCount = 99;
    this.countPulse = 0;
    this.msg = null;       // ONE centre-screen slot…
    this.msgQueue = [];    // …everything else waits its turn
    this.resultsT = 0;     // the classification panel's entrance clock
    this.t = 0;
    this._patches = new Map();   // id → cached static art, see _patch()
    this._glyphs = new Map();    // seven-segment character sprites, see _seg()
    this._stamps = new Map();    // value-keyed sprites, see _stamp()
    this._res = 1;               // device pixels per design unit, set every draw()
    this._frame = 0;             // repaint token for _live() layers
    this.blurOps = 0;            // blurred ops issued on the BACKBUFFER this frame — see BLUR_BUDGET
    this.blurPeak = 0;           // …and the worst frame since the last resize, for telemetry
    this.blurBudget = BLUR_BUDGET;   // published, so the harness does not carry its own copy
    this._blurWarned = false;
    this.resize();
  }

  // ------------------------------------------------------------- the static-art cache
  //
  // ORDERING. Source-over compositing is associative, so baking a run of draws into a transparent
  // layer and compositing that layer is pixel-identical to issuing the same draws straight onto the
  // destination — PROVIDED the run order survives. It does not survive if you bake "everything
  // static" and then draw "everything live" on top: a static wash that originally covered a live
  // glow would end up underneath it. (Concretely: the race clock's glow bleeds ~5 px up out of its
  // deck, and the deck above it is a static tint. Bake all the tints first and that bleed stops
  // being painted over.) So the static art is split into several patches that are called from the
  // same points in the draw order the original code drew them, never hoisted.
  //
  // Anything that changes must be in `key`, or the HUD silently freezes — which is a far worse bug
  // than a slow HUD. Flash and pulse states are deliberately NOT in any key: an element that is
  // mid-flash is drawn live instead, because a key that changes every frame is a cache that costs
  // more than it saves.

  /**
   * Draw a run of STATIC art through an offscreen cache.
   *
   * @param id       stable identity of this run — one cached canvas per id
   * @param x,y,w,h  bounds in the space `paint` draws in, generous enough to hold its shadows/glows
   * @param key      everything the art depends on; when it changes the patch is repainted
   * @param paint    (ctx) => void, drawing at exactly the coordinates the live path would use
   * @param o.ox,oy  design-space origin of that space, when the caller has translated the context
   *                 (the speedo draws about the dial's centre). Baked in, so it must not animate.
   * @param o.tx,ty  blit-only offset for a slide, snapped to a whole device pixel so that an
   *                 animating position can never invalidate the patch
   * @param o.alpha  blit alpha (group opacity — only for whole-cluster fades and the pip breath)
   */
  _patch(ctx, id, x, y, w, h, key, paint, o = {}) {
    const res = this._res;
    const ox = o.ox || 0, oy = o.oy || 0;
    const dx = Math.floor((x + ox) * res), dy = Math.floor((y + oy) * res);
    const cw = Math.max(1, Math.ceil((x + ox + w) * res) - dx);
    const ch = Math.max(1, Math.ceil((y + oy + h) * res) - dy);
    let p = this._patches.get(id);
    if (!p) { p = { canvas: document.createElement('canvas'), ctx: null }; this._patches.set(id, p); }
    const full = `${key}|${res}|${cw}x${ch}|${dx},${dy}`;
    if (p.key !== full) {
      if (p.canvas.width !== cw || p.canvas.height !== ch) {
        p.canvas.width = cw; p.canvas.height = ch;          // reallocating also clears
        p.ctx = p.canvas.getContext('2d');
      } else {
        p.ctx.setTransform(1, 0, 0, 1, 0, 0);
        p.ctx.clearRect(0, 0, cw, ch);
      }
      // identical mapping to the live path: local → device, minus the patch's device origin
      p.ctx.setTransform(res, 0, 0, res, ox * res - dx, oy * res - dy);
      // Ambient opacity is applied INSIDE the layer, not to the blit, whenever the caller passes it
      // (`_live` always does). Source-over is associative, so a run of draws made at alpha A inside
      // a transparent layer and then blitted at 1 is pixel-identical to the same run made at alpha A
      // straight onto the destination — whereas blitting the layer at A is GROUP opacity, which is
      // a different picture wherever those draws overlap each other. That distinction is the whole
      // reason the drift panel and the chassis used to refuse to be cached while they were fading.
      p.ctx.globalAlpha = o.inherit ?? 1;
      paint(p.ctx);
      p.key = full; p.dx = dx; p.dy = dy;
    }
    // Blit under the identity transform at the exact device pixel it was baked for, so this is a
    // straight copy rather than a resample — the type stays as crisp as a direct draw.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (o.alpha != null) ctx.globalAlpha *= o.alpha;
    ctx.drawImage(p.canvas,
      p.dx + (o.tx ? Math.round(o.tx * res) : 0),
      p.dy + (o.ty ? Math.round(o.ty * res) : 0));
    ctx.restore();
  }

  /**
   * Draw a run of art that CHANGES EVERY FRAME through its own small offscreen layer.
   *
   * `_patch` exists to skip work. `_live` does not skip any work at all — it repaints on every
   * single frame — and is still a large win, because of the cost law in the COST note at the top of
   * this file: a blurred canvas2D op is billed for the size of the CANVAS it lands on, not the size
   * of the shape. On the 4045x2275 backbuffer that is ~107 us; on a 700x640 layer around one plate
   * it is ~15 us. So the way to make a glow cheap is not to make it static, it is to make it land
   * somewhere small — and unlike caching, that works on art that genuinely moves every frame.
   *
   * The cost added back is one `clearRect` and one `drawImage` on a small canvas, both of which the
   * compositor does on the GPU. The blit is at the identity transform on a whole device pixel, so
   * it is a straight copy: the type and the plate edges stay exactly as crisp as a direct draw.
   *
   * Ambient `globalAlpha` is carried INTO the layer rather than applied to the blit, so this is
   * pixel-identical to drawing the run directly — see the note in `_patch`.
   *
   * @param o.ox,oy  design-space origin, when the caller has translated the context
   */
  _live(ctx, id, x, y, w, h, paint, o = {}) {
    this._patch(ctx, id, x, y, w, h, `~${this._frame}`, paint,
      { ...o, inherit: ctx.globalAlpha });
  }

  /**
   * Cache a run of art that only ever ROTATES, and blit it through the rotation.
   *
   * `_patch` blits at the identity transform, which is what keeps type and plate edges bit-exact —
   * but it means a patch cannot turn. Anything whose animation IS a rotation (the speedo needle)
   * would otherwise have to be repainted every frame, and a repaint that carries a glow costs
   * ~300 us however small the layer is. This bakes the art once in its own unrotated frame and
   * pays a resample on the blit instead. Use it only where a third of a CSS pixel of softening does
   * not matter — never for type.
   *
   * @param x,y,w,h  bounds in the art's own (unrotated) local space
   * @param key      everything the baked art depends on — NOT the angle
   * @param ang      blit rotation, radians
   * @param ox,oy    design-space centre of rotation
   */
  _sprite(ctx, id, x, y, w, h, key, ang, ox, oy, paint) {
    const res = this._res;
    const cw = Math.max(1, Math.ceil(w * res)), ch = Math.max(1, Math.ceil(h * res));
    let p = this._patches.get(id);
    if (!p) { p = { canvas: document.createElement('canvas'), ctx: null }; this._patches.set(id, p); }
    const full = `${key}|${res}|${cw}x${ch}`;
    if (p.key !== full) {
      if (p.canvas.width !== cw || p.canvas.height !== ch) {
        p.canvas.width = cw; p.canvas.height = ch;
        p.ctx = p.canvas.getContext('2d');
      } else {
        p.ctx.setTransform(1, 0, 0, 1, 0, 0);
        p.ctx.clearRect(0, 0, cw, ch);
      }
      p.ctx.setTransform(res, 0, 0, res, -x * res, -y * res);
      p.ctx.globalAlpha = 1;
      paint(p.ctx);
      p.key = full;
    }
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(ang);
    // drawn in design units at exactly the resolution it was baked for, so the only resampling is
    // the rotation itself
    ctx.drawImage(p.canvas, x, y, cw / res, ch / res);
    ctx.restore();
  }

  /**
   * Cache a run of art keyed on the VALUE it draws, through a bounded LRU.
   *
   * `_patch` keeps one canvas per id for ever, which is right for art whose identity is its place
   * on the grid and wrong for art whose identity is a number. The speed readout is the case: it
   * changes on almost every frame, but only ever draws one of ~240 strings at one of a handful of
   * glow strengths, and the set that is live at any moment is the few values the needle is passing
   * through. Keying on the value instead of the slot turns "repaint every frame" into "repaint the
   * first time this car ever reads 137 mph".
   *
   * Its screen position is fixed, so — unlike `_seg`, which lays characters out along a line — the
   * sub-pixel phase is a constant and one sprite per value is enough. The blit is at a whole device
   * pixel, so the type is bit-exact with a direct draw.
   *
   * @param x,y,w,h  bounds in the space `paint` draws in
   * @param o.ox,oy  design-space origin of that space, when the caller has translated the context
   */
  _stamp(ctx, key, x, y, w, h, paint, o = {}) {
    const res = this._res;
    const ox = o.ox || 0, oy = o.oy || 0;
    const dx = Math.floor((x + ox) * res), dy = Math.floor((y + oy) * res);
    const cw = Math.max(1, Math.ceil((x + ox + w) * res) - dx);
    const ch = Math.max(1, Math.ceil((y + oy + h) * res) - dy);
    const k = `${key}|${res}|${cw}x${ch}|${dx},${dy}`;
    let sp = this._stamps.get(k);
    if (sp) { this._stamps.delete(k); this._stamps.set(k, sp); }   // touch: Maps iterate insertion order
    else {
      sp = document.createElement('canvas');
      sp.width = cw; sp.height = ch;
      const sc = sp.getContext('2d');
      sc.setTransform(res, 0, 0, res, ox * res - dx, oy * res - dy);
      paint(sc);
      this._stamps.set(k, sp);
      while (this._stamps.size > STAMP_CAP) {
        this._stamps.delete(this._stamps.keys().next().value);
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sp, dx, dy);
    ctx.restore();
  }

  /**
   * Count blurred ops on one context, so the HUD can police its own budget.
   *
   * This is an own accessor on the backbuffer context object — the only surface where a blurred op
   * is expensive — so a `shadowBlur` set inside a `_patch`, a `_live` layer or a `_seg` sprite is
   * correctly NOT counted: those canvases are small and their blurs are near-free. One extra
   * property call per assignment, and there should be no assignments at all.
   */
  _meterBlur(c) {
    if (!c || Object.getOwnPropertyDescriptor(c, 'shadowBlur')) return c;
    const proto = Object.getPrototypeOf(c);
    const d = Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
    if (!d || !d.set) return c;
    const hud = this;
    Object.defineProperty(c, 'shadowBlur', {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { if (v) hud.blurOps++; d.set.call(this, v); },
    });
    return c;
  }

  /** Drop every cached canvas — the resolution changed, so nothing baked is reusable. */
  _flushCache() {
    this._patches.clear();
    this._glyphs.clear();
    this._stamps.clear();
  }

  /**
   * Seven-segment text, one cached sprite per character.
   *
   * `drawSevenSeg` glows each lit segment individually, so a `MM:SS:CS` clock costs ~30 blurred
   * fills — and it re-costs them every frame, because the centiseconds change every frame. The
   * character set is tiny and each character is identical wherever it appears, so each one is baked
   * once (glow included) and blitted.
   *
   * The sprite is baked at the sub-pixel phase of the slot it lands in and blitted at an integer
   * device pixel, so digits keep the exact even spacing a seven-segment display lives or dies by.
   */
  _seg(ctx, text, o) {
    const { x = 0, y = 0, size = 40, color = '#ff2e2e', dim = 0.12, tracking = 0.20,
      italic = 0.06, glow = 10, align = 'left', dimColor = null } = o;
    const str = String(text);
    const res = this._res;
    // metrics straight from the font module, so this can never drift out of step with drawSevenSeg
    const adv = measureSevenSeg('0', { size, tracking: 0 }) + size * tracking;
    const punct = measureSevenSeg(':', { size, tracking: 0 });
    let total = 0;
    for (const ch of str) total += (ch === ':' || ch === '.') ? punct : adv;
    total -= size * tracking;
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;

    // Generous local bounds: the glyph box plus the italic lean plus the glow's falloff.
    const pad = glow * 1.6 + 3;
    const bx = -pad, by = -size * 1.08 - pad;
    const bw = (0.72 + italic) * size + pad * 2, bh = size * 1.2 + pad * 2;
    const PH = 8;                    // sub-pixel phases per axis; 1/16 px of placement error

    for (const ch of str) {
      const fx = (cx + bx) * res, fy = (y + by) * res;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const phx = Math.round((fx - ix) * PH) / PH, phy = Math.round((fy - iy) * PH) / PH;
      const key = `${ch}|${size}|${color}|${dimColor}|${dim}|${italic}|${glow}|${res}|${phx}|${phy}`;
      let sp = this._glyphs.get(key);
      if (sp) {
        // touch: a Map iterates in insertion order, so re-inserting makes this the newest entry
        this._glyphs.delete(key); this._glyphs.set(key, sp);
      } else {
        const c = document.createElement('canvas');
        c.width = Math.ceil(bw * res) + 2; c.height = Math.ceil(bh * res) + 2;
        const sc = c.getContext('2d');
        sc.setTransform(res, 0, 0, res, -bx * res + phx, -by * res + phy);
        drawSevenSeg(sc, ch, { x: 0, y: 0, size, color, dim, tracking, italic, glow, align: 'left', dimColor });
        sp = c;
        // Bounded LRU rather than a wholesale clear. The live working set is one glyph per digit
        // per glow step — under a hundred sprites — so this never evicts anything in use, but it
        // does stop a long race in the pulsing "over the record" state from accumulating a variant
        // of all ten digits at every glow step it has ever passed through.
        this._glyphs.set(key, sp);
        while (this._glyphs.size > GLYPH_CAP) {
          const oldest = this._glyphs.keys().next().value;
          this._glyphs.delete(oldest);
        }
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sp, ix, iy);
      ctx.restore();
      cx += (ch === ':' || ch === '.') ? punct : adv;
    }
  }

  resize(w, h) {
    const W = w || window.innerWidth, H = h || window.innerHeight;
    // Everything in the cache was rasterised for the old backbuffer resolution and for layout at
    // the old size. None of it is reusable, and a stale HUD is worse than a slow one.
    this._flushCache();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = Math.max(this.dpr, Math.min(
      SS,
      SS_MAX_EDGE / Math.max(1, W), SS_MAX_EDGE / Math.max(1, H),
      Math.sqrt(SS_MAX_PX / Math.max(1, W * H)),
    ));
    this.canvas.width = Math.floor(W * this.dpr);
    this.canvas.height = Math.floor(H * this.dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.w = W; this.h = H;

    // Supersampled backbuffer. Allocated once and resized in place; the visible canvas only ever
    // receives one downscaled drawImage per frame, so nothing is ever nearest-upscaled.
    if (this.scale > this.dpr + 1e-3) {
      const bw = Math.floor(W * this.scale), bh = Math.floor(H * this.scale);
      if (!this.buf) this.buf = document.createElement('canvas');
      if (this.buf.width !== bw || this.buf.height !== bh) {
        this.buf.width = bw; this.buf.height = bh;      // reallocates — only on a real size change
      }
      this.bctx = this._meterBlur(this.buf.getContext('2d'));
    } else {
      this.buf = null; this.bctx = null;
      this._meterBlur(this.ctx);
    }
    this.blurPeak = 0;
  }

  /**
   * WHERE THE HERO CAR GOES ON THE RESULTS SCREEN, in the camera's own units.
   *
   * The panel reserves its right third for a car (see `resultsLayout`) and main.js's finish camera
   * has to put one there. Rather than have both files carry the same magic numbers, the layout is
   * solved once here and handed over as normalised device coordinates plus the fraction of the
   * frame width the car should measure — which is exactly what a camera solve needs.
   */
  resultsStageNDC() {
    const W = this.w || 1600, H = this.h || 900;
    const k = Math.min(W / 1600, H / 900);
    const VW = W / k, VH = H / k;
    const L = resultsLayout(VW, VH);
    return { x: (L.carX / VW) * 2 - 1, y: 1 - (L.carY / VH) * 2, w: L.carW / VW };
  }

  /**
   * ONE SNAPSHOT, ONE STORY — the invariant that makes the round-7 bug unrepresentable.
   *
   * The panel reads the same fact from four places: the ordinal in the headline (`pos`), the gold
   * row in the classification (`rows[].you`), the clock (`time`) and the record badge
   * (`recordBeaten` / `recordBy`). Nothing forced them to agree, and the whole-game critic caught
   * exactly what that permits: "'8TH CLASSIFIED / OF 8' with a +04.25 gap to the leader, and
   * simultaneously a 'NEW COURSE RECORD' badge". main.js has since fixed WHAT COUNTS as a record
   * (`_classification`), which fixed that snapshot — but the drawing code would still faithfully
   * render any contradiction it was handed, so the fix lived in one file and the fault lived in
   * another.
   *
   * This is the guard, on the drawing side, where the assertion is actually made: the player's own
   * ROW is the authority, and everything the screen says about the player is derived from it.
   *
   *   · retired if the row is retired, whatever the header says — and a retired race has no clock
   *   · the ordinal is the row's own position
   *   · the unqualified green badge requires the row to be classified, to be the leader, and to be
   *     first. Anything else falls through to the NAMED form, which states the holder and their
   *     time and therefore cannot be read as being about the player.
   *   · a BEST is a lap that exists
   *
   * There is no longer a value of the snapshot for which this screen prints two incompatible
   * claims. It is a pure function of the snapshot, so it is also the thing to unit-test.
   */
  static resultsView(s) {
    const src = s.rows || [];
    const dnf = !!(s.dnf || src.find((x) => x.you)?.dnf);
    // 1 — the player's ROW is made to agree with the header. A screen that says DID NOT FINISH
    //     cannot also print that driver a finishing time three inches below it.
    let rows = src.map((x) => (x.you && dnf
      ? { ...x, dnf: true, finished: false, time: null, gap: null, gapM: 0, leader: false }
      : { ...x }));
    // 2 — retirements to the foot of the table, and the ladder renumbered off THAT order, so a
    //     position printed on the panel is always the row's own place in it (main.js does the same
    //     on the snapshot; this is the guard, and a guard that trusts its input is not one)
    rows.sort((a, b) => (a.dnf === b.dnf ? (a.pos ?? 99) - (b.pos ?? 99) : (a.dnf ? 1 : -1)));
    let cls = 0;
    for (const x of rows) x.pos = x.dnf ? null : ++cls;
    // 3 — exactly one leader, and it is the fastest classified time, because every interval in the
    //     TIME column is measured off it
    let lead = null;
    for (const x of rows) {
      if (!x.dnf && x.finished && x.time != null && (!lead || x.time < lead.time)) lead = x;
    }
    for (const x of rows) x.leader = x === lead;
    const me = rows.find((x) => x.you) || null;
    const pos = (!dnf && me && me.pos != null) ? me.pos : (s.pos ?? 1);
    const laps = (s.laps || []).filter((t) => t != null && t > 0);
    const mine = !!(s.recordBeaten && !dnf && me && me.leader && pos === 1);
    const holderIsMe = !!(me && s.recordBy && s.recordBy === me.name);
    return {
      ...s,
      rows,
      laps,
      dnf,
      pos,
      time: dnf ? null : s.time,
      best: laps.length ? Math.min(...laps) : null,
      recordBeaten: mine,
      // …and if the record is not the player's, whoever holds it has to be NAMED. An unqualified
      // "NEW COURSE RECORD" over somebody else's time is the sentence the critic read as the
      // screen congratulating a player who finished eighth.
      //
      // The remaining hole is the mirror of it: a snapshot where the fastest time is the PLAYER'S
      // but the rest of the screen does not agree they won — retired, or classified behind
      // somebody. `mine` is already false there, and the named form would then print "NEW COURSE
      // RECORD  YOU  02:20:12" over an eighth place, which is the same sentence with a different
      // hat on. Either the whole screen agrees the record is yours, or the badge names somebody
      // else; there is no third badge.
      recordBy: (mine || holderIsMe) ? null : (s.recordBy || null),
      recordTime: (mine || holderIsMe) ? null : (s.recordTime ?? null),
    };
  }

  /**
   * Centre-screen shout. ONE slot: a second message never draws on top of the first — it either
   * supersedes it (if the current one is nearly spent) or waits in the queue. Two overlapping
   * banners with mismatched chevrons is a bug, not two-line art.
   */
  message(text, dur = 2.2, color = ORANGE) {
    const m = { text, t: 0, dur, color };
    if (!this.msg) { this.msg = m; return; }
    if (this.msg.text === text) { this.msg.t = 0; this.msg.dur = dur; return; }
    const left = this.msg.dur - this.msg.t;
    if (left < 0.35) { this.msg.t = Math.max(this.msg.t, this.msg.dur - 0.16); this.msgQueue = [m]; }
    else this.msgQueue = [m];       // depth 1: the newest event is the one worth reading next
  }

  /**
   * @param s {
   *   position, totalRacers, raceTime, lapTime, lap, laps, standings:[{name,you}],
   *   mph, rpm, redline, gear, nitroCharge, nitroTanks, nitroActive, drift, driftScore,
   *   cityName, record, countdown, boostStrength, state
   * }
   */
  /**
   * Integrate HUD state on the simulation clock. main.js calls this from Game.update() so the
   * needle spring, nitro drain and flashes are correct in headless captures too.
   */
  update(s, dt) { this._tick(s, dt); this._ticked = true; }

  draw(s, dt) {
    const ctx = this.bctx || this.ctx;
    const scale = this.bctx ? this.scale : this.dpr;
    this._frame++;
    this.blurOps = 0;
    if (!this._ticked) this._tick(s, dt);
    this._ticked = false;
    const W = this.w, H = this.h;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // scale the whole HUD against a 1600x900 design so layout holds at any resolution
    const k = Math.min(W / 1600, H / 900);
    ctx.save();
    ctx.scale(k, k);
    const VW = W / k, VH = H / k;
    // device pixels per design unit — the resolution every cached patch and sprite is baked at
    const res = scale * k;
    if (res !== this._res) { this._res = res; this._flushCache(); }

    // The race HUD YIELDS to the classification. Two full instrument clusters and a results panel
    // fighting for the same 1600x900 is not a designed screen — and the speedometer and the nitro
    // strip sit exactly where the results screen's bottom bar goes. Faded on the panel's own
    // entrance clock, slightly ahead of it, so the frame is handed over rather than covered up.
    const resFade = 1 - smoothstep(0, 1, clamp(this.resultsT * 1.7, 0, 1));
    // …and a SECOND fade, on the flag itself. main.js cuts to a scripted finish camera the instant
    // the line is crossed (§8's money frame), and an instrument cluster laid over a hero angle is
    // the round-1 tell: "the camera does not change at all: it is the same chase rig". The clusters
    // go first so the flag shot is a picture; the FINISH shout stays, because the shout is what the
    // picture is about, and the panel arrives under it a second later.
    const flagFade = 1 - smoothstep(0, 1, clamp(((s.finishT ?? 0) - 0.30) / 0.80, 0, 1));
    const deckFade = Math.min(resFade, flagFade);
    if (deckFade > 0.004) {
      ctx.save();
      ctx.globalAlpha = deckFade;
      this._drawChassis(ctx, s);
      this._drawCityBanner(ctx, s, VW - GR.M, GR.TOP);
      this._drawClock(ctx, s, VW / 2, GR.TOP);
      this._drawGauge(ctx, s, VW, VH);
      this._drawDrift(ctx, s, GR.M, VH - GR.M, 244, GR.BAND);
      ctx.restore();
    }
    // …the centre banner outlives them: the panel says FINISHED P6 in 100 px type of its own, so
    // the shout goes when the PANEL comes, not when the instruments do.
    // …and the banner takes the fade as an ARGUMENT, not from the context: `_drawMessages` sets
    // globalAlpha absolutely (it has its own envelope), so an outer alpha would not reach it and
    // a four-second FINISHED P3 shout would sit at full strength across the panel's headline.
    // …and it drops down the frame once the flag camera is running. At the vanishing point the
    // shout collided with the start/finish gantry's own chequered banner — the first capture of
    // the new flag shot read "FINISHRT / FINISH" — and it was the round-1 complaint anyway: "the
    // FINISH banner floats alone at the vanishing point with nothing under it". At 0.42 it sits
    // between the gantry and the car, with the car under it.
    const msgY = VH * lerp(0.30, 0.42, smoothstep(0, 0.55, s.finishT ?? 0));
    this._drawMessages(ctx, VW / 2, msgY, resFade);
    if (s.state === 'countdown' && s.countdown != null) this._drawStartLights(ctx, VW / 2, VH * 0.30, s.countdown);
    if (s.results) this._drawResults(ctx, s.results, VW, VH);

    ctx.restore();

    // Composite: one high-quality downscale of the supersampled buffer onto the visible canvas.
    if (this.bctx) {
      const out = this.ctx;
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.clearRect(0, 0, this.canvas.width, this.canvas.height);
      out.imageSmoothingEnabled = true;
      out.imageSmoothingQuality = 'high';
      out.drawImage(this.buf, 0, 0, this.buf.width, this.buf.height,
        0, 0, this.canvas.width, this.canvas.height);
    }

    // ---- the guard. Every glow in this file belongs in a `_patch`, a `_live` or a `_seg` sprite;
    // a glow issued straight onto the backbuffer costs ~107 us, and twenty-eight of them was the
    // 4.2 ms regression this piece has now been through twice. Measured live across every HUD
    // state — race, nitrous, drift, banner, flashes, countdown, results — the correct reading is 0.
    //
    // console.ERROR, not warn, and once only: tools/functest.mjs fails the build on a console error
    // and ignores warnings, so this is the difference between a guard that catches the third
    // regression and a guard that watches it happen. If you are reading this because you tripped
    // it, you do not need to delete your glow — you need to move it inside a `_live` layer.
    if (this.blurOps > this.blurPeak) this.blurPeak = this.blurOps;
    if (this.blurOps > BLUR_BUDGET && !this._blurWarned) {
      this._blurWarned = true;
      console.error(`HUD BLUR BUDGET: ${this.blurOps} blurred canvas2D ops issued straight onto the `
        + `${this.buf ? `${this.buf.width}x${this.buf.height}` : 'HUD'} backbuffer this frame `
        + `(budget ${BLUR_BUDGET}). Each one costs ~107 us there and ~13 us inside a layer. Move `
        + `them into a _patch (static art) or a _live layer (art that moves) — see the COST note at `
        + `the top of src/ui/hud.js.`);
    }
  }

  // ---------------------------------------------------------------- state

  _tick(s, dt) {
    const d = Math.min(dt, 1 / 30);
    this.beat += d;
    this.t += dt;

    // one banner at a time; the queue promotes the moment the slot frees
    if (this.msg) {
      this.msg.t += dt;
      if (this.msg.t > this.msg.dur) this.msg = this.msgQueue.shift() || null;
    } else if (this.msgQueue.length) this.msg = this.msgQueue.shift();

    // position change → flash + a gained/lost chevron
    const pos = s.position || 1;
    if (pos !== this.lastPos) {
      // …but not while the lights are still up. The grid re-forms and the director re-orders it
      // through the countdown, so the deck was firing its red LOST chevron at a player who has not
      // yet moved — a state indicator that lies before the race has even started.
      if (s.state !== 'countdown') {
        this.posDelta = Math.sign(this.lastPos - pos);
        this.posFlash = 1;
      }
      this.lastPos = pos;
    }
    this.posFlash = Math.max(0, this.posFlash - d * 1.1);

    // lap change → banner flash + a pip lighting up, and the lap split restarts
    const lap = s.lap || 1;
    if (lap !== this.lastLap) {
      this.lapFlash = 1;
      this.lastLap = lap;
      this.lapStart = s.raceTime || 0;
    }
    this.lapFlash = Math.max(0, this.lapFlash - d * 0.9);

    // nitro: charge is smoothed so the bar drains and refills visibly
    const tanks = s.nitroTanks ?? 0;
    if (tanks !== this.lastTanks) { this.tankFlash = 1; this.lastTanks = tanks; }
    this.tankFlash = Math.max(0, this.tankFlash - d * 1.6);
    this.charge = lerp(this.charge, clamp(s.nitroCharge ?? 0, 0, 1), 1 - Math.exp(-d * 14));
    this.boostPulse = s.nitroActive
      ? Math.min(1, this.boostPulse + d * 7)
      : Math.max(0, this.boostPulse - d * 3.5);

    // needle: a real spring, so it overshoots into a corner and settles
    const target = clamp((s.mph || 0) / MPH_MAX, 0, 1.04);
    this.needleV += (target - this.needle) * 330 * d;
    this.needleV *= Math.exp(-d * 13);
    this.needle += this.needleV * d;
    if (this.needle < -0.02) { this.needle = -0.02; this.needleV = 0; }

    // drift meter
    const drift = s.drift || 0;
    this.driftShow = lerp(this.driftShow, drift > 0.1 ? 1 : 0, 1 - Math.exp(-d * (drift > 0.1 ? 12 : 4)));
    this.driftScore = drift > 0.08 ? lerp(this.driftScore, s.driftScore || 0, 1 - Math.exp(-d * 8)) : this.driftScore * Math.exp(-d * 1.4);

    // countdown ticks once a second
    if (s.countdown != null) {
      const c = Math.ceil(s.countdown);
      if (c !== this.lastCount) { this.countPulse = 1; this.lastCount = c; }
    }
    this.countPulse = Math.max(0, this.countPulse - d * 2.6);

    // the classification panel rises once, and is gone the moment the race state is thrown away
    this.resultsT = s.results ? Math.min(1, this.resultsT + d * 1.05) : 0;
  }

  // ---------------------------------------------------------------- the chassis
  //
  // Position, race clock, lap and standings are FOUR DECKS OF ONE PLATE. One outer edge, one
  // shadow, one rail running the whole height, hairline rules between decks. Because the plate is
  // a single parallelogram, its leading edge is one unbroken line — the four-different-indents
  // problem cannot come back.

  _chassisRect(s) {
    const rows = Math.min(8, (s.standings || []).length);
    const listH = rows ? 20 + rows * GR.ROW + 5 : 0;
    const decks = [GR.BAND, 40, 30, listH];              // position · clock · lap · standings
    const h = decks.reduce((a, b) => a + b, 0);
    return { x: GR.M, y: GR.TOP, w: GR.COLW, h, decks, rows };
  }

  /**
   * The chassis was the single most expensive thing on screen — 65 blurred ops a frame, half of
   * them the race clock's. Two things in it actually move: the clock and the lap pips. Everything
   * else is repainted only when the position, lap or standings change, so it is split into three
   * patches that bracket the live art in the original draw order. The seven-segment clock's halo
   * bleeds a few pixels up out of its own deck and the lit pips' halo bleeds down out of theirs, so
   * the decks below them cannot be hoisted into one layer — hence three, not one.
   */
  _drawChassis(ctx, s) {
    const R = this._chassisRect(s);
    const { x, y, w, h, decks } = R;
    const f = this.posFlash;
    // leading edge as a function of y — every deck's contents are laid out from this, so the whole
    // column of type follows the same slant as the plate
    const lx = (yy) => x + (h - (yy - y)) * SKEW;
    R.lx = lx;

    const y1 = y + decks[0], y2 = y1 + decks[1], y3 = y2 + decks[2];
    // A flash repaints a plate's edge, its deck wash, the rail glow and the numeral's halo all at
    // once. Keying a *cache* on a value that changes every frame would repaint it every frame and
    // gain nothing, so a flashing deck does not get cached — but it still gets a LAYER. The five
    // blurred ops in this deck cost ~107 us each on the backbuffer and ~15 us each on a 700x640
    // layer around the plate, so a flashing chassis went from 0.5 ms to under 0.1 ms without one
    // pixel moving. The standings are the most expensive part of this cluster by far (two glowed
    // labels a row, plus the leader chip) and they react to neither flash, so they stay cached.
    const posLive = f > 0.02;
    const lapLive = this.lapFlash > 0.02;
    const P = 40;
    const rowSig = (s.standings || []).slice(0, 8).map((r) => `${r.name}${r.you ? '*' : ''}`).join(',');
    const sig = `${x}|${y}|${w}|${h}|${s.position}|${s.totalRacers}|${s.lap}|${s.laps}|${s.state}|${rowSig}`;
    // Separate ids for the live and cached forms: a flash must not evict the settled bake, or the
    // deck repaints once more the moment the flash ends.
    const via = (id, live, bx, by, bw, bh, paint) => (live
      ? this._live(ctx, `${id}~`, bx, by, bw, bh, paint)
      : this._patch(ctx, id, bx, by, bw, bh, sig, paint));

    // ---- deck bodies: each deck is tinted a little differently so the chassis has internal
    // structure without ever breaking into separate plates. Always inset past the rail — the rail
    // is the one element that must run the full height uninterrupted.
    via('chassisA', posLive, x - P, y - P, w + h * SKEW + P * 2, h + P * 2, (c) => {
      panel(c, x, y, w, h, {
        fill: ['rgba(19,25,35,0.91)', 'rgba(5,8,13,0.87)'],
        edge: `rgba(160,196,224,${0.24 + f * 0.35})`,
        accent: [
          [0, ORANGE], [decks[0] / h * 0.98, `rgba(255,146,20,${0.9})`],
          [decks[0] / h, CYAN], [1, 'rgba(20,120,150,0.9)'],
        ],
        glow: 9 + f * 22,
      });
      this._tint(c, R, y, decks[0], `rgba(${62 + f * 90},${48 + f * 30},30,${0.72 + f * 0.28})`, 'rgba(10,12,17,0.05)');
      this._deckPosition(c, s, R, y, decks[0]);
      this._tint(c, R, y1, decks[1], 'rgba(8,26,34,0.55)', 'rgba(4,10,16,0.30)');
      this._rule(c, R, y1, CYAN);
      this._deckClockLabel(c, R, y1, decks[1]);
    });
    this._deckClockDigits(ctx, s, R, y1, decks[1]);

    const finalLap = HUD.finalLap(s);
    via('chassisB', lapLive, x - P, y2 - P, w + h * SKEW + P * 2, decks[2] + P * 2, (c) => {
      this._tint(c, R, y2, decks[2], finalLap ? 'rgba(46,32,20,0.55)' : 'rgba(24,28,38,0.45)',
        'rgba(10,13,19,0.25)');
      this._rule(c, R, y2, this.lapFlash > 0.02 || finalLap ? AMBER : CYAN);
      this._deckLap(c, s, R, y2, decks[2]);
    });
    this._lapPips(ctx, s, R, y2, decks[2]);

    via('chassisC', false, x - P, y2, w + h * SKEW + P * 2, decks[2] + decks[3] + P, (c) => {
      this._lapPipFrames(c, s, R, y2, decks[2]);
      if (decks[3]) {
        this._tint(c, R, y3, decks[3], 'rgba(0,0,0,0.30)', 'rgba(0,0,0,0.36)');
        this._rule(c, R, y3, CYAN);
        this._deckStandings(c, s, R, y3, decks[3]);
      }
    });
    if (decks[3]) this._deckIntervals(ctx, s, R, y3, decks[3]);
  }

  /** Deck body wash, clipped to the chassis and inset past the rail. */
  _tint(ctx, R, y, h, top, bottom) {
    ctx.save();
    platePath(ctx, R.x, R.y, R.w, R.h); ctx.clip();
    platePath(ctx, R.lx(y + h) + RAIL, y, R.w - RAIL, h);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
  }

  /** Deck divider: a hairline that follows the shear, tipped with a short bright accent stub. */
  _rule(ctx, R, yy, color) {
    const x0 = R.lx(yy) + RAIL;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.16, yy - 1.6); ctx.lineTo(x0 + R.w - RAIL - 6, yy - 1.6);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1; ctx.stroke();   // shadow of the step
    ctx.beginPath();
    ctx.moveTo(x0, yy - 0.5); ctx.lineTo(x0 + R.w - RAIL - 6, yy - 0.5);
    ctx.strokeStyle = GR.RULE; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, yy - 0.5); ctx.lineTo(x0 + 16, yy - 0.5);
    ctx.strokeStyle = color; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _deckPosition(ctx, s, R, y, h) {
    const f = this.posFlash;
    const base = y + h - 10;
    const L = R.lx(base) + RAIL;

    // the reference's accent chevron, sitting on the rail — the hero deck's one flourish
    chevrons(ctx, R.lx(y + h * 0.5) + RAIL + 7, y + h * 0.5 - 10, 2, 6, 20, ORANGE, 0.55 + f * 0.45);

    const ord = ordinal(s.position || 1);
    const num = ord.slice(0, -2), suf = ord.slice(-2);
    const numSize = 48;
    const pop = 1 + f * 0.07;
    ctx.save();
    ctx.translate(L + 32, base);
    ctx.scale(pop, pop);
    drawText(ctx, num, {
      x: 0, y: 0, size: numSize, weight: 0.215, italic: 0.24, align: 'left',
      color: gradientFill([[0, '#ffffff'], [0.48, '#eef4fb'], [0.56, '#9db0c6'], [1, '#f2f7fc']]),
      bevel: true, sheen: true,
      glow: f > 0.02 ? { color: ORANGE, blur: 26 * f } : null,
    });
    const nw = measure(num, { size: numSize }).width;
    const SUF = 23, RAISE = 18;
    drawText(ctx, suf, {
      x: nw + ordinalGap(numSize, SUF, RAISE), y: -RAISE, size: SUF, weight: 0.21, italic: 0.24,
      color: ORANGE, glow: { color: 'rgba(255,146,20,0.55)', blur: 8 },
    });
    ctx.restore();

    // labels in the geometric face — upright, so they never compete with the numeral
    label(ctx, 'POS', R.lx(y + 22) + R.w - GR.PAD, y + 22, 9.5, 'rgba(146,172,196,0.8)',
      { align: 'right', tracking: 0.34 });
    ctx.beginPath();
    ctx.moveTo(R.lx(y + 30) + R.w - GR.PAD - 44, y + 30); ctx.lineTo(R.lx(y + 30) + R.w - GR.PAD, y + 30);
    ctx.strokeStyle = 'rgba(150,190,220,0.28)'; ctx.lineWidth = 1; ctx.stroke();
    label(ctx, `OF ${s.totalRacers || 8}`, R.lx(y + h - 14) + R.w - GR.PAD, y + h - 14, 14,
      'rgba(206,222,238,0.95)', { align: 'right', tracking: 0.14, weight: 0.17 });

    // gained / lost indicator
    if (this.posDelta !== 0 && f > 0.02) {
      const up = this.posDelta > 0;
      const ax = R.lx(y + 40) + R.w - 92, ay = y + 40;
      ctx.save();
      ctx.globalAlpha = Math.min(1, f * 1.6);
      ctx.fillStyle = up ? GREEN : RED;
      ctx.shadowBlur = 14; ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath();
      if (up) { ctx.moveTo(ax, ay - 9); ctx.lineTo(ax + 9, ay + 5); ctx.lineTo(ax - 9, ay + 5); }
      else { ctx.moveTo(ax, ay + 9); ctx.lineTo(ax + 9, ay - 5); ctx.lineTo(ax - 9, ay - 5); }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  /** The RACE caption — static; the digits beside it are the only part that ticks. */
  _deckClockLabel(ctx, R, y, h) {
    const base = y + h - 13;
    label(ctx, 'RACE', R.lx(base) + RAIL + GR.PAD, base - 1, 10, CYAN_DIM, { tracking: 0.3 });
  }

  _deckClockDigits(ctx, s, R, y, h) {
    const base = y + h - 13;
    this._seg(ctx, fmtTime(s.raceTime || 0), {
      x: R.lx(base) + R.w - GR.PAD - 5, y: base, size: 22, color: CYAN, align: 'right', glow: 10,
      italic: 0.14, dim: 0.10, dimColor: 'rgba(90,150,175,1)',
    });
  }

  /**
   * The lap deck — and THE FINAL LAP IS A STATE.
   *
   * The director shouts FINAL LAP once, for 2.4 s, and then the deck went back to looking exactly
   * like lap one: `LAP 3/3` in the same paper white as `LAP 1/3`, with the pips already amber from
   * the lap before. §6.7 scores "state animation" on whether the HUD *holds* its states, not on
   * whether an event fired, and the last lap is the one state an arcade racer always carries on the
   * counter. So on the final lap the whole deck changes value — rule, caption, numeral and a tag in
   * the dead span between the counter and the pips, which is exactly what that gap was for.
   *
   * All of it is fixed art keyed on the lap, so it costs a repaint when the lap changes and nothing
   * on any other frame; the motion in this deck is still the lap flash and the breathing pip.
   */
  /** Is the player on the last lap? One answer, so the deck's wash, rule and type cannot split. */
  static finalLap(s) {
    const laps = s.laps || 3;
    return laps > 1 && clamp(s.lap || 1, 1, laps) >= laps && s.state !== 'countdown';
  }

  _deckLap(ctx, s, R, y, h) {
    const laps = s.laps || 3;
    const lap = clamp(s.lap || 1, 1, laps);
    const f = this.lapFlash;
    const fin = HUD.finalLap(s);
    const base = y + h - 9;
    const L = R.lx(base) + RAIL;
    label(ctx, 'LAP', L + GR.PAD, base, 11,
      f > 0.02 ? '#ffe6ac' : fin ? 'rgba(255,206,128,0.95)' : LABEL, { tracking: 0.26 });
    drawText(ctx, `${lap}`, {
      x: L + GR.PAD + 40, y: base + 1, size: 17, weight: 0.22, italic: 0.22,
      color: f > 0.02 ? '#fff6df' : fin ? GOLD_HOT : PAPER,
      glow: f > 0.02 ? { color: AMBER, blur: 18 * f } : fin ? { color: ORANGE, blur: 10 } : null,
    });
    label(ctx, `/${laps}`, L + GR.PAD + 56, base, 11,
      fin ? 'rgba(255,190,120,0.85)' : 'rgba(150,172,196,0.8)', { tracking: 0.06 });

    if (!fin) return;
    // the tag, right-aligned against the pips. Two lengths, because a five-lap race puts five pips
    // in the same row and the long form would run under them.
    const pipL = this._pipRect(s, R, y, h, 0).px;
    const room = pipL - (L + GR.PAD + 84);
    const size = 9.5, tracking = 0.26;
    const long = rmeasure('FINAL LAP', { size, tracking, face: 'geo' }).width;
    const txt = room >= long + 20 ? 'FINAL LAP' : 'FINAL';
    const tw = rmeasure(txt, { size, tracking, face: 'geo' }).width;
    if (room < tw + 10) return;
    const tx = pipL - 10 - tw;
    label(ctx, txt, tx, base - 1, size, '#ffdca0',
      { tracking, glow: { color: ORANGE, blur: 12 } });
    chevrons(ctx, tx - 22, base - 10, 2, 5, 11, ORANGE, 0.85);
  }

  /** Geometry of pip `i` — shared by the lit fill and the frame drawn over it. */
  _pipRect(s, R, y, h, i) {
    const laps = s.laps || 3;
    const py = y + 8, ph = h - 16;
    return { px: R.lx(py + ph) + R.w - GR.PAD - 11 - (laps - 1 - i) * 17, py, ph, w: 11 };
  }

  /**
   * Pips: one per lap, lit as they are completed.
   *
   * The completed and unlit pips are fixed art and are cached. The CURRENT lap's pip breathes, and
   * ONE cached sprite faded to the breath is not the same picture: its fill is translucent and sits
   * directly on top of its own glow, so the original lets the halo glow up through the ink
   * (per-element opacity) where a faded sprite would hide it behind (group opacity).
   *
   * TWO sprites is exact — halo, then ink, each blitted at the breath. Nothing here is repainted
   * per frame any more; a breathing pip is two 22 us blits. See `glowOnly`.
   */
  _lapPips(ctx, s, R, y, h) {
    const laps = s.laps || 3;
    const lap = clamp(s.lap || 1, 1, laps);
    const breath = 0.35 + 0.25 * Math.sin(this.beat * 5);
    for (let i = 0; i < laps; i++) {
      const { px, py, ph, w } = this._pipRect(s, R, y, h, i);
      const done = i < lap - 1, cur = i === lap - 1;
      const P = 18;
      const bx = px - P, by = py - P, bw = w + ph * SKEW + P * 2, bh = ph + P * 2;
      const sig = `${done}|${px}|${py}|${ph}`;
      const shape = (c, style) => {
        platePath(c, px, py, w, ph, SKEW);
        c.fillStyle = style;
        c.fill();
      };
      if (cur) {
        this._patch(ctx, `pipGlow${i}`, bx, by, bw, bh, sig,
          (c) => glowOnly(c, this._res, bw, (gc) => {
            gc.shadowBlur = 10; gc.shadowColor = AMBER; shape(gc, 'rgba(255,194,61,1)');
          }), { alpha: breath });
        this._patch(ctx, `pipInk${i}`, bx, by, bw, bh, sig,
          (c) => shape(c, 'rgba(255,194,61,1)'), { alpha: breath });
      } else {
        // done / unlit pips are fixed art whatever the lap deck above them is doing
        this._patch(ctx, `pip${i}`, bx, by, bw, bh, sig, (c) => {
          if (done) { c.shadowBlur = 10; c.shadowColor = AMBER; }
          shape(c, done ? AMBER : 'rgba(255,255,255,0.12)');
          c.shadowBlur = 0;
        });
      }
    }
  }

  /** The pip frames sit OVER the lit fills, so they are baked with the deck below them, not above. */
  _lapPipFrames(ctx, s, R, y, h) {
    const laps = s.laps || 3;
    for (let i = 0; i < laps; i++) {
      const { px, py, ph, w } = this._pipRect(s, R, y, h, i);
      platePath(ctx, px, py, w, ph, SKEW);
      ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  _deckStandings(ctx, s, R, y, h) {
    const rows = s.standings || [];
    const n = Math.min(8, rows.length);
    if (!n) return;
    const head = 20;

    // heading stays in the display italic — it is a heading; the rows below are the list face
    drawText(ctx, 'STANDINGS', {
      x: R.lx(y + 14) + RAIL + GR.PAD, y: y + 14, size: 10, weight: 0.205, italic: 0.20,
      color: 'rgba(150,206,228,0.9)', tracking: 0.30,
    });
    // column head for the interval, set in the list face so it reads as a table head and not as a
    // second title — the same DRIVER / TIME relationship the results panel already uses
    label(ctx, 'GAP', R.lx(y + 14) + R.w - 16, y + 14, 9, 'rgba(120,168,196,0.85)',
      { tracking: 0.24, align: 'right' });
    chevrons(ctx, R.lx(y + 11) + R.w - 96, y + 4, 3, 5, 9, CYAN, 0.5);
    const hx = R.lx(y + head) + RAIL;
    ctx.beginPath();
    ctx.moveTo(hx + GR.PAD, y + head - 2); ctx.lineTo(hx + R.w - RAIL - 12, y + head - 2);
    ctx.strokeStyle = 'rgba(120,170,200,0.26)'; ctx.lineWidth = 1; ctx.stroke();

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ry = y + head + 2 + i * GR.ROW;
      const rowH = GR.ROW - 2;
      const bx = R.lx(ry + rowH) + RAIL + 3;
      const you = r.you;
      if (you) {
        platePath(ctx, bx, ry, R.w - RAIL - 12, rowH, SKEW);
        const g = ctx.createLinearGradient(bx, 0, bx + R.w, 0);
        g.addColorStop(0, 'rgba(255,158,32,0.94)');
        g.addColorStop(0.62, 'rgba(255,130,10,0.55)');
        g.addColorStop(1, 'rgba(255,146,20,0.06)');
        ctx.fillStyle = g;
        ctx.shadowBlur = 14; ctx.shadowColor = 'rgba(255,146,20,0.6)';
        ctx.fill(); ctx.shadowBlur = 0;
      } else if (i % 2 === 1) {
        platePath(ctx, bx, ry, R.w - RAIL - 12, rowH, SKEW);
        ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fill();
      }
      const baseline = ry + rowH - 5;
      const tx = R.lx(baseline) + RAIL;
      // rank and name both in the geometric face: a list, set as a list
      label(ctx, String(i + 1), tx + GR.PAD + 4, baseline, 11.5,
        you ? 'rgba(48,26,2,0.95)' : 'rgba(140,168,194,0.95)', { tracking: 0.06, align: 'right' });
      label(ctx, r.name, tx + GR.PAD + 12, baseline, 13.5, you ? '#160d02' : '#dde8f3',
        { tracking: 0.10, weight: you ? 0.185 : 0.155 });
      if (you) chevrons(ctx, tx + R.w - 84, ry + 5, 2, 4, 8, 'rgba(40,22,2,0.85)', 0.9);
    }
  }

  /**
   * THE INTERVAL COLUMN — the standings deck's second column, and what its empty right-hand two
   * thirds were always for.
   *
   * The race director already carries this number: `_order()` writes `gap` (seconds behind the
   * leader, from the metres of track between them and the car's own speed) onto every driver every
   * frame, and the RESULTS panel has always shown it. The live deck did not, so the two halves of
   * the same table disagreed about what a standings list is — a name list during the race, a
   * classification afterwards.
   *
   * It is drawn STRAIGHT ONTO THE BACKBUFFER, and that is deliberate — it is the one thing in this
   * file that is neither a `_patch` nor a `_live`, so it is worth saying why.
   *
   *   · It cannot ride in `chassisC` with the names. Those repaint only on an overtake; a gap
   *     changes continuously, and folding it in would repaint eight glowed name labels and the
   *     leader chip every frame, which is the exact cost this file's cache system exists to avoid.
   *
   *   · It does not get a `_patch` of its own either, and that took measuring. Eight independent
   *     numbers at any sane quantisation means the patch's key changes on essentially every frame
   *     — 262 repaints in 300, measured — so the cache buys nothing, while the layer it adds is
   *     written and then used as a `drawImage` source in the same frame, every frame. The bake
   *     itself is 0.10 ms and the frame rate still fell 9 % in every city on the real GPU with it
   *     in (la 93.9 -> 85.4, nyc 97.6 -> 92.7). Drawn direct, at the same 0.1 ms of text, the
   *     four-city perf run is inside noise of the build without the column at all.
   *
   * `shadow: false` is load-bearing: a drop shadow is a blurred op, and eight of them straight onto
   * the 4044x2274 backbuffer is 0.86 ms and trips BLUR_BUDGET, which functest checks. The column
   * sits on the deck's own near-black wash and on the player's orange bar, so it does not need one.
   */
  _deckIntervals(ctx, s, R, y, h) {
    const rows = s.standings || [];
    const n = Math.min(8, rows.length);
    if (!n) return;
    const head = 20;
    // The interval column, and it is a TIME, not a placeholder. Round 7 clamped anything past 99 s
    // to the literal string "+99", which is what a car half a lap down showed for the rest of the
    // race — a number that never moves reads as an unimplemented field, and the one car it happens
    // to most is the player having a bad race. Past a minute the interval is set as m:ss, and once
    // a car is a whole lap behind the honest answer is laps, not seconds.
    const lapM = s.lapMetres || 0;
    const txt = (r, i) => {
      if (r.dnf) return 'DNF';
      if (i === 0) return 'LEAD';
      const down = lapM > 100 ? Math.floor((r.gapM ?? 0) / lapM) : 0;
      if (down >= 1) return `+${down} LAP${down > 1 ? 'S' : ''}`;
      const g = Math.abs(r.gap ?? 0);
      if (g < 10) return `+${g.toFixed(2)}`;
      if (g < 60) return `+${g.toFixed(1)}`;
      return `+${Math.floor(g / 60)}:${String(Math.floor(g % 60)).padStart(2, '0')}`;
    };
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ry = y + head + 2 + i * GR.ROW;
      const baseline = ry + (GR.ROW - 2) - 6;
      const tx = R.lx(baseline) + RAIL;
      const lead = i === 0 && !r.dnf;
      label(ctx, txt(r, i), tx + R.w - 16, baseline, lead ? 10 : 11.5,
        r.you ? 'rgba(38,20,2,0.95)' : r.dnf ? 'rgba(226,110,96,0.92)'
          : lead ? 'rgba(255,196,78,0.95)' : 'rgba(158,192,216,0.92)',
        // `false`, not `null`: `label()` resolves its default with `??`, so a null here would put
        // the drop shadow BACK — eight blurred ops a frame straight onto the 4044x2274 backbuffer,
        // which is 0.86 ms and trips BLUR_BUDGET. (Measured the hard way; see the note above.)
        { tracking: lead ? 0.18 : 0.04, align: 'right', weight: r.you ? 0.175 : 0.145, shadow: false });
    }
  }

  // ---------------------------------------------------------------- top band, right

  // The banner never animates: it is the same art from lights-out to the flag, and only a city or
  // record change can alter it. It is the cheapest thing in the HUD to cache and one of the more
  // expensive to draw (6 blurred ops), so the whole cluster goes in one patch.
  _drawCityBanner(ctx, s, xRight, y) {
    if (!s.cityName) return;
    const size = 22;
    const name = String(s.cityName).toUpperCase();
    const tw = measure(name, { size, tracking: 0.13 }).width;
    const w = Math.max(226, tw + 60), h = GR.BAND;      // same 64 px band as the position deck
    const x = xRight - w;                                // bottom-right corner on the margin
    const P = 34;
    this._patch(ctx, 'banner', x - P, y - P, w + h * SKEW + P * 2, h + P * 2,
      `${name}|${s.record}|${x}|${y}|${w}`, (c) => this._paintCityBanner(c, s, x, y, w, h, name, size));
  }

  _paintCityBanner(ctx, s, x, y, w, h, name, size) {
    const nameH = 38;
    const lx = (yy) => x + (h - (yy - y)) * SKEW;

    panel(ctx, x, y, w, h, {
      fill: ['rgba(14,17,24,0.92)', 'rgba(5,7,12,0.9)'], edge: 'rgba(255,180,90,0.34)',
      // the rail changes value where the deck behind it changes: burnt orange against the bright
      // name band, hot amber against the dark record deck, so 3 px reads on both
      accent: [[0, '#8a3800'], [nameH / h - 0.01, '#7a3200'], [nameH / h, '#ffc44e'], [1, '#ff8a0d']],
      glow: 8,
    });

    // top deck: the orange name band, clipped inside the plate so the rail still runs past it
    ctx.save();
    platePath(ctx, x, y, w, h); ctx.clip();
    platePath(ctx, x + (h - nameH) * SKEW + RAIL, y, w - RAIL, nameH);
    const g = ctx.createLinearGradient(x, y, x + w * 0.85, y + nameH);
    g.addColorStop(0, '#ffb43a'); g.addColorStop(0.45, '#ff8a0d'); g.addColorStop(1, '#ffd15c');
    ctx.fillStyle = g;
    ctx.shadowBlur = 16; ctx.shadowColor = 'rgba(255,138,13,0.45)';
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.fillRect(x - 10, y, w + 30, nameH * 0.32);
    ctx.restore();

    chevrons(ctx, lx(y + nameH * 0.5) + RAIL + 8, y + 12, 2, 5, 14, 'rgba(60,26,0,0.8)', 0.9);
    drawText(ctx, name, {
      x: lx(y + nameH - 11) + w / 2 + 10, y: y + nameH - 11, size, weight: 0.215, italic: 0.22,
      align: 'center', color: '#241403', tracking: 0.13,
    });

    // bottom deck: the record, label in the geometric face
    const base = y + h - 8;
    ctx.beginPath();
    ctx.moveTo(lx(y + nameH) + RAIL, y + nameH - 0.5);
    ctx.lineTo(lx(y + nameH) + w, y + nameH - 0.5);
    ctx.strokeStyle = 'rgba(255,190,110,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    if (s.record) {
      label(ctx, 'RECORD', lx(base) + RAIL + GR.PAD, base, 10.5, 'rgba(255,181,94,0.9)', { tracking: 0.28 });
      // the HUD's own clock face, not the city file's raw string — one format for every time on
      // screen, so this deck and the mission clock's `REC` read as the same instrument
      label(ctx, fmtTime(parseClock(s.record)), lx(base) + w - GR.PAD, base, 13.5, '#e2ecf6',
        { align: 'right', tracking: 0.1, weight: 0.17 });
    }
  }

  /**
   * Centre-top mission clock — the reference's red seven-segment plate. Same 64 px band, same
   * shear, same 3 px rail as the position deck and the city banner, so the top of the frame reads
   * as one row of instruments.
   */
  _drawClock(ctx, s, cx, y) {
    const counting = s.state === 'countdown' && s.countdown != null;
    const target = parseClock(s.record);
    const left = target > 0 ? target - (s.raceTime || 0) : 0;
    const over = target > 0 && left <= 0;
    let txt, cap, ref = null;
    if (counting) { txt = fmtCountdown(s.countdown); cap = 'GET READY'; }
    else if (target > 0) {
      const a = Math.abs(left);
      txt = a >= 60 ? fmtTime(a) : fmtCountdown(a);
      cap = over ? 'OVER BY' : 'TIME TO BEAT';
      // name the datum so it can't read as a second race clock — and set it with the HUD's own
      // clock face rather than echoing the city file's raw string, so `REC 02:08:15` and the
      // digits under it are one format
      ref = `REC ${fmtTime(target)}`;
    } else { txt = fmtTime(Math.max(0, (s.raceTime || 0) - (this.lapStart || 0))); cap = 'LAP TIME'; }

    const w = 236, h = GR.BAND, head = 20;
    const x = cx - w / 2;
    const lx = (yy) => x + (h - (yy - y)) * SKEW;
    const urgent = counting || over || (target > 0 && left < 10);
    const p = counting ? this.countPulse : (urgent ? 0.4 + 0.4 * Math.sin(this.beat * 8) : 0);
    const col = urgent ? RED : '#ff9b3c';

    // inset glass window for the digits
    const wy = y + head + 4, wh = h - head - 9, wx = lx(wy + wh) + RAIL + 6;
    const ww = w - RAIL - 18;

    // The plate is the same art from frame to frame unless the pulse is running, and the pulse only
    // runs during the countdown, inside the last ten seconds of the target, or once you are over it.
    // Rather than key the cache on a continuously-varying pulse — a cache that repaints every frame
    // saves nothing — the plate is repainted every frame while it pulses, into its own layer.
    const paintPlate = (c) => {
      panel(c, x, y, w, h, {
        fill: ['rgba(21,12,12,0.94)', 'rgba(3,4,7,0.93)'],
        edge: `rgba(255,110,70,${0.30 + p * 0.5})`, accent: col, glow: 9 + p * 24,
      });

      // caption deck across the top, tinted so it separates from the digit window below
      c.save();
      platePath(c, x, y, w, h); c.clip();
      platePath(c, x + (h - head) * SKEW + RAIL, y, w - RAIL, head);
      const hg = c.createLinearGradient(0, y, 0, y + head);
      hg.addColorStop(0, urgent ? 'rgba(92,22,15,0.95)' : 'rgba(62,34,15,0.92)');
      hg.addColorStop(1, 'rgba(12,8,8,0.55)');
      c.fillStyle = hg; c.fill();
      c.restore();
      c.beginPath();
      c.moveTo(lx(y + head) + RAIL, y + head - 0.5);
      c.lineTo(lx(y + head) + w, y + head - 0.5);
      c.strokeStyle = `rgba(255,150,100,${0.35 + p * 0.35})`; c.lineWidth = 1;
      c.stroke();

      label(c, cap, lx(y + head - 6) + RAIL + GR.PAD, y + head - 6, 9.5,
        over ? 'rgba(255,140,118,0.98)' : 'rgba(255,204,164,0.94)', { tracking: 0.3 });
      if (ref) {
        label(c, ref, lx(y + head - 6) + w - GR.PAD, y + head - 6, 9.5,
          'rgba(196,214,232,0.75)', { align: 'right', tracking: 0.1 });
      }

      platePath(c, wx, wy, ww, wh);
      c.fillStyle = 'rgba(0,0,0,0.55)'; c.fill();
      c.save();
      platePath(c, wx, wy, ww, wh); c.clip();
      platePath(c, wx, wy, ww, wh);
      c.shadowBlur = 7; c.shadowColor = 'rgba(0,0,0,0.9)';
      c.strokeStyle = 'rgba(0,0,0,0.85)'; c.lineWidth = 3; c.stroke();
      c.restore();
      platePath(c, wx, wy, ww, wh);
      c.strokeStyle = `rgba(255,140,90,${0.20 + p * 0.30})`; c.lineWidth = 1; c.stroke();
    };
    const CP = 34;
    const cb = [x - CP, y - CP, w + h * SKEW + CP * 2, h + CP * 2];
    if (p > 0.02) this._live(ctx, 'clockL', ...cb, paintPlate);
    else this._patch(ctx, 'clock', ...cb, `${cap}|${ref}|${urgent}|${over}|${col}|${x}|${y}|${w}`, paintPlate);

    // Quantised so the pulse cannot thrash the sprite cache: a 3 px step on a 12–30 px halo is
    // invisible behind digits this bright, and the plate's rail carries the pulse anyway. p === 0
    // lands exactly on the unpulsed 12, which is the state the clock spends most of a race in.
    this._seg(ctx, txt, {
      x: wx + ww / 2 - 1, y: wy + wh - 6, size: 27, color: col, align: 'center',
      glow: 12 + Math.round(p * 6) * 3, italic: 0.12, dim: 0.11, dimColor: 'rgba(110,44,30,1)',
    });

    // Record-progress rail along the foot of the plate: how much of the target time is spent.
    //
    // It grows continuously, so nothing about it is constant — but its ARTWORK only changes when
    // the drawn end moves by a whole device pixel, which on a 236-unit rail over a minute-long
    // record happens about eight times a second, not sixty. Quantising the length to the device
    // pixel it would have been rasterised to anyway turns a per-frame blurred repaint into a blit
    // on seven frames out of eight, and moves the tip by at most half a device pixel — a fifth of
    // a CSS pixel on a 2.6 px rail.
    if (target > 0 && !counting) {
      const raw = clamp((s.raceTime || 0) / target, 0, 1);
      const px = Math.round(raw * (w - 2) * this._res);
      const t = px / ((w - 2) * this._res);
      const RP = 12;
      this._patch(ctx, 'clockRail', x - RP, y + h - 2 - RP, w + h * SKEW + RP * 2, RP * 2,
        `${px}|${over}|${col}|${x}|${y}|${w}|${h}`, (c) => {
        c.save();
        platePath(c, x, y, w, h); c.clip();
        c.beginPath();
        c.moveTo(x + 1, y + h - 2);
        c.lineTo(x + 1 + (w - 2) * t, y + h - 2);
        c.strokeStyle = over ? RED : '#ff9b3c'; c.lineWidth = 2.6;
        c.shadowBlur = 8; c.shadowColor = col;
        c.stroke();
        c.restore();
      });
    }
  }

  // ---------------------------------------------------------------- gauge cluster
  //
  // The dial is not a floating circle: it is bolted to the nitro strip by a yoke cut at the same
  // shear, so the bottom-right corner is one assembly on the same grid as everything else.

  _drawGauge(ctx, s, VW, VH) {
    const R = 148;
    const barW = 306, barH = GR.BAND;
    const barY = VH - GR.M - barH, barX = VW - GR.M - barW;
    const cx = barX + barW - 8 - R + barH * SKEW * 0.5;
    const cy = barY - 14 - R + R * 0.30;

    // Yoke: a shear-cut mounting slab the dial is bolted to. It is cut wide enough to show past the
    // bezel on both sides and long enough to run into the top of the strip, so the gauge reads as
    // part of the same assembly rather than a circle floating in the corner.
    const yw = 254, yTop = cy + R * 0.74;
    const yh = barY - yTop + 8;
    const yx = cx - yw / 2 - yh * SKEW * 0.5;
    const P = 30;
    this._patch(ctx, 'yoke', yx - P, yTop - P, yw + yh * SKEW + P * 2, yh + P * 2,
      `${yx}|${yTop}|${yw}|${yh}`, (c) => {
        panel(c, yx, yTop, yw, yh, {
          fill: ['rgba(14,19,27,0.86)', 'rgba(6,9,14,0.9)'],
          edge: 'rgba(150,190,220,0.18)', accent: null, shadow: 0.4,
        });
        // bolt heads either side, at the same inset as the strip's gear chip
        for (const sx of [-1, 1]) {
          const bxp = cx + sx * (yw * 0.5 - 13) - yh * SKEW * 0.18, byp = yTop + 13;
          c.beginPath(); c.arc(bxp, byp, 3.2, 0, TAU);
          const bg = c.createLinearGradient(bxp - 3, byp - 3, bxp + 3, byp + 3);
          bg.addColorStop(0, 'rgba(190,208,224,0.85)'); bg.addColorStop(1, 'rgba(40,50,62,0.9)');
          c.fillStyle = bg; c.fill();
        }
      });

    this._drawSpeedo(ctx, s, cx, cy, R);
    this._drawNitro(ctx, s, barX, barY, barW, barH);
  }

  _drawSpeedo(ctx, s, cx, cy, R) {
    const mph = Math.max(0, s.mph || 0);
    const MAX = MPH_MAX, RED0 = MPH_RED;
    // 220° sweep with a 140° gap at the bottom. The gap is sized so the two end numerals (0 and
    // 320) sit above the shoulders of the digital readout rather than beside it — the readout
    // owns the bottom of the face outright.
    const a0 = Math.PI * (160 / 180), a1 = Math.PI * (380 / 180);
    const angOf = (v) => a0 + (a1 - a0) * clamp(v / MAX, 0, 1.02);
    const boost = this.boostPulse;

    const AR = R * 0.845, AW = R * 0.062;
    const O = { ox: cx, oy: cy };

    ctx.save();
    ctx.translate(cx, cy);

    // ---- the dial as a manufactured object: scrim, bezel, knurling, face, hatch, gloss and the
    // two fixed arcs. None of it has ever changed between frames; it is the single largest run of
    // static art in the HUD (a 60-cut knurl, a 96-line brushed hatch and a glowing redline arc).
    this._patch(ctx, 'dialFace', -R * 1.6, -R * 1.6, R * 3.2, R * 3.2, `${R}`, (c) => {
      scrim(c, 0, 0, R * 1.55, 0.55);

      // bezel: metal annulus with a light source top-left
      c.beginPath();
      c.arc(0, 0, R, 0, TAU);
      c.arc(0, 0, R * 0.90, 0, TAU, true);
      const rim = c.createLinearGradient(-R * 0.7, -R, R * 0.7, R);
      rim.addColorStop(0, '#b9c9d8'); rim.addColorStop(0.16, '#5d6e7f');
      rim.addColorStop(0.30, '#1d2732');
      rim.addColorStop(0.55, '#5a6c7e'); rim.addColorStop(0.80, '#131a22');
      rim.addColorStop(1, '#46545f');
      c.fillStyle = rim; c.fill();

      c.beginPath(); c.arc(0, 0, R - 0.6, 0, TAU);
      c.strokeStyle = 'rgba(226,240,250,0.30)'; c.lineWidth = 1.2; c.stroke();

      // knurling on the bezel — 60 fine cuts, brighter where the light falls
      c.save();
      c.lineWidth = 1;
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * TAU;
        const lit = 0.06 + 0.16 * Math.max(0, Math.cos(a + 2.4));
        c.strokeStyle = `rgba(235,246,255,${lit})`;
        c.beginPath();
        c.moveTo(Math.cos(a) * (R - 1.5), Math.sin(a) * (R - 1.5));
        c.lineTo(Math.cos(a) * (R * 0.915), Math.sin(a) * (R * 0.915));
        c.stroke();
      }
      c.restore();

      // dial face
      c.beginPath(); c.arc(0, 0, R * 0.90, 0, TAU);
      const face = c.createRadialGradient(-R * 0.32, -R * 0.42, R * 0.05, 0, 0, R * 0.98);
      face.addColorStop(0, 'rgba(30,44,60,0.95)');
      face.addColorStop(0.62, 'rgba(11,17,26,0.94)');
      face.addColorStop(1, 'rgba(3,5,9,0.97)');
      c.fillStyle = face; c.fill();

      // brushed radial hatch on the face — the thing that stops it reading as flat vector fill
      c.save();
      c.beginPath(); c.arc(0, 0, R * 0.90, 0, TAU); c.clip();
      c.lineWidth = 1;
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * TAU;
        c.strokeStyle = `rgba(150,190,220,${0.028 + 0.040 * ((i * 7) % 5) / 4})`;
        c.beginPath();
        c.moveTo(Math.cos(a) * R * 0.12, Math.sin(a) * R * 0.12);
        c.lineTo(Math.cos(a) * R * 0.90, Math.sin(a) * R * 0.90);
        c.stroke();
      }
      c.strokeStyle = 'rgba(150,190,220,0.07)';
      for (const rr of [0.30, 0.46, 0.62]) {
        c.beginPath(); c.arc(0, 0, R * rr, 0, TAU); c.stroke();
      }
      c.restore();

      c.save();
      c.beginPath(); c.arc(0, 0, R * 0.90, 0, TAU); c.clip();
      const gl = c.createLinearGradient(0, -R, 0, R * 0.2);
      gl.addColorStop(0, 'rgba(255,255,255,0.12)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gl;
      c.beginPath(); c.ellipse(-R * 0.22, -R * 0.38, R * 0.70, R * 0.48, -0.42, 0, TAU); c.fill();
      c.restore();

      c.beginPath(); c.arc(0, 0, R * 0.90, 0, TAU);
      c.strokeStyle = 'rgba(150,200,225,0.22)'; c.lineWidth = 1.2; c.stroke();

      // arcs: track and redline. The live speed fill goes over these, so it stays outside.
      c.lineCap = 'butt';
      c.beginPath(); c.arc(0, 0, AR, a0, a1);
      c.strokeStyle = 'rgba(255,255,255,0.07)'; c.lineWidth = AW; c.stroke();

      c.beginPath(); c.arc(0, 0, AR, angOf(RED0), a1);
      c.strokeStyle = 'rgba(255,46,46,0.90)'; c.lineWidth = AW;
      c.shadowBlur = 12; c.shadowColor = 'rgba(255,40,40,0.8)';
      c.stroke(); c.shadowBlur = 0;
    }, O);
    ctx.lineCap = 'butt';

    // The speed fill and its bright head move every frame and glow hard — two of the three most
    // expensive ops in the old HUD. They go into one `_live` layer cut to the arc's own annulus
    // (about 640x640 device px against the backbuffer's 4045x2275), which is the whole saving.
    const nAng = a0 + (a1 - a0) * clamp(this.needle, 0, 1.02);
    if (this.needle > 0.005) {
      const AB = AR + AW; // arc bounds; the halo is well inside the 34 px pad the layer adds below
      this._live(ctx, 'speedArc', -AB - 18, -AB - 18, (AB + 18) * 2, (AB + 18) * 2, (c) => {
        c.lineCap = 'butt';
        c.beginPath(); c.arc(0, 0, AR, a0, nAng);
        const ag = c.createLinearGradient(-R, R, R, -R);
        ag.addColorStop(0, boost > 0.05 ? '#fff3c4' : '#22a9d6');
        ag.addColorStop(1, boost > 0.05 ? '#ffb02e' : '#8ff0ff');
        c.strokeStyle = ag; c.lineWidth = AW;
        c.shadowBlur = 16 + boost * 18; c.shadowColor = boost > 0.05 ? ORANGE : CYAN;
        c.stroke(); c.shadowBlur = 0;
        // bright head
        c.beginPath();
        c.arc(Math.cos(nAng) * AR, Math.sin(nAng) * AR, AW * 0.34, 0, TAU);
        c.fillStyle = boost > 0.05 ? '#fff8e0' : '#dffaff';
        c.shadowBlur = 14; c.shadowColor = boost > 0.05 ? AMBER : CYAN;
        c.fill(); c.shadowBlur = 0;
      }, O);
    }

    // ---- tick hierarchy: minor every 10, major every 20, numeral every 40.
    // The numeral row sits at NUM_R, chosen so even a three-figure numeral's corner stays inside
    // TICK_R: NUM_R + halfDiagonal(numeral) < TICK_R. No stroke can cross a figure at any angle.
    // The speed fill's halo washes inward across the tick band, and the original draws the ticks
    // over it — so this patch has to be blitted after the live arc above, not folded into the face.
    // (coherence pass) the numeral row went from seven figures to nine when MPH_MAX moved to 320,
    // so the arc length each one gets fell from 36.7° to 27.5°. Size 0.098 → 0.088 and the row
    // pushed 0.018 R further out together restore the gap between "120" and "160" at the apex,
    // where the row is most crowded, without breaking NUM_R + halfDiagonal(numeral) < TICK_R.
    const TICK_R = R * 0.700, NUM_R = R * 0.570, NUM_S = R * 0.088;
    this._patch(ctx, 'dialTicks', -R, -R, R * 2, R * 2, `${R}`, (c) => {
      for (let v = 0; v <= MAX; v += 10) {
        const a = angOf(v);
        const major = v % 20 === 0;
        const hot = v >= RED0;
        const r1 = R * 0.795, r0 = major ? TICK_R : R * 0.742;
        c.beginPath();
        c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        c.strokeStyle = hot
          ? (major ? 'rgba(255,124,112,0.98)' : 'rgba(255,124,112,0.55)')
          : (major ? 'rgba(232,246,253,0.95)' : 'rgba(180,206,225,0.42)');
        c.lineWidth = major ? R * 0.026 : R * 0.012;
        c.stroke();
      }
      for (let v = 0; v <= MAX; v += 40) {
        const a = angOf(v), hot = v >= RED0;
        drawText(c, String(v), {
          x: Math.cos(a) * NUM_R, y: Math.sin(a) * NUM_R + NUM_S * 0.46, size: NUM_S, weight: 0.205,
          align: 'center', color: hot ? 'rgba(255,158,146,0.95)' : 'rgba(222,238,250,0.90)',
          tracking: 0.02, shadow: { color: 'rgba(0,0,0,0.75)', dy: NUM_S * 0.10, blur: 4 },
        });
      }
    }, O);

    // ---- needle with weight: counterweight tail, taper, shadow.
    //
    // The needle is the same object on every frame of a race — only its ANGLE moves — so it is
    // baked once, at rotation zero, and blitted through the rotation. That trades one blurred
    // repaint a frame (~300 us) for one rotated blit (~25 us). The blit resamples, which a blit at
    // the identity transform would not; at the backbuffer's 2.5x supersample that is a third of a
    // CSS pixel of softening on an edge that is then box-filtered by 2.5x on composite anyway, and
    // it is a glowing red needle rather than type. Captured before and after at 1600x900: no
    // visible difference at 1:1 or at 3x on the needle tip.
    const NB = R * 0.80;
    // (0, 0) as the pivot, not (cx, cy): `ctx` is already translated to the dial's centre here.
    this._sprite(ctx, 'needle', -NB, -NB, NB * 2, NB * 2, `${R}`, nAng, 0, 0, (c) => {
      c.save();
      c.save();
      c.translate(R * 0.02, R * 0.03);
      c.beginPath();
      c.moveTo(-R * 0.20, -R * 0.030); c.lineTo(R * 0.72, -R * 0.012);
      c.lineTo(R * 0.745, 0); c.lineTo(R * 0.72, R * 0.012); c.lineTo(-R * 0.20, R * 0.030);
      c.closePath();
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.fill();
      c.restore();
      c.beginPath();
      c.moveTo(-R * 0.20, -R * 0.030); c.lineTo(R * 0.72, -R * 0.012);
      c.lineTo(R * 0.745, 0); c.lineTo(R * 0.72, R * 0.012); c.lineTo(-R * 0.20, R * 0.030);
      c.closePath();
      const ng = c.createLinearGradient(-R * 0.2, 0, R * 0.75, 0);
      ng.addColorStop(0, '#8a1010'); ng.addColorStop(0.25, '#ff4a2a'); ng.addColorStop(1, '#ff8a5a');
      c.fillStyle = ng;
      c.shadowBlur = 12; c.shadowColor = 'rgba(255,60,30,0.85)';
      c.fill(); c.shadowBlur = 0;
      // counterweight
      c.beginPath(); c.ellipse(-R * 0.155, 0, R * 0.055, R * 0.042, 0, 0, TAU);
      c.fillStyle = '#c8332a'; c.fill();
      c.restore();
    });

    // ---- hub, and the scrim the readout sits on. Both are painted over the needle, so they are a
    // patch of their own rather than part of the dial face.
    const mphTxt = String(Math.round(mph));
    this._patch(ctx, 'dialHub', -R * 0.7, -R * 0.2, R * 1.4, R * 1.1, `${R}`, (c) => {
      c.beginPath(); c.arc(0, 0, R * 0.105, 0, TAU);
      const hub = c.createLinearGradient(-R * 0.1, -R * 0.1, R * 0.1, R * 0.1);
      hub.addColorStop(0, '#e2ecf5'); hub.addColorStop(0.5, '#7d8b99'); hub.addColorStop(1, '#2b343e');
      c.fillStyle = hub; c.fill();
      c.beginPath(); c.arc(0, 0, R * 0.105, 0, TAU);
      c.strokeStyle = 'rgba(10,14,20,0.9)'; c.lineWidth = 1.4; c.stroke();
      c.beginPath(); c.arc(0, 0, R * 0.042, 0, TAU);
      c.fillStyle = '#1a2129'; c.fill();

      // readout backing: it owns the open bottom of the dial, dropped clear of the 0 / 320 numerals
      c.save();
      c.beginPath();
      c.ellipse(0, R * 0.46, R * 0.62, R * 0.36, 0, 0, TAU);
      const rb = c.createRadialGradient(0, R * 0.46, 0, 0, R * 0.46, R * 0.62);
      rb.addColorStop(0, 'rgba(2,5,9,0.86)'); rb.addColorStop(0.55, 'rgba(2,5,9,0.55)');
      rb.addColorStop(1, 'rgba(2,5,9,0)');
      c.fillStyle = rb; c.fill();
      c.restore();
    }, O);

    // The readout changes every frame at speed and carries a drop shadow plus, on nitrous, a halo —
    // two blurred ops. Its layer is cut to the number itself, so it is the cheapest kind there is.
    // The readout is two blurred ops — a drop shadow for legibility and, on nitrous, a halo — and
    // it changes on nearly every frame at speed. It is also one of only ~240 strings drawn at a
    // fixed point on the dial, so it belongs in a value-keyed sprite cache rather than a repaint.
    //
    // The halo is quantised to a WHOLE DEVICE PIXEL of blur radius, which is the unit shadowBlur is
    // actually specified in (verified: `tools/_shadowsem.mjs`) — so the cache key is not an
    // approximation of the glow, it is the glow rounded to the finest step that can render
    // differently at all. It also keeps the working set small: the boost pulse takes ~0.15 s to
    // rise, so the radius passes through its 22 values slowly while the number changes every frame.
    const MS = R * 0.300;
    const bBlur = boost > 0.05 ? Math.max(1, Math.round(22 * boost)) : 0;
    this._stamp(ctx, `mph|${mphTxt}|${bBlur}|${R}`,
      -R * 0.62, R * 0.520 - MS * 1.25, R * 1.24, MS * 1.75, (c) => {
        drawText(c, mphTxt, {
          x: 0, y: R * 0.520, size: MS, weight: 0.215, italic: 0.06, align: 'center',
          color: gradientFill([[0, '#ffffff'], [0.5, '#f2f8fd'], [0.58, '#a8bccf'], [1, '#ffffff']]),
          sheen: true, tracking: 0.02,
          shadow: { color: 'rgba(0,0,0,0.6)', dy: R * 0.018, blur: 6 },
          glow: bBlur ? { color: ORANGE, blur: bBlur } : null,
        });
      }, O);
    // hairline rule under the number, then the unit — a caption, not a competing readout. Under
    // nitrous the number's halo reaches down across both, and the original paints them over it.
    this._patch(ctx, 'dialUnit', -R * 0.3, R * 0.5, R * 0.6, R * 0.32, `${R}`, (c) => {
      c.beginPath();
      c.moveTo(-R * 0.155, R * 0.585); c.lineTo(R * 0.155, R * 0.585);
      c.strokeStyle = 'rgba(150,196,225,0.35)'; c.lineWidth = 1;
      c.stroke();
      label(c, 'MPH', 0, R * 0.700, R * 0.098, 'rgba(190,214,236,0.95)', { align: 'center', tracking: 0.38 });
    }, O);

    // Redline warning: the whole rim flushes when the engine is in the red — which under nitrous is
    // most of the lap, so this would otherwise be a blurred op on every frame perf.mjs measures.
    // Fixed art at a pulsing opacity: halo sprite and ink sprite, each blitted at the pulse. See
    // `glowOnly` for why one sprite would not have been the same picture.
    if (mph >= RED0) {
      const p = 0.45 + 0.55 * Math.sin(this.beat * 13);
      const A = 0.14 + 0.30 * p;
      const RB = R * 0.945 + R * 0.014 + 26;
      const rim = (c) => {
        c.beginPath(); c.arc(0, 0, R * 0.945, 0, TAU);
        c.strokeStyle = 'rgba(255,64,40,1)';
        c.lineWidth = R * 0.028;
        c.stroke();
      };
      this._patch(ctx, 'redGlow', -RB, -RB, RB * 2, RB * 2, `${R}`,
        (c) => glowOnly(c, this._res, RB * 2, (gc) => {
          gc.shadowBlur = 20; gc.shadowColor = RED; rim(gc);
        }), { ...O, alpha: A });
      this._patch(ctx, 'redInk', -RB, -RB, RB * 2, RB * 2, `${R}`, rim, { ...O, alpha: A });
    }

    ctx.restore();
  }

  _drawNitro(ctx, s, x, y, w, h) {
    const active = s.nitroActive;
    const tanks = s.nitroTanks ?? 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.beat * 12);
    const lx = (yy) => x + (h - (yy - y)) * SKEW;

    const gh = h - 18, gy = y + 9, gw = 50;
    const gx = lx(gy + gh) + RAIL + 9;
    const hb = y + 26;
    const tx = lx(hb) + RAIL + 74;
    const bh = 17, by = y + h - 26;
    const bx = lx(by + bh) + RAIL + 74, bw = w - 74 - RAIL - GR.PAD;
    const spendIdx = this.tankFlash > 0.02 ? tanks : -1;

    // While the strip is firing, its edge and its rail glow breathe on a 12 rad/s sine — but the
    // drop shadow, the body and the inner shadow underneath them do not. Those are the two blurred
    // ops; the edge is an unblurred stroke and the rail is one more. So the plate is baked without
    // its edge and rail and only those two are re-drawn live, which keeps a firing nitro strip at
    // one blurred op a frame instead of three. Idle, the whole thing is fixed art.
    const P = 34;
    this._patch(ctx, 'nitroPlate', x - P, y - P, w + h * SKEW + P * 2, h + P * 2, `${active}|${x}|${y}|${w}|${h}`,
      (c) => panel(c, x, y, w, h, {
        fill: active ? ['rgba(60,27,4,0.94)', 'rgba(24,10,2,0.92)'] : ['rgba(15,20,29,0.91)', 'rgba(5,8,13,0.88)'],
        // idle, the edge and rail are fixed too and go straight into the patch
        edge: active ? null : 'rgba(150,180,205,0.28)',
        accent: active ? null : CYAN, glow: 7,
      }));
    if (active) {
      // The breathing edge stroke has no blur at all, so it is free on the backbuffer and stays
      // there. The RAIL is the expensive half: its halo pulses from 14 to 26 px, and a radius is
      // not something a blit alpha can fake. So the pulse is quantised into PULSE_STEPS and each
      // step gets its own sprite, baked the first time it is reached and blitted for ever after.
      // At 12 rad/s the strip passes through a step every ~1.5 frames, which is finer than the
      // animation is sampled — the breath is unchanged, and it costs one blit instead of a blurred
      // repaint. The sprite is cut to the rail alone (about 96x233 device px), not to the plate.
      platePath(ctx, x, y, w, h);
      ctx.strokeStyle = `rgba(255,180,60,${0.55 + 0.35 * pulse})`;
      ctx.lineWidth = 1.2; ctx.stroke();
      const pb = Math.round(pulse * (PULSE_STEPS - 1));
      const pq = pb / (PULSE_STEPS - 1);
      const RG = 14;
      this._patch(ctx, `nitroRail${pb}`, x - RG, y - RG, RAIL + h * SKEW + RG * 2, h + RG * 2,
        `${x}|${y}|${h}`, (c) => railOn(c, x, y, h, AMBER, 14 + 12 * pq));
    }

    this._patch(ctx, 'nitroFace', x - 24, y - 24, w + h * SKEW + 48, h + 48,
      `${active}|${tanks}|${s.gear}|${spendIdx}|${this.tankFlash > 0.02 ? Math.round(this.tankFlash * 12) : 0}|${x}|${y}|${w}`, (c) => {
        // gear chip — its own inset parallelogram on the leading edge of the strip
        platePath(c, gx, gy, gw, gh, SKEW);
        c.fillStyle = 'rgba(0,0,0,0.5)'; c.fill();
        platePath(c, gx, gy, gw, gh, SKEW);
        c.strokeStyle = active ? 'rgba(255,180,60,0.7)' : 'rgba(160,200,225,0.35)';
        c.lineWidth = 1; c.stroke();
        label(c, 'GEAR', gx + gw * 0.5 + gh * SKEW * 0.4, gy + 14, 8.5, 'rgba(166,196,218,0.9)',
          { tracking: 0.2, align: 'center' });
        drawText(c, String(s.gear || 1), {
          x: gx + gw * 0.5 + 2, y: gy + gh - 7, size: 23, weight: 0.22, italic: 0.20, align: 'center',
          color: active ? AMBER : '#dceaf6',
        });

        // heading (display italic) + discrete tanks
        drawText(c, 'NITRO', {
          x: tx, y: hb, size: 15, weight: 0.215, italic: 0.22,
          color: active ? '#ffe9b8' : '#cfe0ef', tracking: 0.10,
          glow: active ? { color: ORANGE, blur: 14 } : null,
        });
        for (let i = 0; i < 3; i++) {
          const py = y + 12, ph = 15;
          const px = tx + 78 + i * 20;
          const has = i < tanks;
          const spend = !has && i === tanks && this.tankFlash > 0.02;
          c.save();
          c.beginPath();
          c.moveTo(px, py + ph); c.lineTo(px + 8, py + ph / 2); c.lineTo(px, py);
          c.lineTo(px + 6, py); c.lineTo(px + 14, py + ph / 2); c.lineTo(px + 6, py + ph);
          c.closePath();
          if (has) {
            c.fillStyle = active ? '#ffd77a' : AMBER;
            c.shadowBlur = 10; c.shadowColor = ORANGE;
          } else {
            c.fillStyle = spend ? `rgba(255,120,40,${this.tankFlash})` : 'rgba(255,255,255,0.14)';
          }
          c.fill();
          c.restore();
        }

        // charge bar channel, and the six empty cells drawn first so you can read how much charge
        // is MISSING. Its right end lands on the same w-PAD margin as the caption above it,
        // measured at its own y so the shear lines up.
        platePath(c, bx, by, bw, bh, SKEW);
        c.fillStyle = 'rgba(0,0,0,0.55)'; c.fill();
        c.save();
        c.strokeStyle = 'rgba(150,190,215,0.16)'; c.lineWidth = 1;
        for (let i = 1; i < 6; i++) {
          const px = bx + (bw / 6) * i;
          c.beginPath();
          c.moveTo(px + bh * SKEW, by + 1); c.lineTo(px, by + bh - 1);
          c.stroke();
        }
        c.restore();
      });

    // The caption pulses while firing (live layer) and is fixed art otherwise (cached patch); either
    // way its drop shadow is a blurred op and stays off the backbuffer.
    const capW = 70, capB = [lx(hb) + w - GR.PAD - capW - 6, hb - 16, capW + 12, 24];
    const paintCap = (c, alpha) => label(c, active ? 'FIRING' : 'CHARGE', lx(hb) + w - GR.PAD, hb, 9,
      active ? `rgba(255,232,178,${alpha})` : 'rgba(160,190,212,0.85)',
      { align: 'right', tracking: 0.24 });
    if (active) {
      const cb = Math.round(pulse * (PULSE_STEPS - 1));
      const ca = 0.6 + 0.4 * (cb / (PULSE_STEPS - 1));
      this._patch(ctx, `nitroCap${cb}`, ...capB, `${hb}|${w}|${lx(hb)}`, (c) => paintCap(c, ca));
    } else {
      this._patch(ctx, 'nitroCap', ...capB, `${hb}|${w}|${lx(hb)}`, (c) => paintCap(c, 1));
    }

    // charge bar — drains while boosting, creeps back afterwards
    const fpx = Math.round((bw - 3) * clamp(this.charge, 0, 1) * this._res);
    const fw = fpx / this._res;
    if (fw > 1.5) {
      // Same device-pixel quantisation as the clock rail: while the bar is draining under boost it
      // still repaints, but every frame it is holding, refilling slowly or sitting full is a blit.
      const BP = 22;
      this._patch(ctx, 'nitroFill', bx - BP, by - BP, bw + bh * SKEW + BP * 2, bh + BP * 2,
        `${fpx}|${active}|${bx}|${by}|${bw}|${bh}`, (c) => {
        c.save();
        platePath(c, bx + 1.5, by + 1.5, bw - 3, bh - 3, SKEW);
        c.clip();
        platePath(c, bx + 1.5, by + 1.5, fw, bh - 3, SKEW);
        const g = c.createLinearGradient(bx, 0, bx + bw, 0);
        g.addColorStop(0, active ? '#fff4cf' : '#2fd0ff');
        g.addColorStop(1, active ? ORANGE : '#0d7fae');
        c.fillStyle = g;
        c.shadowBlur = active ? 16 : 7; c.shadowColor = active ? ORANGE : CYAN;
        c.fill();
        c.restore();
      });
    }
    // notches and bezel are cut over the fill, so they cannot be baked with the channel above
    this._patch(ctx, 'nitroMarks', bx - 5, by - 5, bw + bh * SKEW + 10, bh + 10,
      `${fw > 1.5}|${bx}|${by}|${bw}`, (c) => {
        if (fw > 1.5) {
          // segment notches, cut on the same shear, so the bar reads as hardware
          c.save();
          c.globalAlpha = 0.35;
          c.strokeStyle = 'rgba(0,0,0,0.9)'; c.lineWidth = 1.4;
          for (let i = 1; i < 6; i++) {
            const px = bx + (bw / 6) * i;
            c.beginPath();
            c.moveTo(px + bh * SKEW, by); c.lineTo(px, by + bh);
            c.stroke();
          }
          c.restore();
        }
        platePath(c, bx, by, bw, bh, SKEW);
        c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1; c.stroke();
      });
  }

  _drawDrift(ctx, s, x, yBottom, w, h) {
    const a = this.driftShow;
    if (a < 0.02) return;
    const d = clamp(s.drift || 0, 0, 1);
    const y = yBottom - h;
    const lx = (yy) => x + (h - (yy - y)) * SKEW;
    const ty = (1 - smoothstep(0, 1, a)) * 14;
    ctx.save();
    ctx.globalAlpha = smoothstep(0, 0.5, a);
    ctx.translate(0, ty);

    const b1 = y + 26, b2 = y + 43;
    const bh = 9, by = y + h - 14;
    const bx = lx(by + bh) + RAIL + GR.PAD + 14, bw = w - RAIL - GR.PAD * 2 - 14;
    const P = 30;

    // While the panel is sliding and fading in it cannot be CACHED: compositing a cached layer under
    // a global alpha is GROUP opacity — the whole plate fades as one flat image — whereas the
    // original fades each of its ten overlapping translucent draws individually, and where they
    // overlap the two do not agree. Once the panel has settled at full opacity the two are the same
    // thing again, and that is where it spends nearly all of its time on screen.
    //
    // It can still have a LAYER, though, and it should: this plate is five blurred ops. `_live`
    // carries the ambient opacity INTO the layer and blits at 1, so every draw inside still fades
    // individually — per-element opacity, the same picture — for a twentieth of the blur bill.
    const settled = a > 0.995;
    const via = (id, bx2, by2, bw2, bh2, key, paint) => (settled
      ? this._patch(ctx, id, bx2, by2, bw2, bh2, key, paint, { ty })
      : this._live(ctx, `${id}~`, bx2, by2, bw2, bh2, paint, { ty }));

    // Plate, headings, labels and the empty meter — nothing here reacts to the drift, so it is one
    // patch. The score, the angle and the meter fill are the only things that move.
    via('drift', x - P, y - P, w + h * SKEW + P * 2, h + P * 2, `${x}|${y}|${w}|${h}`, (c) => {
      panel(c, x, y, w, h, {
        fill: ['rgba(48,27,6,0.91)', 'rgba(10,8,6,0.88)'],
        edge: 'rgba(255,190,80,0.45)', accent: AMBER, glow: 13,
      });
      // deck 1 — heading (display italic); the live score lands beside it
      chevrons(c, lx(y + h * 0.5) + RAIL + 6, y + 9, 2, 5, 13, AMBER, 0.5);
      drawText(c, 'DRIFT', {
        x: lx(b1) + RAIL + GR.PAD + 14, y: b1, size: 18, weight: 0.22, italic: 0.24,
        color: '#ffd54a', glow: { color: '#ff8a1e', blur: 16 }, tracking: 0.16,
      });
      // deck 2 — label in the geometric face, on its own row
      label(c, 'ANGLE', lx(b2) + RAIL + GR.PAD + 14, b2, 9, 'rgba(255,214,150,0.85)', { tracking: 0.26 });
      // deck 3 — the meter's empty channel, beneath its label
      platePath(c, bx, by, bw, bh, SKEW);
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.fill();
    });

    // Score, slip angle and meter fill all move every frame and all three glow: one layer each,
    // cut to the type and to the meter channel.
    this._live(ctx, 'driftNum', lx(b1 + 2) + w - GR.PAD - 130, b1 - 30, 150, 54, (c) => {
      drawText(c, String(Math.round(this.driftScore)), {
        x: lx(b1 + 2) + w - GR.PAD, y: b1 + 2, size: 24, weight: 0.215, italic: 0.20, align: 'right',
        color: '#ffffff', sheen: true, glow: { color: '#ff8a1e', blur: 12 },
      });
      // the simulated slip angle when main.js supplies it — never a number derived from the bar
      label(c, `${Math.round(s.slipDeg ?? d * 42)}°`, lx(b2) + w - GR.PAD, b2, 10.5,
        'rgba(255,230,184,0.92)', { align: 'right', tracking: 0.04 });
    }, { ty });

    const FP = 20;
    this._live(ctx, 'driftFill', bx - FP, by - FP, bw + bh * SKEW + FP * 2, bh + FP * 2, (c) => {
      c.save();
      platePath(c, bx + 1, by + 1, bw - 2, bh - 2, SKEW);
      c.clip();
      platePath(c, bx + 1, by + 1, Math.max(2, (bw - 2) * d), bh - 2, SKEW);
      const g = c.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, '#ffd54a'); g.addColorStop(1, '#ff5a1e');
      c.fillStyle = g; c.shadowBlur = 12; c.shadowColor = '#ff8a1e';
      c.fill();
      c.restore();
    }, { ty });
    // quarter marks and the bezel go OVER the fill, so they cannot join the patch above
    via('driftMarks', bx - 4, by - 4, bw + bh * SKEW + 8, bh + 8, `${bx}|${by}|${bw}`, (c) => {
      c.save();
      c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1.2;
      for (let i = 1; i < 4; i++) {
        const px = bx + (bw / 4) * i;
        c.beginPath();
        c.moveTo(px + bh * SKEW, by); c.lineTo(px, by + bh);
        c.stroke();
      }
      c.restore();
      platePath(c, bx, by, bw, bh, SKEW);
      c.strokeStyle = 'rgba(255,220,160,0.38)'; c.lineWidth = 1; c.stroke();
    });
    ctx.restore();
  }

  /**
   * Centre-screen shout — ONE slot, so two events can never stack into overlapping banners. The
   * headline is the largest type in the frame, so it is the element most exposed on both counts
   * the rubric cares about: edge quality (it rides the supersampled backbuffer like everything
   * else) and legibility over a blown-out sky — hence a hot white core with the message colour
   * carried in the halo and rails, never orange ink on an orange sky.
   */
  _drawMessages(ctx, cx, cy, fade = 1) {
    const m = this.msg;
    if (!m || fade <= 0.004) return;
    const t = m.t / m.dur;
    const a = smoothstep(0, 0.12, t) * (1 - smoothstep(0.68, 1, t)) * fade;
    const sc = 1 + (1 - smoothstep(0, 0.25, t)) * 0.28;
    const size = 48;
    const wpx = shoutWidth(m.text, size, 0.10);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);

    // banner: a solid dark core with feathered ends, so the shout never dissolves into the scene
    ctx.globalAlpha = a;
    const bw = wpx + 130, bh = size * 1.42;
    platePath(ctx, -bw / 2, -bh * 0.78, bw, bh);
    const bg = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
    bg.addColorStop(0, 'rgba(4,6,11,0)');
    bg.addColorStop(0.16, 'rgba(4,6,11,0.72)');
    bg.addColorStop(0.34, 'rgba(4,6,11,0.90)');
    bg.addColorStop(0.66, 'rgba(4,6,11,0.90)');
    bg.addColorStop(0.84, 'rgba(4,6,11,0.72)');
    bg.addColorStop(1, 'rgba(4,6,11,0)');
    ctx.fillStyle = bg; ctx.fill();

    // accent rails top and bottom, fading out with the plate
    const rail = (yy) => {
      const rg = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      rg.addColorStop(0, 'rgba(0,0,0,0)');
      rg.addColorStop(0.28, m.color);
      rg.addColorStop(0.72, m.color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(-bw / 2 + (yy < 0 ? bh * SKEW : 0), yy);
      ctx.lineTo(bw / 2 + (yy < 0 ? bh * SKEW : 0), yy);
      ctx.strokeStyle = rg; ctx.lineWidth = 2.6; ctx.stroke();
    };
    ctx.globalAlpha = a * 0.85;
    rail(-bh * 0.78); rail(bh * 0.22);
    chevrons(ctx, -wpx / 2 - 52, -size * 0.62, 3, 7, 18, m.color, a * 0.8);
    chevrons(ctx, wpx / 2 + 24, -size * 0.62, 3, 7, 18, m.color, a * 0.8);
    ctx.globalAlpha = 1;

    // The headline is the one blurred op in this cluster (a 34 px halo), and the shout is on screen
    // for four seconds at a time, so it is a per-frame op that matters. It goes in a layer of its
    // own. The entrance scale lives INSIDE the layer, whose box is cut for the largest scale the
    // pop ever reaches, so the canvas is allocated once and only its blit position moves.
    ctx.restore();
    const SCM = 1.28, PM = 34;
    this._live(ctx, 'shout',
      -(wpx * SCM) / 2 - PM, -size * SCM * 1.15 - PM, wpx * SCM + PM * 2, size * SCM * 1.7 + PM * 2,
      (c) => {
        c.scale(sc, sc);
        // left-anchored at -w/2 rather than align:'center', because the bang is a second run and
        // the pair has to be centred as ONE word (see `shout`)
        shout(c, m.text, {
          x: -wpx / 2, y: 0, size, weight: 0.225, italic: 0.24, alpha: a,
          color: gradientFill([[0, '#ffffff'], [0.46, '#fff4dd'], [0.56, '#ffd79a'], [1, '#ffffff']]),
          glow: { color: m.color, blur: 34 },
          outline: { color: 'rgba(0,0,0,0.6)', width: 3.2 },
          tracking: 0.10, bevel: true, sheen: true,
        });
      }, { ox: cx, oy: cy });
  }

  // ---------------------------------------------------------------- the results screen
  //
  // A race used to end in a centre-screen banner and an "ENTER · GARAGE" prompt — the coherence
  // critic's charge, and fair: a product whose race has no result is not one product. This is the
  // screen that ends it, and it is deliberately built out of the GARAGE's parts, because the garage
  // is the strongest UI in the game and these two screens bracket every race anyone will ever run:
  //
  //   · the same chamfered leaning plate (ui/menu.js `plate()`, PANEL_CUT = 26, ~34 px of lean),
  //   · the same gold, the same 3 px leading rail on every plate,
  //   · the same black bottom bar — hazard chevrons along its foot, an orange→cyan hairline along
  //     its top, control glyphs at the left end and the car's full name at the right end in beveled
  //     metallic italic. That last one is the garage's signature move and does most of the work of
  //     making the two screens read as one piece of software,
  //   · headings in the display italic, every list in the geometric face (§2.6).
  //
  // …and, from round 2, a THIRD COLUMN THAT HOLDS NOTHING. The right third of the band is a stage:
  // the scrim is cut away over it and main.js drives the hero car into the hole under a key and a
  // rim (`_finishCamera`, `_heroLight`). The panel and the camera solve the same layout — see
  // `resultsLayout` — so the car lands where the type was laid out around it.
  //
  // COST. Six cached patches, four unblurred gradient fills and one erase a frame, plus the
  // finishing time. The entrance is a per-cluster slide and fade applied at BLIT time (`_patch`'s
  // tx / alpha), never a repaint, so the panel costs the same on its first frame as on its
  // thousandth — see the note above `_patch` for why that matters here. The clock is drawn live
  // because `_seg` blits its own sprites under the identity transform and cannot go inside a patch.

  _drawResults(ctx, snap, VW, VH) {
    const T = clamp(this.resultsT, 0, 1);
    const L = resultsLayout(VW, VH);
    const { M, BAR, CUT, RS, barY, yT, panelH, leftW, midX: rightX, midW: rightW,
      cardAH, cardBY, cardBH, stageX, stageW } = L;

    // THE SCREEN AGREES WITH ITSELF BEFORE IT DRAWS ANYTHING. See `resultsView`.
    const r = HUD.resultsView(snap);
    const rows = r.rows || [];
    const laps = r.laps || [];
    const win = r.pos === 1 && !r.dnf;
    const podium = r.pos <= 3 && !r.dnf;
    const accent = r.dnf ? RED : win ? GOLD : podium ? AMBER : CYAN;
    const sig = [
      VW, VH, r.pos, r.dnf ? 1 : 0, r.time, r.best, r.record, r.recordBeaten ? 1 : 0,
      r.recordBy || '', r.recordTime ?? '',
      r.cityName, r.carName, r.carColor || '', r.carClass || '', r.lapCount,
      laps.map((x) => x.toFixed(2)).join(),
      rows.map((x) => `${x.pos}${x.name}${x.carName}${x.finished ? 1 : 0}${x.dnf ? 1 : 0}`
        + `${x.gap == null ? '' : x.gap.toFixed(2)}${Math.round(x.gapM)}`).join('|'),
    ].join('~');

    // per-cluster entrance. `slide` is the blit offset; `a` the blit alpha.
    const ease = (delay) => smoothstep(0, 1, clamp((T - delay) / 0.40, 0, 1));
    const io = ease(0);

    // ---- ground. Four unblurred fills and one erase. The cool-down lap is still running behind
    // this and is meant to stay faintly visible — an arcade results screen sits ON the race, not
    // instead of it.
    ctx.save();
    ctx.globalAlpha = io;
    const vg = ctx.createRadialGradient(VW * 0.42, VH * 0.46, VH * 0.24, VW * 0.42, VH * 0.5, VH * 1.15);
    vg.addColorStop(0, 'rgba(3,6,12,0.62)');
    vg.addColorStop(0.55, 'rgba(3,6,12,0.84)');
    vg.addColorStop(1, 'rgba(1,3,7,0.97)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, VW, VH);
    const tg = ctx.createLinearGradient(0, 0, 0, 300);
    tg.addColorStop(0, 'rgba(2,5,10,0.92)'); tg.addColorStop(1, 'rgba(2,5,10,0)');
    ctx.fillStyle = tg; ctx.fillRect(0, 0, VW, 300);
    const bgg = ctx.createLinearGradient(0, barY - 200, 0, VH);
    bgg.addColorStop(0, 'rgba(2,4,9,0)'); bgg.addColorStop(0.62, 'rgba(2,4,9,0.72)');
    bgg.addColorStop(1, 'rgba(1,2,6,0.98)');
    ctx.fillStyle = bgg; ctx.fillRect(0, barY - 200, VW, VH - barY + 200);

    /**
     * ---- THE STAGE, WHICH IS A SET AND NOT A HOLE.
     *
     * Round 1 cut one soft round hole in the scrim over the right third and let the race show
     * through it. The critic measured what that produces: "it is the live race camera pointed at
     * wherever the car stopped … no key, no rim, NO BACKDROP, the car in the top third of its
     * bracket with blown-out empty road filling the rest", and named the fix — "push the race scene
     * behind it to a darkened, blurred backdrop instead of letting the chase camera and the ground
     * bloom decide the composition".
     *
     * A 2D overlay cannot blur what is behind it and cannot paint behind the car. What it CAN do is
     * build the room first and then cut the subject out of it: paint a back wall, a floor and the
     * seam between them across the whole third, then erase a tight ellipse around the car. What is
     * left around the subject is a set this file drew — §1.4's garage, dark, with one cool bloom on
     * the wall behind the roofline — instead of Miami's neon skyline growing out of the roof. The
     * hole is sized off `carW`, the same number `resultsStageNDC()` hands the camera solve, so it
     * hugs the car at whatever scale the layout asked for.
     */
    const CW = L.carW;
    const setX = stageX - stageW * 0.36;
    const seam = L.carY + CW * 0.150;                   // where the wall meets the floor
    // The set is the same picture on every frame of the screen — it is built out of the layout and
    // nothing else — so it is baked once and blitted, which is also what makes its LEFT edge
    // affordable: feathering it needs a `destination-out` pass, and that can only run inside a
    // layer of its own. Straight onto the frame it would eat the scrim underneath and leave the
    // city brighter along the seam than it is anywhere else.
    this._patch(ctx, 'resSet', setX, 0, VW - setX, VH, `${VW}|${VH}|${CW}|set`, (c) => {
      // the wall — near-black overhead, lifting a little toward the seam so the plane is readable
      const wall = c.createLinearGradient(0, 0, 0, seam);
      wall.addColorStop(0, 'rgba(2,5,11,0.84)');
      wall.addColorStop(0.62, 'rgba(5,12,21,0.68)');
      wall.addColorStop(1, 'rgba(14,29,44,0.42)');
      c.fillStyle = wall; c.fillRect(setX, 0, VW - setX, seam);
      // the floor — darker again and warm rather than cool, so the two planes are not one wash
      const flr = c.createLinearGradient(0, seam, 0, VH);
      flr.addColorStop(0, 'rgba(16,12,12,0.48)');
      flr.addColorStop(0.55, 'rgba(6,6,10,0.82)');
      flr.addColorStop(1, 'rgba(1,2,6,0.96)');
      c.fillStyle = flr; c.fillRect(setX, seam, VW - setX, VH - seam);
      // the backdrop lamp: a wide cool bloom on the wall behind the roofline. This is the light
      // that separates a car from a black rectangle, and §1.4 has it — "a cool rim from behind
      // that separates it from the wall".
      c.save();
      c.translate(L.carX, L.carY - CW * 0.055);
      c.scale(1, 0.46);
      const back = c.createRadialGradient(0, 0, CW * 0.05, 0, 0, CW * 0.92);
      back.addColorStop(0, 'rgba(104,176,220,0.26)');
      back.addColorStop(0.46, 'rgba(74,132,182,0.11)');
      back.addColorStop(1, 'rgba(58,106,156,0)');
      c.fillStyle = back; c.fillRect(-CW, -CW, CW * 2, CW * 2);
      c.restore();
      // the seam itself, brightest behind the car and gone at both ends
      const sg = c.createLinearGradient(setX, 0, VW, 0);
      sg.addColorStop(0, 'rgba(126,190,226,0)');
      sg.addColorStop(0.46, 'rgba(126,190,226,0.26)');
      sg.addColorStop(1, 'rgba(126,190,226,0.03)');
      c.fillStyle = sg; c.fillRect(setX, seam - 0.8, VW - setX, 1.6);
      // …and the left edge feathered away into the frame's own scrim. Without this the set ends on
      // a ruled vertical line down the middle of the screen — one plate edge that belongs to no
      // plate, which at 1:1 reads as a rendering fault rather than as a room.
      const fade = c.createLinearGradient(setX, 0, setX + stageW * 0.52, 0);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(0.45, 'rgba(0,0,0,0.55)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = fade; c.fillRect(setX, 0, stageW * 0.52, VH);
      c.globalCompositeOperation = 'source-over';
      // (no `alpha` option: the block's ambient `io` is already on the blit, and passing it again
      //  would square it and make the set lag the rest of the entrance)
    });

    // …and the subject, erased out of it. `destination-out` is the only way to get a SOFT hole:
    // clipping to a rectangle leaves a hard edge, and painting light back over the scrim only greys
    // it. An ELLIPSE, not a circle — a car is three times as wide as it is tall at this azimuth,
    // and a round hole big enough to clear the roof clears half the skyline with it, which is
    // exactly how the neon got back in. The centre is not fully cleared (0.94) so the set still
    // lies faintly over the road under the car.
    const HX = CW * 0.605, HY = CW * 0.215;
    ctx.save();
    ctx.translate(L.carX, L.carY + CW * 0.010);
    ctx.scale(1, HY / HX);
    const hole = ctx.createRadialGradient(0, 0, HX * 0.30, 0, 0, HX);
    hole.addColorStop(0, 'rgba(0,0,0,0.94)');
    hole.addColorStop(0.50, 'rgba(0,0,0,0.86)');
    hole.addColorStop(0.80, 'rgba(0,0,0,0.36)');
    hole.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = hole; ctx.fillRect(-HX, -HX, HX * 2, HX * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // …and the wall put back ABOVE the roofline. An ellipse tight enough on the roof to keep a
    // shopfront out of the greenhouse is tight enough to veil the roof itself, so the hole is cut
    // generously and the top of it is painted back as a second soft ellipse rather than clipped —
    // no edge anywhere, and the bright horizontal band Miami's lit facade was throwing across the
    // car's window line is gone. (Measured on miami-muscle-results.png: the band sat at the belt
    // line and was the brightest thing in the third.)
    ctx.save();
    ctx.translate(L.carX, L.carY - CW * 0.360);
    ctx.scale(1, 0.275);
    const cap = ctx.createRadialGradient(0, 0, CW * 0.06, 0, 0, CW * 0.80);
    cap.addColorStop(0, 'rgba(3,7,14,0.80)');
    cap.addColorStop(0.55, 'rgba(3,7,14,0.46)');
    cap.addColorStop(1, 'rgba(3,7,14,0)');
    ctx.fillStyle = cap; ctx.fillRect(-CW, -CW, CW * 2, CW * 2);
    ctx.restore();

    // …and a warm floor pool under it, the garage's turntable light. Drawn ON the frame rather than
    // into it, so it reads as light in the room rather than as a decal on the road. It sits on the
    // seam, so the car stands where the two planes of the set meet instead of hovering over one.
    const fy = seam + CW * 0.045;
    ctx.save();
    ctx.translate(L.carX, fy);
    ctx.scale(1, 0.26);                                   // a pool on the ground, not a halo
    const floor = ctx.createRadialGradient(0, 0, CW * 0.05, 0, 0, CW * 0.72);
    floor.addColorStop(0, 'rgba(255,198,116,0.24)');
    floor.addColorStop(0.40, 'rgba(255,172,84,0.10)');
    floor.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = floor; ctx.fillRect(-CW, -CW, CW * 2, CW * 2);
    ctx.restore();
    ctx.restore();

    // ---- header + headline ------------------------------------------------------------------
    // NOTE the full-width patches are bounded at exactly 0..VW, not padded outward. `_patch` bakes
    // at `res` device pixels per design unit and `res * VW` is `W * scale`, which resize() already
    // holds at or under SS_MAX_EDGE — pad it and the cache canvas crosses 4096 px and falls off the
    // accelerated path. Nothing on this screen draws outside the frame anyway.
    const P = 44;
    this._patch(ctx, 'resHead', 0, -P, VW, 260 + P, `${sig}|head`,
      (c) => this._resHead(c, r, VW, M, accent, win, podium),
      { tx: (1 - ease(0)) * -46, alpha: ease(0) });

    // ---- the stage's furniture: the rail that says this third belongs to the panel ------------
    this._patch(ctx, 'resStage', stageX - P, yT - P, stageW + panelH * RS + P * 2, panelH + P * 2,
      `${sig}|stg`, (c) => this._resStage(c, r, stageX, yT, stageW, panelH, RS, accent),
      { tx: (1 - ease(0.16)) * 70, alpha: ease(0.16) });

    // ---- classification --------------------------------------------------------------------
    this._patch(ctx, 'resTable', M - P, yT - P, leftW + panelH * RS + P * 2, panelH + P * 2, `${sig}|tbl`,
      (c) => this._resTable(c, r, M, yT, leftW, panelH, RS, CUT),
      { tx: (1 - ease(0.10)) * -60, alpha: ease(0.10) });

    // ---- the player's own race --------------------------------------------------------------
    this._patch(ctx, 'resCardA', rightX - P, yT - P, rightW + cardAH * RS + P * 2, cardAH + P * 2, `${sig}|ca`,
      (c) => this._resCardA(c, r, rightX, yT, rightW, cardAH, RS, CUT, accent),
      { tx: (1 - ease(0.20)) * 60, alpha: ease(0.20) });
    // …and its clock, which cannot live in a patch (see the note above).
    {
      const eA = ease(0.20);
      const lx = (ry) => rightX + RS * cardAH * (1 - clamp((ry - yT) / cardAH, 0, 1));
      const cy = yT + 108;
      ctx.save();
      ctx.globalAlpha = eA;
      this._seg(ctx, r.time != null ? fmtTime(r.time) : '--:--:--', {
        x: lx(cy) + rightW - 26 + (1 - eA) * 60, y: cy, size: 40, align: 'right',
        color: r.dnf ? 'rgba(255,110,96,1)' : r.recordBeaten ? '#8ef58a' : CYAN,
        glow: 14, italic: 0.12, dim: 0.10,
        dimColor: r.dnf ? 'rgba(120,40,34,1)' : r.recordBeaten ? 'rgba(50,110,50,1)' : 'rgba(90,150,175,1)',
      });
      ctx.restore();
    }

    // ---- lap book ---------------------------------------------------------------------------
    this._patch(ctx, 'resCardB', rightX - P, cardBY - P, rightW + cardBH * RS + P * 2, cardBH + P * 2, `${sig}|cb`,
      (c) => this._resCardB(c, r, rightX, cardBY, rightW, cardBH, RS, CUT),
      { tx: (1 - ease(0.28)) * 60, alpha: ease(0.28) });

    // ---- bottom bar -------------------------------------------------------------------------
    this._patch(ctx, 'resBar', 0, barY - P, VW, BAR + P, `${sig}|bar`,
      (c) => this._resBar(c, r, VW, VH, barY, BAR, M),
      { ty: (1 - ease(0.34)) * 40, alpha: ease(0.34) });
  }

  /** Top bar and the headline: the ordinal is the biggest thing on the screen, as it should be. */
  _resHead(ctx, r, VW, M, accent, win, podium) {
    const y = 26;
    // P1 badge + wordmark, exactly as the garage sets them
    platePath(ctx, M, y, 60, 40);
    const bg = ctx.createLinearGradient(M, 0, M + 60, 0);
    bg.addColorStop(0, '#ffd968'); bg.addColorStop(1, '#f09a12');
    ctx.fillStyle = bg; ctx.fill();
    platePath(ctx, M, y, 60, 40);
    ctx.strokeStyle = 'rgba(255,240,200,0.85)'; ctx.lineWidth = 1.6; ctx.stroke();
    drawText(ctx, 'P1', {
      x: M + 33, y: y + 30, size: 25, weight: 0.22, italic: 0.22, align: 'center', color: '#1b1204',
    });
    drawText(ctx, 'NITRO', {
      x: M + 78, y: y + 31, size: 30, weight: 0.21, italic: 0.24, tracking: 0.10,
      color: gradientFill([[0, '#ffffff'], [0.55, '#ffd9a2'], [1, ORANGE]]),
      bevel: true, glow: { color: ORANGE, blur: 16 },
    });
    const nw = measure('NITRO', { size: 30, tracking: 0.10 }).width;
    rtext(ctx, 'CIRCUIT', {
      x: M + 84 + nw, y: y + 31, size: 22, weight: 0.14, tracking: 0.30, color: CYAN, face: 'geo',
    });
    rtext(ctx, 'RESULT', {
      x: VW - M, y: y + 22, size: 19, weight: 0.16, tracking: 0.26, align: 'right',
      color: LABEL, face: 'geo',
    });
    rtext(ctx, String(r.cityName || '').toUpperCase(), {
      x: VW - M, y: y + 44, size: 16, weight: 0.15, tracking: 0.18, align: 'right',
      color: CYAN, face: 'geo',
    });
    ctx.strokeStyle = 'rgba(150,190,220,0.22)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(M, y + 54); ctx.lineTo(VW - M, y + 54); ctx.stroke();

    // ---- the headline. Ordinal in chrome, status word beside it, datum line under that.
    const ord = r.dnf ? 'DNF' : ordinal(r.pos).toUpperCase();
    const num = r.dnf ? ord : ord.slice(0, -2), suf = r.dnf ? '' : ord.slice(-2);
    const NS = 104;
    const bx = M + 6, by = 224;
    drawText(ctx, num, {
      x: bx, y: by, size: NS, weight: 0.215, italic: 0.24,
      color: gradientFill([[0, '#ffffff'], [0.46, '#f2f7fc'], [0.56, '#93a7bd'], [1, '#f6fafd']]),
      bevel: true, sheen: true, glow: { color: accent, blur: 34 },
      shadow: { color: 'rgba(0,0,0,0.8)', dy: 5, blur: 8 },
    });
    let hx = bx + measure(num, { size: NS }).width;
    if (suf) {
      const SUF = 44, RAISE = 44, gap = ordinalGap(NS, SUF, RAISE);
      drawText(ctx, suf, {
        x: hx + gap, y: by - RAISE, size: SUF, weight: 0.21, italic: 0.24, color: accent,
        glow: { color: accent, blur: 14 },
      });
      hx += gap + measure(suf, { size: SUF }).width;
    }
    chevrons(ctx, hx + 26, by - 96, 3, 8, 22, accent, 0.75);
    const status = r.dnf ? 'DID NOT FINISH' : win ? 'RACE WINNER' : podium ? 'PODIUM FINISH' : 'CLASSIFIED';
    drawText(ctx, status, {
      x: hx + 74, y: by - 46, size: 40, weight: 0.215, italic: 0.23, tracking: 0.10,
      color: gradientFill([[0, '#ffffff'], [0.5, '#fff0d2'], [1, accent]]),
      bevel: true, glow: { color: accent, blur: 20 },
    });
    // `lapsRun` is laps COMPLETED; the lap deck the player was staring at a second ago counts the
    // lap they are ON (`LAP 2/3` with one lap in the book). Retiring must not renumber the race
    // under them, so the datum names the same lap the deck did.
    const onLap = clamp((r.lapsRun ?? 0) + 1, 1, r.lapCount || 3);
    const datum = `OF ${r.total || 8}  /  ${String(r.cityName || '').toUpperCase()}  /  `
      + `${r.dnf ? `LAP ${onLap} OF ${r.lapCount}` : `${r.lapCount} LAPS`}`;
    rtext(ctx, datum, {
      x: hx + 78, y: by - 8, size: 15, weight: 0.15, tracking: 0.24, color: LABEL, face: 'geo',
    });
    // ---- the record badge.
    //
    // ONE BADGE, ONE OWNER. Round 7 drew this off `recordBeaten` alone, which main.js took straight
    // from the director's "your time beat the target" test — so miami-muscle-results.png carried
    // "8TH CLASSIFIED / OF 8", a +04.25 gap to the leader, and NEW COURSE RECORD, all at once. The
    // classification now decides who owns the course record (main.js `_classification`), and this
    // draws whatever it says: green and unqualified when the record is the player's, steel and
    // NAMED when somebody else took it today. There is no path through here that can claim a
    // record for a player the table shows in eighth.
    // The unqualified form is reserved for the case where the whole screen already agrees it is
    // yours — first, classified, holding the fastest time (main.js sets `recordBeaten` on exactly
    // that). Every other shape of result falls through to the NAMED form, which states the holder
    // and their time and therefore cannot contradict the ordinal beside it.
    const mine = !!r.recordBeaten;
    const badge = mine ? 'NEW COURSE RECORD'
      : r.recordBy ? `NEW COURSE RECORD  ${String(r.recordBy).toUpperCase()}  ${fmtTime(r.recordTime)}`
        : null;
    if (badge) {
      const rw = rmeasure(badge, { size: 15, tracking: 0.24, face: 'geo' }).width + 34;
      platePath(ctx, VW - 64 - rw, by - 44, rw, 30);
      ctx.fillStyle = mine ? 'rgba(46,120,52,0.85)' : 'rgba(16,30,44,0.90)'; ctx.fill();
      railOn(ctx, VW - 64 - rw, by - 44, 30, mine ? GREEN : CYAN, 14);
      rtext(ctx, badge, {
        x: VW - 64 - rw + 24, y: by - 23, size: 15, weight: 0.17, tracking: 0.24,
        color: mine ? '#eaffe9' : '#d6e8f6', face: 'geo',
      });
    }
  }

  /**
   * The stage's furniture. Everything here is drawn AROUND the car, never over it: the leading rail
   * that says this third is part of the panel, a caption, the driver's own colour swatch, and a
   * pair of corner brackets cut off the same chamfer as every other plate on the screen. The car
   * itself is the 3D one, driven into the hole cut in the scrim above.
   */
  _resStage(ctx, r, x, y, w, h, S, accent) {
    const lx = (ry) => x + S * h * (1 - clamp((ry - y) / h, 0, 1));
    // the rail dies away before it reaches the car's height — a full-height bar down the leading
    // edge reads as a line ruled ACROSS the car rather than as the edge of a plate
    railOn(ctx, x, y, h, [[0, GOLD], [0.30, 'rgba(255,194,58,0.30)'], [0.62, 'rgba(255,194,58,0)']],
      10, S, 4);
    // caption, at the head of the rail
    rtext(ctx, 'YOUR MACHINE', {
      x: lx(y + 26) + 24, y: y + 26, size: 13, weight: 0.16, tracking: 0.30,
      color: 'rgba(160,186,208,0.92)', face: 'geo',
    });
    chevrons(ctx, lx(y + 26) + 24, y + 34, 3, 7, 15, accent, 0.55);
    // corner brackets — the chamfer of `cutPath`, drawn as two open corners instead of a box, so
    // the stage is framed without a plate edge cutting across the car's roofline
    const CUTL = 26;
    ctx.strokeStyle = 'rgba(150,190,220,0.34)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x + S * h + 96, y); ctx.lineTo(x + w + S * h, y);
    ctx.lineTo(x + w + S * h, y + 74);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + h - 74); ctx.lineTo(x, y + h);
    ctx.lineTo(x + w - CUTL - 96, y + h);
    ctx.stroke();
    // the foot of the stage: a hairline the car stands on, fading out under it
    const fg = ctx.createLinearGradient(x, 0, x + w, 0);
    fg.addColorStop(0, 'rgba(255,194,58,0.55)');
    fg.addColorStop(0.62, 'rgba(255,194,58,0.16)');
    fg.addColorStop(1, 'rgba(255,194,58,0)');
    ctx.strokeStyle = fg; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + h - 1); ctx.lineTo(x + w - CUTL - 90, y + h - 1);
    ctx.stroke();
    this._resSpec(ctx, r, x, y, w, h, S);
  }

  /**
   * THE MACHINE BLOCK, in the bottom of the stage.
   *
   * The critic on the round-1 stage: "the car in the top third of its bracket with blown-out empty
   * road filling the rest". Half of that is the framing (main.js `_finishCamera`, fixed) and half
   * of it is that the bracket is 524 px tall and a car photographed at three-quarter front is 115
   * of them — so under a properly staged portrait there is still an empty half-panel.
   *
   * It gets the garage's own furniture, because that is what this screen is made of everywhere
   * else: the paint chip the player chose, the class, and the three gradient stat bars §1.4
   * describes (`SPEED` red-pink, `TRACTION` magenta-purple, `ACCELERATION` blue-cyan — the same
   * three keys and the same two-stop ramps `ui/menu.js` draws them with). Nothing here is a number
   * the race produced, so nothing here can contradict the race: it is the object, not the result.
   */
  _resSpec(ctx, r, x, y, w, h, S) {
    const st = r.carStats;
    if (!st) return;
    const lx = (ry) => x + S * h * (1 - clamp((ry - y) / h, 0, 1));
    const BARS = [
      ['SPEED', st.speed, '#ff2f6d', '#ff9fc0'],
      ['TRACTION', st.traction, '#c33cff', '#f0aaff'],
      ['ACCELERATION', st.accel, '#2fa8ff', '#a6e6ff'],
    ];
    const pitch = 34, barH = 8;
    const top = y + h - 24 - BARS.length * pitch;

    // the head: a paint chip in the car's own colour, then the class, cut off the same chamfer as
    // every other plate on the screen. 34 px above the first bar, not 20: the rule under it was
    // being ruled straight through the word SPEED.
    const hy = top - 34;
    const cx0 = lx(hy) + 26;
    platePath(ctx, cx0, hy - 16, 22, 18, 0.16);
    ctx.fillStyle = r.carColor || '#8fa3ba'; ctx.fill();
    platePath(ctx, cx0, hy - 16, 22, 18, 0.16);
    ctx.strokeStyle = 'rgba(236,246,255,0.7)'; ctx.lineWidth = 1.2; ctx.stroke();
    rtext(ctx, String(r.carClass || 'MACHINE'), {
      x: cx0 + 34, y: hy - 2, size: 13, weight: 0.16, tracking: 0.28,
      color: 'rgba(196,216,234,0.95)', face: 'geo',
    });
    rtext(ctx, 'SPEC', {
      x: lx(hy) + w - 26, y: hy - 2, size: 11, weight: 0.15, tracking: 0.30, align: 'right',
      color: 'rgba(146,172,196,0.8)', face: 'geo',
    });
    ctx.beginPath();
    ctx.moveTo(lx(hy + 10) + 20, hy + 10); ctx.lineTo(lx(hy + 10) + w - 20, hy + 10);
    ctx.strokeStyle = 'rgba(150,190,220,0.22)'; ctx.lineWidth = 1.1; ctx.stroke();

    for (let i = 0; i < BARS.length; i++) {
      const [name, v, c0, c1] = BARS[i];
      const by = top + i * pitch;
      const bx = lx(by + barH) + 26;
      const bw = w - 52;
      // …with the label clear of its own bar. At `by - 5` a 10.5 px face and an 11.5 px numeral
      // both sat ON the trough, and the numeral's descenderless box crossed the fill.
      rtext(ctx, name, {
        x: bx, y: by - 9, size: 10.5, weight: 0.15, tracking: 0.28,
        color: 'rgba(160,186,208,0.9)', face: 'geo',
      });
      rtext(ctx, String(Math.round(clamp(v ?? 0, 0, 1) * 100)), {
        x: bx + bw, y: by - 9, size: 12, weight: 0.17, tracking: 0.10, align: 'right',
        color: 'rgba(214,232,246,0.95)', face: 'geo',
      });
      // the trough…
      platePath(ctx, bx, by, bw, barH, 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fill();
      platePath(ctx, bx, by, bw, barH, 0.5);
      ctx.strokeStyle = 'rgba(150,190,220,0.20)'; ctx.lineWidth = 1; ctx.stroke();
      // …and the fill, on the same two-stop ramp the garage uses
      const fw = Math.max(4, bw * clamp(v ?? 0, 0, 1));
      platePath(ctx, bx, by, fw, barH, 0.5);
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, c0); g.addColorStop(1, c1);
      ctx.fillStyle = g;
      ctx.shadowBlur = 8; ctx.shadowColor = c0;
      ctx.fill(); ctx.shadowBlur = 0;
    }
  }

  /** The classification — eight rows, the order the race director froze at the flag. */
  _resTable(ctx, r, x, y, w, h, S, CUT) {
    const lx = (ry) => x + S * h * (1 - clamp((ry - y) / h, 0, 1));
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.fillStyle = 'rgba(4,8,13,0.93)'; ctx.fill();
    ctx.save();
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.shadowBlur = 22; ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.strokeStyle = 'rgba(140,172,200,0.42)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    railOn(ctx, x, y, h, GOLD, 10, S, 4);

    const head = 62;
    drawText(ctx, 'FINAL STANDINGS', {
      x: lx(y + 33) + 24, y: y + 33, size: 21, weight: 0.215, italic: 0.22, tracking: 0.12,
      color: '#f2f7fc', glow: { color: 'rgba(255,194,58,0.5)', blur: 12 },
    });
    // Absolute, not fractional. The position numeral is right-aligned at a fixed 52 px, so a
    // fractional name column collapses onto it the moment the table narrows — which is exactly
    // what happened when the stage took the panel's right third: the r2 layout put `w · 0.100` at
    // 58 px and the classification read "1YOU", "2LETTY".
    const cols = { name: 74, car: Math.max(w * 0.44, 200), time: w - 16 };
    const hy = y + head - 9;
    rtext(ctx, 'DRIVER', {
      x: lx(hy) + cols.name, y: hy, size: 11, weight: 0.15, tracking: 0.30,
      color: 'rgba(146,172,196,0.85)', face: 'geo',
    });
    rtext(ctx, 'MACHINE', {
      x: lx(hy) + cols.car, y: hy, size: 11, weight: 0.15, tracking: 0.30,
      color: 'rgba(146,172,196,0.85)', face: 'geo',
    });
    rtext(ctx, 'TIME', {
      x: lx(hy) + cols.time - 22, y: hy, size: 11, weight: 0.15,
      tracking: 0.30, align: 'right', color: 'rgba(146,172,196,0.85)', face: 'geo',
    });
    ctx.beginPath();
    ctx.moveTo(lx(y + head) + 18, y + head); ctx.lineTo(lx(y + head) + w - 18, y + head);
    ctx.strokeStyle = 'rgba(150,190,220,0.26)'; ctx.lineWidth = 1.1; ctx.stroke();

    const rows = r.rows || [];
    const n = Math.max(1, rows.length);
    const pitch = (h - head - 20) / n;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ry = y + head + 8 + i * pitch;
      const rh = pitch - 5;
      const rl = lx(ry + rh);
      const you = row.you;
      // a retired car carries no position (main.js `_classification` nulls it), so it gets no
      // podium rail and no numeral either — see below
      const pod = (row.pos != null && row.pos <= 3) ? PODIUM[row.pos - 1] : null;

      if (you) {
        // the player's row, in the garage's gold — the one bar of colour on the panel
        platePath(ctx, rl + 12, ry, w - 26, rh, SKEW);
        const g = ctx.createLinearGradient(rl, 0, rl + w, 0);
        g.addColorStop(0, 'rgba(255,196,66,0.96)');
        g.addColorStop(0.52, 'rgba(255,158,26,0.72)');
        g.addColorStop(1, 'rgba(255,146,20,0.08)');
        ctx.fillStyle = g;
        ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(255,150,24,0.65)';
        ctx.fill(); ctx.shadowBlur = 0;
      } else if (i % 2 === 1) {
        platePath(ctx, rl + 12, ry, w - 26, rh, SKEW);
        ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fill();
      }
      if (pod && !you) railOn(ctx, rl + 12, ry, rh, pod, 8, SKEW, 3);

      const base = ry + rh - Math.round(rh * 0.33);
      const bl = lx(base);
      // position numeral in the display face — a rank is a number, and it is set as one
      drawText(ctx, row.pos == null ? '--' : String(row.pos), {
        x: bl + 52, y: base, size: 25, weight: 0.215, italic: 0.22, align: 'right',
        color: you ? '#2a1701' : pod ? pod : 'rgba(176,199,220,0.95)',
        glow: pod && !you ? { color: pod, blur: 10 } : null,
      });
      rtext(ctx, row.name, {
        x: bl + cols.name, y: base, size: 20, weight: you ? 0.18 : 0.155, tracking: 0.14,
        color: you ? '#180d01' : '#e2ecf6', face: 'geo',
      });
      rtext(ctx, row.carName || '--', {
        x: bl + cols.car, y: base, size: 13, weight: 0.145, tracking: 0.22,
        color: you ? 'rgba(38,22,2,0.86)' : 'rgba(150,176,200,0.85)', face: 'geo',
      });
      const tval = resultTime(row);
      drawText(ctx, tval, {
        x: bl + cols.time - 22, y: base, size: 19, weight: 0.19, italic: 0.18, align: 'right',
        color: row.dnf ? 'rgba(255,110,96,0.95)' : you ? '#180d01' : row.pos === 1 ? GOLD_HOT : '#cfdeec',
      });
    }
  }

  /** Card one: the player's finishing time against the course record. */
  _resCardA(ctx, r, x, y, w, h, S, CUT, accent) {
    const lx = (ry) => x + S * h * (1 - clamp((ry - y) / h, 0, 1));
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.fillStyle = 'rgba(4,8,13,0.93)'; ctx.fill();
    ctx.save();
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.strokeStyle = 'rgba(140,172,200,0.40)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    railOn(ctx, x, y, h, accent, 10, S, 4);

    drawText(ctx, 'YOUR RACE', {
      x: lx(y + 34) + 24, y: y + 34, size: 19, weight: 0.215, italic: 0.22, tracking: 0.12,
      color: '#f2f7fc',
    });
    rtext(ctx, 'TOTAL', {
      x: lx(y + 34) + w - 26, y: y + 34, size: 11, weight: 0.15, tracking: 0.30, align: 'right',
      color: 'rgba(146,172,196,0.85)', face: 'geo',
    });
    ctx.beginPath();
    ctx.moveTo(lx(y + 50) + 18, y + 50); ctx.lineTo(lx(y + 50) + w - 18, y + 50);
    ctx.strokeStyle = 'rgba(150,190,220,0.24)'; ctx.lineWidth = 1.1; ctx.stroke();
    // the clock itself is drawn live by _drawResults — this is the window it sits in
    const wy = y + 62, wh = 60;
    platePath(ctx, lx(wy + wh) + 18, wy, w - 44, wh, SKEW * 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
    platePath(ctx, lx(wy + wh) + 18, wy, w - 44, wh, SKEW * 0.5);
    ctx.strokeStyle = 'rgba(150,190,220,0.20)'; ctx.lineWidth = 1; ctx.stroke();

    // Two data rows: the target this race was run against, and where the race landed on it.
    //
    // The label is RECORD TO BEAT, not COURSE RECORD, and the difference is the whole point. The
    // course record is decided at the flag by the whole field and is announced ONCE, on the badge
    // in the header. This card is about the player's own race, so the number it compares against
    // is the time that STOOD coming in — otherwise the screen carries two different clocks under
    // one word, which is the same fault as the badge wearing a different hat.
    const rec = r.recordSec ?? parseClock(r.record);
    const delta = (rec > 0 && r.time != null && !r.dnf) ? r.time - rec : null;
    // …AND IT SAYS WHICH RECORD, because by the time this is drawn there may be two.
    //
    // The whole-game critic on the r1 screen: "the banner announces 'NEW COURSE RECORD ROMAN
    // 02:21:81' while the panel below simultaneously credits the player 'UNDER RECORD BY 28.54'
    // against 02:52:40 … presented without distinguishing them, so the screen appears to
    // congratulate the player for beating a record that the frame also says someone else just
    // took." Both numbers were right and the WORDS were wrong: one said "the record" meaning the
    // one that stood coming in, the other meaning the one that stands now.
    //
    // So the label is tensed off the same fact the badge is drawn from. If nobody took it today the
    // record is still the one you raced, and it is "COURSE RECORD"; if it changed hands — to you or
    // to anybody — the target this card measures against is the OLD one and says so. There is no
    // wording left in which the two halves of the screen can be read as the same record.
    const took = !!(r.recordBeaten || r.recordBy);
    const targetLbl = took ? 'PREVIOUS RECORD' : 'COURSE RECORD';
    // "IT", once the row above has named which record this is measured against — the long forms
    // ("UNDER PREVIOUS RECORD BY") do not fit the card and abbreviating them is worse than binding
    // the pronoun to the line above it, which is how a results card reads anyway.
    const deltaLbl = delta == null ? 'AGAINST IT'
      : delta <= 0 ? (took ? 'UNDER IT BY' : 'UNDER RECORD BY')
        : (took ? 'OVER IT BY' : 'OVER RECORD BY');
    const rowY = [y + h - 54, y + h - 20];
    const put = (i, k, v, col) => {
      rtext(ctx, k, {
        x: lx(rowY[i]) + 26, y: rowY[i], size: 13, weight: 0.15, tracking: 0.26,
        color: 'rgba(160,186,208,0.9)', face: 'geo',
      });
      drawText(ctx, v, {
        x: lx(rowY[i]) + w - 26, y: rowY[i], size: 21, weight: 0.19, italic: 0.20, align: 'right',
        color: col, glow: col === GREEN ? { color: GREEN, blur: 12 } : null,
      });
    };
    // …and the record is set with the panel's own clock face, not echoed as the city file's raw
    // string: "2:08:15" beside a "02:06:65" is two clock formats one line apart.
    put(0, targetLbl, rec > 0 ? fmtTime(rec) : '--:--:--', GOLD);
    put(1, deltaLbl,
      delta == null ? '--' : fmtSplit(Math.abs(delta)), delta == null ? LABEL : delta <= 0 ? GREEN : '#ff8f7a');
  }

  /** Card two: the lap book, with the best lap called out. */
  _resCardB(ctx, r, x, y, w, h, S, CUT) {
    const lx = (ry) => x + S * h * (1 - clamp((ry - y) / h, 0, 1));
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.fillStyle = 'rgba(4,8,13,0.93)'; ctx.fill();
    ctx.save();
    cutPath(ctx, x, y, w, h, S, CUT);
    ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.strokeStyle = 'rgba(140,172,200,0.40)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    railOn(ctx, x, y, h, CYAN, 10, S, 4);

    drawText(ctx, 'LAP TIMES', {
      x: lx(y + 34) + 24, y: y + 34, size: 19, weight: 0.215, italic: 0.22, tracking: 0.12,
      color: '#f2f7fc',
    });
    const best = r.best;
    rtext(ctx, best != null ? 'BEST' : 'NO LAP COMPLETED', {
      x: lx(y + 34) + w - 26, y: y + 34, size: 11, weight: 0.15, tracking: 0.30, align: 'right',
      color: best != null ? 'rgba(146,172,196,0.85)' : 'rgba(255,140,120,0.85)', face: 'geo',
    });
    ctx.beginPath();
    ctx.moveTo(lx(y + 50) + 18, y + 50); ctx.lineTo(lx(y + 50) + w - 18, y + 50);
    ctx.strokeStyle = 'rgba(150,190,220,0.24)'; ctx.lineWidth = 1.1; ctx.stroke();

    const laps = r.laps || [];
    // ONE best lap. `|t - best| < 1e-6` highlights every lap that ties it, and two rows tagged BEST
    // under a header that says BEST is the same contradiction in miniature.
    const bestIdx = best == null ? -1 : laps.findIndex((t) => t != null && Math.abs(t - best) < 1e-6);
    // …and never fewer rows than there are lap times. `lapCount` alone would hide a lap the player
    // actually drove, and the header above claims a BEST — a best that highlights no row on the
    // card is the same class of contradiction as the record badge.
    const n = Math.max(1, r.lapCount || 0, laps.length);
    const pitch = clamp((h - 74) / n, 26, 54);
    for (let i = 0; i < n; i++) {
      const t = laps[i];
      const ry = y + 58 + i * pitch;
      const rh = pitch - 4;
      const rl = lx(ry + rh);
      const isBest = i === bestIdx;
      if (isBest) {
        platePath(ctx, rl + 18, ry, w - 40, rh, SKEW);
        const g = ctx.createLinearGradient(rl, 0, rl + w, 0);
        g.addColorStop(0, 'rgba(57,215,242,0.28)'); g.addColorStop(1, 'rgba(57,215,242,0)');
        ctx.fillStyle = g; ctx.fill();
        railOn(ctx, rl + 18, ry, rh, CYAN, 10, SKEW, 3);
      }
      const base = ry + rh - Math.round(rh * 0.30);
      const bl = lx(base);
      rtext(ctx, `LAP ${i + 1}`, {
        x: bl + 34, y: base, size: 13, weight: 0.15, tracking: 0.26,
        color: t == null ? 'rgba(130,152,172,0.55)' : 'rgba(176,199,220,0.92)', face: 'geo',
      });
      drawText(ctx, t == null ? '--:--.--' : fmtSplit(t), {
        x: bl + w - 26, y: base, size: 22, weight: 0.19, italic: 0.20, align: 'right',
        color: t == null ? 'rgba(120,140,160,0.5)' : isBest ? '#bff3ff' : '#dce8f4',
        glow: isBest ? { color: CYAN, blur: 14 } : null,
      });
      if (isBest) {
        chevrons(ctx, bl + w - 26 - measure(fmtSplit(t), { size: 22, italic: 0.20 }).width - 34,
          base - rh * 0.52, 2, 5, 12, CYAN, 0.9);
      }
    }
  }

  /** The bottom bar — the garage's, down to the hazard chevrons along its foot. */
  _resBar(ctx, r, VW, VH, y, h, M) {
    const g = ctx.createLinearGradient(0, y, 0, VH);
    g.addColorStop(0, 'rgba(4,7,13,0.94)'); g.addColorStop(1, 'rgba(2,3,8,0.99)');
    ctx.fillStyle = g; ctx.fillRect(0, y, VW, h);
    const rg = ctx.createLinearGradient(0, 0, VW, 0);
    rg.addColorStop(0, 'rgba(255,146,20,0.9)');
    rg.addColorStop(0.42, 'rgba(57,215,242,0.6)');
    rg.addColorStop(1, 'rgba(255,146,20,0.15)');
    ctx.fillStyle = rg; ctx.fillRect(0, y - 2, VW, 2);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, VH - 7, VW, 7); ctx.clip();
    ctx.globalAlpha = 0.30;
    for (let cx = -20; cx < VW; cx += 26) {
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.moveTo(cx, VH); ctx.lineTo(cx + 11, VH);
      ctx.lineTo(cx + 20, VH - 7); ctx.lineTo(cx + 9, VH - 7);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    const hy = y + h - 30;
    let hx = M - 24;
    // TWO KEYS, TWO DOORS. Round 1 drew both keycaps against the single word GARAGE — "both keys
    // lead to the same place and the screen is a one-way exit; the player cannot tell which key
    // does what". Confirm now re-runs the race (main.js `retry`), cancel leaves.
    const prompt = (cap, word, col, glow) => {
      hx += keycap(ctx, hx, hy + 13, cap, 34) + 15;   // the caps are sheared: 8 px read as touching
      rtext(ctx, word, {
        x: hx, y: hy + 5, size: 16, weight: 0.16, tracking: 0.18, color: col, face: 'geo',
        glow: { color: glow, blur: 14 },
      });
      hx += rmeasure(word, { size: 16, tracking: 0.18, face: 'geo' }).width + 26;
    };
    prompt('ENTER', 'RACE AGAIN', GOLD_HOT, ORANGE);
    prompt('ESC', 'GARAGE', '#cfe2f2', 'rgba(57,215,242,0.7)');

    // the car you drove, at the far end of the bar — the garage's own sign-off
    const name = String(r.carName || '');
    const MAXW = VW - M - Math.max(640, hx + 40);
    let ns = 46;
    while (ns > 22 && measure(name, { size: ns, tracking: 0.078 }).width > MAXW) ns -= 1;
    const nw = measure(name, { size: ns, tracking: 0.078 }).width;
    const nx = VW - M, ny = y + h - 26;
    const ug = ctx.createLinearGradient(nx - nw, 0, nx, 0);
    ug.addColorStop(0, 'rgba(255,201,66,0)'); ug.addColorStop(1, 'rgba(255,201,66,0.9)');
    ctx.fillStyle = ug; ctx.fillRect(nx - nw, ny + 12, nw, 3);
    rtext(ctx, 'DRIVEN', {
      x: nx, y: ny - ns - 8, size: 12, weight: 0.14, tracking: 0.30, align: 'right',
      color: GOLD, face: 'geo',
    });
    drawText(ctx, name, {
      x: nx, y: ny, size: ns, weight: 0.188, italic: 0.24, tracking: 0.078, align: 'right',
      color: gradientFill([
        [0, '#ffffff'], [0.30, '#e9f2fb'], [0.50, '#8fa3ba'], [0.56, '#c9d8e8'], [1, '#f4f8fc'],
      ]),
      bevel: true, sheen: true,
      shadow: { color: 'rgba(0,0,0,0.8)', dy: 4, blur: 7 },
    });
  }

  // The gantry: a plate with a glow, three lamps that glow when lit, and a numeral with a 34 px
  // halo that pops on every tick — six blurred ops on the frames that matter most, the frames the
  // player is staring at with nothing else to look at. Two layers: the board (which changes only
  // when a lamp lights) and the numeral (which scales every frame).
  _drawStartLights(ctx, cx, cy, countdown) {
    const lit = countdown <= 3 ? 4 - Math.ceil(countdown) : 0;
    const w = 250, h = 74;
    const go = countdown <= 0.02;
    const BP = 40;
    this._patch(ctx, 'lights', cx - w / 2 - BP, cy - h / 2 - BP, w + h * SKEW + BP * 2, h + BP * 2,
      `${lit}|${go}|${cx}|${cy}`, (bc) => {
        panel(bc, cx - w / 2, cy - h / 2, w, h, {
          fill: ['rgba(14,17,24,0.92)', 'rgba(4,6,10,0.92)'], edge: 'rgba(200,220,235,0.28)',
          accent: go ? GREEN : RED, glow: 10,
        });
        for (let i = 0; i < 3; i++) {
          const x = cx - 70 + i * 70;
          const on = i < lit;
          bc.beginPath(); bc.arc(x, cy, 22, 0, TAU);
          const c = on ? (go ? GREEN : RED) : 'rgba(26,30,38,0.9)';
          const gg = bc.createRadialGradient(x - 7, cy - 8, 2, x, cy, 22);
          gg.addColorStop(0, on ? '#ffffff' : 'rgba(60,68,80,0.9)');
          gg.addColorStop(0.35, c);
          gg.addColorStop(1, on ? shade(go ? '#2bff62' : '#ff2e2e', 0.45) : 'rgba(16,20,26,0.9)');
          bc.fillStyle = gg;
          if (on) { bc.shadowBlur = 30; bc.shadowColor = c; }
          bc.fill(); bc.shadowBlur = 0;
          bc.beginPath(); bc.arc(x, cy, 22, 0, TAU);
          bc.strokeStyle = 'rgba(210,228,242,0.45)'; bc.lineWidth = 2.2; bc.stroke();
        }
      });

    // the seconds themselves, punched large under the lamps
    const n = Math.ceil(countdown);
    const frac = 1 - (countdown - Math.floor(countdown));
    const sc = 1 + (1 - smoothstep(0, 0.35, frac)) * 0.45;
    const NS = 64, SCM = 1.45, NP = 34;
    this._live(ctx, 'countNum',
      -NS * SCM * 1.6, -NS * SCM * 1.15 - NP, NS * SCM * 3.2, NS * SCM * 1.7 + NP * 2, (c) => {
        c.scale(sc, sc);
        drawText(c, go ? 'GO!' : String(Math.max(1, n)), {
          x: 0, y: 0, size: NS, weight: 0.23, italic: 0.24, align: 'center',
          color: go ? GREEN : '#fff2e2', sheen: true, tracking: 0.08,
          glow: { color: go ? GREEN : RED, blur: 34 },
          outline: { color: 'rgba(0,0,0,0.45)', width: 2.5 },
        });
      }, { ox: cx, oy: cy + h * 0.5 + 62 });
  }
}

// ---------------------------------------------------------------- helpers

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

/** "2:04:60" / "2:04.60" / "124" → seconds. Returns 0 when there is nothing to parse. */
export function parseClock(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const p = String(v).split(/[:.]/).map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length >= 3) return p[0] * 60 + p[1] + p[2] / 100;
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

export function fmtCountdown(t) {
  const sec = Math.max(0, Math.floor(t));
  const cs = Math.max(0, Math.floor((t % 1) * 100));
  return `${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}
