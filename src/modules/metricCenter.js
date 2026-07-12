import { store } from '../core/store.js';

export function mount(el) {
  const { metricsConfig } = store.getSnapshot();

  const rows = metricsConfig.map((m) => `
    <tr>
      <td>${m.label}</td>
      <td><span class="badge ${m.enabled ? 'badge-success' : ''}">${m.enabled ? 'Enabled' : 'Off'}</span></td>
      <td style="font-family:var(--font-mono);">${m.weight}</td>
      <td style="color:var(--text2);">${m.normalization}</td>
      <td style="color:var(--text2);font-size:12px;">${m.description}</td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h1>Metric Center</h1>
      <p>${metricsConfig.length} metrics registered. Every metric is toggleable, weighted, and normalized -- nothing is permanent.</p>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
            <th style="padding:12px 16px;">Metric</th>
            <th style="padding:12px 16px;">Status</th>
            <th style="padding:12px 16px;">Weight</th>
            <th style="padding:12px 16px;">Normalization</th>
            <th style="padding:12px 16px;">Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="empty-state">Live toggle/weight editing arrives in Phase 4 (Calculation Engine).</p>
  `;

  return () => { el.innerHTML = ''; };
}
