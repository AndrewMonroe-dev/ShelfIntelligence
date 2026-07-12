export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Settings</h1>
      <p>Application-level configuration.</p>
    </div>
    <div class="card empty-state">No configurable settings yet -- added as later phases introduce options that need them.</div>
  `;
  return () => { el.innerHTML = ''; };
}
