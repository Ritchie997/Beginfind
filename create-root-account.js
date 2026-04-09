/**
 * Скрипт создания root-аккаунта
 * Читает ROOT_USERNAME и ROOT_PASSWORD из .env файла
 * Запуск: node create-root-account.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function createRootAccount() {
  const username = process.env.ROOT_USERNAME;
  const password = process.env.ROOT_PASSWORD;

  if (!username || !password) {
    console.error('ОШИБКА: Переменные ROOT_USERNAME и ROOT_PASSWORD должны быть установлены в .env файле');
    console.error('Добавьте в .env:');
    console.error('  ROOT_USERNAME=ваш_root_логин');
    console.error('  ROOT_PASSWORD=ваш_root_пароль');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('ОШИБКА: ROOT_PASSWORD должен быть минимум 6 символов');
    process.exit(1);
  }

  const db = new sqlite3.Database(path.join(__dirname, 'users.db'));

  // Проверяем, существует ли уже root-пользователь
  db.get('SELECT id FROM users WHERE is_root = 1', [], async (err, row) => {
    if (err) {
      console.error('Ошибка базы данных:', err.message);
      db.close();
      process.exit(1);
    }

    if (row) {
      console.log('Root-аккаунт уже существует (id:', row.id + ')');
      db.close();
      process.exit(0);
    }

    // Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 12);

    // Создаём root-аккаунт
    db.run(
      `INSERT INTO users (username, display_name, password, role_id, status, is_root)
       VALUES (?, ?, ?, 4, 'approved', 1)`,
      [username, username, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint')) {
            console.log('Пользователь с таким именем уже существует');
          } else {
            console.error('Ошибка создания root-аккаунта:', err.message);
          }
          db.close();
          process.exit(1);
        }

        console.log('Root-аккаунт успешно создан!');
        console.log('  ID:', this.lastID);
        console.log('  Имя:', username);
        console.log('  Статус: approved');
        console.log('  is_root: true');
        db.close();
      }
    );
  });
}

createRootAccount();
