import fs from 'node:fs';
import path from 'node:path';

function readWav(file) {
  const b = fs.readFileSync(file);
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24);
  let off = 12, dataSz = 0;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; dataSz = sz; break; }
    off += 8 + sz;
  }
  const n = Math.floor(dataSz / 2 / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + i * ch * 2) / 32768;
  return { sr, n, x };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const c = Math.cos(ang * k), s = Math.sin(ang * k);
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
      const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
    }
  }
}
function mags(x, start, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = (x[start + i] || 0) * w; }
  fft(re, im);
  const m = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}
// harmonic-product-spectrum style f0 search over candidate fundamentals
function trackF0(x, start, N, sr, lo = 18, hi = 160) {
  const m = mags(x, start, N);
  const bin = (f) => Math.round(f * N / sr);
  let best = -1, bestF = 0;
  for (let f = lo; f <= hi; f += 0.25) {
    let s = 0, cnt = 0;
    for (let h = 1; h <= 14; h++) {
      const b = bin(f * h);
      if (b >= m.length - 1) break;
      s += Math.max(m[b - 1], m[b], m[b + 1]); cnt++;
    }
    s /= cnt;
    if (s > best) { best = s; bestF = f; }
  }
  return bestF;
}
const mode = process.argv[2];
const files = process.argv.slice(3);
for (const file of files) {
  const { sr, n, x } = readWav(file);
  const name = path.basename(file);
  if (mode === 'rpm') {
    const N = 8192, hop = Math.floor(sr * 0.1);
    const out = [];
    for (let s = 0; s + N < n; s += hop) {
      let r = 0; for (let i = 0; i < N; i++) r += x[s + i] ** 2; r = Math.sqrt(r / N);
      out.push(`${(s / sr).toFixed(1)}s ${trackF0(x, s, N, sr).toFixed(1)}Hz/${(20 * Math.log10(r + 1e-9)).toFixed(0)}dB`);
    }
    console.log(`\n${name}\n  ` + out.join('  '));
  } else if (mode === 'harm') {
    const t = Number(process.argv[process.argv.length - 1]);
    const start = Math.floor(sr * 2.6), N = 16384;
    const m = mags(x, start, N);
    const f0v = trackF0(x, start, N, sr);
    let peak = 0; for (let i = 1; i < m.length; i++) peak = Math.max(peak, m[i]);
    const rows = [];
    for (let h = 1; h <= 16; h++) {
      const b = Math.round(f0v * h * N / sr);
      if (b >= m.length) break;
      const v = Math.max(m[b - 1] || 0, m[b], m[b + 1] || 0);
      rows.push(`h${h}@${Math.round(f0v * h)}Hz ${(20 * Math.log10(v / peak + 1e-9)).toFixed(0)}`);
    }
    // band energies
    const bands = [[0, 100], [100, 300], [300, 800], [800, 2000], [2000, 6000], [6000, 22050]];
    const be = bands.map(([a, b2]) => {
      let s = 0; for (let i = Math.round(a * N / sr); i < Math.round(b2 * N / sr) && i < m.length; i++) s += m[i] * m[i];
      return s;
    });
    const tot = be.reduce((a, b) => a + b, 0) + 1e-12;
    console.log(`\n${name} @2.6s f0=${f0v.toFixed(1)}Hz (~${Math.round(f0v * 60)} rpm crank)`);
    console.log('  harmonics(dB rel peak): ' + rows.join(' '));
    console.log('  band%: ' + bands.map((b, i) => `${b[0]}-${b[1]}:${(100 * be[i] / tot).toFixed(1)}`).join(' '));
    void t;
  }
}
