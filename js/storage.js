// ReadAlong Storage Module
// Handles IndexedDB caching and progress persistence

import { state, getAudioElement } from './state.js';
import { AUDIO_CACHE_VERSION, CACHE_SETTINGS, EPUB_CACHE_VERSION } from './constants.js';
import { saveProgressToServer as serverSaveProgress } from './http.js';

let _db = null;

/**
 * Open IndexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) {
      resolve(_db);
      return;
    }

    const request = indexedDB.open(CACHE_SETTINGS.DB_NAME, CACHE_SETTINGS.DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('epubs')) db.createObjectStore('epubs');
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Cache EPUB blob
 * @param {string} bookId
 * @param {Blob} blob
 */
export async function cacheEpub(bookId, blob) {
  try {
    const db = await openDB();
    const tx = db.transaction('epubs', 'readwrite');
    const store = tx.objectStore('epubs');
    store.put({ blob, version: EPUB_CACHE_VERSION, bookId }, bookId);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch (e) {
    console.warn('Failed to cache epub', e);
  }
}

/**
 * Get cached EPUB blob
 * @param {string} bookId
 * @returns {Promise<Blob|null>}
 */
export async function getCachedEpub(bookId) {
  try {
    const db = await openDB();
    const tx = db.transaction('epubs', 'readonly');
    const store = tx.objectStore('epubs');
    const request = store.get(bookId);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const entry = request.result;
        if (!entry) return resolve(null);
        if (entry.version !== EPUB_CACHE_VERSION) {
          const delTx = db.transaction('epubs', 'readwrite');
          delTx.objectStore('epubs').delete(bookId);
          return resolve(null);
        }
        if (entry.bookId && entry.bookId !== bookId) {
          const delTx = db.transaction('epubs', 'readwrite');
          delTx.objectStore('epubs').delete(bookId);
          return resolve(null);
        }
        resolve(entry.blob);
      };
      request.onerror = reject;
    });
  } catch (e) {
    return null;
  }
}

/**
 * Cache audio blob
 * @param {string} bookId
 * @param {number} epubChIdx
 * @param {Blob} blob
 */
export async function cacheAudio(bookId, epubChIdx, blob, href, duration) {
  try {
    const db = await openDB();
    const tx = db.transaction('audio', 'readwrite');
    const store = tx.objectStore('audio');
    store.put({ blob, fingerprint: audioCacheFingerprint(href, duration) }, audioCacheKey(bookId, epubChIdx));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch (e) {
    console.warn('audio cache write failed', e);
  }
}

/**
 * Get cached audio blob
 * @param {string} bookId
 * @param {number} epubChIdx
 * @returns {Promise<Blob|null>}
 */
export async function getCachedAudio(bookId, epubChIdx, href, duration) {
  try {
    const db = await openDB();
    const tx = db.transaction('audio', 'readonly');
    const store = tx.objectStore('audio');
    const req = store.get(audioCacheKey(bookId, epubChIdx));
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const entry = req.result;
        const fingerprint = audioCacheFingerprint(href, duration);
        // Legacy entries are bare Blobs. They have no provenance and cannot be
        // trusted after a map/manifest correction, so force a network refresh.
        if (!entry || entry.fingerprint !== fingerprint || !(entry.blob instanceof Blob)) {
          if (entry) void removeCachedAudio(bookId, epubChIdx);
          return resolve(null);
        }
        resolve(entry.blob);
      };
      req.onerror = reject;
    });
  } catch (e) {
    return null;
  }
}

/**
 * Remove cached audio
 * @param {string} bookId
 * @param {number} epubChIdx
 */
export async function removeCachedAudio(bookId, epubChIdx) {
  try {
    const db = await openDB();
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').delete(audioCacheKey(bookId, epubChIdx));
    await new Promise(r => tx.oncomplete = r);
  } catch (e) {
    console.warn(e);
  }
}

/**
 * One-time migration for the legacy audio cache.  Unlike EPUB entries, old
 * audio Blobs contained neither their source href nor a manifest version.
 */
export async function invalidateAudioCacheIfNeeded() {
  const key = 'audio_cache_version';
  if (parseInt(localStorage.getItem(key), 10) === AUDIO_CACHE_VERSION) return false;
  try {
    const db = await openDB();
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    localStorage.setItem(key, String(AUDIO_CACHE_VERSION));
    console.log('Audio cache invalidated — legacy blobs had no mapping provenance');
    return true;
  } catch (e) {
    console.warn('Failed to invalidate audio cache', e);
    return false;
  }
}

/**
 * Get list of cached chapter indices for a book
 * @param {string} bookId
 * @returns {Promise<string[]>}
 */
export async function getCachedChapters(bookId) {
  try {
    const db = await openDB();
    const tx = db.transaction('audio', 'readonly');
    const store = tx.objectStore('audio');
    const prefix = bookId + '_ch';
    const list = [];

    return new Promise((resolve) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          if (c.key.toString().startsWith(prefix)) {
            list.push(c.key.toString().replace(prefix, ''));
          }
          c.continue();
        } else {
          resolve(list);
        }
      };
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

/**
 * Get total cache size for a book
 * @param {string} bookId
 * @returns {Promise<number>}
 */
export async function audioCacheSize(bookId) {
  try {
    let total = 0;
    const db = await openDB();
    const tx = db.transaction('audio', 'readonly');
    const store = tx.objectStore('audio');

    return new Promise((resolve) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          if (c.key.toString().startsWith(bookId + '_ch')) {
            total += (c.value?.blob || c.value)?.size || 0;
          }
          c.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => resolve(0);
    });
  } catch (e) {
    return 0;
  }
}

/**
 * Generate cache key for audio chapter
 * @param {string} bookId
 * @param {number} epubChIdx
 * @returns {string}
 */
function audioCacheKey(bookId, epubChIdx) {
  return `${bookId}_ch${epubChIdx}`;
}

function audioCacheFingerprint(href, duration) {
  const normalHref = String(href || '').split('?')[0];
  const seconds = Number(duration || 0).toFixed(3);
  return `${normalHref}|${seconds}`;
}

/**
 * Save current reading progress
 */
// force=true — обійти 10с-тротлінг і ОДРАЗУ синхронізувати на сервер (пауза/вихід).
export function saveProgress(force = false) {
  if (!state.bookId) return;

  const audio = getAudioElement();
  const ac = state.audioChapters[state.currentAudioChIdx];
  // No chapter audio currently loaded (e.g. this chapter has no audio match) —
  // there's no meaningful absolute book position to persist. audio.currentTime
  // alone (without ac.startTime) is a per-file offset, not a book-wide one;
  // writing it here would clobber the last known-good progress with a bogus
  // near-zero value and win the "freshest wins" comparison on restore.
  if (!ac || !audio) return;

  const absTime = ac.startTime + audio.currentTime;

  const progressData = {
    absTime,
    chapterIdx: state.currentChapterIdx,
    sentenceIdx: state.activeIdx,
    totalDuration: state.totalDuration,
    savedAt: Date.now()
  };

  try {
    localStorage.setItem(`prog_${state.bookId}`, JSON.stringify(progressData));
  } catch (e) {
    console.warn(e);
  }

  // Also save to server (throttled, unless forced)
  const now = Date.now();
  if (force || !state._lastServerSave || now - state._lastServerSave > 10000) {
    state._lastServerSave = now;
    const currentHref = ac.href || '';
    serverSaveProgress(state.bookId, absTime, state.totalDuration, currentHref);
  }
}

/**
 * Load reading progress for a book
 * @param {string} bookId
 * @returns {Object|null}
 */
export function loadProgress(bookId) {
  if (!bookId) return null;
  try {
    return JSON.parse(localStorage.getItem(`prog_${bookId}`));
  } catch (e) {
    return null;
  }
}

/**
 * Clear all cached data for a book
 * @param {string} bookId
 */
export async function clearBookCache(bookId) {
  try {
    const db = await openDB();
    const txEpub = db.transaction('epubs', 'readwrite');
    txEpub.objectStore('epubs').delete(bookId);

    const txAudio = db.transaction('audio', 'readwrite');
    const store = txAudio.objectStore('audio');
    const prefix = bookId + '_ch';
    const keysToDelete = [];

    return new Promise((resolve) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          if (c.key.toString().startsWith(prefix)) {
            keysToDelete.push(c.key);
          }
          c.continue();
        } else {
          keysToDelete.forEach(key => store.delete(key));
          resolve();
        }
      };
      req.onerror = resolve;
    });
  } catch (e) {
    console.warn(e);
  }
}

/**
 * Probe the real duration of an audio file via <audio> metadata.
 * Does NOT play audio; only loads metadata headers.
 * @param {string} url - audio URL (already resolved; blob: works best)
 * @param {number} timeoutMs - timeout in milliseconds, default 15000
 * @returns {Promise<{duration: number}>} - rejects on timeout/error
 */
export function probeAudioDuration(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = 'metadata';
    let done = false;
    const cleanup = () => {
      a.onloadedmetadata = null;
      a.onerror = null;
      try { a.src = ''; a.load(); } catch (_) {}
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true; cleanup();
      reject(new Error('probe timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    a.onloadedmetadata = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      const d = a.duration;
      cleanup();
      if (!isFinite(d) || isNaN(d)) reject(new Error('invalid duration (' + d + ')'));
      else resolve({ duration: d });
    };
    a.onerror = () => {
      if (done) return;
      done = true; clearTimeout(timer); cleanup();
      reject(new Error('audio load error: ' + (a.error?.message || 'unknown')));
    };
    a.src = url;
  });
}

/**
 * Estimate total storage usage for this origin.
 * @returns {Promise<number>} bytes used
 */
export async function getCacheSize() {
  if (!navigator.storage?.estimate) return 0;
  const est = await navigator.storage.estimate();
  return est.usage || 0;
}

/**
 * Delete all IndexedDB databases and Cache Storage entries for this origin.
 * WARNING: removes all cached books. Always call behind a confirm().
 */
export async function clearCache() {
  // Drop media IndexedDB databases but NOT 'st-secure' — it holds the AES
  // master key that decrypts the session token stored in localStorage.
  // Deleting it destroys the key → token becomes unreadable → forced logout.
  _db = null;
  const dbs = await (indexedDB.databases?.() ?? Promise.resolve([]));
  await Promise.all(dbs.map(db => new Promise(res => {
    if (db.name === 'st-secure') return res();
    const req = indexedDB.deleteDatabase(db.name);
    req.onsuccess = req.onerror = req.onblocked = () => res();
  })));

  // Clear Cache Storage (SW-cached assets)
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
}

// End of file
