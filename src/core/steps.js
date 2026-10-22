/**
 * COOPERATIVE LOADING — how a synchronous build learns to report progress.
 *
 * Every heavy thing this game does at load time (a city, the garage, a grid of opponents, the
 * shader programs for all of it) used to run as ONE task: measured on the real GPU, boot was a
 * single 8 s block and confirming a destination a single 6–12 s block. Nothing can paint inside a
 * task, so no loading screen could ever have moved.
 *
 * The fix is to write those builds as GENERATORS that `yield` a step at each natural boundary:
 *
 *     yield { p: 0.4, label: 'PAVING THE CIRCUIT' };
 *
 * `p` is how far through ITS OWN generator the work is (0..1); `span()` maps a sub-generator into a
 * slice of its parent, so a city build can sit inside a boot without knowing about it. A step with
 * `wait: true` asks for the frame to be handed back right now — that is how the shader compile
 * polls the GPU process without spinning.
 *
 * Two drivers run the same generator:
 *   - `drive()` hands the browser a frame whenever a time budget is spent, so the loading screen
 *     animates and its bar moves;
 *   - `runSync()` runs it straight through in one task, exactly as the old code did. The headless
 *     harness (`?shot`) uses this so every capture stays the deterministic, single-task build it
 *     always was. The two drivers execute identical code in identical order — only the gaps differ.
 */

/** Run a step generator to completion in this task and return its result. */
export function runSync(gen) {
  let it = gen.next();
  while (!it.done) {
    if (it.value?.wait) throw new Error('runSync: a step asked to wait — that generator needs drive()');
    it = gen.next();
  }
  return it.value;
}

/**
 * Run a step generator, yielding to the browser between steps so it can paint.
 *
 * @param onStep  called with every step `{ p, label }` as it arrives
 * @param budget  ms of work to batch before handing back a frame. Steps are coarse (most are tens
 *                to hundreds of ms on their own), so in practice this yields at nearly every one.
 */
export async function drive(gen, onStep = null, { budget = 12 } = {}) {
  let t0 = performance.now();
  let it = gen.next();
  while (!it.done) {
    const s = it.value;
    if (s && onStep) onStep(s);
    if (s?.wait || performance.now() - t0 > budget) {
      await nextFrame();
      t0 = performance.now();
    }
    it = gen.next();
  }
  return it.value;
}

/** Re-map a sub-generator's progress into [a, b] of its parent. Returns the sub-generator's value. */
export function* span(a, b, gen) {
  let it = gen.next();
  while (!it.done) {
    const s = it.value || {};
    yield { ...s, p: a + (b - a) * Math.min(1, Math.max(0, s.p ?? 0)) };
    it = gen.next();
  }
  return it.value;
}

/**
 * Resolve after the next frame has been painted.
 *
 * rAF then a macrotask: the timeout queued inside the rAF callback runs after that frame's render
 * step, so whatever the loading screen drew in the same rAF is on screen. The 100 ms fallback is for
 * a backgrounded tab, where rAF stops entirely — a load started and then tabbed away from must
 * still finish rather than wait for the player to come back.
 */
export function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}
