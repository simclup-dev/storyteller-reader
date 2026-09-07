// ReadAlong EPUB Module
// Handles EPUB parsing, SMIL synchronization, and chapter extraction

import { loadScript } from './utils.js';
import { state } from './state.js';
import { EPUB_CACHE_VERSION } from './constants.js';

// Cache for JSZip
let _JSZip = null;

/**
 * Ensure JSZip is loaded
 * @private
 */
async function ensureJSZip() {
  if (!_JSZip) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    _JSZip = window.JSZip;
    if (!_JSZip) throw new Error('JSZip failed to load');
  }
}

function invalidateEpubCacheIfNeeded() {
  const stored = parseInt(localStorage.getItem('epub_cache_version'), 10) || 0;
  if (stored !== EPUB_CACHE_VERSION) {
    try { indexedDB.deleteDatabase('ReadAlongCache'); } catch (_) {}
    localStorage.setItem('epub_cache_version', EPUB_CACHE_VERSION);
    console.log('EPUB cache invalidated — re-parsing');
    return true;
  }
  return false;
}

export { invalidateEpubCacheIfNeeded };

/**
 * Parse EPUB blob and extract chapters
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
export async function parseEpub(blob) {
  await ensureJSZip();
  invalidateEpubCacheIfNeeded();

  try {
    const zip = await _JSZip.loadAsync(blob);
    const parser = new DOMParser();

    // Revoke image blob-URLs created for the previous book before making new ones —
    // otherwise every re-parse leaks the old object URLs until the tab closes.
    if (Array.isArray(state._imgBlobUrls)) {
      state._imgBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    state._imgBlobUrls = [];

    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) throw new Error('No container.xml in EPUB');

    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/)?.[1];
    if (!opfPath) throw new Error('No OPF path found');

    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = await zip.file(opfPath)?.async('text');
    if (!opfXml) throw new Error('OPF file not found');

    const opf = parser.parseFromString(opfXml, 'text/xml');
    const manifest = {};

    opf.querySelectorAll('item').forEach(item => {
      const id = item.getAttribute('id');
      manifest[id] = {
        href: item.getAttribute('href'),
        mediaType: item.getAttribute('media-type'),
        overlay: item.getAttribute('media-overlay')
      };
    });

    const spineItems = Array.from(opf.querySelectorAll('itemref'))
      .map(ref => manifest[ref.getAttribute('idref')])
      .filter(Boolean);

    state.epubChapters = [];
    state.chapters = [];

    for (const item of spineItems) {
      if (!item.href || !item.mediaType?.includes('html')) continue;
      if (!item.overlay || !manifest[item.overlay]) continue;

      const htmlPath = opfDir + item.href;
      const htmlText = await zip.file(htmlPath)?.async('text');
      if (!htmlText) continue;

      const smilPath = opfDir + manifest[item.overlay].href;
      const smilText = await zip.file(smilPath)?.async('text');
      if (!smilText) continue;

      const { smilMap, audioEpubFile } = parseSmil(smilText);
      if (!audioEpubFile) continue;

      const doc = parser.parseFromString(htmlText, 'text/html');

      // Extract images from chapter HTML and replace src with blob URLs
      const seenHashes = new Set();
      const imgs = doc.querySelectorAll('img[src]');
      for (const img of imgs) {
        const src = img.getAttribute('src');
        if (!src) continue;
        try {
          const baseUrl = 'http://dummy/' + htmlPath;
          const resolved = new URL(src, baseUrl).pathname.slice(1);
          const blob = await zip.file(resolved)?.async('blob');
          if (!blob) continue;
          // Content-based dedup: hash first 8KB
          const chunk = await blob.slice(0, 8192).arrayBuffer();
          const hash = Array.from(new Uint8Array(chunk)).reduce((h, b) => h * 31 + b, 0);
          if (seenHashes.has(hash)) {
            console.log('skipping duplicate image by hash:', resolved);
            img.remove();
            continue;
          }
          seenHashes.add(hash);
          const objUrl = URL.createObjectURL(blob);
          state._imgBlobUrls.push(objUrl);
          img.setAttribute('src', objUrl);
        } catch (_) { /* skip broken images */ }
      }

      // Store processed HTML (with resolved image srcs)
      const readingHtml = doc.body.innerHTML;

      const sentences = [];
      // SMIL fragments are often spans inside one visible paragraph. Keep that
      // boundary so a damaged quote cannot colour unrelated narration.
      const containerKeys = new Map();
      let nextContainerKey = 0;
      const getContainerKey = (el) => {
        const container = el.closest('p, li, blockquote, h1, h2, h3, h4') || el.parentElement || el;
        if (!containerKeys.has(container)) containerKeys.set(container, `c${nextContainerKey++}`);
        return containerKeys.get(container);
      };

      // First try: elements with ID matching SMIL
      doc.querySelectorAll('[id]').forEach(el => {
        const id = el.getAttribute('id');
        const smil = smilMap[id];
        if (!smil) return;
        const text = el.textContent.trim();
        if (!text || text.length < 3) return;
        // System text detection: entire span content is wrapped in <b> or <strong>
        const boldEl = el.querySelector('b, strong');
        const isSystem = !!boldEl && boldEl.textContent.trim().length >= text.length - 2;
        sentences.push({
          text,
          clipBegin: smil.clipBegin,
          clipEnd: smil.clipEnd,
          elId: id,
          _isSystem: isSystem,
          _containerKey: getContainerKey(el),
          _file: smil.file
        });
      });

      // Second try: paragraphs, list items, headings
      if (!sentences.length) {
        doc.querySelectorAll('p, li, h1, h2, h3, h4').forEach(el => {
          const text = el.textContent.trim();
          if (!text || text.length < 3) return;
          const id = el.getAttribute('id') || '';
          const smil = id ? smilMap[id] : null;
          if (smil) {
            const boldEl = el.querySelector('b, strong');
            const isSystem = !!boldEl && boldEl.textContent.trim().length >= text.length - 2;
            sentences.push({
              text,
              clipBegin: smil.clipBegin,
              clipEnd: smil.clipEnd,
              elId: id,
              _isSystem: isSystem,
              _containerKey: getContainerKey(el),
              _file: smil.file
            });
          }
        });
      }

      // Alignment artifact guard: the aligner occasionally attributes a sentence
      // at a chapter boundary to the ADJACENT audio file (e.g. the narrator's
      // "Chapter N+1" lead-in bleeding a fraction of a second into the next
      // file). Those stray sentences carry clip times from a DIFFERENT file
      // than the rest of the chapter, which corrupts chapter duration
      // (computed from the last sentence's clipEnd) and breaks the monotonic
      // clipBegin ordering audio.js relies on for highlighting. Trim any such
      // sentences off both ends so duration/highlighting always reflect the
      // audio file this chapter actually plays (audioEpubFile).
      while (sentences.length > 1 && sentences[sentences.length - 1]._file !== audioEpubFile) {
        sentences.pop();
      }
      while (sentences.length > 1 && sentences[0]._file !== audioEpubFile) {
        sentences.shift();
      }

      // Media overlays are external source data. Keep the original DOM order
      // for rendering, but record invalid temporal ordering so runtime can use
      // its corruption-safe lookup instead of relying on a binary search.
      const timingIssues = [];
      for (let i = 0; i < sentences.length; i++) {
        const current = sentences[i];
        if (!Number.isFinite(current.clipBegin) || !Number.isFinite(current.clipEnd) || current.clipEnd <= current.clipBegin) {
          timingIssues.push({ index: i, kind: 'invalid-range', elId: current.elId });
        } else if (i > 0 && current.clipBegin < sentences[i - 1].clipBegin - 0.001) {
          timingIssues.push({ index: i, kind: 'non-monotonic', elId: current.elId, previousElId: sentences[i - 1].elId });
        }
      }
      if (timingIssues.length) {
        console.warn('[SMIL integrity]', item.href, timingIssues);
      }

      // TEMP DIAGNOSTIC — remove after Book 5 investigation
      if (!sentences.length) {
        if (Object.keys(smilMap).length === 0) {
          console.warn('[DIAG] smilMap EMPTY for', item.href, '— SMIL has no valid <par> with #fragment src');
        } else {
          const smilKeys = Object.keys(smilMap).slice(0, 3);
          const htmlIds = Array.from(doc.querySelectorAll('[id]')).slice(0, 3).map(e => e.id);
          console.warn('[DIAG] smilMap keys:', smilKeys, '| HTML [id] sample:', htmlIds, '| file:', item.href);
        }
      }

      if (sentences.length < 3) continue; // skip cover/title pages (1–2 sentences)

      const heading = doc.querySelector('h1, h2, h3');
      const label = heading?.textContent.trim() || sentences[0].text.slice(0, 50);

      const chIdx = state.epubChapters.length;
      state.epubChapters.push({
        htmlFile: item.href,
        audioEpubFile,
        sentences,
        duration: sentences[sentences.length - 1].clipEnd,
        timingIssues,
        readingHtml
      });
      state.chapters.push({
        label,
        epubChapterIdx: chIdx
      });
    }

    if (!state.epubChapters.length) {
      throw new Error('Не знайдено озвучених розділів в epub');
    }
  } catch (e) {
    console.error('EPUB parsing error:', e);
    throw e;
  }
}

/**
 * Parse SMIL file and create map of element IDs to timestamps
 * @param {string} smilText
 * @returns {{smilMap: Object, audioEpubFile: string}}
 */
export function parseSmil(smilText) {
  const doc = new DOMParser().parseFromString(smilText, 'text/xml');
  const smilMap = {};
  let audioEpubFile = null;

  doc.querySelectorAll('par').forEach(par => {
    const textEl = par.querySelector('text');
    const audioEl = par.querySelector('audio');
    if (!textEl || !audioEl) return;

    const src = textEl.getAttribute('src') || '';
    const fragId = src.includes('#') ? src.split('#')[1] : '';
    if (!fragId) return;

    const rawSrc = audioEl.getAttribute('src') || '';
    const file = rawSrc.split('/').pop().split('?')[0];
    if (!audioEpubFile) audioEpubFile = file;

    const clipBegin = parseTime(audioEl.getAttribute('clipBegin') || audioEl.getAttribute('clip-begin') || '0');
    const clipEnd = parseTime(audioEl.getAttribute('clipEnd') || audioEl.getAttribute('clip-end') || '0');

    smilMap[fragId] = { clipBegin, clipEnd, file };
  });

  return { smilMap, audioEpubFile };
}

/**
 * Parse time string to seconds
 * @param {string} t
 * @returns {number}
 */
export function parseTime(t) {
  if (!t) return 0;
  t = String(t).replace(/s$/, '');

  if (t.includes(':')) {
    const p = t.split(':').map(Number);
    if (p.some(isNaN)) return 0;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    return p[0] * 60 + (p[1] || 0);
  }

  return parseFloat(t) || 0;
}

/**
 * Match EPUB chapters to audio chapters from authoritative EPUB metadata.
 * Never choose a chapter solely because its duration happens to be similar:
 * that can play a real, but completely different, chapter.
 */
export function matchEpubChaptersToAudio() {
  // Build filename → manifest index map. ac.href can be "00001-00036.mp4" or
  // "transcoded audio/00001-00036.mp4" — normalise to just the bare filename
  // so it can be compared directly against SMIL's audioEpubFile.
  const filenameToIdx = new Map();
  const titleNumberToIdx = new Map();
  state.audioChapters.forEach((ac, i) => {
    const name = decodeURIComponent(ac.href).split('/').pop().split('?')[0];
    if (name) filenameToIdx.set(name, i);
    const number = audioTrackNumber(ac.title);
    if (number == null) return;
    // A numeric title is a valid fallback only when it identifies exactly one
    // manifest track.  Mark duplicates unusable instead of guessing.
    titleNumberToIdx.set(number, titleNumberToIdx.has(number) ? -1 : i);
  });

  for (const ec of state.epubChapters) {
    let idx = -1;

    // Primary: match by filename from SMIL overlay (EPUB is the ground truth).
    // The SMIL says exactly which audio file each text chapter maps to — far
    // more reliable than duration matching. Bug that was here before: code used
    // ac.audioFile (undefined) instead of ac.href, so this always missed.
    if (ec.audioEpubFile) {
      const name = decodeURIComponent(ec.audioEpubFile).split('/').pop().split('?')[0];
      if (name && filenameToIdx.has(name)) idx = filenameToIdx.get(name);
      // Some transcoders number a single source as 00001-00008.mp4 while the
      // audiobook manifest names the same track 00007-00001.mp4 (title 008).
      // The SMIL track number and unique manifest title are still an exact,
      // semantic match; duration is not.
      if (idx < 0) {
        const number = audioTrackNumber(name);
        const byTitle = number == null ? -1 : titleNumberToIdx.get(number);
        if (Number.isInteger(byTitle) && byTitle >= 0) idx = byTitle;
      }
    }

    ec.audioChapterIdx = idx;
    // primaryHref is reserved for an explicit, verified repair.  A normal
    // mapping must always play the manifest href selected above.
    ec.primaryHref = null;
  }
  // TEMP DIAG — save mapping to localStorage for inspection
  try {
    const map = state.epubChapters.map((ec, i) => `${i}:${ec.audioChapterIdx}(${ec.duration?.toFixed(0)})`).join(' ');
    localStorage.setItem('_diag_ch_map', map);
    console.log('[matchEpubChaptersToAudio]', map);
  } catch(_) {}
}

function audioTrackNumber(value) {
  const stem = String(value || '').replace(/\.[^.]+$/, '');
  const match = stem.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}
