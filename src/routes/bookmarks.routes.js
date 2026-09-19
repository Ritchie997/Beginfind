// bookmarks.routes.js — закладки статей Ibripedia, привязанные к профилю
// (req.user.id из токена — никогда из тела запроса). Личная сущность
// читателя: доступ/изменение только своих закладок, без проверки роли —
// см. src/services/bookmarks-store.js.

const express = require('express');
const auth = require('../middleware/auth');
const store = require('../services/bookmarks-store');

const router = express.Router();

// GET /api/bookmarks — все закладки текущего пользователя, либо только по
// одной статье (?slug=...) — см. панель "Закладки" в просмотре статьи и
// вкладку "Закладки" в профиле.
router.get('/bookmarks', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const bookmarks = await store.listForUser(req.user.id, req.query.slug || null);
    res.json(bookmarks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/bookmarks — создать закладку на блок статьи (абзац/заголовок/…).
router.post('/bookmarks', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { slug, title, blockId, quote, name, color } = req.body;
    const bookmark = await store.createBookmark(req.user.id, { slug, title, blockId, quote, name, color });
    res.status(201).json(bookmark);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/bookmarks/:id — переименовать закладку и/или сменить цвет.
router.put('/bookmarks/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { name, color } = req.body;
    const bookmark = await store.updateBookmark(req.user.id, req.params.id, { name, color });
    if (!bookmark) return res.status(404).json({ error: 'Закладка не найдена' });
    res.json(bookmark);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/bookmarks/:id
router.delete('/bookmarks/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const removed = await store.deleteBookmark(req.user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Закладка не найдена' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
