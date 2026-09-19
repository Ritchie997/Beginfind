// articles-store.js — файловое хранилище статей (JSON: метаданные + дерево
// блоков) взамен исходного Markdown+YAML-frontmatter формата (см. blocks.js
// про причину отказа от markdown-текста с самодельным {width=...}-синтаксисом).
// Каждая статья — один файл content/<slug>.json, slug одновременно служит и
// именем файла, и идентификатором в URL (/api/articles/:slug), и целью для
// wiki-ссылок [[slug]].
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
    views: typeof fm.views === 'number' ? fm.views : 0,
    locked: !!fm.locked,
    role: Array.isArray(fm.roles) && fm.roles.length > 0 ? JSON.stringify(fm.roles) : null,
    roles: Array.isArray(fm.roles) ? fm.roles : [],
    categories: Array.isArray(fm.categories) ? fm.categories : (fm.category ? [fm.category] : []),
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
    categories: article.categories || [],
    excerpt: article.excerpt || '',
    server: article.server ?? null,
    locked: !!article.locked,
    roles: article.roles || [],
    image: article.image || null,
    attachments: article.attachments || [],
    views: article.views || 0,
    // content всегда нормализуется перед записью — на диске никогда не
    // оказывается "сырых" данных произвольной формы.
    content: blocks.normalizeDocument(article.content)
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
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: normalizeRoles(fields.role, fields.roles),
    categories: Array.isArray(fields.categories) ? fields.categories : [],
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
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: fields.roles || [],
    categories: Array.isArray(fields.categories) ? fields.categories : (fields.category ? [fields.category] : []),
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
    views: fields.views ?? existing.views,
    locked: fields.locked !== undefined ? !!fields.locked : existing.locked,
    roles: (fields.role !== undefined || fields.roles !== undefined)
      ? normalizeRoles(fields.role, fields.roles)
      : existing.roles,
    categories: Array.isArray(fields.categories) ? fields.categories : existing.categories,
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
  // (и, соответственно, wiki-ссылки [[slug]] на неё) стабилен, пока статью не
  // переименуют явно (см. "быстрое переименование с обновлением ссылок").
  writeArticleFile(slug, updated);
  invalidateCache();
  return getArticle(slug);
}

/**
 * "Удаляет" статью, перемещая файл в content/.trash/ вместо безвозвратного
 * удаления.
 */
function deleteArticle(slug) {
  if (!isSafeSlug(slug)) return false;
  const filePath = articlePath(slug);
  if (!fs.existsSync(filePath)) return false;

  ensureDirs();
  const trashName = `${slug}.${Date.now()}${FILE_EXT}`;
  fs.renameSync(filePath, path.join(TRASH_DIR, trashName));
  invalidateCache();
  return true;
}

/**
 * Переименовывает статью: меняет заголовок и slug (а значит — и имя файла),
 * и обновляет [[wiki-ссылки]] на неё во всех остальных статьях (внутри
 * markdown-текста их блоков — см. blocks.rewriteWikiLinksInDocument), чтобы
 * они продолжали указывать на правильный файл.
 * @returns {{oldSlug, newSlug, updatedArticles: string[]}|null}
 */
function renameArticle(oldSlug, newTitle) {
  if (!isSafeSlug(oldSlug)) return null;
  const existing = readArticleFile(oldSlug);
  if (!existing) return null;

  const newSlug = generateUniqueSlug(newTitle, oldSlug);
  if (newSlug === oldSlug) {
    // Заголовок не поменялся настолько, чтобы изменить slug — просто обновляем title
    updateArticle(oldSlug, { title: newTitle });
    return { oldSlug, newSlug: oldSlug, updatedArticles: [] };
  }

  writeArticleFile(newSlug, {
    ...existing,
    title: newTitle,
    updated_at: new Date().toISOString()
  });
  fs.unlinkSync(articlePath(oldSlug));
  invalidateCache();

  const updatedArticles = [];
  for (const article of listArticles()) {
    if (article.slug === newSlug) continue;
    const { doc, changed } = blocks.rewriteWikiLinksInDocument(article.content, oldSlug, existing.title, newSlug);
    if (!changed) continue;
    writeArticleFile(article.slug, { ...article, content: doc });
    updatedArticles.push(article.slug);
  }

  if (updatedArticles.length > 0) invalidateCache();

  return { oldSlug, newSlug, updatedArticles };
}

function searchArticles(query, { limit = 50, offset = 0 } = {}) {
  const q = query.trim().toLowerCase();
  const all = listArticles();

  const scored = all
    .map(article => {
      const titleLower = article.title.toLowerCase();
      const contentLower = blocks.documentSearchText(article.content).toLowerCase();
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
// по вхождению) — здесь произвольная комбинация фильтров (категории, теги,
// сервер, статус, диапазон дат) плюс сортировка. Пагинацию (limit/offset)
// сюда сознательно не добавляем — её накладывает уже вызывающий код в
// routes ПОСЛЕ проверки доступа (canAccessArticle) к каждой статье: иначе
// total и размер отданной страницы врали бы, если часть подходящих статей
// закрыта по ролям для конкретного пользователя.
function filterArticles(opts = {}) {
  const {
    q = '',
    categories = [],
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
      else if (blocks.documentSearchText(a.content).toLowerCase().includes(qLower)) rank = 1;
      if (rank > 0) scoreBySlug.set(a.slug, rank);
      return rank > 0;
    });
  }

  if (categories.length) {
    const set = new Set(categories.map((c) => c.toLowerCase()));
    list = list.filter((a) => (a.categories || []).some((c) => set.has(String(c).toLowerCase())));
  }

  if (tags.length) {
    const set = new Set(tags.map((t) => t.toLowerCase()));
    list = list.filter((a) => {
      const ownTags = (a.tags || []).map((t) => String(t).toLowerCase());
      if (ownTags.some((t) => set.has(t))) return true;
      // #теги прямо в тексте статьи (Obsidian-стиль) — те же, что подсвечиваются
      // в редакторе/превью (см. extractHashtags), тоже должны находиться фильтром.
      return extractHashtags(a.content).some((t) => set.has(t));
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
 * Извлекает все wiki-ссылки [[slug]] / [[slug|текст]] из документа статьи.
 */
function extractWikiLinks(content) {
  return blocks.extractWikiLinksFromDocument(content, slugify);
}

/**
 * Извлекает #теги, упомянутые прямо в тексте статьи (в нижнем регистре).
 */
function extractHashtags(content) {
  return blocks.extractHashtagsFromDocument(content);
}

/**
 * Возвращает список статей, ссылающихся на указанный slug через [[wiki-ссылку]].
 */
function getBacklinks(slug) {
  return listArticles()
    .filter(a => a.slug !== slug && extractWikiLinks(a.content).includes(slug))
    .map(a => ({ slug: a.slug, title: a.title }));
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
