import { generatePlan } from '../optimize/placementSolver.js';
import { computeBaseline } from './digitalTwin.js';
import { calibrateVelocity, predictPlanTotals, compareToBaseline } from './predictor.js';

// A scenario is just an alternate metric-weight preset merged onto the live
// Metric Center config, per docs/BUSINESS_RULES.md and the architecture's
// "scenario = weight preset" design -- not a separate code path. This never
// mutates the live metricsConfig (no store.setMetricConfig calls); it's a
// pure preview computation.
export function mergeScenarioMetrics(baseMetricsConfig, scenario) {
  if (!scenario.metricsConfigOverride) return baseMetricsConfig;
  return baseMetricsConfig.map((cfg) => {
    const override = scenario.metricsConfigOverride[cfg.id];
    return override ? { ...cfg, ...override } : cfg;
  });
}

export function runScenario(scenario, store, allSkus, baseMetricsConfig, targetSkuCount, bottleDimensions, sales, sectionMultipliers, sectionShelfCounts, sizePackage, caseOnlyMode) {
  const baseline = computeBaseline(store.storeId, sales, allSkus);
  const k = calibrateVelocity(baseline);

  if (scenario.optimizationConstraints?.mode === 'baseline') {
    // Scenario A: Current Shelf -- baseline only, no generated plan.
    return { scenario, plan: null, baseline, prediction: null, comparison: null };
  }

  const scenarioMetricsConfig = mergeScenarioMetrics(baseMetricsConfig, scenario);
  const plan = generatePlan(store, allSkus, scenarioMetricsConfig, targetSkuCount, bottleDimensions, sectionMultipliers, sectionShelfCounts, sizePackage, caseOnlyMode);

  const skuPriceById = new Map(allSkus.map((s) => [s.skuId, s.priceUsd]));
  const prediction = predictPlanTotals(plan, k, skuPriceById);
  const comparison = compareToBaseline(baseline, prediction);

  return { scenario, plan, baseline, prediction, comparison };
}

export function runAllScenarios(scenarios, store, allSkus, baseMetricsConfig, targetSkuCount, bottleDimensions, sales, sectionMultipliers, sectionShelfCounts, sizePackage, caseOnlyMode) {
  return scenarios.map((scenario) =>
    runScenario(scenario, store, allSkus, baseMetricsConfig, targetSkuCount, bottleDimensions, sales, sectionMultipliers, sectionShelfCounts, sizePackage, caseOnlyMode)
  );
}
