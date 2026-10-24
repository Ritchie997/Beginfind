const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { dbPath, UPLOADS_DIR } = require('../config/paths');
const auth = require('../middleware/auth');
const { isAdminOnServer } = require('../services/server-permissions');
const articlesStore = require('../services/articles-store');
const articleLayers = require('../services/article-layers');
const publicArticles = require('../services/public-articles');
const { serversSchemaReady } = require('../db/connections');
const social = require('../services/social-store');
const stickers = require('../services/stickers-store');
const mentions = require('../services/mentions');
const { getAvatarUrl } = require('../services/avatars');

const router = express.Router();
const POST_TYPES = new Set(['news', 'announcement', 'event']);
const HUB_STATUSES = new Set(['active', 'paused', 'finished']);

router.use((req, res, next) => {
  serversSchemaReady.then(() => next()).catch(() => {
    res.status(500).json({ error: 'Не удалось подготовить базу франшиз' });
  });
});

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath('servers.db'));
    db.get(sql, params, (error, row) => {
      db.close();
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath('servers.db'));
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath('servers.db'));
    db.run(sql, params, function (error) {
      db.close();
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return next();
  // Public franchise details stay readable even when an optional session is
  // expired or awaiting approval; write routes still require current approval.
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

async function canManageFranchise(user, franchiseId) {
  if (!user) return false;
  if (user.is_root) return true;
  const franchise = await dbGet('SELECT owner_id FROM servers WHERE id = ?', [franchiseId]);
  return !!franchise && (Number(franchise.owner_id) === Number(user.id) ||
    await isAdminOnServer(user.id, franchiseId));
}

async function isMember(userId, franchiseId) {
  return !!(await dbGet(
    'SELECT 1 FROM user_server_memberships WHERE user_id = ? AND server_id = ?',
    [userId, franchiseId]
  ));
}

async function validatePostInput(body, franchiseId, user, canManage) {
  body = body && typeof body === 'object' ? body : {};
  const type = POST_TYPES.has(body.type) ? body.type : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const articleSlug = typeof body.article_slug === 'string' ? body.article_slug.trim() : '';
  const imageUrls = Array.isArray(body.image_urls)
    ? body.image_urls.map((url) => typeof url === 'string' ? url.trim() : '')
    : (typeof body.image_url === 'string' && body.image_url.trim() ? [body.image_url.trim()] : []);
  const hubId = body.hub_id === '' || body.hub_id == null ? null : Number(body.hub_id);
  const hubStatus = typeof body.hub_status === 'string' ? body.hub_status : '';

  if (!type) throw Object.assign(new Error('Выберите тип публикации'), { status: 400 });
  if (!title || title.length > 160) throw Object.assign(new Error('Заголовок обязателен и должен быть не длиннее 160 символов'), { status: 400 });
  if (text.length > 10000) throw Object.assign(new Error('Текст не должен быть длиннее 10 000 символов'), { status: 400 });
  if (body.hub_id != null && body.hub_id !== '' && (!Number.isInteger(hubId) || hubId < 1)) {
    throw Object.assign(new Error('Некорректный хаб'), { status: 400 });
  }
  const hub = hubId
    ? await dbGet('SELECT id, name, is_public FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, franchiseId])
    : null;
  if (hubId && !hub) {
    throw Object.assign(new Error('Хаб не принадлежит этой франшизе'), { status: 400 });
  }
  if (hubStatus && (!hub || !HUB_STATUSES.has(hubStatus))) {
    throw Object.assign(new Error('Статус хаба можно выбрать только для выбранного хаба'), { status: 400 });
  }
  if (hub && !hub.is_public && !canManage) {
    throw Object.assign(new Error('Предлагать публикации можно только для хабов, открытых в общем доступе'), { status: 400 });
  }
  for (const imageUrl of imageUrls) {
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(imageUrl)) {
      throw Object.assign(new Error('Изображение должно быть загружено через форму публикации'), { status: 400 });
    }
    const imageName = imageUrl.slice('/uploads/'.length);
    const imagePath = path.join(UPLOADS_DIR, imageName);
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(imageName).toLowerCase()) ||
      !fs.existsSync(imagePath)) {
      throw Object.assign(new Error('Загруженное изображение не найдено'), { status: 400 });
    }
  }
  if (articleSlug) {
    const record = articlesStore.getArticle(articleSlug);
    if (!record || !(await articleLayers.hasArticleAccess(record, user))) {
      throw Object.assign(new Error('Указанная статья недоступна для публикации'), { status: 400 });
    }
  }

  return {
    type,
    title,
    body: text,
    hub_id: hubId,
    article_slug: articleSlug || null,
    image_urls: imageUrls,
    hub_status: hubId ? hubStatus || null : null,
    event_at: null
  };
}

async function publicPost(row, user) {
  const articleRecord = row.article_slug ? articlesStore.getArticle(row.article_slug) : null;
  const publicArticle = articleRecord && publicArticles.getPublicArticle(articleRecord);
  const authorizedArticle = articleRecord && user && !publicArticle &&
    await articleLayers.resolveArticleLayer(articleRecord, user);
  const article = publicArticle || (authorizedArticle
    ? { slug: articleRecord.slug, title: authorizedArticle.layer.title || articleRecord.title || articleRecord.slug }
    : null);
  return {
    id: row.id,
    hub_id: row.hub_id,
    type: row.type,
    title: row.title,
    body: row.body,
    images: parsePostImages(row),
    image_url: row.image_url || null,
    article: article ? {
      slug: article.slug,
      title: article.title,
      is_public: !!publicArticle
    } : null,
    hub_status: row.hub_status || null,
    approval_status: row.approval_status || 'published',
    can_edit: !!user && Number(row.created_by) === Number(user.id) &&
      (row.approval_status || 'published') !== 'published',
    event_at: row.event_at,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getEngageablePost(franchiseId, postId, user) {
  const row = await dbGet(`
    SELECT p.*, s.is_published AS franchise_published, h.is_public AS hub_public
    FROM franchise_posts p
    JOIN servers s ON s.id = p.server_id
    LEFT JOIN franchise_hubs h ON h.id = p.hub_id AND h.server_id = p.server_id
    WHERE p.id = ? AND p.server_id = ?
  `, [postId, franchiseId]);
  if (!row) return null;
  const canManage = await canManageFranchise(user, franchiseId);
  if (canManage) return row;
  if (!row.franchise_published || row.approval_status !== 'published' ||
      (row.hub_id && !row.hub_public)) return null;
  return row;
}

async function attachPostCommentExtras(comments, userId) {
  if (!comments.length) return comments;
  const withStickers = await stickers.attachStickersToItems(comments);
  const reactionsById = await social.getReactionsForTargets(
    'franchise_post_comment',
    comments.map((comment) => comment.id),
    userId
  );
  const codes = [...reactionsById.values()].flat().map((reaction) => reaction.shortcode);
  const stickerMeta = await stickers.resolveCodes(codes);
  const withReactions = withStickers.map((comment) => ({
    ...comment,
    reactions: (reactionsById.get(String(comment.id)) || [])
      .map((reaction) => ({ ...reaction, ...stickerMeta.get(reaction.shortcode) }))
      .filter((reaction) => reaction.url),
    authorAvatar: getAvatarUrl(comment.userId)
  }));
  return mentions.attachMentions(withReactions);
}

async function getPostReactions(postId, userId) {
  const reactionsById = await social.getReactionsForTargets('franchise_post', [postId], userId);
  return resolvePostReactions(reactionsById.get(String(postId)) || []);
}

async function resolvePostReactions(reactions) {
  const stickerMeta = await stickers.resolveCodes(reactions.map((reaction) => reaction.shortcode));
  return reactions
    .map((reaction) => ({ ...reaction, ...stickerMeta.get(reaction.shortcode) }))
    .filter((reaction) => reaction.url);
}

function parsePostImages(row) {
  if (typeof row.image_urls === 'string' && row.image_urls) {
    try {
      const images = JSON.parse(row.image_urls);
      if (Array.isArray(images)) return images.filter((image) => typeof image === 'string');
    } catch (error) {
      console.error(`[franchises] Invalid image list for post ${row.id}:`, error.message);
    }
  }
  return row.image_url ? [row.image_url] : [];
}

router.get('/public/franchises', async (req, res) => {
  try {
    const franchises = await dbAll(`
      SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM user_server_memberships m WHERE m.server_id = s.id) AS member_count,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.is_public = 1) AS hub_count,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'active' AND h.is_public = 1) AS active_hubs,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'paused' AND h.is_public = 1) AS paused_hubs,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'finished' AND h.is_public = 1) AS finished_hubs,
             (SELECT COUNT(*) FROM franchise_posts p
               LEFT JOIN franchise_hubs h ON h.id = p.hub_id
               WHERE p.server_id = s.id AND p.approval_status = 'published'
                 AND (p.hub_id IS NULL OR h.is_public = 1)
             ) AS post_count
      FROM servers s
      WHERE s.is_published = 1
      ORDER BY s.created_at DESC, s.id DESC
    `);
    res.json(franchises);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/public/franchises/:id', optionalAuth, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    if (!Number.isInteger(franchiseId) || franchiseId < 1) return res.status(404).json({ error: 'Франшиза не найдена' });
    const franchise = await dbGet(`
      SELECT s.id, s.name, s.description, s.is_published, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM user_server_memberships m WHERE m.server_id = s.id) AS member_count
      FROM servers s WHERE s.id = ?
    `, [franchiseId]);
    if (!franchise) return res.status(404).json({ error: 'Франшиза не найдена' });
    const canManage = await canManageFranchise(req.user, franchiseId);
    if (!franchise.is_published && !canManage) return res.status(404).json({ error: 'Франшиза не найдена' });

    const [hubs, rows, member] = await Promise.all([
      dbAll(`
        SELECT id, server_id, name, description, status, is_public, created_at, updated_at
        FROM franchise_hubs
        WHERE server_id = ? AND (is_public = 1 OR ? = 1)
        ORDER BY created_at DESC, id DESC
      `, [franchiseId, canManage ? 1 : 0]),
      dbAll(`
        SELECT p.* FROM franchise_posts p
        LEFT JOIN franchise_hubs h ON h.id = p.hub_id AND h.server_id = p.server_id
        WHERE p.server_id = ?
          AND (p.approval_status = 'published' OR ? = 1 OR p.created_by = ?)
          AND (p.hub_id IS NULL OR h.is_public = 1 OR ? = 1)
        ORDER BY p.created_at DESC, p.id DESC LIMIT 100
      `, [franchiseId, canManage ? 1 : 0, req.user ? req.user.id : -1, canManage ? 1 : 0]),
      req.user ? isMember(req.user.id, franchiseId) : false
    ]);
    const postIds = rows.filter((row) => (row.approval_status || 'published') === 'published').map((row) => row.id);
    const [postCounts, postReactionMap] = await Promise.all([
      social.getFranchisePostCounts(postIds, req.user?.id),
      social.getReactionsForTargets('franchise_post', postIds, req.user?.id)
    ]);
    const postReactionMeta = await stickers.resolveCodes([...postReactionMap.values()].flat().map((reaction) => reaction.shortcode));
    const postIdSet = new Set(postIds);
    const resPosts = await Promise.all(rows.map(async (row) => {
      const post = await publicPost(row, req.user);
      const counts = postCounts.get(row.id) || { likes: 0, comments: 0, liked: false };
      const reactions = postIdSet.has(row.id)
        ? (postReactionMap.get(String(row.id)) || []).map((reaction) => ({
          ...reaction,
          ...postReactionMeta.get(reaction.shortcode)
        })).filter((reaction) => reaction.url)
        : [];
      return {
        ...post,
        likes_count: counts.likes,
        comments_count: counts.comments,
        liked: counts.liked,
        reactions
      };
    }));
    res.json({
      franchise,
      hubs,
      posts: resPosts,
      is_member: member,
      can_manage: canManage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/franchises/mine', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchises = await dbAll(`
      SELECT s.id, s.name, s.description, s.is_published,
             (SELECT COUNT(*) FROM user_server_memberships members WHERE members.server_id = s.id) AS member_count,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.is_public = 1) AS hub_count,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'active' AND h.is_public = 1) AS active_hubs,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'paused' AND h.is_public = 1) AS paused_hubs,
             (SELECT COUNT(*) FROM franchise_hubs h WHERE h.server_id = s.id AND h.status = 'finished' AND h.is_public = 1) AS finished_hubs,
             (SELECT COUNT(*) FROM franchise_posts p
               LEFT JOIN franchise_hubs h ON h.id = p.hub_id
               WHERE p.server_id = s.id AND p.approval_status = 'published'
                 AND (p.hub_id IS NULL OR h.is_public = 1)
                 AND p.id > COALESCE(
                   (SELECT r.last_seen_post_id FROM franchise_feed_reads r
                    WHERE r.server_id = s.id AND r.user_id = ?), 0
                 )
             ) AS unread_count
      FROM user_server_memberships m
      JOIN servers s ON s.id = m.server_id
      WHERE m.user_id = ? AND (s.is_published = 1 OR s.owner_id = ?)
      ORDER BY s.name COLLATE NOCASE
    `, [req.user.id, req.user.id, req.user.id]);
    res.json(franchises);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/franchises/:id/posts/:postId/likes', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    res.json(await social.getFranchisePostLikeSummary(post.id, req.user.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/likes/toggle', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    res.json(await social.toggleFranchisePostLike(req.user.id, post.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/franchises/:id/posts/:postId/comments', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    const comments = await social.listFranchisePostComments(post.id);
    res.json(await attachPostCommentExtras(comments, req.user.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/comments', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    try {
      await stickers.validateContentForPosting(req.user.id, req.body.content);
    } catch (error) {
      error.status = 400;
      throw error;
    }
    if (!String(req.body.content || '').trim()) {
      return res.status(400).json({ error: 'Комментарий не может быть пустым' });
    }
    let parentId = req.body.parentId ? Number(req.body.parentId) : null;
    if (parentId) {
      const parent = await social.getFranchisePostComment(parentId);
      if (!parent || Number(parent.postId) !== Number(post.id)) {
        return res.status(400).json({ error: 'Комментарий, на который вы отвечаете, не найден' });
      }
      if (parent.parentId) parentId = parent.parentId;
    }
    const comment = await social.addFranchisePostComment(
      req.user.id,
      req.user.display_name || req.user.username || `Пользователь ${req.user.id}`,
      post.id,
      req.body.content,
      parentId
    );
    const [result] = await attachPostCommentExtras([comment], req.user.id);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/franchises/:id/posts/:postId/comments/:commentId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    const comment = await social.getFranchisePostComment(Number(req.params.commentId));
    if (!comment || Number(comment.postId) !== Number(post.id)) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    if (Number(comment.userId) !== Number(req.user.id) &&
        !(await canManageFranchise(req.user, Number(req.params.id)))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления комментария' });
    }
    await social.deleteFranchisePostCommentCascade(comment.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/franchises/:id/posts/:postId/reactions', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    res.json({ reactions: await getPostReactions(post.id, req.user.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер недоступен — набор не найден или ещё не подтверждён модератором' });
    }
    await social.toggleReaction(req.user.id, 'franchise_post', post.id, shortcode);
    res.json({ reactions: await getPostReactions(post.id, req.user.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/comments/:commentId/reactions/toggle', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const post = await getEngageablePost(Number(req.params.id), Number(req.params.postId), req.user);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    const comment = await social.getFranchisePostComment(Number(req.params.commentId));
    if (!comment || Number(comment.postId) !== Number(post.id)) {
      return res.status(404).json({ error: 'Комментарий не найден' });
    }
    const shortcode = String(req.body.shortcode || '');
    if (!(await stickers.canUseShortcode(req.user.id, shortcode))) {
      return res.status(400).json({ error: 'Этот стикер недоступен — набор не найден или ещё не подтверждён модератором' });
    }
    await social.toggleReaction(req.user.id, 'franchise_post_comment', comment.id, shortcode);
    const [withReactions] = await attachPostCommentExtras([comment], req.user.id);
    res.json({ reactions: withReactions.reactions || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/feed/read', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    if (!Number.isInteger(franchiseId) || franchiseId < 1) return res.status(400).json({ error: 'Некорректная франшиза' });
    if (!(await isMember(req.user.id, franchiseId))) return res.status(403).json({ error: 'Вступите во франшизу, чтобы отмечать публикации прочитанными' });
    await dbRun(`
      INSERT INTO franchise_feed_reads (user_id, server_id, last_seen_at, last_seen_post_id)
      VALUES (?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT MAX(id) FROM franchise_posts WHERE server_id = ? AND approval_status = 'published'), 0))
      ON CONFLICT(user_id, server_id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP,
        last_seen_post_id = COALESCE((SELECT MAX(id) FROM franchise_posts WHERE server_id = ? AND approval_status = 'published'), 0)
    `, [req.user.id, franchiseId, franchiseId, franchiseId]);
    res.json({ unread_count: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    if (!Number.isInteger(franchiseId) || franchiseId < 1) return res.status(400).json({ error: 'Некорректная франшиза' });
    const franchise = await dbGet('SELECT id FROM servers WHERE id = ?', [franchiseId]);
    if (!franchise) return res.status(404).json({ error: 'Франшиза не найдена' });
    const canManage = await canManageFranchise(req.user, franchiseId);
    const post = await validatePostInput(req.body, franchiseId, req.user, canManage);
    const authorName = req.user.display_name || req.user.username || `Пользователь ${req.user.id}`;
    const result = await dbRun(`
      INSERT INTO franchise_posts
        (server_id, hub_id, type, title, body, article_slug, event_at, image_url, image_urls, hub_status, approval_status, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      franchiseId, post.hub_id, post.type, post.title, post.body, post.article_slug,
      post.event_at, post.image_urls[0] || null, JSON.stringify(post.image_urls),
      post.hub_status, canManage ? 'published' : 'pending', req.user.id, authorName
    ]);
    const row = await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [result.lastID]);
    res.status(201).json(await publicPost(row, req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/franchises/:id/posts/:postId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    const postId = Number(req.params.postId);
    if (!Number.isInteger(franchiseId) || franchiseId < 1 || !Number.isInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Некорректный идентификатор' });
    }
    const canManage = await canManageFranchise(req.user, franchiseId);
    const existing = await dbGet('SELECT * FROM franchise_posts WHERE id = ? AND server_id = ?', [postId, franchiseId]);
    if (!existing) {
      return res.status(404).json({ error: 'Публикация не найдена' });
    }
    const canEditSuggestion = Number(existing.created_by) === Number(req.user.id) &&
      existing.approval_status !== 'published';
    if (!canManage && !canEditSuggestion) return res.status(403).json({ error: 'Недостаточно прав для редактирования' });
    const post = await validatePostInput(req.body, franchiseId, req.user, canManage);
    await dbRun(`
      UPDATE franchise_posts
      SET hub_id = ?, type = ?, title = ?, body = ?, article_slug = ?, event_at = ?,
          image_url = ?, image_urls = ?, hub_status = ?,
          approval_status = CASE WHEN created_by = ? AND approval_status != 'published' THEN 'pending' ELSE approval_status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ?
    `, [
      post.hub_id, post.type, post.title, post.body, post.article_slug, post.event_at,
      post.image_urls[0] || null, JSON.stringify(post.image_urls), post.hub_status, req.user.id, postId, franchiseId
    ]);
    res.json(await publicPost(await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [postId]), req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/franchises/:id/posts/:postId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    const postId = Number(req.params.postId);
    if (!Number.isInteger(franchiseId) || franchiseId < 1 || !Number.isInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Некорректный идентификатор' });
    }
    const canManage = await canManageFranchise(req.user, franchiseId);
    const post = await dbGet('SELECT created_by, approval_status FROM franchise_posts WHERE id = ? AND server_id = ?', [postId, franchiseId]);
    if (!post) return res.status(404).json({ error: 'Публикация не найдена' });
    if (!canManage && !(Number(post.created_by) === Number(req.user.id) && post.approval_status !== 'published')) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления' });
    }
    const result = await dbRun('DELETE FROM franchise_posts WHERE id = ? AND server_id = ?', [postId, franchiseId]);
    res.json({ deleted: result.changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/approve', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    const postId = Number(req.params.postId);
    if (!Number.isInteger(franchiseId) || franchiseId < 1 || !Number.isInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Некорректный идентификатор' });
    }
    if (!(await canManageFranchise(req.user, franchiseId))) return res.status(403).json({ error: 'Подтверждать публикации может только создатель франшизы или администратор' });
    const result = await dbRun(`
      UPDATE franchise_posts SET approval_status = 'published', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ? AND approval_status = 'pending'
    `, [postId, franchiseId]);
    if (!result.changes) return res.status(404).json({ error: 'Предложение не найдено или уже обработано' });
    res.json(await publicPost(await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [postId]), req.user));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/franchises/:id/posts/:postId/reject', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    const postId = Number(req.params.postId);
    if (!Number.isInteger(franchiseId) || franchiseId < 1 || !Number.isInteger(postId) || postId < 1) {
      return res.status(400).json({ error: 'Некорректный идентификатор' });
    }
    if (!(await canManageFranchise(req.user, franchiseId))) return res.status(403).json({ error: 'Отклонять публикации может только создатель франшизы или администратор' });
    const result = await dbRun(`
      UPDATE franchise_posts SET approval_status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ? AND approval_status = 'pending'
    `, [postId, franchiseId]);
    if (!result.changes) return res.status(404).json({ error: 'Предложение не найдено или уже обработано' });
    res.json(await publicPost(await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [postId]), req.user));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
