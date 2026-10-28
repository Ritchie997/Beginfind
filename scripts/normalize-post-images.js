#!/usr/bin/env node
// normalize-post-images.js — нормализация адресов картинок в таблице franchise_posts.
// Заменяет абсолютные адреса ("http://localhost:3000/uploads/...", "http://alltell.cloudpub.ru/uploads/...", "uploads/...")
// на единый относительный формат "/uploads/...".
//
// Запуск:
//   node scripts/normalize-post-images.js          (применить)
//   node scripts/normalize-post-images.js --dry    (только показать)

const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../src/config/paths');
const { toRelativeUploadPath } = require('../src/services/blocks');

const dry = process.argv.includes('--dry');
const db = new sqlite3.Database(dbPath('servers.db'));

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return toRelativeUploadPath(url.trim());
}

async function main() {
  const rows = await all('SELECT id, title, image_url, image_urls FROM franchise_posts');
  if (!rows || rows.length === 0) {
    console.log('Публикаций франшиз не найдено.');
    return;
  }

  let changed = 0;
  for (const row of rows) {
    let beforeUrl = row.image_url;
    let beforeUrls = row.image_urls;

    let newUrl = beforeUrl ? normalizeUrl(beforeUrl) : null;
    let newUrlsList = [];

    if (typeof beforeUrls === 'string' && beforeUrls.trim()) {
      try {
        const parsed = JSON.parse(beforeUrls);
        if (Array.isArray(parsed)) {
          newUrlsList = parsed.map(normalizeUrl).filter(Boolean);
        } else if (typeof parsed === 'string') {
          newUrlsList = [normalizeUrl(parsed)].filter(Boolean);
        }
      } catch (e) {
        newUrlsList = [normalizeUrl(beforeUrls)].filter(Boolean);
      }
    } else if (newUrl) {
      newUrlsList = [newUrl];
    }

    let newUrlsStr = newUrlsList.length ? JSON.stringify(newUrlsList) : null;
    if (!newUrl && newUrlsList.length) newUrl = newUrlsList[0];

    if (newUrl !== beforeUrl || newUrlsStr !== beforeUrls) {
      changed++;
      console.log(`${dry ? '[dry] ' : ''}Пост #${row.id} «${row.title}»:`);
      if (beforeUrl !== newUrl) console.log(`  image_url:  ${beforeUrl} -> ${newUrl}`);
      if (beforeUrls !== newUrlsStr) console.log(`  image_urls: ${beforeUrls} -> ${newUrlsStr}`);

      if (!dry) {
        await run('UPDATE franchise_posts SET image_url = ?, image_urls = ? WHERE id = ?', [
          newUrl,
          newUrlsStr,
          row.id
        ]);
      }
    }
  }

  console.log(`\n${dry ? 'Требуется обновить' : 'Обновлено'} постов: ${changed} из ${rows.length}`);
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
