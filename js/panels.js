// ReadAlong Panels Module
// Manages bottom panels: chapters, bookmarks, settings, stats, book info

import { state, getBookmarks, saveBookmarks, getAudioElement } from './state.js';
import { showToast, esc, fmtTime } from './utils.js';
import { loadProgress } from './storage.js';
import { openPanel, closeAllPanels } from './ui.js';
import { authHdr, getAudioUrl } from './http.js';
import { getCachedChapters, cacheAudio, removeCachedAudio } from './storage.js';

/**
 * Render chapters list in panel
 */
export function renderChapters() {
  const list = document.getElementById('chapters-list');
  if (!list || !state.chapters.length) {
    if (list) list.innerHTML = '<div style="padding:1rem 1.25rem;color:var(--text-muted);font-size:0.88rem;">Розділи не знайдено</div>';
    return;
  }

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
          Math.round(((savedProg.absTime - ac.startTime) / ac.duration) * 100)
        ));
      }
    }

    const preview = ec?.sentences?.[0]?.text?.slice(0, 60) || '';

    return `
      <div class="chapter-item${isCurrent ? ' chapter-current' : ''}" data-action="go-chapter" data-idx="${i}">
        <div class="chapter-num">${i + 1}</div>
        <div class="chapter-info" style="flex:1;min-width:0;">
          <div class="chapter-label">${esc(ch.label)}</div>
          <div style="height:3px;background:var(--line2,var(--surface2));border-radius:2px;margin-top:6px;position:relative;max-width:200px;">
            ${progPct > 0 ? `<div style="position:absolute;left:0;top:0;height:3px;width:${progPct}%;background:var(--accent);border-radius:2px;"></div>` : ''}
          </div>
        </div>
        <span class="tnum" style="font-size:13px;color:var(--faint,var(--text-dim));flex-shrink:0;">${durStr}</span>
        <span class="chapter-dl-btn" id="dl_${i}" data-action="download-chapter" data-idx="${i}" title="Завантажити для офлайн">⬇</span>
      </div>
    `;
  }).join('');

  // Scroll to current chapter
  if (state.currentChapterIdx >= 0 && list.children[state.currentChapterIdx]) {
    list.children[state.currentChapterIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  updateDlButtons();
}

/**
 * Jump to chapter
 * @param {number} idx - Chapter index in state.chapters
 */
export function goChapter(idx) {
  closeAllPanels();
  const ch = state.chapters[idx];
  if (ch) {
    if (window.loadChapter) {
      window.loadChapter(ch.epubChapterIdx, false);
    }
  }
}

/**
 * Update download button states for all chapters
 */
export async function updateDlButtons() {
  const chapters = state.chapters;
  if (!chapters) return;

  const cached = await getCachedChapters(state.bookId);

  for (let i = 0; i < chapters.length; i++) {
    const btn = document.getElementById(`dl_${i}`);
    if (!btn) continue;

    if (cached.includes(String(chapters[i].epubChapterIdx))) {
      btn.classList.add('cached');
      btn.textContent = '✓';
    } else {
      btn.classList.remove('cached');
      btn.textContent = '⬇';
    }
  }
}

/**
 * Download chapter for offline
 * @param {number} idx
 * @returns {Promise<boolean>}
 */
export async function downloadChapter(idx) {
  if (idx < 0 || idx >= state.chapters.length) return false;

  const ch = state.chapters[idx];
  const btn = document.getElementById(`dl_${idx}`);
  if (!btn) return false;

  // Toggle: if already cached, remove
  if (btn.classList.contains('cached')) {
    await removeCachedAudio(state.bookId, ch.epubChapterIdx);
    btn.classList.remove('cached');
    btn.textContent = '⬇';
    showToast('🗑 Кеш видалено');
    return false;
  }

  btn.textContent = '⏳';
  const ec = state.epubChapters[ch.epubChapterIdx];
  const ac = ec.audioChapterIdx >= 0 ? state.audioChapters[ec.audioChapterIdx] : null;

  if (!ac) {
    showToast('⚠️ Немає аудіо для цього розділу');
    btn.textContent = '⬇';
    return false;
  }

  const href = (ec.primaryHref && ec.primaryHref !== ac.href) ? ec.primaryHref : ac.href;

  try {
    const res = await fetch(getAudioUrl(state.bookId, href), { headers: authHdr() });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const blob = await res.blob();
    await cacheAudio(state.bookId, ch.epubChapterIdx, blob);

    btn.classList.add('cached');
    btn.textContent = '✓';
    showToast(`✅ Розділ ${idx + 1} закешовано`);
    return true;
  } catch (e) {
    showToast('⚠️ Помилка завантаження');
    btn.textContent = '⬇';
    return false;
  }
}

/**
 * Download all chapters
 */
export async function downloadAllChapters() {
  let ok = 0, fail = 0;
  for (let i = 0; i < state.chapters.length; i++) {
    if (await downloadChapter(i)) ok++;
    else fail++;
  }
  showToast(fail ? `✅ ${ok} закешовано, ${fail} помилок` : '✅ Всі розділи закешовано');
  setTimeout(updateDlButtons, 1000);
}

/**
 * Render bookmarks list
 */
export function renderBookmarks() {
  const list = document.getElementById('bookmarks-list');
  if (!list) return;

  const bmarks = getBookmarks();

  if (!bmarks.length) {
    list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:0.9rem;">Немає закладок</div>';
    return;
  }

  list.innerHTML = bmarks.map((b, i) => {
    const ch = state.chapters.find(c => c.epubChapterIdx === b.chapterIdx);
    const label = ch ? ch.label : `Розділ ${b.chapterIdx + 1}`;

    return `
      <div class="bookmark-item" data-action="jump-bookmark" data-idx="${i}">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="font-size:14px;font-weight:600;color:var(--ink,var(--text));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(label)}</div>
            <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
              <span class="tnum" style="font-size:12px;color:var(--accent);">${fmtTime(b.absTime)}</span>
              <span style="color:var(--faint,var(--text-dim));cursor:pointer;" data-action="remove-bookmark" data-idx="${i}">✕</span>
            </div>
          </div>
          <input class="bm-note-input" data-bm-i="${i}" value="${esc(b.note || '')}" placeholder="+ нотатка">
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.bm-note-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('change', e => {
      const bm = getBookmarks();
      const i = Number(e.target.dataset.bmI);
      if (bm[i]) { bm[i].note = e.target.value.trim(); saveBookmarks(bm); }
    });
  });
}

/**
 * Jump to bookmark
 * @param {number} i
 */
export function jumpToBookmark(i) {
  const bmarks = getBookmarks();
  const b = bmarks[i];
  if (!b) return;

  closeAllPanels();

  const chIdx = state.chapters.findIndex(c => c.epubChapterIdx === b.chapterIdx);
  if (chIdx >= 0 && window.goChapter) {
    window.goChapter(chIdx);

    if (b.sentenceIdx >= 0) {
      setTimeout(() => {
        if (window.setActive) window.setActive(b.sentenceIdx);
        const audio = getAudioElement();
        const s = state.sentences[b.sentenceIdx];
        if (audio && s?.clipBegin != null) {
          audio.currentTime = s.clipBegin;
        }
      }, 800);
    }
  }
}

/**
 * Render bookmark dots on the total-progress bar (#reading-progress).
 * Call once on book load and whenever bookmarks change — NOT on every timeupdate frame.
 */
export function renderBookmarkDots() {
  const bar = document.getElementById('reading-progress');
  bar?.querySelectorAll('.progress-bookmark-dot').forEach(d => d.remove());
  if (!bar || !state.totalDuration) return;

  const bmarks = getBookmarks();
  bmarks.forEach((bm, i) => {
    const t = bm.absTime;
    if (t == null || t < 0) return;
    const pct = (t / state.totalDuration) * 100;
    if (pct < 0 || pct > 100) return;
    const dot = document.createElement('div');
    dot.className = 'progress-bookmark-dot';
    dot.style.left = pct + '%';
    dot.title = bm.note || 'Закладка';
    dot.onclick = (e) => {
      e.stopPropagation();
      jumpToBookmark(i);
    };
    bar.appendChild(dot);
  });
}

/**
 * Remove bookmark
 * @param {number} i
 */
export function removeBookmark(i) {
  const bmarks = getBookmarks();
  bmarks.splice(i, 1);
  saveBookmarks(bmarks);
  renderBookmarks();
  renderBookmarkDots();
  updateBookmarkBtn();
}

/**
 * Update bookmark button state
 */
export function updateBookmarkBtn() {
  const btn = document.getElementById('bookmark-btn');
  if (!btn) return;

  const bmarks = getBookmarks();
  const has = bmarks.some(b =>
    b.chapterIdx === state.currentChapterIdx && b.sentenceIdx === state.activeIdx
  );

  btn.textContent = has ? '🔖' : '🏷';
  btn.style.opacity = has ? '1' : '0.5';
}

/**
 * Toggle bookmark at current position
 */
export function toggleBookmark() {
  const bmarks = getBookmarks();
  const idx = bmarks.findIndex(b =>
    b.chapterIdx === state.currentChapterIdx && b.sentenceIdx === state.activeIdx
  );

  if (idx >= 0) {
    bmarks.splice(idx, 1);
    saveBookmarks(bmarks);
    showToast('🔖 Закладку видалено');
  } else {
    const note = '';
    const ac = state.audioChapters[state.currentAudioChIdx];
    const absTime = ac ? ac.startTime + (getAudioElement()?.currentTime || 0) : 0;

    bmarks.push({
      chapterIdx: state.currentChapterIdx,
      sentenceIdx: state.activeIdx,
      absTime,
      note,
      createdAt: Date.now()
    });

    saveBookmarks(bmarks);
    showToast('🔖 Закладку додано');
  }

  updateBookmarkBtn();
  renderBookmarkDots();
}

// No re-exports needed
