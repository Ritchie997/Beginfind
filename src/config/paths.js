// paths.js — единый источник правды для путей проекта.
//
// Раньше почти каждый файл вычислял пути через собственный __dirname
// (path.join(__dirname, 'articles.db') и т.п.), что было безопасно только
// пока все файлы лежали в корне проекта. После переноса кода в src/ такие
// вычисления стали бы указывать не туда — этот модуль даёт всем остальным
// частям приложения один и тот же абсолютный корень проекта.

const path = require('path');

// Корень проекта: два уровня вверх от src/config/paths.js
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
// Файлы стикеров — подпапка UPLOADS_DIR, а не отдельная директория: она уже
// отдаётся статикой как /uploads (см. server.js), так что /uploads/stickers/*
// работает без отдельного app.use — заводить второй static-маунт не нужно.
const STICKERS_DIR = path.join(UPLOADS_DIR, 'stickers');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const CONTENT_DIR = path.join(ROOT_DIR, 'content'); // Статьи — JSON-документы из блоков, см. src/services/blocks.js
// Интерактивные карты (см. src/services/maps-store.js): сами карты и
// настройки миров (мир = сервер) — JSON рядом со статьями, поэтому попадают
// в бэкап вместе с content/. Исходники подложек — вне public/ (их не нужно
// раздавать, а весить они могут сотни МБ); нарезанные тайлы — в
// public/uploads/maps/<mapId>/<basemapId>/{z}/{y}/{x}.webp.
const MAPS_DIR = path.join(CONTENT_DIR, 'maps');
const WORLDS_DIR = path.join(CONTENT_DIR, 'worlds');
const MAP_SOURCES_DIR = path.join(ROOT_DIR, 'map-sources');
const MAP_TILES_DIR = path.join(UPLOADS_DIR, 'maps');

// Пути к файлам SQLite-баз данных (мессенджер, сервера, пользователи).
// Статьи (articles.db) заменены на файлы content/<slug>.json.
function dbPath(fileName) {
  return path.join(ROOT_DIR, fileName);
}

module.exports = {
  ROOT_DIR,
  PUBLIC_DIR,
  UPLOADS_DIR,
  STICKERS_DIR,
  BACKUPS_DIR,
  CONTENT_DIR,
  MAPS_DIR,
  WORLDS_DIR,
  MAP_SOURCES_DIR,
  MAP_TILES_DIR,
  dbPath
};
