// ReadAlong Settings Module
// Handles user preferences: theme, font, colors, speed, etc.

import { state, getAudioElement } from './state.js';
import { showToast, esc, formatBytes } from './utils.js';
import { STORAGE_KEYS, ACCENTS, PADS, DEFAULT_FONT_SIZE, DEFAULT_READ_SIZE, DEFAULT_RADIUS, DEFAULT_DENSITY, DEFAULT_ANIM_DUR, SPEEDS } from './constants.js';
import { getCacheSize, clearCache } from './storage.js';

// hexA from proto: hex color + alpha → rgba string
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Initialize settings from localStorage
 */
export function initSettings() {
  applySavedTheme();
  applySavedAccentColor();
  applySavedFontFamily();

  // Setup listeners
  _syncThemeSegment(state.theme);

  const speedSlider = document.getElementById('speed-slider');
  if (speedSlider) {
    speedSlider.value = state.speedIdx >= 0 ? getSpeedValue(state.speedIdx) : 1.0;
    speedSlider.oninput = (e) => setSpeedFromSlider(e.target.value);
  }

  const fontSelect = document.getElementById('font-select');
  if (fontSelect) {
    const savedFont = localStorage.getItem(STORAGE_KEYS.FONT_FAMILY) || "'EB Garamond', serif";
    fontSelect.value = savedFont;
    fontSelect.onchange = (e) => setFontFamily(e.target.value);
  }

  const apiProvider = document.getElementById('settings-api-provider');
  if (apiProvider) {
    apiProvider.value = state.apiProvider;
    apiProvider.onchange = updateApiProvider;
  }

  // Load doubleTapAction from storage before wiring select
  state.doubleTapAction = localStorage.getItem('st_double_tap_action') || 'translate';

  const doubleTapSelect = document.getElementById('double-tap-action');
  if (doubleTapSelect) {
    doubleTapSelect.value = state.doubleTapAction;
    doubleTapSelect.onchange = (e) => {
      state.doubleTapAction = e.target.value;
      localStorage.setItem('st_double_tap_action', e.target.value);
    };
  }

  const clearCacheBtn = document.getElementById('clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.onclick = () => {
      window.showConfirm(
        'Очистити кеш',
        'Буде видалено весь кешований аудіо та EPUB контент. Прогрес і налаштування збережуться.',
        'Очистити',
        async () => {
          await clearCache();
          showToast('🗑 Кеш очищено');
          refreshCacheDisplay();
        }
      );
    };
  }

  buildSpeedSlider();
  updateSpeedBtn();
  updateFontSizeLabel();
  initNewControls();
}

/**
 * Set theme ('dark' | 'light') and persist
 */
export function setTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  document.body.classList.toggle('light-mode', theme === 'light');
  document.body.classList.remove('theme-amoled');
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
  _syncThemeSegment(theme);
}

export function toggleTheme() {
  setTheme(state.theme === 'light' ? 'dark' : 'light');
}

export function forceThemeStyles() {
  // No-op: CSS variables now come entirely from theme.css via data-theme.
  // Kept as an export for call-sites in app.js that haven't been updated yet.
}

function applySavedTheme() {
  const theme = (state.theme === 'light' || state.theme === 'dark') ? state.theme : 'dark';
  state.theme = theme;
  document.body.dataset.theme = theme;
  document.body.classList.toggle('light-mode', theme === 'light');
  document.body.classList.remove('theme-amoled');
  _syncThemeSegment(theme);
}

function _syncThemeSegment(theme) {
  const lightBtn = document.getElementById('theme-light-btn');
  const darkBtn  = document.getElementById('theme-dark-btn');
  if (!lightBtn || !darkBtn) return;
  lightBtn.classList.toggle('active', theme === 'light');
  darkBtn.classList.toggle('active',  theme === 'dark');
}

/**
 * Apply saved accent — name-based ('auto' | key from ACCENTS)
 */
export function applySavedAccentColor() {
  const name = state._accentName || 'auto';
  setAccentByName(name);
}

/**
 * Set accent by name key from ACCENTS ('auto' | 'Бурштин' | …)
 * Persists the name, applies CSS vars on body.
 */
export function setAccentByName(name) {
  state._accentName = name;
  localStorage.setItem(STORAGE_KEYS.ACCENT, name);

  const hex = ACCENTS[name] ?? null;
  if (hex) {
    document.body.style.setProperty('--accent',    hex);
    document.body.style.setProperty('--glow',      hexA(hex, 0.42));
    document.body.style.setProperty('--glow-soft', hexA(hex, 0.22));
    document.body.style.setProperty('--hl',        hexA(hex, 0.16));
    document.body.style.setProperty('--hl-edge',   hexA(hex, 0.28));
  } else {
    // 'auto' — remove overrides, let theme CSS define accent
    ['--accent', '--glow', '--glow-soft', '--hl', '--hl-edge'].forEach(v =>
      document.body.style.removeProperty(v)
    );
  }

  // Sync color swatch UI
  document.querySelectorAll('.color-option').forEach(opt => {
    const active = opt.dataset.accentName === name;
    opt.classList.toggle('active', active);
    opt.setAttribute('aria-checked', String(active));
    opt.tabIndex = active ? 0 : -1;
  });
}

// Legacy: kept so old call-sites don't crash (panels.js etc.)
export function setAccentColor(color, element) {
  // Find matching ACCENTS name by hex, fallback to 'auto'
  const name = Object.entries(ACCENTS).find(([, v]) => v === color)?.[0] ?? 'auto';
  setAccentByName(name);
}

/**
 * Change font size
 * @param {number} delta
 */
export function changeFontSize(delta) {
  if (state.mode === 'walking') {
    state.fontSize = Math.max(14, Math.min(36, state.fontSize + delta));
    document.documentElement.style.setProperty('--font-size', state.fontSize + 'px');
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, state.fontSize);
    updateFontSizeLabel();
    window._scaleWalkBlocks?.();
    return;
  }

  // Reading mode: --read-size on body (body CSS defines it, so must override at body level)
  state.readSize = Math.max(14, Math.min(36, (state.readSize || DEFAULT_READ_SIZE) + delta));
  document.body.style.setProperty('--read-size', state.readSize + 'px');
  localStorage.setItem(STORAGE_KEYS.READ_SIZE, state.readSize);
  updateFontSizeLabel();
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

/**
 * Update font size display in settings
 */
function updateFontSizeLabel() {
  const readVal = state.mode === 'walking' ? state.fontSize : (state.readSize || DEFAULT_READ_SIZE);
  const label = document.getElementById('font-size-label');
  if (label) label.textContent = readVal;
  const walkLabel = document.getElementById('walk-font-label');
  if (walkLabel) walkLabel.textContent = state.fontSize;
}

/**
 * Set font family
 * @param {string} font
 */
export function setFontFamily(font) {
  document.documentElement.style.setProperty('--font-reading', font);
  localStorage.setItem(STORAGE_KEYS.FONT_FAMILY, font);
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

/**
 * Apply saved font family
 */
function applySavedFontFamily() {
  const savedFont = localStorage.getItem(STORAGE_KEYS.FONT_FAMILY) || "'EB Garamond', serif";
  document.documentElement.style.setProperty('--font-reading', savedFont);
  // Also ensure read-size is applied on body at startup (body CSS defines --read-size,
  // so we must set inline style on body to override it with the saved value)
  document.body.style.setProperty('--read-size', (state.readSize || DEFAULT_READ_SIZE) + 'px');
}

/**
 * Update API provider
 */
export function updateApiProvider() {
  const select = document.getElementById('settings-api-provider');
  if (select) {
    state.apiProvider = select.value;
    localStorage.setItem(STORAGE_KEYS.API_PROVIDER, state.apiProvider);
  }
}

/**
 * Build speed slider options
 */
export function buildSpeedSlider() {
  const slider = document.getElementById('speed-slider');
  if (slider) {
    slider.min = 0.5;
    slider.max = 2.0;
    slider.step = 0.05;
    slider.value = getSpeedValue(state.speedIdx);
  }
}

/**
 * Get speed value from index
 * @param {number} idx
 * @returns {number}
 */
function getSpeedValue(idx) {
  const speeds = [0.75, 0.80, 0.85, 0.90, 0.95, 1.0, 1.1, 1.25, 1.5, 2.0];
  return speeds[idx] !== undefined ? speeds[idx] : 1.0;
}

/**
 * Set speed from slider value
 * @param {number} val
 */
export function setSpeedFromSlider(val) {
  const v = parseFloat(val);
  const speeds = [0.75, 0.80, 0.85, 0.90, 0.95, 1.0, 1.1, 1.25, 1.5, 2.0];
  state.speedIdx = speeds.reduce((best, s, i) => Math.abs(s - v) < Math.abs(speeds[best] - v) ? i : best, 0);

  const audio = getAudioElement();
  if (audio) audio.playbackRate = v;

  updateSpeedBtn();
  localStorage.setItem(STORAGE_KEYS.SPEED, state.speedIdx);
}

/**
 * Update speed button display
 */
export function updateSpeedBtn() {
  const v = state.speedIdx >= 0 ? getSpeedValue(state.speedIdx) : parseFloat(document.getElementById('speed-slider')?.value) || 1.0;

  const speedBtn = document.getElementById('speed-btn');
  if (speedBtn) speedBtn.textContent = v + '× ▾';

  const speedDisplay = document.getElementById('speed-display');
  if (speedDisplay) speedDisplay.textContent = v + '×';

  const slider = document.getElementById('speed-slider');
  if (slider) slider.value = v;
}

export function initSpeedControl() {
  const btn = document.getElementById('speed-btn');
  if (!btn || btn._speedWired) return;
  btn._speedWired = true;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:inline-flex';
  btn.parentNode.insertBefore(wrapper, btn);
  wrapper.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'sleep-timer-menu';
  menu.id = 'speed-menu';
  menu.innerHTML = SPEEDS.map(s =>
    `<div class="sleep-timer-option" data-speed="${s}">${s}×</div>`
  ).join('');
  wrapper.appendChild(menu);

  btn.addEventListener('click', () => menu.classList.toggle('show'));
  menu.querySelectorAll('.sleep-timer-option').forEach(opt => {
    opt.onclick = () => {
      setSpeedFromSlider(parseFloat(opt.dataset.speed));
      updateSpeedBtn();
      menu.classList.remove('show');
    };
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('show') &&
        !e.target.closest('#speed-btn') && !e.target.closest('#speed-menu')) {
      menu.classList.remove('show');
    }
  });
}

/**
 * Set folder expanded state
 * @param {boolean} expanded
 */
export function setFolderState(expanded) {
  localStorage.setItem(STORAGE_KEYS.FOLDERS_EXPANDED, expanded ? '1' : '0');
  document.querySelectorAll('#books-list details').forEach(d => { d.open = expanded; });
}

/**
 * Mark current book as finished
 */
export function markBookFinished() {
  if (!state.bookId) return;

  const prog = {
    absTime: state.totalDuration || 999999,
    chapterIdx: state.epubChapters.length - 1,
    sentenceIdx: -1,
    totalDuration: state.totalDuration || 999999
  };

  try {
    localStorage.setItem(`prog_${state.bookId}`, JSON.stringify(prog));
    showToast('✅ Книгу позначено завершеною');
  } catch (e) {
    console.warn(e);
    showToast('Помилка збереження', 'error');
  }
}

/**
 * Reset book progress
 */
export function resetBookProgress() {
  if (!state.bookId) return;
  window.showConfirm(
    'Скинути прогрес',
    'Книга почнеться з початку. Прогрес буде видалено.',
    'Скинути',
    () => {
      try {
        localStorage.removeItem(`prog_${state.bookId}`);
        state.activeIdx = -1;
        const firstEc = state.epubChapters.findIndex(ec => ec && ec.audioChapterIdx >= 0);
        const startEpubIdx = firstEc >= 0 ? firstEc : 0;
        if (window.loadChapter) {
          window.loadChapter(startEpubIdx, false);
        }
        window._renderChaptersFn?.();
        showToast('↺ Прогрес скинуто');
      } catch (e) {
        console.warn(e);
      }
    }
  );
}

/**
 * Export all app data
 */
export function exportAllData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (
      key.startsWith('prog_') ||
      key.startsWith('bmarks_') ||
      key === 'st_vocab' ||
      key.startsWith('st_')
    )) {
      try {
        data[key] = JSON.parse(localStorage.getItem(key));
      } catch (e) {
        data[key] = localStorage.getItem(key);
      }
    }
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'readalong-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('📤 Дані експортовано');
}

/**
 * Import all app data
 */
export function importAllData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';

  input.onchange = async (e) => {
    try {
      const text = await e.target.files[0].text();
      const data = JSON.parse(text);
      let count = 0;

      for (const key of Object.keys(data)) {
        localStorage.setItem(key, typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]));
        count++;
      }

      showToast(`📥 Імпортовано ${count} записів. Оновіть сторінку.`);
    } catch (e) {
      showToast('⚠️ Помилка імпорту', 'error');
    }
  }
}

export function setDialogueColor(color) {
  localStorage.setItem('st_dialogue_color', color);
  document.documentElement.style.setProperty('--dialogue-color', color);
  document.querySelectorAll('#dc-warm, #dc-blue').forEach(b => {
    b.classList.toggle('active', b.dataset.color === color);
  });
}

export function setDialogueIntensity(val) {
  val = parseInt(val);
  localStorage.setItem('st_dialogue_intensity', val);
  document.documentElement.style.setProperty('--dialogue-font-style', val >= 2 ? 'italic' : 'normal');
  document.documentElement.style.setProperty('--dialogue-text-shadow', val >= 3 ? '0 0 8px var(--dialogue-color)' : 'none');
  const label = document.getElementById('dialogue-intensity-label');
  if (label) label.textContent = val;
}

export function refreshCacheDisplay() {
  const display = document.getElementById('cache-size-display');
  if (!display) return;
  display.textContent = 'обчислення...';
  getCacheSize().then(bytes => {
    display.textContent = formatBytes(bytes);
  });
}

// ── Segmented control sync helper ─────────────────────────────────────────────
function _syncSeg(segId, activeValue) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === activeValue);
  });
}

// ── Columns ───────────────────────────────────────────────────────────────────
export function setColumns(n) {
  n = parseInt(n) || 2;
  document.documentElement.style.setProperty('--columns', n);
  localStorage.setItem('st_columns', n);
  _syncSeg('col-seg', String(n));
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

// ── Density (compact/regular/comfy → --pad-x) ─────────────────────────────────
export function setDensity(density) {
  if (!Object.prototype.hasOwnProperty.call(PADS, density)) density = DEFAULT_DENSITY;
  state._density = density;
  document.body.style.setProperty('--pad-x', PADS[density] + 'px');
  localStorage.setItem(STORAGE_KEYS.DENSITY, density);
  _syncSeg('density-seg', density);
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

// ── Border radius ─────────────────────────────────────────────────────────────
export function setRadius(r) {
  r = Math.max(0, Math.min(22, parseInt(r) ?? DEFAULT_RADIUS));
  state._radius = r;
  document.body.style.setProperty('--radius', r + 'px');
  localStorage.setItem(STORAGE_KEYS.RADIUS, r);
  const label = document.getElementById('radius-label');
  if (label) label.textContent = r + 'px';
}

// ── Walking animation duration ────────────────────────────────────────────────
export function setAnimDur(ms) {
  ms = Math.max(200, Math.min(900, parseInt(ms) ?? DEFAULT_ANIM_DUR));
  state._walkAnimDur = ms;
  localStorage.setItem(STORAGE_KEYS.ANIM_DUR, ms);
  const label = document.getElementById('anim-dur-label');
  if (label) label.textContent = ms + 'мс';
}

// ── Line-height ───────────────────────────────────────────────────────────────
export function setLineH(val) {
  val = parseFloat(val) || 1.85;
  document.body.style.setProperty('--line-h', val);
  localStorage.setItem('st_line_h', val);
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

// ── Para-gap ──────────────────────────────────────────────────────────────────
export function setParaGap(val) {
  val = parseInt(val) ?? 18;
  document.body.style.setProperty('--para-gap', val + 'px');
  localStorage.setItem('st_para_gap', val);
  setTimeout(() => window.restorePageBySentence?.(false), 100);
}

// ── Walking curve ─────────────────────────────────────────────────────────────
export function setWalkCurve(curve) {
  state._walkCurve = curve;
  localStorage.setItem('walk_curve', curve);
  _syncSeg('curve-seg', curve);
}

// ── Walking context depth ─────────────────────────────────────────────────────
export function setWalkDepth(depth) {
  depth = parseInt(depth) || 2;
  state._walkCtxDepth = depth;
  localStorage.setItem('walk_ctx_depth', depth);
  _syncSeg('depth-seg', String(depth));
}

// ── Init new controls (called from initSettings) ──────────────────────────────
export function initNewControls() {
  // Read size (reading font size via --read-size on body)
  document.body.style.setProperty('--read-size', (state.readSize || DEFAULT_READ_SIZE) + 'px');
  updateFontSizeLabel();

  // Columns
  const savedCols = parseInt(localStorage.getItem('st_columns')) || 2;
  document.documentElement.style.setProperty('--columns', savedCols);
  _syncSeg('col-seg', String(savedCols));

  // Line-height
  const savedLineH = parseFloat(localStorage.getItem('st_line_h')) || 1.85;
  document.body.style.setProperty('--line-h', savedLineH);
  const lineHSlider = document.getElementById('line-h-slider');
  if (lineHSlider) { lineHSlider.value = savedLineH; lineHSlider.oninput = (e) => setLineH(e.target.value); }

  // Para-gap
  const savedParaGap = parseInt(localStorage.getItem('st_para_gap')) ?? 18;
  document.body.style.setProperty('--para-gap', savedParaGap + 'px');
  const paraGapSlider = document.getElementById('para-gap-slider');
  if (paraGapSlider) { paraGapSlider.value = savedParaGap; paraGapSlider.oninput = (e) => setParaGap(e.target.value); }

  // Density
  document.body.style.setProperty('--pad-x', PADS[state._density || DEFAULT_DENSITY] + 'px');
  _syncSeg('density-seg', state._density || DEFAULT_DENSITY);
  document.querySelectorAll('[data-action="set-density"]').forEach(btn => {
    btn.onclick = () => setDensity(btn.dataset.value);
  });

  // Radius
  document.body.style.setProperty('--radius', (state._radius ?? DEFAULT_RADIUS) + 'px');
  const radiusSlider = document.getElementById('radius-slider');
  if (radiusSlider) {
    radiusSlider.value = state._radius ?? DEFAULT_RADIUS;
    radiusSlider.oninput = (e) => setRadius(e.target.value);
  }
  const radiusLabel = document.getElementById('radius-label');
  if (radiusLabel) radiusLabel.textContent = (state._radius ?? DEFAULT_RADIUS) + 'px';

  // Walk animation duration
  const animDurSlider = document.getElementById('anim-dur-slider');
  if (animDurSlider) {
    animDurSlider.value = state._walkAnimDur ?? DEFAULT_ANIM_DUR;
    animDurSlider.oninput = (e) => setAnimDur(e.target.value);
  }
  const animDurLabel = document.getElementById('anim-dur-label');
  if (animDurLabel) animDurLabel.textContent = (state._walkAnimDur ?? DEFAULT_ANIM_DUR) + 'мс';

  // Walk curve
  const savedCurve = localStorage.getItem('walk_curve') || 'smooth';
  state._walkCurve = savedCurve;
  _syncSeg('curve-seg', savedCurve);

  // Walk depth
  const savedDepth = parseInt(localStorage.getItem('walk_ctx_depth')) || 2;
  state._walkCtxDepth = savedDepth;
  _syncSeg('depth-seg', String(savedDepth));
}
