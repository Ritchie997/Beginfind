// article-migration.routes.js — "Обновить формат статей" (root only, как
// бэкапы и очистка мусора): предпросмотр без записи и запуск перезаписи.
// Сама логика — src/services/article-migrate.js.

const express = require('express');
const auth = require('../middleware/auth');
const migrate = require('../services/article-migrate');

const router = express.Router();

function parseFlag(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

// GET /api/articles-migration/preview — что изменилось бы, БЕЗ записи.
router.get('/articles-migration/preview', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const report = migrate.runMigration({
      dryRun: true,
      inheritLayerCover: parseFlag(req.query.inheritLayerCover, false)
    });
    res.json({ success: true, data: report });
  } catch (error) {
    console.error('[ArticleMigration] Ошибка предпросмотра:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/articles-migration/run — переписать статьи в актуальном формате.
// Тело (необязательно): { slugs: string[], inheritLayerCover: boolean }.
// Оригиналы изменённых файлов сохраняются в backups/articles-migration/.
router.post('/articles-migration/run', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const { slugs, inheritLayerCover } = req.body || {};
    const report = migrate.runMigration({
      dryRun: false,
      slugs: Array.isArray(slugs) ? slugs.filter((s) => typeof s === 'string') : null,
      inheritLayerCover: parseFlag(inheritLayerCover, false)
    });
    res.json({
      success: true,
      message: `Обновлено статей: ${report.changed}`,
      data: report
    });
  } catch (error) {
    console.error('[ArticleMigration] Ошибка миграции:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
