import { computeScoreMap } from '../calc/scoreEngine.js';

// Selects which SKUs make a store's set, given a target count.
//
// Ranks by the live computed opportunity score (calc/scoreEngine.js), which
// is itself driven entirely by the Metric Center's enabled/weight sliders --
// no fixed sort key. Moving a weight slider changes this ranking immediately.
//
// Respects the base/extended SKU universe rule from docs/BUSINESS_RULES.md:
// the top 500 SKUs by national volume are the "base" pool; ranks 501-1000
// ("extended") are only meant to be drawn on once a store's physical set
// exceeds the documented linear-footage baseline. selectAssortment() itself
// just returns the top N by score -- the caller decides whether N is allowed
// to reach into the extended pool (see storeBuilder.js for the slider that
// sets N).

export function selectAssortment(skus, targetCount, metricsConfig) {
  const scoreMap = computeScoreMap(skus, metricsConfig);
  const sorted = [...skus].sort((a, b) => {
    const scoreA = scoreMap.get(a.skuId)?.score ?? 0;
    const scoreB = scoreMap.get(b.skuId)?.score ?? 0;
    return scoreB - scoreA;
  });
  const selected = sorted.slice(0, targetCount);
  return {
    selected,
    baseCount: selected.filter((s) => s.assortmentTier === 'base').length,
    extendedCount: selected.filter((s) => s.assortmentTier === 'extended').length,
    brandCount: new Set(selected.map((s) => s.brand)).size,
    varietalCount: new Set(selected.map((s) => s.varietal).filter(Boolean)).size,
  };
}
