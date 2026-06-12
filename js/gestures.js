// ReadAlong Gestures Module
// Handles swipe gestures, drag-to-dismiss, and immersive mode

import { state } from './state.js';
import { showToast } from './utils.js';
import { togglePlay } from './audio.js';
import { openTranslate } from './translate.js';
import { closeAllPanels } from './ui.js';

let isImmersive = false;

/**
 * Initialize swipe gestures and drag handlers
 */
export function initGestures() {
  // Swipe gestures for walking mode
  let touchStartX = 0, touchStartY = 0;

  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.bottom-panel, .overlay, input, select, button')) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  // Walking mode swipes are handled by attachWalkingGestures on #text-content

  // Drag to dismiss for panels
  document.querySelectorAll('.bottom-panel').forEach(panel => {
    const handle = panel.querySelector('.panel-handle');
    if (!handle) return;

    let startY = 0, currentY = 0, dragging = false;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      dragging = true;
      panel.style.transition = 'none';
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      currentY = e.touches[0].clientY;
      const dy = Math.max(0, currentY - startY);
      panel.style.transform = `translateY(${dy}px)`;
      panel.style.opacity = Math.max(0.3, 1 - dy / 400).toString();
    }, { passive: true });

    handle.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = currentY - startY;

      panel.style.transition = 'transform 0.3s cubic-bezier(0.16,1,0.3,1), opacity 0.3s ease';

      if (dy > 100) {
        closeAllPanels();
        panel.style.transform = '';
        panel.style.opacity = '';
      } else {
        panel.style.transform = '';
        panel.style.opacity = '';
      }
    });
  });

  // Escape key exits immersive mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isImmersive) {
      toggleImmersive();
    }
  });

  // Block browser context menu everywhere inside reader-screen (long-press popups on mobile)
  // Exception: native inputs still get their context menu
  document.getElementById('reader-screen')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    e.preventDefault();
  });

  // Double tap on text for immersive mode (reading mode only, skip sentences — handled by attachGestures)
  let lastTap = 0;
  document.addEventListener('touchend', (e) => {
    if (e.target.closest('.bottom-panel, .overlay, input, select, button')) return;
    if (state.mode !== 'reading') return;
    if (e.target.closest('.text-sentence')) return; // sentences handled by attachGestures

    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTap;

    if (tapLength < 300 && tapLength > 0) {
      // Double tap -> toggle immersive
      toggleImmersive();
    }
    lastTap = currentTime;
  });
}

/**
 * Toggle immersive mode (hide topbar and player)
 */
export function toggleImmersive() {
  // If already immersive, allow exiting from any mode
  // If entering immersive, only allow in reading mode
  if (!isImmersive && state.mode !== 'reading') return;

  const topbar = document.querySelector('.reader-topbar');
  const player = document.getElementById('player-bar');
  const text = document.getElementById('text-content');
  const btn = document.getElementById('immersive-btn');

  if (isImmersive) {
    if (topbar) topbar.style.transform = '';
    if (topbar) topbar.style.opacity = '';
    if (player) player.style.transform = '';
    if (player) player.style.opacity = '';
    if (text) text.style.paddingBottom = '';
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    if (btn) btn.style.opacity = '';
  } else {
    if (topbar) topbar.style.transform = 'translateY(-100%)';
    if (topbar) topbar.style.opacity = '0';
    if (player) player.style.transform = 'translateY(100%)';
    if (player) player.style.opacity = '0';
    if (text) text.style.paddingBottom = '2rem';
    if (btn) btn.style.opacity = '0.4';
  }

  isImmersive = !isImmersive;
}

/**
 * Exit immersive mode (helper)
 */
export function exitImmersive() {
  if (isImmersive) {
    toggleImmersive();
  }
}

// ── Per-sentence gesture detector ────────────────────────────────────────────
// Single source of truth for long-press / double-tap on reading sentences.

const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;
const MOVE_THRESHOLD = 10; // px — beyond this, treat as scroll, not tap

/**
 * Attach gesture handlers to a container, delegated by selector.
 * @param {HTMLElement} container
 * @param {string} selector - e.g. '.text-sentence'
 * @param {Object} handlers - { onTap, onDoubleTap, onLongPress } — all optional
 * @returns {() => void} cleanup function
 */
export function attachGestures(container, selector, handlers = {}) {
  let lastTapTime = 0;
  let lastTapTarget = null;
  let pressTimer = null;
  let pressFired = false;
  let startX = 0, startY = 0;
  let activeTarget = null;

  function clearPressTimer() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }

  function onPointerDown(e) {
    const target = e.target.closest(selector);
    if (!target || !container.contains(target)) return;
    activeTarget = target;
    pressFired = false;
    startX = e.clientX; startY = e.clientY;
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressFired = true;
      handlers.onLongPress?.(activeTarget, e);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e) {
    if (!activeTarget) return;
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) clearPressTimer();
  }

  function onPointerUp(e) {
    clearPressTimer();
    if (!activeTarget || pressFired) { activeTarget = null; return; }
    const now = Date.now();
    const isDouble = (now - lastTapTime < DOUBLE_TAP_MS) && (lastTapTarget === activeTarget);
    if (isDouble) {
      lastTapTime = 0; lastTapTarget = null;
      handlers.onDoubleTap?.(activeTarget, e);
    } else {
      lastTapTime = now;
      lastTapTarget = activeTarget;
      const capturedTarget = activeTarget;
      setTimeout(() => {
        if (lastTapTarget === capturedTarget && Date.now() - lastTapTime >= DOUBLE_TAP_MS) {
          handlers.onTap?.(capturedTarget, e);
          lastTapTime = 0; lastTapTarget = null;
        }
      }, DOUBLE_TAP_MS + 10);
    }
    activeTarget = null;
  }

  function onContextMenu(e) {
    if (e.target.closest(selector)) e.preventDefault();
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', () => { clearPressTimer(); activeTarget = null; });
  container.addEventListener('contextmenu', onContextMenu);

  return function detach() {
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('contextmenu', onContextMenu);
    clearPressTimer();
  };
}

// ── Walking-mode gesture layer ────────────────────────────────────────────────

const SWIPE_THRESHOLD = 60;
const SWIPE_VELOCITY_MAX_MS = 500;

/**
 * Walking-mode gesture layer. Attaches to a full-screen container.
 * Handlers: { onPlayPause, onPrev, onNext, onTranslate, onDismiss, onBookmark, onPinch(scale) }
 */
export function attachWalkingGestures(container, handlers = {}) {
  let startX = 0, startY = 0, startTime = 0;
  let pressTimer = null;
  let pressFired = false;
  let initialPinchDist = 0;
  let lastPinchScale = 1;
  let pinchActive = false;

  function clearPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinchActive = true;
      const [a, b] = e.touches;
      initialPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      lastPinchScale = 1;
      clearPress();
      return;
    }
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; startTime = Date.now();
    pressFired = false;
    clearPress();
    pressTimer = setTimeout(() => {
      pressFired = true;
      handlers.onBookmark?.();
    }, 500);
  }

  function onTouchMove(e) {
    if (pinchActive && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (initialPinchDist > 0) {
        const scale = d / initialPinchDist;
        if (Math.abs(scale - lastPinchScale) >= 0.05) {
          lastPinchScale = scale;
          handlers.onPinch?.(scale);
        }
      }
      return;
    }
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - startX);
    const dy = Math.abs(t.clientY - startY);
    if (dx > 10 || dy > 10) clearPress();
  }

  function onTouchEnd(e) {
    if (pinchActive) {
      pinchActive = false;
      initialPinchDist = 0;
      lastPinchScale = 1;
      return;
    }
    clearPress();
    if (pressFired) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startTime;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    if ((absDx > SWIPE_THRESHOLD || absDy > SWIPE_THRESHOLD) && dt < SWIPE_VELOCITY_MAX_MS) {
      if (absDx > absDy) {
        if (dx < 0) handlers.onNext?.();
        else handlers.onPrev?.();
      } else {
        if (dy < 0) handlers.onTranslate?.();
        else handlers.onDismiss?.();
      }
      return;
    }

    if (absDx < 10 && absDy < 10) {
      const r = container.getBoundingClientRect();
      const cx = t.clientX - r.left;
      const cy = t.clientY - r.top;
      const inCenterX = cx > r.width * 0.2 && cx < r.width * 0.8;
      const inCenterY = cy > r.height * 0.3 && cy < r.height * 0.7;
      if (inCenterX && inCenterY) {
        handlers.onPlayPause?.();
      }
      // Edge tap — walk-block onclick handles it
    }
  }

  container.addEventListener('touchstart', onTouchStart, { passive: false });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd);
  container.addEventListener('touchcancel', () => { clearPress(); pinchActive = false; });

  return function detach() {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    clearPress();
  };
}
