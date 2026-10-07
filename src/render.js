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
// вшитый при сборке. Букв, которых в нём нет (таджикские ҷ ӣ ӯ ҳ и т. п.,
// см. FONT_MISSING), берутся из Inter — одинаково на любом телефоне, а не
// системным шрифтом. Если ничего не загрузилось — системный sans-serif.
const FONT_FAMILY = {
  title: "'G24TitleUser', 'G24Title', 'G24Body', sans-serif",      // BravoRG
  display: "'G24DisplayUser', 'G24Display', 'G24Body', sans-serif", // Nauryz Red Keds
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

/*
 * Жирный, курсив, цвет слов и маркер внутри текста (кнопки в форме, вставка
 * с форматированием). Хранятся рядом с текстом: slide.fmt[key] — отрезки
 * [длина, флаги] подряд, сумма длин = длина текста. Флаги: 1 — жирный,
 * 2 — курсив, 4 — красный, 8 — кремовый, 16 — маркер (кремовая плашка за
 * словами, текст на ней чёрный). Не сходится с текстом — игнорируем.
 */
const BOLD = 1, ITALIC = 2, RED = 4, CREAM = 8, MARK = 16;
const STYLE_BITS = BOLD | ITALIC;       // нужны начертания шрифта (есть только у Inter)
const ACCENT_RED = '#700004';           // фирменный красный (название события в макете)

function fieldRuns(slide, key, text) {
  const runs = slide && slide.fmt && slide.fmt[key];
  if (!Array.isArray(runs) || !runs.length) return null;
  let sum = 0;
  for (const r of runs) {
    if (!Array.isArray(r) || !(r[0] > 0)) return null;
    sum += r[0];
  }
  return sum === text.length && runs.some(r => r[1]) ? runs : null;
}

function expandRuns(runs, length) {
  const flags = new Uint8Array(length);
  let i = 0;
  for (const [len, f] of runs) { flags.fill(f & 31, i, Math.min(length, i + len)); i += len; }
  return flags;
}

function fontSpec(st, size, f = 0) {
  const italic = st.italic || (f & ITALIC);
  return `${italic ? 'italic ' : ''}${f & BOLD ? 700 : 400} ${size}px ${FONT_FAMILY[st.font]}`;
}

/* Ширина куска строки: без форматирования — одним замером, с ним — по
   отрезкам одного начертания. m = { ctx, fonts, track, stretch }. */
function measureSlice(m, text, flags, a = 0, b = text.length) {
  if (!flags) return measureTracked(m.ctx, text.slice(a, b), m.track, m.stretch);
  let w = 0;
  for (let i = a; i < b;) {
    let j = i + 1;
    while (j < b && flags[j] === flags[i]) j++;
    m.ctx.font = m.fonts[flags[i] & STYLE_BITS];
    w += measureTracked(m.ctx, text.slice(i, j), m.track, m.stretch);
    i = j;
  }
  m.ctx.font = m.fonts[0];
  return w;
}

/* Абзац: пробелы схлопнуты в один, по краям обрезаны (флаги — вместе с текстом). */
function normalizePara(raw, flags) {
  if (!flags) return { text: raw.split(/\s+/).filter(Boolean).join(' '), flags: null };
  let text = '';
  const out = [];
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) { space = text.length > 0; continue; }
    if (space) { text += ' '; out.push(flags[i - 1] || 0); space = false; }
    text += raw[i];
    out.push(flags[i]);
  }
  const f = Uint8Array.from(out);
  return { text, flags: f.some(Boolean) ? f : null };
}

function sliceLine(para, a, b) {
  const flags = para.flags ? para.flags.slice(a, b) : null;
  return { text: para.text.slice(a, b), flags: flags && flags.some(Boolean) ? flags : null };
}

/* Абзац (без \n) → строки по ширине. */
function wrapLine(m, para, maxWidth) {
  const text = para.text;
  // неразрывные куски: слова и части слова через дефис (с позициями в тексте)
  const units = [];
  let pos = 0;
  for (const word of text.split(' ')) {
    let s = pos;
    splitHyphens(word).forEach((p, j) => {
      units.push({ text: p, start: s, end: s + p.length, sep: j === 0 ? ' ' : '' });
      s += p.length;
    });
    pos += word.length + 1;
  }
  // слово-«клей» переносится вместе со следующим
  const groups = [];
  for (let i = 0; i < units.length; i++) {
    const prev = groups[groups.length - 1];
    const prevUnit = units[i - 1];
    const glued = prev && units[i].sep === ' ' && prevUnit && prevUnit.sep === ' ' &&
      !HYPHENS.includes(prevUnit.text.slice(-1)) && isGlueWord(prevUnit.text);
    if (glued) prev.end = units[i].end;
    else groups.push({ start: units[i].start, end: units[i].end });
  }
  const lines = [];
  let ls = -1, le = -1;
  const limit = maxWidth * 1.002;
  for (const g of groups) {
    if (ls < 0) { ls = g.start; le = g.end; continue; }
    if (measureSlice(m, text, para.flags, ls, g.end) <= limit) le = g.end;
    else { lines.push(sliceLine(para, ls, le)); ls = g.start; le = g.end; }
  }
  if (ls >= 0) lines.push(sliceLine(para, ls, le));
  return lines;
}

/*
 * Текстовый блок: раскладывает текст по строкам и считает высоту.
 * height — от верха прописных первой строки до базовой линии последней
 * (так же, как высоты текстов в макете с text-box-trim).
 * runs — жирный/курсив (см. fieldRuns), null — весь текст одним начертанием.
 */
function textBlock(ctx, text, st, scale = 1, maxWidth = 1e6, runs = null) {
  const size = st.size * scale;
  const lead = st.lead ? st.lead * scale : size * INTER_LEAD;
  const track = (st.track || 0) * scale;
  const fonts = [0, 1, 2, 3].map(f => fontSpec(st, size, f));
  const font = fonts[0];
  const stretch = FONT_STRETCH[st.font] || 1;
  const str = String(text || '');
  const flags = runs ? expandRuns(runs, str.length) : null;
  ctx.save();
  ctx.font = font;
  setTracking(ctx, track);
  const m = { ctx, fonts, track, stretch };
  const lines = [];
  let pos = 0;
  for (const raw of str.split('\n')) {
    const para = normalizePara(raw, flags ? flags.subarray(pos, pos + raw.length) : null);
    pos += raw.length + 1;
    if (!para.text) { lines.push({ text: '', width: 0, flags: null, last: true }); continue; }
    const wrapped = wrapLine(m, para, maxWidth);
    wrapped.forEach((l, i) => {
      l.width = measureSlice(m, l.text, l.flags);
      l.last = i === wrapped.length - 1;   // последняя строка абзаца — без растяжки по ширине
      lines.push(l);
    });
  }
  ctx.restore();
  // пустые строки по краям блока не рисуются и места не занимают
  while (lines.length && !lines[0].text) lines.shift();
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  const cap = capRatio(ctx, st.font) * size;
  const height = lines.length ? cap + (lines.length - 1) * lead : 0;
  const width = lines.reduce((mx, l) => Math.max(mx, l.width), 0);
  return { lines, size, lead, track, font, fonts, cap, height, width, maxWidth, st, stretch };
}

/*
 * Рисует блок: x — левый край колонки шириной boxW (по умолчанию ширина
 * переноса блока), align — left / center / right / justify (по ширине:
 * пробелы растягиваются, последняя строка абзаца — по левому краю).
 */
function drawBlock(ctx, b, x, capTop, color, align = 'left', alpha = 1, boxW = b && b.maxWidth) {
  if (!b || !b.lines.length) return;
  if (textHits && b.key) recordTextHit(b, x, capTop, align, boxW);
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
      let lx = x, gap = 0;
      if (align === 'center') lx = x + (boxW - line.width) / 2;
      else if (align === 'right') lx = x + boxW - line.width;
      else if (align === 'justify' && !line.last) {
        const spaces = line.text.split(' ').length - 1;
        if (spaces) gap = Math.max(0, (boxW - line.width) / spaces);
      }
      if (line.flags || gap) drawRichLine(ctx, b, line, lx, base, gap, color);
      else drawPiece(ctx, b, line.text, lx, base);
    }
    base += b.lead;
  }
  ctx.restore();
}

function drawPiece(ctx, b, text, x, base) {
  if (b.stretch !== 1) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.scale(b.stretch, 1);
    fillTracked(ctx, text, 0, base, b.track);
    ctx.restore();
  } else {
    fillTracked(ctx, text, x, base, b.track);
  }
}

/*
 * Где на слайде лежит текст каждого поля — для правки прямо на превью
 * (нажали на текст → редактируем это поле) и проверок (буквы, контраст).
 * renderSlide собирает их в res.texts: { key, x, y, w, h, font, ghost } в
 * единицах макета, по видимым строкам (с запасом на выносные элементы).
 */
let textHits = null;

function recordTextHit(b, x, capTop, align, boxW) {
  let x0 = Infinity, x1 = -Infinity;
  for (const line of b.lines) {
    if (!line.text) continue;
    let lx = x, w = line.width;
    if (align === 'center') lx = x + (boxW - w) / 2;
    else if (align === 'right') lx = x + boxW - w;
    else if (align === 'justify' && !line.last) w = Math.max(w, boxW);
    x0 = Math.min(x0, lx);
    x1 = Math.max(x1, lx + w);
  }
  const top = capTop - b.size * 0.12;
  const bottom = capTop + b.height + b.size * 0.24;
  textHits.push({ key: b.key, x: x0, y: top, w: Math.max(0, x1 - x0), h: bottom - top,
    font: b.st.font, ghost: Boolean(b.ghost) });
}

/* Строка по кускам: смена начертания / цвета, маркер и (при выравнивании
   по ширине) пробелы. Сначала раскладываем куски, потом рисуем плашки
   маркера (слитно через пробелы между выделенными словами), потом текст. */
function drawRichLine(ctx, b, line, x, base, gap, color) {
  const { text, flags } = line;
  const m = { ctx, fonts: b.fonts, track: b.track, stretch: b.stretch };
  const pieces = [];
  let cx = x;
  for (let i = 0; i < text.length;) {
    const f = flags ? flags[i] : 0;
    let j = i + 1;
    if (text[i] !== ' ' || !gap) {
      while (j < text.length && (flags ? flags[j] : 0) === f && !(gap && text[j] === ' ')) j++;
    }
    const piece = text.slice(i, j);
    ctx.font = b.fonts[f & STYLE_BITS];
    const w = measureSlice(m, piece, null) + (gap && piece === ' ' ? gap : 0);
    pieces.push({ text: piece, f, x: cx, w });
    cx += w;
    i = j;
  }
  // плашки маркера: от верха прописных с запасом до низа выносных
  const padX = b.size * 0.14, padTop = b.size * 0.2, padBottom = b.size * 0.26;
  ctx.save();
  ctx.fillStyle = b.markerColor || BRAND_CREAM;
  for (let k = 0; k < pieces.length; k++) {
    if (!(pieces[k].f & MARK)) continue;
    let e = k;
    while (e + 1 < pieces.length && pieces[e + 1].f & MARK) e++;
    // пробел по краю выделения плашку не продлевает
    let s0 = k, e0 = e;
    while (s0 < e0 && pieces[s0].text.trim() === '') s0++;
    while (e0 > s0 && pieces[e0].text.trim() === '') e0--;
    const x0 = pieces[s0].x - padX, x1 = pieces[e0].x + pieces[e0].w + padX;
    roundRect(ctx, x0, base - b.cap - padTop, x1 - x0, b.cap + padTop + padBottom, b.size * 0.12);
    ctx.fill();
    k = e;
  }
  ctx.restore();
  for (const p of pieces) {
    if (p.text.trim() === '') continue;
    ctx.font = b.fonts[p.f & STYLE_BITS];
    ctx.fillStyle = p.f & MARK ? BLACK : p.f & RED ? ACCENT_RED : p.f & CREAM ? BRAND_CREAM : color;
    drawPiece(ctx, b, p.text, p.x, base);
  }
  ctx.font = b.font;
  ctx.fillStyle = color;
}

/*
 * Выравнивание и расположение текста — на слайде (opts.align / opts.valign,
 * переключатели в «Оформлении»), по умолчанию — как в макете (L.align /
 * L.valign). Каждый макет задаёт свою область для текста; placeIn ставит в
 * неё колонку высотой h.
 */
const ALIGNS = ['left', 'center', 'right', 'justify'];
const VALIGNS = ['top', 'middle', 'bottom'];

function textAlign(slide, L) {
  const v = slide && slide.opts && slide.opts.align;
  return ALIGNS.includes(v) ? v : (L.align || 'left');
}
function textVAlign(slide, L) {
  const v = slide && slide.opts && slide.opts.valign;
  return VALIGNS.includes(v) ? v : (L.valign || 'bottom');
}

/* Верх колонки высотой h в области [top, bottom]: сверху, снизу или по
   центру (center — своя середина, если она не посередине области). */
function placeIn(h, top, bottom, valign, center = (top + bottom) / 2) {
  if (valign === 'top') return top;
  if (valign === 'bottom') return bottom - h;
  return Math.min(Math.max(center - h / 2, top), Math.max(top, bottom - h));
}

/* Блок одной строкой в ряд (число + подпись) не растягиваем по ширине. */
function rowAlign(align) { return align === 'justify' ? 'left' : align; }

/* Псевдоблок для stackDown: плашка или ряд заданной высоты. */
function boxBlock(height, on = true) {
  return { lines: on ? [true] : [], height: on ? height : 0 };
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

/* Тень под текстом там, где он стоит: снизу — как в макете, сверху — то же
   зеркально, по центру — полоса с серединой на центре текста (мягче:
   чёрный во всю силу посреди кадра слишком тяжёлый). */
const SHADE_MIDDLE = 0.75;

function drawShadeFor(ctx, W, H, top, strength, valign, center) {
  if (!(strength > 0)) return;
  const a = Math.min(1, strength);
  const span = H - top;
  if (valign === 'bottom') { drawShade(ctx, W, H, top, strength); return; }
  if (valign === 'top') {
    const g = ctx.createLinearGradient(0, 0, 0, span);
    g.addColorStop(0, `rgba(0, 0, 0, ${a})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, span);
    return;
  }
  const g = ctx.createLinearGradient(0, center - span, 0, center + span);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(0.5, `rgba(0, 0, 0, ${a * SHADE_MIDDLE})`);
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Логотип: в макете это маска 152×129 в правом верхнем углу (1198, 149),
// залитая белым или чёрным. Видимая часть знака — 1198…1350 × 148…278.
const LOGO_BOX = { x: 1198, y: 148, w: 152, h: 130 };
const LOGO_BOX_BOTTOM = { x: 1198, y: 1520, w: 152, h: 130 };

/*
 * Логотип можно поставить в одну из 8 точек (opts.logo, переключатель в
 * «Оформлении»): углы и середины сторон. По умолчанию — где в макете
 * (L.logo, его рамка — та, что передал макет). Точки — в рамке
 * L.logoFrame: у постов поля 90 по бокам, 148 сверху и 150 снизу (как
 * у логотипа и текста в макете), у рилс — безопасная зона обложки.
 */
const LOGO_SPOTS = ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'];
const LOGO_FRAME_POST = { x0: 90, x1: 1350, y0: 148, y1: 1650 };

function logoSpot(slide, L) {
  const v = slide && slide.opts && slide.opts.logo;
  return LOGO_SPOTS.includes(v) ? v : (L.logo || 'tr');
}

function logoBox(slide, L, def) {
  const spot = logoSpot(slide, L);
  if (spot === (L.logo || 'tr')) return def;   // как в макете — рамка из макета без пересчёта
  const f = L.logoFrame || LOGO_FRAME_POST;
  const x = spot[1] === 'l' ? f.x0 : spot[1] === 'c' ? (f.x0 + f.x1 - def.w) / 2 : f.x1 - def.w;
  const y = spot[0] === 't' ? f.y0 : spot[0] === 'm' ? (f.y0 + f.y1 - def.h) / 2 : f.y1 - def.h;
  return { x, y, w: def.w, h: def.h };
}

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
const ARROW_X = 1285;   // левый край стрелки

function drawArrow(ctx, color, y = 1687) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ARROW_X, y);
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

/* Подсказка для пустого поля: у макета может быть своя (строка или функция).
   Для доп. блоков (title2, body3…) — ph.titleN / ph.bodyN, иначе как у основного. */
function placeholderFor(layout, key, env = {}) {
  const base = baseKey(key);
  const ph = layout.ph || {};
  const own = ph[key] || (base !== key ? ph[base + 'N'] : null);
  if (typeof own === 'function') return own(env);
  return own || PLACEHOLDERS[base] || '';
}

/* title2 → title: доп. поля берут подпись, кегль и подсказку основного. */
function baseKey(key) {
  return String(key).replace(/\d+$/, '');
}

/*
 * Доп. блоки «заголовок + текст» (карточка интервью): у макета sections —
 * сколько блоков можно, на слайде opts.sections — сколько сейчас. Поля
 * блоков: title/body, затем title2/body2, title3/body3…
 */
function sectionCount(slide, layout) {
  const max = (layout && layout.sections) || 1;
  const n = Math.round(Number(slide && slide.opts && slide.opts.sections) || 1);
  return Math.min(Math.max(n, 1), max);
}

function sectionKeys(k) {
  return k === 1 ? ['title', 'body'] : ['title' + k, 'body' + k];
}

/* Все поля слайда в порядке формы: поля макета + доп. блоки. */
function slideFields(slide, layout) {
  const keys = layout.fields.slice();
  for (let k = 2; k <= sectionCount(slide, layout); k++) keys.push(...sectionKeys(k));
  return keys;
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
  let runs = f.ghost ? null : fieldRuns(slide, key, text);
  // жирный и курсив есть только у Inter: у заголовков (BravoRG, Nauryz) и
  // полей из layout.plain остаются цвет и маркер
  if (runs && (st.font !== 'body' || (layout.plain && layout.plain.includes(baseKey(key))))) {
    runs = runs.map(([len, fl]) => [len, fl & ~STYLE_BITS]);
    if (!runs.some(r => r[1])) runs = null;
  }
  if (transform && text) {
    const t = transform(text);
    // эмодзи спереди сдвигает форматирование на свою длину
    if (runs && t !== text) runs = t.endsWith(text) ? [[t.length - text.length, 0], ...runs] : null;
    text = t;
  }
  const b = textBlock(ctx, text, st, sizeScale(slide, group), maxWidth, runs);
  b.key = key;
  b.ghost = f.ghost;
  // маркер кремовый; если слайд уже кремовый (фирменный цвет) — белый
  b.markerColor = brandTone(slide) ? WHITE : BRAND_CREAM;
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
 * Колонка текстов сверху вниз с зазорами (от базовой линии верхнего блока
 * до верха прописных нижнего; пустые блоки и их зазоры пропускаются).
 * Ставит items[i].top, возвращает низ колонки: stackDown(items, 0) — её высота.
 */
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
const CARD_TOP = 150;        // верх текста, когда логотип не сверху
const CARD_BOTTOM = 1480;    // низ текста, когда логотип внизу

/* Область для текста по высоте: логотип вверху — текст начинается под ним,
   внизу — заканчивается над ним (в макете: обложки — логотип вверху,
   белые карточки интервью — внизу). */
function textRegion(slide, L) {
  const row = logoSpot(slide, L)[0];
  if (L.H === 1920) return [row === 't' ? REELS_TOP : REELS_SAFE_TOP, row === 'b' ? REELS_LOGO_ABOVE : REELS_BOTTOM];
  return [row === 't' ? LOGO_SAFE : CARD_TOP, row === 'b' ? CARD_BOTTOM : COVER_BOTTOM];
}

/* Обложка: фото на весь слайд, тень, логотип, заголовок + подзаголовок
   (в макете — снизу; сверху текст начинается под логотипом). */
function renderCover(ctx, slide, env, L, spec) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const maxW = spec.maxW || COL_W;
  const x = spec.maxW ? (W - maxW) / 2 : MARGIN;
  const title = fieldBlock(ctx, slide, env, L, 'title', spec.title, 'title', maxW);
  const sub = fieldBlock(ctx, slide, env, L, 'subtitle', spec.sub, 'body', maxW);
  const items = [{ block: title }, { block: sub, gapAbove: spec.gap || 60 }];
  const h = stackDown(items, 0);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(h, rTop, rBottom, valign, H / 2);
  stackDown(items, top);

  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, spec.shadeTop, shadeStrength(slide, L), valign, top + h / 2);
  drawLogo(ctx, env, logoBox(slide, L, spec.logo || LOGO_BOX), WHITE);
  if (arrowOn(slide, L)) drawArrow(ctx, ink(slide));
  drawBlock(ctx, title, x, items[0].top, ink(slide), align, alphaOf(title));
  drawBlock(ctx, sub, x, items[1].top, ink(slide), align, alphaOf(sub));
  const overflow = (real(title) || real(sub)) && (top < rTop || top + h > rBottom);
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
   логотип внизу справа. Можно добавить ещё блоки «заголовок + текст»
   (sectionCount) — они идут ниже с зазором SECTION_GAP. */
const SECTION_GAP = 130;

function renderInterviewCard(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX_BOTTOM), BLACK);
  const items = [];
  for (let k = 1; k <= sectionCount(slide, L); k++) {
    const [tk, bk] = sectionKeys(k);
    const title = fieldBlock(ctx, slide, env, L, tk, T.card150, 'title', COL_W);
    const body = fieldBlock(ctx, slide, env, L, bk, T.body45, 'body', COL_W);
    // зазор между блоками — у первого непустого поля блока (stackDown
    // пропускает пустые, а зазор пустого блока не должен теряться)
    const gap = k > 1 ? SECTION_GAP : 0;
    const titleOn = title.lines.length > 0;
    items.push({ block: title, gapAbove: gap }, { block: body, gapAbove: titleOn ? 80 : gap });
  }
  const h = stackDown(items, 0);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(h, rTop, rBottom, valign, H / 2);
  stackDown(items, top);
  for (const it of items) drawBlock(ctx, it.block, MARGIN, it.top, BLACK, align, alphaOf(it.block));
  const overflow = items.some(it => real(it.block)) && (top < rTop || top + h > rBottom);
  return { overflow, photo: null };
}

/* Любимые места — карточка: стопка фотографий, под ней текст (по центру),
   стрелка. Расположение — внутри полосы под стопкой. */
function renderFavoriteCard(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, logoBox(slide, L, { x: 1198, y: 149, w: 152, h: 130 }), BLACK);
  if (env.assets.stack) ctx.drawImage(env.assets.stack, STACK.x, STACK.y, STACK.w, STACK.h);
  const photo = drawPhotoQuad(ctx, env, STACK_PHOTO, env.assets.stack ? null : BLACK);
  if (arrowOn(slide, L)) drawArrow(ctx, BLACK);
  const maxW = 1253;
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body45, 'body', maxW);
  const logoBelow = logoSpot(slide, L)[0] === 'b';
  const top = placeIn(body.height, 1268, logoBelow ? CARD_BOTTOM : COVER_BOTTOM, valign);
  drawBlock(ctx, body, (W - maxW) / 2, top, BLACK, align, alphaOf(body));
  // последняя строка может заходить на уровень стрелки (центрирована, обычно короткая)
  return { overflow: real(body) && (top < 1268 || top + body.height > (logoBelow ? CARD_BOTTOM : 1700)), photo };
}

/* Новые места — карточка: фото, тень, название, адрес и белая плашка
   с описанием. В макете всё прижато к низу (плашка заканчивается на 1650). */
function renderNewPlaceCard(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card150, 'title', COL_W);
  const addr = fieldBlock(ctx, slide, env, L, 'address', T.address50, 'body', COL_W, withEmoji('📍', true));
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', 1076);
  // плашка: текст с полями 75 сверху и снизу
  const plate = boxBlock(body.height + 150, body.lines.length > 0);
  const items = [{ block: title }, { block: addr, gapAbove: 25 }, { block: plate, gapAbove: 60 }];
  const h = stackDown(items, 0);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(h, rTop, rBottom, valign, H / 2);
  stackDown(items, top);

  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, 882, shadeStrength(slide, L), valign, top + h / 2);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX), WHITE);
  if (body.lines.length) {
    const boxTop = items[2].top;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 4 * (env.k || 1);
    ctx.shadowOffsetY = 4 * (env.k || 1);
    ctx.fillStyle = paper(slide);
    ctx.globalAlpha = body.ghost ? Math.min(1, body.alpha + 0.5) : 1;
    roundRect(ctx, MARGIN, boxTop, COL_W, plate.height, 35);
    ctx.fill();
    ctx.restore();
    drawBlock(ctx, body, 182, boxTop + 75, BLACK, align, alphaOf(body));
  }
  drawBlock(ctx, title, MARGIN, items[0].top, ink(slide), align, alphaOf(title));
  drawBlock(ctx, addr, MARGIN, items[1].top, ink(slide), align, alphaOf(addr));
  const any = real(title) || real(addr) || real(body);
  return { overflow: any && (top < rTop || top + h > rBottom), photo };
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
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const num = fieldBlock(ctx, slide, env, L, 'number', T.number500, 'title', 900);
  const dates = fieldBlock(ctx, slide, env, L, 'dates', T.dates120, 'body', COL_W);
  const numW = num.lines.length ? num.width + 20 : 0;
  const label = fieldBlock(ctx, slide, env, L, 'label', T.cover150, 'title', Math.max(300, 1350 - MARGIN - numW));

  // число и подпись — один ряд (низы выровнены), под ним через 100 даты
  const rowH = Math.max(num.height, label.height);
  const row = boxBlock(rowH, rowH > 0);
  const items = [{ block: row }, { block: dates, gapAbove: 100 }];
  const h = stackDown(items, 0);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(h, rTop, rBottom, valign, H / 2);
  stackDown(items, top);

  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, 882, shadeStrength(slide, L), valign, top + h / 2);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX), WHITE);
  if (dates.lines.length) {
    // стрелка стоит справа на уровне дат — по правому краю даты заканчиваются перед ней
    const datesW = arrowOn(slide, L) && rowAlign(align) === 'right' ? ARROW_X - 40 - MARGIN : COL_W;
    drawBlock(ctx, dates, MARGIN, items[1].top, ink(slide), rowAlign(align), alphaOf(dates), datesW);
    if (arrowOn(slide, L)) drawArrow(ctx, ink(slide), items[1].top + dates.cap / 2);
  } else if (arrowOn(slide, L)) {
    drawArrow(ctx, ink(slide));
  }
  if (rowH > 0) {
    const rowW = numW + label.width;
    const a = rowAlign(align);
    const rowX = a === 'center' ? MARGIN + (COL_W - rowW) / 2 : a === 'right' ? MARGIN + COL_W - rowW : MARGIN;
    const rowBottom = items[0].top + rowH;
    drawBlock(ctx, num, rowX, rowBottom - num.height, ink(slide), 'left', alphaOf(num));
    drawBlock(ctx, label, rowX + numW, rowBottom - label.height, ink(slide), a, alphaOf(label), label.width);
  }
  const any = real(num) || real(label) || real(dates);
  const tooWide = real(num) && num.width > 1260 - 300;
  return { overflow: any && (top < rTop || top + h > rBottom || tooWide), photo };
}

/* Мероприятия — карточка: полароид со скрепкой, справа название/дата/место,
   снизу описание. В макете колонка справа — по центру полароида. */
const POLAROID_MID = 682;      // центр полароида по высоте
const POLAROID_BOTTOM = 1116;  // низ рамки полароида

function renderEventCard(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX), BLACK);
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
  // колонка: по центру полароида (не выше логотипа), сверху — под логотипом,
  // снизу — по низу рамки
  const h = stackDown(items, 0);
  const colTop = placeIn(h, LOGO_SAFE, valign === 'bottom' ? POLAROID_BOTTOM : 1240, valign, POLAROID_MID);
  stackDown(items, colTop);
  drawBlock(ctx, title, colX, items[0].top, EVENT_RED, align, alphaOf(title), colW);
  drawBlock(ctx, date, colX, items[1].top, BLACK, align, alphaOf(date), colW);
  drawBlock(ctx, place, colX, items[2].top, BLACK, align, alphaOf(place), colW);
  drawBlock(ctx, price, colX, items[3].top, BLACK, align, alphaOf(price), colW);

  // описание под полароидом: сверху полосы, «снизу» — прижато к низу
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50t, 'body', 1217);
  const bodyLimit = logoSpot(slide, L)[0] === 'b' ? CARD_BOTTOM : 1710;   // логотип внизу — описание над ним
  const bodyTop = valign === 'bottom' ? bodyLimit - body.height : 1309;
  drawBlock(ctx, body, 88, bodyTop, BLACK, align, alphaOf(body));
  const colOverflow = (real(title) || real(date) || real(place) || real(price)) &&
    (colTop < LOGO_SAFE || colTop + h > 1240);
  const bodyOverflow = real(body) && (bodyTop < 1309 || bodyTop + body.height > bodyLimit);
  return { overflow: colOverflow || bodyOverflow, photo };
}

/* Коммерция — карточка с фото сверху. В макете полоса фото подстраивается
   под объём текста (текст прижат к низу, от фото до заголовка — 126).
   Сверху / по центру: фото как в макете (1151), текст — под ним. */
const COM_BAND = 1151;

function renderCommerceTop(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card120, 'title', COL_W);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', COL_W);
  const items = [{ block: title }, { block: body, gapAbove: 70 }];
  const h = stackDown(items, 0);
  const MIN = 640, MAX = 1420;
  // логотип внизу — текст заканчивается над ним
  const logoBelow = logoSpot(slide, L)[0] === 'b';
  const bottom = logoBelow ? CARD_BOTTOM : COVER_BOTTOM;
  let band = COM_BAND;
  let textTop = band + 126;
  if (h > 0) {
    const fits = h <= bottom - (COM_BAND + 126);
    if (valign !== 'bottom' && fits) textTop = placeIn(h, COM_BAND + 126, bottom, valign);
    else { textTop = bottom - h; band = textTop - 126; }
  }
  if (band < MIN) { band = MIN; textTop = band + 126; }
  band = Math.min(band, MAX);
  stackDown(items, textTop);
  const overflow = (real(title) || real(body)) && textTop + h > (logoBelow ? CARD_BOTTOM : 1720);
  const photo = drawPhotoRect(ctx, env, 0, 0, W, band);
  // на фото логотип белый, на белом поле — чёрный
  const logo = logoBox(slide, L, LOGO_BOX);
  drawLogo(ctx, env, logo, logo.y + logo.h / 2 < band ? WHITE : BLACK);
  drawBlock(ctx, title, MARGIN, items[0].top, BLACK, align, alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[1].top, BLACK, align, alphaOf(body));
  return { overflow, photo };
}

/* Коммерция — карточка с фото снизу: текст сверху, под ним фото до низа
   (в макете фото начинается на 139 ниже текста). По центру / снизу: фото
   как в макете (с 649), текст — в полосе над ним. */
const COM_BAND_TOP = 649;

function renderCommerceBottom(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  ctx.fillStyle = paper(slide); ctx.fillRect(0, 0, W, H);
  drawGrid(ctx);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.card120, 'title', COL_W);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body50, 'body', COL_W);
  const items = [{ block: title }, { block: body, gapAbove: 57 }];
  const h = stackDown(items, 0);
  // логотип вверху — текст начинается под ним
  const top0 = logoSpot(slide, L)[0] === 't' ? LOGO_SAFE : CARD_TOP;
  let bandTop = COM_BAND_TOP;
  let textTop = top0;
  if (h > 0) {
    const fits = h <= COM_BAND_TOP - 139 - top0;
    if (valign !== 'top' && fits) textTop = placeIn(h, top0, COM_BAND_TOP - 139, valign);
    else bandTop = top0 + h + 139;
  }
  stackDown(items, textTop);
  const MAX_TOP = 1160;
  const overflow = (real(title) || real(body)) && bandTop > MAX_TOP;
  bandTop = Math.min(Math.max(bandTop, 380), MAX_TOP);
  const photo = drawPhotoRect(ctx, env, 0, bandTop, W, H - bandTop);
  const logo = logoBox(slide, L, LOGO_BOX_BOTTOM);
  drawLogo(ctx, env, logo, logo.y + logo.h / 2 > bandTop ? WHITE : BLACK);
  drawBlock(ctx, title, MARGIN, items[0].top, BLACK, align, alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[1].top, BLACK, align, alphaOf(body));
  return { overflow, photo };
}

/* Киноафиша — карточка фильма: кадр на весь слайд, тень, название,
   белая плашка («Премьера: 17 сентября») и описание (в макете — снизу). */
function renderKinoCard(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const title = fieldBlock(ctx, slide, env, L, 'title', T.kino150, 'title', COL_W);
  const badge = fieldBlock(ctx, slide, env, L, 'badge', T.body42, 'body', COL_W - 120);
  const body = fieldBlock(ctx, slide, env, L, 'body', T.body42, 'body', COL_W);
  // плашка: поля 57 по бокам, 21 над прописными и 22 под строкой — как в макете
  const scale = badge.size / 42;
  const padX = 57 * scale, padTop = 21 * scale, padBottom = 22 * scale;
  const boxH = badge.height + padTop + padBottom;
  const boxW = badge.width + padX * 2 + 5 * scale;
  const pill = boxBlock(boxH, badge.lines.length > 0);
  const items = [{ block: title }, { block: pill, gapAbove: 60 }, { block: body, gapAbove: 38 }];
  const h = stackDown(items, 0);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(h, rTop, rBottom, valign, H / 2);
  stackDown(items, top);

  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, 853, shadeStrength(slide, L), valign, top + h / 2);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX), WHITE);
  if (badge.lines.length) {
    const a = rowAlign(align);
    const pillX = a === 'center' ? MARGIN + (COL_W - boxW) / 2 : a === 'right' ? MARGIN + COL_W - boxW : MARGIN;
    const boxTop = items[1].top;
    ctx.save();
    ctx.globalAlpha = badge.ghost ? Math.min(1, badge.alpha + 0.5) : 1;
    ctx.fillStyle = paper(slide);
    roundRect(ctx, pillX, boxTop, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.restore();
    drawBlock(ctx, badge, pillX + padX, boxTop + padTop, BLACK, a, alphaOf(badge), badge.width);
  }
  drawBlock(ctx, title, MARGIN, items[0].top, ink(slide), align, alphaOf(title));
  drawBlock(ctx, body, MARGIN, items[2].top, ink(slide), align, alphaOf(body));
  const any = real(title) || real(badge) || real(body);
  return { overflow: any && (top < rTop || top + h > rBottom), photo };
}

/* Пост: заголовок крупно (в макете — по центру снизу). */
function renderPost(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const maxW = 1135;
  const title = fieldBlock(ctx, slide, env, L, 'title', T.post200, 'title', maxW);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(title.height, rTop, rBottom, valign, H / 2);
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, 882, shadeStrength(slide, L), valign, top + title.height / 2);
  drawLogo(ctx, env, logoBox(slide, L, LOGO_BOX), WHITE);
  drawBlock(ctx, title, (W - maxW) / 2, top, ink(slide), align, alphaOf(title));
  return { overflow: real(title) && (top < rTop || top + title.height > rBottom), photo };
}

/* Рилс 1080×1920: логотип и заголовок в безопасной зоне обложки
   (по высоте 680…1493 — то, что видно в сетке профиля). */
const REELS_TOP = 680, REELS_BOTTOM = 1493;
const REELS_SAFE_TOP = 535;      // верх безопасной зоны (там логотип в макете)
const REELS_LOGO_ABOVE = 1348;   // низ текста, когда логотип внизу зоны
const REELS_LOGO = { x: 832, y: 535, w: 118, h: 100.14 };

function renderReels(ctx, slide, env, L) {
  const { W, H } = L;
  const align = textAlign(slide, L), valign = textVAlign(slide, L);
  const maxW = 741;
  const title = fieldBlock(ctx, slide, env, L, 'title', T.reels150, 'title', maxW);
  const [rTop, rBottom] = textRegion(slide, L);
  const top = placeIn(title.height, rTop, rBottom, valign);
  const photo = drawPhotoRect(ctx, env, 0, 0, W, H);
  drawShadeFor(ctx, W, H, 830, shadeStrength(slide, L), valign, top + title.height / 2);
  drawLogo(ctx, env, logoBox(slide, L, REELS_LOGO), WHITE);
  drawBlock(ctx, title, (W - maxW) / 2, top, ink(slide), align, alphaOf(title));
  return { overflow: real(title) && (top < rTop || top + title.height > rBottom), photo };
}

/*
 * Все макеты. fields — какие поля есть у слайда (порядок = порядок в форме),
 * photo — есть ли место под фото, shade — есть ли «тень» (затемнение),
 * arrow — 'on' (стрелка в макете есть) / 'off' (можно включить),
 * sections — сколько блоков «заголовок + текст» можно добавить (см. sectionCount),
 * align / valign — выравнивание и расположение текста в макете (их можно
 * поменять на слайде), plain — поля без жирного/курсива (шрифт без них),
 * logo — где логотип в макете (tr, если не указано; см. logoBox),
 * logoFrame — рамка для 8 точек логотипа, если не как у постов.
 */
const POST = [1440, 1800];

const LAYOUTS = {
  'zav-cover': {
    name: 'Заведения — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true,
    align: 'center', valign: 'bottom',
    ph: { title: 'Заведения Душанбе', subtitle: 'где хочется начать вкусное утро' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 1093, maxW: 1300, title: T.display115, sub: T.sub60 }),
  },
  'int-cover': {
    name: 'Интервью — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, align: 'left', valign: 'bottom',
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover150, sub: T.sub60 }),
  },
  'int-card': {
    name: 'Интервью — карточка', short: 'Вопрос-ответ', size: POST,
    fields: ['title', 'body'], photo: false, sections: 4, align: 'left', valign: 'top', logo: 'br',
    ph: { title: env => String(env.cardNo || 1).padStart(2, '0') + '. Заголовок',
          body: 'Текст ответа. Пустая строка — новый абзац.',
          titleN: 'Ещё заголовок', bodyN: 'Текст' },
    render: renderInterviewCard,
  },
  'fav-cover': {
    name: 'Любимые места — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, arrow: 'on', align: 'left', valign: 'bottom',
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover180, sub: T.sub80 }),
  },
  'fav-card': {
    name: 'Любимые места — карточка', short: 'Стопка фото', size: POST,
    fields: ['body'], photo: true, arrow: 'on', align: 'center', valign: 'top',
    ph: { body: 'Пара предложений о месте — почему его любят жители.' },
    render: renderFavoriteCard,
  },
  'new-cover': {
    name: 'Новые места — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, arrow: 'on', align: 'left', valign: 'bottom',
    ph: { title: 'НОВЫЕ МЕСТА\nВ АСТАНЕ', subtitle: 'Смотреть' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 935, title: T.display115, sub: T.sub80i }),
  },
  'new-card': {
    name: 'Новые места — карточка', short: 'Заведение', size: POST,
    fields: ['title', 'address', 'body'], photo: true, shade: true, align: 'left', valign: 'bottom',
    ph: { title: 'Заведение', body: 'Короткое описание: что за место, чем удивит, средний чек.' },
    render: renderNewPlaceCard,
  },
  'ev-cover': {
    name: 'Мероприятия — обложка', short: 'Обложка', size: POST,
    fields: ['number', 'label', 'dates'], photo: true, shade: true, arrow: 'on', align: 'left', valign: 'bottom',
    render: renderEventsCover,
  },
  'ev-card': {
    name: 'Мероприятия — карточка', short: 'Событие', size: POST,
    fields: ['title', 'date', 'place', 'price', 'body'], photo: true, align: 'left', valign: 'middle',
    ph: { title: 'Название\nсобытия', place: 'WE Kitchen', body: 'Описание события: что, где и почему стоит сходить.' },
    render: renderEventCard,
  },
  'com-cover': {
    name: 'Коммерция — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, align: 'left', valign: 'bottom',
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, title: T.cover180, sub: T.sub60 }),
  },
  'com-top': {
    name: 'Коммерция — фото сверху', short: 'Фото сверху', size: POST,
    fields: ['title', 'body'], photo: true, align: 'left', valign: 'bottom',
    ph: { body: 'Текст карточки: пара-тройка предложений о товаре или услуге.' },
    render: renderCommerceTop,
  },
  'com-bottom': {
    name: 'Коммерция — фото снизу', short: 'Фото снизу', size: POST,
    fields: ['title', 'body'], photo: true, align: 'left', valign: 'top', logo: 'br',
    ph: { body: 'Текст карточки: пара-тройка предложений о товаре или услуге.' },
    render: renderCommerceBottom,
  },
  'kino-cover': {
    name: 'Киноафиша — обложка', short: 'Обложка', size: POST,
    fields: ['title', 'subtitle'], photo: true, shade: true, align: 'center', valign: 'bottom', logo: 'tc',
    plain: ['subtitle'],   // подзаголовок набран BravoRG — жирного/курсива у него нет
    ph: { title: 'Киноафиша Узбекистана', subtitle: 'Самые ожидаемые премьеры сентября' },
    render: (ctx, s, env, L) => renderCover(ctx, s, env, L, {
      shadeTop: 882, maxW: 1260, gap: 35,
      logo: { x: 644, y: 148, w: 152, h: 130 },   // логотип по центру
      title: T.kino191, sub: T.kino103 }),
  },
  'kino-card': {
    name: 'Киноафиша — фильм', short: 'Фильм', size: POST,
    fields: ['title', 'badge', 'body'], photo: true, shade: true, align: 'left', valign: 'bottom',
    ph: { title: 'Название фильма', body: 'Коротко о фильме: жанр, режиссёр, чем зацепит и для кого.' },
    render: renderKinoCard,
  },
  'post': {
    name: 'Пост', short: 'Пост', size: POST,
    fields: ['title'], photo: true, shade: true, align: 'center', valign: 'bottom',
    ph: { title: 'Заголовок новости крупно, в две-три строки' },
    render: renderPost,
  },
  'reels': {
    name: 'Рилс — обложка', short: 'Рилс', size: [1080, 1920],
    fields: ['title'], photo: true, shade: true, align: 'center', valign: 'bottom',
    logoFrame: { x0: 130, x1: 950, y0: REELS_SAFE_TOP, y1: REELS_BOTTOM },
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
 * Возвращает { overflow, photo, texts } — photo описывает область фото для
 * UI (перетаскивание кадра, кнопка «Добавить фото»), texts — где тексты
 * полей (правка нажатием на превью).
 */
function renderSlide(ctx, slide, env) {
  const L = LAYOUTS[slide.layout] || LAYOUTS['post'];
  ctx.save();
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, L.W, L.H);
  let res;
  textHits = [];
  try {
    res = L.render(ctx, slide, env, L) || {};
    res.texts = textHits;
  } finally {
    textHits = null;
    if (HAS_LETTER_SPACING) ctx.letterSpacing = '0px';
    ctx.restore();
  }
  return res;
}
