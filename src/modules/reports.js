import { store } from '../core/store.js';

function collectPlanSkus(plan) {
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

function flattenPlan(plan) {
  return collectPlanSkus(plan).map(({ section, shelf, sku }) => ({
    section: section.label,
    sectionType: section.type,
    shelfPosition: shelf.position,
    zone: shelf.zone,
    traffic: shelf.traffic,
    skuId: sku.skuId,
    brand: sku.brand,
    varietal: sku.varietal || '',
    price: sku.priceUsd ?? '',
    score: sku.score.toFixed(1),
    facings: sku.facings,
    reasons: sku.reasons.map((r) => `${r.factor}${r.value != null ? ': ' + r.value : ''}${r.contribution != null ? ' (' + r.contribution + ')' : ''}`).join(' | '),
  }));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  });
  return lines.join('\n');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderReasonsPanel(sku) {
  return `
    <div style="border-top:1px solid var(--border);padding:8px 0;">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;">
        <span><strong>${sku.brand}</strong>${sku.varietal ? ' &middot; ' + sku.varietal : ''} <span style="color:var(--text3);font-family:var(--font-mono);">${sku.skuId}</span></span>
        <span style="font-family:var(--font-mono);color:var(--text2);">score ${sku.score.toFixed(1)}</span>
      </div>
      <div style="margin-top:4px;font-size:11.5px;color:var(--text2);">
        ${sku.reasons.map((r) => `<span class="badge" style="margin:2px 4px 0 0;">${r.factor}${r.value != null ? ': ' + r.value : ''}${r.contribution != null ? ' (' + r.contribution + ')' : ''}</span>`).join('')}
      </div>
    </div>
  `;
}

export function mount(el) {
  function render() {
    const { currentPlan } = store.getSnapshot();

    if (!currentPlan) {
      el.innerHTML = `
        <div class="page-header">
          <h1>Reports</h1>
          <p>Exportable summaries with an explainability panel for every recommendation.</p>
        </div>
        <div class="card empty-state">No plan generated yet. Go to Optimization Engine and click "Generate Plan" first.</div>
      `;
      return;
    }

    const rows = flattenPlan(currentPlan);
    const planSkus = collectPlanSkus(currentPlan);
    const topByScore = [...planSkus].sort((a, b) => b.sku.score - a.sku.score).slice(0, 15);

    el.innerHTML = `
      <div class="page-header">
        <h1>Reports</h1>
        <p>Plan for ${currentPlan.storeId}, generated ${new Date(currentPlan.generatedAt).toLocaleString()}. ${currentPlan.skuCount} SKUs across ${currentPlan.sections.length} sections.</p>
      </div>
      <div class="card" style="display:flex;gap:10px;margin-bottom:14px;">
        <button class="btn btn-primary export-csv-btn">Export CSV</button>
        <button class="btn export-json-btn">Export JSON</button>
      </div>
      <div class="grid grid-3" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-label">Total SKUs</div>
          <div class="kpi-value">${currentPlan.skuCount}</div>
        </div>
        <div class="card">
          <div class="card-label">Sections</div>
          <div class="kpi-value">${currentPlan.sections.length}</div>
        </div>
        <div class="card">
          <div class="card-label">Total Linear Feet</div>
          <div class="kpi-value">${currentPlan.sections.reduce((s, sec) => s + sec.linearFeet, 0).toFixed(1)}</div>
        </div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto;margin-bottom:14px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
              <th style="padding:10px 14px;">Section</th>
              <th style="padding:10px 14px;">Type</th>
              <th style="padding:10px 14px;">Linear Ft</th>
              <th style="padding:10px 14px;">Shelves</th>
              <th style="padding:10px 14px;">Share of Set</th>
            </tr>
          </thead>
          <tbody>
            ${currentPlan.sections.map((s) => `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px 14px;">${s.label}</td>
                <td style="padding:8px 14px;color:var(--text2);">${s.type}</td>
                <td style="padding:8px 14px;">${s.linearFeet.toFixed(1)}</td>
                <td style="padding:8px 14px;">${s.shelfCount}</td>
                <td style="padding:8px 14px;">${(s.scoreShare * 100).toFixed(1)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-label" style="margin-bottom:8px;">Top 15 recommendations, with full explanation</div>
        ${topByScore.map(({ sku }) => renderReasonsPanel(sku)).join('')}
      </div>
    `;

    el.querySelector('.export-csv-btn').addEventListener('click', () => {
      downloadFile(toCsv(rows), `shelf-plan-${currentPlan.storeId}-${Date.now()}.csv`, 'text/csv');
    });
    el.querySelector('.export-json-btn').addEventListener('click', () => {
      downloadFile(JSON.stringify(currentPlan, null, 2), `shelf-plan-${currentPlan.storeId}-${Date.now()}.json`, 'application/json');
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
