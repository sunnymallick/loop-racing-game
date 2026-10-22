/**
 * Entry point. Puts the loading plate up FIRST, from a chunk that carries nothing but the plate and
 * the glyph tables, and only then pulls in the game — two megabytes of module that used to leave the
 * page a black rectangle until it had downloaded, evaluated and built an entire city.
 *
 * The harness (`?shot`) never sees the plate: its captures are of the game, and a capture taken
 * with an overlay on top would be a capture of the overlay.
 */
import { loading } from './ui/loading.js';

if (!new URLSearchParams(location.search).has('shot')) {
  loading.show({ label: 'LOADING THE GAME', instant: true });
}

import('./main.js').catch((e) => {
  // main.js reports its own boot failures on __READY; this is the module failing to arrive at all
  window.__ERRORS = window.__ERRORS || [];
  window.__ERRORS.push(`BOOT: ${e?.stack || e}`);
  window.__READY = 'error';
  loading.set(NaN, 'FAILED TO LOAD - RELOAD THE PAGE');
});
