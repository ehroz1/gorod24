/*
 * Интерфейс конструктора «Город 24».
 * Фото и видео: в слот фото любого макета можно поставить и видео —
 * оно рисуется на canvas кадр за кадром тем же drawCover, а при экспорте
 * слайд записывается в MP4/WebM (раздел «видео» ниже).
 *
 * Два экрана в одной странице: стартовый (рубрики + черновики) и редактор
 * (превью, лента слайдов, форма слайда, экспорт). Вся вёрстка слайдов —
 * в render.js (LAYOUTS), здесь только состояние, формы и жесты.
 *
 * Данные проекта: { id, name, rubric, slides: [slide] }, где
 *   slide = { id, layout, fields: {title, body, …}, opts: {arrow, shade},
 *             size: {title, body}, photo: {id, zoom, x, y, start?, end?, adj?} | null }
 * Черновики (без фото) — в localStorage (STORE_DRAFTS), сами фото — в
 * IndexedDB под ключом «<id проекта>/<id фото>», поэтому после перезагрузки
 * вкладки (на iPhone это бывает при каждом переключении в «Фото») всё на
 * месте. В памяти держим только уменьшенную копию для превью; для экспорта
 * фото каждый раз заново раскодируется из Blob — так не упираемся в лимит
 * памяти canvas на iOS.
 */

const STORE_DRAFTS = 'g24.drafts.v1';
const STORE_THEME = 'g24.theme.v1';
const STORE_PREFS = 'g24.prefs.v1';
const STORE_INSTALL_DISMISSED = 'g24.installDismissed.v1';
const STORE_HINT_TAP = 'g24.hintTapText.v1';   // подсказку «нажмите на текст на превью» уже показали
const MAX_DRAFTS = 60;
const PHOTO_MAX = 3200;       // длинная сторона хранимого фото (1440×1800 + запас на зум)
const PREVIEW_MAX = 1400;     // для превью и миниатюр
const ZOOM_MAX = 4;
const FIT_MIN = 0.6;          // «Уместить» не уменьшает кегль ниже 60% макета
const UPSCALE_WARN = 1.3;     // фото растягивается больше чем на 30% — будет мыльным
// запасные шрифты шире настоящих — сжимаем, чтобы строки ломались как в макете
const FALLBACK_STRETCH = { title: 0.78, display: 0.82 };
const UNDO_LIMIT = 100;
const UNDO_COALESCE_MS = 800;

/*
 * Рубрики = наборы макетов. slides — с чего начинается новый проект,
 * card — какой слайд добавляет «+», layouts — макеты рубрики (показываются
 * первыми при выборе макета).
 */
const RUBRICS = [
  { id: 'zav', name: 'Заведения', desc: 'Подборка заведений: обложка и карточки с адресом',
    slides: ['zav-cover', 'new-card', 'new-card'], card: 'new-card', layouts: ['zav-cover', 'new-card'] },
  { id: 'int', name: 'Интервью', desc: 'Обложка и карточки «вопрос — ответ»',
    slides: ['int-cover', 'int-card', 'int-card'], card: 'int-card', layouts: ['int-cover', 'int-card'] },
  { id: 'fav', name: 'Любимые места', desc: 'Обложка и карточки со стопкой фото',
    slides: ['fav-cover', 'fav-card', 'fav-card'], card: 'fav-card', layouts: ['fav-cover', 'fav-card'] },
  { id: 'new', name: 'Новые места', desc: 'Обложка и карточки заведений',
    slides: ['new-cover', 'new-card', 'new-card'], card: 'new-card', layouts: ['new-cover', 'new-card'] },
  { id: 'ev', name: 'Мероприятия', desc: 'Афиша недели: обложка и события',
    slides: ['ev-cover', 'ev-card', 'ev-card'], card: 'ev-card', layouts: ['ev-cover', 'ev-card'] },
  { id: 'kino', name: 'Киноафиша', desc: 'Премьеры: обложка и карточки фильмов',
    slides: ['kino-cover', 'kino-card', 'kino-card'], card: 'kino-card', layouts: ['kino-cover', 'kino-card'] },
  { id: 'com', name: 'Коммерция', desc: 'Рекламный пост: фото сверху или снизу',
    slides: ['com-cover', 'com-top', 'com-bottom'], card: 'com-top', layouts: ['com-cover', 'com-top', 'com-bottom'] },
  { id: 'post', name: 'Пост', desc: 'Одна картинка с крупным заголовком',
    slides: ['post'], card: 'post', layouts: ['post'] },
  { id: 'reels', name: 'Рилс', desc: 'Обложка для рилс, 1080×1920',
    slides: ['reels'], card: 'reels', layouts: ['reels'] },
];
const RUBRIC_BY_ID = Object.fromEntries(RUBRICS.map(r => [r.id, r]));

/* Поля формы. group: какой ползунок кегля их масштабирует. */
const FIELD_INFO = {
  title: { label: 'Заголовок', multiline: true, group: 'title', rich: 'color', hint: 'Enter — перенос строки' },
  subtitle: { label: 'Подзаголовок', multiline: true, group: 'body', rich: true },
  body: { label: 'Текст', multiline: true, big: true, group: 'body', rich: true, hint: 'Пустая строка — новый абзац' },
  address: { label: 'Адрес', group: 'body', hint: '📍 добавится сам', optional: true },
  number: { label: 'Число', group: 'title', inputmode: 'numeric' },
  label: { label: 'Подпись к числу', multiline: true, group: 'title', rich: 'color' },
  dates: { label: 'Даты', group: 'body' },
  date: { label: 'Дата и время', group: 'body', hint: '🗓️ добавится сам', optional: true },
  place: { label: 'Место', multiline: true, group: 'body', hint: '📍 добавится сам', optional: true },
  price: { label: 'Цена', group: 'body', hint: '💵 добавится сам', optional: true },
  badge: { label: 'Плашка', group: 'body', hint: 'например «Премьера: 17 сентября»', optional: true },
};
const FIELD_LABELS = {
  'int-card': { title: 'Вопрос или заголовок', body: 'Ответ' },
  'new-card': { title: 'Название заведения', body: 'Описание (белая плашка)' },
  'ev-card': { title: 'Название события', body: 'Описание' },
  'fav-card': { body: 'Текст под фото' },
  'kino-card': { title: 'Название фильма', body: 'Описание' },
};

const el = {};
['home', 'editor', 'draftsSection', 'draftsRow', 'rubricGrid', 'fontNoteHome', 'brandLogo',
 'docName', 'docRubric', 'slidesList', 'stage', 'stageInner', 'stageCanvas', 'stageOverlay',
 'warnings', 'slideCounter', 'panel', 'panelBody', 'btnPrev', 'btnNext', 'btnUndo', 'btnRedo',
 'sheet', 'sheetTitle', 'sheetBody', 'status', 'filePicker', 'projectPicker', 'brandPicker', 'dropHint',
 'textMarks']
  .forEach(id => { el[id] = document.getElementById(id); });

const state = {
  screen: 'home',
  project: null,
  current: 0,
  tab: 'slide',
  overflow: [],          // по индексу слайда — текст не помещается
  lastRender: null,      // результат отрисовки текущего слайда на превью
  quick: null,           // телефон: правим это поле с превью (быстрая правка), иначе null
  glyphs: {},            // поле → буквы, которых нет в его шрифте (glyphIssues)
  contrast: [],          // тексты, которые плохо видно на фото (contrastIssues)
  contrastFor: null,     // id слайда, для которого посчитан contrast
  exportFormat: 'png',
  exportWidth: 1440,
  exportStory: false,    // окно «Сохранить»: посты сторис 9:16 (не запоминается)
  undo: [],
  redo: [],
  idbOk: true,
  userFonts: { title: false, display: false },
  userLogo: false,
  fontsVersion: 0,
  panHintAt: 0,          // когда показали подсказку «двигайте фото»
  adjOff: false,         // держат «оригинал» во вкладке «Фото» — превью без коррекции
  adjDrag: false,        // тянут ползунок коррекции — превью по уменьшенной копии
};

const media = new Map();   // id фото → { blob, prev (canvas), w, h }
const loadingMedia = new Map();

/* --------------------------------------------------------------- мелочи */

let statusTimer = null;
function say(text, ms = 3200) {
  el.status.textContent = text;
  el.status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.status.classList.remove('show'), ms);
}

function iconSvg(name) {
  return (typeof ICONS !== 'undefined' && ICONS[name]) || '';
}

function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => {
    const svg = iconSvg(node.dataset.icon);
    if (svg && !node.dataset.painted) {
      node.insertAdjacentHTML('afterbegin', svg);
      node.dataset.painted = '1';
    }
  });
}

/* Короткий конструктор DOM-узлов. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'icon') node.innerHTML = iconSvg(value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function btn(cls, icon, label, onclick, title) {
  const b = h('button', { type: 'button', class: cls, title, onclick });
  if (icon) b.append(iconSpan(icon));
  if (label) b.append(document.createTextNode(label));
  return b;
}

function iconSpan(name) {
  return h('span', { 'data-icon': name, 'data-painted': '1', icon: name, 'aria-hidden': 'true' });
}

function iconBtn(icon, title, onclick, extra = '') {
  return h('button', { type: 'button', class: 'icon-btn ' + extra, title, 'aria-label': title, icon, onclick });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function formatAgo(ts) {
  const diff = Math.max(0, Date.now() - ts) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) { const m = Math.round(diff / 60); return m + ' ' + pluralRu(m, 'минуту', 'минуты', 'минут') + ' назад'; }
  if (diff < 86400) { const hr = Math.round(diff / 3600); return hr + ' ' + pluralRu(hr, 'час', 'часа', 'часов') + ' назад'; }
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// Имена файлов — латиницей: Chromium молча переименовывает скачивание
// с кириллицей в имени в «download».
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i', ӣ: 'i', ӯ: 'u', ҳ: 'h', ҷ: 'j', ў: 'u' };
function fileSlug(text, fallback) {
  const slug = [...String(text || '').toLowerCase()].map(ch => (ch in TRANSLIT ? TRANSLIT[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return slug || fallback;
}

function isTouch() {
  return Boolean(window.matchMedia && window.matchMedia('(hover: none)').matches);
}
function isWide() {
  return window.matchMedia('(min-width: 900px)').matches;
}

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v === null ? fallback : v;
  } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/* ----------------------------------------------------------------- тема */

function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function isDarkActive() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : systemPrefersDark();
}
function syncThemeButton() {
  const dark = isDarkActive();
  document.querySelectorAll('.theme-btn').forEach(button => {
    button.title = dark ? 'Светлая тема' : 'Тёмная тема';
    button.innerHTML = iconSvg(dark ? 'sun' : 'moon');
  });
}
function toggleTheme() {
  const next = isDarkActive() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(STORE_THEME, next); } catch { /* не запомнится — не страшно */ }
  syncThemeButton();
}

/* ------------------------------------------------ установка на телефон */
/*
 * На Android перехватываем beforeinstallprompt и показываем свою кнопку
 * «Установить», на iOS программной установки нет — только подсказка про
 * «Поделиться → На экран «Домой»». Закрытый баннер больше не показывается.
 */
let deferredInstallPrompt = null;

function isStandaloneDisplay() {
  return Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone);
}
function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function hideInstallBanner() { document.getElementById('installBanner').hidden = true; }
function showInstallBanner(mode) {
  const text = document.getElementById('installBannerText');
  const action = document.getElementById('installBannerAction');
  if (mode === 'ios') {
    text.textContent = 'Поставьте на телефон: «Поделиться» внизу Safari → «На экран «Домой»».';
    action.hidden = true;
  } else {
    text.textContent = 'Установите конструктор на телефон — иконка на экране, работает без интернета.';
    action.hidden = false;
  }
  document.getElementById('installBanner').hidden = false;
}
function wireInstallBanner() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(STORE_INSTALL_DISMISSED) === '1'; } catch { /* не критично */ }
  if (dismissed || isStandaloneDisplay()) return;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (state.screen === 'home') showInstallBanner('android');
  });
  if (isIosDevice()) setTimeout(() => { if (state.screen === 'home') showInstallBanner('ios'); }, 1500);
  document.getElementById('installBannerAction').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    hideInstallBanner();
  });
  document.getElementById('installBannerClose').addEventListener('click', () => {
    hideInstallBanner();
    try { localStorage.setItem(STORE_INSTALL_DISMISSED, '1'); } catch { /* не критично */ }
  });
  window.addEventListener('appinstalled', hideInstallBanner);
}

/* ------------------------------------------------------------ IndexedDB */
/*
 * Хранилище фото и загруженных шрифтов/логотипа. Если IndexedDB недоступна
 * (приватный режим старого Safari), всё продолжает работать в памяти —
 * просто фото не переживут перезагрузку, о чём предупредит beforeunload.
 */
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const req = indexedDB.open('g24-media', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }).then(db => { state.idbOk = Boolean(db); return db; });
  return dbPromise;
}
async function idbRequest(mode, fn) {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}
const idbPut = (key, value) => idbRequest('readwrite', s => s.put(value, key));
const idbGet = key => idbRequest('readonly', s => s.get(key));
const idbDel = key => idbRequest('readwrite', s => s.delete(key));
const idbKeys = () => idbRequest('readonly', s => s.getAllKeys());

async function deleteProjectMedia(projectId, keepIds = null) {
  const keys = await idbKeys();
  if (!keys) return;
  const prefix = projectId + '/';
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    if (keepIds && keepIds.has(key.slice(prefix.length))) continue;
    await idbDel(key);
  }
}

/* ------------------------------------------------------ бренд и шрифты */

const assets = { logoWhite: null, logoBlack: null, stack: null };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* Обрезает прозрачные поля — логотип встаёт в рамку по видимой части.
   Маленькие картинки (SVG приходит в своих 123×105) сначала растеризуются
   крупнее, чтобы знак оставался чётким и в экспорте 1440×1800. */
function trimTransparent(img) {
  const [iw, ih] = mediaSize(img);
  const s = Math.max(iw, ih) < 900 ? 1000 / Math.max(iw, ih) : 1;
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; } catch { return c; }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return c;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/* Логотип — маска: красим её в белый и чёрный, как заливки в макете. */
function tint(src, color) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

async function setLogoFrom(src) {
  const img = await loadImage(src);
  const trimmed = trimTransparent(img);
  assets.logoWhite = tint(trimmed, '#ffffff');
  assets.logoBlack = tint(trimmed, '#000000');
  const img2 = h('img', { src: assets.logoWhite.toDataURL('image/png'), alt: '' });
  el.brandLogo.replaceChildren(img2);
}

async function loadBrand() {
  const jobs = [];
  if (BUNDLED_BRAND.stack) jobs.push(loadImage(BUNDLED_BRAND.stack).then(img => { assets.stack = img; }).catch(() => {}));
  jobs.push((async () => {
    const custom = await idbGet('brand/logo');
    if (custom instanceof Blob) {
      const url = URL.createObjectURL(custom);
      try { await setLogoFrom(url); state.userLogo = true; return; } catch { /* битый файл — встроенный */ }
    }
    if (BUNDLED_BRAND.logo) await setLogoFrom(BUNDLED_BRAND.logo).catch(() => {});
  })());
  await Promise.all(jobs);
}

const USER_FONT_FAMILY = { title: 'G24TitleUser', display: 'G24DisplayUser' };
const userFontFaces = {};

async function applyUserFont(kind, blob) {
  if (userFontFaces[kind]) {
    try { document.fonts.delete(userFontFaces[kind]); } catch { /* уже нет */ }
    userFontFaces[kind] = null;
  }
  state.userFonts[kind] = false;
  if (!blob) return true;
  try {
    const face = new FontFace(USER_FONT_FAMILY[kind], await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    userFontFaces[kind] = face;
    state.userFonts[kind] = true;
    return true;
  } catch {
    return false;
  }
}

function syncFontStretch() {
  for (const kind of ['title', 'display']) {
    const real = (typeof BUNDLED_FONTS !== 'undefined' && BUNDLED_FONTS[kind]) || state.userFonts[kind];
    FONT_STRETCH[kind] = real ? 1 : FALLBACK_STRETCH[kind];
  }
  resetCapCache();
  state.fontsVersion++;
}

function missingFonts() {
  const out = [];
  if (!BUNDLED_FONTS.title && !state.userFonts.title) out.push('BravoRG');
  if (!BUNDLED_FONTS.display && !state.userFonts.display) out.push('Nauryz Red Keds');
  return out;
}

async function loadFonts() {
  const specs = ['400 40px G24Title', '400 40px G24Display', '400 40px G24Body', 'italic 400 40px G24Body',
    '700 40px G24Body', 'italic 700 40px G24Body'];
  if (document.fonts && document.fonts.load) {
    await Promise.all(specs.map(s => document.fonts.load(s).catch(() => null)));
  }
  for (const kind of ['title', 'display']) {
    const blob = await idbGet('brand/font-' + kind);
    if (blob instanceof Blob) await applyUserFont(kind, blob);
  }
  syncFontStretch();
}

function pickBrandFile(kind) {
  const picker = el.brandPicker;
  picker.accept = kind === 'logo' ? 'image/png,image/webp,image/svg+xml' : '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';
  picker.value = '';
  picker.onchange = async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    if (kind === 'logo') {
      const url = URL.createObjectURL(file);
      try {
        await setLogoFrom(url);
        await idbPut('brand/logo', file);
        state.userLogo = true;
        say('Логотип заменён');
      } catch { say('Не получилось открыть картинку'); }
    } else {
      const ok = await applyUserFont(kind, file);
      if (!ok) { say('Этот файл не читается как шрифт'); return; }
      await idbPut('brand/font-' + kind, file);
      say('Шрифт загружен');
    }
    afterBrandChange();
  };
  picker.click();
}

async function resetBrand(kind) {
  if (kind === 'logo') {
    await idbDel('brand/logo');
    state.userLogo = false;
    if (BUNDLED_BRAND.logo) await setLogoFrom(BUNDLED_BRAND.logo).catch(() => {});
  } else {
    await idbDel('brand/font-' + kind);
    await applyUserFont(kind, null);
  }
  afterBrandChange();
}

function afterBrandChange() {
  syncFontStretch();
  if (state.screen === 'home') renderHome();
  else { invalidateThumbs(); refreshEditor(); }
}

/* ------------------------------------------------------------------ фото */

/* Раскодирование через <img>, а не createImageBitmap: <img> везде учитывает
   EXIF-поворот, а createImageBitmap в части версий Safari — нет, и
   вертикальные фото с iPhone ложились бы боком. */
function decodeBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { img._url = url; resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
function releaseImage(img) {
  if (!img) return;
  if (img._url) { URL.revokeObjectURL(img._url); img._url = null; img.removeAttribute('src'); }
  if (typeof img.close === 'function') img.close();
}

function downscale(src, max) {
  const [w, h] = mediaSize(src);
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/*
 * Коррекция фото (вкладка «Фото»): slide.photo.adj = {bright, contrast, sat,
 * warm}, каждое от −100 до 100, 0 — как есть (нули не храним). Считаем по
 * пикселям, а не через ctx.filter: в Safari фильтр у canvas появился поздно,
 * а «тепло» им не сделать. Превью берёт исправленную копию m.prev из кеша,
 * экспорт исправляет оригинал. Видео не правим: каждый кадр по пикселям —
 * слишком медленно для записи в реальном времени.
 */
const ADJ_KEYS = ['bright', 'contrast', 'sat', 'warm'];
const ADJ_CACHE_MAX = 6;
const ADJ_SMALL = 640;             // копия для миниатюр и для превью, пока тянут ползунок
const ADJ_BAND = 256;              // строк за один getImageData — меньше памяти на больших фото
const adjCache = new Map();        // `${photoId}|${сигнатура}` → canvas, по давности использования

function photoAdj(slide) {
  const a = slide && slide.photo && slide.photo.adj;
  return a && ADJ_KEYS.some(k => a[k]) ? a : null;
}
function adjSig(a) { return ADJ_KEYS.map(k => a[k] || 0).join(','); }
function normalizeAdj(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  for (const k of ADJ_KEYS) {
    const v = Math.round(clamp(Number(a[k]) || 0, -100, 100));
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* Яркость — гамма (светлеют средние тона, света не выбиваются; темнее —
   ещё и светлые места притушаются, иначе белое небо так и осталось бы
   белым), контраст —
   вокруг середины, насыщенность через яркость Rec. 709 (−100 = ч/б), тепло —
   усиление красного и ослабление синего (или наоборот). */
function adjustPixels(d, a) {
  const gamma = Math.pow(2, -(a.bright || 0) / 100 * 0.8);
  const dim = 1 + Math.min(0, a.bright || 0) / 100 * 0.35;
  const c = (a.contrast || 0) / 100;
  const ct = c >= 0 ? 1 + c * 0.6 : 1 + c * 0.5;
  const s = 1 + (a.sat || 0) / 100;
  const w = (a.warm || 0) / 100;
  const gr = 1 + 0.1 * w, gg = 1 + 0.02 * w, gb = 1 - 0.14 * w;
  const tone = new Float32Array(256);
  for (let i = 0; i < 256; i++) tone[i] = ((Math.pow(i / 255, gamma) * dim - 0.5) * ct + 0.5) * 255;
  for (let i = 0; i < d.length; i += 4) {
    let r = tone[d[i]], g = tone[d[i + 1]], b = tone[d[i + 2]];
    if (s !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s;
    }
    d[i] = r * gr; d[i + 1] = g * gg; d[i + 2] = b * gb;   // Uint8ClampedArray сам обрежет 0…255
  }
}

function adjustImage(src, a) {
  const [w, h] = mediaSize(src);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  for (let y = 0; y < h; y += ADJ_BAND) {
    const img = ctx.getImageData(0, y, w, Math.min(ADJ_BAND, h - y));
    adjustPixels(img.data, a);
    ctx.putImageData(img, 0, y);
  }
  return c;
}
function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

/* То, что рисуется в слоте фото на превью: оригинал или исправленная копия.
   small — хватит копии поменьше (миниатюра; превью, пока тянут ползунок:
   полный пересчёт на телефоне — заметная доля секунды). */
function slidePhoto(slide, m, small) {
  if (!m) return null;
  const a = !isVideoMedia(m) && !state.adjOff && photoAdj(slide);
  if (!a) return m.prev;
  const key = slide.photo.id + (small ? '|s|' : '|') + adjSig(a);
  let c = adjCache.get(key);
  if (c) adjCache.delete(key);
  else c = adjustImage(small ? m.small || (m.small = downscale(m.prev, ADJ_SMALL)) : m.prev, a);
  adjCache.set(key, c);
  while (adjCache.size > ADJ_CACHE_MAX) {
    const [old, oc] = adjCache.entries().next().value;
    adjCache.delete(old);
    freeCanvas(oc);
  }
  return c;
}
function dropAdjCache() { adjCache.forEach(freeCanvas); adjCache.clear(); }

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/*
 * HEIC/HEIF (фото с iPhone). Safari раскодирует их сам, Chrome, Firefox и
 * Edge — нет: для них декодер libheif (vendor/heic-to.js, ~3 МБ) грузится
 * отдельным файлом при первом таком фото, а не вшит в страницу. Дальше
 * сервис-воркер держит его в кеше. В проект фото всё равно ложится JPEG.
 */
const HEIC_LIB = 'vendor/heic-to.js';
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
let heicLib = null;

async function isHeicFile(file) {
  if (/hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '')) return true;
  // тип у файла бывает пустым (Windows) — смотрим на заголовок ftyp
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const box = String.fromCharCode(...head.subarray(4, 8));
    const brand = String.fromCharCode(...head.subarray(8, 12));
    return box === 'ftyp' && HEIC_BRANDS.includes(brand);
  } catch { return false; }
}

function loadHeicLib() {
  if (!heicLib) {
    heicLib = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = HEIC_LIB;
      script.onload = () => (window.HeicTo ? resolve(window.HeicTo) : reject(new Error('heic-to')));
      script.onerror = () => reject(new Error('heic-to'));
      document.head.append(script);
    }).catch(err => { heicLib = null; throw err; });   // не загрузился — в следующий раз попробуем снова
  }
  return heicLib;
}

/* HEIC → ImageBitmap (поворот из файла libheif уже применил). */
async function decodeHeic(file) {
  let HeicTo;
  try { HeicTo = await loadHeicLib(); } catch {
    throw new Error(navigator.onLine === false
      ? 'Для HEIC нужен интернет: при первом таком фото загружается декодер'
      : 'Не получилось загрузить декодер HEIC — попробуйте ещё раз');
  }
  try { return await HeicTo({ blob: file, type: 'bitmap' }); } catch {
    throw new Error('Не получилось открыть HEIC — файл повреждён или это не фото');
  }
}

/*
 * Файл → фото проекта: уменьшаем до PHOTO_MAX (для хранения и экспорта) и
 * до PREVIEW_MAX (для превью), кладём в IndexedDB. Возвращает id фото.
 */
async function importPhoto(file) {
  let img, heic = false;
  try { img = await decodeBlob(file); } catch {
    if (!(await isHeicFile(file))) throw new Error('Не получилось открыть фото');
    img = await decodeHeic(file);
    heic = true;
  }
  const [w, h] = mediaSize(img);
  let blob = file;
  let fw = w, fh = h;
  // не JPEG/PNG/WebP (HEIC, GIF…) пересохраняем в JPEG — его откроет любой браузер
  const plain = !heic && /image\/(jpeg|png|webp)/.test(file.type);
  if (Math.max(w, h) > PHOTO_MAX || !plain) {
    const big = downscale(img, PHOTO_MAX);
    fw = big.width; fh = big.height;
    blob = await canvasToBlob(big, 'image/jpeg', 0.92) || file;
    big.width = big.height = 0;
  }
  const prev = downscale(img, PREVIEW_MAX);
  releaseImage(img);
  const id = newId();
  media.set(id, { blob, prev, w: fw, h: fh });
  if (state.project) await idbPut(state.project.id + '/' + id, blob);
  return id;
}

/* Подгружает из IndexedDB фото, которых ещё нет в памяти. */
function ensureMedia(projectId, ids) {
  const jobs = [];
  for (const id of ids) {
    if (!id || media.has(id) || loadingMedia.has(id)) continue;
    const job = (async () => {
      const blob = await idbGet(projectId + '/' + id);
      if (!(blob instanceof Blob)) return;
      try {
        if (/^video\//.test(blob.type)) {
          media.set(id, await createVideoMedia(blob));
          return;
        }
        const img = await decodeBlob(blob);
        const [w, h] = mediaSize(img);
        media.set(id, { blob, prev: downscale(img, PREVIEW_MAX), w, h });
        releaseImage(img);
      } catch { /* битый файл — просто без фото */ }
    })().finally(() => loadingMedia.delete(id));
    loadingMedia.set(id, job);
    jobs.push(job);
  }
  return Promise.all(jobs);
}

function freeMedia() {
  stopPlayback();
  for (const m of media.values()) {
    if (m.kind === 'video') releaseVideo(m.prev);
    else if (m.prev) { m.prev.width = 0; m.prev.height = 0; }
    freeCanvas(m.small);
  }
  media.clear();
  dropAdjCache();
}

/* ------------------------------------------------------------------ видео */
/*
 * Видео живёт как <video> на blob-URL (в DOM не вставляется): для превью и
 * миниатюр рисуем его текущий кадр, как картинку. Фрагмент задаётся на
 * слайде — slide.photo.start / end (секунды), так что у дубликатов слайда
 * с одним и тем же видео фрагменты могут быть разными.
 *
 * Звук при экспорте берём через Web Audio (createMediaElementSource →
 * MediaStreamDestination), а не video.captureStream(): его нет в Safari.
 * Узел-источник создаётся один раз на элемент, и после этого звук элемента
 * идёт только через граф — поэтому при записи его не слышно, а для
 * просмотра со звуком узел подключаем к динамикам (routeToSpeakers).
 */
const VIDEO_LIMIT = { carousel: 60, reels: 90 };   // Instagram: видео в карусели — до 60 с
const VIDEO_EXPORT_WIDTH = 1080;   // видео пишем в 1080 по ширине — Instagram всё равно ужмёт, телефону легче
const MIN_CLIP = 0.5;
const STOP_GRACE_MS = 350;          // MediaRecorder: stop() раньше onstart даёт пустой файл

function isVideoFile(file) {
  return /^video\//.test(file.type || '') || /\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name || '');
}
function isVideoMedia(m) { return Boolean(m && m.kind === 'video'); }
function slideMedia(slide) { return slide && slide.photo ? media.get(slide.photo.id) : null; }

function waitEvent(target, name, ms) {
  return new Promise(resolve => {
    let timer = null;
    const done = ok => { clearTimeout(timer); target.removeEventListener(name, on); resolve(ok); };
    const on = () => done(true);
    target.addEventListener(name, on);
    timer = setTimeout(() => done(false), ms);
  });
}

function seekVideo(video, t) {
  if (Math.abs(video.currentTime - t) < 0.02 && video.readyState >= 2) return Promise.resolve(true);
  const p = waitEvent(video, 'seeked', 4000);
  video.currentTime = t;
  return p;
}

/* Blob → <video> с загруженным первым кадром и известной длительностью. */
async function createVideoMedia(blob) {
  const video = document.createElement('video');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.preload = 'auto';
  video._url = URL.createObjectURL(blob);
  const meta = waitEvent(video, 'loadedmetadata', 15000);
  const failed = waitEvent(video, 'error', 15000);
  video.src = video._url;
  const ok = await Promise.race([meta, failed.then(() => false)]);
  if (!ok || video.error || !video.videoWidth) { releaseVideo(video); throw new Error('video'); }
  // у записей MediaRecorder длительность бывает Infinity, пока не дойти до конца
  if (!isFinite(video.duration)) {
    const dur = waitEvent(video, 'durationchange', 3000);
    video.currentTime = 1e7;
    await dur;
    await seekVideo(video, 0);
  }
  // iOS не показывает кадр, пока видео хоть раз не проиграли (без звука можно)
  if (video.readyState < 2) {
    try { await video.play(); video.pause(); } catch { /* покажем, когда догрузится */ }
  }
  await seekVideo(video, Math.min(0.05, (video.duration || 1) / 2));
  video.addEventListener('seeked', () => { if (!playback) { thumbSig.clear(); scheduleRender(); } });
  video.addEventListener('loadeddata', () => { thumbSig.clear(); scheduleRender(); });
  return { kind: 'video', blob, prev: video, w: video.videoWidth, h: video.videoHeight,
           duration: isFinite(video.duration) ? video.duration : 0 };
}

function releaseVideo(video) {
  if (!video) return;
  try { video.pause(); } catch { /* уже нет */ }
  if (video._url) { URL.revokeObjectURL(video._url); video._url = null; }
  video.removeAttribute('src');
  try { video.load(); } catch { /* ок */ }
}

async function importVideo(file) {
  let entry;
  try { entry = await createVideoMedia(file); } catch {
    throw new Error('Не получилось открыть видео — этот формат браузер не проигрывает');
  }
  const id = newId();
  media.set(id, entry);
  if (state.project) {
    const saved = await idbPut(state.project.id + '/' + id, file);
    if (!saved) say('Видео не поместилось в память браузера — после перезагрузки его нужно будет добавить заново', 6000);
  }
  return id;
}

function importMedia(file) {
  return isVideoFile(file) ? importVideo(file) : importPhoto(file);
}

function videoLimit(slide) {
  return layoutOf(slide).W === 1080 ? VIDEO_LIMIT.reels : VIDEO_LIMIT.carousel;
}

/* Фрагмент видео на слайде, приведённый к длине ролика. */
function clipOf(slide, m = slideMedia(slide)) {
  const d = (m && m.duration) || 0;
  if (!d) return { start: 0, end: 0, length: 0 };
  const start = clamp(Number(slide.photo.start) || 0, 0, Math.max(0, d - MIN_CLIP));
  let end = Number(slide.photo.end) > 0 ? Number(slide.photo.end) : Math.min(d, videoLimit(slide));
  end = clamp(end, Math.min(d, start + MIN_CLIP), d);
  return { start, end, length: end - start };
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1).replace('.', ',');
}

/* Кадр начала фрагмента — чтобы превью и миниатюры показывали то, с чего начнётся видео. */
function showClipStart(slide) {
  const m = slideMedia(slide);
  if (!isVideoMedia(m) || playback) return;
  seekVideo(m.prev, clipOf(slide, m).start);
}

let audioCtx = null;
function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) { try { audioCtx = new AC(); } catch { return null; } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function audioSource(video) {
  if (video._src !== undefined) return video._src;
  const ctx = getAudioCtx();
  try { video._src = ctx ? ctx.createMediaElementSource(video) : null; } catch { video._src = null; }
  return video._src;
}

/* Вызывается прямо в обработчике нажатия «Сохранить»: iOS разрешает звук и
   AudioContext только из жеста пользователя. Узел создаём заранее — после
   этого пробный play() не слышно. */
function primeVideoAudio(slides) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  for (const slide of slides) {
    const m = slideMedia(slide);
    if (!isVideoMedia(m)) continue;
    const v = m.prev;
    if (!audioSource(v)) continue;
    // play() внутри жеста «разрешает» элементу звук; сразу же pause() —
    // синхронно, без .then(): отложенная пауза прилетала уже во время записи
    // и замораживала видео на первом кадре
    v.muted = false;
    const p = v.play();
    v.pause();
    if (p && p.catch) p.catch(() => {});
  }
}

/* ---- просмотр видео на превью */
let playback = null;   // { slideId, video, raf, lastDraw, speakers }

function togglePlayback() {
  if (playback) { stopPlayback(); return; }
  const slide = currentSlide();
  const m = slideMedia(slide);
  if (!isVideoMedia(m)) return;
  const v = m.prev;
  const clip = clipOf(slide, m);
  if (v.currentTime < clip.start || v.currentTime >= clip.end - 0.05) v.currentTime = clip.start;
  playback = { slideId: slide.id, video: v, raf: 0, lastDraw: 0, speakers: false };
  if (v._src && audioCtx) { v._src.connect(audioCtx.destination); playback.speakers = true; getAudioCtx(); }
  v.muted = false;
  const p = v.play();
  if (p && p.catch) p.catch(() => { v.muted = true; v.play().catch(() => stopPlayback()); });
  const tick = now => {
    if (!playback) return;
    const cur = state.project && state.project.slides.find(x => x.id === playback.slideId);
    const c = cur ? clipOf(cur, m) : clip;
    if (v.currentTime >= c.end || v.ended) {
      v.currentTime = c.start;
      if (v.paused) v.play().catch(() => {});
    }
    if (now - playback.lastDraw > 33) { playback.lastDraw = now; renderStage(); }
    playback.raf = requestAnimationFrame(tick);
  };
  playback.raf = requestAnimationFrame(tick);
  renderOverlay();
  syncPlayButtons();
}

function stopPlayback() {
  if (!playback) return;
  const { video, raf, speakers } = playback;
  cancelAnimationFrame(raf);
  playback = null;
  video.pause();
  video.muted = true;
  if (speakers && video._src && audioCtx) { try { video._src.disconnect(audioCtx.destination); } catch { /* ок */ } }
  if (state.screen === 'editor') { thumbSig.clear(); scheduleRender(); }
  syncPlayButtons();
}

function syncPlayButtons() {
  document.querySelectorAll('[data-play-toggle]').forEach(b => {
    const on = Boolean(playback);
    b.replaceChildren(iconSpan(on ? 'pause' : 'play'), document.createTextNode(b.dataset.label === 'short' ? '' : (on ? 'Пауза' : 'Смотреть')));
    b.setAttribute('aria-label', on ? 'Пауза' : 'Смотреть');
  });
}

/* ---- запись видео-слайда */
const RECORDER_TYPES = {
  audio: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
          'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  silent: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
           'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
};
function recorderType(withAudio) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  for (const t of RECORDER_TYPES[withAudio ? 'audio' : 'silent']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* дальше */ }
  }
  return null;
}
function canRecordVideo() {
  return Boolean(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && recorderType(false));
}
function videoExt() {
  const t = recorderType(false) || '';
  return t.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/*
 * Проигрывает фрагмент и пишет canvas (+ звук ролика) через MediaRecorder.
 * Порядок как в Card Maker, проверенный замерами: запись стартует до
 * воспроизведения, а останавливается не раньше STOP_GRACE_MS после onstart
 * (иначе пустой файл или один кадр); всё это время рисуем последний кадр.
 */
async function recordVideoSlide(slide, index, onProgress, story = false) {
  const m = slideMedia(slide);
  const L = layoutOf(slide);
  const v = m.prev;
  const clip = clipOf(slide, m);
  // сторис: слайд карточкой на фоне, фон — один раз по первому кадру
  const k = story ? STORY_CARD.w / L.W : VIDEO_EXPORT_WIDTH / L.W;
  const canvas = document.createElement('canvas');
  canvas.width = story ? STORY_W : Math.round(L.W * k);
  canvas.height = story ? STORY_H : Math.round(L.H * k);
  const ctx = canvas.getContext('2d');
  const env = envFor(slide, index, { ghost: false, k, photo: v });
  let base = null;
  const draw = () => {
    if (base) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base, 0, 0);
      ctx.save();
      storyCardPath(ctx);
      ctx.clip();
      ctx.setTransform(k, 0, 0, k, STORY_CARD.x, STORY_CARD.y);
      ctx.imageSmoothingQuality = 'high';
      renderSlide(ctx, slide, env);
      ctx.restore();
      return;
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    renderSlide(ctx, slide, env);
  };

  v.pause();
  await seekVideo(v, clip.start);
  if (story) {
    const small = document.createElement('canvas');
    const sk = 288 / L.W;
    small.width = 288;
    small.height = Math.round(L.H * sk);
    const sctx = small.getContext('2d');
    sctx.setTransform(sk, 0, 0, sk, 0, 0);
    renderSlide(sctx, slide, Object.assign({}, env, { k: sk }));
    const back = storyBackdrop(small);
    base = storyBase(back);
    freeCanvas(back);
    freeCanvas(small);
  }
  draw();

  const stream = canvas.captureStream(30);
  const src = audioSource(v);
  let dest = null;
  if (src && audioCtx) {
    try { dest = audioCtx.createMediaStreamDestination(); src.connect(dest); } catch { dest = null; }
  }
  const audioTracks = dest ? dest.stream.getAudioTracks() : [];
  const tracks = [...stream.getVideoTracks(), ...audioTracks];
  const type = recorderType(audioTracks.length > 0) || recorderType(false);
  let recorder;
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 10000000, audioBitsPerSecond: 160000 });
  } catch {
    recorder = new MediaRecorder(new MediaStream(tracks));
  }
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(resolve => { recorder.onstop = resolve; });
  let startedAt = 0;
  recorder.onstart = () => { startedAt = performance.now(); };
  recorder.start(500);

  v.muted = !dest;
  try { await v.play(); } catch {
    v.muted = true;
    try { await v.play(); } catch { /* дорисуем кадр как есть */ }
  }

  await new Promise(resolve => {
    const hardStop = performance.now() + clip.length * 1000 + 8000;
    let endedAt = 0;
    let lastKick = performance.now();
    const tick = () => {
      draw();
      const now = performance.now();
      if (onProgress) onProgress(clamp((v.currentTime - clip.start) / clip.length, 0, 1));
      if (!endedAt && (v.currentTime >= clip.end - 0.01 || v.ended)) {
        endedAt = now;
        v.pause();
      } else if (!endedAt && v.paused && now - lastKick > 400) {
        // кто-то (система, другая вкладка) поставил на паузу — продолжаем
        lastKick = now;
        v.play().catch(() => {});
      }
      if (now > hardStop || (endedAt && startedAt && now - startedAt > STOP_GRACE_MS && now - endedAt > 120)) {
        v.pause();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  await stopped;
  if (dest) { try { src.disconnect(dest); } catch { /* ок */ } }
  v.muted = true;
  stream.getTracks().forEach(t => t.stop());
  canvas.width = canvas.height = 0;
  freeCanvas(base);
  const mime = (recorder.mimeType || type || 'video/webm').split(';')[0];
  return new Blob(chunks, { type: mime });
}

/* ------------------------------------------------------------- проекты */

function newSlide(layout) {
  return { id: newId(), layout, fields: {}, opts: {}, size: {}, photo: null };
}

function currentSlide() {
  return state.project ? state.project.slides[state.current] : null;
}
function layoutOf(slide) {
  return LAYOUTS[slide && slide.layout] || LAYOUTS.post;
}
function rubricOf(project = state.project) {
  return RUBRIC_BY_ID[project && project.rubric] || RUBRICS[0];
}

/* Номер карточки среди слайдов того же макета — для подсказки «02. Заголовок». */
function cardNo(index) {
  const slides = state.project.slides;
  const layout = slides[index].layout;
  let n = 0;
  for (let i = 0; i <= index; i++) if (slides[i].layout === layout) n++;
  return n;
}

function readDrafts() {
  const list = readJson(STORE_DRAFTS, []);
  return Array.isArray(list) ? list.filter(d => d && d.id && d.data) : [];
}
function writeDrafts(list) {
  if (!writeJson(STORE_DRAFTS, list)) {
    say('Не удалось сохранить: память браузера заполнена — удалите старые черновики');
    return false;
  }
  return true;
}

function projectData(p = state.project) {
  return { v: 1, name: p.name, nameAuto: Boolean(p.nameAuto), rubric: p.rubric, slides: p.slides };
}

function normalizeSlides(slides) {
  return (Array.isArray(slides) ? slides : []).filter(s => s && LAYOUTS[s.layout]).map(s => ({
    id: String(s.id || newId()),
    layout: s.layout,
    fields: Object.assign({}, s.fields),
    ...(s.fmt && typeof s.fmt === 'object' && Object.keys(s.fmt).length ? { fmt: Object.assign({}, s.fmt) } : {}),
    opts: Object.assign({}, s.opts),
    size: Object.assign({}, s.size),
    photo: s.photo && s.photo.id ? Object.assign({ id: String(s.photo.id), zoom: Number(s.photo.zoom) || 1,
      x: Number(s.photo.x) || 0, y: Number(s.photo.y) || 0 },
      s.photo.end > 0 ? { start: Number(s.photo.start) || 0, end: Number(s.photo.end) } : {},
      normalizeAdj(s.photo.adj) ? { adj: normalizeAdj(s.photo.adj) } : {},
      normalizeTurn(s.photo)) : null,
  }));
}

function autoName(p) {
  const r = rubricOf(p);
  const f = (p.slides[0] && p.slides[0].fields) || {};
  const t = [f.number, f.title || f.label].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const date = new Date(p.createdAt || Date.now()).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return t ? t.slice(0, 60) : r.name + ' · ' + date;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 350);
}
function saveProject() {
  clearTimeout(saveTimer);
  const p = state.project;
  if (!p) return;
  p.updatedAt = Date.now();
  // читаем список заново перед записью — две вкладки с разными черновиками
  // не затирают друг друга
  const list = readDrafts().filter(d => d.id !== p.id);
  list.unshift({ id: p.id, name: p.name, rubric: p.rubric, createdAt: p.createdAt, updatedAt: p.updatedAt, data: projectData(p) });
  const trimmed = list.slice(0, MAX_DRAFTS);
  for (const old of list.slice(MAX_DRAFTS)) deleteProjectMedia(old.id);
  writeDrafts(trimmed);
}

function createProject(rubricId) {
  const r = RUBRIC_BY_ID[rubricId] || RUBRICS[0];
  const p = { id: newId(), rubric: r.id, name: '', nameAuto: true, createdAt: Date.now(), updatedAt: Date.now(),
              slides: r.slides.map(newSlide) };
  p.name = autoName(p);
  openProject(p);
  saveProject();
}

function openDraft(id) {
  const d = readDrafts().find(x => x.id === id);
  if (!d) { renderHome(); return; }
  const p = { id: d.id, rubric: d.data.rubric || d.rubric, name: d.data.name || d.name || '', nameAuto: Boolean(d.data.nameAuto),
              createdAt: d.createdAt || Date.now(), updatedAt: d.updatedAt || Date.now(),
              slides: normalizeSlides(d.data.slides) };
  if (!p.slides.length) p.slides = rubricOf(p).slides.map(newSlide);
  openProject(p);
}

function openProject(p) {
  freeMedia();
  state.project = p;
  state.current = 0;
  state.undo = [];
  state.redo = [];
  state.overflow = [];
  state.tab = 'slide';
  showEditor();
  const ids = p.slides.map(s => s.photo && s.photo.id).filter(Boolean);
  if (ids.length) ensureMedia(p.id, ids).then(() => { if (state.project === p) { invalidateThumbs(); refreshEditor(); } });
}

function deleteDraft(id) {
  const d = readDrafts().find(x => x.id === id);
  if (!d) return;
  if (!confirm(`Удалить черновик «${d.name || 'без названия'}»? Фото этого проекта тоже удалятся.`)) return;
  writeDrafts(readDrafts().filter(x => x.id !== id));
  deleteProjectMedia(id);
  renderHome();
}

function exportProjectFile() {
  const p = state.project;
  const blob = new Blob([JSON.stringify(Object.assign({ app: 'gorod24' }, projectData(p)), null, 2)], { type: 'application/json' });
  downloadBlob(blob, fileSlug(p.name, 'gorod24') + '.g24.json');
  say('Файл проекта сохранён (без фото)');
}

function importProjectFile() {
  const picker = el.projectPicker;
  picker.value = '';
  picker.onchange = async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const slides = normalizeSlides(data.slides);
      if (!slides.length) throw new Error('empty');
      const p = { id: newId(), rubric: RUBRIC_BY_ID[data.rubric] ? data.rubric : RUBRICS[0].id,
                  name: String(data.name || 'Проект из файла'), createdAt: Date.now(), updatedAt: Date.now(),
                  slides: slides.map(s => Object.assign(s, { photo: null })) };
      openProject(p);
      saveProject();
      say('Проект открыт — фото нужно добавить заново');
    } catch {
      say('Это не файл проекта конструктора');
    }
  };
  picker.click();
}

/* ------------------------------------------------------------- отмена */

let lastUndoKey = null, lastUndoAt = 0;
function snapshot() {
  return JSON.stringify({ slides: state.project.slides, current: state.current });
}
function pushUndo(key = null) {
  const now = Date.now();
  if (key && key === lastUndoKey && now - lastUndoAt < UNDO_COALESCE_MS) { lastUndoAt = now; return; }
  state.undo.push(snapshot());
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
  lastUndoKey = key;
  lastUndoAt = now;
  syncUndoButtons();
}
function restoreSnapshot(snap) {
  const d = JSON.parse(snap);
  state.project.slides = normalizeSlides(d.slides);
  state.current = clamp(d.current || 0, 0, state.project.slides.length - 1);
  lastUndoKey = null;
  const ids = state.project.slides.map(s => s.photo && s.photo.id).filter(Boolean);
  ensureMedia(state.project.id, ids).then(() => { invalidateThumbs(); scheduleRender(); });
  refreshEditor(true);
  scheduleSave();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restoreSnapshot(state.undo.pop());
  syncUndoButtons();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restoreSnapshot(state.redo.pop());
  syncUndoButtons();
}
function syncUndoButtons() {
  el.btnUndo.disabled = !state.undo.length;
  el.btnRedo.disabled = !state.redo.length;
}

/* --------------------------------------------------- операции со слайдами */

function commit({ structure = false, panel = false } = {}) {
  if (structure) renderSlidesList();
  if (panel || structure) renderPanel();
  scheduleRender();
  scheduleSave();
}

function selectSlide(index, { scroll = true } = {}) {
  if (!state.project) return;
  index = clamp(index, 0, state.project.slides.length - 1);
  const changed = index !== state.current;
  if (changed) stopPlayback();
  state.current = index;
  state.panHintAt = 0;
  showClipStart(state.project.slides[index]);
  syncSlideSelection(scroll);
  if (changed && state.quick) {
    // быстрая правка продолжается на соседнем слайде: то же поле или первое
    const keys = editableKeys(state.project.slides[index]);
    if (!keys.includes(state.quick)) state.quick = keys[0] || null;
  }
  if (changed) renderPanel();
  if (changed && state.quick) focusField(state.quick);
  scheduleRender();
}

function addSlide(layout, after = state.current) {
  pushUndo();
  const slide = newSlide(layout);
  state.project.slides.splice(after + 1, 0, slide);
  state.current = after + 1;
  commit({ structure: true });
  return slide;
}

function duplicateSlide(index = state.current) {
  pushUndo();
  const src = state.project.slides[index];
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = newId();
  state.project.slides.splice(index + 1, 0, copy);
  state.current = index + 1;
  commit({ structure: true });
  say('Слайд продублирован');
}

function moveSlide(from, to) {
  const slides = state.project.slides;
  if (to < 0 || to >= slides.length || from === to) return;
  pushUndo();
  const [s] = slides.splice(from, 1);
  slides.splice(to, 0, s);
  state.current = to;
  commit({ structure: true });
}

function deleteSlide(index = state.current) {
  const slides = state.project.slides;
  if (slides.length <= 1) { say('Последний слайд удалить нельзя'); return; }
  pushUndo();
  slides.splice(index, 1);
  state.current = clamp(state.current >= index ? state.current - 1 : state.current, 0, slides.length - 1);
  if (index === 0) state.current = 0;
  commit({ structure: true });
  say('Слайд удалён — ⌘Z или «Отменить» вернёт');
}

function changeLayout(layout, index = state.current) {
  const slide = state.project.slides[index];
  if (slide.layout === layout) return;
  pushUndo();
  slide.layout = layout;
  if (!LAYOUTS[layout].photo) { /* фото остаётся в данных — вернётся при смене обратно */ }
  commit({ structure: true });
}

/*
 * «Перемешать»: карточкам (не обложкам и не рилс) случайно подбираются
 * другие макеты-карточки — из тех, где поместится всё, что на карточке
 * видно. Заголовок, текст и доп. блоки интервью (они есть только у
 * int-card) должны быть в новом макете; короткие строки — адрес, место,
 * дата, цена, плашка — переезжают в его строки (MIX_INFO: адрес → «место»
 * у события, → плашка у фильма), лишь бы строк хватило. С фото — только
 * макеты с фото; без фото — любые (слот «Добавить фото» появится сам).
 * Соседние карточки по возможности разные, реже встречавшиеся макеты — в
 * приоритете, текущий — в последнюю очередь. Отмена — как обычно.
 */
const MIX_LAYOUTS = ['int-card', 'fav-card', 'new-card', 'ev-card', 'com-top', 'com-bottom', 'kino-card'];
const MIX_INFO = { 'new-card': ['address'], 'ev-card': ['place', 'date', 'price'], 'kino-card': ['badge'] };
// куда может переехать строка: адрес и место — друг в друга или в плашку, дата и цена — в плашку
const MIX_MOVES = { address: ['address', 'place', 'badge'], place: ['place', 'address', 'badge'],
  date: ['date', 'badge'], price: ['price', 'badge'], badge: ['badge', 'date'] };

/* Видимые на карточке поля: основные (заголовок, текст, блоки) и короткие строки. */
function mixContent(slide) {
  const cur = layoutOf(slide);
  const info = MIX_INFO[cur.id] || [];
  const shown = slideFields(slide, cur).filter(k => (slide.fields[k] || '').trim() && !isHidden(slide, k));
  return { main: shown.filter(k => !info.includes(k)), info: shown.filter(k => info.includes(k)) };
}

/* Что на самом деле в строке: адрес, переехавший в плашку, остаётся адресом
   (slide.opts.mixKind = {badge: 'address'}) — иначе дальше он ушёл бы в «дату». */
function infoKind(slide, key) { return (slide.opts.mixKind && slide.opts.mixKind[key]) || key; }

/* Куда переедут короткие строки в макете id: [[откуда, куда]] или null — не помещаются. */
function mixInfoMoves(slide, id, info) {
  const free = (MIX_INFO[id] || []).slice();
  const moves = [];
  // сначала строки, у которых есть «своё» место, потом остальные — в первую подходящую свободную
  const own = k => free.includes(infoKind(slide, k));
  for (const k of [...info].sort((a, b) => own(b) - own(a))) {
    const to = MIX_MOVES[infoKind(slide, k)].find(t => free.includes(t));
    if (!to) return null;
    free.splice(free.indexOf(to), 1);
    moves.push([k, to]);
  }
  return moves;
}

function mixFits(slide, id, content = mixContent(slide)) {
  const L = LAYOUTS[id];
  if (slide.photo && !L.photo) return false;
  const keys = slideFields(Object.assign({}, slide, { layout: id }), L);
  return content.main.every(k => keys.includes(k)) && Boolean(mixInfoMoves(slide, id, content.info));
}

/* Переносит короткие строки в строки нового макета. */
function mixMoveInfo(slide, id, content) {
  const moves = mixInfoMoves(slide, id, content.info) || [];
  const values = moves.map(([from]) => [slide.fields[from], slide.fmt && slide.fmt[from], infoKind(slide, from)]);
  const kinds = Object.assign({}, slide.opts.mixKind);
  moves.forEach(([from]) => { delete slide.fields[from]; setFmt(slide, from, null); delete kinds[from]; });
  moves.forEach(([, to], i) => {
    slide.fields[to] = values[i][0];
    if (values[i][2] !== to) kinds[to] = values[i][2];
    if (values[i][1]) setFmt(slide, to, values[i][1]);
    if (slide.opts.hidden && slide.opts.hidden[to]) setHiddenOn(slide, to, false);
  });
  if (Object.keys(kinds).length) slide.opts.mixKind = kinds;
  else delete slide.opts.mixKind;
}

function setHiddenOn(slide, key, hidden) {
  const map = Object.assign({}, slide.opts.hidden);
  if (hidden) map[key] = true;
  else delete map[key];
  if (Object.keys(map).length) slide.opts.hidden = map;
  else delete slide.opts.hidden;
}

function mixLayouts() {
  const slides = state.project.slides;
  const cards = slides.map((s, i) => i).filter(i => MIX_LAYOUTS.includes(slides[i].layout));
  if (!cards.length) { say('Карточек нет — перемешивать нечего'); return; }
  const used = {};
  const plan = slides.map(s => s.layout);
  let changed = 0;
  for (const i of cards) {
    const slide = slides[i];
    const content = mixContent(slide);
    const cands = MIX_LAYOUTS.filter(id => mixFits(slide, id, content));
    const prev = i > 0 ? plan[i - 1] : null;
    let pick = slide.layout;
    if (cands.length > 1) {
      const score = id => (used[id] || 0) * 10 + (id === prev ? 100 : 0) + (id === slide.layout ? 5 : 0) + Math.random() * 6;
      pick = cands.reduce((best, id) => (score(id) < score(best) ? id : best));
    }
    used[pick] = (used[pick] || 0) + 1;
    plan[i] = pick;
    if (pick !== slide.layout) changed++;
  }
  if (!changed) { say('Этим карточкам подходит только их макет — текст и фото не влезут в другие'); return; }
  pushUndo();
  plan.forEach((layout, i) => {
    const slide = slides[i];
    if (layout === slide.layout) return;
    mixMoveInfo(slide, layout, mixContent(slide));
    slide.layout = layout;
  });
  commit({ structure: true });
  say(`Новые макеты у ${changed} ${pluralRu(changed, 'карточки', 'карточек', 'карточек')} — нажмите ещё раз для другого варианта`, 4200);
}

function setField(key, value) {
  const slide = currentSlide();
  pushUndo('text:' + slide.id + ':' + key);
  slide.fields[key] = value;
  setFmt(slide, key, null);   // поле без форматирования — старые отрезки не к этому тексту
  syncAutoName();
  scheduleRender();
  scheduleSave();
}

/* Поле с форматированием: текст + отрезки жирного/курсива (см. fieldRuns в render.js). */
function setRichField(key, text, runs) {
  const slide = currentSlide();
  pushUndo('text:' + slide.id + ':' + key);
  slide.fields[key] = text;
  setFmt(slide, key, runs);
  syncAutoName();
  scheduleRender();
  scheduleSave();
}

function setFmt(slide, key, runs) {
  if (!slide.fmt && !(runs && runs.some(r => r[1]))) return;
  const fmt = Object.assign({}, slide.fmt);
  if (runs && runs.some(r => r[1])) fmt[key] = runs;
  else delete fmt[key];
  if (Object.keys(fmt).length) slide.fmt = fmt;
  else delete slide.fmt;
}

/* Пока название проекта не правили руками, оно повторяет заголовок обложки
   (по нему же называются файлы при экспорте). */
function syncAutoName() {
  const p = state.project;
  if (!p || !p.nameAuto) return;
  p.name = autoName(p);
  if (document.activeElement !== el.docName) el.docName.value = p.name;
}

function setOpt(key, value, undoKey) {
  const slide = currentSlide();
  pushUndo(undoKey || ('opt:' + slide.id + ':' + key));
  slide.opts[key] = value;
  scheduleRender();
  scheduleSave();
}

/* Выключенная строка (дата, место, цена…) не рисуется, но текст в ней сохраняется. */
function setHidden(key, hidden) {
  const slide = currentSlide();
  pushUndo();
  const map = Object.assign({}, slide.opts.hidden);
  if (hidden) map[key] = true;
  else delete map[key];
  if (Object.keys(map).length) slide.opts.hidden = map;
  else delete slide.opts.hidden;
  scheduleRender();
  scheduleSave();
}

/* Доп. блок «заголовок + текст» (см. sectionCount в render.js). */
function addSection() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const n = sectionCount(slide, L);
  if (n >= (L.sections || 1)) return;
  pushUndo();
  slide.opts.sections = n + 1;
  // текст мог остаться от удалённого раньше блока — новый начинается с чистого
  for (const key of sectionKeys(n + 1)) { delete slide.fields[key]; setFmt(slide, key, null); }
  commit({ panel: true });
  // сразу в поле заголовка: клик ещё идёт, так что на iOS откроется клавиатура
  const input = el.panelBody.querySelector(`[data-field="title${n + 1}"]`);
  if (input) {
    input.focus({ preventScroll: true });
    input.closest('.subblock').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* Убрать блок k: следующие блоки сдвигаются на его место. */
function removeSection(k) {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const n = sectionCount(slide, L);
  if (k < 2 || k > n) return;
  pushUndo();
  for (let j = k; j < n; j++) {
    sectionKeys(j).forEach((key, idx) => {
      const from = sectionKeys(j + 1)[idx];
      if (slide.fields[from]) slide.fields[key] = slide.fields[from];
      else delete slide.fields[key];
      setFmt(slide, key, slide.fmt && slide.fmt[from]);
    });
  }
  for (const key of sectionKeys(n)) { delete slide.fields[key]; setFmt(slide, key, null); }
  if (n - 1 > 1) slide.opts.sections = n - 1;
  else delete slide.opts.sections;
  commit({ panel: true });
  say('Блок убран — вернуть можно кнопкой «Отменить»');
}

/* Выравнивание (opts.align) и расположение (opts.valign) текста. Выбрали то,
   что в макете, — настройку убираем: слайд снова следует макету (и при
   смене макета берёт его вариант). */
function setTextLayout(key, value) {
  const slide = currentSlide();
  pushUndo();
  putTextLayout(slide, key, value);
  commit({ panel: true });
}

function putTextLayout(slide, key, value) {
  const L = layoutOf(slide);
  const def = key === 'align' ? (L.align || 'left') : (L.valign || 'bottom');
  if (value === def) delete slide.opts[key];
  else slide.opts[key] = value;
}

function setTextLayoutAll() {
  const src = currentSlide();
  const a = textAlign(src, layoutOf(src)), v = textVAlign(src, layoutOf(src));
  pushUndo();
  for (const slide of state.project.slides) {
    putTextLayout(slide, 'align', a);
    putTextLayout(slide, 'valign', v);
  }
  commit({ panel: true });
  say('Выравнивание и расположение — как на этом слайде');
}

/* Логотип в одной из 8 точек (opts.logo); точка из макета — настройку убираем. */
function setLogoSpot(spot) {
  const slide = currentSlide();
  pushUndo();
  putLogoSpot(slide, spot);
  commit({ panel: true });
}

function putLogoSpot(slide, spot) {
  if (spot === (layoutOf(slide).logo || 'tr')) delete slide.opts.logo;
  else slide.opts.logo = spot;
}

function setLogoSpotAll() {
  const src = currentSlide();
  const spot = logoSpot(src, layoutOf(src));
  pushUndo();
  for (const slide of state.project.slides) putLogoSpot(slide, spot);
  commit({ panel: true });
  say('Логотип — ' + LOGO_SPOT_NAMES[spot].toLowerCase() + ' на всех слайдах');
}

/* Фирменный цвет #FEF3BD (см. brandTone в render.js) — на слайд или на все сразу. */
function setTone(on) {
  const slide = currentSlide();
  pushUndo();
  if (on) slide.opts.tone = 'brand';
  else delete slide.opts.tone;
  commit({ panel: true });
}

function setToneAll(on) {
  pushUndo();
  for (const slide of state.project.slides) {
    if (on) slide.opts.tone = 'brand';
    else delete slide.opts.tone;
  }
  commit({ panel: true });
  say(on ? 'Фирменный цвет — на всех слайдах' : 'Фирменный цвет убран со всех слайдов');
}

function setSize(group, value) {
  const slide = currentSlide();
  pushUndo('size:' + slide.id + ':' + group);
  slide.size[group] = value;
  scheduleRender();
  scheduleSave();
}

/* Фото: одно — на текущий слайд, несколько — по слайдам с местом под фото
   начиная с текущего; лишним фото создаются новые карточки рубрики. */
async function addPhotos(files, startIndex = state.current) {
  // HEIC с компьютера часто приходит без типа или как octet-stream — разберётся importPhoto
  const list = [...files].filter(f => f && (/^image\//.test(f.type || 'image/') || isVideoFile(f) ||
    /\.hei[cf]$/i.test(f.name || '') || f.type === 'application/octet-stream'));
  if (!list.length) return;
  const slides = state.project.slides;
  const targets = [];
  for (let i = startIndex; i < slides.length && targets.length < list.length; i++) {
    if (layoutOf(slides[i]).photo && (i === startIndex || !slides[i].photo)) targets.push(i);
  }
  pushUndo();
  stopPlayback();
  say(list.length > 1 ? `Загружаю ${list.length} файла(ов)…` : (isVideoFile(list[0]) ? 'Загружаю видео…' : 'Загружаю фото…'), 60000);
  let done = 0, failed = 0, longVideo = 0;
  const cardLayout = rubricOf().card;
  for (const file of list) {
    let id;
    try { id = await importMedia(file); } catch (err) { failed++; say(err.message); continue; }
    let idx = targets.shift();
    if (idx === undefined) {
      if (!LAYOUTS[cardLayout].photo) { failed++; continue; }
      const slide = newSlide(cardLayout);
      state.project.slides.push(slide);
      idx = state.project.slides.length - 1;
    }
    const target = state.project.slides[idx];
    target.photo = { id, zoom: 1, x: 0, y: 0 };
    const m = media.get(id);
    if (isVideoMedia(m)) {
      target.photo.start = 0;
      target.photo.end = Math.min(m.duration, videoLimit(target));
      if (m.duration > videoLimit(target) + 0.05) longVideo = videoLimit(target);
    }
    done++;
    if (idx === state.current) state.panHintAt = Date.now();
    commit({ structure: true });
  }
  if (longVideo) say(`Видео длиннее ${longVideo} с — взял первые ${longVideo} с, фрагмент поправьте в блоке «Видео»`, 6000);
  else if (done) say(done > 1 ? `Добавлено: ${done}` : 'Готово');
  else if (!failed) say('Нет слайдов с местом под фото');
  showClipStart(currentSlide());
}

function removePhoto(index = state.current) {
  const slide = state.project.slides[index];
  if (!slide.photo) return;
  stopPlayback();
  pushUndo();
  slide.photo = null;
  commit({ panel: true });
  invalidateThumbs();
}

function resetFrame(index = state.current) {
  const slide = state.project.slides[index];
  if (!slide.photo) return;
  pushUndo();
  Object.assign(slide.photo, { zoom: 1, x: 0, y: 0 });
  commit({ panel: true });
}

function pickPhotos(index = state.current) {
  const picker = el.filePicker;
  picker.value = '';
  picker.onchange = () => {
    if (picker.files && picker.files.length) addPhotos(picker.files, index);
  };
  picker.click();
}

/* «Уместить»: сначала уменьшаем текст до 80%, потом вместе с заголовком. */
function autoFit(index = state.current) {
  const slide = state.project.slides[index];
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = 4;
  const ctx = scratch.getContext('2d');
  const env = { assets, photo: null, transform: {}, ghost: false, k: 1, cardNo: cardNo(index) };
  const test = size => renderSlide(ctx, Object.assign({}, slide, { size }), env).overflow;
  let t = slide.size.title || 1, b = slide.size.body || 1;
  if (!test({ title: t, body: b })) return;
  pushUndo();
  while (test({ title: t, body: b }) && b > 0.8) b = Math.round((b - 0.02) * 100) / 100;
  while (test({ title: t, body: b }) && (t > FIT_MIN || b > FIT_MIN)) {
    t = Math.max(FIT_MIN, Math.round((t - 0.02) * 100) / 100);
    b = Math.max(FIT_MIN, Math.round((b - 0.02) * 100) / 100);
  }
  slide.size = { title: t, body: b };
  if (test(slide.size)) say('Даже мельче не помещается — сократите текст или перенесите часть на новый слайд');
  else say('Готово: кегль ' + Math.round(b * 100) + '%');
  commit({ panel: true });
}

/* -------------------------------------------------------------- отрисовка */

function envFor(slide, index, extra = {}) {
  const env = Object.assign({
    assets,
    photo: null,
    transform: slide.photo || {},
    ghost: true,
    k: 1,
    cardNo: index >= 0 && state.project ? cardNo(index) : 1,
  }, extra);
  if (!('photo' in extra)) {
    const m = slide.photo && media.get(slide.photo.id);
    env.photo = slidePhoto(slide, m, state.adjDrag || env.k * layoutOf(slide).W < ADJ_SMALL);
  }
  return env;
}

/* Рисует слайд в canvas шириной cssWidth (в CSS-пикселях). */
function paintSlide(canvas, slide, index, cssWidth, extra = {}) {
  const L = layoutOf(slide);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const hgt = Math.max(1, Math.round(w * L.H / L.W));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== hgt) canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const k = w / L.W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  return renderSlide(ctx, slide, envFor(slide, index, Object.assign({ k }, extra)));
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (state.screen !== 'editor' || !state.project) return;
    renderStage();
    scheduleThumbs();
  });
}

function stageBox() {
  const cs = getComputedStyle(el.stage);
  const w = el.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const hh = el.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return { w: Math.max(40, w), h: Math.max(40, hh) };
}

function renderStage() {
  const slide = currentSlide();
  if (!slide) return;
  const L = layoutOf(slide);
  const box = stageBox();
  // на телефоне оставляем место под стрелки листания по бокам (пока печатают — их нет)
  const sidePad = isWide() || el.editor.classList.contains('typing') || state.quick ? 0 : 36;
  const cssW = Math.floor(Math.min(box.w - sidePad * 2, box.h * L.W / L.H));
  const cssH = Math.round(cssW * L.H / L.W);
  el.stageCanvas.style.width = cssW + 'px';
  el.stageCanvas.style.height = cssH + 'px';
  const res = paintSlide(el.stageCanvas, slide, state.current, cssW);
  state.lastRender = { res, cssW, cssH, scale: cssW / L.W, layout: L };
  state.overflow[state.current] = Boolean(res.overflow);
  renderOverlay();
  renderTextMarks();
  state.glyphs = glyphIssues(slide, res.texts);
  syncGlyphWarnings();
  if (state.contrastFor !== slide.id) { state.contrast = []; state.contrastFor = slide.id; }
  renderWarnings();
  scheduleContrast();
  const n = state.project.slides.length;
  el.slideCounter.textContent = `${state.current + 1} / ${n}`;
  el.btnPrev.disabled = state.current === 0;
  el.btnNext.disabled = state.current >= n - 1;
  updateSlideDot(state.current);
}

const PAN_HINT_MS = 3400;
const PICTA_URL = 'https://picta.cc';

function renderOverlay() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const r = state.lastRender;
  const area = L.photo && r && r.res.photo;
  const hasPhoto = slide.photo && media.has(slide.photo.id);
  const loading = slide.photo && loadingMedia.has(slide.photo.id);
  let cx = 0, cy = 0;
  if (area) {
    cx = (area.cx !== undefined ? area.cx : area.x + area.w / 2) * r.scale;
    cy = (area.cy !== undefined ? area.cy : area.y + area.h / 2) * r.scale;
    // на обложке фото на весь слайд — кнопку ставим повыше, чтобы не спорить с текстом
    if (area.w >= L.W - 1 && area.h >= L.H - 1) cy = r.cssH * 0.4;
  }
  // Перерисовка идёт до 30 раз в секунду (видео играет) — пересоздавать кнопки
  // каждый кадр нельзя: по ним не попасть. Меняем DOM, только если что-то изменилось.
  const vm = slideMedia(slide);
  const key = JSON.stringify([slide.id, Boolean(area), hasPhoto, loading, Math.round(cx), Math.round(cy),
    isVideoMedia(vm) ? [Boolean(playback), clipOf(slide, vm).length.toFixed(1)] : 0,
    Date.now() - state.panHintAt < PAN_HINT_MS ? state.panHintAt : 0]);
  if (el.stageOverlay.dataset.key === key) return;
  el.stageOverlay.dataset.key = key;
  el.stageOverlay.replaceChildren();
  if (!area) return;
  if (!hasPhoto) {
    const pill = btn('photo-pill', 'image', loading ? 'Загружаю…' : (isWide() ? 'Добавить фото или видео' : 'Фото или видео'), e => {
      e.stopPropagation();
      pickPhotos();
    });
    // рядом — ссылка на Picta.cc (там можно подобрать или сделать фото)
    const picta = h('a', { class: 'photo-pill picta-pill', href: PICTA_URL, target: '_blank', rel: 'noopener',
      onclick: e => e.stopPropagation() }, iconSpan('picta'), document.createTextNode('Picta.cc'));
    const pills = h('div', { class: 'photo-pills' }, pill, picta);
    pills.style.left = cx + 'px';
    pills.style.top = cy + 'px';
    el.stageOverlay.append(pills);
  } else if (isVideoMedia(media.get(slide.photo.id))) {
    const m = media.get(slide.photo.id);
    const play = h('button', { type: 'button', class: 'media-pill', 'data-play-toggle': '1',
      onclick: e => { e.stopPropagation(); togglePlayback(); } });
    const clip = clipOf(slide, m);
    play.append(iconSpan(playback ? 'pause' : 'play'), document.createTextNode(playback ? 'Пауза' : formatTime(clip.length)));
    play.setAttribute('aria-label', playback ? 'Пауза' : 'Смотреть видео');
    el.stageOverlay.append(play);
    if (Date.now() - state.panHintAt < PAN_HINT_MS) {
      const hint = h('div', { class: 'pan-hint', text: isTouch() ? 'Двигайте видео пальцем, щипок — масштаб' : 'Тяните видео мышью, колесо — масштаб' });
      hint.style.animationDelay = -(Date.now() - state.panHintAt) + 'ms';
      el.stageOverlay.append(hint);
    }
  } else if (Date.now() - state.panHintAt < PAN_HINT_MS) {
    // подсказка переживает перерисовки: анимация продолжается с того же места
    const hint = h('div', { class: 'pan-hint', text: isTouch() ? 'Двигайте фото пальцем, щипок — масштаб' : 'Тяните фото мышью, колесо — масштаб' });
    hint.style.animationDelay = -(Date.now() - state.panHintAt) + 'ms';
    el.stageOverlay.append(hint);
  }
}

function photoUpscale(slide) {
  const r = state.lastRender;
  const m = slide.photo && media.get(slide.photo.id);
  if (!m || !r || !r.res.photo || !r.res.photo.applied) return 0;
  // applied.scale — единиц макета на пиксель превью; переводим в пиксели оригинала
  const perFull = r.res.photo.applied.scale * mediaSize(m.prev)[0] / m.w;
  const L = layoutOf(slide);
  const exportK = isVideoMedia(m) ? VIDEO_EXPORT_WIDTH / L.W : (L.W === 1440 ? state.exportWidth / 1440 : 1);
  return perFull * exportK;
}

function renderWarnings() {
  const slide = currentSlide();
  const items = [];
  const wide = isWide();
  if (state.overflow[state.current]) {
    items.push(h('span', { class: 'warn' }, iconSpan('warning'), wide ? 'Текст не помещается' : 'Не помещается'),
      btn('btn btn-sm btn-outline', 'magic-wand', 'Уместить', () => autoFit()));
  }
  const up = photoUpscale(slide);
  if (up > UPSCALE_WARN) items.push(h('span', { class: 'warn' }, iconSpan('warning'), wide ? 'Фото мелковато — будет мыльным' : 'Фото мелковато'));
  const glyphKeys = Object.keys(state.glyphs || {});
  if (glyphKeys.length) {
    const chars = [...new Set(glyphKeys.flatMap(k => state.glyphs[k].chars))].join(' ');
    items.push(h('span', { class: 'warn' }, iconSpan('warning'), wide ? `Нет в шрифте: ${chars}` : `Нет букв: ${chars}`));
  }
  const low = state.contrast || [];
  if (low.length) {
    items.push(h('span', { class: 'warn' }, iconSpan('warning'), wide ? 'Текст плохо читается на фото' : 'Плохо читается'));
    if (low.some(x => x.light)) items.push(btn('btn btn-sm btn-outline', null, 'Затемнить', () => fixContrast()));
  }
  const vm = slideMedia(slide);
  if (isVideoMedia(vm) && clipOf(slide, vm).length > videoLimit(slide) + 0.05) {
    items.push(h('span', { class: 'warn' }, iconSpan('warning'), `Видео длиннее ${videoLimit(slide)} с`));
  }
  if (!items.length) items.push(h('span', { class: 'warn ok' }, iconSpan('check'), 'Всё помещается'));
  el.warnings.replaceChildren(...items);
}

/* ------------------------------------------------------------ миниатюры */

const thumbSig = new Map();
let thumbTimer = null;
function invalidateThumbs() { thumbSig.clear(); }
function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderThumbs, 120);
}

function slideSig(slide, index) {
  const m = slide.photo && media.has(slide.photo.id);
  return JSON.stringify(slide) + '|' + m + '|' + state.fontsVersion + '|' + cardNo(index);
}

function renderThumbs() {
  if (!state.project) return;
  const items = el.slidesList.querySelectorAll('.slide-item');
  items.forEach(item => {
    const i = Number(item.dataset.index);
    const slide = state.project.slides[i];
    if (!slide) return;
    const sig = slideSig(slide, i);
    if (thumbSig.get(slide.id) === sig) return;
    const canvas = item.querySelector('canvas');
    const width = item.querySelector('.slide-thumb').clientWidth || 58;
    const res = paintSlide(canvas, slide, i, width);
    state.overflow[i] = Boolean(res.overflow);
    thumbSig.set(slide.id, sig);
    updateSlideDot(i);
  });
}

function updateSlideDot(i) {
  const item = el.slidesList.querySelector(`.slide-item[data-index="${i}"]`);
  if (!item) return;
  const dot = item.querySelector('.slide-dot');
  if (dot) dot.hidden = !state.overflow[i];
}

/* ----------------------------------------------------------- лента слайдов */

let dragFrom = null;

function renderSlidesList() {
  const p = state.project;
  if (!p) return;
  const frag = document.createDocumentFragment();
  p.slides.forEach((slide, i) => frag.append(buildSlideItem(slide, i)));
  const add = btn('slide-add', 'plus', isWide() ? 'Слайд' : 'Слайд', () => openLayoutSheet('add'));
  add.title = 'Добавить слайд';
  frag.append(add);
  if (p.slides.some(s => MIX_LAYOUTS.includes(s.layout))) {
    const mix = btn('slide-add slide-mix', 'shuffle', 'Перемешать', () => mixLayouts());
    mix.title = 'Перемешать макеты карточек';
    mix.setAttribute('aria-label', 'Перемешать макеты карточек');
    frag.append(mix);
  }
  el.slidesList.replaceChildren(frag);
  invalidateThumbs();
  syncSlideSelection(true);
  scheduleThumbs();
}

function buildSlideItem(slide, i) {
  const L = layoutOf(slide);
  const canvas = h('canvas');
  canvas.style.aspectRatio = `${L.W} / ${L.H}`;
  const item = h('div', { class: 'slide-item', 'data-index': String(i), role: 'button', tabindex: '0',
    'aria-label': `Слайд ${i + 1}: ${L.name}` },
    h('span', { class: 'slide-thumb' }, canvas,
      h('span', { class: 'slide-num', text: String(i + 1) }),
      isVideoMedia(slideMedia(slide)) ? h('span', { class: 'slide-video', title: 'Видео' }, iconSpan('film-strip')) : null,
      h('span', { class: 'slide-dot', hidden: !state.overflow[i] })),
    h('span', { class: 'slide-label', text: L.short + (slideTitle(slide) ? ' · ' + slideTitle(slide) : '') }),
    h('span', { class: 'slide-tools' },
      h('button', { type: 'button', title: 'Выше', icon: 'arrow-up', onclick: e => { e.stopPropagation(); moveSlide(i, i - 1); } }),
      h('button', { type: 'button', title: 'Ниже', icon: 'arrow-down', onclick: e => { e.stopPropagation(); moveSlide(i, i + 1); } }),
      h('button', { type: 'button', title: 'Дублировать', icon: 'copy', onclick: e => { e.stopPropagation(); duplicateSlide(i); } }),
      h('button', { type: 'button', class: 'del', title: 'Удалить', icon: 'trash', onclick: e => { e.stopPropagation(); deleteSlide(i); } })));

  item.addEventListener('click', () => {
    if (i === state.current && !isWide()) openSlideMenu(i);
    else selectSlide(i);
  });
  item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSlide(i); } });

  // перетаскивание для порядка (мышь) и файлы с диска
  item.draggable = !isTouch();
  item.addEventListener('dragstart', e => {
    dragFrom = i;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ок */ }
  });
  item.addEventListener('dragend', () => { dragFrom = null; clearDragMarks(); });
  item.addEventListener('dragover', e => {
    e.preventDefault();
    clearDragMarks();
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    hideDropHint();
    clearDragMarks();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) { selectSlide(i); addPhotos(files, i); return; }
    if (dragFrom !== null) moveSlide(dragFrom, i);
    dragFrom = null;
  });
  return item;
}

function clearDragMarks() {
  el.slidesList.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over'));
}

function slideTitle(slide) {
  const f = slide.fields;
  return (f.title || f.label || f.body || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function syncSlideSelection(scroll) {
  el.slidesList.querySelectorAll('.slide-item').forEach(item => {
    const on = Number(item.dataset.index) === state.current;
    item.classList.toggle('current', on);
    if (on && scroll) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/* ------------------------------------------- буквы, которых нет в шрифте */

/*
 * В BravoRG нет таджикской «ҷ», в Nauryz — «ӣ ӯ ҳ ҷ» и др. (FONT_MISSING
 * считает build.py по самим шрифтам). Такие буквы рисуются Inter (см.
 * FONT_FAMILY) и выбиваются из заголовка — предупреждаем под полем и в
 * плашке под превью. Шрифт, загруженный вручную, не проверяем.
 */
const FONT_NAMES = { title: 'BravoRG', display: 'Nauryz Red Keds', body: 'Inter' };

function glyphIssues(slide, texts) {
  const out = {};
  if (typeof FONT_MISSING === 'undefined' || !texts) return out;
  for (const t of texts) {
    if (t.ghost || state.userFonts[t.font]) continue;
    const missing = FONT_MISSING[t.font] || '';
    const text = (slide.fields && slide.fields[t.key]) || '';
    const chars = [...new Set([...text].filter(ch => missing.includes(ch)))];
    if (chars.length) out[t.key] = { chars, font: t.font };
  }
  return out;
}

/* Подсказка под полем — без пересборки формы (её не трогаем, пока печатают). */
function syncGlyphWarnings() {
  const issues = state.glyphs || {};
  el.panelBody.querySelectorAll('[data-field]').forEach(node => {
    const field = node.closest('.field');
    if (!field) return;
    const issue = issues[node.dataset.field];
    let note = field.querySelector(':scope > .glyph-warn');
    if (!issue) { if (note) note.hidden = true; return; }
    if (!note) { note = h('span', { class: 'field-hint glyph-warn' }); field.append(note); }
    note.hidden = false;
    const text = `В шрифте ${FONT_NAMES[issue.font] || issue.font} нет ${issue.chars.length > 1 ? 'букв' : 'буквы'} ${issue.chars.join(' ')} — на слайде ${issue.chars.length > 1 ? 'они будут' : 'она будет'} шрифтом Inter`;
    if (note.textContent !== text) note.textContent = text;
  });
}

/* ------------------------------------------------- контраст текста на фото */
/*
 * После отрисовки (с паузой, не на каждый кадр) рисуем слайд без текста в
 * маленький canvas (env.noText) и смотрим фон под каждым текстом: контраст
 * по WCAG между цветом текста и каждой точкой фона, берём худшие 15 % точек
 * — светлые пятна под белым заголовком мешают, даже если в среднем темно.
 * Ниже порога — «Текст плохо читается» и «Затемнить»: сначала затемнение
 * макета, потом, если мало, яркость самого фото (вкладка «Фото»).
 */
const CONTRAST_W = 360;          // ширина проверочного canvas, px
const CONTRAST_MIN = 2.6;        // крупный текст
const CONTRAST_MIN_SMALL = 3.2;  // мелкий: кегль меньше CONTRAST_SMALL_SIZE
const CONTRAST_SMALL_SIZE = 70;
const CONTRAST_PART = 0.15;      // доля худших точек под текстом
const CONTRAST_DELAY_MS = 250;
const CONTRAST_DIM_MAX = -60;    // «Затемнить» не делает фото темнее этого (яркость во вкладке «Фото»)
const SRGB_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
let contrastCanvas = null, contrastTimer = null;

function colorLum(css) {
  const m = /^#([0-9a-f]{6})$/i.exec(css || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return 0.2126 * SRGB_LINEAR[n >> 16] + 0.7152 * SRGB_LINEAR[(n >> 8) & 255] + 0.0722 * SRGB_LINEAR[n & 255];
}

/* Тексты слайда, которые плохо видно: [{ key, ratio, light }]. over — временно
   подменить opts / photo.adj (подбор затемнения). Только слайды с фото. */
function contrastIssues(slide, index, over = null) {
  const L = layoutOf(slide);
  const m = L.photo && slideMedia(slide);
  if (!m) return [];
  const s = over ? Object.assign({}, slide, {
    opts: Object.assign({}, slide.opts, over.opts),
    photo: Object.assign({}, slide.photo, over.adj ? { adj: over.adj } : {}),
  }) : slide;
  const c = contrastCanvas || (contrastCanvas = document.createElement('canvas'));
  const k = CONTRAST_W / L.W;
  c.width = CONTRAST_W;
  c.height = Math.round(L.H * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const res = renderSlide(ctx, s, envFor(s, index, { k, ghost: false, noText: true }));
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (const t of res.texts || []) {
    const tl = colorLum(t.color);
    if (tl === null || t.ghost || !t.w || !t.h) continue;
    const x0 = clamp(Math.floor(t.x * k), 0, c.width), x1 = clamp(Math.ceil((t.x + t.w) * k), 0, c.width);
    const y0 = clamp(Math.floor(t.y * k), 0, c.height), y1 = clamp(Math.ceil((t.y + t.h) * k), 0, c.height);
    const ratios = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * c.width + x) * 4;
        const bl = 0.2126 * SRGB_LINEAR[data[i]] + 0.7152 * SRGB_LINEAR[data[i + 1]] + 0.0722 * SRGB_LINEAR[data[i + 2]];
        ratios.push((Math.max(tl, bl) + 0.05) / (Math.min(tl, bl) + 0.05));
      }
    }
    if (!ratios.length) continue;
    ratios.sort((a, b) => a - b);
    const ratio = ratios[Math.floor(ratios.length * CONTRAST_PART)];
    const min = t.size < CONTRAST_SMALL_SIZE ? CONTRAST_MIN_SMALL : CONTRAST_MIN;
    if (ratio < min) out.push({ key: t.key, ratio: Math.round(ratio * 100) / 100, light: tl > 0.4 });
  }
  return out;
}

function scheduleContrast() {
  clearTimeout(contrastTimer);
  contrastTimer = setTimeout(() => {
    const slide = currentSlide();
    if (!slide || state.screen !== 'editor') return;
    let issues = [];
    try { issues = contrastIssues(slide, state.current); } catch { issues = []; }
    const sig = issues.map(x => x.key).join(',');
    if (sig === (state.contrast || []).map(x => x.key).join(',')) return;
    state.contrast = issues;
    renderWarnings();
  }, CONTRAST_DELAY_MS);
}

/* «Затемнить»: затемнение макета до максимума, потом — темнее само фото. */
function fixContrast() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const index = state.current;
  const ok = over => !contrastIssues(slide, index, over).some(x => x.light);
  const m = slideMedia(slide);
  const shade0 = shadeStrength(slide, L);
  const bright0 = (slide.photo.adj && slide.photo.adj.bright) || 0;
  pushUndo();
  let shade = shade0;
  let done = false;
  if (L.shade) {
    while (shade < 1 && !done) {
      shade = Math.min(1, Math.round((shade + 0.1) * 10) / 10);
      done = ok({ opts: { shade } });
    }
    slide.opts.shade = shade;
  }
  let bright = bright0;
  if (!done && m && !isVideoMedia(m)) {
    while (bright > CONTRAST_DIM_MAX && !done) {
      bright -= 10;
      done = ok({ opts: { shade }, adj: Object.assign({}, slide.photo.adj, { bright }) });
    }
    const adj = normalizeAdj(Object.assign({}, slide.photo.adj, { bright }));
    if (adj) slide.photo.adj = adj;
  }
  commit({ panel: true });
  const what = [shade > shade0 ? 'затемнение сильнее' : '', bright < bright0 ? 'фото темнее (вкладка «Фото»)' : ''].filter(Boolean).join(', ');
  say(done ? 'Готово: ' + what : 'Затемнил, сколько можно — попробуйте сдвинуть фото или выбрать другое', 5000);
}

/* ------------------------------------------------------ правка на превью */

/*
 * Нажали на текст на превью — правим это поле (render.js отдаёт, где лежит
 * текст каждого поля: res.texts). На телефоне — быстрая правка: под
 * превью остаётся только это поле (с «Ж / К»), ‹ › — соседний текст (и
 * соседний слайд), «Готово» — обратно к форме. Превью при этом крупнее,
 * редактируемый текст обведён, остальные — пунктиром: на них тоже можно
 * нажать. На компьютере — фокус в поле справа и рамка на превью.
 */
let stageTap = null;   // нажатие без сдвига (pointerup) — его разбирает click

function textAt(pt) {
  const r = state.lastRender;
  const texts = r && r.res.texts;
  if (!texts || !texts.length) return null;
  const pad = Math.max(16, 14 / r.scale);   // ≈ 14 px экрана вокруг текста — под палец
  let best = null, bestD = Infinity;
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    const d = Math.hypot(Math.max(t.x - pt.x, 0, pt.x - t.x - t.w), Math.max(t.y - pt.y, 0, pt.y - t.y - t.h));
    if (d < bestD) { bestD = d; best = t; }
  }
  return bestD <= pad ? best.key : null;
}

/* Поля слайда, которые есть на превью (выключенные строки — нет). */
function editableKeys(slide) {
  return slideFields(slide, layoutOf(slide)).filter(k => !isHidden(slide, k));
}

function editText(key) {
  if (isWide()) {
    if (state.tab !== 'slide') setTab('slide');
    focusField(key, true);
    return;
  }
  state.quick = key;
  renderPanel();
  focusField(key);
  scheduleRender();
}

function finishTextEdit() {
  if (!state.quick) return;
  state.quick = null;
  renderPanel();
  scheduleRender();
}

/* Быстрая правка жива, только пока поле есть на слайде и экран узкий. */
function syncQuick() {
  if (state.quick && (isWide() || !state.project || !editableKeys(currentSlide()).includes(state.quick))) state.quick = null;
  el.editor.classList.toggle('quick', Boolean(state.quick));
}

function focusField(key, scroll = false) {
  const node = el.panelBody.querySelector(`[data-field="${key}"]`);
  if (!node) return;
  node.focus({ preventScroll: true });
  // курсор — в конец текста
  if (node.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } else if (node.setSelectionRange) {
    try { node.setSelectionRange(node.value.length, node.value.length); } catch { /* type без выделения */ }
  }
  if (scroll) (node.closest('.field') || node).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ‹ › в быстрой правке: соседний текст, на краю — соседний слайд. */
function quickMove(dir) {
  const slides = state.project.slides;
  let i = state.current;
  let keys = editableKeys(slides[i]);
  let k = keys.indexOf(state.quick) + dir;
  while (k < 0 || k >= keys.length) {
    i += dir;
    if (i < 0 || i >= slides.length) return;
    keys = editableKeys(slides[i]);
    k = dir > 0 ? 0 : keys.length - 1;
  }
  state.quick = keys[k];
  if (i !== state.current) { selectSlide(i); return; }
  renderPanel();
  focusField(state.quick);
  scheduleRender();
}

function buildQuickForm() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const key = state.quick;
  const keys = editableKeys(slide);
  const k = keys.indexOf(key);
  const base = baseKey(key);
  const label = (FIELD_LABELS[L.id] && FIELD_LABELS[L.id][base]) || FIELD_INFO[base].label;
  const block = key.match(/\d+$/);
  const n = state.project.slides.length;
  const first = k <= 0 && !state.project.slides.slice(0, state.current).some(s => editableKeys(s).length);
  const last = k >= keys.length - 1 && !state.project.slides.slice(state.current + 1).some(s => editableKeys(s).length);
  const nav = (icon, title, dir, off) => {
    const b = h('button', { type: 'button', class: 'icon-btn sm', icon, title, 'aria-label': title, disabled: off });
    // нажатие не уводит фокус из поля — клавиатура не прячется
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => quickMove(dir));
    return b;
  };
  const field = buildField(slide, key, state.current);
  field.classList.add('quick-field');
  return h('div', { class: 'quick-form' },
    h('div', { class: 'quick-head' },
      nav('caret-left', 'Предыдущий текст', -1, first),
      h('div', { class: 'quick-title' },
        h('b', { text: label + (block ? ` · блок ${block[0]}` : '') }),
        h('span', { text: (n > 1 ? `слайд ${state.current + 1} из ${n} · ` : '') + `текст ${k + 1} из ${keys.length}` })),
      nav('caret-right', 'Следующий текст', 1, last),
      btn('btn btn-primary btn-sm quick-done', 'check', 'Готово', () => finishTextEdit())),
    field);
}

/* Рамки текстов на превью: в быстрой правке — все (пунктир) и текущий,
   иначе — только текст поля, в котором курсор. */
function renderTextMarks() {
  const r = state.lastRender;
  const box = el.textMarks;
  if (!box) return;
  const a = document.activeElement;
  const active = state.quick || (a && el.panelBody.contains(a) && a.dataset ? a.dataset.field : null);
  const texts = (r && r.res.texts) || [];
  const show = state.quick ? texts : texts.filter(t => t.key === active);
  while (box.children.length < show.length) box.append(h('div', { class: 'text-mark' }));
  [...box.children].forEach((node, i) => {
    const t = show[i];
    node.hidden = !t;
    if (!t) return;
    node.classList.toggle('on', t.key === active);
    const pad = 5;
    node.style.left = (t.x * r.scale - pad) + 'px';
    node.style.top = (t.y * r.scale - pad) + 'px';
    node.style.width = (t.w * r.scale + pad * 2) + 'px';
    node.style.height = (t.h * r.scale + pad * 2) + 'px';
  });
}

/* ---------------------------------------------------------- жесты превью */

const pointers = new Map();
let gesture = null;

function toDesign(clientX, clientY) {
  const rect = el.stageCanvas.getBoundingClientRect();
  const r = state.lastRender;
  return { x: (clientX - rect.left) / r.scale, y: (clientY - rect.top) / r.scale };
}

function inPhotoArea(pt) {
  const r = state.lastRender;
  const a = r && r.res.photo;
  if (!a) return false;
  if (a.shape === 'quad') {
    const ang = -a.deg * Math.PI / 180;
    const dx = pt.x - a.cx, dy = pt.y - a.cy;
    const lx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const ly = dx * Math.sin(ang) + dy * Math.cos(ang);
    return Math.abs(lx) <= a.w / 2 + 20 && Math.abs(ly) <= a.h / 2 + 20;
  }
  return pt.x >= a.x && pt.x <= a.x + a.w && pt.y >= a.y && pt.y <= a.y + a.h;
}

function pinchDistance() {
  const pts = [...pointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

/* Сдвиг кадра приводим к тому, что реально применилось (с учётом краёв). */
function settleFrame() {
  // досчитываем кадр синхронно — иначе возьмём сдвиг из предыдущего кадра анимации
  if (state.screen === 'editor') renderStage();
  const slide = currentSlide();
  const r = state.lastRender;
  if (slide && slide.photo && r && r.res.photo && r.res.photo.applied) {
    slide.photo.x = Math.round(r.res.photo.applied.x * 10) / 10;
    slide.photo.y = Math.round(r.res.photo.applied.y * 10) / 10;
  }
  scheduleSave();
  syncFrameInputs();
}

function wireStage() {
  const stage = el.stage;
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('button, a')) return;
    if (!state.lastRender) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* ок */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const slide = currentSlide();
    const hasPhoto = Boolean(slide.photo && media.has(slide.photo.id));
    if (pointers.size === 2 && hasPhoto) {
      gesture = { type: 'pinch', d0: pinchDistance(), zoom0: slide.photo.zoom || 1, undone: false };
      return;
    }
    if (pointers.size > 1) return;
    const pt = toDesign(e.clientX, e.clientY);
    const inside = inPhotoArea(pt);
    gesture = {
      type: hasPhoto && inside ? 'pan' : 'swipe',
      x0: e.clientX, y0: e.clientY, inside,
      tx: hasPhoto ? slide.photo.x : 0, ty: hasPhoto ? slide.photo.y : 0,
      moved: false, undone: false, mouse: e.pointerType === 'mouse',
    };
  });

  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    const slide = currentSlide();
    if (gesture.type === 'pinch' && pointers.size === 2) {
      if (!gesture.undone) { pushUndo('frame'); gesture.undone = true; }
      slide.photo.zoom = clamp(gesture.zoom0 * pinchDistance() / gesture.d0, 1, ZOOM_MAX);
      state.panHintAt = 0;
      scheduleRender();
      return;
    }
    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
    if (Math.hypot(dx, dy) > 5) gesture.moved = true;
    if (gesture.type === 'pan' && gesture.moved) {
      if (!gesture.undone) { pushUndo('frame'); gesture.undone = true; }
      const s = state.lastRender.scale;
      slide.photo.x = gesture.tx + dx / s;
      slide.photo.y = gesture.ty + dy / s;
      state.panHintAt = 0;
      scheduleRender();
    }
  });

  const end = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    const g = gesture;
    if (g.type === 'pinch') {
      if (pointers.size === 0) { gesture = null; settleFrame(); }
      return;
    }
    gesture = null;
    if (g.type === 'pan' && g.moved) { settleFrame(); return; }
    // нажатие без сдвига разбираем на click: там iOS разрешает открыть
    // клавиатуру и окно выбора файлов, и «лишний» click после перестройки
    // экрана не попадёт в поле, оказавшееся под пальцем
    if (!g.moved) { stageTap = { x: g.x0, y: g.y0, inside: g.inside, at: Date.now() }; return; }
    if (g.type === 'pan') return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.mouse && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      selectSlide(state.current + (dx < 0 ? 1 : -1));
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('click', e => {
    const t = stageTap;
    stageTap = null;
    if (!t || Date.now() - t.at > 800 || e.target.closest('button, a')) return;
    // нажали на текст — правим его; мимо текста в быстрой правке — выходим
    const key = textAt(toDesign(t.x, t.y));
    if (key) { editText(key); return; }
    if (state.quick) { finishTextEdit(); return; }
    // по пустому месту под фото — выбрать фото
    const slide = currentSlide();
    if (t.inside && layoutOf(slide).photo && !(slide.photo && media.has(slide.photo.id))) pickPhotos();
  });
  stage.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); gesture = null; });

  let wheelTimer = null;
  stage.addEventListener('wheel', e => {
    const slide = currentSlide();
    if (!slide || !slide.photo || !media.has(slide.photo.id)) return;
    e.preventDefault();
    pushUndo('frame');
    slide.photo.zoom = clamp((slide.photo.zoom || 1) * Math.exp(-e.deltaY * 0.0015), 1, ZOOM_MAX);
    state.panHintAt = 0;
    scheduleRender();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(settleFrame, 250);
  }, { passive: false });

  // файлы на превью
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', e => {
    e.preventDefault();
    stage.classList.remove('dragover');
    hideDropHint();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addPhotos(files, state.current);
  });

  if ('ResizeObserver' in window) new ResizeObserver(() => scheduleRender()).observe(stage);
  else window.addEventListener('resize', scheduleRender);
}

function hideDropHint() { el.dropHint.hidden = true; }

/* ------------------------------------------------------------ панель */

function renderPanel() {
  if (!state.project) return;
  syncQuick();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
  const body = el.panelBody;
  const keepScroll = body.dataset.for === state.tab + ':' + (currentSlide() || {}).id ? body.scrollTop : 0;
  body.replaceChildren(state.quick ? buildQuickForm() : state.tab === 'settings' ? buildSettingsForm()
    : state.tab === 'photo' ? buildAdjustForm() : buildSlideForm());
  body.dataset.for = state.tab + ':' + (currentSlide() || {}).id;
  body.scrollTop = keepScroll;
  body.querySelectorAll('textarea').forEach(autoGrow);
}

function setTab(tab) {
  state.tab = tab;
  renderPanel();
}

function section(title, action, ...children) {
  return h('div', { class: 'section' },
    title ? h('div', { class: 'section-title' }, h('span', { text: title }), action || null) : null,
    ...children);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = (ta.scrollHeight + 2) + 'px';
}

function buildField(slide, key, index) {
  const L = layoutOf(slide);
  const base = baseKey(key);   // title2 → title
  const info = FIELD_INFO[base];
  const label = (FIELD_LABELS[L.id] && FIELD_LABELS[L.id][base]) || info.label;
  const ph = placeholderFor(L, key, { cardNo: cardNo(index) }).replace(/\n/g, ' ');
  // full — жирный, курсив, цвет, маркер (поля Inter); color — только цвет и
  // маркер (заголовки: у BravoRG и Nauryz нет жирного и курсива)
  const mode = info.rich === true && !(L.plain || []).includes(base) ? 'full' : info.rich ? 'color' : null;
  if (mode) return buildRichField(slide, key, label, ph, info, mode);
  const value = slide.fields[key] || '';
  let control;
  if (info.multiline) {
    control = h('textarea', { class: 'textarea', rows: info.big ? 4 : 1, placeholder: ph, spellcheck: 'true',
      enterkeyhint: 'enter', autocapitalize: 'sentences' });
    control.value = value;
    control.addEventListener('input', () => { autoGrow(control); setField(key, control.value); });
  } else {
    control = h('input', { class: 'input', type: 'text', placeholder: ph, inputmode: info.inputmode || null,
      enterkeyhint: 'done', autocomplete: 'off' });
    control.value = value;
    control.addEventListener('input', () => setField(key, control.value));
    control.addEventListener('keydown', e => { if (e.key === 'Enter') control.blur(); });
  }
  control.dataset.field = key;
  const hint = info.hint ? h('span', { class: 'muted small', text: info.hint }) : null;
  if (!info.optional) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, h('span', { text: label }), hint),
      control);
  }
  // необязательная строка: переключатель «показывать» рядом с подписью.
  // Обёртка — div, а не label: иначе нажатие на подпись щёлкало бы переключатель.
  const shown = !isHidden(slide, key);
  const toggle = h('input', { type: 'checkbox', checked: shown, 'aria-label': `Показывать «${label}» на слайде` });
  const wrap = h('div', { class: 'field optional' + (shown ? '' : ' off') },
    h('span', { class: 'field-label' },
      h('span', { text: label }),
      h('span', { class: 'field-tools' }, hint, h('span', { class: 'switch sm' }, toggle, h('span')))),
    control);
  toggle.addEventListener('change', () => {
    setHidden(key, !toggle.checked);
    wrap.classList.toggle('off', !toggle.checked);
  });
  return wrap;
}

/* ------------------------------------------- текст с жирным и курсивом */

/*
 * «Текст» и «Подзаголовок» — поле contenteditable: выделил слово, нажал
 * «Ж» / «К» (или ⌘B / ⌘I) — на слайде оно жирное / курсивом. Вставка из
 * Заметок, Google Docs, Word, Telegram, сайтов сохраняет жирный, курсив и
 * обычный текст, остальное оформление отбрасывается. На слайде хранятся
 * обычный текст (fields) и отрезки начертаний (fmt). Начертание читаем из
 * computed style — неважно, какими тегами браузер разметил жирный.
 */
const BLOCK_TAGS = /^(DIV|P|LI|UL|OL|DL|DT|DD|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|THEAD|TBODY|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|FIGURE|FIGCAPTION|ADDRESS|HR)$/;
const SKIP_TAGS = /^(SCRIPT|STYLE|HEAD|TITLE|META|LINK|TEMPLATE|NOSCRIPT|IFRAME|OBJECT|SVG|IMG|VIDEO|AUDIO|CANVAS|BUTTON|SELECT|INPUT|TEXTAREA)$/;

function flagsToRuns(flags) {
  const runs = [];
  for (const f of flags) {
    const last = runs[runs.length - 1];
    if (last && last[1] === f) last[0]++;
    else runs.push([1, f]);
  }
  return runs;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Текст + отрезки → HTML для поля. explicit — обычный текст тоже в span
   с явным начертанием: при вставке внутрь жирного слова он не станет жирным. */
function richToHtml(text, runs, explicit = false) {
  let html = '';
  let i = 0;
  for (const [len, f] of runs || [[text.length, 0]]) {
    const piece = escapeHtml(text.slice(i, i + len)).replace(/\n/g, '<br>');
    i += len;
    if (!piece) continue;
    if (explicit) {
      html += `<span style="font-weight:${f & BOLD ? 700 : 400};font-style:${f & ITALIC ? 'italic' : 'normal'}">${piece}</span>`;
    } else {
      // цвет и маркер в поле — «экранными» цветами (UI_*): кремовый на белом
      // поле не прочитать; на слайде они станут фирменными (см. render.js)
      const open = (f & MARK ? `<span style="background-color:${UI_MARK}">` : '') +
        (f & RED ? `<span style="color:${UI_RED}">` : f & CREAM ? `<span style="color:${UI_CREAM}">` : '') +
        (f & BOLD ? '<b>' : '') + (f & ITALIC ? '<i>' : '');
      const close = (f & ITALIC ? '</i>' : '') + (f & BOLD ? '</b>' : '') +
        (f & (RED | CREAM) ? '</span>' : '') + (f & MARK ? '</span>' : '');
      html += open + piece + close;
    }
  }
  // пустая последняя строка видна в поле только с лишним <br>
  if (text.endsWith('\n') && !explicit) html += '<br>';
  return html;
}

/* Поле → { text, runs }. Строки: <br> и границы блоков (<div> от Enter). */
function readRich(root) {
  let text = '';
  const flags = [];
  let softBreak = false;   // последний \n — от <br>/конца блока: в конце поля он не виден
  const add = (str, f) => { text += str; for (let k = 0; k < str.length; k++) flags.push(f); };
  const flagsOf = node => {
    const cs = getComputedStyle(node);
    const w = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
    let f = (w >= 600 ? BOLD : 0) | (/italic|oblique/.test(cs.fontStyle) ? ITALIC : 0);
    if (sameColor(cs.color, UI_RED)) f |= RED;
    else if (sameColor(cs.color, UI_CREAM)) f |= CREAM;
    // фон не наследуется — ищем плашку маркера у предков до самого поля
    for (let n = node; n && n !== root; n = n.parentElement) {
      if (sameColor(getComputedStyle(n).backgroundColor, UI_MARK)) { f |= MARK; break; }
    }
    return f;
  };
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const str = child.data.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
        if (str) { add(str, flagsOf(child.parentElement)); softBreak = false; }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') { add('\n', 0); softBreak = true; continue; }
        const block = BLOCK_TAGS.test(child.tagName);
        if (block && text && !text.endsWith('\n')) add('\n', 0);
        walk(child);
        if (block && text && !text.endsWith('\n')) { add('\n', 0); softBreak = true; }
      }
    }
  };
  walk(root);
  if (softBreak && text.endsWith('\n')) { text = text.slice(0, -1); flags.pop(); }
  return { text, runs: flagsToRuns(flags) };
}

/*
 * HTML из буфера обмена → { text, runs }. Жирный/курсив — по тегам (b,
 * strong, h1–h6, i, em…), инлайн-стилям (Google Docs: <b style="font-weight:
 * normal"> + span с font-weight:700) и правилам из <style> по классам
 * (Pages, Word).
 */
function htmlToRich(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rules = [];
  for (const st of doc.querySelectorAll('style')) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(st.textContent.replace(/@import[^;]*;/g, ''));
      for (const r of sheet.cssRules) {
        if (r.selectorText && r.style && (r.style.fontWeight || r.style.fontStyle)) {
          rules.push([r.selectorText, r.style.fontWeight, r.style.fontStyle]);
        }
      }
    } catch { /* стили не разобрались — только теги и инлайн-стили */ }
  }
  const weightOf = v => {
    if (!v) return null;
    if (/bold/.test(v)) return true;
    if (/normal|lighter/.test(v)) return false;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n >= 600 : null;
  };
  const styleOf = v => (v ? /italic|oblique/.test(v) : null);
  const chars = [];
  const flags = [];
  const add = (str, f) => { for (const ch of str) { chars.push(ch); flags.push(f); } };
  // конец строки — пробелы после переноса не в счёт (между тегами блоков бывают пробелы и \n)
  const endsNl = () => {
    for (let k = chars.length - 1; k >= 0; k--) {
      if (chars[k] === '\n') return true;
      if (chars[k] !== ' ') return false;
    }
    return true;
  };
  const walk = (node, bold, italic, pre) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        let str = child.data;
        if (!pre) str = str.replace(/[ \t\r\n\f]+/g, ' ');
        // неразрывный пробел пока оставляем: пустой абзац Word — это <p>&nbsp;</p>
        add(str, (bold ? BOLD : 0) | (italic ? ITALIC : 0));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toUpperCase();
      if (SKIP_TAGS.test(tag)) continue;
      if (tag === 'BR') { add('\n', 0); continue; }
      let b = bold, it = italic;
      if (/^(B|STRONG|H[1-6]|TH|DT)$/.test(tag)) b = true;
      if (/^(I|EM|CITE|DFN|VAR)$/.test(tag)) it = true;
      for (const [sel, w, fs] of rules) {
        let hit = false;
        try { hit = child.matches(sel); } catch { /* селектор не понимаем */ }
        if (!hit) continue;
        const wb = weightOf(w); if (wb !== null) b = wb;
        const si = styleOf(fs); if (si !== null) it = si;
      }
      if (child.style) {
        const wb = weightOf(child.style.fontWeight); if (wb !== null) b = wb;
        const si = styleOf(child.style.fontStyle); if (si !== null) it = si;
      }
      const block = BLOCK_TAGS.test(tag);
      if (block && !endsNl()) add('\n', 0);
      if (tag === 'TD' || tag === 'TH') add(' ', 0);
      walk(child, b, it, pre || tag === 'PRE');
      if (block && !endsNl()) add('\n', 0);
    }
  };
  walk(doc.body || doc.documentElement, false, false, false);
  // пробелы у переносов строк, больше одной пустой строки подряд, края
  const outC = [], outF = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] === '\u00a0' ? ' ' : chars[i];
    if (ch === ' ' && (!outC.length || outC[outC.length - 1] === '\n' || outC[outC.length - 1] === ' ')) continue;
    if (ch === '\n') {
      while (outC.length && outC[outC.length - 1] === ' ') { outC.pop(); outF.pop(); }
      if (outC.length >= 2 && outC[outC.length - 1] === '\n' && outC[outC.length - 2] === '\n') continue;
      if (!outC.length) continue;
    }
    outC.push(ch); outF.push(flags[i]);
  }
  while (outC.length && /\s/.test(outC[outC.length - 1])) { outC.pop(); outF.pop(); }
  return { text: outC.join(''), runs: flagsToRuns(outF.map((f, i) => (outC[i] === '\n' ? 0 : f))) };
}

function buildRichField(slide, key, label, ph, info, mode = 'full') {
  const value = slide.fields[key] || '';
  let runs = fieldRuns(slide, key, value);
  if (runs && mode === 'color') runs = stripStyle(runs);
  const editor = h('div', { class: 'textarea rich' + (info.big ? ' big' : ''), contenteditable: 'true',
    role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, 'data-placeholder': ph,
    spellcheck: 'true', autocapitalize: 'sentences', enterkeyhint: 'enter' });
  editor.dataset.field = key;
  editor.dataset.mode = mode;
  editor.innerHTML = richToHtml(value, runs);
  const syncEmpty = () => editor.classList.toggle('is-empty', !editor.textContent);
  syncEmpty();
  const save = () => {
    const r = readRich(editor);
    syncEmpty();
    setRichField(key, r.text, mode === 'color' ? stripStyle(r.runs) : r.runs);
  };
  editor.addEventListener('input', save);
  editor.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    // подчёркивания на слайде нет — ⌘U не даём; у заголовков нет и ⌘B / ⌘I
    if ((e.metaKey || e.ctrlKey) && (k === 'u' || (mode === 'color' && (k === 'b' || k === 'i')))) e.preventDefault();
  });
  editor.addEventListener('paste', e => {
    const cd = e.clipboardData;
    const html = cd ? cd.getData('text/html') : '';
    const plain = cd ? cd.getData('text/plain') : '';
    const r = html ? htmlToRich(html) : null;
    const rich = Boolean(r && r.text.trim());
    // в буфере только картинка (или <img> со страницы) — её подхватит общий обработчик (фото)
    if (!rich && !plain.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    lastUndoKey = null;            // вставка — отдельный шаг отмены
    if (rich) document.execCommand('insertHTML', false, richToHtml(r.text, r.runs, true));
    else document.execCommand('insertText', false, plain.replace(/\r\n?/g, '\n'));
    save();
  });

  const tools = h('span', { class: 'fmt-tools', role: 'toolbar', 'aria-label': 'Начертание' },
    mode === 'full' ? fmtButton(editor, 'bold', 'Ж', 'Жирный (⌘B)') : null,
    mode === 'full' ? fmtButton(editor, 'italic', 'К', 'Курсив (⌘I)') : null,
    fmtButton(editor, 'red', null, 'Красный'),
    fmtButton(editor, 'cream', null, 'Кремовый'),
    fmtButton(editor, 'marker', 'А', 'Маркер — кремовая плашка за словами'),
    fmtButton(editor, 'plain', 'Обычный', 'Обычный — убрать выделение'));
  const tip = mode === 'full' ? 'Выделите слова и нажмите «Ж», «К», цвет или маркер.' : 'Выделите слова и выберите цвет или маркер.';
  return h('div', { class: 'field rich-field' },
    h('span', { class: 'field-label' }, h('span', { text: label }), tools),
    editor,
    h('span', { class: 'field-hint', text: (info.hint ? info.hint + '. ' : '') + tip }));
}

/* Экранные цвета выделения в поле (на слайде — ACCENT_RED / BRAND_CREAM). */
const UI_RED = '#d1343a', UI_CREAM = '#c79a16', UI_MARK = '#fef3bd';

function rgbOf(color) {
  const m = String(color || '').match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(',');
  const r = String(color || '').match(/rgba?\(([^)]+)\)/);
  if (!r) return '';
  const parts = r[1].split(',').map(v => parseFloat(v));
  if (parts.length > 3 && parts[3] === 0) return '';   // прозрачный
  return parts.slice(0, 3).map(Math.round).join(',');
}
function sameColor(a, b) { const x = rgbOf(a); return Boolean(x) && x === rgbOf(b); }

/* Без жирного и курсива (поля заголовков). */
function stripStyle(runs) {
  return flagsToRuns(runs.flatMap(([len, f]) => Array(len).fill(f & ~(BOLD | ITALIC))));
}

/* Кнопка начертания: фокус и выделение остаются в поле. */
function fmtButton(editor, cmd, text, title) {
  const b = h('button', { type: 'button', class: 'fmt-btn fmt-' + cmd, text, title, 'aria-label': title,
    'data-cmd': cmd, 'aria-pressed': cmd === 'plain' ? null : 'false' });
  if (cmd === 'red' || cmd === 'cream') b.append(h('span', { class: 'fmt-dot', 'aria-hidden': 'true' }));
  const keep = e => e.preventDefault();
  b.addEventListener('mousedown', keep);
  b.addEventListener('pointerdown', keep);
  b.addEventListener('click', () => applyFormat(editor, cmd));
  return b;
}

/* fromPopup — нажали во всплывающей панели у выделения: если касание успело
   сбросить выделение, возвращаем последнее непустое (editor._sel). */
function applyFormat(editor, cmd, fromPopup = false) {
  const sel = window.getSelection();
  const lost = document.activeElement !== editor || !sel.rangeCount || !editor.contains(sel.anchorNode);
  if (lost || (fromPopup && sel.isCollapsed)) {
    if (document.activeElement !== editor) editor.focus({ preventScroll: true });
    const r = fromPopup ? editor._sel : editor._range;
    if (r) {
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  lastUndoKey = null;   // смена начертания — отдельный шаг отмены
  const css = on => { try { document.execCommand('styleWithCSS', false, on); } catch { /* не везде есть */ } };
  const fore = () => document.queryCommandValue('foreColor');
  const back = () => document.queryCommandValue('hiliteColor') || document.queryCommandValue('backColor');
  const base = getComputedStyle(editor).color;
  css(false);
  if (cmd === 'plain') {
    document.execCommand('removeFormat');
    if (document.queryCommandState('bold')) document.execCommand('bold');
    if (document.queryCommandState('italic')) document.execCommand('italic');
    css(true);
    if (sameColor(fore(), UI_RED) || sameColor(fore(), UI_CREAM)) document.execCommand('foreColor', false, base);
    if (sameColor(back(), UI_MARK)) document.execCommand('hiliteColor', false, 'transparent');
    css(false);
  } else if (cmd === 'red' || cmd === 'cream') {
    // второе нажатие на тот же цвет — снимает его
    const want = cmd === 'red' ? UI_RED : UI_CREAM;
    css(true);
    document.execCommand('foreColor', false, sameColor(fore(), want) ? base : want);
    css(false);
  } else if (cmd === 'marker') {
    css(true);
    document.execCommand('hiliteColor', false, sameColor(back(), UI_MARK) ? 'transparent' : UI_MARK);
    css(false);
  } else {
    document.execCommand(cmd);
  }
  editor.dispatchEvent(new Event('input'));
  syncFmtButtons();
}

/* Подсветка «Ж» / «К» по месту курсора; запоминаем выделение, чтобы
   вернуть его, если нажатие на кнопку всё-таки сняло фокус (iOS). */
function syncFmtButtons() {
  scheduleFmtPopup();
  const ed = document.activeElement;
  if (!ed || !ed.classList || !ed.classList.contains('rich')) return;
  const sel = window.getSelection();
  if (sel.rangeCount && ed.contains(sel.anchorNode)) {
    ed._range = sel.getRangeAt(0).cloneRange();
    if (!sel.isCollapsed) ed._sel = ed._range;
  }
  syncFmtStates(ed);
}

/* «Ж», «К», цвет, маркер горят, если у курсора / выделения они есть. */
function syncFmtStates(ed) {
  const wrap = ed.closest('.rich-field');
  const val = c => { try { return document.queryCommandValue(c); } catch { return ''; } };
  for (const cmd of ['bold', 'italic', 'red', 'cream', 'marker']) {
    let on = false;
    try {
      if (cmd === 'red') on = sameColor(val('foreColor'), UI_RED);
      else if (cmd === 'cream') on = sameColor(val('foreColor'), UI_CREAM);
      else if (cmd === 'marker') on = sameColor(val('hiliteColor') || val('backColor'), UI_MARK);
      else on = document.queryCommandState(cmd);
    } catch { /* нет */ }
    for (const b of [wrap && wrap.querySelector('.fmt-' + cmd), fmtPopup && fmtPopup.querySelector('.fmt-' + cmd)]) {
      if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    }
  }
}

/*
 * Всплывающая панель «Ж · К · Обычный» у выделенного текста — на телефоне.
 * В системное меню (Вырезать / Копировать / Вставить) свои пункты не
 * добавить, а наши кнопки над полем оно закрывает. Поэтому своя панель:
 * под выделением (системное меню встаёт над ним, «ручки» — прямо под
 * текстом), а если снизу не помещается — над системным меню или у нижнего
 * края видимой области. Кнопки срабатывают на касание (pointerdown) и
 * отменяют его — так выделение и клавиатура остаются.
 */
let fmtPopup = null;
let fmtPopupEditor = null;
let fmtPopupFrame = 0;
const POPUP_BELOW = 34;   // от низа выделения: место под «ручки»
const POPUP_ABOVE = 64;   // над выделением: место под системное меню

function buildFmtPopup() {
  fmtPopup = h('div', { class: 'fmt-pop', role: 'toolbar', 'aria-label': 'Начертание', hidden: true });
  for (const [cmd, text, title] of [['bold', 'Ж', 'Жирный'], ['italic', 'К', 'Курсив'], ['red', null, 'Красный'],
    ['cream', null, 'Кремовый'], ['marker', 'А', 'Маркер'], ['plain', 'Обычный', 'Обычный — убрать выделение']]) {
    const b = h('button', { type: 'button', class: 'fmt-pop-btn fmt-' + cmd, text, title, 'aria-label': title,
      'aria-pressed': cmd === 'plain' ? null : 'false' });
    if (cmd === 'red' || cmd === 'cream') b.append(h('span', { class: 'fmt-dot', 'aria-hidden': 'true' }));
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (fmtPopupEditor) applyFormat(fmtPopupEditor, cmd, true);
    });
    // без этого касание снимает выделение и уводит фокус (Android, iOS)
    b.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    b.addEventListener('mousedown', e => e.preventDefault());
    fmtPopup.append(b);
  }
  document.body.append(fmtPopup);
}

function scheduleFmtPopup() {
  if (fmtPopupFrame) return;
  fmtPopupFrame = requestAnimationFrame(() => { fmtPopupFrame = 0; placeFmtPopup(); });
}

function hideFmtPopup() {
  if (fmtPopup && !fmtPopup.hidden) fmtPopup.hidden = true;
  fmtPopupEditor = null;
}

function placeFmtPopup() {
  const ed = document.activeElement;
  const sel = window.getSelection();
  const ok = isTouch() && ed && ed.classList && ed.classList.contains('rich') && sel.rangeCount &&
    !sel.isCollapsed && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode);
  if (!ok) { hideFmtPopup(); return; }
  const box = sel.getRangeAt(0).getBoundingClientRect();
  if (!box.width && !box.height) { hideFmtPopup(); return; }
  if (!fmtPopup) buildFmtPopup();
  fmtPopupEditor = ed;
  // у заголовков нет «Ж» и «К»
  const colorOnly = ed.dataset.mode === 'color';
  fmtPopup.querySelectorAll('.fmt-bold, .fmt-italic').forEach(b => { b.hidden = colorOnly; });
  fmtPopup.hidden = false;
  syncFmtStates(ed);
  const pw = fmtPopup.offsetWidth, ph = fmtPopup.offsetHeight;
  // видимая область (над клавиатурой) — в координатах страницы, как у position: fixed
  const vv = window.visualViewport;
  const vTop = vv ? vv.offsetTop : 0, vLeft = vv ? vv.offsetLeft : 0;
  const vBottom = vTop + (vv ? vv.height : window.innerHeight);
  const vRight = vLeft + (vv ? vv.width : window.innerWidth);
  let top = box.bottom + POPUP_BELOW;
  if (top + ph > vBottom - 6) {
    top = box.top - POPUP_ABOVE - ph;
    if (top < vTop + 6) top = vBottom - ph - 6;
  }
  const left = Math.min(Math.max((box.left + box.right) / 2 - pw / 2, vLeft + 8), vRight - pw - 8);
  fmtPopup.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function rangeRow(label, { min, max, step = 1, value, unit = '', onInput, onChange, key }) {
  const out = h('output', { text: value + unit });
  const input = h('input', { type: 'range', min, max, step, value, 'data-key': key || null, 'aria-label': label });
  input.addEventListener('input', () => { out.textContent = input.value + unit; onInput(Number(input.value)); });
  if (onChange) input.addEventListener('change', () => onChange(Number(input.value)));
  return h('div', { class: 'range-row' }, h('label', { text: label }), input, out);
}

function switchRow(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label });
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'switch-row' }, h('span', { class: 'lbl', text: label }),
    h('span', { class: 'switch' }, input, h('span')));
}

const LOGO_SPOT_NAMES = {
  tl: 'Слева сверху', tc: 'По центру сверху', tr: 'Справа сверху',
  ml: 'Слева посередине', mr: 'Справа посередине',
  bl: 'Слева снизу', bc: 'По центру снизу', br: 'Справа снизу',
};

/* Схема слайда с 8 точками: углы и середины сторон (у рилс — повыше). */
function logoPicker(L, value, onPick) {
  const grid = h('div', { class: 'logo-pick' + (L.H > L.W * 1.5 ? ' tall' : ''), role: 'radiogroup', 'aria-label': 'Где логотип' });
  for (const spot of ['tl', 'tc', 'tr', 'ml', null, 'mr', 'bl', 'bc', 'br']) {
    if (!spot) { grid.append(h('span', { 'aria-hidden': 'true' })); continue; }
    const on = spot === value;
    const b = h('button', { type: 'button', role: 'radio', class: on ? 'on' : '', 'aria-checked': String(on),
      'aria-label': LOGO_SPOT_NAMES[spot], title: LOGO_SPOT_NAMES[spot] }, h('span'));
    b.addEventListener('click', () => onPick(spot));
    grid.append(b);
  }
  return grid;
}

function segControl(options, value, onPick, groupLabel) {
  const icons = options.some(o => o[2]);
  const seg = h('div', { class: 'seg' + (icons ? ' icons' : ''), role: 'radiogroup', 'aria-label': groupLabel || null });
  for (const [val, label, icon] of options) {
    // с иконкой подпись уходит в title / aria-label
    const b = h('button', { type: 'button', class: val === value ? 'on' : '', role: 'radio',
      text: icon ? null : label, icon: icon || null, title: icon ? label : null, 'aria-label': icon ? label : null,
      'aria-checked': String(val === value) });
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      onPick(val);
    });
    seg.append(b);
  }
  return seg;
}

function buildSlideForm() {
  const p = state.project;
  const slide = currentSlide();
  const i = state.current;
  const L = layoutOf(slide);
  const root = h('div', { class: 'slide-form' });

  root.append(h('div', { class: 'form-head' },
    h('div', { class: 'grow' },
      h('div', { class: 'form-kicker', text: `Слайд ${i + 1} из ${p.slides.length}` }),
      h('div', { class: 'form-title', text: L.name })),
    btn('btn btn-sm btn-outline', 'layout', 'Макет', () => openLayoutSheet('change'))));

  // тексты
  const fields = h('div', { class: 'section' });
  for (const key of L.fields) fields.append(buildField(slide, key, i));
  // доп. блоки «заголовок + текст» (карточка интервью)
  if (L.sections > 1) {
    const n = sectionCount(slide, L);
    for (let k = 2; k <= n; k++) {
      const remove = h('button', { type: 'button', class: 'icon-btn sm', icon: 'x',
        title: 'Убрать блок', 'aria-label': `Убрать блок ${k}` });
      remove.addEventListener('click', () => removeSection(k));
      fields.append(h('div', { class: 'subblock' },
        h('div', { class: 'subblock-head' }, h('span', { text: `Блок ${k}` }), remove),
        ...sectionKeys(k).map(key => buildField(slide, key, i))));
    }
    if (n < L.sections) {
      fields.append(btn('btn btn-outline btn-sm add-section', 'plus', 'Ещё заголовок и текст', () => addSection()));
    }
  }
  root.append(fields);

  // фото
  if (L.photo) root.append(buildPhotoSection(slide));

  // оформление
  const look = [];
  // выравнивание и расположение текста (по умолчанию — как в макете)
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  look.push(h('div', { class: 'look-row' }, h('span', { class: 'lbl', text: 'Выравнивание' }),
    segControl([['left', 'По левому краю', 'text-align-left'], ['center', 'По центру', 'text-align-center'],
      ['right', 'По правому краю', 'text-align-right'], ['justify', 'По ширине', 'text-align-justify']],
    align, v => setTextLayout('align', v), 'Выравнивание текста')));
  look.push(h('div', { class: 'look-row' }, h('span', { class: 'lbl', text: 'Расположение' }),
    segControl([['top', 'Сверху'], ['middle', 'Центр'], ['bottom', 'Снизу']],
      valign, v => setTextLayout('valign', v), 'Расположение текста')));
  // «на всех» — только если на этом слайде меняли вручную (у разных макетов свои умолчания)
  if ((slide.opts.align || slide.opts.valign) &&
      state.project.slides.some(x => textAlign(x, layoutOf(x)) !== align || textVAlign(x, layoutOf(x)) !== valign)) {
    look.push(btn('btn btn-ghost btn-sm look-all', null, 'Так же на всех слайдах', () => setTextLayoutAll()));
  }
  // логотип: одна из 8 точек на схеме слайда
  const spot = logoSpot(slide, L);
  look.push(h('div', { class: 'look-row logo-row' },
    h('span', { class: 'lbl-col' }, h('span', { class: 'lbl', text: 'Логотип' }),
      h('span', { class: 'field-hint', text: LOGO_SPOT_NAMES[spot] })),
    logoPicker(L, spot, v => setLogoSpot(v))));
  if (slide.opts.logo && state.project.slides.some(x => logoSpot(x, layoutOf(x)) !== spot)) {
    look.push(btn('btn btn-ghost btn-sm look-all', null, 'Логотип так же на всех слайдах', () => setLogoSpotAll()));
  }
  const tone = switchRow('Фирменный цвет', brandTone(slide), v => setTone(v));
  tone.querySelector('.lbl').prepend(h('span', { class: 'swatch', 'aria-hidden': 'true' }));
  look.push(tone, h('p', { class: 'field-hint tone-hint', text: L.photo && L.shade
    ? 'Текст и плашки — кремовым #FEF3BD, логотип остаётся белым.'
    : 'Фон карточки — кремовый #FEF3BD, текст остаётся тёмным.' }));
  // предлагаем распространить выбор, только если другие слайды отличаются
  const on = brandTone(slide);
  if (state.project.slides.some(x => brandTone(x) !== on)) {
    look.push(btn('btn btn-ghost btn-sm', null, on ? 'Сделать так на всех слайдах' : 'Убрать со всех слайдов', () => setToneAll(on)));
  }
  if (L.arrow) look.push(switchRow('Стрелка «листай»', arrowOn(slide, L), v => setOpt('arrow', v)));
  if (L.shade) {
    const v = Math.round(shadeStrength(slide, L) * 100);
    look.push(rangeRow('Затемнение', { min: 0, max: 100, value: v, unit: '%', key: 'shade',
      onInput: x => setOpt('shade', x / 100, 'shade:' + slide.id) }));
  }
  if (look.length) root.append(section('Оформление', null, ...look));

  // кегль
  const groups = new Set(L.fields.map(k => FIELD_INFO[k].group));
  const sizeRows = [];
  if (groups.has('title')) sizeRows.push(rangeRow('Заголовок', { min: 50, max: 140, value: Math.round((slide.size.title || 1) * 100), unit: '%', key: 'size-title', onInput: x => setSize('title', x / 100) }));
  if (groups.has('body')) sizeRows.push(rangeRow('Текст', { min: 50, max: 140, value: Math.round((slide.size.body || 1) * 100), unit: '%', key: 'size-body', onInput: x => setSize('body', x / 100) }));
  const resetSize = btn('btn btn-ghost btn-sm', null, 'Как в макете', () => {
    pushUndo(); slide.size = {}; commit({ panel: true });
  });
  root.append(section('Размер текста', resetSize, ...sizeRows,
    btn('btn btn-outline btn-sm', 'magic-wand', 'Уместить, если не влезает', () => autoFit())));

  // слайд
  const wide = isWide();
  // на телефоне — строкой иконок (то же есть в меню по нажатию на миниатюру)
  const act = (cls, icon, label, fn) => btn(cls, icon, label, fn, label);
  root.append(section('Слайд', null, h('div', { class: 'actions-grid' },
    act('btn btn-outline', 'plus', 'Новый слайд', () => openLayoutSheet('add')),
    act('btn btn-outline', 'copy', 'Дублировать', () => duplicateSlide()),
    act('btn btn-outline', wide ? 'arrow-up' : 'arrow-left', wide ? 'Выше' : 'Левее', () => moveSlide(i, i - 1)),
    act('btn btn-outline', wide ? 'arrow-down' : 'arrow-right', wide ? 'Ниже' : 'Правее', () => moveSlide(i, i + 1)),
    act('btn btn-danger', 'trash', 'Удалить слайд', () => deleteSlide()))));

  return root;
}

function buildPhotoSection(slide) {
  const m = slideMedia(slide);
  const video = isVideoMedia(m);
  const thumb = h('span', { class: 'photo-thumb' });
  if (m) {
    try {
      const c = downscale(m.prev, 160);
      c.style.width = '100%'; c.style.height = '100%'; c.style.objectFit = 'cover'; c.style.display = 'block';
      thumb.append(c);
    } catch { /* кадр ещё не готов */ }
  }
  const actions = h('div', { class: 'photo-actions' },
    btn('btn btn-primary btn-sm', 'image', m ? 'Заменить' : 'Выбрать фото или видео', () => pickPhotos()),
    m ? btn('btn btn-ghost btn-sm', 'x', 'Убрать', () => removePhoto()) : null);
  const rows = [h('div', { class: 'photo-row' }, thumb, actions)];
  if (video) rows.push(...buildTrimRows(slide, m));
  if (m) {
    rows.push(h('div', { style: 'height:12px' }));
    rows.push(rangeRow('Масштаб', { min: 100, max: ZOOM_MAX * 100, value: Math.round((slide.photo.zoom || 1) * 100), unit: '%', key: 'zoom',
      onInput: x => { pushUndo('frame'); slide.photo.zoom = x / 100; scheduleRender(); },
      onChange: () => settleFrame() }));
    rows.push(h('p', { class: 'field-hint photo-hint', text: isTouch()
      ? 'Кадр двигается пальцем прямо на превью, щипок двумя пальцами — масштаб.'
      : 'Кадр двигается мышью прямо на превью, колесо — масштаб. Фото можно вставить через ⌘V или перетащить.' }));
  } else {
    rows.push(h('p', { class: 'field-hint photo-hint', style: 'margin-top:10px', text: 'Можно выбрать сразу несколько — разложатся по слайдам, лишним добавятся новые карточки.' }));
  }
  return section(video ? 'Видео' : 'Фото или видео', m ? btn('btn btn-ghost btn-sm', null, 'Сбросить кадр', () => resetFrame()) : null, ...rows);
}

/* Начало и конец фрагмента: два ползунка с шагом 0,1 с. Пока тянешь —
   превью показывает кадр на границе, которую двигаешь. */
function buildTrimRows(slide, m) {
  const d = m.duration || 0;
  const clip = clipOf(slide, m);
  const limit = videoLimit(slide);
  const lengthNote = h('p', { class: 'field-hint' });
  const syncNote = () => {
    const c = clipOf(slide, m);
    lengthNote.textContent = `Фрагмент ${formatTime(c.length)} из ${formatTime(d)}` +
      (c.length > limit + 0.05 ? ` — для Instagram длиннее ${limit} с не получится` : '');
    lengthNote.classList.toggle('warn-text', c.length > limit + 0.05);
  };
  const row = (label, key, value) => {
    const out = h('output', { text: formatTime(value) });
    const input = h('input', { type: 'range', min: 0, max: d.toFixed(2), step: 0.1, value: value.toFixed(2), 'aria-label': label });
    input.addEventListener('input', () => {
      pushUndo('trim:' + slide.id);
      stopPlayback();
      let t = Number(input.value);
      if (key === 'start') {
        t = Math.min(t, d - MIN_CLIP);
        slide.photo.start = t;
        if (clipOf(slide, m).end - t < MIN_CLIP) slide.photo.end = Math.min(d, t + MIN_CLIP);
      } else {
        t = Math.max(t, MIN_CLIP);
        slide.photo.end = t;
        if (t - (slide.photo.start || 0) < MIN_CLIP) slide.photo.start = Math.max(0, t - MIN_CLIP);
      }
      out.textContent = formatTime(t);
      seekVideo(m.prev, key === 'start' ? clipOf(slide, m).start : Math.max(0, clipOf(slide, m).end - 0.05));
      syncNote();
      scheduleSave();
    });
    input.addEventListener('change', () => { showClipStart(slide); renderPanel(); });
    return h('div', { class: 'range-row' }, h('label', { text: label }), input, out);
  };
  syncNote();
  const play = h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-play-toggle': '1', onclick: () => togglePlayback() });
  play.append(iconSpan(playback ? 'pause' : 'play'), document.createTextNode(playback ? 'Пауза' : 'Смотреть'));
  return [
    h('div', { style: 'height:14px' }),
    row('Начало', 'start', clip.start),
    row('Конец', 'end', clip.end),
    h('div', { class: 'trim-foot' }, play, lengthNote),
  ];
}

function syncFrameInputs() {
  const slide = currentSlide();
  const zoom = el.panelBody.querySelector('input[data-key="zoom"]');
  if (zoom && slide && slide.photo) {
    zoom.value = Math.round((slide.photo.zoom || 1) * 100);
    const out = zoom.parentElement.querySelector('output');
    if (out) out.textContent = zoom.value + '%';
  }
}

/* -------------------------------------------- вкладка «Фото»: коррекция */

const ADJ_ROWS = [['bright', 'Яркость'], ['contrast', 'Контраст'], ['sat', 'Насыщенность'], ['warm', 'Тепло']];
const ADJ_PRESETS = [
  ['Ч/б', { sat: -100, contrast: 15 }],
  ['Тёплое', { warm: 45, sat: 10 }],
  ['Холодное', { warm: -45 }],
  ['Сочное', { contrast: 20, sat: 30 }],
  ['Светлее', { bright: 30, contrast: -10 }],
  ['Мягкое', { bright: 10, contrast: -30, sat: -20 }],
];

function setAdj(slide, next, undoKey) {
  pushUndo(undoKey || null);
  const a = normalizeAdj(next);
  if (a) slide.photo.adj = a;
  else delete slide.photo.adj;
  scheduleRender();
  scheduleSave();
}

function isPhotoSlide(slide) {
  const m = layoutOf(slide).photo && slideMedia(slide);
  return Boolean(m && !isVideoMedia(m));
}

/*
 * Поворот и отражение: photo.rot (0/90/180/270), photo.tilt (наклон ±45°),
 * photo.flipH / photo.flipV. Рисует render.js (drawCoverTurned) — прямо при
 * отрисовке, поэтому работает и для видео. Отражение — в осях экрана; при
 * нечётном числе отражений поворот фото выглядит зеркально, поэтому
 * «повернуть вправо» и ползунок наклона учитывают знак (turnSign).
 */
const TILT_MAX = 45;

function normalizeTurn(ph) {
  const out = {};
  const rot = ((Math.round((Number(ph.rot) || 0) / 90) * 90) % 360 + 360) % 360;
  const tilt = Math.round(clamp(Number(ph.tilt) || 0, -TILT_MAX, TILT_MAX) * 10) / 10;
  if (rot) out.rot = rot;
  if (tilt) out.tilt = tilt;
  if (ph.flipH) out.flipH = true;
  if (ph.flipV) out.flipV = true;
  return out;
}
function turnSign(ph) { return (ph.flipH ? -1 : 1) * (ph.flipV ? -1 : 1); }
function hasTurn(ph) { return Boolean(ph && (ph.rot || ph.tilt || ph.flipH || ph.flipV)); }

function buildTurnSection(slide) {
  const ph = slide.photo;
  const act = (icon, label, fn) => btn('btn btn-outline btn-sm', icon, label, fn, label);
  const apply = (fn, key) => {
    pushUndo(key || null);
    fn(ph);
    const turn = normalizeTurn(ph);
    for (const k of ['rot', 'tilt', 'flipH', 'flipV']) delete ph[k];
    Object.assign(ph, turn);
    scheduleRender();
    scheduleSave();
  };
  const buttons = h('div', { class: 'turn-btns' },
    act('arrow-counter-clockwise', '90° влево', () => { apply(p => { p.rot = (p.rot || 0) - 90 * turnSign(p); p.x = 0; p.y = 0; }); renderPanel(); }),
    act('arrow-clockwise', '90° вправо', () => { apply(p => { p.rot = (p.rot || 0) + 90 * turnSign(p); p.x = 0; p.y = 0; }); renderPanel(); }),
    act('swap', 'Зеркально', () => { apply(p => { p.flipH = !p.flipH; p.x = -(p.x || 0); }); renderPanel(); }),
    act('arrow-down', 'Вверх ногами', () => { apply(p => { p.flipV = !p.flipV; p.y = -(p.y || 0); }); renderPanel(); }));
  // наклон — как видно на экране (при отражении знак хранимого угла обратный)
  const tilt = rangeRow('Наклон', { min: -TILT_MAX, max: TILT_MAX, step: 0.5, value: (ph.tilt || 0) * turnSign(ph), unit: '°', key: 'tilt',
    onInput: v => apply(p => { p.tilt = v * turnSign(p); }, 'tilt:' + slide.id),
    onChange: () => { settleFrame(); renderPanel(); } });
  const reset = hasTurn(ph) ? btn('btn btn-ghost btn-sm', null, 'Сбросить', () => {
    apply(p => { p.rot = 0; p.tilt = 0; p.flipH = false; p.flipV = false; });
    renderPanel();
  }) : null;
  return section('Поворот и отражение', reset, buttons, h('div', { style: 'height:10px' }), tilt,
    h('p', { class: 'field-hint', text: 'Наклон выравнивает завалившийся горизонт: фото чуть увеличится, чтобы не было пустых углов.' }));
}

function buildAdjustForm() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const m = slideMedia(slide);
  const root = h('div', { class: 'adjust-form' });
  const note = text => h('p', { class: 'field-hint', text });
  if (!L.photo || !m) {
    root.append(section('Фото', null,
      note(!L.photo ? 'На этом макете нет фото — выберите слайд с фото.'
        : 'Сначала добавьте фото — потом здесь можно повернуть его и поправить яркость, контраст и цвет.'),
      L.photo ? btn('btn btn-primary btn-sm adj-pick', 'image', 'Выбрать фото', () => pickPhotos()) : null));
    return root;
  }
  root.append(buildTurnSection(slide));
  if (isVideoMedia(m)) {
    root.append(section('Коррекция фото', null, note('Яркость и цвет правятся только у фото: видео экспортируется как есть.')));
    return root;
  }
  const a = slide.photo.adj || {};
  const sig = adjSig(a);
  const chips = h('div', { class: 'chips adj-presets' }, ...ADJ_PRESETS.map(([name, p]) => {
    const on = adjSig(p) === sig;
    return h('button', { type: 'button', class: 'chip-btn' + (on ? ' on' : ''), text: name, 'aria-pressed': String(on),
      onclick: () => { setAdj(slide, on ? null : p); renderPanel(); } });
  }));
  const rows = ADJ_ROWS.map(([key, label]) => rangeRow(label, { min: -100, max: 100, value: a[key] || 0, key: 'adj-' + key,
    onInput: x => { state.adjDrag = true; setAdj(slide, Object.assign({}, slide.photo.adj, { [key]: x }), 'adj:' + slide.id + ':' + key); },
    onChange: () => { state.adjDrag = false; scheduleRender(); renderPanel(); } }));
  // удерживаешь — на превью оригинал
  const cmp = btn('btn btn-outline btn-sm adj-compare', 'eye', 'Удерживайте — оригинал');
  cmp.disabled = !photoAdj(slide);
  const hold = on => { if (state.adjOff === on) return; state.adjOff = on; cmp.classList.toggle('on', on); scheduleRender(); };
  cmp.addEventListener('pointerdown', e => { e.preventDefault(); hold(true); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) cmp.addEventListener(t, () => hold(false));
  cmp.addEventListener('contextmenu', e => e.preventDefault());
  cmp.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); hold(true); } });
  cmp.addEventListener('keyup', () => hold(false));
  const reset = photoAdj(slide) ? btn('btn btn-ghost btn-sm', null, 'Сбросить', () => { setAdj(slide, null); renderPanel(); }) : null;
  root.append(section('Коррекция фото', reset,
    chips,
    h('div', { style: 'height:10px' }),
    ...rows,
    note('Насыщенность до упора влево — чёрно-белое. Тепло: влево — холоднее, вправо — теплее.'),
    h('div', { class: 'adj-foot' }, cmp)));
  // те же настройки на остальные фото проекта
  const others = state.project.slides.filter(x => x !== slide && isPhotoSlide(x) && adjSig(x.photo.adj || {}) !== sig);
  if (others.length) {
    root.append(section(null, null, btn('btn btn-outline btn-sm', null,
      photoAdj(slide) ? 'Так же на всех фото' : 'Убрать коррекцию со всех фото', () => {
        pushUndo();
        for (const x of others) {
          if (photoAdj(slide)) x.photo.adj = Object.assign({}, slide.photo.adj);
          else delete x.photo.adj;
        }
        commit({ panel: true });
        say(`Готово: ещё ${others.length} фото`);
      })));
  }
  return root;
}

function buildSettingsForm() {
  const root = h('div', { class: 'settings-form' });

  root.append(section('Экспорт', null,
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Формат файла' }),
      segControl([['png', 'PNG'], ['jpeg', 'JPG']], state.exportFormat, v => { state.exportFormat = v; savePrefs(); })),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Размер поста 4:5' }),
      segControl([[1440, '1440×1800 · как в макете'], [1080, '1080×1350']], state.exportWidth, v => { state.exportWidth = v; savePrefs(); scheduleRender(); })),
    h('p', { class: 'field-hint', text: 'Рилс всегда 1080×1920.' })));

  const fontLine = (kind, name) => {
    const bundled = BUNDLED_FONTS[kind];
    const user = state.userFonts[kind];
    const badge = user ? h('span', { class: 'badge ok', text: 'загружен' })
      : bundled ? h('span', { class: 'badge ok', text: 'вшит' })
        : h('span', { class: 'badge warn', text: 'запасной' });
    return h('div', { class: 'font-line' },
      h('div', { class: 'name' }, h('b', { text: name }),
        h('span', { class: 'muted', text: kind === 'title' ? 'заголовки' : 'рубрики «Заведения», «Новые места»' })),
      badge,
      user ? iconBtn('arrow-counter-clockwise', 'Вернуть встроенный', () => resetBrand(kind), 'sm') : null,
      iconBtn('upload-simple', 'Загрузить файл шрифта', () => pickBrandFile(kind), 'sm'));
  };
  const logoLine = h('div', { class: 'font-line' },
    h('div', { class: 'name' }, h('b', { text: 'Логотип' }),
      h('span', { class: 'muted', text: 'белый знак на прозрачном фоне (PNG)' })),
    h('span', { class: 'badge ok', text: state.userLogo ? 'загружен' : 'встроенный' }),
    state.userLogo ? iconBtn('arrow-counter-clockwise', 'Вернуть встроенный', () => resetBrand('logo'), 'sm') : null,
    iconBtn('upload-simple', 'Загрузить логотип', () => pickBrandFile('logo'), 'sm'));
  const missing = missingFonts();
  root.append(section('Шрифты и логотип', null,
    h('div', { class: 'font-status' }, fontLine('title', 'BravoRG'), fontLine('display', 'Nauryz Red Keds'), logoLine),
    h('p', { class: 'field-hint', style: 'margin-top:10px', text: missing.length
      ? 'Пока нет шрифта макета, слайды рисуются похожим запасным. Загруженный файл хранится только в этом браузере — чтобы шрифт был у всех, положите его в brand/fonts и пересоберите (см. README).'
      : 'Загруженные файлы хранятся только в этом браузере.' })));

  const nameInput = h('input', { class: 'input', type: 'text', value: state.project.name, autocomplete: 'off',
    enterkeyhint: 'done', 'aria-label': 'Название проекта' });
  nameInput.addEventListener('input', () => {
    state.project.name = nameInput.value;
    state.project.nameAuto = false;
    el.docName.value = nameInput.value;
    scheduleSave();
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });
  root.append(section('Проект', null,
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Название' }), nameInput,
      h('span', { class: 'field-hint', text: 'По нему называются файлы. Пока не меняли — повторяет заголовок обложки.' })),
    h('div', { class: 'actions-grid' },
    btn('btn btn-outline', 'file-arrow-down', 'Сохранить файл', exportProjectFile),
    btn('btn btn-outline', 'file-arrow-up', 'Открыть файл', importProjectFile)),
    h('p', { class: 'field-hint', style: 'margin-top:10px', text: 'Файл проекта — тексты и настройки без фото, чтобы продолжить на другом устройстве.' })));

  root.append(section('О приложении', null,
    btn('btn btn-ghost btn-sm', 'question', 'Как пользоваться', openHelp),
    btn('btn btn-ghost btn-sm theme-btn-text', isDarkActive() ? 'sun' : 'moon', isDarkActive() ? 'Светлая тема' : 'Тёмная тема', () => { toggleTheme(); renderPanel(); })));
  return root;
}

function savePrefs() {
  writeJson(STORE_PREFS, { exportFormat: state.exportFormat, exportWidth: state.exportWidth });
}
function loadPrefs() {
  const p = readJson(STORE_PREFS, {});
  if (p.exportFormat === 'png' || p.exportFormat === 'jpeg') state.exportFormat = p.exportFormat;
  if (p.exportWidth === 1440 || p.exportWidth === 1080) state.exportWidth = p.exportWidth;
}

/* ------------------------------------------------------------ шторка */

let sheetOnClose = null;
function openSheet(title, content, onClose = null) {
  el.sheetTitle.textContent = title;
  el.sheetBody.replaceChildren(content);
  el.sheet.hidden = false;
  sheetOnClose = onClose;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function closeSheet() {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  el.sheetBody.replaceChildren();
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (cb) cb();
}

function layoutPreview(layoutId, width = 150) {
  const slide = newSlide(layoutId);
  const c = h('canvas');
  const L = LAYOUTS[layoutId];
  c.style.aspectRatio = `${L.W} / ${L.H}`;
  requestAnimationFrame(() => paintSlide(c, slide, -1, width, { ghostAlpha: 1, cardNo: 1 }));
  return c;
}

function openLayoutSheet(mode) {
  const r = rubricOf();
  const slide = currentSlide();
  const own = r.layouts;
  const others = Object.keys(LAYOUTS).filter(id => !own.includes(id));
  const pick = id => {
    closeSheet();
    if (mode === 'add') addSlide(id);
    else changeLayout(id);
  };
  const grid = ids => h('div', { class: 'layout-grid' }, ids.map(id => {
    const b = h('button', { type: 'button', class: 'layout-opt' + (mode === 'change' && slide && slide.layout === id ? ' current' : '') },
      layoutPreview(id), h('span', { text: LAYOUTS[id].name }));
    b.addEventListener('click', () => pick(id));
    return b;
  }));
  const body = h('div', {},
    h('div', { class: 'sheet-group' }, h('h4', { text: 'Рубрика «' + r.name + '»' }), grid(own)),
    h('div', { class: 'sheet-group' }, h('h4', { text: 'Другие макеты' }), grid(others)));
  openSheet(mode === 'add' ? 'Новый слайд' : 'Макет слайда', body);
}

function openSlideMenu(i) {
  const L = layoutOf(state.project.slides[i]);
  const act = fn => () => { closeSheet(); fn(); };
  const list = h('div', { class: 'sheet-list' },
    btn('btn', 'layout', 'Сменить макет', act(() => openLayoutSheet('change'))),
    L.photo ? btn('btn', 'image', 'Выбрать фото', act(() => pickPhotos(i))) : null,
    btn('btn', 'copy', 'Дублировать', act(() => duplicateSlide(i))),
    btn('btn', 'arrow-left', 'Переместить левее', act(() => moveSlide(i, i - 1))),
    btn('btn', 'arrow-right', 'Переместить правее', act(() => moveSlide(i, i + 1))),
    btn('btn btn-danger', 'trash', 'Удалить слайд', act(() => deleteSlide(i))));
  openSheet(`Слайд ${i + 1} · ${L.short}`, list);
}

/* -------------------------------------------------------------- экспорт */

function downloadBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 20000);
}

function slideHasContent(slide) {
  const L = layoutOf(slide);
  return slideFields(slide, L).some(k => (slide.fields[k] || '').trim()) || Boolean(L.photo && slide.photo && media.has(slide.photo.id));
}

function isVideoSlide(slide) {
  return Boolean(layoutOf(slide).photo && isVideoMedia(slideMedia(slide)));
}

/* Слайд в полном размере: фото раскодируется из оригинала только на время отрисовки. */
async function renderExport(slide, index, width = 0) {
  const L = layoutOf(slide);
  const k = width ? width / L.W : L.W === 1440 ? state.exportWidth / 1440 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(L.W * k);
  canvas.height = Math.round(L.H * k);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  const m = L.photo && slide.photo && media.get(slide.photo.id);
  let full = null, fixed = null;
  if (m && !isVideoMedia(m)) { try { full = await decodeBlob(m.blob); } catch { full = null; } }
  const a = m && !isVideoMedia(m) && photoAdj(slide);
  if (a) { fixed = adjustImage(full || m.prev, a); releaseImage(full); full = null; }
  renderSlide(ctx, slide, envFor(slide, index, { ghost: false, k, photo: fixed || full || (m ? m.prev : null) }));
  releaseImage(full);
  freeCanvas(fixed);
  return canvas;
}

function exportName(i, ext, suffix = '') {
  return `${fileSlug(state.project.name, 'gorod24')}-${String(i + 1).padStart(2, '0')}${suffix}.${ext}`;
}

/*
 * Сторис 9:16 из поста: слайд 4:5 ложится карточкой по центру кадра
 * 1080×1920 (поля 60, верх и низ — в безопасной зоне сторис), фон — тот же
 * слайд, сильно размытый и притемнённый. Рилс и так 9:16 — как есть.
 * Размытие — уменьшением ступенями и обратным растяжением: ctx.filter в
 * Safari появился поздно.
 */
const STORY_W = 1080, STORY_H = 1920;
const STORY_CARD = { x: 60, y: 360, w: 960, h: 1200, r: 28 };

function isPostSlide(slide) { return layoutOf(slide).W === 1440; }
function storyMode(slide) { return state.exportStory && isPostSlide(slide); }

/* Маленькая размытая копия слайда для фона (src — canvas слайда любого размера). */
function storyBackdrop(src) {
  let c = src, w = src.width, h = src.height;
  while (w > 48) {
    w = Math.max(24, Math.round(w / 2));
    h = Math.max(30, Math.round(h / 2));
    const n = document.createElement('canvas');
    n.width = w; n.height = h;
    const x = n.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, w, h);
    if (c !== src) freeCanvas(c);
    c = n;
  }
  return c;
}

function storyCardPath(ctx) {
  const C = STORY_CARD;
  roundRect(ctx, C.x, C.y, C.w, C.h, C.r);
}

/* Фон сторис с тенью под карточкой; s — пикселей на единицу 1080×1920. */
function storyBase(backdrop, s = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(STORY_W * s);
  c.height = Math.round(STORY_H * s);
  const ctx = c.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // с запасом, чтобы размытые края не попадали в кадр
  const bw = backdrop.width, bh = backdrop.height;
  const sc = Math.max(STORY_W / bw, STORY_H / bh) * 1.12;
  ctx.drawImage(backdrop, (STORY_W - bw * sc) / 2, (STORY_H - bh * sc) / 2, bw * sc, bh * sc);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.fillRect(0, 0, STORY_W, STORY_H);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 70 * s;
  ctx.shadowOffsetY = 18 * s;
  storyCardPath(ctx);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
  return c;
}

function composeStory(card, s = 1) {
  const back = storyBackdrop(card);
  const out = storyBase(back, s);
  freeCanvas(back);
  const ctx = out.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  storyCardPath(ctx);
  ctx.clip();
  const C = STORY_CARD;
  ctx.drawImage(card, C.x, C.y, C.w, C.h);
  ctx.restore();
  return out;
}

async function renderStoryExport(slide, index) {
  const card = await renderExport(slide, index, STORY_CARD.w);
  const out = composeStory(card);
  freeCanvas(card);
  return out;
}

/* Превью сторис в окне «Сохранить» (по фото из превью — быстро). */
function storyPreview(slide, index, cssW) {
  const card = document.createElement('canvas');
  paintSlide(card, slide, index, cssW * STORY_CARD.w / STORY_W, { ghost: false });
  const out = composeStory(card, cssW * Math.min(window.devicePixelRatio || 1, 2.5) / STORY_W);
  freeCanvas(card);
  out.style.width = cssW + 'px';
  out.style.height = Math.round(cssW * STORY_H / STORY_W) + 'px';
  return out;
}

/*
 * Новая версия: build.py пишет version.json с id сборки, тот же id вшит в
 * страницу (BUILD_ID). Окно «Сохранить» сверяет их: вкладка, открытая
 * давно, или приложение с экрана «Домой» иначе так и живут со старой
 * сборкой. Запрос без кеша (cache: no-store) — без ?t=…, иначе сервис-воркер
 * копил бы в кеше по копии на каждую проверку.
 */
const STORE_REOPEN = 'g24.reopen.v1';
let versionCheck = null;   // { at, build }

async function latestBuild() {
  if (!/^https?:$/.test(location.protocol) || !/^[0-9a-f]{12}$/.test(BUILD_ID)) return null;
  if (versionCheck && Date.now() - versionCheck.at < 60000) return versionCheck.build;
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    const d = await r.json();
    versionCheck = { at: Date.now(), build: String(d && d.build || '') };
    return versionCheck.build;
  } catch { return null; }
}

async function updateApp() {
  if (state.project) {
    saveProject();
    try { sessionStorage.setItem(STORE_REOPEN, state.project.id); } catch { /* откроют сами */ }
  }
  // свежая страница в HTTP-кеш и в кеш сервис-воркера, потом перезагрузка
  try { await fetch(location.pathname, { cache: 'reload' }); } catch { /* офлайн — перезагрузится как есть */ }
  location.reload();
}

/* После «Обновить» возвращаемся в тот же черновик. */
function reopenAfterUpdate() {
  let id = null;
  try { id = sessionStorage.getItem(STORE_REOPEN); sessionStorage.removeItem(STORE_REOPEN); } catch { /* нет */ }
  if (id && readDrafts().some(d => d.id === id)) openDraft(id);
}

/*
 * Готовит файлы. only — индекс одного слайда или null (все). Слайды с видео
 * записываются в реальном времени, поэтому прогресс считаем по времени:
 * картинка ≈ 0,5 с, видео — длина фрагмента.
 */
async function buildFiles(only, onProgress) {
  stopPlayback();
  const slides = state.project.slides;
  const idx = only === null ? slides.map((_, i) => i).filter(i => slideHasContent(slides[i])) : [only];
  const mime = state.exportFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext = state.exportFormat === 'jpeg' ? 'jpg' : 'png';
  const weight = i => (isVideoSlide(slides[i]) ? Math.max(0.5, clipOf(slides[i]).length) : 0.5);
  const total = idx.reduce((sum, i) => sum + weight(i), 0) || 1;
  const files = [];
  let doneWeight = 0;
  let videoSkipped = 0;
  for (const i of idx) {
    const slide = slides[i];
    if (isVideoSlide(slide) && canRecordVideo()) {
      const story = storyMode(slide);
      const blob = await recordVideoSlide(slide, i, f => onProgress && onProgress((doneWeight + f * weight(i)) / total), story);
      const vext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      if (blob.size) files.push(new File([blob], exportName(i, vext, story ? '-story' : ''), { type: blob.type }));
      showClipStart(slide);
    } else {
      if (isVideoSlide(slide)) videoSkipped++;
      const story = storyMode(slide);
      const canvas = story ? await renderStoryExport(slide, i) : await renderExport(slide, i);
      const blob = await canvasToBlob(canvas, mime, 0.95);
      canvas.width = canvas.height = 0;
      if (blob) files.push(new File([blob], exportName(i, ext, story ? '-story' : ''), { type: mime }));
    }
    doneWeight += weight(i);
    if (onProgress) onProgress(doneWeight / total);
    await new Promise(r => setTimeout(r, 0));
  }
  if (videoSkipped) say('Этот браузер не умеет записывать видео — видео-слайды сохранены картинкой. Откройте в Chrome или Safari', 7000);
  return files;
}

/* ZIP без сжатия (store): PNG/JPG и так сжаты, а store — это пара десятков строк без библиотек. */
function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crc32.table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function canShareFiles() {
  try {
    const probe = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' });
    return Boolean(navigator.share && navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch { return false; }
}

/* Отдаём системному окну только то, что оно согласно принять: WebM, например,
   iOS не шарит — такие файлы скачиваем. */
function shareable(files) {
  try { return navigator.canShare && navigator.canShare({ files }); } catch { return false; }
}

let exportBusy = false;

function openExportSheet() {
  if (!state.project) return;
  const slides = state.project.slides;
  stopPlayback();
  const count = slides.filter(slideHasContent).length;
  const videos = slides.filter(isVideoSlide).length;
  const videoSeconds = slides.filter(isVideoSlide).reduce((sum, sl) => sum + clipOf(sl).length, 0);
  const progress = h('div', { class: 'progress', hidden: true }, h('div'));
  const bar = progress.firstChild;
  const setProgress = f => { progress.hidden = false; bar.style.width = Math.round(f * 100) + '%'; };
  const list = h('div', { class: 'sheet-list' });
  const note = h('p', { class: 'sheet-note' });
  state.exportStory = false;

  // вышла новая сборка — предложить обновиться (проверка в фоне)
  const update = h('div', { class: 'update-note', hidden: true },
    h('span', { class: 'update-text' }, h('b', { text: 'Доступна новая версия' }),
      h('span', { text: 'Черновик не пропадёт — откроется снова.' })),
    btn('btn btn-primary btn-sm', 'arrow-clockwise', 'Обновить', () => updateApp()));
  latestBuild().then(b => { if (b && b !== BUILD_ID) update.hidden = false; });

  // пост или сторис 9:16 (рилс и так 9:16)
  const posts = slides.map((sl, i) => i).filter(i => isPostSlide(slides[i]) && slideHasContent(slides[i]));
  const storyBox = h('div', { class: 'story-box', hidden: true });
  const syncStory = () => {
    storyBox.hidden = !state.exportStory;
    sizeRow.hidden = state.exportStory;
    if (!state.exportStory || storyBox.firstChild) return;
    const i = posts.includes(state.current) ? state.current : posts[0];
    storyBox.append(storyPreview(slides[i], i, 96), h('p', { class: 'sheet-note',
      text: 'Пост ляжет карточкой по центру сторис 1080×1920, фон — размытый слайд.' +
        (posts.length < count ? ' Рилс сохранятся как есть.' : '') }));
  };
  const modeGroup = posts.length ? h('div', { class: 'sheet-group export-mode' },
    segControl([['post', 'Пост 4:5'], ['story', 'Сторис 9:16']], 'post', v => { state.exportStory = v === 'story'; syncStory(); }, 'Что сохранить'),
    storyBox) : null;

  const run = async (label, fn) => {
    if (exportBusy) return;
    if (!count && label !== 'one') { say('Пока нечего сохранять — добавьте текст или фото'); return; }
    exportBusy = true;
    // звук видео и AudioContext на iOS разрешаются только прямо из нажатия
    if (videos) primeVideoAudio(slides);
    list.querySelectorAll('button').forEach(b => { b.disabled = true; });
    setProgress(0);
    try { await fn(); } catch (err) { console.error(err); say('Не получилось: ' + (err && err.message || 'ошибка')); }
    exportBusy = false;
    list.querySelectorAll('button').forEach(b => { b.disabled = false; });
    setTimeout(() => { progress.hidden = true; }, 600);
  };

  const share = async only => {
    const files = await buildFiles(only, setProgress);
    if (!files.length) return;
    if (!shareable(files)) {
      for (const f of files) { downloadBlob(f, f.name); await new Promise(r => setTimeout(r, 350)); }
      say('Система не принимает эти файлы для «Поделиться» — скачал их');
      return;
    }
    try {
      await navigator.share({ files });
      closeSheet();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Safari требует, чтобы share вызывался прямо из нажатия, а подготовка
      // файлов заняла время — даём вторую кнопку с уже готовыми файлами
      const again = btn('btn btn-primary btn-lg btn-block', 'share-network', `Отправить ${files.length} ${pluralRu(files.length, 'файл', 'файла', 'файлов')}`, async () => {
        try { await navigator.share({ files }); closeSheet(); } catch (e2) { if (!e2 || e2.name !== 'AbortError') say('Не получилось — скачайте файлы'); }
      });
      list.prepend(again);
      note.textContent = 'Файлы готовы — нажмите «Отправить».';
    }
  };

  if (canShareFiles()) {
    list.append(
      btn('btn btn-primary btn-lg', 'share-network', isIosDevice() ? 'Сохранить в Фото / отправить' : 'Поделиться',
        () => run('share', () => share(null))),
      btn('btn', 'share-network', 'Поделиться только этим слайдом', () => run('one', () => share(state.current))));
    note.textContent = isIosDevice()
      ? 'В окне «Поделиться» выберите «Сохранить» — слайды окажутся в Фото, оттуда в Instagram.'
      : 'Откроется системное окно: Telegram, Instagram, «Сохранить» и т. п.';
  }
  const addSub = (b, text) => { b.append(h('span', { class: 'sub', text })); return b; };
  list.append(
    addSub(btn('btn', 'file-zip', 'Скачать все одним ZIP', () => run('zip', async () => {
      const files = await buildFiles(null, setProgress);
      const entries = await Promise.all(files.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
      downloadBlob(buildZip(entries), fileSlug(state.project.name, 'gorod24') + '.zip');
      say('Архив скачан');
    })), String(count)),
    btn('btn', 'files', 'Скачать по одному', () => run('files', async () => {
      const files = await buildFiles(null, setProgress);
      for (const f of files) { downloadBlob(f, f.name); await new Promise(r => setTimeout(r, 350)); }
      say('Скачано: ' + files.length);
    })),
    btn('btn', 'download-simple', 'Скачать только этот слайд', () => run('one', async () => {
      const files = await buildFiles(state.current, setProgress);
      if (files[0]) downloadBlob(files[0], files[0].name);
    })));
  if (!isTouch() && navigator.clipboard && window.ClipboardItem && !isVideoSlide(currentSlide())) {
    list.append(btn('btn', 'copy', 'Скопировать слайд в буфер', () => run('one', async () => {
      const canvas = storyMode(currentSlide()) ? await renderStoryExport(currentSlide(), state.current)
        : await renderExport(currentSlide(), state.current);
      const blob = await canvasToBlob(canvas, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say('Слайд скопирован');
    })));
  }

  const L = layoutOf(currentSlide());
  const videoNote = !videos ? null : h('p', { class: 'sheet-note video-note' },
    canRecordVideo()
      ? `Видео (${videos}) записываются в реальном времени — около ${Math.ceil(videoSeconds)} с, 1080 px, в ${videoExt().toUpperCase()}. Не сворачивайте вкладку, пока идёт запись.` +
        (videoExt() === 'webm' ? ' Instagram не принимает WEBM — для видео лучше Safari или Chrome.' : '')
      : 'Этот браузер не умеет записывать видео — видео-слайды сохранятся картинкой. Откройте конструктор в Chrome или Safari.');
  const sizeRow = h('div', { class: 'size-row' }, h('div', { style: 'height:10px' }),
    segControl([[1440, '1440×1800'], [1080, '1080×1350']], state.exportWidth, v => { state.exportWidth = v; savePrefs(); scheduleRender(); }));
  const body = h('div', {},
    update,
    modeGroup,
    h('div', { class: 'sheet-group' }, list, progress, note, videoNote),
    h('div', { class: 'sheet-group' },
      h('h4', { text: 'Формат' }),
      segControl([['png', 'PNG'], ['jpeg', 'JPG']], state.exportFormat, v => { state.exportFormat = v; savePrefs(); }),
      sizeRow,
      h('p', { class: 'sheet-note', text: L.W === 1080 ? 'Рилс сохраняется в 1080×1920.' : `Слайдов с содержимым: ${count}. Пустые не сохраняются.` })));
  openSheet('Сохранить', body);
}


/* --------------------------------------------------- просмотр карусели */
/*
 * Полноэкранный просмотр, как лента в Instagram: слайды листаются
 * свайпом (scroll-snap). Закрытие возвращает в редактор на тот слайд,
 * который смотрели.
 */
const viewer = { el: null, track: null, count: null };

function wireViewer() {
  viewer.el = document.getElementById('viewer');
  viewer.track = document.getElementById('viewerTrack');
  viewer.count = document.getElementById('viewerCount');
  document.getElementById('btnView').addEventListener('click', openViewer);
  document.getElementById('viewerClose').addEventListener('click', closeViewer);
  viewer.track.addEventListener('scroll', () => {
    const i = viewerIndex();
    viewer.count.textContent = `${i + 1} / ${viewer.track.children.length}`;
  }, { passive: true });
}

function viewerIndex() {
  const w = viewer.track.clientWidth || 1;
  return clamp(Math.round(viewer.track.scrollLeft / w), 0, viewer.track.children.length - 1);
}

function openViewer() {
  if (!state.project) return;
  stopPlayback();
  const slides = state.project.slides;
  viewer.el.hidden = false;
  const boxW = viewer.track.clientWidth, boxH = viewer.track.clientHeight;
  viewer.track.replaceChildren(...slides.map((slide, i) => {
    const L = layoutOf(slide);
    const cssW = Math.floor(Math.min(boxW - 24, (boxH - 24) * L.W / L.H));
    const c = h('canvas');
    c.style.width = cssW + 'px';
    c.style.height = Math.round(cssW * L.H / L.W) + 'px';
    paintSlide(c, slide, i, cssW, { ghost: false });
    return h('div', { class: 'viewer-slide' }, c);
  }));
  viewer.track.scrollLeft = state.current * viewer.track.clientWidth;
  viewer.count.textContent = `${state.current + 1} / ${slides.length}`;
}

function closeViewer() {
  if (viewer.el.hidden) return;
  const i = viewerIndex();
  viewer.el.hidden = true;
  viewer.track.replaceChildren();
  selectSlide(i);
}

/* ---------------------------------------------------------------- помощь */

function openHelp() {
  const body = h('div', { class: 'help' });
  body.innerHTML = `
    <h4>Как собрать пост</h4>
    <ul>
      <li>На стартовом экране выберите рубрику — откроется обложка и пара карточек по макету.</li>
      <li>Или «Собрать карусель из текста»: вставьте готовый текст, выберите рубрику — обложка и карточки заполнятся сами (заголовки пунктов, адреса, даты, цены).</li>
      <li>Пишите текст в полях под превью: слайд обновляется сразу. Бледный текст на слайде — подсказка, в готовую картинку он не попадёт.</li>
      <li>Или нажмите на текст прямо на превью: на телефоне под слайдом останется только это поле, превью станет крупнее. ‹ › — соседний текст (и соседний слайд), «Готово» или нажатие мимо текста — обратно.</li>
      <li>«Фото или видео» на превью или в блоке «Фото». Можно выбрать сразу несколько — разложатся по слайдам, лишним добавятся новые карточки.</li>
      <li>Кадр двигается пальцем (или мышью) прямо на превью, щипок или колесо — масштаб.</li>
      <li>Видео ставится в то же место, что и фото. Ползунки «Начало» и «Конец» задают фрагмент (в карусели Instagram — до 60 с), «▶» на превью проигрывает его прямо в макете.</li>
      <li>Кнопка со стрелками в ленте рядом с «+» перемешивает макеты карточек — карусель становится разнообразнее; ещё раз — другой вариант, ⌘Z — вернуть.</li>
      <li>«+» в ленте — новый слайд любого макета, в том числе из другой рубрики. Нажмите на текущий слайд в ленте ещё раз — меню: дублировать, переставить, удалить.</li>
    </ul>
    <h4>Жирный, курсив, цвет, выравнивание</h4>
    <ul>
      <li>В полях «Текст» и «Подзаголовок» выделите слова и нажмите «Ж» (жирный), «К» (курсив) или «Обычный». На компьютере — <kbd>⌘B</kbd> / <kbd>⌘I</kbd>.</li>
      <li>Там же (и в заголовках) — красный и кремовый цвет слов и маркер «А»: кремовая плашка под словами. Повторное нажатие снимает, «Обычный» — снимает всё.</li>
      <li>Текст, скопированный из Заметок, Google Docs, Word или с сайта, вставляется с жирным и курсивом, остальное оформление отбрасывается.</li>
      <li>«Оформление → Выравнивание»: по левому краю, по центру, по правому, по ширине. «Расположение»: сверху, по центру, снизу. Изначально — как в макете; «Так же на всех слайдах» применит выбор ко всей карусели.</li>
      <li>«Оформление → Логотип»: нажмите одну из 8 точек на схеме — углы или середины сторон. Текст сам отодвигается, чтобы не наезжать на логотип.</li>
      <li>На телефоне при выделении текста под ним всплывает панель «Ж · К · Обычный» и цвета.</li>
    </ul>
    <h4>Если текст не помещается или плохо виден</h4>
    <p>Под превью появится «Текст не помещается» и жёлтая точка на миниатюре. «Уместить» уменьшит кегль, пока текст не влезет, или подвиньте ползунки «Размер текста».</p>
    <p>«Текст плохо читается на фото» — под текстом слишком светлое фото. «Затемнить» усилит затемнение, а если мало — сделает темнее само фото. «Нет букв: …» — таких букв нет в шрифте макета, на слайде они будут другим шрифтом.</p>
    <h4>Фото: поворот, яркость и цвет</h4>
    <p>Вкладка «Фото»: поворот на 90°, «Зеркально», «Вверх ногами» и наклон ±45° (выровнять горизонт; работает и для видео), а также яркость, контраст, насыщенность (влево до упора — ч/б), тепло и быстрые варианты. Держите «оригинал», чтобы сравнить. Оригинал фото не меняется.</p>
    <h4>Сохранить</h4>
    <p>Кнопка «Сохранить» вверху. На телефоне — «Сохранить в Фото / отправить»: в системном окне выберите «Сохранить» или сразу Instagram/Telegram. На компьютере — ZIP или по одному файлу, PNG или JPG, 1440×1800 (как в макете) или 1080×1350.</p>
    <p>«Сторис 9:16» вверху окна — посты сохранятся кадром 1080×1920 на размытом фоне. Если вышла новая версия конструктора, там же будет «Обновить».</p>
    <p>Слайды с видео сохраняются роликом MP4 1080 px со звуком (в Firefox — WEBM). Ролик записывается в реальном времени, поэтому 15-секундный фрагмент пишется 15 секунд — не сворачивайте вкладку.</p>
    <h4>Черновики</h4>
    <p>Всё сохраняется само — и тексты, и фото — в этом браузере. Черновики видны на стартовом экране. «Настройки → Сохранить файл» — чтобы продолжить на другом устройстве (без фото).</p>
    <h4>Горячие клавиши</h4>
    <p><kbd>⌘Z</kbd> отменить, <kbd>⌘⇧Z</kbd> повторить, <kbd>⌘S</kbd> сохранить, <kbd>⌘V</kbd> вставить фото, <kbd>⌘B</kbd> / <kbd>⌘I</kbd> жирный / курсив в поле, <kbd>PageUp</kbd>/<kbd>PageDown</kbd> соседний слайд. На Windows вместо ⌘ — Ctrl.</p>
    <h4>На телефон</h4>
    <p>Конструктор ставится как приложение: в Safari «Поделиться → На экран «Домой»», в Chrome — «Установить приложение». Работает и без интернета.</p>`;
  openSheet('Как пользоваться', body);
}

/* ------------------------------------------- карусель из текста (главный) */

/*
 * «Собрать карусель из текста» — кнопка только на стартовом экране. Вставили
 * текст (из Заметок, Docs, Telegram — жирный сохраняется) → обложка и
 * карточки рубрики заполнены. Разбор:
 *  - строки до первого пункта — обложка (заголовок, подзаголовок);
 *  - пункт начинается со строки-заголовка: «1.» / «1)», жирной строки,
 *    вопроса (интервью) или короткой строки после пустой (подборки);
 *  - в пункте: адрес (📍, «ул.»…), дата и время, место, цена, «Премьера…» —
 *    по рубрике; остальное — текст карточки.
 * Если пунктов не нашлось — каждый абзац (через пустую строку) — карточка.
 */
const MAGIC_RUBRICS = ['int', 'zav', 'new', 'fav', 'ev', 'kino', 'com'];
const STORE_MAGIC = 'g24.magic.v1';   // последняя выбранная рубрика и «нумеровать»
const MAGIC_HINTS = {
  int: 'Первая строка — заголовок обложки. Дальше вопросы (с «?», «1.» или жирные) и ответы под ними.',
  zav: 'Первая строка — обложка. Дальше заведения: название, строка с адресом (📍 или «ул.»), описание.',
  new: 'Первая строка — обложка. Дальше места: название, адрес (📍 или «ул.»), описание.',
  fav: 'Первая строка — обложка. Дальше места: название и пара предложений о нём.',
  ev: 'Первая строка — обложка (например, «мероприятий недели», даты 21.09-27.09). Дальше события: название, дата и время, место, цена, описание.',
  kino: 'Первая строка — обложка. Дальше фильмы: название, «Премьера: …», описание.',
  com: 'Первая строка — обложка. Дальше карточки: заголовок и текст.',
};
const MAGIC_EXAMPLE = {
  int: 'Шеф о своём первом ресторане\nИнтервью\n\nКак всё началось?\nС маленькой кухни у друзей…\n\nЧто дальше?\nВторой ресторан весной.',
  zav: 'Где позавтракать в Душанбе\nпять мест с лучшими сырниками\n\nКофейня «Зерно»\n📍 ул. Рудаки, 45\nСырники с соленой карамелью и спешелти-кофе.\n\nБулочная «Хлеб»\n📍 пр. Исмоили Сомони, 12\nТёплые круассаны с 8 утра.',
};
const MONTHS = 'январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр';
// \b в JS не видит кириллицу: слово — через \p{L}. Без lookbehind (?<…) —
// его нет в iOS до 16.4, и весь скрипт не загрузился бы.
const W0 = '(?:^|[^\\p{L}\\d])', W1 = '(?![\\p{L}\\d])';
const RE = {
  numbered: /^\s*(?:(\d{1,2})\s*[.)]|(\d)\uFE0F?\u20E3)\s*(?=\S)/u,
  bullet: /^\s*[•●▪◦*–—-]\s+/u,
  address: new RegExp(`^\\s*(?:📍|адрес${W1}|ул\\.|улица${W1}|пр\\.|просп|пр-т|мкр|микрорайон|бульвар|б-р|ш\\.|шоссе|пл\\.|площадь|пер\\.|переулок|наб\\.|набережная|тц${W1}|трц${W1})`, 'iu'),
  date: new RegExp(`^\\s*(?:🗓|📅|⏰|🕐|🕑|🕒|🕓|🕔|🕕|🕖|🕗|🕘|🕙|🕚|🕛)|${W0}\\d{1,2}\\s+(?:${MONTHS})|${W0}\\d{1,2}[:.]\\d{2}${W1}|${W0}(?:сегодня|завтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)${W1}`, 'iu'),
  place: new RegExp(`^\\s*(?:📍|место${W1}|где${W1}|тц${W1}|трц${W1}|клуб${W1}|бар${W1}|парк${W1})`, 'iu'),
  price: new RegExp(`^\\s*(?:💵|💰|🎟|🎫)|тенге|${W0}тг${W1}|₸|${W0}сом${W1}|сомони|${W0}сум${W1}|руб|₽|\\$|бесплатн|${W0}вход${W1}|билет`, 'iu'),
  badge: /^\s*(?:премьер|в кино|в прокате|старт|с\s+\d{1,2}\s)/iu,
  range: /\d{1,2}\.\d{1,2}\s*[-–—]\s*\d{1,2}\.\d{1,2}/,
  emoji: /^\s*\p{Extended_Pictographic}\uFE0F?\s*/u,
};
/* Адрес — ключевое слово и номер дома («наб. Рудаки, 5»), а не просто «Набережная». */
const looksAddress = t => /^\s*📍/u.test(t) || (RE.address.test(t) && /\d/.test(t));

/* Текст с флагами (жирный из вставки) → строки { text, flags }. */
function magicLines(text, runs) {
  const flags = runs ? runs.flatMap(([len, f]) => Array(len).fill(f)) : Array(text.length).fill(0);
  const lines = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    let a = 0, b = raw.length;
    while (a < b && /\s/.test(raw[a])) a++;
    while (b > a && /\s/.test(raw[b - 1])) b--;
    lines.push({ text: raw.slice(a, b), flags: flags.slice(pos + a, pos + b) });
    pos += raw.length + 1;
  }
  return lines;
}

function lineBold(l) {
  let letters = 0;
  for (let i = 0; i < l.text.length; i++) {
    if (/\s/.test(l.text[i])) continue;
    if (!(l.flags[i] & BOLD)) return false;
    letters++;
  }
  return letters > 1;
}

/* Убрать «1.» / маркер списка спереди (с флагами). */
function cutLead(l) {
  const m = l.text.match(RE.numbered) || l.text.match(RE.bullet);
  if (!m) return l;
  return { text: l.text.slice(m[0].length), flags: l.flags.slice(m[0].length) };
}

function joinLines(lines) {
  // абзацы через пустую строку, подряд идущие пустые — одна
  const parts = [];
  for (const l of lines) {
    if (!l.text) { if (parts.length && parts[parts.length - 1] !== null) parts.push(null); continue; }
    parts.push(l);
  }
  while (parts.length && parts[parts.length - 1] === null) parts.pop();
  let text = '';
  const flags = [];
  parts.forEach((l, i) => {
    if (i) { text += '\n'; flags.push(0); }   // null — пустая строка между абзацами
    if (l) { text += l.text; flags.push(...l.flags); }
  });
  return { text, flags };
}

function magicItemsFrom(lines, rubric) {
  // как узнали заголовок пункта: 'num' — «1.», 'bold' — жирный, 'q' — вопрос,
  // 'title' — короткая строка после пустой (подборки); false — не заголовок
  const headKind = (l, i) => {
    if (!l.text) return false;
    if (RE.numbered.test(l.text)) return 'num';
    if (lineBold(l)) return 'bold';
    if (rubric === 'int') return /[?？]\s*$/.test(l.text) && l.text.length <= 160 ? 'q' : false;
    const prevBlank = i === 0 || !lines[i - 1].text;
    const next = lines[i + 1];
    return prevBlank && next && next.text && l.text.length <= 70 && !/[.!…:;,]$/.test(l.text) &&
      !looksAddress(l.text) ? 'title' : false;
  };
  const heads = lines.map((l, i) => headKind(l, i));
  const first = heads.findIndex(Boolean);
  let coverLines = (first < 0 ? [] : lines.slice(0, first)).filter(l => l.text);
  const items = [];
  if (first >= 0) {
    let cur = null;
    lines.slice(first).forEach((l, k) => {
      if (heads[first + k]) { cur = { head: cutLead(l), kind: heads[first + k], rest: [] }; items.push(cur); }
      else cur.rest.push(l);
    });
  }
  // обложки не нашлось, а первый «пункт» в самом начале — скорее это она:
  // заголовок без текста (жирные строки из Docs) или короткая шапка из 1–2
  // строк без адреса, даты и цены
  if (!coverLines.length && items.length >= 2 && items[0].kind !== 'num') {
    const restText = items[0].rest.filter(l => l.text);
    const plainShort = restText.length <= 2 && restText.every(l => l.text.length <= 90 &&
      !looksAddress(l.text) && !RE.date.test(l.text) && !RE.price.test(l.text) && !RE.badge.test(l.text));
    if (!restText.length || (items[0].kind === 'title' && plainShort)) {
      coverLines = [items[0].head, ...restText];
      items.shift();
    }
  }
  return { coverLines, items };
}

/* Разбор текста под рубрику → { cover: {fields, fmt}, items: [{layout, fields, fmt}] }. */
function parseCarouselText(text, runs, rubricId, opts = {}) {
  const r = RUBRIC_BY_ID[rubricId] || RUBRICS[0];
  const lines = magicLines(text, runs);
  let { coverLines, items } = magicItemsFrom(lines, rubricId);
  if (!items.length) {
    // без явных пунктов: блоки через пустую строку, первый — обложка
    const blocks = [];
    let cur = [];
    for (const l of lines) { if (l.text) cur.push(l); else if (cur.length) { blocks.push(cur); cur = []; } }
    if (cur.length) blocks.push(cur);
    coverLines = blocks.length > 1 || (blocks[0] && blocks[0].length <= 2) ? (blocks.shift() || []) : [];
    items = blocks.map(b => (b.length > 1 && b[0].text.length <= 80
      ? { head: cutLead(b[0]), rest: b.slice(1) }
      : { head: null, rest: b }));
  }

  const cover = { fields: {}, fmt: {} };
  const coverKind = r.slides[0];
  if (coverKind === 'ev-cover') {
    const all = coverLines.map(l => l.text).join('\n');
    const range = all.match(RE.range);
    if (range) cover.fields.dates = range[0].replace(/\s+/g, '');
    const label = coverLines.map(l => l.text.replace(RE.range, '').trim()).filter(Boolean).join('\n');
    if (label) cover.fields.label = label.replace(/^\d+\s+/, '');
  } else {
    if (coverLines[0]) cover.fields.title = coverLines[0].text;
    if (coverLines.length > 1) setRichValue(cover, 'subtitle', joinLines(coverLines.slice(1)));
  }

  const out = items.map((it, n) => {
    const card = { layout: r.card, fields: {}, fmt: {} };
    if (r.id === 'com') card.layout = n % 2 ? 'com-bottom' : 'com-top';
    let head = it.head ? { text: it.head.text.replace(/[:：]\s*$/, ''), flags: it.head.flags } : null;
    let rest = it.rest.slice();
    // «Название — описание» одной строкой
    if (head && rubricId !== 'int') {
      const m = head.text.match(/^(.{2,50}?)\s+[—–-]\s+(.{12,})$/);
      if (m) {
        const cut = head.text.length - m[2].length;
        rest.unshift({ text: m[2], flags: head.flags.slice(cut) });
        head = { text: m[1], flags: head.flags.slice(0, m[1].length) };
      }
    }
    // служебные строки: в первых строках пункта; эмодзи спереди убираем —
    // макет ставит свои (📍, 🗓️, 💵)
    const take = (test, maxLen = 90) => {
      const ok = typeof test === 'function' ? test : t => test.test(t);
      const i = rest.findIndex((l, k) => k < 5 && l.text && l.text.length <= maxLen && ok(l.text));
      if (i < 0) return '';
      return rest.splice(i, 1)[0].text.replace(RE.emoji, '');
    };
    const title = head ? head.text : '';
    if (rubricId === 'int') {
      const num = String(n + 1).padStart(2, '0') + '. ';
      card.fields.title = opts.number && title ? num + title.replace(/^\d{1,2}\s*[.)]\s*/, '') : title;
      setRichValue(card, 'body', joinLines(rest));
    } else if (rubricId === 'zav' || rubricId === 'new') {
      card.fields.title = title;
      const addr = take(looksAddress);
      if (addr) card.fields.address = addr.replace(/^\s*адрес[:\s]*/i, '');
      setRichValue(card, 'body', joinLines(rest));
    } else if (rubricId === 'fav') {
      // у карточки «Любимых мест» только текст — название первой строкой, жирным
      const body = joinLines(rest);
      if (title) {
        const t = { text: title + (body.text ? '\n' + body.text : ''),
          flags: [...Array(title.length).fill(BOLD), ...(body.text ? [0, ...body.flags] : [])] };
        setRichValue(card, 'body', t);
      } else setRichValue(card, 'body', body);
    } else if (rubricId === 'ev') {
      card.fields.title = title;
      const date = take(RE.date, 60);
      const price = take(RE.price, 60);
      const place = take(RE.place, 80) || take(looksAddress, 80);
      if (date) card.fields.date = date;
      if (place) card.fields.place = place;
      if (price) card.fields.price = price;
      setRichValue(card, 'body', joinLines(rest));
    } else if (rubricId === 'kino') {
      card.fields.title = title;
      const badge = take(RE.badge, 60);
      if (badge) card.fields.badge = badge;
      setRichValue(card, 'body', joinLines(rest));
    } else {
      card.fields.title = title;
      setRichValue(card, 'body', joinLines(rest));
    }
    return card;
  }).filter(c => Object.values(c.fields).some(v => String(v).trim()));

  if (coverKind === 'ev-cover' && out.length) cover.fields.number = String(out.length);
  return { cover, items: out };
}

/* Поле с форматированием: текст + отрезки, только если есть выделение. */
function setRichValue(target, key, value) {
  if (!value.text) return;
  target.fields[key] = value.text;
  const runs = flagsToRuns(value.flags.map(f => f & (BOLD | ITALIC)));
  if (runs.some(r => r[1])) target.fmt[key] = runs;
}

function buildMagicProject(rubricId, plan) {
  const r = RUBRIC_BY_ID[rubricId] || RUBRICS[0];
  const make = (layout, part) => {
    const s = newSlide(layout);
    Object.assign(s.fields, part.fields);
    if (Object.keys(part.fmt).length) s.fmt = part.fmt;
    return s;
  };
  const slides = [make(r.slides[0], plan.cover), ...plan.items.map(it => make(it.layout, it))];
  // ни одной карточки — как обычная рубрика
  if (slides.length === 1) slides.push(...r.slides.slice(1).map(newSlide));
  return { id: newId(), rubric: r.id, name: '', nameAuto: true, createdAt: Date.now(), updatedAt: Date.now(), slides };
}

function openMagicSheet() {
  const saved = readJson(STORE_MAGIC, {});
  let rubric = MAGIC_RUBRICS.includes(saved.rubric) ? saved.rubric : 'int';
  let number = saved.number !== false;
  let files = [];
  const body = h('div', { class: 'magic-sheet' });

  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Рубрика' });
  const hint = h('p', { class: 'sheet-note magic-hint' });
  const area = h('div', { class: 'textarea rich magic-input', contenteditable: 'true', role: 'textbox',
    'aria-multiline': 'true', 'aria-label': 'Текст для карусели', spellcheck: 'true' });
  const numberRow = switchRow('Нумеровать вопросы 01, 02…', number, v => { number = v; persist(); refresh(); });
  const summary = h('div', { class: 'magic-summary' });
  const photoNote = h('span', { class: 'muted small' });
  const photoInput = h('input', { type: 'file', accept: 'image/*,video/*,.heic,.heif', multiple: true, hidden: true });
  const go = btn('btn btn-primary btn-block magic-go', 'magic-wand', 'Собрать карусель', () => build());

  const persist = () => writeJson(STORE_MAGIC, { rubric, number });
  const read = () => readRich(area);
  const syncEmpty = () => area.classList.toggle('is-empty', !area.textContent);
  const setPlaceholder = () => { area.dataset.placeholder = MAGIC_EXAMPLE[rubric] || MAGIC_EXAMPLE.zav; };

  const renderChips = () => chips.replaceChildren(...MAGIC_RUBRICS.map(id => {
    const b = h('button', { type: 'button', role: 'radio', class: 'chip-btn' + (id === rubric ? ' on' : ''),
      'aria-checked': String(id === rubric), text: RUBRIC_BY_ID[id].name });
    b.addEventListener('click', () => { rubric = id; persist(); renderChips(); refresh(); });
    return b;
  }));

  let timer = 0;
  const refresh = () => {
    hint.textContent = MAGIC_HINTS[rubric];
    numberRow.hidden = rubric !== 'int';
    setPlaceholder();
    syncEmpty();
    const { text, runs } = read();
    if (!text.trim()) {
      summary.replaceChildren(h('span', { class: 'muted small', text: 'Вставьте или напишите текст — тут появится, какие слайды получатся.' }));
      go.disabled = true;
      return;
    }
    const plan = parseCarouselText(text, runs, rubric, { number });
    const n = plan.items.length;
    const coverTitle = plan.cover.fields.title || plan.cover.fields.label || '(заголовок обложки — допишете)';
    const rows = [h('li', {}, h('b', { text: 'Обложка: ' }), coverTitle.split('\n')[0])];
    plan.items.slice(0, 8).forEach((it, i) => {
      const t = it.fields.title || (it.fields.body || '').split('\n')[0];
      rows.push(h('li', {}, h('b', { text: `${i + 1}. ` }), t.length > 60 ? t.slice(0, 58) + '…' : t));
    });
    if (n > 8) rows.push(h('li', { class: 'muted', text: `…и ещё ${n - 8}` }));
    const total = n + 1;
    summary.replaceChildren(
      h('div', { class: 'magic-total', text: `Получится ${total} ${pluralRu(total, 'слайд', 'слайда', 'слайдов')}` + (total > 20 ? ' — в карусели Instagram до 20' : '') }),
      h('ol', { class: 'magic-list' }, ...rows));
    go.disabled = false;
  };
  area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 120); syncEmpty(); });
  area.addEventListener('paste', e => {
    const cd = e.clipboardData;
    const html = cd ? cd.getData('text/html') : '';
    const plain = cd ? cd.getData('text/plain') : '';
    const r = html ? htmlToRich(html) : null;
    if (!(r && r.text.trim()) && !plain.trim()) return;
    e.preventDefault();
    if (r && r.text.trim()) document.execCommand('insertHTML', false, richToHtml(r.text, r.runs, true));
    else document.execCommand('insertText', false, plain.replace(/\r\n?/g, '\n'));
    refresh();
  });
  photoInput.addEventListener('change', () => {
    files = [...(photoInput.files || [])];
    photoNote.textContent = files.length ? `Выбрано: ${files.length}` : '';
  });

  const build = () => {
    const { text, runs } = read();
    if (!text.trim()) return;
    const plan = parseCarouselText(text, runs, rubric, { number });
    const p = buildMagicProject(rubric, plan);
    p.name = autoName(p);
    const picked = files;
    closeSheet();
    openProject(p);
    saveProject();
    if (picked.length) addPhotos(picked, 0);
    say(`Готово: ${p.slides.length} ${pluralRu(p.slides.length, 'слайд', 'слайда', 'слайдов')} — проверьте тексты`);
  };

  renderChips();
  body.append(
    h('div', { class: 'sheet-group' }, h('h4', { text: 'Рубрика' }), chips, hint),
    h('div', { class: 'sheet-group' }, h('h4', { text: 'Текст' }), area, numberRow),
    h('div', { class: 'sheet-group' }, summary),
    h('div', { class: 'sheet-group magic-photos' },
      btn('btn btn-outline btn-sm', 'images', 'Добавить фото (по желанию)', () => photoInput.click()), photoNote, photoInput),
    go);
  refresh();
  openSheet('Карусель из текста', body);
  setTimeout(() => area.focus(), 250);
}

/* ------------------------------------------------------------ стартовый */

function renderHome() {
  // шрифты
  const missing = missingFonts();
  el.fontNoteHome.hidden = !missing.length;
  if (missing.length) {
    el.fontNoteHome.replaceChildren(
      iconSpan('info'),
      h('div', {},
        h('div', {}, h('b', { text: 'Нет шрифтов макета: ' + missing.join(', ') + '. ' }),
          'Пока слайды рисуются похожими запасными шрифтами. Загрузите файлы шрифтов — они сохранятся в этом браузере.'),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          missing.includes('BravoRG') ? btn('btn btn-sm btn-outline', 'upload-simple', 'BravoRG', () => pickBrandFile('title')) : null,
          missing.includes('Nauryz Red Keds') ? btn('btn btn-sm btn-outline', 'upload-simple', 'Nauryz Red Keds', () => pickBrandFile('display')) : null)));
  }

  // черновики
  const drafts = readDrafts();
  el.draftsSection.hidden = !drafts.length;
  el.draftsRow.replaceChildren(...drafts.map(d => {
    const slides = normalizeSlides(d.data.slides);
    const first = slides[0];
    const canvas = h('canvas');
    const card = h('div', { class: 'draft-card', role: 'button', tabindex: '0', onclick: () => openDraft(d.id),
      onkeydown: e => { if (e.key === 'Enter') openDraft(d.id); } },
      h('span', { class: 'draft-thumb' }, canvas),
      h('div', { class: 'draft-name', text: d.name || 'Без названия' }),
      h('div', { class: 'draft-meta', text: (RUBRIC_BY_ID[d.data.rubric] || {}).name + ' · ' + formatAgo(d.updatedAt || Date.now()) }),
      h('button', { type: 'button', class: 'draft-del', title: 'Удалить черновик', 'aria-label': 'Удалить черновик', icon: 'x',
        onclick: e => { e.stopPropagation(); deleteDraft(d.id); } }));
    if (first) {
      const L = layoutOf(first);
      canvas.style.aspectRatio = `${L.W} / ${L.H}`;
      const paint = photo => {
        const width = 170;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = width * dpr;
        canvas.height = Math.round(width * dpr * L.H / L.W);
        const ctx = canvas.getContext('2d');
        const k = canvas.width / L.W;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        renderSlide(ctx, first, { assets, photo, transform: first.photo || {}, ghost: true, k, cardNo: 1 });
      };
      paint(null);
      if (first.photo) {
        idbGet(d.id + '/' + first.photo.id).then(async blob => {
          if (!(blob instanceof Blob)) return;
          try {
            if (/^video\//.test(blob.type)) {
              const vm = await createVideoMedia(blob);
              await seekVideo(vm.prev, Number(first.photo.start) || 0);
              const small = downscale(vm.prev, 600);
              releaseVideo(vm.prev);
              paint(small);
              return;
            }
            const img = await decodeBlob(blob); const small = downscale(img, 600); releaseImage(img);
            const a = photoAdj(first);
            paint(a ? adjustImage(small, a) : small);
          } catch { /* без фото */ }
        });
      }
    }
    return card;
  }));

  // рубрики
  el.rubricGrid.replaceChildren(...RUBRICS.map(r => {
    const art = h('div', { class: 'rubric-art' });
    const coverL = LAYOUTS[r.slides[0]];
    const back = r.slides[1] ? LAYOUTS[r.slides[1]] : null;
    const place = (c, L, dx, rot) => {
      const hPct = 80;
      c.style.height = hPct + '%';
      c.style.aspectRatio = `${L.W} / ${L.H}`;
      c.style.top = '10%';
      c.style.left = `calc(50% - ${hPct / 2 * L.W / L.H}% + ${dx}%)`;
      if (rot) c.style.transform = `rotate(${rot}deg)`;
    };
    if (back) {
      const c2 = layoutPreview(back.id, 220);
      place(c2, back, 16, 7);
      art.append(c2);
    }
    const c1 = layoutPreview(coverL.id, 220);
    place(c1, coverL, back ? -8 : 0, 0);
    art.append(c1);
    return h('button', { type: 'button', class: 'rubric-tile', onclick: () => createProject(r.id) },
      art, h('span', { class: 'rubric-name', text: r.name }), h('span', { class: 'rubric-desc', text: r.desc }));
  }));
}

function showHome() {
  stopPlayback();
  if (state.project) {
    saveProject();
    const keep = new Set(state.project.slides.map(s => s.photo && s.photo.id).filter(Boolean));
    deleteProjectMedia(state.project.id, keep);
  }
  closeSheet();
  state.quick = null;
  el.editor.classList.remove('quick');
  state.screen = 'home';
  state.project = null;
  freeMedia();
  el.editor.hidden = true;
  el.home.hidden = false;
  document.body.classList.remove('editing');
  renderHome();
  window.scrollTo(0, 0);
}

function showEditor() {
  state.screen = 'editor';
  hideInstallBanner();
  el.home.hidden = true;
  el.editor.hidden = false;
  document.body.classList.add('editing');
  refreshEditor(true);
  // один раз: текст можно править нажатием прямо на превью
  if (!isWide() && !readJson(STORE_HINT_TAP, false)) {
    writeJson(STORE_HINT_TAP, true);
    setTimeout(() => say('Нажмите на текст на превью — его можно править прямо там', 4800), 600);
  }
}

function refreshEditor(structure = true) {
  if (!state.project) return;
  el.docName.value = state.project.name;
  el.docRubric.textContent = rubricOf().name;
  if (structure) renderSlidesList();
  else syncSlideSelection(false);
  renderPanel();
  syncUndoButtons();
  scheduleRender();
}

/* ------------------------------------------------ телефон: клавиатура */
/*
 * Высота редактора = видимая область (visualViewport), а не окно: иначе
 * на iPhone открытая клавиатура уводит превью за верх экрана. Пока в поле
 * печатают, превью уменьшается и лента прячется (.typing).
 */
function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--app-h', (vv ? vv.height : window.innerHeight) + 'px');
  root.setProperty('--app-top', (vv && !isWide() ? vv.offsetTop : 0) + 'px');
}

function isEditable(node) {
  return node && (node.tagName === 'TEXTAREA' ||
    (node.tagName === 'INPUT' && /^(text|search|number|)$/.test(node.type || '')) || node.isContentEditable);
}

let typingTimer = null;
function wireTyping() {
  // рамка редактируемого текста на превью следует за фокусом
  el.panel.addEventListener('focusin', () => scheduleRender());
  el.panel.addEventListener('focusout', () => setTimeout(scheduleRender, 140));
  el.panel.addEventListener('focusin', e => {
    if (isWide() || !isEditable(e.target)) return;
    clearTimeout(typingTimer);
    el.editor.classList.add('typing');
    // поле целиком, с подписью: у полей с форматированием там кнопки «Ж» / «К»
    const target = e.target.closest('.field') || e.target;
    setTimeout(() => target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300);
  });
  el.panel.addEventListener('focusout', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (!isEditable(document.activeElement)) el.editor.classList.remove('typing');
    }, 120);
  });
}

/* --------------------------------------------------------------- события */

function wireEvents() {
  paintIcons();
  syncThemeButton();
  document.querySelectorAll('.theme-btn').forEach(b => b.addEventListener('click', toggleTheme));
  document.getElementById('btnHelpHome').addEventListener('click', openHelp);
  document.getElementById('btnHelp').addEventListener('click', openHelp);
  document.getElementById('btnImportProject').addEventListener('click', importProjectFile);
  document.getElementById('btnMagic').addEventListener('click', openMagicSheet);
  document.getElementById('btnHome').addEventListener('click', showHome);
  document.getElementById('btnExport').addEventListener('click', openExportSheet);
  el.btnUndo.addEventListener('click', undo);
  el.btnRedo.addEventListener('click', redo);
  el.btnPrev.addEventListener('click', () => selectSlide(state.current - 1));
  el.btnNext.addEventListener('click', () => selectSlide(state.current + 1));
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.getElementById('sheetClose').addEventListener('click', closeSheet);
  document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);

  el.docName.addEventListener('input', () => {
    if (!state.project) return;
    state.project.name = el.docName.value;
    state.project.nameAuto = false;
    scheduleSave();
  });
  el.docName.addEventListener('change', () => {
    if (state.project && !el.docName.value.trim()) {
      state.project.nameAuto = true;
      state.project.name = autoName(state.project);
      el.docName.value = state.project.name;
      scheduleSave();
    }
  });
  el.docName.addEventListener('keydown', e => { if (e.key === 'Enter') el.docName.blur(); });

  wireStage();
  wireTyping();
  wireViewer();
  // iOS Safari: щипок на превью — масштаб фото, а не страницы
  ['gesturestart', 'gesturechange'].forEach(t => el.stage.addEventListener(t, e => e.preventDefault()));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.sheet.hidden) { closeSheet(); e.preventDefault(); }
      else if (!viewer.el.hidden) { closeViewer(); e.preventDefault(); }
      return;
    }
    if (!viewer.el.hidden) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const i = clamp(viewerIndex() + (e.key === 'ArrowRight' ? 1 : -1), 0, viewer.track.children.length - 1);
        viewer.track.scrollTo({ left: i * viewer.track.clientWidth, behavior: 'smooth' });
      }
      return;
    }
    if (state.screen !== 'editor' || !el.sheet.hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    const typing = isEditable(e.target);
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openExportSheet(); return; }
    if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    // стрелки нужны самим ползункам и полям — листаем, только если фокус не в них
    if (typing || (e.target.closest && e.target.closest('input, select, textarea, [role="radiogroup"]'))) return;
    if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); selectSlide(state.current + 1); }
    if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); selectSlide(state.current - 1); }
  });

  // «Ж» / «К» у поля с форматированием подсвечиваются по месту курсора
  document.addEventListener('selectionchange', syncFmtButtons);

  // ⌘V с картинкой — фото на текущий слайд
  document.addEventListener('paste', e => {
    if (state.screen !== 'editor') return;
    const cd = e.clipboardData;
    // в поле вставляют текст: Word и др. кладут в буфер ещё и картинку текста — это не фото
    if (cd && isEditable(e.target) && (cd.getData('text/plain') || '').trim()) return;
    const files = [...(cd && cd.files || [])].filter(f => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    addPhotos(files, state.current);
  });

  // перетаскивание файлов в окно
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', e => {
    if (state.screen !== 'editor' || !hasFiles(e)) return;
    dragDepth++;
    el.dropHint.hidden = false;
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) hideDropHint();
  });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    dragDepth = 0;
    hideDropHint();
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (state.screen === 'editor' && e.dataTransfer.files.length) addPhotos(e.dataTransfer.files, state.current);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    // панель «Ж · К» у выделения едет вместе с текстом и клавиатурой
    window.visualViewport.addEventListener('resize', scheduleFmtPopup);
    window.visualViewport.addEventListener('scroll', scheduleFmtPopup);
  }
  el.panelBody.addEventListener('scroll', scheduleFmtPopup, { passive: true });
  window.addEventListener('resize', () => { syncViewport(); scheduleRender(); });
  const wideQuery = window.matchMedia('(min-width: 900px)');
  const onWide = () => { if (state.screen === 'editor') refreshEditor(true); };
  if (wideQuery.addEventListener) wideQuery.addEventListener('change', onWide);
  else if (wideQuery.addListener) wideQuery.addListener(onWide);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPlayback();
      if (state.project) saveProject();
    }
  });
  window.addEventListener('pagehide', () => { if (state.project) saveProject(); });
  window.addEventListener('beforeunload', e => {
    if (state.project) saveProject();
    // фото без IndexedDB после перезагрузки пропадут — переспросим
    if (!state.idbOk && media.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function start() {
  syncViewport();
  loadPrefs();
  wireEvents();
  wireInstallBanner();
  openDb();
  await Promise.all([loadFonts(), loadBrand()]);
  renderHome();
  reopenAfterUpdate();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('service-worker.js').catch(() => { /* офлайна не будет — не страшно */ });
  }
}

start();
