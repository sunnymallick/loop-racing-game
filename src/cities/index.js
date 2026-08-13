import * as la from './losangeles.js';
import * as vegas from './lasvegas.js';
import * as miami from './miami.js';
import * as nyc from './newyork.js';

export const CITIES = { la, vegas, miami, nyc };
export const CITY_IDS = ['la', 'vegas', 'miami', 'nyc'];

export function getCity(id) {
  const c = CITIES[id];
  if (!c) throw new Error(`Unknown city "${id}". Valid: ${CITY_IDS.join(', ')}`);
  return c;
}

export function buildCityById(id, opts) { return getCity(id).build(opts); }

export const CITY_DEFS = CITY_IDS.map((id) => CITIES[id].def);
