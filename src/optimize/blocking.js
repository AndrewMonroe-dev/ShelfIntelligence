// Set structure / blocking rules from docs/BUSINESS_RULES.md "Set structure (world sets)"
// and "Strategic Supplier Priority".

const SEVEN_FIFTY_ML = '0.75LT';

// Sparkling wine (Brut, Prosecco, Rose, Spumante, All Other -- the 5 real
// national-data sparkling varietal categories) gets its own dedicated section
// for 750ml SKUs, instead of scattering across 5 separate varietal sections.
// Sub-blocked internally by its original specific varietal (see
// groupBySection / placementSolver). This only catches SKUs whose varietal
// field was already classified as one of the "SPARKLING ___" national
// categories -- it can't distinguish e.g. "Moscato d'Asti" from a plain still
// Moscato, since the raw product text needed for that wasn't retained when
// skus.json was built. A SKU merely labeled "MOSCATO" stays in the regular
// Moscato section.
export function isSparklingVarietal(varietal) {
  return typeof varietal === 'string' && varietal.startsWith('SPARKLING');
}

// Real national data (data/market/size_package.json) confirms 3L Box, 3L
// Bottle, 4L Bottle, 5L Box, and 5L Bottle are genuinely distinct categories
// with real volume. But data/skus.json has no per-SKU package-type field --
// the raw product text doesn't state it separately from brand names like
// "Bota Box" (checked directly: every 3L sample pulled was "BOTA BOX ..." or
// "BLACK BOX WINES ...", where "BOX" is part of the brand, not an
// independent descriptor). Splitting into real per-SKU Box vs Bottle
// sections isn't possible without that data. This applies a disclosed,
// documented ASSUMPTION instead of a real split: 3L/5L assumed box (box is
// the overwhelmingly dominant real-world format at these sizes), 4L assumed
// bottle. The label says "(assumed)" so this is visible, not silent.
const PACKAGE_TYPE_ASSUMPTIONS = {
  '3LT': 'Box',
  '5LT': 'Box',
  '4LT': 'Bottle',
};

// Small-format sizes where bottles are physically shorter, so more shelves
// realistically fit in the same vertical fixture space -- these sections get
// an extended shelf-count range (see optimizationEngine.js) instead of the
// standard 4-5 max.
export const SMALL_FORMAT_SIZES = new Set(['0.5LT', '0.375LT', '0.25LT', '0.187LT']);

export function isSmallFormatSection(section) {
  if (section.type !== 'size') return false;
  const size = section.key.replace('size:', '');
  return SMALL_FORMAT_SIZES.has(size);
}

export function sectionForSku(sku) {
  if (sku.bottleSizeRaw === SEVEN_FIFTY_ML) {
    if (isSparklingVarietal(sku.varietal)) {
      return { key: 'varietal:SPARKLING WINE', type: 'varietal', label: 'Sparkling Wine' };
    }
    const varietal = sku.varietal || 'UNSPECIFIED VARIETAL';
    return { key: `varietal:${varietal}`, type: 'varietal', label: varietal };
  }
  const size = sku.bottleSizeRaw || 'UNSPECIFIED SIZE';
  const assumedPackage = PACKAGE_TYPE_ASSUMPTIONS[size];
  const label = assumedPackage ? `${size} ${assumedPackage} (assumed)` : size;
  return { key: `size:${size}`, type: 'size', label };
}

export function groupBySection(skus) {
  const sections = new Map();
  skus.forEach((sku) => {
    const { key, type, label } = sectionForSku(sku);
    if (!sections.has(key)) sections.set(key, { key, type, label, skus: [] });
    sections.get(key).skus.push(sku);
  });
  return sections;
}

// Black Box must never outrank Bota Box/Bota Mini when scores are close --
// not an absolute rule regardless of score gap, just a tiebreak for near ties.
// Implemented as a single bounded pass of adjacent swaps (like one pass of
// bubble sort) rather than scanning ahead for any near-tied Bota anywhere in
// the list -- scanning ahead and splicing shifts every subsequent index,
// which caused the same Black Box entry to be reprocessed and cascade
// downward past far more Bota entries than a single "near tie" should move
// it past. An adjacent-only swap can't cascade: each Black Box entry moves
// at most one position per pass, only past a Bota immediately next to it.
const TIEBREAK_EPSILON = 5; // score points

export function applyBlackBoxTiebreak(rankedSkus, scoreMap) {
  const result = [...rankedSkus];
  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i];
    const next = result[i + 1];
    const currentIsBlackBox = /^BLACK BOX/i.test(current.brand || '');
    const nextIsBota = /^BOTA (BOX|MINI)/i.test(next.brand || '');
    if (!currentIsBlackBox || !nextIsBota) continue;
    const currentScore = scoreMap.get(current.skuId)?.score ?? 0;
    const nextScore = scoreMap.get(next.skuId)?.score ?? 0;
    if (currentScore - nextScore >= 0 && currentScore - nextScore < TIEBREAK_EPSILON) {
      result[i] = next;
      result[i + 1] = current;
    }
  }
  return result;
}

export function isSparklingSection(section) {
  return section.key === 'varietal:SPARKLING WINE';
}

// Sub-blocks the Sparkling Wine section by original specific varietal
// (Prosecco together, Brut together, etc.) -- subtype groups ordered by
// their combined score, SKUs within each subtype ordered by their own score.
export function subBlockBySubtype(skus, scoreMap) {
  const groups = new Map();
  skus.forEach((sku) => {
    const subtype = sku.varietal || 'UNSPECIFIED';
    if (!groups.has(subtype)) groups.set(subtype, []);
    groups.get(subtype).push(sku);
  });

  const orderedGroups = [...groups.entries()].map(([subtype, groupSkus]) => {
    const sorted = [...groupSkus].sort(
      (a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0)
    );
    const totalScore = sorted.reduce((sum, s) => sum + (scoreMap.get(s.skuId)?.score ?? 0), 0);
    return { subtype, sorted, totalScore };
  });

  orderedGroups.sort((a, b) => b.totalScore - a.totalScore);
  return orderedGroups.flatMap((g) => g.sorted);
}

// "Bota 3L" hard rule: Bota Box SKUs in the 3L size section get 50%+1 (bare
// majority) of that section's linear space, guaranteed, ahead of normal
// score-proportional distribution. Applied in facings.js via this flag.
export function isBota3LSection(section) {
  return section.type === 'size' && section.key === 'size:3LT';
}

export function isBotaBrand(sku) {
  return /^BOTA (BOX|MINI)/i.test(sku.brand || '');
}

// Trade-up adjacency: brands with an explicit multi-size flag get a
// cross-reference note in each SKU's explanation instead of literal shelf
// adjacency, since 750ml and larger sizes live in different sections.
// Opt-in list -- empty by default until specific brands are flagged.
export const TRADE_UP_BRANDS = new Set([
  // e.g. 'WOODBRIDGE BY ROBERT MONDAVI'
]);

export function tradeUpPartnerNote(sku, allSelectedSkus) {
  if (!TRADE_UP_BRANDS.has(sku.brand)) return null;
  const partner = allSelectedSkus.find(
    (s) => s.brand === sku.brand && s.varietal === sku.varietal && s.bottleSizeRaw !== sku.bottleSizeRaw
  );
  if (!partner) return null;
  const partnerSection = sectionForSku(partner);
  return `Trade-up partner (${partner.bottleSizeRaw}) is in the ${partnerSection.label} section`;
}
