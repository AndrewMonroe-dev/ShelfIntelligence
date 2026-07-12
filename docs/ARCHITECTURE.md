# Shelf Intelligence™ — Architecture Document

Status: DRAFT — awaiting approval before Phase 3 (UI shell) implementation begins.
Deployment target: GitHub Pages (static). Stack: HTML5, CSS3, vanilla JS (ES6 modules), JSON.

---

## 1. Visual Design System (derived from MacBane)

Source: https://andrewmonroe-dev.github.io/MacBane/ (single-file `index.html`, inline CSS).
Shelf Intelligence adopts this system as-is, extended with a few enterprise-scale additions noted below.

### 1.1 Color tokens
```css
:root{
  --bg:#0A0B0F;
  --panel:#131722;
  --panel2:#1A1F2D;
  --border:rgba(255,255,255,.05);
  --border-strong:rgba(255,255,255,.09);
  --blue:#3B82F6;
  --cyan:#06B6D4;
  --success:#10B981;
  --warning:#F59E0B;
  --danger:#EF4444;
  --text:#FFFFFF;
  --text2:#94A3B8;
  --text3:#5B6677;
}
```
Extensions needed for Shelf Intelligence (not in MacBane, added for category-management domain):
```css
  --premium:#C9A227;   /* premium tier / gold accent for shelf premium placement */
  --heat-low:#1A1F2D;  /* heat map gradient stops, reuses panel as cold end */
  --heat-high:#EF4444; /* heat map gradient hot end, reuses --danger */
```

### 1.2 Typography
- Primary: `'Inter', system-ui, sans-serif`
- Monospace (numbers/KPIs): `'JetBrains Mono', monospace`
- KPI values: `28px / 700 / letter-spacing:-.5px`, monospace

### 1.3 Surfaces
- Cards: `linear-gradient(160deg,var(--panel) 0%, var(--panel2) 130%)`, `border:1px solid var(--border)`, `border-radius:14px`, hover border tints blue, radial-gradient spotlight follows cursor (`--mx`/`--my`).
- Shadows: default `0 1px 2px rgba(0,0,0,.25), 0 12px 32px -24px rgba(0,0,0,.7)`; hover adds blue-tinted glow.
- Border radius scale: 6/8px small, 10px medium, 14/16px large, 20/24px badges/hero.

### 1.4 Motion
- Standard easing: `cubic-bezier(.22,.68,.31,1)`
- Transition durations: `.15s`–`.35s ease`
- Respect `prefers-reduced-motion: reduce` (disable all animation/transition).

### 1.5 Navigation
- Fixed left sidebar (`#sidebar`), icon + label nav items, active state = blue-tinted background + left pip bar with `navpip` scale-in animation.

This token set lives in one file — `assets/css/tokens.css` — imported first by every page, so a rebrand or theme change touches one place.

---

## 2. The Five Intelligence Layers → Module Map

| Layer | Responsibility | Primary modules |
|---|---|---|
| 1. Data Intelligence | Store/normalize SKUs, sales history, store profiles, market trends | `data/skuStore.js`, `data/salesStore.js`, `data/storeStore.js`, `data/marketStore.js` |
| 2. Calculation Intelligence | Turn raw metrics into weighted, normalized opportunity scores | `calc/metricRegistry.js`, `calc/normalize.js`, `calc/scoreEngine.js` |
| 3. Optimization Intelligence | Decide assortment, facings, blocking, placement given scores + constraints | `optimize/assortment.js`, `optimize/facings.js`, `optimize/blocking.js`, `optimize/placementSolver.js` |
| 4. Visualization Intelligence | Render shelves, bottles, heat maps, overlays | `viz/planogramRenderer.js`, `viz/heatmap.js`, `viz/bottleSprite.js` |
| 5. Simulation Intelligence | Digital twin, scenario comparison, before/after prediction | `sim/digitalTwin.js`, `sim/scenarioEngine.js`, `sim/predictor.js` |

All five layers communicate only through a central **event bus** (`core/bus.js`) and a **normalized data store** (`core/store.js`, an in-memory reactive object backed by JSON — see §5). No module reaches into another module's internals directly. This is the seam that lets the JSON-file backend be swapped for a real API later without touching layers 2–5.

---

## 3. Folder Structure

```
ShelfIntelligence/
├── index.html                  # app shell: sidebar + router mount point
├── docs/
│   └── ARCHITECTURE.md         # this file
├── assets/
│   ├── css/
│   │   ├── tokens.css          # MacBane-derived design tokens (§1)
│   │   ├── layout.css          # grid, sidebar, page shell
│   │   ├── components.css      # card, btn, tab, input, progress, badge
│   │   └── planogram.css       # shelf/bottle-specific visual styles
│   ├── images/
│   │   └── skus/                # 000481.png, 000482.png ... (SKU ID filenames)
│   │       └── _placeholder.png # used when a SKU image is missing
│   └── icons/                  # nav + UI iconography (svg)
├── src/
│   ├── core/
│   │   ├── bus.js              # pub/sub event bus, the only cross-module channel
│   │   ├── store.js            # in-memory reactive state, hydrated from /data
│   │   ├── router.js           # hash-based router (#dashboard, #sku-database, ...)
│   │   └── idFactory.js        # permanent SKU ID generation/validation
│   ├── data/
│   │   ├── skuStore.js         # CRUD over SKU records
│   │   ├── salesStore.js       # sales history ingestion + query
│   │   ├── storeStore.js       # retail account / store profile records
│   │   ├── marketStore.js      # regional/varietal/trend reference data
│   │   └── adapters/
│   │       ├── jsonAdapter.js  # current: fetch() static JSON files
│   │       └── apiAdapter.js   # future: REST/GraphQL, same interface as jsonAdapter
│   ├── calc/
│   │   ├── metricRegistry.js   # metric definitions: enabled/weight/threshold/etc (§6)
│   │   ├── normalize.js        # min-max / z-score normalization utilities
│   │   └── scoreEngine.js      # combines enabled metrics -> SKU opportunity score
│   ├── optimize/
│   │   ├── assortment.js       # which SKUs make the set, given store constraints
│   │   ├── facings.js          # facing count allocation
│   │   ├── blocking.js         # brand/varietal blocking rules
│   │   └── placementSolver.js  # maps scored SKUs -> scored shelf positions
│   ├── sim/
│   │   ├── digitalTwin.js      # per-store before/after model
│   │   ├── scenarioEngine.js   # scenario A-E definitions + comparison
│   │   └── predictor.js        # velocity/revenue/margin projection formulas
│   ├── viz/
│   │   ├── planogramRenderer.js
│   │   ├── heatmap.js
│   │   └── bottleSprite.js     # handles missing-image fallback (never fails)
│   ├── modules/                 # one file per top-level app module (§7), each owns its page
│   │   ├── dashboard.js
│   │   ├── skuDatabase.js
│   │   ├── salesImport.js
│   │   ├── storeBuilder.js
│   │   ├── metricCenter.js
│   │   ├── planogramViewer.js
│   │   ├── scenarioManager.js
│   │   ├── reports.js
│   │   ├── settings.js
│   │   └── administration.js
│   └── app.js                  # bootstraps store, router, mounts modules
├── data/
│   ├── skus.json                # array of SKU records (§4.1)
│   ├── sales.json               # sales history records (§4.2)
│   ├── stores.json              # store profile records (§4.3)
│   ├── metrics.config.json      # Metric Control Center state (§6)
│   └── scenarios.json           # saved scenario definitions
└── tests/
    └── (unit tests for calc/ and optimize/, framework TBD at Phase 4)
```

Everything under `src/` is a plain ES module, no build step required for GitHub Pages. `data/*.json` is the "database" today; `data/adapters/apiAdapter.js` is a placeholder module with the same method signatures as `jsonAdapter.js` so swapping the backend later is a one-line change in `core/store.js`.

---

## 4. Core Data Schemas

### 4.1 SKU record (`data/skus.json`)
```json
{
  "skuId": "000481",
  "image": "/assets/images/skus/000481.png",
  "brand": "Kim Crawford",
  "supplier": "Constellation Brands",
  "winery": "Kim Crawford Wines",
  "varietal": "Sauvignon Blanc",
  "country": "New Zealand",
  "region": "Marlborough",
  "ava": null,
  "pricePoint": "Premium",
  "priceUsd": 14.99,
  "bottleSizeMl": 750,
  "bottleDimensions": { "heightMm": 300, "widthMm": 75, "depthMm": 75 },
  "marginPct": 0.28,
  "consumerSegment": "Millennial Explorer",
  "regionalImportance": "High",
  "premiumTier": "Standard",
  "seasonality": { "q1": 0.9, "q2": 1.0, "q3": 1.2, "q4": 1.1 },
  "distributionStrength": 0.82,
  "strategicSupplierPriority": false
}
```
Never referenced by name in code or IDs — `skuId` is the only stable key. Names/brands can change without breaking joins.

### 4.2 Sales record (`data/sales.json`)
```json
{
  "skuId": "000481",
  "storeId": "STORE-0091",
  "period": "2026-W27",
  "unitsSold": 42,
  "revenueUsd": 629.58,
  "marginUsd": 176.28
}
```
Sales history is stored as flat weekly (or period-configurable) fact rows — easy to aggregate into 52/104-week trends in `calc/`, easy to bulk-load from a CSV import in `salesImport.js`.

### 4.3 Store record (`data/stores.json`)
```json
{
  "storeId": "STORE-0091",
  "name": "Retailer X - Location 12",
  "storeType": "Grocery - Upscale",
  "region": "Pacific Northwest",
  "demographics": { "medianIncome": 82000, "ageBand": "35-54" },
  "shelfLayout": {
    "shelves": [
      { "shelfId": "S1", "linearFeet": 8, "eyeLevel": true, "traffic": "high" }
    ],
    "totalLinearFeet": 48
  }
}
```

### 4.4 Metric config (`data/metrics.config.json`) — see §6.

### 4.5 Shelf position score (computed, not stored)
```json
{ "shelfId": "S2", "position": "center", "score": 100, "factors": { "eyeLevel": 40, "traffic": 30, "visibility": 20, "accessibility": 10 } }
```

### 4.6 Recommendation explanation (computed, attached to each placement)
```json
{
  "skuId": "000481",
  "shelfId": "S2",
  "reasons": [
    { "factor": "growth", "value": "+18%", "weight": 25 },
    { "factor": "varietalDemand", "value": "High", "weight": 15 },
    { "factor": "storeMatch", "value": "92%", "weight": 20 },
    { "factor": "eyeLevelWeighting", "enabled": true },
    { "factor": "premiumPlacement", "enabled": true }
  ]
}
```
Every placement decision the optimizer makes must carry one of these — `optimize/placementSolver.js` is required to emit a reasons array alongside every assignment, not just a score. This is enforced at the type level (placement objects without `reasons` are treated as invalid by `scenarioEngine.js`).

---

## 5. Module Communication

- **Event bus (`core/bus.js`)**: simple pub/sub (`bus.on(event, handler)`, `bus.emit(event, payload)`). Used for cross-layer notifications, e.g. `metrics:changed` → calculation layer recomputes scores → emits `scores:updated` → optimization layer re-optimizes → emits `plan:updated` → visualization re-renders.
- **Central store (`core/store.js`)**: single in-memory object tree (SKUs, sales, stores, metrics config, current scenario, current plan). Modules read via getters, write via the store's own setters (never mutate directly) — the store emits change events on write, so §5's bus events are mostly store-triggered, not manually fired by feature code.
- **No layer calls another layer's internals.** Layer 3 (optimization) never imports from Layer 4 (visualization) — it only writes a `plan` object to the store; visualization only reads that object. This is what makes the backend swap (JSON → API → DB → ML) not require touching the UI.

---

## 6. Metric Engine

Every metric in the system is a plain config object, stored in `data/metrics.config.json` and editable live from the Metric Center module:

```json
{
  "id": "skuVolume",
  "label": "SKU Volume",
  "enabled": true,
  "weight": 35,
  "multiplier": 1.0,
  "minThreshold": null,
  "maxThreshold": null,
  "normalization": "minmax",
  "inverted": false,
  "priority": 1,
  "description": "Total unit volume for this SKU across the trailing period."
}
```

`calc/scoreEngine.js` iterates only `enabled: true` metrics, normalizes each via `calc/normalize.js` per the metric's `normalization` mode, applies `multiplier` and `inverted`, then combines via weighted sum (weights re-normalized to sum to 100 across enabled metrics only, so toggling one off doesn't silently change the scale). Initial metric set: SKU Volume, Brand Volume, Varietal Volume, Supplier Volume, Growth Rate, 52-Week Trend, 104-Week Trend, Price Point Strength, Margin $, Margin %, Regional Preference, Store Type Match, Consumer Demographics, Brand Strength, Distribution Strength, Velocity, Seasonality, Innovation Priority, Strategic Supplier Priority — each ships as a config row from day one, several defaulted to `enabled:false` until real data backs them.

---

## 7. Required Application Modules (top-level pages)

Dashboard, SKU Database, Sales Import, Store Builder, Metric Center, Calculation Engine (surfaced as a debug/transparency view, not just internal), Optimization Engine (config + run controls), Digital Twin Simulator, Planogram Viewer, Scenario Manager, Reports, Settings, Administration.

Each is one file in `src/modules/`, registered with `core/router.js` under a hash route, and renders into the shell's content area defined in `index.html`. Modules are lazy-loaded via dynamic `import()` so the initial bundle stays small even as the module count grows.

---

## 8. Digital Twin & Scenarios

`sim/digitalTwin.js` builds a per-store baseline (current sales, volume, revenue, margin, cases/linear-foot, category productivity) from `salesStore` + `storeStore`. `sim/scenarioEngine.js` defines named scenarios (A: Current Shelf, B: Optimized, C: Premium Strategy, D: Growth Strategy, E: Margin Strategy) as different **metric-weight presets** fed into the same `scoreEngine` → `optimize/*` pipeline — a scenario is just an alternate `metrics.config.json` plus alternate optimization constraints, not separate code paths. `sim/predictor.js` holds the projection formulas (velocity/space-productivity uplift) as pure functions so they're independently testable and swappable when real ML models replace the heuristics later.

---

## 9. Image System Contract

Shelf Intelligence does not build the image pipeline (that's a separate system — see [WineSKU-Scraper] as a likely candidate for supplying it) but commits to this contract:
- Images live at `/assets/images/skus/{skuId}.png`, transparent PNG, normalized dimensions.
- `viz/bottleSprite.js` must resolve to `_placeholder.png` on any load failure (404, decode error, missing `image` field) and must never throw — the planogram renders fully functional with zero real images.

---

## 10. Future Expansion Path (no frontend rebuild required)

| Today | Future | What changes |
|---|---|---|
| `data/adapters/jsonAdapter.js` reads static JSON | `data/adapters/apiAdapter.js` calls REST/GraphQL | Only `core/store.js`'s adapter selection line |
| In-memory store, no persistence | Node.js backend + database (Postgres likely, given relational SKU/sales/store data) | Adapter swap only |
| Heuristic `sim/predictor.js` formulas | ML model served via API | `predictor.js` becomes a thin client calling the model endpoint; its function signatures stay the same |
| Static hosting (GitHub Pages) | Cloud hosting + auth (multi-tenant: distributors/suppliers/retailers) | Add `core/auth.js` + route guards in `router.js`; no rewrite of modules |
| Local JSON scenario storage | Cloud-synced scenarios, multi-user collaboration | `scenarioEngine.js` adapter swap, same pattern as data layer |

---

## 11. Development Roadmap

1. **Architecture** — this document. *(current phase)*
2. **Data models** — finalize JSON schemas above, write sample `data/*.json` fixtures (a handful of realistic SKUs/stores/sales rows) to develop against.
3. **UI shell** — `index.html`, `tokens.css`, `layout.css`, `components.css`, sidebar/router, empty module pages wired to routes but not yet functional.
4. **Calculation engine** — `metricRegistry.js`, `normalize.js`, `scoreEngine.js`, Metric Center UI to toggle/weight metrics live.
5. **Optimization engine** — assortment/facings/blocking/placement solver, Planogram Viewer showing computed output.
6. **Simulator** — Digital Twin + Scenario Manager (A–E), before/after comparison UI.
7. **Bottle rendering** — `bottleSprite.js`, heat maps, traffic overlays, placeholder-image fallback.
8. **Reporting** — Reports module, exportable summaries, explainability panel wired to every recommendation.

No phase begins until the prior phase's deliverable is reviewed.

---

*This document defines the foundation only. No application code has been written. Awaiting approval to proceed to Phase 2 (data model fixtures).*
