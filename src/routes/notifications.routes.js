// notifications.routes.js — сводка "на что стоит обратить внимание" для
// шапки/сайдбара: сколько заявок на регистрацию и наборов стикеров ждут
// решения (плюс предложения коллабораций на собственные наборы — они
// адресованы конкретному автору и приходят всем). Владелец видит обе цифры всегда; админ — только те, на которые
// у его роли есть право (manage_pending_users / moderate_stickers, см.
// PERMISSION_KEYS в src/db/migrate-users-schema.js). Если права нет — поле
// в ответе не приходит вовсе (не 0), клиент по этому отличает "нечего
// показывать" от "тебе это не показываем" (public/app.js::initNotificationBadges).

const express = require('express');
const auth = require('../middleware/auth');
const stickersStore = require('../services/stickers-store');
const feedbackStore = require('../services/feedback-store');

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
    // Очереди трёх линий модерации обращений — каждая только тем, у кого
    // есть право соответствующей линии (см. src/services/feedback-store.js).
    const canTriage = req.user.is_root || !!(req.user.permissions && req.user.permissions.feedback_triage);
    const canCases = req.user.is_root || !!(req.user.permissions && req.user.permissions.feedback_cases);
    const canDecide = req.user.is_root || !!(req.user.permissions && req.user.permissions.feedback_decide);
    if (canTriage || canCases || canDecide) {
      const queues = await feedbackStore.countQueues();
      if (canTriage) summary.feedbackTriage = queues.triage;
      if (canCases) summary.feedbackUnassigned = queues.unassigned;
      if (canDecide) summary.feedbackEscalated = queues.escalated;
    }

    // Предложения коллабораций на МОИ наборы стикеров — видны любому автору
    // (не зависят от прав), поэтому поле приходит всем.
    summary.incomingStickerCollabs = await stickersStore.countIncomingCollabs(req.user.id);

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
