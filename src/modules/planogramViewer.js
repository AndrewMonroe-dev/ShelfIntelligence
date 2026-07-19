import { store } from '../core/store.js';
import { generatePlan } from '../optimize/placementSolver.js';
import { getPhysicalWidthFt, BAY_WIDTH_FT, getShelvesForSpan } from '../optimize/shelfPosition.js';
import { sectionForSku } from '../optimize/blocking.js';

// A rendered section's own key is only a valid override target when it's a
// real sectionAllocations entry -- merged (small-format cluster) sections
// are a rendering-only composite, not something generatePlan's override
// resolution recognizes. For those, fall back to the SKU's own natural
// section key (sectionForSku), which IS a real allocation underneath the
// merged visual wrapper. Andrew, 2026-07-18 (drag-and-drop + click-to-add).
function realSectionKeyFor(rawKey, sku) {
  return rawKey && rawKey.startsWith('merged:') ? sectionForSku(sku).key : rawKey;
}

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
function placeSectionBoxes(map, section, mapper, bayCount) {
  let sectionContentInches = 0;
  section.shelves.forEach((shelf) => {
    let cumulative = 0;
    shelf.skus.forEach((sku, columnIndex) => {
      const w = sku.allocatedInches ?? sku.facings * (sku.widthInches ?? 3);
      const absoluteStart = mapper(cumulative);
      // Clamp rather than drop: a section can land a hair past the store's
      // real bay count on a rounding-level overshoot (content width sums
      // fractionally past the nominal allocation) -- render it in the last
      // real bay instead of silently vanishing with no warning. Genuine
      // over-allocation is still surfaced separately via `plan.isOverflowing`.
      const rawBayIndex = Math.floor(absoluteStart / BAY_INCHES);
      const bayIndex = bayCount != null ? Math.min(rawBayIndex, bayCount - 1) : rawBayIndex;
      if (!map.has(bayIndex)) map.set(bayIndex, new Map());
      const rowMap = map.get(bayIndex);
      if (!rowMap.has(shelf.position)) rowMap.set(shelf.position, []);
      // columnIndex: this SKU's left-to-right slot within its row (Andrew,
      // 2026-07-18) -- lets a drag-drop swap target the exact position
      // another SKU occupied, not just "somewhere in this row."
      rowMap.get(shelf.position).push({ sku, sectionKey: section.key, sectionLabel: section.label, shelfDef: shelf, columnIndex });
      cumulative += w;
    });
    sectionContentInches = Math.max(sectionContentInches, cumulative);
  });
  return sectionContentInches;
}

// Returns { map, spans } -- `spans` is Map<sectionKey, {startFt, endFt}> in
// the same coordinate space as `map`, so the debug table and any other
// consumer of a section's rendered position stay consistent with what
// actually gets drawn, instead of recomputing (and drifting from) the
// compaction math separately.
//
// Andrew, 2026-07-20: small-format sections (187s, 375s, 4-packs, 500mls --
// see `pinnedBayIndex` in placementSolver.js) are pinned to the store's
// shelf-densest bay instead of flowing with normal left-to-right
// compaction, since shorter bottles physically belong on a bay built with
// more/shorter shelves. Every OTHER section still compacts left-to-right
// by real content width (2026-07-19), but now skips over whatever bay
// range the pinned content actually consumes instead of overlapping it.
function buildBayRowMap(sections, bayCount) {
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
      const contentInches = placeSectionBoxes(map, section, (localOffset) => startInches + localOffset, bayCount);
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

  let runningCompactedInches = 0;
  normal.forEach((section) => {
    const compactedStart = runningCompactedInches;
    const contentInches = placeSectionBoxes(map, section, (localOffset) => toRealInches(compactedStart + localOffset), bayCount);
    const realStartInches = toRealInches(compactedStart);
    const realEndInches = toRealInches(compactedStart + contentInches);
    spans.set(section.key, { startFt: realStartInches / 12, endFt: realEndInches / 12 });
    runningCompactedInches += contentInches;
  });

  return { map, spans };
}

// One box PER FACING (2026-07-15): a SKU with 3 facings renders as 3
// side-by-side boxes instead of 1 box with a "3f" label -- fills the
// section the way it actually looks on the real shelf, and reads as
// immediately obvious rather than requiring you to parse a facings count.
function renderSkuBox(entry) {
  const { sku, sectionKey, shelfDef, columnIndex } = entry;
  const singleWidthIn = sku.widthInches ?? ((sku.allocatedInches ?? sku.widthInches ?? 3) / Math.max(1, sku.facings));
  const widthPx = Math.max(MIN_BOX_PX, singleWidthIn * PX_PER_INCH);
  const label = `${sku.brand}${sku.varietal ? ' – ' + sku.varietal : (sku.bottleSizeRaw ? ' – ' + sku.bottleSizeRaw : '')}`;
  const facingCount = Math.max(1, sku.facings || 1);
  // Name reads vertically, bottom-to-top (like a real shelf spine label) so
  // it stays readable at facing-width instead of truncating to "BOTA ..."
  // in a box only 1-2in wide. Andrew's rule 2026-07-15.
  const box = `
    <div class="planogram-box${sku.isLocked ? ' locked' : ''}" style="width:${widthPx}px;" title="${label} (score ${sku.score.toFixed(1)}, ${sku.facings} facings, ${singleWidthIn.toFixed(1)}in each) -- drag to move or swap" draggable="true" data-sku-id="${sku.skuId}" data-section-key="${sectionKey}" data-shelf-position="${shelfDef.position}" data-facings="${sku.facings}" data-column-index="${columnIndex}">
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
  `;
  return box.repeat(facingCount);
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

// Renders one bay's row: groups the row's entries by contiguous section so
// a bay shared by two categories (a section boundary fell inside it) shows
// a small divider badge at the handoff point, keeping them distinguishable.
// Andrew, 2026-07-18: any leftover width in the row (or the whole row, if
// it's bare) renders as a clickable/droppable "+ Add SKU" slot -- click
// opens the Add SKU search pre-scoped to that section/shelf, or drop a
// dragged box onto it to relocate that SKU there.
function renderBayRow(rowEntries, position, bay) {
  const shelfDef = rowEntries[0]?.shelfDef;
  const groups = [];
  rowEntries.forEach((entry) => {
    const last = groups[groups.length - 1];
    if (last && last.sectionKey === entry.sectionKey) last.entries.push(entry);
    else groups.push({ sectionKey: entry.sectionKey, sectionLabel: entry.sectionLabel, entries: [entry] });
  });

  const usedInches = rowEntries.reduce(
    (sum, e) => sum + (e.sku.allocatedInches ?? e.sku.facings * (e.sku.widthInches ?? 3)),
    0
  );
  const leftoverInches = Math.max(0, BAY_INCHES - usedInches);

  let emptySlotHtml = '';
  if (!groups.length) {
    // Nothing placed on this row at all -- no SKU to derive a real section
    // key from, so this opens the Add SKU form unscoped (pick a section
    // manually) rather than guessing one.
    emptySlotHtml = `<div class="planogram-empty-slot planogram-empty-slot-full" title="Click to add a SKU here">+ Add SKU</div>`;
  } else if (leftoverInches > 1) {
    const lastGroup = groups[groups.length - 1];
    const lastEntry = lastGroup.entries[lastGroup.entries.length - 1];
    const targetSectionKey = realSectionKeyFor(lastGroup.sectionKey, lastEntry.sku);
    // Trailing slot -- its implied column position is after everything
    // already in this row.
    emptySlotHtml = `<div class="planogram-empty-slot" style="width:${(leftoverInches * PX_PER_INCH).toFixed(0)}px;" data-section-key="${targetSectionKey}" data-shelf-position="${position}" data-column-index="${rowEntries.length}" title="Click to add a SKU here, or drag one in">+ Add SKU</div>`;
  }

  return `
    <div class="planogram-shelf-row">
      <div class="planogram-shelf-label">Shelf ${position}${shelfDef ? ` &middot; ${shelfDef.zone} &middot; ${shelfDef.traffic} traffic` : ''}</div>
      <div class="planogram-shelf-frame" style="width:${BAY_INCHES * PX_PER_INCH}px;">
        ${groups.map((g) => `
          ${groups.length > 1 ? `<div class="planogram-section-divider" title="${g.sectionLabel}">${shortenDividerLabel(g.sectionLabel)}</div>` : ''}
          ${g.entries.map(renderSkuBox).join('')}
        `).join('')}
        ${emptySlotHtml}
      </div>
    </div>
  `;
}

function renderBay(bay, bayIndex, rowMap) {
  const rowsForBay = rowMap.get(bayIndex) || new Map();
  const positions = Array.from({ length: bay.shelfCount }, (_, i) => i + 1);

  return `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <span class="card-label">Bay ${bay.bayId} <span class="badge" style="margin-left:6px;">${BAY_WIDTH_FT}ft</span></span>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${bay.shelfCount} shelves</span>
      </div>
      <div style="overflow-x:auto;">
        ${positions.map((position) => renderBayRow(rowsForBay.get(position) || [], position, bay)).join('')}
      </div>
    </div>
  `;
}

export function mount(el) {
  let selectedStoreId = null;
  let openSkuId = null; // skuId whose override panel is currently expanded
  let addSectionKey = ''; // "+ Add SKU" form state
  let addShelfPosition = null; // pre-set when opened by clicking an empty slot
  let addSearchTerm = '';

  function currentStore() {
    return store.getSnapshot().stores.find((s) => s.storeId === selectedStoreId);
  }

  // Andrew, 2026-07-18: the real, addressable override targets are whatever
  // sectionAllocations actually has -- including small-format sizes that
  // only ever appear inside a rendering-only "merged" section in the plan
  // output. Building the selectable list from the allocations themselves
  // (rather than currentPlan.sections, which hides merged-away individual
  // sizes entirely) means every size -- 0.5LT, 0.187LT X4, etc. -- can
  // actually be targeted by the Add SKU form and the override panel, not
  // just the always-standalone varietal sections.
  function realSelectableSections() {
    const targetStore = currentStore();
    if (!targetStore) return [];
    const allocations = store.getSectionAllocations(selectedStoreId);
    return allocations.map((a) => ({
      key: a.key,
      label: a.label,
      shelfCount: getShelvesForSpan(targetStore.shelfLayout, a.startFt, a.widthFt).length,
    }));
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

  function renderAddSkuForm(currentPlan) {
    const { skus } = store.getSnapshot();
    const sections = realSelectableSections();
    const chosenSection = sections.find((s) => s.key === addSectionKey) || sections[0];
    const shelfOptions = chosenSection ? Array.from({ length: chosenSection.shelfCount }, (_, i) => i + 1) : [];
    const chosenShelf = addShelfPosition && shelfOptions.includes(addShelfPosition) ? addShelfPosition : shelfOptions[0];
    const matches = addSearchTerm.trim().length >= 2
      ? skus.filter((s) => `${s.brand} ${s.varietal || ''} ${s.skuId}`.toLowerCase().includes(addSearchTerm.toLowerCase())).slice(0, 8)
      : [];

    return `
      <div class="card" style="margin-bottom:14px;overflow:visible;">
        <span class="card-label">+ Add SKU to Plan</span>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Section</div>
            <select class="add-sku-section">
              ${sections.map((s) => `<option value="${s.key}" ${s.key === chosenSection?.key ? 'selected' : ''}>${s.label}</option>`).join('')}
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

  function renderOverridePanel(currentPlan) {
    if (!openSkuId) return '';
    const { skus } = store.getSnapshot();
    const sku = skus.find((s) => s.skuId === openSkuId);
    if (!sku) return '';
    const existing = store.getOverrides(selectedStoreId).find((o) => o.skuId === openSkuId);

    // Find where this SKU actually sits right now by searching every
    // rendered section (including merged ones) -- a merged section's own
    // key isn't itself selectable, so it's resolved to the real underlying
    // key via realSectionKeyFor below.
    let currentRenderedSectionKey = null;
    let currentShelfPosition = null;
    let currentFacingsFound = null;
    outer: for (const s of currentPlan.sections) {
      for (const sh of s.shelves) {
        const found = sh.skus.find((k) => k.skuId === openSkuId);
        if (found) {
          currentRenderedSectionKey = s.key;
          currentShelfPosition = sh.position;
          currentFacingsFound = found.facings;
          break outer;
        }
      }
    }

    const sections = realSelectableSections();
    const currentSectionKey = existing?.sectionKey
      || (currentRenderedSectionKey ? realSectionKeyFor(currentRenderedSectionKey, sku) : null)
      || sections[0]?.key;
    const chosenSection = sections.find((s) => s.key === currentSectionKey) || sections[0];
    const shelfOptions = chosenSection ? Array.from({ length: chosenSection.shelfCount }, (_, i) => i + 1) : [];
    const chosenShelf = existing?.shelfPosition || currentShelfPosition || shelfOptions[0];
    const currentFacings = existing?.facings || currentFacingsFound || 1;

    return `
      <div class="card override-panel" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Editing ${sku.brand} ${sku.varietal || sku.bottleSizeRaw || ''} (${sku.skuId})</span>
          <button class="btn override-cancel-btn">Cancel</button>
        </div>
        <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Section</div>
            <select class="override-section">
              ${sections.map((s) => `<option value="${s.key}" ${s.key === chosenSection?.key ? 'selected' : ''}>${s.label}</option>`).join('')}
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
    const { stores, currentPlan } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = store.getActiveStoreId() || currentPlan?.storeId || stores[0]?.storeId;

    let plan = currentPlan && currentPlan.storeId === selectedStoreId ? currentPlan : null;
    if (!plan) plan = regenerateAndSetPlan();

    el.innerHTML = `
      <div class="page-header">
        <h1>Planogram Viewer</h1>
        <p>Rendered in real 4ft bays, matching the store's physical fixture from Set Layout. Click a SKU to move, lock, or remove it -- manual placements always win over the AI recommendation. Boxes marked &#128274; are locked.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:16px;margin-bottom:14px;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="viewer-output"></div>
    `;

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      store.setActiveStoreId(selectedStoreId);
      openSkuId = null;
      render();
    });

    renderOutput(plan);
  }

  function renderOutput(plan) {
    const output = el.querySelector('.viewer-output');
    if (!plan) {
      output.innerHTML = '<div class="card empty-state">No plan could be generated for this store.</div>';
      return;
    }
    const targetStore = currentStore();
    if (!targetStore) {
      output.innerHTML = '<div class="card empty-state">Store not found.</div>';
      return;
    }

    // Andrew, 2026-07-19: dropped the Math.max(linearFeet, ...) floor -- with
    // sections now rendering compacted to their real content width (see
    // buildBayRowMap), this summary should match what's actually drawn, not
    // pretend a depth-exhausted section still occupies its full allocation.
    const actualSectionFeet = (s) => Math.max(...s.shelves.map(rowInches), 0) / 12;
    const totalWidth = plan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);
    const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
    const { map: rowMap, spans: bayCompactedSpans } = buildBayRowMap(plan.sections, targetStore.shelfLayout.bays.length);

    output.innerHTML = `
      ${renderOverridesList()}
      ${renderAddSkuForm(plan)}
      ${renderOverridePanel(plan)}
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
        <div class="card-label">Debug: Section &rarr; Bay Mapping</div>
        <table style="width:100%;font-family:var(--font-mono);font-size:11px;margin-top:8px;border-collapse:collapse;">
          <thead><tr style="text-align:left;color:var(--text3);">
            <th style="padding:3px 8px 3px 0;">Type</th><th style="padding:3px 8px;">Key</th>
            <th style="padding:3px 8px;">startFt</th><th style="padding:3px 8px;">linearFeet</th>
            <th style="padding:3px 8px;">endFt</th><th style="padding:3px 8px;">Bay index range</th>
            <th style="padding:3px 8px;">shelfCount</th><th style="padding:3px 8px;">SKUs placed</th>
          </tr></thead>
          <tbody>
            ${plan.sections.map((s) => {
              // Andrew, 2026-07-19: startFt/endFt now come from the same
              // COMPACTED spans buildBayRowMap used to actually place boxes
              // (real content position, not the nominal Set Layout
              // allocation) -- this table used to show the old fixed
              // boundary while the render below already compacted, which
              // made the two disagree.
              const span = bayCompactedSpans.get(s.key) ?? { startFt: s.startFt, endFt: s.startFt + actualSectionFeet(s) };
              const feet = span.endFt - span.startFt;
              const startBay = Math.floor((span.startFt * 12) / BAY_INCHES);
              const endBay = Math.floor(((span.endFt * 12) - 0.01) / BAY_INCHES);
              const bayCount = targetStore.shelfLayout.bays.length;
              const outOfBounds = endBay > bayCount - 1;
              const skuCount = s.shelves.reduce((sum, sh) => sum + sh.skus.length, 0);
              return `<tr style="${outOfBounds ? 'color:var(--warning,#e0a030);' : ''}">
                <td style="padding:3px 8px 3px 0;">${s.type}</td>
                <td style="padding:3px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.key}">${s.key.slice(0, 40)}${s.key.length > 40 ? '…' : ''}</td>
                <td style="padding:3px 8px;">${span.startFt.toFixed(2)}</td>
                <td style="padding:3px 8px;">${feet.toFixed(2)}</td>
                <td style="padding:3px 8px;">${span.endFt.toFixed(2)}</td>
                <td style="padding:3px 8px;">${startBay}-${endBay}${outOfBounds ? ' (OUT OF BOUNDS, store has ' + bayCount + ' bays)' : ''}</td>
                <td style="padding:3px 8px;">${s.shelfCount}</td>
                <td style="padding:3px 8px;">${skuCount}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${targetStore.shelfLayout.bays.map((bay, i) => renderBay(bay, i, rowMap)).join('')}
    `;

    bindListeners(output);
  }

  // Shared by the Add SKU search results, empty-slot drops, and box-swap
  // drops -- always routes through the same override mechanism.
  function placeSku(skuId, sectionKey, shelfPosition, facings, columnIndex = null) {
    store.addOverride(selectedStoreId, { skuId, action: 'place', sectionKey, shelfPosition, facings: facings || 1, columnIndex });
  }

  // Andrew, 2026-07-18: a locked/manual placement's width isn't subtracted
  // from the row's normal fill budget (known limitation, documented at the
  // block-layout call site in placementSolver.js) -- so a forced facings
  // count or a swap can genuinely push a shelf row's real content past the
  // physical 4ft bay width without the placement itself being rejected.
  // Warn explicitly rather than let it silently overflow the row.
  function warnIfRowOverflows(plan, targetStore, skuIds) {
    if (!plan || !targetStore) return;
    const { map: rowMap } = buildBayRowMap(plan.sections, targetStore.shelfLayout.bays.length);
    const warned = new Set();
    for (const [bayIndex, rows] of rowMap.entries()) {
      for (const [position, entries] of rows.entries()) {
        if (!entries.some((e) => skuIds.includes(e.sku.skuId))) continue;
        const usedInches = entries.reduce(
          (sum, e) => sum + (e.sku.allocatedInches ?? e.sku.facings * (e.sku.widthInches ?? 3)),
          0
        );
        const overageInches = usedInches - BAY_INCHES;
        const key = `${bayIndex}-${position}`;
        if (overageInches > 0.5 && !warned.has(key)) {
          warned.add(key);
          alert(`Bay ${bayIndex + 1}, Shelf ${position} now exceeds its available space by ${(overageInches / 12).toFixed(1)}ft. It will still render, but consider fewer facings or moving something out.`);
        }
      }
    }
  }

  function commitAndRender(skuIdsToCheck) {
    const plan = regenerateAndSetPlan();
    warnIfRowOverflows(plan, currentStore(), Array.isArray(skuIdsToCheck) ? skuIdsToCheck : [skuIdsToCheck]);
    renderOutput(plan);
  }

  function bindListeners(output) {
    output.querySelectorAll('.planogram-box').forEach((box) => {
      box.addEventListener('click', () => {
        const skuId = box.dataset.skuId;
        openSkuId = openSkuId === skuId ? null : skuId;
        addSectionKey = '';
        addShelfPosition = null;
        addSearchTerm = '';
        renderOutput(store.getSnapshot().currentPlan);
      });

      // Andrew, 2026-07-18: +/- facing buttons. Plus adds one facing;
      // minus removes one, or removes the SKU from the set entirely once
      // facings would drop below 1. stopPropagation so these don't also
      // trigger the box's own click-to-open-edit-panel handler.
      const currentFacings = parseInt(box.dataset.facings, 10) || 1;
      const sectionKey = realSectionKeyFor(box.dataset.sectionKey, store.getSnapshot().skus.find((s) => s.skuId === box.dataset.skuId));
      const shelfPosition = parseInt(box.dataset.shelfPosition, 10);

      // Andrew, 2026-07-20: pass the box's own columnIndex through --
      // placeSku's override defaults columnIndex to null when omitted, and
      // insertLockedIntoRow (placementSolver.js) treats a null columnIndex
      // as "insert at the end of the row," which is why a facing change
      // was jumping the SKU (and its new facing) to the far right instead
      // of staying put.
      const columnIndex = parseInt(box.dataset.columnIndex, 10);
      const currentColumnIndex = Number.isNaN(columnIndex) ? null : columnIndex;

      box.querySelector('.planogram-facing-plus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        placeSku(box.dataset.skuId, sectionKey, shelfPosition, currentFacings + 1, currentColumnIndex);
        commitAndRender(box.dataset.skuId);
      });

      box.querySelector('.planogram-facing-minus')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentFacings <= 1) {
          store.addOverride(selectedStoreId, { skuId: box.dataset.skuId, action: 'remove' });
        } else {
          placeSku(box.dataset.skuId, sectionKey, shelfPosition, currentFacings - 1, currentColumnIndex);
        }
        if (openSkuId === box.dataset.skuId) openSkuId = null;
        renderOutput(regenerateAndSetPlan());
      });

      // Andrew, 2026-07-18: drag a box onto another box to SWAP their
      // positions (each keeps its own facings count); drag it onto an
      // empty slot to relocate it there instead (handled below).
      box.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          skuId: box.dataset.skuId,
          facings: parseInt(box.dataset.facings, 10) || 1,
          sectionKey: box.dataset.sectionKey,
          shelfPosition: parseInt(box.dataset.shelfPosition, 10),
          columnIndex: parseInt(box.dataset.columnIndex, 10),
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

        const { skus } = store.getSnapshot();
        const draggedSku = skus.find((s) => s.skuId === dragged.skuId);
        const targetSku = skus.find((s) => s.skuId === targetSkuId);
        if (!draggedSku || !targetSku) return;

        const targetSectionKey = realSectionKeyFor(box.dataset.sectionKey, targetSku);
        const targetShelfPosition = parseInt(box.dataset.shelfPosition, 10);
        const targetColumnIndex = parseInt(box.dataset.columnIndex, 10);
        const targetFacings = parseInt(box.dataset.facings, 10) || 1;
        const originSectionKey = realSectionKeyFor(dragged.sectionKey, draggedSku);
        const originShelfPosition = dragged.shelfPosition;
        const originColumnIndex = dragged.columnIndex;

        // The swap: dragged takes target's exact row+column, target takes
        // dragged's -- this is what actually reorders two SKUs already on
        // the same row, not just assigning them both "this row" and hoping.
        placeSku(dragged.skuId, targetSectionKey, targetShelfPosition, dragged.facings, targetColumnIndex);
        placeSku(targetSkuId, originSectionKey, originShelfPosition, targetFacings, originColumnIndex);
        openSkuId = null;
        commitAndRender([dragged.skuId, targetSkuId]);
      });
    });

    output.querySelectorAll('.planogram-empty-slot').forEach((slot) => {
      slot.addEventListener('click', () => {
        openSkuId = null;
        addSectionKey = slot.dataset.sectionKey || '';
        addShelfPosition = slot.dataset.shelfPosition ? parseInt(slot.dataset.shelfPosition, 10) : null;
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
        const sectionKey = slot.dataset.sectionKey;
        const shelfPosition = slot.dataset.shelfPosition ? parseInt(slot.dataset.shelfPosition, 10) : null;
        const columnIndex = slot.dataset.columnIndex ? parseInt(slot.dataset.columnIndex, 10) : null;
        if (!dragged?.skuId || !sectionKey || !shelfPosition) return;
        placeSku(dragged.skuId, sectionKey, shelfPosition, dragged.facings, columnIndex);
        commitAndRender(dragged.skuId);
      });
    });

    output.querySelector('.override-cancel-btn')?.addEventListener('click', () => {
      openSkuId = null;
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelector('.override-save-btn')?.addEventListener('click', () => {
      const sectionKey = output.querySelector('.override-section').value;
      const shelfPosition = parseInt(output.querySelector('.override-shelf').value, 10);
      const facings = parseInt(output.querySelector('.override-facings').value, 10);
      placeSku(openSkuId, sectionKey, shelfPosition, facings);
      const placedSkuId = openSkuId;
      openSkuId = null;
      commitAndRender(placedSkuId);
    });

    output.querySelector('.override-remove-btn')?.addEventListener('click', () => {
      store.addOverride(selectedStoreId, { skuId: openSkuId, action: 'remove' });
      openSkuId = null;
      renderOutput(regenerateAndSetPlan());
    });

    output.querySelector('.override-reset-btn')?.addEventListener('click', () => {
      const existing = store.getOverrides(selectedStoreId).find((o) => o.skuId === openSkuId);
      if (existing) store.removeOverride(selectedStoreId, existing.id);
      openSkuId = null;
      renderOutput(regenerateAndSetPlan());
    });

    output.querySelectorAll('.reset-override-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        store.removeOverride(selectedStoreId, btn.dataset.overrideId);
        renderOutput(regenerateAndSetPlan());
      });
    });

    output.querySelector('.reset-all-overrides-btn')?.addEventListener('click', () => {
      if (!confirm('Reset all manual overrides for this store back to the AI recommendation?')) return;
      store.clearOverrides(selectedStoreId);
      renderOutput(regenerateAndSetPlan());
    });

    output.querySelector('.add-sku-section')?.addEventListener('change', (e) => {
      addSectionKey = e.target.value;
      addShelfPosition = null; // shelf options change with the section -- let it default to the first
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
      const sectionKey = output.querySelector('.add-sku-section').value;
      const shelfPosition = parseInt(output.querySelector('.add-sku-shelf').value, 10);
      const facings = parseInt(output.querySelector('.add-sku-facings').value, 10);
      placeSku(skuId, sectionKey, shelfPosition, facings);
      addSearchTerm = '';
      addSectionKey = '';
      addShelfPosition = null;
      commitAndRender(skuId);
    }

    output.querySelectorAll('.add-sku-result').forEach((row) => {
      row.addEventListener('click', () => addSkuFromForm(row.dataset.skuId));
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
