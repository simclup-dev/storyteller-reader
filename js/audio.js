// ReadAlong Audio Module
// Handles audio playback, navigation, and progress tracking

import { state } from './state.js';
import { getAudioElement } from './state.js';
import { showToast, fmtTime, throttle, isInViewport } from './utils.js';
import { SPEEDS } from './constants.js';
import { getAudioUrl, authHdr, getBookAssetFolder, loadTranscription } from './http.js';
import { checkSleepTimer, stopSleepTimer, updateSleepTimerDisplay } from './sleep.js';
import { saveProgress, getCachedAudio } from './storage.js';
import { updateBookmarkBtn } from './panels.js';


/**
 * Request wake lock to keep screen on.
 * If Wake Lock API is unavailable, activates a silent looping <video> fallback (NoSleep technique).
 */
export async function requestWakeLock() {
  if (navigator.wakeLock) {
    // Native Wake Lock API path
    if (state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (e) {
      // Denied or document not visible — will retry via heartbeat/visibilitychange
    }
  } else {
    // Fallback: tiny looping muted video keeps the screen on in browsers
    // that do not support the Wake Lock API (e.g. older iOS Safari, Firefox Android).
    _noSleepEnsure();
    if (state._noSleepVideo && state._noSleepVideo.paused) {
      state._noSleepVideo.play().catch(() => {}); // may require user gesture; silently ignore
    }
  }
}

/**
 * Release wake lock (and stop fallback video if active)
 */
export function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release();
    state.wakeLock = null;
  }
  if (state._noSleepVideo && !state._noSleepVideo.paused) {
    state._noSleepVideo.pause();
  }
}

/** Ensure the NoSleep <video> element exists in the DOM (created once, hidden). */
function _noSleepEnsure() {
  if (state._noSleepVideo) return;
  // Real, working silent looping clips from NoSleep.js (public domain). A muted
  // looping <video> keeps the screen awake on browsers lacking the Wake Lock API.
  const WEBM = 'data:video/webm;base64,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';
  const MP4 = 'data:video/mp4;base64,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';
  const video = document.createElement('video');
  video.setAttribute('muted', '');
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('loop', '');
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
  for (const [type, src] of [['video/webm', WEBM], ['video/mp4', MP4]]) {
    const source = document.createElement('source');
    source.type = type;
    source.src = src;
    video.appendChild(source);
  }
  document.body.appendChild(video);
  state._noSleepVideo = video;
}

let _progressRAF = null;
let _lastProgUpdate = 0;
let _chapterLoadCounter = 0;

/**
 * Load audio chapter
 * @param {number} audioChIdx - Audio chapter index
 * @param {number} startAt - Start time in seconds
 * @param {boolean} autoplay
 * @param {number} epubChIdx - EPUB chapter index
 */
export function loadAudioChapter(audioChIdx, startAt = 0, autoplay = false, epubChIdx = -1) {
  const audio = getAudioElement();
  if (!audio || !state.audioChapters || audioChIdx >= state.audioChapters.length) return;

  state.currentAudioChIdx = audioChIdx;
  const ac = state.audioChapters[audioChIdx];
  const ec = state.epubChapters[epubChIdx] || { primaryHref: null, audioEpubFile: null };
  const href = (ec.primaryHref && ec.primaryHref !== ac.href) ? ec.primaryHref : ac.href;
  const fullUrl = getAudioUrl(state.bookId, href);

  // Clean up previous
  audio.onended = null;
  audio.onerror = () => {
    document.getElementById('text-content')?.classList.remove('loading');
  };
  if (audio._cacheUrl) {
    URL.revokeObjectURL(audio._cacheUrl);
    audio._cacheUrl = null;
  }
  if (audio._endedHandler) {
    audio.removeEventListener('ended', audio._endedHandler);
    audio._endedHandler = null;
  }

  // Load word-level transcription for this chapter
  const loadId = ++_chapterLoadCounter;
  state.wordTimeline = null;
  state.wordTimelineLoaded = false;
  state.timelineReady = false;
  const audioFilename = href.split('/').pop().split('?')[0];
  const loadWords = (folder) => {
    if (!folder) return;

    // Build candidate transcription filenames (try multiple naming patterns)
    const candidates = [audioFilename];
    if (ec?.audioEpubFile && ec.audioEpubFile !== audioFilename) {
      candidates.push(ec.audioEpubFile);
    }
    const ext = audioFilename.includes('.') ? audioFilename.split('.').pop() : '';
    // Swap AAAAA-BBBBB → BBBBB-AAAAA
    const m = audioFilename.match(/^(\d+)-(\d+)/);
    if (m) {
      const swapped = m[2] + '-' + m[1] + (ext ? '.' + ext : '');
      if (!candidates.includes(swapped)) candidates.push(swapped);
    }
    if (ec?.audioEpubFile) {
      const m2 = ec.audioEpubFile.match(/^(\d+)-(\d+)/);
      if (m2) {
        const swapped2 = m2[2] + '-' + m2[1] + '.' + (ec.audioEpubFile.split('.').pop() || ext);
        if (!candidates.includes(swapped2)) candidates.push(swapped2);
      }
    }

    const tryLoad = (idx) => {
      if (idx >= candidates.length) {
        console.log(`loadWords: no transcription found for chapter ${audioChIdx} (tried ${candidates.length} names)`);
        return;
      }
      loadTranscription(folder, candidates[idx]).then(data => {
        if (loadId !== _chapterLoadCounter) return;
        if (data && data.timeline) {
          const words = data.timeline.filter(t => t.type === 'word');
          if (words.length > 20) {
            state.wordTimeline = words;
            state.wordTimelineLoaded = true;
            console.log(`Word timestamps loaded: ${words.length} words for chapter ${audioChIdx} (file=${candidates[idx]})`);
            // Cache per-sentence timeline index ranges (brute-force: O(words×sentences), once per chapter)
            state.sentences.forEach(s => { s._tlStart = -1; s._tlEnd = -1; });
            for (let i = 0; i < words.length; i++) {
              const w = words[i];
              for (let si = state.sentences.length - 1; si >= 0; si--) {
                const sen = state.sentences[si];
                if (w.startTime >= sen.clipBegin - 0.05 && w.endTime <= sen.clipEnd + 0.05) {
                  if (sen._tlStart < 0) sen._tlStart = i;
                  sen._tlEnd = i;
                  break;
                }
              }
            }
            state.timelineReady = true;
            return;
          }
        }
        tryLoad(idx + 1);
      }).catch(e => {
        console.warn('loadTranscription error for', candidates[idx], ':', e);
        tryLoad(idx + 1);
      });
    };
    tryLoad(0);
  };
  if (state.assetFolder) {
    loadWords(state.assetFolder);
  } else if (state.bookId) {
    // Asset folder might still be loading — fetch it now
    getBookAssetFolder(state.bookId).then(folder => {
      state.assetFolder = folder;
      loadWords(folder);
    });
  }

  const doSeekAndPlay = () => {
    if (loadId !== _chapterLoadCounter) return; // race-guard: глава вже змінилась
    document.getElementById('text-content')?.classList.remove('loading');
    audio.playbackRate = SPEEDS[state.speedIdx];
    const realDuration = audio.duration;

    // Fallback check for short audio (likely wrong file)
    if (realDuration > 0 && !state.fallbackTried && ec.duration > 30 && realDuration < ec.duration * 0.5) {
      state.fallbackTried = true;
      state.fallbackChapterIdx = epubChIdx;
      attemptUniversalFallback(epubChIdx, startAt, autoplay);
      return;
    }

    if (startAt > 0) audio.currentTime = startAt;

    audio._endedHandler = () => { audio._endedHandler = null; _handleChapterEnded(); };
    audio.addEventListener('ended', audio._endedHandler, { once: true });

    if (autoplay || !audio.paused) {
      audio.play().catch(e => {
        if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
      });
    }

    // Update UI
    updatePlayButton();
  };

  audio.addEventListener('loadedmetadata', doSeekAndPlay, { once: true });

  // Try cached audio first
  getCachedAudio(state.bookId, state.currentChapterIdx).then(blob => {
    if (blob) {
      audio._cacheUrl = URL.createObjectURL(blob);
      audio.src = audio._cacheUrl;
    } else {
      audio.src = fullUrl;
    }
    audio.playbackRate = SPEEDS[state.speedIdx];
    audio.load();
  });
}

/**
 * Toggle play/pause
 */
export function togglePlay() {
  const audio = getAudioElement();
  if (!audio) return;

  if (audio.paused) {
    audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  } else {
    audio.pause();
  }
}

/**
 * Handle audio play event
 */
export function onAudioPlay() {
  updatePlayButton(true);
  startProgressLoop();
  state.readingSessionStart = Date.now();

  // Re-acquire wake lock on play (user-gesture context: some browsers require it)
  requestWakeLock();

  if (state.mode === 'walking') {
    // Walk-програвання: сховати walk-controls + топбар (симетричний верх),
    // потім перерахувати позицію треку під новий розмір тексту.
    window.setWalkControlsVisible?.(false);
    document.getElementById('reader-screen')?.classList.add('walk-immersive');
    requestAnimationFrame(() => window.repositionWalkTrack?.(true));
  } else {
    // In reading mode: snap to active sentence's page immediately.
    // rAF ensures layout is committed before getBoundingClientRect fires.
    document.getElementById('reader-screen')?.classList.add('reading-focus');
    requestAnimationFrame(() => window.restorePageBySentence?.(true));
  }
}

// Єдина точка обробки кінця розділу. Викликається з УСІХ шляхів завантаження
// аудіо (основний + 2 fallback), щоб таймер «до кінця розділу» не можна було
// обійти. Раніше fallback-обробники просто переходили далі, ігноруючи таймер.
function _handleChapterEnded() {
  saveReadingTime();
  saveProgress();
  window.extractSyslogBackground?.(state.currentChapterIdx);
  window.extractCharsBackground?.(state.currentChapterIdx);
  if (state.sleepTimer === 'chapter') {
    stopSleepTimer();
    showToast('⏰ Кінець розділу – таймер зупинено');
    return;
  }
  const nextEpubIdx = state.currentChapterIdx + 1;
  if (nextEpubIdx < state.epubChapters.length) {
    window.loadChapter?.(nextEpubIdx, true);
  } else {
    window.showBookEnd?.();
  }
}

function saveReadingTime() {
  if (!state.readingSessionStart) return;
  const elapsed = Math.round((Date.now() - state.readingSessionStart) / 1000);
  state.readingSessionStart = Date.now();
  if (elapsed <= 0) return;
  state.totalReadingTime = (state.totalReadingTime || 0) + elapsed;
  const today = new Date().toISOString().slice(0, 10);
  state.dailyReadingTime[today] = (state.dailyReadingTime[today] || 0) + elapsed;
  try {
    localStorage.setItem('total_reading_time', state.totalReadingTime);
    localStorage.setItem('reading_time_' + today, state.dailyReadingTime[today]);
  } catch (e) {}
  window.onWalkTimeSaved?.();
}

export function onAudioPause() {
  saveReadingTime();
  updatePlayButton(false);
  saveProgress(true); // force: пауза — синхронізувати позицію на сервер одразу
  stopProgressLoop();
  // Зняти focus-режим (на паузі — вільне читання без приглушення)
  document.getElementById('reader-screen')?.classList.remove('reading-focus');
  // Walk-пауза: повернути топбар; walk-controls показати ЛИШЕ якщо немає
  // відкритої панелі (інакше її кнопки лягли б поверх панелі).
  if (state.mode === 'walking') {
    document.getElementById('reader-screen')?.classList.remove('walk-immersive');
    if (!document.querySelector('.bottom-panel.open')) {
      window.setWalkControlsVisible?.(true);
    }
    requestAnimationFrame(() => window.repositionWalkTrack?.(true));
  }
  // Show ✦ hint FAB above current sentence so users discover long-press translate
  window.showTranslateHintOnPause?.();
}

/**
 * Update play button icon
 * @param {boolean} playing
 */
export function updatePlayButton(playing = null) {
  const btn = document.getElementById('play-btn');
  if (!btn) return;

  const isPlaying = playing !== null ? playing : !getAudioElement()?.paused;

  btn.innerHTML = isPlaying
    ? `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

  btn.classList.toggle('playing', isPlaying);
}

/**
 * Seek audio by event (progress bar click)
 * @param {Event} e
 */
export function seekAudio(e) {
  const audio = getAudioElement();
  const ac = state.audioChapters[state.currentAudioChIdx];
  if (!audio || !ac) return;

  const rect = document.getElementById('progress-track')?.getBoundingClientRect();
  if (!rect) return;

  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  audio.currentTime = ratio * ac.duration;
}

/**
 * Seek relative seconds
 * @param {number} secs
 */
export function seekRel(secs) {
  const audio = getAudioElement();
  const ac = state.audioChapters[state.currentAudioChIdx];
  if (!audio || !ac) return;

  const newTime = Math.max(0, Math.min(ac.duration, audio.currentTime + secs));
  audio.currentTime = newTime;
}

/**
 * Start progress tracking loop
 */
export function startProgressLoop() {
  if (_progressRAF) return;

  const loop = (ts) => {
    if (ts - _lastProgUpdate >= 33) {
      _lastProgUpdate = ts;
      window.updateSentenceProgress?.();
    }
    _progressRAF = requestAnimationFrame(loop);
  };
  _progressRAF = requestAnimationFrame(loop);
}

/**
 * Stop progress tracking loop
 */
export function stopProgressLoop() {
  if (_progressRAF) {
    cancelAnimationFrame(_progressRAF);
    _progressRAF = null;
  }
}

/**
 * Update on timeupdate event
 * @param {Event} e
 */
export function onTimeUpdate() {
  const audio = getAudioElement();
  if (!audio) return;

  const t = audio.currentTime;
  const ac = state.audioChapters[state.currentAudioChIdx];
  const dot = document.getElementById('buffering-dot');
  if (dot) dot.classList.toggle('active', audio.readyState < 3);

  // Update chapter progress
  if (ac && ac.duration > 0) {
    const pct = (t / ac.duration) * 100;
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = `${pct}%`;
    // #9 кільце навколо play (прогрес у розділі)
    const ring = document.getElementById('play-ring-fill');
    if (ring) ring.style.strokeDashoffset = String(289 * (1 - Math.min(1, pct / 100)));
    const thumb = document.getElementById('progress-thumb');
    if (thumb) thumb.style.left = `${pct}%`;

    const timeCurrent = document.getElementById('time-current');
    if (timeCurrent) timeCurrent.textContent = fmtTime(t);

    // Права мітка = час, що ЛИШИВСЯ у розділі (важливо на доріжці; пасує до
    // таймера «до кінця розділу»). Лічильник назад із «−».
    const timeTotal = document.getElementById('time-total');
    if (timeTotal) timeTotal.textContent = '−' + fmtTime(Math.max(0, ac.duration - t));
  }

  // Update total reading progress
  if (state.totalDuration > 0 && ac) {
    const totalProgress = ((ac.startTime || 0) + t) / state.totalDuration * 100;
    const readingFill = document.getElementById('reading-progress-fill');
    if (readingFill) readingFill.style.width = `${Math.min(100, totalProgress)}%`;

    const timeProgress = document.getElementById('time-progress');
    if (timeProgress) {
      const remaining = Math.max(0, state.totalDuration - totalProgress / 100 * state.totalDuration);
      timeProgress.textContent = `${Math.round(totalProgress)}% · залишилось ${fmtTime(remaining)}`;
    }
  }

  // Prefetch next chapter
  if (!state._prefetching && ac && ac.duration > 0 && t > Math.max(0, ac.duration - 8)) {
    const nextEpubIdx = state.currentChapterIdx + 1;
    if (nextEpubIdx < state.epubChapters.length) {
      state._prefetching = true;
      const nextEc = state.epubChapters[nextEpubIdx];
      const nextAudioIdx = nextEc.audioChapterIdx;
      if (nextAudioIdx >= 0) {
        const nextAc = state.audioChapters[nextAudioIdx];
        const nextHref = (nextEc.primaryHref && nextEc.primaryHref !== nextAc.href) ? nextEc.primaryHref : nextAc.href;
        const nextUrl = getAudioUrl(state.bookId, nextHref);
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'audio';
        link.href = nextUrl;
        link.onload = () => link.remove();
        link.onerror = () => link.remove();
        document.head.appendChild(link);
      }
    }
  }

  // Check sleep timer and update display
  checkSleepTimer();
  updateSleepTimerDisplay();

  // Update active sentence
  const sens = state.sentences;
  if (!sens.length) return;

  // Binary search for current sentence
  let lo = 0, hi = sens.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sens[mid].clipBegin <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (found >= 0 && found !== state.activeIdx) {
    setActive(found);
  }

  // Auto-save progress every 30 seconds
  if (t > 5 && (!state._lastProgSave || Date.now() - state._lastProgSave > 30000)) {
    state._lastProgSave = Date.now();
    saveProgress();
  }
}

/**
 * Set active sentence index and update UI
 * @param {number} idx
 */
export function setActive(idx) {
  if (state.activeIdx === idx) return;
  state.activeIdx = idx;

  // Sentence/block changed — drop any prior word highlight up front so it can
  // never linger if updateActiveWord early-returns for the new sentence.
  window.clearActiveWord?.();

  // Walking mode: blocks handle their own DOM via renderWalkingBlocks
  if (state.mode === 'walking') {
    updateBookmarkBtn();
    return;
  }

  const sentences = document.querySelectorAll('.text-sentence, .text-chunk');
  if (!state._setActiveCalls) state._setActiveCalls = 0;
  state._setActiveCalls++;
  if (state._setActiveCalls <= 3 || state._setActiveCalls % 50 === 0) {
    console.log(`setActive(${idx}) call#${state._setActiveCalls}, found ${sentences.length} sentence elements, mode=${state.mode}`);
  }

  // Sentence-level band classes only. Word state (.active/.past) is owned
  // exclusively by the read-along state machine (setActiveSentence in app.js),
  // which wipes the outgoing sentence's words — no per-sentence clearing here.
  let activeSentenceEl = null;
  sentences.forEach(el => {
    const elIdx = parseInt(el.id?.replace('s', '') || '', 10);
    if (elIdx === idx) {
      el.classList.add('active');
      el.classList.remove('past');
      activeSentenceEl = el;
    } else {
      el.classList.remove('active');
      if (!isNaN(elIdx) && elIdx < idx) el.classList.add('past');
      else el.classList.remove('past');
    }
    const pb = el.querySelector('.sentence-progress');
    if (pb) pb.style.width = '0';
  });
  // Hand the new sentence to the state machine so its word state is clean.
  if (activeSentenceEl) window.setActiveSentenceEl?.(activeSentenceEl);

  // Scroll into view
  let scrollEl = document.getElementById(`s${idx}`);
  if (!scrollEl) {
    for (let d = 1; d <= 999; d++) {
      if (idx - d < 0) break;
      scrollEl = document.getElementById(`s${idx - d}`);
      if (scrollEl) break;
    }
    if (!scrollEl) {
      for (let d = 1; d <= 20; d++) {
        scrollEl = document.getElementById(`s${idx + d}`);
        if (scrollEl) break;
      }
    }
  }

  if (scrollEl) {
    if (state.mode === 'walking') {
      scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window._syncPageToSentence?.(scrollEl);
    }
  }

  updateBookmarkBtn();
}

/**
 * Go to previous sentence
 */
export function prevSentence() {
  if (state.mode === 'walking' && state.walkingBlocks?.length) {
    const idx = Math.max(0, state.activeBlockIdx - 1);
    const blk = state.walkingBlocks[idx];
    if (blk) {
      window._blockNavCooldown = true;
      setTimeout(() => { window._blockNavCooldown = false; }, 500);
      state.activeBlockIdx = idx;
      const audio = getAudioElement();
      audio.currentTime = blk.clipBegin;
      setActive(blk.sentences[0]);
      if (window._renderWalkingBlocksFn) window._renderWalkingBlocksFn(idx, true);
      if (audio.paused) audio.play().catch(e => {
        if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
      });
    }
    return;
  }

  let idx = state.activeIdx;
  if (idx < 0) idx = state.sentences.length - 1;
  else if (idx > 0) idx -= 1;

  if (idx > 0 && state.sentences[idx].text.split(' ').length <= 4) idx -= 1;

  const s = state.sentences[idx];
  if (s && s.clipBegin != null) {
    const audio = getAudioElement();
    audio.currentTime = s.clipBegin;
    setActive(idx);
    if (audio.paused) audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  }
}

/**
 * Go to next sentence
 */
export function nextSentence() {
  if (state.mode === 'walking' && state.walkingBlocks?.length) {
    const idx = Math.min(state.walkingBlocks.length - 1, state.activeBlockIdx + 1);
    const blk = state.walkingBlocks[idx];
    if (blk && idx !== state.activeBlockIdx) {
      window._blockNavCooldown = true;
      setTimeout(() => { window._blockNavCooldown = false; }, 500);
      state.activeBlockIdx = idx;
      const audio = getAudioElement();
      audio.currentTime = blk.clipBegin;
      setActive(blk.sentences[0]);
      if (window._renderWalkingBlocksFn) window._renderWalkingBlocksFn(idx, true);
      if (audio.paused) audio.play().catch(e => {
        if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
      });
    }
    return;
  }

  let idx = state.activeIdx;
  if (idx < 0 || idx >= state.sentences.length - 1) return;
  idx += 1;

  if (idx < state.sentences.length - 1 && state.sentences[idx].text.split(' ').length <= 4) idx += 1;

  const s = state.sentences[idx];
  if (s && s.clipBegin != null) {
    const audio = getAudioElement();
    audio.currentTime = s.clipBegin;
    setActive(idx);
    if (audio.paused) audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  }
}

/**
 * Handle sentence tap (click on text)
 * @param {number} idx
 */
export function sentenceTap(idx) {
  if (state.blockNextSentenceTap) {
    state.blockNextSentenceTap = false;
    return;
  }

  const s = state.sentences[idx];
  if (s && s.clipBegin != null) {
    const audio = getAudioElement();
    audio.currentTime = s.clipBegin;
    if (audio.paused) audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  }
  setActive(idx);
}

/**
 * Attempt universal fallback for audio files
 * @param {number} epubChIdx
 * @param {number} startAt
 * @param {boolean} autoplay
 */
async function attemptUniversalFallback(epubChIdx, startAt, autoplay) {
  const audio = getAudioElement();
  if (!audio) return;

  const ac = state.audioChapters[state.currentAudioChIdx];
  const ec = state.epubChapters[epubChIdx];
  if (!ac || !ec) return;

  if (ec.primaryHref) { ec.primaryHref = null; }
  const candidates = [];
  if (ec.audioEpubFile) candidates.push(ec.audioEpubFile);
  const m = ec.audioEpubFile?.match(/(\d+)-(\d+)\.mp4$/i);
  if (m) candidates.push(m[2] + '-' + m[1] + '.mp4');
  for (const chapter of state.audioChapters) {
    if (Math.abs(chapter.duration - ec.duration) < 2.0) {
      const candidateFile = chapter.href.split('/').pop().split('?')[0];
      if (!candidates.includes(candidateFile)) candidates.push(candidateFile);
    }
  }
  const prefixMatch = ec.audioEpubFile?.match(/^(\d+-)/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    for (let i = 1; i <= 10; i++) {
      const fname = prefix + String(i).padStart(5, '0') + '.mp4';
      if (!candidates.includes(fname)) candidates.push(fname);
    }
  }

  for (const fname of candidates) {
    const testUrl = getAudioUrl(state.bookId, fname);
    try {
      const headRes = await fetch(testUrl, { method: 'HEAD', headers: authHdr() });
      if (!headRes.ok) continue;
      const size = parseInt(headRes.headers.get('content-length') || '0');
      const expectedSize = ec.duration * 16000;
      const sizeRatio = size / expectedSize;
      if (sizeRatio > 0.7 && sizeRatio < 1.3 && size > 1000000) {
        ec.primaryHref = fname;
        ++_chapterLoadCounter;
        state.wordTimeline = null;
        state.wordTimelineLoaded = false;
        state.timelineReady = false;
        if (state.assetFolder) {
          loadTranscription(state.assetFolder, fname).then(data => {
            if (!data?.timeline) return;
            state.wordTimeline = data.timeline.filter(t => t.type === 'word');
            if (state.wordTimeline.length > 20) {
              state.wordTimelineLoaded = true;
            }
            state.timelineReady = true;
          }).catch(() => {});
        }
        audio.src = testUrl;
        audio.load();
        await new Promise((resolve, reject) => {
          const onMeta = () => {
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.playbackRate = SPEEDS[state.speedIdx];
            if (audio.duration > ec.duration * 0.5) resolve();
            else reject(new Error('short'));
          };
          audio.addEventListener('loadedmetadata', onMeta, { once: true });
          audio.addEventListener('error', () => reject(new Error('error')), { once: true });
        });
        if (startAt > 0) audio.currentTime = startAt;
        if (audio._endedHandler) {
          audio.removeEventListener('ended', audio._endedHandler);
          audio._endedHandler = null;
        }
        audio._endedHandler = () => { audio._endedHandler = null; _handleChapterEnded(); };
        audio.addEventListener('ended', audio._endedHandler, { once: true });
        if (autoplay || !audio.paused) {
          audio.play().catch(e => {
            if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
          });
        }
        return;
      }
    } catch(e) {
      console.warn(e);
    }
  }

  // Fallback: use original href
  const origHref = state.audioChapters[ec.audioChapterIdx].href;
  audio.src = getAudioUrl(state.bookId, origHref);
  audio.load();
  if (startAt > 0) audio.currentTime = startAt;
  if (audio._endedHandler) {
    audio.removeEventListener('ended', audio._endedHandler);
    audio._endedHandler = null;
  }
  audio._endedHandler = () => { audio._endedHandler = null; _handleChapterEnded(); };
  audio.addEventListener('ended', audio._endedHandler, { once: true });
  if (autoplay || !audio.paused) {
    audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  }
}

// Re-export dependencies
export { getAudioElement };