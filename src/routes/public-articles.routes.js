// Read-only API для публичного каталога статей. Не использует auth middleware:
// каждый ответ строится только из слоёв, которые article-layers признал публичными.

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const store = require('../services/articles-store');
const publicArticles = require('../services/public-articles');
const { dbPath } = require('../config/paths');
const { getAvatarUrl } = require('../services/avatars');
const stickers = require('../services/stickers-store');

const usersDb = new sqlite3.Database(dbPath('users.db'));

function getUserById(id) {
  return new Promise((resolve, reject) => {
    usersDb.get('SELECT id, display_name, username FROM users WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function findLegacyAuthor(name) {
  return new Promise((resolve, reject) => {
    usersDb.get(
      'SELECT id, display_name, username FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?)',
      [name, name],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

async function getPublicAuthor(article) {
  const user = article.author_id
    ? await getUserById(article.author_id)
    : (article.legacyAuthorName ? await findLegacyAuthor(article.legacyAuthorName) : null);
  if (user) {
    return {
      id: user.id,
      display_name: user.display_name || user.username || 'Неизвестный автор',
      avatar: getAvatarUrl(user.id)
    };
  }
  return article.legacyAuthorName
    ? { id: null, display_name: article.legacyAuthorName, avatar: null }
    : null;
}

// socialStore — источник агрегированных счётчиков (лайки/комментарии/просмотры).
// Передаётся снаружи (см. server.js), чтобы роутер можно было собрать в тесте без
// базы; без него счётчики в ответе просто нулевые. Наружу уходят только числа —
// кто лайкал/комментировал, гостю не раскрывается.
//
// decorateComments(comments) — необязательный async-хук (см. server.js): достраивает
// стикеры и аватарки. Публичный ответ содержит только профильный id, имя и аватар
// автора комментария, чтобы ссылка на его публичный профиль работала для гостей.
function createPublicArticlesRouter(articleStore = store, socialStore = null, decorateComments = null) {
  const router = express.Router();

  router.get('/public/articles', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
      const offset = Math.max(0, Math.min(100000, parseInt(req.query.offset, 10) || 0));
      const sort = String(req.query.sort || '');
      const viewCounts = socialStore && sort === 'views' ? await socialStore.getAllViewCounts() : null;
      const articles = articleStore.listArticles();
      const articlesBySlug = new Map(articles.map((article) => [article.slug, article]));

      const result = publicArticles.listPublicArticles(articles, {
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
        const reactionsBySlug = socialStore
          ? await socialStore.getReactionsForTargets('article', result.data.map((item) => item.slug), null)
          : new Map();
        const stickerCodes = [...reactionsBySlug.values()].flat().map((reaction) => reaction.shortcode);
        const stickerMeta = await stickers.resolveCodes(stickerCodes);
        result.data = await Promise.all(result.data.map(async (item) => {
          const c = counts.get(item.slug) || {};
          const reactions = (reactionsBySlug.get(String(item.slug)) || [])
            .map((reaction) => ({ ...reaction, ...stickerMeta.get(reaction.shortcode) }))
            .filter((reaction) => reaction.url);
          return {
            ...item,
            author: await getPublicAuthor(articlesBySlug.get(item.slug) || {}),
            reactions,
            likesCount: c.likes || 0,
            commentsCount: c.comments || 0,
            viewsCount: c.views || 0
          };
        }));
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

  router.get('/public/articles/:slug', async (req, res) => {
    try {
      const article = articleStore.getArticle(req.params.slug);
      const result = article && publicArticles.getPublicArticle(article);
      if (!result) return res.status(404).json({ error: 'Статья не найдена' });
      const counts = socialStore
        ? (await socialStore.getCountsForSlugs(null, [article.slug || req.params.slug])).get(article.slug || req.params.slug) || {}
        : {};
      res.json({
        ...result,
        author: await getPublicAuthor(article),
        likesCount: counts.likes || 0,
        commentsCount: counts.comments || 0,
        viewsCount: counts.views || 0
      });
    } catch (err) {
      console.error('[public-articles] Failed to load public article:', err);
      res.status(500).json({ error: 'Не удалось загрузить статью' });
    }
  });

  // Комментарии открытой статьи — только чтение, без авторизации. Статья должна
  // быть публичной (иначе нейтральный 404, как и у самой статьи). Наружу уходит
  // allowlist полей: профильный id автора добавлен для публичной ссылки на его
  // страницу; упоминания и реакции гостю не раскрываются.
  // Писать и удалять комментарии можно только через авторизованные /api/articles.
  router.get('/public/articles/:slug/comments', async (req, res) => {
    try {
      const article = articleStore.getArticle(req.params.slug);
      if (!article || !publicArticles.getPublicArticle(article)) {
        return res.status(404).json({ error: 'Статья не найдена' });
      }
      let comments = socialStore ? await socialStore.listComments(article.slug || req.params.slug) : [];
      if (decorateComments && comments.length) comments = await decorateComments(comments);
      res.json({
        data: comments.map((c) => ({
          id: c.id,
          authorId: c.userId,
          parentId: c.parentId || null,
          authorName: c.authorName,
          authorAvatar: c.authorAvatar || null,
          content: c.content,
          createdAt: c.createdAt,
          stickers: c.stickers || {}
        }))
      });
    } catch (err) {
      console.error('[public-articles] Failed to load public comments:', err);
      res.status(500).json({ error: 'Не удалось загрузить комментарии' });
    }
  });

  return router;
}

module.exports = { createPublicArticlesRouter };
