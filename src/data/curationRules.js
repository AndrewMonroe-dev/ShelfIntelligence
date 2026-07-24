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
  // rank/tier (Andrew, 2026-07-24): rank breaks ties among MULTIPLE priority
  // brands competing for one section's anchor slot (anchorPlacement.js);
  // tier is a harder rule -- tier 2 (currently Noble Vines/Gnarly Head/Diora)
  // may never share a physical shelf row with a tier 1 brand in the same
  // section (placementSolver.js). Both live only in curationRules.json,
  // never hardcoded, since Andrew expects this ranking to keep changing.
  // Missing rank/tier (undefined) means "unranked" -- normal score-based
  // competition only, same as any brand not on this list at all.
  const supplierFavoredBrands = (rules.supplierFavoredBrands?.brandContains || [])
    .map((r) => ({
      match: r.match.toUpperCase(),
      alwaysInclude: r.alwaysInclude === true,
      rank: typeof r.rank === 'number' ? r.rank : undefined,
      tier: typeof r.tier === 'number' ? r.tier : undefined,
    }));
  const supplierFavoredUpcs = rules.supplierFavoredUpcs || {};
  // Andrew, 2026-07-24: width-gated alwaysInclude alternative -- see
  // widthGatedAlwaysInclude's _readme in curationRules.json. Attaches a
  // minimum-section-width threshold to the SKU instead of a flat
  // alwaysInclude:true; placementSolver.js checks the actual section's
  // linear feet against this at generation time.
  const widthGatedBrands = (rules.widthGatedAlwaysInclude?.brandContains || [])
    .map((r) => ({ match: r.match.toUpperCase(), minWidthFt: r.minWidthFt }));
  // UPC-scoped version -- a curated subset of a brand, not the whole line
  // (e.g. exactly 4 of Schmitt Sohne's 14 SKUs). Andrew, 2026-07-24.
  const widthGatedUpcs = rules.widthGatedAlwaysIncludeUpcs || {};
  // Dedicated, growing list (Andrew, 2026-07-23: "we will be putting a
  // number of existing SKUs" into this over time) -- moves a SKU into a
  // brand-new NON-ALCOHOLIC varietal section (sectionForSku, blocking.js,
  // builds a section from whatever string sku.varietal holds, so this needs
  // no separate section-registration step) and OUT of whatever varietal
  // section it used to occupy. Kept as its own key rather than folded into
  // varietalRelabels so it reads as its own standing category-move list,
  // not a one-off mislabel fix.
  const nonAlcoholicUpcs = new Set(Object.keys(rules.nonAlcoholicUpcs || {}).filter((k) => rules.nonAlcoholicUpcs[k] === true));

  // Andrew, 2026-07-24 (bug found while narrowing Schmitt Sohne's
  // width-gated guarantee to 4 specific SKUs): manualAdditions used to be
  // pushed in raw, AFTER the filter/map pipeline below -- meaning every
  // rule in this file (supplierFavoredBrands, widthGatedAlwaysInclude,
  // varietalOverrides, all of it) silently never applied to a
  // manualAddition. Invisible until now because the 3 original Bota
  // manualAdditions happen to ALSO exist as real entries in skus.json
  // (which DO go through the pipeline) -- their manualAdditions copies
  // were always dead duplicates, skipped by the idempotency check below,
  // never actually the ones supplying the flag. 12 of the 146 Germany
  // auxiliary additions (Schmitt Sohne/Relax brand) exist ONLY via
  // manualAdditions and were silently missing their
  // strategicSupplierPriority boost as a result. Fixed by merging
  // manualAdditions into the pool BEFORE the pipeline runs (idempotent by
  // skuId, same as before) instead of appending raw after it.
  const existingSkuIds = new Set(skus.map((s) => s.skuId));
  const combinedSkus = [...skus, ...manualAdditions.filter((s) => !existingSkuIds.has(s.skuId))];

  const kept = combinedSkus
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
      // as opposed to an entire brand line. Andrew, 2026-07-23. Entry can be
      // plain `true` (unranked) or an object with rank/tier (2026-07-24).
      const upcFavor = upc ? supplierFavoredUpcs[upc] : undefined;
      const isSupplierFavoredByUpc = upcFavor === true || upcFavor?.priority === true;
      const isSupplierFavored = !!favoredBrandMatch || isSupplierFavoredByUpc;
      // A brand-level match and a UPC-level match should never both apply to
      // the same SKU in practice (UPC-scoped entries exist precisely because
      // the SKU's brand ISN'T on the brand-wide list), but if they ever did,
      // the UPC-specific rank/tier wins as the more specific instruction.
      const supplierRank = (typeof upcFavor?.rank === 'number') ? upcFavor.rank : favoredBrandMatch?.rank;
      const supplierTier = (typeof upcFavor?.tier === 'number') ? upcFavor.tier : favoredBrandMatch?.tier;
      const isNonAlcoholic = upc ? nonAlcoholicUpcs.has(upc) : false;
      const widthGatedBrandMatch = widthGatedBrands.find((r) => brandUpper.includes(r.match));
      const widthGatedUpcMatch = upc ? widthGatedUpcs[upc] : undefined;
      // UPC-scoped entry wins as the more specific instruction, same
      // precedent as supplierFavoredUpcs vs supplierFavoredBrands above.
      const widthGatedMinWidthFt = (typeof widthGatedUpcMatch?.minWidthFt === 'number')
        ? widthGatedUpcMatch.minWidthFt
        : widthGatedBrandMatch?.minWidthFt;
      if (!relabel && !varietalRelabel && !alwaysInclude && !varietalOverride && !isSupplierFavored && !isNonAlcoholic && widthGatedMinWidthFt === undefined) return sku;
      return {
        ...sku,
        ...(relabel ? { bottleSizeRaw: relabel } : null),
        ...(alwaysInclude || favoredBrandMatch?.alwaysInclude ? { alwaysInclude: true } : null),
        ...(isSupplierFavored ? { strategicSupplierPriority: true } : null),
        ...(isSupplierFavored && supplierRank !== undefined ? { strategicSupplierRank: supplierRank } : null),
        ...(isSupplierFavored && supplierTier !== undefined ? { strategicSupplierTier: supplierTier } : null),
        ...(widthGatedMinWidthFt !== undefined ? { alwaysIncludeMinWidthFt: widthGatedMinWidthFt } : null),
        // A confirmed category move (isNonAlcoholic) wins over every other
        // varietal source -- it's a definitive "this SKU belongs elsewhere
        // now," not a soft preference. varietalOverride (brand-wide) then
        // varietalRelabel (UPC-scoped mislabel fix) in that order otherwise.
        ...(isNonAlcoholic ? { varietal: 'NON-ALCOHOLIC' } : varietalOverride ? { varietal: varietalOverride.varietal } : varietalRelabel ? { varietal: varietalRelabel } : null),
      };
    });

  return kept;
}
