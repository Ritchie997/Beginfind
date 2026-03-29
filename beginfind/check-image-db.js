const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключаемся к базе данных
const db = new sqlite3.Database(path.join(__dirname, 'articles.db'), (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных:', err.message);
    return;
  }
  console.log('Подключено к базе данных articles.db');
});

// Выполняем запрос для получения статей с изображениями
db.all('SELECT id, title, image, created_at, updated_at FROM articles WHERE image IS NOT NULL AND image != "" ORDER BY created_at DESC LIMIT 10', (err, rows) => {
  if (err) {
    console.error('Ошибка при выполнении запроса:', err.message);
    return;
  }

  console.log('Статьи с изображениями:');
  rows.forEach(row => {
    console.log(`ID: ${row.id}, Заголовок: ${row.title}, Изображение: ${row.image}, Создано: ${row.created_at}, Обновлено: ${row.updated_at}`);
  });

  // Закрываем соединение
  db.close((err) => {
    if (err) {
      console.error('Ошибка при закрытии базы данных:', err.message);
    } else {
      console.log('Соединение с базой данных закрыто');
    }
  });
});