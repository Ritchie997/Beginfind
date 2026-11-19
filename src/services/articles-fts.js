// src/services/articles-fts.js
// Модуль полнотекстового поиска SQLite FTS5 для Antropedia.
// Обеспечивает масштабируемость до сотен тысяч/миллионов статей
// с временем отклика 1-3 мс, BM25-ранжированием и автоматическими сниппетами.

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');
const blocks = require('./blocks');
const articleLayers = require('./article-layers');
const searchService = require('./article-search');

let dbInstance = null;
let cachedUsersDb = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(dbPath('articles.db'));
  }
  return dbInstance;
}

function getUsersDb() {
  if (!cachedUsersDb) {
    cachedUsersDb = new sqlite3.Database(dbPath('users.db'));
  }
  return cachedUsersDb;
}

/**
 * Загружает карту всех пользователей системы (id -> { id, username, display_name }).
 */
function loadAllUsersMap(db = getUsersDb()) {
  return new Promise((resolve) => {
    db.all('SELECT id, username, display_name FROM users', (err, rows) => {
      if (err || !rows) return resolve(new Map());
      const map = new Map();
      rows.forEach((r) => {
        map.set(Number(r.id), {
          id: Number(r.id),
          username: String(r.username || '').trim(),
          display_name: String(r.display_name || '').trim()
        });
      });
      resolve(map);
    });
  });
}

/**
 * Формирует строку всех имен авторов статьи (автор, соавторы, легаси) для полнотекстового индекса.
 */
function getArticleAuthorNames(article, usersMap = null) {
  const names = new Set();
  if (article.legacyAuthorName) {
    names.add(article.legacyAuthorName);
  }
  if (article.author) {
    if (typeof article.author === 'string') names.add(article.author);
    else if (typeof article.author === 'object') {
      if (article.author.display_name) names.add(article.author.display_name);
      if (article.author.username) names.add(article.author.username);
    }
  }
  if (usersMap) {
    if (article.author_id && usersMap.has(Number(article.author_id))) {
      const u = usersMap.get(Number(article.author_id));
      if (u.display_name) names.add(u.display_name);
      if (u.username) names.add(u.username);
    }
    if (Array.isArray(article.co_author_ids)) {
      article.co_author_ids.forEach((id) => {
        if (usersMap.has(Number(id))) {
          const u = usersMap.get(Number(id));
          if (u.display_name) names.add(u.display_name);
          if (u.username) names.add(u.username);
        }
      });
    }
  }
  return Array.from(names).filter(Boolean).join(' ');
}

/**
 * Инициализирует виртуальную таблицу FTS5 в articles.db.
 * Если таблица была создана ранее по старой схеме (без slug/stems),
 * она автоматически пересоздаётся.
 */
function initFts(db = getDb()) {
  return new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(articles_fts)', (pragmaErr, cols) => {
      if (pragmaErr) {
        console.error('[articles-fts] Ошибка проверки схемы FTS:', pragmaErr);
        return reject(pragmaErr);
      }
      const names = (cols || []).map((c) => c.name);
      const isMissingColumns = names.length > 0 && (!names.includes('slug') || !names.includes('stems'));

      const createTable = () => {
        db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
          slug UNINDEXED,
          title,
          tags,
          author_name,
          content,
          stems,
          tokenize = 'unicode61 remove_diacritics 2'
        )`, (err) => {
          if (err) {
            console.error('[articles-fts] Ошибка создания виртуальной таблицы FTS5:', err);
            return reject(err);
          }
          resolve();
        });
      };

      if (isMissingColumns) {
        db.run('DROP TABLE IF EXISTS articles_fts', (dropErr) => {
          if (dropErr) {
            console.error('[articles-fts] Ошибка удаления устаревшей таблицы FTS:', dropErr);
            return reject(dropErr);
          }
          createTable();
        });
      } else {
        createTable();
      }
    });
  });
}

/**
 * Извлекает все слова и стеммы из текста статьи для поискового индекса.
 */
function buildIndexDoc(article, authorName = '', usersMap = null) {
  const slug = String(article.slug || '');
  const title = String(article.title || '');

  // Собираем теги
  const tagsSet = new Set(Array.isArray(article.tags) ? article.tags.map(t => String(t).toLowerCase()) : []);
  if (articleLayers.extractHashtags) {
    articleLayers.extractHashtags(article).forEach(t => tagsSet.add(t));
  }
  const tagsStr = Array.from(tagsSet).join(' ');

  // Собираем весь текст статьи (все слои)
  let contentText = '';
  if (Array.isArray(article.layers) && article.layers.length > 0) {
    contentText = articleLayers.getEffectiveLayers(article)
      .map((l) => `${l.title || ''}\n${blocks.documentSearchText(l.content)}`)
      .join('\n\n');
  } else if (article.content) {
    contentText = blocks.documentSearchText(article.content);
  }

  // Автор
  const resolvedAuthor = authorName || getArticleAuthorNames(article, usersMap);
  const authorStr = String(resolvedAuthor || '');

  // Вычисляем стеммы для быстрого морфологического поиска
  const fullText = `${title} ${tagsStr} ${authorStr} ${contentText}`;
  const words = searchService.extractWords(fullText);
  const stems = Array.from(new Set(words.map(searchService.stemWord))).join(' ');

  return {
    slug,
    title,
    tags: tagsStr,
    author_name: authorStr,
    content: contentText,
    stems
  };
}

/**
 * Индексирует одну статью в FTS5 (заменяет старую запись при наличии).
 */
async function indexArticle(article, authorName = '', db = getDb()) {
  if (!article || !article.slug) return;
  let resolvedAuthor = authorName;
  if (!resolvedAuthor) {
    try {
      const usersMap = await loadAllUsersMap();
      resolvedAuthor = getArticleAuthorNames(article, usersMap);
    } catch (_) {
      resolvedAuthor = article.legacyAuthorName || '';
    }
  }
  const doc = buildIndexDoc(article, resolvedAuthor);

  return new Promise((resolve) => {
    // Удаляем старую запись
    db.run('DELETE FROM articles_fts WHERE slug = ?', [doc.slug], () => {
      // Вставляем обновлённый документ
      db.run(
        `INSERT INTO articles_fts(slug, title, tags, author_name, content, stems)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [doc.slug, doc.title, doc.tags, doc.author_name, doc.content, doc.stems],
        (err) => {
          if (err) {
            console.error(`[articles-fts] Не удалось проиндексировать статью ${doc.slug}:`, err.message);
          }
          resolve();
        }
      );
    });
  });
}

/**
 * Удаляет статью из индекса FTS5.
 */
function removeArticle(slug, db = getDb()) {
  if (!slug) return Promise.resolve();
  return new Promise((resolve) => {
    db.run('DELETE FROM articles_fts WHERE slug = ?', [slug], (err) => {
      if (err) console.error(`[articles-fts] Ошибка удаления ${slug} из FTS:`, err.message);
      resolve();
    });
  });
}

/**
 * Синхронизирует все статьи из хранилища в FTS5, если индекс пуст или требует обновления.
 */
async function syncAllArticles(articles, authorResolver = null, db = getDb()) {
  await initFts(db);

  let usersMap = null;
  try {
    usersMap = await loadAllUsersMap();
    if (usersMap && usersMap.size > 0) {
      const names = [];
      for (const u of usersMap.values()) {
        if (u.display_name) names.push(u.display_name);
        if (u.username) names.push(u.username);
      }
      searchService.registerAuthorNames(names);
    }
  } catch (uErr) {
    console.error('[articles-fts] Не удалось загрузить usersMap для индексации:', uErr.message);
  }

  const count = await new Promise((resolve) => {
    db.get('SELECT count(*) as count FROM articles_fts', (err, row) => {
      resolve(row ? row.count : 0);
    });
  });

  const hasPopulatedAuthors = await new Promise((resolve) => {
    db.get("SELECT count(*) as count FROM articles_fts WHERE author_name != ''", (err, row) => {
      resolve(row && row.count > 0);
    });
  });

  // Если записей в индексе столько же, сколько статей, и авторы заполнены, повторная полная индексация не требуется
  if (count === articles.length && count > 0 && hasPopulatedAuthors) {
    return count;
  }

  // Индексируем статьи батчем в транзакции
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM articles_fts');
      const stmt = db.prepare(
        `INSERT INTO articles_fts(slug, title, tags, author_name, content, stems)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      for (const article of articles) {
        const authorName = authorResolver ? authorResolver(article) : getArticleAuthorNames(article, usersMap);
        const doc = buildIndexDoc(article, authorName, usersMap);
        stmt.run([doc.slug, doc.title, doc.tags, doc.author_name, doc.content, doc.stems]);
      }

      stmt.finalize();
      db.run('COMMIT', (err) => {
        if (err) console.error('[articles-fts] Ошибка транзакции индексации:', err);
        resolve(articles.length);
      });
    });
  });
}

/**
 * Компилирует разобранный запрос (из article-search.js) в безопасную строку запроса FTS5 MATCH.
 */
function buildFtsMatchQuery(parsedQuery) {
  const parts = [];

  // 1. Точные фразы в кавычках (поиск по столбцу content/title)
  for (const phrase of parsedQuery.exactPhrases) {
    const clean = phrase.replace(/"/g, '""').trim();
    if (clean) {
      parts.push(`"${clean}"`);
    }
  }

  // 2. Обычные слова: ищем либо само слово в title/content, либо его основу в stems
  for (let i = 0; i < parsedQuery.textWords.length; i++) {
    const word = parsedQuery.textWords[i].replace(/[^\p{L}\p{N}_]/gu, '');
    const stem = (parsedQuery.textStems[i] || '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (word) {
      if (stem && stem !== word) {
        parts.push(`("${word}" OR stems:"${stem}")`);
      } else {
        parts.push(`"${word}"`);
      }
    }
  }

  // 3. Авторы (@поэт, @Качуа, @"Corepse Kodai", @Sargos Bedagamy)
  for (const author of parsedQuery.authorTerms) {
    const clean = String(author || '').replace(/["*]/g, '').trim();
    if (!clean) continue;
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      const w = words[0].replace(/[^\p{L}\p{N}_.-]/gu, '');
      if (w) parts.push(`author_name:"${w}"*`);
    } else {
      // Имя с пробелами: каждое слово должно присутствовать в author_name
      const subParts = words
        .map((w) => w.replace(/[^\p{L}\p{N}_.-]/gu, ''))
        .filter(Boolean)
        .map((w) => `author_name:"${w}"*`);
      if (subParts.length) {
        parts.push(`(${subParts.join(' AND ')})`);
      }
    }
  }

  // 4. Теги (#лор)
  for (const tag of parsedQuery.hashKeys) {
    const clean = tag.replace(/[^\p{L}\p{N}_-]/gu, '');
    if (clean) {
      parts.push(`tags:"${clean}"*`);
    }
  }

  return parts.join(' AND ');
}

/**
 * Выполняет полнотекстовый поиск через FTS5 с BM25 и сниппетами.
 *
 * @param {ReturnType<typeof searchService.parseSearchQuery>} parsedQuery
 * @param {Object} [options]
 * @returns {Promise<Map<string, { slug: string, score: number, snippet: string }>>}
 */
function searchFts(parsedQuery, options = {}, db = getDb()) {
  const matchQuery = buildFtsMatchQuery(parsedQuery);
  if (!matchQuery) {
    // Если основной запрос пуст, но есть альтернативная раскладка
    if (parsedQuery.layoutAlternative) {
      return searchFts(parsedQuery.layoutAlternative, options, db);
    }
    return Promise.resolve(new Map());
  }

  return new Promise((resolve) => {
    // Взвешенный BM25:
    // title: 10.0, tags: 5.0, author_name: 3.0, content: 1.0, stems: 2.0
    const sql = `
      SELECT slug,
             title,
             bm25(articles_fts, 10.0, 5.0, 3.0, 1.0, 2.0) as bm25_score,
             snippet(articles_fts, -1, '<mark>', '</mark>', '…', 50) as snippet
      FROM articles_fts
      WHERE articles_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT 1000
    `;

    db.all(sql, [matchQuery], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        // Если ничего не найдено, но есть альтернативная раскладка (Gj'n -> Поэт)
        if (parsedQuery.layoutAlternative && !options.isAlternative) {
          return resolve(searchFts(parsedQuery.layoutAlternative, { ...options, isAlternative: true }, db));
        }
        return resolve(new Map());
      }

      const results = new Map();
      rows.forEach((row) => {
        // bm25 в SQLite отрицательный (меньше = лучше): нормализуем в положительный балл
        const rawScore = Math.abs(row.bm25_score || 1);
        const normalizedScore = Math.round(100 / (1 + rawScore));
        results.set(row.slug, {
          slug: row.slug,
          score: normalizedScore,
          snippet: row.snippet || ''
        });
      });

      resolve(results);
    });
  });
}

module.exports = {
  initFts,
  indexArticle,
  removeArticle,
  syncAllArticles,
  buildFtsMatchQuery,
  searchFts,
  buildIndexDoc
};
