import { computeScoreMap } from '../calc/scoreEngine.js';

// Selects which SKUs make a store's set, given a target count.
//
// Ranks by the live computed opportunity score (calc/scoreEngine.js), which
// is itself driven entirely by the Metric Center's enabled/weight sliders --
// no fixed sort key. Moving a weight slider changes this ranking immediately.
//
// Respects the base/extended SKU universe rule from docs/BUSINESS_RULES.md:
// the top 750 SKUs by MI dollar sales rank are the "base" pool; ranks 751-1750
// ("extended") are only meant to be drawn on once a store's physical set
// exceeds the documented linear-footage baseline. selectAssortment() itself
// just returns the top N by score -- the caller decides whether N is allowed
// to reach into the extended pool (see storeBuilder.js for the slider that
// sets N).

// National syndicated data sometimes carries multiple distinct SKU records
// (different vintages/UPCs) for what reads as "the same wine" on shelf --
// same brand, varietal, and size. Merchandising-wise that's one shelf
// decision, not several, so only the highest-scoring record per
// brand+varietal+size combo is kept before ranking/selection -- a real SKU
// never ends up split across two shelves under two different skuIds.
export function dedupeByBrandVarietalSize(skus, scoreMap) {
  const bestByKey = new Map();
  skus.forEach((sku) => {
    const key = `${sku.brand}|${sku.varietal || ''}|${sku.bottleSizeRaw || ''}`;
    const score = scoreMap.get(sku.skuId)?.score ?? 0;
    const existing = bestByKey.get(key);
    if (!existing || score > existing.score) bestByKey.set(key, sku);
  });
  return [...bestByKey.values()];
}

export function selectAssortment(skus, targetCount, metricsConfig, context = null) {
  const scoreMap = computeScoreMap(skus, metricsConfig, context);
  const deduped = dedupeByBrandVarietalSize(skus, scoreMap);
  const sorted = [...deduped].sort((a, b) => {
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
