// src/routes/global-search.routes.js
// Маршрут единого глобального поиска по всей платформе:
// GET /api/global-search?q=...&category=all|articles|gallery|alltell|radio&limit=20

const express = require('express');
const auth = require('../middleware/auth');
const globalSearch = require('../services/global-search');

const router = express.Router();

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return next();
  let continued = false;
  const publicFallback = {
    status() { return this; },
    json() {
      if (continued) return;
      continued = true;
      delete req.user;
      next();
    }
  };
  return auth.authenticateToken(req, publicFallback, () => auth.checkApproved(req, publicFallback, () => {
    if (continued) return;
    continued = true;
    next();
  }));
}

router.get('/global-search', optionalAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || req.query.type || 'all').toLowerCase();
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const result = await globalSearch.searchGlobal(q, {
      category,
      limit,
      offset,
      user: req.user || null
    });

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[global-search.routes] Ошибка глобального поиска:', err);
    res.status(500).json({
      success: false,
      error: 'Ошибка при выполнении глобального поиска: ' + err.message
    });
  }
});

module.exports = router;
