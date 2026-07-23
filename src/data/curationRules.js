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
  const varietalRelabels = rules.varietalRelabels || {};
  const alwaysIncludeUpcs = rules.alwaysIncludeUpcs || {};
  const excludeUpcs = new Set(rules.alwaysExclude?.upcs || []);
  const excludeBrands = new Set((rules.alwaysExclude?.brands || []).map((b) => b.toUpperCase()));
  const manualAdditions = rules.manualAdditions?.skus || [];
  const brandVarietalOverrides = (rules.varietalOverrides?.brandContains || [])
    .map((r) => ({ match: r.match.toUpperCase(), varietal: r.varietal }));
  // Each brand entry declares its own alwaysInclude -- most supplier-priority
  // brands (e.g. Stoneleigh) only want the scoring/anchor boost, same as the
  // original hardcoded list; Coppola Diamond is the one exception that also
  // force-places regardless of score, so it opts in explicitly rather than
  // every brand getting alwaysInclude by default. Andrew, 2026-07-23.
  const supplierFavoredBrands = (rules.supplierFavoredBrands?.brandContains || [])
    .map((r) => ({ match: r.match.toUpperCase(), alwaysInclude: r.alwaysInclude === true }));
  const supplierFavoredUpcs = rules.supplierFavoredUpcs || {};
  // Dedicated, growing list (Andrew, 2026-07-23: "we will be putting a
  // number of existing SKUs" into this over time) -- moves a SKU into a
  // brand-new NON-ALCOHOLIC varietal section (sectionForSku, blocking.js,
  // builds a section from whatever string sku.varietal holds, so this needs
  // no separate section-registration step) and OUT of whatever varietal
  // section it used to occupy. Kept as its own key rather than folded into
  // varietalRelabels so it reads as its own standing category-move list,
  // not a one-off mislabel fix.
  const nonAlcoholicUpcs = new Set(Object.keys(rules.nonAlcoholicUpcs || {}).filter((k) => rules.nonAlcoholicUpcs[k] === true));

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
      // UPC-scoped varietal fix -- for a raw-export mislabel on ONE specific
      // SKU (region put in the varietal field, e.g. "NEW ZEALAND" instead of
      // "SAUVIGNON BLANC"), as opposed to varietalOverrides.brandContains
      // below, which intentionally reclassifies an entire brand line.
      // Andrew, 2026-07-23.
      const varietalRelabel = upc ? varietalRelabels[upc] : null;
      const alwaysInclude = upc ? alwaysIncludeUpcs[upc] === true : false;
      const brandUpper = (sku.brand || '').toUpperCase();
      const varietalOverride = brandVarietalOverrides.find((r) => brandUpper.includes(r.match));
      const favoredBrandMatch = supplierFavoredBrands.find((r) => brandUpper.includes(r.match));
      // UPC-scoped priority (unlike the brand-wide rule above) grants ONLY
      // the scoring/anchor boost, not alwaysInclude -- for a single SKU
      // Andrew wants favored without force-placing it regardless of score,
      // as opposed to an entire brand line. Andrew, 2026-07-23.
      const isSupplierFavoredByUpc = upc ? supplierFavoredUpcs[upc] === true : false;
      const isSupplierFavored = !!favoredBrandMatch || isSupplierFavoredByUpc;
      const isNonAlcoholic = upc ? nonAlcoholicUpcs.has(upc) : false;
      if (!relabel && !varietalRelabel && !alwaysInclude && !varietalOverride && !isSupplierFavored && !isNonAlcoholic) return sku;
      return {
        ...sku,
        ...(relabel ? { bottleSizeRaw: relabel } : null),
        ...(alwaysInclude || favoredBrandMatch?.alwaysInclude ? { alwaysInclude: true } : null),
        ...(isSupplierFavored ? { strategicSupplierPriority: true } : null),
        // A confirmed category move (isNonAlcoholic) wins over every other
        // varietal source -- it's a definitive "this SKU belongs elsewhere
        // now," not a soft preference. varietalOverride (brand-wide) then
        // varietalRelabel (UPC-scoped mislabel fix) in that order otherwise.
        ...(isNonAlcoholic ? { varietal: 'NON-ALCOHOLIC' } : varietalOverride ? { varietal: varietalOverride.varietal } : varietalRelabel ? { varietal: varietalRelabel } : null),
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
