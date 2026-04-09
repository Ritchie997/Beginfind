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
      status TEXT DEFAULT 'pending',
      is_root INTEGER DEFAULT 0,
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
      
      // Добавляем колонки status и is_root если их нет (для существующих БД)
      db.exec(`
        ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending';
      `, (err) => {
        // Игнорируем ошибку, если колонка уже существует
        if (err && !err.message.includes('duplicate')) {
          console.error('Error adding status column:', err);
        }
      });
      
      db.exec(`
        ALTER TABLE users ADD COLUMN is_root INTEGER DEFAULT 0;
      `, (err) => {
        // Игнорируем ошибку, если колонка уже существует
        if (err && !err.message.includes('duplicate')) {
          console.error('Error adding is_root column:', err);
        }
      });
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