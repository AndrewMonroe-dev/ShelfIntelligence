// Future backend adapter. Same method signatures as jsonAdapter.js so
// core/store.js can swap adapters without any other module changing.
// Not wired up yet -- Phase 1 architecture placeholder only.

export const apiAdapter = {
  getSkus: () => { throw new Error('apiAdapter not implemented'); },
  getSales: () => { throw new Error('apiAdapter not implemented'); },
  getStores: () => { throw new Error('apiAdapter not implemented'); },
  getMetricsConfig: () => { throw new Error('apiAdapter not implemented'); },
  getScenarios: () => { throw new Error('apiAdapter not implemented'); },
};
