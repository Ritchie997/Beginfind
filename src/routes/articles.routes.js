// articles.routes.js — CRUD и поиск статей (Ibripedia).
//
// С Этапа 3 статьи хранятся как Markdown-файлы в content/ (см.
// src/services/articles-store.js) вместо articles.db. id статьи теперь —
// строковый slug (например "moya-statya"), а не число.

const express = require('express');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const auth = require('../middleware/auth');
const store = require('../services/articles-store');
const social = require('../services/social-store');
const stickers = require('../services/stickers-store');
const tagColors = require('../services/tag-colors');
const dashboardStats = require('../services/dashboard-stats');
const { serversDb } = require('../db/connections');
const { isAdminOnServer } = require('../services/server-permissions');
const { PORT, HOST } = require('../config/env');
const { dbPath } = require('../config/paths');

const router = express.Router();

// Отдельное соединение с users.db — по тому же принципу, что и другие
// модули, которым нужны пользователи (см. src/db/connections.js: общего
// usersDb там намеренно нет). Нужно для резолва author_id/co_author_ids
// статьи в отображаемое имя (см. getUsersByIds/formatArticleResponse ниже).
const usersDb = new sqlite3.Database(dbPath('users.db'));

function getUsersByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter((id) => id != null))];
  if (!uniqueIds.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const placeholders = uniqueIds.map(() => '?').join(',');
    usersDb.all(
      `SELECT id, display_name, username FROM users WHERE id IN (${placeholders})`,
      uniqueIds,
      (err, rows) => {
        if (err || !rows) return resolve(new Map());
        resolve(new Map(rows.map((r) => [r.id, r.display_name || r.username])));
      }
    );
  });
}

// Статьи, созданные до появления author_id, хранят автора текстом в
// article.legacyAuthorName (см. store.readArticleFile) — пытаемся
// сопоставить это имя реальному пользователю по username/display_name
// (регистронезависимо). Возвращает Map<legacyAuthorName, userId> только
// для имён, которые действительно на кого-то сматчились.
function resolveLegacyAuthorIds(names) {
  const uniqueNames = [...new Set((names || []).filter(Boolean))];
  if (!uniqueNames.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const placeholders = uniqueNames.map(() => '(LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?))').join(' OR ');
    const params = uniqueNames.flatMap((name) => [name, name]);
    usersDb.all(
      `SELECT id, display_name, username FROM users WHERE ${placeholders}`,
      params,
      (err, rows) => {
        if (err || !rows) return resolve(new Map());
        const byLowerName = new Map();
        rows.forEach((r) => {
          byLowerName.set(r.username.toLowerCase(), r.id);
          if (r.display_name) byLowerName.set(r.display_name.toLowerCase(), r.id);
        });
        const result = new Map();
        uniqueNames.forEach((name) => {
          const id = byLowerName.get(name.toLowerCase());
          if (id) result.set(name, id);
        });
        resolve(result);
      }
    );
  });
}

// Эффективный id автора статьи: собственный author_id, либо — если его нет —
// id, на который удалось сопоставить legacyAuthorName (см. выше). Используется
// и фильтром ?author=, и formatArticleResponse, чтобы старые статьи с
// текстовым автором вели себя так же, как новые.
function effectiveAuthorId(article, legacyNameToId) {
  if (article.author_id) return article.author_id;
  if (article.legacyAuthorName && legacyNameToId && legacyNameToId.has(article.legacyAuthorName)) {
    return legacyNameToId.get(article.legacyAuthorName);
  }
  return null;
}

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

// Возвращает { is_root, admin_level } автора статьи (0/false, если id не
// задан или пользователь не найден — например, автор был удалён).
// admin_level читается через JOIN на admin_roles (актуальный level роли),
// а не из кэш-столбца users.admin_level — иначе правка level существующей
// роли владельцем не отражалась бы здесь до переназначения роли.
// rankCache — опциональная Map<authorId, Promise<rank>> на время одного
// запроса: при сборке списка статей у многих один и тот же автор.
function getAuthorRank(authorId, rankCache) {
  if (!authorId) return Promise.resolve({ is_root: false, admin_level: 0 });
  if (rankCache && rankCache.has(authorId)) return rankCache.get(authorId);
  const promise = new Promise((resolve) => {
    usersDb.get(
      `SELECT u.is_root, r.level as role_level
       FROM users u LEFT JOIN admin_roles r ON u.admin_role_id = r.id
       WHERE u.id = ?`,
      [authorId],
      (err, row) => {
      if (err || !row) {
        resolve({ is_root: false, admin_level: 0 });
      } else {
        resolve({ is_root: !!row.is_root, admin_level: row.role_level || 0 });
      }
    });
  });
  if (rankCache) rankCache.set(authorId, promise);
  return promise;
}

// Иерархия админов при удалении статьи: владелец может удалить всё; автор
// может удалить свою же статью; админ может удалить статью, написанную
// не-админом или админом со строго меньшим рангом, но не статью владельца
// или админа выше себя по иерархии. Обычный пользователь может удалить
// только свою статью.
async function canDeleteArticle(user, article, rankCache) {
  if (user.is_root) return true;
  if (article.author_id && article.author_id === user.id) return true;

  const myLevel = user.admin_level || 0;
  if (myLevel <= 0) return false; // не админ и не автор — удалять нечем

  const authorRank = await getAuthorRank(article.author_id, rankCache);
  if (authorRank.is_root) return false; // статьи владельца неприкосновенны
  return authorRank.admin_level < myLevel;
}

// Иерархия при редактировании (и переименовании): пользователь, стоящий ниже
// автора статьи, править её не может. Владелец (is_root) выше любого админа,
// админ с ролью — выше не-админа (level 0); при РАВНОМ ранге правка разрешена
// (обычные пользователи по-прежнему могут дополнять статьи друг друга, а
// редактор становится соавтором — см. PUT /articles/:id). Автор всегда может
// править свою статью. Статья без определимого автора (легаси) — level 0.
// effectiveAuthorId — id из effectiveAuthorId(article, nameToId), а не голый
// article.author_id, чтобы легаси-статьи с автором по имени тоже защищались.
async function canEditArticle(user, article, effectiveAuthorId, rankCache) {
  if (user.is_root) return true;
  if (effectiveAuthorId && effectiveAuthorId === user.id) return true;

  const authorRank = await getAuthorRank(effectiveAuthorId, rankCache);
  if (authorRank.is_root) return false; // статьи владельца — только владельцу
  return (user.admin_level || 0) >= authorRank.admin_level;
}

// Права текущего пользователя на статью для фронта (can_edit/can_delete в
// ответе API) — чтобы UI не показывал кнопки, которые сервер всё равно
// отклонит. Сами маршруты PUT/DELETE/rename перепроверяют права независимо.
async function getArticlePermissions(user, article, legacyNameToId, rankCache) {
  const effId = effectiveAuthorId(article, legacyNameToId);
  const [can_edit, can_delete] = await Promise.all([
    canEditArticle(user, article, effId, rankCache),
    canDeleteArticle(user, { author_id: effId }, rankCache)
  ]);
  return { can_edit, can_delete };
}

// Разбирает и валидирует поля авторства из тела PUT /articles/:id — только
// для владельца (вызывается лишь при req.user.is_root). Возвращает null, если
// владелец авторство не трогал (нет ни author_id, ни co_author_ids); иначе
// { author_id, co_author_ids }: author_id — новый основной автор либо null
// ("не менять"), co_author_ids — итоговый список соавторов (без дублей и без
// самого автора; если список не прислан — текущий, за вычетом нового автора).
// Кидает Error с текстом для 400, если id некорректны или пользователей нет.
async function parseOwnerAuthorFields(body, currentAuthorId, currentCoAuthorIds) {
  const hasAuthor = body.author_id !== undefined && body.author_id !== null && body.author_id !== '';
  const hasCoAuthors = Array.isArray(body.co_author_ids);
  if (!hasAuthor && !hasCoAuthors) return null;

  const toId = (value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Некорректный id пользователя в списке авторов');
    return id;
  };

  const authorId = hasAuthor ? toId(body.author_id) : null;
  const finalAuthorId = authorId ?? currentAuthorId;
  const rawCoAuthors = hasCoAuthors ? body.co_author_ids : (currentCoAuthorIds || []);
  const coAuthorIds = [...new Set(rawCoAuthors.map(toId))].filter((id) => id !== finalAuthorId);

  const known = await getUsersByIds([authorId, ...coAuthorIds]);
  const missing = [authorId, ...coAuthorIds].filter((id) => id !== null && !known.has(id));
  if (missing.length) throw new Error(`Пользователь не найден: ${missing.join(', ')}`);

  return { author_id: authorId, co_author_ids: coAuthorIds };
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

// Обновляет относительные пути картинок (image-блоки и обложка infobox) на
// абсолютные — чтобы статьи корректно открывались с других устройств в
// локальной сети или через внешний домен. Раньше это была regex-замена по
// markdown ![alt](src) в сыром тексте; теперь картинки — это структурные
// блоки (см. src/services/blocks.js), поэтому проходим по дереву блоков.
function updateImageUrlsInContent(content, req = null) {
  if (!content) return content;
  return store.blocks.mapImages(content, (src) => formatImageUrl(src, req) || src);
}

// Преобразует статью из хранилища в объект ответа клиенту (резолвит имя
// сервера по id, абсолютизирует пути картинок, резолвит author_id/
// co_author_ids в {id, display_name}). usersMap/legacyNameToId — опциональные
// заранее собранные карты (см. GET /articles и /articles/browse ниже, где
// они собираются один раз на весь список вместо запроса на статью); если не
// переданы — резолвятся здесь же, для одиночного GET /articles/:id.
async function formatArticleResponse(article, req, usersMap, legacyNameToId, rankCache) {
  let serverName = article.server;
  if (article.server && !isNaN(article.server) && parseInt(article.server) > 0) {
    const serverFromDb = await getServerNameById(parseInt(article.server));
    if (serverFromDb) {
      serverName = serverFromDb;
    }
  }

  const nameToId = legacyNameToId || await resolveLegacyAuthorIds([article.legacyAuthorName]);
  const resolvedAuthorId = effectiveAuthorId(article, nameToId);
  const map = usersMap || await getUsersByIds([resolvedAuthorId, ...(article.co_author_ids || [])]);

  let author = null;
  if (resolvedAuthorId) {
    author = { id: resolvedAuthorId, display_name: map.get(resolvedAuthorId) || article.legacyAuthorName || 'Неизвестный автор' };
  } else if (article.legacyAuthorName) {
    // Текстовое имя есть, но ни с одним пользователем не сопоставилось —
    // показываем как есть, без id (фронт не сделает из него ссылку на профиль).
    author = { id: null, display_name: article.legacyAuthorName };
  }

  const permissions = req && req.user
    ? await getArticlePermissions(req.user, article, nameToId, rankCache)
    : { can_edit: false, can_delete: false };

  return {
    ...article,
    content: updateImageUrlsInContent(article.content, req),
    image: formatImageUrl(article.image, req),
    server: serverName,
    author,
    co_authors: (article.co_author_ids || []).map((id) => ({ id, display_name: map.get(id) || 'Неизвестный' })),
    ...permissions
  };
}

// === API маршруты для статей ===

router.get('/articles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { since, server: serverFilter, tag, author } = req.query;
    let articles = store.listArticles();

    if (since) {
      const sinceDate = new Date(since);
      articles = articles.filter(a => new Date(a.created_at) > sinceDate);
    }
    if (serverFilter) {
      articles = articles.filter(a => String(a.server) === String(serverFilter));
    }
    // Легаси-статьи (до author_id) хранят автора текстом — резолвим все
    // такие имена разом, до фильтра по author и до сборки usersMap ниже
    // (см. resolveLegacyAuthorIds/effectiveAuthorId).
    const legacyNameToId = await resolveLegacyAuthorIds(articles.map((a) => a.legacyAuthorName).filter(Boolean));

    if (author) {
      // Профиль пользователя (/profile/:id, вкладка "Медиа") — статьи, где
      // он автор (в т.ч. сматченный по legacy-имени) или соавтор.
      articles = articles.filter(a =>
        String(effectiveAuthorId(a, legacyNameToId)) === String(author) ||
        (a.co_author_ids || []).some((id) => String(id) === String(author))
      );
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

    // Один запрос к users.db на весь список вместо одного на статью —
    // см. formatArticleResponse.
    const allUserIds = [];
    articles.forEach((a) => {
      const effId = effectiveAuthorId(a, legacyNameToId);
      if (effId) allUserIds.push(effId);
      (a.co_author_ids || []).forEach((id) => allUserIds.push(id));
    });
    const usersMap = await getUsersByIds(allUserIds);

    const rankCache = new Map();
    const result = [];
    for (const article of articles) {
      if (!(await canAccessArticle(req.user, article))) continue;
      result.push(await formatArticleResponse(article, req, usersMap, legacyNameToId, rankCache));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Витрина статей (Ibripedia) — комбинация текстового поиска, фильтров
// (теги/сервер/статус/диапазон дат) и сортировки, с постраничной
// подгрузкой. Зарегистрирован ДО "/articles/:id" — иначе Express принял бы
// "browse" за значение :id и сюда бы запрос вообще не долетал.
router.get('/articles/browse', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const {
      q = '', tag = '', server = '', locked, dateFrom = '', dateTo = '',
      sort = '', limit = 30, offset = 0
    } = req.query;

    const tags = tag ? String(tag).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const lockedFilter = locked === 'true' ? true : locked === 'false' ? false : undefined;

    const filtered = store.filterArticles({ q, tags, server, locked: lockedFilter, dateFrom, dateTo, sort });

    // Доступ проверяется ДО среза страницы — иначе total и фактический
    // размер страницы врали бы из-за статей, закрытых по ролям для этого
    // конкретного пользователя (см. комментарий у store.filterArticles).
    const accessible = [];
    for (const article of filtered) {
      if (await canAccessArticle(req.user, article)) accessible.push(article);
    }

    const total = accessible.length;
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 30));
    const offsetNum = Math.max(0, parseInt(offset, 10) || 0);
    const page = accessible.slice(offsetNum, offsetNum + limitNum);

    const legacyNameToId = await resolveLegacyAuthorIds(page.map((a) => a.legacyAuthorName).filter(Boolean));
    const allUserIds = [];
    page.forEach((a) => {
      const effId = effectiveAuthorId(a, legacyNameToId);
      if (effId) allUserIds.push(effId);
      (a.co_author_ids || []).forEach((id) => allUserIds.push(id));
    });
    const usersMap = await getUsersByIds(allUserIds);

    // Лайки/комментарии/просмотры — счётчики на карточках витрины (см.
    // buildCard в public/ibripedia.js), одним батч-запросом на всю страницу,
    // а не по одному на статью (см. social.getCountsForSlugs). Реакции —
    // отдельным батчем по той же причине (см. getArticleReactionsForSlugs).
    const slugs = page.map((a) => a.slug);
    const socialCounts = await social.getCountsForSlugs(req.user.id, slugs);
    const reactionsBySlug = await getArticleReactionsForSlugs(slugs, req.user.id);

    const rankCache = new Map();
    const data = [];
    for (const article of page) {
      const formatted = await formatArticleResponse(article, req, usersMap, legacyNameToId, rankCache);
      const counts = socialCounts.get(article.slug) || { likes: 0, comments: 0, liked: false, views: 0 };
      data.push({
        ...formatted,
        likesCount: counts.likes,
        commentsCount: counts.comments,
        liked: counts.liked,
        viewsCount: counts.views,
        reactions: reactionsBySlug.get(article.slug) || []
      });
    }

    res.json({ success: true, data, total, limit: limitNum, offset: offsetNum });
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
    const formatted = await formatArticleResponse(article, req);
    // Реальный счётчик просмотров (см. article_views в connections.js) —
    // сам просмотр этим запросом НЕ засчитывается (см. POST .../view ниже):
    // этот GET дёргает и читалка Ibripedia, и редактор при открытии статьи
    // на правку, а редактирование не должно накручивать статистику.
    formatted.viewsCount = await social.getViewCount(article.slug);
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Засчитать просмотр статьи текущим пользователем — один просмотр на
// пользователя (повторные заходы того же не увеличивают счётчик, см.
// social.recordView), вызывается явно из читалки Ibripedia (см.
// openArticleView в public/ibripedia.js) сразу после открытия статьи, а не
// автоматически при GET /articles/:id (см. комментарий там же).
router.post('/articles/:id/view', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    await social.recordView(req.user.id, article.slug);
    res.json({ viewsCount: await social.getViewCount(article.slug) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/articles', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const { title, content, views, locked, role, roles, tags, image, attachments, server } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Заголовок статьи обязателен' });
    }

    const article = store.createArticle({
      title, content, views, locked, role, roles, tags, image, attachments,
      // Автор — всегда реальный создатель (из токена), а не то, что прислал
      // клиент — поле "Автор" в форме вырезано именно поэтому.
      author_id: req.user.id,
      // Сервер статьи берём только из тела запроса — без фоллбэка на заголовок Host.
      server: server || null
    });
    await assignColorsForArticle(article);
    res.json({ id: article.slug, slug: article.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/articles/:id', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const existing = store.getArticle(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, existing))) {
      return res.status(403).json({ error: 'Недостаточно прав для редактирования этой статьи' });
    }
    const legacyNameToId = await resolveLegacyAuthorIds([existing.legacyAuthorName]);
    if (!(await canEditArticle(req.user, existing, effectiveAuthorId(existing, legacyNameToId)))) {
      return res.status(403).json({ error: 'Недостаточно прав для редактирования этой статьи: автор выше вас по иерархии' });
    }

    // Управление авторством — ТОЛЬКО владелец (is_root): он может назначить
    // основного автора и задать полный список соавторов. Для всех остальных
    // author_id/co_author_ids из тела запроса игнорируются (см. ниже).
    let ownerAuthors = null;
    if (req.user.is_root) {
      try {
        ownerAuthors = await parseOwnerAuthorFields(req.body, effectiveAuthorId(existing, legacyNameToId), existing.co_author_ids);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Если статью редактирует не её автор — это админ-панель, править может
    // кто угодно с доступом, но редактор автоматически становится соавтором,
    // если явно не снял галочку "добавить себя как соавтора" в форме
    // (add_as_coauthor === false). Сам author_id при этом не меняется —
    // см. store.updateArticle. Если владелец явно управляет авторами
    // (ownerAuthors), список соавторов берётся из его запроса как есть —
    // автодобавление редактора не применяется.
    let coAuthorIds = existing.co_author_ids || [];
    if (ownerAuthors) {
      coAuthorIds = ownerAuthors.co_author_ids;
    } else if (existing.author_id && req.user.id !== existing.author_id && req.body.add_as_coauthor !== false) {
      if (!coAuthorIds.includes(req.user.id)) {
        coAuthorIds = [...coAuthorIds, req.user.id];
      }
    }

    // Статья без автора (легаси — до появления author_id, или без резолвящегося
    // legacyAuthorName): "усыновляем" её при первом же сохранении, иначе
    // author_id остался бы null навсегда (store.updateArticle обычно его не
    // трогает). Если legacy-имя всё же сматчилось на реального пользователя —
    // восстанавливаем историческое авторство, а не переписываем на текущего
    // редактора. author_id берётся из req.body только для владельца (см.
    // ownerAuthors выше) — иначе единственный источник здесь этот
    // вычисленный claimedAuthorId.
    let claimedAuthorId;
    if (ownerAuthors && ownerAuthors.author_id !== null) {
      claimedAuthorId = ownerAuthors.author_id;
    } else if (!existing.author_id) {
      if (existing.legacyAuthorName) {
        claimedAuthorId = legacyNameToId.get(existing.legacyAuthorName) || req.user.id;
      } else {
        claimedAuthorId = req.user.id;
      }
    }

    const { author_id: _ignoredAuthorId, ...bodyFields } = req.body;
    const updated = store.updateArticle(req.params.id, {
      ...bodyFields,
      co_author_ids: coAuthorIds,
      ...(claimedAuthorId !== undefined ? { author_id: claimedAuthorId } : {})
    });
    await assignColorsForArticle(updated);
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
    const legacyNameToId = await resolveLegacyAuthorIds([existing.legacyAuthorName]);
    if (!(await canDeleteArticle(req.user, { author_id: effectiveAuthorId(existing, legacyNameToId) }))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления этой статьи: автор выше вас по иерархии админов' });
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

// ---------- Реакции (эмодзи/стикером) — общая логика для статьи целиком и
// для отдельных комментариев, см. таблицу reactions в src/db/connections.js
// и toggleReaction/getReactionsForTargets в social-store.js. ----------

// Довешивает картинку/имя набора (см. stickers.resolveCodes) на "голые"
// {shortcode, count, reacted} из social-store и отбрасывает реакции на
// шорткод, который с тех пор перестал существовать/подтверждаться (набор
// удалили или разжаловали из approved уже после того, как реакцию
// поставили) — показывать их как картинку нечем.
async function resolveReactions(raw) {
  const stickerMeta = await stickers.resolveCodes(raw.map((r) => r.shortcode));
  return raw
    .map((r) => ({ ...r, ...stickerMeta.get(r.shortcode) }))
    .filter((r) => r.url);
}

async function getArticleReactions(slug, userId) {
  const map = await social.getReactionsForTargets('article', [slug], userId);
  return resolveReactions(map.get(String(slug)) || []);
}

// Батчем на всю страницу витрины (см. GET /articles/browse) — та же
// экономия походов в БД, что и attachCommentReactions ниже, просто по
// article_slug вместо id комментария. Возвращает Map<slug, reactions[]>.
async function getArticleReactionsForSlugs(slugs, userId) {
  const result = new Map();
  if (!slugs.length) return result;
  const map = await social.getReactionsForTargets('article', slugs, userId);
  const stickerMeta = await stickers.resolveCodes([...map.values()].flat().map((r) => r.shortcode));
  slugs.forEach((slug) => {
    const raw = map.get(String(slug)) || [];
    result.set(slug, raw.map((r) => ({ ...r, ...stickerMeta.get(r.shortcode) })).filter((r) => r.url));
  });
  return result;
}

// Батчем на весь список комментариев страницы — та же экономия походов в
// БД, что и attachStickersToItems: одним запросом реакции на все id сразу,
// одним resolveCodes — картинки на все встретившиеся шорткоды сразу.
async function attachCommentReactions(comments, userId) {
  if (!comments.length) return comments;
  const map = await social.getReactionsForTargets('comment', comments.map((c) => c.id), userId);
  const stickerMeta = await stickers.resolveCodes([...map.values()].flat().map((r) => r.shortcode));
  return comments.map((c) => {
    const raw = map.get(String(c.id)) || [];
    const reactions = raw.map((r) => ({ ...r, ...stickerMeta.get(r.shortcode) })).filter((r) => r.url);
    return { ...c, reactions };
  });
}

// Лайки статьи — count + "лайкнул ли её я" одним ответом (см. панель
// лайка/комментариев под статьёй в public/ibripedia.js).
router.get('/articles/:id/likes', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    res.json(await social.getLikeSummary(req.params.id, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Поставить/снять лайк — один лайк на пользователя на статью (см.
// social-store.toggleLike).
router.post('/articles/:id/likes/toggle', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    res.json(await social.toggleLike(req.user.id, req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Реакции на статью целиком — рядом с лайком, но эмодзи/стикером из
// добавленных себе наборов (см. панель реакций в public/ibripedia.js).
router.get('/articles/:id/reactions', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    res.json({ reactions: await getArticleReactions(req.params.id, req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/articles/:id/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер вам недоступен — добавьте набор себе во вкладке «Стикеры»' });
    }
    await social.toggleReaction(req.user.id, 'article', req.params.id, shortcode);
    res.json({ reactions: await getArticleReactions(req.params.id, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Комментарии статьи — видит любой, кому доступна сама статья.
router.get('/articles/:id/comments', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    // attachStickersToItems достраивает поле `.stickers` на каждый
    // комментарий (URL картинок для использованных в тексте шорткодов
    // ":slug:alias:") — см. комментарий в начале stickers-store.js.
    // parentId (см. rowToComment в social-store.js) группируется в дерево
    // "комментарий + ответы" уже на клиенте (см. renderComments в
    // public/ibripedia.js) — плоский список проще было бы разбить пополам,
    // чем удобно постранично подгружать вложенные ответы, а их пока и так
    // мало на статью.
    const comments = await social.listComments(req.params.id);
    const withStickers = await stickers.attachStickersToItems(comments);
    res.json(await attachCommentReactions(withStickers, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Добавить комментарий — автор берётся из токена (req.user), а не из тела
// запроса, тем же приёмом, что sender в messages.routes.js.
router.post('/articles/:id/comments', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    // Проверяем шорткоды стикеров ДО сохранения — иначе можно было бы
    // руками вписать шорткод чужого/неподтверждённого набора мимо пикера.
    await stickers.validateContentForPosting(req.user.id, req.body.content);

    // parentId — ответ на комментарий (см. "Ответить" в public/ibripedia.js).
    // Один уровень вложенности, как в YouTube: ответ на чужой ОТВЕТ
    // подшивается к тому же родителю, а не плодит цепочку — иначе пришлось
    // бы рекурсивно отрисовывать сколь угодно глубокое дерево.
    let parentId = req.body.parentId ? Number(req.body.parentId) : null;
    if (parentId) {
      const parent = await social.getComment(parentId);
      if (!parent || parent.slug !== req.params.id) {
        return res.status(400).json({ error: 'Комментарий, на который вы отвечаете, не найден' });
      }
      if (parent.parentId) parentId = parent.parentId;
    }

    const authorName = req.user.display_name || req.user.username;
    const comment = await social.addComment(req.user.id, authorName, req.params.id, req.body.content, parentId);
    const [withStickers] = await stickers.attachStickersToItems([comment]);
    const [withReactions] = await attachCommentReactions([withStickers], req.user.id);
    res.status(201).json(withReactions);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Поставить/снять реакцию на комментарий — тот же shortcode/toggle, что и
// на статью целиком, но target_type='comment' (см. toggleReaction в
// social-store.js).
router.post('/articles/:id/comments/:commentId/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const comment = await social.getComment(req.params.commentId);
    if (!comment || comment.slug !== req.params.id) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    const article = store.getArticle(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    if (!(await canAccessArticle(req.user, article))) {
      return res.status(403).json({ error: 'Доступ к этой статье ограничен' });
    }
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер вам недоступен — добавьте набор себе во вкладке «Стикеры»' });
    }
    await social.toggleReaction(req.user.id, 'comment', req.params.commentId, shortcode);
    const map = await social.getReactionsForTargets('comment', [req.params.commentId], req.user.id);
    res.json({ reactions: await resolveReactions(map.get(String(req.params.commentId)) || []) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Удалить комментарий — свой собственный, либо (как и удаление самой
// статьи) модератор выше автора комментария по иерархии, либо владелец —
// переиспользуем canDeleteArticle, подставив автора комментария вместо
// автора статьи.
router.delete('/articles/:id/comments/:commentId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const comment = await social.getComment(req.params.commentId);
    if (!comment || comment.slug !== req.params.id) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }

    const isOwn = comment.userId === req.user.id;
    if (!isOwn && !(await canDeleteArticle(req.user, { author_id: comment.userId }))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления этого комментария' });
    }

    const removed = await social.deleteCommentCascade(req.params.commentId);
    if (!removed) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    res.json({ success: true });
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

// Список тегов доступных статей + цвет каждого. Теги, у которых цвета ещё нет
// (в том числе все уже существовавшие до появления цветов), получают
// случайный и сохраняют его — см. src/services/tag-colors.js.
async function collectTagsWithColors(articles) {
  const list = store.collectTags(articles);
  const colors = await tagColors.ensureColors(list.map((t) => ({ key: t.key, name: t.tag })));
  return list.map((t) => ({ tag: t.tag, count: t.count, color: (colors.get(t.key) || {}).color || null }));
}

// Новому тегу статьи цвет выдаётся сразу при сохранении: тег, впервые
// появившийся в этой статье ("тег-родитель"), получает случайный цвет, а все
// последующие теги с тем же названием — уже выданный. Ошибка здесь не должна
// ронять сохранение самой статьи.
async function assignColorsForArticle(article) {
  try {
    const list = store.collectTags([article]);
    await tagColors.ensureColors(list.map((t) => ({ key: t.key, name: t.tag })));
  } catch (err) {
    console.error('[tags] Не удалось выдать цвет тегам статьи:', err.message);
  }
}

// Глобальный список всех тегов — без дублей (регистр и ведущий "#" не
// различаются), с числом статей и цветом у каждого тега. Учитываются и теги из поля
// "Теги", и #хэштеги в тексте статей; берутся только статьи, доступные
// текущему пользователю (так же, как в articles-index и графе), чтобы список
// не выдавал теги закрытых от него статей. Используется вкладкой "Теги".
router.get('/tags', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const accessible = [];
    for (const article of store.listArticles()) {
      if (await canAccessArticle(req.user, article)) accessible.push(article);
    }
    res.json(await collectTagsWithColors(accessible));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tags/color { tag, color } — сменить цвет тега на собственный
// (#rrggbb). Цвет один на тег во всей системе: граф и вкладка "Теги" сразу
// показывают новый цвет всем. Менять можно только существующие (доступные
// пользователю) теги — чтобы таблица цветов не обрастала произвольными
// названиями.
router.put('/tags/color', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const { tag, color } = req.body || {};
    const key = store.tagKey(tag);
    if (!key) return res.status(400).json({ error: 'Не указан тег' });
    if (!tagColors.HEX_RE.test(String(color || ''))) {
      return res.status(400).json({ error: 'Цвет должен быть в формате #rrggbb' });
    }

    const accessible = [];
    for (const article of store.listArticles()) {
      if (await canAccessArticle(req.user, article)) accessible.push(article);
    }
    const existing = store.collectTags(accessible).find((t) => t.key === key);
    if (!existing) return res.status(404).json({ error: 'Такого тега нет' });

    const saved = await tagColors.setColor(key, existing.tag, color);
    res.json({ tag: existing.tag, color: saved });
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

    // server — для клиентского фильтра графа (выбор сервера), см.
    // public/graph-view.js.
    // tags — для поиска по #тегу в графе: объединяем теги, заданные в форме
    // статьи (a.tags), и #хэштеги прямо в тексте (Obsidian-стиль, см.
    // extractHashtags) — так же, как это уже устроено в filterArticles()
    // для витрины Ibripedia, только тут результат отдаётся клиенту, а не
    // используется для серверной фильтрации.
    // Теги узла нормализованы (store.tagKey) и идут в порядке: сначала из поля
    // "Теги", затем #хэштеги из текста — ПЕРВЫЙ из них определяет цвет узла на
    // клиенте (tagColors ниже, см. renderGraph в public/graph-view.js).
    const nodes = accessible.map(a => {
      const ownTags = (a.tags || []).map(t => store.tagKey(t));
      const hashtags = store.extractHashtags(a.content).map(t => store.tagKey(t));
      return {
        slug: a.slug,
        title: a.title,
        server: a.server ?? null,
        tags: [...new Set([...ownTags, ...hashtags])].filter(Boolean)
      };
    });
    const tagList = store.collectTags(accessible);
    const colorMap = await tagColors.ensureColors(tagList.map((t) => ({ key: t.key, name: t.tag })));
    const tagColorsOut = {};
    colorMap.forEach((v, key) => { tagColorsOut[key] = { name: v.name, color: v.color }; });
    const edges = [];
    for (const article of accessible) {
      for (const target of store.extractWikiLinks(article.content)) {
        if (slugs.has(target) && target !== article.slug) {
          edges.push({ from: article.slug, to: target });
        }
      }
    }

    res.json({ nodes, edges, tagColors: tagColorsOut });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сводка для дашборда: пользователи, сообщения мессенджера, комментарии
// статей Ibripedia (отдельная статистика) и свежие события для ленты
// "Последняя активность". Здесь
// (рядом с articles-graph), а не в отдельном роутере, потому что комментарии
// нужно отфильтровать по canAccessArticle — иначе текст комментариев к
// закрытым статьям утёк бы на дашборд тем, кому сама статья недоступна.
router.get('/dashboard-summary', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const [users, messenger, comments] = await Promise.all([
      dashboardStats.getUsersSummary(5),
      dashboardStats.getMessengerSummary(3),
      dashboardStats.getCommentsSummary(50)
    ]);

    const articlesBySlug = new Map(store.listArticles().map((a) => [a.slug, a]));

    // Комментарии удалённых статей остаются в БД — в счётчик не берём.
    let commentsTotal = 0;
    let commentsTrend = 0;
    let commentedArticles = 0;
    for (const row of comments.perArticle) {
      if (!articlesBySlug.has(row.slug)) continue;
      commentsTotal += row.total;
      commentsTrend += row.recent;
      commentedArticles += 1;
    }

    const recentComments = [];
    const accessBySlug = new Map();
    for (const c of comments.recent) {
      if (recentComments.length >= 5) break;
      const article = articlesBySlug.get(c.slug);
      if (!article) continue;
      if (!accessBySlug.has(c.slug)) accessBySlug.set(c.slug, await canAccessArticle(req.user, article));
      if (!accessBySlug.get(c.slug)) continue;
      recentComments.push({ ...c, articleTitle: article.title });
    }

    res.json({
      users: { total: users.total, trend: users.trend },
      messages: {
        total: messenger.total,
        trend: messenger.trend,
        daily: messenger.daily
      },
      comments: {
        total: commentsTotal,
        trend: commentsTrend,
        articles: commentedArticles
      },
      recent: {
        users: users.recent,
        messages: messenger.recent,
        comments: recentComments
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Переименование статьи: меняет заголовок и slug, автоматически обновляет
// [[wiki-ссылки]] на неё в остальных статьях.
router.put('/articles/:id/rename', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
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
    const legacyNameToId = await resolveLegacyAuthorIds([existing.legacyAuthorName]);
    if (!(await canEditArticle(req.user, existing, effectiveAuthorId(existing, legacyNameToId)))) {
      return res.status(403).json({ error: 'Недостаточно прав для переименования этой статьи: автор выше вас по иерархии' });
    }

    const result = store.renameArticle(req.params.id, title);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
