import { computeScoreMap } from '../calc/scoreEngine.js';
import { selectAssortment } from './assortment.js';
import {
  groupBySection, applyBlackBoxTiebreak, isBota3LSection, isBotaBrand, tradeUpPartnerNote,
  isSparklingSection, subBlockBySubtype,
} from './blocking.js';
import { buildSectionShelves } from './shelfPosition.js';
import { computeFacings, computeFacingsWithBotaFloor } from './facings.js';
import { isMarketShareSection, getSectionMarketShare } from './marketShare.js';
import { priceBand, allowedPositions, positionPreferenceMultiplier, appliesPriceBandRules, PRICE_BAND_LABELS } from './priceBand.js';

const MIN_SECTION_LINEAR_FEET = 4;
const DEFAULT_SECTION_SHELF_COUNT = 5;
const CASE_ONLY_FLOOR_FACINGS = 2;
const STANDARD_FLOOR_FACINGS = 1;

// Splits a score-sorted SKU list into `shelfCount` contiguous groups, largest
// groups first, so the top-scored cluster lands on the best shelf position.
// Used for sections NOT subject to the price-band position rules (size
// sections, sub-750ml).
function partitionIntoShelves(sortedSkus, shelfCount) {
  if (shelfCount <= 0) return [];
  const n = sortedSkus.length;
  const base = Math.floor(n / shelfCount);
  const remainder = n % shelfCount;
  const groups = [];
  let idx = 0;
  for (let i = 0; i < shelfCount; i++) {
    const size = base + (i < remainder ? 1 : 0);
    groups.push(sortedSkus.slice(idx, idx + size));
    idx += size;
  }
  return groups;
}

// Constrained partition for 750ml varietal sections: each SKU's price band
// hard-restricts which physical shelf positions it may land on (see
// priceBand.js), with a soft preference layered on top (eye level mainly to
// $10-14/$14-20, top shelf mostly to $20+). Greedy: process SKUs in score
// order, assign each to its highest-preference ALLOWED position that still
// has quota; if none has quota, still place it in its best allowed position
// (never drop a SKU) so "no set should have empty space" still holds.
function partitionIntoShelvesConstrained(sortedSkus, shelfDefs) {
  const shelfCount = shelfDefs.length;
  const eyeDef = shelfDefs.find((d) => d.zone === 'eye');
  const eyePosition = eyeDef ? eyeDef.position : null;

  const n = sortedSkus.length;
  const base = Math.floor(n / shelfCount);
  const remainder = n % shelfCount;
  const quotas = shelfDefs.map((_, i) => base + (i < remainder ? 1 : 0));
  const remainingQuota = [...quotas];

  const groups = Array.from({ length: shelfCount }, () => []);
  const constraintNotes = new Map(); // skuId -> note, for outlier flagging

  sortedSkus.forEach((sku) => {
    const band = priceBand(sku.priceUsd);
    const allowed = allowedPositions(band, shelfCount);

    let candidates = allowed.filter((p) => remainingQuota[p - 1] > 0);
    if (!candidates.length) candidates = allowed;

    let best = candidates[0];
    let bestValue = -Infinity;
    candidates.forEach((p) => {
      const def = shelfDefs[p - 1];
      const value = def.shelfScore * positionPreferenceMultiplier(band, p, eyePosition);
      if (value > bestValue) { bestValue = value; best = p; }
    });

    // Outlier flag: if this SKU's highest-scoring position in the WHOLE
    // section was excluded purely by its price band, and it's genuinely a
    // strong scorer, note it for manual review ("prompt when found") rather
    // than silently overriding the hard constraint with a guessed threshold.
    const unconstrainedBestPosition = shelfDefs.reduce((a, b) => (b.shelfScore > a.shelfScore ? b : a));
    if (!allowed.includes(unconstrainedBestPosition.position) && unconstrainedBestPosition.position !== best) {
      constraintNotes.set(sku.skuId, `Price band (${PRICE_BAND_LABELS[band]}) restricted from ${unconstrainedBestPosition.zone} to position ${best}`);
    }

    groups[best - 1].push(sku);
    if (remainingQuota[best - 1] > 0) remainingQuota[best - 1]--;
  });

  return { groups, constraintNotes };
}

export function generatePlan(
  store, allSkus, metricsConfig, targetSkuCount, bottleDimensions,
  sectionMultipliers = {}, sectionShelfCounts = {}, sizePackageData = [], caseOnlyMode = false
) {
  const context = store.qualityScore != null ? { qualityScore: store.qualityScore } : null;
  const scoreMap = computeScoreMap(allSkus, metricsConfig, context);
  const { selected } = selectAssortment(allSkus, targetSkuCount, metricsConfig, context);

  const sectionsMap = groupBySection(selected);

  // Section weight for sizing: varietal sections use the sum of their SKUs'
  // opportunity scores (as before). Market-share-exempt size sections (3L,
  // 4L, 5L, sub-747ml -- see marketShare.js) instead use their REAL national
  // market share, scaled against the same grand total so both are expressed
  // on comparable footing and compete for space on equal terms.
  const grandTotalScore = selected.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0) || 1;

  const sectionScores = new Map();
  sectionsMap.forEach((section, key) => {
    if (isMarketShareSection(section)) {
      const share = getSectionMarketShare(section, sizePackageData);
      sectionScores.set(key, share * grandTotalScore);
    } else {
      const total = section.skus.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0);
      sectionScores.set(key, total);
    }
  });
  const sectionScoreTotal = [...sectionScores.values()].reduce((a, b) => a + b, 0) || 1;

  // Per-section manual multipliers (default 1) scale each section's raw
  // weight, then the whole set is renormalized so shares still sum to 1 --
  // expanding one section proportionally shrinks all the others, keeping the
  // store's total linear feet/shelf count fixed rather than growing the set.
  let weightedTotal = 0;
  const weightedShares = new Map();
  sectionsMap.forEach((section, key) => {
    const rawShare = (sectionScores.get(key) || 0) / sectionScoreTotal;
    const multiplier = sectionMultipliers[key] ?? 1;
    const weighted = rawShare * multiplier;
    weightedShares.set(key, weighted);
    weightedTotal += weighted;
  });
  weightedTotal = weightedTotal || 1;

  const totalLinearFeet = store.shelfLayout.totalLinearFeet;

  // The fixture is physically built from 4ft bays, not a continuous ribbon --
  // "160ft, 5 shelves" means 40 bays of 4ft x 5 shelves each. Section widths
  // must therefore be whole multiples of 4ft, not an arbitrary float share.
  // Bays are allocated by score share using largest-remainder apportionment
  // (each section gets its floor share, then leftover bays go one at a time
  // to the sections with the largest fractional remainder) so bay counts
  // always sum to exactly the fixture's total bays, with every section
  // guaranteed at least 1 bay.
  const totalBays = Math.max(1, Math.floor(totalLinearFeet / MIN_SECTION_LINEAR_FEET));
  const sectionKeys = [...sectionsMap.keys()];
  const rawBays = sectionKeys.map((key) => {
    const scoreShare = (weightedShares.get(key) || 0) / weightedTotal;
    return scoreShare * totalBays;
  });
  const bayCounts = new Map();
  let allocatedBays = 0;
  sectionKeys.forEach((key, i) => {
    const bays = Math.max(1, Math.floor(rawBays[i]));
    bayCounts.set(key, bays);
    allocatedBays += bays;
  });
  let remainderBays = totalBays - allocatedBays;
  if (remainderBays > 0) {
    const byRemainder = sectionKeys
      .map((key, i) => ({ key, frac: rawBays[i] - Math.floor(rawBays[i]) }))
      .sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < byRemainder.length && remainderBays > 0; i++) {
      bayCounts.set(byRemainder[i].key, bayCounts.get(byRemainder[i].key) + 1);
      remainderBays--;
    }
  }

  const sections = [];
  sectionsMap.forEach((section, key) => {
    const scoreShare = (weightedShares.get(key) || 0) / weightedTotal;
    const linearFeet = bayCounts.get(key) * MIN_SECTION_LINEAR_FEET;
    const shelfCount = sectionShelfCounts[key] ?? DEFAULT_SECTION_SHELF_COUNT;

    let ranked = isSparklingSection(section)
      ? subBlockBySubtype(section.skus, scoreMap)
      : [...section.skus].sort((a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0));
    ranked = applyBlackBoxTiebreak(ranked, scoreMap);

    const shelfDefs = buildSectionShelves(store.shelfLayout.shelves, shelfCount);

    const usesPriceBandRules = appliesPriceBandRules(section);
    const { groups, constraintNotes } = usesPriceBandRules
      ? partitionIntoShelvesConstrained(ranked, shelfDefs)
      : { groups: partitionIntoShelves(ranked, shelfCount), constraintNotes: new Map() };

    // Case-only mode (global toggle, alterable before generating) raises the
    // facing floor from 1 to 2 for 750ml varietal sections only -- size
    // sections aren't case-pack SKUs in the same sense and are unaffected.
    const floorFacings = (usesPriceBandRules && caseOnlyMode) ? CASE_ONLY_FLOOR_FACINGS : STANDARD_FLOOR_FACINGS;

    // Facings are computed PER ROW, not once for the whole section's SKU
    // list -- the section's width repeats at every shelf level, it isn't
    // divided among the rows. Each row independently fills the same
    // `linearFeet` budget with its own subset of SKUs.
    const shelves = shelfDefs.map((shelfDef, i) => {
      const rowSkus = groups[i] || [];
      const facingsResult = isBota3LSection(section)
        ? computeFacingsWithBotaFloor(rowSkus, scoreMap, linearFeet, bottleDimensions, isBotaBrand, floorFacings)
        : computeFacings(rowSkus, scoreMap, linearFeet, bottleDimensions, floorFacings);
      const facingsBySkuId = new Map(facingsResult.map((f) => [f.skuId, f]));

      return {
        ...shelfDef,
        skus: rowSkus.map((sku) => {
          const scoreEntry = scoreMap.get(sku.skuId);
          const facing = facingsBySkuId.get(sku.skuId);
          const tradeUpNote = tradeUpPartnerNote(sku, selected);
          const reasons = [
            ...(scoreEntry?.breakdown || []).slice(0, 3).map((b) => ({
              factor: b.label,
              contribution: Number(b.contribution.toFixed(1)),
            })),
            { factor: 'Shelf position', value: `${shelfDef.zone} (index ${shelfDef.verticalIndex})` },
            { factor: 'Traffic', value: shelfDef.traffic },
            { factor: 'Facings', value: facing?.facings ?? floorFacings },
          ];
          if (usesPriceBandRules) {
            reasons.push({ factor: 'Price band', value: PRICE_BAND_LABELS[priceBand(sku.priceUsd)] });
          }
          if (sku.strategicSupplierPriority) reasons.push({ factor: 'Strategic Supplier Priority', enabled: true });
          if (isBota3LSection(section) && isBotaBrand(sku)) reasons.push({ factor: 'Bota 3L guaranteed majority space', enabled: true });
          if (tradeUpNote) reasons.push({ factor: 'Trade-up', value: tradeUpNote });
          const constraintNote = constraintNotes.get(sku.skuId);
          if (constraintNote) reasons.push({ factor: 'Price-band constraint flag', value: constraintNote });
          return {
            skuId: sku.skuId,
            brand: sku.brand,
            varietal: sku.varietal,
            priceUsd: sku.priceUsd,
            bottleSizeRaw: sku.bottleSizeRaw,
            score: scoreEntry?.score ?? 0,
            facings: facing?.facings ?? floorFacings,
            widthInches: facing?.widthInches ?? null,
            allocatedInches: facing?.allocatedInches ?? null,
            reasons,
          };
        }),
      };
    });

    sections.push({
      key,
      type: section.type,
      label: section.label,
      totalScore: sectionScores.get(key) || 0,
      scoreShare,
      multiplier: sectionMultipliers[key] ?? 1,
      linearFeet,
      shelfCount,
      shelves,
      usesMarketShareSizing: isMarketShareSection(section),
      usesPriceBandRules,
    });
  });

  sections.sort((a, b) => b.totalScore - a.totalScore);

  return {
    storeId: store.storeId,
    generatedAt: new Date().toISOString(),
    targetSkuCount,
    skuCount: selected.length,
    caseOnlyMode,
    sections,
  };
}
