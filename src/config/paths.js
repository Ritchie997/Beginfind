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
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const CONTENT_DIR = path.join(ROOT_DIR, 'content'); // Markdown-статьи (Этап 3)

// Пути к файлам SQLite-баз данных (мессенджер, сервера, пользователи).
// Статьи (articles.db) в Этапе 3 заменяются на Markdown-файлы в CONTENT_DIR.
function dbPath(fileName) {
  return path.join(ROOT_DIR, fileName);
}

module.exports = {
  ROOT_DIR,
  PUBLIC_DIR,
  UPLOADS_DIR,
  BACKUPS_DIR,
  CONTENT_DIR,
  dbPath
};
