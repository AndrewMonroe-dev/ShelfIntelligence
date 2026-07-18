import { computeScoreMap } from '../calc/scoreEngine.js';
import { selectAssortment } from './assortment.js';
import { groupBySection, isSmallFormatSection } from './blocking.js';
import { isMarketShareSection, getSectionMarketShare } from './marketShare.js';
import { getPhysicalWidthFt } from './shelfPosition.js';

const MIN_SECTION_WIDTH_FT = 2;

// One-time seed for a store's Category Allocation Model, run when a store
// has no persisted allocation yet. Scores sections by opportunity (same
// logic `generatePlan` used to run live on every generation) and apportions
// the fixture's physical width directly in feet -- no bay-count detour, no
// dropping sections that don't fit a floor, since allocation width is now
// an explicit, user-editable value rather than something recomputed (and
// silently pruned) on every plan.
export function seedSectionAllocation(store, allSkus, metricsConfig, targetSkuCount, sizePackageData = []) {
  const context = store.qualityScore != null ? { qualityScore: store.qualityScore } : null;
  const scoreMap = computeScoreMap(allSkus, metricsConfig, context);
  const { selected } = selectAssortment(allSkus, targetSkuCount, metricsConfig, context);

  const sectionsMap = groupBySection(selected);
  const grandTotalScore = selected.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0) || 1;

  const sectionScores = new Map();
  sectionsMap.forEach((section, key) => {
    if (isMarketShareSection(section)) {
      const share = getSectionMarketShare(section, sizePackageData);
      sectionScores.set(key, share * grandTotalScore);
    } else {
      const total = section.skus.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0);
      sectionScores.set(key, total);
    }
  });
  const sectionScoreTotal = [...sectionScores.values()].reduce((a, b) => a + b, 0) || 1;

  const physicalWidthFt = getPhysicalWidthFt(store.shelfLayout);
  const sectionKeys = [...sectionsMap.keys()];

  // Give every section its proportional share of the fixture width, floored
  // at a small minimum so no section renders at zero width -- but the floor
  // itself scales down when the fixture doesn't have room for every section
  // to get the full minimum (e.g. many varietals on a small fixture), so the
  // floors alone never exceed the physical width before proportional sizing
  // is even applied.
  const floorPerSection = Math.min(MIN_SECTION_WIDTH_FT, physicalWidthFt / sectionKeys.length);
  const rawShares = sectionKeys.map((key) => (sectionScores.get(key) || 0) / sectionScoreTotal);
  const flooredWidths = rawShares.map(() => floorPerSection);
  const flooredTotal = flooredWidths.reduce((a, b) => a + b, 0);
  const remainingWidth = Math.max(0, physicalWidthFt - flooredTotal);

  const widths = rawShares.map((share, i) => flooredWidths[i] + share * remainingWidth);

  // Andrew, 2026-07-18: every small-format size (0.5LT, 0.187LT, 4-packs,
  // etc.) needs to land physically ADJACENT to each other so the merge in
  // placementSolver.js actually combines them into one section -- pure
  // per-section score sorting scattered them among unrelated varietal
  // sections whenever an individual size's own score happened to fall
  // between two non-small-format sections. Small-format sections now sort
  // as one contiguous cluster (positioned by the cluster's combined score,
  // so it still lands in a sensible spot overall), ranked internally by
  // each size's own score -- "ranked within the 4-pack sets," not just
  // eligible to merge with them.
  const smallFormatClusterScore = sectionKeys.reduce((sum, key) => {
    const isSmall = isSmallFormatSection(sectionsMap.get(key));
    return isSmall ? sum + (sectionScores.get(key) || 0) : sum;
  }, 0);

  const ordered = sectionKeys
    .map((key, i) => ({
      key,
      label: sectionsMap.get(key).label,
      totalScore: sectionScores.get(key) || 0,
      widthFt: widths[i],
      isSmallFormat: isSmallFormatSection(sectionsMap.get(key)),
    }))
    .sort((a, b) => {
      const aRank = a.isSmallFormat ? smallFormatClusterScore : a.totalScore;
      const bRank = b.isSmallFormat ? smallFormatClusterScore : b.totalScore;
      if (aRank !== bRank) return bRank - aRank;
      return b.totalScore - a.totalScore; // within the cluster (or an exact tie), rank by own score
    });

  let cursor = 0;
  return ordered.map((section, order) => {
    const allocation = { key: section.key, label: section.label, order, startFt: cursor, widthFt: section.widthFt };
    cursor += section.widthFt;
    return allocation;
  });
}
