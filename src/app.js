import { store } from './core/store.js?v=20260808b';
import { registerRoute, initRouter } from './core/router.js?v=20260808b';

registerRoute('#dashboard', () => import('./modules/dashboard.js?v=20260808b'));
registerRoute('#sku-database', () => import('./modules/skuDatabase.js?v=20260808b'));
registerRoute('#sku-generator', () => import('./modules/skuGenerator.js?v=20260808b'));
registerRoute('#sales-import', () => import('./modules/salesImport.js?v=20260808b'));
registerRoute('#store-builder', () => import('./modules/storeBuilder.js?v=20260808b'));
registerRoute('#set-layout', () => import('./modules/setLayout.js?v=20260808b'));
registerRoute('#metric-center', () => import('./modules/metricCenter.js?v=20260808b'));
registerRoute('#calculation-engine', () => import('./modules/calculationEngine.js?v=20260808b'));
registerRoute('#optimization-engine', () => import('./modules/optimizationEngine.js?v=20260808b'));
registerRoute('#digital-twin', () => import('./modules/digitalTwinSimulator.js?v=20260808b'));
registerRoute('#planogram-viewer', () => import('./modules/planogramViewer.js?v=20260808b'));
registerRoute('#set-overview', () => import('./modules/setOverview.js?v=20260808b'));
registerRoute('#scenario-manager', () => import('./modules/scenarioManager.js?v=20260808b'));
registerRoute('#reports', () => import('./modules/reports.js?v=20260808b'));
registerRoute('#settings', () => import('./modules/settings.js?v=20260808b'));
registerRoute('#administration', () => import('./modules/administration.js?v=20260808b'));

async function boot() {
  await store.hydrate();
  initRouter(document.getElementById('content'));
}

boot();
