const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Путь к базе данных
const dbPath = path.join(__dirname, 'articles.db');

// Проверяем, существует ли файл базы данных
if (!fs.existsSync(dbPath)) {
  console.error('Файл базы данных articles.db не найден!');
  process.exit(1);
}

// Создаем резервную копию
const backupPath = path.join(__dirname, 'articles.db.backup');
fs.copyFileSync(dbPath, backupPath);
console.log('Создана резервная копия базы данных:', backupPath);

// Подключаемся к базе данных
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных:', err);
    return;
  }

  console.log('Подключено к базе данных articles.db');

  // Шаг 1: Получаем все данные из текущей таблицы articles
  db.all('SELECT id, title, content, views, locked, role, category, tags, author, image, attachments, server, created_at, updated_at FROM articles', (err, rows) => {
    if (err) {
      console.error('Ошибка при чтении данных:', err);
      db.close();
      return;
    }

    console.log(`Найдено ${rows.length} записей для переноса`);

    // Шаг 2: Удаляем старые триггеры и FTS индекс
    const dropStatements = `
      DROP TRIGGER IF EXISTS articles_ai;
      DROP TRIGGER IF EXISTS articles_au;
      DROP TRIGGER IF EXISTS articles_ad;
      DROP TABLE IF EXISTS articles_fts;
    `;

    db.exec(dropStatements, (err) => {
      if (err) {
        console.error('Ошибка при удалении старых объектов:', err);
        db.close();
        return;
      }

      console.log('Старые триггеры и FTS индекс удалены');

      // Шаг 3: Переименовываем старую таблицу
      db.run('ALTER TABLE articles RENAME TO articles_old', (err) => {
        if (err) {
          console.error('Ошибка при переименовании старой таблицы:', err);
          db.close();
          return;
        }

        console.log('Старая таблица переименована в articles_old');

        // Шаг 4: Создаем новую таблицу без поля description
        const createNewTableSQL = `
          CREATE TABLE articles (
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
        `;

        db.exec(createNewTableSQL, (err) => {
          if (err) {
            console.error('Ошибка при создании новой таблицы:', err);
            db.close();
            return;
          }

          console.log('Новая таблица создана');

          // Шаг 5: Вставляем данные в новую таблицу
          const insertStmt = db.prepare(`
            INSERT INTO articles (id, title, content, views, locked, role, category, tags, author, image, attachments, server, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          let insertedCount = 0;
          rows.forEach((row) => {
            insertStmt.run([
              row.id, 
              row.title, 
              row.content, 
              row.views, 
              row.locked, 
              row.role, 
              row.category, 
              row.tags, 
              row.author, 
              row.image, 
              row.attachments, 
              row.server, 
              row.created_at, 
              row.updated_at
            ], (err) => {
              if (err) {
                console.error('Ошибка при вставке записи:', err);
              } else {
                insertedCount++;
                if (insertedCount % 100 === 0) {
                  console.log(`Вставлено ${insertedCount} записей из ${rows.length}`);
                }
              }
            });
          });

          insertStmt.finalize((err) => {
            if (err) {
              console.error('Ошибка при завершении вставки:', err);
            } else {
              console.log(`Все ${insertedCount} записей успешно вставлены`);
            }

            // Шаг 6: Создаем новый FTS индекс
            const createFTS = `
              CREATE VIRTUAL TABLE articles_fts USING fts5(title, content, author, category, tags);
              
              -- Вставляем данные в FTS индекс
              INSERT INTO articles_fts(title, content, author, category, tags)
              SELECT title, content, author, category, tags FROM articles;
              
              -- Создаем триггеры для автоматической синхронизации FTS
              CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
                INSERT INTO articles_fts(title, content, author, category, tags)
                VALUES(new.title, new.content, new.author, new.category, new.tags);
              END;

              CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
                DELETE FROM articles_fts WHERE rowid = old.rowid;
                INSERT INTO articles_fts(title, content, author, category, tags)
                VALUES(new.title, new.content, new.author, new.category, new.tags);
              END;

              CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
                DELETE FROM articles_fts WHERE rowid = old.rowid;
              END;
            `;

            db.exec(createFTS, (err) => {
              if (err) {
                console.error('Ошибка при создании FTS и триггеров:', err);
              } else {
                console.log('FTS индекс и триггеры созданы');
              }

              // Шаг 7: Удаляем старую таблицу
              db.run('DROP TABLE articles_old', (err) => {
                if (err) {
                  console.error('Ошибка при удалении старой таблицы:', err);
                } else {
                  console.log('Старая таблица articles_old удалена');
                }

                // Закрываем соединение
                db.close((err) => {
                  if (err) {
                    console.error('Ошибка при закрытии соединения:', err);
                  } else {
                    console.log('База данных успешно обновлена! Поле description удалено.');
                    console.log('Резервная копия сохранена как:', backupPath);
                  }
                });
              });
            });
          });
        });
      });
    });
  });
});