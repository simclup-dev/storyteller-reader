// ReadAlong App - Main Orchestrator
// Coordinates all modules and manages global dependencies

import { secureGet } from './secureStore.js';
import { state, loadPersistedState, setAudioElement, saveBookProgress, resetBook } from './state.js';
import { runVerifier } from './verifier-ui.js';
import { authHdr, fetchWithRetry, initFetchInterceptor } from './http.js';
import { show as showScreen, openPanel as uiOpenPanel, closeAllPanels as uiCloseAllPanels, hideWordPopup, setDependencies, applyModeClass, showConfirm, closeConfirm } from './ui.js';
import { doLogin, doLogout, doDemoLogin, installPWA, initAuth } from './auth.js';
import { loadBooks as loadBooksFromApi, renderBooks, filterBooks, setViewMode, toggleViewMode, toggleBooks, setFolderState, setFilter, setSort, expandShelf, syncLibraryProgress, reconcileDownloadBadges } from './books.js';
import { openBook, loadChapter, renderChapters, showBookEnd, renderText, getAuthorName, activateWalkingGestures, deactivateWalkingGestures, resetPageState, downloadBookOffline, deleteBookDownload } from './reader.js';
import { loadAudioChapter, togglePlay, prevSentence, nextSentence, sentenceTap, seekAudio, seekRel, setActive, onTimeUpdate as audioTimeUpdate, onAudioPlay, onAudioPause, requestWakeLock, releaseWakeLock } from './audio.js';
import { openTranslate, selectTransSentence, resumeFromSelected, renderHistory, showHistoryDetail, addVocabFromSentence, addVocabWord, saveWord, toggleWordStatus, renderVocab, exportVocab, callOllama } from './translate.js';
import { renderBookmarks, jumpToBookmark, removeBookmark, updateBookmarkBtn, toggleBookmark, downloadChapter, downloadAllChapters, updateDlButtons, goChapter } from './panels.js';
import { initSettings, initSpeedControl, changeFontSize, toggleTheme, setTheme, setAccentColor, setAccentByName, forceThemeStyles, updateSpeedBtn, buildSpeedSlider, setSpeedFromSlider, setFontFamily, markBookFinished, resetBookProgress, exportAllData, importAllData, setDialogueColor, setDialogueIntensity, setSystemColor, setSystemIntensity, updateApiProvider, refreshCacheDisplay, setColumns, setLineH, setParaGap, setWalkCurve, setWalkDepth, setDensity, setRadius, setAnimDur } from './settings.js';
import { initGestures, toggleImmersive, exitImmersive } from './gestures.js';
import { initSleepTimer } from './sleep.js';
import { audioCacheSize } from './storage.js';
import { getBookCoverUrl, saveProgressToServer as serverSaveProgress } from './http.js';
import { showToast, fmtTime, esc, safe, logToBuffer, getErrorLog, debounce } from './utils.js';
import { STORAGE_KEYS, DEFAULT_FONT_SIZE, OLLAMA_ENDPOINT, OLLAMA_MODEL } from './constants.js';

let _audioElement = null;
let _filterTimer = null;
let _wakeLockHeartbeatId = null;

/** Start periodic wake-lock re-acquire (~20s) to survive browser timeouts. */
function _startWakeLockHeartbeat() {
  if (_wakeLockHeartbeatId) return; // already running
  _wakeLockHeartbeatId = setInterval(() => {
    // Only re-acquire if reader screen is active and lock is not held
    const readerActive = document.getElementById('reader-screen')?.classList.contains('active');
    if (readerActive && !state.wakeLock) {
      requestWakeLock();
    }
  }, 20000);
}

/** Stop periodic wake-lock heartbeat (call on book close). */
function _stopWakeLockHeartbeat() {
  if (_wakeLockHeartbeatId) {
    clearInterval(_wakeLockHeartbeatId);
    _wakeLockHeartbeatId = null;
  }
}
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
  _onSystemEnter(el);
}
window.setActiveSentenceEl = setActiveSentence;

// System-сповіщення: коли активним стає System-блок — короткий візуальний пульс
// (+ опційний синтезований «дзинь»). Текст НЕ озвучуємо й не дублюємо — наратор
// читає його як завжди; це лише акцент, що «з'явилось системне вікно».
// Один сигнал (пульс+звук) на ВСЮ System-зону, а не на кожне речення/підблок.
// System-вікно в EPUB часто розбите на кілька абзаців (а в walk — ще й на кілька
// карток), і класифікація per-речення (<b>) інколи «миготить». Тому вживаємо
// гістерезис: у зону входимо одразу, а ВИХОДИМО лише після ≥2 не-System поспіль —
// тоді поодинокий не-жирний рядок усередині вікна не спричиняє повторний «дзинь».
let _sysActive = false;
let _nonSysRun = 0;
function _onSystemEnter(el) {
  const isSys = !!el && (el.classList.contains('walk-system-block') || el.classList.contains('system'));
  if (isSys) {
    _nonSysRun = 0;
    if (!_sysActive) {
      _sysActive = true;
      // У reading активне — inline-речення; сяйво кладемо на блок-вікно System.
      const target = el.closest('.system-block') || el;
      target.classList.remove('system-pulse');
      void target.offsetWidth; // reflow — перезапуск анімації
      target.classList.add('system-pulse');
      if (state.systemChime) _playSystemChime(state.systemChime);
    }
  } else if (_sysActive && ++_nonSysRun >= 2) {
    _sysActive = false;
  }
}

let _chimeCtx = null;
function _playSystemChime(level) {
  try {
    _chimeCtx = _chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _chimeCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const peak = level >= 2 ? 0.17 : 0.10; // «Тихо» / «Гучніше» — наратора НЕ глушимо
    // Звук #4 «Повідомлення» — чистий двотон-дзвін (sine, ~октава), м'який lowpass.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    lp.connect(ctx.destination);
    [[880, 0, 1.0], [1318.5, 0.02, 0.8]].forEach(([f, t, m]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.linearRampToValueAtTime(peak * m, now + t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.5);
      o.connect(g); g.connect(lp);
      o.start(now + t);
      o.stop(now + t + 0.55);
    });
  } catch (_) {}
}

// 0 = вимк, 1 = тихо, 2 = гучніше. Зберігаємо у localStorage.
window.setSystemChime = (v) => {
  state.systemChime = Number(v) || 0;
  try { localStorage.setItem('st_system_chime', String(state.systemChime)); } catch (_) {}
  document.querySelectorAll('#system-chime-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.value) === state.systemChime);
  });
  if (state.systemChime) _playSystemChime(state.systemChime); // прев'ю при виборі
};

// ── Атмосферний арт розділу ──────────────────────────────────────────────────
// Джерело: /illustrations/{bookId}/{epubChIdx}.webp (згенеровані наперед); поки
// арту нема — фолбек на обкладинку книги. Так механізм працює вже, а підміна на
// реальні картинки = просто поява файлів на сервері.
let _artSplashTimer = null;
function _chapterArtUrl(epubChIdx) {
  return `/illustrations/${state.bookId}/${epubChIdx}.webp`;
}
window.updateChapterArt = (epubChIdx, opts = {}) => {
  const mode = state.chapterArt || 0;
  const bg = document.getElementById('chapter-art-bg');
  if (!bg) return;
  if (!mode || !state.bookId) { bg.classList.remove('has-art'); return; }

  const apply = (url) => {
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.add('has-art');
    if (mode >= 2 && opts.splash !== false) _showArtSplash(url, opts.title);
  };
  // Спробувати арт розділу; якщо нема — обкладинку.
  const img = new Image();
  img.onload = () => { apply(_chapterArtUrl(epubChIdx)); _prefetchChapterArt(epubChIdx); };
  img.onerror = () => {
    const cover = getBookCoverUrl(state.bookId);
    if (cover) apply(cover); else bg.classList.remove('has-art');
    _prefetchChapterArt(epubChIdx);
  };
  img.src = _chapterArtUrl(epubChIdx);
};
function _showArtSplash(url, title) {
  const sp = document.getElementById('chapter-art-splash');
  if (!sp) return;
  sp.querySelector('img').src = url;
  sp.querySelector('.splash-title').textContent = title || '';
  sp.classList.add('show');
  if (_artSplashTimer) clearTimeout(_artSplashTimer);
  _artSplashTimer = setTimeout(() => sp.classList.remove('show'), 4800);
}
function _prefetchChapterArt(fromEpubIdx, n = 3) {
  if (localStorage.getItem('st_art_prefetch') === '0') return;
  if (!state.chapterArt || !state.bookId || !state.chapters?.length) return;
  const maxIdx = state.chapters.reduce((m, c) => Math.max(m, c.epubChapterIdx ?? 0), 0);
  for (let i = 1; i <= n; i++) {
    const idx = fromEpubIdx + i;
    if (idx > maxIdx) break;
    new Image().src = _chapterArtUrl(idx);
  }
}

// 0 = вимк, 1 = фон, 2 = фон+заставка
window.setChapterArt = (v) => {
  state.chapterArt = Number(v) || 0;
  try { localStorage.setItem('st_chapter_art', String(state.chapterArt)); } catch (_) {}
  document.body.classList.toggle('chapter-art-on', state.chapterArt > 0);
  document.querySelectorAll('#chapter-art-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.value) === state.chapterArt);
  });
  // Оновити поточний розділ одразу (без заставки — це лише зміна налаштування)
  if (state.currentChapterIdx >= 0) window.updateChapterArt?.(state.currentChapterIdx, { splash: false });
};

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
  await loadPersistedState();

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
    document.documentElement.style.setProperty('--dialogue-text-shadow', di >= 3 ? '0 0 10px var(--dialogue-color)' : 'none');
    document.querySelectorAll('#dc-warm, #dc-blue, #dc-rose').forEach(b => {
      const active = b.dataset.color === dc;
      b.classList.toggle('active', active);
      if (b.style) b.style.borderColor = active ? 'var(--accent)' : 'transparent';
    });
    const slider = document.getElementById('dialogue-intensity');
    const label = document.getElementById('dialogue-intensity-label');
    if (slider) slider.value = di;
    if (label) label.textContent = di;
  } catch (e) {}

  // Load system text settings
  try {
    const sc = localStorage.getItem('st_system_color') || '#d8a24a';
    const si = parseInt(localStorage.getItem('st_system_intensity') || '2');
    document.documentElement.style.setProperty('--system-color', sc);
    document.documentElement.style.setProperty('--system-font-style', si >= 2 ? 'italic' : 'normal');
    document.documentElement.style.setProperty('--system-text-shadow', si >= 3 ? '0 0 10px var(--system-color)' : 'none');
    document.querySelectorAll('#sc-amber, #sc-cyan, #sc-green').forEach(b => {
      const active = b.dataset.color === sc;
      b.classList.toggle('active', active);
      if (b.style) b.style.borderColor = active ? 'var(--accent)' : 'transparent';
    });
    const sSlider = document.getElementById('system-intensity');
    const sLabel = document.getElementById('system-intensity-label');
    if (sSlider) sSlider.value = si;
    if (sLabel) sLabel.textContent = si;
  } catch (e) {}

  // Sync mode buttons with actual state
  document.querySelectorAll('.mode-btn, .topbar-tab').forEach(b => b.classList.remove('active'));
  const modeBtn = document.getElementById(`mode-${state.mode}-btn`);
  if (modeBtn) modeBtn.classList.add('active');

   // Initialize all modules
   await initAuth();
   initSettings();
   initSpeedControl();
   initGestures();
   initSleepTimer();

   // #10 Відновити доріжка-режим
   if (localStorage.getItem('st_treadmill') === '1') {
     document.body.classList.add('treadmill-mode');
     document.getElementById('walk-more-treadmill')?.classList.add('treadmill-on');
   }

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
  const savedToken = await secureGet(STORAGE_KEYS.TOKEN);
  if (savedToken) {
    const savedServer = localStorage.getItem(STORAGE_KEYS.SERVER);
    if (savedServer === 'mock://demo') {
      state.server = 'mock://demo';
    } else {
      // Backend завжди на тому ж origin, що й reader — ігноруємо старі збережені IP.
      state.server = window.location.origin;
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

  // Visibility change handler for saving progress and re-acquiring wake lock
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveProgress(true); // force: згортання/блокування екрана — синхронізувати на сервер зараз
    } else if (document.getElementById('reader-screen')?.classList.contains('active')) {
      requestWakeLock();
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
    'download-book':   (el) => handleDownloadBook(el),
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
    'open-settings':    () => { openSettings(); setTimeout(refreshCacheDisplay, 400); if (document.getElementById('overflow-menu')?.style.display !== 'none') toggleOverflowMenu(); },
    'change-font':      (el) => changeFontSize(Number(el.dataset.delta)),
    'turn-page':        (el) => turnPage(Number(el.dataset.delta)),
    'open-bookmarks':   () => openBookmarks(),
    'open-sleep-timer': (el) => window.toggleSleepTimerMenu?.(el),
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
    'set-system-color':   (el) => setSystemColor(el.dataset.color),
    'set-system-chime':   (el) => window.setSystemChime?.(el.dataset.value),
    'set-chapter-art':    (el) => window.setChapterArt?.(el.dataset.value),
    'set-art-prefetch':   (el) => {
      const on = el.dataset.value === '1';
      try { localStorage.setItem('st_art_prefetch', on ? '1' : '0'); } catch (_) {}
      document.querySelectorAll('#art-prefetch-seg .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.value === el.dataset.value));
    },
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
    'open-syslog-and-close':   () => { window.openSystemLog?.(); toggleOverflowMenu(); },
    'syslog-tab-events':       () => window.switchSyslogTab?.('events'),
    'syslog-tab-character':    () => window.switchSyslogTab?.('character'),
    'open-chars-and-close':    () => { window.openChars?.(); toggleOverflowMenu(); },
    'open-chars':              () => window.openChars?.(),
    'chars-open-dossier':      (el) => window.openCharDossier?.(el.dataset.key),
    'chars-back':              () => window.charsBackToList?.(),
    'dossier-toggle-timeline': () => { const t = document.getElementById('dossier-timeline'); if (t) t.hidden = !t.hidden; },
    'open-dossier-from-popup': (el) => { window.openCharDossier?.(el.dataset.key); hideWordPopup(); },
    'open-stats-and-close':    () => { window.openStats?.(); toggleOverflowMenu(); },
    'open-verifier-and-close': () => { uiOpenPanel('verifier-panel'); runVerifier(); toggleOverflowMenu(); },
    'rerun-verifier':          () => { uiOpenPanel('verifier-panel'); runVerifier(); },
    // Word popup (task 03)
    'hide-word-popup': () => hideWordPopup(),
    'add-popup-word':  () => addPopupWord(),
    'sentence-tap':    (el) => sentenceTap(Number(el.dataset.idx)),
  };

  // Гаптика (вібро) — глянцевий тактильний відгук, особливо на доріжці (керуєш не дивлячись).
  // Легкий тик; не всі пристрої підтримують vibrate (iOS Safari ігнорує — тихо).
  window.haptic = (ms = 12) => { try { navigator.vibrate?.(ms); } catch (_) {} };
  const HAPTIC_ACTIONS = new Set(['toggle-play', 'prev-sentence', 'next-sentence', 'set-mode']);

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    if (!el.hasAttribute('data-no-prevent')) {
      e.preventDefault();
    }
    if (HAPTIC_ACTIONS.has(el.dataset.action)) window.haptic();
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
    requestWakeLock();
    _startWakeLockHeartbeat();
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
    saveProgress(true); // force: вихід із книги — синхронізувати фінальну позицію

    _stopWakeLockHeartbeat();
    releaseWakeLock();

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
  window.setSystemColor = setSystemColor;
  window.setSystemIntensity = setSystemIntensity;
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
// Оновити всі копії бейджа завантаження для книги (картка може бути в кількох
// списках одночасно). mode: 'idle' | 'progress' | 'done'.
function _setDlBadge(id, mode, done, total) {
  document.querySelectorAll(`[data-action="download-book"][data-id="${id}"]`).forEach(badge => {
    badge.classList.toggle('dl-done', mode === 'done');
    badge.classList.toggle('dl-busy', mode === 'progress');
    if (mode === 'progress') badge.textContent = total ? `${done}/${total}` : '⋯';
    else badge.textContent = mode === 'done' ? '✓' : '⬇';
  });
}

// Тап по бейджу: підтвердження → завантажити, або (якщо вже завантажено) видалити.
// Підтвердження захищає від випадкового запуску закачки/видалення.
function handleDownloadBook(el) {
  const id = el.dataset.id;
  if (!id) return;
  if (state._dlInProgress?.[id]) { showToast('⏳ Уже завантажується…'); return; }

  if (localStorage.getItem(`dl_${id}`)) {
    showConfirm('Видалити завантаження?', 'Текст і аудіо цієї книги буде стерто з пам\'яті пристрою. Прогрес читання збережеться.', 'Видалити', async () => {
      await deleteBookDownload(id);
      _setDlBadge(id, 'idle');
      showToast('🗑 Завантаження видалено');
    });
    return;
  }

  showConfirm('Завантажити книгу?', 'Усі розділи (текст + аудіо) збережуться для офлайн-читання без очікування. Це може зайняти кілька хвилин.', 'Завантажити', async () => {
    _setDlBadge(id, 'progress', 0, 0);
    showToast('⬇ Завантаження почалось…');
    const ok = await downloadBookOffline(id, (d, t) => _setDlBadge(id, 'progress', d, t));
    _setDlBadge(id, ok ? 'done' : 'idle');
    showToast(ok ? '✅ Книгу завантажено для офлайн' : '⚠️ Помилка завантаження');
  });
}

async function loadBooks() {
  try {
    await loadBooksFromApi();
    renderBooks();
    syncLibraryProgress(); // async: звірити прогрес із сервером і оновити картки
    reconcileDownloadBadges(); // async: позначити ✓ вже-завантажені книги
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

  // ── Gamification: treadmill distance ─────────────────────────────────────
  const PACE_KMH = 5.0;
  const totalKm = (totalSec * PACE_KMH / 3600);
  const todayKm = (todaySec * PACE_KMH / 3600);
  if (totalSec > 0) {
    const MILESTONES = [
      { km: 1, icon: '🥇', name: 'Перший кілометр' },
      { km: 5, icon: '🏃', name: 'П\'ять кілометрів' },
      { km: 10, icon: '💪', name: 'Десять кілометрів' },
      { km: 21.1, icon: '🎽', name: 'Напівмарафон' },
      { km: 42.2, icon: '🏆', name: 'Марафон' },
      { km: 100, icon: '⚡', name: '100 кілометрів' },
      { km: 200, icon: '🌟', name: '200 кілометрів' },
    ];
    const achieved = new Set(JSON.parse(localStorage.getItem('st_milestones') || '[]'));
    const milestonesHtml = MILESTONES.map(m => {
      const done = totalKm >= m.km || achieved.has(m.km);
      const remaining = m.km - totalKm;
      const sub = done ? `${m.km < 10 ? m.km.toFixed(1) : Math.round(m.km)} км` : `ще ${remaining < 1 ? (remaining * 1000).toFixed(0) + ' м' : remaining.toFixed(1) + ' км'}`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);opacity:${done ? '1' : '0.35'}">
        <span style="font-size:20px;width:28px;text-align:center">${m.icon}</span>
        <div><div style="font-size:13px;color:#c4b8a0">${m.name}</div><div style="font-size:11px;color:#8a7a60">${sub}</div></div>
        ${done ? '<span style="margin-left:auto;font-size:10px;background:#241d0f;border:1px solid rgba(212,175,55,.25);border-radius:10px;padding:2px 7px;color:#d8a24a">✓</span>' : ''}
      </div>`;
    }).join('');
    el.innerHTML += `
      <div style="margin-top:1.2rem;padding:0 0 .5rem;border-top:1px solid rgba(255,255,255,.06);">
        <div style="font-size:11px;color:#5a5040;text-transform:uppercase;letter-spacing:.06em;padding:.75rem 0 .5rem">Доріжка</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:1rem">
          <div class="stats-card"><div class="stats-val">${todayKm.toFixed(1)}</div><div class="stats-lbl">км сьогодні</div></div>
          <div class="stats-card"><div class="stats-val">${totalKm < 100 ? totalKm.toFixed(1) : Math.round(totalKm)}</div><div class="stats-lbl">км всього</div></div>
          <div class="stats-card"><div class="stats-val">${Math.round(totalKm * 1000 / 0.762)}</div><div class="stats-lbl">кроків</div></div>
        </div>
        ${milestonesHtml}
      </div>`;
  }
}

// ── Gamification helpers ───────────────────────────────────────────────────

function _walkKm(seconds) { return seconds * 5.0 / 3600; }

function _updateWalkDistChip() {
  const chip = document.getElementById('walk-dist-chip');
  const span = document.getElementById('walk-dist-today');
  if (!chip || !span) return;
  const today = new Date().toISOString().slice(0, 10);
  const todaySec = state.dailyReadingTime?.[today] || parseInt(localStorage.getItem('reading_time_' + today) || '0');
  const km = _walkKm(todaySec);
  if (km >= 0.1) {
    span.textContent = km.toFixed(1);
    chip.classList.add('has-distance');
  } else {
    chip.classList.remove('has-distance');
  }
}

function _checkMilestones() {
  const THRESHOLDS = [1, 5, 10, 21.1, 42.2, 100, 200];
  const LABELS = { 1: '🥇 Перший кілометр!', 5: '🏃 5 км пройдено!', 10: '💪 10 км!',
    21.1: '🎽 Напівмарафон — 21 км!', 42.2: '🏆 Марафон — 42 км!', 100: '⚡ 100 км!', 200: '🌟 200 км!' };
  const totalSec = state.totalReadingTime || parseInt(localStorage.getItem('total_reading_time') || '0');
  const totalKm = _walkKm(totalSec);
  const achieved = new Set(JSON.parse(localStorage.getItem('st_milestones') || '[]'));
  let newAchieved = false;
  for (const t of THRESHOLDS) {
    if (totalKm >= t && !achieved.has(t)) {
      achieved.add(t);
      newAchieved = true;
      showToast(LABELS[t]);
    }
  }
  if (newAchieved) {
    try { localStorage.setItem('st_milestones', JSON.stringify([...achieved])); } catch (_) {}
  }
}

// Called from audio.js after saveReadingTime
window.onWalkTimeSaved = () => {
  _updateWalkDistChip();
  _checkMilestones();
};

// ── System Log ─────────────────────────────────────────────────────────────

// ── System Log v7 — bullet-proof parse + proactive index + char sheet ────
// v4: max_tokens 300 truncated heavy chapters → []. v5/v6 fixed tokens.
// v7: robust JSON parse (greedy, fence-strip), retry transient errors,
//     proactive background sweep on book open, "Character" tab.

const _SYSLOG_KEY = (ci) => `st_syslog_v7_${state.bookId}_${ci}`;

const _SYSLOG_SYS_PROMPT = `You are processing a chapter from "Dungeon Crawler Carl" (LitRPG). Extract System interface notifications from the bold text blocks below.`;

// Robust extraction of a JSON array of strings from an LLM response.
// Handles ```json fences, leading prose, trailing commas. Returns string[] (possibly empty).
function _parseGemmaArray(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let s = raw.trim();
  // strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // take from FIRST '[' to LAST ']' (greedy — survives ] inside strings)
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a === -1 || b === -1 || b <= a) return [];
  let body = s.slice(a, b + 1);
  const tryParse = (txt) => {
    try {
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : null;
    } catch (_) { return null; }
  };
  let out = tryParse(body);
  if (out) return out;
  // salvage: drop trailing commas before ] and retry
  out = tryParse(body.replace(/,\s*]/g, ']').replace(/,\s*,/g, ','));
  return out || [];
}

// Dedicated Ollama call with higher token limit for syslog/charsheet extraction.
async function _callGemmaForSyslog(userPrompt, sysPrompt = _SYSLOG_SYS_PROMPT) {
  const res = await fetchWithRetry(OLLAMA_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 2000,
      temperature: 0.1,
      stream: false
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function _boldTexts(chapterIdx) {
  const ec = state.epubChapters?.[chapterIdx];
  if (!ec?.sentences) return [];
  const seen = new Set();
  const out = [];
  let cur = null;
  ec.sentences.forEach(s => {
    if (s._isSystem && s.text?.trim()) {
      if (!cur) { cur = []; out.push(cur); }
      cur.push(s.text.trim());
    } else { cur = null; }
  });
  return out.map(g => g.join('\n')).filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
}

const _SYSLOG_USER_TEMPLATE = (bold) => `Below are bold-text blocks from one chapter of Dungeon Crawler Carl.
These blocks are System interface messages (in-game UI, not narrator prose).

TOP PRIORITY — NEVER omit any block containing: "Level Up", "now level", "Skill Level",
"gained a skill", "stat point", or a character stat screen (Level / HP / Strength / etc).
These are the most important and must always appear in your output verbatim.

ALSO INCLUDE:
- Achievements: "New achievement! [Title] [Description] Reward: [text]"
- Character stat screens (Carl, Princess Donut) with Level, HP, all stats
- Status effects: poisoned, cursed, fatigued, healed, etc.
- Time warnings: "Time to Level Collapse: X"
- System announcements, zone notifications, quest updates
- Loot boxes won (just the box name, not every item inside)
- Combat system messages: "No Valid Target Available", "Critical Hit", etc.

EXCLUDE:
- Loot box CONTENTS (individual items inside a box)
- Mundane item descriptions (healing potion text, etc.) unless inside an achievement
- Plain chapter numbers or headings

Bold blocks:
${bold.map((t,i) => `[Block ${i+1}]\n${t}`).join('\n\n')}

Return ONLY a JSON array of strings. Each element = one complete notification (combine related lines). No text outside the JSON.`;

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _extractSyslogChapter(chapterIdx) {
  if (!state.bookId) return;
  const key = _SYSLOG_KEY(chapterIdx);
  if (localStorage.getItem(key) !== null) return;
  const bold = _boldTexts(chapterIdx);
  if (!bold.length) { try { localStorage.setItem(key, '[]'); } catch (_) {} return; }
  // Up to 3 attempts: a transient network/parse failure must not leave a permanent gap.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await _callGemmaForSyslog(_SYSLOG_USER_TEMPLATE(bold));
      const arr = _parseGemmaArray(raw);
      // Empty result from a chapter that HAS bold is suspicious — retry a couple times.
      if (!arr.length && attempt < 2) { await _sleep(600); continue; }
      localStorage.setItem(key, JSON.stringify(arr));
      return;
    } catch (_) {
      if (attempt < 2) { await _sleep(600); continue; }
      /* give up silently — stays unprocessed, retried next sweep */
    }
  }
}

// Process chapters in batches of 3 to balance speed vs Ollama load.
async function _indexAllChapters(upTo, onProgress) {
  const BATCH = 3;
  const pending = [];
  for (let ci = 0; ci <= upTo; ci++) {
    if (localStorage.getItem(_SYSLOG_KEY(ci)) === null) pending.push(ci);
  }
  if (!pending.length) return;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    onProgress?.(i, pending.length);
    await Promise.all(batch.map(ci => _extractSyslogChapter(ci)));
  }
  onProgress?.(pending.length, pending.length);
}

// Called at chapter end from audio.js — index this chapter, then refresh char sheet.
window.extractSyslogBackground = (chapterIdx) => {
  if (!state.bookId) return;
  _extractSyslogChapter(chapterIdx)
    .then(() => window.rebuildCharSheetBackground?.(state.currentChapterIdx))
    .catch(() => {});
};

// Proactive sweep on book open — index all past chapters in the background so the
// log/char-sheet are ready before the user opens the panel. Guarded to run once per book.
let _syslogSweepBook = null;
window.indexSyslogBackground = () => {
  if (!state.bookId || _syslogSweepBook === state.bookId) return;
  _syslogSweepBook = state.bookId;
  // small delay so it doesn't compete with initial chapter load
  setTimeout(() => {
    _indexAllChapters(state.currentChapterIdx)
      .then(() => window.rebuildCharSheetBackground?.(state.currentChapterIdx))
      .catch(() => {});
  }, 4000);
};

// Old v1 hook — kept as no-op so reader.js call doesn't break
window.collectSystemBlocks = () => {};

function _renderSyslogContent() {
  const el = document.getElementById('syslog-content');
  const badge = document.getElementById('syslog-count-badge');
  if (!el) return;

  const curIdx = state.currentChapterIdx;
  const all = [];
  for (let ci = curIdx; ci >= 0; ci--) {
    const raw = localStorage.getItem(_SYSLOG_KEY(ci));
    if (!raw) continue;
    let texts; try { texts = JSON.parse(raw); } catch (_) { continue; }
    if (!texts.length) continue;
    const chMeta = state.chapters.find(c => c.epubChapterIdx === ci);
    const label = chMeta?.label || `Chapter ${ci + 1}`;
    all.push({ label, texts: [...texts].reverse() });
  }

  if (!all.length) {
    el.innerHTML = '<div class="syslog-empty">No System events found</div>';
    if (badge) badge.hidden = true;
    return;
  }

  const total = all.reduce((s, g) => s + g.texts.length, 0);
  if (badge) { badge.textContent = `${total} events`; badge.hidden = false; }

  const latest = all[0].texts[0];
  const pinnedHtml = `
    <div class="syslog-pinned-label">Last System event · ${esc(all[0].label)}</div>
    <div class="syslog-block syslog-block-pinned">${esc(latest)}</div>
    <div class="syslog-log-label">Full log</div>`;

  const logHtml = all.map(g =>
    `<div class="syslog-ch-label">${esc(g.label)}</div>` +
    g.texts.map(t => `<div class="syslog-block">${esc(t)}</div>`).join('')
  ).join('');

  el.innerHTML = pinnedHtml + logHtml;
}

async function renderSystemLog() {
  const el = document.getElementById('syslog-content');
  const badge = document.getElementById('syslog-count-badge');
  if (!el) return;
  if (!state.bookId) { el.innerHTML = '<div class="syslog-empty">Open a book first</div>'; return; }

  const curIdx = state.currentChapterIdx;

  // Count how many chapters still need processing
  let unprocessed = 0;
  for (let ci = 0; ci <= curIdx; ci++) {
    if (localStorage.getItem(_SYSLOG_KEY(ci)) === null) unprocessed++;
  }

  if (unprocessed > 0) {
    el.innerHTML = `<div class="syslog-empty" style="padding:2rem">Scanning chapters… (0 / ${unprocessed})</div>`;
    if (badge) badge.hidden = true;
    await _indexAllChapters(curIdx, (done, total) => {
      el.innerHTML = `<div class="syslog-empty" style="padding:2rem">Scanning chapters… (${done} / ${total})</div>`;
    });
  }

  _renderSyslogContent();
}

// On-device diagnostic — long-press the count badge to dump per-chapter cache state.
function _showSyslogDiag() {
  if (!state.bookId) return;
  const curIdx = state.currentChapterIdx;
  const lines = [];
  let cached = 0, empty = 0, unproc = 0;
  for (let ci = 0; ci <= curIdx; ci++) {
    const raw = localStorage.getItem(_SYSLOG_KEY(ci));
    if (raw === null) { lines.push(`ch${ci}: UNPROCESSED`); unproc++; continue; }
    let n = 0; try { n = JSON.parse(raw).length; } catch (_) {}
    if (n === 0) { lines.push(`ch${ci}: empty`); empty++; }
    else { lines.push(`ch${ci}: ${n}`); cached++; }
  }
  const summary = `cached:${cached}  empty:${empty}  unprocessed:${unproc}`;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.92);color:#9be;font:12px/1.5 monospace;padding:1rem;overflow:auto;white-space:pre-wrap';
  ov.textContent = `SYSLOG DIAG · ${summary}\n\n${lines.join('\n')}\n\n[tap to close]`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

window.openSystemLog = () => {
  _switchSyslogTab('events');
  uiOpenPanel('syslog-panel');
  // wire long-press diagnostic on the badge (once)
  const badge = document.getElementById('syslog-count-badge');
  if (badge && !badge._diagWired) {
    badge._diagWired = true;
    let t = null;
    const start = () => { t = setTimeout(_showSyslogDiag, 600); };
    const cancel = () => { if (t) clearTimeout(t); t = null; };
    badge.addEventListener('pointerdown', start);
    badge.addEventListener('pointerup', cancel);
    badge.addEventListener('pointerleave', cancel);
  }
};

// ── System Log tabs: Events | Character ──────────────────────────────────
function _switchSyslogTab(tab) {
  const evWrap = document.getElementById('syslog-events-wrap');
  const csWrap = document.getElementById('syslog-char-wrap');
  document.querySelectorAll('#syslog-tabs .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (evWrap) evWrap.hidden = (tab !== 'events');
  if (csWrap) csWrap.hidden = (tab !== 'character');
  if (tab === 'events') renderSystemLog();
  else renderCharSheet();
}
window.switchSyslogTab = _switchSyslogTab;

// ── Character sheet ───────────────────────────────────────────────────────
// Data source = the per-chapter syslog cache (notifications ≤ current chapter).
// No spoilers by construction.
// v2: DETERMINISTIC local harvest (no LLM). Gemma conflated Carl/Donut stats
// (gave Carl Donut's CHA 25). Stats/levels are parsed directly from the EPUB with
// name-attribution from surrounding narrative — exact, instant, zero hallucination.
const _CHARSHEET_KEY = (maxCi) => `st_charsheet_v3_${state.bookId}_${maxCi}`;

function _collectNotifications(maxCi) {
  const all = [];
  for (let ci = 0; ci <= maxCi; ci++) {
    const raw = localStorage.getItem(_SYSLOG_KEY(ci));
    if (!raw) continue;
    let texts; try { texts = JSON.parse(raw); } catch (_) { continue; }
    texts.forEach(t => all.push(t));
  }
  return all;
}

// Harvest stat screens + level mentions straight from chapter sentences, with
// owner attribution from narrative context. Returns {statScreens:[], levels:[]}.
function _harvestCharFacts(maxCi) {
  const statScreens = []; // {owner, stats, ci}
  const levels = [];      // {who:'Carl'|'Princess Donut'|'both', level, ci}
  const STAT_MAP = { intelligence:'int', constitution:'con', dexterity:'dex', charisma:'cha' };

  for (let ci = 0; ci <= maxCi; ci++) {
    const ec = state.epubChapters?.[ci];
    if (!ec?.sentences) continue;
    const s = ec.sentences;
    for (let i = 0; i < s.length; i++) {
      const t = (s[i].text || '').trim();

      // Stat screen: a line starting "Strength: N", followed by the other stats
      const sm = t.match(/^Strength:\s*(\d+)/i);
      if (sm) {
        const stats = { str: +sm[1] };
        let j = i + 1;
        while (j < s.length) {
          const mm = (s[j].text || '').trim().match(/^(Intelligence|Constitution|Dexterity|Charisma):\s*(\d+)/i);
          if (!mm) break;
          stats[STAT_MAP[mm[1].toLowerCase()]] = +mm[2];
          j++;
        }
        // Owner: scan up to 3 preceding sentences for a name marker
        const ctx = ((s[i-1]?.text || '') + ' ' + (s[i-2]?.text || '') + ' ' + (s[i-3]?.text || '')).toLowerCase();
        let owner = 'Carl';
        if (/donut/.test(ctx)) owner = 'Princess Donut';
        statScreens.push({ owner, stats, ci });
        i = j - 1;
        continue;
      }

      // Narrative level mention — only when tied to Carl/Donut/us, never a monster
      const lm = t.match(/\blevel[\s-]+(\d+)\b/i);
      if (lm) {
        const lvl = +lm[1];
        const isMonster = /troglodyte|goblin|llama|crawler #|\bboss\b|\bmob\b|guardian|brood|minion|skin|corpse|pygmy|bashers/i.test(t);
        const refsHero = /\b(carl|donut|both|we|us)\b/i.test(t) || /\bI\b/.test(t);
        if (!isMonster && refsHero && lvl <= 40) {
          let who = 'Carl';
          const hasDonut = /donut/i.test(t);
          const hasCarl = /\bcarl\b/i.test(t) || /\bI\b/.test(t) || /\bwe\b|\bus\b|both/i.test(t);
          if (hasDonut && hasCarl) who = 'both';
          else if (hasDonut) who = 'Princess Donut';
          levels.push({ who, level: lvl, ci });
        }
      }
    }
  }
  return { statScreens, levels };
}

// Skills come from System-log notifications (Carl's bold System messages).
function _harvestSkills(maxCi) {
  const skills = {}; // name -> highest level
  _collectNotifications(maxCi)
    .filter(n => /skill level|gained a skill/i.test(n))
    .forEach(n => {
      // strip the generic prefix, then grab "<Name> [Skill ]Level N"
      const body = n.replace(/you'?ve gained a skill level!?/i, '').trim();
      const m = body.match(/([A-Za-z][A-Za-z'’ ]{1,22}?)(?::?\s*Skill Level|\s+Level)\s+(\d+)/i);
      if (!m) return;
      const name = m[1].trim();
      if (/^(the|a|an|and|reward|you|your|with|each|this)$/i.test(name)) return;
      const lvl = +m[2];
      if (!skills[name] || skills[name] < lvl) skills[name] = lvl;
    });
  return Object.entries(skills).map(([n, l]) => `${n} ${l}`);
}

const _WORD_NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20 };

// Level strictly from a character's attributed Gemma facts ("reached level eight",
// "is currently level 8") — NOT from narrative regex, which confused dungeon FLOOR
// ("level 12") with character level.
function _levelFromFacts(facts) {
  let max = null;
  facts.forEach(t => {
    const m = String(t).match(/\blevel[\s-]+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i);
    if (!m) return;
    const raw = m[1].toLowerCase();
    const v = /^\d+$/.test(raw) ? +raw : _WORD_NUM[raw];
    if (v && v <= 40 && (max === null || v > max)) max = v;
  });
  return max;
}

// Donut's abilities/spells from her facts (she has no bold System skill screen).
function _abilitiesFromFacts(facts) {
  const set = new Set();
  facts.forEach(t => {
    const s = String(t);
    if (/magic missile/i.test(s)) set.add('Magic Missile');
    if (/\btorch\b/i.test(s)) set.add('Torch');
    const m = s.match(/\b([A-Z][a-z]+)\s+spell\b/);
    if (m && !/^(The|A|This|Her|His)$/.test(m[1])) set.add(m[1] + ' spell');
  });
  return [...set];
}

function _buildCharSheetLocal(maxCi) {
  const { statScreens } = _harvestCharFacts(maxCi);
  const carlSkills = _harvestSkills(maxCi);
  const reg = _buildCharRegistry(maxCi);

  const latestStats = (owner) => {
    const ss = statScreens.filter(x => x.owner === owner);
    return ss.length ? ss[ss.length - 1].stats : null;
  };
  const factsOf = (key) => (reg.find(c => c.key === key)?.facts || []).map(f => f.t);

  const chars = [];
  // Carl
  const carlStats = latestStats('Carl');
  const carlLvl = _levelFromFacts(factsOf('carl'));
  if (carlStats || carlLvl || carlSkills.length) {
    chars.push({ name: 'Carl', level: carlLvl, stats: carlStats, skills: carlSkills });
  }
  // Donut
  const donutStats = latestStats('Princess Donut');
  const donutLvl = _levelFromFacts(factsOf('donut'));
  const donutSkills = _abilitiesFromFacts(factsOf('donut'));
  if (donutStats || donutLvl || donutSkills.length) {
    chars.push({ name: 'Princess Donut', level: donutLvl, stats: donutStats, skills: donutSkills });
  }
  return JSON.stringify(chars);
}

// Build + cache (synchronous, deterministic). Returns JSON string.
function _buildCharSheet(maxCi) {
  const key = _CHARSHEET_KEY(maxCi);
  const json = _buildCharSheetLocal(maxCi);
  try { localStorage.setItem(key, json); } catch (_) {}
  return json;
}

// Background recompute (called after a chapter's syslog is indexed)
window.rebuildCharSheetBackground = (maxCi) => {
  if (!state.bookId) return;
  try { _buildCharSheet(maxCi); } catch (_) {}
};

function _statRow(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const order = [['str','STR'],['int','INT'],['con','CON'],['dex','DEX'],['cha','CHA']];
  const cells = order
    .filter(([k]) => stats[k] !== undefined && stats[k] !== null)
    .map(([k,lbl]) => `<div class="cs-stat"><div class="cs-stat-k">${lbl}</div><div class="cs-stat-v">${esc(String(stats[k]))}</div></div>`)
    .join('');
  return cells ? `<div class="cs-stat-grid">${cells}</div>` : '';
}

function _charCard(c) {
  if (!c || typeof c !== 'object' || !c.name) return '';
  const lvl = (c.level !== undefined && c.level !== null) ? `<span class="cs-level">Lvl ${esc(String(c.level))}</span>` : '';
  const hp = c.hp ? `<div class="cs-hp">HP: ${esc(String(c.hp))}</div>` : '';
  const skills = Array.isArray(c.skills) && c.skills.length
    ? `<div class="cs-section-label">Skills</div><div class="cs-chips">${c.skills.map(s=>`<span class="cs-chip">${esc(String(s))}</span>`).join('')}</div>` : '';
  const notable = Array.isArray(c.notable) && c.notable.length
    ? `<div class="cs-section-label">Notable</div>${c.notable.map(n=>`<div class="cs-notable">${esc(String(n))}</div>`).join('')}` : '';
  return `<div class="cs-card">
    <div class="cs-card-head"><span class="cs-name">${esc(c.name)}</span>${lvl}</div>
    ${hp}
    ${_statRow(c.stats)}
    ${skills}
    ${notable}
  </div>`;
}

async function renderCharSheet() {
  const el = document.getElementById('charsheet-content');
  if (!el) return;
  if (!state.bookId) { el.innerHTML = '<div class="syslog-empty">Open a book first</div>'; return; }
  const maxCi = state.currentChapterIdx;

  // Need syslog indexed first
  let unprocessed = 0;
  for (let ci = 0; ci <= maxCi; ci++) {
    if (localStorage.getItem(_SYSLOG_KEY(ci)) === null) unprocessed++;
  }

  const cached = localStorage.getItem(_CHARSHEET_KEY(maxCi));
  if (cached !== null && !unprocessed) {
    _paintCharSheet(el, cached);
    return;
  }

  el.innerHTML = '<div class="syslog-empty" style="padding:2rem">Збираю стати персонажів…</div>';
  if (unprocessed > 0) {
    await _indexAllChapters(maxCi, (done, total) => {
      el.innerHTML = `<div class="syslog-empty" style="padding:2rem">Сканую розділи… (${done} / ${total})</div>`;
    });
  }
  const json = await _buildCharSheet(maxCi);
  _paintCharSheet(el, json);
}

function _paintCharSheet(el, json) {
  let arr; try { arr = JSON.parse(json); } catch (_) { arr = []; }
  if (!Array.isArray(arr) || !arr.length) {
    el.innerHTML = '<div class="syslog-empty">Ще нема даних до цієї позиції</div>';
    return;
  }
  el.innerHTML = arr.map(_charCard).join('');
}

// ── Character Dossier ─────────────────────────────────────────────────────
// 3 layers: (1) per-chapter Gemma extraction → cache; (2) local registry +
// significance filter; (3) lazy per-character dossier summary. Spoiler-safe:
// everything is built from chapters ≤ currentChapterIdx.

const _CHARS_KEY    = (ci)        => `st_chars_v1_${state.bookId}_${ci}`;
const _DOSSIER_KEY  = (k, maxCi)  => `st_dossier_v2_${state.bookId}_${k}_${maxCi}`;
const _CHARS_MAXLEN = 12000;

// Generic lenient JSON-array parse (objects). Strips fences, first '[' → last ']'.
function _parseJsonArray(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b <= a) return [];
  const body = s.slice(a, b + 1);
  const tryP = (t) => { try { const x = JSON.parse(t); return Array.isArray(x) ? x : null; } catch (_) { return null; } };
  return tryP(body) || tryP(body.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}')) || [];
}

function _chapterFullText(ci) {
  const ec = state.epubChapters?.[ci];
  if (!ec?.sentences) return '';
  const full = ec.sentences.map(s => s.text?.trim()).filter(Boolean).join('\n');
  return full.length <= _CHARS_MAXLEN ? full : full.slice(0, _CHARS_MAXLEN);
}

const _CHARS_SYS_PROMPT = `You extract characters from a chapter of the LitRPG novel "Dungeon Crawler Carl". A character is a being with a proper name who appears in the scene.`;

const _CHARS_USER = (txt) => `From the chapter text below, list characters that APPEAR or ACT in it.
For each: canonical name, aliases (other names/titles used for them), and 1-3 short facts from THIS chapter (role, action, state).
IGNORE unnamed mobs, crowds, and one-off background mentions. Focus on named beings who matter to the scene.

Return ONLY a JSON array: [{"name":"...","aliases":["..."],"facts":["..."]}]

Chapter text:
${txt}

Return ONLY the JSON array.`;

async function _extractCharsChapter(ci) {
  if (!state.bookId) return;
  const key = _CHARS_KEY(ci);
  if (localStorage.getItem(key) !== null) return;
  const txt = _chapterFullText(ci);
  if (!txt) { try { localStorage.setItem(key, '[]'); } catch (_) {} return; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await _callGemmaForSyslog(_CHARS_USER(txt), _CHARS_SYS_PROMPT);
      const arr = _parseJsonArray(raw)
        .filter(c => c && typeof c === 'object' && c.name)
        .map(c => ({
          name: String(c.name).trim(),
          aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
          facts: Array.isArray(c.facts) ? c.facts.map(String).filter(Boolean) : []
        }));
      if (!arr.length && attempt < 2) { await _sleep(600); continue; }
      localStorage.setItem(key, JSON.stringify(arr));
      return;
    } catch (_) {
      if (attempt < 2) { await _sleep(600); continue; }
    }
  }
}

async function _indexAllChars(upTo, onProgress) {
  const BATCH = 2;
  const pending = [];
  for (let ci = 0; ci <= upTo; ci++) {
    if (localStorage.getItem(_CHARS_KEY(ci)) === null) pending.push(ci);
  }
  if (!pending.length) return;
  for (let i = 0; i < pending.length; i += BATCH) {
    onProgress?.(i, pending.length);
    await Promise.all(pending.slice(i, i + BATCH).map(ci => _extractCharsChapter(ci)));
  }
  onProgress?.(pending.length, pending.length);
}

// chapter-end hook
window.extractCharsBackground = (ci) => {
  if (!state.bookId) return;
  _extractCharsChapter(ci).catch(() => {});
};

// proactive sweep on book open (guarded once per book)
let _charsSweepBook = null;
window.indexCharsBackground = () => {
  if (!state.bookId || _charsSweepBook === state.bookId) return;
  _charsSweepBook = state.bookId;
  setTimeout(() => { _indexAllChars(state.currentChapterIdx).catch(() => {}); }, 6000);
};

// Normalise a name → registry key (lowercase, strip titles/punctuation)
function _charKey(name) {
  return String(name).toLowerCase()
    .replace(/\b(princess|sir|lady|mr|mrs|ms|crawler|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Aggregate per-chapter extractions into a registry, with significance filter.
function _buildCharRegistry(maxCi) {
  const reg = {}; // key → {name, aliases:Set, chapters:Set, facts:[{ci,t}], mentions}
  for (let ci = 0; ci <= maxCi; ci++) {
    const raw = localStorage.getItem(_CHARS_KEY(ci));
    if (!raw) continue;
    let arr; try { arr = JSON.parse(raw); } catch (_) { continue; }
    arr.forEach(c => {
      if (!c?.name) return;
      // pick the key from the longest of name+aliases to merge variants
      const names = [c.name, ...(c.aliases || [])];
      let key = _charKey(c.name);
      // merge into an existing registry entry if any alias matches
      for (const n of names) { const k = _charKey(n); if (reg[k]) { key = k; break; } }
      if (!reg[key]) reg[key] = { name: c.name, aliases: new Set(), chapters: new Set(), facts: [], mentions: 0 };
      const e = reg[key];
      // prefer the shortest "clean" canonical display name
      if (c.name.length < e.name.length) e.name = c.name;
      (c.aliases || []).forEach(a => e.aliases.add(a));
      e.chapters.add(ci);
      e.mentions += (c.facts?.length || 1);
      (c.facts || []).forEach(t => e.facts.push({ ci, t }));
    });
  }
  // significance filter: appeared in ≥2 chapters OR ≥3 mentions
  const LEADS = new Set(['carl', 'donut']);
  return Object.entries(reg)
    .filter(([k, e]) => e.chapters.size >= 2 || e.mentions >= 3 || LEADS.has(k))
    .map(([k, e]) => ({
      key: k, name: e.name,
      aliases: [...e.aliases],
      chapters: [...e.chapters].sort((a, b) => a - b),
      lastCi: Math.max(...e.chapters),
      mentions: e.mentions,
      facts: e.facts
    }))
    .sort((a, b) => (b.lastCi - a.lastCi) || (b.mentions - a.mentions));
}

// Known-name lookup for word-popup integration (lowercased single + multiword)
function _knownCharNames(maxCi) {
  const names = new Set();
  _buildCharRegistry(maxCi).forEach(c => {
    names.add(c.name.toLowerCase());
    c.aliases.forEach(a => names.add(a.toLowerCase()));
  });
  return names;
}

const _DOSSIER_SYS_PROMPT = `You write rich, spoiler-free character profiles for a reader of "Dungeon Crawler Carl", using ONLY the facts provided. Never invent. The reader has only read up to these events. Write engaging, substantial prose — like a wiki character page limited to what's known so far.`;

async function _buildDossier(charKey, maxCi) {
  const key = _DOSSIER_KEY(charKey, maxCi);
  const cached = localStorage.getItem(key);
  if (cached !== null) return cached;
  const reg = _buildCharRegistry(maxCi).find(c => c.key === charKey);
  if (!reg || !reg.facts.length) { try { localStorage.setItem(key, ''); } catch (_) {} return ''; }
  // de-dupe facts, keep order
  const seen = new Set();
  const factLines = reg.facts.map(f => f.t).filter(t => { const k = t.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; }).join('\n');
  const isMain = reg.chapters.length >= 4 || reg.mentions >= 8;
  const len = isMain
    ? 'Write TWO substantial paragraphs (a thorough profile, ~8-12 sentences total).'
    : 'Write ONE solid paragraph (4-6 sentences).';
  const user = `Character: ${reg.name}${reg.aliases.length ? ' (also known as: ' + reg.aliases.join(', ') + ')' : ''}

${len} Cover: who they are and their role; their personality; their abilities, skills, or spells; their current level/power if mentioned; and how they have developed so far. Weave the facts into flowing prose — do NOT just list them. Plain prose only: no headings, no bullet points, no chapter numbers. Base everything ONLY on the facts below.

Facts (chronological):
${factLines}

Return only the profile text.`;
  try {
    const raw = await _callGemmaForSyslog(user, _DOSSIER_SYS_PROMPT);
    const text = raw.trim().replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    localStorage.setItem(key, text);
    return text;
  } catch (_) { return cached || ''; }
}

// ── Character panel UI (list ⇄ dossier) ──────────────────────────────────
function _renderCharsList() {
  const el = document.getElementById('chars-content');
  if (!el) return;
  const maxCi = state.currentChapterIdx;
  const reg = _buildCharRegistry(maxCi);
  if (!reg.length) { el.innerHTML = '<div class="syslog-empty">Ще нема персонажів до цієї позиції</div>'; return; }
  el.innerHTML = reg.map(c => {
    const firstFact = c.facts.length ? esc(c.facts[c.facts.length - 1].t) : '';
    return `<div class="char-row" data-action="chars-open-dossier" data-key="${esc(c.key)}">
      <div class="char-row-main">
        <span class="char-row-name">${esc(c.name)}</span>
        <span class="char-row-meta">розд. ${c.lastCi + 1}</span>
      </div>
      ${firstFact ? `<div class="char-row-sub">${firstFact}</div>` : ''}
    </div>`;
  }).join('');
}

async function _openDossier(charKey) {
  const el = document.getElementById('chars-content');
  if (!el) return;
  const maxCi = state.currentChapterIdx;
  const reg = _buildCharRegistry(maxCi).find(c => c.key === charKey);
  const name = reg?.name || 'Персонаж';
  el.innerHTML = `<div class="dossier-head"><button class="dossier-back" data-action="chars-back">← Список</button><span class="dossier-name">${esc(name)}</span></div>
    <div class="dossier-body"><div class="syslog-empty" style="padding:1.5rem">Збираю досьє…</div></div>`;
  const text = await _buildDossier(charKey, maxCi);
  const body = el.querySelector('.dossier-body');
  if (!body) return;
  // de-duped chronological facts, collapsed behind a toggle (avoid the wall of text)
  const seen = new Set();
  const facts = (reg ? reg.facts : []).filter(f => { const k = f.t.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; }).reverse();
  const timeline = facts.length
    ? `<button class="dossier-toggle" data-action="dossier-toggle-timeline">Хронологія (${facts.length}) ▾</button>
       <div id="dossier-timeline" hidden>${facts.map(f => `<div class="dossier-fact">${esc(f.t)}</div>`).join('')}</div>`
    : '';
  body.innerHTML = (text ? `<div class="dossier-text">${esc(text)}</div>` : '')
    + timeline
    + (!text && !facts.length ? '<div class="syslog-empty">Нема даних</div>' : '');
}

window.openChars = () => {
  _renderCharsList();
  uiOpenPanel('chars-panel');
  // proactive index if nothing yet
  let any = false;
  for (let ci = 0; ci <= state.currentChapterIdx; ci++) { if (localStorage.getItem(_CHARS_KEY(ci)) !== null) { any = true; break; } }
  if (!any) {
    const el = document.getElementById('chars-content');
    if (el) el.innerHTML = '<div class="syslog-empty" style="padding:2rem">Сканую розділи…</div>';
    _indexAllChars(state.currentChapterIdx, (done, total) => {
      const e = document.getElementById('chars-content');
      if (e) e.innerHTML = `<div class="syslog-empty" style="padding:2rem">Сканую розділи… (${done} / ${total})</div>`;
    }).then(() => _renderCharsList());
  }
};
window.openCharDossier = (key) => { _openDossier(key); uiOpenPanel('chars-panel'); };
window.charsBackToList = () => _renderCharsList();

/**
 * Save current progress
 */
// force=true — обійти 10с-тротлінг і ОДРАЗУ штовхнути позицію на сервер. Викликати
// на межах сесії (пауза / згортання / вихід із книги), інакше остання позиція
// лишалась тільки в localStorage цього пристрою й не синхронізувалась на інший.
function saveProgress(force = false) {
  if (!state.bookId || !_audioElement) return;

  const ac = state.audioChapters[state.currentAudioChIdx];
  const absTime = (ac && ac.startTime != null) ? (ac.startTime + _audioElement.currentTime) : _audioElement.currentTime;

  const progressData = {
    absTime,
    chapterIdx: state.currentChapterIdx,
    sentenceIdx: state.activeIdx,
    totalDuration: state.totalDuration,
    savedAt: Date.now()
  };

  saveBookProgress(state.bookId, progressData);

  // Also save to server (throttled, unless forced)
  if (ac) {
    const now = Date.now();
    if (force || !state._lastServerSave || now - state._lastServerSave > 10000) {
      state._lastServerSave = now;
      serverSaveProgress(state.bookId, absTime, state.totalDuration, ac.href || '');
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

  // Dossier bonus: if the tapped word is a known character name, offer "👤 Досьє"
  const dossierBtn = document.getElementById('popup-dossier-btn');
  if (dossierBtn) {
    dossierBtn.hidden = true;
    const w = word.toLowerCase().trim();
    if (w.length >= 3 && state.bookId) {
      const hit = _buildCharRegistry(state.currentChapterIdx).find(c =>
        [c.name, ...c.aliases].some(n => n.toLowerCase().split(/[^a-z0-9]+/).includes(w)));
      if (hit) { dossierBtn.hidden = false; dossierBtn.dataset.key = hit.key; }
    }
  }

  // Call translation API
  const systemPrompt = 'Ти — професійний літературний перекладач з англійської на українську. Перекладай чистою літературною українською мовою, уникаючи суржику, русизмів, кальок з російської та канцеляризмів.';
  const userPrompt = `Переклади слово "${word}" українською. Відповідай ТІЛЬКИ перекладом, без коментарів.`;

  (async () => {
    try {
      let translation = '';
      if (state.apiProvider === 'ollama') {
        const res = await fetchWithRetry(OLLAMA_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 30,
            temperature: 0.3,
            stream: false
          })
        });
        if (res.ok) {
          const data = await res.json();
          translation = data.choices?.[0]?.message?.content?.trim() || '';
        }
      } else if (state.apiProvider === 'deepseek') {
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
