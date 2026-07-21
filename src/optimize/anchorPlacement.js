// Anchor/priority placement for 750ml varietal sections ONLY -- brand/size
// block sections (3L, 5L, 4L, etc.) are explicitly out of scope per Andrew,
// 2026-07-21: "The block sets are to remain as is." 750ml sections have no
// brand blocking to begin with (BUSINESS_RULES.md: "ordered purely by
// opportunity score"), so the anchor unit here is the whole section (or, for
// Sparkling Wine, each subtype sub-block -- see subBlockBySubtype in
// blocking.js).
//
// Vertical placement itself needs no new logic: partitionIntoShelvesConstrained
// (placementSolver.js) already processes SKUs one at a time, in score order,
// against a shared pool of positions that starts fully open -- whichever SKU
// is processed FIRST automatically claims the single best
// shelfScore x positionPreferenceMultiplier slot among its price band's
// allowed positions, since nothing has claimed anything yet. What's missing
// is WHO goes first: a strategicSupplierPriority SKU that's a close #2 (not
// literally top-scored, e.g. because its live metric weight is set low)
// still loses that claim under a flat score sort. applyAnchorTiebreak below
// reorders the front of an already score-sorted list so a near-tied priority
// SKU wins the anchor slot instead -- a genuinely weak priority SKU is NOT
// bumped in front of a real top seller, only a close one.

// How close a strategicSupplierPriority SKU's own score must be to the
// section (or subtype group)'s raw top scorer, as a fraction of the top
// score, before it wins the anchor slot on priority alone. Named/exported
// (not hardcoded inline) so it's easy to find and tune later, same pattern
// as blocking.js's TIEBREAK_EPSILON for the Black Box/Bota tiebreak.
export const DEFAULT_ANCHOR_PRIORITY_MARGIN = 0.12; // 12%

// Documents the intended strength of the horizontal nudge described to
// Andrew (roughly 1.05-1.1x, well below ZONE_INDEX's spread) -- implemented
// as a direct center-of-row placement (applyHorizontalAnchorBias) rather
// than a continuous scoring multiplier, since re-ordering SKUs that already
// passed fitSkusToWidth must never change WHICH SKUs are included, only
// their left-to-right order.
export const DEFAULT_ANCHOR_HORIZONTAL_BIAS = 1.08;

// Reorders one already score-sorted SKU list so its anchor -- the top
// scorer, or a strategicSupplierPriority SKU within `priorityMargin` of the
// top score -- is first. Returns the reordered list plus a
// Map<skuId, 'top-score' | 'priority-override'> for explainability (exactly
// one entry: the anchor).
export function applyAnchorTiebreak(sortedSkus, scoreMap, { priorityMargin = DEFAULT_ANCHOR_PRIORITY_MARGIN } = {}) {
  const anchorInfoBySkuId = new Map();
  if (!sortedSkus.length) return { ranked: sortedSkus, anchorInfoBySkuId };

  const topScorer = sortedSkus[0];
  if (topScorer.strategicSupplierPriority) {
    // Already covered by the normal top-score pick -- no override needed.
    anchorInfoBySkuId.set(topScorer.skuId, 'top-score');
    return { ranked: sortedSkus, anchorInfoBySkuId };
  }

  const topScore = scoreMap.get(topScorer.skuId)?.score ?? 0;
  const prioritySku = sortedSkus.find((s) => s.strategicSupplierPriority);
  if (prioritySku && topScore > 0) {
    const priorityScore = scoreMap.get(prioritySku.skuId)?.score ?? 0;
    if ((topScore - priorityScore) / topScore <= priorityMargin) {
      const ranked = [prioritySku, ...sortedSkus.filter((s) => s.skuId !== prioritySku.skuId)];
      anchorInfoBySkuId.set(prioritySku.skuId, 'priority-override');
      return { ranked, anchorInfoBySkuId };
    }
  }

  anchorInfoBySkuId.set(topScorer.skuId, 'top-score');
  return { ranked: sortedSkus, anchorInfoBySkuId };
}

// Moves the anchor SKU to the horizontal center of its row -- ONLY called
// after fitSkusToWidth has already decided which SKUs are included in that
// row; reordering any earlier could push the anchor past the width cutoff
// and silently drop it. A modest, honest nudge: real eye-tracking research
// finds horizontal shelf-position effects weak and inconsistent, roughly
// half the strength of vertical position (Drèze, Hoch & Purk 1994; Hansen et
// al. 2010) -- so this only ever repositions within a row, never changes row
// membership or facings.
export function applyHorizontalAnchorBias(rowSkus, anchorSkuId) {
  if (!anchorSkuId || rowSkus.length < 2) return rowSkus;
  const idx = rowSkus.findIndex((s) => s.skuId === anchorSkuId);
  if (idx === -1) return rowSkus;
  const centerIdx = Math.floor(rowSkus.length / 2);
  if (idx === centerIdx) return rowSkus;
  const copy = [...rowSkus];
  const [anchor] = copy.splice(idx, 1);
  copy.splice(centerIdx, 0, anchor);
  return copy;
}
