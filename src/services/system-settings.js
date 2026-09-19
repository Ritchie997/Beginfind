// system-settings.js — чтение/запись system-settings.json (общие настройки
// системы, вкладка "Настройки" в админ-панели). Тот же принцип единого
// источника правды, что и в backup-settings.js.
//
// Раньше здесь же хранились systemName/systemDescription/articlesPerPage/
// theme — все четыре сохранялись, но нигде в приложении не читались: ни
// название/описание системы никуда не выводились (ни в <title>, ни в
// шапке), ни лимит статей на странице не влиял на Ibripedia (там жёсткий
// PAGE_SIZE в public/ibripedia.js, к тому же не постраничная, а
// бесконечная лента), ни тема — никакой светлой темы в CSS попросту не
// существует. Поле выглядело как настройка, но нажатие "Сохранить" ничего
// не меняло нигде, кроме этого файла — по требованию "проверить на
// реальность функционала" эти четыре убраны совсем, а не оставлены
// притворяться рабочими. Остались только два поля, которые реально что-то
// делают — см. их использование ниже.

const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/paths');

const SETTINGS_PATH = path.join(ROOT_DIR, 'system-settings.json');

const DEFAULT_SETTINGS = {
  // МБ — реальный лимит на загрузку картинки через POST /api/upload-image
  // (см. src/routes/uploads.routes.js); многеровский жёсткий предел в
  // src/uploads/multer-config.js — это отдельный, более высокий технический
  // потолок, а не эта настройка.
  maxFileSize: 5,
  // Блокирует POST /api/register, когда выключено — см. src/routes/auth.routes.js.
  allowRegistration: true,
  // Часы жизни JWT — см. auth.generateToken в src/middleware/auth.js. Читается
  // заново на каждый логин (не кэшируется при старте сервера), поэтому смена
  // значения не требует перезапуска — подействует на СЛЕДУЮЩИЙ вход; уже
  // выданные токены живут до срока, с которым были подписаны.
  sessionDurationHours: 8,
  // Режим техобслуживания — см. src/middleware/maintenance.js: пока включён,
  // весь /api/* (кроме логина и самой проверки статуса) отвечает 503 всем,
  // кроме владельца (is_root).
  maintenanceMode: false,
  maintenanceMessage: 'Сайт временно на техническом обслуживании. Загляните чуть позже.'
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (e) {
    console.error('[Settings] Не удалось прочитать system-settings.json, использую значения по умолчанию:', e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { SETTINGS_PATH, DEFAULT_SETTINGS, readSettings, writeSettings };
