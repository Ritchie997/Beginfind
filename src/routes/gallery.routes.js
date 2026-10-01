// gallery.routes.js — Галерея: /api/gallery/* (см. src/services/gallery-store.js).
//
// Лайки/просмотры/комментарии/реакции — те же эндпоинты и тот же формат
// ответов, что у статей Ibripedia (articles.routes.js), только на своих
// таблицах: клиент переиспользует для работы галереи готовый UI читалки
// (см. engagementApi в public/ibripedia.js и public/gallery.js).

const express = require('express');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const auth = require('../middleware/auth');
const gallery = require('../services/gallery-store');
const social = require('../services/social-store');
const stickers = require('../services/stickers-store');
const articlesStore = require('../services/articles-store');
const articleLayers = require('../services/article-layers');
const { uploadGallery } = require('../uploads/multer-config');
const { readSettings } = require('../services/system-settings');
const { getAvatarUrl } = require('../services/avatars');
const { serversDb } = require('../db/connections');
const { dbPath } = require('../config/paths');

const router = express.Router();

// Своё соединение с users.db — как в articles.routes.js (общего usersDb нет).
const usersDb = new sqlite3.Database(dbPath('users.db'));

function getUsersByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter((id) => id != null))];
  if (!uniqueIds.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    usersDb.all(
      `SELECT u.id, u.display_name, u.username, u.is_root, r.level as role_level
       FROM users u LEFT JOIN admin_roles r ON u.admin_role_id = r.id
       WHERE u.id IN (${uniqueIds.map(() => '?').join(',')})`,
      uniqueIds,
      (err, rows) => resolve(new Map((err || !rows ? [] : rows).map((r) => [r.id, r])))
    );
  });
}

function authorInfo(id, usersMap) {
  const u = usersMap.get(id);
  return { id, display_name: u ? (u.display_name || u.username) : 'Неизвестный автор', avatar: getAvatarUrl(id) };
}

function getServerName(serverId) {
  if (!serverId) return Promise.resolve(null);
  return new Promise((resolve) => {
    serversDb.get('SELECT name FROM servers WHERE id = ?', [serverId], (err, row) => resolve(err || !row ? null : row.name));
  });
}

// Иерархия как у статей (canEditArticle/canDeleteArticle): автор, владелец,
// доверенный админ; админ — только работы не-админа или админа ниже рангом.
function canManageWork(user, authorId, usersMap) {
  if (user.is_root || user.is_role_manager) return true;
  if (authorId === user.id) return true;
  const myLevel = user.admin_level || 0;
  if (myLevel <= 0) return false;
  const author = usersMap.get(authorId);
  if (author && author.is_root) return false;
  return ((author && author.role_level) || 0) < myLevel;
}

function displayName(user) {
  return user.display_name || user.username;
}

function workCard(item, usersMap) {
  return {
    id: item.id,
    title: item.title,
    tags: item.tags,
    restricted: item.roles.length > 0,
    scrollMode: item.scroll_mode,
    author: authorInfo(item.author_id, usersMap),
    cover: item.cover,
    pagesCount: item.pagesCount,
    hasVariations: item.hasVariations,
    likes: item.counts.likes,
    liked: item.counts.liked,
    comments: item.counts.comments,
    views: item.counts.views,
    created_at: item.created_at
  };
}

async function cardsFor(items) {
  const usersMap = await getUsersByIds(items.map((i) => i.author_id));
  return items.map((i) => workCard(i, usersMap));
}

// Работа + проверка доступа одним шагом: 404, если нет, 403 — если закрыта.
async function loadAccessibleWork(req, res) {
  const work = await gallery.getWorkRow(req.params.id);
  if (!work) {
    res.status(404).json({ error: 'Работа не найдена' });
    return null;
  }
  const ctx = await gallery.getAccessContext(req.user);
  if (!gallery.canViewWork(work, ctx)) {
    res.status(403).json({ error: 'Доступ к этой работе ограничен' });
    return null;
  }
  return work;
}

async function loadManageableWork(req, res) {
  const work = await gallery.getWorkRow(req.params.id);
  if (!work) {
    res.status(404).json({ error: 'Работа не найдена' });
    return null;
  }
  const usersMap = await getUsersByIds([work.author_id]);
  if (!canManageWork(req.user, work.author_id, usersMap)) {
    res.status(403).json({ error: 'Недостаточно прав для изменения этой работы' });
    return null;
  }
  return work;
}

// Статьи, к которым привязана работа, — только доступные читателю, заголовок
// с его слоя (как в индексе статей), чтобы не утёк заголовок закрытого слоя.
async function linkedArticlesFor(slugs, user) {
  const out = [];
  for (const slug of slugs) {
    const article = articlesStore.getArticle(slug);
    if (!article) continue;
    const resolved = await articleLayers.resolveArticleLayer(article, user);
    if (!resolved) continue;
    out.push({ slug, title: resolved.layer.title || article.title || slug });
  }
  return out;
}

async function validateRolesOrThrow(user, roles) {
  if (!(await gallery.canAssignRoles(user, roles))) {
    throw new Error('Можно ограничить доступ только ролями, которые есть у вас самих');
  }
}

// Привязать работу можно только к существующим статьям, доступным автору.
async function filterArticleSlugs(slugs, user) {
  const out = [];
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    const article = articlesStore.getArticle(String(slug));
    if (article && (await articleLayers.hasArticleAccess(article, user))) out.push(article.slug || String(slug));
  }
  return out;
}

async function fullWork(work, user) {
  const usersMap = await getUsersByIds([work.author_id]);
  const canManage = canManageWork(user, work.author_id, usersMap);
  const ctx = await gallery.getAccessContext(user);
  const [pages, associatedIds, counts, serverName] = await Promise.all([
    // Только доступные читателю вариации; роли вариаций — тем, кто правит.
    gallery.getPagesForUser(work, ctx, { withRoles: canManage }),
    gallery.getAssociatedIds(work.id),
    gallery.getCountsForWorks(user.id, [work.id]),
    getServerName(work.server_id)
  ]);
  const associated = associatedIds.length
    ? await cardsFor((await gallery.listWorks(user, { ids: associatedIds, limit: 100 })).items)
    : [];
  const c = counts.get(work.id);
  return {
    id: work.id,
    title: work.title,
    description: work.description,
    tags: work.tags,
    scrollMode: work.scroll_mode,
    serverId: work.server_id,
    serverName,
    // Список ролей — только тем, кто может править работу (форма правки);
    // остальным достаточно знать, что работа закрытая.
    roles: canManage ? work.roles : undefined,
    restricted: work.roles.length > 0,
    author: authorInfo(work.author_id, usersMap),
    pages,
    associated,
    articleSlugs: canManage ? work.article_slugs : undefined,
    articles: await linkedArticlesFor(work.article_slugs, user),
    likes: c.likes,
    liked: c.liked,
    comments: c.comments,
    views: c.views,
    created_at: work.created_at,
    updated_at: work.updated_at,
    can_edit: canManage,
    can_delete: canManage
  };
}

// ===== Витрина / поиск =====

router.get('/gallery/works', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { items, total } = await gallery.listWorks(req.user, {
      q: req.query.q,
      tag: req.query.tag,
      authorId: req.query.author,
      sort: req.query.sort,
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json({ data: await cardsFor(items), total });
  } catch (err) {
    console.error('[gallery] list:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/gallery/tags', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await gallery.listTags(req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Работы, привязанные к статье (полоса "Из галереи" под статьёй).
router.get('/gallery/by-article/:slug', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const article = articlesStore.getArticle(req.params.slug);
    if (!article || !(await articleLayers.hasArticleAccess(article, req.user))) return res.json([]);
    res.json(await cardsFor(await gallery.listWorksForArticle(req.user, article.slug || req.params.slug)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gallery/works/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    res.json(await fullWork(work, req.user));
  } catch (err) {
    console.error('[gallery] get:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Создание / правка / удаление =====

router.post('/gallery/works', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    await validateRolesOrThrow(req.user, req.body.roles);
    const body = { ...req.body, articleSlugs: await filterArticleSlugs(req.body.articleSlugs, req.user) };
    const id = await gallery.createWork(req.user, body, displayName(req.user));
    res.status(201).json(await fullWork(await gallery.getWorkRow(id), req.user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/gallery/works/:id', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const work = await loadManageableWork(req, res);
    if (!work) return;
    // Роли, уже стоявшие на работе, можно оставить и без их наличия у себя
    // (модератор правит чужую работу) — проверяем только добавленные.
    const before = new Set(work.roles.map((r) => `${r.scope}:${r.id}`));
    const added = articleLayers.normalizeLayerRoles(req.body.roles).filter((r) => !before.has(`${r.scope}:${r.id}`));
    await validateRolesOrThrow(req.user, added);
    const body = { ...req.body };
    if (Array.isArray(req.body.articleSlugs)) {
      // Привязки к статьям, которых правящий не видит, сохраняем как были.
      const visible = await filterArticleSlugs(work.article_slugs, req.user);
      const hidden = work.article_slugs.filter((s) => !visible.includes(s));
      body.articleSlugs = [...hidden, ...(await filterArticleSlugs(req.body.articleSlugs, req.user))];
    } else {
      delete body.articleSlugs;
    }
    // Роли вариаций: так же — проверяем только добавленные к вариации роли.
    if (Array.isArray(req.body.pages)) {
      const rolesBefore = await gallery.getVariantRolesMap(work.id);
      const addedVariantRoles = [];
      req.body.pages.forEach((p) => (p && Array.isArray(p.variants) ? p.variants : []).forEach((v) => {
        const prev = new Set((rolesBefore.get(Number(v && v.id)) || []).map((r) => `${r.scope}:${r.id}`));
        articleLayers.normalizeLayerRoles(v && v.roles).forEach((r) => {
          if (!prev.has(`${r.scope}:${r.id}`)) addedVariantRoles.push(r);
        });
      }));
      await validateRolesOrThrow(req.user, addedVariantRoles);
    }
    const usersMap = await getUsersByIds([work.author_id]);
    await gallery.updateWork(work.id, body, authorInfo(work.author_id, usersMap).display_name, await gallery.getAccessContext(req.user));
    res.json(await fullWork(await gallery.getWorkRow(work.id), req.user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/gallery/works/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadManageableWork(req, res);
    if (!work) return;
    await gallery.deleteWork(work.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Массовая загрузка (поле images, до 60 файлов за раз — клиент шлёт большие
// пачки частями): без ?pageId каждый файл — новая страница, с ?pageId —
// новые вариации этой страницы. Файлы отклонённого запроса удаляем.
router.post(
  '/gallery/works/:id/images',
  auth.authenticateToken,
  auth.checkApproved,
  auth.checkNotMuted,
  uploadGallery.array('images', 60),
  async (req, res) => {
    const files = req.files || [];
    const dropFiles = () => files.forEach((f) => fs.unlink(f.path, () => {}));
    try {
      const work = await loadManageableWork(req, res);
      if (!work) return dropFiles();
      const page = req.query.pageId ? await gallery.getPage(work.id, req.query.pageId) : null;
      if (req.query.pageId && !page) {
        dropFiles();
        return res.status(404).json({ error: 'Страница не найдена' });
      }
      if (!files.length) return res.status(400).json({ error: 'Файлы не загружены' });
      const maxFileSizeMb = readSettings().maxFileSize;
      const tooBig = files.find((f) => f.size > maxFileSizeMb * 1024 * 1024);
      if (tooBig) {
        dropFiles();
        return res.status(400).json({ error: `Файл «${tooBig.originalname}» больше ${maxFileSizeMb} МБ — лимит задан в Настройках` });
      }
      res.status(201).json({ variants: await gallery.addImages(work.id, files, page ? page.id : null) });
    } catch (err) {
      dropFiles();
      res.status(400).json({ error: err.message });
    }
  }
);

// ===== Просмотры / лайки =====

router.post('/gallery/works/:id/view', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    await gallery.recordView(req.user.id, work.id);
    res.json({ viewsCount: await gallery.getViewCount(work.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gallery/works/:id/likes', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    res.json(await gallery.getLikeSummary(work.id, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/gallery/works/:id/likes/toggle', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    res.json(await gallery.toggleLike(req.user.id, work.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Реакции — общая таблица reactions (social.db), свои target_type =====

async function resolveReactions(raw) {
  const stickerMeta = await stickers.resolveCodes(raw.map((r) => r.shortcode));
  return raw.map((r) => ({ ...r, ...stickerMeta.get(r.shortcode) })).filter((r) => r.url);
}

async function attachCommentReactions(comments, userId) {
  if (!comments.length) return comments;
  const map = await social.getReactionsForTargets('gallery_comment', comments.map((c) => c.id), userId);
  const stickerMeta = await stickers.resolveCodes([...map.values()].flat().map((r) => r.shortcode));
  return comments.map((c) => {
    const raw = map.get(String(c.id)) || [];
    const reactions = raw.map((r) => ({ ...r, ...stickerMeta.get(r.shortcode) })).filter((r) => r.url);
    return { ...c, reactions, authorAvatar: getAvatarUrl(c.userId) };
  });
}

router.get('/gallery/works/:id/reactions', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    const map = await social.getReactionsForTargets('gallery', [work.id], req.user.id);
    res.json({ reactions: await resolveReactions(map.get(String(work.id)) || []) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/gallery/works/:id/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер вам недоступен — добавьте набор себе во вкладке «Стикеры»' });
    }
    await social.toggleReaction(req.user.id, 'gallery', work.id, shortcode);
    const map = await social.getReactionsForTargets('gallery', [work.id], req.user.id);
    res.json({ reactions: await resolveReactions(map.get(String(work.id)) || []) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Комментарии =====

router.get('/gallery/works/:id/comments', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    const withStickers = await stickers.attachStickersToItems(await gallery.listComments(work.id));
    res.json(await attachCommentReactions(withStickers, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/gallery/works/:id/comments', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    await stickers.validateContentForPosting(req.user.id, req.body.content);
    // Один уровень вложенности — ответ на ответ подшивается к его родителю.
    let parentId = req.body.parentId ? Number(req.body.parentId) : null;
    if (parentId) {
      const parent = await gallery.getComment(parentId);
      if (!parent || parent.workId !== work.id) {
        return res.status(400).json({ error: 'Комментарий, на который вы отвечаете, не найден' });
      }
      if (parent.parentId) parentId = parent.parentId;
    }
    const comment = await gallery.addComment(req.user.id, displayName(req.user), work.id, req.body.content, parentId);
    const [withStickers] = await stickers.attachStickersToItems([comment]);
    const [withReactions] = await attachCommentReactions([withStickers], req.user.id);
    res.status(201).json(withReactions);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/gallery/works/:id/comments/:commentId/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const work = await loadAccessibleWork(req, res);
    if (!work) return;
    const comment = await gallery.getComment(req.params.commentId);
    if (!comment || comment.workId !== work.id) return res.status(404).json({ error: 'Комментарий не найден' });
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер вам недоступен — добавьте набор себе во вкладке «Стикеры»' });
    }
    await social.toggleReaction(req.user.id, 'gallery_comment', comment.id, shortcode);
    const map = await social.getReactionsForTargets('gallery_comment', [comment.id], req.user.id);
    res.json({ reactions: await resolveReactions(map.get(String(comment.id)) || []) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/gallery/works/:id/comments/:commentId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const comment = await gallery.getComment(req.params.commentId);
    if (!comment || String(comment.workId) !== String(req.params.id)) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    if (comment.userId !== req.user.id) {
      const usersMap = await getUsersByIds([comment.userId]);
      const author = usersMap.get(comment.userId);
      const myLevel = req.user.admin_level || 0;
      const allowed = req.user.is_root || (myLevel > 0 && !(author && author.is_root) && ((author && author.role_level) || 0) < myLevel);
      if (!allowed) return res.status(403).json({ error: 'Недостаточно прав для удаления этого комментария' });
    }
    if (!(await gallery.deleteCommentCascade(comment.id))) return res.status(404).json({ error: 'Комментарий не найден' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
