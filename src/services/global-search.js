// src/services/global-search.js
// Единая служба глобального поиска по всей платформе AllTell:
// - Статьи Antropedia (FTS5 + стемминг + права доступа)
// - Галерея (работы, арты, описания, теги)
// - AllTell (франшизы, публикации, лента)
// - Радио (треки, подкасты, радиостанции)

const { serversDb, radioDb } = require('../db/connections');
const articlesStore = require('./articles-store');
const publicArticles = require('./public-articles');
const articleLayers = require('./article-layers');
const articlesFts = require('./articles-fts');
const searchService = require('./article-search');
const galleryStore = require('./gallery-store');
const radioStore = require('./radio-store');

function escapeLike(str) {
  return String(str || '').replace(/[\\%_]/g, (c) => '\\' + c);
}

function highlightSnippet(text, query) {
  if (!text || !query) return text || '';
  const cleanQuery = query.replace(/[^\p{L}\p{N}_]/gu, ' ').trim();
  const words = cleanQuery.split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  try {
    const pattern = words.map((w) => searchService.escapeRegex(w)).join('|');
    const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${pattern})([^\\p{L}\\p{N}_]|$)`, 'giu');
    return text.replace(regex, (m, p1, p2, p3) => `${p1}<mark>${p2}</mark>${p3}`);
  } catch (_) {
    return text;
  }
}

/**
 * Поиск по статьям Antropedia с учётом прав пользователя.
 */
async function searchArticles(query, user, parsedQuery, limit = 10) {
  if (!query) return [];

  let ftsMatches = null;
  if (parsedQuery.hasTextCriteria || parsedQuery.authorTerms.length || parsedQuery.hashKeys.length) {
    try {
      ftsMatches = await articlesFts.searchFts(parsedQuery);
    } catch (e) {
      console.error('[global-search] Ошибка FTS5 поиска статей:', e.message);
    }
  }

  const allArticles = articlesStore.listArticles();
  const results = [];

  if (user) {
    const filtered = articlesStore.filterArticles({
      parsedQuery,
      ftsMatches,
      sort: 'relevance'
    });

    for (const article of filtered) {
      if (results.length >= limit) break;
      const canAccess = await articleLayers.hasArticleAccess(article, user);
      if (!canAccess) continue;
      const resolved = await articleLayers.resolveArticleLayer(article, user);
      const title = (resolved && resolved.title) || article.title || article.slug;
      const author = article.legacyAuthorName || 'Автор';
      const snippet = article.search_snippet || (resolved && resolved.excerpt) || article.excerpt || '';

      results.push({
        type: 'article',
        id: article.slug,
        slug: article.slug,
        title,
        subtitle: `Статья · ${author}`,
        snippet,
        image: article.image || null,
        url: `/antropedia/${encodeURIComponent(article.slug)}`,
        badge: 'Статья',
        icon: 'fas fa-book-open',
        score: ftsMatches && ftsMatches.has(article.slug) ? ftsMatches.get(article.slug).score : 70
      });
    }
  } else {
    const publicList = publicArticles.listPublicArticles(allArticles, {
      q: query,
      ftsMatches,
      sort: 'relevance',
      limit
    });

    for (const item of publicList.data) {
      results.push({
        type: 'article',
        id: item.slug,
        slug: item.slug,
        title: item.title,
        subtitle: 'Статья Antropedia',
        snippet: item.search_snippet || item.excerpt || '',
        image: item.image || null,
        url: `/antropedia/${encodeURIComponent(item.slug)}`,
        badge: 'Статья',
        icon: 'fas fa-book-open',
        score: 75
      });
    }
  }

  return results;
}

/**
 * Поиск по работам Галереи с учётом прав пользователя.
 */
async function searchGallery(query, user, parsedQuery, limit = 10) {
  if (!query) return [];
  try {
    let { items } = await galleryStore.listWorks(user, { q: query, limit });
    if (!items.length && parsedQuery.layoutAlternative) {
      const alt = await galleryStore.listWorks(user, { q: parsedQuery.layoutAlternative.raw, limit });
      items = alt.items;
    }

    return items.map((w) => {
      const coverUrl = w.cover ? (w.cover.thumb || w.cover.url) : null;
      const authorName = w.author ? (w.author.display_name || w.author.username) : 'Художник';
      const rawDesc = w.description || (w.tags && w.tags.length ? w.tags.map((t) => '#' + t).join(' ') : '');
      const snippet = highlightSnippet(rawDesc.slice(0, 180), query);

      return {
        type: 'gallery',
        id: w.id,
        workId: w.id,
        title: w.title,
        subtitle: `Галерея · ${authorName}${w.pagesCount > 1 ? ` · ${w.pagesCount} стр.` : ''}`,
        snippet,
        image: coverUrl,
        url: `/site/gallery.html?work=${encodeURIComponent(w.id)}`,
        badge: 'Галерея',
        icon: 'fas fa-palette',
        score: 70
      };
    });
  } catch (err) {
    console.error('[global-search] Ошибка поиска галереи:', err.message);
    return [];
  }
}

/**
 * Поиск по франшизам и постам AllTell.
 */
async function searchAlltell(query, parsedQuery, limit = 10) {
  if (!query) return [];

  const rawTerm = query.trim();
  const altTerm = parsedQuery.layoutAlternative ? parsedQuery.layoutAlternative.raw.trim() : '';

  const searchInServers = (term) => new Promise((resolve) => {
    const like = `%${escapeLike(term)}%`;
    serversDb.all(
      `SELECT s.id, s.name, s.description, s.avatar_url,
              (SELECT COUNT(*) FROM user_server_memberships m WHERE m.server_id = s.id) AS member_count
       FROM servers s
       WHERE s.is_published = 1 AND (s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')
       ORDER BY member_count DESC, s.id DESC
       LIMIT ?`,
      [like, like, limit],
      (err, rows) => resolve(err || !rows ? [] : rows)
    );
  });

  const searchInPosts = (term) => new Promise((resolve) => {
    const like = `%${escapeLike(term)}%`;
    serversDb.all(
      `SELECT p.id, p.server_id, p.title, p.body, p.image_url, s.name AS franchise_name, s.avatar_url AS franchise_avatar_url
       FROM franchise_posts p
       JOIN servers s ON s.id = p.server_id AND s.is_published = 1
       LEFT JOIN franchise_hubs h ON h.id = p.hub_id
       WHERE p.approval_status = 'published' AND (p.hub_id IS NULL OR h.is_public = 1)
         AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')
       ORDER BY p.id DESC
       LIMIT ?`,
      [like, like, limit],
      (err, rows) => resolve(err || !rows ? [] : rows)
    );
  });

  let [servers, posts] = await Promise.all([
    searchInServers(rawTerm),
    searchInPosts(rawTerm)
  ]);

  if (!servers.length && !posts.length && altTerm) {
    [servers, posts] = await Promise.all([
      searchInServers(altTerm),
      searchInPosts(altTerm)
    ]);
  }

  const results = [];

  servers.forEach((s) => {
    results.push({
      type: 'alltell',
      id: `franchise-${s.id}`,
      franchiseId: s.id,
      title: s.name,
      subtitle: `Франшиза AllTell · ${s.member_count || 0} уч.`,
      snippet: highlightSnippet(s.description || 'Официальная франшиза вселенной AllTell', query),
      image: s.avatar_url || null,
      url: `/alltell?franchise=${s.id}`,
      badge: 'Франшиза',
      icon: 'fas fa-server',
      score: 65
    });
  });

  posts.forEach((p) => {
    results.push({
      type: 'alltell',
      id: `post-${p.id}`,
      postId: p.id,
      franchiseId: p.server_id,
      title: p.title || `Запись в «${p.franchise_name}»`,
      subtitle: `AllTell · ${p.franchise_name}`,
      snippet: highlightSnippet((p.body || '').slice(0, 150), query),
      image: p.image_url || p.franchise_avatar_url || null,
      url: `/alltell?franchise=${p.server_id}&post=${p.id}`,
      badge: 'AllTell',
      icon: 'fas fa-comment-alt',
      score: 60
    });
  });

  return results.slice(0, limit);
}

/**
 * Поиск по аудиотрекам и радиостанциям Радио.
 */
async function searchRadio(query, parsedQuery, limit = 10) {
  if (!query) return [];

  const rawTerm = query.trim();
  const altTerm = parsedQuery.layoutAlternative ? parsedQuery.layoutAlternative.raw.trim() : '';

  const searchStations = (term) => new Promise((resolve) => {
    const like = `%${escapeLike(term)}%`;
    radioDb.all(
      `SELECT id, frequency, name, description, avatar_url
       FROM radio_stations
       WHERE is_active = 1 AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR frequency LIKE ? ESCAPE '\\')
       LIMIT ?`,
      [like, like, like, limit],
      (err, rows) => resolve(err || !rows ? [] : rows)
    );
  });

  try {
    let [tracksResult, stations] = await Promise.all([
      radioStore.listTracks({ search: rawTerm, limit }),
      searchStations(rawTerm)
    ]);

    let tracks = tracksResult ? tracksResult.tracks : [];

    if (!tracks.length && !stations.length && altTerm) {
      [tracksResult, stations] = await Promise.all([
        radioStore.listTracks({ search: altTerm, limit }),
        searchStations(altTerm)
      ]);
      tracks = tracksResult ? tracksResult.tracks : [];
    }

    const results = [];

    stations.forEach((s) => {
      results.push({
        type: 'radio',
        id: `station-${s.id}`,
        stationId: s.id,
        title: s.name,
        subtitle: `Радиостанция${s.frequency ? ` · ${s.frequency} MHz` : ''}`,
        snippet: highlightSnippet(s.description || 'Эфирное радио AllTell', query),
        image: s.avatar_url || null,
        url: `/radio`,
        badge: 'Станция',
        icon: 'fas fa-broadcast-tower',
        score: 68
      });
    });

    tracks.forEach((t) => {
      const typeLabel = t.type === 'podcast' ? 'Подкаст' : t.type === 'speech' ? 'Речь' : 'Музыка';
      results.push({
        type: 'radio',
        id: `track-${t.id}`,
        trackId: t.id,
        title: t.title,
        subtitle: `Радио · ${typeLabel}${t.author_name ? ' · ' + t.author_name : ''}`,
        snippet: highlightSnippet(t.author_name ? `Исполнитель: ${t.author_name}` : 'Аудиозапись медиатеки', query),
        image: t.cover_url || null,
        url: `/radio?track=${t.id}`,
        badge: 'Радио',
        icon: 'fas fa-music',
        score: 64
      });
    });

    return results.slice(0, limit);
  } catch (err) {
    console.error('[global-search] Ошибка поиска радио:', err.message);
    return [];
  }
}

/**
 * Основной оркестратор глобального поиска по всем доменам.
 */
async function searchGlobal(rawQuery, options = {}) {
  const query = String(rawQuery || '').trim();
  const category = String(options.category || 'all').toLowerCase();
  const user = options.user || null;
  const limit = Math.max(1, Math.min(50, parseInt(options.limit, 10) || 20));

  if (!query) {
    return {
      query: '',
      category,
      total: 0,
      counts: { all: 0, articles: 0, gallery: 0, alltell: 0, radio: 0 },
      results: []
    };
  }

  const parsedQuery = searchService.parseSearchQuery(query);

  const fetchArticles = category === 'all' || category === 'articles';
  const fetchGallery = category === 'all' || category === 'gallery';
  const fetchAlltell = category === 'all' || category === 'alltell';
  const fetchRadio = category === 'all' || category === 'radio';

  const [articles, gallery, alltell, radio] = await Promise.all([
    fetchArticles ? searchArticles(query, user, parsedQuery, limit) : Promise.resolve([]),
    fetchGallery ? searchGallery(query, user, parsedQuery, limit) : Promise.resolve([]),
    fetchAlltell ? searchAlltell(query, parsedQuery, limit) : Promise.resolve([]),
    fetchRadio ? searchRadio(query, parsedQuery, limit) : Promise.resolve([])
  ]);

  const counts = {
    all: articles.length + gallery.length + alltell.length + radio.length,
    articles: articles.length,
    gallery: gallery.length,
    alltell: alltell.length,
    radio: radio.length
  };

  let combined = [];

  if (category === 'articles') combined = articles;
  else if (category === 'gallery') combined = gallery;
  else if (category === 'alltell') combined = alltell;
  else if (category === 'radio') combined = radio;
  else {
    // В категории 'all' объединяем и ранжируем по приоритету и релевантности:
    // точные совпадения названия идут выше
    const qLower = query.toLowerCase();
    combined = [...articles, ...gallery, ...alltell, ...radio];
    combined.sort((a, b) => {
      const aTitleMatch = a.title.toLowerCase().startsWith(qLower);
      const bTitleMatch = b.title.toLowerCase().startsWith(qLower);
      if (aTitleMatch && !bTitleMatch) return -1;
      if (!aTitleMatch && bTitleMatch) return 1;
      return (b.score || 0) - (a.score || 0);
    });
  }

  return {
    query,
    category,
    total: counts[category] !== undefined ? counts[category] : counts.all,
    counts,
    results: combined.slice(0, limit)
  };
}

module.exports = {
  searchGlobal,
  searchArticles,
  searchGallery,
  searchAlltell,
  searchRadio
};
