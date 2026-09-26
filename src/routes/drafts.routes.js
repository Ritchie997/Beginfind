// drafts.routes.js — черновики статей редактора, привязанные к профилю
// (req.user.id из токена — никогда из тела запроса). Личная сущность
// автора: доступ/изменение только своих черновиков, без проверки роли —
// см. src/services/drafts-store.js.

const express = require('express');
const auth = require('../middleware/auth');
const store = require('../services/drafts-store');

const router = express.Router();

// GET /api/drafts — список своих черновиков (без полного содержимого) для
// окна "Мои черновики" в редакторе.
router.get('/drafts', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listForUser(req.user.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/drafts/:id — черновик целиком (снимок формы редактора).
router.get('/drafts/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    if (!store.isValidId(req.params.id)) return res.status(400).json({ error: 'Некорректный id черновика' });
    const draft = await store.getDraft(req.user.id, req.params.id);
    if (!draft) return res.status(404).json({ error: 'Черновик не найден' });
    res.json(draft);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/drafts/:id — создать/обновить черновик. Тело: { data, baseRev,
// updatedAt }. 409 — черновик тем временем изменили на другом устройстве
// (в ответе — текущая серверная rev), клиент сохраняет свою версию копией.
router.put('/drafts/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { data, baseRev, updatedAt } = req.body || {};
    const result = await store.saveDraft(req.user.id, req.params.id, { data, baseRev, updatedAt });
    if (result.status === 'conflict') {
      return res.status(409).json({ error: 'Черновик изменён на другом устройстве', draft: result.draft });
    }
    res.json(result.draft);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/drafts/:id — удалить свой черновик. Отсутствующий черновик —
// тоже успех: клиенту важно лишь, что его больше нет (например, его уже
// удалили с другого устройства).
router.delete('/drafts/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    if (!store.isValidId(req.params.id)) return res.status(400).json({ error: 'Некорректный id черновика' });
    const removed = await store.deleteDraft(req.user.id, req.params.id);
    res.json({ success: true, removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
