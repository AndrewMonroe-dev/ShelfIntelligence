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
  // Andrew, 2026-07-19: no repeats anywhere, full stop -- a brand with
  // fewer real SKUs than its block has rows just leaves the extra rows of
  // its own column empty rather than repeating a SKU into a second
  // position. Where you place a SKU is the only spot it goes unless it's
  // getting more facings in that same spot (see skuDepthExhausted below
  // for surfacing the resulting shortfall instead of silently padding it).
  if (n > 0 && n < shelfCount) {
    const chunks = Array.from({ length: shelfCount }, () => []);
    rest.forEach((sku, i) => { chunks[i] = [sku]; });
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
  // Andrew, 2026-07-20 (bug found via 3LT Box investigation): the TOP
  // scorer is always force-kept regardless of its own width ("usedFloor
  // === 0" branch), so a single wide block (Bota Box, 11 SKUs) can alone
  // exceed the row and poison `usedFloor` past totalWidthInches -- every
  // smaller block checked afterward then fails, even a 1-SKU brand that
  // would trivially fit. But that force-kept oversized block gets scaled
  // DOWN afterward anyway (see floorTotal/scale below), so this drop
  // decision was made against a width nothing actually ends up needing.
  // Result: 20 of 25 real brands for Retailer X - Location 12's 3LT Box
  // were dropped entirely while every shelf row sat 45%+ empty. Dropped
  // blocks are now kept aside and backfilled below once real leftover
  // space (after scaling) is known, instead of being discarded for good.
  // Andrew, 2026-07-20: the cull decision (which blocks survive) still
  // ranks by score, but the SURVIVING blocks must render in their
  // ORIGINAL order (groups' incoming order, e.g. brandGroups' pinned
  // Bota Breeze -> Bota Box -> Bota Nighthawk -> everyone else by score) --
  // building `kept` by pushing in score order silently reshuffled render
  // order to pure score whenever any drop happened, which broke that
  // pinning (Black Box, higher raw score than Bota Nighthawk/Breeze, was
  // rendering BETWEEN them instead of after the whole Bota family).
  const droppedBlocks = [];
  const totalFloorAll = blockInfo.reduce((s, b) => s + b.maxRowFloorWidth, 0);
  if (totalFloorAll > totalWidthInches) {
    const byScoreDesc = [...blockInfo].sort((a, b) => b.totalScore - a.totalScore);
    const keptSet = new Set();
    let usedFloor = 0;
    for (const b of byScoreDesc) {
      if (usedFloor === 0 || usedFloor + b.maxRowFloorWidth <= totalWidthInches) {
        keptSet.add(b);
        usedFloor += b.maxRowFloorWidth;
      } else {
        droppedBlocks.push(b);
      }
    }
    blockInfo = blockInfo.filter((b) => keptSet.has(b));
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
  const rowUsedInches = new Array(shelfCount).fill(0);
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
      rowUsedInches[rowIdx] += fitted.reduce((s, sku) => s + bottleWidthInches(sku, bottleDimensions) * floorFacings, 0);
    });
  });

  // Andrew, 2026-07-20 (bug found via 3LT Box investigation -- Retailer X
  // - Location 12, every shelf row 30-45% empty while 20 of 25 real
  // brands were dropped entirely): `targetWidths` above always sums to
  // exactly totalWidthInches by construction (scaled or bonus-filled), so
  // there's never leftover AT THAT STAGE to backfill dropped blocks into.
  // The real gap only appears here, per ROW, once a kept block's own
  // limited SKU roster can't fill the width it was allotted (no bonus
  // facings are spent to close that, per the 07-18 rule above). Backfill
  // now happens from REAL post-build leftover, per row -- highest-scoring
  // dropped block first, placed into whichever row has room for its own
  // (un-scaled) floor width, using that block's own row-chunking so a
  // family still only appears once across the whole section (no-repeat).
  if (droppedBlocks.length) {
    // A dropped block's `.rows` chunking (from chunkEvenlyAcrossRows) pins
    // a small block's few SKUs to specific row INDICES -- fine for a kept
    // block maintaining one consistent vertical column, but wrong for
    // backfill: a 1-SKU block ends up pinned to row 0 only, so if row 0
    // happens to be full it can never use wide-open space on row 5 or 6.
    // Flatten back to the block's real SKU list and place each SKU
    // individually into whichever row CURRENTLY has the most room that
    // still fits it -- greedy fullest-remaining-bin, so backfill spreads
    // naturally across whatever rows are actually short instead of being
    // stuck wherever the pre-drop row math happened to put it.
    const byScoreDesc = [...droppedBlocks].sort((a, b) => b.totalScore - a.totalScore);
    for (const b of byScoreDesc) {
      const allSkus = b.rows.flat();
      allSkus.forEach((sku) => {
        const widthInches = bottleWidthInches(sku, bottleDimensions);
        const w = widthInches * floorFacings;
        let bestRow = -1;
        let bestRoom = -1;
        for (let rowIdx = 0; rowIdx < shelfCount; rowIdx++) {
          const room = totalWidthInches - rowUsedInches[rowIdx];
          if (room >= w && room > bestRoom) { bestRow = rowIdx; bestRoom = room; }
        }
        if (bestRow === -1) return; // doesn't fit in any row's remaining space
        facingsBySkuId.set(sku.skuId, { skuId: sku.skuId, facings: floorFacings, widthInches, allocatedInches: widthInches * floorFacings });
        rowGroups[bestRow].push(sku);
        rowUsedInches[bestRow] += w;
      });
    }
  }

  return { rowGroups, facingsBySkuId };
}

// Andrew, 2026-07-18 (sixth pass -- replaces the "N dedicated rows per
// size" model entirely): small-format sizes (187s, 4-packs, mini multi-
// packs, 375s, 500mls) stay grouped together HORIZONTALLY as much as
// possible -- one size's SKUs are never interleaved bottle-by-bottle with
// another size's within the same contiguous run -- but a size is no longer
// capped at exactly one dedicated row just because there are more size
// codes than shelves. A size's own content can span as many rows as it
// actually needs, and once it runs out (or its next chunk stops fitting),
// the next size in priority order picks up filling the REST of that same
// row, sharing space instead of every size getting an artificially
// exclusive row. See layoutSmallFormatSection below for the bin-packing
// that replaced the old row-quota math (allocateRowsBySize).
//
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

// Andrew, 2026-07-18 (seventh pass): fixed vertical tiering by size instead
// of pure score priority between sizes. 0.187LT singles and 0.375LT only
// look right on the very top shelf of a small-format section ("on any
// other shelf they look strange") -- ranked by sales, top shelf ONLY, never
// spilling further down. 0.5LT claims the row(s) below that next. Every
// other small multi-pack size (4-packs, X2/X3/X6 packs, etc.) fills
// whatever rows are left after 500ml, each exact size still its own
// contiguous group (never interleaved), ranked by that size's own SKU
// score among its tier-3 siblings. Within each tier, sizes/families still
// bin-pack and cycle exactly as before (see packGroupsIntoRows) -- this
// only changes WHICH rows a tier is allowed to use, not how it fills them.
const SMALL_FORMAT_TOP_SHELF_SIZES = new Set(['0.187LT', '0.375LT']);

function layoutSmallFormatSection(naturalPool, shelfDefs, totalWidthInches, scoreMap, bottleDimensions, floorFacings) {
  const shelfCount = shelfDefs.length;
  const rowGroups = Array.from({ length: shelfCount }, () => []);
  const facingsBySkuId = new Map();
  if (!naturalPool.length) return { rowGroups, facingsBySkuId };

  const familyWidth = (fam) => fam.sorted.reduce((s, sk) => s + bottleWidthInches(sk, bottleDimensions) * floorFacings, 0);

  function buildSizeGroups(pool) {
    const bySize = new Map();
    pool.forEach((sku) => {
      const key = sku.bottleSizeRaw || 'UNSPECIFIED';
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push(sku);
    });
    return [...bySize.entries()].map(([size, skus]) => {
      const families = collapseToRootBrand(skus, scoreMap);
      const totalScore = skus.reduce((s, sk) => s + (scoreMap.get(sk.skuId)?.score ?? 0), 0);
      return { size, families, totalScore, familyCursor: 0 };
    }).filter((g) => g.families.length > 0);
  }

  // Bin-packs a fixed, already-ORDERED list of size-groups into a given set
  // of rows -- same cycling/wraparound mechanism as the previous pass, just
  // scoped to whichever rows its tier is allowed to use.
  // Andrew, 2026-07-19: nothing repeats as filler, full stop -- every
  // family/group gets its one appearance in its best available slot and is
  // then excluded entirely, even if that leaves a row short of full width.
  // (Previously only Bota was exempted from repeat-fill; now nothing is
  // reused to pad a row.) The resulting shortfall is surfaced via
  // skuDepthExhausted in buildSectionOutput/buildMergedSectionOutput rather
  // than silently papered over with a duplicate.
  function pickIndex(items, currentIdx) {
    if (items[currentIdx] && !items[currentIdx].hasAppeared) return currentIdx;
    return items.findIndex((it) => !it.hasAppeared); // -1: nothing left that hasn't already appeared
  }

  function packGroupsIntoRows(orderedGroups, rows) {
    if (!orderedGroups.length || !rows.length) return;
    orderedGroups.forEach((g) => {
      g.hasAppeared = false;
      g.families.forEach((f) => { f.hasAppeared = false; });
    });
    let groupCursor = 0;
    const maxStepsPerRow = orderedGroups.reduce((s, g) => s + g.families.length, 0) * 200;
    rows.forEach((row) => {
      const rowSkus = [];
      let used = 0;
      for (let steps = 0; steps < maxStepsPerRow; steps++) {
        if (groupCursor >= orderedGroups.length) groupCursor = 0;
        const gIdx = pickIndex(orderedGroups, groupCursor);
        if (gIdx === -1) break; // nothing left anywhere that's allowed to appear again
        groupCursor = gIdx;
        const group = orderedGroups[groupCursor];

        if (group.familyCursor >= group.families.length) group.familyCursor = 0;
        const fIdx = pickIndex(group.families, group.familyCursor);
        if (fIdx === -1) {
          // this size's own families are all exhausted/non-repeatable --
          // move on to the next size group instead of stalling this row
          group.hasAppeared = true;
          groupCursor++;
          continue;
        }
        group.familyCursor = fIdx;
        const fam = group.families[group.familyCursor];

        const w = familyWidth(fam);
        if (used > 0 && used + w > totalWidthInches) break; // this size's next chunk doesn't fit -- stop the row here
        rowSkus.push(...fam.sorted);
        used += w;
        fam.hasAppeared = true;
        group.familyCursor++;
        if (group.familyCursor >= group.families.length) {
          group.familyCursor = 0;
          group.hasAppeared = true;
          groupCursor++;
        }
      }
      if (rowSkus.length) {
        rowGroups[row.position - 1].push(...rowSkus);
        rowSkus.forEach((sku) => {
          const widthInches = bottleWidthInches(sku, bottleDimensions);
          facingsBySkuId.set(sku.skuId, { skuId: sku.skuId, facings: floorFacings, widthInches, allocatedInches: widthInches * floorFacings });
        });
      }
    });
  }

  const topShelfPool = naturalPool.filter((s) => SMALL_FORMAT_TOP_SHELF_SIZES.has(s.bottleSizeRaw));
  const halfLiterPool = naturalPool.filter((s) => s.bottleSizeRaw === '0.5LT');
  const otherPool = naturalPool.filter((s) =>
    !SMALL_FORMAT_TOP_SHELF_SIZES.has(s.bottleSizeRaw) && s.bottleSizeRaw !== '0.5LT'
  );

  const sortedShelves = [...shelfDefs].sort((a, b) => a.position - b.position);
  // Only reserve the physical top shelf if this section actually has any
  // 187/375 content -- otherwise that row would sit needlessly empty while
  // 500ml/other sizes go begging for space below it.
  const reserveTopShelf = topShelfPool.length > 0 && sortedShelves.length > 0;
  const topShelf = reserveTopShelf ? [sortedShelves[0]] : [];
  const remainingShelves = reserveTopShelf ? sortedShelves.slice(1) : sortedShelves;

  const topGroups = buildSizeGroups(topShelfPool).sort((a, b) => b.totalScore - a.totalScore);
  packGroupsIntoRows(topGroups, topShelf);

  const halfLiterGroups = buildSizeGroups(halfLiterPool);
  const otherGroups = buildSizeGroups(otherPool).sort((a, b) => b.totalScore - a.totalScore);
  packGroupsIntoRows([...halfLiterGroups, ...otherGroups], remainingShelves);

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

  // Andrew, 2026-07-20: small-format product (187s, 375s, 4-packs, 500mls)
  // is physically shorter, so a bay DELIBERATELY BUILT with more/shorter
  // shelves in the same vertical height fits it better -- but a section's
  // bay was always chosen purely by horizontal position (getShelvesForSpan),
  // which only lands small-format content in a shelf-dense bay by accident
  // of Set Layout's cumulative width math. Small-format content pins
  // directly to whichever bay has the most shelves, regardless of Set
  // Layout order -- Set Layout width still controls how much total space
  // it gets, just not which physical bay it renders in.
  //
  // Andrew, 2026-07-20 (correction): this must only activate when a bay is
  // ACTUALLY built denser than the rest -- reduce() always returns SOME
  // index even when every bay has the identical shelf count, which forced
  // pinning unconditionally and broke stores with uniform shelving ("if
  // there WAS a set designed for them, they'd populate there -- cutting
  // them when they're the same shelf height as the others is not the
  // fix"). No real density difference means no special bay: small-format
  // sections fall through to ordinary position-based bay assignment, same
  // as every other section.
  const shelfCounts = store.shelfLayout.bays.map((b) => b.shelfCount);
  const maxShelfCount = shelfCounts.length ? Math.max(...shelfCounts) : 0;
  const minShelfCount = shelfCounts.length ? Math.min(...shelfCounts) : 0;
  const hasDenseBay = maxShelfCount > minShelfCount;
  const denseBayIndex = hasDenseBay ? shelfCounts.indexOf(maxShelfCount) : null;
  const denseBayShelves = denseBayIndex != null ? store.shelfLayout.bays[denseBayIndex].shelves : null;

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
  // OVERALL size -- space-driven fill (fitSkusToWidth/layoutSmallFormatSection)
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
    // columnIndex (Andrew, 2026-07-18): left-to-right slot within the row,
    // set by dragging one box onto another -- shelfPosition alone only
    // controls which ROW a locked SKU lands on, so swapping two SKUs
    // already on the SAME row was a visual no-op (both just got appended
    // to that row's array in whatever order, ignoring the swap). Null
    // means "no preference, append at the end" (the Add SKU form and the
    // manual override panel don't have a natural column to reference).
    placementsBySkuId.set(o.skuId, {
      sku, sectionKey: targetKey, shelfPosition: o.shelfPosition, facings: o.facings,
      columnIndex: o.columnIndex ?? null,
    });
  });

  // Inserts each row's locked SKUs at their requested column position
  // instead of always appending -- processed in ascending columnIndex order
  // so a clean two-way swap (each wants the other's original slot) lands
  // both SKUs in the right relative position. Items with no columnIndex
  // preference (null) go to the end, after everything else.
  function insertLockedIntoRow(rowArray, lockedSkusForRow) {
    const withIndex = lockedSkusForRow
      .map((sku) => ({ sku, columnIndex: placementsBySkuId.get(sku.skuId)?.columnIndex }));
    withIndex.sort((a, b) => {
      if (a.columnIndex == null && b.columnIndex == null) return 0;
      if (a.columnIndex == null) return 1;
      if (b.columnIndex == null) return -1;
      return a.columnIndex - b.columnIndex;
    });
    withIndex.forEach(({ sku, columnIndex }) => {
      const insertAt = columnIndex == null ? rowArray.length : Math.max(0, Math.min(columnIndex, rowArray.length));
      rowArray.splice(insertAt, 0, sku);
    });
  }

  // Andrew, 2026-07-19: since nothing repeats as filler anymore (see
// pickIndex/chunkEvenlyAcrossRows above), a section can legitimately come
// up short of its physical width when there just isn't enough distinct
// product to cover it without repeating. Flag that -- but measure it
// deterministically against real inventory width, not against the
// post-bin-packing leftover in each row: normal fitSkusToWidth/facings
// rounding always leaves a fractional gap (the next SKU's full width
// doesn't divide evenly into what's left), and that's not exhaustion, it's
// ordinary rectangle-packing slack. Compare total distinct-SKU width
// actually available (each SKU counted once, at floor facings, since none
// can repeat) against total width needed to fill every row -- exhausted
// only when the pool itself is too shallow to cover that, with a
// tolerance of one average bottle width so the last unavoidable partial
// slot doesn't false-positive.
// Andrew, 2026-07-20: measures from the shelves that were ACTUALLY built,
// not a theoretical naturalPool-width estimate. The theoretical estimate
// summed every distinct SKU's width once and compared it to shelfCount *
// linearFeet -- correct in spirit, but it doesn't account for brand-FAMILY
// grouping (no-repeat operates on families, not individual SKUs) reducing
// how many "rounds" the pool can actually support, nor for a family too
// wide to fit a given row. Real per-row placed content already reflects
// both; summing it directly is the honest number ("shelf 6 has one SKU"
// stays invisible if you only ever look at the widest row or a raw SKU
// count -- see the 2026-07-20 achievedInches fix in the redistribution
// pass above for the same class of bug).
function computeDepthExhaustion(shelves, shelfCount, linearFeet, poolSize) {
  const neededInches = shelfCount * linearFeet * 12;
  const achievedInches = shelves.reduce((s, sh) => s + rowInches(sh), 0);
  const allPlaced = shelves.flatMap((sh) => sh.skus);
  const avgBottleWidth = allPlaced.length
    ? allPlaced.reduce((s, sk) => s + (sk.widthInches ?? 3), 0) / allPlaced.length
    : 0;
  const shortfallInches = neededInches - achievedInches;
  // Andrew, 2026-07-20: tolerance scales PER ROW (shelfCount * one bottle
  // width), not a single flat bottle-width regardless of row count.
  // Ordinary "no bonus facings" rounding (2026-07-18) leaves up to about
  // one bottle-width unused on EVERY row, not once for the whole section
  // -- a flat tolerance made a well-filled 5-row section (Cabernet, 390
  // real SKUs, only 5% short) flag as "exhausted" right alongside a
  // section that's genuinely out of distinct product, drowning the real
  // signal in normal bin-packing noise.
  const skuDepthExhausted = shortfallInches > Math.max(avgBottleWidth * shelfCount, shelfCount);
  const depthExhaustedNote = skuDepthExhausted
    ? `Only ${poolSize} distinct SKU${poolSize === 1 ? '' : 's'} available -- ${(achievedInches / 12).toFixed(1)}ft actually placed vs ${(neededInches / 12).toFixed(1)}ft needed to fill every row without repeating.`
    : null;
  return { skuDepthExhausted, depthExhaustedNote };
}

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
  // `overrideShelves` (Andrew, 2026-07-20): the reconciliation pass below
  // rebuilds a section with the shelf profile of the bay it ACTUALLY
  // renders into after compaction, instead of the bay its nominal Set
  // Layout position happened to sit over.
  function buildSectionOutput(data, overrideShelves = null) {
    const { allocation, key, type, section, categorySkus, ranked, naturalPool, lockedForSection, lockedSkuIds } = data;
    if (!categorySkus.length) return null;

    const linearFeet = allocation.widthFt;
    const startFt = allocation.startFt;

    const isSmallFormat = isSmallFormatSection(section);
    const storeShelves = overrideShelves ?? ((isSmallFormat && denseBayShelves) ? denseBayShelves : getShelvesForSpan(store.shelfLayout, startFt, linearFeet));
    const shelfCount = storeShelves.length;
    const shelfDefs = buildSectionShelves(storeShelves, shelfCount);
    const pinnedBayIndex = (isSmallFormat && denseBayIndex != null) ? denseBayIndex : null;

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
    const lockedByRow = new Map();
    lockedForSection.forEach((sku) => {
      const position = placementsBySkuId.get(sku.skuId).shelfPosition;
      const clamped = Math.max(1, Math.min(shelfCount, position || 1));
      if (!lockedByRow.has(clamped)) lockedByRow.set(clamped, []);
      lockedByRow.get(clamped).push(sku);
    });
    lockedByRow.forEach((skusForRow, clamped) => insertLockedIntoRow(rowGroups[clamped - 1], skusForRow));

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

    const { skuDepthExhausted, depthExhaustedNote } = computeDepthExhaustion(shelves, shelfCount, linearFeet, naturalPool.length);

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
      skuDepthExhausted,
      depthExhaustedNote,
      pinnedBayIndex,
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
  function buildMergedSectionOutput(memberAllocations, memberDataList, overrideShelves = null) {
    const withSkus = memberDataList.filter((d) => d.categorySkus.length);
    if (!withSkus.length) return null;

    const combinedWidth = memberAllocations.reduce((sum, a) => sum + a.widthFt, 0);
    const startFt = memberAllocations[0].startFt;
    const combinedLockedSkuIds = new Set(withSkus.flatMap((d) => [...d.lockedSkuIds]));

    // The merge-eligibility guard above (currentRunIsSmallFormat) guarantees
    // every member of a merged run is either all small-format or all
    // regular-format -- never mixed -- so checking the first member decides
    // layout mode for the whole group.
    const isSmallFormatRun = isSmallFormatSection(withSkus[0].section);
    const storeShelves = overrideShelves ?? ((isSmallFormatRun && denseBayShelves) ? denseBayShelves : getShelvesForSpan(store.shelfLayout, startFt, combinedWidth));
    const shelfCount = storeShelves.length;
    const shelfDefs = buildSectionShelves(storeShelves, shelfCount);
    const pinnedBayIndex = (isSmallFormatRun && denseBayIndex != null) ? denseBayIndex : null;
    let rowGroups, blockFacingsBySkuId;
    if (isSmallFormatRun) {
      // Each exact size code (187s, 4-packs, 375s, 500mls) keeps its own
      // dedicated row(s) within the merged pool -- never interleaved with
      // another size -- and only brand-blocks within a size's own rows when
      // it actually got more than one. Andrew, 2026-07-17 (revised).
      // Andrew, 2026-07-18: locked/override SKUs must NOT go through this
      // pool -- they were previously mixed in with naturalPool and treated
      // as ordinary ranked candidates, so a manual placement's facings and
      // shelf position were silently ignored (or the SKU dropped entirely
      // if it didn't score high enough to win a bin-packing slot). They're
      // spliced in afterward at their exact stated position instead, same
      // as the standalone (non-merged) section path already does.
      const pooled = withSkus.flatMap((d) => [...d.naturalPool]);
      const result = layoutSmallFormatSection(
        pooled, shelfDefs, combinedWidth * 12, scoreMap, bottleDimensions, STANDARD_FLOOR_FACINGS
      );
      rowGroups = result.rowGroups;
      blockFacingsBySkuId = result.facingsBySkuId;
    } else {
      const categoryGroups = withSkus.map((d) => ({
        label: d.section.label,
        sorted: [...d.naturalPool],
      }));
      const result = layoutGroupsAsBlocks(
        categoryGroups, shelfCount, combinedWidth * 12, scoreMap, bottleDimensions, STANDARD_FLOOR_FACINGS
      );
      rowGroups = result.rowGroups;
      blockFacingsBySkuId = result.facingsBySkuId;
    }

    // Splice locked/override SKUs into their exact stated shelf position
    // (clamped to this merged section's own shelf count), same pattern as
    // buildSectionOutput's standalone path -- and, at their requested
    // columnIndex within that row (see insertLockedIntoRow), so swapping
    // two SKUs already on the same row actually reorders them instead of
    // both just landing at the row's end regardless.
    rowGroups = rowGroups.map((group) => [...group]);
    const lockedByRow = new Map();
    withSkus.forEach((d) => {
      d.lockedForSection.forEach((sku) => {
        const position = placementsBySkuId.get(sku.skuId)?.shelfPosition;
        const clamped = Math.max(1, Math.min(shelfCount, position || 1));
        if (!lockedByRow.has(clamped)) lockedByRow.set(clamped, []);
        lockedByRow.get(clamped).push(sku);
        const widthInches = bottleWidthInches(sku, bottleDimensions);
        const override = placementsBySkuId.get(sku.skuId);
        blockFacingsBySkuId.set(sku.skuId, {
          skuId: sku.skuId, facings: override.facings, widthInches, allocatedInches: widthInches * override.facings,
        });
      });
    });
    lockedByRow.forEach((skusForRow, clamped) => insertLockedIntoRow(rowGroups[clamped - 1], skusForRow));

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

    const combinedPool = withSkus.flatMap((d) => d.naturalPool);
    const { skuDepthExhausted, depthExhaustedNote } = computeDepthExhaustion(shelves, shelfCount, combinedWidth, combinedPool.length);

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
      skuDepthExhausted,
      depthExhaustedNote,
      pinnedBayIndex,
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
    // 500ml, see layoutSmallFormatSection) instead of each size independently
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

  // Andrew, 2026-07-20: leftover space from a section that can't fill its
  // allocation used to just shrink the whole set at render time -- recovered
  // space piled up as dead space at the tail of the fixture instead of ever
  // being used. Redistribute it BEFORE the final build instead: shrink each
  // under-capacity group's allocation down to what it can actually use,
  // pool the freed width, then hand that pool to over-capacity groups (real
  // inventory deeper than their current allocation) in descending order of
  // total opportunity score -- best-selling first -- each capped at how
  // much more it can genuinely use. The fixture stays full edge-to-edge;
  // savings from thin categories go to top performers instead of
  // evaporating.
  //
  // Andrew, 2026-07-20 (widened scope): a section can under-fill its width
  // for two different reasons -- genuinely too few distinct SKUs (what
  // skuDepthExhausted flags), or simply not having enough eligible
  // candidates for a specific price-band-restricted shelf position even
  // with plenty of inventory overall, or ordinary floor-facings bin-packing
  // slack (a bottle's width rarely divides evenly into a row -- no bonus
  // facings are spent to close that fraction, per the 2026-07-18 "breadth
  // not depth" rule). Both are real, intentional rules, not bugs, but their
  // cumulative slack across dozens of rows still adds up to a visible gap
  // even when total allocated width exactly matches the fixture. Andrew
  // asked for the set to fill edge-to-edge regardless of cause, so shortfall
  // is now measured from an actual trial BUILD at each group's original
  // width (real achieved fill), not just its theoretical inventory count.
  function rowInches(shelf) {
    return shelf.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0);
  }

  function groupFloorFacings(dataList) {
    if (dataList.length > 1) return STANDARD_FLOOR_FACINGS; // merged groups never use price-band/case-only rules
    const usesPriceBandRules = appliesPriceBandRules(dataList[0].section);
    return (usesPriceBandRules && caseOnlyMode) ? CASE_ONLY_FLOOR_FACINGS : STANDARD_FLOOR_FACINGS;
  }

  // A section's real inventory (naturalPool) is shared ACROSS every shelf
  // row it spans -- no-repeat means the same distinct-SKU width can only be
  // "spent" once total, not once per row. So the true capacity comparison
  // is against shelfCount * widthFt (every row's worth), same `neededInches`
  // math as skuDepthExhausted -- comparing against widthFt alone (one row)
  // would badly understate how much a multi-shelf section actually needs.
  function groupShelfCount(dataList, groupAllocations) {
    const isSmallFormat = isSmallFormatSection(dataList[0].section);
    const combinedWidth = groupAllocations.reduce((s, a) => s + a.widthFt, 0);
    const startFt = groupAllocations[0].startFt;
    const storeShelves = (isSmallFormat && denseBayShelves) ? denseBayShelves : getShelvesForSpan(store.shelfLayout, startFt, combinedWidth);
    return storeShelves.length;
  }

  function buildGroupOutput(groupAllocations, dataList) {
    return groupAllocations.length === 1
      ? buildSectionOutput(groupAllocations[0] === dataList[0].allocation ? dataList[0] : { ...dataList[0], allocation: groupAllocations[0] })
      : buildMergedSectionOutput(groupAllocations, dataList);
  }

  // Andrew, 2026-07-20 (bug found via "24.6ft of 24ft" investigation):
  // layoutSmallFormatSection's row-packer always force-places the FIRST
  // brand family into a row even if that family alone is wider than the
  // row's budget (same "never leave a row artificially empty" philosophy
  // used elsewhere) -- fine when the row is a reasonable size, but
  // shrinking a small-format group down to its measured achievedInches can
  // land it BELOW what its own widest single family needs, forcing that
  // exact overflow into existence. The trial build that measured
  // achievedInches ran at the ORIGINAL (wider) allocation, where the
  // family fit -- shrinking changes the row-packing outcome itself, so the
  // measurement doesn't predict the overflow it causes. Shrink target is
  // now floored at the widest real family's width so redistribution can
  // never shrink a small-format group past what one family alone requires.
  function widestSmallFormatFamilyInches(pool, floorFacings) {
    const bySize = new Map();
    pool.forEach((sku) => {
      const key = sku.bottleSizeRaw || 'UNSPECIFIED';
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push(sku);
    });
    let widest = 0;
    bySize.forEach((skusForSize) => {
      collapseToRootBrand(skusForSize, scoreMap).forEach((fam) => {
        const w = fam.sorted.reduce((s, sku) => s + bottleWidthInches(sku, bottleDimensions) * floorFacings, 0);
        widest = Math.max(widest, w);
      });
    });
    return widest;
  }

  // Andrew, 2026-07-20: the same force-first-unit overflow applies to
  // regular (non-small-format) block sections -- layoutGroupsAsBlocks'
  // chunkEvenlyAcrossRows/fitSkusToWidth also always includes at least one
  // BRAND block even if that whole block is wider than the row, so a
  // heavily-shrunk tiny size section (3LT/5LT/1LT box, etc.) can end up
  // narrower than even its own single widest brand -- same bug, smaller
  // scale, surfaced once the small-format fix above stopped masking it.
  // Uses brandGroups (the actual grouping layoutGroupsAsBlocks uses),
  // where small-format uses collapseToRootBrand's per-size grouping.
  function widestBlockFamilyInches(pool, floorFacings) {
    let widest = 0;
    brandGroups(pool, scoreMap).forEach((fam) => {
      const w = fam.sorted.reduce((s, sku) => s + bottleWidthInches(sku, bottleDimensions) * floorFacings, 0);
      widest = Math.max(widest, w);
    });
    return widest;
  }

  const groupInfo = groups.map((group) => {
    const dataList = group.map((g) => g.data);
    const groupAllocations = group.map((g) => g.allocation);
    const combinedPool = dataList.flatMap((d) => d.naturalPool);
    const floorFacings = groupFloorFacings(dataList);
    const shelfCount = groupShelfCount(dataList, groupAllocations);
    const isSmallFormat = isSmallFormatSection(dataList[0].section);
    const maxInventoryInches = combinedPool.reduce((s, sku) => s + bottleWidthInches(sku, bottleDimensions) * floorFacings, 0);
    const neededInches = shelfCount * groupAllocations.reduce((s, a) => s + a.widthFt, 0) * 12;
    const currentWidthFt = groupAllocations.reduce((s, a) => s + a.widthFt, 0);
    // Price-band varietal sections (750ml) place SKUs individually via
    // fitSkusToWidth per shelf position, never force a whole multi-SKU
    // brand block together -- no family-width floor applies there, only
    // to 'size' blocks and merged runs that actually use brandGroups.
    const usesPriceBandRulesHere = dataList.length === 1 && appliesPriceBandRules(dataList[0].section);
    const widestFamilyInches = isSmallFormat
      ? widestSmallFormatFamilyInches(combinedPool, floorFacings)
      : (usesPriceBandRulesHere ? 0 : widestBlockFamilyInches(combinedPool, floorFacings));
    const totalScore = combinedPool.reduce((s, sku) => s + (scoreMap.get(sku.skuId)?.score ?? 0), 0);
    // Trial build at the ORIGINAL (pre-redistribution) width to measure what
    // this group actually achieves, across every row -- the real yardstick
    // for shortfall, not just theoretical inventory count.
    //
    // Andrew, 2026-07-20: summed across every row (the TRUE total placed),
    // not shelfCount * the single widest row. No-repeat means each brand
    // family only appears once across the WHOLE section, so once the
    // deepest rows consume the best families, later rows in the cycling
    // order can run dry even while the widest row looks completely full --
    // multiplying that one best row by shelfCount silently assumed every
    // row could match it, masking exactly the "shelf 6 has one SKU" case
    // this measurement exists to catch.
    const trialOut = buildGroupOutput(groupAllocations, dataList);
    const achievedInches = trialOut ? trialOut.shelves.reduce((s, sh) => s + rowInches(sh), 0) : 0;
    return { group, shelfCount, maxInventoryInches, neededInches, achievedInches, currentWidthFt, widestFamilyInches, totalScore };
  });

  // Shrink/grow amounts are expressed per-ROW (divided by shelfCount) since
  // widthFt is a per-row budget applied uniformly across every shelf --
  // shrinking/growing the group's widthFt by X automatically changes its
  // total capacity by X * shelfCount. Shrink target uses REAL achieved
  // fill (catches price-band/bin-packing slack too). Grow capacity still
  // uses theoretical max inventory as the upper bound, since that's the
  // only thing knowable without an extra trial build at a hypothetical
  // wider width.
  //
  // Andrew, 2026-07-20: a small-format group whose ORIGINAL allocation is
  // narrower than its own widest single family is a MANDATORY claim on the
  // shortfall pool, funded FIRST, ahead of the normal score-ranked growth
  // below -- not optional/best-effort like ordinary growth, since under-
  // funding it means an actual overflow bug (the family gets force-placed
  // past the row's real budget), not just a missed opportunity. A group
  // with a mandatory need is excluded from ordinary shrink/grow -- it gets
  // exactly its family-floor width, funded from the pool, full stop.
  const mandatoryExtraInchesByGroup = new Map();
  groupInfo.forEach((g) => {
    const deficit = g.shelfCount * g.widestFamilyInches - g.neededInches;
    if (deficit > 0) mandatoryExtraInchesByGroup.set(g.group, deficit);
  });
  const totalMandatoryInches = [...mandatoryExtraInchesByGroup.values()].reduce((a, b) => a + b, 0);

  const shrinkToWidthFtByGroup = new Map();
  groupInfo.forEach((g) => {
    if (mandatoryExtraInchesByGroup.has(g.group)) return; // mandatory groups don't shrink, they draw from the pool instead
    if (g.neededInches > g.achievedInches) {
      shrinkToWidthFtByGroup.set(g.group, g.achievedInches / g.shelfCount / 12);
    }
  });

  // `remaining`/`capacity` stay in TOTAL inches (summed across every row of
  // the contributing/absorbing sections) throughout -- only converted to a
  // per-row widthFt (divide by shelfCount) at the moment it's recorded.
  const totalShortfallInches = groupInfo.reduce((s, g) => {
    if (mandatoryExtraInchesByGroup.has(g.group)) return s;
    return s + Math.max(0, g.neededInches - g.achievedInches);
  }, 0);
  const extraWidthFtByGroup = new Map();
  let remaining = totalShortfallInches;

  // Pay mandatory family-floor claims first, even if that leaves less (or
  // nothing) for ordinary score-ranked growth below. If the pool can't
  // cover every mandatory claim, each is funded proportionally rather than
  // first-come-first-served, so a store that's genuinely too tight for a
  // wide family spreads that shortfall instead of picking an arbitrary
  // winner.
  if (totalMandatoryInches > 0) {
    const fundRatio = remaining >= totalMandatoryInches ? 1 : remaining / totalMandatoryInches;
    mandatoryExtraInchesByGroup.forEach((deficit, group) => {
      extraWidthFtByGroup.set(group, deficit * fundRatio / (groupInfo.find((g) => g.group === group)?.shelfCount ?? 1) / 12);
    });
    remaining = Math.max(0, remaining - totalMandatoryInches);
  }

  if (remaining > 0) {
    const growable = groupInfo.filter((g) => !mandatoryExtraInchesByGroup.has(g.group) && g.maxInventoryInches > g.neededInches).sort((a, b) => b.totalScore - a.totalScore);
    for (const g of growable) {
      if (remaining <= 0) break;
      const capacity = g.maxInventoryInches - g.neededInches; // total inches this group can still absorb
      const take = Math.min(capacity, remaining);
      if (take > 0) { extraWidthFtByGroup.set(g.group, take / g.shelfCount / 12); remaining -= take; }
    }
  }

  // Applies a group's redistribution result to its member allocations,
  // scaling every member's widthFt so the group's TOTAL hits the target --
  // preserves each member's relative share within a merged group. A
  // mandatory group's family-floor grant already lives in
  // extraWidthFtByGroup (funded above, ahead of ordinary growth) and it
  // never has a shrinkTo, so this stays a plain shrink-or-grow apply.
  function applyRedistribution(group, groupAllocations) {
    const shrinkTo = shrinkToWidthFtByGroup.get(group);
    const extra = extraWidthFtByGroup.get(group) ?? 0;
    if (shrinkTo == null && extra === 0) return groupAllocations;
    const currentTotal = groupAllocations.reduce((s, a) => s + a.widthFt, 0);
    const targetTotal = (shrinkTo ?? currentTotal) + extra;
    if (targetTotal === currentTotal) return groupAllocations;
    const scale = currentTotal > 0 ? targetTotal / currentTotal : 0;
    return groupAllocations.map((a) => ({ ...a, widthFt: a.widthFt * scale }));
  }

  const sections = [];
  const rebuildContextBySectionKey = new Map(); // sectionKey -> how to rebuild it with a different shelf profile
  groups.forEach((group) => {
    const rawAllocations = group.map((g) => g.allocation);
    const dataList = group.map((g) => g.data);
    const groupAllocations = applyRedistribution(group, rawAllocations);

    if (groupAllocations.length === 1) {
      // Standalone section -- always fills every shelf row (block width
      // applies uniformly per shelf; buildSectionOutput's own sparse
      // fallback already handles genuinely low-SKU-count cases).
      const widenedData = groupAllocations[0] === rawAllocations[0] ? dataList[0] : { ...dataList[0], allocation: groupAllocations[0] };
      const sectionOut = buildSectionOutput(widenedData);
      if (sectionOut) {
        sections.push(sectionOut);
        rebuildContextBySectionKey.set(sectionOut.key, { kind: 'standalone', widenedData });
      }
      return;
    }

    const sectionOut = buildMergedSectionOutput(groupAllocations, dataList);
    if (sectionOut) {
      sections.push(sectionOut);
      rebuildContextBySectionKey.set(sectionOut.key, { kind: 'merged', groupAllocations, dataList });
    }
  });

  // Andrew, 2026-07-20: reconcile each section's shelf profile with the
  // bay it ACTUALLY renders into. Every section's rows were computed from
  // its NOMINAL Set Layout position (getShelvesForSpan), but the viewer
  // compacts sections left-to-right by real content width (and pins
  // small-format to the dense bay), so a section routinely lands in a bay
  // with a different shelf count than the one it was built for -- a
  // 4-row section arriving in a 7-shelf bay leaves shelves 5-7 empty
  // ("Bay 8 shelves 2/3/4 sparse"), and a 5-row section arriving in a
  // 4-shelf bay overfills. Replicate the viewer's compaction walk here
  // (same math as buildBayRowMap: pinned sections at the dense-bay
  // anchor, everyone else sequential by real content width, skipping the
  // reserved bay range), find each section's destination bay, and rebuild
  // any section whose destination bay's shelf profile differs from what
  // it was built with. One pass, not iterated to convergence -- rebuilding
  // changes content width slightly, but bay assignment by content START
  // is stable enough that a second pass almost never changes anything.
  {
    const BAY_W_IN = 48;
    const bays = store.shelfLayout.bays;
    const sectionRealInches = (s) => Math.max(...s.shelves.map((sh) => sh.skus.reduce((sum, x) => sum + (x.allocatedInches ?? x.facings * (x.widthInches ?? 3)), 0)), 0);

    const pinnedSecs = sections.filter((s) => s.pinnedBayIndex != null);
    const normalSecs = sections.filter((s) => s.pinnedBayIndex == null);
    const destBayBySectionKey = new Map();
    const reservedBays = new Set();
    if (pinnedSecs.length) {
      let cursor = pinnedSecs[0].pinnedBayIndex * BAY_W_IN;
      const anchor = cursor;
      pinnedSecs.forEach((s) => {
        destBayBySectionKey.set(s.key, Math.min(Math.floor(cursor / BAY_W_IN), bays.length - 1));
        cursor += sectionRealInches(s);
      });
      const bayspan = Math.max(1, Math.ceil((cursor - anchor) / BAY_W_IN));
      const startBay = pinnedSecs[0].pinnedBayIndex;
      for (let i = startBay; i < Math.min(startBay + bayspan, bays.length); i++) reservedBays.add(i);
    }
    const availableBays = [];
    for (let i = 0; i < bays.length; i++) if (!reservedBays.has(i)) availableBays.push(i);
    let compacted = 0;
    normalSecs.forEach((s) => {
      const bayOffset = Math.floor(compacted / BAY_W_IN);
      const destBay = availableBays.length
        ? availableBays[Math.min(bayOffset, availableBays.length - 1)]
        : Math.min(bayOffset, bays.length - 1);
      destBayBySectionKey.set(s.key, destBay);
      compacted += sectionRealInches(s);
    });

    sections.forEach((s, i) => {
      const destBay = destBayBySectionKey.get(s.key);
      if (destBay == null) return;
      const destShelves = bays[destBay].shelves;
      if (destShelves.length === s.shelfCount) return;
      const ctx = rebuildContextBySectionKey.get(s.key);
      if (!ctx) return;
      const rebuilt = ctx.kind === 'standalone'
        ? buildSectionOutput(ctx.widenedData, destShelves)
        : buildMergedSectionOutput(ctx.groupAllocations, ctx.dataList, destShelves);
      if (rebuilt) sections[i] = rebuilt;
    });
  }

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
