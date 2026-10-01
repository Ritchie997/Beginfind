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
const notificationSeen = require('../services/notification-seen');
const userNotifications = require('../services/user-notifications');

const router = express.Router();

// Ответ: { <категория>: число, …, fresh: { <категория>: сколько из них
// пользователь видит впервые } } — по fresh клиент показывает всплывающее
// уведомление, ровно один раз на каждый элемент (см. notification-seen.js).
router.get('/notifications/summary', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const perms = req.user.permissions || {};
    const canSeeUsers = req.user.is_root || !!perms.manage_pending_users;
    const canSeeStickers = req.user.is_root || !!perms.moderate_stickers;
    const canTriage = req.user.is_root || !!perms.feedback_triage;
    const canCases = req.user.is_root || !!perms.feedback_cases;
    const canDecide = req.user.is_root || !!perms.feedback_decide;

    // Категория -> ключи элементов, лежащих в ней сейчас.
    const items = {};
    if (canSeeUsers) items.pendingUsers = (await auth.getPendingUsers()).map((u) => u.id);
    if (canSeeStickers) items.pendingStickerPacks = await stickersStore.listPendingIds();
    // Очереди трёх линий модерации обращений — каждая только тем, у кого
    // есть право соответствующей линии (см. src/services/feedback-store.js).
    if (canTriage || canCases || canDecide) {
      const queues = await feedbackStore.listQueueIds();
      if (canTriage) items.feedbackTriage = queues.triage;
      // Второй линии — и новые обращения без кейса, и кейсы, возвращённые на
      // доработку (id обращений и кейсов пересекаются — отсюда префиксы).
      if (canCases) items.feedbackUnassigned = [...queues.unassigned.map((id) => `report:${id}`), ...queues.returned.map((id) => `case:${id}`)];
      if (canDecide) items.feedbackEscalated = queues.escalated;
    }
    // Предложения коллабораций на МОИ наборы стикеров — видны любому автору
    // (не зависят от прав), поэтому поле приходит всем.
    items.incomingStickerCollabs = await stickersStore.listIncomingCollabIds(req.user.id);

    const summary = { fresh: {} };
    for (const [category, keys] of Object.entries(items)) {
      summary[category] = keys.length;
      const fresh = await notificationSeen.markSeen(req.user.id, category, keys);
      if (fresh) summary.fresh[category] = fresh;
    }
    // Личные (ответы на комментарии, @упоминания): число непрочитанных для
    // колокольчика и новые — для всплывающего уведомления, один раз.
    summary.personalUnread = await userNotifications.countUnread(req.user.id);
    summary.personalFresh = await userNotifications.takeUnnotified(req.user.id);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Колокольчик: последние личные уведомления + сколько непрочитанных.
router.get('/notifications', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const [items, unread] = await Promise.all([
      userNotifications.list(req.user.id, 30),
      userNotifications.countUnread(req.user.id)
    ]);
    res.json({ items, unread });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Отметить прочитанными: { ids: [..] } или { all: true }.
router.post('/notifications/read', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await userNotifications.markRead(req.user.id, req.body.all ? 'all' : req.body.ids);
    res.json({ unread: await userNotifications.countUnread(req.user.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
