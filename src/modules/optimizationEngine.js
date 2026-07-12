import { store } from '../core/store.js';
import { generatePlan } from '../optimize/placementSolver.js';
import { isSmallFormatSection } from '../optimize/blocking.js';

const STANDARD_SHELF_OPTIONS = [4, 5];
const SMALL_FORMAT_SHELF_OPTIONS = [4, 5, 6, 7, 8];

export function mount(el) {
  let selectedStoreId = null;

  function regenerateAndSetPlan() {
    const { stores, skus, metricsConfig, bottleDimensions } = store.getSnapshot();
    const targetStore = stores.find((s) => s.storeId === selectedStoreId);
    const targetCount = store.getTargetSkuCount(selectedStoreId);
    const multipliers = store.getSectionMultipliers(selectedStoreId);
    const shelfCounts = store.getSectionShelfCounts(selectedStoreId);
    const plan = generatePlan(targetStore, skus, metricsConfig, targetCount, bottleDimensions, multipliers, shelfCounts);
    store.setPlan(plan);
    return plan;
  }

  function renderSectionCard(section) {
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
          <span class="card-label">${section.label} <span class="badge" style="margin-left:6px;">${section.type}</span></span>
          <span class="section-summary" style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${section.linearFeet.toFixed(1)} ft &middot; ${section.shelfCount} shelves &middot; ${(section.scoreShare * 100).toFixed(1)}% of set</span>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:11px;color:var(--text2);white-space:nowrap;">Section size</span>
          <input type="range" class="section-mult-slider" min="0.5" max="2" step="0.1" value="${section.multiplier}" style="flex:1;" />
          <span class="section-mult-value" style="font-family:var(--font-mono);font-size:12px;width:34px;">${section.multiplier.toFixed(1)}x</span>
        </div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:11px;color:var(--text2);white-space:nowrap;">Shelves per block${isSmallFormatSection(section) ? ' (small format, extended range)' : ''}</span>
          <div class="tabs shelf-count-tabs">
            ${(isSmallFormatSection(section) ? SMALL_FORMAT_SHELF_OPTIONS : STANDARD_SHELF_OPTIONS)
              .map((n) => `<div class="tab shelf-count-tab ${section.shelfCount === n ? 'active' : ''}" data-shelf-count="${n}">${n}</div>`)
              .join('')}
          </div>
        </div>
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

  function renderPlan(plan) {
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
      </div>
      ${plan.sections.map(renderSectionCard).join('')}
    `;
  }

  function bindPlanOutputListeners(output) {
    output.querySelectorAll('.section-mult-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const valueLabel = e.target.closest('[data-section-key]').querySelector('.section-mult-value');
        valueLabel.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
      });
      slider.addEventListener('change', (e) => {
        const sectionKey = e.target.closest('[data-section-key]').dataset.sectionKey;
        store.setSectionMultiplier(selectedStoreId, sectionKey, parseFloat(e.target.value));
        const plan = regenerateAndSetPlan();
        output.innerHTML = renderPlan(plan);
        bindPlanOutputListeners(output);
      });
    });

    output.querySelectorAll('.shelf-count-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        const sectionKey = e.target.closest('[data-section-key]').dataset.sectionKey;
        const shelfCount = parseInt(e.target.dataset.shelfCount, 10);
        store.setSectionShelfCount(selectedStoreId, sectionKey, shelfCount);
        const plan = regenerateAndSetPlan();
        output.innerHTML = renderPlan(plan);
        bindPlanOutputListeners(output);
      });
    });
  }

  function render() {
    const { stores, currentPlan } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = stores[0]?.storeId;

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
          <div class="card-label" style="margin-bottom:6px;">Target SKU Count</div>
          <span style="font-family:var(--font-mono);">${store.getTargetSkuCount(selectedStoreId)} <span style="color:var(--text3);">(set in Store Builder)</span></span>
        </div>
        <button class="btn btn-primary generate-btn" style="margin-left:auto;">Generate Plan</button>
      </div>
      <div class="plan-output"></div>
    `;

    const output = el.querySelector('.plan-output');
    if (currentPlan && currentPlan.storeId === selectedStoreId) {
      output.innerHTML = renderPlan(currentPlan);
      bindPlanOutputListeners(output);
    }

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      render();
    });

    el.querySelector('.generate-btn').addEventListener('click', () => {
      const plan = regenerateAndSetPlan();
      output.innerHTML = renderPlan(plan);
      bindPlanOutputListeners(output);
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
