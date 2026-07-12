const SKU_ID_PATTERN = /^\d{6}$/;

export function isValidSkuId(id) {
  return SKU_ID_PATTERN.test(id);
}

export function nextSkuId(existingIds) {
  const numeric = existingIds
    .map((id) => parseInt(id, 10))
    .filter((n) => !Number.isNaN(n));
  const max = numeric.length ? Math.max(...numeric) : 0;
  return String(max + 1).padStart(6, '0');
}
