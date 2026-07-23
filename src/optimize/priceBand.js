// Price-point shelf position rules, gathered 2026-07-12. Only applies to
// 750ml varietal sections (Cabernet, Sparkling Wine, etc.) -- size sections
// (3L Box, 5L Box, 4L Bottle, and anything smaller than 750ml) are
// explicitly exempt. Mostly HARD constraints (a SKU cannot be placed
// outside its price band's allowed positions), with one documented
// exception: a "very large brand" can subvert this, but no concrete
// threshold was defined ("leave it open for crazy outliers, prompt when
// found") -- so instead of guessing a brand-size cutoff, constrained
// placements that meaningfully bump a high-scoring SKU out of its natural
// best position are flagged in that SKU's explainability reasons for manual
// review, rather than silently auto-overridden by an invented rule.

export function priceBand(priceUsd) {
  if (priceUsd == null) return '20plus'; // no price data: treat as unrestricted rather than guessing a band
  if (priceUsd < 10) return 'under10';
  if (priceUsd < 14) return '10to14';
  if (priceUsd < 20) return '14to20';
  if (priceUsd < 30) return '20plus';
  return '30plus';
}

export const PRICE_BAND_LABELS = {
  under10: 'Under $10',
  '10to14': '$10-$14',
  '14to20': '$14-$20',
  '20plus': '$20-$30',
  '30plus': 'Over $30',
};

// Physical position numbers, 1 = topmost shelf, shelfCount = bottommost.
export function allowedPositions(band, shelfCount) {
  const all = Array.from({ length: shelfCount }, (_, i) => i + 1);
  switch (band) {
    case 'under10':
      // Can go no higher than the second shelf from the bottom -- confined
      // to the bottom two physical positions.
      return all.slice(Math.max(0, shelfCount - 2));
    case '10to14':
      // Cannot be top shelf.
      return all.filter((p) => p !== 1);
    case '14to20':
      // Can go no lower than second from the bottom -- excluded only from
      // the very bottom position.
      return all.filter((p) => p !== shelfCount);
    case '20plus':
      // Andrew, 2026-07-21: mirrors under10's exclusion from the top --
      // $20+ wine never lands on the very bottom shelf. Without this, a
      // $20+ SKU that loses the competition for the top/eye-level slot had
      // no floor at all and could fall next to the cheapest product in the
      // section, undercutting the whole point of a deliberate price
      // pyramid (top-shelf = premium, bottom-shelf = value, both hard
      // constraints now, not just a soft eye-level nudge on the top end).
      // Degrades to "all" on a 1-shelf section -- same as every other band,
      // excluding the section's only shelf would leave zero allowed
      // positions.
      return shelfCount <= 1 ? all : all.filter((p) => p !== shelfCount);
    case '30plus':
      // Andrew, 2026-07-23: Over $30 ARP goes top shelf only, in both 4-
      // and 5-shelf sets -- not just "not the bottom," the whole point is
      // keeping it above eye level entirely. Position 1 is always the top
      // shelf regardless of shelfCount, so this needs no shelfCount branch.
      return [1];
    default:
      return all;
  }
}

export function appliesPriceBandRules(section) {
  return section.type === 'varietal'; // 750ml sections only
}

// Approximate price range per band, used only to normalize where a SKU
// sits within its own band for the within-band tiebreak below -- not a
// hard boundary (bands themselves are defined in priceBand()).
const BAND_RANGE = {
  under10: [0, 10],
  '10to14': [10, 14],
  '14to20': [14, 20],
  '20plus': [20, 30],
  '30plus': [30, 60], // open-ended band; 60 is just a normalization cap
};

// Soft preference layered on top of the hard allowed-position constraint:
// eye level mainly goes to $10-14/$14-20 ("TOP SKUs" for those bands), top
// shelf mostly goes to $20+. Implemented as a scoring multiplier so the
// constrained greedy assignment naturally favors these matches without
// hard-excluding other eligible bands from those positions.
//
// Andrew, 2026-07-22: layered a small within-band tiebreak on top, per
// retail eye-tracking research -- higher price maps to a (moderate, not
// absolute) preference for a physically higher shelf. Deliberately capped
// small (max ~8% swing) so it only breaks near-ties between two SKUs of the
// same price band; it never overrides the eye-level/top-shelf preferences
// above or the hard band constraints in allowedPositions().
export function positionPreferenceMultiplier(band, position, eyePosition, priceUsd, shelfCount) {
  let base = 1.0;
  if (position === 1) {
    if (band === '30plus') base = 1.8; // the only allowed position for this band -- large so it never loses a quota tie to a lower-preference SKU that CAN go elsewhere
    else if (band === '20plus') base = 1.4;
    else if (band === '14to20') base = 1.0;
    else base = 0.6;
  } else if (eyePosition != null && position === eyePosition) {
    base = (band === '10to14' || band === '14to20') ? 1.4 : 1.0;
  }

  if (priceUsd != null && shelfCount > 1) {
    const [lo, hi] = BAND_RANGE[band] || [0, 40];
    const priceNorm = Math.max(0, Math.min(1, (priceUsd - lo) / (hi - lo || 1))); // 0 (band floor) .. 1 (band ceiling)
    const heightNorm = (shelfCount - position) / (shelfCount - 1); // 0 (bottom) .. 1 (top)
    const tiebreak = (priceNorm - 0.5) * (heightNorm - 0.5) * 0.16; // max +/-0.04 each way, -> up to ~8% total swing
    base *= 1 + tiebreak;
  }

  return base;
}
