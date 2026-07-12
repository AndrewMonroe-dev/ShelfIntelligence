// Parses CSV/XLS/XLSX files client-side via vendored SheetJS
// (assets/js/vendor/xlsx.full.min.js), lazy-loaded only when Sales Import is
// actually used so the ~880KB library never loads on other pages.

let xlsxLoadPromise = null;

export function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLoadPromise) return xlsxLoadPromise;

  xlsxLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../assets/js/vendor/xlsx.full.min.js', import.meta.url).href;
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('Failed to load xlsx parsing library'));
    document.head.appendChild(script);
  });
  return xlsxLoadPromise;
}

export async function readWorkbook(file) {
  const XLSX = await loadXlsxLib();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  return { XLSX, workbook };
}

export function sheetToRows(XLSX, workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

// Best-effort header matching against common POS/export naming conventions.
// This only suggests a mapping -- the UI always shows it for user confirmation
// rather than importing silently on a guess.
const FIELD_PATTERNS = {
  upc: /^(upc|barcode|gtin|ean)$/i,
  skuId: /^(sku.?id|sku|item.?id|product.?id)$/i,
  storeId: /^(store.?id|store|location|account)$/i,
  period: /^(period|week|date|week.?ending)$/i,
  unitsSold: /^(units?.?sold|units?|qty|quantity|cases?)$/i,
  revenueUsd: /^(revenue|sales.?\$|sales.?amount|amount|dollars?)$/i,
};

export function autoDetectMapping(headers) {
  const mapping = {};
  Object.entries(FIELD_PATTERNS).forEach(([field, pattern]) => {
    const match = headers.find((h) => pattern.test(String(h).trim()));
    if (match) mapping[field] = match;
  });
  return mapping;
}

export function transformRows(rows, mapping, { defaultStoreId, defaultPeriod, skusByUpc, skusById }) {
  const matched = [];
  const unmatched = [];

  rows.forEach((row) => {
    const upcRaw = mapping.upc ? row[mapping.upc] : null;
    const skuIdRaw = mapping.skuId ? row[mapping.skuId] : null;
    const upc = upcRaw != null ? String(upcRaw).trim() : null;
    const skuIdCandidate = skuIdRaw != null ? String(skuIdRaw).trim() : null;

    const sku = (upc && skusByUpc.get(upc)) || (skuIdCandidate && skusById.get(skuIdCandidate));
    if (!sku) {
      unmatched.push(row);
      return;
    }

    const storeId = mapping.storeId ? String(row[mapping.storeId] ?? '').trim() || defaultStoreId : defaultStoreId;
    const period = mapping.period ? String(row[mapping.period] ?? '').trim() || defaultPeriod : defaultPeriod;
    const unitsSold = mapping.unitsSold ? Number(row[mapping.unitsSold]) || 0 : 0;
    const revenueUsd = mapping.revenueUsd
      ? Number(row[mapping.revenueUsd]) || 0
      : Number((unitsSold * (sku.priceUsd ?? 0)).toFixed(2));

    matched.push({
      skuId: sku.skuId,
      storeId,
      period,
      unitsSold,
      revenueUsd,
      marginUsd: null,
      synthetic: false,
    });
  });

  return { matched, unmatched };
}
