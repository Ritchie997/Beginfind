// stickers-store.js — наборы стикеров (аналог стикерпаков Telegram).
//
// Жизненный цикл набора: любой одобренный пользователь создаёт набор и
// загружает в него стикеры — набор рождается в статусе 'pending' и НЕ
// работает как шорткод, пока владелец/админ с правом moderate_stickers
// (см. PERMISSION_KEYS в src/db/migrate-users-schema.js) его не одобрит
// ('approved') или не отклонит ('rejected', с причиной).
//
// Использование: набор нужно "добавить себе" (см. sticker_subscriptions) —
// только из добавленных наборов пикер клиента предлагает стикеры при
// отправке комментария/сообщения. Автор набора подписывается на него
// автоматически при создании (см. createPack) — это не обходит модерацию:
// validateContentForPosting всё равно требует status = 'approved'.
//
// Синтаксис использования — ОДИН и тот же шорткод ":slug:alias:" в двух
// режимах, различаемых по контексту на клиенте при рендере (см.
// hasOnlyOneShortcode ниже и public/ibripedia.js):
//   - внутри текста среди прочих слов — маленькая инлайн-картинка ("эмодзи");
//   - когда это ВЕСЬ комментарий (после trim) — крупная отдельная картинка
//     ("стикер"), как отдельное сообщение-стикер в Telegram.
//
// Комментарии (article_comments в social-store.js) как хранили, так и
// хранят обычный TEXT — шорткод в нём такой же текст, как ":slug:alias:".
// Разрешение шорткодов в URL картинок происходит здесь же (resolve*) и
// подключается со стороны src/routes/articles.routes.js, чтобы
// social-store.js не знал о существовании стикеров вообще.

const fs = require('fs');
const path = require('path');
const { stickersDb } = require('../db/connections');
const { slugify } = require('./slugify');
const { STICKERS_DIR } = require('../config/paths');

const MAX_TITLE_LEN = 100;
const MAX_DESCRIPTION_LEN = 200;
const MAX_STICKERS_PER_PACK = 200; // как у Telegram — разумный потолок на набор

// :slug:alias: — обе части используют тот же алфавит, что и slugify()
// (латиница/цифры/дефис), поэтому распознаются и валидные, и "битые" (после
// slugify) названия наборов/стикеров без экранирования спецсимволов.
// Регистр в самом regex ('i') и латинские заглавные в классе символов —
// специально: slug/alias в БД всегда строчные (slugify всегда lowercase), но
// многие пользователи пришли из Discord и по привычке набирают шорткод
// руками в произвольном регистре (":MyPack:Hello:"). Раньше такой шорткод
// просто не распознавался этим regex'ом — оставался обычным текстом.
// extractShortcodes ниже приводит найденные пары к нижнему регистру перед
// использованием как ключа — сравнение со slug/alias в БД остаётся точным.
const SHORTCODE_RE = /:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):/g;

function run(sql, params) {
  return new Promise((resolve, reject) => {
    stickersDb.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function get(sql, params) {
  return new Promise((resolve, reject) => {
    stickersDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params) {
  return new Promise((resolve, reject) => {
    stickersDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function rowToPack(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || '',
    authorId: row.author_id,
    authorName: row.author_name,
    status: row.status,
    rejectReason: row.reject_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

function rowToSticker(row) {
  return {
    id: row.id,
    packId: row.pack_id,
    alias: row.alias,
    fileUrl: row.file_url,
    isAnimated: !!row.is_animated,
    position: row.position,
    createdAt: row.created_at
  };
}

// Уникальный slug для нового набора: berём slugify(title), а при коллизии
// (набор с таким названием уже есть) добавляем числовой суффикс — тем же
// приёмом, каким articles-store.js избегает коллизий slug статей.
async function makeUniquePackSlug(title) {
  const base = slugify(title) || 'pack';
  let candidate = base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await get('SELECT id FROM sticker_packs WHERE slug = ?', [candidate]);
    if (!existing) return candidate;
    candidate = `${base}-${n++}`;
  }
}

async function createPack(userId, userName, title, description) {
  const trimmedTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!trimmedTitle) throw new Error('Название набора не может быть пустым');
  const trimmedDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION_LEN);

  const slug = await makeUniquePackSlug(trimmedTitle);
  const result = await run(
    'INSERT INTO sticker_packs (slug, title, description, author_id, author_name, status) VALUES (?, ?, ?, ?, ?, ?)',
    [slug, trimmedTitle, trimmedDescription || null, userId, userName, 'pending']
  );
  // Автор автоматически "добавляет себе" собственный набор — не приходится
  // отдельно искать его в каталоге сразу после создания; на возможность
  // использования (approved) это не влияет.
  await run('INSERT OR IGNORE INTO sticker_subscriptions (user_id, pack_id) VALUES (?, ?)', [userId, result.lastID]);
  return getPackWithStickers(result.lastID);
}

async function getPack(packId) {
  const row = await get('SELECT * FROM sticker_packs WHERE id = ?', [packId]);
  return row ? rowToPack(row) : null;
}

async function getPackWithStickers(packId) {
  const pack = await getPack(packId);
  if (!pack) return null;
  const stickerRows = await all('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position ASC, id ASC', [packId]);
  return { ...pack, stickers: stickerRows.map(rowToSticker) };
}

async function attachStickerCounts(packs) {
  if (!packs.length) return packs;
  const placeholders = packs.map(() => '?').join(',');
  const rows = await all(
    `SELECT pack_id, COUNT(*) as count FROM stickers WHERE pack_id IN (${placeholders}) GROUP BY pack_id`,
    packs.map((p) => p.id)
  );
  const counts = new Map(rows.map((r) => [r.pack_id, r.count]));
  return packs.map((p) => ({ ...p, stickersCount: counts.get(p.id) || 0 }));
}

// Довешивает на каждый набор первые несколько стикеров (не все — только для
// превью карточки, см. renderProfileStickers в public/spa-router.js) поверх
// уже посчитанного stickersCount. Отдельный запрос на набор — их всё равно
// немного (список одного автора), не стоит городить оконные функции ради
// LIMIT per group в SQLite.
async function attachStickerPreviews(packs, limit = 4) {
  if (!packs.length) return packs;
  const result = [];
  for (const p of packs) {
    const rows = await all('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position ASC, id ASC LIMIT ?', [p.id, limit]);
    result.push({ ...p, stickers: rows.map(rowToSticker) });
  }
  return result;
}

// Наборы конкретного автора — параметризованная версия для вкладки "Наборы
// стикеров" в профиле (см. GET /api/stickers/by-user/:userId): сам автор
// видит все свои наборы, включая pending/rejected (includeAllStatuses),
// посторонним показываем только то, что прошло модерацию — публичная
// витрина чужого профиля не должна выдавать черновики.
async function listPacksByAuthor(authorId, includeAllStatuses) {
  const rows = includeAllStatuses
    ? await all('SELECT * FROM sticker_packs WHERE author_id = ? ORDER BY created_at DESC', [authorId])
    : await all("SELECT * FROM sticker_packs WHERE author_id = ? AND status = 'approved' ORDER BY created_at DESC", [authorId]);
  const packs = await attachStickerCounts(rows.map(rowToPack));
  return attachStickerPreviews(packs);
}

// Наборы, загруженные самим пользователем (любого статуса — свои pending и
// rejected он должен видеть, чтобы понимать, что происходит с заявкой).
async function listMyPacks(userId) {
  return listPacksByAuthor(userId, true);
}

// Каталог: только одобренные наборы, с пометкой, добавил ли их себе userId —
// см. "добавить набор себе" в src/routes/stickers.routes.js.
async function listCatalog(userId, search) {
  const q = String(search || '').trim();
  let rows;
  if (q) {
    rows = await all(
      "SELECT * FROM sticker_packs WHERE status = 'approved' AND title LIKE ? ORDER BY created_at DESC",
      [`%${q}%`]
    );
  } else {
    rows = await all("SELECT * FROM sticker_packs WHERE status = 'approved' ORDER BY created_at DESC");
  }
  const counted = await attachStickerCounts(rows.map(rowToPack));
  if (!counted.length) return counted;
  const packs = await attachStickerPreviews(counted);

  const subRows = await all(
    `SELECT pack_id FROM sticker_subscriptions WHERE user_id = ? AND pack_id IN (${packs.map(() => '?').join(',')})`,
    [userId, ...packs.map((p) => p.id)]
  );
  const subscribed = new Set(subRows.map((r) => r.pack_id));
  return packs.map((p) => ({ ...p, subscribed: subscribed.has(p.id), isOwn: p.authorId === userId }));
}

// Наборы, добавленные пользователем себе — вместе со стикерами, для пикера
// в форме комментария/сообщения. Только approved: если пак разжаловали из
// approved уже после того как на него подписались, он не должен всплывать.
async function listSubscribedWithStickers(userId) {
  const rows = await all(
    `SELECT p.* FROM sticker_packs p
     JOIN sticker_subscriptions sub ON sub.pack_id = p.id AND sub.user_id = ?
     WHERE p.status = 'approved'
     ORDER BY sub.created_at ASC`,
    [userId]
  );
  const packs = rows.map(rowToPack);
  const result = [];
  for (const pack of packs) {
    const stickerRows = await all('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position ASC, id ASC', [pack.id]);
    result.push({ ...pack, stickers: stickerRows.map(rowToSticker) });
  }
  return result;
}

async function isSubscribed(userId, packId) {
  const row = await get('SELECT id FROM sticker_subscriptions WHERE user_id = ? AND pack_id = ?', [userId, packId]);
  return !!row;
}

async function subscribe(userId, packId) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.status !== 'approved') throw new Error('Набор ещё не подтверждён модератором');
  await run('INSERT OR IGNORE INTO sticker_subscriptions (user_id, pack_id) VALUES (?, ?)', [userId, packId]);
  return getPackWithStickers(packId);
}

async function unsubscribe(userId, packId) {
  await run('DELETE FROM sticker_subscriptions WHERE user_id = ? AND pack_id = ?', [userId, packId]);
}

// ===== Избранные стикеры (звёздочка в пикере — public/ibripedia.js) =====
//
// В избранное можно добавить только стикер из набора, который пользователь
// уже добавил себе (см. вопрос "Источник избранного" — по решению владельца,
// не любой встреченный стикер). При отписке от набора favorite-запись не
// удаляется сама — listFavorites просто перестаёт её возвращать (JOIN на
// sticker_subscriptions ниже), пока пользователь не подпишется обратно; так
// избранное не "теряется" из-за случайной отписки.

async function addFavorite(userId, stickerId) {
  const sticker = await get('SELECT s.*, p.status as pack_status FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.id = ?', [stickerId]);
  if (!sticker) throw new Error('Стикер не найден');
  if (sticker.pack_status !== 'approved' || !(await isSubscribed(userId, sticker.pack_id))) {
    throw new Error('В избранное можно добавить только стикер из уже добавленного себе набора');
  }
  await run('INSERT OR IGNORE INTO sticker_favorites (user_id, sticker_id) VALUES (?, ?)', [userId, stickerId]);
  return true;
}

async function removeFavorite(userId, stickerId) {
  await run('DELETE FROM sticker_favorites WHERE user_id = ? AND sticker_id = ?', [userId, stickerId]);
  return true;
}

// Стикеры, ранее добавленные в избранное — только пока их набор ещё
// approved И пользователь всё ещё на него подписан (см. комментарий выше);
// иначе избранный стикер вёл бы на шорткод, который validateContentForPosting
// тут же отклонил бы при попытке отправить. packSlug/packTitle — чтобы
// собрать шорткод и подписать источник в UI (см. renderStickerPickerBody).
async function listFavoritesWithStickers(userId) {
  const rows = await all(
    `SELECT s.*, p.slug as pack_slug, p.title as pack_title
     FROM sticker_favorites f
     JOIN stickers s ON s.id = f.sticker_id
     JOIN sticker_packs p ON p.id = s.pack_id
     JOIN sticker_subscriptions sub ON sub.pack_id = p.id AND sub.user_id = f.user_id
     WHERE f.user_id = ? AND p.status = 'approved'
     ORDER BY f.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...rowToSticker(r), packSlug: r.pack_slug, packTitle: r.pack_title }));
}

// Каждый набор хранит свои файлы в STICKERS_DIR/<packId>/ (см.
// src/uploads/multer-config.js) — fileUrl вида
// /uploads/stickers/<packId>/<filename>, поэтому наружу отдаём и путь к
// файлу, и путь к самой папке набора (для полной очистки при удалении
// набора целиком, см. deletePack).
function packDir(packId) {
  return path.join(STICKERS_DIR, String(packId));
}

function unlinkQuietly(fileUrl) {
  if (!fileUrl) return;
  // basename(dirname(...)) — сегмент с ID набора из /uploads/stickers/<id>/<file>,
  // а не жёстко переданный packId: unlinkQuietly вызывается и для одиночного
  // стикера (deleteSticker), где под рукой есть только сама запись стикера.
  const filePath = path.join(STICKERS_DIR, path.basename(path.dirname(fileUrl)), path.basename(fileUrl));
  fs.unlink(filePath, () => {}); // не критично, если файла уже нет
}

async function addSticker(packId, userId, { alias, fileUrl, isAnimated }) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== userId) throw new Error('Редактировать этот набор может только его автор');

  const count = await get('SELECT COUNT(*) as count FROM stickers WHERE pack_id = ?', [packId]);
  if ((count?.count || 0) >= MAX_STICKERS_PER_PACK) {
    throw new Error(`В наборе не может быть больше ${MAX_STICKERS_PER_PACK} стикеров`);
  }

  const aliasSlug = slugify(alias || '');
  if (!aliasSlug) throw new Error('Укажите имя стикера (латиницей/цифрами)');

  const existing = await get('SELECT id FROM stickers WHERE pack_id = ? AND alias = ?', [packId, aliasSlug]);
  if (existing) throw new Error(`В наборе уже есть стикер с именем «${aliasSlug}»`);

  const posRow = await get('SELECT COALESCE(MAX(position), -1) as maxPos FROM stickers WHERE pack_id = ?', [packId]);
  const result = await run(
    'INSERT INTO stickers (pack_id, alias, file_url, is_animated, position) VALUES (?, ?, ?, ?, ?)',
    [packId, aliasSlug, fileUrl, isAnimated ? 1 : 0, (posRow?.maxPos ?? -1) + 1]
  );
  const row = await get('SELECT * FROM stickers WHERE id = ?', [result.lastID]);
  return rowToSticker(row);
}

// Кто вправе удалить этот стикер (сам автор набора, или модератор/владелец —
// см. canModerateOtherUsersPack в src/routes/stickers.routes.js) решается в
// роуте ДО вызова этой функции — она сама уже не проверяет авторство, только
// удаляет. authorId в ответе нужен роуту именно для этой проверки — без
// отдельного запроса ходить в JOIN stickers+sticker_packs самому.
async function getStickerWithPackAuthor(stickerId) {
  const row = await get(
    `SELECT s.id, s.pack_id as packId, p.author_id as authorId
     FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
     WHERE s.id = ?`,
    [stickerId]
  );
  return row || null;
}

async function deleteSticker(stickerId) {
  const sticker = await get('SELECT * FROM stickers WHERE id = ?', [stickerId]);
  if (!sticker) return false;

  await run('DELETE FROM sticker_favorites WHERE sticker_id = ?', [stickerId]);
  await run('DELETE FROM stickers WHERE id = ?', [stickerId]);
  unlinkQuietly(sticker.file_url);
  return true;
}

// Переименование + описание — одна и та же форма "изменить набор" в
// stickers-manager.js, поэтому один запрос/один метод. description
// необязателен: undefined — не трогаем текущее значение (например, старый
// клиент шлёт только title), пустая строка — осознанно очищаем.
// Кто вправе переименовать чужой набор — решается в роуте (см.
// canModerateOtherUsersPack в src/routes/stickers.routes.js) до вызова.
async function renamePack(packId, title, description) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  const trimmedTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!trimmedTitle) throw new Error('Название набора не может быть пустым');

  if (description === undefined) {
    await run('UPDATE sticker_packs SET title = ? WHERE id = ?', [trimmedTitle, packId]);
  } else {
    const trimmedDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION_LEN);
    await run('UPDATE sticker_packs SET title = ?, description = ? WHERE id = ?', [trimmedTitle, trimmedDescription || null, packId]);
  }
  return getPackWithStickers(packId);
}

// Автор или модератор (проверка права и иерархии — на уровне маршрута, см.
// canModerateOtherUsersPack в src/routes/stickers.routes.js) может удалить
// набор целиком: сами файлы стикеров с диска тоже удаляются — теперь просто
// сносом всей папки набора (packDir), а не поштучным unlink по file_url —
// заодно подчищает и файлы-сироты, если такие в ней когда-то оказались.
async function deletePack(packId) {
  const pack = await getPack(packId);
  if (!pack) return false;

  await run('DELETE FROM sticker_favorites WHERE sticker_id IN (SELECT id FROM stickers WHERE pack_id = ?)', [packId]);
  await run('DELETE FROM stickers WHERE pack_id = ?', [packId]);
  await run('DELETE FROM sticker_subscriptions WHERE pack_id = ?', [packId]);
  await run('DELETE FROM sticker_packs WHERE id = ?', [packId]);
  fs.rm(packDir(packId), { recursive: true, force: true }, () => {}); // не критично, если папки уже нет
  return true;
}

async function listPending() {
  const rows = await all("SELECT * FROM sticker_packs WHERE status = 'pending' ORDER BY created_at ASC");
  const packs = rows.map(rowToPack);
  const result = [];
  for (const pack of packs) {
    const stickerRows = await all('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position ASC, id ASC', [pack.id]);
    result.push({ ...pack, stickers: stickerRows.map(rowToSticker) });
  }
  return result;
}

async function approvePack(packId, moderatorName) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  const stickerCount = await get('SELECT COUNT(*) as count FROM stickers WHERE pack_id = ?', [packId]);
  if (!stickerCount?.count) throw new Error('Нельзя подтвердить пустой набор — в нём нет ни одного стикера');
  await run(
    "UPDATE sticker_packs SET status = 'approved', reject_reason = NULL, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [moderatorName, packId]
  );
  return getPackWithStickers(packId);
}

async function rejectPack(packId, moderatorName, reason) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  await run(
    "UPDATE sticker_packs SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [String(reason || '').trim().slice(0, 500) || null, moderatorName, packId]
  );
  return getPackWithStickers(packId);
}

// Отозвать УЖЕ одобренный набор — в отличие от rejectPack (решение по ещё
// не рассмотренной заявке в очереди "На модерации"), это реакция на набор,
// который уже был опубликован и использовался (например, по жалобе). Право
// на это — только у модератора/владельца по отношению к автору строго ниже
// по иерархии (см. canModerateOtherUsersPack в src/routes/stickers.routes.js),
// собственный набор автор отзывать не может — у него для этого есть
// "Удалить". Статус после отзыва тот же 'rejected', что и у обычного
// отклонения — шорткоды набора сразу перестают резолвиться (resolveCodes
// фильтрует по status = 'approved'), а автор может отправить его повторно
// на модерацию через resubmitPack, как после обычного отклонения.
async function revokePack(packId, moderatorName, reason) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.status !== 'approved') throw new Error('Отозвать можно только уже подтверждённый набор');
  await run(
    "UPDATE sticker_packs SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [String(reason || '').trim().slice(0, 500) || 'Одобрение отозвано администратором', moderatorName, packId]
  );
  return getPackWithStickers(packId);
}

// Автор возвращает отклонённый набор на повторную модерацию — например,
// после того как заменил спорный стикер.
async function resubmitPack(userId, packId) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== userId) throw new Error('Отправить набор на повторную модерацию может только его автор');
  if (pack.status !== 'rejected') throw new Error('На повторную модерацию можно отправить только отклонённый набор');
  await run("UPDATE sticker_packs SET status = 'pending', reject_reason = NULL WHERE id = ?", [packId]);
  return getPackWithStickers(packId);
}

function extractShortcodes(content) {
  const codes = new Set();
  let m;
  SHORTCODE_RE.lastIndex = 0;
  while ((m = SHORTCODE_RE.exec(String(content || '')))) {
    // toLowerCase() — регистр набора/стикера в самом тексте может быть
    // любым (см. комментарий у SHORTCODE_RE), а slug/alias в БД всегда
    // строчные, так что ключ для сравнения/резолва должен быть строчным.
    codes.add(`${m[1].toLowerCase()}:${m[2].toLowerCase()}`);
  }
  return [...codes];
}

// Ровно один шорткод, занимающий ВЕСЬ текст (после trim) — признак "это
// стикер, а не эмодзи в тексте" на клиенте (см. formatCommentContent в
// public/ibripedia.js). Экспортируем ту же проверку и на сервер, вдруг
// понадобится (например, для будущих чатов) — незачем дублировать regex.
function isStandaloneShortcode(content) {
  const trimmed = String(content || '').trim();
  const match = trimmed.match(/^:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):$/);
  return !!match;
}

async function getSubscribedAliasSet(userId) {
  const rows = await all(
    `SELECT p.slug as packSlug, s.alias as alias FROM stickers s
     JOIN sticker_packs p ON p.id = s.pack_id
     JOIN sticker_subscriptions sub ON sub.pack_id = p.id AND sub.user_id = ?
     WHERE p.status = 'approved'`,
    [userId]
  );
  return new Set(rows.map((r) => `${r.packSlug}:${r.alias}`));
}

// Проверка ПЕРЕД сохранением комментария/сообщения: каждый использованный
// шорткод должен вести на одобренный набор, который автор добавил себе —
// иначе можно было бы вписать шорткод чужого/ещё не подтверждённого набора
// руками, не проходя через пикер.
async function validateContentForPosting(userId, content) {
  const codes = extractShortcodes(content);
  if (!codes.length) return;
  const allowed = await getSubscribedAliasSet(userId);
  const invalid = codes.filter((c) => !allowed.has(c));
  if (invalid.length) {
    throw new Error(`Неизвестный или недоступный стикер: ${invalid.map((c) => `:${c}:`).join(', ')}`);
  }
}

// Та же проверка, что validateContentForPosting, но для ОДНОГО шорткода
// вне текста — реакция на статью/комментарий (см. POST .../reactions/toggle
// в articles.routes.js) хранит голый шорткод, а не текст с ним внутри.
async function canUseShortcode(userId, code) {
  const allowed = await getSubscribedAliasSet(userId);
  return allowed.has(code);
}

// Разрешает список шорткодов ("slug:alias") ОДНИМ запросом в
// Map<"slug:alias", {url, animated, packTitle, packId}> — используется и
// для текста (см. resolveShortcodesInTexts ниже), и напрямую для реакций
// (см. GET .../reactions в articles.routes.js — там шорткоды уже готовым
// списком, а не спрятаны в тексте). packId нужен клиенту (см.
// public/ibripedia.js), чтобы по клику на стикер открыть его набор целиком
// (просмотр + добавить/убрать себе — public/sticker-pack-view.js).
async function resolveCodes(codes) {
  const list = [...new Set(codes)].filter(Boolean);
  if (!list.length) return new Map();

  const pairs = list.map((c) => c.split(':'));
  const placeholders = pairs.map(() => '(p.slug = ? AND s.alias = ?)').join(' OR ');
  const params = pairs.flat();
  const rows = await all(
    `SELECT p.id as packId, p.slug as packSlug, p.title as packTitle, s.alias, s.file_url, s.is_animated
     FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id
     WHERE p.status = 'approved' AND (${placeholders})`,
    params
  );

  const map = new Map();
  rows.forEach((r) => {
    map.set(`${r.packSlug}:${r.alias}`, { url: r.file_url, animated: !!r.is_animated, packTitle: r.packTitle, packId: r.packId });
  });
  return map;
}

// То же самое, но шорткоды сперва достаются из массива текстов (например,
// все комментарии страницы) — используется, чтобы не делать по запросу к БД
// на каждый комментарий.
async function resolveShortcodesInTexts(texts) {
  const codes = new Set();
  (texts || []).forEach((t) => extractShortcodes(t).forEach((c) => codes.add(c)));
  return resolveCodes([...codes]);
}

// Достраивает поле `.stickers` (Object, не Map — чтобы легко ушло в JSON) на
// каждый объект из списка с полем `.content` — используется для комментариев
// статей (см. src/routes/articles.routes.js), но не завязан на их форму
// специально, чтобы будущий чат мог переиспользовать без изменений.
async function attachStickersToItems(items) {
  const map = await resolveShortcodesInTexts(items.map((i) => i.content));
  if (!map.size) return items.map((i) => ({ ...i, stickers: {} }));

  return items.map((item) => {
    const codes = extractShortcodes(item.content);
    const stickers = {};
    codes.forEach((c) => {
      if (map.has(c)) stickers[c] = map.get(c);
    });
    return { ...item, stickers };
  });
}

module.exports = {
  MAX_STICKERS_PER_PACK,
  MAX_DESCRIPTION_LEN,
  createPack,
  getPack,
  getPackWithStickers,
  listMyPacks,
  listPacksByAuthor,
  listCatalog,
  listSubscribedWithStickers,
  isSubscribed,
  subscribe,
  unsubscribe,
  addFavorite,
  removeFavorite,
  listFavoritesWithStickers,
  addSticker,
  deleteSticker,
  getStickerWithPackAuthor,
  renamePack,
  deletePack,
  listPending,
  approvePack,
  rejectPack,
  revokePack,
  resubmitPack,
  extractShortcodes,
  isStandaloneShortcode,
  validateContentForPosting,
  canUseShortcode,
  resolveCodes,
  resolveShortcodesInTexts,
  attachStickersToItems
};
