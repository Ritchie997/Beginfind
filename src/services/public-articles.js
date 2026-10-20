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

function publicArticleTags(resolved) {
  const tags = new Set();
  resolved.accessible.forEach((index) => {
    const layer = resolved.layers[index];
    (layer.tags || []).forEach((tag) => tags.add(String(tag).toLocaleLowerCase()));
    blocks.extractHashtagsFromDocument(layer.content).forEach((tag) => tags.add(tag));
  });
  return tags;
}

function listPublicArticles(articles, { q = '', tag = '', limit = 30, offset = 0 } = {}) {
  const query = String(q).trim().slice(0, 200).toLocaleLowerCase();
  const tagQuery = String(tag).trim().replace(/^#+/, '').slice(0, 60).toLocaleLowerCase();
  const visible = [];

  for (const article of articles) {
    const resolved = articleLayers.resolvePublicArticleLayers(article);
    if (!resolved) continue;
    if (tagQuery && !publicArticleTags(resolved).has(tagQuery)) continue;

    const searchText = publicArticleSearchText(article, resolved);
    if (query && !searchText.includes(query)) continue;
    visible.push({ article, resolved });
  }

  visible.sort((a, b) =>
    new Date(b.article.created_at || 0) - new Date(a.article.created_at || 0)
  );
  const total = visible.length;
  const page = visible.slice(offset, offset + limit)
    .map(({ article, resolved }) => toPublicArticle(article, resolved));

  return { data: page, total, limit, offset };
}

module.exports = {
  getPublicArticle,
  listPublicArticles,
  sanitizePublicDocument
};
