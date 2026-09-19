// notifications.routes.js — сводка "на что стоит обратить внимание" для
// шапки/сайдбара: сколько заявок на регистрацию и наборов стикеров ждут
// решения. Владелец видит обе цифры всегда; админ — только те, на которые
// у его роли есть право (manage_pending_users / moderate_stickers, см.
// PERMISSION_KEYS в src/db/migrate-users-schema.js). Если права нет — поле
// в ответе не приходит вовсе (не 0), клиент по этому отличает "нечего
// показывать" от "тебе это не показываем" (public/app.js::initNotificationBadges).

const express = require('express');
const auth = require('../middleware/auth');
const stickersStore = require('../services/stickers-store');

const router = express.Router();

router.get('/notifications/summary', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const canSeeUsers = req.user.is_root || !!(req.user.permissions && req.user.permissions.manage_pending_users);
    const canSeeStickers = req.user.is_root || !!(req.user.permissions && req.user.permissions.moderate_stickers);

    const summary = {};
    if (canSeeUsers) {
      const pending = await auth.getPendingUsers();
      summary.pendingUsers = pending.length;
    }
    if (canSeeStickers) {
      const pending = await stickersStore.listPending();
      summary.pendingStickerPacks = pending.length;
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
