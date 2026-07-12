import { store } from '../core/store.js';
import { bus } from '../core/bus.js';
import { getActiveMetrics } from '../calc/scoreEngine.js';

export function mount(el) {
  function renderRow(cfg, hasData, weightSharePct) {
    const isActive = cfg.enabled && hasData;
    return `
      <tr data-metric-id="${cfg.id}" style="${isActive ? '' : 'opacity:0.55;'}">
        <td style="padding:10px 16px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" class="metric-enabled" ${cfg.enabled ? 'checked' : ''} />
            <span>${cfg.label}</span>
          </label>
        </td>
        <td style="padding:10px 16px;">
          ${hasData
            ? `<span class="badge badge-success">Live data</span>`
            : `<span class="badge badge-warning">No data</span>`}
        </td>
        <td style="padding:10px 16px;width:220px;">
          <input type="range" class="metric-weight" min="0" max="100" step="1" value="${cfg.weight}" style="width:140px;vertical-align:middle;" ${hasData ? '' : 'disabled'} />
          <span class="metric-weight-value" style="font-family:var(--font-mono);margin-left:8px;">${cfg.weight}</span>
        </td>
        <td style="padding:10px 16px;font-family:var(--font-mono);" class="metric-share">
          ${isActive ? weightSharePct.toFixed(1) + '%' : '--'}
        </td>
        <td style="padding:10px 16px;color:var(--text2);font-size:12px;">${cfg.description}</td>
      </tr>
    `;
  }

  function computeShares(metricsConfig, skus) {
    const active = getActiveMetrics(metricsConfig, skus);
    const activeEnabled = active.filter((m) => m.cfg.enabled && m.hasData);
    const totalWeight = activeEnabled.reduce((sum, m) => sum + m.cfg.weight, 0) || 1;
    const shareById = {};
    active.forEach((m) => {
      shareById[m.cfg.id] = m.cfg.enabled && m.hasData ? (m.cfg.weight / totalWeight) * 100 : null;
    });
    return { active, shareById, activeEnabledCount: activeEnabled.length };
  }

  // Updates text/labels/opacity in place without touching the slider/checkbox
  // DOM nodes themselves -- rebuilding those mid-drag would break dragging.
  function refreshDisplay() {
    const { metricsConfig, skus } = store.getSnapshot();
    const { shareById, activeEnabledCount } = computeShares(metricsConfig, skus);

    metricsConfig.forEach((cfg) => {
      const row = el.querySelector(`tr[data-metric-id="${cfg.id}"]`);
      if (!row) return;
      const share = shareById[cfg.id];
      row.style.opacity = share != null ? '1' : '0.55';
      const shareCell = row.querySelector('.metric-share');
      if (shareCell) shareCell.textContent = share != null ? share.toFixed(1) + '%' : '--';
      const weightValue = row.querySelector('.metric-weight-value');
      if (weightValue) weightValue.textContent = cfg.weight;
    });

    const summary = el.querySelector('.active-metric-summary');
    if (summary) {
      summary.textContent = `${activeEnabledCount} of ${metricsConfig.length} metrics are enabled with real data behind them and are actively contributing to scores. Metrics with no data still show their slider but are excluded from the blend until real data is provided.`;
    }
  }

  function render() {
    const { metricsConfig, skus } = store.getSnapshot();
    const { active, shareById } = computeShares(metricsConfig, skus);

    const rows = active.map((m) => renderRow(m.cfg, m.hasData, shareById[m.cfg.id] || 0)).join('');

    el.innerHTML = `
      <div class="page-header">
        <h1>Metric Center</h1>
        <p>${metricsConfig.length} metrics registered. Every weight below is live -- moving a slider immediately re-scores all ${skus.length} SKUs and re-ranks Store Builder's assortment.</p>
      </div>
      <div class="card" style="margin-bottom:14px;padding:14px 18px;">
        <span class="active-metric-summary" style="color:var(--text2);font-size:12.5px;"></span>
      </div>
      <div class="card" style="padding:0;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
              <th style="padding:12px 16px;">Metric</th>
              <th style="padding:12px 16px;">Data</th>
              <th style="padding:12px 16px;">Weight</th>
              <th style="padding:12px 16px;">Active Share</th>
              <th style="padding:12px 16px;">Description</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    refreshDisplay();

    el.querySelectorAll('.metric-enabled').forEach((checkbox) => {
      checkbox.addEventListener('change', (e) => {
        const metricId = e.target.closest('[data-metric-id]').dataset.metricId;
        store.setMetricConfig(metricId, { enabled: e.target.checked });
      });
    });

    el.querySelectorAll('.metric-weight').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const metricId = e.target.closest('[data-metric-id]').dataset.metricId;
        const weight = parseInt(e.target.value, 10);
        store.setMetricConfig(metricId, { weight });
      });
    });
  }

  render();
  const unsubscribe = bus.on('metrics:changed', refreshDisplay);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
