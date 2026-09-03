// messages.routes.js — API мессенджера.

const express = require('express');
const auth = require('../middleware/auth');
const { messengerDb } = require('../db/connections');

const router = express.Router();

router.get('/messages', auth.authenticateToken, auth.checkApproved, (req, res) => {
  messengerDb.all('SELECT * FROM messages ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // Преобразование кодировки для кириллических символов
    const encodedRows = rows.map(row => {
      return {
        ...row,
        sender: row.sender,
        content: row.content
      };
    });
    res.json(encodedRows);
  });
});

router.post('/messages', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Содержимое сообщения обязательно' });
  }
  // Отправитель берётся из токена, а не из тела запроса — раньше клиент мог
  // прислать любой sender и отправить сообщение от чужого имени.
  const sender = req.user.display_name || req.user.username;
  messengerDb.run('INSERT INTO messages (sender, content) VALUES (?, ?)', [sender, content], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID });
  });
});

module.exports = router;
