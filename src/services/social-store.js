// social-store.js — лайки, комментарии и реакции для Antropedia и AllTell
// (см. таблицы article_* и franchise_post_* в src/db/connections.js).

const { socialDb } = require('../db/connections');

const COMMENT_MAX_LEN = 2000;

function rowToComment(row) {
  return {
    id: row.id,
    slug: row.article_slug,
    userId: row.user_id,
    authorName: row.author_name,
    content: row.content,
    parentId: row.parent_id || null,
    createdAt: row.created_at
  };
}

/**
 * Число лайков статьи + лайкнул ли её сам userId — одним запросом, чтобы
 * панель "лайк" в просмотре статьи не делала два похода на сервер.
 */
function getLikeSummary(slug, userId) {
  return new Promise((resolve, reject) => {
    socialDb.get(
      `SELECT COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as liked
       FROM article_likes WHERE article_slug = ?`,
      [userId, slug],
      (err, row) => {
        if (err) { reject(err); return; }
        resolve({ count: (row && row.count) || 0, liked: !!(row && row.liked) });
      }
    );
  });
}

/**
 * Ставит лайк, если его ещё нет, снимает — если уже стоит. Возвращает
 * свежий getLikeSummary, чтобы клиент сразу обновил счётчик и подсветку
 * кнопки без отдельного запроса.
 */
function toggleLike(userId, slug) {
  return new Promise((resolve, reject) => {
    socialDb.get('SELECT id FROM article_likes WHERE user_id = ? AND article_slug = ?', [userId, slug], (err, row) => {
      if (err) { reject(err); return; }

      const after = (err2) => {
        if (err2) { reject(err2); return; }
        getLikeSummary(slug, userId).then(resolve, reject);
      };

      if (row) {
        socialDb.run('DELETE FROM article_likes WHERE id = ?', [row.id], after);
      } else {
        socialDb.run('INSERT INTO article_likes (user_id, article_slug) VALUES (?, ?)', [userId, slug], after);
      }
    });
  });
}

/**
 * Комментарии статьи, старые сверху (обычный порядок чтения ленты
 * комментариев — новые дописываются в конец, а не подсовываются наверх).
 */
function listComments(slug) {
  return new Promise((resolve, reject) => {
    socialDb.all(
      'SELECT * FROM article_comments WHERE article_slug = ? ORDER BY created_at ASC',
      [slug],
      (err, rows) => {
        if (err) { reject(err); return; }
        resolve((rows || []).map(rowToComment));
      }
    );
  });
}

// parentId — id комментария, на который отвечают (один уровень вложенности,
// см. комментарий у article_comments в src/db/connections.js); "уплощение"
// ответа на ответ до общего родителя делает вызывающий код в
// articles.routes.js, сюда parentId приходит уже финальным.
function addComment(userId, authorName, slug, content, parentId) {
  const trimmed = String(content || '').trim().slice(0, COMMENT_MAX_LEN);
  if (!trimmed) return Promise.reject(new Error('Комментарий не может быть пустым'));

  return new Promise((resolve, reject) => {
    socialDb.run(
      'INSERT INTO article_comments (user_id, author_name, article_slug, content, parent_id) VALUES (?, ?, ?, ?, ?)',
      [userId, authorName, slug, trimmed, parentId || null],
      function (err) {
        if (err) { reject(err); return; }
        socialDb.get('SELECT * FROM article_comments WHERE id = ?', [this.lastID], (err2, row) => {
          if (err2 || !row) { reject(err2 || new Error('Не удалось добавить комментарий')); return; }
          resolve(rowToComment(row));
        });
      }
    );
  });
}

function getComment(id) {
  return new Promise((resolve, reject) => {
    socialDb.get('SELECT * FROM article_comments WHERE id = ?', [id], (err, row) => {
      if (err) { reject(err); return; }
      resolve(row ? rowToComment(row) : null);
    });
  });
}

function deleteComment(id) {
  return new Promise((resolve, reject) => {
    socialDb.run('DELETE FROM article_comments WHERE id = ?', [id], function (err) {
      if (err) { reject(err); return; }
      resolve(this.changes > 0);
    });
  });
}

// Удаляет комментарий ВМЕСТЕ с его ответами (см. "Ответить" в
// public/antropedia.js) — иначе после удаления родителя ответы остались бы
// висеть без него (parent_id указывал бы в никуда). Реакции на удалённые
// строки (таблица reactions) намеренно не чистим — они просто больше никогда
// не запрашиваются (см. attachCommentReactions в articles.routes.js), а FK
// на них не завязан.
function deleteCommentCascade(id) {
  return new Promise((resolve, reject) => {
    socialDb.run('DELETE FROM article_comments WHERE id = ? OR parent_id = ?', [id, id], function (err) {
      if (err) { reject(err); return; }
      resolve(this.changes > 0);
    });
  });
}

/**
 * Число лайков + число комментариев (+ лайкнул ли сам userId) сразу для
 * ЦЕЛОЙ СТРАНИЦЫ статей — витрина Antropedia (см. GET /api/articles/browse)
 * показывает те же счётчики на карточках, что и панель под открытой
 * статьёй, и не может позволить себе по два похода в БД на каждую из
 * (обычно 24) карточек странице — два запроса с WHERE ... IN (...) вместо
 * этого. Возвращает Map<slug, {likes, comments, liked}>; для slug без
 * единого лайка/комментария явной записи в Map не будет — вызывающий код
 * сам подставляет нули (см. formatArticleResponse в articles.routes.js).
 */
function getCountsForSlugs(userId, slugs) {
  const uniqueSlugs = [...new Set(slugs || [])];
  if (!uniqueSlugs.length) return Promise.resolve(new Map());

  const placeholders = uniqueSlugs.map(() => '?').join(',');
  const result = new Map();
  const ensure = (slug) => {
    if (!result.has(slug)) result.set(slug, { likes: 0, comments: 0, liked: false, views: 0 });
    return result.get(slug);
  };
  uniqueSlugs.forEach(ensure);

  return new Promise((resolve, reject) => {
    socialDb.all(
      `SELECT article_slug, COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as liked
       FROM article_likes WHERE article_slug IN (${placeholders}) GROUP BY article_slug`,
      [userId, ...uniqueSlugs],
      (err, likeRows) => {
        if (err) { reject(err); return; }
        (likeRows || []).forEach((row) => {
          const entry = ensure(row.article_slug);
          entry.likes = row.count;
          entry.liked = !!row.liked;
        });

        socialDb.all(
          `SELECT article_slug, COUNT(*) as count
           FROM article_comments WHERE article_slug IN (${placeholders}) GROUP BY article_slug`,
          uniqueSlugs,
          (err2, commentRows) => {
            if (err2) { reject(err2); return; }
            (commentRows || []).forEach((row) => {
              ensure(row.article_slug).comments = row.count;
            });

            socialDb.all(
              `SELECT article_slug, COUNT(*) as count
               FROM article_views WHERE article_slug IN (${placeholders}) GROUP BY article_slug`,
              uniqueSlugs,
              (err3, viewRows) => {
                if (err3) { reject(err3); return; }
                (viewRows || []).forEach((row) => {
                  ensure(row.article_slug).views = row.count;
                });
                resolve(result);
              }
            );
          }
        );
      }
    );
  });
}

// ========================================
// Просмотры — один на пользователя на статью (см. article_views в
// src/db/connections.js). Вызывается ЯВНО из отдельного эндпоинта (см. POST
// .../articles/:id/view в articles.routes.js), а не при каждом GET статьи —
// иначе открытие той же статьи в редакторе тоже накручивало бы счётчик.
// ========================================

function recordView(userId, slug) {
  return new Promise((resolve, reject) => {
    socialDb.run(
      'INSERT OR IGNORE INTO article_views (user_id, article_slug) VALUES (?, ?)',
      [userId, slug],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// Просмотры всех статей разом (slug -> число) — для сортировки витрины
// "по просмотрам" (см. GET /articles/browse). Статей без просмотров в Map нет.
function getAllViewCounts() {
  return new Promise((resolve, reject) => {
    socialDb.all('SELECT article_slug, COUNT(*) as count FROM article_views GROUP BY article_slug', [], (err, rows) => {
      if (err) { reject(err); return; }
      resolve(new Map((rows || []).map((r) => [r.article_slug, r.count])));
    });
  });
}

function getViewCount(slug) {
  return new Promise((resolve, reject) => {
    socialDb.get('SELECT COUNT(*) as count FROM article_views WHERE article_slug = ?', [slug], (err, row) => {
      if (err) { reject(err); return; }
      resolve((row && row.count) || 0);
    });
  });
}

function rowToFranchisePostComment(row) {
  return {
    id: row.id,
    postId: row.post_id,
    userId: row.user_id,
    authorName: row.author_name,
    content: row.content,
    parentId: row.parent_id || null,
    createdAt: row.created_at
  };
}

function getFranchisePostCounts(postIds, userId) {
  const ids = [...new Set((postIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return Promise.resolve(new Map());
  const placeholders = ids.map(() => '?').join(',');
  const result = new Map(ids.map((id) => [id, { likes: 0, comments: 0, liked: false }]));
  return new Promise((resolve, reject) => {
    socialDb.all(
      `SELECT post_id, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS liked
       FROM franchise_post_likes WHERE post_id IN (${placeholders}) GROUP BY post_id`,
      [userId || 0, ...ids],
      (err, likes) => {
        if (err) return reject(err);
        (likes || []).forEach((row) => {
          const entry = result.get(row.post_id);
          if (entry) Object.assign(entry, { likes: row.count, liked: !!row.liked });
        });
        socialDb.all(
          `SELECT post_id, COUNT(*) AS count FROM franchise_post_comments
           WHERE post_id IN (${placeholders}) GROUP BY post_id`,
          ids,
          (commentErr, comments) => {
            if (commentErr) return reject(commentErr);
            (comments || []).forEach((row) => {
              const entry = result.get(row.post_id);
              if (entry) entry.comments = row.count;
            });
            resolve(result);
          }
        );
      }
    );
  });
}

function getFranchisePostLikeSummary(postId, userId) {
  return new Promise((resolve, reject) => {
    socialDb.get(
      `SELECT COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS liked
       FROM franchise_post_likes WHERE post_id = ?`,
      [userId, postId],
      (err, row) => err ? reject(err) : resolve({ count: row?.count || 0, liked: !!row?.liked })
    );
  });
}

function toggleFranchisePostLike(userId, postId) {
  return new Promise((resolve, reject) => {
    socialDb.get(
      'SELECT id FROM franchise_post_likes WHERE user_id = ? AND post_id = ?',
      [userId, postId],
      (err, row) => {
        if (err) return reject(err);
        const callback = (runErr) => {
          if (runErr) return reject(runErr);
          getFranchisePostLikeSummary(postId, userId).then(resolve, reject);
        };
        if (row) socialDb.run('DELETE FROM franchise_post_likes WHERE id = ?', [row.id], callback);
        else socialDb.run('INSERT INTO franchise_post_likes (user_id, post_id) VALUES (?, ?)', [userId, postId], callback);
      }
    );
  });
}

function listFranchisePostComments(postId) {
  return new Promise((resolve, reject) => {
    socialDb.all(
      'SELECT * FROM franchise_post_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC',
      [postId],
      (err, rows) => err ? reject(err) : resolve((rows || []).map(rowToFranchisePostComment))
    );
  });
}

function addFranchisePostComment(userId, authorName, postId, content, parentId) {
  const trimmed = String(content || '').trim().slice(0, COMMENT_MAX_LEN);
  if (!trimmed) return Promise.reject(new Error('Комментарий не может быть пустым'));
  return new Promise((resolve, reject) => {
    socialDb.run(
      `INSERT INTO franchise_post_comments (user_id, author_name, post_id, content, parent_id)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, authorName, postId, trimmed, parentId || null],
      function (err) {
        if (err) return reject(err);
        socialDb.get('SELECT * FROM franchise_post_comments WHERE id = ?', [this.lastID], (getErr, row) => {
          if (getErr || !row) return reject(getErr || new Error('Не удалось добавить комментарий'));
          resolve(rowToFranchisePostComment(row));
        });
      }
    );
  });
}

function getFranchisePostComment(id) {
  return new Promise((resolve, reject) => {
    socialDb.get('SELECT * FROM franchise_post_comments WHERE id = ?', [id], (err, row) => {
      if (err) return reject(err);
      resolve(row ? rowToFranchisePostComment(row) : null);
    });
  });
}

function deleteFranchisePostCommentCascade(id) {
  return new Promise((resolve, reject) => {
    socialDb.run(
      'DELETE FROM franchise_post_comments WHERE id = ? OR parent_id = ?',
      [id, id],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

// ========================================
// Реакции (эмодзи/стикером) на статью или комментарий — см. таблицу
// reactions в src/db/connections.js. targetType is 'article', 'comment',
// 'franchise_post' or 'franchise_post_comment'; targetId is stored as TEXT.
// Валидация "стикер принадлежит добавленному одобренному набору" — на
// вызывающей стороне (см. stickers.canUseShortcode в articles.routes.js),
// этот модуль ничего не знает о наборах стикеров.
// ========================================

/**
 * Ставит реакцию, если её ещё нет от этого пользователя этим же шорткодом,
 * снимает — если уже стоит (в отличие от лайка, разные шорткоды от одного
 * пользователя на одну цель сосуществуют — это не взаимоисключающий выбор).
 */
function toggleReaction(userId, targetType, targetId, shortcode) {
  return new Promise((resolve, reject) => {
    socialDb.get(
      'SELECT id FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND shortcode = ?',
      [userId, targetType, String(targetId), shortcode],
      (err, row) => {
        if (err) { reject(err); return; }
        const after = (err2) => (err2 ? reject(err2) : resolve());
        if (row) socialDb.run('DELETE FROM reactions WHERE id = ?', [row.id], after);
        else socialDb.run(
          'INSERT INTO reactions (user_id, target_type, target_id, shortcode) VALUES (?, ?, ?, ?)',
          [userId, targetType, String(targetId), shortcode],
          after
        );
      }
    );
  });
}

/**
 * Реакции сразу для НЕСКОЛЬКИХ целей одного типа (все комментарии статьи
 * одним запросом — та же экономия похода в БД, что и getCountsForSlugs
 * выше) — Map<targetId, [{shortcode, count, reacted}, ...]>, отсортировано
 * по убыванию count. Метаданные стикера (картинка) сюда не входят — это
 * достраивает stickers.resolveCodes на вызывающей стороне, этот модуль не
 * знает о наборах стикеров.
 */
function getReactionsForTargets(targetType, targetIds, userId) {
  const uniqueIds = [...new Set((targetIds || []).map(String))];
  if (!uniqueIds.length) return Promise.resolve(new Map());

  const placeholders = uniqueIds.map(() => '?').join(',');
  return new Promise((resolve, reject) => {
    socialDb.all(
      `SELECT target_id, shortcode, COUNT(*) as count,
              MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as reacted
       FROM reactions
       WHERE target_type = ? AND target_id IN (${placeholders})
       GROUP BY target_id, shortcode
       ORDER BY count DESC`,
      [userId, targetType, ...uniqueIds],
      (err, rows) => {
        if (err) { reject(err); return; }
        const map = new Map();
        (rows || []).forEach((row) => {
          if (!map.has(row.target_id)) map.set(row.target_id, []);
          map.get(row.target_id).push({ shortcode: row.shortcode, count: row.count, reacted: !!row.reacted });
        });
        resolve(map);
      }
    );
  });
}

module.exports = {
  getLikeSummary,
  toggleLike,
  listComments,
  addComment,
  getComment,
  deleteComment,
  deleteCommentCascade,
  getCountsForSlugs,
  recordView,
  getViewCount,
  getAllViewCounts,
  getFranchisePostCounts,
  getFranchisePostLikeSummary,
  toggleFranchisePostLike,
  listFranchisePostComments,
  addFranchisePostComment,
  getFranchisePostComment,
  deleteFranchisePostCommentCascade,
  toggleReaction,
  getReactionsForTargets
};
