import { bus } from './bus.js';
import { jsonAdapter } from '../data/adapters/jsonAdapter.js';
import { loadPersistedState, savePersistedState, clearPersistedState } from './persistence.js';

const adapter = jsonAdapter; // swap to apiAdapter later, nothing else changes

const state = {
  skus: [],
  sales: [],
  stores: [],
  metricsConfig: [],
  scenarios: [],
  bottleDimensions: [],
  activeScenarioId: 'scenario-a',
  currentPlan: null,
  ready: false,
  targetSkuCounts: {}, // storeId -> desired total SKU count for that store's set
  sectionMultipliers: {}, // storeId -> { sectionKey -> multiplier (default 1) }
};

const DEFAULT_TARGET_SKU_COUNT = 150;
const DEFAULT_SECTION_MULTIPLIER = 1;

function persist() {
  savePersistedState(state);
}

export function getTargetSkuCount(storeId) {
  return state.targetSkuCounts[storeId] ?? DEFAULT_TARGET_SKU_COUNT;
}

export function getSectionMultiplier(storeId, sectionKey) {
  return state.sectionMultipliers[storeId]?.[sectionKey] ?? DEFAULT_SECTION_MULTIPLIER;
}

export function getSectionMultipliers(storeId) {
  return state.sectionMultipliers[storeId] || {};
}

export function setSectionMultiplier(storeId, sectionKey, multiplier) {
  if (!state.sectionMultipliers[storeId]) state.sectionMultipliers[storeId] = {};
  state.sectionMultipliers[storeId][sectionKey] = multiplier;
  bus.emit('section:changed', { storeId, sectionKey, multiplier });
  persist();
}

export async function hydrate() {
  const [skus, sales, stores, metricsConfig, scenarios, bottleDimensions] = await Promise.all([
    adapter.getSkus(),
    adapter.getSales(),
    adapter.getStores(),
    adapter.getMetricsConfig(),
    adapter.getScenarios(),
    adapter.getBottleDimensions(),
  ]);
  state.skus = skus;
  state.sales = sales;
  state.stores = stores;
  state.metricsConfig = metricsConfig;
  state.scenarios = scenarios;
  state.bottleDimensions = bottleDimensions;

  applyPersistedOverrides();

  state.ready = true;
  bus.emit('store:hydrated', getSnapshot());
  return getSnapshot();
}

function applyPersistedOverrides() {
  const persisted = loadPersistedState();
  if (!persisted) return;

  if (persisted.targetSkuCounts) state.targetSkuCounts = persisted.targetSkuCounts;
  if (persisted.sectionMultipliers) state.sectionMultipliers = persisted.sectionMultipliers;
  if (persisted.activeScenarioId) state.activeScenarioId = persisted.activeScenarioId;

  if (persisted.metricOverrides) {
    persisted.metricOverrides.forEach((override) => {
      const metric = state.metricsConfig.find((m) => m.id === override.id);
      if (metric) {
        metric.enabled = override.enabled;
        metric.weight = override.weight;
      }
    });
  }

  if (persisted.importedSales?.length) {
    state.sales = [...state.sales, ...persisted.importedSales];
  }
}

export function getSnapshot() {
  return { ...state };
}

export function setActiveScenario(scenarioId) {
  state.activeScenarioId = scenarioId;
  bus.emit('scenario:changed', scenarioId);
  persist();
}

export function setMetricConfig(metricId, patch) {
  const metric = state.metricsConfig.find((m) => m.id === metricId);
  if (!metric) return;
  Object.assign(metric, patch);
  bus.emit('metrics:changed', { metricId, patch });
  persist();
}

export function setPlan(plan) {
  state.currentPlan = plan;
  bus.emit('plan:updated', plan);
}

export function importSales(rows, { replace }) {
  state.sales = replace ? rows : [...state.sales, ...rows];
  bus.emit('sales:imported', { count: rows.length, replace, total: state.sales.length });
  persist();
}

export function setTargetSkuCount(storeId, count) {
  state.targetSkuCounts[storeId] = count;
  bus.emit('assortment:changed', { storeId, count });
  persist();
}

export function resetPersistedState() {
  clearPersistedState();
  bus.emit('state:reset');
}

export const store = {
  hydrate,
  getSnapshot,
  setActiveScenario,
  setMetricConfig,
  setPlan,
  importSales,
  getTargetSkuCount,
  setTargetSkuCount,
  getSectionMultiplier,
  getSectionMultipliers,
  setSectionMultiplier,
  resetPersistedState,
};
