import { store } from './core/store.js?v=20260807b';
import { registerRoute, initRouter } from './core/router.js?v=20260807b';

registerRoute('#dashboard', () => import('./modules/dashboard.js?v=20260807b'));
registerRoute('#sku-database', () => import('./modules/skuDatabase.js?v=20260807b'));
registerRoute('#sales-import', () => import('./modules/salesImport.js?v=20260807b'));
registerRoute('#store-builder', () => import('./modules/storeBuilder.js?v=20260807b'));
registerRoute('#set-layout', () => import('./modules/setLayout.js?v=20260807b'));
registerRoute('#metric-center', () => import('./modules/metricCenter.js?v=20260807b'));
registerRoute('#calculation-engine', () => import('./modules/calculationEngine.js?v=20260807b'));
registerRoute('#optimization-engine', () => import('./modules/optimizationEngine.js?v=20260807b'));
registerRoute('#digital-twin', () => import('./modules/digitalTwinSimulator.js?v=20260807b'));
registerRoute('#planogram-viewer', () => import('./modules/planogramViewer.js?v=20260807b'));
registerRoute('#set-overview', () => import('./modules/setOverview.js?v=20260807b'));
registerRoute('#scenario-manager', () => import('./modules/scenarioManager.js?v=20260807b'));
registerRoute('#reports', () => import('./modules/reports.js?v=20260807b'));
registerRoute('#settings', () => import('./modules/settings.js?v=20260807b'));
registerRoute('#administration', () => import('./modules/administration.js?v=20260807b'));

async function boot() {
  await store.hydrate();
  initRouter(document.getElementById('content'));
}

boot();
