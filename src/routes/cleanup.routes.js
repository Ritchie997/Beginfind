// cleanup.routes.js — очистка серверного мусора (root only, как и бэкапы —
// см. auth.checkRoot). Настройки + предпросмотр + ручной запуск; сам
// планировщик — initializeAutoCleanup в src/server.js.

const express = require('express');
const auth = require('../middleware/auth');
const cleanup = require('../services/cleanup');
const { readSettings, writeSettings, DEFAULT_SETTINGS } = require('../services/cleanup-settings');

const router = express.Router();

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// GET /api/cleanup/settings — текущие настройки автоочистки
router.get('/cleanup/settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    res.json({ success: true, data: readSettings() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/cleanup/settings — сохранить настройки автоочистки
router.put('/cleanup/settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const current = readSettings();
    const { enabled, intervalHours, minOrphanAgeHours, trashRetentionDays, cleanTrashedArticles, cleanOrphanUploads, cleanOrphanStickers } = req.body;

    const settings = writeSettings({
      ...current,
      enabled: !!enabled,
      intervalHours: clampInt(intervalHours, DEFAULT_SETTINGS.intervalHours, 1, 168),
      // Нижняя граница 1 час — не даём случайно поставить 0 и превратить
      // грейс-период в "удалять сразу", что и убивает его смысл (см.
      // комментарий у minOrphanAgeHours в cleanup-settings.js).
      minOrphanAgeHours: clampInt(minOrphanAgeHours, DEFAULT_SETTINGS.minOrphanAgeHours, 1, 24 * 30),
      trashRetentionDays: clampInt(trashRetentionDays, DEFAULT_SETTINGS.trashRetentionDays, 1, 365),
      cleanTrashedArticles: cleanTrashedArticles !== undefined ? !!cleanTrashedArticles : current.cleanTrashedArticles,
      cleanOrphanUploads: cleanOrphanUploads !== undefined ? !!cleanOrphanUploads : current.cleanOrphanUploads,
      cleanOrphanStickers: cleanOrphanStickers !== undefined ? !!cleanOrphanStickers : current.cleanOrphanStickers
    });

    res.json({ success: true, message: 'Настройки очистки сохранены', data: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/cleanup/preview — что было бы удалено при текущих настройках,
// БЕЗ единого удаления — владелец видит, что демон собирается снести, перед
// тем как разрешить это по расписанию или нажать "Запустить сейчас".
router.get('/cleanup/preview', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const settings = readSettings();
    const result = await cleanup.runCleanup(settings, { dryRun: true });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Cleanup] Ошибка предпросмотра:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/cleanup/run — запустить очистку прямо сейчас (по текущим
// сохранённым настройкам категорий/порогов) — независимо от settings.enabled,
// который управляет только автозапуском по расписанию.
router.post('/cleanup/run', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const settings = readSettings();
    const result = await cleanup.runCleanup(settings, { dryRun: false });

    writeSettings({
      ...settings,
      lastRun: result.at,
      lastReport: {
        totalCount: result.totalCount,
        totalBytes: result.totalBytes,
        trashCount: result.trashCount,
        uploadsCount: result.uploadsCount,
        stickersCount: result.stickersCount,
        at: result.at
      }
    });

    res.json({ success: true, message: `Удалено файлов: ${result.totalCount}`, data: result });
  } catch (error) {
    console.error('[Cleanup] Ошибка очистки:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
