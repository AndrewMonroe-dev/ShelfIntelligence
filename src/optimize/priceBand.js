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
  return '20plus';
}

export const PRICE_BAND_LABELS = {
  under10: 'Under $10',
  '10to14': '$10-$14',
  '14to20': '$14-$20',
  '20plus': '$20+',
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
    default:
      return all;
  }
}

export function appliesPriceBandRules(section) {
  return section.type === 'varietal'; // 750ml sections only
}

// Soft preference layered on top of the hard allowed-position constraint:
// eye level mainly goes to $10-14/$14-20 ("TOP SKUs" for those bands), top
// shelf mostly goes to $20+. Implemented as a scoring multiplier so the
// constrained greedy assignment naturally favors these matches without
// hard-excluding other eligible bands from those positions.
export function positionPreferenceMultiplier(band, position, eyePosition) {
  if (position === 1) {
    if (band === '20plus') return 1.4;
    if (band === '14to20') return 1.0;
    return 0.6;
  }
  if (eyePosition != null && position === eyePosition) {
    if (band === '10to14' || band === '14to20') return 1.4;
    return 1.0;
  }
  return 1.0;
}
