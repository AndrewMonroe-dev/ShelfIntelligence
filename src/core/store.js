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
  sizePackage: [],
  activeScenarioId: 'scenario-a',
  currentPlan: null,
  ready: false,
  targetSkuCounts: {}, // storeId -> desired total SKU count for that store's set
  sectionMultipliers: {}, // storeId -> { sectionKey -> multiplier (default 1) }
  sectionShelfCounts: {}, // storeId -> { sectionKey -> 4 | 5 (default 5) }
  caseOnlyMode: false, // global toggle: 750ml facing floor 1 -> 2
  customStores: [], // stores added via Store Builder's "+ Add Store" flow
};

const DEFAULT_TARGET_SKU_COUNT = 150;
const DEFAULT_SECTION_MULTIPLIER = 1;
const DEFAULT_SECTION_SHELF_COUNT = 5;

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

export function getSectionShelfCount(storeId, sectionKey) {
  return state.sectionShelfCounts[storeId]?.[sectionKey] ?? DEFAULT_SECTION_SHELF_COUNT;
}

export function getSectionShelfCounts(storeId) {
  return state.sectionShelfCounts[storeId] || {};
}

export function setSectionShelfCount(storeId, sectionKey, shelfCount) {
  if (!state.sectionShelfCounts[storeId]) state.sectionShelfCounts[storeId] = {};
  state.sectionShelfCounts[storeId][sectionKey] = shelfCount;
  bus.emit('section:changed', { storeId, sectionKey, shelfCount });
  persist();
}

export function getCaseOnlyMode() {
  return state.caseOnlyMode;
}

export function setCaseOnlyMode(value) {
  state.caseOnlyMode = value;
  bus.emit('caseOnly:changed', value);
  persist();
}

// Synthesizes a default shelf layout from just an average shelf count, for
// stores created via the "+ Add Store" flow (no real per-shelf traffic data
// exists for a brand-new store) -- mostly medium traffic, the middle shelf
// marked high, so existing shelf-position/traffic logic works unchanged.
function synthesizeShelfLayout(avgShelfCount, totalLinearFeet) {
  const count = Math.max(1, Math.round(avgShelfCount));
  const middleIndex = Math.floor((count - 1) / 2);
  const shelves = Array.from({ length: count }, (_, i) => ({
    shelfId: `S${i + 1}`,
    linearFeet: totalLinearFeet,
    eyeLevel: i === middleIndex,
    traffic: i === middleIndex ? 'high' : 'medium',
  }));
  return { shelves, totalLinearFeet };
}

export function addStore({ name, totalLinearFeet, avgShelfCount, qualityScore }) {
  const storeId = `CUSTOM-${Date.now()}`;
  const newStore = {
    storeId,
    name,
    storeType: 'Custom',
    region: 'Unspecified',
    demographics: {},
    shelfLayout: synthesizeShelfLayout(avgShelfCount, totalLinearFeet),
    qualityScore, // -1 (budget) .. 0 (neutral) .. +1 (high-end), biases Price Point Strength for this store's plan
    isCustom: true,
  };
  state.stores = [...state.stores, newStore];
  state.customStores = [...state.customStores, newStore];
  bus.emit('stores:changed', newStore);
  persist();
  return newStore;
}

export async function hydrate() {
  const [skus, sales, stores, metricsConfig, scenarios, bottleDimensions, sizePackage] = await Promise.all([
    adapter.getSkus(),
    adapter.getSales(),
    adapter.getStores(),
    adapter.getMetricsConfig(),
    adapter.getScenarios(),
    adapter.getBottleDimensions(),
    adapter.getSizePackage(),
  ]);
  state.skus = skus;
  state.sales = sales;
  state.stores = stores;
  state.metricsConfig = metricsConfig;
  state.scenarios = scenarios;
  state.bottleDimensions = bottleDimensions;
  state.sizePackage = sizePackage;

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
  if (persisted.sectionShelfCounts) state.sectionShelfCounts = persisted.sectionShelfCounts;
  if (persisted.activeScenarioId) state.activeScenarioId = persisted.activeScenarioId;
  if (typeof persisted.caseOnlyMode === 'boolean') state.caseOnlyMode = persisted.caseOnlyMode;

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

  if (persisted.customStores?.length) {
    state.customStores = persisted.customStores;
    state.stores = [...state.stores, ...persisted.customStores];
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
  getSectionShelfCount,
  getSectionShelfCounts,
  setSectionShelfCount,
  getCaseOnlyMode,
  setCaseOnlyMode,
  addStore,
  resetPersistedState,
};
