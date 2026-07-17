import { store } from '../core/store.js';
import { groupBySection } from '../optimize/blocking.js';
import { getPhysicalWidthFt, getLinearShelfFeet } from '../optimize/shelfPosition.js';

const PX_PER_FT = 20;
const MIN_BAY_BLOCK_PX = 92; // wide enough for the shelf-count stepper to never overflow a 4ft-scaled block
const MIN_SECTION_WIDTH_FT = 1;
// Andrew, 2026-07-16: with 50+ small MI-derived categories (many under 1ft,
// e.g. Regional, New Zealand, Flavored/Sweet), a strictly-proportional card
// width made most cards ~16px -- unreadable, no room for the category name.
// This is a purely VISUAL floor on the rendered card width; the underlying
// widthFt data and resize/reorder behavior are untouched -- a card can still
// scroll off to the right, per Andrew's "fine if I have to scroll" call.
const MIN_CARD_PX = 168;
function cardWidthPx(widthFt) {
  return Math.max(MIN_CARD_PX, widthFt * PX_PER_FT);
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
            <div class="section-block${a.key === highlightedKey ? ' highlighted' : ''}" style="width:${cardWidthPx(a.widthFt)}px;" data-section-key="${a.key}">
              <div class="section-drag-handle" data-section-key="${a.key}" title="Drag to reorder">::</div>
              <button class="section-delete-btn" draggable="false" data-section-key="${a.key}" title="Delete section">&times;</button>
              <div class="section-block-label">${a.label}</div>
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
            const sorted = [...allocations].sort((a, b) => a.order - b.order);
            const fromIndex = sorted.findIndex((a) => a.key === draggedKey);
            const toIndex = sorted.findIndex((a) => a.key === currentTargetKey);
            if (fromIndex !== -1 && toIndex !== -1) {
              const [moved] = sorted.splice(fromIndex, 1);
              sorted.splice(toIndex, 0, moved);
              recompactAndSave(sorted);
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
          const deltaFt = (moveEvent.clientX - startX) / PX_PER_FT;
          pendingWidth = Math.max(MIN_SECTION_WIDTH_FT, startWidth + deltaFt);
          if (block) {
            block.style.width = `${cardWidthPx(pendingWidth)}px`;
            block.querySelector('.section-block-width').textContent = `${pendingWidth.toFixed(1)}ft`;
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
