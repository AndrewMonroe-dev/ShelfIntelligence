export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Reports</h1>
      <p>Exportable summaries with explainability panels for every recommendation.</p>
    </div>
    <div class="card empty-state">Report generation arrives in Phase 8.</div>
  `;
  return () => { el.innerHTML = ''; };
}
