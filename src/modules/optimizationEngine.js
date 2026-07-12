export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Optimization Engine</h1>
      <p>Configure and run assortment, facing, and blocking optimization.</p>
    </div>
    <div class="card empty-state">Run controls arrive in Phase 5, once optimize/* modules exist.</div>
  `;
  return () => { el.innerHTML = ''; };
}
