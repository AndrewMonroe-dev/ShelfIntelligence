import { computeScoreMap } from '../calc/scoreEngine.js';
import { dedupeByBrandVarietalSize } from './assortment.js';
import {
  sectionForSku, applyBlackBoxTiebreak, isBota3LSection, isBotaBrand, tradeUpPartnerNote,
  isSparklingSection, subBlockBySubtype, rankByBrandBlocks, brandGroups,
  isExcludedSku, isFranzia3LRedirect, isSmallFormatSection, pinBotaBlackBoxFamilyOrder,
} from './blocking.js';
import { buildSectionShelves, getPhysicalWidthFt, getShelvesForSpan } from './shelfPosition.js';
import { computeFacings, computeFacingsWithBotaFloor, bottleWidthInches, fitSkusToWidth } from './facings.js';
import { isMarketShareSection, getSectionMarketShare } from './marketShare.js';
import { priceBand, allowedPositions, positionPreferenceMultiplier, appliesPriceBandRules, PRICE_BAND_LABELS } from './priceBand.js';

const CASE_ONLY_FLOOR_FACINGS = 2;
const STANDARD_FLOOR_FACINGS = 1;
// A section that can't fill more than this much width can't realistically
// use more than one shelf row's worth of distinct product -- it defaults to
// its top shelf only. When adjacent thin sections exist, they merge into
// one shared shelf stack instead of each getting a mostly-empty column.
// ">4ft is the new standard" -- Andrew, 2026-07-15: anything above 4ft
// stands alone, 4ft and under merges.
export const THIN_SECTION_WIDTH_FT = 4;

// Splits a group's sorted SKU list into `shelfCount` contiguous chunks, as
// even as possible (top rows get the extra one on an uneven split) -- same
// quota math used elsewhere (partitionIntoShelvesConstrained/Sparse), just
// applied per group instead of across the whole section. `pinnedToTopFn`
// (e.g. the Franzia-3L-into-5L redirect) pulls matching SKUs out of the
// even split entirely and places them on row 0 only, ahead of that row's
// normal share -- a one-off exception, not part of the block's normal
// vertical spread.
function chunkEvenlyAcrossRows(sortedSkus, shelfCount, pinnedToTopFn = null) {
  const pinned = pinnedToTopFn ? sortedSkus.filter(pinnedToTopFn) : [];
  const rest = pinnedToTopFn ? sortedSkus.filter((s) => !pinnedToTopFn(s)) : sortedSkus;
  const n = rest.length;

  // Fewer distinct SKUs than shelves (e.g. a 1-SKU brand in a 4-shelf set):
  // the old remainder-based split dumped the whole group onto the first
  // `n` rows and left the rest of the shelves with NOTHING from this brand
  // -- which made that brand's block vanish on later rows and threw off
  // every row's total width (some rows had every brand, some only had the
  // big ones). Cycle the SKUs round-robin instead so every row gets at
  // least one representative (repeating a SKU across shelves is normal
  // real-world blocking for a small assortment). Fixed 2026-07-15 after
  // Andrew caught mismatched row widths on Bay B1.
  if (n > 0 && n < shelfCount) {
    const chunks = Array.from({ length: shelfCount }, (_, i) => [rest[i % n]]);
    if (pinned.length) chunks[0] = [...pinned, ...chunks[0]];
    return chunks;
  }

  const base = Math.floor(n / shelfCount);
  const remainder = n % shelfCount;
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < shelfCount; i++) {
    const size = base + (i < remainder ? 1 : 0);
    const chunk = rest.slice(cursor, cursor + size);
    chunks.push(i === 0 ? [...pinned, ...chunk] : chunk);
    cursor += size;
  }
  return chunks;
}

// True vertical blocks with PER-BLOCK facings (2026-07-15): each group (a
// brand within a size section, or a category within a merged thin/sparse
// section) claims its own contiguous width slice, appearing on EVERY shelf
// row in that slice -- not a sequential top-row-then-wrap fill, which let a
// group spill onto the next row mixed in with the next group. Critically,
// bonus "fill the width" facings are also scoped PER BLOCK, not across the
// whole row -- otherwise the largest-remainder algorithm (see facings.js)
// keeps dumping bonus facings on whichever single SKU in the ENTIRE row is
// most under its fair share, which can hoover up almost all the row's width
// on one or two top scorers while every other brand/category sits at floor
// facings, effectively disappearing next to it. Andrew caught exactly this
// on a live "Retailer X - Location 12" set.
//
// Each block's target width is its floor requirement (max across its own
// rows, so every row of the block reaches the same width -- a rectangle),
// topped up proportional to its total score with whatever width is left
// after every block's floor is covered.
function layoutGroupsAsBlocks(groups, shelfCount, totalWidthInches, scoreMap, bottleDimensions, floorFacings, botaFloorTest = null, pinnedToTopFn = null) {
  const perGroupChunks = groups.map((g) => chunkEvenlyAcrossRows(g.sorted, shelfCount, pinnedToTopFn));
  let blockInfo = groups.map((g, gi) => {
    const rows = perGroupChunks[gi];
    const rowFloorWidths = rows.map((chunk) =>
      chunk.reduce((s, sku) => s + bottleWidthInches(sku, bottleDimensions) * floorFacings, 0)
    );
    const maxRowFloorWidth = rowFloorWidths.length ? Math.max(...rowFloorWidths) : 0;
    const totalScore = g.sorted.reduce((s, sku) => s + (scoreMap.get(sku.skuId)?.score ?? 0), 0);
    return { rows, maxRowFloorWidth, totalScore, sample: g.sorted[0] };
  });

  // Width-scaling alone (below) can't rescue a section where the block
  // count itself is the problem -- a block that's already down to a single
  // SKU per row can't be trimmed any smaller, so if the sum of every
  // block's floor requirement still exceeds the section width after
  // scaling would drive individual SKUs below their own floor width, the
  // section physically cannot hold every block. Drop lowest-scoring blocks
  // entirely (greedy best-fit by score, most valuable blocks kept first)
  // until what remains actually fits at floor -- staying within the bay's
  // real linear feet takes priority over guaranteeing every brand a column.
  const totalFloorAll = blockInfo.reduce((s, b) => s + b.maxRowFloorWidth, 0);
  if (totalFloorAll > totalWidthInches) {
    const byScoreDesc = [...blockInfo].sort((a, b) => b.totalScore - a.totalScore);
    const kept = [];
    let usedFloor = 0;
    for (const b of byScoreDesc) {
      if (usedFloor === 0 || usedFloor + b.maxRowFloorWidth <= totalWidthInches) {
        kept.push(b);
        usedFloor += b.maxRowFloorWidth;
      }
    }
    blockInfo = kept;
  }

  const floorTotal = blockInfo.reduce((s, b) => s + b.maxRowFloorWidth, 0);
  const totalScoreAll = blockInfo.reduce((s, b) => s + b.totalScore, 0) || 1;
  let targetWidths;
  if (floorTotal > totalWidthInches && floorTotal > 0) {
    // More blocks' floor requirements than the bay's real linear feet can
    // hold (common now that the MI dataset packs many more distinct brands
    // into the same physical sections) -- scale every block's budget down
    // proportionally instead of letting the sum of floors run over the
    // section width. Each block's row roster is then trimmed to fit its
    // shrunk budget below (fitSkusToWidth), dropping lowest scorers first,
    // rather than forcing a floor facing for every SKU regardless of fit.
    const scale = totalWidthInches / floorTotal;
    targetWidths = blockInfo.map((b) => b.maxRowFloorWidth * scale);
  } else {
    targetWidths = blockInfo.map((b) => b.maxRowFloorWidth);
    const remaining = Math.max(0, totalWidthInches - floorTotal);
    if (remaining > 0) {
      blockInfo.forEach((b, i) => { targetWidths[i] += remaining * (b.totalScore / totalScoreAll); });
    }
  }

  // Bota 3L hard rule, now applied per-block instead of per-SKU: Bota-family
  // blocks collectively get at least 50%+1 of the section's width. Scale
  // Bota blocks up to the requirement (preserving their relative sizes),
  // then scale non-Bota blocks down to fit what's left, never below their
  // own floor requirement.
  if (botaFloorTest) {
    const botaIdx = blockInfo.map((b, i) => (b.sample && botaFloorTest(b.sample) ? i : -1)).filter((i) => i >= 0);
    const otherIdx = blockInfo.map((_, i) => i).filter((i) => !botaIdx.includes(i));
    if (botaIdx.length && otherIdx.length) {
      const botaTotal = botaIdx.reduce((s, i) => s + targetWidths[i], 0);
      const required = totalWidthInches * 0.5 + 0.0001;
      if (botaTotal < required && botaTotal > 0) {
        const scaleUp = required / botaTotal;
        botaIdx.forEach((i) => { targetWidths[i] *= scaleUp; });
        const newBotaTotal = botaIdx.reduce((s, i) => s + targetWidths[i], 0);
        const otherBudget = Math.max(0, totalWidthInches - newBotaTotal);
        const otherNaturalTotal = otherIdx.reduce((s, i) => s + targetWidths[i], 0) || 1;
        otherIdx.forEach((i) => {
          targetWidths[i] = Math.max(blockInfo[i].maxRowFloorWidth, otherBudget * (targetWidths[i] / otherNaturalTotal));
        });
      }
    }
  }

  const rowGroups = Array.from({ length: shelfCount }, () => []);
  const facingsBySkuId = new Map();
  blockInfo.forEach((b, gi) => {
    const budgetInches = targetWidths[gi];
    b.rows.forEach((chunk, rowIdx) => {
      if (!chunk.length) return;
      // Andrew, 2026-07-18: no SKU gets more than 1 facing, full stop --
      // breadth, not depth, same rule already applied to small formats on
      // 07-17 now extended to every regular-size brand block too. Trim to
      // whatever this block's (possibly shrunk) budget can hold at floor
      // facings; if the block's own roster is smaller than its width
      // budget (e.g. Breeze only has 6 real SKUs), the leftover width
      // stays unused rather than getting spent as bonus facings on
      // whichever SKU scored best. The removed bonus-facing pass had a
      // real side effect worth naming: it could let a SKU with a strong
      // score on some OTHER metric (growth%, margin) outrank the true best
      // seller for shelf depth -- backwards, since extra facings exist to
      // prevent a stockout on whatever's actually moving fastest, not to
      // reward whichever SKU has the best composite score on paper. This
      // change doesn't redirect the freed-up space to the top seller
      // either -- it simply stops spending it, per Andrew's exercise rule.
      const fitted = fitSkusToWidth(chunk, budgetInches, bottleDimensions, floorFacings);
      fitted.forEach((sku) => {
        const widthInches = bottleWidthInches(sku, bottleDimensions);
        facingsBySkuId.set(sku.skuId, { skuId: sku.skuId, facings: floorFacings, widthInches, allocatedInches: widthInches * floorFacings });
      });
      rowGroups[rowIdx].push(...fitted);
    });
  });

  return { rowGroups, facingsBySkuId };
}

// Andrew, 2026-07-17 (revised after first pass): small-format sizes (187s,
// 4-packs, mini multi-packs, 375s, 500mls) get a genuine TWO-LEVEL layout.
// Level 1 -- each exact size code (0.5LT, 0.187LT X4, 0.375LT, etc.) keeps
// its own dedicated shelf row(s), proportional to that size's combined
// score share, never interleaved with another size ("a shelf of 4-packs,
// two shelves of .5L, half a shelf of 375s" -- rows are the closest
// available unit to "half a shelf" without a sub-row model). Level 2 --
// WITHIN a size's own allotted rows, brand blocking (best brand on the best
// of that size's rows) only applies if the size actually got more than one
// row; a single-row (or single-brand) allotment just ranks all its SKUs by
// score and fills as many distinct ones as fit. Facings are always 1 per
// SKU in both levels -- Andrew, 2026-07-17: "these should all be 1 facing
// SKUs going down the dollar sales list," i.e. fill width with breadth
// (more distinct SKUs) rather than depth (more facings on one SKU).
function allocateRowsBySize(naturalPool, shelfDefs, scoreMap, totalWidthInches, bottleDimensions) {
  const bySize = new Map();
  naturalPool.forEach((sku) => {
    const key = sku.bottleSizeRaw || 'UNSPECIFIED';
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(sku);
  });
  const groups = [...bySize.entries()].map(([size, skus]) => ({
    size, skus,
    totalScore: skus.reduce((s, sk) => s + (scoreMap.get(sk.skuId)?.score ?? 0), 0),
    // Sum of every SKU's own width at 1 facing -- the real amount of shelf
    // this size's actual inventory needs to show its full breadth.
    floorWidthInches: skus.reduce((s, sk) => s + bottleWidthInches(sk, bottleDimensions), 0),
  })).sort((a, b) => b.totalScore - a.totalScore);

  const shelfCount = shelfDefs.length;
  // More size codes present than rows to give them -- keep the highest-
  // scoring ones (at least 1 row each), same drop-lowest philosophy already
  // used for width elsewhere in this file.
  const kept = groups.length > shelfCount ? groups.slice(0, shelfCount) : groups;
  const n = kept.length;
  if (!n) return [];

  // Andrew, 2026-07-18 (third pass on row allocation): row count per size
  // should track how many rows that size's OWN real inventory can actually
  // fill, not a fixed split. A rigid "minor size gets 1 row" rule (tried
  // previously) made sense when the minor size genuinely only had a
  // handful of SKUs, but broke down once the extended-tier catalog gate
  // was removed and BOTH sizes could have plenty of real content -- "a big
  // sub-750 area with a lot of shelves would have a lot of 500mls AND
  // 4-packs to work with... 3 shelves of 4-pack, or 3 shelves of .5L."
  const contentNeeded = kept.map((g) => Math.max(1, Math.ceil(g.floorWidthInches / totalWidthInches)));
  const totalNeeded = contentNeeded.reduce((s, r) => s + r, 0);

  let rowCounts;
  if (totalNeeded <= shelfCount) {
    // Andrew, 2026-07-18: every shelf gets filled, full stop -- that's the
    // priority over anything else. Start from what each size's own
    // inventory needs, then hand out any genuinely leftover rows as BONUS
    // rows (largest-remainder by score share, same mechanism used
    // everywhere else in this file) rather than leaving them unassigned.
    // A size that gets more rows than its strict content need cycles back
    // through its own ranked list from the top to fill them (see
    // fillSmallFormatGroupRows) -- the same product can appear on more
    // than one shelf, which is different from stacking extra facings on
    // one SKU within a single row.
    rowCounts = [...contentNeeded];
    const leftover = shelfCount - totalNeeded;
    if (leftover > 0) {
      const totalScoreAll = kept.reduce((s, g) => s + g.totalScore, 0) || 1;
      const shares = kept.map((g) => (g.totalScore / totalScoreAll) * leftover);
      const bonus = kept.map((_, i) => Math.floor(shares[i]));
      let distributed = bonus.reduce((s, b) => s + b, 0);
      const remainders = kept.map((_, i) => ({ i, frac: shares[i] - Math.floor(shares[i]) })).sort((a, b) => b.frac - a.frac);
      for (let k = 0; distributed < leftover && k < remainders.length; k++, distributed++) {
        bonus[remainders[k].i]++;
      }
      rowCounts = rowCounts.map((r, i) => r + bonus[i]);
    }
  } else {
    // Not enough rows for everyone's full breadth -- fall back to score-
    // proportional (1-row floor, largest-remainder for the rest, same
    // approach computeFacings uses for bonus facings), then still cap each
    // size at what its OWN content needs and hand back anything reclaimed
    // to whichever other size could still use more.
    const extra = shelfCount - n;
    const totalScoreAll = kept.reduce((s, g) => s + g.totalScore, 0) || 1;
    const shares = kept.map((g) => (g.totalScore / totalScoreAll) * extra);
    rowCounts = kept.map((_, i) => 1 + Math.floor(shares[i]));
    let distributed = rowCounts.reduce((s, r) => s + r, 0);
    const remainders = kept.map((_, i) => ({ i, frac: shares[i] - Math.floor(shares[i]) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; distributed < shelfCount && k < remainders.length; k++, distributed++) {
      rowCounts[remainders[k].i]++;
    }
    let reclaimed = 0;
    kept.forEach((g, i) => {
      if (rowCounts[i] > contentNeeded[i]) {
        reclaimed += rowCounts[i] - contentNeeded[i];
        rowCounts[i] = contentNeeded[i];
      }
    });
    let guard = 0;
    while (reclaimed > 0 && guard < shelfCount) {
      guard++;
      const needMore = kept.map((_, i) => i).filter((i) => rowCounts[i] < contentNeeded[i]);
      if (!needMore.length) break; // nobody else can productively use another row
      const target = needMore.reduce((best, i) => (kept[i].totalScore > kept[best].totalScore ? i : best));
      rowCounts[target]++;
      reclaimed--;
    }
    if (reclaimed > 0) rowCounts[0] += reclaimed; // truly nothing left to use it -- give it to the top scorer rather than stranding it
  }

  const rankedShelves = [...shelfDefs].sort((a, b) => b.shelfScore - a.shelfScore);
  let cursor = 0;
  return kept.map((g, i) => {
    const rows = rankedShelves.slice(cursor, cursor + rowCounts[i]);
    cursor += rowCounts[i];
    return { ...g, rows };
  });
}

// Andrew, 2026-07-17 (third pass) -- root cause of "Bota split across two
// shelves with 1 SKU stranded on the second": brandGroups() (used
// elsewhere for regular-size vertical blocking) groups by the EXACT brand
// string, so a sub-line SKU like "BOTA MINI REDVOLUTION" or "BLACK BOX
// WINES DEEP & DARK" is a completely different group from its own parent
// brand ("BOTA MINI", "BLACK BOX WINES") as far as the row balancer is
// concerned -- splitting one real brand family across rows it should never
// have left. Small-format row balancing needs the FAMILY, not the exact
// string: any brand that is a word-boundary prefix of another brand
// present in this same pool (checked locally, not via a hardcoded marker
// list like blocking.js's SUB_LINE_MARKERS) collapses under that shorter
// root for grouping purposes, while each SKU keeps its own full brand name
// for display.
function collapseToRootBrand(skus, scoreMap) {
  const distinctBrands = [...new Set(skus.map((s) => s.brand || 'UNSPECIFIED'))];
  const rootCache = new Map();
  function rootFor(brand) {
    if (rootCache.has(brand)) return rootCache.get(brand);
    const upper = brand.toUpperCase();
    let root = brand;
    distinctBrands.forEach((other) => {
      if (other === brand) return;
      const otherUpper = other.toUpperCase();
      if (otherUpper.length < root.toUpperCase().length && upper.startsWith(`${otherUpper} `)) {
        root = other;
      }
    });
    rootCache.set(brand, root);
    return root;
  }
  const groups = new Map();
  skus.forEach((sku) => {
    const root = rootFor(sku.brand || 'UNSPECIFIED');
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(sku);
  });
  const ordered = [...groups.entries()].map(([root, groupSkus]) => {
    const sorted = [...groupSkus].sort((a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0));
    const totalScore = sorted.reduce((s, sk) => s + (scoreMap.get(sk.skuId)?.score ?? 0), 0);
    return { label: root, sorted, totalScore };
  });
  ordered.sort((a, b) => b.totalScore - a.totalScore);
  // Andrew, 2026-07-17: Bota must ALWAYS land in a better spot than Black
  // Box, full stop -- not score-dependent. Same hard family-order rule
  // already applied to regular-size vertical blocking (blocking.js
  // pinBotaBlackBoxFamilyOrder), reused here since this function is a
  // parallel brand-grouping path for small formats that was bypassing it.
  return pinBotaBlackBoxFamilyOrder(ordered);
}

// Andrew, 2026-07-18 (fifth pass on small-format row filling): the previous
// wraparound fill walked a FLAT SKU list, which could cut a brand family in
// half at a row boundary (e.g. Black Box's first few SKUs finishing one row
// and the rest spilling into the next) -- exactly the "families must never
// split across shelves" rule from earlier undone by "fill every shelf."
// Both hold at once by making the FAMILY the atomic unit here instead of
// the SKU: walk the family list (Bota-before-Black-Box order preserved),
// add whole families to a row while they still fit, move to the next row
// once the next family wouldn't fit, and wrap back to the first family for
// the next row once the list is exhausted -- same "every shelf gets
// product, cycling if needed" behavior, just never splitting a family
// mid-row. A lone family wider than one full row still gets included whole
// (never leave a row artificially empty), matching the same exception
// fitSkusToWidth already uses at the SKU level.
function fillSmallFormatGroupRows(skus, rows, totalWidthInches, scoreMap, bottleDimensions, floorFacings) {
  const byPosition = new Map();
  const families = collapseToRootBrand(skus, scoreMap);
  if (!families.length) return byPosition;
  const familyWidth = (fam) => fam.sorted.reduce((s, sk) => s + bottleWidthInches(sk, bottleDimensions) * floorFacings, 0);

  let cursor = 0;
  // Andrew, 2026-07-18: the previous `steps < families.length` bound stopped
  // each row after visiting every family once, even when a lot of width was
  // still unused -- it never actually took the "wrap back to the first
  // family" cycling the comment above describes. A family can now repeat
  // within the same row (and across rows) as many times as it takes to
  // genuinely fill the width; the safety ceiling below is just a backstop
  // against a true infinite loop, not a realistic limit.
  const maxStepsPerRow = families.length * 200;
  rows.forEach((row) => {
    const rowSkus = [];
    let used = 0;
    for (let steps = 0; steps < maxStepsPerRow; steps++) {
      if (cursor >= families.length) cursor = 0;
      const fam = families[cursor];
      const w = familyWidth(fam);
      if (used > 0 && used + w > totalWidthInches) break; // next family doesn't fit alongside what's already placed -- save it for the next row
      rowSkus.push(...fam.sorted);
      used += w;
      cursor++;
    }
    if (rowSkus.length) byPosition.set(row.position, rowSkus);
  });
  return byPosition;
}

function layoutSmallFormatSection(naturalPool, shelfDefs, totalWidthInches, scoreMap, bottleDimensions, floorFacings) {
  const shelfCount = shelfDefs.length;
  const rowGroups = Array.from({ length: shelfCount }, () => []);
  const facingsBySkuId = new Map();
  if (!naturalPool.length) return { rowGroups, facingsBySkuId };

  const sizeAllocations = allocateRowsBySize(naturalPool, shelfDefs, scoreMap, totalWidthInches, bottleDimensions);
  sizeAllocations.forEach(({ skus, rows }) => {
    const byPosition = fillSmallFormatGroupRows(skus, rows, totalWidthInches, scoreMap, bottleDimensions, floorFacings);
    byPosition.forEach((fitted, position) => {
      rowGroups[position - 1].push(...fitted);
      fitted.forEach((sku) => {
        const widthInches = bottleWidthInches(sku, bottleDimensions);
        facingsBySkuId.set(sku.skuId, { skuId: sku.skuId, facings: floorFacings, widthInches, allocatedInches: widthInches * floorFacings });
      });
    });
  });

  return { rowGroups, facingsBySkuId };
}

// Sparse-category fallback (2026-07-15): when a varietal section has fewer
// SKUs than shelves, the hard price-band constraint can't be satisfied --
// there aren't enough SKUs to cover every band/position combination. Instead
// of leaving shelves empty, drop the band restriction entirely and place by
// price rank: reuses the same top-down quota split as the constrained path
// (top shelf gets first claim), but fills each shelf's quota with the
// highest-priced remaining SKUs first -- small categories get pushed to the
// top shelves for visibility, and price still progresses vertically (higher
// shelf, higher price). Within each shelf, SKUs are ordered left-to-right
// ascending by price (cheapest left, priciest right), per Andrew's rule.
function partitionIntoShelvesSparse(sortedSkus, shelfDefs) {
  const shelfCount = shelfDefs.length;
  const n = sortedSkus.length;
  const base = Math.floor(n / shelfCount);
  const remainder = n % shelfCount;
  const quotas = shelfDefs.map((_, i) => base + (i < remainder ? 1 : 0));

  const priceRankedDesc = [...sortedSkus].sort((a, b) => (b.priceUsd ?? 0) - (a.priceUsd ?? 0));

  const groups = [];
  const constraintNotes = new Map();
  let cursor = 0;
  quotas.forEach((q) => {
    const chunk = priceRankedDesc.slice(cursor, cursor + q);
    chunk.sort((a, b) => (a.priceUsd ?? 0) - (b.priceUsd ?? 0)); // left-to-right ascending
    chunk.forEach((sku) => constraintNotes.set(sku.skuId, 'Sparse category: placed by price rank (top-down), price-band rule waived'));
    groups.push(chunk);
    cursor += q;
  });

  return { groups, constraintNotes };
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
  sectionAllocations = [], sectionMultipliers = {}, sizePackageData = [], caseOnlyMode = false, overrides = []
) {
  const context = store.qualityScore != null ? { qualityScore: store.qualityScore } : null;
  const scoreMap = computeScoreMap(allSkus, metricsConfig, context);
  const physicalWidthFt = getPhysicalWidthFt(store.shelfLayout);

  // Each section now pulls from its OWN full category pool (dedup'd,
  // eligibility-filtered) rather than a slice of one global top-N list --
  // `targetSkuCount` no longer caps the assortment, it's kept only as a
  // pass-through label (the one-time auto-allocate seed still uses it to
  // size initial section widths, see allocationSeed.js).
  const deduped = dedupeByBrandVarietalSize(allSkus, scoreMap);
  // Andrew, 2026-07-18: removed the base/extended tier gate (previously
  // required a store's total fixture to exceed 112ft before "extended"
  // SKUs became eligible at all). A 20ft .5L section should be able to
  // grab everything ranked into that space regardless of the store's
  // OVERALL size -- space-driven fill (fitSkusToWidth/allocateRowsBySize)
  // already determines how deep into the ranked pool a section actually
  // reaches, so a separate store-wide gate on top of that was just cutting
  // off real inventory (half the 0.5LT catalog, in one real case) before
  // ranking ever got a chance to include it.
  // Andrew, 2026-07-17: a single 0.187LT mini is too small to belong in a
  // set on its own once that same brand also sells a 0.187LT X4 4-pack --
  // computed dynamically from whatever brands are actually in the pool
  // (rather than a hardcoded brand list) so it stays correct as the SKU
  // data changes.
  const brandsWithFourPack = new Set(allSkus.filter((s) => s.bottleSizeRaw === '0.187LT X4').map((s) => s.brand));
  const eligiblePool = deduped.filter((sku) =>
    !isExcludedSku(sku)
    && !(sku.bottleSizeRaw === '0.187LT' && brandsWithFourPack.has(sku.brand))
  );

  // Manual overrides always win over the AI recommendation, and bypass
  // tier eligibility entirely (a 'place' override can put ANY SKU on the
  // shelf, extended pool or not, regardless of fixture size). A 'remove'
  // excludes a SKU from the plan no matter how it scores.
  const removedSkuIds = new Set(overrides.filter((o) => o.action === 'remove').map((o) => o.skuId));
  const placeOverrides = overrides.filter((o) => o.action === 'place' && !removedSkuIds.has(o.skuId));
  const placedSkuIds = new Set(placeOverrides.map((o) => o.skuId));

  const allocationByKey = new Map(sectionAllocations.map((a) => [a.key, a]));

  // `placementsBySkuId` records each locked SKU's resolved section/shelf/
  // facings -- a stale target (section deleted in Set Layout since the
  // override was saved) falls back to the SKU's natural section rather
  // than crashing or vanishing, still locked at its stated facings.
  const placementsBySkuId = new Map();
  placeOverrides.forEach((o) => {
    const sku = allSkus.find((s) => s.skuId === o.skuId);
    if (!sku) return;
    const natural = sectionForSku(sku);
    const targetKey = allocationByKey.has(o.sectionKey) ? o.sectionKey : natural.key;
    placementsBySkuId.set(o.skuId, { sku, sectionKey: targetKey, shelfPosition: o.shelfPosition, facings: o.facings });
  });

  // Builds one allocation's category pool, ranking, and locked-SKU split --
  // identical regardless of whether the section ends up thin/merged or not.
  // Thin-ness only changes what happens to this data AFTER it's built.
  function buildCategoryData(allocation) {
    const key = allocation.key;
    const naturalMatches = eligiblePool.filter((sku) =>
      sectionForSku(sku).key === key && !removedSkuIds.has(sku.skuId) && !placedSkuIds.has(sku.skuId)
    );
    const placedHere = [...placementsBySkuId.values()].filter((p) => p.sectionKey === key).map((p) => p.sku);
    const categorySkus = [...naturalMatches, ...placedHere];

    const type = key.startsWith('varietal:') ? 'varietal' : 'size';
    const section = { key, type, label: allocation.label, skus: categorySkus };

    let ranked = isSparklingSection(section)
      ? subBlockBySubtype(categorySkus, scoreMap)
      : type === 'size'
        ? rankByBrandBlocks(categorySkus, scoreMap)
        : [...categorySkus].sort((a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0));
    ranked = applyBlackBoxTiebreak(ranked, scoreMap);

    const lockedSkuIds = new Set(
      [...placementsBySkuId.entries()].filter(([, p]) => p.sectionKey === key).map(([skuId]) => skuId)
    );
    const naturalPool = ranked.filter((sku) => !lockedSkuIds.has(sku.skuId));
    const lockedForSection = ranked.filter((sku) => lockedSkuIds.has(sku.skuId));

    return { allocation, key, type, section, categorySkus, ranked, naturalPool, lockedForSection, lockedSkuIds };
  }

  // Builds one section's final output shelves. Every standalone section
  // (merged or not, narrow or not) always fills every shelf row -- Set
  // Layout's widthFt is a BLOCK width applied identically to every shelf,
  // not a linear-feet total, so width alone never restricts which rows get
  // product (fixed 2026-07-15, see THIN_SECTION_WIDTH_FT comment). Locked/
  // override SKUs still honor their exact requested shelfPosition
  // regardless, since manual placement always wins.
  function buildSectionOutput(data) {
    const { allocation, key, type, section, categorySkus, ranked, naturalPool, lockedForSection, lockedSkuIds } = data;
    if (!categorySkus.length) return null;

    const linearFeet = allocation.widthFt;
    const startFt = allocation.startFt;

    const storeShelves = getShelvesForSpan(store.shelfLayout, startFt, linearFeet);
    const shelfCount = storeShelves.length;
    const shelfDefs = buildSectionShelves(storeShelves, shelfCount);

    const usesPriceBandRules = appliesPriceBandRules(section);
    const floorFacings = (usesPriceBandRules && caseOnlyMode) ? CASE_ONLY_FLOOR_FACINGS : STANDARD_FLOOR_FACINGS;
    // Andrew, 2026-07-18: 1-facing-max (breadth, not depth) extended to 750ml
    // varietal sections too -- same reasoning as the 07-17 extension to
    // 3L/4L/5L blocks. No more bonus facings on top scorers; leftover width
    // goes to showing more distinct SKUs instead. Case Only Mode's raised
    // floor (2) still applies as both floor and ceiling when active.
    const maxFacings = floorFacings;

    function lockedInchesForRow(rowIndex) {
      const lockedInRow = lockedForSection.filter((sku) => {
        const pos = placementsBySkuId.get(sku.skuId).shelfPosition;
        return Math.max(1, Math.min(shelfCount, pos || 1)) === rowIndex + 1;
      });
      return lockedInRow.reduce((sum, sku) => sum + bottleWidthInches(sku, bottleDimensions) * placementsBySkuId.get(sku.skuId).facings, 0);
    }

    // Row assignment + space-driven fill: a section's actual SKU roster is
    // decided PER ROW by how many distinct SKUs fit at floor facings
    // (fitSkusToWidth), not by a fixed pre-sliced group -- so a section
    // reaches as deep into its category's ranked pool as its width allows.
    let rowGroups;
    let constraintNotes = new Map();
    let blockFacingsBySkuId = null; // set only for size sections -- bypasses the generic per-row facings call below
    if (usesPriceBandRules) {
      // Price band is a harder constraint than "fill greedily" -- keep the
      // existing constrained position assignment as the primary row
      // decision, then fit-to-width each resulting row (a rare trim, since
      // the constrained assignment already quotas by count). Falls back to
      // partitionIntoShelvesSparse when there aren't enough SKUs to cover
      // every shelf under the hard band constraint -- either by raw count,
      // or (Andrew, 2026-07-18) when the category's SKUs happen to cluster
      // in one or two price bands (e.g. Germany/Riesling skewing cheap) and
      // the hard band restrictions leave a shelf with zero eligible SKUs
      // even though there's plenty of product overall. "No set should have
      // empty space" wins over the price-band rule in that case.
      let result = naturalPool.length < shelfCount
        ? partitionIntoShelvesSparse(naturalPool, shelfDefs)
        : partitionIntoShelvesConstrained(naturalPool, shelfDefs);
      if (result.groups.some((rowSkus) => rowSkus.length === 0) && naturalPool.length >= shelfCount) {
        result = partitionIntoShelvesSparse(naturalPool, shelfDefs);
      }
      constraintNotes = result.constraintNotes;
      rowGroups = result.groups.map((rowSkus, i) => {
        const widthInches = Math.max(0, linearFeet * 12 - lockedInchesForRow(i));
        return fitSkusToWidth(rowSkus, widthInches, bottleDimensions, floorFacings);
      });
    } else if (isSmallFormatSection(section)) {
      // Small-format sizes (187s, 4-packs, mini multi-packs, 375s, 500mls):
      // a standalone section is already one size code, so this just brand-
      // blocks that size across its own rows (best brand on the best row)
      // when it has more than one row to work with. Andrew, 2026-07-17.
      const blockResult = layoutSmallFormatSection(
        naturalPool, shelfDefs, linearFeet * 12, scoreMap, bottleDimensions, floorFacings
      );
      rowGroups = blockResult.rowGroups;
      blockFacingsBySkuId = blockResult.facingsBySkuId;
    } else {
      // Size sections: true vertical brand blocks -- each brand's SKUs are
      // split evenly across every shelf row, each capped to 1 facing per
      // SKU (Andrew, 2026-07-18) and scoped to its OWN width budget (not
      // the whole row), so a brand appears on every shelf as a consistent
      // column instead of spilling onto the next row or getting starved by
      // a bigger scorer elsewhere in the row. Andrew's rule 2026-07-15:
      // "everything should be in block based categories." Known
      // limitation: locked-SKU width (lockedInchesForRow) isn't subtracted
      // from the block width budget here -- a heavily-overridden row may
      // run slightly over.
      const blockResult = layoutGroupsAsBlocks(
        brandGroups(naturalPool, scoreMap), shelfCount, linearFeet * 12,
        scoreMap, bottleDimensions, floorFacings,
        isBota3LSection(section) ? isBotaBrand : null,
        key === 'size:5LT' ? isFranzia3LRedirect : null
      );
      rowGroups = blockResult.rowGroups;
      blockFacingsBySkuId = blockResult.facingsBySkuId;
    }

    rowGroups = rowGroups.map((group) => [...group]);
    lockedForSection.forEach((sku) => {
      const position = placementsBySkuId.get(sku.skuId).shelfPosition;
      const clamped = Math.max(1, Math.min(shelfCount, position || 1));
      rowGroups[clamped - 1].push(sku);
    });

    // Facings are computed PER ROW, not once for the whole section's SKU
    // list -- the section's width repeats at every shelf level, it isn't
    // divided among the rows. Each row independently fills the same
    // `linearFeet` budget with its own fitted subset of SKUs.
    const shelves = shelfDefs.map((shelfDef, i) => {
      const rowSkus = rowGroups[i] || [];
      const lockedRowSkus = rowSkus.filter((sku) => lockedSkuIds.has(sku.skuId));
      const nonLockedRowSkus = rowSkus.filter((sku) => !lockedSkuIds.has(sku.skuId));

      // Locked SKUs' facing counts are fixed by the override, not computed --
      // reserve their consumed width first, then let the normal facings
      // algorithm fill whatever's left with the non-locked SKUs.
      const lockedInches = lockedInchesForRow(i);
      const effectiveLinearFeet = Math.max(0, linearFeet - lockedInches / 12);

      const facingsBySkuId = blockFacingsBySkuId ?? new Map(
        (isBota3LSection(section)
          ? computeFacingsWithBotaFloor(nonLockedRowSkus, scoreMap, effectiveLinearFeet, bottleDimensions, isBotaBrand, floorFacings)
          : computeFacings(nonLockedRowSkus, scoreMap, effectiveLinearFeet, bottleDimensions, floorFacings, maxFacings)
        ).map((f) => [f.skuId, f])
      );

      lockedRowSkus.forEach((sku) => {
        const override = placementsBySkuId.get(sku.skuId);
        const widthInches = bottleWidthInches(sku, bottleDimensions);
        facingsBySkuId.set(sku.skuId, { skuId: sku.skuId, facings: override.facings, widthInches, allocatedInches: widthInches * override.facings });
      });

      return {
        ...shelfDef,
        skus: rowSkus.map((sku) => {
          const scoreEntry = scoreMap.get(sku.skuId);
          const facing = facingsBySkuId.get(sku.skuId);
          const tradeUpNote = tradeUpPartnerNote(sku, categorySkus);
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
          const isLocked = lockedSkuIds.has(sku.skuId);
          if (isLocked) reasons.push({ factor: 'Manual override', value: 'Locked by user' });
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
            isLocked,
            reasons,
          };
        }),
      };
    });

    return {
      key,
      type,
      label: allocation.label,
      multiplier: sectionMultipliers[key] ?? 1,
      startFt,
      linearFeet,
      shelfCount,
      shelves,
      usesMarketShareSizing: isMarketShareSection(section),
      usesPriceBandRules,
    };
  }

  // Builds one combined section from 2+ adjacent thin/sparse allocations:
  // each member category is its own vertical block -- appearing on every
  // shelf row within its own slice of the combined width, per Andrew's rule
  // 2026-07-15 ("everything should be in block based categories"), same
  // mechanism as brand blocking below. Price-band positioning and the
  // Bota-3L guarantee are intentionally NOT applied here (merging thin
  // sections is itself an exception to normal positioning rules). Known
  // limitation: a locked/override SKU targeting a section that ends up
  // merged is still guaranteed to appear (concatenated near the front of
  // its category's block), but its exact requested shelfPosition isn't
  // preserved once shelves are shared across categories -- precise
  // position-locking inside a merged block is out of scope.
  function buildMergedSectionOutput(memberAllocations, memberDataList) {
    const withSkus = memberDataList.filter((d) => d.categorySkus.length);
    if (!withSkus.length) return null;

    const combinedWidth = memberAllocations.reduce((sum, a) => sum + a.widthFt, 0);
    const startFt = memberAllocations[0].startFt;
    const combinedLockedSkuIds = new Set(withSkus.flatMap((d) => [...d.lockedSkuIds]));

    const storeShelves = getShelvesForSpan(store.shelfLayout, startFt, combinedWidth);
    const shelfCount = storeShelves.length;
    const shelfDefs = buildSectionShelves(storeShelves, shelfCount);

    // The merge-eligibility guard above (currentRunIsSmallFormat) guarantees
    // every member of a merged run is either all small-format or all
    // regular-format -- never mixed -- so checking the first member decides
    // layout mode for the whole group.
    const isSmallFormatRun = isSmallFormatSection(withSkus[0].section);
    let rowGroups, blockFacingsBySkuId;
    if (isSmallFormatRun) {
      // Each exact size code (187s, 4-packs, 375s, 500mls) keeps its own
      // dedicated row(s) within the merged pool -- never interleaved with
      // another size -- and only brand-blocks within a size's own rows when
      // it actually got more than one. Andrew, 2026-07-17 (revised).
      const pooled = withSkus.flatMap((d) => [...d.naturalPool, ...d.lockedForSection]);
      const result = layoutSmallFormatSection(
        pooled, shelfDefs, combinedWidth * 12, scoreMap, bottleDimensions, STANDARD_FLOOR_FACINGS
      );
      rowGroups = result.rowGroups;
      blockFacingsBySkuId = result.facingsBySkuId;
    } else {
      const categoryGroups = withSkus.map((d) => ({
        label: d.section.label,
        sorted: [...d.naturalPool, ...d.lockedForSection],
      }));
      const result = layoutGroupsAsBlocks(
        categoryGroups, shelfCount, combinedWidth * 12, scoreMap, bottleDimensions, STANDARD_FLOOR_FACINGS
      );
      rowGroups = result.rowGroups;
      blockFacingsBySkuId = result.facingsBySkuId;
    }

    const shelves = shelfDefs.map((shelfDef, i) => {
      const rowSkus = rowGroups[i] || [];
      const facingsBySkuId = blockFacingsBySkuId;

      return {
        ...shelfDef,
        skus: rowSkus.map((sku) => {
          const scoreEntry = scoreMap.get(sku.skuId);
          const facing = facingsBySkuId.get(sku.skuId);
          const isLocked = combinedLockedSkuIds.has(sku.skuId);
          const reasons = [
            ...(scoreEntry?.breakdown || []).slice(0, 3).map((b) => ({
              factor: b.label,
              contribution: Number(b.contribution.toFixed(1)),
            })),
            { factor: 'Shelf position', value: `${shelfDef.zone} (index ${shelfDef.verticalIndex})` },
            { factor: 'Traffic', value: shelfDef.traffic },
            { factor: 'Facings', value: facing?.facings ?? STANDARD_FLOOR_FACINGS },
            { factor: 'Combined section', value: 'Merged with adjacent thin categories (each ≤' + THIN_SECTION_WIDTH_FT + 'ft)' },
          ];
          if (isLocked) reasons.push({ factor: 'Manual override', value: 'Locked by user' });
          return {
            skuId: sku.skuId,
            brand: sku.brand,
            varietal: sku.varietal,
            priceUsd: sku.priceUsd,
            bottleSizeRaw: sku.bottleSizeRaw,
            score: scoreEntry?.score ?? 0,
            facings: facing?.facings ?? STANDARD_FLOOR_FACINGS,
            widthInches: facing?.widthInches ?? null,
            allocatedInches: facing?.allocatedInches ?? null,
            isLocked,
            reasons,
          };
        }),
      };
    });

    return {
      key: `merged:${memberAllocations.map((a) => a.key).join('+')}`,
      type: 'merged',
      label: memberAllocations.map((a) => a.label).join(' + '),
      multiplier: 1,
      startFt,
      linearFeet: combinedWidth,
      shelfCount,
      shelves,
      usesMarketShareSizing: false,
      usesPriceBandRules: false,
    };
  }

  const sortedAllocations = [...sectionAllocations].sort((a, b) => a.order - b.order);

  // Build each allocation's category data once, up front, so both the
  // width-based and SKU-sparsity-based thin checks below can use it without
  // recomputing.
  const allocationData = sortedAllocations.map((allocation) => ({
    allocation,
    data: buildCategoryData(allocation),
  }));

  // A varietal section counts as SKU-sparse if it has fewer natural-pool SKUs
  // than the shelves in its own span -- the same condition that triggers
  // partitionIntoShelvesSparse in buildSectionOutput. Per Andrew's rule
  // 2026-07-15, a sparse section should also be eligible for the thin-section
  // merge (borrow a neighbor's product/space) rather than sit with empty
  // shelves below whatever the price-rank fallback could place.
  function isSkuSparse(allocation, data) {
    if (data.type !== 'varietal') return false;
    const storeShelves = getShelvesForSpan(store.shelfLayout, allocation.startFt, allocation.widthFt);
    return data.naturalPool.length > 0 && data.naturalPool.length < storeShelves.length;
  }

  // Group into runs: consecutive allocations that are thin BY LINEAR FEET
  // (widthFt * shelfCount <= 4) OR SKU-sparse merge into one shared shelf
  // stack; everything else stands alone. Definition fix, 2026-07-15: Set
  // Layout's widthFt is a BLOCK width applied to every shelf, not a linear-
  // feet total -- a 3ft-wide block in a 4-shelf set is 12 linear feet, not
  // 3, and was wrongly collapsing to one row under the old widthFt-only
  // check. The linear-feet threshold now only catches genuinely tiny blocks
  // (e.g. <=1ft wide in a 4-shelf set); SKU-sparsity is the main practical
  // merge trigger going forward. A merge is only allowed between allocations
  // whose OWN standalone shelf count matches -- otherwise the combined
  // span's center can land in a different bay than either member's own bay
  // (real store data has mixed shelf counts per bay), silently changing the
  // block's shelf count mid-merge.
  function ownShelfCount(allocation) {
    return getShelvesForSpan(store.shelfLayout, allocation.startFt, allocation.widthFt).length;
  }

  // Andrew, 2026-07-17: a small-format section (187s, 4-packs, mini multi-
  // packs, 375s, 500mls -- all physically short, see SMALL_FORMAT_SIZES)
  // must never merge into the same shared block as a regular-format section
  // (750ml+, 1.5L, 3L, 4L, 5L) -- a bay with more shelves than typical is
  // assumed reserved for these short packages specifically, so a merge that
  // pulled in a much taller bottle would defeat that assumption. Doesn't
  // require knowing real bay heights: it just keeps the two size families
  // from ever sharing a merged run.
  function isSmallFormatRun(data) {
    return isSmallFormatSection(data.section);
  }

  const groups = [];
  let currentThinRun = [];
  let currentRunShelfCount = null;
  let currentRunIsSmallFormat = null;
  allocationData.forEach(({ allocation, data }) => {
    const shelfCountHere = ownShelfCount(allocation);
    const linearFeetHere = allocation.widthFt * shelfCountHere;
    const smallFormatHere = isSmallFormatRun(data);
    // Andrew, 2026-07-17: small-format sections always share one pool with
    // an adjacent small-format section, regardless of width/sparsity --
    // that's the only way row real estate can be arbitrated between sizes
    // (e.g. capping a sparse 4-pack group to 1 row and handing the rest to
    // 500ml, see allocateRowsBySize) instead of each size independently
    // claiming every row in its own standalone section. The smallFormatMatches
    // check below still keeps this from merging into a NON-small-format
    // neighbor.
    // Andrew, 2026-07-17: varietal sections (Cabernet, Chardonnay, Merlot,
    // Rose, etc.) must always stay their own independently-labeled section,
    // filled only from their own ranked pool to whatever width they're
    // allocated -- even if that means very few SKUs. A thin or sparse
    // varietal used to borrow a neighbor's product via this merge; that's
    // no longer wanted. buildSectionOutput's own sparse fallback already
    // fills every shelf row for a thin/sparse standalone section, so
    // un-merging doesn't leave empty shelves. Non-varietal (size-based)
    // thin sections and small-format's row-arbitration merge are unchanged.
    const isMergeEligible = data.type !== 'varietal' && (linearFeetHere <= THIN_SECTION_WIDTH_FT || isSkuSparse(allocation, data) || smallFormatHere);
    const shelfCountMatches = currentRunShelfCount === null || shelfCountHere === currentRunShelfCount;
    const smallFormatMatches = currentRunIsSmallFormat === null || smallFormatHere === currentRunIsSmallFormat;
    if (isMergeEligible && shelfCountMatches && smallFormatMatches) {
      currentThinRun.push({ allocation, data });
      currentRunShelfCount = shelfCountHere;
      currentRunIsSmallFormat = smallFormatHere;
    } else {
      if (currentThinRun.length) { groups.push(currentThinRun); currentThinRun = []; }
      currentRunShelfCount = isMergeEligible ? shelfCountHere : null;
      currentRunIsSmallFormat = isMergeEligible ? smallFormatHere : null;
      if (isMergeEligible) { currentThinRun.push({ allocation, data }); return; }
      groups.push([{ allocation, data }]);
    }
  });
  if (currentThinRun.length) groups.push(currentThinRun);

  const sections = [];
  groups.forEach((group) => {
    const groupAllocations = group.map((g) => g.allocation);
    const dataList = group.map((g) => g.data);

    if (groupAllocations.length === 1) {
      // Standalone section -- always fills every shelf row (block width
      // applies uniformly per shelf; buildSectionOutput's own sparse
      // fallback already handles genuinely low-SKU-count cases).
      const sectionOut = buildSectionOutput(dataList[0]);
      if (sectionOut) sections.push(sectionOut);
      return;
    }

    const sectionOut = buildMergedSectionOutput(groupAllocations, dataList);
    if (sectionOut) sections.push(sectionOut);
  });

  const totalAllocatedWidth = sections.reduce((sum, s) => sum + s.linearFeet, 0);
  const overflowFt = totalAllocatedWidth - physicalWidthFt;

  const allPlaced = sections.flatMap((s) => s.shelves.flatMap((sh) => sh.skus));
  const uniquePlaced = [...new Map(allPlaced.map((s) => [s.skuId, s])).values()];
  const tierBySkuId = new Map(allSkus.map((s) => [s.skuId, s.assortmentTier]));

  return {
    storeId: store.storeId,
    generatedAt: new Date().toISOString(),
    targetSkuCount,
    skuCount: uniquePlaced.length,
    baseCount: uniquePlaced.filter((s) => tierBySkuId.get(s.skuId) === 'base').length,
    extendedCount: uniquePlaced.filter((s) => tierBySkuId.get(s.skuId) === 'extended').length,
    brandCount: new Set(uniquePlaced.map((s) => s.brand)).size,
    varietalCount: new Set(uniquePlaced.map((s) => s.varietal).filter(Boolean)).size,
    caseOnlyMode,
    sections,
    isOverflowing: overflowFt > 0.05,
    overflowFt,
  };
}
