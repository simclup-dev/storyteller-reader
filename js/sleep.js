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

  // Build menu anchored to the button
  if (!document.getElementById('sleep-timer-menu')) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-flex';
    _sleepBtn.parentNode.insertBefore(wrapper, _sleepBtn);
    wrapper.appendChild(_sleepBtn);

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
    wrapper.appendChild(_sleepMenu);

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
        !e.target.closest('#sleep-timer-menu')) {
      _sleepMenu.classList.remove('show');
    }
  });

  // expose for data-action dispatch
  window.toggleSleepTimerMenu = toggleSleepTimerMenu;
}

/**
 * Toggle sleep timer menu
 */
export function toggleSleepTimerMenu() {
  if (!_sleepMenu) return;
  _sleepMenu.classList.toggle('show');
}

/**
 * Set sleep timer
 * @param {number} minutes - Minutes (15,30,45) or special value 'chapter'
 */
export function setSleepTimer(minutes) {
  if (minutes === 'chapter') {
    state.sleepTimerEnd = null;
    state.sleepTimer = 'chapter';
  } else {
    state.sleepTimerEnd = Date.now() + minutes * 60000;
    state.sleepTimer = minutes;
  }
  if (_sleepBtn) _sleepBtn.classList.add('sleep-timer-active');
  showToast(`⏳ Таймер: ${minutes === 'chapter' ? 'до кінця розділу' : minutes + ' хв'}`);
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
}

/**
 * Update sleep timer display (call from audio timeupdate)
 */
export function updateSleepTimerDisplay() {
  if (!_sleepBtn) return;
  if (state.sleepTimerEnd) {
    const remaining = Math.max(0, state.sleepTimerEnd - Date.now());
    if (remaining <= 0) {
      _sleepBtn.innerHTML = '⏳';
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    _sleepBtn.innerHTML = `⏳ ${mins}:${secs.toString().padStart(2, '0')}`;
  } else if (state.sleepTimer === 'chapter') {
    _sleepBtn.innerHTML = '⏳ Розділ';
  } else {
    _sleepBtn.innerHTML = '⏳';
  }
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
