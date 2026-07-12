import { store } from '../core/store.js';

export function mount(el) {
  const { skus, sales, stores } = store.getSnapshot();

  const totalUnits = sales.reduce((sum, r) => sum + r.unitsSold, 0);
  const totalRevenue = sales.reduce((sum, r) => sum + r.revenueUsd, 0);
  const totalMargin = sales.reduce((sum, r) => sum + r.marginUsd, 0);

  el.innerHTML = `
    <div class="page-header">
      <h1>Dashboard</h1>
      <p>Category snapshot across ${stores.length} store${stores.length === 1 ? '' : 's'} and ${skus.length} SKUs.</p>
    </div>
    <div class="grid grid-4">
      <div class="card">
        <div class="card-label">Total Units (12wk)</div>
        <div class="kpi-value">${totalUnits.toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="card-label">Total Revenue (12wk)</div>
        <div class="kpi-value">$${totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
      </div>
      <div class="card">
        <div class="card-label">Total Margin (12wk)</div>
        <div class="kpi-value">$${totalMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
      </div>
      <div class="card">
        <div class="card-label">Active SKUs</div>
        <div class="kpi-value">${skus.length}</div>
      </div>
    </div>
    <div class="grid grid-2" style="margin-top:14px;">
      <div class="card">
        <div class="card-label">Stores</div>
        <div class="empty-state" style="text-align:left;padding:16px 0 0;">
          ${stores.map((s) => `<div style="padding:6px 0;color:var(--text);font-size:13px;">${s.name} <span class="badge" style="margin-left:6px;">${s.storeType}</span></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-label">Data Intelligence Layer Status</div>
        <div class="empty-state" style="text-align:left;padding:16px 0 0;">
          <div style="color:var(--success);font-size:13px;">SKUs, Sales, Stores, Metrics, Scenarios loaded from data/*.json.</div>
        </div>
      </div>
    </div>
  `;

  return () => { el.innerHTML = ''; };
}
