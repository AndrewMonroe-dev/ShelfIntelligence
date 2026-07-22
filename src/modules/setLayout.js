import { store } from '../core/store.js';
import { groupBySection } from '../optimize/blocking.js';
import { getPhysicalWidthFt, getLinearShelfFeet } from '../optimize/shelfPosition.js';

const PX_PER_FT = 20;
const MIN_BAY_BLOCK_PX = 92; // wide enough for the shelf-count stepper to never overflow a 4ft-scaled block
// Andrew, 2026-07-17: lowered from 1ft -- some categories genuinely only
// need a couple bottles' worth of space, and a section's width applies to
// EVERY shelf row it spans, so even 1ft (several bottles per row) was too
// coarse a floor. ~0.3ft is roughly one bottle width at floor facings.
// Card rendering still floors at MIN_CARD_PX below regardless of widthFt.
const MIN_SECTION_WIDTH_FT = 0.3;

// Andrew, 2026-07-19: Category Allocation cards get their own px/ft scale,
// independent of the bay-fixture strip's PX_PER_FT above -- a 2ft-wide
// section is the reference size and should render as a perfect square
// (equal width and height). Height is FIXED at this reference regardless
// of widthFt, so only width varies: narrower sections read as portrait
// rectangles, wider ones as landscape, square exactly at 2ft.
const SQUARE_REFERENCE_FT = 2;
const CATEGORY_PX_PER_FT = 44; // chosen so the 2ft reference square (88px) matches the card's prior comfortable min-height
const CATEGORY_CARD_HEIGHT_PX = SQUARE_REFERENCE_FT * CATEGORY_PX_PER_FT;
// Floor exists only so the drag handle (top-left) and delete button
// (top-right, each ~18px) don't overlap each other at extreme widths.
const MIN_CARD_PX = 48;
function cardWidthPx(widthFt) {
  return Math.max(MIN_CARD_PX, widthFt * CATEGORY_PX_PER_FT);
}

// Andrew, 2026-07-19: below a certain card width the label needs to shrink
// and turn sideways (vertical writing) to stay legible instead of wrapping
// into an unreadable single-letter-per-line stack. Font scales down
// continuously with width down to a 9px floor; the vertical-writing switch
// kicks in once horizontal space is too tight for even short words.
const LABEL_VERTICAL_THRESHOLD_PX = 70;
function labelStyleFor(widthPx) {
  const fontSize = Math.max(9, Math.min(13.5, widthPx / 5));
  if (widthPx < LABEL_VERTICAL_THRESHOLD_PX) {
    return `font-size:${fontSize}px;writing-mode:vertical-rl;text-orientation:mixed;white-space:nowrap;overflow:hidden;max-height:${CATEGORY_CARD_HEIGHT_PX - 36}px;`;
  }
  return `font-size:${fontSize}px;`;
}

export function mount(el) {
  let selectedStoreId = null;
  let draggedKey = null;
  let highlightedKey = null;

  function currentStore() {
    const { stores } = store.getSnapshot();
    return stores.find((s) => s.storeId === selectedStoreId);
  }

  function ensureAllocations(storeId) {
    let allocations = store.getSectionAllocations(storeId);
    if (!allocations.length) allocations = store.autoAllocateSections(storeId);
    return allocations;
  }

  function renderFixtureStrip(targetStore) {
    const bays = targetStore.shelfLayout.bays;
    const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
    const linearShelfFeet = getLinearShelfFeet(targetStore.shelfLayout);
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
          <span class="card-label">Physical Fixture</span>
          <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${bays.length} bays &middot; ${physicalWidthFt}ft wide &middot; ${linearShelfFeet} linear shelf feet</span>
        </div>
        <div class="layout-strip" style="margin-top:10px;">
          ${bays.map((bay) => `
            <div class="bay-block" style="width:${Math.max(MIN_BAY_BLOCK_PX, PX_PER_FT * 4)}px;" data-bay-id="${bay.bayId}">
              <div class="bay-block-id">${bay.bayId} &middot; 4ft</div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                <button class="btn bay-shelf-minus" data-bay-id="${bay.bayId}" style="padding:2px 8px;">-</button>
                <span class="bay-shelf-count-value" style="font-family:var(--font-mono);font-size:13px;min-width:16px;text-align:center;">${bay.shelfCount}</span>
                <button class="btn bay-shelf-plus" data-bay-id="${bay.bayId}" style="padding:2px 8px;">+</button>
              </div>
              <div style="font-size:10px;color:var(--text3);margin-top:2px;">shelves</div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="btn add-bay-btn">+ Add Bay</button>
          <button class="btn remove-bay-btn" ${bays.length <= 1 ? 'disabled' : ''}>- Remove Bay</button>
        </div>
      </div>
    `;
  }

  function renderAllocationStrip(targetStore, allocations) {
    const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
    const totalAllocated = allocations.reduce((sum, a) => sum + a.widthFt, 0);
    const diff = totalAllocated - physicalWidthFt;
    const allocatedKeys = new Set(allocations.map((a) => a.key));
    const allSections = groupBySection(store.getSnapshot().skus);
    const availableToAdd = [...allSections.values()].filter((s) => !allocatedKeys.has(s.key));

    const sorted = [...allocations].sort((a, b) => a.order - b.order);

    return `
      <div class="card" style="margin-top:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
          <span class="card-label">Category Allocation</span>
          <span style="font-family:var(--font-mono);font-size:12px;color:var(--text2);">${totalAllocated.toFixed(1)}ft allocated of ${physicalWidthFt}ft</span>
        </div>
        ${Math.abs(diff) > 0.05 ? `<div class="badge badge-warning" style="margin-top:8px;">Allocated sections ${diff > 0 ? 'exceed' : 'fall short of'} the fixture by ${Math.abs(diff).toFixed(1)}ft -- ${diff > 0 ? 'shrink sections or add bays' : 'grow sections or remove bays'}</div>` : ''}
        <div class="layout-strip category-strip" style="margin-top:10px;">
          ${sorted.map((a) => `
            <div class="section-block${a.key === highlightedKey ? ' highlighted' : ''}" style="width:${cardWidthPx(a.widthFt)}px;height:${CATEGORY_CARD_HEIGHT_PX}px;" data-section-key="${a.key}">
              <div class="section-drag-handle" data-section-key="${a.key}" title="Drag to reorder">::</div>
              <button class="section-delete-btn" draggable="false" data-section-key="${a.key}" title="Delete section">&times;</button>
              <div class="section-block-label" style="${labelStyleFor(cardWidthPx(a.widthFt))}">${a.label}</div>
              <div class="section-block-width">${a.widthFt.toFixed(1)}ft</div>
              <div class="resize-handle" data-section-key="${a.key}"></div>
            </div>
          `).join('')}
          <div class="add-section-block">
            ${availableToAdd.length
              ? `<select class="add-section-select">
                  <option value="">+ Add Section...</option>
                  ${availableToAdd.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}
                </select>`
              : '<span>All categories allocated</span>'}
          </div>
        </div>
        <div class="section-list" style="margin-top:12px;">
          ${sorted.map((a) => `
            <div class="section-list-item${a.key === highlightedKey ? ' highlighted' : ''}" data-section-key="${a.key}">
              <span>${a.label}</span>
              <span style="font-family:var(--font-mono);color:var(--text2);">${a.widthFt.toFixed(1)}ft</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function render() {
    const { stores } = store.getSnapshot();
    if (!selectedStoreId) selectedStoreId = store.getActiveStoreId() || stores[0]?.storeId;
    const targetStore = stores.find((s) => s.storeId === selectedStoreId);

    el.innerHTML = `
      <div class="page-header">
        <h1>Set Layout</h1>
        <p>Define the physical fixture (bays and shelves) and how much space each wine category gets. Drag the :: handle to reorder a section, drag its right edge to resize (you can expand past the fixture's width -- the banner above flags it), or delete/add sections. This does not decide which SKUs appear -- that's the Optimization Engine's job, working within the space allocated here.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;gap:16px;">
        <div>
          <div class="card-label" style="margin-bottom:6px;">Store</div>
          <select class="store-select">
            ${stores.map((s) => `<option value="${s.storeId}" ${s.storeId === selectedStoreId ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="layout-output"></div>
    `;

    const output = el.querySelector('.layout-output');
    if (targetStore) {
      const allocations = ensureAllocations(targetStore.storeId);
      output.innerHTML = renderFixtureStrip(targetStore) + renderAllocationStrip(targetStore, allocations);
      bindListeners(output);
    }

    el.querySelector('.store-select').addEventListener('change', (e) => {
      selectedStoreId = e.target.value;
      store.setActiveStoreId(selectedStoreId);
      render();
    });
  }

  // renderOutputOnly() replaces the whole card's innerHTML on every action
  // (drag-reorder, resize, delete, add) -- without this, the category strip
  // and list both silently reset their scroll position to the far left/top
  // on every re-render, so dropping a dragged card anywhere but near the
  // start of the strip immediately jumps the view away from where you just
  // dropped it. Snapshot both scroll positions before the DOM is torn down
  // and reapply them to the freshly-rendered elements.
  function renderOutputOnly() {
    const targetStore = currentStore();
    if (!targetStore) return;
    const allocations = store.getSectionAllocations(targetStore.storeId);
    const output = el.querySelector('.layout-output');
    const prevStripScroll = output.querySelector('.category-strip')?.scrollLeft ?? 0;
    const prevListScroll = output.querySelector('.section-list')?.scrollTop ?? 0;
    output.innerHTML = renderFixtureStrip(targetStore) + renderAllocationStrip(targetStore, allocations);
    bindListeners(output);
    const nextStrip = output.querySelector('.category-strip');
    if (nextStrip) nextStrip.scrollLeft = prevStripScroll;
    const nextList = output.querySelector('.section-list');
    if (nextList) nextList.scrollTop = prevListScroll;
  }

  function bindListeners(output) {
    output.querySelectorAll('.bay-shelf-minus, .bay-shelf-plus').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const bayId = e.target.dataset.bayId;
        const targetStore = currentStore();
        const bay = targetStore.shelfLayout.bays.find((b) => b.bayId === bayId);
        const delta = e.target.classList.contains('bay-shelf-plus') ? 1 : -1;
        store.setBayShelfCount(selectedStoreId, bayId, bay.shelfCount + delta);
        renderOutputOnly();
      });
    });

    output.querySelector('.add-bay-btn')?.addEventListener('click', () => {
      store.addBay(selectedStoreId);
      renderOutputOnly();
    });

    output.querySelector('.remove-bay-btn')?.addEventListener('click', () => {
      store.removeBay(selectedStoreId);
      renderOutputOnly();
    });

    output.querySelectorAll('.section-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const key = e.target.dataset.sectionKey;
        if (!confirm('Delete this section from the allocation?')) return;
        const allocations = store.getSectionAllocations(selectedStoreId)
          .slice().sort((a, b) => a.order - b.order)
          .filter((a) => a.key !== key);
        recompactAndSave(allocations);
        renderOutputOnly();
      });
    });

    output.querySelector('.add-section-select')?.addEventListener('change', (e) => {
      const key = e.target.value;
      if (!key) return;
      const allSections = groupBySection(store.getSnapshot().skus);
      const section = allSections.get(key);
      const targetStore = currentStore();
      const physicalWidthFt = getPhysicalWidthFt(targetStore.shelfLayout);
      const allocations = store.getSectionAllocations(selectedStoreId).slice().sort((a, b) => a.order - b.order);
      const totalAllocated = allocations.reduce((sum, a) => sum + a.widthFt, 0);
      const remaining = Math.max(MIN_SECTION_WIDTH_FT, physicalWidthFt - totalAllocated);
      const widthFt = Math.min(4, remaining);
      allocations.push({ key: section.key, label: section.label, order: allocations.length, startFt: 0, widthFt });
      recompactAndSave(allocations);
      renderOutputOnly();
    });

    output.querySelectorAll('.section-block, .section-list-item').forEach((el2) => {
      el2.addEventListener('click', (e) => {
        if (e.target.closest('.section-delete-btn') || e.target.closest('.resize-handle')) return;
        highlightedKey = el2.dataset.sectionKey;
        renderOutputOnly();
      });
    });

    bindDragReorder(output, '.section-block', 'x');
    bindDragReorder(output, '.section-list-item', 'y');
    bindResizeHandles(output);
  }

  // Takes an array already in its FINAL desired order and stamps
  // order/startFt to match -- it must NOT re-sort by each item's existing
  // `.order` field, since callers like drag-reorder pass an array whose
  // order was just changed via splice while the stale `.order` values on
  // the objects themselves haven't been updated yet; sorting by them here
  // would silently undo the reorder.
  function recompactAndSave(allocationsInFinalOrder) {
    let cursor = 0;
    allocationsInFinalOrder.forEach((a, i) => {
      a.order = i;
      a.startFt = cursor;
      cursor += a.widthFt;
    });
    store.setSectionAllocations(selectedStoreId, allocationsInFinalOrder);
  }

  // Pointer-based reorder rather than native HTML5 drag-and-drop (which
  // proved unreliable here) or elementFromPoint hit-testing (fragile
  // against overlapping/absolutely-positioned children like the resize
  // handle) -- instead, snapshot every item's actual on-screen center
  // position ONCE at drag start via getBoundingClientRect, then during the
  // drag just compare the pointer's current position to those fixed
  // positions. Pure geometry, no hit-testing, nothing for overlapping
  // elements to interfere with. Works on either the horizontal box strip
  // (axis 'x') or the vertical text list (axis 'y') -- both edit the same
  // underlying sectionAllocations order, so dragging in either place stays
  // in sync with the other.
  function bindDragReorder(output, itemSelector, axis) {
    output.querySelectorAll(itemSelector).forEach((item) => {
      item.addEventListener('pointerdown', (e) => {
        // Don't start a drag when the user is actually clicking the delete
        // button or the resize handle -- those have their own behavior
        // (the resize handle also calls stopPropagation, but the delete
        // button is a plain button with no such guard).
        if (e.target.closest('.section-delete-btn') || e.target.closest('.resize-handle')) return;
        e.preventDefault();
        const key = item.dataset.sectionKey;

        const items = [...output.querySelectorAll(itemSelector)];
        const positions = items.map((it) => {
          const rect = it.getBoundingClientRect();
          const center = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
          return { key: it.dataset.sectionKey, center };
        });

        draggedKey = key;
        item.classList.add('dragging');
        let currentTargetKey = null;

        function onMove(moveEvent) {
          const pos = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
          let closest = null;
          let closestDist = Infinity;
          positions.forEach((p) => {
            if (p.key === draggedKey) return;
            const dist = Math.abs(pos - p.center);
            if (dist < closestDist) { closestDist = dist; closest = p.key; }
          });

          output.querySelectorAll(`${itemSelector}.drop-target`).forEach((it) => it.classList.remove('drop-target'));
          currentTargetKey = closest;
          if (closest) {
            const targetItem = output.querySelector(`${itemSelector}[data-section-key="${closest}"]`);
            targetItem?.classList.add('drop-target');
          }
        }

        function onUp() {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          item.classList.remove('dragging');
          output.querySelectorAll(`${itemSelector}.drop-target`).forEach((it) => it.classList.remove('drop-target'));

          if (currentTargetKey && currentTargetKey !== draggedKey) {
            const allocations = store.getSectionAllocations(selectedStoreId);
            const fromIndex = allocations.findIndex((a) => a.key === draggedKey);
            const targetIndex = allocations.findIndex((a) => a.key === currentTargetKey);
            if (fromIndex !== -1 && targetIndex !== -1) {
              // Real insert-and-shift: pull the dragged section out, drop it
              // in at the target's position, and recompact the whole run so
              // every section between old and new position slides over by
              // one slot -- not a two-item swap (see recompactAndSave's own
              // comment on why it must run off final array order, not each
              // item's stale .order field).
              const reordered = [...allocations];
              const [moved] = reordered.splice(fromIndex, 1);
              reordered.splice(targetIndex, 0, moved);
              recompactAndSave(reordered);
            }
          }
          draggedKey = null;
          renderOutputOnly();
        }

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  }

  // Resizing a section only ever changes THAT section's own width -- it
  // never steals space from a neighbor. A section can be expanded past
  // what the fixture physically has; the totals banner above already
  // flags that as an over-allocation rather than blocking the resize, per
  // "the application should display when total allocated section widths
  // exceed the available fixture width so the user can rebalance."
  function bindResizeHandles(output) {
    output.querySelectorAll('.resize-handle').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = handle.dataset.sectionKey;
        const allocations = store.getSectionAllocations(selectedStoreId).slice().sort((a, b) => a.order - b.order);
        const target = allocations.find((a) => a.key === key);
        if (!target) return;

        const startX = e.clientX;
        const startWidth = target.widthFt;
        const block = output.querySelector(`.section-block[data-section-key="${key}"]`);
        handle.classList.add('active');
        let pendingWidth = startWidth;

        function onMove(moveEvent) {
          const deltaFt = (moveEvent.clientX - startX) / CATEGORY_PX_PER_FT;
          pendingWidth = Math.max(MIN_SECTION_WIDTH_FT, startWidth + deltaFt);
          if (block) {
            const px = cardWidthPx(pendingWidth);
            block.style.width = `${px}px`;
            block.querySelector('.section-block-width').textContent = `${pendingWidth.toFixed(1)}ft`;
            block.querySelector('.section-block-label').setAttribute('style', labelStyleFor(px));
          }
        }

        function onUp() {
          handle.classList.remove('active');
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);

          target.widthFt = pendingWidth;
          recompactAndSave(allocations);
          renderOutputOnly();
        }

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  }

  render();
  return () => { el.innerHTML = ''; };
}
