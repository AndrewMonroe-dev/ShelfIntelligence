import { store } from './core/store.js';
import { registerRoute, initRouter } from './core/router.js';

registerRoute('#dashboard', () => import('./modules/dashboard.js'));
registerRoute('#sku-database', () => import('./modules/skuDatabase.js'));
registerRoute('#sales-import', () => import('./modules/salesImport.js'));
registerRoute('#store-builder', () => import('./modules/storeBuilder.js'));
registerRoute('#metric-center', () => import('./modules/metricCenter.js'));
registerRoute('#calculation-engine', () => import('./modules/calculationEngine.js'));
registerRoute('#optimization-engine', () => import('./modules/optimizationEngine.js'));
registerRoute('#digital-twin', () => import('./modules/digitalTwinSimulator.js'));
registerRoute('#planogram-viewer', () => import('./modules/planogramViewer.js'));
registerRoute('#scenario-manager', () => import('./modules/scenarioManager.js'));
registerRoute('#reports', () => import('./modules/reports.js'));
registerRoute('#settings', () => import('./modules/settings.js'));
registerRoute('#administration', () => import('./modules/administration.js'));

async function boot() {
  await store.hydrate();
  initRouter(document.getElementById('content'));
}

boot();
