// mentions.js — упоминания пользователей в комментариях (статей Ibripedia и
// работ галереи). Синтаксис:
//   @Имя            — имя без пробелов (username или отображаемое имя);
//   @[Имя Фамилия]  — имя с пробелами (так его вставляет подсказка при вводе).
// Упомянутый получает уведомление (см. user-notifications.js), а в тексте
// комментария упоминание подсвечивается и ведёт в профиль — для этого к
// комментарию прикладывается карта mentions {имя в нижнем регистре: id}.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');

// Своё соединение с users.db — как в articles.routes.js (общего usersDb нет).
const usersDb = new sqlite3.Database(dbPath('users.db'));

const MENTION_RE = /(^|[^\p{L}\p{N}_@])@(?:\[([^\]\n]{1,64})\]|([\p{L}\p{N}_.-]{1,64}))/gu;

/** Имена, упомянутые в тексте (без повторов, как написаны). */
function extractMentionNames(text) {
  const names = new Map();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(String(text || ''))) !== null) {
    // Точка/дефис в конце "@Имя." — знак препинания, а не часть имени.
    const name = (m[2] || m[3] || '').trim().replace(/[.-]+$/, '');
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()];
}

/**
 * Имена -> пользователи (только одобренные), без учёта регистра, по
 * username и по отображаемому имени.
 * @returns {Promise<Map<string, {id:number, name:string}>>} ключ — имя в нижнем регистре
 */
function resolveNames(names) {
  const unique = [...new Set((names || []).map((n) => String(n).toLowerCase()))];
  if (!unique.length) return Promise.resolve(new Map());
  const ph = unique.map(() => '?').join(',');
  return new Promise((resolve) => {
    usersDb.all(
      `SELECT id, username, display_name FROM users
       WHERE status = 'approved' AND (LOWER(username) IN (${ph}) OR LOWER(display_name) IN (${ph}))`,
      [...unique, ...unique],
      (err, rows) => {
        const result = new Map();
        if (err || !rows) return resolve(result);
        // SQLite LOWER() не понимает кириллицу — сверяем регистр ещё и в JS.
        rows.forEach((r) => {
          [r.username, r.display_name].filter(Boolean).forEach((n) => {
            const key = n.toLowerCase();
            if (unique.includes(key) && !result.has(key)) result.set(key, { id: r.id, name: r.display_name || r.username });
          });
        });
        // Кириллические имена в другом регистре SQL не поймал — добираем.
        const missing = unique.filter((k) => !result.has(k));
        if (!missing.length) return resolve(result);
        usersDb.all("SELECT id, username, display_name FROM users WHERE status = 'approved'", [], (err2, all) => {
          (err2 || !all ? [] : all).forEach((r) => {
            [r.username, r.display_name].filter(Boolean).forEach((n) => {
              const key = n.toLowerCase();
              if (missing.includes(key) && !result.has(key)) result.set(key, { id: r.id, name: r.display_name || r.username });
            });
          });
          resolve(result);
        });
      }
    );
  });
}

/**
 * Дописывает каждому комментарию mentions — {имя в нижнем регистре: id}
 * для упомянутых в нём существующих пользователей (одним запросом на весь
 * список). Клиент по ней делает из @имени ссылку на профиль.
 */
async function attachMentions(comments) {
  const perComment = comments.map((c) => extractMentionNames(c.content));
  const resolved = await resolveNames(perComment.flat());
  return comments.map((c, i) => {
    const mentions = {};
    perComment[i].forEach((name) => {
      const hit = resolved.get(name.toLowerCase());
      if (hit) mentions[name.toLowerCase()] = hit.id;
    });
    return { ...c, mentions };
  });
}

module.exports = { extractMentionNames, resolveNames, attachMentions };
