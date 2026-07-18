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
export const PACKAGE_TYPE_ASSUMPTIONS = {
  '3LT': 'Box',
  '5LT': 'Box',
  '4LT': 'Bottle',
  '0.5LT': 'Bottle',
  '0.375LT': 'Bottle',
  '0.25LT': 'Bottle',
  '0.187LT': 'Bottle',
};

// Andrew, 2026-07-16: confirmed (not assumed) -- 16 SKUs recorded with raw
// size "0.748LT" (Sutter Home, Woodbridge, Barefoot, Cavit, Korbel, Cook's)
// are actually 4-packs of 187ml splits, mis-set to the summed pack volume
// instead of a real size code. Relabeled in data/skus.json to "0.187LT X4"
// so they get their own section instead of landing in either the 750ml
// varietal sections or the true single-mini 0.187LT section.
export const CONFIRMED_PACKAGE_TYPES = {
  '0.187LT X4': '4-Pack',
};

// Small-format sizes where bottles are physically shorter, so more shelves
// realistically fit in the same vertical fixture space -- these sections get
// an extended shelf-count range (see optimizationEngine.js) instead of the
// standard 4-5 max. Andrew, 2026-07-17: a bay with more shelves than typical
// is physically shorter per shelf (same total bay height, sliced more ways),
// so only packages this short belong there -- 750ml and up are assumed fine
// at store level and not gated here. Per data/bottleDimensions.json, every
// code below tops out at 9.5in (0.375LT) vs 750ml's 11.9in, so the full
// small-format family (single minis, multi-mini packs, and the 4-pack) all
// genuinely qualify -- this previously only listed the four single-bottle
// codes and missed every multi-pack variant.
// Andrew, 2026-07-18: 0.748LT X4 is a 4-pack (same shelf category as the
// other X4 packs, not its own size) and 0.2LT -- despite its raw ct=1
// label -- is also effectively a 4-pack for shelf purposes. Every other
// odd/rare container size surfaced by the pool-cap removal (0.72LT, 1LT,
// 1LT X4, 0.8LT X4, 1.42LT X4, 0.561LT X3, 4LT, 1.25LT X2, 9.464LT X12)
// stays OUT of this set on purpose -- those are real standalone categories,
// choosable independently like any other size, not small-format.
export const SMALL_FORMAT_SIZES = new Set([
  '0.5LT', '0.375LT', '0.25LT', '0.187LT',
  '0.187LT X2', '0.187LT X3', '0.187LT X4', '0.187LT X6',
  '0.2LT X4', '0.275LT X4', '0.355LT X4', '0.748LT X4', '0.2LT',
]);

export function isSmallFormatSection(section) {
  if (section.type !== 'size') return false;
  const size = section.key.replace('size:', '');
  return SMALL_FORMAT_SIZES.has(size);
}

// Andrew, 2026-07-15: Carlo Rossi doesn't come in a 3L box (it's a glass
// jug) and its "3L" catalog entries don't reflect a real, endemic Michigan
// product -- excluded from the assortment entirely, not just deprioritized.
// Andrew, 2026-07-16: same issue with Riunite 3L -- it's glass, not a box,
// so it doesn't belong in the 3L box set either. Excluded entirely.
// Andrew, 2026-07-16: Menage a Trois Assorted (UPC 0196383007961) and Stella
// Rosa Assorted (UPC 0087872635091) are seasonal assortment packs, ruled out
// for future use -- excluded by UPC (each brand has other, legitimate
// single-varietal SKUs that must stay).
// Andrew, 2026-07-18: Manos Detroit (x2 UPCs), Kolbie Regular, The Barber,
// and Worlds End -- flagged during the 750ml null-varietal review as not
// belonging in sets. Excluded by UPC, same as the seasonal-pack exclusions
// above.
const EXCLUDED_UPCS = new Set([
  '0196383007961', '0087872635091',
  '0810196750451', '0810196750241', '4061462873131', '0852743002811', '0670087475591'
]);
// Andrew, 2026-07-16, per "Suggested Measurements of wine sizes.xlsx":
// 0.187LT X5 ("These do not belong in sets. Period.") and 0.187LT X24, the
// advent-calendar box ("DOES NOT BELONG IN SET") -- excluded by size code
// entirely, not just deprioritized or narrow-sized.
const EXCLUDED_SIZES = new Set(['0.187LT X5', '0.187LT X24']);
export function isExcludedSku(sku) {
  if (/^CARLO ROSSI/i.test(sku.brand || '') && sku.bottleSizeRaw === '3LT') return true;
  if (/^RIUNITE/i.test(sku.brand || '') && sku.bottleSizeRaw === '3LT') return true;
  if (EXCLUDED_UPCS.has(sku.upc)) return true;
  if (EXCLUDED_SIZES.has(sku.bottleSizeRaw)) return true;
  return false;
}

// Andrew, 2026-07-15: Franzia 3L doesn't make sense as its own presence --
// it's redirected into the Franzia group in the 5L section (sectionForSku
// below), placed top-shelf-only within that block (see the pinnedToTopIds
// param on layoutGroupsAsBlocks in placementSolver.js) rather than getting
// the normal even vertical spread.
export function isFranzia3LRedirect(sku) {
  return /^FRANZIA/i.test(sku.brand || '') && sku.bottleSizeRaw === '3LT';
}

// Andrew, 2026-07-17: Livingston Cellars 3L is glass, not a box, same issue
// as Carlo Rossi 3L (excluded) and Riunite 3L (excluded) -- but unlike
// those two, Livingston Cellars 3L should still be sold, just grouped with
// Carlo Rossi in the 4L glass section instead of sitting in the 3L Box
// section. Spreads normally across the section's shelves (no top-shelf pin
// -- that treatment is Franzia-specific).
export function isLivingstonCellars3LRedirect(sku) {
  return /^LIVINGSTON CELLARS/i.test(sku.brand || '') && sku.bottleSizeRaw === '3LT';
}

export function sectionForSku(sku) {
  if (sku.bottleSizeRaw === SEVEN_FIFTY_ML) {
    if (isSparklingVarietal(sku.varietal)) {
      return { key: 'varietal:SPARKLING WINE', type: 'varietal', label: 'Sparkling Wine' };
    }
    const varietal = sku.varietal || 'UNSPECIFIED VARIETAL';
    return { key: `varietal:${varietal}`, type: 'varietal', label: varietal };
  }
  const size = isFranzia3LRedirect(sku)
    ? '5LT'
    : isLivingstonCellars3LRedirect(sku)
      ? '4LT'
      : (sku.bottleSizeRaw || 'UNSPECIFIED SIZE');
  const confirmedPackage = CONFIRMED_PACKAGE_TYPES[size];
  const assumedPackage = PACKAGE_TYPE_ASSUMPTIONS[size];
  const label = confirmedPackage
    ? `${size} ${confirmedPackage}`
    : assumedPackage
      ? `${size} ${assumedPackage} (assumed)`
      : size;
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

// Named sub-lines (2026-07-15): some brands' sub-line names carry a
// per-SKU flavor/style descriptor baked in (e.g. "BOTA BOX NIGHTHAWK
// BOURBON BARREL AGED" vs "BOTA BOX NIGHTHAWK BUTTERY" -- 8 different exact
// `brand` strings for what's really ONE sub-brand, Nighthawk). Left as raw
// exact-string grouping, that fragments into one single-SKU block per
// flavor instead of one cohesive Nighthawk block. This truncates the
// GROUPING key at the sub-line marker word while leaving the full
// descriptive name intact on the SKU itself (still shown per-box) -- same
// "group by a shorter key, order the group internally by score" pattern as
// subBlockBySubtype above, just applied to brand family instead of varietal
// subtype. Only Nighthawk and Breeze are big enough sub-lines to earn their
// OWN block this way -- extend this list only for a sub-line with the same
// multi-SKU-flavor-suffix problem.
const SUB_LINE_MARKERS = ['NIGHTHAWK', 'BREEZE'];
// Andrew, 2026-07-18: Redvolution, Brightside, "Dry" (Rose), or any other
// one-off Bota sub-line NOT in SUB_LINE_MARKERS above is "essentially part
// of Bota," not its own presence -- each was previously a single-SKU block
// of its own, which (with too few SKUs to fill every shelf row) cycled
// round-robin and showed up as "1 facing on 4 shelves" instead of sharing
// plain Bota's much larger, better-filled block. Fold anything Bota-
// branded that isn't a recognized major sub-line back to the bare
// "BOTA BOX"/"BOTA MINI" root.
const BOTA_ROOT_PATTERN = /^(BOTA (?:BOX|MINI))\b/;
export function brandGroupKey(brand) {
  const upper = (brand || '').toUpperCase();
  for (const marker of SUB_LINE_MARKERS) {
    const idx = upper.indexOf(marker);
    if (idx !== -1) return upper.slice(0, idx + marker.length);
  }
  const botaRoot = upper.match(BOTA_ROOT_PATTERN);
  if (botaRoot) return botaRoot[1];
  return upper;
}

// Brand-blocks a size section's SKUs (3L, 5L, 4L, sub-750ml) so all of one
// brand's (or sub-brand's) SKUs sit contiguously -- all Bota Box Nighthawk
// together, all Bota Box Breeze next to it, all plain Bota Box next to
// that, etc. -- rather than interleaved by raw score or fragmented into
// single-SKU blocks by a per-SKU flavor descriptor.
export function brandGroups(skus, scoreMap) {
  const groups = new Map();
  skus.forEach((sku) => {
    const brand = brandGroupKey(sku.brand) || 'UNSPECIFIED';
    if (!groups.has(brand)) groups.set(brand, []);
    groups.get(brand).push(sku);
  });

  const orderedGroups = [...groups.entries()].map(([brand, groupSkus]) => {
    const sorted = [...groupSkus].sort(
      (a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0)
    );
    const totalScore = sorted.reduce((sum, s) => sum + (scoreMap.get(s.skuId)?.score ?? 0), 0);
    return { label: brand, sorted, totalScore };
  });

  orderedGroups.sort((a, b) => b.totalScore - a.totalScore);
  return pinBotaBlackBoxFamilyOrder(orderedGroups);
}

// Andrew, 2026-07-16, simplified 2026-07-18: Bota Breeze, Bota (plain), and
// Bota Nighthawk always block together left-to-right in that order, and the
// whole Bota family always lands in a better spot than any OTHER brand in
// the same size/section -- not tied to beating Black Box specifically
// (dropped 2026-07-18: pinning Black Box immediately after Bota regardless
// of its own score was an unnecessary special case; Black Box now just
// keeps its normal score-based position among every other non-Bota brand).
// Any other Bota sub-line not called out explicitly (Redvolution,
// Brightside) sits in the "plain Bota" slot -- least-surprising default
// until Andrew specifies otherwise.
function botaFamilyRank(groupLabel) {
  if (/^BOTA/.test(groupLabel)) {
    if (groupLabel.includes('BREEZE')) return 0;
    if (groupLabel.includes('NIGHTHAWK')) return 2;
    return 1; // plain Bota + any other unlisted Bota sub-line
  }
  return null;
}

export function pinBotaBlackBoxFamilyOrder(orderedGroups) {
  const familyIndices = [];
  orderedGroups.forEach((g, i) => { if (botaFamilyRank(g.label) != null) familyIndices.push(i); });
  if (!familyIndices.length) return orderedGroups;

  const family = familyIndices.map((i) => orderedGroups[i])
    .sort((a, b) => botaFamilyRank(a.label) - botaFamilyRank(b.label));

  const result = orderedGroups.filter((_, i) => !familyIndices.includes(i));
  result.unshift(...family); // Bota always goes first, ahead of every other brand
  return result;
}

export function rankByBrandBlocks(skus, scoreMap) {
  return brandGroups(skus, scoreMap).flatMap((g) => g.sorted);
}

// "Bota 3L" hard rule: Bota Box SKUs in the 3L size section get 50%+1 (bare
// majority) of that section's linear space, guaranteed, ahead of normal
// score-proportional distribution. Applied in facings.js via this flag.
export function isBota3LSection(section) {
  return section.type === 'size' && section.key === 'size:3LT';
}

// Any Bota sub-brand (Bota Box, Bota Mini, Bota Breeze, Bota Nighthawk, etc.)
// counts as Bota for the 3L hard rule -- Andrew, 2026-07-15: previously only
// matched "BOTA BOX"/"BOTA MINI" literally, so sub-brands like Bota
// Nighthawk were miscounted as a competing "other" brand instead of pooling
// with the rest of the Bota family.
export function isBotaBrand(sku) {
  return /^BOTA\b/i.test(sku.brand || '');
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
