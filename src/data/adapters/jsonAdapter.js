import { applyCurationRules } from '../curationRules.js?v=20260805';

const BASE = new URL('../../../data/', import.meta.url);
// Andrew, 2026-08-05: same cache-busting marker as index.html's asset tags
// and every internal module import (see docs/ARCHITECTURE.md) -- data
// files are fetch()ed at runtime, same staleness exposure as the JS/CSS.
const CACHE_BUST = '20260805';

async function fetchJson(filename) {
  const url = new URL(filename, BASE);
  url.searchParams.set('v', CACHE_BUST);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${filename}: ${res.status}`);
  return res.json();
}

// Andrew, 2026-07-23: curationRules.json is applied here, automatically,
// every time the app loads -- not a manual step, not an offline script.
// Whatever skus.json contains (a stale snapshot or a brand-new export)
// always gets the same manual corrections layered on top. See
// src/data/curationRules.js for what each rule category does.
async function getCuratedSkus() {
  const [skus, rules] = await Promise.all([
    fetchJson('skus.json'),
    fetchJson('curationRules.json'),
  ]);
  return applyCurationRules(skus, rules);
}

export const jsonAdapter = {
  getSkus: () => getCuratedSkus(),
  getSales: () => fetchJson('sales.json'),
  getStores: () => fetchJson('stores.json'),
  getMetricsConfig: () => fetchJson('metrics.config.json'),
  getScenarios: () => fetchJson('scenarios.json'),
  getBottleDimensions: () => fetchJson('bottleDimensions.json'),
  getSizePackage: () => fetchJson('market/size_package.json'),
};
