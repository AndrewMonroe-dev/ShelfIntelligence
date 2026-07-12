import { computeScoreMap } from '../calc/scoreEngine.js';
import { selectAssortment } from './assortment.js';
import {
  groupBySection, applyBlackBoxTiebreak, isBota3LSection, isBotaBrand, tradeUpPartnerNote,
  isSparklingSection, subBlockBySubtype,
} from './blocking.js';
import { buildSectionShelves } from './shelfPosition.js';
import { computeFacings, computeFacingsWithBotaFloor } from './facings.js';

const MIN_SECTION_LINEAR_FEET = 4;
const DEFAULT_SECTION_SHELF_COUNT = 5;

// Splits a score-sorted SKU list into `shelfCount` contiguous groups, largest
// groups first, so the top-scored cluster lands on the best shelf position.
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

export function generatePlan(store, allSkus, metricsConfig, targetSkuCount, bottleDimensions, sectionMultipliers = {}, sectionShelfCounts = {}) {
  const scoreMap = computeScoreMap(allSkus, metricsConfig);
  const { selected } = selectAssortment(allSkus, targetSkuCount, metricsConfig);

  const sectionsMap = groupBySection(selected);
  const sectionScores = new Map();
  let grandTotalScore = 0;
  sectionsMap.forEach((section, key) => {
    const total = section.skus.reduce((sum, sku) => sum + (scoreMap.get(sku.skuId)?.score ?? 0), 0);
    sectionScores.set(key, total);
    grandTotalScore += total;
  });
  grandTotalScore = grandTotalScore || 1;

  // Per-section manual multipliers (default 1) scale each section's raw score
  // share, then the whole set is renormalized so shares still sum to 1 --
  // expanding one section proportionally shrinks all the others, keeping the
  // store's total linear feet/shelf count fixed rather than growing the set.
  let weightedTotal = 0;
  const weightedShares = new Map();
  sectionsMap.forEach((section, key) => {
    const rawShare = (sectionScores.get(key) || 0) / grandTotalScore;
    const multiplier = sectionMultipliers[key] ?? 1;
    const weighted = rawShare * multiplier;
    weightedShares.set(key, weighted);
    weightedTotal += weighted;
  });
  weightedTotal = weightedTotal || 1;

  const totalLinearFeet = store.shelfLayout.totalLinearFeet;

  const sections = [];
  sectionsMap.forEach((section, key) => {
    const scoreShare = (weightedShares.get(key) || 0) / weightedTotal;
    // Sections are built in 4-foot blocks minimum -- the score-proportional
    // width stays continuous (not rounded to a 4ft multiple), it just can't
    // fall below one block's worth of space. Shelf count is a per-section
    // setting (4 or 5), not derived from score -- this also means a section
    // never rounds down to an unrealistic single eye-level-only shelf.
    const linearFeet = Math.max(MIN_SECTION_LINEAR_FEET, totalLinearFeet * scoreShare);
    const shelfCount = sectionShelfCounts[key] ?? DEFAULT_SECTION_SHELF_COUNT;

    let ranked = isSparklingSection(section)
      ? subBlockBySubtype(section.skus, scoreMap)
      : [...section.skus].sort((a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0));
    ranked = applyBlackBoxTiebreak(ranked, scoreMap);

    const shelfDefs = buildSectionShelves(store.shelfLayout.shelves, shelfCount);
    const groups = partitionIntoShelves(ranked, shelfCount);

    // Facings are computed PER ROW, not once for the whole section's SKU
    // list -- the section's width repeats at every shelf level (confirmed:
    // "that same 9-foot width repeats at every shelf level in the section"),
    // it isn't divided among the rows. Each row independently fills the same
    // `linearFeet` budget with its own subset of SKUs.
    const shelves = shelfDefs.map((shelfDef, i) => {
      const rowSkus = groups[i] || [];
      const facingsResult = isBota3LSection(section)
        ? computeFacingsWithBotaFloor(rowSkus, scoreMap, linearFeet, bottleDimensions, isBotaBrand)
        : computeFacings(rowSkus, scoreMap, linearFeet, bottleDimensions);
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
          { factor: 'Facings', value: facing?.facings ?? 1 },
        ];
        if (sku.strategicSupplierPriority) reasons.push({ factor: 'Strategic Supplier Priority', enabled: true });
        if (isBota3LSection(section) && isBotaBrand(sku)) reasons.push({ factor: 'Bota 3L guaranteed majority space', enabled: true });
        if (tradeUpNote) reasons.push({ factor: 'Trade-up', value: tradeUpNote });
        return {
          skuId: sku.skuId,
          brand: sku.brand,
          varietal: sku.varietal,
          priceUsd: sku.priceUsd,
          bottleSizeRaw: sku.bottleSizeRaw,
          score: scoreEntry?.score ?? 0,
          facings: facing?.facings ?? 1,
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
    });
  });

  sections.sort((a, b) => b.totalScore - a.totalScore);

  return {
    storeId: store.storeId,
    generatedAt: new Date().toISOString(),
    targetSkuCount,
    skuCount: selected.length,
    sections,
  };
}
