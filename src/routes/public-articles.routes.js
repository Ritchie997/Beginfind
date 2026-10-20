// Read-only API для публичного каталога статей. Не использует auth middleware:
// каждый ответ строится только из слоёв, которые article-layers признал публичными.

const express = require('express');
const store = require('../services/articles-store');
const publicArticles = require('../services/public-articles');

function createPublicArticlesRouter(articleStore = store) {
  const router = express.Router();

  router.get('/public/articles', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
      const offset = Math.max(0, Math.min(100000, parseInt(req.query.offset, 10) || 0));
      res.json(publicArticles.listPublicArticles(articleStore.listArticles(), {
        q: req.query.q,
        tag: req.query.tag,
        limit,
        offset
      }));
    } catch (err) {
      console.error('[public-articles] Failed to list public articles:', err);
      res.status(500).json({ error: 'Не удалось загрузить публичные статьи' });
    }
  });

  router.get('/public/articles/:slug', (req, res) => {
    try {
      const article = articleStore.getArticle(req.params.slug);
      const result = article && publicArticles.getPublicArticle(article);
      if (!result) return res.status(404).json({ error: 'Статья не найдена' });
      res.json(result);
    } catch (err) {
      console.error('[public-articles] Failed to load public article:', err);
      res.status(500).json({ error: 'Не удалось загрузить статью' });
    }
  });

  return router;
}

module.exports = { createPublicArticlesRouter };
