/*
 * Отрисовка слайдов «Город 24» на Canvas.
 *
 * Все размеры — в единицах макета Figma (пост 1440×1800, рилс 1080×1920)
 * и сняты с него один в один. Масштаб до реального размера картинки
 * задаётся снаружи через ctx.setTransform, поэтому переносы строк в превью
 * и в экспорте одинаковые.
 *
 * Координата «top» у текста — это верх прописных букв, а не верх строки:
 * в макете у всех текстов включён text-box-trim (cap height → baseline),
 * так что в Figma y текстового блока — это ровно линия прописных. Здесь
 * так же: baseline первой строки = top + высота прописных (capRatio).
 *
 * LAYOUTS — единственный источник правды для каждого макета: какие поля,
 * есть ли фото, стрелка, затемнение и сама функция отрисовки. Никаких
 * пиксельных значений вёрстки вне этого файла быть не должно.
 */

/* ------------------------------------------------------------- шрифты */

// Пользовательский шрифт (загружен в «Настройках») идёт первым, за ним
// вшитый при сборке. Если ни один не загрузился — системный sans-serif.
const FONT_FAMILY = {
  title: "'G24TitleUser', 'G24Title', sans-serif",      // BravoRG
  display: "'G24DisplayUser', 'G24Display', sans-serif", // Nauryz Red Keds
  body: "'G24Body', sans-serif",                        // Inter
};

// Высота прописных в долях кегля — по макету (высоты текстовых блоков
// с text-box-trim): BravoRG 150px → 105, Nauryz 115px → 82, Inter 60px → 44.
// Реальная высота меряется в браузере (capRatio), эти числа — запас на
// случай, если measureText не отдаёт actualBoundingBoxAscent.
const CAP_DEFAULT = { title: 0.70, display: 0.713, body: 0.727 };

// Сжатие по горизонтали для запасных шрифтов. BravoRG очень узкий, и
// запасной Oswald без сжатия ломал бы строки совсем не так, как в макете.
// Пока настоящий шрифт не добавлен, app.js ставит сюда < 1; с настоящим
// шрифтом всегда 1.
const FONT_STRETCH = { title: 1, display: 1, body: 1 };
const INTER_LEAD = 1.21;   // «normal» межстрочный у Inter в Figma

const WHITE = '#ffffff';
// Фирменный кремовый: по переключателю «Фирменный цвет» им красятся светлый
// текст и стрелки на тёмных слайдах, плашки и белый фон карточек.
// Логотип остаётся белым/чёрным, как в макете.
const BRAND_CREAM = '#FEF3BD';

function brandTone(slide) { return Boolean(slide && slide.opts && slide.opts.tone === 'brand'); }
/* Светлый текст и стрелка поверх фото. */
function ink(slide) { return brandTone(slide) ? BRAND_CREAM : WHITE; }
/* Плашки и белый фон карточек (текст на них остаётся чёрным). */
function paper(slide) { return brandTone(slide) ? BRAND_CREAM : WHITE; }
const BLACK = '#000000';
const EVENT_RED = '#700004';

const capCache = new Map();
function resetCapCache() { capCache.clear(); }

function capRatio(ctx, font) {
  if (capCache.has(font)) return capCache.get(font);
  let ratio = CAP_DEFAULT[font];
  ctx.save();
  ctx.font = `400 100px ${FONT_FAMILY[font]}`;
  const m = ctx.measureText('НHЕ');
  ctx.restore();
  if (m && typeof m.actualBoundingBoxAscent === 'number' && m.actualBoundingBoxAscent > 20) {
    ratio = m.actualBoundingBoxAscent / 100;
  }
  capCache.set(font, ratio);
  return ratio;
}

/* ---------------------------------------------------- текст: перенос */

const HAS_LETTER_SPACING = typeof CanvasRenderingContext2D !== 'undefined' &&
  'letterSpacing' in CanvasRenderingContext2D.prototype;

/*
 * Короткие служебные слова не должны оставаться в конце строки —
 * такое слово переносится вместе со следующим.
 */
const GLUE_WORDS = new Set([
  'в', 'во', 'на', 'к', 'ко', 'с', 'со', 'у', 'о', 'об', 'обо', 'от', 'ото',
  'до', 'из', 'изо', 'за', 'по', 'под', 'над', 'при', 'про', 'для', 'без',
  'не', 'ни', 'и', 'а', 'но', 'да', 'же', 'ли', 'бы', 'то', 'как', 'что',
  'или', 'их', 'его', 'её', 'ее', 'мы', 'вы', 'он', 'она', 'они', 'я',
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'by', 'is', 'or', 'and',
]);

function isGlueWord(text) {
  const clean = text.replace(/[«»"'(„“]/g, '').toLowerCase();
  return clean.length > 0 && (clean.length <= 2 || GLUE_WORDS.has(clean));
}

const HYPHENS = '-‐–';

/* Слово с дефисами → куски, после каждого дефиса можно перенести строку
   (как в Figma: «Каракол-» / «Корумду»). */
function splitHyphens(word) {
  const out = [];
  let cur = '';
  for (let i = 0; i < word.length; i++) {
    cur += word[i];
    if (HYPHENS.includes(word[i]) && i > 0 && i < word.length - 1 && !HYPHENS.includes(word[i + 1])) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function setTracking(ctx, px) {
  if (HAS_LETTER_SPACING) ctx.letterSpacing = (px || 0).toFixed(2) + 'px';
}

function measureTracked(ctx, text, track, stretch = 1) {
  const w = ctx.measureText(text).width;
  return (HAS_LETTER_SPACING ? w : w + (track || 0) * [...text].length) * stretch;
}

function fillTracked(ctx, text, x, y, track) {
  if (HAS_LETTER_SPACING || !track) { ctx.fillText(text, x, y); return; }
  // старые браузеры без ctx.letterSpacing — посимвольно
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + track;
  }
}

/* Одна строка текста (без \n) → строки по ширине. */
function wrapLine(ctx, raw, track, maxWidth, stretch = 1) {
  const words = raw.split(/\s+/).filter(Boolean);
  // неразрывные куски: слово-«клей» + следующее слово, куски слова через дефис
  const units = [];
  for (let i = 0; i < words.length; i++) {
    const pieces = splitHyphens(words[i]);
    pieces.forEach((p, j) => units.push({ text: p, sep: j === 0 ? ' ' : '' }));
  }
  const groups = [];
  for (let i = 0; i < units.length; i++) {
    const prev = groups[groups.length - 1];
    const prevUnit = units[i - 1];
    const glued = prev && units[i].sep === ' ' && prevUnit && prevUnit.sep === ' ' &&
      !HYPHENS.includes(prevUnit.text.slice(-1)) && isGlueWord(prevUnit.text) &&
      (i < 2 || units[i - 1].sep === ' ');
    if (glued) prev.text += ' ' + units[i].text;
    else groups.push({ text: units[i].text, sep: units[i].sep });
  }
  const lines = [];
  let line = '';
  const limit = maxWidth * 1.002;
  for (const g of groups) {
    if (!line) { line = g.text; continue; }
    const candidate = line + g.sep + g.text;
    if (measureTracked(ctx, candidate, track, stretch) <= limit) line = candidate;
    else { lines.push(line); line = g.text; }
  }
  if (line) lines.push(line);
  return lines;
}

/*
 * Текстовый блок: раскладывает текст по строкам и считает высоту.
 * height — от верха прописных первой строки до базовой линии последней
 * (так же, как высоты текстов в макете с text-box-trim).
 */
function textBlock(ctx, text, st, scale = 1, maxWidth = 1e6) {
  const size = st.size * scale;
  const lead = st.lead ? st.lead * scale : size * INTER_LEAD;
  const track = (st.track || 0) * scale;
  const font = `${st.italic ? 'italic ' : ''}400 ${size}px ${FONT_FAMILY[st.font]}`;
  const stretch = FONT_STRETCH[st.font] || 1;
  ctx.save();
  ctx.font = font;
  setTracking(ctx, track);
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) { lines.push({ text: '', width: 0 }); continue; }
    for (const l of wrapLine(ctx, raw.trim(), track, maxWidth, stretch)) {
      lines.push({ text: l, width: measureTracked(ctx, l, track, stretch) });
    }
  }
  ctx.restore();
  // пустые строки по краям блока не рисуются и места не занимают
  while (lines.length && !lines[0].text) lines.shift();
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  const cap = capRatio(ctx, st.font) * size;
  const height = lines.length ? cap + (lines.length - 1) * lead : 0;
  const width = lines.reduce((m, l) => Math.max(m, l.width), 0);
  return { lines, size, lead, track, font, cap, height, width, maxWidth, st, stretch };
}

function drawBlock(ctx, b, x, capTop, color, align = 'left', alpha = 1) {
  if (!b || !b.lines.length) return;
  ctx.save();
  ctx.font = b.font;
  setTracking(ctx, b.track);
  ctx.fillStyle = color;
  ctx.globalAlpha *= alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let base = capTop + b.cap;
  for (const line of b.lines) {
    if (line.text) {
      let lx = x;
      if (align === 'center') lx = x + (b.maxWidth - line.width) / 2;
      else if (align === 'right') lx = x + b.maxWidth - line.width;
      if (b.stretch !== 1) {
        ctx.save();
        ctx.translate(lx, 0);
        ctx.scale(b.stretch, 1);
        fillTracked(ctx, line.text, 0, base, b.track);
        ctx.restore();
      } else {
        fillTracked(ctx, line.text, lx, base, b.track);
      }
    }
    base += b.lead;
  }
  ctx.restore();
}

/* ------------------------------------------------------- фон и детали */

// Сетка линий на белых карточках: группа «линии на фоне», повёрнута на 6°,
// линии 1px чёрные с прозрачностью 15%. Координаты начала каждой линии —
// из макета (relativeTransform).
const GRID = {
  cos: 0.9945176839828491, sin: 0.10456832498311996,
  hLen: 3160.97, vLen: 2366.05,
  h: [[-1087.96, -246.15], [-1014.62, 451.40], [-977.94, 800.18], [-941.27, 1148.95],
      [-904.60, 1497.72], [-867.93, 1846.51]],
  v: [[-531.63, -276.43], [-182.86, -313.11], [165.92, -349.78], [514.69, -386.45],
      [863.47, -423.12], [1212.24, -459.80], [1561.02, -496.47], [1909.80, -533.14]],
};

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, y] of GRID.h) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + GRID.hLen * GRID.cos, y - GRID.hLen * GRID.sin);
  }
  for (const [x, y] of GRID.v) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + GRID.vLen * GRID.sin, y + GRID.vLen * GRID.cos);
  }
  ctx.stroke();
  ctx.restore();
}

/* «Тень» — градиент от прозрачного к чёрному снизу карточки. */
function drawShade(ctx, W, H, top, strength) {
  if (!(strength > 0)) return;
  const g = ctx.createLinearGradient(0, top, 0, H);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, `rgba(0, 0, 0, ${Math.min(1, strength)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, W, H - top);
}

// Логотип: в макете это маска 152×129 в правом верхнем углу (1198, 149),
// залитая белым или чёрным. Видимая часть знака — 1198…1350 × 148…278.
const LOGO_BOX = { x: 1198, y: 148, w: 152, h: 130 };
const LOGO_BOX_BOTTOM = { x: 1198, y: 1520, w: 152, h: 130 };

function drawLogo(ctx, env, box, color) {
  const logo = color === BLACK ? env.assets.logoBlack : env.assets.logoWhite;
  if (!logo) return;
  const iw = logo.width, ih = logo.height;
  const s = Math.min(box.w / iw, box.h / ih);
  const w = iw * s, h = ih * s;
  ctx.drawImage(logo, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

// Стрелка «листай дальше»: линия 61px, толщина 10, скруглённые концы,
// наконечник-«галочка» под 45°.
function drawArrow(ctx, color, y = 1687) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(1285, y);
  ctx.lineTo(1346, y);
  ctx.moveTo(1346 - 32.5, y - 32.5);
  ctx.lineTo(1346, y);
  ctx.lineTo(1346 - 32.5, y + 32.5);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------- фото */

function mediaSize(img) {
  return [img.naturalWidth || img.videoWidth || img.width, img.naturalHeight || img.videoHeight || img.height];
}

/*
 * Фото «по размеру области с обрезкой» (cover) с масштабом и сдвигом.
 * Сдвиг t.x/t.y — в единицах макета от центра, ограничивается так,
 * чтобы по краям области не было пустот. Возвращает применённый сдвиг.
 */
function drawCover(ctx, img, x, y, w, h, t = {}) {
  const [iw, ih] = mediaSize(img);
  if (!iw || !ih) return { x: 0, y: 0, scale: 1 };
  const base = Math.max(w / iw, h / ih);
  const zoom = Math.min(Math.max(t.zoom || 1, 1), 5);
  const s = base * zoom;
  const dw = iw * s, dh = ih * s;
  const mx = (dw - w) / 2, my = (dh - h) / 2;
  const ox = Math.min(Math.max(t.x || 0, -mx), mx);
  const oy = Math.min(Math.max(t.y || 0, -my), my);
  ctx.drawImage(img, x + (w - dw) / 2 + ox, y + (h - dh) / 2 + oy, dw, dh);
  return { x: ox, y: oy, scale: s };
}

function drawPhotoRect(ctx, env, x, y, w, h, fallback = BLACK) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  let applied = null;
  if (env.photo) applied = drawCover(ctx, env.photo, x, y, w, h, env.transform);
  else if (fallback) { ctx.fillStyle = fallback; ctx.fillRect(x, y, w, h); }
  ctx.restore();
  return { shape: 'rect', x, y, w, h, deg: 0, applied };
}

/* Фото в повёрнутой рамке (стопка фотографий, полароид). bleed — запас
   за край рамки, чтобы не просвечивал чёрный плейсхолдер под фото. */
function drawPhotoQuad(ctx, env, q, fallback = BLACK) {
  const b = q.bleed || 0;
  ctx.save();
  ctx.translate(q.cx, q.cy);
  ctx.rotate(q.deg * Math.PI / 180);
  ctx.beginPath();
  ctx.rect(-q.w / 2 - b, -q.h / 2 - b, q.w + 2 * b, q.h + 2 * b);
  ctx.clip();
  let applied = null;
  if (env.photo) applied = drawCover(ctx, env.photo, -q.w / 2 - b, -q.h / 2 - b, q.w + 2 * b, q.h + 2 * b, env.transform);
  else if (fallback) { ctx.fillStyle = fallback; ctx.fillRect(-q.w / 2 - b, -q.h / 2 - b, q.w + 2 * b, q.h + 2 * b); }
  ctx.restore();
  return { shape: 'quad', x: q.cx - q.w / 2, y: q.cy - q.h / 2, w: q.w, h: q.h, cx: q.cx, cy: q.cy, deg: q.deg, applied };
}

// Стопка фотографий («фотопленка не удалять!»): картинка стопки и
// повёрнутая на 5,65° область «фото ставить сюда» поверх неё.
const STACK = { x: 182.63, y: 382.83, w: 1069.46, h: 802.6 };
const STACK_PHOTO = { cx: 760.1, cy: 784.6, w: 865.43, h: 593.76, deg: 5.65, bleed: 2 };

// Полароид мероприятий: фото 627×688 повёрнуто на 0,97°, вокруг рамка
// (#FCFCFC, поля 26 / 47 сверху / 131 снизу) с мягкой тенью вверх-вправо.
const POLAROID = { cx: 407.4, cy: 641.2, w: 627.62, h: 687.87, deg: 0.97, bleed: 0.5,
                   side: 26, top: 47, bottom: 131 };

function drawPolaroidFrame(ctx, env) {
  const q = POLAROID;
  const k = env.k || 1;
  ctx.save();
  ctx.translate(q.cx, q.cy);
  ctx.rotate(q.deg * Math.PI / 180);
  const fx = -q.w / 2 - q.side, fy = -q.h / 2 - q.top;
  const fw = q.w + 2 * q.side, fh = q.h + q.top + q.bottom;
  // тень canvas задаётся в пикселях устройства — умножаем на масштаб
  ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
  ctx.shadowBlur = 22 * k;
  ctx.shadowOffsetX = 6 * k;
  ctx.shadowOffsetY = -6 * k;
  ctx.fillStyle = '#FCFCFC';
  ctx.fillRect(fx, fy, fw, fh);
  ctx.restore();
}

// Скрепка поверх полароида (в макете — картинка «Группа 3 1»):
// рисуется вектором, чтобы не мылилась при любом размере экспорта.
function drawPaperClip(ctx) {
  ctx.save();
  ctx.translate(718, 272);
  ctx.rotate(36 * Math.PI / 180);
  const path = new Path2D();
  path.moveTo(-24, -58);
  path.lineTo(-24, 85);
  path.arc(0, 85, 24, Math.PI, 0, true);
  path.lineTo(24, -89.5);
  path.arc(4.5, -89.5, 19.5, 0, -Math.PI, true);
  path.lineTo(-15, 55);
  path.arc(0, 55, 15, Math.PI, 0, true);
  path.lineTo(15, -52);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = 9;
  ctx.save(); ctx.translate(2.5, 3); ctx.stroke(path); ctx.restore();
  ctx.strokeStyle = '#A3121D';
  ctx.lineWidth = 8;
  ctx.stroke(path);
  ctx.strokeStyle = '#E2454E';
  ctx.lineWidth = 5.2;
  ctx.stroke(path);
  ctx.strokeStyle = 'rgba(255, 214, 214, 0.9)';
  ctx.lineWidth = 1.8;
  ctx.save(); ctx.translate(-1.2, -0.8); ctx.stroke(path); ctx.restore();
  ctx.restore();
}

/* ----------------------------------------------------- стили текстов */

const T = {
  // BravoRG
  cover150: { font: 'title', size: 150, lead: 130, track: -3 },
  cover180: { font: 'title', size: 180, lead: 153, track: -3 },
  card150: { font: 'title', size: 150, lead: 130, track: -3 },
  card120: { font: 'title', size: 120, lead: 115, track: -2.4 },
  event120: { font: 'title', size: 120, lead: 110, track: -3 },
  event65: { font: 'title', size: 65, lead: 60, track: 0 },
  number500: { font: 'title', size: 500, lead: 430, track: -5 },
  post200: { font: 'title', size: 200, lead: 160, track: -6 },
  reels150: { font: 'title', size: 150, lead: 115, track: -4.5 },
  // Nauryz Red Keds
  display115: { font: 'display', size: 115, lead: 130, track: -2 },
  // Inter
  sub60: { font: 'body', size: 60, track: -3 },
  sub80: { font: 'body', size: 80, track: -4 },
  sub80i: { font: 'body', size: 80, track: -4, italic: true },
  body45: { font: 'body', size: 45, track: -2.25 },
  body50: { font: 'body', size: 50, track: -2.5 },
  body50t: { font: 'body', size: 50, track: -3 },
  address50: { font: 'body', size: 50, track: -3 },
  dates120: { font: 'body', size: 120, track: -3 },
  // Киноафиша: кегли выведены из размеров текстовых блоков макета
  // (высота прописных и ширина строки при BravoRG / Inter)
  kino191: { font: 'title', size: 191, lead: 165, track: -3.8 },
  kino103: { font: 'title', size: 103, lead: 95, track: -2 },
  kino150: { font: 'title', size: 150, lead: 108, track: -3 },
  body42: { font: 'body', size: 42, track: -2.1 },
};

/* ------------------------------------------------------- поля слайда */

/*
 * Значение поля: введённый текст или, в превью, бледная подсказка.
 * В экспорте (env.ghost = false) пустое поле просто не рисуется.
 */
function fieldText(slide, env, key, layout) {
  // строка выключена переключателем в форме — не рисуем ни текст, ни подсказку
  if (isHidden(slide, key)) return { text: '', ghost: false };
  const v = (slide.fields && slide.fields[key]) || '';
  if (v.trim()) return { text: v, ghost: false };
  if (env.ghost) return { text: placeholderFor(layout, key, env), ghost: true };
  return { text: '', ghost: false };
}

function isHidden(slide, key) {
  return Boolean(slide && slide.opts && slide.opts.hidden && slide.opts.hidden[key]);
}

/* Подсказка для пустого поля: у макета может быть своя (строка или функция). */
function placeholderFor(layout, key, env = {}) {
  const own = layout.ph && layout.ph[key];
  if (typeof own === 'function') return own(env);
  return own || PLACEHOLDERS[key] || '';
}

const PLACEHOLDERS = {
  title: 'Заголовок',
  subtitle: 'подзаголовок',
  body: 'Текст карточки',
  address: 'Адрес',
  number: '11',
  label: 'мероприятий\nнедели в Астане',
  dates: '21.09-27.09',
  date: '2 октября в 19:00',
  place: 'Место проведения',
  price: '3000 тенге',
  badge: 'Премьера: 17 сентября',
};

const GHOST_ALPHA = 0.38;

function sizeScale(slide, group) {
  const s = slide.size && slide.size[group];
  return s ? Math.min(Math.max(s, 0.4), 1.6) : 1;
}

/* Блок + признак «подсказка» — чтобы рисовать бледным и не считать переполнение. */
function fieldBlock(ctx, slide, env, layout, key, st, group, maxWidth, transform) {
  const f = fieldText(slide, env, key, layout);
  let text = f.text;
  if (transform && text) text = transform(text);
  const b = textBlock(ctx, text, st, sizeScale(slide, group), maxWidth);
  b.ghost = f.ghost;
  b.alpha = f.ghost ? (typeof env.ghostAlpha === 'number' ? env.ghostAlpha : GHOST_ALPHA) : 1;
  return b;
}

function alphaOf(b) { return b ? b.alpha : 1; }
function real(b) { return b && !b.ghost && b.lines.length > 0; }

/* 📍 перед адресом и 📅 перед датой, если пользователь не поставил их сам. */
function withEmoji(emoji, spaced) {
  return text => {
    const t = text.trim();
    if (!t || /^\p{Extended_Pictographic}/u.test(t)) return text;
    return emoji + (spaced ? ' ' : '') + text;
  };
}

/*
 * Колонка текстов, прижатая к низу: у последнего блока базовая линия на
 * bottom, остальные выше с зазорами (от базовой линии верхнего блока до
 * верха прописных нижнего). Возвращает верх первого блока.
 */
function stackUp(items, bottom) {
  let y = bottom;
  let top = bottom;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.block || !it.block.lines.length) continue;
    it.top = y - it.block.height;
    top = it.top;
    y = it.top - (it.gapAbove || 0);
  }
  return top;
}

function stackDown(items, top) {
  let y = top;
  let bottom = top;
  let first = true;
  for (const it of items) {
    if (!it.block || !it.block.lines.length) continue;
    if (!first) y += it.gapAbove || 0;
    it.top = y;
    y += it.block.height;
    bottom = y;
    first = false;
  }
  return bottom;
}

/* ------------------------------------------------------------ макеты */

const COVER_BOTTOM = 1650;   // низ текста на всех обложках (отступ 150)
const MARGIN = 90;
const COL_W = 1260;
const LOGO_SAFE = 330;       // выше этой линии текст залезает на логотип

/* Обложка: фото на весь слайд, тень, логотип, заголовок + подзаголовок снизу. */
function renderCover(ctx, slide, env, L, spec) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, spec.shadeTop, shadeStrength(slide, L));
  drawLogo(ctx, env, spec.logo || LOGO_BOX, WHITE);
  if (arrowOn(slide, L)) drawArrow(ctx, ink(slide));

  const center = spec.align === 'center';
  const maxW = spec.maxW || COL_W;
  const x = center ? (W - maxW) / 2 : MARGIN;
  const title = fieldBlock(ctx, slide, env, L, 'title', spec.title, 'title', maxW);
  const sub = fieldBlock(ctx, slide, env, L, 'subtitle', spec.sub, 'body', maxW);
  const items = [{ block: title }, { block: sub, gapAbove: spec.gap || 60 }];
  const top = stackUp(items, COVER_BOTTOM);
  drawBlock(ctx, title, x, items[0].top, ink(slide), spec.align, alphaOf(title));
  drawBlock(ctx, sub, x, items[1].top, ink(slide), spec.align, alphaOf(sub));
  const overflow = (real(title) || real(sub)) && top < LOGO_SAFE;
  return { overflow, photo };
}

function shadeStrength(slide, L) {
  if (!L.shade) return 0;
  const v = slide.opts && typeof slide.opts.shade === 'number' ? slide.opts.shade : 1;
  return Math.min(Math.max(v, 0), 1);
}

function arrowOn(slide, L) {
  if (!L.arrow) return false;
  const v = slide.opts && slide.opts.arrow;
  return v === undefined ? L.arrow === 'on' : Boolean(v);
}

/* Интервью — карточка: белый фон с сеткой, заголовок и текст сверху,
   логотип внизу справа. */
function renderInterviewCard(ctx, slide, env, L) {
  const { W, H } = L;
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, LOGO_BOX_BOTTOM, BLACK);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card150, 'title', COL_W);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body45, 'body', COL_W);
  const items = [{ block: title }, { block: body, gapAbove: 80 }];
  const bottom = stackDown(items, 150);
  drawBlock(ctx, title, MARGIN, items[0].top, BLACK, 'left', alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[1].top, BLACK, 'left', alphaOf(body));
  return { overflow: (real(title) || real(body)) && bottom > 1480, photo: null };
}

/* Любимые места — карточка: стопка фотографий, текст по центру, стрелка. */
function renderFavoriteCard(ctx, slide, env, L) {
  const { W, H } = L;
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, { x: 1198, y: 149, w: 152, h: 130 }, BLACK);
  if (env.assets.stack) ctx.drawImage(env.assets.stack, STACK.x, STACK.y, STACK.w, STACK.h);
  const photo = drawPhotoQuad(ctx, env, STACK_PHOTO, env.assets.stack ? null : BLACK);
  if (arrowOn(slide, L)) drawArrow(ctx, BLACK);
  const maxW = 1253;
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body45, 'body', maxW);
  drawBlock(ctx, body, (W - maxW) / 2, 1268, BLACK, 'center', alphaOf(body));
  // последняя строка может заходить на уровень стрелки (центрирована, обычно короткая)
  return { overflow: real(body) && 1268 + body.height > 1700, photo };
}

/* Новые места — карточка: фото, тень, название, адрес и белая плашка
   с описанием. Всё прижато к низу (плашка заканчивается на 1650). */
function renderNewPlaceCard(ctx, slide, env, L) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, 882, shadeStrength(slide, L));
  drawLogo(ctx, env, LOGO_BOX, WHITE);

  const title = fieldBlock(ctx, slide, env, L, 'title', T.card150, 'title', COL_W);
  const addr = fieldBlock(ctx, slide, env, L, 'address', T.address50, 'body', COL_W, withEmoji('📍', true));
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', 1076);

  let y = COVER_BOTTOM;
  let boxTop = y;
  if (body.lines.length) {
    const boxH = body.height + 150;
    boxTop = COVER_BOTTOM - boxH;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 4 * (env.k || 1);
    ctx.shadowOffsetY = 4 * (env.k || 1);
    ctx.fillStyle = paper(slide);
    ctx.globalAlpha = body.ghost ? Math.min(1, body.alpha + 0.5) : 1;
    roundRect(ctx, MARGIN, boxTop, COL_W, boxH, 35);
    ctx.fill();
    ctx.restore();
    drawBlock(ctx, body, 182, boxTop + 75, BLACK, 'left', alphaOf(body));
    y = boxTop - 60;
  }
  const items = [{ block: title }, { block: addr, gapAbove: 25 }];
  const top = stackUp(items, y);
  drawBlock(ctx, title, MARGIN, items[0].top, ink(slide), 'left', alphaOf(title));
  drawBlock(ctx, addr, MARGIN, items[1].top, ink(slide), 'left', alphaOf(addr));
  const any = real(title) || real(addr) || real(body);
  return { overflow: any && Math.min(top, boxTop) < LOGO_SAFE, photo };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Мероприятия — обложка: большое число, подпись справа от него и даты. */
function renderEventsCover(ctx, slide, env, L) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, 882, shadeStrength(slide, L));
  drawLogo(ctx, env, LOGO_BOX, WHITE);

  const num = fieldBlock(ctx, slide, env, L, 'number', T.number500, 'title', 900);
  const dates = fieldBlock(ctx, slide, env, L, 'dates', T.dates120, 'body', COL_W);
  const labelX = num.lines.length ? MARGIN + num.width + 20 : MARGIN;
  const label = fieldBlock(ctx, slide, env, L, 'label', T.cover150, 'title', Math.max(300, 1350 - labelX));

  // даты прижаты к низу, число и подпись — на 100 выше (низы выровнены)
  let bottom = COVER_BOTTOM;
  if (dates.lines.length) {
    const datesTop = COVER_BOTTOM - dates.height;
    drawBlock(ctx, dates, MARGIN, datesTop, ink(slide), 'left', alphaOf(dates));
    bottom = datesTop - 100;
    if (arrowOn(slide, L)) drawArrow(ctx, ink(slide), datesTop + dates.cap / 2);
  } else if (arrowOn(slide, L)) {
    drawArrow(ctx, ink(slide));
  }
  const numTop = bottom - num.height;
  const labelTop = bottom - label.height;
  drawBlock(ctx, num, MARGIN, numTop, ink(slide), 'left', alphaOf(num));
  drawBlock(ctx, label, labelX, labelTop, ink(slide), 'left', alphaOf(label));
  const any = real(num) || real(label) || real(dates);
  const top = Math.min(num.lines.length ? numTop : bottom, label.lines.length ? labelTop : bottom);
  const tooWide = real(num) && num.width > 1260 - 300;
  return { overflow: any && (top < LOGO_SAFE || tooWide), photo };
}

/* Мероприятия — карточка: полароид со скрепкой, справа название/дата/место,
   снизу описание. */
function renderEventCard(ctx, slide, env, L) {
  const { W, H } = L;
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, LOGO_BOX, BLACK);
  drawPolaroidFrame(ctx, env);
  const photo = drawPhotoQuad(ctx, env, POLAROID);
  drawPaperClip(ctx);

  const colX = 796, colW = 554;
  const title = fieldBlock(ctx, slide, env, L, 'title', T.event120, 'title', colW);
  // строки «когда / где / сколько стоит»: каждую можно выключить в форме,
  // тогда следующие поднимаются на её место
  const date = fieldBlock(ctx, slide, env, L, 'date', T.event65, 'body', colW, withEmoji('🗓️', true));
  const place = fieldBlock(ctx, slide, env, L, 'place', T.event65, 'body', 457, withEmoji('📍', true));
  const price = fieldBlock(ctx, slide, env, L, 'price', T.event65, 'body', colW, withEmoji('💵', true));
  const items = [{ block: title }, { block: date, gapAbove: 89 }, { block: place, gapAbove: 50 },
                 { block: price, gapAbove: 50 }];
  // первая строка после названия всегда отстоит на 89, как дата в макете
  const firstInfo = items.slice(1).find(i => i.block.lines.length);
  if (firstInfo) firstInfo.gapAbove = 89;
  // колонка центрируется по высоте полароида (центр ≈ 682), но не выше логотипа
  const h = stackDown(items.map(i => Object.assign({}, i)), 0);
  let colTop = Math.max(LOGO_SAFE, 682 - h / 2);
  const colBottom = stackDown(items, colTop);
  drawBlock(ctx, title, colX, items[0].top, EVENT_RED, 'left', alphaOf(title));
  drawBlock(ctx, date, colX, items[1].top, BLACK, 'left', alphaOf(date));
  drawBlock(ctx, place, colX, items[2].top, BLACK, 'left', alphaOf(place));
  drawBlock(ctx, price, colX, items[3].top, BLACK, 'left', alphaOf(price));

  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50t, 'body', 1217);
  drawBlock(ctx, body, 88, 1309, BLACK, 'left', alphaOf(body));
  const colOverflow = (real(title) || real(date) || real(place) || real(price)) && colBottom > 1240;
  const bodyOverflow = real(body) && 1309 + body.height > 1710;
  return { overflow: colOverflow || bodyOverflow, photo };
}

/* Коммерция — карточка с фото сверху: полоса фото подстраивается под
   объём текста (текст прижат к низу, от фото до заголовка — 126). */
function renderCommerceTop(ctx, slide, env, L) {
  const { W, H } = L;
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card120, 'title', COL_W);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', COL_W);
  const items = [{ block: title }, { block: body, gapAbove: 70 }];
  let textTop = stackUp(items, COVER_BOTTOM);
  const hasText = title.lines.length || body.lines.length;
  let band = hasText ? textTop - 126 : 1151;
  let overflow = false;
  const MIN = 640, MAX = 1420;
  if (band < MIN) {
    band = MIN;
    stackDown(items, band + 126);
    overflow = (real(title) || real(body)) && (items[1].top || 0) + body.height > 1720;
  }
  band = Math.min(band, MAX);
  const photo = drawPhotoRect(ctx, env, 0, 0, W, band);
  drawLogo(ctx, env, LOGO_BOX, WHITE);
  drawBlock(ctx, title, MARGIN, items[0].top, BLACK, 'left', alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[1].top, BLACK, 'left', alphaOf(body));
  return { overflow, photo };
}

/* Коммерция — карточка с фото снизу: текст сверху, под ним фото до низа. */
function renderCommerceBottom(ctx, slide, env, L) {
  const { W, H } = L;
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card120, 'title', COL_W);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', COL_W);
  const items = [{ block: title }, { block: body, gapAbove: 57 }];
  const bottom = stackDown(items, 150);
  const hasText = title.lines.length || body.lines.length;
  let bandTop = hasText ? bottom + 139 : 649;
  const MAX_TOP = 1160;
  const overflow = (real(title) || real(body)) && bandTop > MAX_TOP;
  bandTop = Math.min(Math.max(bandTop, 380), MAX_TOP);
  const photo = drawPhotoRect(ctx, env, 0, bandTop, W, H - bandTop);
  drawLogo(ctx, env, LOGO_BOX_BOTTOM, WHITE);
  drawBlock(ctx, title, MARGIN, items[0].top, BLACK, 'left', alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[1].top, BLACK, 'left', alphaOf(body));
  return { overflow, photo };
}

/* Киноафиша — карточка фильма: кадр на весь слайд, тень, название,
   белая плашка («Премьера: 17 сентября») и описание, всё прижато к низу. */
function renderKinoCard(ctx, slide, env, L) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, 853, shadeStrength(slide, L));
  drawLogo(ctx, env, LOGO_BOX, WHITE);

  const title = fieldBlock(ctx, slide, env, L, 'title', T.kino150, 'title', COL_W);
  const badge = fieldBlock(ctx, slide, env, L, 'badge', T.body42, 'body', COL_W - 120);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body42, 'body', COL_W);

  let y = COVER_BOTTOM;
  let top = y;
  if (body.lines.length) {
    top = y - body.height;
    drawBlock(ctx, body, MARGIN, top, ink(slide), 'left', alphaOf(body));
    y = top - 38;
  }
  if (badge.lines.length) {
    // плашка: поля 57 по бокам, 21 над прописными и 22 под строкой — как в макете
    const scale = badge.size / 42;
    const padX = 57 * scale, padTop = 21 * scale, padBottom = 22 * scale;
    const boxH = badge.height + padTop + padBottom;
    const boxW = badge.width + padX * 2 + 5 * scale;
    const boxTop = y - boxH;
    ctx.save();
    ctx.globalAlpha = badge.ghost ? Math.min(1, badge.alpha + 0.5) : 1;
    ctx.fillStyle = paper(slide);
    roundRect(ctx, MARGIN, boxTop, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.restore();
    drawBlock(ctx, badge, MARGIN + padX, boxTop + padTop, BLACK, 'left', alphaOf(badge));
    top = boxTop;
    y = boxTop - 60;
  }
  if (title.lines.length) {
    top = y - title.height;
    drawBlock(ctx, title, MARGIN, top, ink(slide), 'left', alphaOf(title));
  }
  const any = real(title) || real(badge) || real(body);
  return { overflow: any && top < LOGO_SAFE, photo };
}

/* Пост: заголовок крупно по центру снизу. */
function renderPost(ctx, slide, env, L) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, 882, shadeStrength(slide, L));
  drawLogo(ctx, env, LOGO_BOX, WHITE);
  const maxW = 1135;
  const title = fieldBlock(ctx, slide, env, L, 'title', T.post200, 'title', maxW);
  const top = COVER_BOTTOM - title.height;
  drawBlock(ctx, title, (W - maxW) / 2, top, ink(slide), 'center', alphaOf(title));
  return { overflow: real(title) && top < LOGO_SAFE, photo };
}

/* Рилс 1080×1920: логотип и заголовок в безопасной зоне обложки. */
function renderReels(ctx, slide, env, L) {
  const { W, H } = L;
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShade(ctx, W, H, 830, shadeStrength(slide, L));
  drawLogo(ctx, env, { x: 832, y: 535, w: 118, h: 100.14 }, WHITE);
  const maxW = 741;
  const title = fieldBlock(ctx, slide, env, L, 'title', T.reels150, 'title', maxW);
  const top = 1493 - title.height;
  drawBlock(ctx, title, (W - maxW) / 2, top, ink(slide), 'center', alphaOf(title));
  return { overflow: real(title) && top < 680, photo };
}

/*
 * Все макеты. fields — какие поля есть у слайда (порядок = порядок в форме),
 * photo — есть ли место под фото, shade — есть ли «тень» (затемнение),
 * arrow — 'on' (стрелка в макете есть) / 'off' (можно включить).
 */
const POST = [1440, 1800];

const LAYOUTS = {
  'zav-cover': {
    name: 'Заведения — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true,
    ph: { title: 'Заведения Душанбе', subtitle: 'где хочется начать вкусное утро' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 1093, align: 'center', maxW: 1300, title: T.display115, sub: T.sub60 }),
  },
  'int-cover': {
    name: 'Интервью — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true,
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover150, sub: T.sub60 }),
  },
  'int-card': {
    name: 'Интервью — карточка', short: 'Вопрос-ответ', size: POST,
    fields: ['title', 'body'], photo: false,
    ph: { title: env => String(env.cardNo || 1).padStart(2, '0') + '. Заголовок',
          body: 'Текст ответа. Пустая строка — новый абзац.' },
    render: renderInterviewCard,
  },
  'fav-cover': {
    name: 'Любимые места — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, arrow: 'on',
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover180, sub: T.sub80 }),
  },
  'fav-card': {
    name: 'Любимые места — карточка', short: 'Стопка фото', size: POST,
    fields: ['body'], photo: true, arrow: 'on',
    ph: { body: 'Пара предложений о месте — почему его любят жители.' },
    render: renderFavoriteCard,
  },
  'new-cover': {
    name: 'Новые места — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, arrow: 'on',
    ph: { title: 'НОВЫЕ МЕСТА\nВ АСТАНЕ', subtitle: 'Смотреть' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 935, title: T.display115, sub: T.sub80i }),
  },
  'new-card': {
    name: 'Новые места — карточка', short: 'Заведение', size: POST,
    fields: ['title', 'address', 'body'], photo: true, shade: true,
    ph: { title: 'Заведение', body: 'Короткое описание: что за место, чем удивит, средний чек.' },
    render: renderNewPlaceCard,
  },
  'ev-cover': {
    name: 'Мероприятия — обложка', short: 'Обложка', size: POST,
    fields: ['number', 'label', 'dates'], photo: true, shade: true, arrow: 'on',
    render: renderEventsCover,
  },
  'ev-card': {
    name: 'Мероприятия — карточка', short: 'Событие', size: POST,
    fields: ['title', 'date', 'place', 'price', 'body'], photo: true,
    ph: { title: 'Название\nсобытия', place: 'WE Kitchen', body: 'Описание события: что, где и почему стоит сходить.' },
    render: renderEventCard,
  },
  'com-cover': {
    name: 'Коммерция — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true,
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover180, sub: T.sub60 }),
  },
  'com-top': {
    name: 'Коммерция — фото сверху', short: 'Фото сверху', size: POST,
    fields: ['title', 'body'], photo: true,
    ph: { body: 'Текст карточки: пара-тройка предложений о товаре или услуге.' },
    render: renderCommerceTop,
  },
  'com-bottom': {
    name: 'Коммерция — фото снизу', short: 'Фото снизу', size: POST,
    fields: ['title', 'body'], photo: true,
    ph: { body: 'Текст карточки: пара-тройка предложений о товаре или услуге.' },
    render: renderCommerceBottom,
  },
  'kino-cover': {
    name: 'Киноафиша — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true,
    ph: { title: 'Киноафиша Узбекистана', subtitle: 'Самые ожидаемые премьеры сентября' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, align: 'center', maxW: 1260, gap: 35,
      logo: { x: 644, y: 148, w: 152, h: 130 },   // логотип по центру
      title: T.kino191, sub: T.kino103 }),
  },
  'kino-card': {
    name: 'Киноафиша — фильм', short: 'Фильм', size: POST,
    fields: ['title', 'badge', 'body'], photo: true, shade: true,
    ph: { title: 'Название фильма', body: 'Коротко о фильме: жанр, режиссёр, чем зацепит и для кого.' },
    render: renderKinoCard,
  },
  'post': {
    name: 'Пост', short: 'Пост', size: POST,
    fields: ['title'], photo: true, shade: true,
    ph: { title: 'Заголовок новости крупно, в две-три строки' },
    render: renderPost,
  },
  'reels': {
    name: 'Рилс — обложка', short: 'Рилс', size: [1080, 1920],
    fields: ['title'], photo: true, shade: true,
    ph: { title: 'Заголовок рилс в две-три строки' },
    render: renderReels,
  },
};

for (const [id, L] of Object.entries(LAYOUTS)) {
  L.id = id;
  L.W = L.size[0];
  L.H = L.size[1];
}

/*
 * Рисует слайд. ctx уже отмасштабирован снаружи (setTransform) так, что
 * единица = пиксель макета; env.k — сколько пикселей устройства в единице
 * (нужно для теней, которые canvas не масштабирует).
 * env: { assets: {logoWhite, logoBlack, stack}, photo, transform, ghost, k }
 * Возвращает { overflow, photo } — photo описывает область фото для UI
 * (перетаскивание кадра, кнопка «Добавить фото»).
 */
function renderSlide(ctx, slide, env) {
  const L = LAYOUTS[slide.layout] || LAYOUTS['post'];
  ctx.save();
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, L.W, L.H);
  let res;
  try {
    res = L.render(ctx, slide, env, L) || {};
  } finally {
    if (HAS_LETTER_SPACING) ctx.letterSpacing = '0px';
    ctx.restore();
  }
  return res;
}
