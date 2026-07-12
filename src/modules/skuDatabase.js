import { store } from '../core/store.js';

export function mount(el) {
  const { skus } = store.getSnapshot();

  const rows = skus.map((s) => `
    <tr>
      <td style="font-family:var(--font-mono);color:var(--text2);">${s.skuId}</td>
      <td>${s.brand}</td>
      <td style="color:var(--text2);">${s.varietal}</td>
      <td style="color:var(--text2);">${s.country}</td>
      <td>$${s.priceUsd.toFixed(2)}</td>
      <td>${s.bottleSizeMl}ml</td>
      <td><span class="badge${s.premiumTier === 'Elevated' ? ' badge-premium' : ''}">${s.premiumTier}</span></td>
    </tr>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h1>SKU Database</h1>
      <p>${skus.length} SKUs. Identified permanently by SKU ID -- never by name.</p>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;color:var(--text2);border-bottom:1px solid var(--border);">
            <th style="padding:12px 16px;">SKU ID</th>
            <th style="padding:12px 16px;">Brand</th>
            <th style="padding:12px 16px;">Varietal</th>
            <th style="padding:12px 16px;">Country</th>
            <th style="padding:12px 16px;">Price</th>
            <th style="padding:12px 16px;">Size</th>
            <th style="padding:12px 16px;">Tier</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  return () => { el.innerHTML = ''; };
}
