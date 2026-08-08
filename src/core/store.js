import { bus } from './bus.js?v=20260808';
import { jsonAdapter } from '../data/adapters/jsonAdapter.js?v=20260808';
import { loadPersistedState, savePersistedState, clearPersistedState } from './persistence.js?v=20260808';
import { seedSectionAllocation } from '../optimize/allocationSeed.js?v=20260808';
import { generatePlan } from '../optimize/placementSolver.js?v=20260808';

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
  currentPlanVersions: null, // { global, store } snapshot -- see setPlan/isPlanStale
  // Andrew, 2026-08-07: two separate version counters, bumped by every
  // setter that feeds generatePlan()'s inputs. globalPlanInputsVersion is
  // for inputs that affect EVERY store identically (metric weight/enabled
  // changes -- originally the only thing tracked here, 2026-08-04 -- and
  // case-only mode, both genuinely global toggles). storePlanInputsVersion
  // is PER-STORE (Set Layout's section allocations, target SKU count,
  // section multipliers, physical fixture edits) -- caught via live testing
  // that a single global counter was wrong for these: auto-seeding one
  // store's allocations (e.g. Store Builder rendering every card) was
  // incorrectly marking every OTHER store's plan/bayLayout stale too, since
  // they all shared one counter. Overrides are deliberately NOT tracked at
  // all -- they're already kept in sync via the bayLayout dual-write, and
  // counting them would false-fire staleness on every routine manual edit.
  globalPlanInputsVersion: 0,
  storePlanInputsVersion: {},
  ready: false,
  targetSkuCounts: {}, // storeId -> desired total SKU count for that store's set
  sectionMultipliers: {}, // storeId -> { sectionKey -> multiplier (default 1) }
  sectionAllocations: {}, // storeId -> [{ key, label, order, startFt, widthFt }]
  shelfLayoutOverrides: {}, // storeId -> shelfLayout snapshot (fixture edits, incl. built-in stores)
  overrides: {}, // storeId -> [{ id, skuId, action: 'place'|'remove', sectionKey, shelfPosition, facings }]
  caseOnlyMode: false, // global toggle: 750ml facing floor 1 -> 2
  // Andrew, 2026-07-26 (bay-locked rebuild): storeId -> COMPACT bay layout,
  // the Planogram Viewer's persistent render+edit truth. Compact = per
  // (bayIndex, shelfPosition) an ordered list of { skuId, facings, isLocked }
  // plus empty-slot markers { empty: true, widthInches } -- small enough for
  // localStorage; planogramViewer.js rehydrates full entries (brand,
  // varietal, price, etc.) from the SKU master + scoreMap on load, and
  // re-compacts after every edit before calling setBayLayout. Materialized
  // once per store (from a generated plan) and then only mutated directly --
  // never re-derived on a routine render -- so a manual bay arrangement
  // survives reloads and other pages regenerating plan.sections. Only an
  // explicit Regenerate/Reset action replaces it.
  bayLayouts: {},
  // Andrew, 2026-08-07: storeId -> { global, store } version snapshot at the
  // moment this store's bayLayout was last fully materialized or resynced
  // (Reset All to AI) -- see isBayLayoutStale below for why this can't just
  // reuse currentPlan/currentPlanVersions directly.
  bayLayoutSyncedVersion: {},
  customStores: [], // stores added via Store Builder's "+ Add Store" flow
  // Andrew, 2026-08-07: SKUs added via the SKU Generator tab -- merged into
  // state.skus on hydrate (see applyPersistedOverrides), same pattern as
  // customStores merging into state.stores. A generated SKU is otherwise
  // indistinguishable from a real one everywhere downstream (scoring,
  // sections, placement, Planogram Viewer) -- any field left blank just
  // means that metric skips this SKU (see calc/metricRegistry.js), same as
  // a real SKU with incomplete source data.
  generatedSkus: [],
  activeStoreId: null, // last store picked in ANY store-scoped page (Set Layout, Optimization Engine, Planogram Viewer, Set Overview, Digital Twin) -- shared so switching pages keeps you on the same set instead of resetting to the first store
};

const DEFAULT_TARGET_SKU_COUNT = 150;
const DEFAULT_SECTION_MULTIPLIER = 1;

function persist() {
  savePersistedState(state);
}

// Bumps the per-store plan-inputs counter for a setter scoped to one store
// (Set Layout allocations, target SKU count, section multipliers, fixture
// edits) -- see globalPlanInputsVersion/storePlanInputsVersion's comment on
// state for why these must stay separate from the global counter.
function bumpStoreVersion(storeId) {
  state.storePlanInputsVersion[storeId] = (state.storePlanInputsVersion[storeId] || 0) + 1;
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
  bumpStoreVersion(storeId);
  bus.emit('section:changed', { storeId, sectionKey, multiplier });
  persist();
}

export function getSectionAllocations(storeId) {
  return state.sectionAllocations[storeId] || [];
}

export function setSectionAllocations(storeId, allocations) {
  state.sectionAllocations[storeId] = allocations;
  bumpStoreVersion(storeId);
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

// Andrew, 2026-07-26: replace the whole override list at once -- used for
// transactional rollback in Editing Mode, where a drag/swap saves its
// overrides up front but must be able to cleanly undo them if the in-place
// patch can't be applied (rather than leaving a half-applied edit persisted
// and falling back to a destructive full regeneration).
export function setOverrides(storeId, overrides) {
  state.overrides[storeId] = overrides.map((o) => ({ ...o }));
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
  state.globalPlanInputsVersion += 1;
  bus.emit('caseOnly:changed', value);
  persist();
}

export function getBayLayout(storeId) {
  return state.bayLayouts[storeId] || null;
}

// `compactLayout` is already in the small persisted shape (see state.bayLayouts
// above) -- planogramViewer.js does the full<->compact conversion since it
// owns the SKU/scoreMap context needed to hydrate a full entry back out.
export function setBayLayout(storeId, compactLayout) {
  state.bayLayouts[storeId] = compactLayout;
  bus.emit('bayLayout:changed', { storeId });
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
  bumpStoreVersion(storeId);
  bus.emit('fixture:changed', { storeId });
  persistShelfLayout(storeId, targetStore.shelfLayout);
}

export function removeBay(storeId) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  if (!targetStore || targetStore.shelfLayout.bays.length <= 1) return;
  targetStore.shelfLayout.bays.pop();
  bumpStoreVersion(storeId);
  bus.emit('fixture:changed', { storeId });
  persistShelfLayout(storeId, targetStore.shelfLayout);
}

export function setBayShelfCount(storeId, bayId, shelfCount) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  const bay = targetStore?.shelfLayout.bays.find((b) => b.bayId === bayId);
  if (!bay) return;
  bay.shelfCount = Math.max(1, Math.round(shelfCount));
  bay.shelves = buildBayShelves(bayId, bay.shelfCount);
  bumpStoreVersion(storeId);
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
  delete state.bayLayouts[storeId];
  delete state.bayLayoutSyncedVersion[storeId];

  bus.emit('stores:changed', { removed: storeId });
  persist();
}

// Andrew, 2026-08-07 (SKU Generator): builds a real SKU record from
// whatever the form actually had filled in. Only skuId is ever guaranteed
// -- every other field is optional and left undefined when blank rather
// than defaulted to a guessed value, so scoring/sections/placement treat a
// sparse generated SKU exactly like a real SKU with incomplete source data
// (see metricRegistry.js's null-skipping, not a special case here).
export function addGeneratedSku(input) {
  const skuId = `GEN-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const newSku = {
    skuId,
    brand: str(input.brand) || 'UNKNOWN',
    varietal: str(input.varietal),
    region: str(input.region),
    bottleSizeRaw: str(input.bottleSizeRaw),
    upc: str(input.upc),
    priceUsd: num(input.priceUsd),
    sales9L: num(input.sales9L),
    growthPct9L: num(input.growthPct9L),
    podsDistribution: num(input.podsDistribution),
    strategicSupplierPriority: input.strategicSupplierPriority === true,
    isGenerated: true, // flags this as SKU-Generator-created, for the tab's own list/delete UI
  };
  state.generatedSkus = [...state.generatedSkus, newSku];
  state.skus = [...state.skus, newSku];
  bus.emit('skus:changed', newSku);
  persist();
  return newSku;
}

export function removeGeneratedSku(skuId) {
  state.generatedSkus = state.generatedSkus.filter((s) => s.skuId !== skuId);
  state.skus = state.skus.filter((s) => s.skuId !== skuId);
  bus.emit('skus:changed', { removed: skuId });
  persist();
}

export function getGeneratedSkus() {
  return state.generatedSkus;
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
  if (persisted.bayLayouts) state.bayLayouts = persisted.bayLayouts;

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

  if (persisted.generatedSkus?.length) {
    state.generatedSkus = persisted.generatedSkus;
    state.skus = [...state.skus, ...state.generatedSkus];
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
  state.globalPlanInputsVersion += 1;
  bus.emit('metrics:changed', { metricId, patch });
  persist();
}

function currentVersionsFor(storeId) {
  return { global: state.globalPlanInputsVersion, store: state.storePlanInputsVersion[storeId] || 0 };
}

function versionsMatch(a, b) {
  return a.global === b.global && a.store === b.store;
}

export function setPlan(plan) {
  state.currentPlan = plan;
  state.currentPlanVersions = currentVersionsFor(plan.storeId);
  bus.emit('plan:updated', plan);
}

// True once any plan-generation input (metric weights, Set Layout section
// allocations, target SKU count, section multipliers, case-only mode, or
// physical fixture edits) has changed since currentPlan was generated for
// ITS OWN store -- the plan still reflects the OLD inputs until something
// regenerates it. Compares two separate counters (see
// globalPlanInputsVersion/storePlanInputsVersion on state) so a change to a
// DIFFERENT store's allocations/target count/fixture never falsely flags
// this plan as stale -- only a genuinely global change (metric weights,
// case-only mode) or a change to this plan's OWN store does.
export function isPlanStale() {
  return !!state.currentPlan && !versionsMatch(state.currentPlanVersions, currentVersionsFor(state.currentPlan.storeId));
}

// Andrew, 2026-08-07: found via live testing while broadening isPlanStale --
// a SEPARATE, per-store tracker for Planogram Viewer specifically. Reusing
// isPlanStale() directly seemed right at first but is wrong: the moment
// Optimization Engine/Set Overview/Reports auto-regenerate (which they now
// do freely, since currentPlan is safe to silently refresh), setPlan() syncs
// currentPlanVersions to the current versions for EVERYONE reading
// currentPlan -- clearing isPlanStale() even though Planogram Viewer's own
// bayLayout for THIS store was never touched and is still built from the old
// inputs. bayLayoutSyncedVersion (state field above) records the version
// pair that was true at the moment THIS store's bayLayout was last fully
// materialized (first load) or resynced (Reset All to AI) -- not bumped by
// routine manual edits (facing +/-, drag, add SKU), which don't change
// plan-generation inputs and shouldn't mask real staleness.
export function markBayLayoutSynced(storeId) {
  state.bayLayoutSyncedVersion[storeId] = currentVersionsFor(storeId);
}

export function isBayLayoutStale(storeId) {
  const synced = state.bayLayoutSyncedVersion[storeId];
  return !!synced && !versionsMatch(synced, currentVersionsFor(storeId));
}

// Andrew, 2026-08-07: single shared implementation of "read every current
// plan-generation input for this store and produce+store a fresh plan" --
// previously copy-pasted identically in optimizationEngine.js,
// planogramViewer.js, and setOverview.js. Optimization Engine/Set
// Overview/Reports call this whenever their plan is missing or isPlanStale()
// (safe -- currentPlan is a pure derived structure, nothing hand-edited
// lives on it directly). Planogram Viewer also calls this, but only from its
// own explicit "Reset All to AI" action -- its bayLayout is real user state
// (manual placements) that must never be silently regenerated out from under
// someone, per the 2026-07-31 bay-locked rebuild.
export function regeneratePlan(storeId) {
  const targetStore = state.stores.find((s) => s.storeId === storeId);
  if (!targetStore) return null;
  const targetCount = getTargetSkuCount(storeId);
  const multipliers = getSectionMultipliers(storeId);
  let allocations = getSectionAllocations(storeId);
  if (!allocations.length) allocations = autoAllocateSections(storeId);
  const overrides = getOverrides(storeId);
  const plan = generatePlan(
    targetStore, state.skus, state.metricsConfig, targetCount, state.bottleDimensions,
    allocations, multipliers, state.sizePackage, state.caseOnlyMode, overrides
  );
  setPlan(plan);
  return plan;
}

export function importSales(rows, { replace }) {
  state.sales = replace ? rows : [...state.sales, ...rows];
  bus.emit('sales:imported', { count: rows.length, replace, total: state.sales.length });
  persist();
}

export function setTargetSkuCount(storeId, count) {
  state.targetSkuCounts[storeId] = count;
  bumpStoreVersion(storeId);
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
  isPlanStale,
  regeneratePlan,
  markBayLayoutSynced,
  isBayLayoutStale,
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
  setOverrides,
  getCaseOnlyMode,
  setCaseOnlyMode,
  getBayLayout,
  setBayLayout,
  getActiveStoreId,
  setActiveStoreId,
  addStore,
  removeStore,
  addGeneratedSku,
  removeGeneratedSku,
  getGeneratedSkus,
  resetPersistedState,
};
