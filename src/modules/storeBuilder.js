import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { generatePlan } from '../optimize/placementSolver.js';
import { getPhysicalWidthFt, getLinearShelfFeet } from '../optimize/shelfPosition.js';

function actualSectionFeet(section) {
  const maxRowInches = Math.max(
    ...section.shelves.map((sh) => sh.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0)),
    0
  );
  return Math.max(section.linearFeet, maxRowInches / 12);
}

function computePlanMetrics(plan, physicalWidth) {
  const totalWidth = plan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);
  const avgShelfCount = plan.sections.length
    ? plan.sections.reduce((sum, s) => sum + s.shelfCount, 0) / plan.sections.length
    : 0;
  const totalFacings = plan.sections.reduce(
    (sum, s) => sum + s.shelves.reduce((sh, shelf) => sh + shelf.skus.reduce((sk, k) => sk + k.facings, 0), 0),
    0
  );
  return {
    totalWidth,
    avgShelfCount,
    totalFacings,
    sectionCount: plan.sections.length,
    overflowFt: totalWidth - physicalWidth,
  };
}

function dropWarningHtml(plan) {
  if (!plan.isOverflowing) return '';
  return `<div class="badge badge-warning" style="margin-top:6px;">Allocated sections exceed the fixture by ${plan.overflowFt.toFixed(1)}ft -- reduce section widths or add bays</div>`;
}

function qualityLabel(q) {
  if (q == null) return 'Neutral';
  if (q >= 0.6) return 'High-End';
  if (q >= 0.2) return 'Above Average';
  if (q > -0.2) return 'Neutral';
  if (q > -0.6) return 'Value-Focused';
  return 'Budget';
}

export function mount(el) {
  let showAddForm = false;

  function generateStorePlan(s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode) {
    const targetCount = store.getTargetSkuCount(s.storeId);
    const multipliers = store.getSectionMultipliers(s.storeId);
    let allocations = store.getSectionAllocations(s.storeId);
    if (!allocations.length) allocations = store.autoAllocateSections(s.storeId);
    const overrides = store.getOverrides(s.storeId);
    return generatePlan(s, skus, metricsConfig, targetCount, bottleDimensions, allocations, multipliers, sizePackage, caseOnlyMode, overrides);
  }

  function renderStoreCard(s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode) {
    const targetCount = store.getTargetSkuCount(s.storeId);
    const plan = generateStorePlan(s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode);
    const metrics = computePlanMetrics(plan, getPhysicalWidthFt(s.shelfLayout));

    return `
      <div class="card" data-store-id="${s.storeId}">
        <div class="card-label" style="display:flex;justify-content:space-between;align-items:baseline;">
          <span>${s.name}${s.isCustom ? ' <span class="badge badge-success">custom</span>' : ''}</span>
          ${s.isCustom ? '<button class="btn delete-store-btn" style="font-size:11px;padding:2px 8px;color:var(--danger);">Delete</button>' : ''}
        </div>
        <div style="margin-top:8px;font-size:13px;color:var(--text2);">${s.storeType} &middot; ${s.region}${s.qualityScore != null ? ' &middot; ' + qualityLabel(s.qualityScore) + ' quality' : ''}</div>
        <div style="margin-top:6px;font-size:13px;">${s.shelfLayout.bays.length} bays &middot; ${getLinearShelfFeet(s.shelfLayout)} linear shelf feet (physical fixture)</div>

        <div style="margin-top:18px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
            <span class="card-label">SKU Count (seed target)</span>
            <span class="kpi-value sku-count-value" style="font-size:20px;margin-top:0;">${targetCount}</span>
          </div>
          <input type="range" class="sku-count-slider" min="10" max="${skus.length}" step="10" value="${targetCount}" style="width:100%;" />
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-top:2px;">
            <span>10</span>
            <span>${skus.length}</span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px;">Only seeds initial section sizes -- each section now fills its own space, so the actual SKU count (<span class="actual-sku-count">${plan.skuCount}</span>) may differ.</div>
        </div>

        <div class="grid grid-2" style="margin-top:14px;">
          <div>
            <div class="card-label" style="font-size:10px;">Total Horizontal Set Length</div>
            <div class="set-total-width" style="font-size:16px;font-weight:600;margin-top:4px;font-family:var(--font-mono);">${metrics.totalWidth.toFixed(1)} ft</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Avg Shelves / Section</div>
            <div class="set-avg-shelves" style="font-size:16px;font-weight:600;margin-top:4px;font-family:var(--font-mono);">${metrics.avgShelfCount.toFixed(1)}</div>
          </div>
        </div>

        <div class="grid grid-3" style="margin-top:12px;">
          <div>
            <div class="card-label" style="font-size:10px;">Sections</div>
            <div class="set-section-count" style="font-size:13px;font-weight:600;margin-top:4px;">${metrics.sectionCount}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Total Facings</div>
            <div class="set-total-facings" style="font-size:13px;font-weight:600;margin-top:4px;">${metrics.totalFacings}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Bottles / Foot</div>
            <div class="set-density" style="font-size:13px;font-weight:600;margin-top:4px;">${(metrics.totalFacings / metrics.totalWidth).toFixed(1)}</div>
          </div>
        </div>

        <div class="grid grid-3" style="margin-top:12px;">
          <div>
            <div class="card-label" style="font-size:10px;">Base / Extended</div>
            <div class="assortment-tiers" style="font-size:13px;font-weight:600;margin-top:4px;">${plan.baseCount} / ${plan.extendedCount}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Brands</div>
            <div class="assortment-brands" style="font-size:13px;font-weight:600;margin-top:4px;">${plan.brandCount}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Varietals</div>
            <div class="assortment-varietals" style="font-size:13px;font-weight:600;margin-top:4px;">${plan.varietalCount}</div>
          </div>
        </div>

        <div class="fit-warning">${metrics.overflowFt > 0.05
          ? `<div class="badge badge-warning" style="margin-top:10px;">Set needs ${metrics.overflowFt.toFixed(1)}ft more than the store's physical fixture -- reduce SKU count or expand the store's linear feet</div>`
          : ''}</div>
        <div class="extended-warning">${plan.extendedCount > 0
          ? '<div class="badge badge-warning" style="margin-top:6px;">Drawing into extended pool (rank 501-1000)</div>'
          : ''}</div>
        <div class="dropped-warning">${dropWarningHtml(plan)}</div>
      </div>
    `;
  }

  function updateCardMetrics(card, s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode, targetCount) {
    const plan = generateStorePlan(s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode);
    const metrics = computePlanMetrics(plan, getPhysicalWidthFt(s.shelfLayout));

    card.querySelector('.sku-count-value').textContent = targetCount;
    card.querySelector('.actual-sku-count').textContent = plan.skuCount;
    card.querySelector('.set-total-width').textContent = `${metrics.totalWidth.toFixed(1)} ft`;
    card.querySelector('.set-avg-shelves').textContent = metrics.avgShelfCount.toFixed(1);
    card.querySelector('.set-section-count').textContent = metrics.sectionCount;
    card.querySelector('.set-total-facings').textContent = metrics.totalFacings;
    card.querySelector('.set-density').textContent = (metrics.totalFacings / metrics.totalWidth).toFixed(1);
    card.querySelector('.assortment-tiers').textContent = `${plan.baseCount} / ${plan.extendedCount}`;
    card.querySelector('.assortment-brands').textContent = plan.brandCount;
    card.querySelector('.assortment-varietals').textContent = plan.varietalCount;

    card.querySelector('.fit-warning').innerHTML = metrics.overflowFt > 0.05
      ? `<div class="badge badge-warning" style="margin-top:10px;">Set needs ${metrics.overflowFt.toFixed(1)}ft more than the store's physical fixture -- reduce SKU count or expand the store's linear feet</div>`
      : '';
    card.querySelector('.extended-warning').innerHTML = plan.extendedCount > 0
      ? '<div class="badge badge-warning" style="margin-top:6px;">Drawing into extended pool (rank 501-1000)</div>'
      : '';
    card.querySelector('.dropped-warning').innerHTML = dropWarningHtml(plan);
  }

  function renderAddStoreCard() {
    if (!showAddForm) {
      return `
        <div class="card add-store-card" style="display:flex;align-items:center;justify-content:center;cursor:pointer;min-height:180px;border:1px dashed var(--border-strong);">
          <span style="color:var(--text2);font-size:14px;">+ Add Store</span>
        </div>
      `;
    }
    return `
      <div class="card">
        <div class="card-label" style="margin-bottom:12px;">New Store</div>
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Store Name</div>
          <input type="text" class="new-store-name" placeholder="e.g. Retailer Z - Location 3" style="width:100%;" />
        </div>
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Number of Bays (4ft each)</div>
          <input type="number" class="new-store-bays" value="6" min="1" step="1" style="width:100%;" />
        </div>
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Shelves per Bay</div>
          <input type="number" class="new-store-shelves" value="5" min="1" max="8" step="1" style="width:100%;" />
        </div>
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:4px;">
            <span>Store Quality</span>
            <span class="new-store-quality-label">Neutral</span>
          </div>
          <input type="range" class="new-store-quality" min="-1" max="1" step="0.1" value="0" style="width:100%;" />
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:2px;">
            <span>Budget (favors sub-$15)</span>
            <span>High-End (favors $15-20 / $20+)</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary save-store-btn">Save Store</button>
          <button class="btn cancel-store-btn">Cancel</button>
        </div>
      </div>
    `;
  }

  function render() {
    const { stores, skus, metricsConfig, bottleDimensions, sizePackage } = store.getSnapshot();
    const caseOnlyMode = store.getCaseOnlyMode();
    el.innerHTML = `
      <div class="page-header">
        <h1>Store Builder</h1>
        <p>Define store physical layout, shelf geometry, and target set size. All metrics below reflect the real generated plan -- same numbers you'd see in Optimization Engine.</p>
      </div>
      <div class="grid grid-3">
        ${stores.map((s) => renderStoreCard(s, skus, metricsConfig, bottleDimensions, sizePackage, caseOnlyMode)).join('')}
        ${renderAddStoreCard()}
      </div>
    `;
    el.querySelectorAll('.sku-count-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const storeId = e.target.closest('[data-store-id]').dataset.storeId;
        const count = parseInt(e.target.value, 10);
        store.setTargetSkuCount(storeId, count);

        const { stores: currentStores, skus: currentSkus, metricsConfig: currentMetrics, bottleDimensions: currentDims, sizePackage: currentSizePkg } = store.getSnapshot();
        const targetStore = currentStores.find((st) => st.storeId === storeId);
        const card = e.target.closest('[data-store-id]');
        updateCardMetrics(card, targetStore, currentSkus, currentMetrics, currentDims, currentSizePkg, store.getCaseOnlyMode(), count);
      });
    });

    el.querySelectorAll('.delete-store-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const storeId = e.target.closest('[data-store-id]').dataset.storeId;
        const targetStore = stores.find((st) => st.storeId === storeId);
        if (!confirm(`Delete "${targetStore?.name}"? This removes it and all its settings completely.`)) return;
        store.removeStore(storeId);
        render();
      });
    });

    const addCard = el.querySelector('.add-store-card');
    if (addCard) {
      addCard.addEventListener('click', () => {
        showAddForm = true;
        render();
      });
    }

    const qualitySlider = el.querySelector('.new-store-quality');
    if (qualitySlider) {
      qualitySlider.addEventListener('input', (e) => {
        el.querySelector('.new-store-quality-label').textContent = qualityLabel(parseFloat(e.target.value));
      });
    }

    el.querySelector('.cancel-store-btn')?.addEventListener('click', () => {
      showAddForm = false;
      render();
    });

    el.querySelector('.save-store-btn')?.addEventListener('click', () => {
      const name = el.querySelector('.new-store-name').value.trim();
      const bayCount = parseInt(el.querySelector('.new-store-bays').value, 10);
      const shelvesPerBay = parseFloat(el.querySelector('.new-store-shelves').value);
      const qualityScore = parseFloat(el.querySelector('.new-store-quality').value);

      if (!name) {
        el.querySelector('.new-store-name').style.borderColor = 'var(--danger)';
        return;
      }
      store.addStore({ name, bayCount, shelvesPerBay, qualityScore });
      showAddForm = false;
      render();
    });
  }

  render();
  const unsubscribe = bus.on('metrics:changed', render);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
