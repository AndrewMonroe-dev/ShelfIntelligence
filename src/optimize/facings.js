// Facings allocation per docs/BUSINESS_RULES.md item 6: floor of 1 facing per
// SKU, remaining linear space distributed proportionally to score, converted
// to a facing count using real bottle width from data/bottleDimensions.json.

// data/bottleDimensions.json (2026-07-16 rewrite) holds Andrew's own
// corrected measurements, keyed by the EXACT bottleSizeRaw string ("0.75LT",
// "0.187LT X4", etc.) -- sourced from
// "docs/Suggested Measurements of wine sizes.xlsx" (moved here from the vault 2026-07-23; was D:\Jarvis\...), not derived or
// estimated. No per-size mapping table needed anymore: bottleSizeRaw *is*
// the dimension type. A size with no entry (e.g. the single-SKU "0.72LT")
// falls back to a generic width rather than guessing a specific shape.
const FALLBACK_WIDTH_IN = 3.1; // matches the measured 0.75LT width -- used only when a raw size has no dimension entry at all

export function bottleWidthInches(sku, bottleDimensions) {
  const dim = bottleDimensions.find((d) => d.type === sku.bottleSizeRaw);
  return dim ? dim.widthIn : FALLBACK_WIDTH_IN;
}

// Given a category's SKUs already ranked in fill order, returns the
// longest PREFIX that fits within widthInches at floorFacings each -- this
// is what decides how many DISTINCT SKUs populate a row, before
// computeFacings spends any leftover width as bonus facings on that same
// prefix. Always includes at least one SKU (if the pool is non-empty and
// width > 0) even if it alone exceeds the budget, consistent with the
// "never leave a row artificially empty" philosophy below.
export function fitSkusToWidth(rankedSkus, widthInches, bottleDimensions, floorFacings) {
  const included = [];
  let used = 0;
  for (const sku of rankedSkus) {
    const w = bottleWidthInches(sku, bottleDimensions) * floorFacings;
    if (used + w > widthInches && included.length > 0) break;
    included.push(sku);
    used += w;
  }
  return included;
}

// Guarantees a section's full allocated width is always consumed -- "no set
// should have empty space." Gives every SKU a floor of 1 facing, then
// repeatedly awards the NEXT facing to whichever SKU is furthest below its
// fair score-proportional share (a standard largest-remainder apportionment
// approach), until no remaining SKU's bottle width fits in the leftover
// space. As sets get larger relative to SKU count, facings scale up to fill
// the space rather than leaving it empty.
export function computeFacings(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions, floorFacings = 1, maxFacings = Infinity) {
  if (!sectionSkus.length) return [];
  const sectionInches = sectionLinearFeet * 12;
  const widths = sectionSkus.map((sku) => bottleWidthInches(sku, bottleDimensions));
  const scores = sectionSkus.map((sku) => scoreMap.get(sku.skuId)?.score ?? 0);
  const totalScore = scores.reduce((a, b) => a + b, 0) || 1;

  const facingCounts = new Array(sectionSkus.length).fill(floorFacings);
  let usedInches = widths.reduce((a, b) => a + b, 0) * floorFacings;

  const minWidth = Math.min(...widths);
  let guard = 0;
  while (sectionInches - usedInches >= minWidth && guard < 100000) {
    guard++;
    const remaining = sectionInches - usedInches;
    const totalFacingsSoFar = facingCounts.reduce((a, b) => a + b, 0);

    let bestIdx = -1;
    let bestDeficit = -Infinity;
    for (let i = 0; i < sectionSkus.length; i++) {
      if (widths[i] > remaining) continue;
      if (facingCounts[i] >= maxFacings) continue;
      const targetShare = scores[i] / totalScore;
      const currentShare = facingCounts[i] / totalFacingsSoFar;
      const deficit = targetShare - currentShare;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // nothing left fits, or everything's capped
    facingCounts[bestIdx]++;
    usedInches += widths[bestIdx];
  }

  return sectionSkus.map((sku, i) => ({
    skuId: sku.skuId,
    facings: facingCounts[i],
    widthInches: widths[i],
    allocatedInches: widths[i] * facingCounts[i],
  }));
}

// Bota 3L hard rule: within the 3L section, Bota Box/Mini SKUs collectively
// get 50%+1 of the section's linear space guaranteed, before the remaining
// space is distributed among the other 3L brands by the normal scoring process.
export function computeFacingsWithBotaFloor(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions, isBotaFn, floorFacings = 1) {
  const botaSkus = sectionSkus.filter(isBotaFn);
  const otherSkus = sectionSkus.filter((s) => !isBotaFn(s));
  // Nothing to split the width against -- give the full row budget to
  // whichever group actually exists (e.g. a row that landed all-Bota with no
  // other brands) instead of artificially half-capping it at 50%+1 and
  // wasting the rest of the row's real space.
  if (!botaSkus.length || !otherSkus.length) {
    return computeFacings(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions, floorFacings);
  }

  const sectionInches = sectionLinearFeet * 12;
  const botaInches = sectionInches * 0.5 + 0.0001; // bare majority, "50% + 1"
  const otherInches = Math.max(0, sectionInches - botaInches);

  const botaFacings = computeFacings(botaSkus, scoreMap, botaInches / 12, bottleDimensions, floorFacings);
  const otherFacings = otherSkus.length
    ? computeFacings(otherSkus, scoreMap, otherInches / 12, bottleDimensions, floorFacings)
    : [];

  return [...botaFacings, ...otherFacings];
}
