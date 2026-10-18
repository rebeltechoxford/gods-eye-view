// Car routing rules for OpenStreetMap ways: which ways a car may use, in
// which directions, and how fast. Portable; shared by the road-pack builder
// and tests. The rules follow common OSM tagging and the conventions of the
// OSRM car profile (implied oneway for motorways and roundabouts, access
// overrides), simplified: no turn restrictions, ferries or time conditions.

/** Road classes in pack order. Index is stored per road record. */
export const ROAD_CLASSES = Object.freeze([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
]);

/** Free-flow speed without a usable maxspeed tag, km/h. */
export const DEFAULT_SPEEDS_KMH = Object.freeze({
  motorway: 105,
  motorway_link: 60,
  trunk: 90,
  trunk_link: 50,
  primary: 80,
  primary_link: 45,
  secondary: 70,
  secondary_link: 40,
  tertiary: 60,
  tertiary_link: 35,
  unclassified: 50,
  residential: 35,
  living_street: 15,
  service: 20,
});

/** Posted limits are not travel speeds; scale them toward realistic averages. */
export const MAXSPEED_FACTOR = 0.9;
export const MAX_SPEED_KMH = 130;

const CLASS_INDEX = new Map(ROAD_CLASSES.map((name, index) => [name, index]));
const DENIED = new Set([
  'no',
  'private',
  'agricultural',
  'forestry',
  'delivery',
  'emergency',
  'military',
]);
const ALLOWED = new Set(['yes', 'permissive', 'designated', 'destination']);
const EXCLUDED_SERVICE = new Set(['emergency_access', 'parking_aisle']);

function accessFor(tags) {
  // Most specific mode wins: motorcar > motor_vehicle > vehicle > access.
  for (const key of ['motorcar', 'motor_vehicle', 'vehicle', 'access']) {
    const value = tags[key];
    if (value === undefined) continue;
    if (ALLOWED.has(value)) return true;
    if (DENIED.has(value)) return false;
  }
  return true;
}

/** Parse an OSM maxspeed value ("45 mph", "80", "50 km/h") to km/h, or null. */
export function parseMaxspeedKmh(value) {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(
    value,
  );
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  const kmh = match[2]?.toLowerCase() === 'mph' ? number * 1.609344 : number;
  return kmh > 200 ? null : kmh;
}

function onewayFor(tags, highway) {
  const value = tags.oneway;
  if (value === 'yes' || value === 'true' || value === '1')
    return { forward: true, backward: false };
  if (value === '-1' || value === 'reverse')
    return { forward: false, backward: true };
  if (value === 'reversible' || value === 'alternating') return null;
  if (value === 'no' || value === 'false' || value === '0')
    return { forward: true, backward: true };
  const junction = tags.junction;
  if (
    highway === 'motorway' ||
    junction === 'roundabout' ||
    junction === 'circular'
  )
    return { forward: true, backward: false };
  return { forward: true, backward: true };
}

function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Car attributes of one OSM way, or null when a car may not use it.
 * @param {Record<string,string>} tags
 * @returns {null|{classIndex:number, speedKmh:number, forward:boolean,
 *   backward:boolean, roundabout:boolean, name:string, ref:string}}
 */
export function carRoad(tags) {
  const highway = tags?.highway;
  const classIndex = CLASS_INDEX.get(highway);
  if (classIndex === undefined) return null;
  if (tags.area === 'yes' || tags.impassable === 'yes') return null;
  if (highway === 'service' && EXCLUDED_SERVICE.has(tags.service)) return null;
  if (!accessFor(tags)) return null;
  const direction = onewayFor(tags, highway);
  if (!direction) return null;
  const posted = parseMaxspeedKmh(tags.maxspeed);
  const speedKmh = Math.min(
    MAX_SPEED_KMH,
    posted ? posted * MAXSPEED_FACTOR : DEFAULT_SPEEDS_KMH[highway],
  );
  return {
    classIndex,
    speedKmh,
    forward: direction.forward,
    backward: direction.backward,
    roundabout: tags.junction === 'roundabout' || tags.junction === 'circular',
    name: text(tags.name),
    ref: text(tags.ref, 60),
  };
}

/** Whether a class is a ramp (link) road, for on/off-ramp maneuvers. */
export function isLinkClass(classIndex) {
  return ROAD_CLASSES[classIndex]?.endsWith('_link') === true;
}
