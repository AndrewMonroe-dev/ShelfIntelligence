const routes = new Map();
let contentEl = null;
let currentUnmount = null;

export function registerRoute(hash, moduleLoader) {
  routes.set(hash, moduleLoader);
}

export function initRouter(mountEl) {
  contentEl = mountEl;
  window.addEventListener('hashchange', render);
  render();
}

async function render() {
  const hash = window.location.hash || '#dashboard';
  const loader = routes.get(hash);

  document.querySelectorAll('.navitem').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('href') === hash);
  });

  if (typeof currentUnmount === 'function') {
    currentUnmount();
    currentUnmount = null;
  }

  if (!loader) {
    contentEl.innerHTML = `<div class="empty-state">No module registered for ${hash}</div>`;
    return;
  }

  contentEl.innerHTML = `<div class="empty-state">Loading...</div>`;
  try {
    const mod = await loader();
    currentUnmount = mod.mount(contentEl);
  } catch (err) {
    console.error(`Failed to load/mount ${hash}:`, err);
    contentEl.innerHTML = `<div class="empty-state" style="color:var(--danger);text-align:left;white-space:pre-wrap;">Failed to load this page: ${err.message}\n\nSee the browser console for the full error.</div>`;
  }
}
