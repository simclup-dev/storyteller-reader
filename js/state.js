// ReadAlong State Management
// Centralized state store for application data

import { secureGet } from './secureStore.js';
import { DEFAULT_FONT_SIZE, DEFAULT_READ_SIZE, DEFAULT_SPEED_IDX, DEFAULT_MODE, DEFAULT_THEME, DEFAULT_DENSITY, DEFAULT_RADIUS, DEFAULT_ANIM_DUR, STORAGE_KEYS, ACCENTS } from './constants.js';

/**
 * Application state
 * @type {Object}
 */
const state = {
  server: '',
  token: '',
  apiKey: '',
  apiProvider: 'ollama',
  books: [],
  currentBook: null,
  bookId: null,
  epubChapters: [],
  audioChapters: [],
  chapters: [],
  currentChapterIdx: -1,
  currentAudioChIdx: -1,
  sentences: [],
  walkingBlocks: [],
  activeIdx: -1,
  activeBlockIdx: -1,
  selectedTranslateIdx: -1,
  totalDuration: 0,
  fontSize: DEFAULT_FONT_SIZE,
  readSize: DEFAULT_READ_SIZE,
  _density: DEFAULT_DENSITY,
  _radius: DEFAULT_RADIUS,
  _walkAnimDur: DEFAULT_ANIM_DUR,
  _accentName: 'auto',
  speedIdx: DEFAULT_SPEED_IDX,
  fallbackTried: false,
  fallbackChapterIdx: -1,
  mode: DEFAULT_MODE,
  theme: DEFAULT_THEME,
  history: [],
  vocabulary: [],
  sleepTimer: null,
  sleepTimerEnd: null,
  systemChime: 0,
  chapterArt: 0,
  popupWord: '',
  blockNextSentenceTap: false,
  mockMode: false,
  assetFolder: null,
  wordTimeline: null,
  wordTimelineLoaded: false,
  timelineReady: false,
  _prefetching: false,
  wakeLock: null,
  _searchQuery: '',
  _searchMode: 'title',
  _viewMode: 'shelf',
  _renderingStats: false,
  _lastServerSave: null,
  _lastProgSave: null,
  _resumeProgress: null,
  _origFetch: null,
  // Reading time tracker
  readingSessionStart: null,
  dailyReadingTime: {},
  totalReadingTime: 0,

  doubleTapAction: 'translate', // 'translate' | 'bookmark' | 'none'
  walkingTutorialShown: false,

  // Namespaces — modules should prefer these going forward.
  // Top-level fields above stay for backward compat; mirrored via reset* below.
  session: {},
  book: {},
  player: {}
};

// Audio element reference (will be set in main.js)
let audioElement = null;

/**
 * Get current state (shallow copy)
 * @returns {Object}
 */
export function getState() {
  return { ...state };
}

/**
 * Update state partially
 * @param {Object} updates - Key-value pairs to update
 */
export function updateState(updates) {
  Object.assign(state, updates);
}

/**
 * Reset state to initial values (except server/token)
 */
export function resetState() {
  Object.assign(state, {
    books: [],
    currentBook: null,
    bookId: null,
    epubChapters: [],
    audioChapters: [],
    chapters: [],
    currentChapterIdx: -1,
    currentAudioChIdx: -1,
    sentences: [],
    walkingBlocks: [],
    activeIdx: -1,
    activeBlockIdx: -1,
    selectedTranslateIdx: -1,
    totalDuration: 0,
    fallbackTried: false,
    fallbackChapterIdx: -1,
    history: [],
    vocabulary: [],
    sleepTimer: null,
    sleepTimerEnd: null,
    popupWord: '',
    blockNextSentenceTap: false,
    mockMode: false,
    assetFolder: null,
    wordTimeline: null,
    wordTimelineLoaded: false,
    timelineReady: false,
    _prefetching: false,
    wakeLock: null,
    _searchQuery: '',
    _searchMode: 'title',
    _viewMode: 'shelf',
    _renderingStats: false,
    _lastServerSave: null,
    _lastProgSave: null,
    _resumeProgress: null
  });
}

/**
 * Reset player-related fields. Called when chapter/book ends or progress is reset.
 * Mirrors onto top-level fields for backward compat with modules that still read them.
 */
export function resetPlayer() {
  const player = {
    activeIdx: -1,
    activeBlockIdx: -1,
    walkingBlocks: [],
    totalDuration: 0,
    selectedTranslateIdx: -1,
    fallbackTried: false,
    fallbackChapterIdx: -1,
    wordTimeline: null,
    wordTimelineLoaded: false,
    timelineReady: false,
    blockNextSentenceTap: false,
    _resumeProgress: null
  };
  state.player = player;
  Object.assign(state, player);
}

/**
 * Reset book-related fields. Called from backToBooks and when opening a new book.
 * Also resets player (book without player makes no sense).
 */
export function resetBook() {
  const book = {
    currentBook: null,
    bookId: null,
    epubChapters: [],
    audioChapters: [],
    chapters: [],
    currentChapterIdx: -1,
    currentAudioChIdx: -1,
    sentences: []
  };
  state.book = book;
  Object.assign(state, book);
  resetPlayer();
}

/**
 * Set audio element reference
 * @param {HTMLAudioElement} el
 */
export function setAudioElement(el) {
  audioElement = el;
}

/**
 * Get audio element
 * @returns {HTMLAudioElement|null}
 */
export function getAudioElement() {
  return audioElement;
}

/**
 * Load persisted settings from localStorage
 */
export async function loadPersistedState() {
  try {
    const savedFontSize = localStorage.getItem(STORAGE_KEYS.FONT_SIZE);
    if (savedFontSize) state.fontSize = parseInt(savedFontSize, 10);

    const savedSpeed = localStorage.getItem(STORAGE_KEYS.SPEED);
    if (savedSpeed !== null) {
      const idx = parseInt(savedSpeed, 10);
      if (idx >= 0 && idx < 10) state.speedIdx = idx;
    }

    const savedMode = localStorage.getItem(STORAGE_KEYS.MODE);
    if (savedMode) state.mode = savedMode;

    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME);
    if (savedTheme) {
      // Migrate legacy values to the new two-theme system
      if (savedTheme === 'sepia') state.theme = 'light';
      else if (savedTheme === 'warm-dark' || savedTheme === 'amoled') state.theme = 'dark';
      else state.theme = savedTheme;
    } else {
      // First run: respect system preference
      state.theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

     const savedViewMode = localStorage.getItem(STORAGE_KEYS.VIEW_MODE);
     if (savedViewMode) state._viewMode = savedViewMode;

     const savedSearchQuery = localStorage.getItem('st_searchquery');
     if (savedSearchQuery) state._searchQuery = savedSearchQuery;

     const savedSearchMode = localStorage.getItem('st_searchmode');
     if (savedSearchMode) state._searchMode = savedSearchMode;

     const savedProvider = localStorage.getItem(STORAGE_KEYS.API_PROVIDER);
    if (savedProvider) state.apiProvider = savedProvider;

     const savedApiKey = await secureGet(STORAGE_KEYS.API_KEY);
     if (savedApiKey) state.apiKey = savedApiKey;

     // Migration: старі профілі на deepseek/claude без збереженого ключа
     // переводимо на безкоштовний Ollama (ключ більше не потрібен).
     if (!state.apiKey && (state.apiProvider === 'deepseek' || state.apiProvider === 'claude')) {
       state.apiProvider = 'ollama';
       localStorage.setItem(STORAGE_KEYS.API_PROVIDER, 'ollama');
     }

     const savedFontFamily = localStorage.getItem(STORAGE_KEYS.FONT_FAMILY);
     if (savedFontFamily) {
       // Will be applied in settings module
       state._fontFamily = savedFontFamily;
     }

     // Load vocabulary
     const vocab = localStorage.getItem('st_vocab');
     if (vocab) {
       state.vocabulary = JSON.parse(vocab) || [];
     }

    const savedReadSize = localStorage.getItem(STORAGE_KEYS.READ_SIZE);
    if (savedReadSize) state.readSize = parseInt(savedReadSize, 10) || DEFAULT_READ_SIZE;

    const savedDensity = localStorage.getItem(STORAGE_KEYS.DENSITY);
    if (savedDensity && Object.prototype.hasOwnProperty.call({ compact: 1, regular: 1, comfy: 1 }, savedDensity)) {
      state._density = savedDensity;
    }

    const savedRadius = localStorage.getItem(STORAGE_KEYS.RADIUS);
    if (savedRadius !== null && savedRadius !== '') state._radius = parseInt(savedRadius, 10);

    const savedAnimDur = localStorage.getItem(STORAGE_KEYS.ANIM_DUR);
    if (savedAnimDur !== null && savedAnimDur !== '') state._walkAnimDur = parseInt(savedAnimDur, 10);

    const savedAccent = localStorage.getItem(STORAGE_KEYS.ACCENT);
    if (savedAccent) {
      // New format: name key from ACCENTS ('auto', 'Бурштин', …)
      // Old format: raw hex starting with '#' → treat as old, migrate to auto
      if (!savedAccent.startsWith('#') && Object.prototype.hasOwnProperty.call(ACCENTS, savedAccent)) {
        state._accentName = savedAccent;
      } else if (savedAccent.startsWith('#')) {
        state._accentColor = savedAccent; // legacy, applied by applySavedAccentColor
      }
    }

    const foldersExpanded = localStorage.getItem(STORAGE_KEYS.FOLDERS_EXPANDED);
    if (foldersExpanded !== null) {
      state._foldersExpanded = foldersExpanded !== '0';
    }

    const savedDoubleTap = localStorage.getItem('st_double_tap_action');
    if (savedDoubleTap) state.doubleTapAction = savedDoubleTap;

    if (localStorage.getItem('st_walk_tutorial_shown') === '1') state.walkingTutorialShown = true;
  } catch (e) {
    console.warn('Failed to load persisted state:', e);
  }
}

/**
 * Get current book progress from localStorage
 * @param {string} bookId
 * @returns {Object|null}
 */
export function getBookProgress(bookId) {
  try {
    const data = JSON.parse(localStorage.getItem(`prog_${bookId}`));
    if (!data || !data.absTime) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Save book progress to localStorage
 * @param {string} bookId
 * @param {Object} progress
 */
export function saveBookProgress(bookId, progress) {
  try {
    localStorage.setItem(`prog_${bookId}`, JSON.stringify(progress));
  } catch (e) {
    console.warn('Failed to save book progress:', e);
  }
}

/**
 * Get bookmarks for current book
 * @returns {Array}
 */
export function getBookmarks() {
  if (!state.bookId) return [];
  try {
    return JSON.parse(localStorage.getItem(`bmarks_${state.bookId}`) || '[]');
  } catch (e) {
    return [];
  }
}

/**
 * Save bookmarks for current book
 * @param {Array} bookmarks
 */
export function saveBookmarks(bookmarks) {
  if (!state.bookId) return;
  try {
    localStorage.setItem(`bmarks_${state.bookId}`, JSON.stringify(bookmarks));
  } catch (e) {
    console.warn('Failed to save bookmarks:', e);
  }
}

export { state };
