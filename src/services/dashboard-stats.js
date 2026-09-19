// dashboard-stats.js — данные для страницы "Аналитика" (дашборда), которые
// нельзя собрать на клиенте из уже существующих API: число пользователей,
// общее число "сообщений" (мессенджер + комментарии статей Ibripedia) и
// свежие события пользователей/комментариев/сообщений для ленты "Последняя
// активность". Статьи и серверы дашборд по-прежнему берёт из /api/articles и
// /api/servers — они уже отфильтрованы по правам доступа.
//
// Проверка доступа к статьям (закрытые по ролям) здесь НЕ делается — это
// забота маршрута (см. GET /dashboard-summary в articles.routes.js, там
// живёт canAccessArticle): сервис отдаёт "сырые" последние комментарии, а
// маршрут отсеивает те, что относятся к недоступным пользователю статьям.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');
const { messengerDb, socialDb } = require('../db/connections');

// Окно "тренда" в бейджах рядом со счётчиками (см. renderTrendBadge на клиенте).
const TREND_DAYS = 7;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// CURRENT_TIMESTAMP в SQLite — UTC без указания зоны ("2026-09-12 14:53:28").
// Клиентский new Date() разобрал бы такую строку как ЛОКАЛЬНОЕ время и
// сдвинул бы все "N мин. назад" на величину пояса, поэтому отдаём ISO с "Z".
function toIso(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Границы окна тренда в том же формате, что и CURRENT_TIMESTAMP — иначе
// строковое сравнение created_at в SQL было бы некорректным.
const TREND_CUTOFF_SQL = `datetime('now', '-${TREND_DAYS} days')`;

/**
 * Пользователи: сколько всего (только подтверждённые — заявки в ожидании и
 * отклонённые пользователями ещё/уже не являются), сколько зарегистрировалось
 * за последние TREND_DAYS дней и последние регистрации для ленты активности.
 */
async function getUsersSummary(recentLimit = 5) {
  const usersDb = new sqlite3.Database(dbPath('users.db'), sqlite3.OPEN_READONLY);
  try {
    const [counts] = await dbAll(
      usersDb,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at >= ${TREND_CUTOFF_SQL} THEN 1 ELSE 0 END), 0) AS recent
         FROM users WHERE status = 'approved'`
    );
    const recent = await dbAll(
      usersDb,
      `SELECT id, username, display_name, created_at FROM users
        WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT ?`,
      [recentLimit]
    );
    return {
      total: counts.total,
      trend: counts.recent,
      recent: recent.map((u) => ({
        id: u.id,
        name: u.display_name || u.username,
        createdAt: toIso(u.created_at)
      }))
    };
  } finally {
    usersDb.close();
  }
}

/**
 * Сообщения мессенджера: всего, за окно тренда и последние для ленты.
 */
async function getMessengerSummary(recentLimit = 3) {
  const [counts] = await dbAll(
    messengerDb,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN timestamp >= ${TREND_CUTOFF_SQL} THEN 1 ELSE 0 END), 0) AS recent
       FROM messages`
  );
  const recent = await dbAll(
    messengerDb,
    'SELECT id, sender, content, timestamp FROM messages ORDER BY timestamp DESC, id DESC LIMIT ?',
    [recentLimit]
  );
  return {
    total: counts.total,
    trend: counts.recent,
    recent: recent.map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      createdAt: toIso(m.timestamp)
    }))
  };
}

/**
 * Комментарии статей Ibripedia: число по каждой статье (всего и за окно
 * тренда) — вызывающий код суммирует только по СУЩЕСТВУЮЩИМ статьям, потому
 * что комментарии удалённой статьи в article_comments остаются — и последние
 * комментарии (с запасом, часть отсеется проверкой доступа/существования).
 */
async function getCommentsSummary(recentLimit = 50) {
  const perArticle = await dbAll(
    socialDb,
    `SELECT article_slug AS slug, COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN created_at >= ${TREND_CUTOFF_SQL} THEN 1 ELSE 0 END), 0) AS recent
       FROM article_comments GROUP BY article_slug`
  );
  const recent = await dbAll(
    socialDb,
    `SELECT id, user_id, author_name, article_slug, content, created_at
       FROM article_comments ORDER BY created_at DESC, id DESC LIMIT ?`,
    [recentLimit]
  );
  return {
    perArticle,
    recent: recent.map((c) => ({
      id: c.id,
      userId: c.user_id,
      authorName: c.author_name,
      slug: c.article_slug,
      content: c.content,
      createdAt: toIso(c.created_at)
    }))
  };
}

module.exports = { getUsersSummary, getMessengerSummary, getCommentsSummary };
