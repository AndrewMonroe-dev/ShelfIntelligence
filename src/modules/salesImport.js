export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Sales Import</h1>
      <p>Bulk-load sales history from CSV/POS export into data/sales.json-compatible records.</p>
    </div>
    <div class="card empty-state">CSV import pipeline arrives in a later phase, once the Calculation Engine (Phase 4) defines what it consumes.</div>
  `;
  return () => { el.innerHTML = ''; };
}
