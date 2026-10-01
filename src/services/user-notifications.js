// user-notifications.js — личные уведомления пользователя: ответ на его
// комментарий и упоминание @пользователь (в комментариях статей Ibripedia и
// работ галереи). Таблица user_notifications в social.db.
//
// Появляются в колокольчике в шапке (GET /api/notifications) и ОДИН раз
// всплывающим уведомлением (см. takeUnnotified и /api/notifications/summary).

const { socialDb } = require('../db/connections');
const auth = require('../middleware/auth');
const mentions = require('./mentions');

const EXCERPT_LEN = 140;
const KEEP_PER_USER = 200;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    socialDb.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    socialDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function rowToNotification(row) {
  return {
    id: row.id,
    type: row.type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    targetType: row.target_type,
    targetId: row.target_id,
    targetTitle: row.target_title,
    commentId: row.comment_id,
    excerpt: row.excerpt,
    createdAt: row.created_at,
    read: !!row.read_at
  };
}

// "@[Имя Фамилия]" -> "@Имя Фамилия", лишние пробелы — в один, обрезка.
function makeExcerpt(content) {
  const text = String(content || '').replace(/@\[([^\]\n]+)\]/g, '@$1').replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_LEN ? text.slice(0, EXCERPT_LEN - 1) + '…' : text;
}

async function create(userId, data) {
  await run(
    `INSERT INTO user_notifications (user_id, type, actor_id, actor_name, target_type, target_id, target_title, comment_id, excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, data.type, data.actorId, data.actorName, data.targetType, String(data.targetId), data.targetTitle || null, data.commentId || null, data.excerpt || null]
  );
  // Храним только последние KEEP_PER_USER — старее никто не листает.
  await run(
    `DELETE FROM user_notifications WHERE user_id = ? AND id NOT IN
       (SELECT id FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
    [userId, userId, KEEP_PER_USER]
  );
}

/**
 * Уведомления о новом комментарии: автору ветки, на которую ответили
 * (parentAuthorId), и всем упомянутым через @. Себе — никогда; одному
 * человеку — одно уведомление (ответ важнее упоминания). Получатель должен
 * иметь доступ к статье/работе (canAccess(user)) — иначе через уведомление
 * утёк бы текст из закрытого места. Ошибки не мешают самому комментарию.
 * @param {object} p
 * @param {object} p.actor — req.user автора комментария
 * @param {object} p.comment — {id, content}
 * @param {number|null} p.parentAuthorId
 * @param {'article'|'gallery'} p.targetType
 * @param {string|number} p.targetId — slug статьи / id работы
 * @param {(user:object)=>Promise<string|null>} p.titleFor — заголовок цели
 *   глазами получателя (у многослойной статьи — с его слоя) или null, если
 *   получателю она недоступна
 */
async function notifyAboutComment({ actor, comment, parentAuthorId, targetType, targetId, titleFor }) {
  try {
    const recipients = new Map(); // userId -> type
    if (parentAuthorId && parentAuthorId !== actor.id) recipients.set(parentAuthorId, 'reply');
    const names = mentions.extractMentionNames(comment.content);
    if (names.length) {
      const resolved = await mentions.resolveNames(names);
      resolved.forEach(({ id }) => {
        if (id !== actor.id && !recipients.has(id)) recipients.set(id, 'mention');
      });
    }
    const base = {
      actorId: actor.id,
      actorName: actor.display_name || actor.username,
      targetType,
      targetId,
      commentId: comment.id,
      excerpt: makeExcerpt(comment.content)
    };
    for (const [userId, type] of recipients) {
      const user = await auth.getUserFull(userId);
      if (!user || user.status !== 'approved') continue;
      const title = await titleFor(user);
      if (title == null) continue;
      await create(userId, { ...base, type, targetTitle: title });
    }
  } catch (err) {
    console.error('[notifications] Не удалось создать уведомления о комментарии:', err.message);
  }
}

async function list(userId, limit = 30) {
  const rows = await all('SELECT * FROM user_notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
  return rows.map(rowToNotification);
}

async function countUnread(userId) {
  const rows = await all('SELECT COUNT(*) as count FROM user_notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
  return rows[0] ? rows[0].count : 0;
}

/**
 * Ещё не показанные всплывающим уведомлением — и сразу отмечает их
 * показанными (одно уведомление — один раз, на все вкладки и устройства:
 * UPDATE с проверкой notified_at IS NULL выигрывает только одна вкладка).
 */
async function takeUnnotified(userId) {
  const rows = await all(
    'SELECT * FROM user_notifications WHERE user_id = ? AND notified_at IS NULL AND read_at IS NULL ORDER BY id ASC LIMIT 10',
    [userId]
  );
  const taken = [];
  for (const row of rows) {
    const res = await run('UPDATE user_notifications SET notified_at = CURRENT_TIMESTAMP WHERE id = ? AND notified_at IS NULL', [row.id]);
    if (res.changes > 0) taken.push(rowToNotification(row));
  }
  return taken;
}

async function markRead(userId, ids) {
  if (ids === 'all') {
    await run('UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP, notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP) WHERE user_id = ? AND read_at IS NULL', [userId]);
    return;
  }
  const clean = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return;
  await run(
    `UPDATE user_notifications SET read_at = CURRENT_TIMESTAMP, notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP)
     WHERE user_id = ? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`,
    [userId, ...clean]
  );
}

module.exports = { notifyAboutComment, list, countUnread, takeUnnotified, markRead };
