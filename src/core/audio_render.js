/**
 * Offline audio rendering for the audio critic (ART_DIRECTION.md §6.9 is judged by LISTENING to
 * captured WAV renders).
 *
 * This used to hold a SECOND copy of the engine automation, because an OfflineAudioContext's
 * currentTime stays at 0 until rendering begins and the live code path scheduled everything at
 * `ctx.currentTime`. Two copies means the WAV the critic hears can silently drift away from what
 * a player hears — so the voices in core/audio.js now take an explicit time on every call and the
 * renderer lives next to them. This file is a re-export so `window.__GAME.renderAudio()` keeps
 * working.
 *
 * Clip kinds: engine | idle | nitrous | impact | squeal | music | ambience | mix
 */
export { renderClip, renderClipBase64 } from './audio.js';
