export function mount(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Administration</h1>
      <p>User, role, and multi-tenant management -- for the distributor/supplier/retailer expansion.</p>
    </div>
    <div class="card empty-state">No auth/multi-tenant system yet. Planned for the cloud-hosting expansion phase (see Architecture &sect;10).</div>
  `;
  return () => { el.innerHTML = ''; };
}
