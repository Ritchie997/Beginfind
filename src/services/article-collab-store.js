// article-collab-store.js — хранилище заявок на соавторство и обновление статей.
// Когда пользователь редактирует чужую статью и ставит галочку "Добавить себя как соавтора",
// статья не обновляется напрямую, а отправляется автору на подтверждение.

const { articlesDb } = require('../db/connections');
const articlesStore = require('./articles-store');
const userNotifications = require('./user-notifications');

let schemaReadyPromise = null;

function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = new Promise((resolve, reject) => {
      articlesDb.serialize(() => {
        articlesDb.run(`CREATE TABLE IF NOT EXISTS article_collab_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_slug TEXT NOT NULL,
          article_title TEXT NOT NULL,
          author_id INTEGER NOT NULL,
          proposer_id INTEGER NOT NULL,
          proposer_name TEXT NOT NULL,
          proposed_data TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          comment TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME,
          resolved_by INTEGER
        )`, (err) => {
          if (err) return reject(err);
          articlesDb.run('CREATE INDEX IF NOT EXISTS idx_acr_article_slug ON article_collab_requests(article_slug)', () => {});
          articlesDb.run('CREATE INDEX IF NOT EXISTS idx_acr_author_status ON article_collab_requests(author_id, status)', () => {});
          articlesDb.run('CREATE INDEX IF NOT EXISTS idx_acr_proposer ON article_collab_requests(proposer_id)', () => {});
          resolve();
        });
      });
    });
  }
  return schemaReadyPromise;
}

async function run(sql, params = []) {
  await ensureSchema();
  return new Promise((resolve, reject) => {
    articlesDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function get(sql, params = []) {
  await ensureSchema();
  return new Promise((resolve, reject) => {
    articlesDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

async function all(sql, params = []) {
  await ensureSchema();
  return new Promise((resolve, reject) => {
    articlesDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function formatRow(row) {
  if (!row) return null;
  let proposedData = null;
  try {
    proposedData = typeof row.proposed_data === 'string' ? JSON.parse(row.proposed_data) : row.proposed_data;
  } catch (e) {
    proposedData = {};
  }
  return {
    id: row.id,
    article_slug: row.article_slug,
    article_title: row.article_title,
    author_id: row.author_id,
    proposer_id: row.proposer_id,
    proposer_name: row.proposer_name,
    proposed_data: proposedData,
    status: row.status,
    comment: row.comment,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by
  };
}

/**
 * Создаёт или обновляет существующую ожидающую заявку от этого пользователя на эту статью.
 */
async function createOrUpdateRequest({
  articleSlug,
  articleTitle,
  authorId,
  proposerId,
  proposerName,
  proposedData,
  comment = null
}) {
  const dataJson = JSON.stringify(proposedData || {});

  // Проверяем, есть ли уже ожидающая заявка от этого автора на эту статью
  const existing = await get(
    'SELECT * FROM article_collab_requests WHERE article_slug = ? AND proposer_id = ? AND status = ? LIMIT 1',
    [articleSlug, proposerId, 'pending']
  );

  if (existing) {
    await run(
      `UPDATE article_collab_requests
       SET article_title = ?, proposed_data = ?, comment = ?, created_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [articleTitle, dataJson, comment, existing.id]
    );
    return getRequestById(existing.id);
  }

  const result = await run(
    `INSERT INTO article_collab_requests
     (article_slug, article_title, author_id, proposer_id, proposer_name, proposed_data, status, comment)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [articleSlug, articleTitle, authorId, proposerId, proposerName, dataJson, comment]
  );

  return getRequestById(result.lastID);
}

async function getRequestById(id) {
  const row = await get('SELECT * FROM article_collab_requests WHERE id = ?', [id]);
  return formatRow(row);
}

/**
 * Возвращает список ожидающих заявок для статьи (для автора статьи).
 */
async function listPendingForArticle(articleSlug) {
  const rows = await all(
    'SELECT * FROM article_collab_requests WHERE article_slug = ? AND status = ? ORDER BY id DESC',
    [articleSlug, 'pending']
  );
  return rows.map(formatRow);
}

/**
 * Возвращает ожидающие заявки, где пользователь является автором статьи (ему адресованы).
 */
async function listPendingForAuthor(authorId) {
  const rows = await all(
    'SELECT * FROM article_collab_requests WHERE author_id = ? AND status = ? ORDER BY id DESC',
    [authorId, 'pending']
  );
  return rows.map(formatRow);
}

/**
 * Одобрение заявки автором статьи или root.
 * Применяет изменения в статье и добавляет proposer_id в соавторы.
 */
async function approveRequest(requestId, reviewerUser) {
  const request = await getRequestById(requestId);
  if (!request) throw new Error('Заявка не найдена');
  if (request.status !== 'pending') throw new Error('Заявка уже рассмотрена');

  const existingArticle = articlesStore.getArticle(request.article_slug);
  if (!existingArticle) throw new Error('Статья не найдена');

  const isAuthor = existingArticle.author_id && Number(existingArticle.author_id) === Number(reviewerUser.id);
  const isRoot = !!reviewerUser.is_root;
  if (!isAuthor && !isRoot) {
    throw new Error('Только автор статьи может подтвердить заявку');
  }

  // Обновляем список соавторов: добавляем заявителя
  const coAuthors = Array.isArray(existingArticle.co_author_ids) ? [...existingArticle.co_author_ids] : [];
  if (!coAuthors.includes(request.proposer_id) && request.proposer_id !== existingArticle.author_id) {
    coAuthors.push(request.proposer_id);
  }

  const pData = request.proposed_data || {};
  const updatePayload = {
    ...pData,
    co_author_ids: coAuthors
  };

  // Обновляем саму статью
  const updatedArticle = articlesStore.updateArticle(request.article_slug, updatePayload);

  // Помечаем заявку как одобренную
  await run(
    `UPDATE article_collab_requests
     SET status = 'approved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
     WHERE id = ?`,
    [reviewerUser.id, requestId]
  );

  // Отправляем уведомление заявителю
  try {
    await userNotifications.create(request.proposer_id, {
      type: 'collab_approved',
      actorId: reviewerUser.id,
      actorName: reviewerUser.display_name || reviewerUser.username,
      targetType: 'article',
      targetId: request.article_slug,
      targetTitle: existingArticle.title || request.article_slug,
      excerpt: 'Одобрил ваше обновление статьи и добавил вас в соавторы'
    });
  } catch (err) {
    console.error('Ошибка отправки уведомления об одобрении соавторства:', err);
  }

  return { request: await getRequestById(requestId), article: updatedArticle };
}

/**
 * Отклонение заявки автором статьи или root.
 */
async function declineRequest(requestId, reviewerUser, comment = null) {
  const request = await getRequestById(requestId);
  if (!request) throw new Error('Заявка не найдена');
  if (request.status !== 'pending') throw new Error('Заявка уже рассмотрена');

  const existingArticle = articlesStore.getArticle(request.article_slug);
  const isAuthor = existingArticle && existingArticle.author_id && Number(existingArticle.author_id) === Number(reviewerUser.id);
  const isRoot = !!reviewerUser.is_root;
  if (!isAuthor && !isRoot) {
    throw new Error('Только автор статьи может отклонить заявку');
  }

  await run(
    `UPDATE article_collab_requests
     SET status = 'declined', comment = COALESCE(?, comment), resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
     WHERE id = ?`,
    [comment, reviewerUser.id, requestId]
  );

  // Отправляем уведомление заявителю
  try {
    await userNotifications.create(request.proposer_id, {
      type: 'collab_declined',
      actorId: reviewerUser.id,
      actorName: reviewerUser.display_name || reviewerUser.username,
      targetType: 'article',
      targetId: request.article_slug,
      targetTitle: (existingArticle && existingArticle.title) || request.article_slug,
      excerpt: comment || 'Отклонил предложенные правки статьи'
    });
  } catch (err) {
    console.error('Ошибка отправки уведомления об отклонении соавторства:', err);
  }

  return getRequestById(requestId);
}

module.exports = {
  createOrUpdateRequest,
  getRequestById,
  listPendingForArticle,
  listPendingForAuthor,
  approveRequest,
  declineRequest
};
