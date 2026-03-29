const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключение к базе данных
const wikiDb = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
    
    // Создание таблицы для категорий
    wikiDb.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Error creating categories table', err);
      } else {
        console.log('Categories table created or already exists');
        
        // Добавим существующие категории из текущей реализации
        const defaultCategories = [
          'Техническая документация',
          'Управление',
          'Интеграции',
          'Дизайн',
          'Разработка',
          'Безопасность',
          'Маркетинг',
          'Поддержка'
        ];
        
        const insertCategory = wikiDb.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
        defaultCategories.forEach(category => {
          insertCategory.run(category, (err) => {
            if (err) {
              console.error(`Error inserting category ${category}:`, err);
            }
          });
        });
        insertCategory.finalize();
        console.log('Default categories added');
      }
    });
    
    // Создание таблицы для ролей
    wikiDb.run(`CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Error creating roles table', err);
      } else {
        console.log('Roles table created or already exists');
        
        // Добавим только необходимые базовые роли
        const defaultRoles = [
          { name: 'Пользователь', code: 'user' },
          { name: 'Администратор', code: 'admin' }
        ];
        
        const insertRole = wikiDb.prepare('INSERT OR IGNORE INTO roles (name, code) VALUES (?, ?)');
        defaultRoles.forEach(role => {
          insertRole.run([role.name, role.code], (err) => {
            if (err) {
              console.error(`Error inserting role ${role.name}:`, err);
            }
          });
        });
        insertRole.finalize();
        console.log('Default roles added');
      }
    });
    
    // Закрываем соединение
    wikiDb.close(() => {
      console.log('Database connection closed');
    });
  }
});