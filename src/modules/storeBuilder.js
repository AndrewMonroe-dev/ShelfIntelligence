import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { selectAssortment } from '../optimize/assortment.js';

export function mount(el) {
  function renderStoreCard(s, skus, metricsConfig) {
    const targetCount = store.getTargetSkuCount(s.storeId);
    const result = selectAssortment(skus, targetCount, metricsConfig);
    return `
      <div class="card" data-store-id="${s.storeId}">
        <div class="card-label">${s.name}</div>
        <div style="margin-top:8px;font-size:13px;color:var(--text2);">${s.storeType} &middot; ${s.region}</div>
        <div style="margin-top:6px;font-size:13px;">${s.shelfLayout.shelves.length} shelves &middot; ${s.shelfLayout.totalLinearFeet} linear feet</div>

        <div style="margin-top:18px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
            <span class="card-label">SKU Count</span>
            <span class="kpi-value sku-count-value" style="font-size:20px;margin-top:0;">${targetCount}</span>
          </div>
          <input type="range" class="sku-count-slider" min="10" max="${skus.length}" step="10" value="${targetCount}" style="width:100%;" />
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-top:2px;">
            <span>10</span>
            <span>${skus.length}</span>
          </div>
        </div>

        <div class="grid grid-3" style="margin-top:12px;">
          <div>
            <div class="card-label" style="font-size:10px;">Base / Extended</div>
            <div class="assortment-tiers" style="font-size:13px;font-weight:600;margin-top:4px;">${result.baseCount} / ${result.extendedCount}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Brands</div>
            <div class="assortment-brands" style="font-size:13px;font-weight:600;margin-top:4px;">${result.brandCount}</div>
          </div>
          <div>
            <div class="card-label" style="font-size:10px;">Varietals</div>
            <div class="assortment-varietals" style="font-size:13px;font-weight:600;margin-top:4px;">${result.varietalCount}</div>
          </div>
        </div>
        ${result.extendedCount > 0 ? '<div class="badge badge-warning" style="margin-top:10px;">Drawing into extended pool (rank 501-1000)</div>' : ''}
      </div>
    `;
  }

  function render() {
    const { stores, skus, metricsConfig } = store.getSnapshot();
    el.innerHTML = `
      <div class="page-header">
        <h1>Store Builder</h1>
        <p>Define store physical layout, shelf geometry, and target set size. Assortment ranking uses the live Calculation Engine score.</p>
      </div>
      <div class="grid grid-3">${stores.map((s) => renderStoreCard(s, skus, metricsConfig)).join('')}</div>
    `;
    el.querySelectorAll('.sku-count-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const storeId = e.target.closest('[data-store-id]').dataset.storeId;
        const count = parseInt(e.target.value, 10);
        store.setTargetSkuCount(storeId, count);

        const { skus: currentSkus, metricsConfig: currentMetrics } = store.getSnapshot();
        const result = selectAssortment(currentSkus, count, currentMetrics);
        const card = e.target.closest('[data-store-id]');
        card.querySelector('.sku-count-value').textContent = count;
        card.querySelector('.assortment-tiers').textContent = `${result.baseCount} / ${result.extendedCount}`;
        card.querySelector('.assortment-brands').textContent = result.brandCount;
        card.querySelector('.assortment-varietals').textContent = result.varietalCount;

        const existingWarning = card.querySelector('.badge-warning');
        if (result.extendedCount > 0 && !existingWarning) {
          card.insertAdjacentHTML('beforeend', '<div class="badge badge-warning" style="margin-top:10px;">Drawing into extended pool (rank 501-1000)</div>');
        } else if (result.extendedCount === 0 && existingWarning) {
          existingWarning.remove();
        }
      });
    });
  }

  render();
  const unsubscribe = bus.on('metrics:changed', render);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
