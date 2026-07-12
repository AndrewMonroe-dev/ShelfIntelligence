// Normalizes a raw metric value array to a comparable 0-100 scale. `null`
// entries pass through as `null` (metric had no data for that SKU) and are
// excluded from the min/max/mean/stddev calculation, not treated as zero.

const isUsable = (v) => v != null && typeof v === 'number' && Number.isFinite(v);

function minmax(values) {
  const present = values.filter(isUsable);
  if (!present.length) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min;
  return values.map((v) => (!isUsable(v) ? null : range === 0 ? 50 : ((v - min) / range) * 100));
}

function zscore(values) {
  const present = values.filter(isUsable);
  if (!present.length) return values.map(() => null);
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const variance = present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return values.map((v) => (isUsable(v) ? 50 : null));
  const zscores = values.map((v) => (isUsable(v) ? (v - mean) / stddev : null));
  // rescale z-scores to 0-100 via their own min/max so they're comparable to other metrics
  return minmax(zscores);
}

function booleanNorm(values) {
  return values.map((v) => (v == null ? null : v ? 100 : 0));
}

export function normalizeValues(values, method) {
  switch (method) {
    case 'zscore':
      return zscore(values);
    case 'boolean':
      return booleanNorm(values);
    case 'minmax':
    default:
      return minmax(values);
  }
}
