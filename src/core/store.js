import { bus } from './bus.js';
import { jsonAdapter } from '../data/adapters/jsonAdapter.js';

const adapter = jsonAdapter; // swap to apiAdapter later, nothing else changes

const state = {
  skus: [],
  sales: [],
  stores: [],
  metricsConfig: [],
  scenarios: [],
  activeScenarioId: 'scenario-a',
  currentPlan: null,
  ready: false,
};

export async function hydrate() {
  const [skus, sales, stores, metricsConfig, scenarios] = await Promise.all([
    adapter.getSkus(),
    adapter.getSales(),
    adapter.getStores(),
    adapter.getMetricsConfig(),
    adapter.getScenarios(),
  ]);
  state.skus = skus;
  state.sales = sales;
  state.stores = stores;
  state.metricsConfig = metricsConfig;
  state.scenarios = scenarios;
  state.ready = true;
  bus.emit('store:hydrated', getSnapshot());
  return getSnapshot();
}

export function getSnapshot() {
  return { ...state };
}

export function setActiveScenario(scenarioId) {
  state.activeScenarioId = scenarioId;
  bus.emit('scenario:changed', scenarioId);
}

export function setMetricConfig(metricId, patch) {
  const metric = state.metricsConfig.find((m) => m.id === metricId);
  if (!metric) return;
  Object.assign(metric, patch);
  bus.emit('metrics:changed', { metricId, patch });
}

export function setPlan(plan) {
  state.currentPlan = plan;
  bus.emit('plan:updated', plan);
}

export const store = {
  hydrate,
  getSnapshot,
  setActiveScenario,
  setMetricConfig,
  setPlan,
};
