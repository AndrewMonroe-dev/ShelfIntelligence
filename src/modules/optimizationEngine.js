import { store } from '../core/store.js';
import { generatePlan, THIN_SECTION_WIDTH_FT } from '../optimize/placementSolver.js';
import { getPhysicalWidthFt } from '../optimize/shelfPosition.js';

export function mount(el) {
  let selectedStoreId = null;

  function regenerateAndSetPlan() {
    const { stores, skus, metricsConfig, bottleDimensions, sizePackage } = store.getSnapshot();
    const targetStore = stores.find((s) => s.storeId === selectedStoreId);
    const targetCount = store.getTargetSkuCount(selectedStoreId);
    const multipliers = store.getSectionMultipliers(selectedStoreId);
    let allocations = store.getSectionAllocations(selectedStoreId);
    if (!allocations.length) allocations = store.autoAllocateSections(selectedStoreId);
    const caseOnlyMode = store.getCaseOnlyMode();
    const overrides = store.getOverrides(selectedStoreId);
    const plan = generatePlan(targetStore, skus, metricsConfig, targetCount, bottleDimensions, allocations, multipliers, sizePackage, caseOnlyMode, overrides);
    store.setPlan(plan);
    return plan;
  }

  // Resizing one section's width via the slider shrinks/grows every other
  // section proportionally so the total stays fixed at the fixture's
  // physical width -- mirrors the old score-multiplier "others compensate"
  // behavior, now operating on the persisted allocation directly.
  function adjustSectionWidth(storeId, sectionKey, newWidthFt, physicalWidthFt) {
    const allocations = store.getSectionAllocations(storeId);
    const target = allocations.find((a) => a.key === sectionKey);
    if (!target) return;
    const others = allocations.filter((a) => a.key !== sectionKey);
    const othersTotal = others.reduce((sum, a) => sum + a.widthFt, 0) || 1;
    const minOthersTotal = others.length; // 1ft floor per other section
    const clampedNew = Math.max(1, Math.min(newWidthFt, physicalWidthFt - minOthersTotal));
    const remainingForOthers = Math.max(minOthersTotal, physicalWidthFt - clampedNew);
    const scale = remainingForOthers / othersTotal;

    const updated = allocations
      .map((a) => (a.key === sectionKey ? { ...a, widthFt: clampedNew } : { ...a, widthFt: Math.max(1, a.widthFt * scale) }))
      .sort((a, b) => a.order - b.order);

    let cursor = 0;
    updated.forEach((a) => { a.startFt = cursor; cursor += a.widthFt; });

    store.setSectionAllocations(storeId, updated);
  }

  function renderSectionCard(section, physicalWidthFt) {
    const shelvesHtml = section.shelves.map((shelf) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:6px;">
          <span>Shelf ${shelf.position} &middot; ${shelf.zone} (index ${shelf.verticalIndex}) &middot; ${shelf.traffic} traffic</span>
          <span style="font-family:var(--font-mono);">shelfScore ${shelf.shelfScore.toFixed(2)}</span>
        </div>
        ${shelf.skus.map((s) => `
          <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0;">
            <span>${s.brand}${s.varietal ? ' &middot; ' + s.varietal : ''}</span>
            <span style="color:var(--text2);font-family:var(--font-mono);">score ${s.score.toFixed(1)} &middot; ${s.facings}f</span>
          </div>
        `).join('') || '<div class="empty-state" style="padding:8px 0;">No SKUs on this shelf</div>'}
      </div>
    `).join('');

    return `
      <div class="card" data-section-key="${section.key}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
          <span class="card-label">${section.label} <span class="badge" style="margin-left:6px;">${section.type}</span>${section.usesMarketShareSizing ? ' <span class="badge badge-success">real market share</span>' : ''}${section.usesPriceBandRules ? ' <span class="badge badge-success">price-band rules</span>' : ''}</span>
          <span class="section-summary" style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${section.linearFeet.toFixed(1)} ft &middot; ${section.shelfCount} shelves &middot; ${section.shelves.reduce((sum, sh) => sum + sh.skus.length, 0)} SKUs</span>
        </div>
        ${section.type === 'merged'
          ? `<div style="margin-top:10px;font-size:11.5px;color:var(--text2);">Combined section (each category here is ≤${THIN_SECTION_WIDTH_FT}ft) -- resize the individual categories in Set Layout.</div>`
          : `<div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
              <span style="font-size:11px;color:var(--text2);white-space:nowrap;">Section size</span>
              <input type="range" class="section-width-slider" min="1" max="${physicalWidthFt}" step="0.5" value="${section.linearFeet}" style="flex:1;" />
              <span class="section-width-value" style="font-family:var(--font-mono);font-size:12px;width:44px;">${section.linearFeet.toFixed(1)}ft</span>
            </div>`}
        <div style="margin-top:12px;">${shelvesHtml}</div>
      </div>
    `;
  }

  function actualSectionFeet(section) {
    const maxRowInches = Math.max(
      ...section.shelves.map((sh) => sh.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0)),
      0
    );
    return Math.max(section.linearFeet, maxRowInches / 12);
  }

  function renderPlan(plan, physicalWidthFt) {
    const totalWidth = plan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);
    return `
      <div class="page-header" style="margin-top:20px;">
        <h1 style="font-size:16px;">Plan: ${plan.skuCount} SKUs across ${plan.sections.length} sections</h1>
        <p>Generated ${new Date(plan.generatedAt).toLocaleString()}. Drag a section's size slider to expand or contract it -- other sections shrink or grow proportionally to keep the store's total space fixed, then release to recompute.</p>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Total Horizontal Set Width</span>
          <span class="kpi-value" style="font-size:22px;margin-top:0;">${totalWidth.toFixed(1)} ft</span>
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
          ${plan.sections.map((s) => `<span class="badge" style="font-family:var(--font-mono);">${s.label}: ${actualSectionFeet(s).toFixed(1)}ft</span>`).join('')}
        </div>
        ${plan.isOverflowing ? `<div class="badge badge-warning" style="margin-top:10px;">Allocated sections exceed the fixture by ${plan.overflowFt.toFixed(1)}ft -- reduce section widths or add bays</div>` : ''}
      </div>
      ${plan.sections.map((s) => renderSectionCard(s, physicalWidthFt)).join('')}
    `;
  }

  function bindPlanOutputListeners(output, physicalWidthFt) {
    output.querySelectorAll('.section-width-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const valueLabel = e.target.closest('[data-section-key]').querySelector('.section-width-value');
        valueLabel.textContent = parseFloat(e.target.value).toFixed(1) + 'ft';
      });
      slider.addEventListener('change', (e) => {
        const sectionKey = e.target.closest('[data-section-key]').dataset.sectionKey;
        adjustSectionWidth(selectedStoreId, sectionKey, parseFloat(e.target.value), physicalWidthFt);
        const plan = regenerateAndSetPlan();
        output.innerHTML = renderPlan(plan, physicalWidthFt);
        bindPlanOutputListeners(output, physicalWidthFt);
      });
    });
  }

  function render() {
    const { stores, currentPlan } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = store.getActiveStoreId() || stores[0]?.storeId;
    const selectedStore = stores.find((s) => s.storeId === selectedStoreId);
    const physicalWidthFt = selectedStore ? getPhysicalWidthFt(selectedStore.shelfLayout) : 0;

    el.innerHTML = `
      <div class="page-header">
        <h1>Optimization Engine</h1>
        <p>Generate a full section/shelf/facings placement using the live Calculation Engine score and the documented world-set, shelf-position, and priority-brand rules.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="card-label" style="margin-bottom:6px;">SKU Count Seed Target</div>
          <span style="font-family:var(--font-mono);">${store.getTargetSkuCount(selectedStoreId)} <span style="color:var(--text3);">(set in Store Builder -- actual count is space-driven per section, see generated plan)</span></span>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;">
          <input type="checkbox" class="case-only-toggle" ${store.getCaseOnlyMode() ? 'checked' : ''} />
          Case Only Mode <span style="color:var(--text3);">(750ml facing floor: 2 instead of 1)</span>
        </label>
        <button class="btn btn-primary generate-btn" style="margin-left:auto;">Generate Plan</button>
      </div>
      <div class="plan-output"></div>
    `;

    const output = el.querySelector('.plan-output');
    if (currentPlan && currentPlan.storeId === selectedStoreId) {
      output.innerHTML = renderPlan(currentPlan, physicalWidthFt);
      bindPlanOutputListeners(output, physicalWidthFt);
    }

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      store.setActiveStoreId(selectedStoreId);
      render();
    });

    el.querySelector('.case-only-toggle').addEventListener('change', (e) => {
      store.setCaseOnlyMode(e.target.checked);
    });

    el.querySelector('.generate-btn').addEventListener('click', () => {
      const plan = regenerateAndSetPlan();
      output.innerHTML = renderPlan(plan, physicalWidthFt);
      bindPlanOutputListeners(output, physicalWidthFt);
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
