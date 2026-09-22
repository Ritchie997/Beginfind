// articles-store.js — файловое хранилище статей (JSON: метаданные + дерево
// блоков) взамен исходного Markdown+YAML-frontmatter формата (см. blocks.js
// про причину отказа от markdown-текста с самодельным {width=...}-синтаксисом).
// Каждая статья — один файл content/<slug>.json, slug одновременно служит и
// именем файла, и идентификатором в URL (/api/articles/:slug), и целью для
// wiki-ссылок [подпись]((slug)).
//
// Экспортирует единый CRUD-слой, которым пользуется src/routes/articles.routes.js.
// Список статей кэшируется в памяти и инвалидируется при любой записи через
// этот модуль (см. requirement "кэширование списка статей для производительности").
//
// Старые *.md-файлы (Markdown-формат, до перехода на блоки) сюда сознательно
// НЕ читаются — по решению "статьи мусорные, миграция не нужна": при переходе
// на этот модуль содержимое content/ пересоздаётся с нуля.

const fs = require('fs');
const path = require('path');
const { CONTENT_DIR } = require('../config/paths');
const { slugify } = require('./slugify');
const blocks = require('./blocks');
const articleLayers = require('./article-layers');

const TRASH_DIR = path.join(CONTENT_DIR, '.trash');
const FILE_EXT = '.json';

function ensureDirs() {
  if (!fs.existsSync(CONTENT_DIR)) {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
  }
  if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
  }
}

/**
 * Проверяет, что slug безопасен для использования как имя файла
 * (защита от directory traversal вида "../../secret").
 */
function isSafeSlug(slug) {
  return typeof slug === 'string' &&
    slug.length > 0 &&
    slug === path.basename(slug) &&
    !slug.startsWith('.');
}

function articlePath(slug) {
  return path.join(CONTENT_DIR, `${slug}${FILE_EXT}`);
}

function listArticleFiles() {
  ensureDirs();
  return fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(FILE_EXT));
}

// ========================================
// КЭШ СПИСКА СТАТЕЙ
// ========================================

let cache = null; // Array<article> | null

function invalidateCache() {
  cache = null;
}

/**
 * Читает и разбирает один файл статьи. Возвращает null, если файла нет,
 * либо он повреждён/не в формате JSON (ошибка логируется, но не валит весь
 * список — см. requirement "обработай случаи, когда файл повреждён или
 * содержит неверный формат").
 */
function readArticleFile(slug) {
  return parseArticleFile(articlePath(slug), slug);
}

// Разбор файла статьи по произвольному пути — общий для файлов в content/ и
// в корзине content/.trash/ (см. listTrashedArticles).
function parseArticleFile(filePath, slug) {
  if (!fs.existsSync(filePath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`[articles-store] Не удалось прочитать ${filePath}:`, e.message);
    return null;
  }

  let fm;
  try {
    fm = JSON.parse(raw);
  } catch (e) {
    console.error(`[articles-store] Повреждённый JSON в ${filePath}:`, e.message);
    return null;
  }
  if (!fm || typeof fm !== 'object') return null;

  return {
    id: slug, // для обратной совместимости с фронтендом, ожидающим article.id
    slug,
    title: fm.title || slug,
    // content — дерево блоков { version, blocks }, а не markdown-строка (см.
    // blocks.js). normalizeDocument заодно чинит любую неполноту/повреждённость
    // отдельных блоков, не роняя чтение всей статьи целиком.
    content: blocks.normalizeDocument(fm.content),
    // Слои "многослойной" статьи (см. src/services/article-layers.js) — []
    // означает "статья слоями не пользуется", тогда в силе обычные
    // title/content/excerpt/image/locked/roles ниже (как было всегда).
    layers: articleLayers.normalizeLayers(fm.layers),
    views: typeof fm.views === 'number' ? fm.views : 0,
    locked: !!fm.locked,
    role: Array.isArray(fm.roles) && fm.roles.length > 0 ? JSON.stringify(fm.roles) : null,
    roles: Array.isArray(fm.roles) ? fm.roles : [],
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    // author_id/co_author_ids — id пользователей (числа), имена резолвятся
    // на лету в articles.routes.js::formatArticleResponse, а не хранятся
    // здесь снимком — чтобы переименование пользователя сразу отражалось
    // везде, где он указан автором/соавтором.
    author_id: fm.author_id != null ? parseInt(fm.author_id, 10) || null : null,
    // legacyAuthorName — статьи, созданные до появления author_id, хранят
    // автора текстом (fm.author). articles.routes.js пытается сопоставить
    // это имя реальному пользователю (см. resolveLegacyAuthorIds).
    legacyAuthorName: (!fm.author_id && fm.author && String(fm.author).trim()) || null,
    co_author_ids: Array.isArray(fm.co_author_ids)
      ? fm.co_author_ids.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
      : [],
    image: fm.image || null,
    attachments: Array.isArray(fm.attachments) ? fm.attachments : [],
    server: fm.server ?? null,
    excerpt: fm.excerpt || '',
    created_at: fm.date || null,
    updated_at: fm.updated || fm.date || null,
    legacyId: fm.legacyId ?? null
  };
}

function writeArticleFile(slug, article) {
  const fileContents = {
    title: article.title,
    date: article.created_at,
    updated: article.updated_at,
    author_id: article.author_id ?? null,
    co_author_ids: article.co_author_ids || [],
    tags: article.tags || [],
    excerpt: article.excerpt || '',
    server: article.server ?? null,
    locked: !!article.locked,
    roles: article.roles || [],
    image: article.image || null,
    attachments: article.attachments || [],
    views: article.views || 0,
    // content всегда нормализуется перед записью — на диске никогда не
    // оказывается "сырых" данных произвольной формы.
    content: blocks.normalizeDocument(article.content),
    // Слои — так же всегда нормализуются; [] пишется и для обычных статей
    // (явный, а не подразумеваемый признак "слои не используются").
    layers: articleLayers.normalizeLayers(article.layers)
  };
  if (article.legacyId != null) {
    fileContents.legacyId = article.legacyId;
  }

  // Отступы — чтобы файл оставался читаемым/дифаемым в git, как раньше
  // читался markdown (полностью machine-readable JSON в одну строку было бы
  // куда менее приятно смотреть в git diff при правке одной статьи).
  fs.writeFileSync(articlePath(slug), JSON.stringify(fileContents, null, 2), 'utf8');
}

/**
 * Возвращает список всех статей (из кэша, если он свежий).
 */
function listArticles() {
  if (cache) return cache;

  const files = listArticleFiles();
  const articles = [];

  for (const file of files) {
    const slug = file.slice(0, -FILE_EXT.length);
    const article = readArticleFile(slug);
    if (article) articles.push(article);
  }

  articles.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  cache = articles;
  return cache;
}

/**
 * Статьи из корзины (content/.trash/<slug>.<timestamp>.json). Без кэша и без
 * сортировки: нужны только очистке мусора (cleanup.js), чтобы не считать
 * "сиротами" картинки, на которые ссылаются статьи, лежащие в корзине —
 * пока статью можно вернуть вручную, её картинки должны быть на месте.
 */
function listTrashedArticles() {
  if (!fs.existsSync(TRASH_DIR)) return [];
  const articles = [];
  for (const file of fs.readdirSync(TRASH_DIR)) {
    if (!file.endsWith(FILE_EXT)) continue;
    const article = parseArticleFile(path.join(TRASH_DIR, file), file.slice(0, -FILE_EXT.length));
    if (article) articles.push(article);
  }
  return articles;
}

function getArticle(slug) {
  if (!isSafeSlug(slug)) return null;
  // Ищем в кэше, чтобы не делать лишний readFileSync, если список уже загружен
  const cached = cache && cache.find(a => a.slug === slug);
  if (cached) return cached;
  return readArticleFile(slug);
}

/**
 * Генерирует уникальный slug по заголовку (article-title, article-title-2, ...).
 */
function generateUniqueSlug(title, excludeSlug = null) {
  const base = slugify(title);
  const existing = new Set(
    listArticleFiles()
      .map((f) => f.slice(0, -FILE_EXT.length))
      .filter((s) => s !== excludeSlug)
  );

  if (!existing.has(base)) return base;

  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function createArticle(fields) {
  ensureDirs();
  const now = new Date().toISOString();
  const slug = generateUniqueSlug(fields.title || 'article');

  const article = {
    title: fields.title || 'Без названия',
    content: blocks.normalizeDocument(fields.content),
    layers: articleLayers.normalizeLayers(fields.layers),
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: normalizeRoles(fields.role, fields.roles),
    tags: fields.tags || [],
    // Автор — всегда пользователь, реально создавший статью (проставляется
    // маршрутом из req.user.id, а не из тела запроса) — см. articles.routes.js.
    author_id: fields.author_id ?? null,
    co_author_ids: [],
    image: normalizeImagePath(fields.image),
    attachments: fields.attachments || [],
    server: fields.server ?? null,
    excerpt: fields.excerpt || '',
    created_at: now,
    updated_at: now
  };

  writeArticleFile(slug, article);
  invalidateCache();
  return getArticle(slug);
}

/**
 * Низкоуровневая запись статьи с явными датами/legacyId — для скриптов
 * импорта/переноса данных (сохраняет исходные даты и id вместо простановки
 * "now").
 */
function importArticle(slug, fields) {
  ensureDirs();
  writeArticleFile(slug, {
    title: fields.title || 'Без названия',
    content: blocks.normalizeDocument(fields.content),
    layers: articleLayers.normalizeLayers(fields.layers),
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: fields.roles || [],
    tags: fields.tags || [],
    author_id: fields.author_id ?? null,
    co_author_ids: Array.isArray(fields.co_author_ids) ? fields.co_author_ids : [],
    image: fields.image || null,
    attachments: fields.attachments || [],
    server: fields.server ?? null,
    excerpt: fields.excerpt || '',
    created_at: fields.created_at || new Date().toISOString(),
    updated_at: fields.updated_at || fields.created_at || new Date().toISOString(),
    legacyId: fields.legacyId ?? null
  });
  invalidateCache();
  return getArticle(slug);
}

function updateArticle(slug, fields) {
  if (!isSafeSlug(slug)) return null;
  const existing = readArticleFile(slug);
  if (!existing) return null;

  const updated = {
    title: fields.title ?? existing.title,
    content: fields.content !== undefined ? blocks.normalizeDocument(fields.content) : existing.content,
    // fields.layers, если передан, приходит сюда УЖЕ полностью слитым (см.
    // articleLayers.mergeLayersUpdate в articles.routes.js) — слои выше
    // резолвнутого максимума текущего пользователя уже сохранены в нём как
    // есть, здесь остаётся только нормализовать форму на всякий случай.
    layers: fields.layers !== undefined ? articleLayers.normalizeLayers(fields.layers) : existing.layers,
    views: fields.views ?? existing.views,
    locked: fields.locked !== undefined ? !!fields.locked : existing.locked,
    roles: (fields.role !== undefined || fields.roles !== undefined)
      ? normalizeRoles(fields.role, fields.roles)
      : existing.roles,
    tags: fields.tags ?? existing.tags,
    // author_id намеренно не берётся из req.body (маршрут его туда даже не
    // пропускает) — закреплён за статьёй с момента создания и не меняется
    // при редактировании другим профилем. Единственное исключение — сама
    // статья ещё ничья (existing.author_id == null): тогда articles.routes.js
    // передаёт сюда fields.author_id явно, "усыновляя" её первым же
    // редактором — иначе такая статья не имела бы автора вообще никогда.
    author_id: fields.author_id !== undefined ? fields.author_id : existing.author_id,
    co_author_ids: Array.isArray(fields.co_author_ids) ? fields.co_author_ids : existing.co_author_ids,
    image: fields.image !== undefined ? normalizeImagePath(fields.image) : existing.image,
    attachments: fields.attachments ?? existing.attachments,
    server: fields.server ?? existing.server,
    excerpt: fields.excerpt ?? existing.excerpt,
    created_at: existing.created_at,
    updated_at: new Date().toISOString()
  };

  // Примечание: заголовок статьи можно менять без переименования файла — slug
  // (и, соответственно, wiki-ссылки [подпись]((slug)) на неё) стабилен, пока статью не
  // переименуют явно (см. "быстрое переименование с обновлением ссылок").
  // Но упоминания статьи в других статьях при смене заголовка всё равно
  // обновляем — иначе они продолжали бы показывать старое название.
  writeArticleFile(slug, updated);
  invalidateCache();
  if (updated.title !== existing.title) refreshMentions(slug, slug, updated.title);
  return getArticle(slug);
}

/**
 * Переписывает wiki-ссылки [подпись]((цель)) во всех статьях (включая саму статью — она
 * может ссылаться на себя), для которых rewrite(link) вернул замену — см.
 * blocks.rewriteWikiLinksInDocument. updated_at правленных статей не трогаем:
 * это служебная правка ссылок, а не работа автора над текстом.
 * @returns {string[]} slug'и изменённых статей
 */
function rewriteMentions(rewrite) {
  const updatedArticles = [];
  for (const article of listArticles()) {
    const patch = {};
    let changedAny = false;

    if (!article.layers || article.layers.length === 0) {
      const { doc, changed } = blocks.rewriteWikiLinksInDocument(article.content, slugify, rewrite);
      if (changed) { patch.content = doc; changedAny = true; }
    } else {
      // Многослойная статья — ссылка могла встретиться в любом слое; верхнеуровневый
      // article.content у таких статей не используется, трогать его незачем.
      let layersChanged = false;
      const newLayers = article.layers.map((l) => {
        const { doc, changed } = blocks.rewriteWikiLinksInDocument(l.content, slugify, rewrite);
        if (changed) layersChanged = true;
        return changed ? { ...l, content: doc } : l;
      });
      if (layersChanged) { patch.layers = newLayers; changedAny = true; }
    }

    if (!changedAny) continue;
    writeArticleFile(article.slug, { ...article, ...patch });
    updatedArticles.push(article.slug);
  }
  if (updatedArticles.length > 0) invalidateCache();
  return updatedArticles;
}

/**
 * Текст цели для ((ссылки)) на статью: сам заголовок, если он однозначно
 * превращается обратно в тот же slug (читаемо в редакторе), иначе slug.
 * Заголовок с ()# ссылкой не записать — ими ссылка разбирается.
 */
function mentionTarget(title, slug) {
  const t = String(title).trim();
  return slugify(t) === slug && !/[()#]/.test(t) ? t : slug;
}

/**
 * Статья была переименована (oldSlug → newSlug, заголовок newTitle):
 * упоминания [текст]((oldSlug)) / [текст]((Старый заголовок)) /
 * [текст]((oldSlug#якорь)) в других статьях указывают на новое имя. Своя
 * подпись ("[Имя]((статья))") сохраняется — её задал автор упоминания.
 */
function refreshMentions(oldSlug, newSlug, newTitle) {
  const target = mentionTarget(newTitle, newSlug);
  return rewriteMentions(({ slug, anchor, label }) =>
    slug === oldSlug ? `[${label}]((${target}${anchor}))` : null);
}

// Что подставляется вместо упоминания удалённой статьи.
const DELETED_MENTION_TEXT = 'Удалено';

/**
 * "Удаляет" статью, перемещая файл в content/.trash/ вместо безвозвратного
 * удаления. Упоминания wiki-ссылками в остальных статьях заменяются на
 * текст "Удалено" (вместе с подписью и якорем — ссылаться больше не на что).
 */
function deleteArticle(slug) {
  if (!isSafeSlug(slug)) return false;
  const filePath = articlePath(slug);
  if (!fs.existsSync(filePath)) return false;

  ensureDirs();
  const trashName = `${slug}.${Date.now()}${FILE_EXT}`;
  fs.renameSync(filePath, path.join(TRASH_DIR, trashName));
  invalidateCache();

  rewriteMentions((link) => (link.slug === slug ? DELETED_MENTION_TEXT : null));
  return true;
}

/**
 * Переименовывает статью: меняет заголовок и slug (а значит — и имя файла),
 * и обновляет wiki-ссылки на неё во всех остальных статьях (внутри
 * markdown-текста их блоков — см. blocks.rewriteWikiLinksInDocument), чтобы
 * они продолжали указывать на правильный файл.
 * @returns {{oldSlug, newSlug, updatedArticles: string[]}|null}
 */
function renameArticle(oldSlug, newTitle) {
  if (!isSafeSlug(oldSlug)) return null;
  const existing = readArticleFile(oldSlug);
  if (!existing) return null;

  const newSlug = generateUniqueSlug(newTitle, oldSlug);

  writeArticleFile(newSlug, {
    ...existing,
    title: newTitle,
    updated_at: new Date().toISOString()
  });
  // Заголовок мог не поменять slug — тогда файл тот же и удалять нечего.
  if (newSlug !== oldSlug) fs.unlinkSync(articlePath(oldSlug));
  invalidateCache();

  const updatedArticles = refreshMentions(oldSlug, newSlug, newTitle);
  return { oldSlug, newSlug, updatedArticles };
}

/**
 * Ключ тега для сравнения и хранения цвета: без ведущего "#", без учёта
 * регистра ("Дракон", "дракон" и "#ДРАКОН" — один и тот же тег).
 */
function tagKey(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^#+/, '').trim().toLowerCase();
}

/**
 * Глобальный список тегов по переданным статьям — БЕЗ дублей. Тег статьи —
 * это и то, что вписано в поле "Теги" формы (article.tags), и #хэштеги прямо
 * в тексте (см. extractHashtags): фильтр витрины и граф связей уже считают их
 * одним и тем же, поэтому и здесь они сливаются. Дубли определяются без учёта
 * регистра и без ведущего "#" ("Дракон", "дракон" и "#дракон" — один тег);
 * показывается написание из поля "Теги" (в нём регистр задал автор), а если
 * тег встречается только как #хэштег в тексте — его строчная форма.
 * key — нормализованное название (tagKey), count — сколько разных статей
 * отмечено этим тегом.
 * @param {object[]} articles — статьи (уже отфильтрованные по доступу)
 * @returns {{tag: string, key: string, count: number}[]} по алфавиту
 */
function collectTags(articles) {
  const byKey = new Map(); // ключ (нижний регистр) -> { tag, fromField, slugs:Set }

  const add = (raw, slug, fromField) => {
    const name = String(raw == null ? '' : raw).trim().replace(/^#+/, '').trim();
    if (!name) return;
    const key = tagKey(name);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { tag: name, fromField, slugs: new Set() };
      byKey.set(key, entry);
    } else if (fromField && !entry.fromField) {
      entry.tag = name; // явное написание из поля "Теги" главнее хэштега из текста
      entry.fromField = true;
    }
    entry.slugs.add(slug);
  };

  for (const article of articles) {
    (article.tags || []).forEach((t) => add(t, article.slug, true));
    extractHashtags(article).forEach((t) => add(t, article.slug, false));
  }

  return [...byKey.values()]
    .map((e) => ({ tag: e.tag, key: tagKey(e.tag), count: e.slugs.size }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'ru'));
}

/**
 * Разовая (и идемпотентная) чистка: убирает устаревшее поле categories/category
 * из файлов статей (и из корзины) — сущность "Категории" удалена из проекта.
 * Файлы, где этих полей нет, не трогаются; updated_at не меняется — это
 * служебная правка формата, а не работа автора над статьёй.
 * @returns {number} сколько файлов было переписано
 */
function stripLegacyCategoryFields() {
  let rewritten = 0;
  for (const dir of [CONTENT_DIR, TRASH_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(FILE_EXT)) continue;
      const filePath = path.join(dir, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data || typeof data !== 'object') continue;
        if (!('categories' in data) && !('category' in data)) continue;
        delete data.categories;
        delete data.category;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        rewritten += 1;
      } catch (e) {
        console.error(`[articles-store] Не удалось убрать categories из ${filePath}:`, e.message);
      }
    }
  }
  if (rewritten > 0) invalidateCache();
  return rewritten;
}

// Текст статьи для полнотекстового поиска/фильтра — объединяет ВСЕ слои
// (заголовок+тело каждого), а не только тот, что достался бы конкретному
// читателю: иначе одна и та же статья находилась бы по разным запросам для
// разных ролей, что и труднее поддерживать, и путает пользователя ("почему
// поиск не находит статью, которую я точно видел"). Доступ к самой статье
// (и к тому, какой слой её представляет) по-прежнему решает canAccessArticle
// отдельно, уже после того, как поиск её нашёл — см. articles.routes.js.
function allLayersSearchText(article) {
  return articleLayers.getEffectiveLayers(article)
    .map((l) => `${l.title || ''}\n${blocks.documentSearchText(l.content)}`)
    .join('\n\n');
}

function searchArticles(query, { limit = 50, offset = 0 } = {}) {
  const q = query.trim().toLowerCase();
  const all = listArticles();

  const scored = all
    .map(article => {
      const titleLower = article.title.toLowerCase();
      const contentLower = allLayersSearchText(article).toLowerCase();
      let rank = 0;
      if (titleLower === q) rank = 1;
      else if (titleLower.includes(q)) rank = 2;
      else if (contentLower.includes(q)) rank = 3;
      return { article, rank };
    })
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => a.rank - b.rank);

  const total = scored.length;
  const page = scored.slice(offset, offset + limit).map(({ article, rank }) => ({
    ...article,
    relevance_score: rank === 1 ? 100 : rank === 2 ? 80 : 60
  }));

  return { rows: page, total };
}

// === Ibripedia: фильтрация/сортировка витрины статей ===
//
// В отличие от searchArticles() (только текстовый поиск, с ранжированием
// по вхождению) — здесь произвольная комбинация фильтров (теги,
// сервер, статус, диапазон дат) плюс сортировка. Пагинацию (limit/offset)
// сюда сознательно не добавляем — её накладывает уже вызывающий код в
// routes ПОСЛЕ проверки доступа (canAccessArticle) к каждой статье: иначе
// total и размер отданной страницы врали бы, если часть подходящих статей
// закрыта по ролям для конкретного пользователя.
function filterArticles(opts = {}) {
  const {
    q = '',
    tags = [],
    server = '',
    locked, // true | false | undefined — фильтр не применяется
    dateFrom = '',
    dateTo = '',
    sort = ''
  } = opts;

  let list = listArticles();

  const qLower = q.trim().toLowerCase();
  let scoreBySlug = null;
  if (qLower) {
    scoreBySlug = new Map();
    list = list.filter((a) => {
      const titleLower = a.title.toLowerCase();
      let rank = 0;
      if (titleLower === qLower) rank = 3;
      else if (titleLower.includes(qLower)) rank = 2;
      else if (allLayersSearchText(a).toLowerCase().includes(qLower)) rank = 1;
      if (rank > 0) scoreBySlug.set(a.slug, rank);
      return rank > 0;
    });
  }

  if (tags.length) {
    const set = new Set(tags.map((t) => t.toLowerCase()));
    list = list.filter((a) => {
      const ownTags = (a.tags || []).map((t) => String(t).toLowerCase());
      if (ownTags.some((t) => set.has(t))) return true;
      // #теги прямо в тексте статьи (Obsidian-стиль) — те же, что подсвечиваются
      // в редакторе/превью (см. extractHashtags), тоже должны находиться фильтром.
      return extractHashtags(a).some((t) => set.has(t));
    });
  }

  if (server) {
    list = list.filter((a) => String(a.server) === String(server));
  }

  if (locked === true || locked === false) {
    list = list.filter((a) => !!a.locked === locked);
  }

  if (dateFrom) {
    const from = new Date(dateFrom);
    if (!isNaN(from.getTime())) list = list.filter((a) => a.created_at && new Date(a.created_at) >= from);
  }
  if (dateTo) {
    const to = new Date(dateTo);
    if (!isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999); // конец дня — иначе "по" исключало бы весь выбранный день
      list = list.filter((a) => a.created_at && new Date(a.created_at) <= to);
    }
  }

  const effectiveSort = sort || (qLower ? 'relevance' : 'newest');
  const sorted = [...list];
  switch (effectiveSort) {
    case 'relevance':
      sorted.sort((a, b) => (scoreBySlug?.get(b.slug) || 0) - (scoreBySlug?.get(a.slug) || 0)
        || new Date(b.created_at || 0) - new Date(a.created_at || 0));
      break;
    case 'oldest':
      sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      break;
    case 'updated':
      sorted.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      break;
    case 'views':
      sorted.sort((a, b) => (b.views || 0) - (a.views || 0));
      break;
    case 'alpha':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
      break;
    case 'newest':
    default:
      sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  return sorted;
}

// === Wiki-ссылки и backlinks ===

/**
 * Извлекает все wiki-ссылки [подпись]((slug)) из статьи — из ВСЕХ её слоёв
 * разом (см. allLayersSearchText выше про то же решение для поиска): граф
 * связей и бэклинки — это карта того, что автор вообще написал в статье,
 * не зависящая от того, какой слой достанется конкретному читателю. Видимость
 * самого узла/связи читателю решает canAccessArticle отдельно.
 * @param {object} article
 */
function extractWikiLinks(article) {
  const links = new Set();
  articleLayers.getEffectiveLayers(article).forEach((l) => {
    blocks.extractWikiLinksFromDocument(l.content, slugify).forEach((s) => links.add(s));
  });
  return Array.from(links);
}

/**
 * Извлекает #теги, упомянутые прямо в тексте статьи (в нижнем регистре) — по
 * всем слоям сразу, по той же логике, что и extractWikiLinks выше.
 * @param {object} article
 */
function extractHashtags(article) {
  const tags = new Set();
  articleLayers.getEffectiveLayers(article).forEach((l) => {
    blocks.extractHashtagsFromDocument(l.content).forEach((t) => tags.add(t));
  });
  return Array.from(tags);
}

/**
 * Возвращает статьи, ссылающиеся на указанный slug через wiki-ссылку
 * [подпись]((slug)) — статьи целиком (не {slug,title}): маршрут
 * GET /articles/:id/backlinks сам фильтрует их по доступу конкретного
 * смотрящего (canAccessArticle) и резолвит заголовок под его слой — раньше
 * этой фильтрации не было (см. обсуждение "многослойные статьи", пункт про
 * утечку заголовков в бэклинках).
 */
function getBacklinks(slug) {
  return listArticles().filter(a => a.slug !== slug && extractWikiLinks(a).includes(slug));
}

// === Вспомогательные функции нормализации полей (перенесены из старого
// SQLite-слоя без изменения логики) ===

function normalizeRoles(role, roles) {
  if (roles && Array.isArray(roles) && roles.length > 0) {
    return roles.map(r => (typeof r === 'string' && !isNaN(r)) ? parseInt(r) : r);
  }
  if (role && typeof role === 'object' && Array.isArray(role)) {
    return role;
  }
  if (role) return [role];
  return [];
}

function normalizeImagePath(imagePath) {
  if (!imagePath) return null;

  if (imagePath.startsWith('http')) {
    try {
      const url = new URL(imagePath);
      return url.pathname;
    } catch (e) {
      console.warn('Could not parse image URL, saving as is:', imagePath);
      return imagePath;
    }
  }

  if (imagePath.includes('uploads') && !imagePath.startsWith('/')) {
    return '/' + imagePath;
  }

  if (!imagePath.startsWith('/') && !imagePath.includes('/')) {
    return `/uploads/${imagePath}`;
  }

  return imagePath;
}

module.exports = {
  CONTENT_DIR,
  TRASH_DIR,
  listArticles,
  listTrashedArticles,
  getArticle,
  createArticle,
  importArticle,
  updateArticle,
  deleteArticle,
  renameArticle,
  searchArticles,
  filterArticles,
  collectTags,
  tagKey,
  stripLegacyCategoryFields,
  extractWikiLinks,
  extractHashtags,
  getBacklinks,
  generateUniqueSlug,
  invalidateCache,
  isSafeSlug,
  // Переэкспорт блочной модели — routes.js использует её напрямую для
  // абсолютизации путей картинок (см. formatImageUrl/updateImageUrlsInContent).
  blocks
};
