// Vertical shelf-position scoring, per docs/BUSINESS_RULES.md "Shelf position scoring".

export const ZONE_INDEX = { above: 0.9, eye: 1.5, belowEye: 1.2, belowWaist: 0.8, bottom: 0.6 };
export const TRAFFIC_MULTIPLIER = { high: 1.2, medium: 1.0, low: 0.8 };

// The fixture is physically built from 4ft bays, not a continuous ribbon --
// every bay is exactly this wide, and each bay owns its own shelf count.
export const BAY_WIDTH_FT = 4;

export function getPhysicalWidthFt(shelfLayout) {
  return shelfLayout.bays.length * BAY_WIDTH_FT;
}

export function getLinearShelfFeet(shelfLayout) {
  return shelfLayout.bays.reduce((sum, bay) => sum + BAY_WIDTH_FT * bay.shelfCount, 0);
}

export function getBayForPosition(shelfLayout, ft) {
  let cursor = 0;
  for (const bay of shelfLayout.bays) {
    if (ft < cursor + BAY_WIDTH_FT) return bay;
    cursor += BAY_WIDTH_FT;
  }
  return shelfLayout.bays[shelfLayout.bays.length - 1];
}

// A section's shelf rows come from whichever bay covers its horizontal
// center -- a section spanning bays of different shelf counts renders using
// that one bay's count rather than a blend (see docs/plan notes).
export function getShelvesForSpan(shelfLayout, startFt, widthFt) {
  return getBayForPosition(shelfLayout, startFt + widthFt / 2).shelves;
}

// Fixed 4-zone map for >=4 shelves; extra shelves beyond 4 go to bottom first,
// per the documented table (4/5/6-shelf examples). For section shelf counts
// below 4 -- not covered by the original spec, since sections can now have
// their own shelf counts independent of the store's overall fixture -- we
// keep the two highest-value zones (eye, belowEye) first, since those carry
// the most weight, then add bottom, then above, dropping least first.
const SUB_FOUR_ORDER = ['eye', 'belowEye', 'bottom', 'above'];

export function buildZoneMap(shelfCount) {
  if (shelfCount <= 0) return [];
  // Andrew, 2026-07-17: a 4-shelf bay has no shelf ABOVE eye level -- the
  // top shelf itself IS the best-selling/eye-level position. "above" only
  // makes sense once a 5th shelf exists above eye level.
  if (shelfCount === 4) {
    const zones = ['eye', 'belowEye', 'belowWaist', 'bottom'];
    return zones.map((zone) => ({ zone, verticalIndex: ZONE_INDEX[zone] }));
  }
  if (shelfCount >= 5) {
    const zones = ['above', 'eye', 'belowEye', 'bottom'];
    for (let i = 4; i < shelfCount; i++) zones.push('bottom');
    return zones.map((zone) => ({ zone, verticalIndex: ZONE_INDEX[zone] }));
  }
  return SUB_FOUR_ORDER.slice(0, shelfCount).map((zone) => ({ zone, verticalIndex: ZONE_INDEX[zone] }));
}

export function trafficMultiplier(trafficLevel) {
  return TRAFFIC_MULTIPLIER[trafficLevel] ?? TRAFFIC_MULTIPLIER.medium;
}

// Real store fixture data (data/stores.json shelfLayout.bays[].shelves)
// defines traffic per physical shelf position top-to-bottom within a bay.
// A section's shelf count comes from whichever bay it spans, so we reuse the
// store's traffic profile by position, repeating the last known value for
// any additional shelves beyond what the store data defines.
export function trafficProfileForSection(storeShelves, shelfCount) {
  const profile = [];
  for (let i = 0; i < shelfCount; i++) {
    const storeShelf = storeShelves[i] || storeShelves[storeShelves.length - 1];
    profile.push(storeShelf ? storeShelf.traffic : 'medium');
  }
  return profile;
}

export function buildSectionShelves(storeShelves, shelfCount) {
  const zoneMap = buildZoneMap(shelfCount);
  const traffic = trafficProfileForSection(storeShelves, shelfCount);
  return zoneMap.map((z, i) => ({
    position: i + 1,
    zone: z.zone,
    verticalIndex: z.verticalIndex,
    traffic: traffic[i],
    trafficMultiplier: trafficMultiplier(traffic[i]),
    shelfScore: z.verticalIndex * trafficMultiplier(traffic[i]),
  }));
}
