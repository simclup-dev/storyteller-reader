// Verifier UI — renders verifyCurrentBook results into #verifier-body
import { verifyCurrentBook } from './verifier.js';

let _abortCtrl = null;

export async function runVerifier() {
  const body = document.getElementById('verifier-body');
  if (!body) return;

  _abortCtrl?.abort();
  _abortCtrl = new AbortController();

  body.innerHTML = renderProgress({ done: 0, total: 0, currentTitle: 'підготовка...' });

  try {
    const result = await verifyCurrentBook({
      signal: _abortCtrl.signal,
      onProgress: (p) => {
        const cur = body.querySelector('.vfy-progress');
        if (cur) cur.outerHTML = renderProgress(p);
      }
    });
    body.innerHTML = renderResults(result);
  } catch (e) {
    body.innerHTML = `<div class="vfy-error">Перевірку перервано: ${escapeHtml(e.message)}</div>`;
  }
}

function renderProgress({ done, total, currentTitle }) {
  const pct = total ? Math.round(done / total * 100) : 0;
  return `
    <div class="vfy-progress">
      <div class="vfy-bar"><div class="vfy-bar-fill" style="width:${pct}%"></div></div>
      <div class="vfy-progress-text">${done}/${total || '?'} — ${escapeHtml(currentTitle || '')}</div>
    </div>`;
}

function renderResults({ checks, summary }) {
  const overall = summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass';
  const verdict = {
    pass: '✓ Маніфест виглядає чистим',
    warn: '⚠ Є підозрілі місця',
    fail: '✕ Знайдено критичні розсинхрони'
  }[overall];

  const rows = checks.map(c => `
    <li class="vfy-row vfy-${c.status}">
      <div class="vfy-row-head">
        <span class="vfy-status">${c.status.toUpperCase()}</span>
        <span class="vfy-title">${escapeHtml(c.title)}</span>
      </div>
      <div class="vfy-detail">${escapeHtml(c.detail)}</div>
    </li>`).join('');

  return `
    <div class="vfy-summary vfy-${overall}">
      <div class="vfy-verdict">${verdict}</div>
      <div class="vfy-counts">${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail</div>
    </div>
    <ul class="vfy-list">${rows}</ul>
    <div class="vfy-actions"><button data-action="rerun-verifier">Перевірити знову</button></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
