// Transparent heuristic prediction model -- NOT a trained ML model. Every
// number here comes from a disclosed formula, shown in the UI, so a
// prediction is always explainable rather than a black-box guess. This is
// meant to be replaced by a real model later (see architecture.md Section 10
// "Future Expansion Path") without changing the call signature.
//
// Formula:
//   1. Calibrate a velocity constant `k` from the store's OWN current
//      baseline: k = currentUnitsPerWeek / currentSkuCount. This treats each
//      currently-sold SKU as if it held one "neutral" facing at a neutral
//      shelf position (shelfScore 1.0, score 50/100) -- k is unitless
//      "units per week per neutral facing."
//   2. For each SKU in a generated plan, predicted units/week =
//      k * facings * shelfScore * (score / 50)
//      -- more facings, a better shelf position, and a higher opportunity
//      score all independently push predicted velocity up; a SKU at the
//      exact neutral baseline (1 facing, shelfScore 1.0, score 50) predicts
//      to exactly k, matching the calibration point.

export function calibrateVelocity(baseline) {
  if (!baseline.hasData || baseline.skuCount === 0) return null;
  return baseline.totalUnitsPerWeek / baseline.skuCount;
}

function skuUnitPrediction(skuEntry, shelf, k) {
  const scoreMultiplier = skuEntry.score / 50;
  return k * skuEntry.facings * shelf.shelfScore * scoreMultiplier;
}

export function predictPlanTotals(plan, k, skuPriceById) {
  if (k == null) {
    return { hasPrediction: false };
  }
  let totalUnitsPerWeek = 0;
  let totalRevenuePerWeek = 0;

  plan.sections.forEach((section) => {
    section.shelves.forEach((shelf) => {
      shelf.skus.forEach((skuEntry) => {
        const units = skuUnitPrediction(skuEntry, shelf, k);
        totalUnitsPerWeek += units;
        totalRevenuePerWeek += units * (skuPriceById.get(skuEntry.skuId) ?? 0);
      });
    });
  });

  const totalLinearFeet = plan.sections.reduce((sum, s) => sum + s.linearFeet, 0) || 1;

  return {
    hasPrediction: true,
    k,
    totalUnitsPerWeek,
    totalRevenuePerWeek,
    casesPerLinearFoot: totalUnitsPerWeek / totalLinearFeet,
  };
}

export function compareToBaseline(baseline, prediction) {
  if (!baseline.hasData || !prediction.hasPrediction) return null;
  const velocityChangePct = baseline.totalUnitsPerWeek
    ? ((prediction.totalUnitsPerWeek - baseline.totalUnitsPerWeek) / baseline.totalUnitsPerWeek) * 100
    : null;
  const revenueChangePct = baseline.totalRevenuePerWeek
    ? ((prediction.totalRevenuePerWeek - baseline.totalRevenuePerWeek) / baseline.totalRevenuePerWeek) * 100
    : null;
  return { velocityChangePct, revenueChangePct };
}
