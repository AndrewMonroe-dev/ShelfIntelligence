import { store } from './core/store.js?v=20260807c';
import { registerRoute, initRouter } from './core/router.js?v=20260807c';

registerRoute('#dashboard', () => import('./modules/dashboard.js?v=20260807c'));
registerRoute('#sku-database', () => import('./modules/skuDatabase.js?v=20260807c'));
registerRoute('#sku-generator', () => import('./modules/skuGenerator.js?v=20260807c'));
registerRoute('#sales-import', () => import('./modules/salesImport.js?v=20260807c'));
registerRoute('#store-builder', () => import('./modules/storeBuilder.js?v=20260807c'));
registerRoute('#set-layout', () => import('./modules/setLayout.js?v=20260807c'));
registerRoute('#metric-center', () => import('./modules/metricCenter.js?v=20260807c'));
registerRoute('#calculation-engine', () => import('./modules/calculationEngine.js?v=20260807c'));
registerRoute('#optimization-engine', () => import('./modules/optimizationEngine.js?v=20260807c'));
registerRoute('#digital-twin', () => import('./modules/digitalTwinSimulator.js?v=20260807c'));
registerRoute('#planogram-viewer', () => import('./modules/planogramViewer.js?v=20260807c'));
registerRoute('#set-overview', () => import('./modules/setOverview.js?v=20260807c'));
registerRoute('#scenario-manager', () => import('./modules/scenarioManager.js?v=20260807c'));
registerRoute('#reports', () => import('./modules/reports.js?v=20260807c'));
registerRoute('#settings', () => import('./modules/settings.js?v=20260807c'));
registerRoute('#administration', () => import('./modules/administration.js?v=20260807c'));

async function boot() {
  await store.hydrate();
  initRouter(document.getElementById('content'));
}

boot();
