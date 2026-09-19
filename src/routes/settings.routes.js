// settings.routes.js — общие настройки системы (вкладка "Настройки").
// Чтение/запись — только владелец (auth.checkRoot). Исключение —
// GET /api/maintenance-status ниже: она НАМЕРЕННО публичная (без auth
// вообще), потому что её обязан проверить даже неавторизованный посетитель
// (или пользователь с уже просроченным токеном), прежде чем сайт покажет
// ему форму входа вместо экрана "идут технические работы" — см.
// src/middleware/maintenance.js и public/auth-system.js.

const express = require('express');
const auth = require('../middleware/auth');
const { readSettings, writeSettings, DEFAULT_SETTINGS } = require('../services/system-settings');

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
// файла" в одной форме тихо гасило maintenanceMode/sessionDurationHours,
// сохранённые из другой. Теперь отсутствующее поле = "не трогать", берём его
// из уже сохранённых настроек (current), а не из дефолта.
router.put('/system-settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const current = readSettings();
    const { maxFileSize, allowRegistration, sessionDurationHours, maintenanceMode, maintenanceMessage } = req.body;

    const settings = writeSettings({
      maxFileSize: maxFileSize !== undefined ? clampInt(maxFileSize, current.maxFileSize, 1, 20) : current.maxFileSize,
      allowRegistration: allowRegistration !== undefined ? !!allowRegistration : current.allowRegistration,
      // 1 час — 30 дней. Токены уже выданные это не меняет (см. комментарий
      // у generateToken в src/middleware/auth.js) — подействует со
      // следующего входа.
      sessionDurationHours: sessionDurationHours !== undefined
        ? clampInt(sessionDurationHours, current.sessionDurationHours, 1, 24 * 30)
        : current.sessionDurationHours,
      maintenanceMode: maintenanceMode !== undefined ? !!maintenanceMode : current.maintenanceMode,
      maintenanceMessage: maintenanceMessage !== undefined
        ? (String(maintenanceMessage).trim().slice(0, 300) || DEFAULT_SETTINGS.maintenanceMessage)
        : current.maintenanceMessage
    });
    res.json({ message: 'Настройки сохранены', settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/maintenance-status — публичный статус режима техобслуживания
// (без auth.authenticateToken — см. комментарий в начале файла). Отдаём
// только флаг и текст сообщения, ничего больше из system-settings.json.
router.get('/maintenance-status', (req, res) => {
  try {
    const settings = readSettings();
    res.json({ enabled: !!settings.maintenanceMode, message: settings.maintenanceMessage });
  } catch (error) {
    // Если даже это упало — не блокируем клиента "здесь могла бы быть
    // техобслуживание", а считаем, что режима нет.
    res.json({ enabled: false, message: '' });
  }
});

module.exports = router;
