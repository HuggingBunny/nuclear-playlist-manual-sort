/**
 * Nuclear Music Player - Playlist Manual Sort Plugin
 * Author: Chad Longanecker
 * License: MIT
 *
 * Adds a new "Manual" sort option to Nuclear's Playlists view and enables
 * intuitive click-and-drag reordering of playlists with persistent storage.
 */
'use strict';

let api = null;
let currentSortMode = 'manual';
let manualPlaylistOrder = [];
let playlistIndex = [];
const playlistTitleToIdMap = new Map();
const playlistIdToEntryMap = new Map();

let unsubscribers = [];
let domObserver = null;
let syncInterval = null;
let styleEl = null;

let draggedCard = null;
let suppressClicksUntil = 0;
let isReorderingDom = false;

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
      transition: transform 0.18s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.18s ease, opacity 0.18s ease;
      user-select: none !important;
      -webkit-user-drag: element;
    }

    .manual-sort-active [data-testid="card"]:active {
      cursor: grabbing !important;
    }

    .manual-sort-active [data-testid="card"].is-dragging {
      opacity: 0.4 !important;
      transform: scale(0.96) !important;
      box-shadow: 0 0 0 2px var(--primary-9, #fc83d3), 0 12px 28px rgba(0, 0, 0, 0.6) !important;
    }

    .manual-sort-active [data-testid="card"].drag-over-before {
      box-shadow: -4px 0 0 0 var(--primary-9, #fc83d3) !important;
      transform: translateX(4px);
    }

    .manual-sort-active [data-testid="card"].drag-over-after {
      box-shadow: 4px 0 0 0 var(--primary-9, #fc83d3) !important;
      transform: translateX(-4px);
    }

    .manual-drag-handle {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 15;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: rgba(18, 18, 18, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.14);
      opacity: 0.65;
      pointer-events: none;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
    }

    [data-testid="card"]:hover .manual-drag-handle {
      opacity: 1;
      background: rgba(0, 0, 0, 0.88);
      color: #ffffff;
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

  // Prune any deleted playlist IDs from manualPlaylistOrder
  const validIds = new Set(playlistIdToEntryMap.keys());
  let changed = false;

  manualPlaylistOrder = manualPlaylistOrder.filter(id => validIds.has(id));

  // Append any newly created/imported playlists not yet in manual order
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
  } catch (err) {
    api?.Logger?.warn?.('[PlaylistManualSort] Failed to persist sort mode: ' + err);
  }
}

/**
 * Resolves the playlist ID for a given card DOM node.
 */
function getPlaylistIdFromCard(cardEl) {
  if (!cardEl) return null;
  if (cardEl.dataset.playlistId) return cardEl.dataset.playlistId;

  // 1. Inspect React Fiber key on DOM node
  for (const prop in cardEl) {
    if (prop.startsWith('__reactFiber$')) {
      const fiber = cardEl[prop];
      if (fiber?.key && playlistIdToEntryMap.has(String(fiber.key))) {
        cardEl.dataset.playlistId = String(fiber.key);
        return String(fiber.key);
      }
      if (fiber?.return?.key && playlistIdToEntryMap.has(String(fiber.return.key))) {
        cardEl.dataset.playlistId = String(fiber.return.key);
        return String(fiber.return.key);
      }
    }
  }

  // 2. Fallback: match by title text in card
  const titleEl = cardEl.querySelector('[data-testid="card-title"]');
  const title = titleEl?.textContent?.trim();
  if (title && playlistTitleToIdMap.has(title)) {
    const id = playlistTitleToIdMap.get(title);
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

  // Attach inside card's relative aspect-square image container if present, else card
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
 * Drag and Drop Event Listeners for Playlist Cards
 */
function handleCardDragStart(e) {
  if (currentSortMode !== 'manual') return;

  const card = e.currentTarget;
  draggedCard = card;
  card.classList.add('is-dragging');

  const playlistId = getPlaylistIdFromCard(card);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', playlistId || '');

  // Add subtle drag ghost transparency
  if (e.dataTransfer.setDragImage) {
    e.dataTransfer.setDragImage(card, e.offsetX || 40, e.offsetY || 40);
  }
}

function handleCardDragOver(e) {
  if (currentSortMode !== 'manual' || !draggedCard) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const targetCard = e.currentTarget;
  if (targetCard === draggedCard) return;

  const rect = targetCard.getBoundingClientRect();
  const isAfter = (e.clientX - rect.left) > (rect.width / 2);

  targetCard.classList.toggle('drag-over-after', isAfter);
  targetCard.classList.toggle('drag-over-before', !isAfter);
}

function handleCardDragLeave(e) {
  const card = e.currentTarget;
  card.classList.remove('drag-over-before', 'drag-over-after');
}

function handleCardDrop(e) {
  if (currentSortMode !== 'manual' || !draggedCard) return;

  e.preventDefault();
  e.stopPropagation();

  const targetCard = e.currentTarget;
  targetCard.classList.remove('drag-over-before', 'drag-over-after');

  if (targetCard !== draggedCard) {
    const rect = targetCard.getBoundingClientRect();
    const isAfter = (e.clientX - rect.left) > (rect.width / 2);

    if (isAfter) {
      targetCard.after(draggedCard);
    } else {
      targetCard.before(draggedCard);
    }

    // Extract new DOM order and save
    const grid = targetCard.closest('[role="grid"]') || targetCard.parentElement;
    if (grid) {
      const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
      const newOrder = cards.map(c => getPlaylistIdFromCard(c)).filter(Boolean);

      if (newOrder.length > 0) {
        manualPlaylistOrder = newOrder;
        persistManualOrder();
        api?.Logger?.info?.(`[PlaylistManualSort] Updated manual order (${newOrder.length} playlists)`);
      }
    }
  }

  suppressClicksUntil = Date.now() + 300;
}

function handleCardDragEnd(e) {
  const card = e.currentTarget;
  card.classList.remove('is-dragging');
  draggedCard = null;

  document.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => {
    el.classList.remove('drag-over-before', 'drag-over-after');
  });

  suppressClicksUntil = Date.now() + 300;
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
 * Attaches drag-and-drop listeners to a card.
 */
function attachDragListeners(cardEl) {
  if (cardEl.__manualSortAttached) return;
  cardEl.__manualSortAttached = true;

  cardEl.setAttribute('draggable', 'true');
  cardEl.addEventListener('dragstart', handleCardDragStart);
  cardEl.addEventListener('dragover', handleCardDragOver);
  cardEl.addEventListener('dragleave', handleCardDragLeave);
  cardEl.addEventListener('drop', handleCardDrop);
  cardEl.addEventListener('dragend', handleCardDragEnd);
  cardEl.addEventListener('click', handleCardClickCapture, true);
}

/**
 * Detaches drag-and-drop listeners from a card.
 */
function detachDragListeners(cardEl) {
  if (!cardEl.__manualSortAttached) return;
  cardEl.__manualSortAttached = false;

  cardEl.removeAttribute('draggable');
  cardEl.classList.remove('is-dragging', 'drag-over-before', 'drag-over-after');
  cardEl.removeEventListener('dragstart', handleCardDragStart);
  cardEl.removeEventListener('dragover', handleCardDragOver);
  cardEl.removeEventListener('dragleave', handleCardDragLeave);
  cardEl.removeEventListener('drop', handleCardDrop);
  cardEl.removeEventListener('dragend', handleCardDragEnd);
  cardEl.removeEventListener('click', handleCardClickCapture, true);
  removeDragHandle(cardEl);
}

/**
 * Applies the manual playlist order to cards in the DOM.
 */
function applyManualOrderToDom(grid) {
  if (!grid || isReorderingDom) return;
  if (!manualPlaylistOrder || manualPlaylistOrder.length === 0) return;

  const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
  if (cards.length === 0) return;

  const cardMap = new Map();
  for (const card of cards) {
    const id = getPlaylistIdFromCard(card);
    if (id) {
      cardMap.set(id, card);
    }
  }

  // Check if DOM already matches manualPlaylistOrder
  let alreadyOrdered = true;
  let orderIndex = 0;
  for (const card of cards) {
    const id = getPlaylistIdFromCard(card);
    if (id && orderIndex < manualPlaylistOrder.length) {
      if (id !== manualPlaylistOrder[orderIndex]) {
        alreadyOrdered = false;
        break;
      }
      orderIndex++;
    }
  }

  if (alreadyOrdered) return;

  isReorderingDom = true;
  try {
    const fragment = document.createDocumentFragment();
    const appendedIds = new Set();

    for (const id of manualPlaylistOrder) {
      const card = cardMap.get(id);
      if (card) {
        fragment.appendChild(card);
        appendedIds.add(id);
      }
    }

    // Append any playlists that weren't in manualPlaylistOrder
    for (const card of cards) {
      const id = getPlaylistIdFromCard(card);
      if (id && !appendedIds.has(id)) {
        fragment.appendChild(card);
      }
    }

    grid.appendChild(fragment);
  } finally {
    isReorderingDom = false;
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
    let labelSpan = button.querySelector('span.truncate') || button.querySelector('span');
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

  // Prepend Manual at the top of the listbox
  listboxEl.insertBefore(manualOption, listboxEl.firstChild);

  // If manual is currently active, remove checkmarks from other options
  if (isSelected) {
    const otherChecks = listboxEl.querySelectorAll('li:not([data-manual-sort-option]) span');
    otherChecks.forEach(span => {
      if (span.textContent?.includes('✓')) {
        span.style.display = 'none';
      }
    });
  }

  // Handle click on Manual
  manualOption.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    persistSortMode('manual');

    // Update checkmark
    const check = manualOption.querySelector('.manual-check-icon');
    if (check) check.style.display = '';

    // Update button text
    const sortContainer = document.querySelector('[data-testid="sort-playlists"]');
    updateSortButtonLabel(sortContainer);

    // Close the listbox menu by clicking outside or pressing Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Re-apply DOM layout
    syncPlaylistsView();
  });

  // Handle click on any other option (switch to native sort)
  const otherOptions = listboxEl.querySelectorAll('li:not([data-manual-sort-option])');
  otherOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      persistSortMode('native');
      const check = manualOption.querySelector('.manual-check-icon');
      if (check) check.style.display = 'none';
      syncPlaylistsView();
    });
  });
}

/**
 * Main DOM synchronization routine for the Playlists view.
 */
function syncPlaylistsView() {
  const playlistsView = document.querySelector('[data-testid="playlists-view"]');
  if (!playlistsView) return;

  const sortContainer = playlistsView.querySelector('[data-testid="sort-playlists"]');
  if (sortContainer) {
    updateSortButtonLabel(sortContainer);

    // Watch for listbox menu opening
    const listbox = document.querySelector('ul[role="listbox"], ul[id$="-listbox"]');
    if (listbox) {
      enhanceListboxMenu(listbox);
    }
  }

  const grid = playlistsView.querySelector('[role="grid"]') || playlistsView.querySelector('.grid');
  if (!grid) return;

  const cards = Array.from(grid.querySelectorAll('[data-testid="card"]'));
  if (cards.length === 0) return;

  // Tag cards with playlist IDs
  for (const card of cards) {
    getPlaylistIdFromCard(card);
  }

  if (currentSortMode === 'manual') {
    grid.classList.add('manual-sort-active');
    applyManualOrderToDom(grid);

    for (const card of cards) {
      ensureDragHandle(card);
      attachDragListeners(card);
    }
  } else {
    grid.classList.remove('manual-sort-active');
    for (const card of cards) {
      detachDragListeners(card);
    }
  }
}

const plugin = {
  async onEnable(pluginApi) {
    api = pluginApi;
    api.Logger?.info('[PlaylistManualSort] Enabling Playlist Manual Sort plugin');

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
    } catch (e) {
      api.Logger?.warn?.('[PlaylistManualSort] Settings registration notice: ' + e);
    }

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
            syncPlaylistsView();
          })
        );
      }
    } catch (e) {
      api.Logger?.warn?.('[PlaylistManualSort] Failed to get initial playlist index: ' + e);
    }

    // Route and DOM observer
    const mainWorkspace = document.querySelector('main[data-testid="player-workspace-main"]') || document.body;
    domObserver = new MutationObserver(() => {
      syncPlaylistsView();
    });

    domObserver.observe(mainWorkspace, { childList: true, subtree: true });
    domObserver.observe(document.body, { childList: true, subtree: false });

    // Periodic sync interval
    syncInterval = setInterval(() => {
      syncPlaylistsView();
    }, 1200);

    // Initial sync
    syncPlaylistsView();

    api.Logger?.info('[PlaylistManualSort] Playlist Manual Sort plugin active');
  },

  async onDisable() {
    api?.Logger?.info('[PlaylistManualSort] Disabling Playlist Manual Sort plugin');

    for (const off of unsubscribers) {
      try { off(); } catch (_) {}
    }
    unsubscribers = [];

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }

    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }

    // Cleanup cards in DOM
    const playlistsView = document.querySelector('[data-testid="playlists-view"]');
    if (playlistsView) {
      const grid = playlistsView.querySelector('[role="grid"]') || playlistsView.querySelector('.grid');
      if (grid) {
        grid.classList.remove('manual-sort-active');
        const cards = grid.querySelectorAll('[data-testid="card"]');
        cards.forEach(detachDragListeners);
      }
    }

    // Remove injected option
    const manualOpt = document.querySelector('[data-manual-sort-option]');
    if (manualOpt && manualOpt.parentNode) {
      manualOpt.parentNode.removeChild(manualOpt);
    }

    removeStyles();

    api = null;
    draggedCard = null;
  }
};

module.exports = plugin;
