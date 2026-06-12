// ReadAlong Utils
// Helper functions used throughout the application

/**
 * Format seconds to MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function fmtTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} s - String to escape
 * @returns {string} Escaped string
 */
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Toast notification system
 * Shows temporary messages to the user
 */
const _toastQueue = [];
let _toastShowing = false;
const _toastHistory = new Map(); // text → timestamp
const TOAST_THROTTLE_MS = 3000;

/**
 * Show a toast notification
 * @param {string} msg - Message to display
 * @param {string} type - 'default', 'success', or 'error'
 * @param {number} duration - Duration in ms (default 2800)
 */
export function showToast(msg, type = 'default', duration = 2800, onClick = null) {
  if (!msg) return;
  const now = Date.now();
  const lastShown = _toastHistory.get(msg);
  if (lastShown && now - lastShown < TOAST_THROTTLE_MS) return;
  _toastHistory.set(msg, now);

  _toastQueue.push({ msg, type, duration, onClick });
  if (_toastQueue.length > 5) _toastQueue.shift();

  _processToastQueue();
}

/**
 * Process the toast queue
 * @private
 */
function _processToastQueue() {
  if (_toastShowing || !_toastQueue.length) return;

  _toastShowing = true;
  try {
    const { msg, type, duration, onClick } = _toastQueue.shift();
    const container = document.getElementById('toast-container');
    if (!container) {
      _toastShowing = false;
      return;
    }

    const el = document.createElement('div');
    el.className = 'toast' + (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : '');

    let icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    let text = msg;

    // Emoji detection for icons
    const c0 = msg.charCodeAt(0);
    if (c0 >= 0xD800 && c0 <= 0xDBFF && msg.length > 1) {
      icon = msg.slice(0, 2);
      text = msg.slice(2).trim();
    } else if (c0 > 0x2000) {
      icon = msg[0];
      text = msg.slice(1).trim();
    }

    el.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-text">${text}</span>
      <span class="toast-bar" style="animation-duration:${duration}ms"></span>
    `;

    if (onClick) el.style.cursor = 'pointer';
    container.appendChild(el);

    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => {
        el.remove();
        _toastShowing = false;
        _processToastQueue();
      }, 350);
    };

    if (onClick) el.addEventListener('click', () => { onClick(); remove(); }, { once: true });
    if (duration != null) setTimeout(remove, duration);
  } catch (e) {
    _toastShowing = false;
    _processToastQueue();
  }
}

/**
 * Check if element is in viewport
 * @param {Element} el - DOM element
 * @returns {boolean}
 */
export function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return r.top >= 50 && r.bottom <= window.innerHeight - 220;
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function
 * @param {Function} func - Function to throttle
 * @param {number} limit - Limit in ms
 * @returns {Function} Throttled function
 */
export function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Load external script dynamically
 * @param {string} src - Script URL
 * @returns {Promise<void>}
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/**
 * Safe JSON parse with fallback
 * @param {string} json - JSON string
 * @param {*} fallback - Fallback value
 * @returns {*}
 */
export function safeJsonParse(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch (e) {
    console.warn('JSON parse error:', e);
    return fallback;
  }
}

/**
 * Generate unique ID
 * @returns {string}
 */
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Logs errors to a circular buffer in localStorage (max 50 entries).
 * @param {string} source - Where the error came from (e.g. 'audio:timeupdate')
 * @param {Error|any} err - The error object or value
 */
export function logToBuffer(source, err) {
  try {
    const buf = JSON.parse(localStorage.getItem('st_errlog') || '[]');
    buf.push({
      t: Date.now(),
      src: source,
      msg: err?.message || String(err),
      stack: err?.stack?.slice(0, 500) || null
    });
    while (buf.length > 50) buf.shift();
    localStorage.setItem('st_errlog', JSON.stringify(buf));
  } catch (_) { /* never throw from logger */ }
}

/**
 * Wraps a function so any thrown error is logged and shown as toast,
 * without crashing the caller.
 * @param {Function} fn
 * @param {string} name - Identifier for logging
 * @returns {Function}
 */
export function safe(fn, name = 'unknown') {
  return function(...args) {
    try { return fn.apply(this, args); }
    catch (e) {
      console.error(`[safe:${name}]`, e);
      logToBuffer(name, e);
      try { showToast('Помилка: ' + name, 'error'); } catch (_) {}
    }
  };
}

/**
 * Format byte count to human-readable string (e.g. "12.5 МБ").
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${val} ${units[i]}`;
}

/** Returns the current error buffer (array of {t, src, msg, stack}). */
export function getErrorLog() {
  try { return JSON.parse(localStorage.getItem('st_errlog') || '[]'); }
  catch (_) { return []; }
}
