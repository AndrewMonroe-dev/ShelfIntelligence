import { store } from '../core/store.js';

const PX_PER_INCH = 8;
const BLOCK_INCHES = 48; // 4 feet -- the fixed visual module width
const MIN_BOX_PX = 8; // just enough to avoid a zero-width render glitch, not a proportionality-distorting floor

// Splits a shelf row's SKU sequence into 4-foot visual blocks. Boxes are
// never split mid-box -- each box is assigned to the block where its
// cumulative running position starts, so block boundaries land consistently
// at the same physical distance-from-left across every shelf row in a
// section (blocks stay within one section only, never spanning into the
// next section, per the resolved design question).
function chunkRowIntoBlocks(skus, blockCount) {
  const blocks = Array.from({ length: blockCount }, () => []);
  let cumulative = 0;
  skus.forEach((s) => {
    const w = s.allocatedInches ?? s.facings * (s.widthInches ?? 3);
    const blockIdx = Math.min(blockCount - 1, Math.floor(cumulative / BLOCK_INCHES));
    blocks[blockIdx].push(s);
    cumulative += w;
  });
  return blocks;
}

function renderSkuBox(skuEntry) {
  const widthIn = skuEntry.allocatedInches ?? skuEntry.facings * (skuEntry.widthInches ?? 3);
  const widthPx = Math.max(MIN_BOX_PX, widthIn * PX_PER_INCH);
  return `
    <div class="planogram-box" style="width:${widthPx}px;" title="${skuEntry.brand}${skuEntry.varietal ? ' - ' + skuEntry.varietal : ''} (score ${skuEntry.score.toFixed(1)}, ${skuEntry.facings} facings, ${widthIn.toFixed(1)}in)">
      <div class="planogram-box-image">[no image]<br/><span style="color:var(--text3);">${skuEntry.skuId}</span></div>
      <div class="planogram-box-brand">${skuEntry.brand}</div>
      <div class="planogram-box-varietal">${skuEntry.varietal || skuEntry.bottleSizeRaw || ''}</div>
      <div class="planogram-box-price">${skuEntry.priceUsd != null ? '$' + skuEntry.priceUsd.toFixed(2) : '--'}</div>
      <div class="planogram-box-facings">${skuEntry.facings}f &middot; score ${skuEntry.score.toFixed(0)}</div>
    </div>
  `;
}

function renderBlock(blockSkus, blockIndex, isLastBlock, sectionLinearFeet) {
  const usedInches = blockSkus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0);
  const targetFeet = isLastBlock ? sectionLinearFeet - blockIndex * 4 : 4;
  return `
    <div class="planogram-block">
      <div class="planogram-block-label">Block ${blockIndex + 1} &middot; ${targetFeet.toFixed(1)}ft target &middot; ${(usedInches / 12).toFixed(1)}ft used</div>
      <div class="planogram-shelf-boxes">
        ${blockSkus.map(renderSkuBox).join('') || '<div class="empty-state" style="padding:8px;font-size:10px;">Empty</div>'}
      </div>
    </div>
  `;
}

function rowInches(shelf) {
  return shelf.skus.reduce((sum, s) => sum + (s.allocatedInches ?? s.facings * (s.widthInches ?? 3)), 0);
}

function renderShelfRow(shelf, blockCount, sectionLinearFeet) {
  const blocks = chunkRowIntoBlocks(shelf.skus, blockCount);
  return `
    <div class="planogram-shelf-row">
      <div class="planogram-shelf-label">Shelf ${shelf.position} &middot; ${shelf.zone} &middot; ${shelf.traffic} traffic</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${blocks.map((blockSkus, i) => renderBlock(blockSkus, i, i === blocks.length - 1, sectionLinearFeet)).join('')}
      </div>
    </div>
  `;
}

function renderSection(section) {
  // Block count is based on the ACTUAL real content width of the section's
  // widest shelf row, not the nominal score-proportional linearFeet -- a
  // section can end up needing more physical space than its nominal share
  // when it has more SKUs than fit at 1 facing each (see docs/BUSINESS_RULES.md
  // "Overflow resolution": sections are allowed to grow beyond their nominal
  // share rather than drop SKUs, so the view must render that real space,
  // not crop it to fit a stale block count).
  const maxRowInches = Math.max(...section.shelves.map(rowInches), 0);
  const nominalInches = section.linearFeet * 12;
  const actualInches = Math.max(maxRowInches, nominalInches);
  const blockCount = Math.max(1, Math.ceil(actualInches / BLOCK_INCHES));
  const isOverflowing = maxRowInches > nominalInches + 1; // +1 tolerance for float rounding

  return `
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
        <span class="card-label">${section.label} <span class="badge" style="margin-left:6px;">${section.type}</span></span>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${section.linearFeet.toFixed(1)} ft nominal &middot; ${blockCount} block${blockCount === 1 ? '' : 's'}</span>
      </div>
      ${isOverflowing ? `<div class="badge badge-warning" style="margin-bottom:8px;">Needs ${(maxRowInches / 12).toFixed(1)}ft -- exceeds its ${section.linearFeet.toFixed(1)}ft nominal share (too many SKUs for the space at 1 facing each; section grows rather than dropping SKUs)</div>` : ''}
      ${section.shelves.map((shelf) => renderShelfRow(shelf, blockCount, actualInches / 12)).join('')}
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
          <p>Interactive shelf visualization -- rendered in fixed 4-foot blocks, box width proportional to real allocated linear space. Bottle imagery arrives later; boxes show text only for now.</p>
        </div>
        <div class="card empty-state">No plan generated yet. Go to Optimization Engine and click "Generate Plan" first.</div>
      `;
      return;
    }

    const actualSectionFeet = (s) => Math.max(s.linearFeet, Math.max(...s.shelves.map(rowInches), 0) / 12);
    const totalWidth = currentPlan.sections.reduce((sum, s) => sum + actualSectionFeet(s), 0);

    el.innerHTML = `
      <div class="page-header">
        <h1>Planogram Viewer</h1>
        <p>${currentPlan.skuCount} SKUs across ${currentPlan.sections.length} sections. Each section is rendered in fixed 4-foot blocks (a partial final block shows its actual remaining width); box width is proportional to each SKU's real allocated linear space at a fixed scale, so a wider box always means more real shelf space, not just more facings within one section.</p>
      </div>
      <div class="card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <span class="card-label">Total Horizontal Set Width</span>
          <span class="kpi-value" style="font-size:22px;margin-top:0;">${totalWidth.toFixed(1)} ft</span>
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
          ${currentPlan.sections.map((s) => `<span class="badge" style="font-family:var(--font-mono);">${s.label}: ${actualSectionFeet(s).toFixed(1)}ft</span>`).join('')}
        </div>
      </div>
      ${currentPlan.sections.map(renderSection).join('')}
    `;
  }

  render();
  return () => { el.innerHTML = ''; };
}
