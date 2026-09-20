// stickers-store.js — наборы стикеров (аналог стикерпаков Telegram).
//
// Жизненный цикл набора: создание и публикация — два разных шага.
//   1. Любой одобренный пользователь создаёт набор и загружает в него
//      стикеры — набор рождается в статусе 'draft' (черновик): виден только
//      автору, в очередь модерации и в каталог не попадает, работать как
//      шорткод не может. Держать набор черновиком можно сколько угодно.
//   2. Когда набор готов, автор явно публикует его (publishPack) — статус
//      становится 'pending' ("на модерации"). Пока он там, автор может
//      передумать и вернуть его в черновики (unpublishPack).
//   3. Владелец/админ с правом moderate_stickers (см. PERMISSION_KEYS в
//      src/db/migrate-users-schema.js) одобряет набор ('approved') или
//      отклоняет ('rejected', с причиной); отклонённый автор правит и
//      отправляет повторно (resubmitPack).
// Столбец status — обычный TEXT без CHECK, поэтому новое значение 'draft' не
// требует миграции; ранее созданные наборы остаются в своих статусах.
//
// Коллаборации: зайдя в ЧУЖОЙ одобренный набор, пользователь может собрать
// свои стикеры (они хранятся отдельно, см. sticker_collab_stickers) и
// предложить автору коллаборацию. Автор видит предложение в разделе
// "Стикеры" и принимает или отклоняет его:
//   - принял — стикеры вливаются в набор (при совпадении имени получают
//     числовой суффикс), автор заявки становится соавтором набора;
//   - отклонил (или сам автор заявки отозвал) — стикеры удаляются, набор не
//     меняется, "всё отменяется".
// Заявка имеет статусы draft → pending → accepted | declined (см. комментарий
// у таблицы в src/db/connections.js).
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

// Новый набор — всегда черновик (см. жизненный цикл выше): публикация — отдельное
// осознанное действие автора, а не побочный эффект создания.
async function createPack(userId, userName, title, description) {
  const trimmedTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!trimmedTitle) throw new Error('Название набора не может быть пустым');
  const trimmedDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION_LEN);

  const slug = await makeUniquePackSlug(trimmedTitle);
  const result = await run(
    'INSERT INTO sticker_packs (slug, title, description, author_id, author_name, status) VALUES (?, ?, ?, ?, ?, ?)',
    [slug, trimmedTitle, trimmedDescription || null, userId, userName, 'draft']
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

// Довешивает на наборы список соавторов (coAuthors: [{userId, name}]) —
// появляются после принятой коллаборации, см. acceptCollab ниже.
async function attachCoAuthors(packs) {
  if (!packs.length) return packs;
  const rows = await all(
    `SELECT pack_id, user_id, user_name FROM sticker_pack_coauthors WHERE pack_id IN (${packs.map(() => '?').join(',')}) ORDER BY created_at ASC`,
    packs.map((p) => p.id)
  );
  const byPack = new Map();
  rows.forEach((r) => {
    if (!byPack.has(r.pack_id)) byPack.set(r.pack_id, []);
    byPack.get(r.pack_id).push({ userId: r.user_id, name: r.user_name });
  });
  return packs.map((p) => ({ ...p, coAuthors: byPack.get(p.id) || [] }));
}

async function getPackWithStickers(packId) {
  const pack = await getPack(packId);
  if (!pack) return null;
  const stickerRows = await all('SELECT * FROM stickers WHERE pack_id = ? ORDER BY position ASC, id ASC', [packId]);
  const [withCoAuthors] = await attachCoAuthors([pack]);
  return { ...withCoAuthors, stickers: stickerRows.map(rowToSticker) };
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
//
// includeCoAuthored — добавить одобренные наборы, где пользователь СОАВТОР
// (помечены isCoAuthor) — для витрины профиля. В "Мои наборы"
// (listMyPacks) их не добавляем: управлять чужим набором (загружать/
// удалять/переименовывать) соавтор не может.
async function listPacksByAuthor(authorId, includeAllStatuses, includeCoAuthored = false) {
  const rows = includeAllStatuses
    ? await all('SELECT * FROM sticker_packs WHERE author_id = ? ORDER BY created_at DESC', [authorId])
    : await all("SELECT * FROM sticker_packs WHERE author_id = ? AND status = 'approved' ORDER BY created_at DESC", [authorId]);
  let packs = rows.map(rowToPack);

  if (includeCoAuthored) {
    const coRows = await all(
      `SELECT p.* FROM sticker_packs p
       JOIN sticker_pack_coauthors c ON c.pack_id = p.id AND c.user_id = ?
       WHERE p.status = 'approved' AND p.author_id != ?
       ORDER BY p.created_at DESC`,
      [authorId, authorId]
    );
    packs = packs.concat(coRows.map((r) => ({ ...rowToPack(r), isCoAuthor: true })));
  }

  const counted = await attachStickerCounts(packs);
  const withPreviews = await attachStickerPreviews(counted);
  return attachCoAuthors(withPreviews);
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
  const packs = await attachCoAuthors(await attachStickerPreviews(counted));

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
    `SELECT s.id, s.pack_id as packId, p.author_id as authorId, p.status as status
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
  // Заявки коллабораций и их стикеры (файлы лежат в той же папке набора и
  // уходят вместе с ней ниже), а также соавторы.
  await run('DELETE FROM sticker_collab_stickers WHERE request_id IN (SELECT id FROM sticker_collab_requests WHERE pack_id = ?)', [packId]);
  await run('DELETE FROM sticker_collab_requests WHERE pack_id = ?', [packId]);
  await run('DELETE FROM sticker_pack_coauthors WHERE pack_id = ?', [packId]);
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
  if (pack.status === 'draft') throw new Error('Набор ещё не опубликован автором');
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
  if (pack.status === 'draft') throw new Error('Набор ещё не опубликован автором');
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

// Автор публикует готовый набор: черновик уходит на модерацию. Пустой набор
// публиковать нельзя — approvePack всё равно отказал бы ему, так что
// говорим об этом сразу, а не после ожидания в очереди.
async function publishPack(userId, packId) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== userId) throw new Error('Опубликовать набор может только его автор');
  if (pack.status !== 'draft') throw new Error('Опубликовать можно только черновик');
  const stickerCount = await get('SELECT COUNT(*) as count FROM stickers WHERE pack_id = ?', [packId]);
  if (!stickerCount?.count) throw new Error('Добавьте в набор хотя бы один стикер, прежде чем публиковать его');
  await run("UPDATE sticker_packs SET status = 'pending', reject_reason = NULL WHERE id = ?", [packId]);
  return getPackWithStickers(packId);
}

// Автор забирает набор из очереди модерации обратно в черновики — например,
// вспомнил, что не доделал. Одобренный набор так не отозвать: на него уже
// могли подписаться и использовать в комментариях (для этого — удаление).
async function unpublishPack(userId, packId) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== userId) throw new Error('Вернуть набор в черновики может только его автор');
  if (pack.status !== 'pending') throw new Error('В черновики можно вернуть только набор, ожидающий модерации');
  await run("UPDATE sticker_packs SET status = 'draft' WHERE id = ?", [packId]);
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

// ===== Коллаборации =====

const MAX_COLLAB_MESSAGE_LEN = 300;

function rowToCollabRequest(row) {
  return {
    id: row.id,
    packId: row.pack_id,
    proposerId: row.proposer_id,
    proposerName: row.proposer_name,
    status: row.status,
    message: row.message || '',
    stickersCount: row.stickers_count || 0,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at
  };
}

async function getCollabStickers(requestId) {
  const rows = await all('SELECT * FROM sticker_collab_stickers WHERE request_id = ? ORDER BY position ASC, id ASC', [requestId]);
  return rows.map(rowToSticker);
}

async function getCollabRequestRow(requestId) {
  return get('SELECT * FROM sticker_collab_requests WHERE id = ?', [requestId]);
}

// Текущая (draft/pending) заявка пользователя на этот набор со стикерами —
// у пользователя на один набор одновременно не больше одной активной заявки.
async function getMyCollab(userId, packId) {
  const row = await get(
    "SELECT * FROM sticker_collab_requests WHERE pack_id = ? AND proposer_id = ? AND status IN ('draft', 'pending') ORDER BY id DESC LIMIT 1",
    [packId, userId]
  );
  if (!row) return null;
  return { ...rowToCollabRequest(row), stickers: await getCollabStickers(row.id) };
}

// Добавить свой стикер в "черновик коллаборации" чужого набора. Заявка
// создаётся при первом же стикере; пока она draft, стикеры можно добавлять и
// убирать. В сам набор они не попадают — только после принятия автором.
async function stageCollabSticker(userId, userName, packId, { alias, fileUrl, isAnimated }) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.status !== 'approved') throw new Error('Предлагать коллаборацию можно только к опубликованному набору');
  if (pack.authorId === userId) throw new Error('Это ваш набор — добавляйте стикеры в него напрямую');

  let request = await get(
    "SELECT * FROM sticker_collab_requests WHERE pack_id = ? AND proposer_id = ? AND status IN ('draft', 'pending') ORDER BY id DESC LIMIT 1",
    [packId, userId]
  );
  if (request && request.status === 'pending') {
    throw new Error('Предложение уже отправлено автору — чтобы изменить стикеры, сначала отзовите его');
  }

  const aliasSlug = slugify(alias || '');
  if (!aliasSlug) throw new Error('Укажите имя стикера (латиницей/цифрами)');

  const packCount = await get('SELECT COUNT(*) as count FROM stickers WHERE pack_id = ?', [packId]);
  const stagedCount = request
    ? await get('SELECT COUNT(*) as count FROM sticker_collab_stickers WHERE request_id = ?', [request.id])
    : { count: 0 };
  if ((packCount?.count || 0) + (stagedCount?.count || 0) >= MAX_STICKERS_PER_PACK) {
    throw new Error(`В наборе не может быть больше ${MAX_STICKERS_PER_PACK} стикеров — места для новых уже нет`);
  }

  if (request) {
    const dup = await get('SELECT id FROM sticker_collab_stickers WHERE request_id = ? AND alias = ?', [request.id, aliasSlug]);
    if (dup) throw new Error(`В вашем предложении уже есть стикер с именем «${aliasSlug}»`);
  }

  if (!request) {
    const created = await run(
      'INSERT INTO sticker_collab_requests (pack_id, proposer_id, proposer_name, status) VALUES (?, ?, ?, ?)',
      [packId, userId, userName, 'draft']
    );
    request = await getCollabRequestRow(created.lastID);
  }

  const posRow = await get('SELECT COALESCE(MAX(position), -1) as maxPos FROM sticker_collab_stickers WHERE request_id = ?', [request.id]);
  const result = await run(
    'INSERT INTO sticker_collab_stickers (request_id, alias, file_url, is_animated, position) VALUES (?, ?, ?, ?, ?)',
    [request.id, aliasSlug, fileUrl, isAnimated ? 1 : 0, (posRow?.maxPos ?? -1) + 1]
  );
  const row = await get('SELECT * FROM sticker_collab_stickers WHERE id = ?', [result.lastID]);
  return rowToSticker(row);
}

// Убрать свой стикер из ЧЕРНОВИКА заявки (после отправки — только отозвать
// заявку целиком, см. cancelCollab).
async function removeCollabSticker(userId, stickerId) {
  const sticker = await get('SELECT * FROM sticker_collab_stickers WHERE id = ?', [stickerId]);
  if (!sticker) throw new Error('Стикер не найден');
  const request = await getCollabRequestRow(sticker.request_id);
  if (!request || request.proposer_id !== userId) throw new Error('Это не ваш стикер');
  if (request.status !== 'draft') throw new Error('Предложение уже отправлено — чтобы изменить стикеры, сначала отзовите его');

  await run('DELETE FROM sticker_collab_stickers WHERE id = ?', [stickerId]);
  unlinkQuietly(sticker.file_url);
  return true;
}

// Отправить собранные стикеры автору набора на рассмотрение.
async function submitCollab(userId, packId, message) {
  const pack = await getPack(packId);
  if (!pack) throw new Error('Набор не найден');
  if (pack.status !== 'approved') throw new Error('Предлагать коллаборацию можно только к опубликованному набору');

  const request = await get(
    "SELECT * FROM sticker_collab_requests WHERE pack_id = ? AND proposer_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1",
    [packId, userId]
  );
  if (!request) throw new Error('Сначала добавьте свои стикеры');
  const staged = await get('SELECT COUNT(*) as count FROM sticker_collab_stickers WHERE request_id = ?', [request.id]);
  if (!staged?.count) throw new Error('Сначала добавьте хотя бы один свой стикер');

  const trimmed = String(message || '').trim().slice(0, MAX_COLLAB_MESSAGE_LEN);
  await run(
    "UPDATE sticker_collab_requests SET status = 'pending', message = ?, stickers_count = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?",
    [trimmed || null, staged.count, request.id]
  );
  return getMyCollab(userId, packId);
}

// Стёрать стикеры заявки с диска и из БД (при отзыве/отклонении).
async function discardCollabStickers(requestId) {
  const rows = await all('SELECT file_url FROM sticker_collab_stickers WHERE request_id = ?', [requestId]);
  rows.forEach((r) => unlinkQuietly(r.file_url));
  await run('DELETE FROM sticker_collab_stickers WHERE request_id = ?', [requestId]);
}

// Автор заявки отзывает её (draft или pending): всё, что он собрал,
// удаляется, сама заявка — тоже.
async function cancelCollab(userId, requestId) {
  const request = await getCollabRequestRow(requestId);
  if (!request) throw new Error('Предложение не найдено');
  if (request.proposer_id !== userId) throw new Error('Отозвать предложение может только его автор');
  if (request.status !== 'draft' && request.status !== 'pending') throw new Error('Это предложение уже рассмотрено');

  await discardCollabStickers(requestId);
  await run('DELETE FROM sticker_collab_requests WHERE id = ?', [requestId]);
  return true;
}

// Довешивает на заявки название набора/slug и стикеры (первые previewLimit —
// для превью карточки, либо все при previewLimit = null).
async function decorateCollabRequests(requests, previewLimit = null) {
  const result = [];
  for (const r of requests) {
    const pack = await getPack(r.packId);
    const stickers = await getCollabStickers(r.id);
    result.push({
      ...r,
      packTitle: pack ? pack.title : 'Набор удалён',
      packSlug: pack ? pack.slug : null,
      packAuthorName: pack ? pack.authorName : null,
      stickers: previewLimit ? stickers.slice(0, previewLimit) : stickers,
      stickersCount: r.status === 'draft' || r.status === 'pending' ? stickers.length : r.stickersCount
    });
  }
  return result;
}

// Входящие: ожидающие решения заявки на МОИ наборы (для раздела "Стикеры").
async function listIncomingCollabs(authorId) {
  const rows = await all(
    `SELECT r.* FROM sticker_collab_requests r
     JOIN sticker_packs p ON p.id = r.pack_id
     WHERE p.author_id = ? AND r.status = 'pending'
     ORDER BY r.submitted_at ASC, r.id ASC`,
    [authorId]
  );
  return decorateCollabRequests(rows.map(rowToCollabRequest));
}

async function countIncomingCollabs(authorId) {
  const row = await get(
    `SELECT COUNT(*) as count FROM sticker_collab_requests r
     JOIN sticker_packs p ON p.id = r.pack_id
     WHERE p.author_id = ? AND r.status = 'pending'`,
    [authorId]
  );
  return row?.count || 0;
}

// Исходящие: мои заявки любого статуса (свежие сверху) — чтобы видеть, что
// с ними стало (ждёт / принято / отклонено).
async function listMyCollabs(userId) {
  const rows = await all('SELECT * FROM sticker_collab_requests WHERE proposer_id = ? ORDER BY COALESCE(resolved_at, submitted_at, created_at) DESC, id DESC LIMIT 50', [userId]);
  return decorateCollabRequests(rows.map(rowToCollabRequest), 6);
}

// Автор принимает заявку: стикеры вливаются в набор, автор заявки становится
// соавтором. Совпавшие по имени стикеры не теряем — получают суффикс -2, -3…
async function acceptCollab(authorId, requestId) {
  const request = await getCollabRequestRow(requestId);
  if (!request) throw new Error('Предложение не найдено');
  const pack = await getPack(request.pack_id);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== authorId) throw new Error('Принять предложение может только автор набора');
  if (request.status !== 'pending') throw new Error('Это предложение уже рассмотрено');
  if (pack.status !== 'approved') throw new Error('Набор сейчас не опубликован — принять предложение нельзя');

  const staged = await all('SELECT * FROM sticker_collab_stickers WHERE request_id = ? ORDER BY position ASC, id ASC', [requestId]);
  if (!staged.length) throw new Error('В предложении не осталось стикеров');

  const packCount = await get('SELECT COUNT(*) as count FROM stickers WHERE pack_id = ?', [pack.id]);
  if ((packCount?.count || 0) + staged.length > MAX_STICKERS_PER_PACK) {
    throw new Error(`В наборе не хватит места: максимум ${MAX_STICKERS_PER_PACK} стикеров`);
  }

  const takenRows = await all('SELECT alias FROM stickers WHERE pack_id = ?', [pack.id]);
  const taken = new Set(takenRows.map((r) => r.alias));
  const posRow = await get('SELECT COALESCE(MAX(position), -1) as maxPos FROM stickers WHERE pack_id = ?', [pack.id]);
  let position = (posRow?.maxPos ?? -1) + 1;

  for (const s of staged) {
    let alias = s.alias;
    let n = 2;
    while (taken.has(alias)) alias = `${s.alias}-${n++}`;
    taken.add(alias);
    await run(
      'INSERT INTO stickers (pack_id, alias, file_url, is_animated, position) VALUES (?, ?, ?, ?, ?)',
      [pack.id, alias, s.file_url, s.is_animated, position++]
    );
  }

  // Файлы остаются на месте — они уже лежат в папке набора (см. multer-config
  // и stageCollabSticker), поэтому удаляем только строки "черновика".
  await run('DELETE FROM sticker_collab_stickers WHERE request_id = ?', [requestId]);
  if (request.proposer_id !== pack.authorId) {
    await run(
      'INSERT OR IGNORE INTO sticker_pack_coauthors (pack_id, user_id, user_name) VALUES (?, ?, ?)',
      [pack.id, request.proposer_id, request.proposer_name]
    );
  }
  await run(
    "UPDATE sticker_collab_requests SET status = 'accepted', stickers_count = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
    [staged.length, requestId]
  );
  return getPackWithStickers(pack.id);
}

// Автор отклоняет заявку: стикеры предложившего удаляются, набор не
// меняется — "всё отменяется". Сама запись остаётся в истории "Мои
// предложения" предложившего со статусом declined.
async function declineCollab(authorId, requestId) {
  const request = await getCollabRequestRow(requestId);
  if (!request) throw new Error('Предложение не найдено');
  const pack = await getPack(request.pack_id);
  if (!pack) throw new Error('Набор не найден');
  if (pack.authorId !== authorId) throw new Error('Отклонить предложение может только автор набора');
  if (request.status !== 'pending') throw new Error('Это предложение уже рассмотрено');

  await discardCollabStickers(requestId);
  await run("UPDATE sticker_collab_requests SET status = 'declined', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [requestId]);
  return true;
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
  publishPack,
  unpublishPack,
  resubmitPack,
  MAX_COLLAB_MESSAGE_LEN,
  getMyCollab,
  stageCollabSticker,
  removeCollabSticker,
  submitCollab,
  cancelCollab,
  listIncomingCollabs,
  countIncomingCollabs,
  listMyCollabs,
  acceptCollab,
  declineCollab,
  extractShortcodes,
  isStandaloneShortcode,
  validateContentForPosting,
  canUseShortcode,
  resolveCodes,
  resolveShortcodesInTexts,
  attachStickersToItems
};
