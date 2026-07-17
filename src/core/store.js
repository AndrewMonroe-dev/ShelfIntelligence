import { bus } from './bus.js';
import { jsonAdapter } from '../data/adapters/jsonAdapter.js';
import { loadPersistedState, savePersistedState, clearPersistedState } from './persistence.js';
import { seedSectionAllocation } from '../optimize/allocationSeed.js';

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
  sectionAllocations: {}, // storeId -> [{ key, label, order, startFt, widthFt }]
  shelfLayoutOverrides: {}, // storeId -> shelfLayout snapshot (fixture edits, incl. built-in stores)
  overrides: {}, // storeId -> [{ id, skuId, action: 'place'|'remove', sectionKey, shelfPosition, facings }]
  caseOnlyMode: false, // global toggle: 750ml facing floor 1 -> 2
  customStores: [], // stores added via Store Builder's "+ Add Store" flow
  activeStoreId: null, // last store picked in ANY store-scoped page (Set Layout, Optimization Engine, Planogram Viewer, Set Overview, Digital Twin) -- shared so switching pages keeps you on the same set instead of resetting to the first store
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

export function getSectionAllocations(storeId) {
  return state.sectionAllocations[storeId] || [];
}

export function setSectionAllocations(storeId, allocations) {
  state.sectionAllocations[storeId] = allocations;
  bus.emit('allocation:changed', { storeId, allocations });
  persist();
}

// One-time seed for a store with no persisted allocation yet -- scores
// sections by opportunity and apportions the fixture's physical width
// directly in feet (see src/optimize/allocationSeed.js). Not called on
// every plan generation, only when a store has nothing saved.
export function autoAllocateSections(storeId) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  if (!targetStore) return [];
  const targetSkuCount = getTargetSkuCount(storeId);
  const allocations = seedSectionAllocation(targetStore, state.skus, state.metricsConfig, targetSkuCount, state.sizePackage);
  setSectionAllocations(storeId, allocations);
  return allocations;
}

export function getOverrides(storeId) {
  return state.overrides[storeId] || [];
}

// Manual placement/removal always wins over the AI recommendation -- one
// active override per SKU per store, so placing a SKU somewhere new
// supersedes any earlier override for that same SKU.
export function addOverride(storeId, override) {
  const existing = state.overrides[storeId] || [];
  const id = `override-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const next = [...existing.filter((o) => o.skuId !== override.skuId), { id, ...override }];
  state.overrides[storeId] = next;
  bus.emit('overrides:changed', { storeId });
  persist();
}

export function removeOverride(storeId, overrideId) {
  const existing = state.overrides[storeId] || [];
  state.overrides[storeId] = existing.filter((o) => o.id !== overrideId);
  bus.emit('overrides:changed', { storeId });
  persist();
}

export function clearOverrides(storeId) {
  state.overrides[storeId] = [];
  bus.emit('overrides:changed', { storeId });
  persist();
}

export function getActiveStoreId() {
  return state.activeStoreId;
}

export function setActiveStoreId(storeId) {
  state.activeStoreId = storeId;
  bus.emit('activeStore:changed', storeId);
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

// Builds one bay's shelf array -- no real per-shelf traffic data exists for
// a synthesized bay, so it's mostly medium traffic with the middle shelf
// marked high, so existing shelf-position/traffic logic works unchanged.
// Shared by store creation and later fixture edits (add bay / change a
// bay's shelf count) so a bay is built identically either way.
function buildBayShelves(bayId, shelfCount) {
  const count = Math.max(1, Math.round(shelfCount));
  const middleIndex = Math.floor((count - 1) / 2);
  return Array.from({ length: count }, (_, i) => ({
    shelfId: `${bayId}-S${i + 1}`,
    eyeLevel: i === middleIndex,
    traffic: i === middleIndex ? 'high' : 'medium',
  }));
}

function synthesizeShelfLayout(bayCount, shelfCountPerBay) {
  const count = Math.max(1, Math.round(shelfCountPerBay));
  const bays = Array.from({ length: Math.max(1, Math.round(bayCount)) }, (_, b) => {
    const bayId = `B${b + 1}`;
    return { bayId, shelfCount: count, shelves: buildBayShelves(bayId, count) };
  });
  return { bays };
}

function persistShelfLayout(storeId, shelfLayout) {
  state.shelfLayoutOverrides[storeId] = shelfLayout;
  persist();
}

export function addBay(storeId) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  if (!targetStore) return;
  const bays = targetStore.shelfLayout.bays;
  const lastBay = bays[bays.length - 1];
  const shelfCount = lastBay ? lastBay.shelfCount : 5;
  const bayId = `B${bays.length + 1}`;
  bays.push({ bayId, shelfCount, shelves: buildBayShelves(bayId, shelfCount) });
  bus.emit('fixture:changed', { storeId });
  persistShelfLayout(storeId, targetStore.shelfLayout);
}

export function removeBay(storeId) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  if (!targetStore || targetStore.shelfLayout.bays.length <= 1) return;
  targetStore.shelfLayout.bays.pop();
  bus.emit('fixture:changed', { storeId });
  persistShelfLayout(storeId, targetStore.shelfLayout);
}

export function setBayShelfCount(storeId, bayId, shelfCount) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  const bay = targetStore?.shelfLayout.bays.find((b) => b.bayId === bayId);
  if (!bay) return;
  bay.shelfCount = Math.max(1, Math.round(shelfCount));
  bay.shelves = buildBayShelves(bayId, bay.shelfCount);
  bus.emit('fixture:changed', { storeId });
  persistShelfLayout(storeId, targetStore.shelfLayout);
}

export function addStore({ name, bayCount, shelvesPerBay, qualityScore }) {
  const storeId = `CUSTOM-${Date.now()}`;
  const newStore = {
    storeId,
    name,
    storeType: 'Custom',
    region: 'Unspecified',
    demographics: {},
    shelfLayout: synthesizeShelfLayout(bayCount, shelvesPerBay),
    qualityScore, // -1 (budget) .. 0 (neutral) .. +1 (high-end), biases Price Point Strength for this store's plan
    isCustom: true,
  };
  state.stores = [...state.stores, newStore];
  state.customStores = [...state.customStores, newStore];
  bus.emit('stores:changed', newStore);
  persist();
  return newStore;
}

export function removeStore(storeId) {
  const target = state.stores.find((s) => s.storeId === storeId);
  if (!target || !target.isCustom) return;

  state.stores = state.stores.filter((s) => s.storeId !== storeId);
  state.customStores = state.customStores.filter((s) => s.storeId !== storeId);
  delete state.targetSkuCounts[storeId];
  delete state.sectionMultipliers[storeId];
  delete state.sectionAllocations[storeId];
  delete state.shelfLayoutOverrides[storeId];
  delete state.overrides[storeId];

  bus.emit('stores:changed', { removed: storeId });
  persist();
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
  if (persisted.sectionAllocations) state.sectionAllocations = persisted.sectionAllocations;
  if (persisted.shelfLayoutOverrides) state.shelfLayoutOverrides = persisted.shelfLayoutOverrides;
  if (persisted.overrides) state.overrides = persisted.overrides;
  if (persisted.activeScenarioId) state.activeScenarioId = persisted.activeScenarioId;
  if (persisted.activeStoreId) state.activeStoreId = persisted.activeStoreId;
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

  const hasValidBays = (shelfLayout) => Array.isArray(shelfLayout?.bays) && shelfLayout.bays.length > 0;

  if (persisted.customStores?.length) {
    // Backfill shelfLayout on any custom store saved before that field
    // existed, or saved with a malformed/empty `bays` array -- without
    // this, a legacy/corrupted localStorage record crashes every
    // downstream getPhysicalWidthFt call (Store Builder, Optimization
    // Engine, etc.) on load, with no recovery.
    state.customStores = persisted.customStores.map((s) =>
      hasValidBays(s.shelfLayout) ? s : { ...s, shelfLayout: synthesizeShelfLayout(6, 5) }
    );
    state.stores = [...state.stores, ...state.customStores];
  }

  // Applied last, after all stores (built-in + custom) are in state.stores,
  // so fixture edits to EITHER kind of store survive a reload. Skips a
  // corrupted override (missing/empty `bays`) instead of blindly
  // overwriting an otherwise-valid shelfLayout with it.
  Object.entries(state.shelfLayoutOverrides).forEach(([storeId, shelfLayout]) => {
    if (!hasValidBays(shelfLayout)) return;
    const targetStore = state.stores.find((s) => s.storeId === storeId);
    if (targetStore) targetStore.shelfLayout = shelfLayout;
  });
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
  getSectionAllocations,
  setSectionAllocations,
  autoAllocateSections,
  addBay,
  removeBay,
  setBayShelfCount,
  getOverrides,
  addOverride,
  removeOverride,
  clearOverrides,
  getCaseOnlyMode,
  setCaseOnlyMode,
  getActiveStoreId,
  setActiveStoreId,
  addStore,
  removeStore,
  resetPersistedState,
};
