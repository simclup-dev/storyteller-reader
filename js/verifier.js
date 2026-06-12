// ReadAlong Book Verifier
// Detects manifest/audio mismatches that cause progress drift.

import { state } from './state.js';
import { getAudioManifest, getAudioUrl } from './http.js';
import { probeAudioDuration } from './storage.js';

const WARN_DURATION_DIFF = 1.0;
const FAIL_DURATION_DIFF = 5.0;

/**
 * Full verification — loads audio metadata for every chapter. Slow (~200ms × N).
 */
export async function verifyCurrentBook({ onProgress, signal } = {}) {
  if (!state.bookId) throw new Error('No book is currently open');

  const manifest = await getAudioManifest(state.bookId);
  const order = manifest.readingOrder || [];
  const checks = [];

  // Cheap structural checks first
  checks.push(...structuralChecks(order));

  for (let i = 0; i < order.length; i++) {
    if (signal?.aborted) throw new Error('aborted');
    const item = order[i];
    onProgress?.({ done: i, total: order.length, currentTitle: item.title || `Розділ ${i+1}` });

    const claimed = Number(item.duration) || 0;
    let actual = null, err = null;
    try {
      const url = getAudioUrl(state.bookId, item.href);
      const probe = await probeAudioDuration(url);
      actual = probe.duration;
    } catch (e) { err = e.message || String(e); }

    let status, detail;
    if (err) {
      status = 'fail';
      detail = `Не вдалося завантажити аудіо: ${err}`;
    } else if (claimed === 0) {
      status = 'warn';
      detail = `Маніфест заявляє 0 сек; реальна тривалість файлу — ${actual.toFixed(1)} сек`;
    } else {
      const diff = Math.abs(claimed - actual);
      if (diff >= FAIL_DURATION_DIFF) {
        status = 'fail';
        detail = `Заявлено ${claimed.toFixed(1)} сек, реально ${actual.toFixed(1)} сек (різниця ${diff.toFixed(1)} сек)`;
      } else if (diff >= WARN_DURATION_DIFF) {
        status = 'warn';
        detail = `Заявлено ${claimed.toFixed(1)} сек, реально ${actual.toFixed(1)} сек (різниця ${diff.toFixed(1)} сек)`;
      } else {
        status = 'pass';
        detail = `${actual.toFixed(1)} сек — збігається`;
      }
    }

    checks.push({
      kind: err ? 'fetch-fail' : 'duration-mismatch',
      chapterIdx: i,
      title: item.title || `Розділ ${i+1}`,
      status, detail,
      data: { claimed, actual, error: err, href: item.href }
    });
  }

  onProgress?.({ done: order.length, total: order.length, currentTitle: '' });
  return { checks, summary: summarize(checks), manifest };
}

/**
 * Quick check — no audio probes. Safe to call on every book open. < 50ms.
 */
export function quickStructuralCheck() {
  if (!state.audioChapters?.length) return { checks: [], summary: { pass:0, warn:0, fail:0, total:0 } };
  const order = state.audioChapters.map(c => ({ href: c.href, title: c.title, duration: c.duration }));
  const checks = structuralChecks(order);
  return { checks, summary: summarize(checks) };
}

function structuralChecks(order) {
  const checks = [];
  let sumDur = 0;
  let anyNegative = false;

  for (let i = 0; i < order.length; i++) {
    const d = Number(order[i].duration);
    if (!isFinite(d) || isNaN(d)) {
      checks.push({
        kind: 'zero-duration', chapterIdx: i,
        title: order[i].title || `Розділ ${i+1}`,
        status: 'fail',
        detail: `duration не є числом: ${order[i].duration}`,
        data: { claimed: order[i].duration }
      });
      continue;
    }
    if (d < 0) anyNegative = true;
    if (d === 0) {
      checks.push({
        kind: 'zero-duration', chapterIdx: i,
        title: order[i].title || `Розділ ${i+1}`,
        status: 'warn',
        detail: 'duration = 0 у маніфесті',
        data: { claimed: 0 }
      });
    }
    sumDur += d;
  }

  checks.push({
    kind: 'monotonic', chapterIdx: -1,
    title: 'Послідовність глав',
    status: anyNegative ? 'fail' : 'pass',
    detail: anyNegative
      ? "Знайдена від'ємна тривалість — startTime може йти назад"
      : `Всі ${order.length} глав мають невід'ємні тривалості`,
    data: { totalDuration: sumDur }
  });

  if (state.totalDuration && Math.abs(sumDur - state.totalDuration) > 1) {
    checks.push({
      kind: 'totals', chapterIdx: -1,
      title: 'Сума тривалостей',
      status: 'warn',
      detail: `Сума глав ${sumDur.toFixed(1)} ≠ state.totalDuration ${state.totalDuration.toFixed(1)}`,
      data: { sum: sumDur, state: state.totalDuration }
    });
  }
  return checks;
}

function summarize(checks) {
  const s = { pass: 0, warn: 0, fail: 0, total: checks.length };
  for (const c of checks) s[c.status]++;
  return s;
}
