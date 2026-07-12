import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { computeScoreMap } from '../calc/scoreEngine.js';

export function mount(el) {
  function render() {
    const { skus, metricsConfig } = store.getSnapshot();
    const scoreMap = computeScoreMap(skus, metricsConfig);
    const sorted = [...skus].sort((a, b) => (scoreMap.get(b.skuId)?.score ?? 0) - (scoreMap.get(a.skuId)?.score ?? 0));

    const rows = sorted.map((s) => {
      const score = scoreMap.get(s.skuId)?.score ?? 0;
      return `
        <tr>
          <td style="font-family:var(--font-mono);color:var(--text2);">${s.skuId}</td>
          <td style="font-family:var(--font-mono);color:var(--blue);font-weight:600;">${score.toFixed(1)}</td>
          <td style="font-family:var(--font-mono);color:var(--text3);">#${s.nationalRank}</td>
          <td>${s.brand === 'UNKNOWN' ? '<span style="color:var(--text3);">Unmatched</span>' : s.brand}${s.strategicSupplierPriority ? ' <span class="badge badge-premium">Priority</span>' : ''}</td>
          <td style="color:var(--text2);">${s.varietal || '<span style="color:var(--text3);">--</span>'}</td>
          <td style="color:var(--text2);">${s.region || '<span style="color:var(--text3);">--</span>'}</td>
          <td>${s.priceUsd != null ? '$' + s.priceUsd.toFixed(2) : '--'}</td>
          <td>${s.bottleSizeRaw || '--'}</td>
        </tr>
      `;
    }).join('');

    const unmatchedBrand = skus.filter((s) => s.brand === 'UNKNOWN').length;
    const unmatchedVarietal = skus.filter((s) => !s.varietal).length;

    el.innerHTML = `
      <div class="page-header">
        <h1>SKU Database</h1>
        <p>${skus.length} SKUs, sorted by live Calculation Engine score. Identified permanently by SKU ID -- never by name.</p>
      </div>
      <div class="grid grid-3" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-label">Brand Match Rate</div>
          <div class="kpi-value">${(100 * (1 - unmatchedBrand / skus.length)).toFixed(1)}%</div>
        </div>
        <div class="card">
          <div class="card-label">Varietal Match Rate</div>
          <div class="kpi-value">${(100 * (1 - unmatchedVarietal / skus.length)).toFixed(1)}%</div>
        </div>
        <div class="card">
          <div class="card-label">Base / Extended Split</div>
          <div class="kpi-value" style="font-size:18px;">${skus.filter((s) => s.assortmentTier === 'base').length} / ${skus.filter((s) => s.assortmentTier === 'extended').length}</div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto;max-height:520px;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);">
              <th style="padding:12px 16px;">SKU ID</th>
              <th style="padding:12px 16px;">Score</th>
              <th style="padding:12px 16px;">Nat'l Rank</th>
              <th style="padding:12px 16px;">Brand</th>
              <th style="padding:12px 16px;">Varietal</th>
              <th style="padding:12px 16px;">Region</th>
              <th style="padding:12px 16px;">ARP</th>
              <th style="padding:12px 16px;">Size</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  render();
  const unsubscribe = bus.on('metrics:changed', render);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
