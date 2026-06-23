// ReadAlong UI Module
// Handles screen transitions, panels, and UI state

import { state, getAudioElement } from './state.js';
import { showToast, debounce, esc, fmtTime } from './utils.js';

/**
 * Show a specific screen
 * @param {string} screenId - 'login', 'books', 'reader'
 */
export function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId + '-screen');
  if (screen) {
    screen.classList.add('active');
  }

  // Reset walking mode if leaving reader
  if (screenId !== 'reader') {
    document.body.classList.remove('walking-mode');
    const readerScreen = document.getElementById('reader-screen');
    if (readerScreen) readerScreen.classList.remove('walking-active');
  }
}

/**
 * Open a bottom panel
 * @param {string} panelId - Panel element ID
 */
export function openPanel(panelId) {
  const overlay = document.getElementById('overlay');
  const panel = document.getElementById(panelId);

  // Сховати walk-controls (z:50) поки відкрита панель — інакше його кнопки
  // (⏮/⏭/таймер) лежать поверх панелі й перехоплюють тапи (керують фоном).
  if (document.getElementById('walk-controls')?.classList.contains('visible')) {
    window.setWalkControlsVisible?.(false);
  }

  if (overlay) overlay.classList.add('show');
  if (panel) panel.classList.add('open');
}

/**
 * Close all panels
 */
export function closeAllPanels() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.remove('show');

  document.querySelectorAll('.bottom-panel').forEach(p => p.classList.remove('open'));

  // Повернути walk-controls, якщо ми у walk на паузі (єдине джерело істини —
  // walk-controls видимі ⇔ walk + пауза + жодної відкритої панелі).
  if (state.mode === 'walking') {
    const audio = getAudioElement();
    if (!audio || audio.paused) window.setWalkControlsVisible?.(true);
  }

  // Hide word popup if exists
  hideWordPopup();
}

/**
 * Show bookmark prompt
 * @param {Object|string} progress - progress object or message string
 * @param {Function} onContinue - callback (optional, will be stored from progress)
 */
export function showResumePrompt(progress, onContinue) {
  const msgEl = document.getElementById('resume-msg');

  if (typeof progress === 'object' && progress !== null) {
    const pct = Math.min(100, Math.round((progress.absTime / (progress.totalDuration || 1)) * 100));
    if (msgEl) msgEl.textContent = `Ви прослухали ${pct}% книги. Продовжити з цього місця?`;
    state._resumeProgress = progress;
  } else {
    if (msgEl) msgEl.textContent = String(progress);
  }

  state._resumeCallback = onContinue || null;

  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('show');

  const panel = document.getElementById('resume-panel');
  if (panel) panel.classList.add('open');
}

/**
 * Close resume prompt
 * @param {boolean} shouldContinue
 */
export function closeResumePrompt(shouldContinue) {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.remove('show');

  const panel = document.getElementById('resume-panel');
  if (panel) panel.classList.remove('open');

  if (shouldContinue && state._resumeCallback) {
    state._resumeCallback();
  } else if (!shouldContinue && state._resumeProgress) {
    // «Спочатку» або ✕ — завантажити з початку
    const firstIdx = state.epubChapters.findIndex(ec => ec.audioChapterIdx >= 0);
    window.loadChapter?.(firstIdx >= 0 ? firstIdx : 0, false);
  }
  state._resumeCallback = null;
}

// IMPORT BOOKED from other modules (will be imported in main.js)
// These are just placeholders to avoid circular dependencies
let _getAuthorName = null;
let _fmtTime = null;

/**
 * Set internal dependencies (called from main.js)
 * @param {Object} deps
 */
export function setDependencies(deps) {
  _getAuthorName = deps.getAuthorName;
  _fmtTime = deps.fmtTime;
}

// Helper to get author name (fallback)
function getAuthorName(b) {
  return _getAuthorName ? _getAuthorName(b) : (b.author || b.authors?.[0]?.name || 'Невідомий');
}

/**
 * Hide word popup
 */
export function hideWordPopup() {
  const popup = document.getElementById('word-popup');
  if (popup?.classList.contains('show')) {
    popup.classList.remove('show');
    state.popupWord = '';
    state.blockNextSentenceTap = true;
    setTimeout(() => { state.blockNextSentenceTap = false; }, 300);
  }
}

/**
 * Apply mode class based on current state
 */
export function applyModeClass() {
  const readerScreen = document.getElementById('reader-screen');
  if (state.mode === 'walking') {
    readerScreen?.classList.add('walking-active');
    readerScreen?.classList.remove('reading-focus');
    document.body.classList.add('walking-mode');
  } else {
    readerScreen?.classList.remove('walking-active');
    readerScreen?.classList.remove('walk-immersive');
    document.body.classList.remove('walking-mode');
  }
  document.body.classList.toggle('light-mode', state.theme === 'sepia');
  document.body.classList.toggle('theme-amoled', state.theme === 'amoled');
}

// Confirm modal support
let _confirmCallback = null;

export function showConfirm(title, msg, label, onConfirm) {
  document.getElementById('confirm-title').textContent = title || '';
  document.getElementById('confirm-msg').textContent = msg || '';
  document.getElementById('confirm-danger-btn').textContent = label || 'Підтвердити';
  _confirmCallback = onConfirm || null;
  document.getElementById('confirm-overlay').style.display = 'flex';
}

export function closeConfirm(confirmed) {
  document.getElementById('confirm-overlay').style.display = 'none';
  if (confirmed && _confirmCallback) _confirmCallback();
  _confirmCallback = null;
}
