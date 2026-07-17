import { store } from '../core/store.js';
import { generatePlan } from '../optimize/placementSolver.js';
import { getPhysicalWidthFt, BAY_WIDTH_FT } from '../optimize/shelfPosition.js';

const PX_PER_INCH = 16; // bumped up 2026-07-15 so the planogram reads as the actual set, not a compressed summary
const BAY_INCHES = BAY_WIDTH_FT * 12; // 48in -- a real physical bay, the fixed visual module width
const MIN_BOX_PX = 16; // just enough to avoid a zero-width render glitch, not a proportionality-distorting floor

function rowInches(shelf) {
  return shelf.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0);
}

// Maps every section's shelf content onto the store's REAL physical bays --
// section boundaries are independent of bay boundaries (Set Layout design),
// so a section's content can be cut mid-bay, and a single bay can contain
// pieces of more than one category. Walks each section's shelf rows tracking
// an ABSOLUTE inch position (section.startFt*12 + running position within
// the section), bucketing each box into the real bay its absolute position
// falls in. Returns Map<bayIndex, Map<shelfPosition, [{sku, sectionKey, sectionLabel}]>>.
function buildBayRowMap(sections, bayCount) {
  const map = new Map();
  sections.forEach((section) => {
    const sectionStartInches = section.startFt * 12;
    section.shelves.forEach((shelf) => {
      let cumulative = 0;
      shelf.skus.forEach((sku) => {
        const w = sku.allocatedInches ?? sku.facings * (sku.widthInches ?? 3);
        const absoluteStart = sectionStartInches + cumulative;
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
        rowMap.get(shelf.position).push({ sku, sectionKey: section.key, sectionLabel: section.label, shelfDef: shelf });
        cumulative += w;
      });
    });
  });
  return map;
}

// One box PER FACING (2026-07-15): a SKU with 3 facings renders as 3
// side-by-side boxes instead of 1 box with a "3f" label -- fills the
// section the way it actually looks on the real shelf, and reads as
// immediately obvious rather than requiring you to parse a facings count.
function renderSkuBox(entry) {
  const { sku, sectionKey, shelfDef } = entry;
  const singleWidthIn = sku.widthInches ?? ((sku.allocatedInches ?? sku.widthInches ?? 3) / Math.max(1, sku.facings));
  const widthPx = Math.max(MIN_BOX_PX, singleWidthIn * PX_PER_INCH);
  const label = `${sku.brand}${sku.varietal ? ' – ' + sku.varietal : (sku.bottleSizeRaw ? ' – ' + sku.bottleSizeRaw : '')}`;
  const facingCount = Math.max(1, sku.facings || 1);
  // Name reads vertically, bottom-to-top (like a real shelf spine label) so
  // it stays readable at facing-width instead of truncating to "BOTA ..."
  // in a box only 1-2in wide. Andrew's rule 2026-07-15.
  const box = `
    <div class="planogram-box${sku.isLocked ? ' locked' : ''}" style="width:${widthPx}px;" title="${label} (score ${sku.score.toFixed(1)}, ${sku.facings} facings, ${singleWidthIn.toFixed(1)}in each)" data-sku-id="${sku.skuId}" data-section-key="${sectionKey}" data-shelf-position="${shelfDef.position}">
      ${sku.isLocked ? '<div class="planogram-lock-badge" title="Manually placed, locked">&#128274;</div>' : ''}
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
function renderBayRow(rowEntries, position, bay) {
  const shelfDef = rowEntries[0]?.shelfDef;
  const groups = [];
  rowEntries.forEach((entry) => {
    const last = groups[groups.length - 1];
    if (last && last.sectionKey === entry.sectionKey) last.entries.push(entry);
    else groups.push({ sectionKey: entry.sectionKey, sectionLabel: entry.sectionLabel, entries: [entry] });
  });

  return `
    <div class="planogram-shelf-row">
      <div class="planogram-shelf-label">Shelf ${position}${shelfDef ? ` &middot; ${shelfDef.zone} &middot; ${shelfDef.traffic} traffic` : ''}</div>
      <div class="planogram-shelf-frame" style="width:${BAY_INCHES * PX_PER_INCH}px;">
        ${groups.map((g) => `
          ${groups.length > 1 ? `<div class="planogram-section-divider" title="${g.sectionLabel}">${shortenDividerLabel(g.sectionLabel)}</div>` : ''}
          ${g.entries.map(renderSkuBox).join('')}
        `).join('') || '<div class="empty-state" style="padding:8px;font-size:10px;">Empty</div>'}
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
  let addSearchTerm = '';

  function currentStore() {
    return store.getSnapshot().stores.find((s) => s.storeId === selectedStoreId);
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
    // Merged sections (adjacent thin categories sharing one shelf stack)
    // aren't a real sectionAllocations entry to target -- exclude them as
    // an override destination.
    const sections = currentPlan.sections.filter((s) => s.type !== 'merged');
    const chosenSection = sections.find((s) => s.key === addSectionKey) || sections[0];
    const shelfOptions = chosenSection ? chosenSection.shelves.map((sh) => sh.position) : [];
    const matches = addSearchTerm.trim().length >= 2
      ? skus.filter((s) => `${s.brand} ${s.varietal || ''} ${s.skuId}`.toLowerCase().includes(addSearchTerm.toLowerCase())).slice(0, 8)
      : [];

    return `
      <div class="card" style="margin-bottom:14px;">
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
              ${shelfOptions.map((p) => `<option value="${p}">${p}</option>`).join('')}
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
    const sections = currentPlan.sections.filter((s) => s.type !== 'merged');
    const currentSectionKey = existing?.sectionKey
      || sections.find((s) => s.shelves.some((sh) => sh.skus.some((k) => k.skuId === openSkuId)))?.key
      || sections[0]?.key;
    const chosenSection = sections.find((s) => s.key === currentSectionKey) || sections[0];
    const shelfOptions = chosenSection ? chosenSection.shelves.map((sh) => sh.position) : [];
    const currentFacings = existing?.facings
      || sections.flatMap((s) => s.shelves.flatMap((sh) => sh.skus)).find((k) => k.skuId === openSkuId)?.facings
      || 1;

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
              ${shelfOptions.map((p) => `<option value="${p}">${p}</option>`).join('')}
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

    const actualSectionFeet = (s) => Math.max(s.linearFeet, Math.max(...s.shelves.map(rowInches), 0) / 12);
    const totalWidth = plan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);
    const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
    const rowMap = buildBayRowMap(plan.sections, targetStore.shelfLayout.bays.length);

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
              const feet = actualSectionFeet(s);
              const endFt = s.startFt + feet;
              const startBay = Math.floor((s.startFt * 12) / BAY_INCHES);
              const endBay = Math.floor(((endFt * 12) - 0.01) / BAY_INCHES);
              const bayCount = targetStore.shelfLayout.bays.length;
              const outOfBounds = endBay > bayCount - 1;
              const skuCount = s.shelves.reduce((sum, sh) => sum + sh.skus.length, 0);
              return `<tr style="${outOfBounds ? 'color:var(--warning,#e0a030);' : ''}">
                <td style="padding:3px 8px 3px 0;">${s.type}</td>
                <td style="padding:3px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.key}">${s.key.slice(0, 40)}${s.key.length > 40 ? '…' : ''}</td>
                <td style="padding:3px 8px;">${s.startFt.toFixed(2)}</td>
                <td style="padding:3px 8px;">${feet.toFixed(2)}</td>
                <td style="padding:3px 8px;">${endFt.toFixed(2)}</td>
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

  function bindListeners(output) {
    output.querySelectorAll('.planogram-box').forEach((box) => {
      box.addEventListener('click', () => {
        const skuId = box.dataset.skuId;
        openSkuId = openSkuId === skuId ? null : skuId;
        addSectionKey = '';
        addSearchTerm = '';
        renderOutput(store.getSnapshot().currentPlan);
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
      store.addOverride(selectedStoreId, { skuId: openSkuId, action: 'place', sectionKey, shelfPosition, facings });
      openSkuId = null;
      renderOutput(regenerateAndSetPlan());
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
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelector('.add-sku-search')?.addEventListener('input', (e) => {
      addSearchTerm = e.target.value;
      renderOutput(store.getSnapshot().currentPlan);
    });

    output.querySelectorAll('.add-sku-result').forEach((row) => {
      row.addEventListener('click', () => {
        const sectionKey = output.querySelector('.add-sku-section').value;
        const shelfPosition = parseInt(output.querySelector('.add-sku-shelf').value, 10);
        const facings = parseInt(output.querySelector('.add-sku-facings').value, 10);
        store.addOverride(selectedStoreId, { skuId: row.dataset.skuId, action: 'place', sectionKey, shelfPosition, facings });
        addSearchTerm = '';
        addSectionKey = '';
        renderOutput(regenerateAndSetPlan());
      });
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
