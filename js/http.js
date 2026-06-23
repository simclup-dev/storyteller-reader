// ReadAlong HTTP/API Module
// Handles all network requests, authentication, and error handling

import { state } from './state.js';
import { showToast, esc } from './utils.js';
import { show } from './ui.js';
import { STORAGE_KEYS } from './constants.js';
import { secureSet } from './secureStore.js';
import { getMockBooks, getMockManifest, createMockEpubZip, generateMockWav } from './mock.js';

let _originalFetch = null;

/**
 * Get authorization header
 * @returns {Object}
 */
export function authHdr() {
  return {
    'Authorization': `Bearer ${state.token}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Initialize fetch interceptor for auth handling
 * @param {string} serverUrl
 */
export function initFetchInterceptor(serverUrl) {
  if (_originalFetch) return; // Already initialized

  _originalFetch = window.fetch;
  window.fetch = function(url, opts) {
    return _originalFetch(url, opts).then(res => {
      if (res.status === 401 && url.toString().includes(serverUrl)) {
        localStorage.removeItem(STORAGE_KEYS.TOKEN);
        state.token = '';
        show('login');
        showToast('⚠️ Сесію завершено — увійдіть знову');
      }
      return res;
    });
  };
}

/**
 * Restore original fetch (for logout)
 */
export function restoreFetch() {
  if (_originalFetch) {
    window.fetch = _originalFetch;
    _originalFetch = null;
  }
}

/**
 * Generic fetch with retry logic
 * @param {string} url
 * @param {Object} options
 * @param {number} retries
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (i < retries && res.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Login to server
 * @param {string} serverUrl
 * @param {string} username
 * @param {string} password
 * @param {string} apiKey
 * @param {string} apiProvider
 * @returns {Promise<boolean>}
 */
export async function login(serverUrl, username, password, apiKey, apiProvider) {
  state.server = serverUrl.replace(/\/$/, '');
  state.apiKey = apiKey.trim();
  state.apiProvider = apiProvider;

  try {
    const body = new URLSearchParams();
    body.set('usernameOrEmail', username.trim());
    body.set('password', password);

    const res = await fetch(`${state.server}/api/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${txt.slice(0, 120)}`);
    }

    const data = await res.json();
    state.token = data.access_token || data.token || data.accessToken || '';

    if (!state.token) throw new Error('Токен не отримано');

    // Persist (secrets encrypted at rest — see secureStore.js)
    localStorage.setItem(STORAGE_KEYS.SERVER, state.server);
    await secureSet(STORAGE_KEYS.TOKEN, state.token);
    await secureSet(STORAGE_KEYS.API_KEY, state.apiKey);
    localStorage.setItem(STORAGE_KEYS.API_PROVIDER, state.apiProvider);

    initFetchInterceptor(state.server);
    return true;
  } catch (e) {
    throw e;
  }
}

/**
 * Logout
 */
export function logout() {
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  state.token = '';
  restoreFetch();
  show('login');
}

/**
 * Load books from server
 * @returns {Promise<Array>}
 */
export async function loadBooks() {
  if (state.mockMode) {
    state.books = getMockBooks();
    return state.books;
  }
  try {
    const res = await fetch(`${state.server}/api/v2/books`, { headers: authHdr() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.books = Array.isArray(data) ? data : (data.books || data.items || []);
    return state.books;
  } catch (e) {
    throw e;
  }
}

/**
 * Fetch book cover image URL
 * @param {string} bookId
 * @returns {string}
 */
export function getBookCoverUrl(bookId) {
  if (!bookId || state.mockMode) return '';
  return `${state.server}/api/v2/books/${bookId}/cover?token=${encodeURIComponent(state.token)}`;
}

/**
 * Get EPUB sync file
 * @param {string} bookId
 * @returns {Promise<Blob>}
 */
export async function getEpubBlob(bookId) {
  if (state.mockMode) {
    const bookIdx = state.books.findIndex(b => (b.uuid || b.id) === bookId);
    return createMockEpubZip(bookIdx >= 0 ? bookIdx : 0);
  }
  const res = await fetch(`${state.server}/api/books/${bookId}/synced`, { headers: authHdr() });
  if (!res.ok) throw new Error('epub HTTP ' + res.status);
  return await res.blob();
}

/**
 * Get audio manifest
 * @param {string} bookId
 * @returns {Promise<Object>}
 */
export async function getAudioManifest(bookId) {
  if (state.mockMode) {
    const bookIdx = state.books.findIndex(b => (b.uuid || b.id) === bookId);
    return getMockManifest(bookIdx >= 0 ? bookIdx : 0);
  }
  const res = await fetch(`${state.server}/api/v2/books/${bookId}/listen/manifest.json`, { headers: authHdr() });
  if (!res.ok) throw new Error('manifest ' + res.status);
  return await res.json();
}

/**
 * Get audio file URL
 * @param {string} bookId
 * @param {string} href
 * @returns {string}
 */
let _mockAudioBlobUrls = null;

export function getAudioUrl(bookId, href) {
  if (state.mockMode) {
    if (!_mockAudioBlobUrls) _mockAudioBlobUrls = {};
    if (!_mockAudioBlobUrls[href]) {
      const duration = href.endsWith('.mp4') ? 120 : 2;
      const blob = generateMockWav(duration);
      _mockAudioBlobUrls[href] = URL.createObjectURL(blob);
    }
    return _mockAudioBlobUrls[href];
  }
  const segments = href.split('/').map(s => encodeURIComponent(s));
  return `${state.server}/api/v2/books/${bookId}/listen/${segments.join('/')}`;
}

/**
 * Save progress to server
 * @param {string} bookId
 * @param {number} absTime - absolute playback position (seconds)
 * @param {number} totalDuration - total book duration (seconds), for totalProgression
 * @param {string} [hrefOpt] - current audio chapter href (optional)
 * @returns {Promise<boolean|'conflict'>} true on success, 'conflict' if server has newer, false on error
 */
export async function saveProgressToServer(bookId, absTime, totalDuration, hrefOpt) {
  if (state.mockMode) return true;
  if (!state.token) return false;
  try {
    const locator = {
      href: hrefOpt || '',
      type: 'audio/mpeg',
      locations: {
        totalProgression: totalDuration > 0 ? Math.min(1, absTime / totalDuration) : 0,
        fragments: [`t=${absTime}`],
        position: absTime
      }
    };
    const res = await fetch(`${state.server}/api/v2/books/${bookId}/positions`, {
      method: 'POST',
      headers: authHdr(),
      body: JSON.stringify({ locator, timestamp: Date.now() })
    });
    if (res.status === 204) return true;
    if (res.status === 409) return 'conflict';
    const txt = await res.text().catch(() => '');
    console.warn(`saveProgressToServer: HTTP ${res.status}`, txt.slice(0, 120));
    return false;
  } catch (e) {
    console.warn('saveProgressToServer error:', e);
    return false;
  }
}

/**
 * Load progress from server
 * @param {string} bookId
 * @returns {Promise<{absTime: number, timestamp: number}|null>}
 */
export async function loadProgressFromServer(bookId) {
  if (state.mockMode) return null;
  if (!state.token) return null;
  try {
    const res = await fetch(`${state.server}/api/v2/books/${bookId}/positions`, { headers: authHdr() });
    if (res.status === 404) return null;
    if (res.ok) {
      const data = await res.json();
      let locator = data.locator;
      if (typeof locator === 'string') {
        try { locator = JSON.parse(locator); } catch (_) { locator = null; }
      }
      let absTime = null;
      if (locator?.locations?.position != null) {
        absTime = locator.locations.position;
      } else if (locator?.locations?.fragments?.length) {
        const frag = locator.locations.fragments.find(f => typeof f === 'string' && f.startsWith('t='));
        if (frag) absTime = parseFloat(frag.slice(2));
      }
      if (absTime == null && locator?.locations?.totalProgression != null && state.totalDuration > 0) {
        absTime = locator.locations.totalProgression * state.totalDuration;
      }
      if (absTime == null || isNaN(absTime)) return null;
      const totalProgression = (locator?.locations?.totalProgression != null)
        ? locator.locations.totalProgression : null;
      return { absTime, totalProgression, timestamp: data.timestamp || 0 };
    }
    const txt = await res.text().catch(() => '');
    console.warn(`loadProgressFromServer: HTTP ${res.status}`, txt.slice(0, 120));
  } catch (e) {
    console.warn('loadProgressFromServer error:', e);
  }
  return null;
}

/**
 * Check if URL exists (HEAD request)
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function checkUrlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch (e) {
    return false;
  }
}
/**
 * Get book asset folder name from API
 * @param {string} bookId
 * @returns {Promise<string|null>}
 */
export async function getBookAssetFolder(bookId) {
  try {
    const res = await fetch(`${state.server}/api/v2/books/${bookId}`, { headers: authHdr() });
    if (!res.ok) return null;
    const data = await res.json();
    const filepath = data.audiobook?.filepath || '';
    // Extract folder: "/data/assets/Dungeon Crawler Carl - 01/audio" -> "Dungeon Crawler Carl - 01"
    const match = filepath.match(/\/data\/assets\/(.+?)\/audio/);
    return match ? match[1] : null;
  } catch (e) {
    console.warn('getBookAssetFolder error:', e);
    return null;
  }
}

/**
 * Load transcription JSON for a chapter
 * @param {string} assetFolder - e.g. "Dungeon Crawler Carl - 01"
 * @param {string} audioFilename - e.g. "00001-00001.mp4"
 * @returns {Promise<Object|null>}
 */
export async function loadTranscription(assetFolder, audioFilename) {
  try {
    const jsonName = audioFilename.replace(/\.[^.]+$/, '.json');
    const url = `/assets/${encodeURIComponent(assetFolder)}/transcriptions/${jsonName}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('loadTranscription error:', e);
    return null;
  }
}