import { store } from '../core/store.js';
import { estimateStorageSizeKb } from '../core/persistence.js';

export function mount(el) {
  function render() {
    const { targetSkuCounts, sectionMultipliers, sales } = store.getSnapshot();
    const importedSalesCount = sales.filter((r) => !r.synthetic).length;
    const storeCount = Object.keys(targetSkuCounts).length;
    const sectionOverrideCount = Object.values(sectionMultipliers).reduce(
      (sum, m) => sum + Object.keys(m).length, 0
    );

    el.innerHTML = `
      <div class="page-header">
        <h1>Settings</h1>
        <p>Every slider, weight, and imported row in this app is saved to your browser's local storage automatically -- it survives a page reload. This page shows what's saved and lets you reset it.</p>
      </div>
      <div class="grid grid-4" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-label">Stores with custom SKU count</div>
          <div class="kpi-value">${storeCount}</div>
        </div>
        <div class="card">
          <div class="card-label">Section size overrides</div>
          <div class="kpi-value">${sectionOverrideCount}</div>
        </div>
        <div class="card">
          <div class="card-label">Imported sales rows</div>
          <div class="kpi-value">${importedSalesCount}</div>
        </div>
        <div class="card">
          <div class="card-label">Local storage used</div>
          <div class="kpi-value">${estimateStorageSizeKb()} KB</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div class="card-label" style="margin-bottom:8px;">What's saved</div>
        <div style="font-size:12.5px;color:var(--text2);line-height:1.8;">
          Metric Center weights and enabled/disabled toggles &middot;
          Store Builder SKU count sliders &middot;
          Optimization Engine section size multipliers &middot;
          Active scenario selection &middot;
          Sales Import rows (not the synthetic demo data, only what you've imported)
        </div>
        <div style="font-size:11.5px;color:var(--text3);margin-top:10px;">Base data (data/*.json -- SKUs, stores, market rankings) is never overridden here; this only stores your adjustments on top of it. Nothing is sent anywhere -- it's your browser's localStorage only.</div>
      </div>
      <div class="card">
        <div class="card-label" style="margin-bottom:10px;">Reset</div>
        <button class="btn reset-btn" style="background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3);color:var(--danger);">Clear saved settings and reload</button>
        <div class="reset-confirm" style="margin-top:10px;"></div>
      </div>
    `;

    el.querySelector('.reset-btn').addEventListener('click', (e) => {
      const confirmEl = el.querySelector('.reset-confirm');
      if (!e.target.dataset.confirmed) {
        confirmEl.innerHTML = `
          <span style="font-size:12.5px;color:var(--warning);">This clears all saved weights, SKU counts, section sizes, and imported sales. Click again to confirm.</span>
        `;
        e.target.dataset.confirmed = 'true';
        return;
      }
      store.resetPersistedState();
      window.location.reload();
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
