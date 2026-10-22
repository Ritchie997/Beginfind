// Read-only API для публичного каталога статей. Не использует auth middleware:
// каждый ответ строится только из слоёв, которые article-layers признал публичными.

const express = require('express');
const store = require('../services/articles-store');
const publicArticles = require('../services/public-articles');

// socialStore — источник агрегированных счётчиков (лайки/комментарии/просмотры).
// Передаётся снаружи (см. server.js), чтобы роутер можно было собрать в тесте без
// базы; без него счётчики в ответе просто нулевые. Наружу уходят только числа —
// кто лайкал/комментировал, гостю не раскрывается.
function createPublicArticlesRouter(articleStore = store, socialStore = null) {
  const router = express.Router();

  router.get('/public/articles', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
      const offset = Math.max(0, Math.min(100000, parseInt(req.query.offset, 10) || 0));
      const sort = String(req.query.sort || '');
      const viewCounts = socialStore && sort === 'views' ? await socialStore.getAllViewCounts() : null;

      const result = publicArticles.listPublicArticles(articleStore.listArticles(), {
        q: req.query.q,
        tag: req.query.tag,
        sort,
        viewCounts,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        limit,
        offset
      });

      if (result.data.length) {
        // Гость — не пользователь: userId = null, поле liked нам не нужно.
        const counts = socialStore
          ? await socialStore.getCountsForSlugs(null, result.data.map((item) => item.slug))
          : new Map();
        result.data = result.data.map((item) => {
          const c = counts.get(item.slug) || {};
          return {
            ...item,
            likesCount: c.likes || 0,
            commentsCount: c.comments || 0,
            viewsCount: c.views || 0
          };
        });
      }
      res.json(result);
    } catch (err) {
      console.error('[public-articles] Failed to list public articles:', err);
      res.status(500).json({ error: 'Не удалось загрузить публичные статьи' });
    }
  });

  // Теги для фильтра каталога — только видимые гостю. Зарегистрирован до
  // /public/articles/:slug по смыслу: путь другой, конфликта нет.
  router.get('/public/tags', (req, res) => {
    try {
      res.json({ data: publicArticles.listPublicTags(articleStore.listArticles()) });
    } catch (err) {
      console.error('[public-articles] Failed to list public tags:', err);
      res.status(500).json({ error: 'Не удалось загрузить теги' });
    }
  });

  router.get('/public/articles-index', (req, res) => {
    try {
      res.json({ data: publicArticles.listPublicIndex(articleStore.listArticles()) });
    } catch (err) {
      console.error('[public-articles] Failed to build public index:', err);
      res.status(500).json({ error: 'Не удалось загрузить индекс статей' });
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
