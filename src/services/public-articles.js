// Публичное представление статей: только whitelisted-поля публичных слоёв.

const articleLayers = require('./article-layers');
const blocks = require('./blocks');

function sanitizePublicBlocks(rawBlocks) {
  return (rawBlocks || []).flatMap((block) => {
    if (!block || !blocks.BLOCK_TYPES.includes(block.type)) return [];
    if (block.type === 'map') return [];
    if (block.type === 'image' && block.data && block.data.gallery) return [];

    if (block.type === 'columns') {
      return [{
        ...block,
        data: {
          ...block.data,
          columns: (block.data.columns || []).map((column) => ({
            ...column,
            blocks: sanitizePublicBlocks(column.blocks)
          }))
        }
      }];
    }
    if (block.type === 'spoiler-section') {
      return [{
        ...block,
        data: { ...block.data, blocks: sanitizePublicBlocks(block.data.blocks) }
      }];
    }
    return [block];
  });
}

function sanitizePublicDocument(content) {
  const normalized = blocks.normalizeDocument(content);
  return { version: 1, blocks: sanitizePublicBlocks(normalized.blocks) };
}

function toPublicArticle(article, resolved) {
  const layer = resolved.layer;
  const isLegacy = !Array.isArray(article.layers) || article.layers.length === 0;

  return {
    slug: article.slug,
    title: layer.title || (isLegacy ? article.title : article.slug),
    excerpt: layer.excerpt || (isLegacy ? article.excerpt : ''),
    image: layer.image || (isLegacy ? article.image : null),
    content: sanitizePublicDocument(layer.content),
    tags: Array.isArray(layer.tags) ? layer.tags : [],
    created_at: article.created_at,
    updated_at: article.updated_at
  };
}

const EXCERPT_MAX_LEN = 180;

// Если у статьи нет явного описания, карточке каталога нужен короткий кусок
// текста (в админке то же делает blocksToExcerptText на клиенте). Здесь —
// упрощённый серверный вариант по публичному слою: убираем разметку wiki-ссылок
// и markdown-символы, схлопываем пробелы и режем по границе слова.
function excerptFromDocument(content) {
  const raw = blocks.documentSearchText(sanitizePublicDocument(content))
    .replace(/\[([^\]\n]*)\]\(\(([^()#\n]+)(?:#[^()\n]*)?\)\)/g, (m, label, target) => label || target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    .replace(/[*_~`]|\+\+|==|\|\|/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length <= EXCERPT_MAX_LEN) return raw;
  return raw.slice(0, EXCERPT_MAX_LEN).replace(/\s+\S*$/, '') + '…';
}

function toPublicArticleSummary(article, resolved) {
  const layer = resolved.layer;
  const isLegacy = !Array.isArray(article.layers) || article.layers.length === 0;
  return {
    slug: article.slug,
    title: layer.title || (isLegacy ? article.title : article.slug),
    excerpt: layer.excerpt || (isLegacy ? article.excerpt : '') || excerptFromDocument(layer.content),
    image: layer.image || (isLegacy ? article.image : null),
    tags: Array.isArray(layer.tags) ? layer.tags : [],
    created_at: article.created_at,
    updated_at: article.updated_at
  };
}

function getPublicArticle(article) {
  const resolved = articleLayers.resolvePublicArticleLayers(article);
  if (!resolved) return null;
  return toPublicArticle(article, resolved);
}

function publicArticleSearchText(article, resolved) {
  const isLegacy = !Array.isArray(article.layers) || article.layers.length === 0;
  return resolved.accessible.map((index) => {
    const layer = resolved.layers[index];
    const title = layer.title || (isLegacy ? article.title : article.slug);
    return `${title || ''}\n${layer.excerpt || ''}\n${blocks.documentSearchText(layer.content)}`;
  }).join('\n\n').toLocaleLowerCase();
}

// Теги, видимые гостю у статьи: поле «Теги» доступных слоёв и #хэштеги из их
// текста. Map<ключ в нижнем регистре, подпись>: подпись автора (регистр) важнее
// хэштега, поэтому хэштег добавляется, только если такого ключа ещё нет.
function publicArticleTagLabels(resolved) {
  const labels = new Map();
  resolved.accessible.forEach((index) => {
    (resolved.layers[index].tags || []).forEach((tag) => {
      const label = String(tag).trim();
      const key = label.toLocaleLowerCase();
      if (key && !labels.has(key)) labels.set(key, label);
    });
  });
  resolved.accessible.forEach((index) => {
    blocks.extractHashtagsFromDocument(resolved.layers[index].content).forEach((tag) => {
      const key = String(tag).toLocaleLowerCase();
      if (key && !labels.has(key)) labels.set(key, tag);
    });
  });
  return labels;
}

function publicArticleTags(resolved) {
  return new Set(publicArticleTagLabels(resolved).keys());
}

function normalizeTagKey(value) {
  return String(value || '').trim().replace(/^#+/, '').toLocaleLowerCase();
}

// Конец выбранного дня — по UTC, как и сама граница «от» (new Date('2026-01-10')
// это полночь UTC), иначе результат зависел бы от часового пояса сервера.
function parseDateBound(value, endOfDay) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

const SORT_MODES = ['newest', 'oldest', 'updated', 'views', 'alpha', 'relevance'];

function listPublicArticles(articles, {
  q = '', tag = '', sort = '', viewCounts = null, dateFrom = '', dateTo = '', limit = 30, offset = 0
} = {}) {
  // «#слово» в строке поиска — это тег (совпадение по началу тега), остальное —
  // текстовый запрос; так же устроен поиск в админке.
  const words = String(q).trim().slice(0, 200).split(/\s+/).filter(Boolean);
  const hashKeys = words.filter((w) => w.startsWith('#')).map(normalizeTagKey).filter(Boolean);
  const query = words.filter((w) => !w.startsWith('#')).join(' ').toLocaleLowerCase();
  const tagKeys = String(tag).slice(0, 300).split(',').map(normalizeTagKey).filter(Boolean).slice(0, 20);
  const from = parseDateBound(dateFrom, false);
  const to = parseDateBound(dateTo, true);
  const requestedSort = SORT_MODES.includes(sort) ? sort : '';
  const effectiveSort = requestedSort || (query ? 'relevance' : 'newest');
  const createdAt = (item) => new Date(item.article.created_at || 0);
  const visible = [];

  for (const article of articles) {
    const resolved = articleLayers.resolvePublicArticleLayers(article);
    if (!resolved) continue;

    const tags = publicArticleTags(resolved);
    if (tagKeys.length && !tagKeys.some((key) => tags.has(key))) continue;
    if (hashKeys.length) {
      const own = [...tags];
      if (!hashKeys.every((key) => own.some((t) => t.startsWith(key)))) continue;
    }

    if (from || to) {
      const created = article.created_at ? new Date(article.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      if (from && created < from) continue;
      if (to && created > to) continue;
    }

    let rank = 0;
    if (query) {
      const title = String(resolved.layer.title || (!article.layers || !article.layers.length ? article.title : article.slug) || '')
        .toLocaleLowerCase();
      if (title === query) rank = 3;
      else if (title.includes(query)) rank = 2;
      else if (publicArticleSearchText(article, resolved).includes(query)) rank = 1;
      if (!rank) continue;
    }
    visible.push({ article, resolved, rank });
  }

  const views = (item) => (viewCounts ? viewCounts.get(item.article.slug) || 0 : 0);
  const title = (item) => String(item.resolved.layer.title || item.article.title || item.article.slug || '');
  const newestFirst = (a, b) => createdAt(b) - createdAt(a);
  switch (effectiveSort) {
    case 'relevance':
      visible.sort((a, b) => (b.rank - a.rank) || newestFirst(a, b));
      break;
    case 'oldest':
      visible.sort((a, b) => createdAt(a) - createdAt(b));
      break;
    case 'updated':
      visible.sort((a, b) => new Date(b.article.updated_at || 0) - new Date(a.article.updated_at || 0));
      break;
    case 'views':
      visible.sort((a, b) => (views(b) - views(a)) || newestFirst(a, b));
      break;
    case 'alpha':
      visible.sort((a, b) => title(a).localeCompare(title(b), 'ru'));
      break;
    default:
      visible.sort(newestFirst);
  }

  const total = visible.length;
  const page = visible.slice(offset, offset + limit)
    .map(({ article, resolved }) => toPublicArticleSummary(article, resolved));

  return { data: page, total, limit, offset };
}

// Список тегов для фильтра каталога: только то, что видно гостю, с числом
// статей. Подпись — как у автора (регистр сохраняется).
function listPublicTags(articles) {
  const counts = new Map();
  for (const article of articles) {
    const resolved = articleLayers.resolvePublicArticleLayers(article);
    if (!resolved) continue;
    publicArticleTagLabels(resolved).forEach((label, key) => {
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag: label, count: 1 });
    });
  }
  return [...counts.values()].sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'ru'));
}

// Лёгкий индекс (slug/title/tags) всех открытых гостю статей — клиент по нему
// отличает в тексте существующие вики-ссылки от недоступных/несуществующих.
function listPublicIndex(articles) {
  const index = [];
  for (const article of articles) {
    const resolved = articleLayers.resolvePublicArticleLayers(article);
    if (!resolved) continue;
    const { slug, title, tags } = toPublicArticleSummary(article, resolved);
    index.push({ slug, title, tags });
  }
  return index;
}

module.exports = {
  getPublicArticle,
  listPublicArticles,
  listPublicTags,
  listPublicIndex
};
