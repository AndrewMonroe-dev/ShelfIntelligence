import { store } from './core/store.js?v=20260808';
import { registerRoute, initRouter } from './core/router.js?v=20260808';

registerRoute('#dashboard', () => import('./modules/dashboard.js?v=20260808'));
registerRoute('#sku-database', () => import('./modules/skuDatabase.js?v=20260808'));
registerRoute('#sku-generator', () => import('./modules/skuGenerator.js?v=20260808'));
registerRoute('#sales-import', () => import('./modules/salesImport.js?v=20260808'));
registerRoute('#store-builder', () => import('./modules/storeBuilder.js?v=20260808'));
registerRoute('#set-layout', () => import('./modules/setLayout.js?v=20260808'));
registerRoute('#metric-center', () => import('./modules/metricCenter.js?v=20260808'));
registerRoute('#calculation-engine', () => import('./modules/calculationEngine.js?v=20260808'));
registerRoute('#optimization-engine', () => import('./modules/optimizationEngine.js?v=20260808'));
registerRoute('#digital-twin', () => import('./modules/digitalTwinSimulator.js?v=20260808'));
registerRoute('#planogram-viewer', () => import('./modules/planogramViewer.js?v=20260808'));
registerRoute('#set-overview', () => import('./modules/setOverview.js?v=20260808'));
registerRoute('#scenario-manager', () => import('./modules/scenarioManager.js?v=20260808'));
registerRoute('#reports', () => import('./modules/reports.js?v=20260808'));
registerRoute('#settings', () => import('./modules/settings.js?v=20260808'));
registerRoute('#administration', () => import('./modules/administration.js?v=20260808'));

async function boot() {
  await store.hydrate();
  initRouter(document.getElementById('content'));
}

boot();
