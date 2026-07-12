// Facings allocation per docs/BUSINESS_RULES.md item 6: floor of 1 facing per
// SKU, remaining linear space distributed proportionally to score, converted
// to a facing count using real bottle width from data/bottleDimensions.json.

// data/skus.json only carries a raw size string (e.g. "0.75LT", "3LT"), not a
// bottle shape (bordeaux vs. burgundy vs. champagne) or package type. This
// maps each raw size to a reasonable default bottleDimensions.json entry.
// Sizes with no close match fall back to a generic width rather than
// guessing a specific shape.
const SIZE_TO_DIMENSION_TYPE = {
  '0.75LT': '750_bordeaux',
  '1.5LT': '1.5L_magnum',
  '3LT': '3L_box',
  '5LT': '5L_box',
  '1LT': '1L_bottle',
  '0.375LT': '375_half',
  '0.187LT': '187_split',
  '0.25LT': '250_can',
};
const FALLBACK_WIDTH_IN = 3.0; // used only when no size mapping exists at all

export function bottleWidthInches(sku, bottleDimensions) {
  const dimType = SIZE_TO_DIMENSION_TYPE[sku.bottleSizeRaw];
  const dim = dimType && bottleDimensions.find((d) => d.type === dimType);
  return dim ? dim.widthIn : FALLBACK_WIDTH_IN;
}

export function computeFacings(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions) {
  if (!sectionSkus.length) return [];
  const sectionInches = sectionLinearFeet * 12;
  const widths = sectionSkus.map((sku) => bottleWidthInches(sku, bottleDimensions));

  const floorWidthTotal = widths.reduce((a, b) => a + b, 0);
  const remainingInches = Math.max(0, sectionInches - floorWidthTotal);

  const totalScore = sectionSkus.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0) || 1;

  return sectionSkus.map((sku, i) => {
    const share = (scoreMap.get(sku.skuId)?.score ?? 0) / totalScore;
    const extraInches = remainingInches * share;
    const extraFacings = Math.floor(extraInches / widths[i]);
    return {
      skuId: sku.skuId,
      facings: 1 + extraFacings,
      widthInches: widths[i],
      allocatedInches: widths[i] * (1 + extraFacings),
    };
  });
}

// Bota 3L hard rule: within the 3L section, Bota Box/Mini SKUs collectively
// get 50%+1 of the section's linear space guaranteed, before the remaining
// space is distributed among the other 3L brands by the normal scoring process.
export function computeFacingsWithBotaFloor(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions, isBotaFn) {
  const botaSkus = sectionSkus.filter(isBotaFn);
  const otherSkus = sectionSkus.filter((s) => !isBotaFn(s));
  if (!botaSkus.length) return computeFacings(sectionSkus, scoreMap, sectionLinearFeet, bottleDimensions);

  const sectionInches = sectionLinearFeet * 12;
  const botaInches = sectionInches * 0.5 + 0.0001; // bare majority, "50% + 1"
  const otherInches = Math.max(0, sectionInches - botaInches);

  const botaFacings = computeFacings(botaSkus, scoreMap, botaInches / 12, bottleDimensions);
  const otherFacings = otherSkus.length
    ? computeFacings(otherSkus, scoreMap, otherInches / 12, bottleDimensions)
    : [];

  return [...botaFacings, ...otherFacings];
}
