// Applies data/curationRules.json on top of whatever skus.json actually
// contains, every time the app loads -- see jsonAdapter.js. This is the
// mechanism that makes manual calls (size relabels a raw export gets wrong,
// SKUs that must always place regardless of score, discontinued brands,
// products too new to have real sales data yet) survive a full skus.json
// regeneration from a fresh brand ranking / MI Specific Data export,
// instead of needing to be redone by hand every time -- Andrew, 2026-07-23.

function normalizeUpc(upc) {
  return upc == null ? null : String(upc);
}

export function applyCurationRules(skus, rules) {
  if (!rules) return skus;

  const sizeRelabels = rules.sizeRelabels || {};
  const alwaysIncludeUpcs = rules.alwaysIncludeUpcs || {};
  const excludeUpcs = new Set(rules.alwaysExclude?.upcs || []);
  const excludeBrands = new Set((rules.alwaysExclude?.brands || []).map((b) => b.toUpperCase()));
  const manualAdditions = rules.manualAdditions?.skus || [];
  const brandVarietalOverrides = (rules.varietalOverrides?.brandContains || [])
    .map((r) => ({ match: r.match.toUpperCase(), varietal: r.varietal }));

  const kept = skus
    .filter((sku) => {
      const upc = normalizeUpc(sku.upc);
      if (upc && excludeUpcs.has(upc)) return false;
      if (excludeBrands.has((sku.brand || '').toUpperCase())) return false;
      return true;
    })
    .map((sku) => {
      const upc = normalizeUpc(sku.upc);
      const relabel = upc ? sizeRelabels[upc] : null;
      const alwaysInclude = upc ? alwaysIncludeUpcs[upc] === true : false;
      const brandUpper = (sku.brand || '').toUpperCase();
      const varietalOverride = brandVarietalOverrides.find((r) => brandUpper.includes(r.match));
      if (!relabel && !alwaysInclude && !varietalOverride) return sku;
      return {
        ...sku,
        ...(relabel ? { bottleSizeRaw: relabel } : null),
        ...(alwaysInclude ? { alwaysInclude: true } : null),
        ...(varietalOverride ? { varietal: varietalOverride.varietal } : null),
      };
    });

  // Manual additions are idempotent by skuId -- re-running this over a
  // skus.json that already has them (e.g. it was regenerated but happened
  // to re-include one) never creates a duplicate.
  const existingIds = new Set(kept.map((s) => s.skuId));
  manualAdditions.forEach((sku) => {
    if (!existingIds.has(sku.skuId)) kept.push(sku);
  });

  return kept;
}
