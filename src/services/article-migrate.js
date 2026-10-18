// article-migrate.js — "полная перезапись" статей в актуальном формате.
//
// Чтение и запись статей и так нормализуют содержимое (blocks.normalizeDocument,
// article-layers.normalizeLayers), но файлы на диске, сохранённые старыми
// версиями сайта или импортированные вручную, остаются как были, пока их не
// откроют и не пересохранят. Этот модуль проходит по всем content/*.json,
// приводит каждый к актуальной форме и пишет обратно ТОЛЬКО те, что реально
// изменились (идемпотентно: повторный запуск ничего не меняет).
//
// Что чинится:
//   — content и layers[].content: схема блоков, id блоков, адреса картинок;
//   — image (обложка) статьи и слоёв: значение, не похожее на путь к картинке
//     (например "/gZfLhZTD"), заменяется обложкой из инфобокса или null;
//   — (опционально, inheritLayerCover) слои без обложки получают обложку статьи;
//     по умолчанию выключено: сервер и так показывает обложку статьи, если у
//     слоя своей нет (см. formatArticleResponse), а копия в слоях мешала бы
//     её убрать;
//   — типы служебных полей (tags, roles, attachments, author_id, views, ...);
//   — устаревшие поля categories/category.
// Неизвестные поля файла сохраняются как есть (например legacy-поле author).
//
// Перед записью оригинал каждого изменяемого файла копируется в
// backups/articles-migration/<метка времени>/ — откат = вернуть файл в content/.

const fs = require('fs');
const path = require('path');
const { CONTENT_DIR, BACKUPS_DIR, UPLOADS_DIR } = require('../config/paths');
const blocks = require('./blocks');
const articleLayers = require('./article-layers');

const FILE_EXT = '.json';
const MIGRATION_BACKUPS_DIR = path.join(BACKUPS_DIR, 'articles-migration');

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// JSON с отсортированными ключами — чтобы разный порядок ключей не считался
// изменением.
function stable(value) {
  return JSON.stringify(value, (_k, v) => {
    if (!isPlainObject(v)) return v;
    return Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {});
  });
}

function show(v) {
  if (v === undefined) return 'нет';
  if (v === null) return 'null';
  return typeof v === 'string' ? `"${v}"` : stable(v);
}

function firstInfoboxImage(doc) {
  let found = null;
  blocks.visitBlocks(doc, (b) => {
    if (!found && b.type === 'infobox' && b.data && b.data.image && b.data.image.src) {
      found = b.data.image.src;
    }
  });
  return found;
}

// Файл обложки из /uploads/ существует? (внешние адреса не проверяем)
function uploadMissing(cover) {
  if (!cover || !cover.startsWith('/uploads/')) return false;
  try {
    const rel = decodeURIComponent(cover.slice('/uploads/'.length).split(/[?#]/)[0]);
    const full = path.resolve(UPLOADS_DIR, rel);
    if (!full.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return false;
    return !fs.existsSync(full);
  } catch (e) {
    return false;
  }
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Приводит сырое содержимое файла статьи к актуальной форме.
 * Чистая функция: ничего не читает и не пишет на диск.
 * @param {object} raw — разобранный JSON файла статьи
 * @param {{slug?: string, inheritLayerCover?: boolean}} opts
 * @returns {{next: object, changes: string[], warnings: string[]}}
 */
function migrateRaw(raw, { slug = '', inheritLayerCover = false } = {}) {
  const next = JSON.parse(JSON.stringify(raw));
  const changes = [];
  const warnings = [];

  const setField = (key, value, label = key) => {
    if (stable(next[key]) === stable(value) && key in next) return;
    changes.push(`${label}: ${show(next[key])} → ${show(value)}`);
    next[key] = value;
  };

  // --- содержимое ---
  const content = blocks.normalizeDocument(raw.content);
  if (stable(content) !== stable(raw.content)) {
    next.content = content;
    changes.push('content: блоки приведены к актуальной схеме');
  }

  // --- обложка статьи ---
  // Битое значение (задано, но не путь к картинке) → обложка из инфобокса или
  // null. Пустое значение не трогаем: отсутствие обложки — выбор автора.
  const infoboxCover = blocks.sanitizeCoverPath(firstInfoboxImage(content));
  let cover = blocks.sanitizeCoverPath(raw.image);
  if (raw.image && !cover) {
    cover = infoboxCover;
    changes.push(`image: битое значение ${show(raw.image)} → ${show(cover)}`);
    next.image = cover;
  } else if (raw.image && cover !== raw.image) {
    changes.push(`image: ${show(raw.image)} → ${show(cover)}`);
    next.image = cover;
  } else if (!('image' in next)) {
    next.image = null;
    changes.push('image: добавлено поле (null)');
  }
  if (uploadMissing(cover)) warnings.push(`обложка ссылается на отсутствующий файл ${cover}`);

  // --- слои ---
  const rawLayers = Array.isArray(raw.layers) ? raw.layers.filter(isPlainObject) : [];
  const baseLayers = articleLayers.normalizeLayers(raw.layers);
  const layers = baseLayers.map((layer, i) => {
    const rawImage = rawLayers[i] && rawLayers[i].image;
    let image = layer.image;
    if (rawImage && !image) {
      image = cover || infoboxCover;
      changes.push(`layers[${i}].image: битое значение ${show(rawImage)} → ${show(image)}`);
    } else if (!rawImage && !image && inheritLayerCover && cover) {
      image = cover;
      changes.push(`layers[${i}].image: null → ${show(cover)} (обложка статьи)`);
    }
    return image === layer.image ? layer : { ...layer, image };
  });
  if (stable(baseLayers) !== stable(raw.layers)) {
    changes.push(Array.isArray(raw.layers)
      ? 'layers: структура приведена к актуальной схеме'
      : 'layers: добавлено поле ([])');
  }
  if (stable(layers) !== stable(raw.layers)) next.layers = layers;

  // --- служебные поля ---
  if (!(typeof raw.title === 'string' && raw.title.trim())) setField('title', slug || 'Без названия');
  setField('tags', (Array.isArray(raw.tags) ? raw.tags : [])
    .map((t) => String(t == null ? '' : t).trim()).filter(Boolean));
  setField('roles', (Array.isArray(raw.roles) ? raw.roles : [])
    .map((r) => (typeof r === 'string' && r.trim() !== '' && !isNaN(r) ? parseInt(r, 10) : r)));
  setField('attachments', Array.isArray(raw.attachments) ? raw.attachments : []);
  setField('co_author_ids', (Array.isArray(raw.co_author_ids) ? raw.co_author_ids : [])
    .map(toInt).filter((n) => n !== null));
  setField('author_id', raw.author_id != null ? toInt(raw.author_id) : null);
  setField('views', typeof raw.views === 'number' ? raw.views : 0);
  setField('locked', !!raw.locked);
  setField('excerpt', typeof raw.excerpt === 'string' ? raw.excerpt : '');
  if (!('server' in next)) setField('server', null);

  for (const legacy of ['categories', 'category']) {
    if (legacy in next) {
      delete next[legacy];
      changes.push(`${legacy}: устаревшее поле удалено`);
    }
  }

  return { next, changes, warnings };
}

/**
 * Проходит по content/*.json. dryRun=true — только отчёт, ничего не пишется.
 * @param {{dryRun?: boolean, slugs?: string[]|null, inheritLayerCover?: boolean}} opts
 */
function runMigration({ dryRun = true, slugs = null, inheritLayerCover = false } = {}) {
  // Берём store лениво: он сам подключает этот модуль только по требованию,
  // а скрипт командной строки не должен зависеть от порядка require.
  const store = require('./articles-store');

  const report = {
    dryRun,
    at: new Date().toISOString(),
    total: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    backupDir: null,
    items: [],
    failures: []
  };

  if (!fs.existsSync(CONTENT_DIR)) return report;

  const wanted = Array.isArray(slugs) && slugs.length ? new Set(slugs) : null;
  const files = fs.readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(FILE_EXT))
    .filter((f) => !wanted || wanted.has(f.slice(0, -FILE_EXT.length)));

  for (const file of files) {
    const slug = file.slice(0, -FILE_EXT.length);
    if (!store.isSafeSlug(slug)) continue;
    const filePath = path.join(CONTENT_DIR, file);
    report.total += 1;

    let rawText;
    let raw;
    try {
      rawText = fs.readFileSync(filePath, 'utf8');
      raw = JSON.parse(rawText);
      if (!isPlainObject(raw)) throw new Error('файл не содержит объект статьи');
    } catch (e) {
      report.failed += 1;
      report.failures.push({ slug, error: e.message });
      continue;
    }

    let result;
    try {
      result = migrateRaw(raw, { slug, inheritLayerCover });
    } catch (e) {
      report.failed += 1;
      report.failures.push({ slug, error: e.message });
      continue;
    }

    const { next, changes, warnings } = result;
    if (changes.length || warnings.length) {
      report.items.push({ slug, title: next.title || slug, changes, warnings });
    }
    if (!changes.length) {
      report.unchanged += 1;
      continue;
    }
    report.changed += 1;
    if (dryRun) continue;

    try {
      if (!report.backupDir) {
        const stamp = report.at.replace(/[:.]/g, '-');
        report.backupDir = path.join(MIGRATION_BACKUPS_DIR, stamp);
        fs.mkdirSync(report.backupDir, { recursive: true });
      }
      fs.writeFileSync(path.join(report.backupDir, file), rawText, 'utf8');

      // Запись через временный файл: обрыв посреди записи не оставит
      // половину статьи.
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      report.changed -= 1;
      report.failed += 1;
      report.failures.push({ slug, error: `не удалось записать: ${e.message}` });
    }
  }

  if (!dryRun && report.changed > 0) store.invalidateCache();
  return report;
}

module.exports = { migrateRaw, runMigration, MIGRATION_BACKUPS_DIR };
