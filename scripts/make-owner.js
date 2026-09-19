#!/usr/bin/env node
// make-owner.js — назначить пользователя владельцем (is_root) через терминал
// сервера. Владелец — уникальная роль: ровно один аккаунт с is_root=1.
// Назначение нового владельца автоматически снимает эту роль с предыдущего
// (передача роли), их admin_level и прочие данные при этом не трогаются.
//
// Запуск:
//   node scripts/make-owner.js <username или id>
//   npm run make-owner -- <username или id>
//
// Без аргумента — печатает список пользователей с их текущей ролью и
// ничего не меняет.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../src/config/paths');
const { ensureUserSchema } = require('../src/db/migrate-users-schema');

const db = new sqlite3.Database(dbPath('users.db'));

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function roleLabel(user) {
  if (user.is_root) return 'владелец';
  if (user.admin_level > 0) return `админ (уровень ${user.admin_level})`;
  return 'пользователь';
}

async function main() {
  await ensureUserSchema(db);

  const arg = process.argv[2];

  if (!arg) {
    const users = await all('SELECT id, username, display_name, status, is_root, admin_level FROM users ORDER BY is_root DESC, admin_level DESC, id ASC');
    if (users.length === 0) {
      console.log('Пользователей пока нет — сначала зарегистрируйте аккаунт через приложение.');
      return;
    }
    console.log('Пользователи:');
    users.forEach((u) => {
      console.log(`  #${u.id}\t${u.username}\t(${u.display_name || u.username})\t${u.status}\t${roleLabel(u)}`);
    });
    console.log('\nЧтобы выдать себе роль владельца:');
    console.log('  node scripts/make-owner.js <username>');
    console.log('  npm run make-owner -- <username>');
    return;
  }

  const target = /^\d+$/.test(arg)
    ? await get('SELECT * FROM users WHERE id = ?', [Number(arg)])
    : await get('SELECT * FROM users WHERE username = ?', [arg]);

  if (!target) {
    console.error(`Пользователь "${arg}" не найден.`);
    process.exitCode = 1;
    return;
  }

  if (target.is_root) {
    console.log(`«${target.username}» уже является владельцем — ничего не изменено.`);
    return;
  }

  const previousOwner = await get('SELECT id, username FROM users WHERE is_root = 1');

  await run('UPDATE users SET is_root = 0 WHERE is_root = 1');
  await run(
    "UPDATE users SET is_root = 1, status = 'approved', rejection_reason = NULL WHERE id = ?",
    [target.id]
  );

  console.log(`Готово: «${target.username}» (#${target.id}) теперь владелец.`);
  if (previousOwner) {
    console.log(`Предыдущий владелец «${previousOwner.username}» (#${previousOwner.id}) роль потерял.`);
  }
  console.log('Изменения вступят в силу на следующем запросе — перелогиниваться не обязательно.');
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
