import { store } from '../core/store.js';
import { generatePlan } from '../optimize/placementSolver.js';
import { getPhysicalWidthFt, BAY_WIDTH_FT, buildSectionShelves } from '../optimize/shelfPosition.js';
import { sectionForSku } from '../optimize/blocking.js';
import { bottleWidthInches } from '../optimize/facings.js';
import { computeScoreMap } from '../calc/scoreEngine.js';

const PX_PER_INCH = 16; // bumped up 2026-07-15 so the planogram reads as the actual set, not a compressed summary
const BAY_INCHES = BAY_WIDTH_FT * 12; // 48in -- a real physical bay, the fixed visual module width
const MIN_BOX_PX = 16; // just enough to avoid a zero-width render glitch, not a proportionality-distorting floor

function rowInches(shelf) {
  return shelf.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0);
}

// Maps every section's shelf content onto the store's REAL physical bays --
// section boundaries are independent of bay boundaries (Set Layout design),
// so a section's content can be cut mid-bay, and a single bay can contain
// pieces of more than one category. Andrew, 2026-07-19: sections render
// COMPACTED, not at their nominal Set Layout startFt -- the "breadth not
// depth" 1-facing-max rule (2026-07-18) and the no-repeat/depth-exhaustion
// rule (2026-07-19) both mean a section's REAL placed content routinely
// comes in under its allocated width, and previously the next section still
// started at the old fixed boundary regardless, leaving a dead gap. Each
// section now starts right where the PREVIOUS section's actual content
// (its widest row) ended, so sections pack left-to-right with no gaps
// between them; whatever's left over lands as genuine unused space at the
// tail of the fixture instead of scattered gaps throughout. Set Layout's
// widthFt allocations are untouched by this -- they're still exactly what
// feeds the Optimization Engine as each section's target/cap; only the
// VISUAL bay-bucket position changes here.
// Places one section's boxes into `map`. `mapper(localOffsetInches)` turns
// this section's own running content offset (0 at its first box) into a
// real absolute inch position on the fixture -- lets pinned sections map
// straight through (offset -> pinnedBayStart + offset) while normal
// sections map through the reserved-bay skip logic below, PER BOX rather
// than just at the section's start, so content wide enough to itself reach
// a reserved bay still jumps over it correctly instead of overlapping it.
// Returns how many local-offset inches of real content the section
// actually used (its widest row).
function placeSectionBoxes(map, section, mapper, bays) {
  const bayCount = bays ? bays.length : null;
  let sectionContentInches = 0;
  section.shelves.forEach((shelf) => {
    let cumulative = 0;
    for (let columnIndex = 0; columnIndex < shelf.skus.length; columnIndex++) {
      const sku = shelf.skus[columnIndex];
      const w = sku.allocatedInches ?? sku.facings * (sku.widthInches ?? 3);
      const absoluteStart = mapper(cumulative);
      // Andrew, 2026-07-25: tried making genuinely-past-the-fixture content
      // stop rendering entirely instead of cramming into the last bay, to
      // fix a merged small-format section that piled up so illegibly it
      // was effectively invisible. That overcorrected: reverted 2026-07-26
      // after it made an ordinary Editing Mode edit (dropping one more SKU
      // into a section already sitting right at the fixture boundary --
      // e.g. Fortified, confirmed via the debug table's "OUT OF BOUNDS"
      // flag) silently vanish instead of rendering a little messily like
      // it used to. For everyday edits, "visible but crowded" beats
      // "invisible" every time -- the debug table's out-of-bounds flag
      // already gives visibility into genuine over-allocation without
      // needing the render itself to hide anything. Back to clamping.
      // Clamp rather than drop: a section can land a hair past the store's
      // real bay count on a rounding-level overshoot (content width sums
      // fractionally past the nominal allocation) -- render it in the last
      // real bay instead of silently vanishing with no warning. Genuine
      // over-allocation is still surfaced separately via `plan.isOverflowing`.
      const rawBayIndex = Math.floor(absoluteStart / BAY_INCHES);
      const bayIndex = bayCount != null ? Math.min(rawBayIndex, bayCount - 1) : rawBayIndex;
      if (!map.has(bayIndex)) map.set(bayIndex, new Map());
      const rowMap = map.get(bayIndex);
      // Andrew, 2026-07-20: a section's shelf rows are computed from its
      // NOMINAL Set Layout position (getShelvesForSpan), but compaction /
      // dense-bay pinning can relocate its content into a bay with a
      // DIFFERENT shelf count. renderBay only draws positions 1..the
      // bay's own shelfCount, so a 5-row section landing in a 4-shelf bay
      // silently lost its 5th row (confirmed live: Merlot's shelf-5 SKUs
      // invisible in Bay 6). Fold overflow rows into the bay's last real
      // shelf instead of dropping them.
      const bayShelfCount = bays ? bays[bayIndex].shelfCount : null;
      const rowPosition = bayShelfCount != null ? Math.min(shelf.position, bayShelfCount) : shelf.position;
      if (!rowMap.has(rowPosition)) rowMap.set(rowPosition, []);
      // columnIndex: this SKU's left-to-right slot within its row (Andrew,
      // 2026-07-18) -- lets a drag-drop swap target the exact position
      // another SKU occupied, not just "somewhere in this row."
      rowMap.get(rowPosition).push({ sku, sectionKey: section.key, sectionLabel: section.label, shelfDef: shelf, columnIndex });
      cumulative += w;
    }
    sectionContentInches = Math.max(sectionContentInches, cumulative);
  });
  return sectionContentInches;
}

// Returns { map, spans } -- `spans` is Map<sectionKey, {startFt, endFt}> in
// the same coordinate space as `map`, kept for materialization purposes
// (used once to seed a fresh bayLayout); the live debug table reads
// computeLiveSectionSpans off the persistent bayLayout instead, since spans
// captured here go stale the moment a manual bay edit happens.
//
// Andrew, 2026-07-20: small-format sections (187s, 375s, 4-packs, 500mls --
// see `pinnedBayIndex` in placementSolver.js) are pinned to the store's
// shelf-densest bay instead of flowing with normal left-to-right
// compaction, since shorter bottles physically belong on a bay built with
// more/shorter shelves. Every OTHER section still compacts left-to-right
// by real content width (2026-07-19), but now skips over whatever bay
// range the pinned content actually consumes instead of overlapping it.
function buildBayRowMap(sections, bays) {
  const bayCount = bays ? bays.length : null;
  const map = new Map();
  const spans = new Map();

  const pinned = sections.filter((s) => s.pinnedBayIndex != null);
  const normal = sections.filter((s) => s.pinnedBayIndex == null);

  // Andrew, 2026-07-20 (second bug in the same feature): every pinned
  // section shares the SAME dense-bay index (placementSolver.js computes
  // one densest bay for the whole store), so if Set Layout ever produces
  // more than one separate small-format section -- e.g. small-format
  // categories aren't all adjacent in the order list, so they don't merge
  // into a single combined block -- each one independently started at
  // `pinnedBayIndex * BAY_INCHES` and they all landed on top of each
  // other, 100% of the time. Pinned sections now sequence one after
  // another from that shared starting point instead, same compaction
  // principle as the normal sections below, just anchored to the dense
  // bay instead of bay 0.
  const reservedBayIndices = new Set();
  if (pinned.length) {
    const pinnedAnchorInches = pinned[0].pinnedBayIndex * BAY_INCHES;
    let pinnedCursorInches = pinnedAnchorInches;
    pinned.forEach((section) => {
      const startInches = pinnedCursorInches;
      const contentInches = placeSectionBoxes(map, section, (localOffset) => startInches + localOffset, bays);
      spans.set(section.key, { startFt: startInches / 12, endFt: (startInches + contentInches) / 12 });
      pinnedCursorInches += contentInches;
    });
    const pinnedTotalInches = pinnedCursorInches - pinnedAnchorInches;
    const bayspan = Math.max(1, Math.ceil(pinnedTotalInches / BAY_INCHES));
    const startBay = pinned[0].pinnedBayIndex;
    const upperBound = bayCount != null ? bayCount : startBay + bayspan;
    for (let i = startBay; i < Math.min(startBay + bayspan, upperBound); i++) reservedBayIndices.add(i);
  }

  const availableBayIndices = [];
  if (bayCount != null) {
    for (let i = 0; i < bayCount; i++) if (!reservedBayIndices.has(i)) availableBayIndices.push(i);
  }

  // Maps a "compacted" cumulative-inches offset (as if all available bays
  // were laid end to end with no gaps) to its real absolute-inch position,
  // skipping any reserved bay. Falls back to plain sequential bays if the
  // store's bay count is unknown or nothing is reserved.
  //
  // Andrew, 2026-07-20 (bug fix): once total normal-section content exceeds
  // the available (non-reserved) capacity, clamping bayOffset to the last
  // available bay collapsed ALL further content onto that single bay --
  // `withinBay` (compactedInches % BAY_INCHES) kept cycling 0..48in over
  // and over, so many unrelated sections all landed in the exact same
  // bay-card, one after another, while the bays "freed up" by that
  // collapse rendered starved. Overflow now continues LINEARLY past the
  // last available bay's end instead of wrapping back into it -- still
  // genuinely past the fixture at that point (same as any other
  // over-allocation, see `placeSectionBoxes`'s own final clamp / the
  // separate plan.isOverflowing check), but coherent and sequential rather
  // than piled on top of itself.
  function toRealInches(compactedInches) {
    if (!availableBayIndices.length) return compactedInches;
    const bayOffset = Math.floor(compactedInches / BAY_INCHES);
    const withinBay = compactedInches % BAY_INCHES;
    if (bayOffset < availableBayIndices.length) {
      return availableBayIndices[bayOffset] * BAY_INCHES + withinBay;
    }
    const lastAvailable = availableBayIndices[availableBayIndices.length - 1];
    const overflowInches = compactedInches - availableBayIndices.length * BAY_INCHES;
    return (lastAvailable + 1) * BAY_INCHES + overflowInches;
  }

  // Andrew, 2026-07-22: the very LAST section in the store can land straddling
  // a bay boundary by pure accident of real-content compaction -- e.g. 3LT
  // Box needing ~3.96ft (basically one whole bay) but starting 0.81ft before
  // a bay boundary, leaving a near-unreadable 0.81ft sliver in one bay
  // (brand names truncated) and a half-empty ~3.15ft remainder in the next.
  // Since nothing renders after the last section, snapping its start
  // forward to the next bay boundary trades that broken-looking sliver for
  // one honest, empty gap at the tail of the PREVIOUS bay -- better than a
  // truncated fragment, and unlike every other section, doing this here
  // can't reopen a gap between two pieces of content (07-19's "no gaps"
  // fix), since there's no next section to leave a gap before.
  // Andrew, 2026-07-23: bumped from 0.25 to 1/3 -- a real live case (3LT
  // Box, Retailer X - Location 12) left 12.84in of room (26.75% of a bay),
  // just above the old 25% cutoff, so it went unsnapped: a cramped sliver
  // in one bay plus most of that row's real content stranded there, leaving
  // the next (last) bay looking starved of inventory that was actually
  // available, just misplaced by the boundary miss.
  const MIN_READABLE_SLIVER_INCHES = BAY_INCHES * (1 / 3);

  let runningCompactedInches = 0;
  normal.forEach((section, i) => {
    let compactedStart = runningCompactedInches;
    if (i === normal.length - 1) {
      const naiveRealStart = toRealInches(compactedStart);
      const roomLeftInStartBay = BAY_INCHES - (naiveRealStart % BAY_INCHES);
      if (roomLeftInStartBay > 0 && roomLeftInStartBay < MIN_READABLE_SLIVER_INCHES) {
        compactedStart += roomLeftInStartBay;
      }
    }
    const contentInches = placeSectionBoxes(map, section, (localOffset) => toRealInches(compactedStart + localOffset), bays);
    const realStartInches = toRealInches(compactedStart);
    const realEndInches = toRealInches(compactedStart + contentInches);
    spans.set(section.key, { startFt: realStartInches / 12, endFt: realEndInches / 12 });
    runningCompactedInches = compactedStart + contentInches;
  });

  return { map, spans };
}

// Andrew, 2026-07-26 (bay-locked rebuild, Step 1): captures the bay layout
// that buildBayRowMap derives into an EXPLICIT structure. This is the
// Planogram Viewer's persistent render+edit truth once ensureLiveBayLayout
// (below) hands it off to `liveBayLayout` -- called only when a store has no
// saved bayLayout yet, or on an explicit Regenerate. Each (bay, shelf) holds
// its ordered `slots` = exactly the entries the renderer consumes per row.
// Full design: "ShelfIntelligence Bay-Locked Rebuild Spec.md" in the vault.
function materializeBayLayout(plan, bays) {
  const { map } = buildBayRowMap(plan.sections, bays);
  return {
    storeId: plan.storeId,
    bays: bays.map((bay, bayIndex) => {
      const rowsForBay = map.get(bayIndex) || new Map();
      return {
        bayIndex,
        bayId: bay.bayId,
        shelfCount: bay.shelfCount,
        shelves: Array.from({ length: bay.shelfCount }, (_, i) => {
          const position = i + 1;
          const entries = rowsForBay.get(position) || [];
          return { position, slots: entries.slice() };
        }),
      };
    }),
  };
}

// Andrew, 2026-07-26 (bay-locked rebuild, Step 3 core): pure mutation
// helpers on a materialized bayLayout, addressed by physical
// (bayIndex, shelfPosition, slotIndex). Every address is a concrete bay
// slot, so a move/swap physically cannot re-flow into another bay -- the
// whole point of the rebuild. Unit-tested in isolation before any handler
// wiring. A "slot" is an entry {sku, sectionKey, sectionLabel, shelfDef,
// columnIndex}; an empty slot is an entry whose sku.isEmptySlot is true.
function bayShelf(bayLayout, bayIndex, shelfPosition) {
  const bay = bayLayout.bays.find((b) => b.bayIndex === bayIndex);
  return bay ? (bay.shelves.find((s) => s.position === shelfPosition) || null) : null;
}

function markSlotLocked(entry) {
  if (entry && entry.sku && !entry.sku.isEmptySlot) entry.sku.isLocked = true;
}

function makeEmptyEntry(fromEntry) {
  const sku = fromEntry && fromEntry.sku;
  const widthInches = (sku && sku.widthInches)
    ?? ((sku && sku.allocatedInches && sku.facings) ? sku.allocatedInches / sku.facings : 3);
  return {
    sku: {
      skuId: null, isEmptySlot: true, brand: '', varietal: '', priceUsd: null,
      facings: 1, widthInches, allocatedInches: widthInches, score: 0,
      isLocked: false, reasons: [],
    },
    sectionKey: (fromEntry && fromEntry.sectionKey) || '',
    sectionLabel: (fromEntry && fromEntry.sectionLabel) || '',
    shelfDef: (fromEntry && fromEntry.shelfDef) || null,
    columnIndex: 0,
  };
}

// Exchange two real slot entries. Same shelf or across bays -- pure element
// swap, no length change.
function bayLayoutSwap(bayLayout, a, b) {
  const shelfA = bayShelf(bayLayout, a.bayIndex, a.shelfPosition);
  const shelfB = bayShelf(bayLayout, b.bayIndex, b.shelfPosition);
  if (!shelfA || !shelfB) return false;
  if (a.slotIndex < 0 || a.slotIndex >= shelfA.slots.length) return false;
  if (b.slotIndex < 0 || b.slotIndex >= shelfB.slots.length) return false;
  const tmp = shelfA.slots[a.slotIndex];
  shelfA.slots[a.slotIndex] = shelfB.slots[b.slotIndex];
  shelfB.slots[b.slotIndex] = tmp;
  markSlotLocked(shelfA.slots[a.slotIndex]);
  markSlotLocked(shelfB.slots[b.slotIndex]);
  return true;
}

// Move a real entry from -> to. Source becomes an empty placeholder (hole);
// target fills an empty placeholder there, else inserts within that shelf
// (still same bay). Marks the moved entry locked (manual placement).
function bayLayoutMove(bayLayout, from, to) {
  const shelfFrom = bayShelf(bayLayout, from.bayIndex, from.shelfPosition);
  const shelfTo = bayShelf(bayLayout, to.bayIndex, to.shelfPosition);
  if (!shelfFrom || !shelfTo) return false;
  if (from.slotIndex < 0 || from.slotIndex >= shelfFrom.slots.length) return false;
  const entry = shelfFrom.slots[from.slotIndex];
  if (!entry || (entry.sku && entry.sku.isEmptySlot)) return false;
  shelfFrom.slots[from.slotIndex] = makeEmptyEntry(entry);
  markSlotLocked(entry);
  const ti = Math.max(0, Math.min(to.slotIndex == null ? shelfTo.slots.length : to.slotIndex, shelfTo.slots.length));
  if (shelfTo.slots[ti] && shelfTo.slots[ti].sku && shelfTo.slots[ti].sku.isEmptySlot) shelfTo.slots[ti] = entry;
  else shelfTo.slots.splice(ti, 0, entry);
  return true;
}

// Replace a real entry with an empty placeholder (keeps the hole/width).
function bayLayoutRemove(bayLayout, addr) {
  const shelf = bayShelf(bayLayout, addr.bayIndex, addr.shelfPosition);
  if (!shelf || addr.slotIndex < 0 || addr.slotIndex >= shelf.slots.length) return false;
  const entry = shelf.slots[addr.slotIndex];
  if (!entry || (entry.sku && entry.sku.isEmptySlot)) return false;
  shelf.slots[addr.slotIndex] = makeEmptyEntry(entry);
  return true;
}

// Change a slot's facings in place (recompute width). <1 removes it.
function bayLayoutSetFacings(bayLayout, addr, newFacings) {
  if (newFacings < 1) return bayLayoutRemove(bayLayout, addr);
  const shelf = bayShelf(bayLayout, addr.bayIndex, addr.shelfPosition);
  if (!shelf || addr.slotIndex < 0 || addr.slotIndex >= shelf.slots.length) return false;
  const entry = shelf.slots[addr.slotIndex];
  if (!entry || (entry.sku && entry.sku.isEmptySlot)) return false;
  const per = entry.sku.widthInches ?? (entry.sku.allocatedInches && entry.sku.facings ? entry.sku.allocatedInches / entry.sku.facings : 3);
  entry.sku.facings = newFacings;
  entry.sku.allocatedInches = per * newFacings;
  markSlotLocked(entry);
  return true;
}

// Insert a prepared entry at a target slot (fill an empty placeholder there,
// else insert within the shelf). Used for Add SKU / next-in-line drops.
function bayLayoutInsert(bayLayout, addr, entry) {
  const shelf = bayShelf(bayLayout, addr.bayIndex, addr.shelfPosition);
  if (!shelf) return false;
  const ti = Math.max(0, Math.min(addr.slotIndex == null ? shelf.slots.length : addr.slotIndex, shelf.slots.length));
  markSlotLocked(entry);
  if (shelf.slots[ti] && shelf.slots[ti].sku && shelf.slots[ti].sku.isEmptySlot) shelf.slots[ti] = entry;
  else shelf.slots.splice(ti, 0, entry);
  return true;
}

// Andrew, 2026-07-26/27 (bay-locked rebuild, Steps 3-5): compact <-> full
// conversion for persistence. The COMPACT form (per bay/shelf, an ordered
// list of { skuId, facings, isLocked } or { empty: true, widthInches }) is
// what's saved to localStorage -- small regardless of store size. The FULL
// form (real brand/varietal/price/score/etc. per entry, same shape
// materializeBayLayout produces) is what's actually rendered from and
// mutated by the bay-address helpers above; it's rehydrated from the
// compact form + the current SKU master + a fresh scoreMap every time a
// store's Planogram Viewer is opened.
function compactBayLayout(bayLayout) {
  return {
    storeId: bayLayout.storeId,
    bays: bayLayout.bays.map((bay) => ({
      bayIndex: bay.bayIndex,
      shelves: bay.shelves.map((shelf) => ({
        position: shelf.position,
        slots: shelf.slots.map((entry) => (entry.sku.isEmptySlot
          ? { empty: true, widthInches: entry.sku.widthInches }
          : { skuId: entry.sku.skuId, facings: entry.sku.facings, isLocked: !!entry.sku.isLocked })),
      })),
    })),
  };
}

function hydrateBayLayout(compact, targetStore, skus, bottleDimensions, scoreMap) {
  return {
    storeId: compact.storeId,
    bays: targetStore.shelfLayout.bays.map((bay, bayIndex) => {
      const compactBay = compact.bays.find((b) => b.bayIndex === bayIndex);
      return {
        bayIndex,
        bayId: bay.bayId,
        shelfCount: bay.shelfCount,
        shelves: Array.from({ length: bay.shelfCount }, (_, i) => {
          const position = i + 1;
          const compactShelf = compactBay && compactBay.shelves.find((s) => s.position === position);
          const shelfDef = physicalShelfDef(targetStore, bayIndex, position);
          const slots = (compactShelf ? compactShelf.slots : []).map((slot) => {
            if (slot.empty) return makeEmptyEntry({ sku: { widthInches: slot.widthInches }, shelfDef });
            const sku = skus.find((s) => s.skuId === slot.skuId);
            // A saved slot's SKU is no longer in the master list (removed
            // from the data source since the layout was saved) -- render
            // it as an empty placeholder rather than crashing or dropping
            // the slot's reserved width.
            if (!sku) return makeEmptyEntry({ sku: { widthInches: 3 }, shelfDef });
            return buildBayEntry(sku, slot.facings, bottleDimensions, scoreMap, shelfDef, slot.isLocked);
          });
          return { position, slots };
        }),
      };
    }),
  };
}

// Builds one full bayLayout slot entry for a real SKU -- shared by hydration
// (rehydrating a saved compact layout) and every manual placement (Add SKU,
// next-in-line drop, override panel save).
function buildBayEntry(sku, facings, bottleDimensions, scoreMap, shelfDef, isLocked = true) {
  const widthInches = bottleWidthInches(sku, bottleDimensions);
  const section = sectionForSku(sku);
  return {
    sku: {
      skuId: sku.skuId,
      upc: sku.upc,
      brand: sku.brand,
      varietal: sku.varietal,
      priceUsd: sku.priceUsd,
      bottleSizeRaw: sku.bottleSizeRaw,
      sales9L: sku.sales9L ?? null,
      growthPct9L: sku.growthPct9L ?? null,
      score: scoreMap.get(sku.skuId)?.score ?? 0,
      facings,
      widthInches,
      allocatedInches: widthInches * facings,
      isLocked,
      reasons: isLocked ? [{ factor: 'Manual override', value: 'Locked by user' }] : [],
    },
    sectionKey: section.key,
    sectionLabel: section.label,
    shelfDef,
    columnIndex: 0,
  };
}

// A physical bay's own shelf profile (zone/traffic per position), computed
// directly from the target bay -- independent of any section, since a
// bay-addressed placement doesn't route through section generation at all.
// Andrew, 2026-07-26/27: reuses the exact same zone/traffic math a section
// gets (buildSectionShelves), just anchored to the REAL destination bay
// instead of wherever a section's nominal Set Layout position happened to
// land, which is strictly more correct for a manually-placed SKU.
function physicalShelfDef(targetStore, bayIndex, shelfPosition) {
  const bay = targetStore.shelfLayout.bays[bayIndex];
  if (!bay) return null;
  const shelves = buildSectionShelves(bay.shelves, bay.shelfCount);
  return shelves[shelfPosition - 1] || null;
}

// Scans every real slot in a bayLayout for one SKU's current physical
// address -- the source of truth for "where is this SKU right now" once
// bayLayout (not plan.sections) is what's actually rendered.
function findBayAddressForSku(bayLayout, skuId) {
  for (const bay of bayLayout.bays) {
    for (const shelf of bay.shelves) {
      const slotIndex = shelf.slots.findIndex((e) => e.sku.skuId === skuId);
      if (slotIndex !== -1) return { bayIndex: bay.bayIndex, shelfPosition: shelf.position, slotIndex };
    }
  }
  return null;
}

// Andrew, 2026-07-26/27: per-section bay range + SKU count, scanned live off
// the persistent bayLayout every render -- replaces the one-time `spans`
// buildBayRowMap produced at materialization, which goes stale the instant
// a manual bay edit happens. Keys off each entry's own (unresolved)
// sectionKey, which for a merged section IS the merged wrapper key (matches
// plan.sections' own key), same convention placeSectionBoxes always used.
function computeLiveSectionSpans(bayLayout) {
  const bySection = new Map();
  bayLayout.bays.forEach((bay) => {
    bay.shelves.forEach((shelf) => {
      shelf.slots.forEach((entry) => {
        if (entry.sku.isEmptySlot) return;
        const key = entry.sectionKey;
        const rec = bySection.get(key) || { minBay: bay.bayIndex, maxBay: bay.bayIndex, count: 0 };
        rec.minBay = Math.min(rec.minBay, bay.bayIndex);
        rec.maxBay = Math.max(rec.maxBay, bay.bayIndex);
        rec.count += 1;
        bySection.set(key, rec);
      });
    });
  });
  return bySection;
}

// One box PER FACING (2026-07-15): a SKU with 3 facings renders as 3
// side-by-side boxes instead of 1 box with a "3f" label -- fills the
// section the way it actually looks on the real shelf, and reads as
// immediately obvious rather than requiring you to parse a facings count.
// Andrew, 2026-07-23: botaEdge ({first, last}) marks whether this ENTRY
// sits at the very start/end of a contiguous Bota run within its category
// group (see renderEntriesWithBotaHighlight) -- used to cap the gold
// highlight's left/right edge on the true first/last PHYSICAL box only
// (not every repeated facing-copy of this SKU), so a same-SKU multi-facing
// run doesn't get a stray gold line between its own facings.
function renderSkuBox(entry, botaEdge = null) {
  const { sku, shelfDef, bayIndex, slotIndex } = entry;
  const singleWidthIn = sku.widthInches ?? ((sku.allocatedInches ?? sku.widthInches ?? 3) / Math.max(1, sku.facings));
  const widthPx = Math.max(MIN_BOX_PX, singleWidthIn * PX_PER_INCH);
  const label = `${sku.brand}${sku.varietal ? ' – ' + sku.varietal : (sku.bottleSizeRaw ? ' – ' + sku.bottleSizeRaw : '')}`;
  const salesStr = sku.sales9L != null ? '$' + Math.round(sku.sales9L).toLocaleString() : '--';
  const growthStr = (typeof sku.growthPct9L === 'number' && Number.isFinite(sku.growthPct9L))
    ? (sku.growthPct9L >= 0 ? '+' : '') + (sku.growthPct9L * 100).toFixed(1) + '%'
    : '--';
  const facingCount = Math.max(1, sku.facings || 1);
  // Name reads vertically, top-to-bottom, brand first, so it stays readable
  // at facing-width instead of truncating in a box only 1-2in wide.
  // Andrew's rule 2026-07-15 (vertical text), refined 2026-07-22 (brand
  // must read first/top-most, not get buried at the bottom).
  const boxes = [];
  for (let i = 0; i < facingCount; i++) {
    const botaClass = botaEdge
      ? ' planogram-box-bota'
        + (botaEdge.first && i === 0 ? ' planogram-box-bota-first' : '')
        + (botaEdge.last && i === facingCount - 1 ? ' planogram-box-bota-last' : '')
      : '';
    boxes.push(`
    <div class="planogram-box${sku.isLocked ? ' locked' : ''}${botaClass}" style="width:${widthPx}px;" title="${label} (score ${sku.score.toFixed(1)}, ${salesStr} sales, ${growthStr} vs YA, ${sku.facings} facings, ${singleWidthIn.toFixed(1)}in each) -- drag to move or swap" draggable="true" data-sku-id="${sku.skuId}" data-bay-index="${bayIndex}" data-shelf-position="${shelfDef.position}" data-slot-index="${slotIndex}" data-facings="${sku.facings}">
      ${sku.isLocked ? '<div class="planogram-lock-badge" title="Manually placed, locked">&#128274;</div>' : ''}
      <div class="planogram-box-facing-controls">
        <button type="button" class="planogram-facing-btn planogram-facing-minus" draggable="false" title="${sku.facings <= 1 ? 'Remove from set' : 'Remove one facing'}">&minus;</button>
        <button type="button" class="planogram-facing-btn planogram-facing-plus" draggable="false" title="Add one facing">&plus;</button>
      </div>
      <div class="planogram-box-label"><span>${label}</span></div>
      <div class="planogram-box-footer">
        <span class="planogram-box-price">${sku.priceUsd != null ? '$' + sku.priceUsd.toFixed(2) : '--'}</span>
      </div>
    </div>
  `);
  }
  return boxes.join('');
}

// A merged section's label concatenates every original category it absorbed
// (e.g. "CABERNET SAUVIGNON + 3LT Box + ... + FLAVORED/SWEET" -- with the
// MI dataset's ~50 small categories, that can run 15+ segments). The full
// string is fine in the Total Horizontal Set Width summary (normal
// horizontal text), but as a vertical divider badge between boxes it was
// dictating the ENTIRE shelf row's height via flex stretch -- one long
// divider forced every box in the row to stretch to match it, regardless of
// how short the actual SKU labels were. Shown truncated here; full label
// still available via the title tooltip.
function shortenDividerLabel(label, maxParts = 3, maxChars = 60) {
  const parts = label.split(' + ');
  let shown = parts.slice(0, maxParts).join(' + ');
  if (parts.length > maxParts) shown += ` +${parts.length - maxParts} more`;
  if (shown.length > maxChars) shown = shown.slice(0, maxChars) + '…';
  return shown;
}

// Andrew, 2026-07-20: every category gets a stable color, hashed from its
// own section key -- deterministic (same category always draws the same
// color across reloads/regenerations) and needs no manual list to keep in
// sync as categories get added, merged, or renamed. Golden-angle hue step
// keeps adjacent categories visually distinct even as the count grows.
const categoryColorCache = new Map();
function categoryColor(sectionKey) {
  if (categoryColorCache.has(sectionKey)) return categoryColorCache.get(sectionKey);
  let hash = 0;
  for (let i = 0; i < sectionKey.length; i++) hash = (hash * 31 + sectionKey.charCodeAt(i)) >>> 0;
  const hue = (hash * 137.508) % 360; // golden angle
  const color = `hsl(${hue.toFixed(1)}, 70%, 58%)`;
  categoryColorCache.set(sectionKey, color);
  return color;
}

// Andrew, 2026-07-23 (revised a second time): gold shimmer highlight around
// just the contiguous run of highlighted boxes (any sub-line, any size)
// within a category group -- NOT the whole category group, which can hold
// other brands too. A wrapping div around the run (both a plain outline and
// an inset box-shadow version) failed: the ring ended up covered either by
// the next sibling box (outline, positive offset) or by the wrapper's own
// children (inset, since they fill it edge to edge with no padding) --
// confirmed live both times. Styling each box's OWN border instead can't be
// covered by anything else, since it's part of that box's own paint: every
// highlighted box gets a continuous gold top/bottom edge, and only the true
// first/last physical box in the run also gets a gold left/right cap,
// closing the ring exactly at the seam with a non-highlighted neighbor.
// Andrew, 2026-07-24: extended from Bota-only to every Strategic Supplier
// Priority SKU (curationRules.js sets sku.strategicSupplierPriority on all
// of them -- Coppola, Stoneleigh, Schmitt Sohne, Stella Rosa, etc., plus
// whatever gets added to that list later, no code change needed here).
// Bota itself doesn't carry that flag (it's a hardcoded priority brand
// predating the curation-rules mechanism), so it's kept as a second,
// independent check rather than folded into the supplier-priority list.
function renderEntriesWithBotaHighlight(entries) {
  const runs = [];
  entries.forEach((entry) => {
    const isHighlighted = /BOTA/i.test(entry.sku.brand || '') || entry.sku.strategicSupplierPriority === true;
    const last = runs[runs.length - 1];
    if (last && last.isHighlighted === isHighlighted) last.entries.push(entry);
    else runs.push({ isHighlighted, entries: [entry] });
  });
  return runs.map((run) => {
    if (!run.isHighlighted) return run.entries.map((e) => renderSkuBox(e)).join('');
    return run.entries.map((entry, i) => renderSkuBox(entry, {
      first: i === 0,
      last: i === run.entries.length - 1,
    })).join('');
  }).join('');
}

// Renders one bay's row: groups the row's entries by contiguous section so
// a bay shared by two categories (a section boundary fell inside it) shows
// a small divider badge at the handoff point, keeping them distinguishable.
// Andrew, 2026-07-18: any leftover width in the row (or the whole row, if
// it's bare) renders as a clickable/droppable "+ Add SKU" slot -- click
// opens the Add SKU search pre-scoped to that bay/shelf, or drop a dragged
// box onto it to relocate that SKU there.
function renderBayRow(rowEntries, position, bay) {
  const shelfDef = rowEntries[0]?.shelfDef;
  const groups = [];
  rowEntries.forEach((rawEntry, slotIndex) => {
    // Every entry carries its own physical address (bayIndex from the bay
    // this row belongs to, slotIndex from its literal position in the
    // shelf's slots array) -- the address every edit handler now targets
    // instead of a section/columnIndex pair. A plain object spread, not a
    // mutation of the live entry, so re-rendering never leaves stray
    // render-only fields on the actual bayLayout data.
    const entry = { ...rawEntry, bayIndex: bay.bayIndex, slotIndex };
    // Andrew, 2026-07-24: an emptied spot renders as its own standalone
    // "+ Add SKU" box at the exact reserved width, rather than folding into
    // a category group -- keeps every OTHER box's position stable instead
    // of condensing toward the start.
    if (entry.sku?.isEmptySlot) {
      groups.push({
        isEmptySlot: true,
        widthInches: entry.sku.widthInches,
        bayIndex: entry.bayIndex,
        slotIndex: entry.slotIndex,
      });
      return;
    }
    // Andrew, 2026-07-26: entry.sectionKey reflects which section's shelf
    // array the SKU physically lives in -- correct for placement, but a
    // manually locked/moved SKU (Editing Mode) can end up sitting inside a
    // DIFFERENT category's section (e.g. a White Zinfandel dragged next to
    // Fortified). Grouping/coloring by the container section made it
    // silently repaint to the neighboring category's color, which defeats
    // the whole point of dragging things around to see what's what. Locked
    // SKUs group/color by their OWN natural category instead, so the color
    // stays a fixed visual anchor no matter where the SKU gets moved.
    const displayKey = entry.sku.isLocked ? sectionForSku(entry.sku).key : entry.sectionKey;
    const displayLabel = entry.sku.isLocked ? sectionForSku(entry.sku).label : entry.sectionLabel;
    const last = groups[groups.length - 1];
    if (last && !last.isEmptySlot && last.sectionKey === displayKey) last.entries.push(entry);
    else groups.push({ sectionKey: displayKey, sectionLabel: displayLabel, entries: [entry] });
  });

  const usedInches = rowEntries.reduce(
    (sum, e) => sum + (e.sku.allocatedInches ?? e.sku.facings * (e.sku.widthInches ?? 3)),
    0
  );
  const leftoverInches = Math.max(0, BAY_INCHES - usedInches);

  let emptySlotHtml = '';
  if (!groups.length) {
    // Nothing placed on this row at all -- append target (slotIndex 0 of an
    // empty array).
    emptySlotHtml = `<div class="planogram-empty-slot planogram-empty-slot-full" data-bay-index="${bay.bayIndex}" data-shelf-position="${position}" data-slot-index="0" title="Click to add a SKU here">+ Add SKU</div>`;
  } else if (leftoverInches > 1) {
    // Trailing slot -- appends after the last real slot in this shelf's
    // array (slotIndex = rowEntries.length, same as "insert at the end").
    emptySlotHtml = `<div class="planogram-empty-slot" style="width:${(leftoverInches * PX_PER_INCH).toFixed(0)}px;" data-bay-index="${bay.bayIndex}" data-shelf-position="${position}" data-slot-index="${rowEntries.length}" title="Click to add a SKU here, or drag one in">+ Add SKU</div>`;
  }

  return `
    <div class="planogram-shelf-row">
      <div class="planogram-shelf-label">Shelf ${position}${shelfDef ? ` &middot; ${shelfDef.zone} &middot; ${shelfDef.traffic} traffic` : ''}</div>
      <div class="planogram-shelf-frame" style="width:${BAY_INCHES * PX_PER_INCH}px;">
        ${groups.map((g) => g.isEmptySlot ? `
          <div class="planogram-empty-slot" style="width:${(g.widthInches * PX_PER_INCH).toFixed(0)}px;" data-bay-index="${g.bayIndex}" data-shelf-position="${position}" data-slot-index="${g.slotIndex}" title="Click to add a SKU here, or drag one in">+ Add SKU</div>
        ` : `
          ${groups.length > 1 ? `<div class="planogram-section-divider" title="${g.sectionLabel}">${shortenDividerLabel(g.sectionLabel)}</div>` : ''}
          <div class="planogram-category-group" style="border-color:${categoryColor(g.sectionKey)};" title="${g.sectionLabel}">
            ${renderEntriesWithBotaHighlight(g.entries)}
          </div>
        `).join('')}
        ${emptySlotHtml}
      </div>
    </div>
  `;
}

// Andrew, 2026-07-26 (bay-locked rebuild, Step 2): renders one bay from the
// materialized bayLayout's bay object (shelves[].slots) instead of the
// re-derived map. Output is identical -- slots ARE the same per-row entries
// the map held -- but the render now flows from an explicit, editable
// structure rather than a per-render recompute.
function renderBay(layoutBay) {
  const positions = Array.from({ length: layoutBay.shelfCount }, (_, i) => i + 1);

  return `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <span class="card-label">Bay ${layoutBay.bayId} <span class="badge" style="margin-left:6px;">${BAY_WIDTH_FT}ft</span></span>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${layoutBay.shelfCount} shelves</span>
      </div>
      <div style="overflow-x:auto;">
        ${positions.map((position) => {
          const shelf = layoutBay.shelves.find((s) => s.position === position);
          return renderBayRow(shelf ? shelf.slots : [], position, layoutBay);
        }).join('')}
      </div>
    </div>
  `;
}

// Andrew, 2026-08-03: Print Set. A deliberately separate, minimal render
// path from renderBay/renderBayRow/renderSkuBox above -- print output has
// none of the interactive/editing concerns (drag-drop, facing buttons, lock
// badges, category color, Bota highlight) those exist for, and mixing the
// two would tie print layout's percentage-of-page math to the on-screen
// editor's pixel-based math. Prints from liveBayLayout (the live, hand-
// edited truth), one bay per physical page, portrait, black-and-white.
function renderPrintBox(sku) {
  const label = `${sku.brand}${sku.varietal ? ' – ' + sku.varietal : (sku.bottleSizeRaw ? ' – ' + sku.bottleSizeRaw : '')}`;
  const singleWidthIn = sku.widthInches ?? ((sku.allocatedInches ?? sku.widthInches ?? 3) / Math.max(1, sku.facings));
  const facingCount = Math.max(1, sku.facings || 1);
  const boxes = [];
  for (let i = 0; i < facingCount; i++) {
    boxes.push(`
      <div class="print-box" style="flex-grow:${singleWidthIn};flex-basis:0;">
        ${sku.upc ? `<div class="print-box-upc"><span>${sku.upc}</span></div>` : ''}
        <div class="print-box-desc"><span>${label}</span></div>
      </div>
    `);
  }
  return boxes.join('');
}

function renderPrintShelfRow(slots, position) {
  const realSlots = slots.filter((s) => s.sku && !s.sku.isEmptySlot);
  return `
    <div class="print-shelf-row">
      <div class="print-shelf-label">Shelf ${position}</div>
      <div class="print-shelf-frame">
        ${realSlots.map((s) => renderPrintBox(s.sku)).join('')}
      </div>
    </div>
  `;
}

function renderPrintBayPage(layoutBay, storeName, pageIndex) {
  const positions = Array.from({ length: layoutBay.shelfCount }, (_, i) => i + 1);
  return `
    <div class="print-page"${pageIndex > 0 ? ' style="break-before:page;page-break-before:always;"' : ''}>
      <div class="print-page-header">${storeName} &mdash; Bay ${layoutBay.bayId}</div>
      <div class="print-page-body">
        ${positions.map((position) => {
          const shelf = layoutBay.shelves.find((s) => s.position === position);
          return renderPrintShelfRow(shelf ? shelf.slots : [], position);
        }).join('')}
      </div>
    </div>
  `;
}

function printSet(bayLayout, storeName) {
  let printRoot = document.getElementById('planogram-print-root');
  if (!printRoot) {
    printRoot = document.createElement('div');
    printRoot.id = 'planogram-print-root';
    document.body.appendChild(printRoot);
  }
  printRoot.innerHTML = bayLayout.bays.map((b, i) => renderPrintBayPage(b, storeName, i)).join('');
  window.print();
}

export function mount(el) {
  let selectedStoreId = null;
  let openSkuId = null; // skuId whose override panel is currently expanded
  let addBayIndex = null; // "+ Add SKU" form state
  let addShelfPosition = null; // pre-set when opened by clicking an empty slot
  let addSlotIndex = null; // pre-set when opened by clicking an empty slot -- exact slot to insert at
  let addSearchTerm = '';
  let nextInLineSectionKey = ''; // which section's "next in line" rail list is showing
  let nextInLineSearchTerm = ''; // filters the rail's own list by brand/varietal/size/skuId

  // Andrew, 2026-07-26 (bay-locked rebuild): the Planogram Viewer's
  // persistent render+edit truth for the currently selected store -- loaded
  // once per store (from store.getBayLayout, or freshly materialized if
  // none saved yet) via ensureLiveBayLayout, then mutated directly by every
  // edit handler. Deliberately NOT recomputed from plan.sections on every
  // render -- that's the entire point of the rebuild (a manual bay
  // arrangement stays put instead of re-flowing on every edit).
  let liveBayLayout = null;

  // Andrew, 2026-07-25: bayIndex -> last-rendered HTML string for that bay.
  // renderOutput used to rebuild EVERY bay's DOM (up to ~1000 SKU boxes on
  // a large store, each with 7-8 listeners) on every single edit, even a
  // one-facing change to one SKU. See patchBays: a bay whose computed HTML
  // hasn't changed since last render is skipped entirely, DOM and
  // listeners untouched.
  let bayHtmlCache = new Map();

  function currentStore() {
    return store.getSnapshot().stores.find((s) => s.storeId === selectedStoreId);
  }

  function scoreMapForCurrentStore() {
    const { skus, metricsConfig } = store.getSnapshot();
    const targetStore = currentStore();
    return computeScoreMap(skus, metricsConfig, targetStore?.qualityScore != null ? { qualityScore: targetStore.qualityScore } : null);
  }

  function regenerateAndSetPlan() {
    const { skus, metricsConfig, bottleDimensions, sizePackage } = store.getSnapshot();
    const targetStore = currentStore();
    if (!targetStore) return null;
    const targetCount = store.getTargetSkuCount(selectedStoreId);
    const multipliers = store.getSectionMultipliers(selectedStoreId);
    let allocations = store.getSectionAllocations(selectedStoreId);
    if (!allocations.length) allocations = store.autoAllocateSections(selectedStoreId);
    const overrides = store.getOverrides(selectedStoreId);
    const caseOnlyMode = store.getCaseOnlyMode();
    const plan = generatePlan(targetStore, skus, metricsConfig, targetCount, bottleDimensions, allocations, multipliers, sizePackage, caseOnlyMode, overrides);
    store.setPlan(plan);
    return plan;
  }

  function persistLiveBayLayout() {
    if (!liveBayLayout) return;
    store.setBayLayout(selectedStoreId, compactBayLayout(liveBayLayout));
  }

  // Andrew, 2026-07-26/27 (bay-locked rebuild, Step 5): loads the saved
  // compact bayLayout for the selected store and rehydrates it, or
  // materializes a fresh one (from the current plan) if this store has
  // none saved yet. A no-op once liveBayLayout already matches the
  // selected store -- called on every renderOutput, but only does real
  // work on a store switch or first load.
  function ensureLiveBayLayout(plan, targetStore) {
    if (liveBayLayout && liveBayLayout.storeId === selectedStoreId) return;
    const compact = store.getBayLayout(selectedStoreId);
    const { skus, bottleDimensions } = store.getSnapshot();
    const scoreMap = scoreMapForCurrentStore();
    if (compact) {
      liveBayLayout = hydrateBayLayout(compact, targetStore, skus, bottleDimensions, scoreMap);
    } else {
      liveBayLayout = materializeBayLayout(plan, targetStore.shelfLayout.bays);
      persistLiveBayLayout();
    }
  }

  // Single entry point for every manual bay edit (facing +/-, drag
  // move/swap, Add SKU, remove, override panel). `mutate` applies to
  // liveBayLayout via the bay-address helpers above; `overrides` is the
  // parallel section-addressed override list saved via store.addOverride --
  // the "COUPLING FINDING" dual-write from the rebuild spec, so Set
  // Overview / Digital Twin / Optimization Engine (which regenerate from
  // plan.sections + overrides, not from bayLayout) stay correct too, even
  // though they may show a differently-reflowed position than the
  // bay-locked viewer. If `mutate` can't apply (shouldn't happen -- every
  // caller only ever targets a real, currently-rendered address), nothing
  // is touched: no override saved, no render, no partial state.
  function commitBayEdit({ mutate, overrides }) {
    if (!liveBayLayout) return;
    const ok = mutate(liveBayLayout);
    if (!ok) {
      console.warn('Bay-locked edit could not be applied cleanly; no change made.', overrides);
      return;
    }
    overrides.forEach((o) => store.addOverride(selectedStoreId, o));
    persistLiveBayLayout();
    renderOutput(store.getSnapshot().currentPlan);
    warnIfBayOverflows(overrides.map((o) => o.skuId));
  }

  // Andrew, 2026-07-18: a locked/manual placement's width isn't subtracted
  // from the row's normal fill budget (known limitation, documented at the
  // block-layout call site in placementSolver.js) -- so a forced facings
  // count or a swap can genuinely push a shelf row's real content past the
  // physical 4ft bay width without the placement itself being rejected.
  // Warn explicitly rather than let it silently overflow the row. Per
  // decision 3 (2026-07-27): crowd-and-warn, never block -- the edit above
  // has already been applied by the time this runs.
  function warnIfBayOverflows(skuIds) {
    if (!liveBayLayout) return;
    const warned = new Set();
    liveBayLayout.bays.forEach((bay) => {
      bay.shelves.forEach((shelf) => {
        if (!shelf.slots.some((e) => skuIds.includes(e.sku.skuId))) return;
        const usedInches = shelf.slots.reduce(
          (sum, e) => sum + (e.sku.allocatedInches ?? e.sku.facings * (e.sku.widthInches ?? 3)),
          0
        );
        const overageInches = usedInches - BAY_INCHES;
        const key = `${bay.bayIndex}-${shelf.position}`;
        if (overageInches > 0.5 && !warned.has(key)) {
          warned.add(key);
          alert(`Bay ${bay.bayId}, Shelf ${shelf.position} now exceeds its available space by ${(overageInches / 12).toFixed(1)}ft. It will still render, but consider fewer facings or moving something out.`);
        }
      });
    });
  }

  function renderOverridesList() {
    const overrides = store.getOverrides(selectedStoreId);
    if (!overrides.length) return '';
    return `
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Manual Overrides (${overrides.length})</span>
          <button class="btn reset-all-overrides-btn">Reset All to AI</button>
        </div>
        <div style="margin-top:8px;">
          ${overrides.map((o) => `
            <div class="override-list-item" data-override-id="${o.id}">
              <span>${o.skuId} -- ${o.action === 'remove' ? 'removed from plan' : `placed in ${o.sectionKey}, shelf ${o.shelfPosition}, ${o.facings}f`}</span>
              <button class="btn reset-override-btn" data-override-id="${o.id}">Reset to AI</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Andrew, 2026-07-27 (bay-locked rebuild, decision 1): Bay + Shelf
  // dropdowns, not a Section dropdown -- place directly where you want it.
  function renderAddSkuForm() {
    const { skus } = store.getSnapshot();
    const targetStore = currentStore();
    const bays = targetStore ? targetStore.shelfLayout.bays : [];
    const chosenBayIndex = addBayIndex != null && bays[addBayIndex] ? addBayIndex : 0;
    const chosenBay = bays[chosenBayIndex];
    const shelfOptions = chosenBay ? Array.from({ length: chosenBay.shelfCount }, (_, i) => i + 1) : [];
    const chosenShelf = addShelfPosition && shelfOptions.includes(addShelfPosition) ? addShelfPosition : shelfOptions[0];
    const matches = addSearchTerm.trim().length >= 2
      ? skus.filter((s) => `${s.brand} ${s.varietal || ''} ${s.skuId}`.toLowerCase().includes(addSearchTerm.toLowerCase())).slice(0, 8)
      : [];

    return `
      <div class="card" style="margin-bottom:14px;overflow:visible;">
        <span class="card-label">+ Add SKU to Plan</span>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Bay</div>
            <select class="add-sku-bay">
              ${bays.map((b, i) => `<option value="${i}" ${i === chosenBayIndex ? 'selected' : ''}>Bay ${b.bayId}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Shelf</div>
            <select class="add-sku-shelf">
              ${shelfOptions.map((p) => `<option value="${p}" ${p === chosenShelf ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Facings</div>
            <input type="number" class="add-sku-facings" value="1" min="1" max="20" step="1" style="width:70px;" />
          </div>
          <div style="flex:1;min-width:200px;position:relative;">
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Search SKU (brand, varietal, or ID)</div>
            <input type="text" class="add-sku-search" value="${addSearchTerm}" placeholder="e.g. Barefoot, Cabernet..." style="width:100%;" />
            ${matches.length ? `
              <div class="add-sku-results">
                ${matches.map((s) => `<div class="add-sku-result" data-sku-id="${s.skuId}">${s.brand} &middot; ${s.varietal || s.bottleSizeRaw} &middot; ${s.skuId}</div>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // Andrew, 2026-07-27 (bay-locked rebuild): same Bay + Shelf targeting as
  // Add SKU, for consistency -- this is the click-a-box editing panel.
  function renderOverridePanel() {
    if (!openSkuId) return '';
    const { skus } = store.getSnapshot();
    const sku = skus.find((s) => s.skuId === openSkuId);
    if (!sku) return '';
    const existing = store.getOverrides(selectedStoreId).find((o) => o.skuId === openSkuId);
    const targetStore = currentStore();
    const bays = targetStore ? targetStore.shelfLayout.bays : [];
    const currentAddr = liveBayLayout ? findBayAddressForSku(liveBayLayout, openSkuId) : null;
    const chosenBayIndex = currentAddr ? currentAddr.bayIndex : 0;
    const chosenBay = bays[chosenBayIndex];
    const shelfOptions = chosenBay ? Array.from({ length: chosenBay.shelfCount }, (_, i) => i + 1) : [];
    const chosenShelf = currentAddr ? currentAddr.shelfPosition : shelfOptions[0];
    const currentEntry = currentAddr ? bayShelf(liveBayLayout, currentAddr.bayIndex, currentAddr.shelfPosition)?.slots[currentAddr.slotIndex] : null;
    const currentFacings = existing?.facings || currentEntry?.sku.facings || 1;

    return `
      <div class="card override-panel" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Editing ${sku.brand} ${sku.varietal || sku.bottleSizeRaw || ''} (${sku.skuId})</span>
          <button class="btn override-cancel-btn">Cancel</button>
        </div>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Bay</div>
            <select class="override-bay">
              ${bays.map((b, i) => `<option value="${i}" ${i === chosenBayIndex ? 'selected' : ''}>Bay ${b.bayId}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Shelf</div>
            <select class="override-shelf">
              ${shelfOptions.map((p) => `<option value="${p}" ${p === chosenShelf ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Facings</div>
            <input type="number" class="override-facings" value="${currentFacings}" min="1" max="20" step="1" style="width:70px;" />
          </div>
          <button class="btn btn-primary override-save-btn">Save (Lock Here)</button>
          <button class="btn override-remove-btn">Remove from Plan</button>
          ${existing ? '<button class="btn override-reset-btn">Reset to AI</button>' : ''}
        </div>
      </div>
    `;
  }

  function render() {
    bayHtmlCache = new Map(); // fresh .viewer-output element below -- old bay wrappers no longer exist
    const { stores, currentPlan } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = store.getActiveStoreId() || currentPlan?.storeId || stores[0]?.storeId;

    let plan = currentPlan && currentPlan.storeId === selectedStoreId ? currentPlan : null;
    if (!plan) plan = regenerateAndSetPlan();

    el.innerHTML = `
      <div class="page-header">
        <h1>Planogram Viewer</h1>
        <p>Rendered in real 4ft bays, matching the store's physical fixture from Set Layout. Click a SKU to move, lock, or remove it -- manual placements always win over the AI recommendation. Boxes marked &#128274; are locked.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:24px;margin-bottom:14px;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <a href="#set-layout" class="btn">Reorder Sections &rarr;</a>
        </div>
        <div>
          <button type="button" class="btn print-set-btn">Print Set</button>
        </div>
      </div>
      <div style="display:flex;align-items:stretch;gap:14px;">
        <div class="viewer-output" style="flex:1;min-width:0;"></div>
        <div class="next-in-line-column"></div>
      </div>
    `;

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      store.setActiveStoreId(selectedStoreId);
      openSkuId = null;
      render();
    });

    // Andrew, 2026-08-03: prints from liveBayLayout (not plan.sections), same
    // "live hand-edited truth" liveBayLayout already is for the on-screen
    // view -- a manual bay edit shows up on the printout without needing a
    // full Regenerate first.
    el.querySelector('.print-set-btn').addEventListener('click', () => {
      if (!liveBayLayout) return;
      printSet(liveBayLayout, currentStore()?.name || 'Store');
    });

    renderOutput(plan);
  }

  // Andrew, 2026-07-21: browsable per-section "next in line" list -- the
  // ranked-but-not-yet-placed pool for whichever section is selected in the
  // rail's own dropdown, draggable onto any shelf slot. Andrew, 2026-07-27:
  // always visible now that bayLayout is always the live editable truth
  // (the old Editing-Mode-only gate is gone -- every edit is a manual
  // placement tool now, not just when a toggle was on). Scoped per-section
  // (not one global list) since sections are real, distinct category pools.
  function renderNextInLineRail(plan) {
    const column = el.querySelector('.next-in-line-column');
    if (!column) return;
    if (!plan || !plan.sections.length) {
      column.innerHTML = '';
      return;
    }

    const sectionsWithPool = plan.sections.filter((s) => s.nextInLine.length);
    if (!nextInLineSectionKey || !sectionsWithPool.some((s) => s.key === nextInLineSectionKey)) {
      nextInLineSectionKey = sectionsWithPool[0]?.key || '';
    }
    const activeSection = plan.sections.find((s) => s.key === nextInLineSectionKey);
    const term = nextInLineSearchTerm.trim().toLowerCase();
    const visibleSkus = activeSection
      ? activeSection.nextInLine.filter((sku) => !term
        || `${sku.brand} ${sku.varietal || ''} ${sku.bottleSizeRaw || ''} ${sku.skuId}`.toLowerCase().includes(term))
      : [];

    column.innerHTML = `
      <div class="card next-in-line-rail" style="width:300px;position:sticky;top:14px;max-height:calc(100vh - 28px);display:flex;flex-direction:column;">
        <div class="card-label" style="margin-bottom:8px;">Next In Line</div>
        <select class="next-in-line-section-select" style="width:100%;margin-bottom:8px;">
          ${sectionsWithPool.length
            ? sectionsWithPool.map((s) => `<option value="${s.key}" ${s.key === nextInLineSectionKey ? 'selected' : ''}>${s.label} (${s.nextInLine.length})</option>`).join('')
            : '<option>No section has a deeper pool right now</option>'}
        </select>
        <input type="text" class="next-in-line-search" value="${nextInLineSearchTerm}" placeholder="Search brand, varietal, size, or ID..." style="width:100%;margin-bottom:8px;" />
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px;">Drag a SKU onto any shelf slot in this section to add it. Doesn't change any other SKU's position.</div>
        <div class="next-in-line-list" style="overflow-y:auto;flex:1;">
          ${visibleSkus.length ? visibleSkus.map((sku) => `
            <div class="next-in-line-item" draggable="true" data-sku-id="${sku.skuId}" title="Drag onto a shelf slot to add">
              <div style="font-weight:600;font-size:12.5px;">${sku.brand}${sku.varietal ? ' &ndash; ' + sku.varietal : (sku.bottleSizeRaw ? ' &ndash; ' + sku.bottleSizeRaw : '')}</div>
              <div style="font-size:11px;color:var(--text2);display:flex;justify-content:space-between;">
                <span>${sku.priceUsd != null ? '$' + sku.priceUsd.toFixed(2) : '--'}</span>
                <span>score ${sku.score.toFixed(1)}</span>
              </div>
            </div>
          `).join('') : `<div style="font-size:12px;color:var(--text2);padding:8px 0;">${term ? 'No matches in this section\'s list.' : 'No section has a deeper pool right now'}</div>`}
        </div>
      </div>
    `;

    // Andrew, 2026-07-21: re-render replaces the whole subtree on every
    // keystroke (same reason the Add SKU search does this below), which
    // would otherwise drop focus/cursor after one character -- restore both.
    const searchInput = column.querySelector('.next-in-line-search');
    searchInput?.addEventListener('input', (e) => {
      nextInLineSearchTerm = e.target.value;
      const cursorPos = e.target.selectionStart;
      renderNextInLineRail(store.getSnapshot().currentPlan);
      const freshInput = column.querySelector('.next-in-line-search');
      if (freshInput) {
        freshInput.focus();
        freshInput.setSelectionRange(cursorPos, cursorPos);
      }
    });

    column.querySelector('.next-in-line-section-select')?.addEventListener('change', (e) => {
      nextInLineSectionKey = e.target.value;
      nextInLineSearchTerm = '';
      renderNextInLineRail(store.getSnapshot().currentPlan);
    });

    column.querySelectorAll('.next-in-line-item').forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          skuId: item.dataset.skuId,
          facings: 1,
          fromNextInLineList: true,
        }));
      });
    });
  }

  function renderOutput(plan) {
    renderNextInLineRail(plan);
    const output = el.querySelector('.viewer-output');
    if (!plan) {
      output.innerHTML = '<div class="card empty-state">No plan could be generated for this store.</div>';
      bayHtmlCache.clear();
      return;
    }
    const targetStore = currentStore();
    if (!targetStore) {
      output.innerHTML = '<div class="card empty-state">Store not found.</div>';
      bayHtmlCache.clear();
      return;
    }

    ensureLiveBayLayout(plan, targetStore);

    // Andrew, 2026-07-19: dropped the Math.max(linearFeet, ...) floor -- with
    // sections now rendering compacted to their real content width (see
    // buildBayRowMap), this summary should match what's actually drawn, not
    // pretend a depth-exhausted section still occupies its full allocation.
    // Andrew, 2026-07-27: this summary, the category legend, and the
    // nextInLine rail all keep reading plan.sections unchanged (per the
    // rebuild spec) -- they reflect the last full regeneration, not live
    // bay edits, same intentional divergence as Set Overview/Digital
    // Twin/Optimization Engine.
    const actualSectionFeet = (s) => Math.max(...s.shelves.map(rowInches), 0) / 12;
    const totalWidth = plan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);
    const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
    const liveSpans = computeLiveSectionSpans(liveBayLayout);
    const bayCount = targetStore.shelfLayout.bays.length;

    const chromeHtml = `
      ${renderOverridesList()}
      ${renderAddSkuForm()}
      ${renderOverridePanel()}
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Total Horizontal Set Width</span>
          <span class="kpi-value" style="font-size:22px;margin-top:0;">${totalWidth.toFixed(1)} ft <span style="font-size:12px;color:var(--text3);">of ${physicalWidthFt}ft fixture</span></span>
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
          ${plan.sections.map((s) => `<span class="badge" style="font-family:var(--font-mono);">${s.label}: ${actualSectionFeet(s).toFixed(1)}ft</span>`).join('')}
        </div>
        ${plan.isOverflowing ? `<div class="badge badge-warning" style="margin-top:10px;">Allocated sections exceed the fixture by ${plan.overflowFt.toFixed(1)}ft -- sections past the physical bay count are computed but NOT SHOWN below (silently dropped, not merged or trimmed). Reduce section widths in Set Layout or add bays in Store Builder.</div>` : ''}
        ${plan.sections.filter((s) => s.skuDepthExhausted).map((s) => `<div class="badge badge-warning" style="margin-top:6px;">${s.label}: SKU depth exhausted -- ${s.depthExhaustedNote}</div>`).join('')}
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div class="card-label">Category Colors</div>
        <div class="planogram-category-legend">
          ${plan.sections.map((s) => `
            <div class="planogram-category-legend-item">
              <span class="planogram-category-legend-swatch" style="background:${categoryColor(s.key)};"></span>
              <span>${s.label}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div class="card-label">Debug: Section &rarr; Bay Mapping (live)</div>
        <table style="width:100%;font-family:var(--font-mono);font-size:11px;margin-top:8px;border-collapse:collapse;">
          <thead><tr style="text-align:left;color:var(--text3);">
            <th style="padding:3px 8px 3px 0;">Type</th><th style="padding:3px 8px;">Key</th>
            <th style="padding:3px 8px;">startFt</th><th style="padding:3px 8px;">linearFeet</th>
            <th style="padding:3px 8px;">endFt</th><th style="padding:3px 8px;">Bay index range</th>
            <th style="padding:3px 8px;">shelfCount</th><th style="padding:3px 8px;">SKUs placed</th>
          </tr></thead>
          <tbody>
            ${plan.sections.map((s) => {
              // Andrew, 2026-07-27: startFt/endFt/bay-range/SKU-count now
              // come from a LIVE scan of the persistent bayLayout (see
              // computeLiveSectionSpans), not a one-time materialization
              // snapshot -- this table always matches what's actually
              // drawn, including after manual bay edits. Bay indices are
              // always real physical bays by construction now, so the old
              // "OUT OF BOUNDS" case can no longer occur.
              const rec = liveSpans.get(s.key);
              const startFt = rec ? rec.minBay * BAY_WIDTH_FT : null;
              const endFt = rec ? (rec.maxBay + 1) * BAY_WIDTH_FT : null;
              const feet = rec ? endFt - startFt : 0;
              const skuCount = rec ? rec.count : 0;
              return `<tr>
                <td style="padding:3px 8px 3px 0;">${s.type}</td>
                <td style="padding:3px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.key}">${s.key.slice(0, 40)}${s.key.length > 40 ? '…' : ''}</td>
                <td style="padding:3px 8px;">${startFt != null ? startFt.toFixed(2) : '--'}</td>
                <td style="padding:3px 8px;">${feet.toFixed(2)}</td>
                <td style="padding:3px 8px;">${endFt != null ? endFt.toFixed(2) : '--'}</td>
                <td style="padding:3px 8px;">${rec ? `${rec.minBay}-${rec.maxBay}` : 'not placed'} (of ${bayCount} bays)</td>
                <td style="padding:3px 8px;">${s.shelfCount}</td>
                <td style="padding:3px 8px;">${skuCount}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // Andrew, 2026-07-25: the bays container is a PERSISTENT sibling of the
    // chrome, never torn down here -- only patchBays touches it, and only
    // the specific bay wrappers whose content actually changed. Rebuilding
    // it via innerHTML on every render (like chrome, which is cheap and
    // always fully rebuilt) would destroy and recreate every bay's DOM
    // every time, defeating the whole point.
    let chromeEl = output.querySelector('.planogram-chrome');
    let baysContainer = output.querySelector('.planogram-bays-container');
    if (!chromeEl || !baysContainer) {
      output.innerHTML = '<div class="planogram-chrome"></div><div class="planogram-bays-container"></div>';
      chromeEl = output.querySelector('.planogram-chrome');
      baysContainer = output.querySelector('.planogram-bays-container');
      bayHtmlCache.clear();
    }
    chromeEl.innerHTML = chromeHtml;
    bindChromeListeners(output);
    patchBays(baysContainer, liveBayLayout);
  }

  // Andrew, 2026-07-25: rebuilds one bay's DOM + listeners, but only when
  // that bay's actual rendered content changed since last render -- see
  // bayHtmlCache above. On a typical single-SKU edit, only the bay(s) the
  // edit actually touches get rebuilt; every other bay's existing elements
  // and listeners are left completely alone, instead of the whole store's
  // ~1000 boxes being torn down and re-listened on every click.
  function patchBays(container, bayLayout) {
    bayLayout.bays.forEach((layoutBay, i) => {
      const html = renderBay(layoutBay);
      if (bayHtmlCache.get(i) === html) return; // unchanged -- skip entirely
      bayHtmlCache.set(i, html);
      let wrapper = container.querySelector(`[data-bay-index="${i}"]`);
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.dataset.bayIndex = String(i);
        container.appendChild(wrapper);
      }
      wrapper.innerHTML = html;
      bindBoxAndSlotListeners(wrapper);
    });
    // Store switched to a fixture with fewer bays -- drop the stale extras
    // (render() already resets bayHtmlCache on any store switch, but this
    // keeps patchBays correct even if ever called without that reset).
    Array.from(container.children).forEach((child) => {
      const idx = Number(child.dataset.bayIndex);
      if (idx >= bayLayout.bays.length) { container.removeChild(child); bayHtmlCache.delete(idx); }
    });
  }

  // Bay-scoped listeners (SKU boxes + empty "+ Add SKU" slots) -- split out
  // from bindChromeListeners so patchBays can bind just the one bay wrapper
  // that actually changed, not the whole output panel.
  function bindBoxAndSlotListeners(scopeEl) {
    scopeEl.querySelectorAll('.planogram-box').forEach((box) => {
      box.addEventListener('click', () => {
        const skuId = box.dataset.skuId;
        openSkuId = openSkuId === skuId ? null : skuId;
        addBayIndex = null;
        addShelfPosition = null;
        addSlotIndex = null;
        addSearchTerm = '';
        renderOutput(store.getSnapshot().currentPlan);
      });

      const bayIndex = parseInt(box.dataset.bayIndex, 10);
      const shelfPosition = parseInt(box.dataset.shelfPosition, 10);
      const slotIndex = parseInt(box.dataset.slotIndex, 10);
      const currentFacings = parseInt(box.dataset.facings, 10) || 1;
      const addr = { bayIndex, shelfPosition, slotIndex };

      // Andrew, 2026-07-18: +/- facing buttons. Plus adds one facing;
      // minus removes one, or removes the SKU from the set entirely once
      // facings would drop below 1. stopPropagation so these don't also
      // trigger the box's own click-to-open-edit-panel handler.
      box.querySelector('.planogram-facing-plus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const sku = store.getSnapshot().skus.find((s) => s.skuId === box.dataset.skuId);
        if (!sku) return;
        commitBayEdit({
          mutate: (bl) => bayLayoutSetFacings(bl, addr, currentFacings + 1),
          overrides: [{ skuId: box.dataset.skuId, action: 'place', sectionKey: sectionForSku(sku).key, shelfPosition, facings: currentFacings + 1 }],
        });
      });

      box.querySelector('.planogram-facing-minus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openSkuId === box.dataset.skuId) openSkuId = null;
        if (currentFacings <= 1) {
          commitBayEdit({
            mutate: (bl) => bayLayoutRemove(bl, addr),
            overrides: [{ skuId: box.dataset.skuId, action: 'remove' }],
          });
        } else {
          const sku = store.getSnapshot().skus.find((s) => s.skuId === box.dataset.skuId);
          if (!sku) return;
          commitBayEdit({
            mutate: (bl) => bayLayoutSetFacings(bl, addr, currentFacings - 1),
            overrides: [{ skuId: box.dataset.skuId, action: 'place', sectionKey: sectionForSku(sku).key, shelfPosition, facings: currentFacings - 1 }],
          });
        }
      });

      // Andrew, 2026-07-18: drag a box onto another box to SWAP their
      // positions (each keeps its own facings count); drag it onto an
      // empty slot to relocate it there instead (handled below).
      box.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          skuId: box.dataset.skuId,
          facings: currentFacings,
          bayIndex, shelfPosition, slotIndex,
        }));
      });
      box.addEventListener('dragover', (e) => e.preventDefault());
      box.addEventListener('dragenter', () => box.classList.add('drag-over-target'));
      box.addEventListener('dragleave', () => box.classList.remove('drag-over-target'));
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.classList.remove('drag-over-target');
        let dragged;
        try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
        const targetSkuId = box.dataset.skuId;
        if (!dragged?.skuId || dragged.skuId === targetSkuId) return;

        const { skus, bottleDimensions } = store.getSnapshot();
        const draggedSku = skus.find((s) => s.skuId === dragged.skuId);
        const targetSku = skus.find((s) => s.skuId === targetSkuId);
        if (!draggedSku || !targetSku) return;

        // Andrew, 2026-07-21: a "next in line" rail drag has no real origin
        // slot to swap back into (it isn't placed anywhere yet) -- insert
        // it at the target box's exact position instead of swapping. The
        // box already there isn't removed, just pushed over.
        if (dragged.fromNextInLineList) {
          const scoreMap = scoreMapForCurrentStore();
          const shelfDef = physicalShelfDef(currentStore(), bayIndex, shelfPosition);
          const entry = buildBayEntry(draggedSku, 1, bottleDimensions, scoreMap, shelfDef);
          openSkuId = null;
          commitBayEdit({
            mutate: (bl) => bayLayoutInsert(bl, addr, entry),
            overrides: [{ skuId: dragged.skuId, action: 'place', sectionKey: sectionForSku(draggedSku).key, shelfPosition, facings: 1 }],
          });
          return;
        }

        const originAddr = { bayIndex: dragged.bayIndex, shelfPosition: dragged.shelfPosition, slotIndex: dragged.slotIndex };
        // The swap: dragged takes target's exact bay/shelf/slot, target
        // takes dragged's -- exchanges the two SKUs' physical positions.
        openSkuId = null;
        commitBayEdit({
          mutate: (bl) => bayLayoutSwap(bl, originAddr, addr),
          overrides: [
            { skuId: dragged.skuId, action: 'place', sectionKey: sectionForSku(draggedSku).key, shelfPosition, facings: dragged.facings },
            { skuId: targetSkuId, action: 'place', sectionKey: sectionForSku(targetSku).key, shelfPosition: originAddr.shelfPosition, facings: currentFacings },
          ],
        });
      });
    });

    scopeEl.querySelectorAll('.planogram-empty-slot').forEach((slot) => {
      slot.addEventListener('click', () => {
        openSkuId = null;
        addBayIndex = slot.dataset.bayIndex != null ? parseInt(slot.dataset.bayIndex, 10) : null;
        addShelfPosition = slot.dataset.shelfPosition ? parseInt(slot.dataset.shelfPosition, 10) : null;
        addSlotIndex = slot.dataset.slotIndex != null ? parseInt(slot.dataset.slotIndex, 10) : null;
        addSearchTerm = '';
        renderOutput(store.getSnapshot().currentPlan);
        requestAnimationFrame(() => {
          const input = document.querySelector('.add-sku-search');
          if (input) { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); input.focus(); }
        });
      });
      slot.addEventListener('dragover', (e) => e.preventDefault());
      slot.addEventListener('dragenter', () => slot.classList.add('drag-over-target'));
      slot.addEventListener('dragleave', () => slot.classList.remove('drag-over-target'));
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('drag-over-target');
        let dragged;
        try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
        if (!dragged?.skuId) return;

        const targetAddr = {
          bayIndex: parseInt(slot.dataset.bayIndex, 10),
          shelfPosition: parseInt(slot.dataset.shelfPosition, 10),
          slotIndex: parseInt(slot.dataset.slotIndex, 10),
        };
        const { skus, bottleDimensions } = store.getSnapshot();
        const draggedSku = skus.find((s) => s.skuId === dragged.skuId);
        if (!draggedSku) return;

        if (dragged.fromNextInLineList) {
          const scoreMap = scoreMapForCurrentStore();
          const shelfDef = physicalShelfDef(currentStore(), targetAddr.bayIndex, targetAddr.shelfPosition);
          const entry = buildBayEntry(draggedSku, 1, bottleDimensions, scoreMap, shelfDef);
          commitBayEdit({
            mutate: (bl) => bayLayoutInsert(bl, targetAddr, entry),
            overrides: [{ skuId: dragged.skuId, action: 'place', sectionKey: sectionForSku(draggedSku).key, shelfPosition: targetAddr.shelfPosition, facings: 1 }],
          });
          return;
        }

        const originAddr = { bayIndex: dragged.bayIndex, shelfPosition: dragged.shelfPosition, slotIndex: dragged.slotIndex };
        commitBayEdit({
          mutate: (bl) => bayLayoutMove(bl, originAddr, targetAddr),
          overrides: [{ skuId: dragged.skuId, action: 'place', sectionKey: sectionForSku(draggedSku).key, shelfPosition: targetAddr.shelfPosition, facings: dragged.facings }],
        });
      });
    });
  }

  // Everything in the output panel EXCEPT the bays themselves (overrides
  // list, Add SKU form, override edit panel, etc.) -- comparatively cheap
  // (a handful of elements, not ~1000), so this still fully rebuilds every
  // render; only the bays get the incremental treatment (patchBays).
  function bindChromeListeners(output) {
    output.querySelector('.override-cancel-btn')?.addEventListener('click', () => {
      openSkuId = null;
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelector('.override-save-btn')?.addEventListener('click', () => {
      const bayIndex = parseInt(output.querySelector('.override-bay').value, 10);
      const shelfPosition = parseInt(output.querySelector('.override-shelf').value, 10);
      const facings = parseInt(output.querySelector('.override-facings').value, 10);
      const skuId = openSkuId;
      openSkuId = null;
      const { skus, bottleDimensions } = store.getSnapshot();
      const sku = skus.find((s) => s.skuId === skuId);
      if (!sku || !liveBayLayout) return;
      const targetStore = currentStore();
      const currentAddr = findBayAddressForSku(liveBayLayout, skuId);
      const scoreMap = scoreMapForCurrentStore();
      const shelfDef = physicalShelfDef(targetStore, bayIndex, shelfPosition);
      const entry = buildBayEntry(sku, facings, bottleDimensions, scoreMap, shelfDef);
      commitBayEdit({
        mutate: (bl) => {
          // Same address, only facings changed -- adjust in place rather
          // than vacating and re-inserting at the end of the row.
          if (currentAddr && currentAddr.bayIndex === bayIndex && currentAddr.shelfPosition === shelfPosition) {
            return bayLayoutSetFacings(bl, currentAddr, facings);
          }
          if (currentAddr) bayLayoutRemove(bl, currentAddr);
          return bayLayoutInsert(bl, { bayIndex, shelfPosition, slotIndex: null }, entry);
        },
        overrides: [{ skuId, action: 'place', sectionKey: sectionForSku(sku).key, shelfPosition, facings }],
      });
    });

    output.querySelector('.override-remove-btn')?.addEventListener('click', () => {
      const skuId = openSkuId;
      openSkuId = null;
      const addr = liveBayLayout ? findBayAddressForSku(liveBayLayout, skuId) : null;
      commitBayEdit({
        mutate: (bl) => (addr ? bayLayoutRemove(bl, addr) : false),
        overrides: [{ skuId, action: 'remove' }],
      });
    });

    // Andrew, 2026-07-27: a per-SKU "Reset to AI" just opens a slot where
    // the SKU currently sits (same as Remove) and drops the override --
    // its natural AI-recommended position doesn't reappear in the bay
    // layout until a full Regenerate (Reset All to AI), consistent with
    // every other bay edit never triggering a reflow of its own accord.
    output.querySelector('.override-reset-btn')?.addEventListener('click', () => {
      const skuId = openSkuId;
      openSkuId = null;
      const existing = store.getOverrides(selectedStoreId).find((o) => o.skuId === skuId);
      if (existing) store.removeOverride(selectedStoreId, existing.id);
      const addr = liveBayLayout ? findBayAddressForSku(liveBayLayout, skuId) : null;
      if (addr) {
        bayLayoutRemove(liveBayLayout, addr);
        persistLiveBayLayout();
      }
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelectorAll('.reset-override-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const overrideId = btn.dataset.overrideId;
        const skuId = store.getOverrides(selectedStoreId).find((o) => o.id === overrideId)?.skuId;
        store.removeOverride(selectedStoreId, overrideId);
        const addr = (skuId && liveBayLayout) ? findBayAddressForSku(liveBayLayout, skuId) : null;
        if (addr) {
          bayLayoutRemove(liveBayLayout, addr);
          persistLiveBayLayout();
        }
        renderOutput(store.getSnapshot().currentPlan);
      });
    });

    // Andrew, 2026-07-27 (bay-locked rebuild, decision 4): confirm-and-
    // discard -- this existing button/confirm already covers "regenerate,"
    // now extended to also re-materialize the bay layout (discarding any
    // manual bay arrangement), not just plan.sections' overrides.
    output.querySelector('.reset-all-overrides-btn')?.addEventListener('click', () => {
      if (!confirm('Reset all manual overrides and regenerate this bay arrangement from the AI recommendation? Any manual bay moves will be lost.')) return;
      store.clearOverrides(selectedStoreId);
      const plan = regenerateAndSetPlan();
      const targetStore = currentStore();
      liveBayLayout = materializeBayLayout(plan, targetStore.shelfLayout.bays);
      persistLiveBayLayout();
      renderOutput(plan);
    });

    output.querySelector('.add-sku-bay')?.addEventListener('change', (e) => {
      addBayIndex = parseInt(e.target.value, 10);
      addShelfPosition = null; // shelf options change with the bay -- let it default to the first
      addSlotIndex = null; // a different bay's row has an unrelated slot layout
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelector('.add-sku-search')?.addEventListener('input', (e) => {
      addSearchTerm = e.target.value;
      const cursorPos = e.target.selectionStart;
      renderOutput(store.getSnapshot().currentPlan);
      // renderOutput replaces the whole DOM subtree via innerHTML, which
      // destroys and recreates the input -- without this, focus is lost
      // after every single keystroke, so only one letter could be typed
      // before having to click back in. Andrew, 2026-07-18.
      const freshInput = output.querySelector('.add-sku-search');
      if (freshInput) {
        freshInput.focus();
        freshInput.setSelectionRange(cursorPos, cursorPos);
      }
    });

    // Andrew, 2026-07-18: "I enter it in, hit enter" -- Enter picks the
    // top search match directly, no need to click the result row too.
    output.querySelector('.add-sku-search')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const topMatch = output.querySelector('.add-sku-result');
      if (topMatch) topMatch.click();
    });

    function addSkuFromForm(skuId) {
      const bayIndex = parseInt(output.querySelector('.add-sku-bay').value, 10);
      const shelfPosition = parseInt(output.querySelector('.add-sku-shelf').value, 10);
      const facings = parseInt(output.querySelector('.add-sku-facings').value, 10);
      const slotIndex = addSlotIndex;
      addSearchTerm = '';
      addBayIndex = null;
      addShelfPosition = null;
      addSlotIndex = null;
      const { skus, bottleDimensions } = store.getSnapshot();
      const sku = skus.find((s) => s.skuId === skuId);
      if (!sku) return;
      const targetStore = currentStore();
      const scoreMap = scoreMapForCurrentStore();
      const shelfDef = physicalShelfDef(targetStore, bayIndex, shelfPosition);
      const entry = buildBayEntry(sku, facings, bottleDimensions, scoreMap, shelfDef);
      commitBayEdit({
        mutate: (bl) => bayLayoutInsert(bl, { bayIndex, shelfPosition, slotIndex }, entry),
        overrides: [{ skuId, action: 'place', sectionKey: sectionForSku(sku).key, shelfPosition, facings }],
      });
    }

    output.querySelectorAll('.add-sku-result').forEach((row) => {
      row.addEventListener('click', () => addSkuFromForm(row.dataset.skuId));
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
