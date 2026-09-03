// articles-store.js — файловое хранилище статей (Markdown + YAML frontmatter)
// взамен articles.db. Каждая статья — один файл content/<slug>.md, slug
// одновременно служит и именем файла, и идентификатором в URL (/api/articles/:slug),
// и целью для wiki-ссылок [[slug]] (см. Этап 4).
//
// Экспортирует единый CRUD-слой, которым пользуется src/routes/articles.routes.js.
// Список статей кэшируется в памяти и инвалидируется при любой записи через
// этот модуль (см. requirement "кэширование списка статей для производительности").

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { CONTENT_DIR } = require('../config/paths');
const { slugify } = require('./slugify');

const TRASH_DIR = path.join(CONTENT_DIR, '.trash');

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
  return path.join(CONTENT_DIR, `${slug}.md`);
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
 * либо он повреждён/не в формате Markdown+frontmatter (ошибка логируется,
 * но не валит весь список — см. requirement "обработай случаи, когда файл
 * повреждён или содержит неверный формат").
 */
function readArticleFile(slug) {
  const filePath = articlePath(slug);
  if (!fs.existsSync(filePath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`[articles-store] Не удалось прочитать ${filePath}:`, e.message);
    return null;
  }

  let parsed;
  try {
    parsed = matter(raw);
  } catch (e) {
    console.error(`[articles-store] Повреждённый frontmatter в ${filePath}:`, e.message);
    // Отдаём статью как есть, без метаданных, чтобы контент не потерялся молча
    parsed = { data: {}, content: raw };
  }

  const fm = parsed.data || {};

  return {
    id: slug, // для обратной совместимости с фронтендом, ожидающим article.id
    slug,
    title: fm.title || slug,
    content: parsed.content.trim(),
    views: typeof fm.views === 'number' ? fm.views : 0,
    locked: !!fm.locked,
    role: Array.isArray(fm.roles) && fm.roles.length > 0 ? JSON.stringify(fm.roles) : null,
    roles: Array.isArray(fm.roles) ? fm.roles : [],
    category: fm.category || '',
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    author: fm.author || '',
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
  const frontmatter = {
    title: article.title,
    date: article.created_at,
    updated: article.updated_at,
    author: article.author || '',
    tags: article.tags || [],
    category: article.category || '',
    excerpt: article.excerpt || '',
    server: article.server ?? null,
    locked: !!article.locked,
    roles: article.roles || [],
    image: article.image || null,
    attachments: article.attachments || [],
    views: article.views || 0
  };
  if (article.legacyId != null) {
    frontmatter.legacyId = article.legacyId;
  }

  const fileContents = matter.stringify(article.content || '', frontmatter);
  fs.writeFileSync(articlePath(slug), fileContents, 'utf8');
}

/**
 * Возвращает список всех статей (из кэша, если он свежий).
 */
function listArticles() {
  if (cache) return cache;

  ensureDirs();
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md'));
  const articles = [];

  for (const file of files) {
    const slug = file.slice(0, -3);
    const article = readArticleFile(slug);
    if (article) articles.push(article);
  }

  articles.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  cache = articles;
  return cache;
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
  ensureDirs();
  const base = slugify(title);
  const existing = new Set(
    fs.readdirSync(CONTENT_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3))
      .filter(s => s !== excludeSlug)
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
    content: fields.content || '',
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: normalizeRoles(fields.role, fields.roles),
    category: fields.category || '',
    tags: fields.tags || [],
    author: fields.author || '',
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
 * Низкоуровневая запись статьи с явными датами/legacyId — используется только
 * скриптом миграции (scripts/migrate-articles-to-markdown.js), чтобы сохранить
 * исходные даты создания/изменения и id из articles.db вместо простановки "now".
 */
function importArticle(slug, fields) {
  ensureDirs();
  writeArticleFile(slug, {
    title: fields.title || 'Без названия',
    content: fields.content || '',
    views: fields.views || 0,
    locked: !!fields.locked,
    roles: fields.roles || [],
    category: fields.category || '',
    tags: fields.tags || [],
    author: fields.author || '',
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
    content: fields.content ?? existing.content,
    views: fields.views ?? existing.views,
    locked: fields.locked !== undefined ? !!fields.locked : existing.locked,
    roles: (fields.role !== undefined || fields.roles !== undefined)
      ? normalizeRoles(fields.role, fields.roles)
      : existing.roles,
    category: fields.category ?? existing.category,
    tags: fields.tags ?? existing.tags,
    author: fields.author ?? existing.author,
    image: fields.image !== undefined ? normalizeImagePath(fields.image) : existing.image,
    attachments: fields.attachments ?? existing.attachments,
    server: fields.server ?? existing.server,
    excerpt: fields.excerpt ?? existing.excerpt,
    created_at: existing.created_at,
    updated_at: new Date().toISOString()
  };

  // Примечание: заголовок статьи можно менять без переименования файла — slug
  // (и, соответственно, wiki-ссылки [[slug]] на неё) стабилен, пока статью не
  // переименуют явно (см. Этап 4, "быстрое переименование с обновлением ссылок").
  writeArticleFile(slug, updated);
  invalidateCache();
  return getArticle(slug);
}

/**
 * "Удаляет" статью, перемещая файл в content/.trash/ вместо безвозвратного
 * удаления — см. requirement Этапа 4 "удаление должно перемещать файл в
 * корзину, а не удалять безвозвратно".
 */
function deleteArticle(slug) {
  if (!isSafeSlug(slug)) return false;
  const filePath = articlePath(slug);
  if (!fs.existsSync(filePath)) return false;

  ensureDirs();
  const trashName = `${slug}.${Date.now()}.md`;
  fs.renameSync(filePath, path.join(TRASH_DIR, trashName));
  invalidateCache();
  return true;
}

/**
 * Переименовывает статью: меняет заголовок и slug (а значит — и имя файла),
 * и обновляет [[wiki-ссылки]] на неё во всех остальных статьях, чтобы они
 * продолжали указывать на правильный файл (см. Этап 4, "быстрое
 * переименование статьи с автоматическим обновлением ссылок").
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

  // Обновляем [[oldSlug]] / [[oldSlug|текст]] / [[oldSlug#заголовок]] в остальных статьях
  const updatedArticles = [];
  const linkRe = new RegExp(`\\[\\[\\s*${escapeRegExp(oldSlug)}(\\s*[|#][^\\]]*)?\\]\\]`, 'gi');
  // Также поддерживаем ссылки по исходному заголовку статьи (Obsidian принимает
  // и то, и другое как цель — у нас slug всегда транслитерирован из заголовка)
  const titleRe = new RegExp(`\\[\\[\\s*${escapeRegExp(existing.title)}(\\s*[|#][^\\]]*)?\\]\\]`, 'gi');

  for (const article of listArticles()) {
    if (article.slug === newSlug) continue;
    if (!linkRe.test(article.content) && !titleRe.test(article.content)) continue;

    linkRe.lastIndex = 0;
    titleRe.lastIndex = 0;
    const newContent = article.content
      .replace(linkRe, (m, suffix) => `[[${newSlug}${suffix || ''}]]`)
      .replace(titleRe, (m, suffix) => `[[${newSlug}${suffix || ''}]]`);

    writeArticleFile(article.slug, { ...article, content: newContent });
    updatedArticles.push(article.slug);
  }

  if (updatedArticles.length > 0) invalidateCache();

  return { oldSlug, newSlug, updatedArticles };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchArticles(query, { limit = 50, offset = 0 } = {}) {
  const q = query.trim().toLowerCase();
  const all = listArticles();

  const scored = all
    .map(article => {
      const titleLower = article.title.toLowerCase();
      const contentLower = article.content.toLowerCase();
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

// === Wiki-ссылки и backlinks (данные для Этапа 4) ===

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/**
 * Извлекает все wiki-ссылки [[slug]] / [[slug|текст]] из содержимого статьи.
 */
function extractWikiLinks(content) {
  const links = new Set();
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content || '')) !== null) {
    const target = slugify(m[1].trim());
    if (target) links.add(target);
  }
  return Array.from(links);
}

// #тег прямо в тексте статьи (не путать с frontmatter tags:) — Obsidian-стиль.
// Не матчим внутри слов (например #include в код-блоке) — требуем начало строки
// или пробел/пунктуацию перед решёткой.
const HASHTAG_RE = /(^|\s)#([a-zA-Zа-яА-ЯёЁ0-9_-]+)/g;

/**
 * Извлекает #теги, упомянутые прямо в тексте статьи (в нижнем регистре).
 */
function extractHashtags(content) {
  const tags = new Set();
  let m;
  HASHTAG_RE.lastIndex = 0;
  while ((m = HASHTAG_RE.exec(content || '')) !== null) {
    tags.add(m[2].toLowerCase());
  }
  return Array.from(tags);
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
  getArticle,
  createArticle,
  importArticle,
  updateArticle,
  deleteArticle,
  renameArticle,
  searchArticles,
  extractWikiLinks,
  extractHashtags,
  getBacklinks,
  generateUniqueSlug,
  invalidateCache,
  isSafeSlug
};
