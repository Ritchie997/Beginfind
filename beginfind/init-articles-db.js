const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключаемся к новой базе данных статей
const db = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening articles database', err);
    return;
  }
  
  console.log('Connected to articles database');
  
  // Создаем таблицы для новой базы статей
  const createTablesSQL = `
    -- Таблица статей
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      views INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0,
      role TEXT,
      category TEXT,
      tags TEXT,
      author TEXT,
      image TEXT,
      attachments TEXT,
      server TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Таблица категорий
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Создание полнотекстового индекса для поиска
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, content, author, category, tags);

    -- Создаем триггеры для автоматической синхронизации изменений FTS
    CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(title, content, author, category, tags)
      VALUES(new.title, new.content, new.author, new.category, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      DELETE FROM articles_fts WHERE rowid = old.rowid;
      INSERT INTO articles_fts(title, content, author, category, tags)
      VALUES(new.title, new.content, new.author, new.category, new.tags);
    END;
    
    CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      DELETE FROM articles_fts WHERE rowid = old.rowid;
    END;
  `;

  db.exec(createTablesSQL, (err) => {
    if (err) {
      console.error('Error creating tables in articles database:', err);
    } else {
      console.log('Articles database tables created successfully');
      
      // Добавляем базовые категории
      const categories = [
        'Техническая документация',
        'Управление',
        'Интеграции',
        'Дизайн',
        'Разработка',
        'Безопасность',
        'Маркетинг',
        'Поддержка'
      ];
      
      const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
      categories.forEach(category => {
        insertCategory.run(category, (err) => {
          if (err) {
            console.error(`Error inserting category ${category}:`, err);
          }
        });
      });
      insertCategory.finalize();
      console.log('Default categories added to articles database');
    }
    
    // Закрываем соединение
    db.close((err) => {
      if (err) {
        console.error('Error closing articles database:', err);
      } else {
        console.log('Articles database connection closed');
      }
    });
  });
});