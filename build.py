#!/usr/bin/env python3
"""
Собирает всё приложение в один index.html для GitHub Pages.

Что берёт:
    src/            — код (render.js, app.js, styles.css, index.template.html)
    brand/          — логотип, стопка фото, иконки
    brand/fonts/    — шрифты

Запуск:  python3 build.py
Результат: index.html, manifest.webmanifest, service-worker.js в корне
"""

import base64
import hashlib
import json
import mimetypes
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
BRAND = HERE / "brand"
FONTS = BRAND / "fonts"
OUT = HERE / "index.html"

# какие символы оставляем в шрифтах: латиница, вся кириллица (с казахскими,
# таджикскими, узбекскими буквами), пунктуация, знаки валют
SUBSET_UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+02BB-02BC,U+0400-04FF,U+2010-2027,U+2030-203A,"
    "U+2116,U+2122,U+20B8,U+20BD,U+2212,U+2190-2193"
)

IMAGE_EXT = (".png", ".webp", ".jpg", ".jpeg", ".svg")
FONT_EXT = (".woff2", ".ttf", ".otf")


def find_one(folder: Path, stems, exts) -> Path | None:
    """Ищет файл по списку возможных имён, без учёта регистра."""
    if not folder.exists():
        return None
    for stem in stems:
        for f in sorted(folder.iterdir()):
            if not f.is_file() or f.suffix.lower() not in exts:
                continue
            if f.stem.lower().replace(" ", "").replace("-", "_") == stem:
                return f
    return None


def data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if path.suffix.lower() == ".svg":
        mime = "image/svg+xml"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def subset_font(path: Path) -> tuple[bytes, bool]:
    """Урезает шрифт до нужных символов и переводит в woff2.
    Без fontTools — как есть. Возвращает (байты, это_woff2)."""
    if path.suffix.lower() == ".woff2":
        return path.read_bytes(), True
    try:
        from fontTools import subset  # noqa: F401
    except ImportError:
        print(f"  ! fontTools не установлен, {path.name} встраивается целиком")
        print("    (поставь: pip3 install fonttools brotli — файл станет меньше)")
        return path.read_bytes(), False

    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / "out.woff2"
        cmd = [
            sys.executable, "-m", "fontTools.subset", str(path),
            f"--unicodes={SUBSET_UNICODES}",
            "--flavor=woff2",
            f"--output-file={dst}",
            "--layout-features=kern,liga,calt,locl",
            "--no-hinting",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not dst.exists():
            print(f"  ! не удалось урезать {path.name}, встраиваю целиком")
            return path.read_bytes(), False
        return dst.read_bytes(), True


def font_face(family: str, path: Path, italic: bool = False, weight: int = 400) -> str:
    data, woff2 = subset_font(path)
    fmt = "woff2" if woff2 else ("opentype" if path.suffix.lower() == ".otf" else "truetype")
    mime = "font/woff2" if woff2 else ("font/otf" if path.suffix.lower() == ".otf" else "font/ttf")
    b64 = base64.b64encode(data).decode("ascii")
    style = "italic" if italic else "normal"
    return (
        f"@font-face{{font-family:'{family}';font-weight:{weight};font-style:{style};"
        f"font-display:block;src:url(data:{mime};base64,{b64}) format('{fmt}')}}"
    )


# Буквы, которые проверяем в шрифтах: вся кириллица (казахские, таджикские,
# узбекские буквы — там же) и узбекские латинские апострофы oʻ gʻ.
WATCH_CHARS = [chr(c) for c in range(0x0400, 0x0500)] + ["\u02bb", "\u02bc", "\u2018", "\u2019"]


def missing_chars(path: Path | None) -> str:
    """Каких букв из WATCH_CHARS нет в шрифте — для предупреждения в приложении."""
    if not path:
        return ""
    try:
        from fontTools.ttLib import TTFont
        cmap = TTFont(str(path), fontNumber=0).getBestCmap() or {}
    except Exception:
        return ""
    # только буквы, у которых есть пара в другом регистре или которые реально
    # встречаются в текстах (служебные символы 0x0482–0x0489 не в счёт)
    return "".join(ch for ch in WATCH_CHARS
                   if ord(ch) not in cmap and not 0x0482 <= ord(ch) <= 0x0489)


def collect_icons() -> str:
    """Собирает иконки из brand/icons/ в объект ICONS для интерфейса."""
    icons = {}
    folder = BRAND / "icons"
    if folder.exists():
        for f in sorted(folder.glob("*.svg")):
            icons[f.stem] = " ".join(f.read_text(encoding="utf-8").strip().split())
    print(f"иконок:           {len(icons)}")
    body = ",\n".join(f"  {k!r}: {v!r}" for k, v in icons.items())
    return "const ICONS = {\n" + body + "\n};\n"


def main() -> int:
    if not SRC.exists():
        print("нет папки src/ — запусти скрипт из корня проекта")
        return 1

    # ---------- шрифты
    # Настоящие шрифты макета: title.* — BravoRG, display.* — Nauryz Red Keds.
    # Если их нет, встраиваются запасные (fallback-*.ttf, свободные Google Fonts),
    # а приложение показывает подсказку, как добавить настоящие.
    faces = []
    bundled = {}

    title = find_one(FONTS, ["title", "bravorg", "bravo_rg", "bravo"], FONT_EXT)
    display = find_one(FONTS, ["display", "nauryzredkeds", "nauryz_red_keds", "nauryz"], FONT_EXT)
    body = find_one(FONTS, ["body", "inter", "inter_regular"], FONT_EXT)
    body_italic = find_one(FONTS, ["body_italic", "inter_italic"], FONT_EXT)
    body_bold = find_one(FONTS, ["body_bold", "inter_bold"], FONT_EXT)
    body_bold_italic = find_one(FONTS, ["body_bold_italic", "inter_bold_italic", "inter_bolditalic"], FONT_EXT)
    fb_title = find_one(FONTS, ["fallback_title"], FONT_EXT)
    fb_display = find_one(FONTS, ["fallback_display"], FONT_EXT)

    font_missing = {}
    for key, family, real, fallback, label in (
        ("title", "G24Title", title, fb_title, "BravoRG"),
        ("display", "G24Display", display, fb_display, "Nauryz Red Keds"),
    ):
        src = real or fallback
        bundled[key] = bool(real)
        font_missing[key] = missing_chars(src)
        if src:
            faces.append(font_face(family, src))
        mark = src.name if real else (f"— нет файла, запасной {fallback.name}" if fallback else "— нет файла")
        print(f"шрифт {label:16s} {mark}")

    if not body:
        print("не нашёл brand/fonts/body.ttf (Inter) — без него текст карточек не собрать")
        return 1
    faces.append(font_face("G24Body", body))
    font_missing["body"] = missing_chars(body)
    print(f"шрифт Inter            {body.name}")
    if body_italic:
        faces.append(font_face("G24Body", body_italic, italic=True))
        print(f"шрифт Inter Italic     {body_italic.name}")
    # жирный и жирный курсив — для выделения в тексте (кнопка «Ж» в форме)
    if body_bold:
        faces.append(font_face("G24Body", body_bold, weight=700))
        print(f"шрифт Inter Bold       {body_bold.name}")
    if body_bold_italic:
        faces.append(font_face("G24Body", body_bold_italic, italic=True, weight=700))
        print(f"шрифт Inter Bold It.   {body_bold_italic.name}")

    # ---------- картинки бренда
    brand = {}
    for key, stems in (
        ("logo", ["logo", "logo_white", "logo_light"]),
        ("stack", ["photo_stack", "photostack", "stack"]),
    ):
        found = find_one(BRAND, stems, IMAGE_EXT)
        brand[key] = data_url(found) if found else None
        print(f"{key:9s}: {found.name if found else '— нет файла'}")

    for key, chars in font_missing.items():
        sample = "".join(c for c in chars if c.islower())[:24]
        if sample:
            print(f"  в шрифте {key}: нет {sample}…")
    bundled_js = (
        "const BUNDLED_BRAND = " + json.dumps(brand) + ";\n"
        "const BUNDLED_FONTS = " + json.dumps(bundled) + ";\n"
        # каких букв нет в шрифтах — приложение предупреждает под полем
        "const FONT_MISSING = " + json.dumps(font_missing, ensure_ascii=False) + ";\n"
        "const BUILD_ID = '__BUILD_ID__';\n"
    )

    # ---------- иконка приложения (favicon — svg, для iOS — готовый png)
    icon_svg = BRAND / "pwa-icon.svg"
    icon_png = BRAND / "pwa-icon-180.png"
    favicon_url = data_url(icon_svg) if icon_svg.exists() else ""
    if icon_png.exists():
        apple_icon_url = data_url(icon_png)
    else:
        print(f"  ! нет {icon_png.name} — apple-touch-icon будет из SVG")
        apple_icon_url = favicon_url

    # ---------- сборка
    html = (SRC / "index.template.html").read_text(encoding="utf-8")
    html = html.replace("__FONT_FACES__", "\n".join(faces))
    html = html.replace("__CSS__", (SRC / "styles.css").read_text(encoding="utf-8"))
    html = html.replace("__ICONS__", collect_icons())
    html = html.replace("__BUNDLED__", bundled_js)
    html = html.replace("__FAVICON__", favicon_url)
    html = html.replace("__APPLE_TOUCH_ICON__", apple_icon_url)
    html = html.replace("__RENDER_JS__", (SRC / "render.js").read_text(encoding="utf-8"))
    html = html.replace("__APP_JS__", (SRC / "app.js").read_text(encoding="utf-8"))

    for token in ("__FONT_FACES__", "__CSS__", "__ICONS__", "__BUNDLED__",
                  "__RENDER_JS__", "__APP_JS__"):
        if token in html:
            print(f"ошибка сборки: не подставлено {token}")
            return 1

    # номер сборки = хеш страницы: приложение сверяет его с version.json
    # и в окне экспорта предлагает обновиться, если сайт уже новее
    build_id = hashlib.sha1(html.encode("utf-8")).hexdigest()[:12]
    html = html.replace("__BUILD_ID__", build_id)
    OUT.write_text(html, encoding="utf-8")
    (HERE / "version.json").write_text(json.dumps({"build": build_id}) + "\n", encoding="utf-8")
    print(f"\nготово: {OUT.name}  ({OUT.stat().st_size / 1024:.0f} КБ), сборка {build_id}")

    # ---------- PWA: манифест и сервис-воркер рядом с index.html
    manifest = (SRC / "manifest.template.json").read_text(encoding="utf-8")
    manifest = manifest.replace("__PWA_ICON__", data_url(icon_svg) if icon_svg.exists() else "")
    manifest = manifest.replace("__PWA_ICON_PNG__", apple_icon_url)
    (HERE / "manifest.webmanifest").write_text(manifest, encoding="utf-8")
    (HERE / "service-worker.js").write_text(
        (SRC / "service-worker.js").read_text(encoding="utf-8"), encoding="utf-8")
    print("готово: manifest.webmanifest, service-worker.js, version.json")

    missing = [name for key, name in (("title", "BravoRG"), ("display", "Nauryz Red Keds"))
               if not bundled[key]]
    if missing:
        print("\n! нет шрифтов макета: " + ", ".join(missing))
        print("  положи их в brand/fonts/ (title.ttf — BravoRG, display.ttf — Nauryz Red Keds)")
        print("  и запусти сборку ещё раз — см. brand/ПОЛОЖИ_СЮДА_ФАЙЛЫ.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
