import * as tuner from './tuner.js';
import * as muscle from './muscle.js';
import * as suv from './suv.js';
import * as supercar from './supercar.js';
import { getHandling } from './handling.js';
import { getNitro } from './nitrous.js';
import { getAudioProfile } from './audio_tuning.js';

/**
 * Vehicle registry.
 *
 * A vehicle's SPEC is assembled here from four independently-owned sources, so four builders can
 * work at once without ever editing the same file:
 *
 *   identity + geometry  → tuner.js / muscle.js / suv.js / supercar.js   (vehicle-art piece)
 *   physics              → handling.js                                   (handling piece)
 *   nitrous              → nitrous.js NITRO table                        (nitrous piece)
 *   engine voicing       → audio_tuning.js                               (audio piece)
 *
 * Do not put handling, nitrous or audio numbers back into the car files.
 */
export const VEHICLES = { tuner, muscle, suv, supercar };
export const VEHICLE_IDS = ['tuner', 'muscle', 'suv', 'supercar'];

const _specs = new Map();

export function getVehicle(id) {
  const v = VEHICLES[id];
  if (!v) throw new Error(`Unknown vehicle "${id}". Valid: ${VEHICLE_IDS.join(', ')}`);
  if (!_specs.has(id)) {
    const spec = {
      ...v.spec,
      physics: getHandling(id),
      nitro: getNitro(id),
      audio: getAudioProfile(id),
    };
    _specs.set(id, spec);
    // keep the blueprint's back-reference in sync so assemble.js sees the merged spec
    if (v.blueprint) v.blueprint.spec = spec;
    v.spec.physics = spec.physics;
    v.spec.nitro = spec.nitro;
    v.spec.audio = spec.audio;
  }
  return { ...v, spec: _specs.get(id) };
}

export function buildVehicle(id, opts) {
  getVehicle(id);            // force spec merge before the blueprint is read
  return VEHICLES[id].build(opts);
}

export const SPECS = () => VEHICLE_IDS.map((id) => getVehicle(id).spec);
