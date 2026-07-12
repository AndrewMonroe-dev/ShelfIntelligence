import { store } from '../core/store.js';

export function mount(el) {
  const { stores } = store.getSnapshot();

  const cards = stores.map((s) => `
    <div class="card">
      <div class="card-label">${s.name}</div>
      <div style="margin-top:8px;font-size:13px;color:var(--text2);">${s.storeType} · ${s.region}</div>
      <div style="margin-top:10px;font-size:13px;">${s.shelfLayout.shelves.length} shelves · ${s.shelfLayout.totalLinearFeet} linear feet</div>
    </div>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h1>Store Builder</h1>
      <p>Define store physical layout, shelf geometry, and demographics.</p>
    </div>
    <div class="grid grid-3">${cards}</div>
    <p class="empty-state">Shelf-layout editing UI arrives once the Planogram Viewer (Phase 5) is in place.</p>
  `;

  return () => { el.innerHTML = ''; };
}
