// ReadAlong Auth Module
// Handles login, logout, and authentication UI

import { state } from './state.js';
import { show } from './ui.js';
import { showToast, esc } from './utils.js';
import {
  login as apiLogin,
  logout as apiLogout,
  initFetchInterceptor
} from './http.js';
import { STORAGE_KEYS } from './constants.js';
import { secureSet, secureGet } from './secureStore.js';
import { getMockBooks, getMockManifest, createMockEpubZip, generateMockWav } from './mock.js';

/**
 * Perform login
 */
export async function doLogin() {
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');

  if (!btn || !err) return;

  err.classList.remove('show');
  btn.disabled = true;
  btn.textContent = 'Підключення...';

  const serverUrl = document.getElementById('server-url')?.value?.replace(/\/$/, '') || '';
  const apiKey = document.getElementById('api-key')?.value?.trim() || '';
  const apiProvider = document.getElementById('api-provider')?.value || 'deepseek';
  const username = document.getElementById('username')?.value?.trim() || '';
  const password = document.getElementById('password')?.value || '';

  if (!serverUrl || !username || !password) {
    err.innerHTML = 'Будь ласка, заповніть всі поля';
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Увійти';
    return;
  }

  try {
    await apiLogin(serverUrl, username, password, apiKey, apiProvider);
    showToast('✓ Увійшли успішно');
    await loadBooksAndShow();
  } catch (e) {
    err.innerHTML = 'Помилка: ' + esc(e.message);
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Увійти';
  }
}

/**
 * Demo login — works without a backend
 */
export async function doDemoLogin() {
  state.mockMode = true;
  state.server = 'mock://demo';
  state.token = 'mock-token-' + Date.now();
  state.apiKey = '';
  state.apiProvider = 'deepseek';

  localStorage.setItem(STORAGE_KEYS.SERVER, state.server);
  await secureSet(STORAGE_KEYS.TOKEN, state.token);
  await secureSet(STORAGE_KEYS.API_KEY, state.apiKey);
  localStorage.setItem(STORAGE_KEYS.API_PROVIDER, state.apiProvider);

  showToast('🎭 Демо-режим');
  await loadBooksAndShow();
}

/**
 * Load books and switch to books screen
 * @private
 */
async function loadBooksAndShow() {
  try {
    // Import books module dynamically to avoid circular dependency
    const { loadBooks } = await import('./books.js');
    await loadBooks();
    show('books');
  } catch (e) {
    console.error('Failed to load books after login:', e);
    show('books');
  }
}

/**
 * Perform logout
 */
export function doLogout() {
  apiLogout();
  const btn = document.getElementById('login-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Увійти';
  }
  const err = document.getElementById('login-error');
  if (err) err.classList.remove('show');
  const pwdField = document.getElementById('password');
  if (pwdField) pwdField.value = '';
  showToast('Ви вийшли');
}

let _deferredPrompt = null;

/**
 * Initialize PWA install button
 */
export function initPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPrompt = e;
    const btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'block';
  });
}

/**
 * Install PWA (triggered by install button)
 */
export function installPWA() {
  if (_deferredPrompt) {
    _deferredPrompt.prompt();
    _deferredPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        showToast('Застосунок встановлюється!');
      }
      _deferredPrompt = null;
      const btn = document.getElementById('install-btn');
      if (btn) btn.style.display = 'none';
    });
  }
}

/**
 * Initialize authentication module
 */
export async function initAuth() {
  // Initialize fetch interceptor (will be configured on login)
  // initFetchInterceptor will be called in doLogin

  // Setup PWA
  initPWA();

  // Restore saved credentials (optional, auto-login not implemented for security)
  const savedServer = localStorage.getItem(STORAGE_KEYS.SERVER);
  const savedKey = await secureGet(STORAGE_KEYS.API_KEY);
  const savedProvider = localStorage.getItem(STORAGE_KEYS.API_PROVIDER);

  if (savedServer) {
    const serverInput = document.getElementById('server-url');
    if (serverInput) serverInput.value = savedServer;
  }
  if (savedKey) {
    const keyInput = document.getElementById('api-key');
    if (keyInput) keyInput.value = savedKey;
  }
  if (savedProvider) {
    const providerSelect = document.getElementById('api-provider');
    if (providerSelect) providerSelect.value = savedProvider;
  }

  // Check for saved token and try to use it
  const savedToken = await secureGet(STORAGE_KEYS.TOKEN);
  if (savedToken && savedServer && savedServer !== 'mock://demo') {
    state.token = savedToken;
    // Could auto-load books here, but better ask user to click login
  }
}
