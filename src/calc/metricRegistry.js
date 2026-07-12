// Maps each metric id from data/metrics.config.json to a function that pulls
// its raw value off a SKU record. A metric with no accessor here (or whose
// accessor returns null for effectively the whole SKU pool) has no real data
// behind it -- the Calculation Engine treats it as unavailable rather than
// inventing a value. See docs/BUSINESS_RULES.md for what data currently exists.

export const METRIC_ACCESSORS = {
  skuVolume: (sku) => sku.sales9L ?? null,
  brandVolume: (sku) => sku.brandSales9L ?? null,
  varietalVolume: (sku) => sku.varietalSales9L ?? null,
  supplierVolume: () => null, // no supplier field in current data
  growthRate: (sku) => (typeof sku.growthPct9L === 'number' && Number.isFinite(sku.growthPct9L) ? sku.growthPct9L : null),
  trend52wk: () => null, // no time-series history, only current + YoY chg
  trend104wk: () => null,
  pricePointStrength: (sku) => sku.priceSegmentShare9L ?? null,
  marginDollars: () => null, // no margin data provided
  marginPct: () => null,
  regionalPreference: (sku) => sku.regionShare9L ?? null,
  storeTypeMatch: () => null, // requires a defined store<->SKU compatibility model, not yet built
  consumerDemographics: () => null,
  brandStrength: () => null,
  distributionStrength: (sku) => sku.podsDistribution ?? null,
  velocity: (sku) => (sku.sales9L != null && sku.podsDistribution) ? sku.sales9L / sku.podsDistribution : null,
  seasonality: () => null, // no quarterly/time-series data
  innovationPriority: () => null,
  strategicSupplierPriority: (sku) => (sku.strategicSupplierPriority != null ? sku.strategicSupplierPriority : null),
};

// A metric counts as "has data" if at least this fraction of the pool has a
// non-null value. Below this, a slider exists but is shown inactive/no-data.
const DATA_COVERAGE_THRESHOLD = 0.5;

export function metricHasData(metricId, skus) {
  const accessor = METRIC_ACCESSORS[metricId];
  if (!accessor) return false;
  const covered = skus.filter((s) => accessor(s) != null).length;
  return skus.length > 0 && covered / skus.length >= DATA_COVERAGE_THRESHOLD;
}
