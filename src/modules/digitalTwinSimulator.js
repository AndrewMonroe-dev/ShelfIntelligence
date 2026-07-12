export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Digital Twin Simulator</h1>
      <p>Before/after prediction per store: volume, revenue, margin, velocity, space productivity.</p>
    </div>
    <div class="card empty-state">Digital twin model arrives in Phase 6, once sim/digitalTwin.js exists.</div>
  `;
  return () => { el.innerHTML = ''; };
}
