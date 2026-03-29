const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Открываем базу данных
const db = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Ошибка открытия базы данных:', err);
  } else {
    console.log('База данных открыта успешно');
    
    // Получаем все статьи
    db.all('SELECT * FROM articles', (err, rows) => {
      if (err) {
        console.error('Ошибка запроса:', err);
      } else {
        console.log('Найдено статей:', rows.length);
        console.log('Статьи:');
        rows.forEach((row, index) => {
          console.log(`${index + 1}. ID: ${row.id}, Заголовок: ${row.title}`);
        });
      }
      
      // Закрываем базу данных
      db.close((err) => {
        if (err) {
          console.error('Ошибка закрытия базы данных:', err);
        } else {
          console.log('База данных закрыта');
        }
      });
    });
  }
});