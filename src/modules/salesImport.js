import { store } from '../core/store.js';
import { readWorkbook, sheetToRows, autoDetectMapping, transformRows } from '../data/importParser.js';

const FIELD_LABELS = {
  upc: 'UPC / Barcode',
  skuId: 'SKU ID',
  storeId: 'Store ID',
  period: 'Period / Week',
  unitsSold: 'Units Sold',
  revenueUsd: 'Revenue ($)',
};

export function mount(el) {
  let workbookState = null; // { XLSX, workbook, sheetName, rows, headers, mapping }
  let selectedStoreId = null;

  function fieldSelectHtml(field, headers, mapping) {
    const current = mapping[field] || '';
    return `
      <div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">${FIELD_LABELS[field]}${field === 'upc' || field === 'skuId' ? '' : ' (optional)'}</div>
        <select class="field-map" data-field="${field}">
          <option value="">-- none --</option>
          ${headers.map((h) => `<option value="${h}" ${h === current ? 'selected' : ''}>${h}</option>`).join('')}
        </select>
      </div>
    `;
  }

  function renderMappingAndPreview() {
    const { headers, mapping, rows, sheetName, workbook } = workbookState;
    const { stores } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = stores[0]?.storeId;

    const sheetNames = workbook.SheetNames;
    const previewRows = rows.slice(0, 8);

    return `
      <div class="card" style="margin-top:14px;">
        <div class="card-label" style="margin-bottom:10px;">Column Mapping -- ${rows.length} rows on sheet "${sheetName}"</div>
        ${sheetNames.length > 1 ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Sheet</div>
            <select class="sheet-select">
              ${sheetNames.map((s) => `<option value="${s}" ${s === sheetName ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <div class="grid grid-3" style="margin-bottom:14px;">
          ${Object.keys(FIELD_LABELS).map((f) => fieldSelectHtml(f, headers, mapping)).join('')}
        </div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px;">Provide at least UPC or SKU ID to match rows to real SKUs. Unmapped Store ID / Period fall back to the selections below; unmapped Revenue is estimated from Units &times; each SKU's real ARP.</div>
        <div class="grid grid-2" style="margin-bottom:14px;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Default Store (used when Store ID isn't mapped)</div>
            <select class="default-store-select">
              ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Default Period (used when Period isn't mapped)</div>
            <input type="text" class="default-period-input" value="IMPORTED-${new Date().toISOString().slice(0, 10)}" />
          </div>
        </div>
        <div class="card" style="padding:0;overflow-x:auto;margin-bottom:14px;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
                ${headers.map((h) => `<th style="padding:6px 10px;white-space:nowrap;">${h}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${previewRows.map((r) => `<tr>${headers.map((h) => `<td style="padding:6px 10px;color:var(--text2);white-space:nowrap;">${r[h] ?? ''}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:12px;">
          <input type="checkbox" class="replace-checkbox" />
          Replace existing sales data instead of appending to it
        </label>
        <button class="btn btn-primary import-btn">Import Rows</button>
        <div class="import-result" style="margin-top:12px;"></div>
      </div>
    `;
  }

  function bindMappingListeners(container) {
    container.querySelectorAll('.field-map').forEach((select) => {
      select.addEventListener('change', (e) => {
        workbookState.mapping[e.target.dataset.field] = e.target.value || undefined;
      });
    });
    const sheetSelect = container.querySelector('.sheet-select');
    if (sheetSelect) {
      sheetSelect.addEventListener('change', (e) => {
        const { XLSX, workbook } = workbookState;
        const { rows, headers } = sheetToRows(XLSX, workbook, e.target.value);
        workbookState = { ...workbookState, sheetName: e.target.value, rows, headers, mapping: autoDetectMapping(headers) };
        container.innerHTML = renderMappingAndPreview();
        bindMappingListeners(container);
      });
    }
    container.querySelector('.default-store-select')?.addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
    });
    let defaultPeriod = container.querySelector('.default-period-input')?.value;
    container.querySelector('.default-period-input')?.addEventListener('input', (e) => {
      defaultPeriod = e.target.value;
    });

    container.querySelector('.import-btn').addEventListener('click', () => {
      const { skus } = store.getSnapshot();
      const skusByUpc = new Map(skus.filter((s) => s.upc).map((s) => [String(s.upc).trim(), s]));
      const skusById = new Map(skus.map((s) => [s.skuId, s]));
      const replace = container.querySelector('.replace-checkbox').checked;
      const periodValue = container.querySelector('.default-period-input').value;

      const { matched, unmatched } = transformRows(workbookState.rows, workbookState.mapping, {
        defaultStoreId: selectedStoreId,
        defaultPeriod: periodValue,
        skusByUpc,
        skusById,
      });

      if (matched.length) {
        store.importSales(matched, { replace });
      }

      const resultEl = container.querySelector('.import-result');
      resultEl.innerHTML = `
        <div class="badge ${matched.length ? 'badge-success' : 'badge-danger'}">${matched.length} rows imported${replace ? ' (replaced existing data)' : ' (appended)'}</div>
        ${unmatched.length ? `<div class="badge badge-warning" style="margin-left:8px;">${unmatched.length} rows had no UPC/SKU match and were skipped</div>` : ''}
      `;
    });
  }

  function renderUploadCard() {
    return `
      <div class="card">
        <div class="card-label" style="margin-bottom:8px;">Upload File</div>
        <input type="file" class="file-input" accept=".csv,.xlsx,.xls" />
        <div class="upload-status" style="margin-top:10px;font-size:12.5px;color:var(--text2);"></div>
      </div>
    `;
  }

  function render() {
    el.innerHTML = `
      <div class="page-header">
        <h1>Sales Import</h1>
        <p>Bulk-load sales history from CSV, XLS, or XLSX -- any spreadsheet export, not just a fixed CSV format. Parsed entirely in your browser (SheetJS), nothing uploaded anywhere.</p>
      </div>
      <div class="upload-card-slot"></div>
      <div class="mapping-slot"></div>
    `;

    const uploadSlot = el.querySelector('.upload-card-slot');
    uploadSlot.innerHTML = renderUploadCard();

    uploadSlot.querySelector('.file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = uploadSlot.querySelector('.upload-status');
      statusEl.textContent = 'Parsing...';
      try {
        const { XLSX, workbook } = await readWorkbook(file);
        const sheetName = workbook.SheetNames[0];
        const { rows, headers } = sheetToRows(XLSX, workbook, sheetName);
        if (!rows.length) {
          statusEl.textContent = 'File parsed but contains no rows.';
          return;
        }
        workbookState = { XLSX, workbook, sheetName, rows, headers, mapping: autoDetectMapping(headers) };
        statusEl.textContent = `Parsed ${rows.length} rows from "${file.name}".`;
        const mappingSlot = el.querySelector('.mapping-slot');
        mappingSlot.innerHTML = renderMappingAndPreview();
        bindMappingListeners(mappingSlot);
      } catch (err) {
        statusEl.textContent = `Failed to parse file: ${err.message}`;
      }
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
