import { store } from '../core/store.js';

const PX_PER_INCH = 6;
const MIN_BOX_WIDTH = 76;

function renderSkuBox(skuEntry) {
  const widthPx = Math.max(MIN_BOX_WIDTH, (skuEntry.allocatedInches ?? skuEntry.widthInches ?? 12) * PX_PER_INCH);
  return `
    <div class="planogram-box" style="width:${widthPx}px;" title="${skuEntry.brand}${skuEntry.varietal ? ' - ' + skuEntry.varietal : ''} (score ${skuEntry.score.toFixed(1)}, ${skuEntry.facings} facings)">
      <div class="planogram-box-image">[no image]<br/><span style="color:var(--text3);">${skuEntry.skuId}</span></div>
      <div class="planogram-box-brand">${skuEntry.brand}</div>
      <div class="planogram-box-varietal">${skuEntry.varietal || skuEntry.bottleSizeRaw || ''}</div>
      <div class="planogram-box-price">${skuEntry.priceUsd != null ? '$' + skuEntry.priceUsd.toFixed(2) : '--'}</div>
      <div class="planogram-box-facings">${skuEntry.facings}f &middot; score ${skuEntry.score.toFixed(0)}</div>
    </div>
  `;
}

function renderShelfRow(shelf) {
  return `
    <div class="planogram-shelf-row">
      <div class="planogram-shelf-label">Shelf ${shelf.position} &middot; ${shelf.zone} &middot; ${shelf.traffic} traffic</div>
      <div class="planogram-shelf-boxes">
        ${shelf.skus.map(renderSkuBox).join('') || '<div class="empty-state" style="padding:8px;">Empty</div>'}
      </div>
    </div>
  `;
}

function renderSection(section) {
  return `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <span class="card-label">${section.label} <span class="badge" style="margin-left:6px;">${section.type}</span></span>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${section.linearFeet.toFixed(1)} ft</span>
      </div>
      ${section.shelves.map(renderShelfRow).join('')}
    </div>
  `;
}

export function mount(el) {
  function render() {
    const { currentPlan } = store.getSnapshot();

    if (!currentPlan) {
      el.innerHTML = `
        <div class="page-header">
          <h1>Planogram Viewer</h1>
          <p>Interactive shelf visualization -- boxes are sized relative to each other by real allocated linear space (facings x bottle width). Bottle imagery arrives later; boxes show text only for now.</p>
        </div>
        <div class="card empty-state">No plan generated yet. Go to Optimization Engine and click "Generate Plan" first.</div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="page-header">
        <h1>Planogram Viewer</h1>
        <p>${currentPlan.skuCount} SKUs across ${currentPlan.sections.length} sections. Box width is proportional to each SKU's allocated linear space -- bottle images arrive in a later pass, boxes are text-only placeholders for now.</p>
      </div>
      ${currentPlan.sections.map(renderSection).join('')}
    `;
  }

  render();
  return () => { el.innerHTML = ''; };
}
