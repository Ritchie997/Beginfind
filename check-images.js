const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Создание подключения к базе данных для статей
const wikiDb = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening ibripedia database', err);
  } else {
    console.log('Connected to ibripedia SQLite database');
    
    // Проверим структуру таблицы статей
    wikiDb.all("PRAGMA table_info(articles)", (err, rows) => {
      if (err) {
        console.error('Error querying table info', err);
      } else {
        console.log('Articles table structure:');
        rows.forEach(row => {
          console.log(`Column: ${row.name}, Type: ${row.type}, Not Null: ${row.notnull}`);
        });
        
        // Посмотрим на данные в таблице статей
        wikiDb.all('SELECT id, title, image FROM articles', (err, rows) => {
          if (err) {
            console.error('Error querying articles', err);
          } else {
            console.log('\nArticles with images:');
            rows.forEach(row => {
              console.log(`ID: ${row.id}, Title: ${row.title}, Image: ${row.image}`);
            });
          }
          
          // Закрываем соединение
          wikiDb.close();
        });
      }
    });
  }
});