// ReadAlong Translate Module
// Handles sentence translation, vocabulary, and word popup

import { state, getAudioElement } from './state.js';
import { showToast, esc, debounce } from './utils.js';
import { fetchWithRetry } from './http.js';
import { openPanel, closeAllPanels } from './ui.js';
import { setActive } from './audio.js';

let _popupWord = '';

/**
 * Open translate panel for a specific sentence
 * @param {number} idxOverride - Sentence index (optional)
 */
export function openTranslate(idxOverride) {
  const audio = getAudioElement();
  if (audio) audio.pause();

  let idx = idxOverride !== undefined
    ? idxOverride
    : (state.activeIdx >= 0 ? state.activeIdx : Math.floor(state.sentences.length / 2));

  idx = Math.max(0, Math.min(state.sentences.length - 1, idx));

  const from = Math.max(0, idx - 2);
  const to = Math.min(state.sentences.length - 1, idx);

  const ctx = document.getElementById('translate-context');
  if (!ctx) return;

  ctx.innerHTML = `
    <div class="panel-label" style="margin: 0.5rem 0;">Оберіть речення</div>
    ${state.sentences.slice(from, to + 1).map((s, i) => {
      const ri = from + i;
      return `
        <div class="translate-sentence-item ${ri === idx ? 'selected' : ''}"
             id="tsi-${ri}"
             onclick="selectTransSentence(${ri})">
          ${esc(s.text)}
          <button class="vocab-add-btn"
                  style="float:right; margin-left:0.5rem;"
                  onclick="event.stopPropagation(); addVocabFromSentence(${ri})">＋</button>
        </div>
      `;
    }).join('')}
  `;

  state.selectedTranslateIdx = idx;
  const resultDiv = document.getElementById('translate-result');
  if (resultDiv) resultDiv.innerHTML = '';
  const resumeBtn = document.getElementById('resume-btn');
  if (resumeBtn) resumeBtn.classList.add('hidden');

  openPanel('translate-panel');

  if (state.apiKey) {
    translateSentence(idx);
  } else {
    showToast('⚠️ Встановіть API ключ у налаштуваннях');
  }
}

/**
 * Select sentence for translation
 * @param {number} idx
 */
export function selectTransSentence(idx) {
  document.querySelectorAll('.translate-sentence-item').forEach(el => {
    el.classList.remove('selected');
  });

  const el = document.getElementById(`tsi-${idx}`);
  if (el) el.classList.add('selected');

  state.selectedTranslateIdx = idx;

  if (state.apiKey) {
    translateSentence(idx);
  }
}

/**
 * Translate sentence using API
 * @param {number} idx
 */
export async function translateSentence(idx) {
  const s = state.sentences[idx];
  if (!s) return;

  const ctxBefore = state.sentences.slice(Math.max(0, idx - 2), idx)
    .map(x => x.text).join(' ');

  const resultDiv = document.getElementById('translate-result');
  if (resultDiv) {
    resultDiv.innerHTML = `
      <div class="panel-loading">
        <div class="dot-pulse"><span></span><span></span><span></span></div>
        <span>Перекладаю...</span>
      </div>
    `;
  }

  const resumeBtn = document.getElementById('resume-btn');
  if (resumeBtn) resumeBtn.classList.add('hidden');

  const systemPrompt = `Ти — професійний літературний перекладач з англійської на українську. Перекладай чистою літературною українською мовою, уникаючи суржику, русизмів, кальок з російської та канцеляризмів. Використовуй природні українські відповідники, враховуй контекст, ідіоми та культурні особливості. Пояснення надавай виключно українською мовою.`;

  const userPrompt = `Sentence: "${s.text}"${ctxBefore ? `\nContext: "${ctxBefore}"` : ''}\n\nReply ONLY in Ukrainian, exactly:\nПЕРЕКЛАД: [natural Ukrainian translation]\nПОЯСНЕННЯ: [1-2 sentences on difficult words, idioms, or cultural references. If straightforward, write "Все зрозуміло."]`;

  try {
    let reply = '';
    if (state.apiProvider === 'deepseek') {
      reply = await callDeepSeek(systemPrompt, userPrompt);
    } else {
      reply = await callClaude(systemPrompt, userPrompt);
    }

    const trans = reply.match(/ПЕРЕКЛАД:\s*(.+?)(?=ПОЯСНЕННЯ:|$)/s)?.[1]?.trim() || reply;
    const expl = reply.match(/ПОЯСНЕННЯ:\s*(.+)/s)?.[1]?.trim() || '';

    if (resultDiv) {
      resultDiv.innerHTML = `
        <div class="panel-label" style="margin-top:0.75rem">Переклад</div>
        <div class="panel-translation">${esc(trans)}</div>
        ${expl && expl !== 'Все зрозуміло.' ? `
          <div class="panel-label" style="margin-top:0.75rem">Пояснення</div>
          <div class="panel-explanation">${esc(expl)}</div>
        ` : ''}
      `;
    }

    // Adjust font size if needed
    const translationEl = resultDiv?.querySelector('.panel-translation');
    if (translationEl) {
      let fontSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
      const maxHeight = 200;
      while (translationEl.scrollHeight > maxHeight && fontSize > 12) {
        fontSize--;
        translationEl.style.fontSize = fontSize + 'px';
      }
    }

    if (resumeBtn) resumeBtn.classList.remove('hidden');

    state.history.unshift({
      sentence: s.text,
      translation: trans,
      explanation: expl,
      time: new Date().toLocaleTimeString()
    });

    if (state.history.length > 20) state.history.pop();

    renderHistory();
  } catch (e) {
    if (resultDiv) {
      resultDiv.innerHTML = `<p style="color:var(--danger);font-size:0.88rem;">Помилка: ${esc(e.message)}</p>`;
    }
    if (resumeBtn) resumeBtn.classList.remove('hidden');
    showToast('Помилка перекладу', 'error');
  }
}

/**
 * Call DeepSeek API
 * @private
 */
async function callDeepSeek(systemPrompt, userPrompt) {
  const res = await fetchWithRetry('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 300,
      temperature: 0.3
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Call Claude API
 * @private
 */
async function callClaude(systemPrompt, userPrompt) {
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

/**
 * Render translation history
 */
export function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!state.history.length) {
    list.innerHTML = '<p style="color:var(--text-muted);">Ще немає перекладів</p>';
    return;
  }

  list.innerHTML = state.history.map(h => `
    <div class="history-item"
         data-sentence="${encodeURIComponent(h.sentence)}"
         data-translation="${encodeURIComponent(h.translation)}"
         data-explanation="${encodeURIComponent(h.explanation || '')}">
      <strong>${esc(h.sentence.slice(0, 60))}…</strong><br>
      <span style="font-size:0.75rem;">${h.time}</span>
    </div>
  `).join('');
}

/**
 * Show history item detail
 * @param {string} sentence
 * @param {string} translation
 * @param {string} explanation
 */
export function showHistoryDetail(sentence, translation, explanation) {
  const ctx = document.getElementById('translate-context');
  const result = document.getElementById('translate-result');

  if (ctx) {
    ctx.innerHTML = `
      <div class="panel-label">Речення</div>
      <p style="font-style:italic;">${esc(sentence)}</p>
    `;
  }

  if (result) {
    result.innerHTML = `
      <div class="panel-label">Переклад</div>
      <div class="panel-translation">${esc(translation)}</div>
      ${explanation ? `
        <div class="panel-label">Пояснення</div>
        <div class="panel-explanation">${esc(explanation)}</div>
      ` : ''}
    `;
  }
}

/**
 * Resume playback from selected sentence
 */
export function resumeFromSelected() {
  const idx = state.selectedTranslateIdx;
  closeAllPanels();

  if (idx >= 0) {
    const s = state.sentences[idx];
    if (s?.clipBegin != null) {
      const audio = getAudioElement();
      if (audio) audio.currentTime = s.clipBegin;
    }
    setActive(idx);
    const audio = getAudioElement();
    if (audio) audio.play().catch(e => {
      if (e.name === 'NotAllowedError') showToast('⚠️ Натисніть Play, щоб почати');
    });
  }
}

/**
 * Add word from sentence to vocabulary
 * @param {number} idx
 */
export function addVocabFromSentence(idx) {
  const sentence = state.sentences[idx]?.text;
  if (sentence) {
    const firstWord = sentence.split(' ')[0];
    saveWord(firstWord);
    showToast('Перше слово речення додано в словничок');
    renderVocab();
  }
}

/**
 * Add custom word to vocabulary
 */
export function addVocabWord() {
  const input = document.getElementById('new-vocab-word');
  const word = input?.value.trim();
  if (word) {
    saveWord(word);
    if (input) input.value = '';
    renderVocab();
  }
}

/**
 * Save word to vocabulary
 * @param {string} word
 */
export function saveWord(word) {
  if (!word) return;

  const exists = state.vocabulary.find(w => w.word === word);
  if (!exists) {
    state.vocabulary.push({
      word,
      sentence: state.sentences[state.activeIdx]?.text.slice(0, 100) || '',
      status: 'new'
    });
    localStorage.setItem('st_vocab', JSON.stringify(state.vocabulary));
    showToast('Слово збережено: ' + word);
  } else {
    showToast('Це слово вже є в словничку');
  }
}

/**
 * Toggle word status (new -> learning -> known -> new)
 * @param {string} word
 */
export function toggleWordStatus(word) {
  const entry = state.vocabulary.find(w => w.word === word);
  if (!entry) return;

  const next = { 'new': 'learning', 'learning': 'known', 'known': 'new' };
  entry.status = next[entry.status] || 'new';

  localStorage.setItem('st_vocab', JSON.stringify(state.vocabulary));
  renderVocab();
}

/**
 * Render vocabulary list
 */
export function renderVocab() {
  const list = document.getElementById('vocab-list');
  if (!list) return;

  if (!state.vocabulary.length) {
    list.innerHTML = '<p style="color:var(--text-muted);">Словничок порожній</p>';
    return;
  }

  list.innerHTML = state.vocabulary.map(w => {
    const dot = w.status === 'new' ? '●' : (w.status === 'learning' ? '◔' : '◕');
    const color = w.status === 'new' ? 'var(--text-dim)' :
                 (w.status === 'learning' ? 'var(--accent)' : '#50b894');

    return `
      <span class="vocab-word"
            style="border-color:${color};"
            data-word="${esc(w.word)}"
            onclick="toggleWordStatus(this.dataset.word)"
            title="${esc(w.word)}: ${esc(w.sentence?.slice(0,50) || '')}…">
        ${dot} ${esc(w.word)}
      </span>
    `;
  }).join('') + `
    <div style="margin-top:0.5rem;display:flex;gap:0.4rem;">
      <button class="ctrl-btn" onclick="exportVocab('json')" style="flex:1;font-size:0.7rem;padding:0.3rem 0.5rem;">📄 JSON</button>
      <button class="ctrl-btn" onclick="exportVocab('csv')" style="flex:1;font-size:0.7rem;padding:0.3rem 0.5rem;">📊 CSV</button>
    </div>
  `;
}

/**
 * Export vocabulary to file
 * @param {string} format - 'json' or 'csv'
 */
export function exportVocab(format) {
  if (!state.vocabulary.length) {
    showToast('Словничок порожній');
    return;
  }

  let data, mime, ext;
  if (format === 'json') {
    data = JSON.stringify(state.vocabulary, null, 2);
    mime = 'application/json';
    ext = 'json';
  } else {
    data = '\uFEFFСлово,Переклад,Статус,Контекст\n' +
      state.vocabulary.map(w =>
        `"${w.word}","","${w.status}","${(w.sentence || '').replace(/"/g, '""')}"`
      ).join('\n');
    mime = 'text/csv;charset=utf-8';
    ext = 'csv';
  }

  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabulary.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Словничок експортовано (${format})`);
}

// No re-exports needed
