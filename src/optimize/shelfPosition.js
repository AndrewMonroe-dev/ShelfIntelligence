// Vertical shelf-position scoring, per docs/BUSINESS_RULES.md "Shelf position scoring".

export const ZONE_INDEX = { above: 0.9, eye: 1.5, belowEye: 1.2, bottom: 0.6 };
export const TRAFFIC_MULTIPLIER = { high: 1.2, medium: 1.0, low: 0.8 };

// Fixed 4-zone map for >=4 shelves; extra shelves beyond 4 go to bottom first,
// per the documented table (4/5/6-shelf examples). For section shelf counts
// below 4 -- not covered by the original spec, since sections can now have
// their own shelf counts independent of the store's overall fixture -- we
// keep the two highest-value zones (eye, belowEye) first, since those carry
// the most weight, then add bottom, then above, dropping least first.
const SUB_FOUR_ORDER = ['eye', 'belowEye', 'bottom', 'above'];

export function buildZoneMap(shelfCount) {
  if (shelfCount <= 0) return [];
  if (shelfCount >= 4) {
    const zones = ['above', 'eye', 'belowEye', 'bottom'];
    for (let i = 4; i < shelfCount; i++) zones.push('bottom');
    return zones.map((zone) => ({ zone, verticalIndex: ZONE_INDEX[zone] }));
  }
  return SUB_FOUR_ORDER.slice(0, shelfCount).map((zone) => ({ zone, verticalIndex: ZONE_INDEX[zone] }));
}

export function trafficMultiplier(trafficLevel) {
  return TRAFFIC_MULTIPLIER[trafficLevel] ?? TRAFFIC_MULTIPLIER.medium;
}

// Real store fixture data (data/stores.json shelfLayout.shelves) defines
// traffic per physical shelf position top-to-bottom. A section may have a
// different shelf count than the store's base fixture, so we reuse the
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
