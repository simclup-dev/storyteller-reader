// ReadAlong App - Main Orchestrator
// Coordinates all modules and manages global dependencies

import { state, loadPersistedState, setAudioElement, saveBookProgress, resetBook } from './state.js';
import { runVerifier } from './verifier-ui.js';
import { authHdr, fetchWithRetry, initFetchInterceptor } from './http.js';
import { show as showScreen, openPanel as uiOpenPanel, closeAllPanels as uiCloseAllPanels, hideWordPopup, setDependencies, applyModeClass, showConfirm, closeConfirm } from './ui.js';
import { doLogin, doLogout, doDemoLogin, installPWA, initAuth } from './auth.js';
import { loadBooks as loadBooksFromApi, renderBooks, filterBooks, setViewMode, toggleViewMode, toggleBooks, setFolderState, setFilter, setSort, expandShelf } from './books.js';
import { openBook, loadChapter, renderChapters, showBookEnd, renderText, getAuthorName, activateWalkingGestures, deactivateWalkingGestures, resetPageState } from './reader.js';
import { loadAudioChapter, togglePlay, prevSentence, nextSentence, sentenceTap, seekAudio, seekRel, setActive, onTimeUpdate as audioTimeUpdate, onAudioPlay, onAudioPause } from './audio.js';
import { openTranslate, selectTransSentence, resumeFromSelected, renderHistory, showHistoryDetail, addVocabFromSentence, addVocabWord, saveWord, toggleWordStatus, renderVocab, exportVocab } from './translate.js';
import { renderBookmarks, jumpToBookmark, removeBookmark, updateBookmarkBtn, toggleBookmark, downloadChapter, downloadAllChapters, updateDlButtons, goChapter } from './panels.js';
import { initSettings, initSpeedControl, changeFontSize, toggleTheme, setTheme, setAccentColor, setAccentByName, forceThemeStyles, updateSpeedBtn, buildSpeedSlider, setSpeedFromSlider, setFontFamily, markBookFinished, resetBookProgress, exportAllData, importAllData, setDialogueColor, setDialogueIntensity, updateApiProvider, refreshCacheDisplay, setColumns, setLineH, setParaGap, setWalkCurve, setWalkDepth, setDensity, setRadius, setAnimDur } from './settings.js';
import { initGestures, toggleImmersive, exitImmersive } from './gestures.js';
import { initSleepTimer } from './sleep.js';
import { audioCacheSize } from './storage.js';
import { getBookCoverUrl, saveProgressToServer as serverSaveProgress } from './http.js';
import { showToast, fmtTime, esc, safe, logToBuffer, getErrorLog, debounce } from './utils.js';
import { STORAGE_KEYS, DEFAULT_FONT_SIZE } from './constants.js';

let _audioElement = null;
let _filterTimer = null;
// ─── Read-along state machine: single source of truth (sentence + word) ──────
// Two word states exist and BOTH belong exclusively to the active sentence:
//   .word.active — the one word being spoken (accent + underline), one per doc
//   .word.past   — words already spoken within the active sentence (progressive dim)
// On any sentence change, setActiveSentence wipes BOTH from the OUTGOING sentence.
// This makes it physically impossible for a word in a non-active sentence to keep
// .active or .past — in either reading or walking mode, playback or manual nav.
let _activeSentenceEl = null; // current sentence/line element (owns its words)
let _activeWordEl = null;     // current spoken word

function setActiveSentence(el) {
  if (_activeSentenceEl === el) return;
  if (_activeSentenceEl) {
    // Full reset of the outgoing sentence's word state — both active and past.
    _activeSentenceEl.querySelectorAll('.word').forEach(w => w.classList.remove('active', 'past'));
  }
  _activeSentenceEl = el;
  _activeWordEl = null; // word tracker is scoped to the active sentence
}
window.setActiveSentenceEl = setActiveSentence;

function setActiveWord(el) {
  if (_activeWordEl === el) return;
  if (_activeWordEl) _activeWordEl.classList.remove('active');
  _activeWordEl = el;
  if (el) el.classList.add('active');
}
// Sentence change without a known new element (e.g. clearing on chapter load).
function clearActiveWord() { setActiveSentence(null); }
window.clearActiveWord = clearActiveWord;

/**
 * Initialize the application
 */
export async function init() {
  console.log('ReadAlong v2 - Starting...');

  // Set up audio element
  _audioElement = document.getElementById('audio-el');
  setAudioElement(_audioElement);
  if (_audioElement) {
    _audioElement.addEventListener('timeupdate', safe(audioTimeUpdate, 'audio:timeupdate'));
    _audioElement.addEventListener('play', safe(onAudioPlay, 'audio:play'));
    _audioElement.addEventListener('pause', safe(onAudioPause, 'audio:pause'));
  }

  window.addEventListener('error', (e) => {
    logToBuffer('window:error', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logToBuffer('promise:unhandled', e.reason);
  });

  window.addEventListener('resize', debounce(() => {
    if (state.mode === 'walking') {
      const c = document.getElementById('text-content');
      if (c && state.walkingBlocks?.length) {
        const topbar = document.querySelector('.reader-topbar');
        const progress = document.getElementById('reading-progress');
        const playerBarH = document.getElementById('player-bar')?.offsetHeight ?? 0;
        const topbarH = topbar ? topbar.offsetHeight : 0;
        const progressH = progress ? progress.offsetHeight : 0;
        const availH = Math.max(200, window.innerHeight - topbarH - progressH - playerBarH);
        c.style.height = availH + 'px';
      }
      window._scaleWalkBlocks?.();
    } else {
      // Reading mode: pagination re-snaps to the active sentence via its measured
      // column edges (the ResizeObserver in reader.js also fires). No scrollLeft /
      // display:none reflow here — #text-inner is positioned by transform, not native
      // scroll, so the old scroll-restore both did nothing useful and caused flicker.
      window.restorePageBySentence?.(false);
    }
  }, 150));

  // Load persisted settings
  loadPersistedState();

  // Load reading time stats from localStorage
  try {
    state.totalReadingTime = parseInt(localStorage.getItem('total_reading_time'), 10) || 0;
    const today = new Date().toISOString().slice(0, 10);
    const todaySec = parseInt(localStorage.getItem('reading_time_' + today), 10) || 0;
    state.dailyReadingTime = { [today]: todaySec };
  } catch (e) {}

  // Load walk context depth (1/2/3 — controls how many neighbours are visible)
  try {
    const d = parseInt(localStorage.getItem('walk_ctx_depth'), 10);
    state._walkCtxDepth = (d >= 1 && d <= 3) ? d : 2;
  } catch (e) { state._walkCtxDepth = 2; }

  // Load dialogue settings
  try {
    const dc = localStorage.getItem('st_dialogue_color') || '#c8a85a';
    const di = parseInt(localStorage.getItem('st_dialogue_intensity') || '2');
    document.documentElement.style.setProperty('--dialogue-color', dc);
    document.documentElement.style.setProperty('--dialogue-font-style', di >= 2 ? 'italic' : 'normal');
    document.documentElement.style.setProperty('--dialogue-text-shadow', di >= 3 ? '0 0 8px var(--dialogue-color)' : 'none');
    // Update buttons + slider
    document.querySelectorAll('#dc-warm, #dc-blue').forEach(b => {
      b.classList.toggle('active', b.dataset.color === dc);
    });
    const slider = document.getElementById('dialogue-intensity');
    const label = document.getElementById('dialogue-intensity-label');
    if (slider) slider.value = di;
    if (label) label.textContent = di;
  } catch (e) {}

  // Sync mode buttons with actual state
  document.querySelectorAll('.mode-btn, .topbar-tab').forEach(b => b.classList.remove('active'));
  const modeBtn = document.getElementById(`mode-${state.mode}-btn`);
  if (modeBtn) modeBtn.classList.add('active');

   // Initialize all modules
   initAuth();
   initSettings();
   initSpeedControl();
   initGestures();
   initSleepTimer();

   // Setup dependencies for UI modules
   setDependencies({
     getAuthorName,
     fmtTime
   });

   // Setup global event handlers
  setupEventListeners();

  // Restore UI state
  applySavedTheme();
  updateSpeedBtn();
  buildSpeedSlider();

  // Check if already logged in
  const savedToken = localStorage.getItem(STORAGE_KEYS.TOKEN);
  if (savedToken) {
    const savedServer = localStorage.getItem(STORAGE_KEYS.SERVER);
    if (savedServer && savedServer !== 'mock://demo') {
      state.server = savedServer;
      state.token = savedToken;
    }
  }

  console.log('ReadAlong initialized');

  // Show default screen
  if (state.server && state.token && state.server !== 'mock://demo') {
    initFetchInterceptor(state.server);
    show('books');
    loadBooks();
  } else if (state.server === 'mock://demo') {
    // Previous mock session expired; clear and show login
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.SERVER);
    state.token = '';
    state.server = '';
    show('login');
  } else {
    show('login');
  }

  // Export all window.* functions for onclick handlers
  exportGlobalAPI();

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => console.log('SW registered', reg.scope))
      .catch(err => console.warn('SW registration failed', err));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) {
        showToast('🔄 Доступне оновлення — натисніть щоб перезавантажити', 'default', null, () => location.reload());
      }
    });
  }
}

/**
 * Setup DOM event listeners
 */
function setupEventListeners() {
  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(() => {
        state._searchQuery = searchInput.value;
        renderBooks();
      }, 150);
    });
  }

  const searchMode = document.getElementById('search-mode');
  if (searchMode) {
    searchMode.addEventListener('change', () => {
      state._searchMode = searchMode.value;
      renderBooks();
    });
  }

  // Speed slider
  const speedSlider = document.getElementById('speed-slider');
  if (speedSlider) {
    speedSlider.oninput = (e) => setSpeedFromSlider(e.target.value);
  }

  // Font size buttons in settings
  const fontSizeLabel = document.getElementById('font-size-label');
  if (fontSizeLabel) {
    // Will be updated by settings module
  }

  // Visibility change handler for saving progress
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveProgress();
    }
  });

  // Word popup close on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#word-popup')) {
      hideWordPopup();
    }
  });

  // Translate panel history click
  document.getElementById('translate-panel')?.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (item) {
      showHistoryDetail(
        decodeURIComponent(item.dataset.sentence),
        decodeURIComponent(item.dataset.translation),
        decodeURIComponent(item.dataset.explanation || '')
      );
    }
  });

  // Context menu for word translation
  document.addEventListener('contextmenu', (e) => {
    const word = window.getSelection()?.toString().trim();
    if (word && word.length > 1 && /^[a-zA-Z'-]+$/.test(word) && e.target.closest('#text-content')) {
      e.preventDefault();
      showWordPopup(word, e.clientX, e.clientY);
      window.getSelection().removeAllRanges();
    }
  });

  // ACTIONS map for data-action delegate. We migrate screens incrementally.
  // Each handler receives (el, event) — el is the element with data-action.
  const ACTIONS = {
    'open-book':       (el) => openBook(Number(el.dataset.idx)),
    'set-view-mode':   (el) => setViewMode(el.dataset.value),
    'set-filter':      (el) => setFilter(el.dataset.value),
    'set-sort':        (el) => setSort(el.dataset.value),
    'set-folder':      (el) => setFolderState(el.dataset.value === 'expanded'),
    'toggle-books':    (el) => toggleBooks(el.dataset.value === 'expanded'),
    'toggle-search':   () => {
      const el = document.getElementById('lib-search');
      if (el) { el.classList.toggle('open'); if (el.classList.contains('open')) document.getElementById('search-input')?.focus(); }
    },
    'shelf-show-more': (el) => expandShelf(el.dataset.shelf),
    // Reader-screen actions (task 02)
    'back-to-books':    () => backToBooks(),
    'set-mode':         (el) => setMode(el.dataset.value),
    'toggle-immersive': () => toggleImmersive(),
    'open-chapters':    () => openChapters(),
    'toggle-overflow':  () => toggleOverflowMenu(),
    'show-book-info':   () => { showBookInfo(); toggleOverflowMenu(); },
    'open-settings':    () => { openSettings(); refreshCacheDisplay(); if (document.getElementById('overflow-menu')?.style.display !== 'none') toggleOverflowMenu(); },
    'change-font':      (el) => changeFontSize(Number(el.dataset.delta)),
    'turn-page':        (el) => turnPage(Number(el.dataset.delta)),
    'open-bookmarks':   () => openBookmarks(),
    'open-sleep-timer': () => window.toggleSleepTimerMenu?.(),
    'prev-sentence':    () => prevSentence(),
    'toggle-play':      () => togglePlay(),
    'next-sentence':    () => nextSentence(),
    'open-translate':   () => openTranslate(),
    'close-confirm':    (el) => closeConfirm(el.dataset.value === 'ok'),
    // Panels actions (task 02)
    'close-panels':           () => uiCloseAllPanels(),
    'resume-from-selected':   () => resumeFromSelected(),
    'add-vocab':              () => addVocabWord(),
    'download-all-chapters':  () => downloadAllChapters(),
    'go-chapter':             (el) => goChapter(Number(el.dataset.idx)),
    'download-chapter':       (el) => downloadChapter(Number(el.dataset.idx)),
    'jump-bookmark':          (el) => jumpToBookmark(Number(el.dataset.idx)),
    'remove-bookmark':        (el) => removeBookmark(Number(el.dataset.idx)),
    'open-book-and-close':    (el) => { openBook(Number(el.dataset.idx)); uiCloseAllPanels(); },
    // Login + library topbar (task 03)
    'do-login':          () => doLogin(),
    'install-pwa':       () => installPWA(),
    'open-stats':        () => openStats(),
    'do-logout':         () => doLogout(),
    'toggle-theme':      () => toggleTheme(),
    'set-theme':         (el) => setTheme(el.dataset.value),
    'set-accent':        (el) => setAccentColor(el.dataset.color, el),
    'toggle-view-mode':  () => toggleViewMode(),
    // Settings panel extras (task 03)
    'set-dialogue-color': (el) => setDialogueColor(el.dataset.color),
    'mark-finished':      () => markBookFinished(),
    'reset-progress':     () => resetBookProgress(),
    'export-data':        () => exportAllData(),
    'import-data':        () => importAllData(),
    // New panel controls (step 08/09)
    'set-columns':        (el) => setColumns(el.dataset.value),
    'set-walk-curve':     (el) => setWalkCurve(el.dataset.value),
    'set-walk-depth':     (el) => setWalkDepth(el.dataset.value),
    'set-density':        (el) => setDensity(el.dataset.value),
    'set-accent-name':    (el) => setAccentByName(el.dataset.accentName),
    // Walk overlay (task 03)
    'confirm-walk-bookmark':   () => confirmWalkBookmark(),
    'dismiss-walk-bookmark':   () => dismissWalkBookmarkConfirm(),
    // Overflow verifier (task 03)
    'open-verifier-and-close': () => { uiOpenPanel('verifier-panel'); runVerifier(); toggleOverflowMenu(); },
    'rerun-verifier':          () => { uiOpenPanel('verifier-panel'); runVerifier(); },
    // Word popup (task 03)
    'hide-word-popup': () => hideWordPopup(),
    'add-popup-word':  () => addPopupWord(),
    'sentence-tap':    (el) => sentenceTap(Number(el.dataset.idx)),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    if (!el.hasAttribute('data-no-prevent')) {
      e.preventDefault();
    }
    try { fn(el, e); } catch (err) { logToBuffer('action:' + el.dataset.action, err); }
  });
}

/**
 * Show screen
 * @param {string} screenId
 */
function show(screenId) {
  showScreen(screenId);
}

/**
 * Export functions for global use (onclick handlers etc.)
 */
export function exportGlobalAPI() {
  // Auth - use imported functions
  window.doLogin = doLogin;
  window.doLogout = doLogout;
  window.doDemoLogin = doDemoLogin;
  window.installPWA = installPWA;
  window.hideWordPopup = hideWordPopup;
  window.jumpToBookmark = jumpToBookmark; // from panels.js
  window.removeBookmark = removeBookmark; // from panels.js
  window.showBookEnd = showBookEnd; // from reader.js
  window.loadChapter = loadChapter; // from reader.js

  // Navigation helpers (used by auth.js)
  window.show = show;
  window.loadBooks = loadBooks;

  // UI helpers
  window.toggleImmersive = toggleImmersive;

  // Books
  window.openBook = async (idx) => {
    await openBook(idx);
  };

  window.toggleBooks = (expanded) => {
    toggleBooks(expanded);
  };

  window.setViewMode = (mode) => {
    setViewMode(mode);
  };

  window.toggleViewMode = () => {
    toggleViewMode();
  };

  window.filterBooks = () => {
    filterBooks();
  };

  window.setFolderState = (expanded) => {
    setFolderState(expanded);
  };

  window.setFilter = (filter) => { setFilter(filter); };
  window.setSort = (sort) => { setSort(sort); };
  window.showConfirm = showConfirm;
  window.closeConfirm = closeConfirm;

  // Reader
  window.backToBooks = () => {
    // Save progress first
    saveProgress();

    // Stop audio
    if (_audioElement) {
      _audioElement.pause();
      _audioElement.src = '';
      _audioElement.removeAttribute('src');
    }

    uiCloseAllPanels();

    resetBook(); // covers bookId, sentences, audioChapters, etc. + calls resetPlayer()

    loadBooks();
  };

  window.setMode = (mode) => {
    // Save current reading font-size before switching to walking
    if (state.mode === 'reading' && mode === 'walking') {
      state._savedReadingFontSize = getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim();
    }
    state.mode = mode;
    applyModeClass();

    // Restore mode-specific font size (same state.fontSize, CSS * 1.4 for walking display)
    if (mode === 'walking') {
      document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
    } else {
      const saved = state._savedReadingFontSize || (state.fontSize || DEFAULT_FONT_SIZE) + 'px';
      document.documentElement.style.setProperty('--font-size', saved);
    }

    document.querySelectorAll('.mode-btn, .topbar-tab').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`mode-${mode}-btn`);
    if (btn) btn.classList.add('active');
    // Exit immersive when changing modes (topbar/player would be hidden)
    exitImmersive();
    if (mode === 'walking') {
      activateWalkingGestures();
    } else {
      deactivateWalkingGestures();
      resetPageState();
    }
    renderText(false);
    if (state.activeIdx >= 0) {
      const saved = state.activeIdx;
      state.activeIdx = -1;
      setActive(saved);
    }
    localStorage.setItem(STORAGE_KEYS.MODE, mode);
  };

  window.changeFontSize = (delta) => {
    changeFontSize(delta);
  };

  // Audio player
  window.togglePlay = () => {
    togglePlay();
  };

  window.prevSentence = () => {
    prevSentence();
  };

  // Overflow menu toggle
  window.toggleOverflowMenu = () => {
    const menu = document.getElementById('overflow-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  };

  window.nextSentence = () => {
    nextSentence();
  };

  window.seekAudio = (e) => {
    seekAudio(e);
  };

  window.openChapters = () => {
    renderChapters();
    uiOpenPanel('chapters-panel');
  };

  window.goChapter = (idx) => {
    const ch = state.chapters[idx];
    if (ch) loadChapter(ch.epubChapterIdx, false);
  };

  // Panels
  window.showBookInfo = () => {
    // Will be implemented in reader module
    if (window._showBookInfoImpl) {
      window._showBookInfoImpl();
    }
  };

  window.openSettings = () => {
    uiOpenPanel('settings-panel');
  };

  window.openStats = () => {
    renderStats();
    uiOpenPanel('stats-panel');
  };

  window.openBookmarks = () => {
    renderBookmarks();
    uiOpenPanel('bookmarks-panel');
  };

  window.openVerifier = () => {
    uiOpenPanel('verifier-panel');
    runVerifier();
  };

  window.toggleBookmark = () => {
    toggleBookmark();
  };

  window.openTranslate = (idx) => {
    openTranslate(idx);
  };

  window.selectTransSentence = (idx) => {
    selectTransSentence(idx);
  };

  window.resumeFromSelected = () => {
    resumeFromSelected();
  };

  window.addVocabFromSentence = (idx) => {
    addVocabFromSentence(idx);
  };

  window.toggleWordStatus = (word) => {
    toggleWordStatus(word);
  };

  window.exportVocab = (format) => {
    exportVocab(format);
  };

  window.addVocabWord = () => {
    addVocabWord();
  };

  window.closeResumePrompt = (shouldContinue) => {
    // Resume prompt removed — no-op
  };

  window.sentenceTap = (idx) => {
    sentenceTap(idx);
  };

  window.closeAllPanels = () => {
    uiCloseAllPanels();
  };

  window.confirmWalkBookmark = () => {
    const overlay = document.getElementById('walk-bookmark-confirm');
    if (!overlay) return;
    const idx = Number(overlay.dataset.idx);
    if (!isNaN(idx) && idx >= 0) {
      const prev = state.activeIdx;
      state.activeIdx = idx;
      toggleBookmark();
      state.activeIdx = prev;
    }
    overlay.classList.remove('visible');
  };

  window.dismissWalkBookmarkConfirm = () => {
    document.getElementById('walk-bookmark-confirm')?.classList.remove('visible');
  };

  window.showHistoryDetail = showHistoryDetail;
  window.setActive = setActive;
  window.showToast = showToast;
  window.fmtTime = fmtTime;
  window.esc = esc;
  window.getAudioElement = () => _audioElement;
  window.updateSentenceProgress = updateSentenceProgress;
  window.applyModeClass = applyModeClass;

  // Settings
  window.setAccentColor = setAccentColor;
  window.markBookFinished = markBookFinished;
  window.resetBookProgress = resetBookProgress;
  window.setDialogueColor = setDialogueColor;
  window.setDialogueIntensity = setDialogueIntensity;
  window.exportAllData = exportAllData;
  window.importAllData = importAllData;
  window.setFontFamily = setFontFamily;
  window.setSpeedFromSlider = setSpeedFromSlider;
  window.updateApiProvider = updateApiProvider;

  // Download
  window.downloadChapter = downloadChapter;
  window.downloadAllChapters = downloadAllChapters;

  // Debug
  window.getErrorLog = getErrorLog;
}

/**
 * Helper: apply saved theme
 */
function applySavedTheme() {
  const theme = (state.theme === 'light' || state.theme === 'dark') ? state.theme : 'dark';
  state.theme = theme;
  document.body.dataset.theme = theme;
  document.body.classList.toggle('light-mode', theme === 'light');
  document.body.classList.remove('theme-amoled');
}

/**
 * Load books (alias)
 */
async function loadBooks() {
  try {
    await loadBooksFromApi();
    renderBooks();
  } catch (e) {
    showToast('Помилка завантаження книг', 'error');
  }
}

/**
 * Render stats panel
 */
function renderStats() {
  const el = document.getElementById('stats-content');
  if (!el) return;

  let totalTime = 0, bookCount = 0, completedBooks = 0, bookNames = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('prog_')) continue;

    try {
      const prog = JSON.parse(localStorage.getItem(key));
      if (prog && prog.absTime > 0) {
        totalTime += prog.absTime;
        bookCount++;
        if (prog.absTime >= (prog.totalDuration || Infinity) * 0.95) completedBooks++;
      }

      const book = state.books.find(bk => (bk.uuid || bk.id) === key.replace('prog_', ''));
      if (book) {
        bookNames.push({
          title: book.title || book.name,
          prog: Math.min(100, Math.round((prog.absTime / (prog.totalDuration || 1)) * 100))
        });
      }
    } catch (e) {
      console.warn(e);
    }
  }

  if (!bookCount) {
    el.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:0.9rem;">Немає даних про прослуховування</div>';
    return;
  }

  const vocab = JSON.parse(localStorage.getItem('st_vocab') || '[]');
  const todaySec = state.dailyReadingTime?.[new Date().toISOString().slice(0, 10)] || 0;
  const totalSec = state.totalReadingTime || 0;

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card"><div class="stats-val">${bookCount}</div><div class="stats-lbl">Книг у прогресі</div></div>
      <div class="stats-card"><div class="stats-val">${completedBooks}</div><div class="stats-lbl">Завершено</div></div>
      <div class="stats-card"><div class="stats-val">${fmtTime(totalTime)}</div><div class="stats-lbl">Прослухано</div></div>
      <div class="stats-card"><div class="stats-val">${vocab.length}</div><div class="stats-lbl">Слів у словнику</div></div>
      <div class="stats-card"><div class="stats-val">${todaySec >= 3600 ? Math.round(todaySec / 3600 * 10) / 10 + ' год' : Math.round(todaySec / 60) + ' хв'}</div><div class="stats-lbl">Сьогодні</div></div>
      <div class="stats-card"><div class="stats-val">${totalSec >= 3600 ? Math.round(totalSec / 3600 * 10) / 10 + ' год' : Math.round(totalSec / 60) + ' хв'}</div><div class="stats-lbl">Всього</div></div>
    </div>
  `;

  if (bookNames.length) {
    el.innerHTML += '<div style="margin-top:1rem;font-size:0.85rem;color:var(--text-muted);">Книги:</div>';
    bookNames.sort((a, b) => (b.prog || 0) - (a.prog || 0)).forEach(b => {
      el.innerHTML += `
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(b.title)}</span>
          <span style="color:var(--accent);font-weight:600;flex-shrink:0;">${b.prog}%</span>
        </div>
      `;
    });
  }

  // Show cache size
  if (state.bookId) {
    audioCacheSize(state.bookId).then(bytes => {
      if (bytes > 0) {
        const sizeStr = bytes < 1048576 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
        el.innerHTML += `<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-dim);">💾 Аудіо-кеш: ${sizeStr}</div>`;
      }
    });
  }
}

/**
 * Save current progress
 */
function saveProgress() {
  if (!state.bookId || !_audioElement) return;

  const ac = state.audioChapters[state.currentAudioChIdx];
  const absTime = (ac && ac.startTime != null) ? (ac.startTime + _audioElement.currentTime) : _audioElement.currentTime;

  const progressData = {
    absTime,
    chapterIdx: state.currentChapterIdx,
    sentenceIdx: state.activeIdx,
    totalDuration: state.totalDuration
  };

  saveBookProgress(state.bookId, progressData);

  // Also save to server (throttled)
  if (ac) {
    const now = Date.now();
    if (!state._lastServerSave || now - state._lastServerSave > 10000) {
      state._lastServerSave = now;
      serverSaveProgress(state.bookId, absTime);
    }
  }
}

/**
 * Update sentence progress bar
 */
export function updateSentenceProgress() {
  const chapterTime = _audioElement.currentTime;

  // Walking mode: block detection at 30fps + word highlighting
  if (state.mode === 'walking' && state.walkingBlocks?.length) {
    const t = chapterTime;
    const blocks = state.walkingBlocks;
    let lo = 0, hi = blocks.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].clipBegin <= t) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found >= 0 && found !== state.activeBlockIdx && !window._blockNavCooldown) {
      if (window._renderWalkingBlocksFn) window._renderWalkingBlocksFn(found, true);
    }
    updateActiveWord();
    return;
  }

  // Continuously re-validate page position — corrects stale translateX within one frame.
  window.restorePageBySentence?.(false);

  const activeEl = document.querySelector('.text-sentence.active, .text-chunk.active');
  if (!activeEl || state.activeIdx < 0 || state.activeIdx >= state.sentences.length) return;

  updateActiveWord();
}

/**
 * Update active word highlight (runs at ~30fps via rAF)
 * Pure timestamp-based — maps Whisper word index to DOM word index
 */
export function updateActiveWord() {
  if (!_audioElement) return;
  const t = Math.max(0, _audioElement.currentTime - 0.25);
  const tl = state.wordTimeline;
  if (!tl?.length) return;

  let clipBegin, clipEnd, activeEl, wordOffset = 0;

  if (state.mode === 'walking' && state.walkingBlocks?.length) {
    const bidx = state.activeBlockIdx;
    if (bidx < 0 || bidx >= state.walkingBlocks.length) return;
    const blk = state.walkingBlocks[bidx];
    clipBegin = blk.clipBegin;
    clipEnd = blk.clipEnd;
    activeEl = document.querySelector('.walk-line.walk-line-active');
    if (!activeEl) return;
  } else {
    const sid = state.activeIdx;
    if (sid < 0 || sid >= state.sentences.length) return;
    const s = state.sentences[sid];
    if (!s || s.clipBegin == null || s.clipEnd == null) return;
    clipBegin = s.clipBegin;
    clipEnd = s.clipEnd;
    activeEl = document.getElementById(`s${sid}`);
    if (!activeEl) return;

    // Chunk-mode word offset for reading mode
    if (activeEl.classList.contains('text-chunk')) {
      const elId = parseInt(activeEl.id.replace('s', ''), 10);
      if (!isNaN(elId)) {
        for (let i = elId; i < sid; i++) {
          const sen = state.sentences[i];
          if (sen) wordOffset += sen.text.split(/\s+/).filter(Boolean).length;
        }
      }
    }
  }

  if (!activeEl) return;
  const words = activeEl.querySelectorAll('.word');
  if (!words.length) return;

  // Collect Whisper words for this block/sentence
  const rangeWords = [];
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].startTime < clipBegin - 0.1) continue;
    if (tl[i].startTime > clipEnd + 0.1) break;
    rangeWords.push(tl[i]);
  }
  if (!rangeWords.length) return;

  let activeWordIdx = -1;
  for (let i = 0; i < rangeWords.length; i++) {
    if (t >= rangeWords[i].startTime && t <= rangeWords[i].endTime) {
      activeWordIdx = i;
      break;
    }
  }
  if (activeWordIdx < 0) {
    for (let i = rangeWords.length - 1; i >= 0; i--) {
      if (rangeWords[i].startTime <= t) {
        activeWordIdx = i;
        break;
      }
    }
  }
  if (activeWordIdx < 0) return;

  // Route through the state machine: setActiveSentence wipes the outgoing
  // sentence's word state (active + past) the moment the sentence changes.
  setActiveSentence(activeEl);

  // 'past' dimming is per-word within the active sentence; the accent '.active'
  // highlight goes through the single word tracker (setActiveWord).
  let targetWord = null;
  words.forEach((el, i) => {
    const rel = i - wordOffset;
    if (rel === activeWordIdx) targetWord = el;
    el.classList.toggle('past', rel >= 0 && rel < activeWordIdx);
  });
  setActiveWord(targetWord);

  // NOTE: reading mode no longer does a per-word scrollLeft here. The page is
  // positioned by transform on #text-inner (pagination), and the active word's
  // PAGE is followed via _snapToActive. A native scrollLeft on #text-content
  // (which is overflow:hidden but still programmatically scrollable because the
  // columns overflow it) used to fight the transform: a word near the right edge
  // tripped scrollTo, shifting the text into a half-page "clipped both sides"
  // state that persisted until the next page turn reset scrollLeft to 0. Removed.
}

// Store implementation reference
window._renderTextImpl = renderText;
window._showBookInfoImpl = showBookInfoImplementation;

function showBookInfoImplementation() {
  if (!state.currentBook) return;

  const b = state.currentBook;
  const id = b.uuid || b.id;
  const coverUrl = id ? getBookCoverUrl(id) : '';
  const totalCh = state.chapters.length;
  const totalWords = state.epubChapters.reduce((sum, ec) =>
    sum + (ec.sentences ? ec.sentences.reduce((s2, sen) => s2 + sen.text.split(/\s+/).filter(Boolean).length, 0) : 0), 0
  );

  const content = document.getElementById('bookinfo-content');
  if (!content) return;

  content.innerHTML = `
    <div style="display:flex;gap:1rem;align-items:start;margin-bottom:1rem;">
      ${coverUrl ?
        `<img src="${coverUrl}&token=${encodeURIComponent(state.token)}" alt="Обкладинка" style="width:100px;height:140px;object-fit:cover;border-radius:8px;flex-shrink:0;" onerror="this.outerHTML='<div style=\\'width:100px;height:140px;border-radius:8px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:2.5rem;flex-shrink:0;\\'>📖</div>'">` :
        '<div style="width:100px;height:140px;border-radius:8px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:2.5rem;flex-shrink:0;">📖</div>'
      }
      <div style="flex:1;min-width:0;">
        <div style="font-size:1.1rem;font-weight:600;color:var(--text);">${esc(b.title || b.name)}</div>
        <div style="font-size:0.85rem;color:var(--text-muted);margin-top:0.25rem;">${esc(getAuthorName(b))}</div>
        ${b.series ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-top:0.2rem;">📚 ${esc(typeof b.series === 'string' ? b.series : b.series.name || b.series.title || '')}</div>` : ''}
        <div style="display:flex;gap:1rem;margin-top:0.6rem;font-size:0.8rem;color:var(--text-dim);">
          <span>📄 ${totalCh} розділів</span>
          <span>📝 ${totalWords.toLocaleString()} слів</span>
          <span>⏱ ${state.totalDuration ? fmtTime(state.totalDuration) : '—'}</span>
        </div>
      </div>
    </div>
    ${b.synopsis || b.description ? `<div style="font-size:0.88rem;color:var(--text-muted);line-height:1.6;padding-top:0.75rem;border-top:1px solid var(--border);">${esc(b.synopsis || b.description)}</div>` : ''}
  `;

  uiOpenPanel('bookinfo-panel');
}

// Show word popup for translation
function showWordPopup(word, x, y) {
  hideWordPopup();
  state.popupWord = word;

  const popup = document.getElementById('word-popup');
  const wordEl = document.getElementById('popup-word');
  const transEl = document.getElementById('popup-translation');

  if (!popup || !wordEl || !transEl) return;

  wordEl.textContent = word;
  transEl.textContent = 'Перекладаю...';

  // Force all styles based on theme (backup in case CSS fails)
  const isLight = document.body.dataset.theme === 'light';
  const addBtn = document.getElementById('popup-add-btn');
  const closeBtn = popup.querySelector('.popup-close');
  if (isLight) {
    popup.style.background = '#f5eee1'; popup.style.backdropFilter = 'none';
    popup.style.setProperty('-webkit-backdrop-filter', 'none');
    wordEl.style.color = '#2c2416'; transEl.style.color = '#6b5e4a';
    if (addBtn) { addBtn.style.color = '#a07830'; addBtn.style.borderColor = '#a07830'; addBtn.style.background = 'rgba(160,120,48,0.18)'; }
    if (closeBtn) closeBtn.style.color = '#6b5e4a';
  } else {
    popup.style.background = 'rgba(15,14,13,0.96)'; popup.style.backdropFilter = 'blur(16px)';
    popup.style.setProperty('-webkit-backdrop-filter', 'blur(16px)');
    wordEl.style.color = ''; transEl.style.color = '';
    if (addBtn) { addBtn.style.color = ''; addBtn.style.borderColor = ''; addBtn.style.background = ''; }
    if (closeBtn) closeBtn.style.color = '';
  }

  popup.style.left = Math.min(x, window.innerWidth - 310) + 'px';
  popup.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  popup.classList.add('show');

  // Call translation API
  const systemPrompt = 'Ти — професійний літературний перекладач з англійської на українську. Перекладай чистою літературною українською мовою, уникаючи суржику, русизмів, кальок з російської та канцеляризмів.';
  const userPrompt = `Переклади слово "${word}" українською. Відповідай ТІЛЬКИ перекладом, без коментарів.`;

  (async () => {
    try {
      let translation = '';
      if (state.apiProvider === 'deepseek') {
        const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.apiKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 30,
            temperature: 0.3
          })
        });
        if (res.ok) {
          const data = await res.json();
          translation = data.choices?.[0]?.message?.content?.trim() || '';
        }
      } else {
        const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': state.apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 30,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        if (res.ok) {
          const data = await res.json();
          translation = data.content?.[0]?.text?.trim() || '';
        }
      }
      transEl.textContent = translation || '(не вдалося)';
    } catch (e) {
      transEl.textContent = 'Помилка';
    }
  })();
}

// Add popup word to vocabulary
window.addPopupWord = () => {
  if (state.popupWord) {
    saveWord(state.popupWord);
    renderVocab();
    showToast(`"${state.popupWord}" додано в словничок`);
  }
  hideWordPopup();
};

// Auto-start application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
