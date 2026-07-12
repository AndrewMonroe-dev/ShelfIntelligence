import { store } from '../core/store.js';
import { runAllScenarios } from '../sim/scenarioEngine.js';

function fmtPct(v) {
  if (v == null) return '--';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

export function mount(el) {
  let selectedStoreId = null;
  let results = null;

  function renderResultCard(result) {
    const { scenario, baseline, prediction, comparison } = result;
    const isBaseline = scenario.optimizationConstraints?.mode === 'baseline';

    return `
      <div class="card">
        <div class="card-label">${scenario.label}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px;">${scenario.description}</div>
        ${isBaseline ? `
          <div style="margin-top:14px;">
            <div class="kpi-value" style="font-size:22px;">${baseline.hasData ? baseline.totalUnitsPerWeek.toFixed(0) : '--'}</div>
            <div style="font-size:11px;color:var(--text2);">units/week (current, synthetic demo data)</div>
          </div>
        ` : prediction?.hasPrediction ? `
          <div style="margin-top:14px;">
            <div class="kpi-value" style="font-size:22px;">${prediction.totalUnitsPerWeek.toFixed(0)}</div>
            <div style="font-size:11px;color:var(--text2);">predicted units/week</div>
          </div>
          <div class="grid grid-2" style="margin-top:10px;">
            <div>
              <div style="font-size:10px;color:var(--text2);">Velocity vs. current</div>
              <div style="font-size:14px;font-weight:600;color:${comparison?.velocityChangePct >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmtPct(comparison?.velocityChangePct)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text2);">Revenue vs. current</div>
              <div style="font-size:14px;font-weight:600;color:${comparison?.revenueChangePct >= 0 ? 'var(--success)' : 'var(--danger)'};">${fmtPct(comparison?.revenueChangePct)}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text2);margin-top:8px;">${prediction.casesPerLinearFoot.toFixed(1)} units/linear ft &middot; ${result.plan.sections.length} sections</div>
        ` : '<div class="empty-state">No baseline sales data for this store -- cannot calibrate a prediction.</div>'}
      </div>
    `;
  }

  function render() {
    const { stores } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = stores[0]?.storeId;

    el.innerHTML = `
      <div class="page-header">
        <h1>Digital Twin Simulator</h1>
        <p>Compares current-state baseline (synthetic demo sales) against a transparent heuristic prediction for each scenario -- not a trained ML model. Formula disclosed in src/sim/predictor.js.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:16px;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary run-btn" style="margin-left:auto;">Run All Scenarios</button>
      </div>
      <div class="results-output"></div>
    `;

    const output = el.querySelector('.results-output');
    if (results) {
      output.innerHTML = `<div class="grid grid-3" style="margin-top:14px;">${results.map(renderResultCard).join('')}</div>`;
    }

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      results = null;
      render();
    });

    el.querySelector('.run-btn').addEventListener('click', () => {
      const { stores: allStores, skus, metricsConfig, bottleDimensions, sales, scenarios, sizePackage } = store.getSnapshot();
      const targetStore = allStores.find((s) => s.storeId === selectedStoreId);
      const targetCount = store.getTargetSkuCount(selectedStoreId);
      const sectionMultipliers = store.getSectionMultipliers(selectedStoreId);
      const sectionShelfCounts = store.getSectionShelfCounts(selectedStoreId);
      const caseOnlyMode = store.getCaseOnlyMode();
      results = runAllScenarios(scenarios, targetStore, skus, metricsConfig, targetCount, bottleDimensions, sales, sectionMultipliers, sectionShelfCounts, sizePackage, caseOnlyMode);
      output.innerHTML = `<div class="grid grid-3" style="margin-top:14px;">${results.map(renderResultCard).join('')}</div>`;
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
