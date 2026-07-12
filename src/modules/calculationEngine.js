export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Calculation Engine</h1>
      <p>Transparency view into how enabled metrics combine into each SKU's opportunity score.</p>
    </div>
    <div class="card empty-state">Score breakdown viewer arrives in Phase 4, once calc/scoreEngine.js exists.</div>
  `;
  return () => { el.innerHTML = ''; };
}
