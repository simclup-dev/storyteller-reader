// ReadAlong Mock Module
// Demo mode for testing without a real backend

import { state } from './state.js';

export const MOCK_BOOKS = [
  {
    uuid: 'demo-book-1',
    title: 'Подорож до зірок',
    author: 'Олена Коваленко',
    series: 'Космічні пригоди',
    seriesIndex: 1,
    description: 'Хлопчик на ім\'я Андрій мріяв стати космонавтом. Одного разу він знайшов таємничий портал, який переніс його в іншу галактику. Тепер йому потрібно знайти шлях додому.'
  },
  {
    uuid: 'demo-book-2',
    title: 'Таємниця старого замку',
    author: 'Максим Шевченко',
    description: 'Група друзів вирушає в покинутий замок, де за легендою заховано скарб. Але вони не самі шукають його.'
  },
  {
    uuid: 'demo-book-3',
    title: 'The Lost Key',
    author: 'John Smith',
    description: 'An English test book for translation features. A young detective searches for a mysterious key in an old library.'
  }
];

const CHAPTERS = [
  {
    label: 'Розділ 1: Початок подорожі',
    sentences: [
      { text: 'Андрій прокинувся рано-вранці та виглянув у вікно.', clipBegin: 0, clipEnd: 4.0 },
      { text: 'Сонце тільки починало підніматися над горизонтом.', clipBegin: 4.0, clipEnd: 8.0 },
      { text: 'Хлопчик відчував неймовірне хвилювання — сьогодні мала статися важлива подія.', clipBegin: 8.0, clipEnd: 14.0 },
      { text: 'Він швидко одягнувся та спустився на кухню, де вже чекав сніданок.', clipBegin: 14.0, clipEnd: 19.0 },
      { text: 'Запах свіжих булочок наповнював увесь будинок.', clipBegin: 19.0, clipEnd: 23.0 },
      { text: '"Мамо, я сьогодні знайду його!" — вигукнув Андрій, вибігаючи на вулицю.', clipBegin: 23.0, clipEnd: 29.0 },
    ]
  },
  {
    label: 'Розділ 2: Таємничий портал',
    sentences: [
      { text: 'Андрій біг через ліс, обережно перестрибуючи через коріння дерев.', clipBegin: 30, clipEnd: 35.0 },
      { text: 'Він знав, що портал знаходиться саме тут, під старим дубом.', clipBegin: 35.0, clipEnd: 40.0 },
      { text: 'Раптом земля під ногами почала світитися блакитним світлом.', clipBegin: 40.0, clipEnd: 45.0 },
      { text: 'Хлопчик зробив крок вперед і відчув, як повітря навколо нього завібрувало.', clipBegin: 45.0, clipEnd: 51.0 },
      { text: 'За лічені секунди він опинився в зовсім іншому світі.', clipBegin: 51.0, clipEnd: 56.0 },
      { text: 'Небо було фіолетовим, а навколо літали дивні створіння, що світилися.', clipBegin: 56.0, clipEnd: 62.0 },
      { text: '"Неймовірно!" — прошепотів Андрій, роззираючись навколо.', clipBegin: 62.0, clipEnd: 67.0 },
    ]
  },
  {
    label: 'Розділ 3: Перші кроки в новому світі',
    sentences: [
      { text: 'Андрій обережно ступив на м\'яку фіолетову траву.', clipBegin: 68, clipEnd: 73.0 },
      { text: 'Дивні створіння підлетіли ближче, вивчаючи незнайомця.', clipBegin: 73.0, clipEnd: 78.0 },
      { text: 'Вони мали великі очі та прозорі крила, які переливалися всіма кольорами веселки.', clipBegin: 78.0, clipEnd: 85.0 },
      { text: '"Привіт", — сказав Андрій, простягаючи руку.', clipBegin: 85.0, clipEnd: 89.0 },
      { text: 'Одна з істот сіла йому на долоню і заспівала мелодійну пісню.', clipBegin: 89.0, clipEnd: 95.0 },
    ]
  }
];

const ENGLISH_SENTENCES = [
  { text: 'The old library stood at the end of the street, its windows dark and dusty.', clipBegin: 0, clipEnd: 5.0 },
  { text: 'Sarah pushed the heavy wooden door and stepped inside.', clipBegin: 5.0, clipEnd: 9.5 },
  { text: 'The air smelled of old paper and forgotten stories.', clipBegin: 9.5, clipEnd: 14.0 },
  { text: 'She was looking for the key that her grandfather had hidden years ago.', clipBegin: 14.0, clipEnd: 19.0 },
  { text: 'A mysterious note in his diary said: "Look where the sun never shines."', clipBegin: 19.0, clipEnd: 25.0 },
];

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildMinimalEpub(chapters, bookIdx) {
  const book = MOCK_BOOKS[bookIdx];
  const h = '<?xml version="1.0" encoding="UTF-8"?>';

  const containerXml = `${h}
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const chapterFiles = chapters.map((ch, i) => ({
    name: `chapter${i + 1}.xhtml`,
    content: `${h}
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${bookIdx === 2 ? 'en' : 'uk'}">
<head><title>${escXml(ch.label)}</title></head>
<body>
  <h1>${escXml(ch.label)}</h1>
  ${ch.sentences.map((s, j) => `      <p id="s${j}_${i}">${escXml(s.text)}</p>`).join('\n')}
</body>
</html>`
  }));

  const smilFiles = chapters.map((ch, i) => ({
    name: `chapter${i + 1}.smil`,
    content: `${h}
<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">
  <body>
${ch.sentences.map((s, j) => `    <par><text src="chapter${i + 1}.xhtml#s${j}_${i}"/><audio src="chapter_${i + 1}.mp4" clipBegin="${s.clipBegin}" clipEnd="${s.clipEnd}"/></par>`).join('\n')}
  </body>
</smil>`
  }));

  const manifestItems = chapters.flatMap((ch, i) => [
    `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
    `    <item id="chapter${i + 1}-smil" href="chapter${i + 1}.smil" media-type="application/smil+xml"/>`,
    `    <item id="chapter${i + 1}-audio" href="audio/chapter_${i + 1}.mp4" media-type="audio/mp4"/>`
  ]).join('\n');

  const opfXml = `${h}
<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${escXml(book.title)}</dc:title>
    <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">${escXml(book.author)}</dc:creator>
    <dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">${bookIdx === 2 ? 'en' : 'uk'}</dc:language>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine>
${chapters.map((ch, i) => `    <itemref idref="chapter${i + 1}"/>`).join('\n')}
  </spine>
</package>`;

  const lang = bookIdx === 2 ? 'en' : 'uk';
  const navHtml = `${h}
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>Навігація</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${chapters.map((ch, i) => `      <li><a href="chapter${i + 1}.xhtml">${escXml(ch.label)}</a></li>`).join('\n')}
    </ol>
  </nav>
</body>
</html>`;

  return { containerXml, opfXml, chapterFiles, smilFiles, navHtml };
}

function buildChapters(bookIdx) {
  if (bookIdx === 2) {
    return [
      { label: 'Chapter 1: The Old Library', sentences: ENGLISH_SENTENCES.slice(0, 3) },
      { label: 'Chapter 2: The Search Begins', sentences: ENGLISH_SENTENCES.slice(3, 5) }
    ];
  }
  return CHAPTERS;
}

export function getMockManifest(bookIdx) {
  const chapters = buildChapters(bookIdx);
  return {
    readingOrder: chapters.map((ch, i) => {
      const dur = ch.sentences.reduce((max, s) => Math.max(max, s.clipEnd), ch.sentences[0].clipBegin);
      return { href: `audio/chapter_${i + 1}.mp4`, title: ch.label, duration: Math.ceil(dur) };
    })
  };
}

export function createMockEpubZip(bookIdx) {
  const chapters = buildChapters(bookIdx);
  const epub = buildMinimalEpub(chapters, bookIdx);

  const encoder = new TextEncoder();
  const allFiles = [
    { name: 'mimetype', content: 'application/epub+zip' },
    { name: 'META-INF/container.xml', content: epub.containerXml },
    { name: 'book.opf', content: epub.opfXml },
    { name: 'nav.xhtml', content: epub.navHtml },
    ...epub.chapterFiles,
    ...epub.smilFiles
  ];

  const fileEntries = [];
  let totalSize = 0;

  for (const f of allFiles) {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = f.name === 'mimetype'
      ? encoder.encode('application/epub+zip')
      : encoder.encode(f.content);
    const crc = crc32(dataBytes);
    const headerSize = 30 + nameBytes.length;
    const localHeader = new ArrayBuffer(headerSize);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, f.name === 'mimetype' ? 0 : 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(localHeader, 30).set(nameBytes);

    fileEntries.push({
      localHeader,
      data: dataBytes,
      nameBytes,
      crc,
      offset: totalSize
    });
    totalSize += headerSize + dataBytes.length;
  }

  let cdOffset = totalSize;
  const cdEntries = [];

  for (const fe of fileEntries) {
    const entrySize = 46 + fe.nameBytes.length;
    const entry = new ArrayBuffer(entrySize);
    const ev = new DataView(entry);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0, true);
    ev.setUint16(10, 0, true);
    ev.setUint16(12, 0, true);
    ev.setUint16(14, 0, true);
    ev.setUint32(16, fe.crc, true);
    ev.setUint32(20, fe.data.length, true);
    ev.setUint32(24, fe.data.length, true);
    ev.setUint16(28, fe.nameBytes.length, true);
    ev.setUint16(30, 0, true);
    ev.setUint16(32, 0, true);
    ev.setUint16(34, 0, true);
    ev.setUint16(36, 0, true);
    ev.setUint32(38, 0, true);
    ev.setUint32(42, fe.offset, true);
    new Uint8Array(entry, 46).set(fe.nameBytes);

    cdEntries.push(entry);
    totalSize += entrySize;
  }

  const cdSize = cdEntries.reduce((s, e) => s + e.byteLength, 0);
  const eocd = new ArrayBuffer(22);
  const ev2 = new DataView(eocd);
  ev2.setUint32(0, 0x06054b50, true);
  ev2.setUint16(4, 0, true);
  ev2.setUint16(6, 0, true);
  ev2.setUint16(8, allFiles.length, true);
  ev2.setUint16(10, allFiles.length, true);
  ev2.setUint32(12, cdSize, true);
  ev2.setUint32(16, cdOffset, true);
  ev2.setUint16(20, 0, true);

  const combined = new Uint8Array(totalSize + 22);
  let pos = 0;
  for (const fe of fileEntries) {
    combined.set(new Uint8Array(fe.localHeader), pos); pos += fe.localHeader.byteLength;
    combined.set(fe.data, pos); pos += fe.data.length;
  }
  for (const cd of cdEntries) {
    combined.set(new Uint8Array(cd), pos); pos += cd.byteLength;
  }
  combined.set(new Uint8Array(eocd), pos);

  return new Blob([combined], { type: 'application/epub+zip' });
}

export function generateMockWav(durationSec) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function getMockBooks() {
  return MOCK_BOOKS.map(b => ({ ...b }));
}
