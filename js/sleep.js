// ReadAlong Sleep Timer Module
// Handles sleep timer functionality

import { state } from './state.js';
import { getAudioElement } from './state.js';
import { showToast } from './utils.js';

let _sleepBtn = null;
let _sleepMenu = null;
let _sleepInterval = null;

/**
 * Initialize sleep timer button
 */
export function initSleepTimer() {
  // The button is now static in HTML; we just wire up the menu.
  _sleepBtn = document.getElementById('sleep-timer-btn');
  if (!_sleepBtn) return;

  // Меню — fixed-елемент у body (НЕ всередині controls-row плеєра, бо в walk
  // вона display:none → меню було б невидиме). Позицію виставляє toggle().
  if (!document.getElementById('sleep-timer-menu')) {
    _sleepMenu = document.createElement('div');
    _sleepMenu.className = 'sleep-timer-menu';
    _sleepMenu.id = 'sleep-timer-menu';
    _sleepMenu.innerHTML = `
      <div class="sleep-timer-option" data-minutes="15">15 хвилин</div>
      <div class="sleep-timer-option" data-minutes="30">30 хвилин</div>
      <div class="sleep-timer-option" data-minutes="45">45 хвилин</div>
      <div class="sleep-timer-option" data-minutes="chapter">До кінця розділу</div>
      <div class="sleep-timer-option" data-minutes="0">Вимкнути</div>
    `;
    document.body.appendChild(_sleepMenu);

    _sleepMenu.querySelectorAll('.sleep-timer-option').forEach(opt => {
      opt.onclick = () => {
        const val = opt.dataset.minutes;
        setSleepTimer(val === 'chapter' ? val : parseInt(val));
        _sleepMenu.classList.remove('show');
      };
    });
  } else {
    _sleepMenu = document.getElementById('sleep-timer-menu');
  }

  document.addEventListener('click', (e) => {
    if (_sleepMenu?.classList.contains('show') &&
        !e.target.closest('#sleep-timer-btn') &&
        !e.target.closest('#walk-btn-timer') &&
        !e.target.closest('#sleep-timer-menu')) {
      _sleepMenu.classList.remove('show');
    }
  });

  // expose for data-action dispatch + walk timer popover
  window.toggleSleepTimerMenu = toggleSleepTimerMenu;
  window.setSleepTimer = setSleepTimer;
}

/**
 * Toggle sleep timer menu, positioned (fixed) above the triggering button.
 * @param {HTMLElement} [anchorEl] - кнопка-тригер (walk-btn-timer у walk, sleep-timer-btn у reading)
 */
export function toggleSleepTimerMenu(anchorEl) {
  if (!_sleepMenu) return;
  const willShow = !_sleepMenu.classList.contains('show');
  _sleepMenu.classList.toggle('show', willShow);
  if (!willShow) return;

  const anchor = (anchorEl instanceof HTMLElement ? anchorEl : null) || _sleepBtn;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  // Над кнопкою, горизонтально по центру
  _sleepMenu.style.top = 'auto';
  _sleepMenu.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  _sleepMenu.style.left = (r.left + r.width / 2) + 'px';
  _sleepMenu.style.transform = 'translateX(-50%)';
  // Клемп по горизонталі, щоб не виходило за край екрана
  const mr = _sleepMenu.getBoundingClientRect();
  const m = 8;
  let shift = 0;
  if (mr.left < m) shift = m - mr.left;
  else if (mr.right > window.innerWidth - m) shift = (window.innerWidth - m) - mr.right;
  if (shift) _sleepMenu.style.left = (r.left + r.width / 2 + shift) + 'px';
}

/**
 * Set sleep timer
 * @param {number} minutes - Minutes (15,30,45) or special value 'chapter'
 */
export function setSleepTimer(minutes) {
  // «Вимкнути» (0) = просто зняти таймер, НЕ зводити його на «зараз»
  // (інакше checkSleepTimer одразу ставив аудіо на паузу й показував «завершено»).
  if (minutes === 0) {
    stopSleepTimer();
    showToast('Таймер вимкнено');
    return;
  }
  if (minutes === 'chapter') {
    state.sleepTimerEnd = null;
    state.sleepTimer = 'chapter';
  } else {
    state.sleepTimerEnd = Date.now() + minutes * 60000;
    state.sleepTimer = minutes;
  }
  if (_sleepBtn) _sleepBtn.classList.add('sleep-timer-active');
  showToast(`⏳ Таймер: ${minutes === 'chapter' ? 'до кінця розділу' : minutes + ' хв'}`);
  updateSleepTimerDisplay(); // негайне підтвердження (інтервал стартує лише через 1с)
  if (_sleepInterval) clearInterval(_sleepInterval);
  _sleepInterval = setInterval(() => {
    updateSleepTimerDisplay();
    checkSleepTimer();
  }, 1000);
}

/**
 * Stop sleep timer
 */
export function stopSleepTimer() {
  if (_sleepInterval) { clearInterval(_sleepInterval); _sleepInterval = null; }
  state.sleepTimer = null;
  state.sleepTimerEnd = null;
  if (_sleepBtn) {
    _sleepBtn.classList.remove('sleep-timer-active');
    _sleepBtn.innerHTML = '⏳';
  }
  _reflectWalkBtn(null);
}

// Walk-режим: окрема кнопка walk-btn-timer (reading-кнопка прихована). Без цього
// зведення таймера ніяк не видно в прогулянці → здавалось «нічого не робить».
function _reflectWalkBtn(label) {
  const btn = document.getElementById('walk-btn-timer');
  if (!btn) return;
  const armed = label != null;
  btn.classList.toggle('timer-armed', armed);
  const lbl = btn.querySelectorAll('span')[1];
  if (lbl) lbl.textContent = armed ? label : 'таймер';
}

/**
 * Update sleep timer display (call from audio timeupdate)
 */
export function updateSleepTimerDisplay() {
  let walkLabel = null;
  if (state.sleepTimerEnd) {
    const remaining = Math.max(0, state.sleepTimerEnd - Date.now());
    if (remaining > 0) {
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      const txt = `${mins}:${secs.toString().padStart(2, '0')}`;
      if (_sleepBtn) _sleepBtn.innerHTML = `⏳ ${txt}`;
      walkLabel = txt;
    } else if (_sleepBtn) {
      _sleepBtn.innerHTML = '⏳';
    }
  } else if (state.sleepTimer === 'chapter') {
    if (_sleepBtn) _sleepBtn.innerHTML = '⏳ Розділ';
    walkLabel = 'розділ';
  } else if (_sleepBtn) {
    _sleepBtn.innerHTML = '⏳';
  }
  _reflectWalkBtn(walkLabel);
}

/**
 * Check if timer expired (call from audio timeupdate)
 */
export function checkSleepTimer() {
  if (state.sleepTimerEnd && Date.now() >= state.sleepTimerEnd) {
    stopSleepTimer();
    const audio = getAudioElement();
    if (audio) audio.pause();
    showToast('⏰ Таймер завершено');
  }
}
