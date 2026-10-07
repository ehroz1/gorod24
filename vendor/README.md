# Сторонние библиотеки

Подгружаются страницей по требованию, в `index.html` не вшиты.

| Файл | Что это | Версия | Лицензия |
|---|---|---|---|
| `heic-to.js` | декодер фото HEIC/HEIF (libheif 1.23.5), сборка `dist/iife` из npm-пакета [heic-to](https://github.com/hoppergee/heic-to) | 1.6.5 | LGPL-3.0, `heic-to.LICENSE.txt` |

`heic-to.js` грузится только когда браузер сам не открыл HEIC (Chrome,
Firefox, Edge; Safari умеет HEIC без него). Обновить: скачать
`https://registry.npmjs.org/heic-to/-/heic-to-<версия>.tgz`, положить сюда
`package/dist/iife/heic-to.js` и `package/LICENSE`, поправить версию в
таблице. Пересобирать `index.html` не нужно.
