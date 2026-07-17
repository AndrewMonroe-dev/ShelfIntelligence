import { generatePlan } from './src/optimize/placementSolver.js';
import fs from 'fs';

const skus = JSON.parse(fs.readFileSync('data/skus.json', 'utf8'));
const allSkus = Array.isArray(skus) ? skus : skus.skus;
const bottleDimensions = JSON.parse(fs.readFileSync('data/bottleDimensions.json', 'utf8'));
const metricsConfig = JSON.parse(fs.readFileSync('data/metrics.config.json', 'utf8'));

// 6 bays: 5 at 4 shelves, 1 (B6) at 7 shelves -- matches Andrew's real store.
const store = {
  storeId: 'test-store',
  qualityScore: null,
  shelfLayout: {
    bays: [
      ...Array.from({ length: 5 }, (_, i) => ({ bayId: `B${i + 1}`, shelfCount: 4, shelves: Array.from({ length: 4 }, () => ({ traffic: 'medium' })) })),
      { bayId: 'B6', shelfCount: 7, shelves: Array.from({ length: 7 }, () => ({ traffic: 'medium' })) },
    ],
  },
};

const cats = [
  'varietal:NEW ZEALAND', 'varietal:SAUVIGNON BLANC', 'varietal:RED BLEND', 'varietal:PINOT GRIGIO/PINOT GRIS',
  'varietal:MERLOT', 'varietal:ROSE', 'varietal:SPARKLING WINE', 'varietal:ITALY', 'varietal:AUSTRALIA',
  'size:1.5LT', 'varietal:REGIONAL', 'varietal:RIESLING', 'varietal:MOSCATO', 'varietal:FLAVORED/SWEET',
];
let cursor = 0;
const sectionAllocations = cats.map((key, order) => {
  const a = { key, label: key, widthFt: 0.8, startFt: cursor, order };
  cursor += 0.8;
  return a;
});

const plan = generatePlan(store, allSkus, metricsConfig, allSkus.length, bottleDimensions, sectionAllocations, {}, [], false, []);
console.log('Sections produced:', plan.sections.length);
plan.sections.forEach((s) => console.log(' ', s.type, '|', s.key, '|', s.linearFeet, 'ft |', s.shelves.reduce((sum, sh) => sum + sh.skus.length, 0), 'total SKUs placed'));

const producedKeys = new Set();
plan.sections.forEach((s) => {
  s.key.split('+').forEach((k) => producedKeys.add(k));
});
console.log('\nRequested but not found in ANY output section:');
cats.forEach((c) => { if (![...producedKeys].some((k) => k.includes(c))) console.log(' ', c); });
