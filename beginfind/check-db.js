const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Создание подключения к базе данных для статей
const wikiDb = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening ibripedia database', err);
  } else {
    console.log('Connected to ibripedia SQLite database');
    
    // Проверим количество статей
    wikiDb.get('SELECT COUNT(*) as count FROM articles', (err, row) => {
      if (err) {
        console.error('Error querying articles count', err);
      } else {
        console.log('Number of articles in database:', row.count);
        
        // Покажем несколько первых статей
        wikiDb.all('SELECT id, title FROM articles LIMIT 5', (err, rows) => {
          if (err) {
            console.error('Error querying articles', err);
          } else {
            console.log('First 5 articles:');
            rows.forEach(row => {
              console.log(`ID: ${row.id}, Title: ${row.title}`);
            });
          }
          
          // Закрываем соединение
          wikiDb.close();
        });
      }
    });
  }
});