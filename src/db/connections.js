// connections.js — открывает общие SQLite-соединения один раз при старте
// сервера и отдаёт их остальным модулям. usersDb намеренно не открывается
// здесь: middleware/auth.js держит собственное соединение с users.db, а
// отдельные маршруты (роли, список пользователей и т.п.) открывают
// users.db по требованию — так было в исходном коде, поведение не менялось.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');
const { migrateStickerFilesToPackFolders } = require('./migrate-stickers-pack-folders');

const messengerDb = new sqlite3.Database(dbPath('messenger.db'), (err) => {
  if (err) {
    console.error('Error opening messenger database', err);
  } else {
    console.log('Connected to messenger SQLite database');
    messengerDb.run("PRAGMA encoding = 'UTF-8'");
    messengerDb.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

const articlesDb = new sqlite3.Database(dbPath('articles.db'), (err) => {
  if (err) {
    console.error('Error opening articles database', err);
  } else {
    console.log('Connected to articles SQLite database');
    articlesDb.run("PRAGMA encoding = 'UTF-8'");
    // Сущность "Категории" полностью убрана из проекта (остались только
    // теги) — справочник categories в articles.db больше не нужен. DROP TABLE
    // IF EXISTS безопасно вызывать на каждом старте: там, где таблицы уже нет,
    // ничего не происходит. Поле categories в самих файлах статей вычищает
    // articles-store.stripLegacyCategoryFields (см. server.js).
    articlesDb.run('DROP TABLE IF EXISTS categories', (dropErr) => {
      if (dropErr) console.error('Не удалось удалить устаревшую таблицу categories:', dropErr);
    });

    // Цвет тега (граф связей, вкладка "Теги") — один на тег во всей системе, см.
    // src/services/tag-colors.js. tag_key — название тега в нижнем регистре и
    // без ведущего "#" (одно название = один цвет), tag_name — как оно
    // написано в первый раз (для подписей), color — #rrggbb.
    articlesDb.run(`CREATE TABLE IF NOT EXISTS tag_colors (
      tag_key TEXT PRIMARY KEY,
      tag_name TEXT NOT NULL,
      color TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

const serversDb = new sqlite3.Database(dbPath('servers.db'), (err) => {
  if (err) {
    console.error('Error opening servers database', err);
  } else {
    console.log('Connected to servers SQLite database');
    serversDb.run("PRAGMA encoding = 'UTF-8'");
    // Журнал действий на сервере (кто/что/когда) — вкладка "Журнал" в
    // рабочей области сервера, см. logServerAction/getServerAuditLog в
    // server-system-logic.js. actor_username денормализован (снят с
    // JWT-токена в момент действия), а не связывается через users.id —
    // это отдельный файл users.db, JOIN между файлами SQLite невозможен
    // (тот же приём уже используется для owner_username в getServerById).
    serversDb.run(`CREATE TABLE IF NOT EXISTS server_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      actor_username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Закладки статей (Ibripedia) — привязаны к профилю (user_id), поэтому
// живут в собственном файле БД, а не в articles.db (тот вообще не
// используется с переезда статей на content/*.json — см. комментарий у
// articlesDb выше) и не в users.db (отдельное соединение держит
// middleware/auth.js, а закладок может быть много на пользователя, это не
// "профильное" поле, а отдельная сущность).
const bookmarksDb = new sqlite3.Database(dbPath('bookmarks.db'), (err) => {
  if (err) {
    console.error('Error opening bookmarks database', err);
  } else {
    console.log('Connected to bookmarks SQLite database');
    bookmarksDb.run("PRAGMA encoding = 'UTF-8'");
    // block_id — id блока (см. src/services/blocks.js) внутри дерева блоков
    // статьи, к которому привязана закладка (тот же блок, что рендерится с
    // атрибутом data-block-id в blocks-renderer.js) — null, если блок к
    // моменту простановки закладки не определился (страховка, в норме
    // всегда заполнен). quote — сам выделенный текст (для показа в панели
    // закладок и подсветки в статье), name/color — то, что вводит сам
    // пользователь в диалоге "Установить закладку".
    bookmarksDb.run(`CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      article_slug TEXT NOT NULL,
      article_title TEXT,
      block_id TEXT,
      quote TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5865f2',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    bookmarksDb.run('CREATE INDEX IF NOT EXISTS idx_bookmarks_user_article ON bookmarks (user_id, article_slug)');
  }
});

// Лайки и комментарии статей (Ibripedia) — в отличие от закладок это
// ПУБЛИЧНЫЕ данные (комментарий/факт лайка видны всем читателям статьи, а
// не только автору), поэтому живут в собственном файле, а не в bookmarks.db.
// article_slug — тот же slug, что и у файла статьи в content/ (см.
// src/services/articles-store.js); статьи не переезжали на числовые id.
const socialDb = new sqlite3.Database(dbPath('social.db'), (err) => {
  if (err) {
    console.error('Error opening social database', err);
  } else {
    console.log('Connected to social SQLite database');
    socialDb.run("PRAGMA encoding = 'UTF-8'");
    // serialize() — без него node-sqlite3 может разослать эти run() по
    // разным потокам своего пула и выполнить их не в порядке вызова (на
    // практике так и происходило: CREATE INDEX иногда стартовал раньше, чем
    // фиксировался CREATE TABLE, и падал с "no such table"). Внутри
    // serialize() каждый следующий run() гарантированно ждёт предыдущий.
    socialDb.serialize(() => {
      // Один лайк на пользователя на статью (UNIQUE) — повторный POST
      // .../likes/toggle снимает уже поставленный лайк, а не плодит дубликаты.
      socialDb.run(`CREATE TABLE IF NOT EXISTS article_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        article_slug TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, article_slug)
      )`);
      socialDb.run('CREATE INDEX IF NOT EXISTS idx_article_likes_slug ON article_likes (article_slug)');

      // Реальная статистика просмотров — один просмотр на пользователя на
      // статью (UNIQUE), а не голая инкрементируемая цифра: повторные заходы
      // того же пользователя счётчик не увеличивают (см. recordView в
      // social-store.js). Заменяет собой раньше никогда не изменявшееся
      // поле `views` во frontmatter статьи (см. src/services/articles-store.js) —
      // то поле остаётся в файлах статей нетронутым, но для отображения
      // счётчика больше не используется.
      socialDb.run(`CREATE TABLE IF NOT EXISTS article_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        article_slug TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, article_slug)
      )`);
      socialDb.run('CREATE INDEX IF NOT EXISTS idx_article_views_slug ON article_views (article_slug)');

      // author_name денормализовано (снято с req.user в момент отправки) —
      // тем же приёмом, что actor_username в server_audit_log выше: users.db —
      // отдельный файл SQLite, JOIN между файлами невозможен.
      socialDb.run(`CREATE TABLE IF NOT EXISTS article_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        article_slug TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      socialDb.run('CREATE INDEX IF NOT EXISTS idx_article_comments_slug ON article_comments (article_slug)');

      // parent_id — ответы на комментарий (один уровень вложенности, как в
      // YouTube: ответ на ответ подшивается к тому же родителю, см.
      // addComment в social-store.js). Добавлено позже исходной таблицы,
      // поэтому колонка проверяется через PRAGMA (тот же приём, что
      // ensureUserSchema в src/db/migrate-users-schema.js) и добавляется, если
      // её ещё нет — CREATE INDEX запускаем только ПОСЛЕ ALTER, из его же
      // колбэка, а не параллельно внутри serialize(): иначе индекс может
      // создаться раньше, чем появится сама колонка (см. комментарий про
      // serialize() выше).
      socialDb.all('PRAGMA table_info(article_comments)', [], (err, columns) => {
        if (err) {
          console.error('Error reading article_comments schema', err);
          return;
        }
        const hasParent = (columns || []).some((c) => c.name === 'parent_id');
        const addIndex = () => socialDb.run('CREATE INDEX IF NOT EXISTS idx_article_comments_parent ON article_comments (parent_id)');
        if (hasParent) addIndex();
        else socialDb.run('ALTER TABLE article_comments ADD COLUMN parent_id INTEGER', addIndex);
      });

      // Реакции эмодзи/стикером — общая таблица для статей и комментариев
      // (target_type + target_id, а не отдельные таблицы на каждую сущность:
      // одна и та же логика подсчёта/тоггла что под статьёй, что под
      // комментарием, см. toggleReaction/getReactionsForTargets в
      // social-store.js). UNIQUE — один и тот же стикер от одного
      // пользователя на одну цель можно поставить только один раз (повторный
      // клик снимает его), но разные стикеры от одного пользователя на одну
      // цель — можно (в отличие от лайка, это не взаимоисключающие реакции).
      socialDb.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        shortcode TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(target_type, target_id, user_id, shortcode)
      )`);
      socialDb.run('CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions (target_type, target_id)');
    });
  }
});

// Стикер-наборы (наборы стикеров/кастомных эмодзи) — своя БД по той же
// причине, что и у social.db/bookmarks.db: отдельная сущность со своим
// жизненным циклом (модерация, подписки), не привязанная к статьям.
// author_id/author_name денормализованы тем же приёмом, что actor_username
// в server_audit_log (users.db — отдельный файл SQLite, JOIN между файлами
// невозможен). slug пакета используется в шорткоде :slug:alias: прямо в
// тексте комментария/сообщения — см. src/services/stickers-store.js.
const stickersDb = new sqlite3.Database(dbPath('stickers.db'), (err) => {
  if (err) {
    console.error('Error opening stickers database', err);
  } else {
    console.log('Connected to stickers SQLite database');
    stickersDb.run("PRAGMA encoding = 'UTF-8'");
    stickersDb.serialize(() => {
      // status: 'draft' | 'pending' | 'approved' | 'rejected'. 'draft' —
      // только что созданный, ещё не опубликованный автором набор (см.
      // жизненный цикл в stickers-store.js). Набор нельзя использовать (см.
      // validateContentForPosting), пока он не approved — даже автору, пока
      // модератор явно не подтвердил набор.
      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_packs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reject_reason TEXT,
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_sticker_packs_status ON sticker_packs (status)');
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_sticker_packs_author ON sticker_packs (author_id)');

      // description — до 200 символов, показывается в пикере стикеров
      // (подсказка у вкладки набора) и в карточках набора (магазин/раздел
      // "Стикеры"). Добавлено позже исходной таблицы — та же проверка через
      // PRAGMA, что и у article_comments.parent_id выше.
      stickersDb.all('PRAGMA table_info(sticker_packs)', [], (err, columns) => {
        if (err) {
          console.error('Error reading sticker_packs schema', err);
          return;
        }
        const hasDescription = (columns || []).some((c) => c.name === 'description');
        if (!hasDescription) stickersDb.run('ALTER TABLE sticker_packs ADD COLUMN description TEXT');
      });

      // alias — короткое имя стикера внутри набора (латиница/цифры/дефис),
      // вместе со slug набора образует шорткод :slug:alias: в тексте.
      // is_animated — 1 для .gif (см. multer-config.js), 0 для статичных
      // картинок; только подсказка клиенту, как проигрывать превью.
      stickersDb.run(`CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id INTEGER NOT NULL REFERENCES sticker_packs(id),
        alias TEXT NOT NULL,
        file_url TEXT NOT NULL,
        is_animated INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pack_id, alias)
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_stickers_pack ON stickers (pack_id)');

      // "Добавленные себе" наборы (аналог подписки на стикерпак в Telegram) —
      // только из числа своих подписок пользователь видит стикеры в пикере
      // при отправке комментария/сообщения (см. listSubscribedWithStickers).
      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        pack_id INTEGER NOT NULL REFERENCES sticker_packs(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, pack_id)
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_sticker_subs_user ON sticker_subscriptions (user_id)');

      // Избранные стикеры (отдельные, а не целыми наборами — см.
      // sticker_subscriptions выше) — звёздочка в пикере стикеров.
      // Добавить можно только стикер из уже добавленного себе набора (см.
      // addFavorite в stickers-store.js) — эта таблица сама по себе такую
      // проверку не выражает (она только запоминает пару пользователь-
      // стикер), проверка — на уровне store при записи.
      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        sticker_id INTEGER NOT NULL REFERENCES stickers(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, sticker_id)
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_sticker_favorites_user ON sticker_favorites (user_id)');

      // Коллаборации (см. жизненный цикл в stickers-store.js): другой
      // пользователь добавляет СВОИ стикеры к чужому одобренному набору не
      // напрямую, а через заявку. Пока заявка не принята, его стикеры лежат
      // отдельно (sticker_collab_stickers) и в самом наборе не видны.
      // status заявки: 'draft' — собирает стикеры, ещё не отправил автору;
      // 'pending' — отправлена, ждёт решения; 'accepted' — стикеры влиты в
      // набор, автор заявки стал соавтором; 'declined' — автор отказал,
      // стикеры удалены. stickers_count — снимок числа стикеров на момент
      // отправки (после решения самих строк в sticker_collab_stickers уже
      // нет, а в истории "Мои предложения" число показать нужно).
      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_collab_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id INTEGER NOT NULL REFERENCES sticker_packs(id),
        proposer_id INTEGER NOT NULL,
        proposer_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        message TEXT,
        stickers_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME,
        resolved_at DATETIME
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_collab_requests_pack ON sticker_collab_requests (pack_id, status)');
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_collab_requests_proposer ON sticker_collab_requests (proposer_id)');

      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_collab_stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES sticker_collab_requests(id),
        alias TEXT NOT NULL,
        file_url TEXT NOT NULL,
        is_animated INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(request_id, alias)
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_collab_stickers_request ON sticker_collab_stickers (request_id)');

      // Соавторы набора — появляются, когда автор принял чью-то заявку.
      // user_name денормализован (users.db — отдельный файл, JOIN нельзя),
      // как author_name в sticker_packs.
      stickersDb.run(`CREATE TABLE IF NOT EXISTS sticker_pack_coauthors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id INTEGER NOT NULL REFERENCES sticker_packs(id),
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pack_id, user_id)
      )`);
      stickersDb.run('CREATE INDEX IF NOT EXISTS idx_pack_coauthors_user ON sticker_pack_coauthors (user_id)');

      // Разложить уже загруженные файлы по папкам наборов (см. комментарий в
      // самом модуле) — безопасно на каждом старте, трогает только ещё не
      // перенесённые (старые) записи.
      migrateStickerFilesToPackFolders(stickersDb).catch((migrateErr) => {
        console.error('Не удалось перенести файлы стикеров по папкам наборов:', migrateErr);
      });
    });
  }
});

module.exports = { messengerDb, articlesDb, serversDb, bookmarksDb, socialDb, stickersDb };
