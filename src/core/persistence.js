// Session persistence via localStorage. Without this, every dial the user
// turns (metric weights, SKU counts, section multipliers, imported sales)
// vanishes on reload -- directly against the "nothing hardcoded, everything
// malleable" principle if it doesn't survive a refresh. Only persists
// user-made overrides, never the base fixture data (data/*.json stays the
// source of truth for everything not explicitly overridden).

const STORAGE_KEY = 'shelfIntelligence.v1';

function safeParse(json, fallback) {
  try {
    return JSON.parse(json) ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadPersistedState() {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return safeParse(raw, null);
}

export function savePersistedState(state) {
  if (typeof localStorage === 'undefined') return;
  const payload = {
    targetSkuCounts: state.targetSkuCounts,
    sectionMultipliers: state.sectionMultipliers,
    sectionShelfCounts: state.sectionShelfCounts,
    metricOverrides: state.metricsConfig.map((m) => ({ id: m.id, enabled: m.enabled, weight: m.weight })),
    activeScenarioId: state.activeScenarioId,
    importedSales: state.sales.filter((r) => !r.synthetic),
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function clearPersistedState() {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function estimateStorageSizeKb() {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return raw ? (raw.length / 1024).toFixed(1) : '0';
}
