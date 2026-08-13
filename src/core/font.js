// Procedural vector font. ART_DIRECTION.md §3 forbids any imported font, and forbids falling back
// to a browser-installed family. Everything here is drawn from polygon outlines defined on a unit
// grid (x: 0..advance, y: 0 = cap line, 1 = baseline) and FILLED, not stroked — filled contours are
// what give real letterforms: flat terminals, proper joins, true counters, optical bearings.
//
// Three faces — a type SYSTEM, not one font used at different sizes:
//   NITRO    ('display') — heavy condensed grotesque, narrow oval bowls, tapered joins, tabular
//                          figures, built to be sheared into an aggressive italic. Reserved for
//                          numbers and headings.
//   CIRCUIT  ('geo')     — upright monolinear geometric sans: true-circle bowls, single-storey a,
//                          pointed A/M/W apexes, a large x-height and open apertures. Cut on its
//                          own metrics (lighter stem, wider set) so it stays clean at 9–15 px.
//                          Used for every label and list: names, POS / OF 8, CHARGE, ANGLE, RECORD.
//   SEVENSEG             — seven-segment display face with tapered hexagonal segments.
//
// Weight: outlines are cut at each face's base weight. Anything heavier is produced by stroking the
// same path with a mitred pen, so one master per face covers its whole weight range.

const TAU = Math.PI * 2;
const BASE_WEIGHT = 0.165;      // stem thickness of the master outlines, in cap-height units

// ---------------------------------------------------------------- contour primitives

/** Signed area in screen space (y down): > 0 is clockwise. */
function area(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a;
}
/** Force clockwise winding so overlapping shapes union under the nonzero fill rule. */
function cw(p) { return area(p) < 0 ? p.slice().reverse() : p; }
/** Force counter-clockwise winding — a counter (hole) inside a clockwise outline. */
function ccw(p) { return area(p) > 0 ? p.slice().reverse() : p; }

const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Diagonal stroke with a horizontal pen: terminals are cut flat along x (cap line / baseline). */
const hbar = (x0, y0, x1, y1, t) => cw([[x0 - t / 2, y0], [x0 + t / 2, y0], [x1 + t / 2, y1], [x1 - t / 2, y1]]);
/** Diagonal stroke with a vertical pen: terminals are cut flat along y (vertical shears). */
const vbar = (x0, y0, x1, y1, t) => cw([[x0, y0 - t / 2], [x0, y0 + t / 2], [x1, y1 + t / 2], [x1, y1 - t / 2]]);

function arcInto(out, cx, cy, rx, ry, a0, a1) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.12));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}
/** Partial ring (a bowl segment) — outer arc out, inner arc back. Radial cuts at both terminals. */
function band(cx, cy, rx, ry, t, a0, a1) {
  const p = [];
  arcInto(p, cx, cy, rx, ry, a0, a1);
  arcInto(p, cx, cy, rx - t, ry - t, a1, a0);
  return cw(p);
}
/** Closed ring: outer contour + reversed counter. Returns TWO contours. */
function ring(cx, cy, rx, ry, t) {
  return [cw(arcInto([], cx, cy, rx, ry, 0, TAU)), ccw(arcInto([], cx, cy, rx - t, ry - t, 0, TAU))];
}
/** Rotate a glyph 180° inside its ink box — 6→9, etc. */
function rot180(cs, w, h = 1) { return cs.map((c) => c.map(([x, y]) => [w - x, h - y])); }
/** Non-uniform scale, used to derive x-height forms from cap forms. */
function xform(cs, sx, sy, dx = 0, dy = 0) { return cs.map((c) => c.map(([x, y]) => [x * sx + dx, y * sy + dy])); }

const ST = 0.165;    // stem
const BT = 0.152;    // horizontal bar (optically lighter than the stem)
const DT = 0.205;    // diagonal, horizontal pen
const RT = 0.175;    // round stroke (bowls read thin, so a touch heavier)

// x-height metrics for the lowercase
const XT = 0.30;     // x-height top
const XM = 0.65;     // centre of the x-height ellipse
const XR = 0.35;     // x-height ellipse vertical radius
const DESC = 1.26;   // descender depth

// ---------------------------------------------------------------- the glyph table

const G = {};
/** @param a advance (ink width + side bearings) @param c contours @param ox ink offset */
const def = (ch, a, c, ox = 0) => { G[ch] = { a, c, ox }; };

// --- capitals -------------------------------------------------------------
// A: cut as one outline so the apex is a real point-cut rather than two overlapping bars.
def('A', 0.82, [
  cw([[0.325, 0], [0.475, 0], [0.80, 1], [0.595, 1], [0.538, 0.825], [0.262, 0.825], [0.205, 1], [0, 1]]),
  ccw([[0.40, 0.40], [0.314, 0.665], [0.486, 0.665]]),
]);
def('B', 0.85, [
  box(0, 0, ST, 1),
  band(0.40, 0.255, 0.36, 0.255, RT, -0.5 * Math.PI, 0.5 * Math.PI),
  band(0.40, 0.745, 0.38, 0.255, RT, -0.5 * Math.PI, 0.5 * Math.PI),
  box(0, 0, 0.42, BT), box(0, 0.50 - BT / 2, 0.44, 0.50 + BT / 2), box(0, 1 - BT, 0.42, 1),
]);
def('C', 0.82, [band(0.38, 0.5, 0.38, 0.502, RT, 0.30 * Math.PI, 1.70 * Math.PI)]);
def('D', 0.85, [
  box(0, 0, ST, 1),
  band(0.38, 0.5, 0.40, 0.502, RT, -0.5 * Math.PI, 0.5 * Math.PI),
  box(0, 0, 0.40, BT), box(0, 1 - BT, 0.40, 1),
]);
def('E', 0.73, [box(0, 0, ST, 1), box(0, 0, 0.66, BT), box(0, 0.50 - BT / 2, 0.575, 0.50 + BT / 2), box(0, 1 - BT, 0.66, 1)]);
def('F', 0.70, [box(0, 0, ST, 1), box(0, 0, 0.64, BT), box(0, 0.50 - BT / 2, 0.56, 0.50 + BT / 2)]);
def('G', 0.85, [
  band(0.39, 0.5, 0.39, 0.502, RT, 0.30 * Math.PI, 1.70 * Math.PI),
  box(0.42, 0.50, 0.78, 0.50 + BT), box(0.78 - RT, 0.50, 0.78, 0.90),
]);
def('H', 0.83, [box(0, 0, ST, 1), box(0.76 - ST, 0, 0.76, 1), box(0, 0.50 - BT / 2, 0.76, 0.50 + BT / 2)]);
def('I', 0.35, [box(0, 0, ST, 1)]);
def('J', 0.74, [box(0.68 - ST, 0, 0.68, 0.70), band(0.34, 0.70, 0.34, 0.30, RT, 0, Math.PI)]);
def('K', 0.83, [
  box(0, 0, ST, 1),
  hbar(0.645, 0, 0.16, 0.50, 0.265),
  hbar(0.205, 0.42, 0.665, 1, 0.235),
]);
def('L', 0.70, [box(0, 0, ST, 1), box(0, 1 - BT, 0.64, 1)]);
def('M', 1.08, [
  box(0, 0, ST, 1), box(1.02 - ST, 0, 1.02, 1),
  cw([[0.165, 0], [0.375, 0], [0.51, 0.40], [0.645, 0], [0.855, 0], [0.51, 0.82]]),
]);
def('N', 0.87, [box(0, 0, ST, 1), box(0.80 - ST, 0, 0.80, 1), cw([[ST, 0], [0.385, 0], [0.80, 1], [0.59, 1]])]);
def('O', 0.86, ring(0.40, 0.50, 0.40, 0.502, RT));
def('P', 0.82, [
  box(0, 0, ST, 1),
  band(0.38, 0.29, 0.38, 0.29, RT, -0.5 * Math.PI, 0.5 * Math.PI),
  box(0, 0, 0.40, BT), box(0, 0.58 - BT, 0.40, 0.58),
]);
def('Q', 0.86, [...ring(0.40, 0.50, 0.40, 0.502, RT), hbar(0.50, 0.66, 0.84, 1.10, 0.215)]);
def('R', 0.84, [
  box(0, 0, ST, 1),
  band(0.38, 0.29, 0.38, 0.29, RT, -0.5 * Math.PI, 0.5 * Math.PI),
  box(0, 0, 0.40, BT), box(0, 0.58 - BT, 0.40, 0.58),
  hbar(0.315, 0.50, 0.665, 1, 0.235),
]);
def('S', 0.80, [
  band(0.36, 0.28, 0.36, 0.28, RT, 1.75 * Math.PI, 0.5 * Math.PI),
  band(0.36, 0.72, 0.36, 0.28, RT, 1.5 * Math.PI, 2.75 * Math.PI),
]);
def('T', 0.76, [box(0, 0, 0.72, BT), box(0.36 - ST / 2, 0, 0.36 + ST / 2, 1)]);
def('U', 0.85, [
  box(0, 0, ST, 0.66), box(0.78 - ST, 0, 0.78, 0.66),
  band(0.39, 0.66, 0.39, 0.34, RT, 0, Math.PI),
]);
def('V', 0.80, [cw([[0, 0], [0.205, 0], [0.390, 0.474], [0.575, 0], [0.78, 0], [0.39, 1]])]);
def('W', 1.16, [
  cw([[0, 0], [0.185, 0], [0.310, 0.474], [0.435, 0], [0.62, 0], [0.31, 1]]),
  cw([[0.54, 0], [0.725, 0], [0.850, 0.474], [0.975, 0], [1.16, 0], [0.85, 1]]),
]);
def('X', 0.80, [hbar(0.12, 0, 0.66, 1, 0.235), hbar(0.66, 0, 0.12, 1, 0.235)]);
def('Y', 0.80, [
  hbar(0.117, 0, 0.39, 0.52, 0.235), hbar(0.663, 0, 0.39, 0.52, 0.235),
  box(0.39 - ST / 2, 0.44, 0.39 + ST / 2, 1),
]);
def('Z', 0.78, [box(0, 0, 0.72, BT), box(0, 1 - BT, 0.72, 1), hbar(0.545, 0, 0.175, 1, 0.215)]);

// --- figures — tabular: every digit shares one advance so clocks don't shimmer -------
const FIG = 0.80;
const fig = (ch, c, inkW) => def(ch, FIG, c, (FIG - 0.14 - inkW) / 2 + 0.07);
fig('0', [...ring(0.36, 0.50, 0.36, 0.502, RT)], 0.72);
fig('1', [box(0.28, 0, 0.28 + ST, 1), cw([[0.28, 0.02], [0.28, 0.30], [0.075, 0.235]])], 0.45 + 0.075);
fig('2', [
  band(0.36, 0.30, 0.32, 0.30, RT, 0.88 * Math.PI, 2.10 * Math.PI),
  hbar(0.60, 0.34, 0.155, 0.88, 0.245),
  box(0, 1 - BT, 0.72, 1),
], 0.72);
fig('3', [
  band(0.34, 0.275, 0.30, 0.275, RT, 0.88 * Math.PI, 2.42 * Math.PI),
  band(0.34, 0.725, 0.33, 0.275, RT, 1.52 * Math.PI, 2.88 * Math.PI),
], 0.70);
fig('4', [box(0, 0.60, 0.70, 0.60 + BT), box(0.44, 0, 0.44 + ST, 1), hbar(0.47, 0, 0.115, 0.66, 0.225)], 0.70);
fig('5', [
  box(0, 0, 0.66, BT), box(0, 0, ST, 0.52), box(0, 0.36, 0.36, 0.36 + RT),
  band(0.34, 0.68, 0.34, 0.32, RT, 1.5 * Math.PI, 2.86 * Math.PI),
], 0.68);
const SIX = [
  ...ring(0.36, 0.66, 0.36, 0.34, RT),
  band(0.44, 0.62, 0.42, 0.62, RT, 1.72 * Math.PI, 1.0 * Math.PI),
];
fig('6', SIX, 0.72);
fig('7', [box(0, 0, 0.72, BT), hbar(0.585, 0, 0.19, 1, 0.235)], 0.72);
fig('8', [...ring(0.35, 0.275, 0.31, 0.277, RT * 0.94), ...ring(0.36, 0.725, 0.34, 0.277, RT)], 0.70);
fig('9', rot180(SIX, 0.72), 0.72);

// --- lowercase — real lowercase, not shrunken caps -------------------------
def('a', 0.74, [...ring(0.33, XM, 0.33, XR, ST), box(0.66 - ST, XT, 0.66, 1)]);
def('b', 0.78, [box(0, 0, ST, 1), ...ring(0.355, XM, 0.355, XR, ST)]);
def('c', 0.72, [band(0.35, XM, 0.35, XR, ST, 0.30 * Math.PI, 1.70 * Math.PI)]);
def('d', 0.78, [...ring(0.325, XM, 0.325, XR, ST), box(0.68 - ST, 0, 0.68, 1)]);
def('e', 0.74, [
  band(0.35, XM, 0.35, XR, ST, 0.14 * Math.PI, 2.0 * Math.PI),
  box(0.02, XM - BT / 2, 0.70, XM + BT / 2),
]);
def('f', 0.54, [
  box(0.18, 0.17, 0.18 + ST, 1),
  band(0.45, 0.175, 0.1875, 0.175, ST, Math.PI, 1.5 * Math.PI),
  box(0.0, XT, 0.52, XT + BT),
]);
def('g', 0.78, [
  ...ring(0.33, XM, 0.33, XR, ST), box(0.66 - ST, XT, 0.66, 1.08),
  band(0.33, 1.06, 0.33, 0.20, ST, 0, 0.92 * Math.PI),
]);
def('h', 0.78, [box(0, 0, ST, 1), band(0.355, XM, 0.355, XR, ST, Math.PI, TAU), box(0.71 - ST, XM, 0.71, 1)]);
def('i', 0.36, [box(0.02, XT, 0.02 + ST, 1), box(0.02, 0.03, 0.02 + ST, 0.03 + ST)]);
def('j', 0.42, [
  box(0.15, XT, 0.15 + ST, 1.02), box(0.15, 0.03, 0.15 + ST, 0.03 + ST),
  band(0.15, 1.02, 0.15, 0.22, ST, 0.5 * Math.PI, Math.PI),
]);
def('k', 0.74, [box(0, 0, ST, 1), hbar(0.60, XT, 0.145, 0.72, 0.245), hbar(0.19, 0.63, 0.60, 1, 0.225)]);
def('l', 0.36, [box(0.02, 0, 0.02 + ST, 1)]);
def('m', 1.16, [
  box(0, XT, ST, 1),
  band(0.315, XM, 0.315, XR, ST, Math.PI, TAU), box(0.63 - ST, XM, 0.63, 1),
  band(0.785, XM, 0.315, XR, ST, Math.PI, TAU), box(1.10 - ST, XM, 1.10, 1),
]);
def('n', 0.78, [box(0, XT, ST, 1), band(0.355, XM, 0.355, XR, ST, Math.PI, TAU), box(0.71 - ST, XM, 0.71, 1)]);
def('o', 0.78, ring(0.355, XM, 0.355, XR, ST));
def('p', 0.78, [box(0, XT, ST, DESC), ...ring(0.355, XM, 0.355, XR, ST)]);
def('q', 0.78, [...ring(0.325, XM, 0.325, XR, ST), box(0.68 - ST, XT, 0.68, DESC)]);
def('r', 0.56, [box(0, XT, ST, 1), band(0.35, XM, 0.35, XR, ST, Math.PI, 1.62 * Math.PI)]);
def('s', 0.70, [
  band(0.32, XT + 0.185, 0.32, 0.185, ST, 1.78 * Math.PI, 0.5 * Math.PI),
  band(0.32, 1 - 0.185, 0.32, 0.185, ST, 1.5 * Math.PI, 2.78 * Math.PI),
]);
def('t', 0.50, [box(0.20, 0.10, 0.20 + ST, 0.88), band(0.365, 0.88, 0.165, 0.12, ST, Math.PI, 0.5 * Math.PI), box(0.02, XT, 0.54, XT + BT)]);
def('u', 0.78, [box(0, XT, ST, XM), box(0.71 - ST, XT, 0.71, 1), band(0.355, XM, 0.355, XR, ST, 0, Math.PI)]);
def('v', 0.72, [cw([[0, XT], [0.185, XT], [0.35, 0.63], [0.515, XT], [0.70, XT], [0.35, 1]])]);
def('w', 1.06, [
  cw([[0, XT], [0.17, XT], [0.285, 0.63], [0.40, XT], [0.57, XT], [0.285, 1]]),
  cw([[0.49, XT], [0.66, XT], [0.775, 0.63], [0.89, XT], [1.06, XT], [0.775, 1]]),
]);
def('x', 0.72, [hbar(0.11, XT, 0.59, 1, 0.225), hbar(0.59, XT, 0.11, 1, 0.225)]);
def('y', 0.72, [hbar(0.105, XT, 0.35, 0.76, 0.225), cw([[0.585, XT], [0.70, XT], [0.36, DESC], [0.19, DESC]])]);
def('z', 0.70, [box(0.02, XT, 0.66, XT + BT), box(0.02, 1 - BT, 0.66, 1), hbar(0.50, XT, 0.18, 1, 0.205)]);

// --- punctuation & symbols ------------------------------------------------
def(' ', 0.34, []);
def('.', 0.34, [box(0.05, 1 - ST, 0.05 + ST, 1)]);
def(',', 0.34, [cw([[0.05, 1 - ST], [0.05 + ST, 1 - ST], [0.05 + ST, 1], [0.02, 1.20]])]);
def(':', 0.34, [box(0.05, 0.34, 0.05 + ST, 0.34 + ST), box(0.05, 1 - ST, 0.05 + ST, 1)]);
def(';', 0.34, [box(0.05, 0.34, 0.05 + ST, 0.34 + ST), cw([[0.05, 1 - ST], [0.05 + ST, 1 - ST], [0.05 + ST, 1], [0.02, 1.18]])]);
def('-', 0.56, [box(0.04, 0.50 - BT / 2, 0.46, 0.50 + BT / 2)]);
def('–', 0.72, [box(0.04, 0.50 - BT / 2, 0.62, 0.50 + BT / 2)]);
def('_', 0.72, [box(0, 1.10, 0.66, 1.10 + BT)]);
def('/', 0.62, [hbar(0.50, -0.04, 0.06, 1.04, 0.185)]);
def('\\', 0.62, [hbar(0.06, -0.04, 0.50, 1.04, 0.185)]);
def("'", 0.32, [cw([[0.06, 0], [0.06 + ST, 0], [0.06 + ST, 0.20], [0.06, 0.32]])]);
def('"', 0.52, [
  cw([[0.06, 0], [0.06 + ST, 0], [0.06 + ST, 0.20], [0.06, 0.32]]),
  cw([[0.30, 0], [0.30 + ST, 0], [0.30 + ST, 0.20], [0.30, 0.32]]),
]);
def('!', 0.36, [cw([[0.045, 0], [0.045 + ST, 0], [0.06 + ST * 0.8, 0.68], [0.06, 0.68]]), box(0.045, 1 - ST, 0.045 + ST, 1)]);
def('?', 0.72, [
  band(0.33, 0.235, 0.30, 0.235, RT, 0.94 * Math.PI, 2.24 * Math.PI),
  box(0.33 - ST / 2, 0.44, 0.33 + ST / 2, 0.70),
  box(0.33 - ST / 2, 1 - ST, 0.33 + ST / 2, 1),
]);
def('#', 0.92, [
  hbar(0.30, 0, 0.20, 1, 0.135), hbar(0.62, 0, 0.52, 1, 0.135),
  box(0.02, 0.30, 0.82, 0.30 + 0.13), box(0.02, 0.62, 0.82, 0.62 + 0.13),
]);
def('%', 1.0, [
  hbar(0.78, 0, 0.16, 1, 0.185),
  ...ring(0.20, 0.20, 0.20, 0.20, 0.125), ...ring(0.74, 0.80, 0.20, 0.20, 0.125),
]);
def('+', 0.78, [box(0.36 - BT / 2, 0.22, 0.36 + BT / 2, 0.78), box(0.08, 0.50 - BT / 2, 0.64, 0.50 + BT / 2)]);
def('=', 0.78, [box(0.06, 0.36, 0.66, 0.36 + BT), box(0.06, 0.64 - BT, 0.66, 0.64)]);
def('×', 0.68, [hbar(0.14, 0.26, 0.50, 0.80, 0.17), hbar(0.50, 0.26, 0.14, 0.80, 0.17)]);
def('*', 0.60, [
  box(0.26, 0.02, 0.26 + 0.11, 0.46), hbar(0.10, 0.10, 0.53, 0.36, 0.11), hbar(0.53, 0.10, 0.10, 0.36, 0.11),
]);
def('(', 0.44, [band(0.42, 0.5, 0.36, 0.58, 0.145, 0.72 * Math.PI, 1.28 * Math.PI)]);
def(')', 0.44, [band(-0.04, 0.5, 0.36, 0.58, 0.145, 1.72 * Math.PI, 2.28 * Math.PI)]);
def('[', 0.42, [box(0.06, -0.04, 0.34, -0.04 + 0.135), box(0.06, -0.04, 0.06 + 0.135, 1.04), box(0.06, 1.04 - 0.135, 0.34, 1.04)]);
def(']', 0.42, [box(0.02, -0.04, 0.30, -0.04 + 0.135), box(0.30 - 0.135, -0.04, 0.30, 1.04), box(0.02, 1.04 - 0.135, 0.30, 1.04)]);
def('<', 0.66, [hbar(0.56, 0.10, 0.10, 0.52, 0.20), hbar(0.10, 0.48, 0.56, 0.90, 0.20)]);
def('>', 0.66, [hbar(0.06, 0.10, 0.52, 0.52, 0.20), hbar(0.52, 0.48, 0.06, 0.90, 0.20)]);
def('°', 0.46, ring(0.20, 0.18, 0.18, 0.18, 0.105));
def('&', 0.92, [
  band(0.34, 0.18, 0.20, 0.18, RT * 0.85, 0.5 * Math.PI, 1.5 * Math.PI),
  band(0.34, 0.72, 0.32, 0.28, RT * 0.9, 1.62 * Math.PI, 0.62 * Math.PI),
  hbar(0.30, 0.30, 0.86, 1.0, 0.20),
]);
def('|', 0.34, [box(0.06, -0.02, 0.06 + 0.12, 1.02)]);
def('@', 1.0, [
  band(0.44, 0.5, 0.44, 0.5, 0.15, 0.16 * Math.PI, 1.86 * Math.PI),
  ...ring(0.44, 0.56, 0.20, 0.22, 0.13),
  box(0.60, 0.42, 0.60 + 0.13, 0.70),
]);

// arrows / button glyphs used by the menu's control hints
def('◄', 0.70, [cw([[0.56, 0.10], [0.56, 0.90], [0.04, 0.50]])]);
def('►', 0.70, [cw([[0.10, 0.10], [0.62, 0.50], [0.10, 0.90]])]);
def('▲', 0.70, [cw([[0.33, 0.06], [0.62, 0.72], [0.04, 0.72]])]);
def('▼', 0.70, [cw([[0.04, 0.28], [0.62, 0.28], [0.33, 0.94]])]);
def('←', 0.86, [box(0.20, 0.42, 0.78, 0.58), cw([[0.36, 0.22], [0.36, 0.78], [0.02, 0.50]])]);
def('→', 0.86, [box(0.06, 0.42, 0.64, 0.58), cw([[0.48, 0.22], [0.82, 0.50], [0.48, 0.78]])]);
def('↑', 0.74, [box(0.30, 0.20, 0.46, 0.92), cw([[0.38, 0.02], [0.72, 0.36], [0.04, 0.36]])]);
def('↓', 0.74, [box(0.30, 0.08, 0.46, 0.80), cw([[0.04, 0.64], [0.72, 0.64], [0.38, 0.98]])]);

// ================================================================ CIRCUIT — the geometric face
// A second, independently cut face. Not the display face with the shear switched off: different
// skeletons (pointed A/M/W, straight-legged R, spurred G, single-storey a), different metrics
// (circular rather than oval bowls, wider set, lighter monolinear stem, bigger x-height) and its
// own kerning. §2.6 asks for "a clean geometric face for lists" alongside the display italic; this
// is that face, and the HUD uses it for every label and every leaderboard row.

const GEO = {};
const defG = (ch, a, c, ox = 0) => { GEO[ch] = { a, c, ox }; };

const gST = 0.145;   // stem — monolinear: bars and rounds sit within a hair of it
const gBT = 0.132;   // horizontal bar
const gRT = 0.152;   // round stroke
const gDT = 0.170;   // diagonal, horizontal pen
const gXT = 0.30;    // x-height line
const gXM = 0.65;    // centre of the lowercase bowl
const gXR = 0.35;    // lowercase bowl radius
const gDS = 1.24;    // descender
const P = Math.PI;

defG('A', 0.80, [
  hbar(0.395, 0, 0.045, 1, gDT), hbar(0.395, 0, 0.745, 1, gDT),
  box(0.155, 0.660, 0.635, 0.660 + gBT),
]);
defG('B', 0.74, [
  box(0, 0, gST, 1),
  band(0.335, 0.252, 0.295, 0.252, gRT, -0.5 * P, 0.5 * P),
  band(0.345, 0.748, 0.305, 0.252, gRT, -0.5 * P, 0.5 * P),
  box(0, 0, 0.35, gBT), box(0, 0.50 - gBT / 2, 0.36, 0.50 + gBT / 2), box(0, 1 - gBT, 0.35, 1),
]);
defG('C', 0.82, [band(0.375, 0.5, 0.375, 0.5, gRT, 0.32 * P, 1.68 * P)]);
defG('D', 0.84, [
  box(0, 0, gST, 1), band(0.36, 0.5, 0.39, 0.5, gRT, -0.5 * P, 0.5 * P),
  box(0, 0, 0.38, gBT), box(0, 1 - gBT, 0.38, 1),
]);
defG('E', 0.70, [box(0, 0, gST, 1), box(0, 0, 0.60, gBT), box(0, 0.50 - gBT / 2, 0.53, 0.50 + gBT / 2), box(0, 1 - gBT, 0.60, 1)]);
defG('F', 0.66, [box(0, 0, gST, 1), box(0, 0, 0.58, gBT), box(0, 0.50 - gBT / 2, 0.50, 0.50 + gBT / 2)]);
defG('G', 0.84, [
  band(0.375, 0.5, 0.375, 0.5, gRT, 0.32 * P, 1.70 * P),
  box(0.40, 0.50 - gBT / 2, 0.75, 0.50 + gBT / 2), box(0.75 - gRT, 0.50 - gBT / 2, 0.75, 0.86),
]);
defG('H', 0.82, [box(0, 0, gST, 1), box(0.72 - gST, 0, 0.72, 1), box(0, 0.50 - gBT / 2, 0.72, 0.50 + gBT / 2)]);
defG('I', 0.32, [box(0, 0, gST, 1)]);
defG('J', 0.68, [box(0.60 - gST, 0, 0.60, 0.70), band(0.305, 0.70, 0.305, 0.30, gRT, 0, P)]);
defG('K', 0.76, [box(0, 0, gST, 1), hbar(0.605, 0, 0.145, 0.52, 0.185), hbar(0.19, 0.46, 0.635, 1, 0.185)]);
defG('L', 0.64, [box(0, 0, gST, 1), box(0, 1 - gBT, 0.58, 1)]);
defG('M', 0.98, [
  box(0, 0, gST, 1), box(0.88 - gST, 0, 0.88, 1),
  cw([[0, 0], [0.185, 0], [0.44, 0.80], [0.695, 0], [0.88, 0], [0.44, 1.02]]),
]);
defG('N', 0.88, [box(0, 0, gST, 1), box(0.78 - gST, 0, 0.78, 1), cw([[gST, 0], [0.36, 0], [0.78, 1], [0.55, 1]])]);
defG('O', 0.84, ring(0.375, 0.5, 0.375, 0.5, gRT));
defG('P', 0.76, [
  box(0, 0, gST, 1), band(0.345, 0.285, 0.305, 0.285, gRT, -0.5 * P, 0.5 * P),
  box(0, 0, 0.36, gBT), box(0, 0.57 - gBT, 0.36, 0.57),
]);
defG('Q', 0.84, [...ring(0.375, 0.5, 0.375, 0.5, gRT), hbar(0.46, 0.66, 0.80, 1.08, 0.165)]);
defG('R', 0.78, [
  box(0, 0, gST, 1), band(0.345, 0.285, 0.305, 0.285, gRT, -0.5 * P, 0.5 * P),
  box(0, 0, 0.36, gBT), box(0, 0.57 - gBT, 0.36, 0.57),
  hbar(0.285, 0.55, 0.625, 1, 0.185),
]);
defG('S', 0.76, [
  band(0.34, 0.272, 0.34, 0.272, gRT, 1.75 * P, 0.5 * P),
  band(0.34, 0.728, 0.34, 0.272, gRT, 1.5 * P, 2.75 * P),
]);
defG('T', 0.74, [box(0, 0, 0.68, gBT), box(0.34 - gST / 2, 0, 0.34 + gST / 2, 1)]);
defG('U', 0.82, [box(0, 0, gST, 0.65), box(0.72 - gST, 0, 0.72, 0.65), band(0.36, 0.65, 0.36, 0.35, gRT, 0, P)]);
defG('V', 0.80, [cw([[0, 0], [0.185, 0], [0.365, 0.52], [0.545, 0], [0.73, 0], [0.365, 1.0]])]);
defG('W', 1.20, [
  cw([[0, 0], [0.17, 0], [0.30, 0.52], [0.43, 0], [0.60, 0], [0.30, 1.0]]),
  cw([[0.52, 0], [0.69, 0], [0.82, 0.52], [0.95, 0], [1.12, 0], [0.82, 1.0]]),
]);
defG('X', 0.78, [hbar(0.11, 0, 0.62, 1, 0.185), hbar(0.62, 0, 0.11, 1, 0.185)]);
defG('Y', 0.78, [
  hbar(0.105, 0, 0.365, 0.50, 0.185), hbar(0.625, 0, 0.365, 0.50, 0.185),
  box(0.365 - gST / 2, 0.44, 0.365 + gST / 2, 1),
]);
defG('Z', 0.74, [box(0, 0, 0.68, gBT), box(0, 1 - gBT, 0.68, 1), hbar(0.515, 0, 0.165, 1, 0.175)]);

// tabular figures — same advance for every digit so a changing readout never reflows
const FIGG = 0.72;
const figG = (ch, c, inkW) => defG(ch, FIGG, c, (FIGG - 0.10 - inkW) / 2 + 0.05);
figG('0', ring(0.31, 0.5, 0.31, 0.5, gRT), 0.62);
figG('1', [box(0.245, 0, 0.245 + gST, 1), cw([[0.245, 0.02], [0.245, 0.265], [0.065, 0.205]])], 0.325 + 0.065);
figG('2', [
  band(0.31, 0.30, 0.30, 0.30, gRT, 0.88 * P, 2.10 * P),
  hbar(0.545, 0.34, 0.135, 0.87, 0.19), box(0, 1 - gBT, 0.62, 1),
], 0.62);
figG('3', [
  band(0.305, 0.272, 0.28, 0.272, gRT, 0.88 * P, 2.42 * P),
  band(0.305, 0.728, 0.305, 0.272, gRT, 1.52 * P, 2.88 * P),
], 0.61);
figG('4', [box(0, 0.62, 0.60, 0.62 + gBT), box(0.395, 0, 0.395 + gST, 1), hbar(0.425, 0, 0.095, 0.68, 0.185)], 0.60);
figG('5', [
  box(0, 0, 0.58, gBT), box(0, 0, gST, 0.50), box(0, 0.36, 0.32, 0.36 + gRT),
  band(0.30, 0.68, 0.30, 0.32, gRT, 1.5 * P, 2.86 * P),
], 0.60);
const SIXG = [...ring(0.31, 0.66, 0.31, 0.34, gRT), band(0.38, 0.62, 0.37, 0.62, gRT, 1.72 * P, 1.0 * P)];
figG('6', SIXG, 0.62);
figG('7', [box(0, 0, 0.62, gBT), hbar(0.50, 0, 0.155, 1, 0.185)], 0.62);
figG('8', [...ring(0.30, 0.272, 0.27, 0.272, gRT * 0.95), ...ring(0.31, 0.728, 0.30, 0.272, gRT)], 0.61);
figG('9', rot180(SIXG, 0.62), 0.62);

// lowercase — geometric construction: a circle, a stem, and nothing else where possible
defG('a', 0.72, [...ring(0.325, gXM, 0.325, gXR, gST), box(0.65 - gST, gXT, 0.65, 1)]);
defG('b', 0.76, [box(0, 0, gST, 1), ...ring(0.35, gXM, 0.35, gXR, gST)]);
defG('c', 0.72, [band(0.35, gXM, 0.35, gXR, gST, 0.32 * P, 1.68 * P)]);
defG('d', 0.74, [...ring(0.325, gXM, 0.325, gXR, gST), box(0.65 - gST, 0, 0.65, 1)]);
defG('e', 0.74, [
  band(0.35, gXM, 0.35, gXR, gST, 0.14 * P, 2.0 * P),
  box(0.02, gXM - gBT / 2, 0.68, gXM + gBT / 2),
]);
defG('f', 0.50, [
  box(0.17, 0.17, 0.17 + gST, 1), band(0.425, 0.175, 0.18, 0.175, gST, P, 1.5 * P),
  box(0, gXT, 0.50, gXT + gBT),
]);
defG('g', 0.74, [
  ...ring(0.325, gXM, 0.325, gXR, gST), box(0.65 - gST, gXT, 0.65, 1.06),
  band(0.325, 1.04, 0.325, 0.20, gST, 0, 0.92 * P),
]);
defG('h', 0.76, [box(0, 0, gST, 1), band(0.35, gXM, 0.35, gXR, gST, P, TAU), box(0.70 - gST, gXM, 0.70, 1)]);
defG('i', 0.34, [box(0.02, gXT, 0.02 + gST, 1), box(0.02, 0.04, 0.02 + gST, 0.04 + gST)]);
defG('j', 0.40, [
  box(0.13, gXT, 0.13 + gST, 1.02), box(0.13, 0.04, 0.13 + gST, 0.04 + gST),
  band(0.13, 1.02, 0.13, 0.22, gST, 0.5 * P, P),
]);
defG('k', 0.70, [box(0, 0, gST, 1), hbar(0.555, gXT, 0.135, 0.71, 0.19), hbar(0.18, 0.63, 0.565, 1, 0.185)]);
defG('l', 0.34, [box(0.02, 0, 0.02 + gST, 1)]);
defG('m', 1.14, [
  box(0, gXT, gST, 1),
  band(0.305, gXM, 0.305, gXR, gST, P, TAU), box(0.61 - gST, gXM, 0.61, 1),
  band(0.765, gXM, 0.305, gXR, gST, P, TAU), box(1.07 - gST, gXM, 1.07, 1),
]);
defG('n', 0.76, [box(0, gXT, gST, 1), band(0.35, gXM, 0.35, gXR, gST, P, TAU), box(0.70 - gST, gXM, 0.70, 1)]);
defG('o', 0.76, ring(0.35, gXM, 0.35, gXR, gST));
defG('p', 0.76, [box(0, gXT, gST, gDS), ...ring(0.35, gXM, 0.35, gXR, gST)]);
defG('q', 0.74, [...ring(0.325, gXM, 0.325, gXR, gST), box(0.65 - gST, gXT, 0.65, gDS)]);
defG('r', 0.52, [box(0, gXT, gST, 1), band(0.34, gXM, 0.34, gXR, gST, P, 1.62 * P)]);
defG('s', 0.66, [
  band(0.30, gXT + 0.175, 0.30, 0.175, gST, 1.78 * P, 0.5 * P),
  band(0.30, 1 - 0.175, 0.30, 0.175, gST, 1.5 * P, 2.78 * P),
]);
defG('t', 0.48, [
  box(0.185, 0.09, 0.185 + gST, 0.88), band(0.345, 0.88, 0.16, 0.12, gST, P, 0.5 * P),
  box(0.01, gXT, 0.51, gXT + gBT),
]);
defG('u', 0.76, [box(0, gXT, gST, gXM), box(0.70 - gST, gXT, 0.70, 1), band(0.35, gXM, 0.35, gXR, gST, 0, P)]);
defG('v', 0.72, [cw([[0, gXT], [0.175, gXT], [0.34, 0.64], [0.505, gXT], [0.68, gXT], [0.34, 1]])]);
defG('w', 1.06, [
  cw([[0, gXT], [0.16, gXT], [0.275, 0.64], [0.39, gXT], [0.55, gXT], [0.275, 1]]),
  cw([[0.46, gXT], [0.62, gXT], [0.735, 0.64], [0.85, gXT], [1.01, gXT], [0.735, 1]]),
]);
defG('x', 0.70, [hbar(0.10, gXT, 0.57, 1, 0.185), hbar(0.57, gXT, 0.10, 1, 0.185)]);
defG('y', 0.70, [hbar(0.10, gXT, 0.335, 0.76, 0.185), cw([[0.555, gXT], [0.675, gXT], [0.345, gDS], [0.185, gDS]])]);
defG('z', 0.68, [box(0.02, gXT, 0.64, gXT + gBT), box(0.02, 1 - gBT, 0.64, 1), hbar(0.475, gXT, 0.165, 1, 0.175)]);

defG(' ', 0.32, []);
defG('.', 0.32, [box(0.045, 1 - gST, 0.045 + gST, 1)]);
defG(',', 0.32, [cw([[0.045, 1 - gST], [0.045 + gST, 1 - gST], [0.045 + gST, 1], [0.015, 1.18]])]);
defG(':', 0.32, [box(0.045, 0.36, 0.045 + gST, 0.36 + gST), box(0.045, 1 - gST, 0.045 + gST, 1)]);
defG('-', 0.54, [box(0.04, 0.50 - gBT / 2, 0.46, 0.50 + gBT / 2)]);
defG('/', 0.58, [hbar(0.48, -0.04, 0.06, 1.04, 0.16)]);
defG('°', 0.44, ring(0.19, 0.17, 0.17, 0.17, 0.10));
defG('+', 0.74, [box(0.34 - gBT / 2, 0.22, 0.34 + gBT / 2, 0.78), box(0.06, 0.50 - gBT / 2, 0.62, 0.50 + gBT / 2)]);
defG('!', 0.32, [box(0.045, 0, 0.045 + gST, 0.70), box(0.045, 1 - gST, 0.045 + gST, 1)]);
defG('%', 0.96, [
  hbar(0.74, 0, 0.16, 1, 0.165),
  ...ring(0.19, 0.19, 0.19, 0.19, 0.115), ...ring(0.71, 0.81, 0.19, 0.19, 0.115),
]);
defG('×', 0.66, [hbar(0.14, 0.26, 0.48, 0.80, 0.155), hbar(0.48, 0.26, 0.14, 0.80, 0.155)]);

const NOTDEF = { a: 0.72, ox: 0, c: [box(0.04, 0.06, 0.64, 0.06 + 0.10), box(0.04, 0.90, 0.64, 1.0), box(0.04, 0.06, 0.14, 1.0), box(0.54, 0.06, 0.64, 1.0)] };

/** Optical kerning for the pairs that actually hurt in a condensed italic face. */
const KERN = {
  AV: -0.07, AW: -0.06, AY: -0.07, AT: -0.06, VA: -0.07, WA: -0.06, YA: -0.07, TA: -0.06,
  LT: -0.07, LV: -0.07, LW: -0.06, LY: -0.07, PA: -0.06, FA: -0.06, RT: -0.03, RV: -0.04, RY: -0.04,
  KO: -0.02, LO: -0.02, OA: -0.02, AO: -0.02, DA: -0.02, VO: -0.03, OV: -0.03, OW: -0.03, WO: -0.03,
  'T.': -0.09, 'V.': -0.07, 'Y.': -0.08, 'F.': -0.07, 'P.': -0.07, 'L.': -0.05, 'T,': -0.09, 'W.': -0.06,
  To: -0.07, Ta: -0.07, Te: -0.06, Tr: -0.05, Yo: -0.06, Ya: -0.06, Vo: -0.05, Wa: -0.05, Pe: -0.03,
  'r.': -0.05, 'v.': -0.06, 'y.': -0.06, 'w.': -0.05, ry: -0.02, rt: -0.02,
};

/**
 * Optical kerning for the geometric face. Circular bowls open up more space beside a diagonal than
 * the display face's ovals do, so the diagonal pairs need a firmer pull and the round/round pairs
 * a small one.
 */
const KERN_GEO = {
  AV: -0.055, AW: -0.05, AY: -0.06, AT: -0.05, VA: -0.055, WA: -0.05, YA: -0.06, TA: -0.05,
  LT: -0.06, LV: -0.055, LW: -0.05, LY: -0.06, PA: -0.05, FA: -0.05, RT: -0.025, RV: -0.03, RY: -0.035,
  LO: -0.025, OA: -0.02, AO: -0.02, DA: -0.02, VO: -0.03, OV: -0.03, OW: -0.025, WO: -0.025,
  OX: -0.02, XO: -0.02, CO: -0.015, OC: -0.015, GO: -0.015, OO: -0.012, DO: -0.015, OD: -0.015,
  'T.': -0.08, 'V.': -0.06, 'Y.': -0.07, 'F.': -0.06, 'P.': -0.06, 'L.': -0.045, 'W.': -0.05,
  To: -0.06, Ta: -0.06, Te: -0.05, Tr: -0.045, Yo: -0.055, Ya: -0.055, Vo: -0.045, Wa: -0.045,
  'r.': -0.045, 'v.': -0.05, 'y.': -0.05, 'w.': -0.045, ry: -0.02, rt: -0.02, rn: -0.015,
};

/**
 * The face registry. `base` is the stem weight the outlines are cut at; drawText's `weight`
 * expands from there with a mitred pen, so each face has its own natural regular.
 */
const FACES = {
  display: { tab: G, kern: KERN, base: BASE_WEIGHT },
  geo: { tab: GEO, kern: KERN_GEO, base: gST },
};

function faceOf(name) { return FACES[name] || FACES.display; }

function glyph(ch, face) {
  const t = face.tab;
  const g = t[ch] || t[ch.toUpperCase()] || t[ch.toLowerCase()];
  if (g) return g;
  // rare symbols (arrows, @, brackets) exist only in the display master — borrow rather than notdef
  return G[ch] || G[ch.toUpperCase()] || G[ch.toLowerCase()] || NOTDEF;
}

// ---------------------------------------------------------------- layout

function layout(text, size, tracking, smallCaps, faceName) {
  const face = faceOf(faceName);
  const items = [];
  let x = 0;
  let prev = null;
  for (const ch of text) {
    const small = smallCaps && ch >= 'a' && ch <= 'z';
    const key = small ? ch.toUpperCase() : ch;
    const g = glyph(key, face);
    const h = small ? size * 0.78 : size;
    if (prev !== null) {
      const k = face.kern[prev + ch];
      if (k) x += k * size;
    }
    items.push({ g, h, x });
    x += g.a * h + tracking * size;
    prev = ch;
  }
  const width = Math.max(0, x - tracking * size);
  return { items, width };
}

/**
 * Measure a string.
 * @param o.face 'display' (NITRO, default) or 'geo' (CIRCUIT)
 * @returns {{width:number, height:number}} in pixels
 */
export function measure(text, { size = 32, tracking = 0.08, smallCaps = false, face = 'display' } = {}) {
  return { width: layout(String(text), size, tracking, smallCaps, face).width, height: size };
}

// Path cache — glyph outlines are static, so a string's Path2D is reusable frame to frame.
const PATHS = new Map();
const PATH_CAP = 320;

/**
 * Build (or fetch) the outline of `text` anchored at x=0, baseline y=0.
 *
 * Returns two paths. `path` is every contour, filled under the nonzero rule — the glyph as cut.
 * `outer` is the clockwise contours only, i.e. the silhouette without its counters. All pen work
 * (weight expansion, outline, glow, bevel) strokes `outer`, never `path`: stroking the counters
 * too would grow them *inward* and choke the bowls — at 50 px and weight 0.215 the 8's counters
 * close into slits, and a dark outline layer would flood every counter with ink behind the fill.
 */
function textPath(text, size, italic, tracking, smallCaps, faceName) {
  const key = `${faceName}|${text}|${size}|${italic}|${tracking}|${smallCaps ? 1 : 0}`;
  const hit = PATHS.get(key);
  if (hit) return hit;
  const { items, width } = layout(text, size, tracking, smallCaps, faceName);
  const path = new Path2D();
  const outer = new Path2D();
  for (const { g, h, x } of items) {
    for (const c of g.c) {
      const solid = area(c) > 0;                           // clockwise → ink, not a counter
      for (let i = 0; i < c.length; i++) {
        const gy = (c[i][1] - 1) * h;                      // baseline at 0
        const px = x + (g.ox + c[i][0]) * h - gy * italic; // italic shear, pivoting on the baseline
        if (i === 0) { path.moveTo(px, gy); if (solid) outer.moveTo(px, gy); }
        else { path.lineTo(px, gy); if (solid) outer.lineTo(px, gy); }
      }
      path.closePath();
      if (solid) outer.closePath();
    }
  }
  const rec = { path, outer, width };
  if (PATHS.size > PATH_CAP) PATHS.clear();
  PATHS.set(key, rec);
  return rec;
}

/**
 * Draw text in the NITRO face.
 *
 * @param ctx Canvas2D context
 * @param text string
 * @param o.x,o.y            anchor (y is the BASELINE)
 * @param o.size             cap height in px
 * @param o.weight           stem width as a fraction of size (0.165 is the master; heavier expands)
 * @param o.italic           shear in x per unit y (0.22 ≈ the reference's aggressive lean)
 * @param o.tracking         extra advance per glyph, fraction of size
 * @param o.align            'left'|'center'|'right'
 * @param o.color            fill colour, or a function(ctx,w,h,ox,y)=>fillStyle for gradients
 * @param o.outline          {color, width} drawn behind for legibility over bright scenes
 * @param o.glow             {color, blur} outer glow
 * @param o.bevel            true → light top edge + dark bottom edge (metallic arcade look)
 * @param o.sheen            true → clipped highlight sweep across the upper half
 * @param o.smallCaps        true → lowercase renders as 78% caps instead of real lowercase
 * @param o.face             'display' (NITRO italic master) or 'geo' (CIRCUIT upright geometric)
 */
export function drawText(ctx, text, o = {}) {
  const {
    x = 0, y = 0, size = 32, italic = 0, tracking = 0.08,
    align = 'left', color = '#ffffff', outline = null, glow = null,
    bevel = false, sheen = false, smallCaps = false, alpha = 1, shadow = null,
    face = 'display',
  } = o;
  const base = faceOf(face).base;
  const weight = o.weight ?? base;
  const str = String(text);
  const { path, outer, width } = textPath(str, size, italic, tracking, smallCaps, face);

  let ox = x;
  if (align === 'center') ox = x - width / 2;
  else if (align === 'right') ox = x - width;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(ox, y);
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 2.4;

  const grow = Math.max(0, (weight - base) * size) * 2;          // pen width for heavier weights

  const paint = (style, extra = 0, dx = 0, dy = 0, blur = 0) => {
    ctx.save();
    if (dx || dy) ctx.translate(dx, dy);
    if (blur) { ctx.shadowBlur = blur; ctx.shadowColor = style; }
    ctx.fillStyle = style;
    ctx.fill(path);
    const lw = grow + extra;
    if (lw > 0.01) { ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.stroke(outer); }
    ctx.restore();
  };

  if (shadow) paint(shadow.color, 0, shadow.dx ?? 0, shadow.dy ?? size * 0.06, shadow.blur ?? 0);
  if (glow) paint(glow.color, 0, 0, 0, glow.blur || size * 0.5);
  if (outline) paint(outline.color, (outline.width ?? size * 0.10) * 2);
  if (bevel) {
    paint('rgba(0,0,0,0.55)', 0, size * 0.032, size * 0.045);
    paint('rgba(255,255,255,0.70)', 0, -size * 0.028, -size * 0.040);
  }

  let fill = color;
  if (typeof color === 'function') fill = color(ctx, width, size, 0, 0);
  paint(fill);

  if (sheen) {
    ctx.save();
    if (grow > 0.01) { ctx.lineWidth = grow; ctx.strokeStyle = 'rgba(0,0,0,0)'; }
    ctx.clip(path);
    const g = ctx.createLinearGradient(0, -size, 0, size * 0.12);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.0)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(-size, -size * 1.3, width + size * 2, size * 1.8);
    ctx.restore();
  }

  ctx.restore();
  return { width, height: size };
}

/** Vertical gradient helper for chrome / neon fills. Pass as `color`. */
export function gradientFill(stops) {
  return (ctx, w, h, ox, y) => {
    const g = ctx.createLinearGradient(0, y - h, 0, y + h * 0.12);
    for (const [t, c] of stops) g.addColorStop(t, c);
    return g;
  };
}

/** Path of a string, anchored at (0, baseline) — for clipping or custom paint. */
export function textOutline(text, o = {}) {
  const { size = 32, italic = 0, tracking = 0.08, smallCaps = false, face = 'display' } = o;
  return textPath(String(text), size, italic, tracking, smallCaps, face);
}

// ------------------------------------------------------------------ seven segment

//        a
//      f   b
//        g
//      e   c
//        d
const SEG = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd', '-': 'g', ' ': '',
};

const DW = 0.62;                       // digit ink width, in cap-height units
const SW = 0.115;                      // segment thickness
const h2 = SW / 2;
// Tapered hexagonal segments — the mitred ends are what make it read as a real display.
const hseg = (x0, x1, y) => [[x0, y], [x0 + h2, y - h2], [x1 - h2, y - h2], [x1, y], [x1 - h2, y + h2], [x0 + h2, y + h2]];
const vseg = (x, y0, y1) => [[x, y0], [x + h2, y0 + h2], [x + h2, y1 - h2], [x, y1], [x - h2, y1 - h2], [x - h2, y0 + h2]];
const SEGPTS = {
  a: hseg(0.10, DW - 0.10, 0.055),
  b: vseg(DW - 0.055, 0.115, 0.445),
  c: vseg(DW - 0.055, 0.555, 0.885),
  d: hseg(0.10, DW - 0.10, 0.945),
  e: vseg(0.055, 0.555, 0.885),
  f: vseg(0.055, 0.115, 0.445),
  g: hseg(0.10, DW - 0.10, 0.50),
};

/**
 * Seven-segment display (the reference's red countdown clock and cyan lap timer).
 * Unlit segments are drawn at low alpha so the display reads as physical hardware.
 */
export function drawSevenSeg(ctx, text, {
  x = 0, y = 0, size = 40, color = '#ff2e2e', dim = 0.12, tracking = 0.20,
  italic = 0.06, glow = 10, align = 'left', alpha = 1, dimColor = null,
} = {}) {
  const str = String(text);
  const digitW = size * DW;
  const adv = digitW + size * tracking;
  const punct = size * 0.36;
  let total = 0;
  for (const ch of str) total += (ch === ':' || ch === '.') ? punct : adv;
  total -= size * tracking;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;

  ctx.save();
  ctx.globalAlpha = alpha;
  const off = dimColor || color;

  const map = (p) => {
    const gy = (p[1] - 1) * size;
    return [cx + p[0] * size - gy * italic, y + gy];
  };

  for (const ch of str) {
    if (ch === ':' || ch === '.') {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color; ctx.shadowBlur = glow; ctx.shadowColor = color;
      const r = size * 0.058;
      const dot = (yy) => {
        const gy = (yy - 1) * size;
        ctx.beginPath();
        ctx.arc(cx + size * 0.10 - gy * italic, y + gy, r, 0, TAU);
        ctx.fill();
      };
      if (ch === ':') { dot(0.34); dot(0.72); } else dot(0.96);
      ctx.shadowBlur = 0;
      cx += punct;
      continue;
    }
    const on = SEG[ch] ?? SEG[' '];
    for (const s of Object.keys(SEGPTS)) {
      const lit = on.includes(s);
      ctx.globalAlpha = alpha * (lit ? 1 : dim);
      ctx.fillStyle = lit ? color : off;
      ctx.shadowBlur = lit ? glow : 0;
      ctx.shadowColor = color;
      const pts = SEGPTS[s];
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [px, py] = map(pts[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    cx += adv;
  }
  ctx.restore();
}

/** Width of a seven-segment string, for layout. */
export function measureSevenSeg(text, { size = 40, tracking = 0.20 } = {}) {
  let total = 0;
  for (const ch of String(text)) total += (ch === ':' || ch === '.') ? size * 0.36 : size * DW + size * tracking;
  return Math.max(0, total - size * tracking);
}

/** Render text to a standalone transparent CanvasTexture (for 3D signage, decals, banners). */
export function textCanvas(text, o = {}) {
  const size = o.size || 64;
  const pad = size * 0.6;
  const m = measure(text, { size, tracking: o.tracking ?? 0.08, smallCaps: o.smallCaps, face: o.face });
  const c = document.createElement('canvas');
  c.width = Math.max(4, Math.ceil(m.width + pad * 2 + size * (o.italic || 0)));
  c.height = Math.ceil(size * 1.9 + pad);
  const ctx = c.getContext('2d');
  drawText(ctx, text, { ...o, x: pad, y: size * 1.25, size });
  return c;
}
