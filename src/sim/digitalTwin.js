// Builds the "current state" baseline for a store from the synthetic demo
// sales data (data/sales.json, flagged synthetic: true). This is placeholder
// data until real POS is provided -- see docs/BUSINESS_RULES.md. The baseline
// only covers the SKUs that happen to have synthetic sales rows (currently a
// 40-SKU demo sample), not the full assortment -- that's fine for a baseline
// "what this store sells today" total, and is exactly what predictor.js's
// calibration step is built to handle.

export function computeBaseline(storeId, sales, skus) {
  const storeSales = sales.filter((r) => r.storeId === storeId);
  if (!storeSales.length) {
    return {
      storeId,
      isSynthetic: true,
      hasData: false,
      weeksCovered: 0,
      skuCount: 0,
      totalUnitsPerWeek: 0,
      totalRevenuePerWeek: 0,
    };
  }

  const weeks = new Set(storeSales.map((r) => r.period));
  const skuIds = new Set(storeSales.map((r) => r.skuId));
  const totalUnits = storeSales.reduce((sum, r) => sum + r.unitsSold, 0);
  const totalRevenue = storeSales.reduce((sum, r) => sum + r.revenueUsd, 0);

  return {
    storeId,
    isSynthetic: storeSales.some((r) => r.synthetic),
    hasData: true,
    weeksCovered: weeks.size,
    skuCount: skuIds.size,
    totalUnitsPerWeek: totalUnits / weeks.size,
    totalRevenuePerWeek: totalRevenue / weeks.size,
  };
}
