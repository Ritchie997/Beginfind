const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Создание подключения к базе данных для мессенджера
const messengerDb = new sqlite3.Database(path.join(__dirname, 'messenger.db'), (err) => {
  if (err) {
    console.error('Error opening messenger database', err);
  } else {
    console.log('Connected to messenger SQLite database');
    
    // Проверим структуру таблицы сообщений
    messengerDb.all("PRAGMA table_info(messages)", (err, rows) => {
      if (err) {
        console.error('Error querying table info', err);
      } else {
        console.log('Messages table structure:');
        rows.forEach(row => {
          console.log(`Column: ${row.name}, Type: ${row.type}, Not Null: ${row.notnull}`);
        });
        
        // Посмотрим на данные в таблице сообщений
        messengerDb.all('SELECT id, sender, content FROM messages', (err, rows) => {
          if (err) {
            console.error('Error querying messages', err);
          } else {
            console.log('\nMessages:');
            rows.forEach(row => {
              console.log(`ID: ${row.id}, Sender: ${row.sender}, Content: ${row.content}`);
            });
          }
          
          // Закрываем соединение
          messengerDb.close();
        });
      }
    });
  }
});