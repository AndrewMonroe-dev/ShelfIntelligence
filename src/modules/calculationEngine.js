import { store } from '../core/store.js?v=20260808c';
import { bus } from '../core/bus.js?v=20260808c';
import { computeScores } from '../calc/scoreEngine.js?v=20260808c';

// Andrew, 2026-08-08: this page was a day-1 placeholder ("arrives once
// scoreEngine.js exists") that never got built out even after scoreEngine.js
// had long since existed and been powering every other module's scores.
// Nothing new needed here computationally -- computeScores() already returns
// a full per-metric breakdown (every enabled+data-backed metric, not just the
// top 3 placementSolver truncates to for its own tooltip use). This is purely
// the transparency-view UI ARCHITECTURE.md always called for.

let searchTerm = '';
let selectedSkuId = null;

const PERCENT_METRICS = new Set(['growthRate', 'pricePointStrength', 'regionalPreference', 'displayShare', 'featureShare']);
const PER_POD_WEEK_METRICS = new Set(['velocity']);
const SIGNED_POD_METRICS = new Set(['podsMomentum']);
const BOOLEAN_METRICS = new Set(['strategicSupplierPriority']);
const COUNT_METRICS = new Set(['skuVolume', 'brandVolume', 'varietalVolume', 'supplierVolume', 'distributionStrength']);

function formatRawValue(metricId, value) {
  if (value == null) return '--';
  if (BOOLEAN_METRICS.has(metricId)) return value ? 'Yes' : 'No';
  if (PERCENT_METRICS.has(metricId)) return (value * 100).toFixed(1) + '%';
  if (PER_POD_WEEK_METRICS.has(metricId)) return '$' + value.toFixed(2) + '/POD/wk';
  if (SIGNED_POD_METRICS.has(metricId)) return (value > 0 ? '+' : '') + value.toFixed(1) + ' PODs';
  if (COUNT_METRICS.has(metricId)) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return value.toFixed(2);
}

export function mount(el) {
  function renderBreakdown(sku, scoreEntry) {
    const rows = scoreEntry.breakdown.map((b) => `
      <tr>
        <td style="padding:10px 16px;">${b.label}</td>
        <td style="padding:10px 16px;font-family:var(--font-mono);color:var(--text2);">${formatRawValue(b.metricId, b.rawValue)}</td>
        <td style="padding:10px 16px;font-family:var(--font-mono);color:var(--text2);">${b.normalizedValue.toFixed(1)}</td>
        <td style="padding:10px 16px;font-family:var(--font-mono);color:var(--text2);">${b.weightSharePct.toFixed(1)}%</td>
        <td style="padding:10px 16px;width:200px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="progress-track" style="flex:1;margin-top:0;">
              <div class="progress-fill" style="width:${Math.max(0, Math.min(100, (b.contribution / scoreEntry.score) * 100 || 0))}%;"></div>
            </div>
            <span style="font-family:var(--font-mono);color:var(--blue);font-weight:600;width:44px;text-align:right;">${b.contribution.toFixed(1)}</span>
          </div>
        </td>
      </tr>
    `).join('');

    const inactiveCount = store.getSnapshot().metricsConfig.length - scoreEntry.breakdown.length;

    return `
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;">
          <div>
            <span class="card-label">${sku.brand}${sku.varietal ? ' -- ' + sku.varietal : ''}${sku.strategicSupplierPriority ? ' <span class="badge badge-premium">Priority</span>' : ''}</span>
            <div style="color:var(--text2);font-size:12.5px;margin-top:4px;">
              ${sku.skuId} &middot; ${sku.region || '--'} &middot; ${sku.bottleSizeRaw || '--'} &middot; ${sku.priceUsd != null ? '$' + sku.priceUsd.toFixed(2) : '--'} &middot; Nat'l Rank #${sku.nationalRank ?? '--'}
            </div>
          </div>
          <div style="text-align:right;">
            <div class="card-label">Opportunity Score</div>
            <div class="kpi-value" style="color:var(--blue);">${scoreEntry.score.toFixed(1)}</div>
          </div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
              <th style="padding:12px 16px;">Metric</th>
              <th style="padding:12px 16px;">Raw Value</th>
              <th style="padding:12px 16px;">Normalized (0-100)</th>
              <th style="padding:12px 16px;">Weight Share</th>
              <th style="padding:12px 16px;">Contribution to Score</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="color:var(--text2);font-size:12px;margin-top:8px;">
        ${scoreEntry.breakdown.length} of ${store.getSnapshot().metricsConfig.length} registered metrics contributed to this score (the rest are disabled or have no data for this SKU pool -- see Metric Center). ${inactiveCount} not contributing.
      </div>
    `;
  }

  function render() {
    const { skus, metricsConfig } = store.getSnapshot();
    const scores = computeScores(skus, metricsConfig);
    const scoreMap = new Map(scores.map((s) => [s.skuId, s]));

    // Defaults to the top-scoring SKU so the page never opens on an empty
    // state -- search below picks a different one.
    if (!selectedSkuId || !scoreMap.has(selectedSkuId)) {
      const top = [...scores].sort((a, b) => b.score - a.score)[0];
      selectedSkuId = top ? top.skuId : null;
    }

    const term = searchTerm.trim();
    const matches = term.length >= 2
      ? skus.filter((s) => `${s.brand} ${s.varietal || ''} ${s.skuId}`.toLowerCase().includes(term.toLowerCase())).slice(0, 8)
      : [];

    const sku = skus.find((s) => s.skuId === selectedSkuId);
    const scoreEntry = sku ? scoreMap.get(sku.skuId) : null;

    el.innerHTML = `
      <div class="page-header">
        <h1>Calculation Engine</h1>
        <p>Full metric-by-metric transparency into how any SKU's opportunity score is built -- live off the exact same calc/scoreEngine.js every recommendation in this app (assortment, placement, Store Builder) runs on.</p>
      </div>
      <div class="card" style="margin-bottom:14px;overflow:visible;position:relative;">
        <span class="card-label">Select a SKU (brand, varietal, or ID)</span>
        <input type="text" class="calc-sku-search" value="${searchTerm}" placeholder="e.g. Barefoot, Cabernet, 000001..." style="width:100%;margin-top:8px;" />
        ${matches.length ? `
          <div class="add-sku-results">
            ${matches.map((s) => `<div class="add-sku-result" data-sku-id="${s.skuId}">${s.brand} &middot; ${s.varietal || s.bottleSizeRaw} &middot; ${s.skuId} &middot; score ${scoreMap.get(s.skuId)?.score.toFixed(1) ?? '--'}</div>`).join('')}
          </div>
        ` : ''}
      </div>
      ${sku && scoreEntry ? renderBreakdown(sku, scoreEntry) : '<div class="card empty-state">No SKUs available.</div>'}
    `;

    const searchInput = el.querySelector('.calc-sku-search');
    searchInput?.addEventListener('input', (e) => {
      searchTerm = e.target.value;
      const cursorPos = e.target.selectionStart;
      render();
      const freshInput = el.querySelector('.calc-sku-search');
      if (freshInput) {
        freshInput.focus();
        freshInput.setSelectionRange(cursorPos, cursorPos);
      }
    });
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const topMatch = el.querySelector('.add-sku-result');
      if (topMatch) topMatch.click();
    });

    el.querySelectorAll('.add-sku-result').forEach((row) => {
      row.addEventListener('click', () => {
        selectedSkuId = row.dataset.skuId;
        searchTerm = '';
        render();
      });
    });
  }

  render();
  const unsubscribe = bus.on('metrics:changed', render);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
