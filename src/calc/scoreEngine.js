import { normalizeValues } from './normalize.js';
import { METRIC_ACCESSORS, metricHasData } from './metricRegistry.js';

// Every metric weight is fully live/config-driven -- nothing about which
// metrics count or how much they count is hardcoded here. This function only
// knows HOW to combine whatever is enabled+available; WHAT is enabled and at
// WHAT weight comes entirely from data/metrics.config.json (editable live via
// the Metric Center's sliders).

export function getActiveMetrics(metricsConfig, skus) {
  return metricsConfig
    .filter((cfg) => METRIC_ACCESSORS[cfg.id])
    .map((cfg) => ({ cfg, hasData: metricHasData(cfg.id, skus) }));
}

export function computeScores(skus, metricsConfig, context = null) {
  const active = metricsConfig.filter(
    (cfg) => cfg.enabled && METRIC_ACCESSORS[cfg.id] && metricHasData(cfg.id, skus)
  );

  const totalWeight = active.reduce((sum, cfg) => sum + cfg.weight, 0) || 1;

  const normalizedByMetric = {};
  active.forEach((cfg) => {
    const accessor = METRIC_ACCESSORS[cfg.id];
    const raw = skus.map((s) => accessor(s, context));
    let normalized = normalizeValues(raw, cfg.normalization);
    if (cfg.inverted) {
      normalized = normalized.map((v) => (v == null ? null : 100 - v));
    }
    if (cfg.multiplier != null && cfg.multiplier !== 1) {
      normalized = normalized.map((v) => (v == null ? null : v * cfg.multiplier));
    }
    normalizedByMetric[cfg.id] = normalized;
  });

  return skus.map((sku, i) => {
    let score = 0;
    const breakdown = [];
    active.forEach((cfg) => {
      const norm = normalizedByMetric[cfg.id][i];
      if (norm == null) return;
      const weightSharePct = (cfg.weight / totalWeight) * 100;
      const contribution = (norm * weightSharePct) / 100;
      score += contribution;
      breakdown.push({
        metricId: cfg.id,
        label: cfg.label,
        rawValue: METRIC_ACCESSORS[cfg.id](sku, context),
        normalizedValue: norm,
        weightSharePct,
        contribution,
      });
    });
    breakdown.sort((a, b) => b.contribution - a.contribution);
    return { skuId: sku.skuId, score, breakdown };
  });
}

export function computeScoreMap(skus, metricsConfig, context = null) {
  const scores = computeScores(skus, metricsConfig, context);
  return new Map(scores.map((s) => [s.skuId, s]));
}
