/**
 * Nuclear Music Player - Playlist Manual Sort Plugin
 * Author: Chad Longanecker
 * License: MIT
 *
 * Adds a new "Manual" sort option to Nuclear's Playlists view and enables
 * high-performance 60fps drag-and-drop playlist reordering with persistent storage.
 */
'use strict';

let api = null;
let currentSortMode = 'manual';
let manualPlaylistOrder = [];
let playlistIndex = [];
const playlistTitleToIdMap = new Map();
const playlistIdToEntryMap = new Map();

let unsubscribers = [];
let workspaceObserver = null;
let gridObserver = null;
let syncDebounceTimer = null;
let styleEl = null;

let pointerDragState = null;
let suppressClicksUntil = 0;
let isReorderingDom = false;
let rafId = null;

const STYLE_ID = 'nuclear-playlist-manual-sort-styles';
const STORAGE_KEY_ORDER = 'nuclear_playlist_manual_order';
const STORAGE_KEY_MODE = 'nuclear_playlist_sort_mode';

/**
 * Injects required stylesheet for manual drag-and-drop visuals.
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = `
    .manual-sort-active [data-testid="card"] {
      cursor: grab !important;
      position: relative !important;
      user-select: none !important;
      touch-action: none !important;
      transition: box-shadow 0.15s ease, opacity 0.15s ease !important;
    }

    .manual-sort-active [data-testid="card"]:active {
      cursor: grabbing !important;
    }

    .manual-sort-active [data-testid="card"].is-dragging {
      opacity: 0.25 !important;
      box-shadow: 0 0 0 2px var(--primary-9, #fc83d3) !important;
    }

    .manual-sort-active [data-testid="card"].drag-over-before {
      box-shadow: -4px 0 0 0 var(--primary-9, #fc83d3) !important;
    }

    .manual-sort-active [data-testid="card"].drag-over-after {
      box-shadow: 4px 0 0 0 var(--primary-9, #fc83d3) !important;
    }

    .manual-drag-handle {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 15;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: rgba(18, 18, 18, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.15);
      opacity: 0.7;
      pointer-events: none;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
    }

    [data-testid="card"]:hover .manual-drag-handle {
      opacity: 1;
      background: rgba(0, 0, 0, 0.92);
      color: #ffffff;
    }

    #manual-drag-ghost {
      pointer-events: none !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      z-index: 99999 !important;
      opacity: 0.92 !important;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.75), 0 0 0 2px var(--primary-9, #fc83d3) !important;
      border-radius: 8px;
      overflow: hidden;
      will-change: transform;
      transform-origin: 0 0;
    }

    [data-manual-sort-option] {
      transition: background 0.12s ease;
    }

    [data-manual-sort-option]:hover {
      background: rgba(255, 255, 255, 0.08) !important;
    }
  `;
  document.head.appendChild(styleEl);
}

/**
 * Removes injected stylesheet.
 */
function removeStyles() {
  if (styleEl && styleEl.parentNode) {
    styleEl.parentNode.removeChild(styleEl);
  }
  styleEl = null;
}

/**
 * Updates internal maps of playlist IDs and titles.
 */
function updatePlaylistIndexCache(index) {
  if (!Array.isArray(index)) return;
  playlistIndex = index;
  playlistTitleToIdMap.clear();
  playlistIdToEntryMap.clear();

  for (const entry of index) {
    if (entry && entry.id) {
      playlistIdToEntryMap.set(entry.id, entry);
      if (entry.name) {
        playlistTitleToIdMap.set(entry.name.trim(), entry.id);
      }
    }
  }

  // Prune deleted playlist IDs from manualPlaylistOrder
  const validIds = new Set(playlistIdToEntryMap.keys());
  let changed = false;

  const filteredOrder = manualPlaylistOrder.filter(id => validIds.has(id));
  if (filteredOrder.length !== manualPlaylistOrder.length) {
    manualPlaylistOrder = filteredOrder;
    changed = true;
  }

  // Append newly created/imported playlists not yet in manual order
  for (const entry of index) {
    if (entry?.id && !manualPlaylistOrder.includes(entry.id)) {
      manualPlaylistOrder.push(entry.id);
      changed = true;
    }
  }

  if (changed) {
    persistManualOrder();
  }
}

/**
 * Persists manual playlist order to plugin settings and local cache.
 */
async function persistManualOrder() {
  try {
    const raw = JSON.stringify(manualPlaylistOrder);
    localStorage.setItem(STORAGE_KEY_ORDER, raw);
    if (api?.Settings?.set) {
      await api.Settings.set('manualOrder', raw);
    }
    api?.Logger?.info?.(`[PlaylistManualSort] Persisted manual order (${manualPlaylistOrder.length} playlists)`);
  } catch (err) {
    api?.Logger?.warn?.('[PlaylistManualSort] Failed to persist manual order: ' + err);
  }
}

/**
 * Persists active sort mode.
 */
async function persistSortMode(mode) {
  try {
    currentSortMode = mode;
    localStorage.setItem(STORAGE_KEY_MODE, mode);
    if (api?.Settings?.set) {
      await api.Settings.set('sortBy', mode);
    }
    api?.Logger?.info?.(`[PlaylistManualSort] Switched sort mode to: ${mode}`);
  } catch (err) {
    api?.Logger?.warn?.('[PlaylistManualSort] Failed to persist sort mode: ' + err);
  }
}

/**
 * Resolves the playlist ID for a given card DOM node with caching.
 */
function getPlaylistIdFromCard(cardEl) {
  if (!cardEl) return null;
  if (cardEl._nuclearPlaylistId) return cardEl._nuclearPlaylistId;
  if (cardEl.dataset.playlistId && playlistIdToEntryMap.has(cardEl.dataset.playlistId)) {
    cardEl._nuclearPlaylistId = cardEl.dataset.playlistId;
    return cardEl._nuclearPlaylistId;
  }

  // 1. Deep traverse React Fiber hierarchy to find key
  for (const prop in cardEl) {
    if (prop.startsWith('__reactFiber$')) {
      let cur = cardEl[prop];
      let depth = 0;
      while (cur && depth < 12) {
        if (cur.key && playlistIdToEntryMap.has(String(cur.key))) {
          const id = String(cur.key);
          cardEl._nuclearPlaylistId = id;
          cardEl.dataset.playlistId = id;
          return id;
        }
        cur = cur.return;
        depth++;
      }
    }
  }

  // 2. Fallback: match by title text in card
  const titleEl = cardEl.querySelector('[data-testid="card-title"]');
  const title = titleEl?.textContent?.trim();
  if (title && playlistTitleToIdMap.has(title)) {
    const id = playlistTitleToIdMap.get(title);
    cardEl._nuclearPlaylistId = id;
    cardEl.dataset.playlistId = id;
    return id;
  }

  return null;
}

/**
 * Ensures the drag handle SVG icon is attached to a playlist card.
 */
function ensureDragHandle(cardEl) {
  if (cardEl.querySelector('.manual-drag-handle')) return;

  const handle = document.createElement('div');
  handle.className = 'manual-drag-handle';
  handle.title = 'Manual Sort: Drag to reorganize';
  handle.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="8.5" cy="6.5" r="2"/>
      <circle cx="15.5" cy="6.5" r="2"/>
      <circle cx="8.5" cy="12" r="2"/>
      <circle cx="15.5" cy="12" r="2"/>
      <circle cx="8.5" cy="17.5" r="2"/>
      <circle cx="15.5" cy="17.5" r="2"/>
    </svg>
  `;

  const imgBox = cardEl.querySelector('.aspect-square') || cardEl;
  imgBox.appendChild(handle);
}

/**
 * Removes drag handle from a playlist card.
 */
function removeDragHandle(cardEl) {
  const handle = cardEl.querySelector('.manual-drag-handle');
  if (handle && handle.parentNode) {
    handle.parentNode.removeChild(handle);
  }
}

/**
 * Cleans up any leftover drop indicators across cards.
 */
function clearDropIndicators() {
  document.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => {
    el.classList.remove('drag-over-before', 'drag-over-after');
  });
}

/**
 * ULTRA-FAST 60FPS POINTER DRAG CONTROLLER
 * Zero layout thrashing, pure numerical coordinate matching, rAF updates.
 */
function handleCardPointerDown(e) {
  if (currentSortMode !== 'manual') return;
  if (e.button !== 0) return; // Left click only

  const card = e.currentTarget;
  const playlistId = getPlaylistIdFromCard(card);
  if (!playlistId) return;

  const grid = card.closest('[role="grid"]') || card.parentElement;
  if (!grid) return;

  // Cache geometry of all cards ONCE at drag start (0 DOM queries during drag)
  const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
  const cardItems = cards.map(c => ({
    el: c,
    id: getPlaylistIdFromCard(c),
    rect: c.getBoundingClientRect()
  })).filter(c => c.id);

  const rect = card.getBoundingClientRect();

  pointerDragState = {
    card,
    grid,
    playlistId,
    startX: e.clientX,
    startY: e.clientY,
    currentX: e.clientX,
    currentY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    cardWidth: rect.width,
    cardHeight: rect.height,
    isDragging: false,
    ghostEl: null,
    pointerId: e.pointerId,
    cardItems,
    targetItem: null,
    isAfter: false
  };

  card.addEventListener('pointermove', handleCardPointerMove);
  card.addEventListener('pointerup', handleCardPointerUp);
  card.addEventListener('pointercancel', handleCardPointerUp);
}

function handleCardPointerMove(e) {
  if (!pointerDragState) return;

  pointerDragState.currentX = e.clientX;
  pointerDragState.currentY = e.clientY;

  const dx = e.clientX - pointerDragState.startX;
  const dy = e.clientY - pointerDragState.startY;

  if (!pointerDragState.isDragging && (dx * dx + dy * dy) > 25) {
    pointerDragState.isDragging = true;

    try {
      pointerDragState.card.setPointerCapture(pointerDragState.pointerId);
    } catch (_) {}

    pointerDragState.card.classList.add('is-dragging');

    // Create featherweight ghost
    const ghost = pointerDragState.card.cloneNode(true);
    ghost.id = 'manual-drag-ghost';
    ghost.style.width = pointerDragState.cardWidth + 'px';
    ghost.style.height = pointerDragState.cardHeight + 'px';
    ghost.style.transform = `translate3d(${e.clientX - pointerDragState.offsetX}px, ${e.clientY - pointerDragState.offsetY}px, 0)`;

    document.body.appendChild(ghost);
    pointerDragState.ghostEl = ghost;

    // Start rAF loop
    startDragRaf();
  }
}

function startDragRaf() {
  if (rafId) return;

  function update() {
    if (!pointerDragState || !pointerDragState.isDragging) {
      rafId = null;
      return;
    }

    const { ghostEl, currentX, currentY, offsetX, offsetY, cardItems, card } = pointerDragState;

    // 1. Move ghost smoothly via GPU translate3d
    if (ghostEl) {
      ghostEl.style.transform = `translate3d(${currentX - offsetX}px, ${currentY - offsetY}px, 0)`;
    }

    // 2. Numerical hit test against cached cardItems (instant, 0 layout reflows)
    let bestTarget = null;
    let isAfter = false;

    for (let i = 0; i < cardItems.length; i++) {
      const item = cardItems[i];
      if (item.el === card) continue;
      const r = item.rect;

      if (currentX >= r.left && currentX <= r.right && currentY >= r.top && currentY <= r.bottom) {
        bestTarget = item;
        isAfter = (currentX - r.left) > (r.width / 2);
        break;
      }
    }

    if (bestTarget !== pointerDragState.targetItem || isAfter !== pointerDragState.isAfter) {
      clearDropIndicators();
      pointerDragState.targetItem = bestTarget;
      pointerDragState.isAfter = isAfter;

      if (bestTarget) {
        bestTarget.el.classList.toggle('drag-over-after', isAfter);
        bestTarget.el.classList.toggle('drag-over-before', !isAfter);
      }
    }

    rafId = requestAnimationFrame(update);
  }

  rafId = requestAnimationFrame(update);
}

function handleCardPointerUp(e) {
  if (!pointerDragState) return;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  const { card, playlistId, isDragging, ghostEl, pointerId, targetItem, isAfter, grid } = pointerDragState;

  try {
    card.releasePointerCapture(pointerId);
  } catch (_) {}

  card.removeEventListener('pointermove', handleCardPointerMove);
  card.removeEventListener('pointerup', handleCardPointerUp);
  card.removeEventListener('pointercancel', handleCardPointerUp);

  if (ghostEl && ghostEl.parentNode) {
    ghostEl.parentNode.removeChild(ghostEl);
  }

  card.classList.remove('is-dragging');
  clearDropIndicators();

  if (isDragging) {
    suppressClicksUntil = Date.now() + 400;

    if (targetItem && targetItem.id && targetItem.id !== playlistId) {
      executeReorder(playlistId, targetItem.id, isAfter, grid, card, targetItem.el);
    }
  }

  pointerDragState = null;
}

/**
 * Reorders array in memory, updates DOM instantly, and persists.
 */
function executeReorder(sourceId, targetId, isAfter, grid, sourceEl, targetEl) {
  const fromIdx = manualPlaylistOrder.indexOf(sourceId);
  const toIdx = manualPlaylistOrder.indexOf(targetId);

  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

  // 1. Update in-memory order array
  manualPlaylistOrder.splice(fromIdx, 1);
  let insertIdx = manualPlaylistOrder.indexOf(targetId);
  if (isAfter) {
    insertIdx += 1;
  }
  manualPlaylistOrder.splice(insertIdx, 0, sourceId);

  // 2. Persist synchronously to localStorage & asynchronously to api.Settings
  persistManualOrder();

  // 3. Move in DOM under atomic lock
  isReorderingDom = true;
  try {
    if (isAfter) {
      targetEl.after(sourceEl);
    } else {
      targetEl.before(sourceEl);
    }
    api?.Logger?.info?.(`[PlaylistManualSort] Live drop reorder complete (${manualPlaylistOrder.length} playlists)`);
  } catch (err) {
    api?.Logger?.warn?.('[PlaylistManualSort] DOM reorder error: ' + err);
  } finally {
    // Keep lock active for 100ms to ignore immediate mutation observer echoes
    setTimeout(() => {
      isReorderingDom = false;
    }, 100);
  }
}

function handleCardClickCapture(e) {
  if (Date.now() < suppressClicksUntil) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return false;
  }
}

/**
 * Attaches drag listeners to a card.
 */
function attachDragListeners(cardEl) {
  if (cardEl.__manualSortAttached) return;
  cardEl.__manualSortAttached = true;

  cardEl.addEventListener('pointerdown', handleCardPointerDown);
  cardEl.addEventListener('click', handleCardClickCapture, true);
}

/**
 * Detaches drag listeners from a card.
 */
function detachDragListeners(cardEl) {
  if (!cardEl.__manualSortAttached) return;
  cardEl.__manualSortAttached = false;

  cardEl.removeEventListener('pointerdown', handleCardPointerDown);
  cardEl.removeEventListener('click', handleCardClickCapture, true);
  cardEl.classList.remove('is-dragging', 'drag-over-before', 'drag-over-after');
  removeDragHandle(cardEl);
}

/**
 * Applies the manual playlist order to cards in the DOM in a single atomic batch.
 */
function applyManualOrderToDom(grid) {
  if (!grid || isReorderingDom) return;
  if (!manualPlaylistOrder || manualPlaylistOrder.length === 0) return;

  const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
  if (cards.length === 0) return;

  const cardMap = new Map();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const id = getPlaylistIdFromCard(card);
    if (id) {
      cardMap.set(id, card);
    }
  }

  // Check if DOM already matches
  let alreadyOrdered = true;
  for (let i = 0; i < cards.length && i < manualPlaylistOrder.length; i++) {
    const id = getPlaylistIdFromCard(cards[i]);
    if (id && id !== manualPlaylistOrder[i]) {
      alreadyOrdered = false;
      break;
    }
  }

  if (alreadyOrdered) return;

  isReorderingDom = true;
  try {
    const fragment = document.createDocumentFragment();
    const appendedIds = new Set();

    for (let i = 0; i < manualPlaylistOrder.length; i++) {
      const id = manualPlaylistOrder[i];
      const card = cardMap.get(id);
      if (card) {
        fragment.appendChild(card);
        appendedIds.add(id);
      }
    }

    // Append any extra cards
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const id = getPlaylistIdFromCard(card);
      if (id && !appendedIds.has(id)) {
        fragment.appendChild(card);
      }
    }

    grid.appendChild(fragment);
  } finally {
    setTimeout(() => {
      isReorderingDom = false;
    }, 50);
  }
}

/**
 * Updates the sort select button label inside [data-testid="sort-playlists"].
 */
function updateSortButtonLabel(sortContainer) {
  if (!sortContainer) return;
  const button = sortContainer.querySelector('button');
  if (!button) return;

  if (currentSortMode === 'manual') {
    const labelSpan = button.querySelector('span.truncate') || button.querySelector('span');
    if (labelSpan && labelSpan.textContent !== 'Manual') {
      labelSpan.textContent = 'Manual';
    }
  }
}

/**
 * Enhances the Headless UI listbox options menu by injecting the "Manual" option.
 */
function enhanceListboxMenu(listboxEl) {
  if (!listboxEl || listboxEl.querySelector('[data-manual-sort-option]')) return;

  const firstOption = listboxEl.querySelector('li[role="option"]');
  if (!firstOption) return;

  const manualOption = document.createElement('li');
  manualOption.setAttribute('role', 'option');
  manualOption.setAttribute('data-manual-sort-option', 'true');
  manualOption.className = firstOption.className;

  const isSelected = currentSortMode === 'manual';
  manualOption.innerHTML = `
    <div class="text-popover-foreground cursor-pointer p-1">
      <span class="relative inline-flex w-full flex-row items-center justify-between">
        <span>Manual</span>
        <span class="manual-check-icon" style="${isSelected ? '' : 'display: none;'}">✓</span>
      </span>
    </div>
  `;

  listboxEl.insertBefore(manualOption, listboxEl.firstChild);

  if (isSelected) {
    const otherChecks = listboxEl.querySelectorAll('li:not([data-manual-sort-option]) span');
    otherChecks.forEach(span => {
      if (span.textContent?.includes('✓')) {
        span.style.display = 'none';
      }
    });
  }

  manualOption.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    persistSortMode('manual');

    const check = manualOption.querySelector('.manual-check-icon');
    if (check) check.style.display = '';

    const sortContainer = document.querySelector('[data-testid="sort-playlists"]');
    updateSortButtonLabel(sortContainer);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    triggerSync();
  });

  const otherOptions = listboxEl.querySelectorAll('li:not([data-manual-sort-option])');
  otherOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      persistSortMode('native');
      const check = manualOption.querySelector('.manual-check-icon');
      if (check) check.style.display = 'none';
      triggerSync();
    });
  });
}

/**
 * Debounced sync trigger to prevent tight observer loops.
 */
function triggerSync() {
  if (isReorderingDom) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(syncPlaylistsView, 30);
}

/**
 * Main DOM synchronization routine for the Playlists view.
 */
function syncPlaylistsView() {
  const playlistsView = document.querySelector('[data-testid="playlists-view"]');
  if (!playlistsView) {
    if (gridObserver) {
      gridObserver.disconnect();
      gridObserver = null;
    }
    return;
  }

  const sortContainer = playlistsView.querySelector('[data-testid="sort-playlists"]');
  if (sortContainer) {
    updateSortButtonLabel(sortContainer);

    const listbox = document.querySelector('ul[role="listbox"], ul[id$="-listbox"]');
    if (listbox) {
      enhanceListboxMenu(listbox);
    }
  }

  const grid = playlistsView.querySelector('[role="grid"]') || playlistsView.querySelector('.grid');
  if (!grid) return;

  // Observe grid children directly (never deep subtree)
  if (!gridObserver && window.MutationObserver) {
    gridObserver = new MutationObserver(() => {
      triggerSync();
    });
    gridObserver.observe(grid, { childList: true });
  }

  const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
  if (cards.length === 0) return;

  // Tag cards
  for (let i = 0; i < cards.length; i++) {
    getPlaylistIdFromCard(cards[i]);
  }

  if (currentSortMode === 'manual') {
    grid.classList.add('manual-sort-active');
    applyManualOrderToDom(grid);

    for (let i = 0; i < cards.length; i++) {
      ensureDragHandle(cards[i]);
      attachDragListeners(cards[i]);
    }
  } else {
    grid.classList.remove('manual-sort-active');
    for (let i = 0; i < cards.length; i++) {
      detachDragListeners(cards[i]);
    }
  }
}

const plugin = {
  async onEnable(pluginApi) {
    api = pluginApi;
    api.Logger?.info('[PlaylistManualSort] Enabling Playlist Manual Sort plugin v1.0.0');

    injectStyles();

    // Register settings
    try {
      if (api.Settings?.register) {
        await api.Settings.register([
          {
            id: 'sortBy',
            title: 'Playlist Sort Order',
            description: 'Active sort mode for the Playlists view',
            category: 'Playlists',
            kind: 'string',
            default: 'manual',
            hidden: true
          },
          {
            id: 'manualOrder',
            title: 'Manual Playlist Order',
            description: 'Ordered list of playlist IDs for manual sorting',
            category: 'Playlists',
            kind: 'string',
            default: '[]',
            hidden: true
          }
        ]);
      }
    } catch (_) {}

    // Load initial settings & local cache
    try {
      const savedMode = (await api.Settings?.get?.('sortBy')) || localStorage.getItem(STORAGE_KEY_MODE);
      if (savedMode) {
        currentSortMode = savedMode;
      }

      const rawOrder = (await api.Settings?.get?.('manualOrder')) || localStorage.getItem(STORAGE_KEY_ORDER);
      if (rawOrder) {
        manualPlaylistOrder = typeof rawOrder === 'string' ? JSON.parse(rawOrder) : rawOrder;
      }
    } catch (_) {}

    // Load initial playlist index and subscribe to changes
    try {
      if (api.Playlists?.getIndex) {
        const initialIndex = await api.Playlists.getIndex();
        updatePlaylistIndexCache(initialIndex);
      }
      if (api.Playlists?.subscribe) {
        unsubscribers.push(
          api.Playlists.subscribe((index) => {
            updatePlaylistIndexCache(index);
            triggerSync();
          })
        );
      }
    } catch (_) {}

    // Workspace observer (watches route changes, childList only, no deep subtree)
    const mainWorkspace = document.querySelector('main[data-testid="player-workspace-main"]') || document.body;
    workspaceObserver = new MutationObserver(() => {
      triggerSync();
    });
    workspaceObserver.observe(mainWorkspace, { childList: true });

    // Initial sync
    syncPlaylistsView();

    api.Logger?.info('[PlaylistManualSort] Playlist Manual Sort plugin active (60fps engine)');
  },

  async onDisable() {
    api?.Logger?.info('[PlaylistManualSort] Disabling Playlist Manual Sort plugin');

    for (const off of unsubscribers) {
      try { off(); } catch (_) {}
    }
    unsubscribers = [];

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }

    if (workspaceObserver) {
      workspaceObserver.disconnect();
      workspaceObserver = null;
    }

    if (gridObserver) {
      gridObserver.disconnect();
      gridObserver = null;
    }

    const playlistsView = document.querySelector('[data-testid="playlists-view"]');
    if (playlistsView) {
      const grid = playlistsView.querySelector('[role="grid"]') || playlistsView.querySelector('.grid');
      if (grid) {
        grid.classList.remove('manual-sort-active');
        const cards = grid.querySelectorAll('[data-testid="card"]');
        cards.forEach(detachDragListeners);
      }
    }

    const manualOpt = document.querySelector('[data-manual-sort-option]');
    if (manualOpt && manualOpt.parentNode) {
      manualOpt.parentNode.removeChild(manualOpt);
    }

    removeStyles();

    api = null;
    pointerDragState = null;
  }
};

module.exports = plugin;
