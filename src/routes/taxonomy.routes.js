// taxonomy.routes.js — категории и роли статей (глобальный справочник,
// используемый формой создания/редактирования статьи). Изменение
// справочника — root only: раньше POST/DELETE были доступны любому
// approved-пользователю.

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const auth = require('../middleware/auth');
const { articlesDb } = require('../db/connections');
const { dbPath } = require('../config/paths');

const router = express.Router();

// === Категории ===

router.get('/categories', auth.authenticateToken, auth.checkApproved, (req, res) => {
  articlesDb.all('SELECT * FROM categories ORDER BY name', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

router.post('/categories', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  const { name } = req.body;
  articlesDb.run('INSERT INTO categories (name) VALUES (?)', [name], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ id: this.lastID, name });
  });
});

router.delete('/categories/:id', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  const { id } = req.params;
  articlesDb.run('DELETE FROM categories WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    res.json({ deleted: this.changes });
  });
});

// === Роли (глобальный справочник пользователей, users.db) ===

router.get('/roles', auth.authenticateToken, auth.checkApproved, (req, res) => {
  const usersDb = new sqlite3.Database(dbPath('users.db'));
  usersDb.all('SELECT * FROM roles ORDER BY name', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
    usersDb.close();
  });
});

router.post('/roles', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  const { name, code } = req.body;
  const usersDb = new sqlite3.Database(dbPath('users.db'));
  usersDb.run('INSERT INTO roles (name, code) VALUES (?, ?)', [name, code], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      usersDb.close();
      return;
    }
    res.json({ id: this.lastID, name, code });
    usersDb.close();
  });
});

router.delete('/roles/:id', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  const { id } = req.params;
  const usersDb = new sqlite3.Database(dbPath('users.db'));
  usersDb.run('DELETE FROM roles WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      usersDb.close();
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: 'Role not found' });
      usersDb.close();
      return;
    }
    res.json({ deleted: this.changes });
    usersDb.close();
  });
});

module.exports = router;
