import { store } from '../core/store.js';

export function mount(el) {
  const { scenarios, activeScenarioId } = store.getSnapshot();

  const cards = scenarios.map((s) => `
    <div class="card">
      <div class="card-label">${s.label}${s.scenarioId === activeScenarioId ? ' <span class="badge badge-success">Active</span>' : ''}</div>
      <div style="margin-top:10px;font-size:13px;color:var(--text2);">${s.description}</div>
    </div>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h1>Scenario Manager</h1>
      <p>Compare predicted outcomes across Current Shelf, Optimized, Premium, Growth, and Margin strategies.</p>
    </div>
    <div class="grid grid-3">${cards}</div>
    <p class="empty-state">Scenario comparison + predicted outcome deltas arrive in Phase 6 (Simulator).</p>
  `;

  return () => { el.innerHTML = ''; };
}
