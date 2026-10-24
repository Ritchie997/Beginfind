// settings.routes.js — общие настройки системы (вкладка "Настройки").
// Чтение/запись — только владелец (auth.checkRoot). Исключение —
// GET /api/maintenance-status намеренно публичный и возвращает только
// состояния публичных страниц, без остальных системных настроек.

const express = require('express');
const auth = require('../middleware/auth');
const {
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS,
  normalizeMaintenancePages
} = require('../services/system-settings');
const { setMaintenanceBypassCookie, MAINTENANCE_PAGE_KEYS } = require('../middleware/maintenance');

const router = express.Router();

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// GET /api/system-settings — текущие настройки (только владелец)
router.get('/system-settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    res.json({ settings: readSettings() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/system-settings — сохранить настройки (только владелец).
//
// Клиент шлёт настройки тремя отдельными формами на этой странице
// (безопасность/сессия, техобслуживание, и т.д. — у каждой своя кнопка
// "Сохранить", см. public/spa-router.js и public/views/settings.html), а не
// одной большой — поэтому в req.body почти всегда есть только ЧАСТЬ полей.
// Раньше любое отсутствующее поле трактовалось как "сбросить к дефолту"
// (fallback на DEFAULT_SETTINGS), из-за чего сохранение "Максимальный размер
// файла" в одной форме тихо сбрасывало другие настройки,
// сохранённые из другой. Теперь отсутствующее поле = "не трогать", берём его
// из уже сохранённых настроек (current), а не из дефолта.
router.put('/system-settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const current = readSettings();
    const { maxFileSize, allowRegistration, sessionDurationHours, maintenancePages, maintenanceMessage } = req.body;

    const settings = writeSettings({
      maxFileSize: maxFileSize !== undefined ? clampInt(maxFileSize, current.maxFileSize, 1, 20) : current.maxFileSize,
      allowRegistration: allowRegistration !== undefined ? !!allowRegistration : current.allowRegistration,
      // 1 час — 30 дней. Токены уже выданные это не меняет (см. комментарий
      // у generateToken в src/middleware/auth.js) — подействует со
      // следующего входа.
      sessionDurationHours: sessionDurationHours !== undefined
        ? clampInt(sessionDurationHours, current.sessionDurationHours, 1, 24 * 30)
        : current.sessionDurationHours,
      maintenancePages: maintenancePages !== undefined
        ? normalizeMaintenancePages(maintenancePages)
        : current.maintenancePages,
      maintenanceMessage: maintenanceMessage !== undefined
        ? (String(maintenanceMessage).trim().slice(0, 300) || DEFAULT_SETTINGS.maintenanceMessage)
        : current.maintenanceMessage
    });
    res.json({ message: 'Настройки сохранены', settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Публичный статус отдельных страниц: не отдаёт остальные системные настройки.
router.get('/maintenance-status', (req, res) => {
  try {
    const settings = readSettings();
    res.json({ pages: settings.maintenancePages, message: settings.maintenanceMessage });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось загрузить статус страниц' });
  }
});

router.post('/maintenance-continue', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const { page } = req.body || {};
  if (!MAINTENANCE_PAGE_KEYS.includes(page)) {
    return res.status(400).json({ error: 'Неизвестная страница' });
  }
  if (!req.user.is_root && !(req.user.admin_level > 0)) {
    return res.status(403).json({ error: 'Продолжить могут только владелец или администратор' });
  }

  const settings = readSettings();
  if (!settings.maintenancePages[page]) {
    return res.json({ continued: true });
  }

  setMaintenanceBypassCookie(req, res, page);
  return res.json({ continued: true });
});

module.exports = router;
