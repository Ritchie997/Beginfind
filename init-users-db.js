const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключаемся к новой базе данных пользователей
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening users database', err);
    return;
  }
  
  console.log('Connected to users database');
  
  // Создаем таблицы для новой базы пользователей
  const createTablesSQL = `
    -- Таблица пользователей
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role_id INTEGER DEFAULT 4,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Таблица ролей
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Вставка базовых ролей
    INSERT OR IGNORE INTO roles (name, code) VALUES
    ('Пользователь', 'user'),
    ('Администратор', 'admin');
  `;

  db.exec(createTablesSQL, (err) => {
    if (err) {
      console.error('Error creating tables in users database:', err);
    } else {
      console.log('Users database tables created successfully');
    }
    
    // Закрываем соединение
    db.close((err) => {
      if (err) {
        console.error('Error closing users database:', err);
      } else {
        console.log('Users database connection closed');
      }
    });
  });
});