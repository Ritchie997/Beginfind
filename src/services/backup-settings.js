// backup-settings.js — чтение/запись backup-settings.json.
// Раньше этот же код (существует ли файл → прочитать/распарсить → дефолты)
// был скопирован в четырёх местах (GET/PUT /api/backups/auto/settings,
// POST /api/backups/auto/run и планировщик автобэкапа при старте сервера).
// Здесь — один источник правды.

const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../config/paths');

const SETTINGS_PATH = path.join(ROOT_DIR, 'backup-settings.json');

const DEFAULT_SETTINGS = {
  enabled: false,
  intervalHours: 12,
  lastBackup: null
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    console.error('[Backup] Не удалось прочитать backup-settings.json, использую значения по умолчанию:', e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

module.exports = { SETTINGS_PATH, DEFAULT_SETTINGS, readSettings, writeSettings };
