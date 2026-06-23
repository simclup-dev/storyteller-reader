// ReadAlong Reader Module
// Core reader logic: opening books, loading chapters, syncing text/audio

import { state, resetPlayer } from './state.js';
import { getAudioElement } from './state.js';
import { showToast, esc, loadScript, fmtTime, debounce } from './utils.js';
import { quickStructuralCheck } from './verifier.js';
import {
  getEpubBlob,
  getAudioManifest,
  getAudioUrl,
  getBookAssetFolder,
  saveProgressToServer,
  loadProgressFromServer,
  authHdr
} from './http.js';
import { cacheEpub, getCachedEpub, loadProgress, cacheAudio, getCachedAudio, clearBookCache, getCachedChapters } from './storage.js';
import { parseEpub, parseSmil, matchEpubChaptersToAudio, invalidateEpubCacheIfNeeded } from './epub.js';
import { loadAudioChapter, setActive, onTimeUpdate, onAudioPlay, onAudioPause } from './audio.js';
import { renderChapters as renderChaptersPanel, updateBookmarkBtn, renderBookmarkDots } from './panels.js';
import { show, applyModeClass } from './ui.js';
import { buildSpeedSlider } from './settings.js';
import { WALK_CURVES } from './constants.js';
import { attachGestures, attachWalkingGestures } from './gestures.js';
import { openTranslate } from './translate.js';
import { toggleBookmark } from './panels.js';

/**
 * Open a book
 * @param {number} idx - Index in state.books array
 */
export async function openBook(idx) {
  const book = state.books[idx];
  if (!book) return;

  resetPlayer(); // clear player leak when switching books directly (no backToBooks)
  state.currentBook = book;
  state.bookId = book.uuid || book.id;
  const bookId = state.bookId; // capture for race guards

  // Load asset folder for word-level transcriptions
state.assetFolder = null;
getBookAssetFolder(state.bookId).then(folder => {
  state.assetFolder = folder;
  console.log('Asset folder:', folder);
});

  try {
    localStorage.setItem(`lastopen_${state.bookId}`, Date.now());
  } catch (e) {
    console.warn(e);
  }

  state.epubChapters = [];
  state.audioChapters = [];
  state.chapters = [];
  state.currentChapterIdx = -1;
  state.sentences = [];
  state.activeIdx = -1;
  state.fallbackTried = false;
  state.history = [];
  state.vocabulary = JSON.parse(localStorage.getItem('st_vocab') || '[]');
  state.sleepTimer = null;
  state.sleepTimerEnd = null;

  show('reader');
  const readerScreen = document.getElementById('reader-screen');
  if (readerScreen) readerScreen.classList.add('reader-enter');
  setTimeout(() => readerScreen?.classList.remove('reader-enter'), 600);

  const titleEl = document.getElementById('reader-title');
  if (titleEl) titleEl.textContent = book.title || 'Книга';

  const textContent = document.getElementById('text-content');
  if (textContent) {
    textContent.style.display = '';
    textContent.innerHTML = `
      <div style="text-align:center;padding:4rem 1rem;color:var(--text-muted)">
        <div class="spinner"></div><br><br>Завантаження...
      </div>
    `;
  }
  document.getElementById('book-end-screen')?.classList.remove('show');

  const audio = getAudioElement();
  if (audio) {
    audio.pause();
    audio.src = '';
    // timeupdate/play/pause listeners are attached ONCE in app.js init().
    // Re-attaching them here added a second (raw) listener alongside the safe()
    // wrapper, so onTimeUpdate ran twice per tick. Do not re-wire them here.
  }

  buildSpeedSlider();
  applyModeClass();
  // Якщо книга відкривається ОДРАЗУ в walk — навісити тап-жести (play/pause).
  // Раніше це робив лише setMode (перехід reading→walk), тож прямий старт у walk
  // лишав текст без обробника тапа («тап нічого не робить»).
  if (state.mode === 'walking') activateWalkingGestures();

  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    if (state.bookId !== bookId) return;

    invalidateEpubCacheIfNeeded();

    let blob = await getCachedEpub(bookId);
    if (!blob) {
      blob = await getEpubBlob(bookId);
      if (state.bookId !== bookId) return;
      await cacheEpub(bookId, blob);
    }

    if (state.bookId !== bookId) return;
    await parseEpub(blob);
  } catch (e) {
    console.error('EPUB error:', e);
    if (textContent) {
      textContent.innerHTML = `
        <div style="text-align:center;padding:3rem;color:var(--danger)">
          Помилка epub:<br>${esc(e.message)}
        </div>
      `;
    }
    return;
  }

  if (state.bookId !== bookId) return;
  await loadAudioManifest();
  setupMediaSession();
}

/**
 * Set up Media Session API for lock screen controls
 */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const audio = getAudioElement();
  if (!audio) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.currentBook?.title || 'Аудіокнига',
    artist: state.currentBook?.author || '',
    album: 'ReadAlong',
    artwork: [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }]
  });
  navigator.mediaSession.setActionHandler('play', () => window.togglePlay?.());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => window.prevSentence?.());
  navigator.mediaSession.setActionHandler('nexttrack', () => window.nextSentence?.());
}

/**
 * Load audio manifest and match chapters
 */
export async function loadAudioManifest() {
  try {
    const manifest = await getAudioManifest(state.bookId);
    let offset = 0;

    state.audioChapters = (manifest.readingOrder || []).map(item => {
      const audioFile = item.href.split('/').pop().split('?')[0];
      const ch = {
        href: item.href,
        audioFile,
        title: item.title || '',
        duration: item.duration || 0,
        startTime: offset
      };
      offset += ch.duration;
      return ch;
    });

    state.totalDuration = offset;
    matchEpubChaptersToAudio();
    renderBookmarkDots();

    // Quick sanity check on manifest structure (< 50ms, no audio fetch)
    try {
      const { summary } = quickStructuralCheck();
      if (summary.fail > 0 || summary.warn > 0) {
        console.warn('[verifier] manifest has issues', summary);
        const seen = JSON.parse(localStorage.getItem('manifest_warn_seen') || '{}');
        if (!seen[state.bookId]) {
          showToast(
            `⚠ Маніфест підозрілий (${summary.fail} fail, ${summary.warn} warn) — Меню → Перевірити книгу`,
            'default',
            8000
          );
          seen[state.bookId] = 1;
          localStorage.setItem('manifest_warn_seen', JSON.stringify(seen));
        }
      }
    } catch (e) {
      console.warn('[verifier] quick check failed', e);
    }

    renderChapters();

    // Звірити прапорець офлайн-завантаження з реальним кешем (точно: к-сть розділів
    // з аудіо vs закешованих). Так книга, завантажена раніше (зокрема старим
    // по-розділах способом), отримує ✓; а якщо кеш неповний/стертий — прапорець знімається.
    try {
      const cached = await getCachedChapters(state.bookId);
      const need = state.epubChapters.filter(ec => ec.audioChapterIdx >= 0).length;
      if (need > 0 && cached.length >= need) {
        localStorage.setItem(`dl_${state.bookId}`, JSON.stringify({ total: need, at: Date.now() }));
      } else {
        localStorage.removeItem(`dl_${state.bookId}`);
      }
    } catch (_) {}

    const hasAudio = state.epubChapters.some(ec => ec.audioChapterIdx >= 0);
    if (!hasAudio) {
      const textContent = document.getElementById('text-content');
      if (textContent) textContent.style.display = 'none';
      showToast('⚠️ Книга не має аудіо-доріжок');
      return;
    }

    const restored = await tryRestoreProgress();
    if (!restored) {
      const firstMatchIdx = state.epubChapters.findIndex(ec => ec.audioChapterIdx >= 0);
      const startIdx = firstMatchIdx >= 0 ? firstMatchIdx : 0;
      loadChapter(startIdx, false);
    }
    // Проактивно проіндексувати System Log усіх минулих розділів у фоні,
    // щоб лог і картка персонажа були готові ще до відкриття панелі.
    window.indexSyslogBackground?.();
    window.indexCharsBackground?.();
  } catch (e) {
    console.error('Audio manifest error:', e);
    loadChapter(0, false);
  }
}

// ── Офлайн-завантаження книги з бібліотеки (без відкриття) ──────────────────
// Готує маніфест у state (без UI, без старту відтворення), потім кешує всі
// аудіо-розділи. Аудіо кешується за epubChIdx — той самий ключ, що читає плеєр.
const _JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

async function _prepareBookData(bookId) {
  await loadScript(_JSZIP_URL);
  invalidateEpubCacheIfNeeded();
  let blob = await getCachedEpub(bookId);
  if (!blob) {
    blob = await getEpubBlob(bookId);
    await cacheEpub(bookId, blob);
  }
  state.bookId = bookId;          // parseEpub/matchEpubChaptersToAudio читають state
  await parseEpub(blob);
  const manifest = await getAudioManifest(bookId);
  let offset = 0;
  state.audioChapters = (manifest.readingOrder || []).map(item => {
    const audioFile = item.href.split('/').pop().split('?')[0];
    const ch = { href: item.href, audioFile, title: item.title || '', duration: item.duration || 0, startTime: offset };
    offset += ch.duration;
    return ch;
  });
  state.totalDuration = offset;
  matchEpubChaptersToAudio();
}

/**
 * Завантажити й закешувати всю книгу (текст уже в кеші після підготовки, далі —
 * усі аудіо-розділи). onProgress(done, total) — для прогресу на кнопці.
 * @returns {Promise<boolean>}
 */
export async function downloadBookOffline(bookId, onProgress) {
  if (!bookId) return false;
  state._dlInProgress = state._dlInProgress || {};
  if (state._dlInProgress[bookId]) return false; // вже качається — не дублювати
  state._dlInProgress[bookId] = true;
  try {
    await _prepareBookData(bookId);
    // Знімок мапінгу epubChIdx→href — далі цикл НЕ читає глобальний state,
    // тож відкриття іншої книги під час завантаження не зламає кешування.
    const items = state.chapters.map(ch => {
      const ec = state.epubChapters[ch.epubChapterIdx];
      const ac = ec && ec.audioChapterIdx >= 0 ? state.audioChapters[ec.audioChapterIdx] : null;
      const href = ac ? ((ec.primaryHref && ec.primaryHref !== ac.href) ? ec.primaryHref : ac.href) : null;
      return { epubChIdx: ch.epubChapterIdx, href };
    }).filter(x => x.href);

    const total = items.length;
    let done = 0;
    onProgress?.(done, total);
    for (const it of items) {
      const cached = await getCachedAudio(bookId, it.epubChIdx);
      if (!cached) {
        try {
          const res = await fetch(getAudioUrl(bookId, it.href), { headers: authHdr() });
          if (res.ok) await cacheAudio(bookId, it.epubChIdx, await res.blob());
        } catch (_) { /* пропустити розділ, не валити всю книгу */ }
      }
      done++;
      onProgress?.(done, total);
    }
    try { localStorage.setItem(`dl_${bookId}`, JSON.stringify({ total, at: Date.now() })); } catch (_) {}
    return true;
  } finally {
    delete state._dlInProgress[bookId];
  }
}

/** Видалити офлайн-завантаження книги (текст + усе аудіо). */
export async function deleteBookDownload(bookId) {
  if (!bookId) return;
  await clearBookCache(bookId);
  try { localStorage.removeItem(`dl_${bookId}`); } catch (_) {}
}

/**
 * Try to restore reading progress
 * @returns {boolean}
 */
export async function tryRestoreProgress() {
  if (!state.audioChapters.length) return false;

  const localSaved = localStorage.getItem(`prog_${state.bookId}`);
  let localProgress = null;

  if (localSaved) {
    try {
      localProgress = JSON.parse(localSaved);
    } catch (e) {
      console.warn(e);
    }
  }

  const serverProgress = await loadProgressFromServer(state.bookId);
  let bestProgress = localProgress;

  if (serverProgress !== null && serverProgress.absTime > 0) {
    const localTs = localProgress?.savedAt || 0;
    const serverTs = serverProgress.timestamp || 0;
    // Pick the freshest record by wall-clock; if no local record, always use server
    if (!localProgress || serverTs > localTs) {
      bestProgress = { absTime: serverProgress.absTime, chapterIdx: -1, sentenceIdx: -1 };
    }
  }

  if (bestProgress && bestProgress.absTime > 5 && bestProgress.absTime < state.totalDuration) {
    let chIdx = 0;
    for (let i = 0; i < state.audioChapters.length; i++) {
      if (bestProgress.absTime >= state.audioChapters[i].startTime &&
          bestProgress.absTime < state.audioChapters[i].startTime + state.audioChapters[i].duration) {
        chIdx = state.epubChapters.findIndex(ec => ec.audioChapterIdx === i);
        if (chIdx >= 0) {
          bestProgress.chapterIdx = chIdx;
          break;
        }
      }
    }

    if (bestProgress.chapterIdx >= 0 && bestProgress.chapterIdx < state.epubChapters.length) {
      const ac = state.audioChapters[state.epubChapters[bestProgress.chapterIdx].audioChapterIdx];
      const offset = ac ? Math.max(0, bestProgress.absTime - ac.startTime) : 0;
      loadChapter(bestProgress.chapterIdx, false, offset);
      return true;
    }
  }

  return false;
}

/**
 * Load a chapter
 * @param {number} epubChIdx
 * @param {boolean} autoplay
 * @param {number} startAtOverride
 */
export function loadChapter(epubChIdx, autoplay = true, startAtOverride = undefined) {
  if (epubChIdx < 0 || epubChIdx >= state.epubChapters.length) return;

  state.currentChapterIdx = epubChIdx;
  const ec = state.epubChapters[epubChIdx];
  state.sentences = ec.sentences;
  state.activeIdx = -1;
  state.activeBlockIdx = -1;
  state.fallbackTried = false;
  state._prefetching = false;
  state._walkingBlocksBuilt = false;
  buildWalkingBlocks();

  // Invalidate walk DOM cache — _walkPool entries are keyed by block index (0,1,2…)
  // so they'd silently reuse previous chapter's DOM elements on the same indices.
  _walkPool.clear();
  if (_walkTrack) { _walkTrack.remove(); _walkTrack = null; }

  // Атмосферний арт розділу: оновити фон + (за налаштуванням) заставку розділу.
  try {
    const chMeta = state.chapters.find(c => c.epubChapterIdx === epubChIdx);
    window.updateChapterArt?.(epubChIdx, { title: chMeta?.label || '' });
  } catch (_) {}

  // System log: зібрати System-блоки для Листа Системи.
  try { window.collectSystemBlocks?.(epubChIdx, state.sentences, state.walkingBlocks); } catch (_) {}

  document.getElementById('book-end-screen')?.classList.remove('show');
  const textContent = document.getElementById('text-content');
  if (textContent) {
    textContent.style.display = '';
    textContent.classList.add('loading');
  }

  const startAt = startAtOverride !== undefined
    ? startAtOverride
    : (ec.sentences[0]?.clipBegin || 0);

  let startBlockIdx = 0;
  for (let i = 0; i < state.walkingBlocks.length; i++) {
    if (state.walkingBlocks[i].clipBegin <= startAt) startBlockIdx = i;
    else break;
  }

  renderText(false, startBlockIdx);

  const audioChIdx = ec.audioChapterIdx;
  if (audioChIdx >= 0) {
    loadAudioChapter(audioChIdx, startAt, autoplay, epubChIdx);
  } else {
    state.currentAudioChIdx = -1;
    if (textContent) textContent.classList.remove('loading');
    showToast('⚠️ Немає аудіо для цього розділу');
  }

  const ch = state.chapters.find(c => c.epubChapterIdx === epubChIdx);
  if (ch) {
    const chNoEl = document.getElementById('topbar-chapter-no');
    if (chNoEl) chNoEl.textContent = ch.label;
    const chNameEl = document.getElementById('current-chapter-name');
    if (chNameEl) chNameEl.textContent = ch.label;
  }

  updateBookmarkBtn();
}

/**
 * Build walking blocks by grouping sentences into ~3-6s chunks.
 * Detects dialogue (quote-balanced, per source sentence) and System text (bold EPUB markup).
 */
function buildWalkingBlocks() {
  // ── Pass 1: compute _isSystem and _isDialogue per source sentence ──────────
  // Dialogue detection uses quote-parity tracking across DOM order to catch
  // continuation lines that lack opening quotes (e.g. second paragraph of a reply).
  // Only DOUBLE quotes mark speech. Single curly ’ is an apostrophe in English
  // (it's, Carl's, don't) — counting it as a closing quote would corrupt the debt.
  const OPEN_QUOTES  = /[“«„]/g;     // “ « „
  const CLOSE_QUOTES = /[”»]/g;      // ” »
  const ANY_QUOTE    = /[“”«»„"]/;   // incl. straight " for hasQuote (some EPUBs use it)
  let openQuoteDebt = 0; // >0 means we are inside an unmatched open quote
  let prevPara = null;   // paragraph key from elId (e.g. "id110-s61" → "id110")

  for (let si = 0; si < state.sentences.length; si++) {
    const s = state.sentences[si];
    const txt = s.text || '';

    // Reset quote-debt at real paragraph boundaries so one unbalanced quote can't
    // leak "dialogue" onto the rest of the chapter. Only when the id scheme actually
    // encodes a paragraph (…-s<N>); otherwise keep pure parity (don't reset).
    const m = (s.elId || '').match(/^(.*)-s\d+$/);
    if (m) {
      if (m[1] !== prevPara) openQuoteDebt = 0;
      prevPara = m[1];
    }

    // System: from EPUB DOM priming (epub.js sets _isSystem); default false
    const isSys = !!s._isSystem;
    s._isSystem = isSys;

    if (isSys) {
      s._isDialogue = false;
      // System blocks don't carry quote debt (they're LitRPG status boxes, not speech)
    } else {
      const opens  = (txt.match(OPEN_QUOTES)  || []).length;
      const closes = (txt.match(CLOSE_QUOTES) || []).length;
      const hasQuote = ANY_QUOTE.test(txt);
      const inDebt   = openQuoteDebt > 0;
      s._isDialogue = hasQuote || inDebt;
      openQuoteDebt = Math.max(0, openQuoteDebt + opens - closes);
    }
  }

  // ── Pass 2: group into blocks ──────────────────────────────────────────────
  const blocks = [];
  let i = 0;
  while (i < state.sentences.length) {
    const startIdx = i;
    const firstDur = state.sentences[i].clipEnd - state.sentences[i].clipBegin;
    let dur = firstDur;
    let combinedText = state.sentences[i].text;
    let j = i + 1;

    if (firstDur < 4) {
      while (j < state.sentences.length) {
        const s = state.sentences[j];
        // Не зливати System з не-System в один блок — інакше маска змішана і walk-картка
        // (every system) не спрацьовує. Так System-вікно лишається цілісним блоком.
        if (!!s._isSystem !== !!state.sentences[startIdx]._isSystem) break;
        const sDur = s.clipEnd - s.clipBegin;
        if (sDur <= 0) { j++; continue; }
        const nextDur = dur + sDur;
        if (nextDur > 6) break;
        dur = nextDur;
        combinedText += ' ' + s.text;
        j++;
      }
    }

    const sentenceIndices = [];
    const dialogueMasks = [];
    const systemMasks = [];
    for (let k = startIdx; k < j; k++) {
      sentenceIndices.push(k);
      const isDial = state.sentences[k]._isDialogue;
      const isSys  = state.sentences[k]._isSystem;
      const wordCount = (state.sentences[k].text || '').split(/\s+/).filter(Boolean).length;
      for (let w = 0; w < wordCount; w++) {
        dialogueMasks.push(isDial);
        systemMasks.push(isSys);
      }
    }
    blocks.push({
      sentences: sentenceIndices,
      clipBegin: state.sentences[startIdx].clipBegin,
      clipEnd: state.sentences[j - 1].clipEnd,
      text: combinedText,
      dialogueMasks,
      systemMasks
    });
    i = j;
  }
  state.walkingBlocks = blocks;
}

// ─── Walking-mode GPU track renderer ─────────────────────────────────────────
// All rows stay in DOM. The track div slides via translateY (GPU).
// look(dist) gives scale + opacity per-row — no innerHTML during transitions.

// No fixed WALK_SP — rows are in a flex column, heights come from real layout.

let _walkTrack = null;
let _walkPool  = new Map(); // blockIdx → DOM element

const mkWordsMasked = (text, dialogueMask, systemMask) => {
  if (!text) return '';
  const words = text.split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    // System takes priority over dialogue (LitRPG boxes may contain quoted names)
    const cls = (systemMask && systemMask[i]) ? ' system'
      : (dialogueMask && dialogueMask[i]) ? ' dialogue' : '';
    return `<span class="word${cls}">${esc(w)}</span>`;
  }).join(' ');
};

// depth-aware: scale + opacity spread so 1/2/3 look visually distinct
function _walkLook(dist, depth) {
  const a = Math.abs(dist);
  if (a === 0) return { s: 1, o: 1 };
  if (a > depth) return { s: 0.62, o: 0 };
  const f = a / (depth + 1);
  return { s: 1 - 0.34 * f, o: 0.56 * (1 - f * 0.8) };
}

// Font size for .walk-line comes from CSS: calc(var(--font-size) * 1.4).
// A+/A− and pinch update --font-size on :root, so no inline size needed here.

function _walkEnsureDOM() {
  const c = document.getElementById('text-content');
  if (!c) return false;
  if (_walkTrack && c.contains(_walkTrack)) return true;
  _walkPool.clear();
  _walkTrack = null;
  c.style.height = '';
  c.innerHTML = '';
  const track = document.createElement('div');
  track.className = 'walk-track';
  c.appendChild(track);
  _walkTrack = track;
  return true;
}

// Insert el into _walkTrack at the correct sorted position (by data-idx).
function _walkInsertSorted(el, idx) {
  el.dataset.idx = String(idx);
  const after = Array.from(_walkTrack.children).find(ch => +(ch.dataset.idx) > idx);
  if (after) _walkTrack.insertBefore(el, after);
  else _walkTrack.appendChild(el);
}

function _walkPopulate(blockIdx) {
  const blocks = state.walkingBlocks;
  if (!blocks?.length || !_walkTrack) return;
  const depth = state._walkCtxDepth ?? 2;
  const minI = Math.max(0, blockIdx - depth - 1);
  const maxI = Math.min(blocks.length - 1, blockIdx + depth + 1);

  // Never remove rows — keeping them in flex flow preserves offsetTop stability.
  // Invisible (opacity:0) rows still hold their flex height so centering is correct.
  for (let i = minI; i <= maxI; i++) {
    if (!_walkPool.has(i)) {
      const blk = blocks[i];
      const el = document.createElement('div');
      el.className = 'walk-line';
      // LitRPG: якщо весь блок — System, оформити рядок як картку статус-вікна.
      if (blk?.systemMasks?.length && blk.systemMasks.every(Boolean)) {
        el.classList.add('walk-system-block');
      }
      el.innerHTML = mkWordsMasked(blk?.text, blk?.dialogueMasks, blk?.systemMasks);
      _walkInsertSorted(el, i);
      _walkPool.set(i, el);
    }
    const el = _walkPool.get(i);
    // Тап по тексту = ТІЛЬКИ play/pause (toggle на контейнері). Без переходу до речення:
    // навігація по блоках — лише кнопками ⏮/⏭. Прибирає й конфлікт click↔toggle, що
    // провокував нативний Touch-to-Search («Історія Google»).
    el.onclick = null;
  }
}

function _walkLayout(blockIdx, instant) {
  const c = document.getElementById('text-content');
  if (!c || !_walkTrack) return;
  const activeEl = _walkPool.get(blockIdx);
  if (!activeEl) return;

  // Read offsetTop BEFORE transforms — flex layout is unaffected by CSS scale.
  const CENTER = c.clientHeight / 2;
  const activeCenter = activeEl.offsetTop + activeEl.offsetHeight / 2;

  const depth = state._walkCtxDepth ?? 2;
  const dur = instant ? 0 : (state._walkAnimDur ?? 560);
  const ease = WALK_CURVES[state._walkCurve] ?? WALK_CURVES.smooth;

  _walkTrack.style.transition = dur ? `transform ${dur}ms ${ease}` : 'none';
  _walkTrack.style.transform = `translateY(${CENTER - activeCenter}px)`;

  _walkPool.forEach((el, idx) => {
    const lk = _walkLook(idx - blockIdx, depth);
    el.style.transition = dur
      ? `transform ${dur}ms ${ease}, opacity ${dur}ms ${ease}`
      : 'none';
    el.style.transform = `scale(${lk.s})`; // no translateY(-50%) — flex centres vertically
    el.style.opacity = lk.o;
    el.style.pointerEvents = lk.o > 0 ? 'auto' : 'none';
    el.classList.toggle('walk-line-active', idx === blockIdx);
  });
}

export function renderWalkingBlocks(blockIdx, animate = false) {
  if (blockIdx < 0 || !state.walkingBlocks?.length) return;
  if (!animate || !state._walkingBlocksBuilt) { buildWalkingBlocks(); state._walkingBlocksBuilt = true; }
  state.activeBlockIdx = blockIdx;
  if (!_walkEnsureDOM()) return;
  _walkPopulate(blockIdx);
  _walkLayout(blockIdx, !animate);
}

// CSS handles font-size (calc(var(--font-size)*1.4)); just re-apply layout after A+/A−/pinch.
function scaleWalkBlocks() {
  if (state.activeBlockIdx >= 0) _walkLayout(state.activeBlockIdx, true);
}
window._scaleWalkBlocks = scaleWalkBlocks;

window.walkBlockTap = (blockIdx) => {
  if (blockIdx < 0 || blockIdx >= state.walkingBlocks.length) return;
  const blk = state.walkingBlocks[blockIdx];
  if (state.activeBlockIdx !== blockIdx) {
    window._blockNavCooldown = true;
    setTimeout(() => { window._blockNavCooldown = false; }, 500);
    const audio = getAudioElement();
    if (audio) audio.currentTime = blk.clipBegin;
    setActive(blk.sentences[0]);
    if (window._renderWalkingBlocksFn) window._renderWalkingBlocksFn(blockIdx, true);
  }
};

/**
 * Process chapter HTML for reading mode: inject sentence spans and word spans
 * @param {Object} ec - epubChapter with sentences and readingHtml
 * @returns {string} modified HTML
 */
function processReadingHtml(ec) {
  if (!ec.readingHtml) return '';
  const doc = new DOMParser().parseFromString(ec.readingHtml, 'text/html');

  // Ensure _isSystem and _isDialogue are set on every sentence.
  // If buildWalkingBlocks has not run yet (e.g. first render before chapter load),
  // use a best-effort fallback from text content only — quotes for dialogue, never System.
  for (const s of ec.sentences) {
    if (s._isSystem === undefined) s._isSystem = false;
    if (s._isDialogue === undefined) {
      s._isDialogue = !s._isSystem && /[“”«»]/.test(s.text || '');
    }
  }

  // Inject sentence spans: wrap each SMIL-matched element's content
  let matchedCount = 0;
  for (let i = 0; i < ec.sentences.length; i++) {
    const s = ec.sentences[i];
    if (!s.elId) continue;
    const el = doc.getElementById(s.elId);
    if (!el) continue;
    matchedCount++;
    // System takes priority; dialogue only when not system
    const cls = s._isSystem ? ' system' : (s._isDialogue ? ' dialogue' : '');
    el.innerHTML = `<span class="text-sentence${cls}" id="s${i}" data-idx="${i}">${el.innerHTML}</span>`;
    // LitRPG: System = повністю-жирний елемент (детектиться в epub.js) → оформити
    // САМ елемент-абзац як картку статус-вікна (рамка/фон/моно). Інлайн-жирне сюди не
    // потрапляє (там boldEl коротший за текст), тож крихітних боксів не буде.
    if (s._isSystem) el.classList.add('system-block');
  }
  console.log(`processReadingHtml: ${matchedCount}/${ec.sentences.length} sentences matched via elId`);

  // Wrap words in <span class="word"> for audio sync
  wrapWordsInSpan(doc.body);
  const wordCount = doc.body.querySelectorAll('.word').length;
  const sentenceCount = doc.body.querySelectorAll('.text-sentence').length;
  const imgCount = doc.body.querySelectorAll('img').length;
  if (imgCount > 0) {
    console.log('images to render:', imgCount, Array.from(doc.body.querySelectorAll('img')).map(i => i.getAttribute('src')));
  }
  console.log(`processReadingHtml: ${matchedCount}/${ec.sentences.length} sentences, ${wordCount} words wrapped in ${sentenceCount} sentence-spans`);

  return doc.body.innerHTML;
}

function wrapWordsInSpan(root) {
  root.querySelectorAll('.text-sentence').forEach(sen => {
    const walker = document.createTreeWalker(sen, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    for (const node of textNodes) {
      const parts = node.textContent.split(/(\s+)/g);
      const frag = document.createDocumentFragment();
      let hasWord = false;
      for (const part of parts) {
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else if (part.trim()) {
          hasWord = true;
          const span = document.createElement('span');
          span.className = sen.classList.contains('system') ? 'word system'
            : sen.classList.contains('dialogue') ? 'word dialogue' : 'word';
          span.textContent = part;
          frag.appendChild(span);
        }
      }
      if (hasWord) node.parentNode.replaceChild(frag, node);
    }
  });
}

/**
 * Render text for current chapter
 * @param {boolean} scrollToTop
 * @param {number} startBlockIdx  - specific block to show (undefined = auto-detect from audio)
 */
export function renderText(scrollToTop = true, startBlockIdx) {
  const c = document.getElementById('text-content');
  if (!c || !state.sentences.length) {
    if (c) c.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-muted)">Текст не знайдено</div>';
    return;
  }

  if (state.mode === 'walking') {
    deactivateReadingGestures();
    buildWalkingBlocks();
    let blockIdx = startBlockIdx;
    if (blockIdx === undefined) {
      blockIdx = 0;
      const blocks = state.walkingBlocks;
      if (blocks?.length) {
        const audio = getAudioElement();
        const t = audio ? audio.currentTime : 0;
        for (let i = 0; i < blocks.length; i++) {
          if (blocks[i].clipBegin <= t) blockIdx = i;
          else break;
        }
      }
    }
    blockIdx = Math.max(0, Math.min((state.walkingBlocks?.length || 1) - 1, blockIdx));
    state.activeBlockIdx = blockIdx;
    renderWalkingBlocks(blockIdx);
  } else {
    // Reading mode: always wipe #text-content (clears spinner, walk-blocks, stale #text-inner)
    // then create a fresh #text-inner to slide columns into.
    c.style.height = '';
    c.innerHTML = '';
    const inner = document.createElement('div');
    inner.id = 'text-inner';
    c.appendChild(inner);

    const ec = state.epubChapters[state.currentChapterIdx];
    // (Картку-заголовок прибрано: книга вже містить власний заголовок розділу → дублювалось.)
    if (ec?.readingHtml) {
      inner.innerHTML = processReadingHtml(ec);
    } else {
      // Fallback: plain sentence list wrapped in <p> paragraphs (~8 sentences each)
      const PARA_SIZE = 8;
      const chunks = [];
      for (let i = 0; i < state.sentences.length; i += PARA_SIZE) {
        chunks.push(state.sentences.slice(i, i + PARA_SIZE).map((s, j) => {
          const idx = i + j;
          const words = s.text.split(/\s+/).filter(Boolean);
          const cls = s._isSystem ? ' system' : (s._isDialogue ? ' dialogue' : '');
          return `<span class="text-sentence${cls}" id="s${idx}" data-idx="${idx}">${words.map(w => `<span class="word${cls}">${esc(w)}</span>`).join(' ')}</span>`;
        }).join(' '));
      }
      inner.innerHTML = chunks.map(p => `<p>${p}</p>`).join('');
    }

    // Reset pagination immediately (page 0, no animation)
    resetPageState();

    // Wait for fonts to stabilise (metrics are final), then snap.
    // _snapToActive derives pageStride from live clientWidth every call,
    // so no separate measure step is needed here.
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        _snapToActive(false);
      }));
    });

    // Attach per-sentence gesture detector
    setTimeout(activateReadingGestures, 0);
  }
}

/**
 * Render chapters to panel
 */
export function renderChapters() {
  // Use the panels module's function
  if (window._renderChaptersFn) {
    window._renderChaptersFn();
  } else {
    // Fallback to direct rendering
    const list = document.getElementById('chapters-list');
    if (!list || !state.chapters.length) return;

    const savedProg = loadProgress(state.bookId);

    list.innerHTML = state.chapters.map((ch, i) => {
      const isCurrent = i === state.currentChapterIdx;
      const ec = state.epubChapters[ch.epubChapterIdx];
      const ac = ec && ec.audioChapterIdx >= 0 ? state.audioChapters[ec.audioChapterIdx] : null;
      const dur = ac ? ac.duration : (ec ? ec.duration : 0);
      const durStr = dur > 0 ? fmtTime(dur) : '';
      const wc = ec ? ec.sentences.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0) : 0;

      let progPct = 0;
      if (savedProg && ac && savedProg.chapterIdx != null) {
        const ecIdx = ch.epubChapterIdx;
        if (ecIdx < savedProg.chapterIdx) {
          progPct = 100;
        } else if (ecIdx === savedProg.chapterIdx) {
          progPct = Math.max(0, Math.min(100,
            Math.round(((savedProg.absTime - ac.startTime) / ac.duration) * 100))
          );
        }
      }

      const preview = ec?.sentences?.[0]?.text?.slice(0, 60) || '';

      return `
        <div class="chapter-item${isCurrent ? ' chapter-current' : ''}" data-action="go-chapter" data-idx="${i}">
          <div class="chapter-num">${i + 1}</div>
          <div class="chapter-info">
            <div class="chapter-label">${esc(ch.label)}</div>
            <div class="chapter-dur">${durStr ? durStr + ' · ' : ''}${wc} слів</div>
            ${preview ? `<div class="chapter-preview">${esc(preview)}…</div>` : ''}
          </div>
          <div class="chapter-progress-bar"><div class="chapter-progress-fill" style="width:${progPct}%"></div></div>
          <span class="chapter-dl-btn" id="dl_${i}" data-action="download-chapter" data-idx="${i}" title="Завантажити для офлайн">⬇</span>
          <span class="chapter-arrow">›</span>
        </div>
      `;
    }).join('');
  }
}

/**
 * Show book end screen
 */
export function showBookEnd() {
  const screen = document.getElementById('book-end-screen');
  if (!screen) return;

  const book = state.currentBook;
  const totalCh = state.chapters.length;
  const totalTime = state.totalDuration;
  const vocabCount = state.vocabulary.length;
  const transCount = state.history.length;
  const totalWords = state.epubChapters.reduce((sum, ec) =>
    sum + (ec.sentences ? ec.sentences.reduce((s2, sen) => s2 + sen.text.split(/\s+/).filter(Boolean).length, 0) : 0), 0
  );

  const textContent = document.getElementById('text-content');
  if (textContent) textContent.style.display = 'none';

  const subEl = document.getElementById('book-end-sub');
  if (subEl) subEl.textContent = book?.title || '';

  const statsEl = document.getElementById('book-end-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="book-end-stat"><div class="book-end-stat-value">${totalCh}</div><div class="book-end-stat-label">Розділів</div></div>
      <div class="book-end-stat"><div class="book-end-stat-value">${fmtTime(totalTime)}</div><div class="book-end-stat-label">Час</div></div>
      <div class="book-end-stat"><div class="book-end-stat-value">${totalWords.toLocaleString()}</div><div class="book-end-stat-label">Слів</div></div>
      <div class="book-end-stat"><div class="book-end-stat-value">${vocabCount}</div><div class="book-end-stat-label">У словнику</div></div>
      <div class="book-end-stat"><div class="book-end-stat-value">${transCount}</div><div class="book-end-stat-label">Перекладів</div></div>
    `;
  }

  // Suggest next book
  suggestNextBook();

  screen.classList.add('show');
}

/**
 * Suggest next book to read
 */
function suggestNextBook() {
  const currId = state.bookId;
  const author = state.currentBook ? getAuthorName(state.currentBook) : '';
  const candidates = state.books
    .filter(b => (b.uuid || b.id) !== currId)
    .map(b => {
      const key = `prog_${b.uuid || b.id}`;
      let prog = 0;
      try {
        const p = JSON.parse(localStorage.getItem(key));
        if (p) prog = (p.absTime || 0) / (p.totalDuration || 1);
      } catch (e) { console.warn(e); }
      return { book: b, prog };
    });

  candidates.sort((a, b) => {
    const aSame = getAuthorName(a.book) === author ? 1 : 0;
    const bSame = getAuthorName(b.book) === author ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    return a.prog - b.prog;
  });

  const best = candidates[0];
  const sugEl = document.getElementById('next-book-suggestion');

  if (best) {
    const sameAuthor = getAuthorName(best.book) === author;
    const bookIndex = state.books.indexOf(best.book);

    sugEl.innerHTML = `
      <div style="margin:1.25rem 0 0.6rem;padding-top:1rem;border-top:1px solid var(--border);text-align:center;">
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">
          ${sameAuthor ? 'Ще від цього автора' : 'Можливо вас зацікавить'}
        </div>
        <div class="next-book-card" data-action="open-book-and-close" data-idx="${bookIndex}">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.95rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${esc(best.book.title || best.book.name || '')}
            </div>
            ${best.prog > 0 ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.15rem;">${Math.round(best.prog * 100)}% прочитано</div>` : ''}
          </div>
          <span style="color:var(--accent);font-size:1.2rem;flex-shrink:0;">›</span>
        </div>
      </div>
    `;
  } else {
    sugEl.innerHTML = '';
  }
}

// Helper: get author name
export function getAuthorName(b) {
  return b.author || b.authors?.[0]?.name || 'Невідомий';
}

// ── Sentence gesture entry-points ────────────────────────────────────────────

export function openTranslateForSentence(idx) {
  openTranslate(idx);
}

function toggleBookmarkAt(idx) {
  const prev = state.activeIdx;
  state.activeIdx = idx;
  toggleBookmark();
  state.activeIdx = prev;
}

let _detachReadingGestures = null;

export function activateReadingGestures() {
  if (_detachReadingGestures) _detachReadingGestures();
  const container = document.getElementById('text-content');
  if (!container) return;

  const detachGestures = attachGestures(container, '.text-sentence', {
    onTap: (el) => {
      const idx = Number(el.dataset.idx);
      if (!isNaN(idx)) window.sentenceTap?.(idx);
    },
    onLongPress: (el) => {
      const idx = Number(el.dataset.idx);
      if (!isNaN(idx)) openTranslateForSentence(idx);
    },
    onDoubleTap: (el) => {
      const idx = Number(el.dataset.idx);
      if (isNaN(idx)) return;
      const action = state.doubleTapAction || 'translate';
      if (action === 'translate') openTranslateForSentence(idx);
      else if (action === 'bookmark') toggleBookmarkAt(idx);
      // 'none' — no-op
    }
  });

  // Right-click on sentence → translate (desktop)
  function onContextMenu(e) {
    const target = e.target.closest('.text-sentence');
    if (!target) return;
    e.preventDefault();
    const idx = Number(target.dataset.idx);
    if (!isNaN(idx)) {
      state.blockNextSentenceTap = true;
      openTranslateForSentence(idx);
    }
  }
  container.addEventListener('contextmenu', onContextMenu);

  _detachReadingGestures = () => {
    detachGestures();
    container.removeEventListener('contextmenu', onContextMenu);
  };
}

export function deactivateReadingGestures() {
  _detachReadingGestures?.();
  _detachReadingGestures = null;
}

// ── Walking-mode gesture wiring ───────────────────────────────────────────────

let _detachWalkingGestures = null;
let _pinchBaseFontSize = null;

export function activateWalkingGestures() {
  if (_detachWalkingGestures) _detachWalkingGestures();
  const container = document.getElementById('text-content');
  if (!container) return;

  // Tap anywhere on text area = toggle play/pause; panel visibility follows audio state.
  window.walkToggle = () => { window.haptic?.(); window.togglePlay?.(); };

  _detachWalkingGestures = attachWalkingGestures(container, {
    onToggle: () => window.walkToggle?.(),
    onPinch: (scale) => {
      if (_pinchBaseFontSize == null) {
        _pinchBaseFontSize = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--font-size')
        ) || state.fontSize || 21;
      }
      const newSize = Math.max(14, Math.min(36, Math.round(_pinchBaseFontSize * scale)));
      document.documentElement.style.setProperty('--font-size', newSize + 'px');
      state.fontSize = newSize;
      try { localStorage.setItem('fontSize', String(newSize)); } catch (e) {}
    }
  });

  container.addEventListener('touchend', () => { _pinchBaseFontSize = null; }, { passive: true });

  _initWalkControlsPanel();

  if (!state.walkingTutorialShown) {
    _showWalkingTutorial();
  }
}

/**
 * Show or hide the walk-controls panel.
 * When showing, recalculate `bottom` so the panel sits above the player-bar (progress strip).
 * Called from audio.js via window.setWalkControlsVisible.
 */
window.setWalkControlsVisible = function setWalkControlsVisible(show) {
  const panel = document.getElementById('walk-controls');
  if (!panel) return;
  if (show) {
    const playerBar = document.getElementById('player-bar');
    panel.style.bottom = (playerBar ? playerBar.offsetHeight : 0) + 'px';
    panel.classList.add('visible');
  } else {
    panel.classList.remove('visible');
    document.getElementById('walk-more-popover')?.classList.remove('open');
  }
};

/**
 * Перерахувати позицію walk-треку (центрування активного рядка) під поточний
 * розмір #text-content. Кличеться з audio.js після ховання/повернення топбару,
 * коли висота тексту змінюється.
 */
window.repositionWalkTrack = function repositionWalkTrack(instant) {
  if (state.mode !== 'walking') return;
  _walkLayout(state.activeBlockIdx ?? 0, !!instant);
};

export function deactivateWalkingGestures() {
  _detachWalkingGestures?.();
  _detachWalkingGestures = null;
  // Hide panel when leaving walking mode
  window.setWalkControlsVisible(false);
}

function _initWalkControlsPanel() {
  // Wire up walk-controls buttons. Called each time walking mode is activated.
  // Buttons use stopPropagation so they don't bubble up to the text-area toggle.
  const panel = document.getElementById('walk-controls');
  if (!panel || panel._walkCtrlInitDone) return;
  panel._walkCtrlInitDone = true;

  const stopAndCall = (fn) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.haptic?.();
    fn(e);
  };

  // Prev block
  document.getElementById('walk-btn-prev')?.addEventListener('click', stopAndCall(() => {
    const prevIdx = Math.max(0, (state.activeBlockIdx ?? 0) - 1);
    window.walkBlockTap?.(prevIdx);
  }));

  // Translate active phrase
  document.getElementById('walk-btn-translate')?.addEventListener('click', stopAndCall(() => {
    const sentIdx = state.activeIdx >= 0
      ? state.activeIdx
      : (state.walkingBlocks?.[state.activeBlockIdx]?.sentences?.[0] ?? 0);
    openTranslateForSentence(sentIdx);
  }));

  // Next block
  document.getElementById('walk-btn-next')?.addEventListener('click', stopAndCall(() => {
    const nextIdx = Math.min(
      (state.walkingBlocks?.length ?? 1) - 1,
      (state.activeBlockIdx ?? 0) + 1
    );
    window.walkBlockTap?.(nextIdx);
  }));

  // ⏳ sleep timer — власний popover у walk-controls (той самий надійний механізм, що й more)
  const timerBtn = document.getElementById('walk-btn-timer');
  const timerPop = document.getElementById('walk-timer-popover');
  timerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.haptic?.();
    popover?.classList.remove('open');     // не тримати обидва відкритими
    timerPop?.classList.toggle('open');
  });
  timerPop?.querySelectorAll('[data-min]').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = opt.dataset.min;
      window.setSleepTimer?.(v === 'chapter' ? v : parseInt(v, 10));
      timerPop.classList.remove('open');
    });
  });

  // ⋯ more button — toggle popover
  const moreBtn = document.getElementById('walk-btn-more');
  const popover = document.getElementById('walk-more-popover');
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.haptic?.();
    timerPop?.classList.remove('open');
    popover?.classList.toggle('open');
  });

  // Close popovers when tapping outside. ⚠️ contains() (а не !==): тап потрапляє на
  // внутрішній <span> кнопки, тож !==btn хибно закривав і bubble одразу відкривав назад.
  document.addEventListener('click', (e) => {
    if (popover?.classList.contains('open') && !popover.contains(e.target) && !moreBtn.contains(e.target)) {
      popover.classList.remove('open');
    }
    if (timerPop?.classList.contains('open') && !timerPop.contains(e.target) && !timerBtn.contains(e.target)) {
      timerPop.classList.remove('open');
    }
  }, true);

  // Popover actions — all stop propagation, close popover, then act
  const moreAction = (fn) => (e) => {
    e.stopPropagation();
    popover?.classList.remove('open');
    fn();
  };

  document.getElementById('walk-more-chapters')?.addEventListener('click', moreAction(() => {
    window.openChapters?.();
  }));
  document.getElementById('walk-more-bookmark')?.addEventListener('click', moreAction(() => {
    _showWalkingBookmarkConfirm(state.activeBlockIdx ?? 0);
  }));
  document.getElementById('walk-more-treadmill')?.addEventListener('click', moreAction(() => {
    const on = document.body.classList.toggle('treadmill-mode');
    try { localStorage.setItem('st_treadmill', on ? '1' : '0'); } catch (_) {}
    document.getElementById('walk-more-treadmill')?.classList.toggle('treadmill-on', on);
    showToast(on ? '🏃 Доріжка-режим увімкнено' : 'Доріжка-режим вимкнено');
    requestAnimationFrame(() => window.repositionWalkTrack?.(true));
  }));
  document.getElementById('walk-more-stats')?.addEventListener('click', moreAction(() => {
    window.openStats?.();
  }));
  document.getElementById('walk-more-syslog')?.addEventListener('click', moreAction(() => {
    window.openSystemLog?.();
  }));
  document.getElementById('walk-more-chars')?.addEventListener('click', moreAction(() => {
    window.openChars?.();
  }));
  document.getElementById('walk-more-settings')?.addEventListener('click', moreAction(() => {
    window.openSettings?.();
  }));
  document.getElementById('walk-more-reading')?.addEventListener('click', moreAction(() => {
    window.setMode?.('reading');
  }));
}

function _showWalkingBookmarkConfirm(blockIdx) {
  const overlay = document.getElementById('walk-bookmark-confirm');
  if (!overlay) return;
  const sentenceIdx = state.walkingBlocks?.[blockIdx]?.sentences?.[0] ?? state.activeIdx;
  overlay.dataset.idx = String(sentenceIdx >= 0 ? sentenceIdx : 0);
  overlay.classList.add('visible');
}

function _showWalkingTutorial() {
  const tutorial = document.getElementById('walking-tutorial');
  if (!tutorial) return;
  tutorial.classList.add('visible');
  const dismiss = () => {
    tutorial.classList.remove('visible');
    state.walkingTutorialShown = true;
    try { localStorage.setItem('st_walk_tutorial_shown', '1'); } catch (e) { console.warn(e); }
    tutorial.removeEventListener('click', dismiss);
  };
  tutorial.addEventListener('click', dismiss);
  setTimeout(dismiss, 8000);
}

// Show ✦ FAB above current sentence on pause (reading mode only), 3s
export function showTranslateHintOnPause() {
  if (state.mode !== 'reading') return;
  if (state.activeIdx < 0) return;
  const el = document.getElementById(`s${state.activeIdx}`);
  if (!el) return;
  let fab = document.getElementById('translate-hint-fab');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'translate-hint-fab';
    fab.className = 'translate-hint-fab';
    fab.textContent = '✦';
    fab.onclick = () => openTranslateForSentence(state.activeIdx);
    document.getElementById('reader-screen')?.appendChild(fab);
  }
  const rect = el.getBoundingClientRect();
  // position:fixed → viewport coords, no scrollY needed
  fab.style.top = (rect.top - 56) + 'px';
  fab.style.left = (rect.right - 48) + 'px';
  fab.classList.add('visible');
  clearTimeout(window._hintFabTimer);
  window._hintFabTimer = setTimeout(() => fab.classList.remove('visible'), 3000);
}

// Export for usage in panels
window._renderChaptersFn = renderChaptersPanel;
window._renderWalkingBlocksFn = renderWalkingBlocks;
window.showTranslateHintOnPause = showTranslateHintOnPause;
window.openTranslateForSentence = openTranslateForSentence;
window.getAudioUrl = getAudioUrl;
window.authHdr = () => ({ 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' });

// ─── Real horizontal pagination (v4 — exact arithmetic) ──────────────────────
// Architecture:
//   • #text-inner: CSS multi-column container (column-count:N, column-fill:auto,
//     no horizontal padding → clientWidth = column area V, gap = G).
//   • With column-COUNT (not column-width), the browser lays out perfectly even
//     columns: every column left = k·colStride where colStride = (V + G) / N.
//     One PAGE = N columns, so pageStride = colStride·N = V + G.
//   • page X offset = page · pageStride. This is exact (verified live: V=1764, G=60,
//     N=2 → real column edges land on 0,912,1824,2736,… = multiples of 912).
//
// WHY earlier getClientRects-based measuring failed (the real root cause):
//   The text contains nested .text-sentence / .word spans. Range.getClientRects()
//   and element.getClientRects() then return ONE RECT PER WORD, not per line/column
//   — thousands of intra-column X positions. Treating those as column edges produced
//   a tiny "stride" (≈ a word width) → pages that advanced a centimetre and a bogus
//   page count in the thousands. There is no even per-column stride to "measure"
//   incorrectly: column-count layout IS exact, so we compute it directly.
//
//   • Source of truth for "which page" = layout x of active sentence inside #text-inner,
//     computed as el.getBoundingClientRect().left - inner.getBoundingClientRect().left.
//     The current translateX cancels in that difference, giving the true layout position.
//     offsetLeft was previously used here but returns column-local x in some browsers.

let _currentPage = 0;

function _getInner() { return document.getElementById('text-inner'); }

function _pageStride(inner) {
  const gap = parseFloat(getComputedStyle(inner).columnGap) || 0;
  return inner.clientWidth + gap;            // V + G — рівно одна сторінка для column-count
}

function _totalPages(inner, stride) {
  if (!inner || !stride) return 1;
  const gap = parseFloat(getComputedStyle(inner).columnGap) || 0;
  return Math.max(1, Math.round((inner.scrollWidth + gap) / stride));
}

function _updatePageNumEl(total) {
  const el = document.getElementById('page-num');
  if (!el) return;
  const inner = _getInner();
  el.textContent = `${_currentPage + 1} з ${total ?? (inner ? _totalPages(inner, _pageStride(inner)) : 1)}`;
}

function _applyPage(page, animate) {
  const inner = _getInner();
  if (!inner) return;
  const stride = _pageStride(inner);
  const total  = _totalPages(inner, stride);
  _currentPage = Math.max(0, Math.min(Math.round(page), total - 1));
  inner.style.transition = animate ? 'transform 560ms cubic-bezier(.22,1,.36,1)' : 'none';
  inner.style.transform  = `translateX(${-_currentPage * stride}px)`;
  _updatePageNumEl(total);
}

function _snapToActive(animate) {
  if (state.mode !== 'reading') return;
  const inner = _getInner();
  if (!inner) return;
  const stride = _pageStride(inner);
  const total  = _totalPages(inner, stride);
  const idx = state.activeIdx >= 0 ? state.activeIdx : 0;
  const el  = document.querySelector('.word.active') || document.getElementById(`s${idx}`) || document.querySelector('.text-sentence');
  if (!el) { _applyPage(0, false); return; }
  const layoutX = el.getBoundingClientRect().left - inner.getBoundingClientRect().left;
  const page = Math.max(0, Math.min(Math.floor(layoutX / stride), total - 1));
  if (page === _currentPage && inner.style.transform === `translateX(${-page * stride}px)`) return;
  _currentPage = page;
  inner.style.transition = animate ? 'transform 560ms cubic-bezier(.22,1,.36,1)' : 'none';
  inner.style.transform  = `translateX(${-page * stride}px)`;
  _updatePageNumEl(total);
}

export function resetPageState() {
  _currentPage = 0;
  const inner = _getInner();
  if (inner) { inner.style.transition = 'none'; inner.style.transform = 'translateX(0)'; }
  _updatePageNumEl(1);
}

function updatePlayerHeightVar() {
  const bar = document.getElementById('player-bar');
  if (bar) document.documentElement.style.setProperty('--player-height', bar.offsetHeight + 'px');
}
window.updatePlayerHeightVar = updatePlayerHeightVar;

// ── Public API ────────────────────────────────────────────────────────────────

// Manual page turn: pause audio first, then shift page counter.
window.turnPage = (dir) => {
  if (state.mode !== 'reading') return;
  const audio = getAudioElement();
  if (audio && !audio.paused) audio.pause();
  _applyPage(_currentPage + dir, true);
};

window.updatePageNum = () => _updatePageNumEl();

// Called from ResizeObserver, settings (font/column changes), and chapter open.
// pageStride is derived live each call, so just re-snap to the active sentence.
window.restorePageBySentence = (animate) => {
  _snapToActive(animate ?? false);
};

// Called by audio.js on every new active sentence while playing.
window._syncPageToSentence = (_el) => {
  const audio = getAudioElement();
  if (!audio || audio.paused) return;
  _snapToActive(false);  // instant during auto-follow; manual turns (which pause audio) still animate
};

// ── DOM init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const c = document.getElementById('text-content');
  updatePlayerHeightVar();
  if (!c) return;

  const ro = new ResizeObserver(debounce(() => {
    updatePlayerHeightVar();
    if (state.mode === 'reading') {
      _snapToActive(false);  // pageStride is recomputed live from clientWidth
    }
  }, 150));
  ro.observe(c);

  document.addEventListener('keydown', (e) => {
    if (state?.mode === 'walking') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); window.turnPage(1); }
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); window.turnPage(-1); }
  });
});
