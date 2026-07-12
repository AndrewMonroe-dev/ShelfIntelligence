const BASE = new URL('../../../data/', import.meta.url);

async function fetchJson(filename) {
  const res = await fetch(new URL(filename, BASE));
  if (!res.ok) throw new Error(`Failed to load ${filename}: ${res.status}`);
  return res.json();
}

export const jsonAdapter = {
  getSkus: () => fetchJson('skus.json'),
  getSales: () => fetchJson('sales.json'),
  getStores: () => fetchJson('stores.json'),
  getMetricsConfig: () => fetchJson('metrics.config.json'),
  getScenarios: () => fetchJson('scenarios.json'),
};
