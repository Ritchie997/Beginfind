// connections.js — открывает общие SQLite-соединения один раз при старте
// сервера и отдаёт их остальным модулям. usersDb намеренно не открывается
// здесь: middleware/auth.js держит собственное соединение с users.db, а
// отдельные маршруты (роли, список пользователей и т.п.) открывают
// users.db по требованию — так было в исходном коде, поведение не менялось.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');

const messengerDb = new sqlite3.Database(dbPath('messenger.db'), (err) => {
  if (err) {
    console.error('Error opening messenger database', err);
  } else {
    console.log('Connected to messenger SQLite database');
    messengerDb.run("PRAGMA encoding = 'UTF-8'");
    messengerDb.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

const articlesDb = new sqlite3.Database(dbPath('articles.db'), (err) => {
  if (err) {
    console.error('Error opening articles database', err);
  } else {
    console.log('Connected to articles SQLite database');
    articlesDb.run("PRAGMA encoding = 'UTF-8'");
  }
});

const serversDb = new sqlite3.Database(dbPath('servers.db'), (err) => {
  if (err) {
    console.error('Error opening servers database', err);
  } else {
    console.log('Connected to servers SQLite database');
    serversDb.run("PRAGMA encoding = 'UTF-8'");
  }
});

module.exports = { messengerDb, articlesDb, serversDb };
