// cleanup-settings.js — чтение/запись cleanup-settings.json (настройки
// автоматической очистки серверного мусора — см. src/services/cleanup.js).
// Тот же единый источник правды, что и backup-settings.js/system-settings.js:
// не хранить копии дефолтов/путь к файлу в нескольких местах (routes,
// планировщик в server.js).

const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/paths');

const SETTINGS_PATH = path.join(ROOT_DIR, 'cleanup-settings.json');

const DEFAULT_SETTINGS = {
  enabled: false, // автозапуск по расписанию (как autoBackupEnabled) — вручную "Запустить сейчас" работает всегда, независимо от этого флага
  intervalHours: 24, // как часто (в часах) планировщик проверяет, не пора ли запустить очистку — та же схема, что и у автобэкапа (см. shouldRun ниже)
  // Файл-сирота (без единой ссылки на него) удаляется, только если он старше
  // этого возраста — иначе демон мог бы снести картинку, которую человек
  // только что загрузил в редакторе статьи, но ещё не успел сохранить саму
  // статью (окно между /api/upload-image и PUT/POST /api/articles).
  minOrphanAgeHours: 48,
  // Статьи, лежащие в корзине (content/.trash/ — см. articles-store.js
  // deleteArticle) дольше этого срока, удаляются безвозвратно.
  trashRetentionDays: 30,
  // Каждую из трёх категорий можно выключить по отдельности, не трогая
  // остальные — например, если владелец пока не готов доверить демону
  // безвозвратное удаление статей из корзины, но хочет чистить сиротские файлы.
  cleanTrashedArticles: true,
  cleanOrphanUploads: true,
  cleanOrphanStickers: true,
  lastRun: null, // ISO-дата последнего запуска (авто или вручную)
  lastReport: null // краткая сводка последнего запуска — см. summarizeReport() в cleanup.js
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (e) {
    console.error('[Cleanup] Не удалось прочитать cleanup-settings.json, использую значения по умолчанию:', e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { SETTINGS_PATH, DEFAULT_SETTINGS, readSettings, writeSettings };
