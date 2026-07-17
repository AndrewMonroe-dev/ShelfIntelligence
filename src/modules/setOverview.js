import { store } from '../core/store.js';
import { generatePlan } from '../optimize/placementSolver.js';

// Flat, one-row-per-SKU-placement view of the WHOLE generated set --
// every section/shelf in physical set order, on one page, instead of
// paging through bay-by-bay visual blocks. Andrew's rule 2026-07-15: "I
// want a page to view the entire set by SKU in one shot."
export function mount(el) {
  let selectedStoreId = null;
  let searchTerm = '';

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

  // One row per SKU placement, in physical set order (section order, then
  // shelf position top to bottom, then left-to-right as placed) -- not one
  // row per facing, this is a data review list, not the visual planogram.
  function buildRows(plan) {
    const rows = [];
    plan.sections.forEach((section) => {
      section.shelves.forEach((shelf) => {
        shelf.skus.forEach((sku) => {
          rows.push({ section, shelf, sku });
        });
      });
    });
    return rows;
  }

  function render() {
    const { stores, currentPlan } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = store.getActiveStoreId() || currentPlan?.storeId || stores[0]?.storeId;

    let plan = currentPlan && currentPlan.storeId === selectedStoreId ? currentPlan : null;
    if (!plan) plan = regenerateAndSetPlan();

    el.innerHTML = `
      <div class="page-header">
        <h1>Set Overview</h1>
        <p>The whole generated set, one row per SKU placement, in physical set order -- for reviewing the full assortment without paging through bays.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:16px;margin-bottom:14px;flex-wrap:wrap;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1;min-width:220px;">
          <div class="card-label" style="margin-bottom:6px;">Search (brand, varietal, section)</div>
          <input type="text" class="set-overview-search" value="${searchTerm}" placeholder="e.g. Bota, Nighthawk, Cabernet..." style="width:100%;" />
        </div>
      </div>
      <div class="viewer-output"></div>
    `;

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      store.setActiveStoreId(selectedStoreId);
      render();
    });
    el.querySelector('.set-overview-search').addEventListener('input', (e) => {
      searchTerm = e.target.value;
      renderOutput(store.getSnapshot().currentPlan);
    });

    renderOutput(plan);
  }

  function renderOutput(plan) {
    const output = el.querySelector('.viewer-output');
    if (!plan) {
      output.innerHTML = '<div class="card empty-state">No plan could be generated for this store.</div>';
      return;
    }

    let rows = buildRows(plan);
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      rows = rows.filter((r) =>
        `${r.sku.brand} ${r.sku.varietal || ''} ${r.section.label}`.toLowerCase().includes(term)
      );
    }

    const totalFacings = rows.reduce((sum, r) => sum + (r.sku.facings || 0), 0);

    const bodyRows = rows.map((r) => `
      <tr>
        <td style="color:var(--text2);">${r.section.label}</td>
        <td style="font-family:var(--font-mono);color:var(--text2);">${r.shelf.position} &middot; ${r.shelf.zone}</td>
        <td>${r.sku.brand}${r.sku.isLocked ? ' &#128274;' : ''}</td>
        <td style="color:var(--text2);">${r.sku.varietal || r.sku.bottleSizeRaw || '--'}</td>
        <td>${r.sku.priceUsd != null ? '$' + r.sku.priceUsd.toFixed(2) : '--'}</td>
        <td style="font-family:var(--font-mono);">${r.sku.facings}</td>
        <td style="font-family:var(--font-mono);color:var(--blue);">${r.sku.score.toFixed(1)}</td>
        <td style="font-family:var(--font-mono);color:var(--text3);">${r.sku.skuId}</td>
      </tr>
    `).join('');

    output.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-label">Distinct SKUs Shown</div>
          <div class="kpi-value">${rows.length}</div>
        </div>
        <div class="card">
          <div class="card-label">Total Facings</div>
          <div class="kpi-value">${totalFacings}</div>
        </div>
        <div class="card">
          <div class="card-label">Sections</div>
          <div class="kpi-value">${plan.sections.length}</div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto;max-height:640px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);">
              <th style="padding:12px 16px;">Section</th>
              <th style="padding:12px 16px;">Shelf</th>
              <th style="padding:12px 16px;">Brand</th>
              <th style="padding:12px 16px;">Varietal / Size</th>
              <th style="padding:12px 16px;">Price</th>
              <th style="padding:12px 16px;">Facings</th>
              <th style="padding:12px 16px;">Score</th>
              <th style="padding:12px 16px;">SKU ID</th>
            </tr>
          </thead>
          <tbody>${bodyRows || '<tr><td colspan="8" class="empty-state" style="padding:16px;">No SKUs match.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  render();
  return () => { el.innerHTML = ''; };
}
