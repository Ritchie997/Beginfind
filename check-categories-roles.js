const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключение к базе данных
const wikiDb = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
    
    // Проверим структуру таблицы категорий
    wikiDb.all("PRAGMA table_info(categories)", (err, rows) => {
      if (err) {
        console.error('Error querying categories table info', err);
      } else {
        console.log('Categories table structure:');
        rows.forEach(row => {
          console.log(`Column: ${row.name}, Type: ${row.type}, Not Null: ${row.notnull}`);
        });
        
        // Проверим данные в таблице категорий
        wikiDb.all('SELECT * FROM categories', (err, rows) => {
          if (err) {
            console.error('Error querying categories', err);
          } else {
            console.log('\nCategories data:');
            rows.forEach(row => {
              console.log(`ID: ${row.id}, Name: ${row.name}, Created: ${row.created_at}`);
            });
          }
        });
      }
    });
    
    // Проверим структуру таблицы ролей
    wikiDb.all("PRAGMA table_info(roles)", (err, rows) => {
      if (err) {
        console.error('Error querying roles table info', err);
      } else {
        console.log('\nRoles table structure:');
        rows.forEach(row => {
          console.log(`Column: ${row.name}, Type: ${row.type}, Not Null: ${row.notnull}`);
        });
        
        // Проверим данные в таблице ролей
        wikiDb.all('SELECT * FROM roles', (err, rows) => {
          if (err) {
            console.error('Error querying roles', err);
          } else {
            console.log('\nRoles data:');
            rows.forEach(row => {
              console.log(`ID: ${row.id}, Name: ${row.name}, Code: ${row.code}, Created: ${row.created_at}`);
            });
          }
          
          // Закрываем соединение
          wikiDb.close(() => {
            console.log('\nDatabase connection closed');
          });
        });
      }
    });
  }
});