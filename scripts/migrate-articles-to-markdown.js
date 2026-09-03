#!/usr/bin/env node
// migrate-articles-to-markdown.js — одноразовый скрипт миграции статей
// из articles.db (SQLite, HTML в колонке content) в content/*.md
// (Markdown + YAML frontmatter).
//
// Запуск: node scripts/migrate-articles-to-markdown.js
//
// Скрипт НЕ удаляет articles.db и НЕ трогает таблицу categories — она
// по-прежнему используется как справочник категорий (см. src/routes/taxonomy.routes.js).
// Безопасно запускать повторно: уже смигрированные статьи (по legacyId) пропускаются.

const sqlite3 = require('sqlite3').verbose();
const TurndownService = require('turndown');
const { dbPath } = require('../src/config/paths');
const store = require('../src/services/articles-store');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
});

// Редакторские div-обёртки картинок (image-wrapper/image-control-panel и т.п.)
// не несут смысловой нагрузки в Markdown — разворачиваем их в содержимое,
// оставляя сам <img> для стандартного правила turndown.
turndown.addRule('unwrapEditorWrappers', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    /image-wrapper|image-control-panel|image-caption/.test(node.getAttribute('class') || ''),
  replacement: (content, node) => {
    if ((node.getAttribute('class') || '').includes('image-control-panel')) {
      return ''; // кнопки управления картинкой в редакторе — не часть контента
    }
    return content;
  }
});

function parseRoles(roleField) {
  if (!roleField) return [];
  try {
    const values = (roleField.startsWith('[') && roleField.endsWith(']'))
      ? JSON.parse(roleField)
      : [roleField];
    return values.map(v => (typeof v === 'string' && !isNaN(v)) ? parseInt(v) : v);
  } catch (e) {
    return [roleField];
  }
}

function toIsoDate(sqliteDate) {
  if (!sqliteDate) return new Date().toISOString();
  // SQLite CURRENT_TIMESTAMP формата "YYYY-MM-DD HH:MM:SS" (UTC, без 'T'/'Z')
  const iso = sqliteDate.includes('T') ? sqliteDate : sqliteDate.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function migrate() {
  const db = new sqlite3.Database(dbPath('articles.db'), sqlite3.OPEN_READONLY);

  const rows = await new Promise((resolve, reject) => {
    db.all('SELECT * FROM articles', (err, rows) => err ? reject(err) : resolve(rows));
  });

  console.log(`Найдено статей в articles.db: ${rows.length}`);

  const alreadyMigrated = new Set(
    store.listArticles()
      .filter(a => a.legacyId != null)
      .map(a => a.legacyId)
  );

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (alreadyMigrated.has(row.id)) {
      console.log(`— пропущена (уже смигрирована): [${row.id}] ${row.title}`);
      skipped++;
      continue;
    }

    const markdown = turndown.turndown(row.content || '');
    const slug = store.generateUniqueSlug(row.title || `article-${row.id}`);

    store.importArticle(slug, {
      title: row.title,
      content: markdown,
      views: row.views || 0,
      locked: row.locked === 1,
      roles: parseRoles(row.role),
      category: row.category || '',
      tags: row.tags ? JSON.parse(row.tags) : [],
      author: row.author || '',
      image: row.image || null,
      attachments: row.attachments ? JSON.parse(row.attachments) : [],
      server: row.server || null,
      created_at: toIsoDate(row.created_at),
      updated_at: toIsoDate(row.updated_at),
      legacyId: row.id
    });

    console.log(`✓ [${row.id}] "${row.title}" -> content/${slug}.md`);
    migrated++;
  }

  db.close();

  console.log('');
  console.log(`Готово: смигрировано ${migrated}, пропущено ${skipped} (уже были смигрированы).`);
  console.log(`Файлы статей: ${store.CONTENT_DIR}`);
}

migrate().catch((err) => {
  console.error('Ошибка миграции:', err);
  process.exit(1);
});
