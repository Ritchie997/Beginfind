// articles.routes.js — CRUD и поиск статей (Ibripedia).
//
// ВНИМАНИЕ: этот модуль всё ещё читает/пишет articles.db (SQLite). В Этапе 3
// хранение статей переезжает на Markdown-файлы в content/ — эта реализация
// будет заменена, но сам файл и маршруты (пути /api/articles*) останутся
// на своём месте в новой структуре.

const express = require('express');
const os = require('os');
const auth = require('../middleware/auth');
const { articlesDb, serversDb } = require('../db/connections');
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

// Разбирает поле articles.role (JSON-массив id ролей сервера, одиночная роль
// или пусто) в массив числовых id ролей сервера
function parseArticleRoleIds(roleField) {
  if (!roleField) return [];
  let values;
  try {
    values = (roleField.startsWith('[') && roleField.endsWith(']'))
      ? JSON.parse(roleField)
      : [roleField];
  } catch (e) {
    values = [roleField];
  }
  return values.map(v => parseInt(v)).filter(v => !isNaN(v));
}

// Проверяет, может ли пользователь просматривать/редактировать/удалять статью
// с учётом её флага "locked" и списка разрешённых ролей сервера.
// root и админ сервера статьи могут всё; остальным при locked=true нужна
// одна из ролей, перечисленных в article.role.
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

  const allowedRoleIds = parseArticleRoleIds(article.role);
  if (allowedRoleIds.length === 0) return true; // ограничение не задано корректно — не блокируем

  const userRoleIds = await getUserRoleIdsOnServer(user.id, serverId);
  return userRoleIds.some(r => allowedRoleIds.includes(r));
}

// Функция для определения IP-адреса сервера
function getServerIP() {
  // Если HOST уже является конкретным IP, возвращаем его
  if (HOST !== '0.0.0.0' && HOST !== 'localhost' && HOST !== '127.0.0.1') {
    return HOST;
  }

  // В противном случае возвращаем IP-адрес машины,
  // который можно использовать из локальной сети
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

// Функция для форматирования URL изображения
function formatImageUrl(imagePath, req = null) {
  if (!imagePath) return null;

  // Если это уже полный URL (внешнее изображение), возвращаем как есть
  if (imagePath.startsWith('http')) {
    return imagePath;
  }

  // Убедимся, что путь начинается с '/', иначе добавляем
  let normalizedPath = imagePath;
  if (!imagePath.startsWith('/')) {
    normalizedPath = '/' + imagePath;
  }

  // Проверяем, есть ли заголовок X-Forwarded-Host (может использоваться с обратным прокси)
  if (req && req.get('X-Forwarded-Host')) {
    const protocol = req.get('X-Forwarded-Proto') || 'http';
    return `${protocol}://${req.get('X-Forwarded-Host')}${normalizedPath}`;
  }

  // Для доступа через DuckDNS используем внешний домен
  if (req && req.get('Host')) {
    const host = req.get('Host');
    if (host.includes('duckdns.org')) {
      return `http://${host}${normalizedPath}`;
    }
  }

  // В остальных случаях используем текущий хост
  if (req && req.get('Host')) {
    const host = req.get('Host');
    return `http://${host}${normalizedPath}`;
  }

  // Получаем IP-адрес сервера для формирования корректного URL
  // при доступе с разных устройств в сети
  const serverIP = getServerIP();
  const baseUrl = `http://${serverIP}:${PORT}`;
  return baseUrl + normalizedPath;
}

// Функция для обновления URL изображений в содержимом статьи
function updateImageUrlsInContent(content, req = null) {
  if (!content) return content;

  // Обрабатываем все теги <img> с относительными URL на полные URL
  return content.replace(/<img\s+([^>]*?)src=(["'])((?!https?:\/\/)[^"']*)(["'])([^>]*?)>/gi, (match, beforeSrc, quote1, src, quote2, afterTag) => {
    const isSelfClosing = match.trim().endsWith('/>');
    const formattedUrl = formatImageUrl(src, req);
    const newTag = `<img ${beforeSrc}src=${quote1}${formattedUrl}${quote2}${afterTag}>`;

    if (isSelfClosing) {
      return newTag.replace('>', '/>');
    }
    return newTag;
  });
}

// Функция для нормализации пути к изображению перед сохранением в базу
function normalizeImagePath(imagePath) {
  if (!imagePath) return null;

  // Если это внешний URL, извлекаем только путь
  if (imagePath.startsWith('http')) {
    try {
      const url = new URL(imagePath);
      return url.pathname;
    } catch (e) {
      console.warn('Could not parse image URL, saving as is:', imagePath);
      return imagePath;
    }
  }

  // Если путь уже содержит uploads, но не начинается с /, добавляем /
  if (imagePath.includes('uploads') && !imagePath.startsWith('/')) {
    return '/' + imagePath;
  }

  // Если это просто имя файла, добавляем /uploads/
  if (!imagePath.startsWith('/') && !imagePath.includes('/')) {
    return `/uploads/${imagePath}`;
  }

  return imagePath;
}

// Собирает роль(и) статьи в единое поле для хранения в БД
function resolveRoleValue(role, roles) {
  if (roles && Array.isArray(roles) && roles.length > 0) {
    return JSON.stringify(roles);
  }
  if (role && typeof role === 'object' && Array.isArray(role)) {
    return JSON.stringify(role);
  }
  return role; // одиночная роль для обратной совместимости
}

// Преобразует строку row из БД в объект статьи для ответа клиенту
async function formatArticleRow(row, req, { includeDescription = false } = {}) {
  const formattedImage = formatImageUrl(row.image, req);

  let serverName = row.server;
  if (row.server && !isNaN(row.server) && parseInt(row.server) > 0) {
    const serverFromDb = await getServerNameById(parseInt(row.server));
    if (serverFromDb) {
      serverName = serverFromDb;
    }
  }

  const formatted = {
    ...row,
    title: row.title,
    content: updateImageUrlsInContent(row.content, req),
    views: row.views,
    locked: row.locked === 1,
    role: row.role,
    roles: row.role && row.role.startsWith('[') && row.role.endsWith(']') ? JSON.parse(row.role) : (row.role ? [row.role] : []),
    category: row.category,
    tags: row.tags ? JSON.parse(row.tags) : [],
    author: row.author,
    image: formattedImage,
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    server: serverName,
    created_at: row.created_at
  };

  if (includeDescription) {
    formatted.description = row.description;
  }

  return formatted;
}

// === API маршруты для статей ===

router.get('/articles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  const { since, server: serverFilter } = req.query;

  let query = 'SELECT * FROM articles';
  let params = [];

  let whereConditions = [];
  if (since) {
    whereConditions.push('created_at > ?');
    params.push(since);
  }

  if (serverFilter) {
    whereConditions.push('server = ?');
    params.push(serverFilter);
  }

  if (whereConditions.length > 0) {
    query += ' WHERE ' + whereConditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  articlesDb.all(query, params, async (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    const encodedRows = [];
    for (const row of rows) {
      // Закрытые статьи показываем только тем, у кого есть доступ по роли/правам
      if (!(await canAccessArticle(req.user, row))) {
        continue;
      }
      encodedRows.push(await formatArticleRow(row, req));
    }
    res.json(encodedRows);
  });
});

router.get('/articles/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  const { id } = req.params;
  articlesDb.get('SELECT * FROM articles WHERE id = ?', [id], async (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!row) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    if (!(await canAccessArticle(req.user, row))) {
      res.status(403).json({ error: 'Доступ к этой статье ограничен' });
      return;
    }
    res.json(await formatArticleRow(row, req, { includeDescription: true }));
  });
});

router.post('/articles', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const { title, content, views, locked, role, roles, category, tags, author, image, attachments, server } = req.body;
  // Сервер статьи берём только из тела запроса. Раньше сюда подставлялся
  // req.get('Host'), из-за чего статья без явного сервера получала в
  // качестве "сервера" хост запроса (например "localhost:3002") — это
  // ломало и отображение имени сервера, и проверку прав по ролям.
  const articleServer = server || null;

  const tagsJson = tags ? JSON.stringify(tags) : '[]';
  const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]';
  const lockedInt = locked ? 1 : 0;
  const roleValue = resolveRoleValue(role, roles);
  const imagePath = normalizeImagePath(image);

  // id не указываем — SQLite сам назначит следующий по автоинкременту.
  // Раньше id искался как "наименьший свободный" отдельным запросом, что
  // могло приводить к гонке при параллельном создании статей и к
  // переиспользованию id удалённых статей (опасно для ссылок на статьи).
  articlesDb.run(
    'INSERT INTO articles (title, content, views, locked, role, category, tags, author, image, attachments, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [title, content, views || 0, lockedInt, roleValue, category, tagsJson, author, imagePath, attachmentsJson, articleServer],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ id: this.lastID });
    }
  );
});

router.put('/articles/:id', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const { id } = req.params;

  // Сначала читаем текущую статью, чтобы проверить право на её редактирование
  // (раньше правку мог сохранить любой авторизованный пользователь, включая
  // статьи, закрытые по ролям).
  articlesDb.get('SELECT * FROM articles WHERE id = ?', [id], async (err, existing) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    if (!(await canAccessArticle(req.user, existing))) {
      res.status(403).json({ error: 'Недостаточно прав для редактирования этой статьи' });
      return;
    }

    const { title, content, views, locked, role, roles, category, tags, author, image, attachments, server } = req.body;
    const articleServer = server || existing.server;

    const tagsJson = tags ? JSON.stringify(tags) : '[]';
    const attachmentsJson = attachments ? JSON.stringify(attachments) : '[]';
    const lockedInt = locked ? 1 : 0;
    const roleValue = resolveRoleValue(role, roles);
    const imagePath = normalizeImagePath(image);

    articlesDb.run(
      'UPDATE articles SET title = ?, content = ?, views = ?, locked = ?, role = ?, category = ?, tags = ?, author = ?, image = ?, attachments = ?, server = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [title, content, views || 0, lockedInt, roleValue, category, tagsJson, author, imagePath, attachmentsJson, articleServer, id],
      function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        if (this.changes === 0) {
          res.status(404).json({ error: 'Article not found' });
          return;
        }
        res.json({ updated: this.changes });
      }
    );
  });
});

router.delete('/articles/:id', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const { id } = req.params;

  // Читаем статью перед удалением, чтобы проверить право на удаление
  // (раньше удалить закрытую по ролям статью мог кто угодно авторизованный).
  articlesDb.get('SELECT * FROM articles WHERE id = ?', [id], async (err, existing) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    if (!(await canAccessArticle(req.user, existing))) {
      res.status(403).json({ error: 'Недостаточно прав для удаления этой статьи' });
      return;
    }

    articlesDb.run('DELETE FROM articles WHERE id = ?', [id], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      if (this.changes === 0) {
        res.status(404).json({ error: 'Article not found' });
        return;
      }
      res.json({ deleted: this.changes });
    });
  });
});

// Маршрут для поиска статей
router.get('/search-articles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  const { q, limit = 50, offset = 0 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  const searchQuery = q.trim();

  const searchSql = `
    SELECT a.*,
           CASE
             WHEN a.title = ? THEN 1  -- Точное совпадение в заголовке
             WHEN a.title LIKE ? THEN 2  -- Частичное совпадение в заголовке
             ELSE 3  -- Совпадение в содержимом
           END AS sort_rank
    FROM articles a
    WHERE a.title LIKE ?
       OR a.content LIKE ?
    ORDER BY sort_rank
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) as total
    FROM articles a
    WHERE a.title LIKE ?
       OR a.content LIKE ?
  `;

  try {
    const titleExact = searchQuery;
    const titleLike = `%${searchQuery}%`;
    const contentLike = `%${searchQuery}%`;

    articlesDb.get(countSql, [titleLike, contentLike], (err, countRow) => {
      if (err) {
        console.error('Search count error:', err);
        return res.status(500).json({ error: err.message });
      }

      const total = countRow ? countRow.total : 0;

      articlesDb.all(searchSql, [titleExact, titleLike, titleLike, contentLike, parseInt(limit), parseInt(offset)], async (err, rows) => {
        if (err) {
          console.error('Search error:', err);
          return res.status(500).json({ error: err.message });
        }

        const encodedRows = [];
        for (const row of rows) {
          // Закрытые по ролям статьи не должны находиться поиском для тех, у кого нет доступа
          // (total выше считает по всей БД без учёта прав — с переездом на Markdown-поиск
          // в Этапе 3 это будет учтено на уровне самого поиска)
          if (!(await canAccessArticle(req.user, row))) {
            continue;
          }
          const formatted = await formatArticleRow(row, req);
          formatted.relevance_score = (row.sort_rank === 1) ? 100 : (row.sort_rank === 2) ? 80 : (row.sort_rank === 3) ? 60 : 40;
          encodedRows.push(formatted);
        }

        res.json({
          success: true,
          data: encodedRows,
          total: total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          query: q
        });
      });
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
