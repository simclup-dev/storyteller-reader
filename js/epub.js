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
          _isSystem: isSystem
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
              _isSystem: isSystem
            });
          }
        });
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

    if (!audioEpubFile) {
      const rawSrc = audioEl.getAttribute('src') || '';
      audioEpubFile = rawSrc.split('/').pop().split('?')[0];
    }

    const clipBegin = parseTime(audioEl.getAttribute('clipBegin') || audioEl.getAttribute('clip-begin') || '0');
    const clipEnd = parseTime(audioEl.getAttribute('clipEnd') || audioEl.getAttribute('clip-end') || '0');

    smilMap[fragId] = { clipBegin, clipEnd };
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
 * Match EPUB chapters to audio chapters by duration
 */
export function matchEpubChaptersToAudio() {
  for (const ec of state.epubChapters) {
    const epubDur = ec.duration;
    if (!epubDur) {
      ec.audioChapterIdx = -1;
      continue;
    }
    // Primary: duration match within 2s (original, backward-compatible)
    let idx = state.audioChapters.findIndex(ac => Math.abs(ac.duration - epubDur) < 2.0);

    // Fallback: match by audio filename (for books where duration differs > 2s,
    // or single-file audiobooks where one file covers all chapters).
    // Require epubDur > 10s to skip very short chapters.
    // Normalize both sides with decodeURIComponent to handle URL-encoded filenames
    // in the audio manifest (e.g. "The%20Butcher%27s..." vs "The Butcher's...").
    if (idx < 0 && ec.audioEpubFile && epubDur > 10) {
      const epubFile = decodeURIComponent(ec.audioEpubFile);
      idx = state.audioChapters.findIndex(ac =>
        decodeURIComponent(ac.audioFile) === epubFile
      );
    }

    ec.audioChapterIdx = idx;
    ec.primaryHref = idx >= 0 ? state.audioChapters[idx].href : null;
  }
}
