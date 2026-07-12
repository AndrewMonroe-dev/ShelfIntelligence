export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Planogram Viewer</h1>
      <p>Interactive shelf visualization with bottle imagery, heat maps, and performance overlays.</p>
    </div>
    <div class="card empty-state">Shelf rendering arrives in Phase 7, once viz/planogramRenderer.js and bottleSprite.js exist.</div>
  `;
  return () => { el.innerHTML = ''; };
}
