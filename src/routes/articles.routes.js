// articles.routes.js — CRUD и поиск статей (Ibripedia).
//
// С Этапа 3 статьи хранятся как Markdown-файлы в content/ (см.
// src/services/articles-store.js) вместо articles.db. id статьи теперь —
// строковый slug (например "moya-statya"), а не число.

const express = require('express');
const os = require('os');
const auth = require('../middleware/auth');
const store = require('../services/articles-store');
const { serversDb } = require('../db/connections');
const { isAdminOnServer } = require('../services/server-permissions');
const { PORT, HOST } = require('../config/env');

const router = express.Router();

// Функция для получения имени сервера по ID
function getServerNameById(serverId) {
  return new Promise((resolve) => {
    serversDb.get('SELECT name FROM servers WHERE id = ?', [serverId], (err, row) => {
      if (err) {
        console.error('Error getting server name by ID:', err);
        resolve(null);
      } else {
        resolve(row ? row.name : null);
      }
    });
  });
}

// Возвращает id ролей сервера, назначенных пользователю на этом сервере
function getUserRoleIdsOnServer(userId, serverId) {
  return new Promise((resolve) => {
    serversDb.all(
      'SELECT role_id FROM user_server_role_assignments WHERE user_id = ? AND server_id = ?',
      [userId, serverId],
      (err, rows) => resolve(err || !rows ? [] : rows.map(r => r.role_id))
    );
  });
}

// Проверяет, может ли пользователь просматривать/редактировать/удалять статью
// с учётом её флага "locked" и списка разрешённых ролей сервера.
// root и админ сервера статьи могут всё; остальным при locked=true нужна
// одна из ролей, перечисленных в article.roles.
async function canAccessArticle(user, article) {
  if (!article.locked) return true;
  if (user.is_root) return true;

  const serverId = parseInt(article.server);
  if (!serverId || isNaN(serverId)) {
    // Статья не привязана к валидному серверу — проверить роли невозможно,
    // по умолчанию запрещаем доступ к закрытой статье кроме root
    return false;
  }

  if (await isAdminOnServer(user.id, serverId)) return true;

  const allowedRoleIds = (article.roles || []).map(r => parseInt(r)).filter(r => !isNaN(r));
  if (allowedRoleIds.length === 0) return true; // ограничение не задано корректно — не блокируем

  const userRoleIds = await getUserRoleIdsOnServer(user.id, serverId);
  return userRoleIds.some(r => allowedRoleIds.includes(r));
}

// Функция для определения IP-адреса сервера
function getServerIP() {
  if (HOST !== '0.0.0.0' && HOST !== 'localhost' && HOST !== '127.0.0.1') {
    return HOST;
  }

  const networkInterfaces = os.networkInterfaces();
  let serverIP = 'localhost';

  for (const interfaceName in networkInterfaces) {
    const networkInterface = networkInterfaces[interfaceName];
    for (const network of networkInterface) {
      if (!network.internal && network.family === 'IPv4') {
        serverIP = network.address;
        break;
      }
    }
    if (serverIP !== 'localhost') {
      break;
    }
  }

  return serverIP;
}

// Функция для форматирования URL изображения (та же логика, что была в
// SQLite-версии — не менялась при переезде на Markdown)
function formatImageUrl(imagePath, req = null) {
  if (!imagePath) return null;
  if (imagePath.startsWith('http')) {
    return imagePath;
  }

  let normalizedPath = imagePath;
  if (!imagePath.startsWith('/')) {
    normalizedPath = '/' + imagePath;
  }

  if (req && req.get('X-Forwarded-Host')) {
    const protocol = req.get('X-Forwarded-Proto') || 'http';
    return `${protocol}://${req.get('X-Forwarded-Host')}${normalizedPath}`;
  }

  if (req && req.get('Host')) {
    const host = req.get('Host');
    if (host.includes('duckdns.org')) {
      return `http://${host}${normalizedPath}`;
    }
  }

  if (req && req.get('Host')) {
    const host = req.get('Host');
    return `http://${host}${normalizedPath}`;
  }

  const serverIP = getServerIP();
  return `http://${serverIP}:${PORT}${normalizedPath}`;
}

// Обновляет относительные пути картинок вида ![alt](/uploads/x.png) на
// абсолютные — чтобы статьи корректно открывались с других устройств в
// локальной сети или через внешний домен. Markdown-эквивалент старой
// updateImageUrlsInContent(), которая работала с HTML <img>.
function updateImageUrlsInContent(content, req = null) {
  if (!content) return content;
  return content.replace(/!\[([^\]]*)\]\(((?!https?:\/\/)[^)\s]+)\)/g, (match, alt, src) => {
    return `![${alt}](${formatImageUrl(src, req)})`;
  });
}

// Преобразует статью из хранилища в объект ответа клиенту (резолвит имя
// сервера по id, абсолютизирует пути картинок).
async function formatArticleResponse(article, req) {
  let serverName = article.server;
  if (article.server && !isNaN(article.server) && parseInt(article.server) > 0) {
    const serverFromDb = await getServerNameById(parseInt(article.server));
    if (serverFromDb) {
      serverName = serverFromDb;
    }
  }

  return {
    ...article,
    content: updateImageUrlsInContent(article.content, req),
    image: formatImageUrl(article.image, req),
    server: serverName
  };
}

// === API маршруты для статей ===

router.get('/articles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { since, server: serverFilter, tag } = req.query;
    let articles = store.listArticles();

    if (since) {
      const sinceDate = new Date(since);
      articles = articles.filter(a => new Date(a.created_at) > sinceDate);
    }
    if (serverFilter) {
      articles = articles.filter(a => String(a.server) === String(serverFilter));
    }
    if (tag) {
      // Клик по #тегу в редакторе/просмотре — статьи с этим тегом (frontmatter
      // tags или #тег прямо в тексте, см. store.extractHashtags).
      const tagLower = String(tag).toLowerCase();
      articles = articles.filter(a =>
        (a.tags || []).some(t => String(t).toLowerCase() === tagLower) ||
        store.extractHashtags(a.content).includes(tagLower)
      );
    }

    const result = [];
    for (const article of articles) {
      if (!(await canAccessArticle(req.user, article))) continue;
      result.push(await formatArticleResponse(article, req));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/articles/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    res.json(await formatArticleResponse(article, req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/articles', auth.authenticateToken, auth.checkApproved, (req, res) => {
  try {
    const { title, content, views, locked, role, roles, category, tags, author, image, attachments, server } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Заголовок статьи обязателен' });
    }

    const article = store.createArticle({
      title, content, views, locked, role, roles, category, tags, author, image, attachments,
      // Сервер статьи берём только из тела запроса — без фоллбэка на заголовок Host.
      server: server || null
    });
    res.json({ id: article.slug, slug: article.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/articles/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const existing = store.getArticle(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, existing))) {
      return res.status(403).json({ error: 'Недостаточно прав для редактирования этой статьи' });
    }

    const updated = store.updateArticle(req.params.id, req.body);
    res.json({ updated: 1, slug: updated.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/articles/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const existing = store.getArticle(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, existing))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления этой статьи' });
    }

    // Файл перемещается в content/.trash/, а не удаляется безвозвратно.
    const deleted = store.deleteArticle(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.json({ deleted: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Маршрут для поиска статей
router.get('/search-articles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const { rows, total } = store.searchArticles(q, { limit: parseInt(limit), offset: parseInt(offset) });

    const data = [];
    for (const article of rows) {
      // Закрытые по ролям статьи не должны находиться поиском для тех, у кого нет доступа
      if (!(await canAccessArticle(req.user, article))) continue;
      data.push(await formatArticleResponse(article, req));
    }

    res.json({
      success: true,
      data,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      query: q
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Backlinks — статьи, ссылающиеся на данную через [[wiki-ссылку]] (используется
// панелью обратных ссылок редактора, см. Этап 4).
router.get('/articles/:id/backlinks', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    res.json(store.getBacklinks(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Облегчённый индекс статей (без содержимого) — для автодополнения
// [[wiki-ссылок]] и проверки "существует ли статья" в редакторе.
router.get('/articles-index', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const index = [];
    for (const article of store.listArticles()) {
      if (!(await canAccessArticle(req.user, article))) continue;
      index.push({ slug: article.slug, title: article.title, tags: article.tags });
    }
    res.json(index);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Данные для графа связей: статьи (узлы) + wiki-ссылки между ними (рёбра).
router.get('/articles-graph', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const accessible = [];
    for (const article of store.listArticles()) {
      if (await canAccessArticle(req.user, article)) accessible.push(article);
    }
    const slugs = new Set(accessible.map(a => a.slug));

    // server/category — для клиентских фильтров графа (выбор сервера,
    // раскраска узлов по категории), см. public/graph-view.js
    const nodes = accessible.map(a => ({ slug: a.slug, title: a.title, server: a.server ?? null, category: a.category || '' }));
    const edges = [];
    for (const article of accessible) {
      for (const target of store.extractWikiLinks(article.content)) {
        if (slugs.has(target) && target !== article.slug) {
          edges.push({ from: article.slug, to: target });
        }
      }
    }

    res.json({ nodes, edges });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Переименование статьи: меняет заголовок и slug, автоматически обновляет
// [[wiki-ссылки]] на неё в остальных статьях.
router.put('/articles/:id/rename', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Новый заголовок обязателен' });
    }

    const existing = store.getArticle(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, existing))) {
      return res.status(403).json({ error: 'Недостаточно прав для переименования этой статьи' });
    }

    const result = store.renameArticle(req.params.id, title);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
