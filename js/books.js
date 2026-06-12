// ReadAlong Books Module
// Handles book list, filtering, search, and rendering

import { state } from './state.js';
import { getBookProgress, saveBookProgress } from './state.js';
import { showToast, esc, fmtTime } from './utils.js';
import { loadBooks as apiLoadBooks, getBookCoverUrl } from './http.js';
import { show } from './ui.js';
import { STORAGE_KEYS, SPEEDS } from './constants.js';

let _filterTimer = null;
let _filter = 'all';    // all | reading | finished | new

// Deterministic gradient palette for typographic cover fallback
const COVER_PALETTES = [
  ['#1a1040', '#4a2c6e'], ['#0d2137', '#1e5f74'],
  ['#1a0a0a', '#7a2020'], ['#0a1a0a', '#1a5c2a'],
  ['#1a1200', '#6b4700'], ['#0a0a2a', '#1a3a7a'],
  ['#1a0a14', '#6a1a3a'], ['#0d1a0d', '#2a4a1a'],
];
function bookColors(b) {
  const key = (b.uuid || b.id || b.title || '').toString();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const [c1, c2] = COVER_PALETTES[h % COVER_PALETTES.length];
  return { c1, c2 };
}

function renderCover(b, meta, w, h) {
  const { c1, c2 } = bookColors(b);
  const coverUrl = meta?.id ? getBookCoverUrl(meta.id) : null;
  const title = esc(b.title || b.name || '');
  const sw = typeof w === 'number' ? `${w}px` : w;
  const sh = typeof h === 'number' ? `${h}px` : h;
  const radius = `border-radius:calc(var(--radius)*0.7)`;

  if (coverUrl) {
    return `<div class="lib-cover" style="width:${sw};height:${sh}">
      <img src="${coverUrl}" alt="${title}"
        onerror="this.parentElement.style.background='linear-gradient(155deg,${c2},${c1})';this.parentElement.classList.add('lib-cover--fallback');this.parentElement.innerHTML='<div class=lib-cover-title>${title}</div>'">
    </div>`;
  }
  return `<div class="lib-cover lib-cover--fallback" style="width:${sw};height:${sh};background:linear-gradient(155deg,${c2},${c1})">
    <div class="lib-cover-title">${title}</div>
  </div>`;
}
let _sort = 'series';  // series | recent | author | progress

export async function loadBooks() {
  show('books');
  const list = document.getElementById('books-list');
  if (!list) return;
  list.innerHTML = skeletonCards(6);
  try {
    await apiLoadBooks();
    renderBooks();
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Помилка: ${esc(e.message)}</div>`;
    showToast('Не вдалося завантажити книги', 'error');
  }
}

export function setFilter(filter) {
  _filter = filter;
  document.querySelectorAll('#filter-chips .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === filter);
  });
  renderBooks();
}

export function setSort(sort) {
  _sort = sort;
  document.querySelectorAll('.sort-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.sort === sort);
  });
  renderBooks();
}

function getBookMeta(b) {
  const id = b.uuid || b.id;
  const prog = id ? getBookProgress(id) : null;
  const pct = prog && prog.totalDuration > 0
    ? Math.min(100, Math.round((prog.absTime / prog.totalDuration) * 100))
    : (prog ? 1 : 0);
  const lastOpen = parseInt(localStorage.getItem(`lastopen_${id}`)) || 0;
  const isFinished = prog && pct >= 95;
  const isReading = prog && prog.absTime > 5 && !isFinished;
  const isNew = !prog || prog.absTime <= 5;
  const duration = b.totalDuration || (state.audioChapters
    ? state.audioChapters.reduce((s, a) => s + (a.duration || 0), 0)
    : 0);
  return { id, prog, pct, lastOpen, isFinished, isReading, isNew, duration };
}

export function renderBooks() {
  const list = document.getElementById('books-list');
  if (!list) return;

  // Sync toggle button icon
  const toggleBtn = document.getElementById('view-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = state._viewMode === 'shelf' ? '⊞' : '📚';

  const q = (state._searchQuery || '').trim().toLowerCase();

  const bookCountEl = document.getElementById('book-count');
  if (bookCountEl) {
    const total = state.books.length;
    const filtered = q ? state.books.filter(b => matchesSearch(b, q)).length : total;
    bookCountEl.textContent = total
      ? (q ? `${filtered} з ${total} книг` : `${total} книг`)
      : '';
  }

  if (!state.books.length) {
    list.innerHTML = '<div class="empty-state">Бібліотека порожня. Додайте книги на сервері.</div>';
    return;
  }

  // Filter by search query
  let filteredBooks = q
    ? state.books.filter(b => matchesSearch(b, q))
    : [...state.books];

  // Enrich with metadata
  let entries = filteredBooks.map((b, i) => {
    const meta = getBookMeta(b);
    return { b, origIdx: state.books.indexOf(b), meta };
  });

  // Filter by status
  if (_filter === 'reading') entries = entries.filter(e => e.meta.isReading);
  else if (_filter === 'finished') entries = entries.filter(e => e.meta.isFinished);
  else if (_filter === 'new') entries = entries.filter(e => e.meta.isNew);

  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">Нічого не знайдено</div>';
    return;
  }

  // Sort
  entries.sort((a, b) => {
    if (_sort === 'series') {
      const aa = getAuthorName(a.b).toLowerCase();
      const bb = getAuthorName(b.b).toLowerCase();
      if (aa !== bb) return aa.localeCompare(bb);
      const sa = getSeriesName(a.b) || '\uffff';
      const sb = getSeriesName(b.b) || '\uffff';
      if (sa !== sb) return sa.localeCompare(sb);
      return getSeriesIndex(a.b) - getSeriesIndex(b.b);
    } else if (_sort === 'recent') {
      return (b.meta.lastOpen || 0) - (a.meta.lastOpen || 0);
    } else if (_sort === 'progress') {
      if (a.meta.isNew !== b.meta.isNew) return a.meta.isNew ? 1 : -1;
      return b.meta.pct - a.meta.pct;
    } else { // author
      const aa = getAuthorName(a.b).toLowerCase();
      const bb = getAuthorName(b.b).toLowerCase();
      return aa.localeCompare(bb) || (a.b.title || '').localeCompare(b.b.title || '');
    }
  });

  // Shelf mode
  if (state._viewMode === 'shelf') {
    list.innerHTML = renderShelves(entries);
    return;
  }

  // Dusk grid mode
  let html = '';

  // Cinematic hero (most recent in-progress book, only when filter=all and no search)
  if (!q && _filter === 'all') {
    const hero = entries
      .filter(e => e.meta.isReading)
      .sort((a, b) => (b.meta.lastOpen || 0) - (a.meta.lastOpen || 0))[0];
    if (hero) html += renderHero(hero);
  }

  // Series grid
  const label = _filter === 'all' ? 'УСЯ СЕРІЯ' :
                _filter === 'reading' ? 'В ПРОЦЕСІ' :
                _filter === 'finished' ? 'ЗАВЕРШЕНІ' : 'НЕ ПОЧАТО';
  html += `<div class="lib-section-label">${label}</div>`;
  html += `<div class="lib-grid">`;
  for (const entry of entries) {
    html += renderLibCard(entry.b, entry.origIdx, entry.meta);
  }
  html += `</div>`;

  list.innerHTML = html;
}

export function filterBooks() {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    state._searchQuery = document.getElementById('search-input')?.value || '';
    renderBooks();
  }, 150);
}

export function setViewMode(mode) {
  state._viewMode = mode;
  localStorage.setItem(STORAGE_KEYS.VIEW_MODE, mode);
  renderBooks();
}

export function toggleViewMode() {
  const next = state._viewMode === 'shelf' ? 'grid' : 'shelf';
  state._viewMode = next;
  localStorage.setItem(STORAGE_KEYS.VIEW_MODE, next);
  const btn = document.getElementById('view-toggle-btn');
  if (btn) btn.textContent = next === 'shelf' ? '📚' : '⊞';
  renderBooks();
}

function computeRemainingHuman(meta) {
  if (!meta.prog || !meta.prog.totalDuration) return '';
  const speed = SPEEDS[state.speedIdx] || 1.0;
  const remaining = (meta.prog.totalDuration - (meta.prog.absTime || 0)) / speed;
  if (remaining <= 0) return '';
  const mins = Math.round(remaining / 60);
  if (mins < 60) return `ще ~${mins} хв`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `ще ~${h} год ${m} хв` : `ще ~${h} год`;
}

function renderShelves(entries) {
  const readingEntries = entries.filter(e => e.meta.isReading);
  const heroEntry = readingEntries.length === 1 ? readingEntries[0] : null;

  const seriesMap = new Map();
  const standalone = [];
  for (const e of entries) {
    const sName = getSeriesName(e.b);
    if (sName) {
      if (!seriesMap.has(sName)) seriesMap.set(sName, []);
      seriesMap.get(sName).push(e);
    } else {
      standalone.push(e);
    }
  }

  let html = '';
  if (heroEntry) html += renderHero(heroEntry);

  for (const [seriesName, items] of seriesMap) {
    html += renderShelf(seriesName, items);
  }
  if (standalone.length) {
    html += renderShelf('Окремі книги', standalone, true);
  }
  return html;
}

function renderHero(entry) {
  const { b, origIdx, meta } = entry;
  const { c1, c2 } = bookColors(b);
  const remaining = computeRemainingHuman(meta);
  const author = esc(getAuthorName(b));
  const title = esc(b.title || b.name || '');
  return `
    <div class="lib-hero" data-action="open-book" data-idx="${origIdx}">
      <div class="lib-hero-bg" style="background:linear-gradient(110deg,${c1},${c2})"></div>
      <div class="lib-hero-scrim"></div>
      <div class="lib-hero-cover-slot">${renderCover(b, meta, 120, 180)}</div>
      <div class="lib-hero-body">
        <div class="lib-hero-eyebrow">ПРОДОВЖИТИ</div>
        <div class="lib-hero-title">${title}</div>
        <div class="lib-hero-author">${author}</div>
        <div class="lib-hero-actions">
          <span class="lib-hero-btn">▶ Продовжити</span>
          ${remaining ? `<span class="lib-hero-time">${esc(remaining)}</span>` : ''}
        </div>
      </div>
      <div class="lib-hero-track">
        <div class="lib-hero-fill" style="width:${meta.pct}%"></div>
      </div>
    </div>`;
}

function renderLibCard(b, origIdx, meta) {
  const title = esc(b.title || b.name || '');
  const pct = meta.pct || 0;
  return `
    <div class="lib-card" data-action="open-book" data-idx="${origIdx}">
      ${renderCover(b, meta, '100%', 188)}
      <div class="lib-card-title">${title}</div>
      <div class="lib-card-track">
        ${pct > 0 ? `<div class="lib-card-fill" style="width:${pct}%"></div>` : ''}
      </div>
      <div class="lib-card-pct">${pct > 0 ? pct + '%' : 'Не почато'}</div>
    </div>`;
}

function renderShelf(name, entries, allowCollapse = false) {
  const isSeries = name !== 'Окремі книги';
  const MAX = Number.MAX_SAFE_INTEGER;
  const seriesAuthor = isSeries ? getAuthorName(entries[0].b) : '';
  const showAll = !allowCollapse || entries.length <= 20 || _expandedShelves.has(name);
  const visible = showAll ? entries : entries.slice(0, 20);

  const cards = visible.map(({ b, origIdx, meta }) => {
    const coverUrl = getBookCoverUrl(meta.id);
    const isNew = !meta.prog;
    const idx = isSeries ? getSeriesIndex(b) : MAX;
    const numBadge = (isSeries && idx < MAX)
      ? `<span class="shelf-num">${idx}</span>` : '';
    const authorLine = !isSeries
      ? `<div class="shelf-card-author">${esc(getAuthorName(b))}</div>` : '';
    return `
      <div class="shelf-card" data-action="open-book" data-idx="${origIdx}">
        <div class="shelf-cover" style="${coverUrl ? `background-image:url(${esc(coverUrl)})` : ''}">
          ${!coverUrl ? '<span style="font-size:2rem;display:flex;align-items:center;justify-content:center;height:100%">📖</span>' : ''}
          ${numBadge}
          ${isNew ? '<span class="shelf-badge">Нова</span>' : ''}
          ${meta.pct > 0 ? `<div class="shelf-progress"><div style="width:${meta.pct}%"></div></div>` : ''}
        </div>
        <div class="shelf-card-title">${esc(b.title || b.name || '')}</div>
        ${authorLine}
      </div>`;
  }).join('');

  const moreBtn = !showAll
    ? `<button class="shelf-show-more" data-action="shelf-show-more" data-shelf="${esc(name)}">Показати всі ${entries.length}</button>`
    : '';
  const headerAuthor = seriesAuthor
    ? `<div class="shelf-author">${esc(seriesAuthor)}</div>` : '';

  return `
    <section class="shelf" data-shelf-name="${esc(name)}">
      <header class="shelf-header">
        <div class="shelf-header-left">
          <span class="shelf-name">${esc(name)}</span>
          ${headerAuthor}
        </div>
        <span class="shelf-count">${entries.length}</span>
      </header>
      <div class="shelf-row">${cards}</div>
      ${moreBtn}
    </section>`;
}

export function expandShelf(shelfName) {
  // re-render books which will now include all entries for this shelf
  // simplest: just re-render whole view in expanded mode by toggling a set
  _expandedShelves.add(shelfName);
  renderBooks();
}

const _expandedShelves = new Set();

export function toggleBooks(expanded) {
  // kept for backward compat, no longer used
  renderBooks();
}

export function matchesSearch(b, q) {
  const title = (b.title || b.name || '').toLowerCase();
  const author = getAuthorName(b).toLowerCase();
  const series = getSeriesName(b)?.toLowerCase() || '';
  return title.includes(q) || author.includes(q) || series.includes(q);
}

export function getAuthorName(b) {
  return b.author || b.authors?.[0]?.name || 'Невідомий';
}

export function getSeriesName(b) {
  try {
    const s = b.series;
    if (s) {
      if (typeof s === 'string') return s;
      const n = s.name || s.title || s.label || '';
      if (n) return n;
    }
    if (b.seriesName) return b.seriesName;
    const t = b.title || b.name || '';
    let m = t.match(/: (.+?) Book \d+/i);
    if (m) return m[1].trim();
    m = t.match(/^(.+?)\s*[-–—:#]\s*\d+/);
    if (m) return m[1].trim();
  } catch (e) { console.warn(e); }
  return null;
}

export function getSeriesIndex(b) {
  if (b.seriesIndex != null) return b.seriesIndex;
  if (b.seriesNumber != null) return b.seriesNumber;
  const t = b.title || b.name || '';
  let m = t.match(/Book (\d+)/i);
  if (m) return parseInt(m[1]);
  m = t.match(/[-–—]\s*(\d+)/);
  if (m) return parseInt(m[1]);
  m = t.match(/(\d+)/);
  return m ? parseInt(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function renderBookCard(b, origIdx, meta) {
  meta = meta || getBookMeta(b);
  const title = b.title || b.name || 'Без назви';
  const coverUrl = getBookCoverUrl(meta.id);
  let badge = '';
  if (meta.isFinished) badge = '<span class="book-badge badge-done">✓</span>';
  else if (meta.isReading) badge = `<span class="book-badge badge-reading">${meta.pct}%</span>`;
  else badge = '<span class="book-badge badge-new">Нова</span>';

  const durationH = meta.duration > 0 ? `${Math.round(meta.duration / 3600 * 10) / 10} год` : '';
  const seriesIdx = getSeriesIndex(b);
  const seriesNum = seriesIdx < Number.MAX_SAFE_INTEGER ? `Кн. ${seriesIdx}` : '';

  return `
    <div class="book-card-grid" data-action="open-book" data-idx="${origIdx}">
      <div class="book-cover">
        ${coverUrl
          ? `<img src="${coverUrl}" alt="Обкладинка" onerror="this.outerHTML='📖'">`
          : '📖'
        }
        ${badge}
      </div>
      <div class="book-body">
        <div class="book-title" title="${esc(title)}">${esc(title)}</div>
        <div class="book-author">${esc(getAuthorName(b))}${seriesNum ? ` · ${seriesNum}` : ''}</div>
        <div class="book-progress-bar"><div class="book-progress-fill" style="width:${meta.pct}%"></div></div>
        <div class="book-meta">
          <span>${meta.pct}%</span>
          <span>${durationH}</span>
        </div>
      </div>
    </div>
  `;
}

export function skeletonCards(n) {
  let cards = '';
  for (let i = 0; i < n; i++) {
    cards += `<div class="skeleton-card"><div class="skeleton-cover"></div><div class="skeleton-body"><div class="skeleton-line skeleton-title"></div><div class="skeleton-line skeleton-progress"></div></div></div>`;
  }
  return `<div class="lib-section-label"> </div><div class="lib-grid">${cards}</div>`;
}

export function setFolderState(expanded) {
  // kept for backward compat
  renderBooks();
}
