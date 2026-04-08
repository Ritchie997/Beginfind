const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключаемся к новой базе данных мессенджера
const db = new sqlite3.Database(path.join(__dirname, 'messenger.db'), (err) => {
  if (err) {
    console.error('Error opening messenger database', err);
    return;
  }
  
  console.log('Connected to messenger database');
  
  // Создаем таблицу для сообщений
  const createTableSQL = `
    -- Таблица сообщений
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

  db.exec(createTableSQL, (err) => {
    if (err) {
      console.error('Error creating table in messenger database:', err);
    } else {
      console.log('Messenger database table created successfully');
    }
    
    // Закрываем соединение
    db.close((err) => {
      if (err) {
        console.error('Error closing messenger database:', err);
      } else {
        console.log('Messenger database connection closed');
      }
    });
  });
});