import { store } from '../core/store.js?v=20260807c';
import { bus } from '../core/bus.js?v=20260807c';
import { computeScoreMap } from '../calc/scoreEngine.js?v=20260807c';

// Andrew, 2026-08-07: lets a SKU be created by hand instead of only ever
// arriving via skus.json/curationRules.json -- for stress-testing (e.g.
// "make a huge Cabernet set") or a real product that doesn't have a source
// export yet. Every field below except Brand is optional; a blank field
// just means the SKU carries no data for whatever metric would have read
// it (see calc/metricRegistry.js -- a metric skips a SKU with a null value
// for it, same as any real SKU with incomplete source data). Once added,
// the SKU is pushed straight into state.skus, so it's immediately usable
// everywhere else in the app -- SKU Database, sections, scoring,
// Optimization Engine, Planogram Viewer -- no separate "activate" step.
export function mount(el) {
  let form = {
    brand: '', varietal: '', region: '', bottleSizeRaw: '', upc: '', priceUsd: '',
    sales9L: '', growthPct9L: '', podsDistribution: '', strategicSupplierPriority: false,
  };

  function resetForm() {
    form = {
      brand: '', varietal: '', region: '', bottleSizeRaw: '', upc: '', priceUsd: '',
      sales9L: '', growthPct9L: '', podsDistribution: '', strategicSupplierPriority: false,
    };
  }

  function render() {
    const { skus, metricsConfig } = store.getSnapshot();
    const generated = store.getGeneratedSkus();
    const scoreMap = computeScoreMap(skus, metricsConfig);

    const varietals = [...new Set(skus.map((s) => s.varietal).filter(Boolean))].sort();
    const regions = [...new Set(skus.map((s) => s.region).filter(Boolean))].sort();
    const sizes = [...new Set(skus.map((s) => s.bottleSizeRaw).filter(Boolean))].sort();

    const rows = [...generated].reverse().map((s) => {
      const score = scoreMap.get(s.skuId)?.score ?? 0;
      return `
        <tr>
          <td>${s.brand}</td>
          <td style="color:var(--text2);">${s.varietal || '<span style="color:var(--text3);">--</span>'}</td>
          <td style="color:var(--text2);">${s.region || '<span style="color:var(--text3);">--</span>'}</td>
          <td>${s.bottleSizeRaw || '<span style="color:var(--text3);">--</span>'}</td>
          <td style="font-family:var(--font-mono);color:var(--text2);">${s.upc || '--'}</td>
          <td>${s.priceUsd != null ? '$' + s.priceUsd.toFixed(2) : '--'}</td>
          <td style="font-family:var(--font-mono);color:var(--blue);">${score.toFixed(1)}</td>
          <td><button class="btn remove-generated-btn" data-sku-id="${s.skuId}" style="padding:3px 10px;font-size:11.5px;color:var(--danger);">Remove</button></td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      <div class="page-header">
        <h1>SKU Generator</h1>
        <p>Create a SKU by hand instead of waiting on a source export. Only Brand is required -- leave anything else blank if you don't know it yet; a blank field just means that metric won't count toward this SKU's score, same as a real SKU with incomplete data. Added SKUs are immediately usable everywhere: SKU Database, Set Layout, Optimization Engine, Planogram Viewer.</p>
      </div>

      <div class="card" style="margin-bottom:14px;">
        <div class="card-label" style="margin-bottom:12px;">New SKU</div>
        <div class="grid grid-3" style="gap:12px;">
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Brand *</div>
            <input type="text" class="gen-brand" value="${form.brand}" placeholder="e.g. Bon Anno" style="width:100%;" />
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Varietal / Name</div>
            <input type="text" class="gen-varietal" value="${form.varietal}" placeholder="e.g. Cabernet Sauvignon" list="gen-varietal-list" style="width:100%;" />
            <datalist id="gen-varietal-list">${varietals.map((v) => `<option value="${v}"></option>`).join('')}</datalist>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Region</div>
            <input type="text" class="gen-region" value="${form.region}" placeholder="e.g. Napa Valley" list="gen-region-list" style="width:100%;" />
            <datalist id="gen-region-list">${regions.map((r) => `<option value="${r}"></option>`).join('')}</datalist>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Size</div>
            <input type="text" class="gen-size" value="${form.bottleSizeRaw}" placeholder="e.g. 0.75LT" list="gen-size-list" style="width:100%;" />
            <datalist id="gen-size-list">${sizes.map((s) => `<option value="${s}"></option>`).join('')}</datalist>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">UPC</div>
            <input type="text" class="gen-upc" value="${form.upc}" placeholder="optional" style="width:100%;" />
          </div>
          <div>
            <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Price ($)</div>
            <input type="number" class="gen-price" value="${form.priceUsd}" placeholder="e.g. 24.99" min="0" step="0.01" style="width:100%;" />
          </div>
        </div>

        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
          <div style="font-size:11px;color:var(--text2);margin-bottom:10px;">Ranking data -- optional, leave blank if unknown</div>
          <div class="grid grid-3" style="gap:12px;">
            <div>
              <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Sales (9L cases)</div>
              <input type="number" class="gen-sales" value="${form.sales9L}" placeholder="optional" min="0" step="1" style="width:100%;" />
            </div>
            <div>
              <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Growth % (YoY)</div>
              <input type="number" class="gen-growth" value="${form.growthPct9L}" placeholder="optional" step="0.1" style="width:100%;" />
            </div>
            <div>
              <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">PODs Distribution</div>
              <input type="number" class="gen-pods" value="${form.podsDistribution}" placeholder="optional" min="0" step="1" style="width:100%;" />
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;margin-top:12px;">
            <input type="checkbox" class="gen-priority" ${form.strategicSupplierPriority ? 'checked' : ''} />
            Strategic Supplier Priority
          </label>
        </div>

        <div style="margin-top:16px;">
          <button class="btn btn-primary add-generated-btn">+ Add SKU</button>
        </div>
      </div>

      <div class="card" style="padding:0;overflow-x:auto;">
        <div class="card-label" style="padding:14px 16px 0;">Generated SKUs (${generated.length})</div>
        ${generated.length ? `
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px;">
            <thead>
              <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
                <th style="padding:10px 16px;">Brand</th>
                <th style="padding:10px 16px;">Varietal</th>
                <th style="padding:10px 16px;">Region</th>
                <th style="padding:10px 16px;">Size</th>
                <th style="padding:10px 16px;">UPC</th>
                <th style="padding:10px 16px;">Price</th>
                <th style="padding:10px 16px;">Score</th>
                <th style="padding:10px 16px;"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        ` : '<div class="empty-state" style="padding:16px;">No generated SKUs yet.</div>'}
      </div>
    `;

    el.querySelector('.gen-brand').addEventListener('input', (e) => { form.brand = e.target.value; });
    el.querySelector('.gen-varietal').addEventListener('input', (e) => { form.varietal = e.target.value; });
    el.querySelector('.gen-region').addEventListener('input', (e) => { form.region = e.target.value; });
    el.querySelector('.gen-size').addEventListener('input', (e) => { form.bottleSizeRaw = e.target.value; });
    el.querySelector('.gen-upc').addEventListener('input', (e) => { form.upc = e.target.value; });
    el.querySelector('.gen-price').addEventListener('input', (e) => { form.priceUsd = e.target.value; });
    el.querySelector('.gen-sales').addEventListener('input', (e) => { form.sales9L = e.target.value; });
    el.querySelector('.gen-growth').addEventListener('input', (e) => { form.growthPct9L = e.target.value; });
    el.querySelector('.gen-pods').addEventListener('input', (e) => { form.podsDistribution = e.target.value; });
    el.querySelector('.gen-priority').addEventListener('change', (e) => { form.strategicSupplierPriority = e.target.checked; });

    el.querySelector('.add-generated-btn').addEventListener('click', () => {
      if (!form.brand.trim()) {
        alert('Brand is required.');
        return;
      }
      store.addGeneratedSku(form);
      resetForm();
      render();
    });

    el.querySelectorAll('.remove-generated-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const skuId = e.target.dataset.skuId;
        if (!confirm('Remove this generated SKU? It will no longer be available anywhere in the app.')) return;
        store.removeGeneratedSku(skuId);
        render();
      });
    });
  }

  render();
  const unsubscribe = bus.on('metrics:changed', render);
  return () => { unsubscribe(); el.innerHTML = ''; };
}
