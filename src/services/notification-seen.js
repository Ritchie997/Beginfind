// notification-seen.js — какие элементы очередей (заявки на регистрацию,
// обращения, наборы стикеров, предложения коллабораций) пользователь уже
// видел во всплывающем уведомлении (таблица notification_seen в social.db).
//
// Раньше клиент сравнивал только КОЛИЧЕСТВО с последним увиденным в
// localStorage — уведомление повторялось, когда число колебалось (обращение
// ушло на другую линию и вернулось: 8 → 7 → 8), в каждой вкладке/на каждом
// устройстве заново и у всех аккаунтов одного браузера разом. Теперь сервер
// помнит конкретные элементы: о каждом пользователь узнаёт ровно один раз.

const { socialDb } = require('../db/connections');

const INIT_KEY = '__init__';

function run(sql, params) {
  return new Promise((resolve, reject) => {
    socialDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Отмечает элементы категории как увиденные и возвращает, сколько из них
 * пользователь видит впервые. INSERT OR IGNORE — атомарно на строку: если
 * две вкладки спросят одновременно, новым элемент окажется только для одной.
 *
 * Самый первый вызов по категории (отметки INIT_KEY ещё нет) молча
 * запоминает всё текущее — иначе при первом заходе после обновления сайта
 * пользователя "уведомило" бы обо всём накопившемся бэклоге разом.
 * @param {number} userId
 * @param {string} category — ключ категории (pendingUsers, feedbackTriage, …)
 * @param {Array<string|number>} itemKeys — id элементов, лежащих в очереди сейчас
 * @returns {Promise<number>} число элементов, о которых нужно уведомить
 */
async function markSeen(userId, category, itemKeys) {
  const firstTime = (await run(
    'INSERT OR IGNORE INTO notification_seen (user_id, category, item_key) VALUES (?, ?, ?)',
    [userId, category, INIT_KEY]
  )) > 0;
  let fresh = 0;
  for (const key of itemKeys) {
    fresh += await run(
      'INSERT OR IGNORE INTO notification_seen (user_id, category, item_key) VALUES (?, ?, ?)',
      [userId, category, String(key)]
    );
  }
  return firstTime ? 0 : fresh;
}

module.exports = { markSeen };
