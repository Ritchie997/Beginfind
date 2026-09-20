// stickers.routes.js — наборы стикеров: создание/загрузка своими силами,
// модерация (approve/reject) правом moderate_stickers, каталог + подписки
// ("добавить набор себе"). Подробности жизненного цикла и формата шорткода
// ":slug:alias:" — см. комментарий в начале src/services/stickers-store.js.

const express = require('express');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth');
const store = require('../services/stickers-store');
const { uploadSticker } = require('../uploads/multer-config');

const router = express.Router();

function displayName(user) {
  return user.display_name || user.username;
}

// Может ли actingUser модерировать (переименовать/удалить/отозвать) набор
// ЧУЖОГО автора — тот же принцип иерархии, что и canDeleteArticle в
// articles.routes.js: право moderate_stickers само по себе не даёт трогать
// набор владельца или админа не ниже себя по уровню — иначе равные по рангу
// модераторы могли бы удалять/отзывать наборы друг у друга. Проверка
// авторства (пользователь управляет своим же набором) — отдельно, в каждом
// роуте, эта функция только про ЧУЖИЕ наборы.
async function canModerateOtherUsersPack(actingUser, authorId) {
  if (actingUser.is_root) return true;
  if (!(actingUser.permissions && actingUser.permissions.moderate_stickers)) return false;
  const myLevel = actingUser.admin_level || 0;
  if (myLevel <= 0) return false;

  const author = await auth.getUserFull(authorId);
  if (!author) return true; // автора уже нет — иерархию проверять не с кем
  if (author.is_root) return false;
  return (author.admin_level || 0) < myLevel;
}

// GET /api/stickers/mine — свои наборы (любого статуса — draft/pending/
// rejected тоже показываем автору, чтобы он видел, что происходит с ними).
router.get('/stickers/mine', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listMyPacks(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stickers/by-user/:userId — наборы конкретного пользователя для
// вкладки "Наборы стикеров" в его профиле (public/views/profile.html):
// сам пользователь видит все свои наборы, как и /stickers/mine (включая
// pending/rejected — чтобы видеть статус заявки), посторонним показываем
// только одобренные — публичная витрина не должна светить черновики.
router.get('/stickers/by-user/:userId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const isSelf = String(req.params.userId) === String(req.user.id);
    res.json(await store.listPacksByAuthor(req.params.userId, isSelf, true));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stickers/catalog?q=... — одобренные наборы + отметка, добавлен
// ли себе (subscribed) — экран "Каталог" во вкладке "Стикеры".
router.get('/stickers/catalog', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listCatalog(req.user.id, req.query.q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stickers/subscribed — добавленные себе наборы вместе со
// стикерами — то, чем наполняется пикер в форме комментария/сообщения.
router.get('/stickers/subscribed', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listSubscribedWithStickers(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stickers/packs/:id — набор целиком (со стикерами) для модалки
// просмотра/управления. Approved-наборы видны всем; pending/rejected —
// только автору или модератору (moderate_stickers/владелец).
router.get('/stickers/packs/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const pack = await store.getPackWithStickers(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Набор не найден' });

    const isOwner = pack.authorId === req.user.id;
    const isModerator = req.user.is_root || !!(req.user.permissions && req.user.permissions.moderate_stickers);
    // Черновик приватен — его не видит никто, кроме автора (даже модераторы:
    // им набор доступен только после публикации, из очереди "На модерации").
    if (pack.status === 'draft' && !isOwner) {
      return res.status(403).json({ error: 'Этот набор ещё не опубликован' });
    }
    if (pack.status !== 'approved' && !isOwner && !isModerator) {
      return res.status(403).json({ error: 'Этот набор ещё не подтверждён' });
    }
    // subscribed/isOwn — та же пара полей, что и в listCatalog, нужна модалке
    // набора (public/stickers-manager.js), чтобы после переключения подписки
    // кнопка в футере сразу отражала актуальное состояние. canModerate —
    // может ли ТЕКУЩИЙ пользователь отозвать/удалить/переименовать ЧУЖОЙ
    // набор (тот же canModerateOtherUsersPack, что и в PUT/DELETE/revoke
    // ниже) — фронту нужно заранее знать, показывать ли кнопки модерации в
    // модалке чужого набора, не дожидаясь 403 от реального действия.
    pack.subscribed = await store.isSubscribed(req.user.id, pack.id);
    pack.isOwn = isOwner;
    pack.canModerate = !isOwner && await canModerateOtherUsersPack(req.user, pack.authorId);
    // myCollab — моя текущая (draft/pending) заявка на коллаборацию с этим
    // набором со стикерами, если есть (см. раздел "Коллаборации" в
    // stickers-store.js); автору собственного набора заявка ни к чему.
    pack.myCollab = (!isOwner && pack.status === 'approved') ? await store.getMyCollab(req.user.id, pack.id) : null;
    res.json(pack);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stickers/packs — создать новый набор. Он рождается черновиком и
// в модерацию не уходит, пока автор сам не опубликует его (POST
// .../publish ниже) — см. жизненный цикл в stickers-store.js.
router.post('/stickers/packs', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const pack = await store.createPack(req.user.id, displayName(req.user), req.body.title, req.body.description);
    res.status(201).json(pack);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/stickers/packs/:id — переименовать набор (и/или поменять описание
// — req.body.description опущен целиком => не трогаем текущее, см.
// renamePack в stickers-store.js): сам автор, либо модератор/владелец над
// автором строго ниже по иерархии (см. canModerateOtherUsersPack выше).
router.put('/stickers/packs/:id', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const pack = await store.getPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Набор не найден' });
    if (pack.status === 'draft' && pack.authorId !== req.user.id) {
      return res.status(403).json({ error: 'Этот набор ещё не опубликован' });
    }
    if (pack.authorId !== req.user.id && !(await canModerateOtherUsersPack(req.user, pack.authorId))) {
      return res.status(403).json({ error: 'Недостаточно прав для изменения этого набора' });
    }
    const updated = await store.renamePack(req.params.id, req.body.title, req.body.description);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/stickers/packs/:id — удалить набор целиком: сам автор, либо
// модератор/владелец (moderate_stickers) над автором строго ниже по
// иерархии — для чистки от спама/нарушений.
router.delete('/stickers/packs/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const pack = await store.getPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Набор не найден' });
    if (pack.status === 'draft' && pack.authorId !== req.user.id) {
      return res.status(403).json({ error: 'Этот набор ещё не опубликован' });
    }
    if (pack.authorId !== req.user.id && !(await canModerateOtherUsersPack(req.user, pack.authorId))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления этого набора' });
    }
    await store.deletePack(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/stickers — загрузить один стикер в свой
// набор (multipart, поле "sticker") + имя (alias) для шорткода.
router.post(
  '/stickers/packs/:id/stickers',
  auth.authenticateToken,
  auth.checkApproved,
  auth.checkNotMuted,
  uploadSticker.single('sticker'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл стикера не загружен' });

      const isAnimated = path.extname(req.file.filename).toLowerCase() === '.gif';
      // req.file.filename тут — только имя файла; сама папка набора уже
      // выбрана multer'ом (stickerStorage.destination в multer-config.js) —
      // req.params.id, а не что-то из тела запроса, поэтому оба места
      // используют один и тот же (доверенный) ID.
      const sticker = await store.addSticker(req.params.id, req.user.id, {
        alias: req.body.alias,
        fileUrl: `/uploads/stickers/${req.params.id}/${req.file.filename}`,
        isAnimated
      });
      res.status(201).json(sticker);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// DELETE /api/stickers/stickers/:id — убрать один стикер из набора: сам
// автор, либо модератор/владелец над автором строго ниже по иерархии.
router.delete('/stickers/stickers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const info = await store.getStickerWithPackAuthor(req.params.id);
    if (!info) return res.status(404).json({ error: 'Стикер не найден' });
    if (info.status === 'draft' && info.authorId !== req.user.id) {
      return res.status(403).json({ error: 'Этот набор ещё не опубликован' });
    }
    if (info.authorId !== req.user.id && !(await canModerateOtherUsersPack(req.user, info.authorId))) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления этого стикера' });
    }
    const removed = await store.deleteSticker(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Стикер не найден' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Коллаборации ---
// Зайдя в чужой одобренный набор, пользователь собирает СВОИ стикеры
// (POST .../collab/stickers), затем предлагает коллаборацию (POST
// .../collab/submit). Автор набора принимает (стикеры вливаются в набор,
// предложивший становится соавтором) или отклоняет (всё удаляется). Подробнее
// — в начале src/services/stickers-store.js.

// POST /api/stickers/packs/:id/collab/stickers — добавить свой стикер в
// черновик коллаборации (multipart, поле "sticker" + alias). Файл ложится в
// папку набора (multer берёт :id из URL), но в сам набор не попадает.
router.post(
  '/stickers/packs/:id/collab/stickers',
  auth.authenticateToken,
  auth.checkApproved,
  auth.checkNotMuted,
  uploadSticker.single('sticker'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл стикера не загружен' });
      try {
        const isAnimated = path.extname(req.file.filename).toLowerCase() === '.gif';
        const sticker = await store.stageCollabSticker(req.user.id, displayName(req.user), req.params.id, {
          alias: req.body.alias,
          fileUrl: `/uploads/stickers/${req.params.id}/${req.file.filename}`,
          isAnimated
        });
        res.status(201).json(sticker);
      } catch (err) {
        // Файл уже записан multer'ом до проверок — не оставляем его сиротой.
        fs.unlink(req.file.path, () => {});
        throw err;
      }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// DELETE /api/stickers/collab/stickers/:id — убрать свой стикер из черновика.
router.delete('/stickers/collab/stickers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.removeCollabSticker(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/collab/submit — предложить коллаборацию
// (необязательное сопроводительное сообщение автору).
router.post('/stickers/packs/:id/collab/submit', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    res.json(await store.submitCollab(req.user.id, req.params.id, req.body.message));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/collab/:id/cancel — отозвать свою заявку (черновик или
// уже отправленную) — все её стикеры удаляются.
router.post('/stickers/collab/:id/cancel', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.cancelCollab(req.user.id, Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/stickers/collab/incoming — ожидающие решения заявки на МОИ наборы.
router.get('/stickers/collab/incoming', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listIncomingCollabs(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stickers/collab/outgoing — мои заявки любого статуса.
router.get('/stickers/collab/outgoing', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listMyCollabs(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stickers/collab/:id/accept — автор принимает заявку: стикеры
// вливаются в набор, предложивший становится соавтором.
router.post('/stickers/collab/:id/accept', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    res.json(await store.acceptCollab(req.user.id, Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/collab/:id/decline — автор отклоняет: всё отменяется.
router.post('/stickers/collab/:id/decline', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.declineCollab(req.user.id, Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/stickers/favorites — избранные стикеры (звёздочка в пикере).
router.get('/stickers/favorites', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.listFavoritesWithStickers(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST/DELETE /api/stickers/stickers/:id/favorite — добавить/убрать один
// стикер из избранного (только из уже добавленного себе набора — см.
// addFavorite в stickers-store.js).
router.post('/stickers/stickers/:id/favorite', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.addFavorite(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/stickers/stickers/:id/favorite', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.removeFavorite(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/subscribe — "добавить набор себе".
router.post('/stickers/packs/:id/subscribe', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.subscribe(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/stickers/packs/:id/subscribe — убрать набор из своих.
router.delete('/stickers/packs/:id/subscribe', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    await store.unsubscribe(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/publish — опубликовать готовый набор:
// черновик уходит в очередь модерации (сам автор).
router.post('/stickers/packs/:id/publish', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    res.json(await store.publishPack(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/unpublish — забрать набор из очереди
// модерации обратно в черновики (сам автор, пока набор ещё не одобрен).
router.post('/stickers/packs/:id/unpublish', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.unpublishPack(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/resubmit — вернуть отклонённый набор на
// повторную модерацию (сам автор, после исправлений).
router.post('/stickers/packs/:id/resubmit', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    res.json(await store.resubmitPack(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Модерация (moderate_stickers) ---

router.get('/stickers/pending', auth.authenticateToken, auth.checkApproved, auth.checkPermission('moderate_stickers'), async (req, res) => {
  try {
    res.json(await store.listPending());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stickers/packs/:id/approve', auth.authenticateToken, auth.checkApproved, auth.checkPermission('moderate_stickers'), async (req, res) => {
  try {
    res.json(await store.approvePack(req.params.id, displayName(req.user)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/stickers/packs/:id/reject', auth.authenticateToken, auth.checkApproved, auth.checkPermission('moderate_stickers'), async (req, res) => {
  try {
    res.json(await store.rejectPack(req.params.id, displayName(req.user), req.body.reason));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/stickers/packs/:id/revoke — отозвать УЖЕ одобренный набор
// (например, по жалобе уже после публикации, не на этапе очереди "На
// модерации" — для неё есть approve/reject выше). В отличие от них — это
// действие не над своей заявкой, а над чужим, уже живым набором, поэтому
// checkPermission('moderate_stickers') тут недостаточно: нужна ещё и
// иерархия (canModerateOtherUsersPack), как при удалении/переименовании
// чужого набора. Собственный набор автор отзывает не через этот эндпоинт —
// у него для этого уже есть "Удалить".
router.post('/stickers/packs/:id/revoke', auth.authenticateToken, auth.checkApproved, auth.checkPermission('moderate_stickers'), async (req, res) => {
  try {
    const pack = await store.getPack(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Набор не найден' });
    if (pack.authorId === req.user.id) {
      return res.status(403).json({ error: 'Нельзя отозвать собственный набор — используйте удаление' });
    }
    if (!(await canModerateOtherUsersPack(req.user, pack.authorId))) {
      return res.status(403).json({ error: 'Недостаточно прав для отзыва этого набора' });
    }
    res.json(await store.revokePack(req.params.id, displayName(req.user), req.body.reason));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
