/*
 * Интерфейс конструктора «Город 24».
 *
 * Два экрана в одной странице: стартовый (рубрики + черновики) и редактор
 * (превью, лента слайдов, форма слайда, экспорт). Вся вёрстка слайдов —
 * в render.js (LAYOUTS), здесь только состояние, формы и жесты.
 *
 * Данные проекта: { id, name, rubric, slides: [slide] }, где
 *   slide = { id, layout, fields: {title, body, …}, opts: {arrow, shade},
 *             size: {title, body}, photo: {id, zoom, x, y} | null }
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
  title: { label: 'Заголовок', multiline: true, group: 'title', hint: 'Enter — перенос строки' },
  subtitle: { label: 'Подзаголовок', multiline: true, group: 'body' },
  body: { label: 'Текст', multiline: true, big: true, group: 'body', hint: 'Пустая строка — новый абзац' },
  address: { label: 'Адрес', group: 'body', hint: '📍 добавится сам' },
  number: { label: 'Число', group: 'title', inputmode: 'numeric' },
  label: { label: 'Подпись к числу', multiline: true, group: 'title' },
  dates: { label: 'Даты', group: 'body' },
  date: { label: 'Дата', group: 'body', hint: '📅 добавится сам' },
  place: { label: 'Место', multiline: true, group: 'body', hint: '📍 добавится сам' },
};
const FIELD_LABELS = {
  'int-card': { title: 'Вопрос или заголовок', body: 'Ответ' },
  'new-card': { title: 'Название заведения', body: 'Описание (белая плашка)' },
  'ev-card': { title: 'Название события', body: 'Описание' },
  'fav-card': { body: 'Текст под фото' },
};

const el = {};
['home', 'editor', 'draftsSection', 'draftsRow', 'rubricGrid', 'fontNoteHome', 'brandLogo',
 'docName', 'docRubric', 'slidesList', 'stage', 'stageInner', 'stageCanvas', 'stageOverlay',
 'warnings', 'slideCounter', 'panel', 'panelBody', 'btnPrev', 'btnNext', 'btnUndo', 'btnRedo',
 'sheet', 'sheetTitle', 'sheetBody', 'status', 'filePicker', 'projectPicker', 'brandPicker', 'dropHint']
  .forEach(id => { el[id] = document.getElementById(id); });

const state = {
  screen: 'home',
  project: null,
  current: 0,
  tab: 'slide',
  overflow: [],          // по индексу слайда — текст не помещается
  lastRender: null,      // результат отрисовки текущего слайда на превью
  exportFormat: 'png',
  exportWidth: 1440,
  undo: [],
  redo: [],
  idbOk: true,
  userFonts: { title: false, display: false },
  userLogo: false,
  fontsVersion: 0,
  panHintAt: 0,          // когда показали подсказку «двигайте фото»
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

/* Обрезает прозрачные поля — логотип встаёт в рамку по видимой части. */
function trimTransparent(img) {
  const [w, h] = mediaSize(img);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
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
  const specs = ['400 40px G24Title', '400 40px G24Display', '400 40px G24Body', 'italic 400 40px G24Body'];
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

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/*
 * Файл → фото проекта: уменьшаем до PHOTO_MAX (для хранения и экспорта) и
 * до PREVIEW_MAX (для превью), кладём в IndexedDB. Возвращает id фото.
 */
async function importPhoto(file) {
  let img;
  try { img = await decodeBlob(file); } catch {
    throw new Error('Не получилось открыть фото' + (/heic|heif/i.test(file.type + file.name) ? ' (HEIC — сохраните как JPEG)' : ''));
  }
  const [w, h] = mediaSize(img);
  let blob = file;
  let fw = w, fh = h;
  const plain = /image\/(jpeg|png|webp)/.test(file.type);
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
  for (const m of media.values()) { if (m.prev) { m.prev.width = 0; m.prev.height = 0; } }
  media.clear();
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
    opts: Object.assign({}, s.opts),
    size: Object.assign({}, s.size),
    photo: s.photo && s.photo.id ? { id: String(s.photo.id), zoom: Number(s.photo.zoom) || 1,
      x: Number(s.photo.x) || 0, y: Number(s.photo.y) || 0 } : null,
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
  state.current = index;
  state.panHintAt = 0;
  syncSlideSelection(scroll);
  if (changed) renderPanel();
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

function setField(key, value) {
  const slide = currentSlide();
  pushUndo('text:' + slide.id + ':' + key);
  slide.fields[key] = value;
  syncAutoName();
  scheduleRender();
  scheduleSave();
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
  const list = [...files].filter(f => f && /^image\//.test(f.type || 'image/'));
  if (!list.length) return;
  const slides = state.project.slides;
  const targets = [];
  for (let i = startIndex; i < slides.length && targets.length < list.length; i++) {
    if (layoutOf(slides[i]).photo && (i === startIndex || !slides[i].photo)) targets.push(i);
  }
  pushUndo();
  say(list.length > 1 ? `Загружаю ${list.length} ${pluralRu(list.length, 'фото', 'фото', 'фото')}…` : 'Загружаю фото…', 60000);
  let done = 0, failed = 0;
  const cardLayout = rubricOf().card;
  for (const file of list) {
    let id;
    try { id = await importPhoto(file); } catch (err) { failed++; say(err.message); continue; }
    let idx = targets.shift();
    if (idx === undefined) {
      if (!LAYOUTS[cardLayout].photo) { failed++; continue; }
      const slide = newSlide(cardLayout);
      state.project.slides.push(slide);
      idx = state.project.slides.length - 1;
    }
    state.project.slides[idx].photo = { id, zoom: 1, x: 0, y: 0 };
    done++;
    if (idx === state.current) state.panHintAt = Date.now();
    commit({ structure: true });
  }
  if (done) say(done > 1 ? `Добавлено ${done} фото` : 'Фото добавлено');
  else if (!failed) say('Нет слайдов с местом под фото');
}

function removePhoto(index = state.current) {
  const slide = state.project.slides[index];
  if (!slide.photo) return;
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
  const m = slide.photo && media.get(slide.photo.id);
  return Object.assign({
    assets,
    photo: m ? m.prev : null,
    transform: slide.photo || {},
    ghost: true,
    k: 1,
    cardNo: index >= 0 && state.project ? cardNo(index) : 1,
  }, extra);
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
  // на телефоне оставляем место под стрелки листания по бокам
  const sidePad = isWide() ? 0 : 36;
  const cssW = Math.floor(Math.min(box.w - sidePad * 2, box.h * L.W / L.H));
  const cssH = Math.round(cssW * L.H / L.W);
  el.stageCanvas.style.width = cssW + 'px';
  el.stageCanvas.style.height = cssH + 'px';
  const res = paintSlide(el.stageCanvas, slide, state.current, cssW);
  state.lastRender = { res, cssW, cssH, scale: cssW / L.W, layout: L };
  state.overflow[state.current] = Boolean(res.overflow);
  renderOverlay();
  renderWarnings();
  const n = state.project.slides.length;
  el.slideCounter.textContent = `${state.current + 1} / ${n}`;
  el.btnPrev.disabled = state.current === 0;
  el.btnNext.disabled = state.current >= n - 1;
  updateSlideDot(state.current);
}

const PAN_HINT_MS = 3400;
function renderOverlay() {
  const slide = currentSlide();
  const L = layoutOf(slide);
  const r = state.lastRender;
  el.stageOverlay.replaceChildren();
  if (!L.photo || !r || !r.res.photo) return;
  const area = r.res.photo;
  const hasPhoto = slide.photo && media.has(slide.photo.id);
  const loading = slide.photo && loadingMedia.has(slide.photo.id);
  const cx = (area.cx !== undefined ? area.cx : area.x + area.w / 2) * r.scale;
  let cy = (area.cy !== undefined ? area.cy : area.y + area.h / 2) * r.scale;
  // на обложке фото на весь слайд — кнопку ставим повыше, чтобы не спорить с текстом
  if (area.w >= L.W - 1 && area.h >= L.H - 1) cy = r.cssH * 0.4;
  if (!hasPhoto) {
    const pill = btn('photo-pill', 'image', loading ? 'Загружаю…' : 'Добавить фото', e => {
      e.stopPropagation();
      pickPhotos();
    });
    pill.style.left = cx + 'px';
    pill.style.top = cy + 'px';
    el.stageOverlay.append(pill);
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
  const perFull = r.res.photo.applied.scale * m.prev.width / m.w;
  const L = layoutOf(slide);
  const exportK = L.W === 1440 ? state.exportWidth / 1440 : 1;
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
    if (e.target.closest('button')) return;
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
    if (g.type === 'pan') {
      if (g.moved) settleFrame();
      return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.mouse && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      selectSlide(state.current + (dx < 0 ? 1 : -1));
      return;
    }
    // тап по пустому месту под фото — выбрать фото
    const slide = currentSlide();
    if (!g.moved && g.inside && layoutOf(slide).photo && !(slide.photo && media.has(slide.photo.id))) pickPhotos();
  };
  stage.addEventListener('pointerup', end);
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
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
  const body = el.panelBody;
  const keepScroll = body.dataset.for === state.tab + ':' + (currentSlide() || {}).id ? body.scrollTop : 0;
  body.replaceChildren(state.tab === 'settings' ? buildSettingsForm() : buildSlideForm());
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
  const info = FIELD_INFO[key];
  const label = (FIELD_LABELS[L.id] && FIELD_LABELS[L.id][key]) || info.label;
  const ph = placeholderFor(L, key, { cardNo: cardNo(index) }).replace(/\n/g, ' ');
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
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, h('span', { text: label }), info.hint ? h('span', { class: 'muted small', text: info.hint }) : null),
    control);
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

function segControl(options, value, onPick) {
  const seg = h('div', { class: 'seg', role: 'radiogroup' });
  for (const [val, label] of options) {
    const b = h('button', { type: 'button', class: val === value ? 'on' : '', text: label, role: 'radio',
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
  root.append(fields);

  // фото
  if (L.photo) root.append(buildPhotoSection(slide));

  // оформление
  const look = [];
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
  root.append(section('Слайд', null, h('div', { class: 'actions-grid' },
    btn('btn btn-outline', 'plus', 'Новый слайд', () => openLayoutSheet('add')),
    btn('btn btn-outline', 'copy', 'Дублировать', () => duplicateSlide()),
    btn('btn btn-outline', wide ? 'arrow-up' : 'arrow-left', wide ? 'Выше' : 'Левее', () => moveSlide(i, i - 1)),
    btn('btn btn-outline', wide ? 'arrow-down' : 'arrow-right', wide ? 'Ниже' : 'Правее', () => moveSlide(i, i + 1)),
    btn('btn btn-danger', 'trash', 'Удалить слайд', () => deleteSlide()))));

  return root;
}

function buildPhotoSection(slide) {
  const m = slide.photo && media.get(slide.photo.id);
  const thumb = h('span', { class: 'photo-thumb' });
  if (m) {
    const c = downscale(m.prev, 160);
    c.style.width = '100%'; c.style.height = '100%'; c.style.objectFit = 'cover'; c.style.display = 'block';
    thumb.append(c);
  }
  const actions = h('div', { class: 'photo-actions' },
    btn('btn btn-primary btn-sm', 'image', m ? 'Заменить' : 'Выбрать фото', () => pickPhotos()),
    m ? btn('btn btn-ghost btn-sm', 'x', 'Убрать', () => removePhoto()) : null);
  const rows = [h('div', { class: 'photo-row' }, thumb, actions)];
  if (m) {
    rows.push(h('div', { style: 'height:12px' }));
    rows.push(rangeRow('Масштаб', { min: 100, max: ZOOM_MAX * 100, value: Math.round((slide.photo.zoom || 1) * 100), unit: '%', key: 'zoom',
      onInput: x => { pushUndo('frame'); slide.photo.zoom = x / 100; scheduleRender(); },
      onChange: () => settleFrame() }));
    rows.push(h('p', { class: 'field-hint', text: isTouch()
      ? 'Кадр двигается пальцем прямо на превью, щипок двумя пальцами — масштаб.'
      : 'Кадр двигается мышью прямо на превью, колесо — масштаб. Фото можно вставить через ⌘V или перетащить.' }));
  } else {
    rows.push(h('p', { class: 'field-hint', style: 'margin-top:10px', text: 'Можно выбрать сразу несколько — разложатся по слайдам, лишним добавятся новые карточки.' }));
  }
  return section('Фото', m ? btn('btn btn-ghost btn-sm', null, 'Сбросить кадр', () => resetFrame()) : null, ...rows);
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
  return L.fields.some(k => (slide.fields[k] || '').trim()) || Boolean(L.photo && slide.photo && media.has(slide.photo.id));
}

/* Слайд в полном размере: фото раскодируется из оригинала только на время отрисовки. */
async function renderExport(slide, index) {
  const L = layoutOf(slide);
  const k = L.W === 1440 ? state.exportWidth / 1440 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(L.W * k);
  canvas.height = Math.round(L.H * k);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  const m = L.photo && slide.photo && media.get(slide.photo.id);
  let full = null;
  if (m) { try { full = await decodeBlob(m.blob); } catch { full = null; } }
  renderSlide(ctx, slide, envFor(slide, index, { ghost: false, k, photo: full || (m ? m.prev : null) }));
  releaseImage(full);
  return canvas;
}

function exportName(i, ext) {
  return `${fileSlug(state.project.name, 'gorod24')}-${String(i + 1).padStart(2, '0')}.${ext}`;
}

/* Готовит файлы. only — индекс одного слайда или null (все). */
async function buildFiles(only, onProgress) {
  const slides = state.project.slides;
  const idx = only === null ? slides.map((_, i) => i).filter(i => slideHasContent(slides[i])) : [only];
  const mime = state.exportFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext = state.exportFormat === 'jpeg' ? 'jpg' : 'png';
  const files = [];
  let n = 0;
  for (const i of idx) {
    const canvas = await renderExport(slides[i], i);
    const blob = await canvasToBlob(canvas, mime, 0.95);
    canvas.width = canvas.height = 0;
    if (blob) files.push(new File([blob], exportName(i, ext), { type: mime }));
    n++;
    if (onProgress) onProgress(n / idx.length);
    await new Promise(r => setTimeout(r, 0));
  }
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

let exportBusy = false;

function openExportSheet() {
  if (!state.project) return;
  const slides = state.project.slides;
  const count = slides.filter(slideHasContent).length;
  const progress = h('div', { class: 'progress', hidden: true }, h('div'));
  const bar = progress.firstChild;
  const setProgress = f => { progress.hidden = false; bar.style.width = Math.round(f * 100) + '%'; };
  const list = h('div', { class: 'sheet-list' });
  const note = h('p', { class: 'sheet-note' });

  const run = async (label, fn) => {
    if (exportBusy) return;
    if (!count && label !== 'one') { say('Пока нечего сохранять — добавьте текст или фото'); return; }
    exportBusy = true;
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
      ? 'В окне «Поделиться» выберите «Сохранить изображения» — слайды окажутся в Фото, оттуда в Instagram.'
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
  if (!isTouch() && navigator.clipboard && window.ClipboardItem) {
    list.append(btn('btn', 'copy', 'Скопировать слайд в буфер', () => run('one', async () => {
      const canvas = await renderExport(currentSlide(), state.current);
      const blob = await canvasToBlob(canvas, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      say('Слайд скопирован');
    })));
  }

  const L = layoutOf(currentSlide());
  const body = h('div', {},
    h('div', { class: 'sheet-group' }, list, progress, note),
    h('div', { class: 'sheet-group' },
      h('h4', { text: 'Формат' }),
      segControl([['png', 'PNG'], ['jpeg', 'JPG']], state.exportFormat, v => { state.exportFormat = v; savePrefs(); }),
      h('div', { style: 'height:10px' }),
      segControl([[1440, '1440×1800'], [1080, '1080×1350']], state.exportWidth, v => { state.exportWidth = v; savePrefs(); scheduleRender(); }),
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
      <li>Пишите текст в полях под превью: слайд обновляется сразу. Бледный текст на слайде — подсказка, в готовую картинку он не попадёт.</li>
      <li>«Добавить фото» на превью или в блоке «Фото». Можно выбрать сразу несколько — разложатся по слайдам, лишним добавятся новые карточки.</li>
      <li>Кадр двигается пальцем (или мышью) прямо на превью, щипок или колесо — масштаб.</li>
      <li>«+» в ленте — новый слайд любого макета, в том числе из другой рубрики. Нажмите на текущий слайд в ленте ещё раз — меню: дублировать, переставить, удалить.</li>
    </ul>
    <h4>Если текст не помещается</h4>
    <p>Под превью появится «Текст не помещается» и жёлтая точка на миниатюре. «Уместить» уменьшит кегль, пока текст не влезет, или подвиньте ползунки «Размер текста».</p>
    <h4>Сохранить</h4>
    <p>Кнопка «Готово» вверху. На телефоне — «Сохранить в Фото / отправить»: в системном окне выберите «Сохранить изображения» или сразу Instagram/Telegram. На компьютере — ZIP или по одному файлу, PNG или JPG, 1440×1800 (как в макете) или 1080×1350.</p>
    <h4>Черновики</h4>
    <p>Всё сохраняется само — и тексты, и фото — в этом браузере. Черновики видны на стартовом экране. «Настройки → Сохранить файл» — чтобы продолжить на другом устройстве (без фото).</p>
    <h4>Горячие клавиши</h4>
    <p><kbd>⌘Z</kbd> отменить, <kbd>⌘⇧Z</kbd> повторить, <kbd>⌘S</kbd> сохранить, <kbd>⌘V</kbd> вставить фото, <kbd>PageUp</kbd>/<kbd>PageDown</kbd> соседний слайд. На Windows вместо ⌘ — Ctrl.</p>
    <h4>На телефон</h4>
    <p>Конструктор ставится как приложение: в Safari «Поделиться → На экран «Домой»», в Chrome — «Установить приложение». Работает и без интернета.</p>`;
  openSheet('Как пользоваться', body);
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
          try { const img = await decodeBlob(blob); const small = downscale(img, 600); releaseImage(img); paint(small); } catch { /* без фото */ }
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
  if (state.project) {
    saveProject();
    const keep = new Set(state.project.slides.map(s => s.photo && s.photo.id).filter(Boolean));
    deleteProjectMedia(state.project.id, keep);
  }
  closeSheet();
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
  el.panel.addEventListener('focusin', e => {
    if (isWide() || !isEditable(e.target)) return;
    clearTimeout(typingTimer);
    el.editor.classList.add('typing');
    setTimeout(() => e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300);
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

  // ⌘V с картинкой — фото на текущий слайд
  document.addEventListener('paste', e => {
    if (state.screen !== 'editor') return;
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
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
  }
  window.addEventListener('resize', () => { syncViewport(); scheduleRender(); });
  const wideQuery = window.matchMedia('(min-width: 900px)');
  const onWide = () => { if (state.screen === 'editor') refreshEditor(true); };
  if (wideQuery.addEventListener) wideQuery.addEventListener('change', onWide);
  else if (wideQuery.addListener) wideQuery.addListener(onWide);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.project) saveProject();
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
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('service-worker.js').catch(() => { /* офлайна не будет — не страшно */ });
  }
}

start();
