const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');
const auth = require('../middleware/auth');
const { isAdminOnServer } = require('../services/server-permissions');
const articlesStore = require('../services/articles-store');
const publicArticles = require('../services/public-articles');
const { serversSchemaReady } = require('../db/connections');

const router = express.Router();
const POST_TYPES = new Set(['news', 'announcement', 'event']);

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

async function validatePostInput(body, franchiseId) {
  body = body && typeof body === 'object' ? body : {};
  const type = POST_TYPES.has(body.type) ? body.type : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const articleSlug = typeof body.article_slug === 'string' ? body.article_slug.trim() : '';
  const hubId = body.hub_id === '' || body.hub_id == null ? null : Number(body.hub_id);
  const eventAt = typeof body.event_at === 'string' && body.event_at.trim() ? new Date(body.event_at) : null;

  if (!type) throw Object.assign(new Error('Выберите тип публикации'), { status: 400 });
  if (!title || title.length > 160) throw Object.assign(new Error('Заголовок обязателен и должен быть не длиннее 160 символов'), { status: 400 });
  if (!text || text.length > 10000) throw Object.assign(new Error('Текст обязателен и должен быть не длиннее 10 000 символов'), { status: 400 });
  if (body.hub_id != null && body.hub_id !== '' && (!Number.isInteger(hubId) || hubId < 1)) {
    throw Object.assign(new Error('Некорректный хаб'), { status: 400 });
  }
  if (hubId && !(await dbGet('SELECT id FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, franchiseId]))) {
    throw Object.assign(new Error('Хаб не принадлежит этой франшизе'), { status: 400 });
  }
  if (type === 'event' && (!eventAt || Number.isNaN(eventAt.getTime()))) {
    throw Object.assign(new Error('Для события укажите корректные дату и время'), { status: 400 });
  }
  if (type !== 'event' && body.event_at) {
    throw Object.assign(new Error('Дата и время используются только для событий'), { status: 400 });
  }
  if (articleSlug) {
    const record = articlesStore.getArticle(articleSlug);
    if (!record || !publicArticles.getPublicArticle(record)) {
      throw Object.assign(new Error('Указанная статья недоступна для публикации'), { status: 400 });
    }
  }

  return {
    type,
    title,
    body: text,
    hub_id: hubId,
    article_slug: articleSlug || null,
    event_at: type === 'event' ? eventAt.toISOString() : null
  };
}

async function publicPost(row) {
  const articleRecord = row.article_slug ? articlesStore.getArticle(row.article_slug) : null;
  const article = articleRecord && publicArticles.getPublicArticle(articleRecord);
  return {
    id: row.id,
    hub_id: row.hub_id,
    type: row.type,
    title: row.title,
    body: row.body,
    article: article ? { slug: article.slug, title: article.title, excerpt: article.excerpt } : null,
    event_at: row.event_at,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
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
               WHERE p.server_id = s.id AND (p.hub_id IS NULL OR h.is_public = 1)
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
        WHERE p.server_id = ? AND (p.hub_id IS NULL OR h.is_public = 1 OR ? = 1)
        ORDER BY p.created_at DESC, p.id DESC LIMIT 100
      `, [franchiseId, canManage ? 1 : 0]),
      req.user ? isMember(req.user.id, franchiseId) : false
    ]);
    res.json({
      franchise,
      hubs,
      posts: await Promise.all(rows.map(publicPost)),
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
               WHERE p.server_id = s.id
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

router.post('/franchises/:id/feed/read', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const franchiseId = Number(req.params.id);
    if (!Number.isInteger(franchiseId) || franchiseId < 1) return res.status(400).json({ error: 'Некорректная франшиза' });
    if (!(await isMember(req.user.id, franchiseId))) return res.status(403).json({ error: 'Вступите во франшизу, чтобы отмечать публикации прочитанными' });
    await dbRun(`
      INSERT INTO franchise_feed_reads (user_id, server_id, last_seen_at, last_seen_post_id)
      VALUES (?, ?, CURRENT_TIMESTAMP, COALESCE((SELECT MAX(id) FROM franchise_posts WHERE server_id = ?), 0))
      ON CONFLICT(user_id, server_id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP,
        last_seen_post_id = COALESCE((SELECT MAX(id) FROM franchise_posts WHERE server_id = ?), 0)
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
    if (!(await canManageFranchise(req.user, franchiseId))) return res.status(403).json({ error: 'Недостаточно прав для публикации' });
    if (!(await dbGet('SELECT id FROM servers WHERE id = ?', [franchiseId]))) return res.status(404).json({ error: 'Франшиза не найдена' });
    const post = await validatePostInput(req.body, franchiseId);
    const authorName = req.user.display_name || req.user.username || `Пользователь ${req.user.id}`;
    const result = await dbRun(`
      INSERT INTO franchise_posts
        (server_id, hub_id, type, title, body, article_slug, event_at, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [franchiseId, post.hub_id, post.type, post.title, post.body, post.article_slug, post.event_at, req.user.id, authorName]);
    const row = await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [result.lastID]);
    res.status(201).json(await publicPost(row));
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
    if (!(await canManageFranchise(req.user, franchiseId))) return res.status(403).json({ error: 'Недостаточно прав для редактирования' });
    if (!(await dbGet('SELECT id FROM franchise_posts WHERE id = ? AND server_id = ?', [postId, franchiseId]))) {
      return res.status(404).json({ error: 'Публикация не найдена' });
    }
    const post = await validatePostInput(req.body, franchiseId);
    await dbRun(`
      UPDATE franchise_posts
      SET hub_id = ?, type = ?, title = ?, body = ?, article_slug = ?, event_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ?
    `, [post.hub_id, post.type, post.title, post.body, post.article_slug, post.event_at, postId, franchiseId]);
    res.json(await publicPost(await dbGet('SELECT * FROM franchise_posts WHERE id = ?', [postId])));
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
    if (!(await canManageFranchise(req.user, franchiseId))) return res.status(403).json({ error: 'Недостаточно прав для удаления' });
    const result = await dbRun('DELETE FROM franchise_posts WHERE id = ? AND server_id = ?', [postId, franchiseId]);
    if (!result.changes) return res.status(404).json({ error: 'Публикация не найдена' });
    res.json({ deleted: result.changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
