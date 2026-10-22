// pages.routes.js — публичные страницы и совместимые входы в SPA админ-панели.
// Конкретные маршруты регистрируются до общего SPA fallback в server.js.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('../config/paths');
const articleStore = require('../services/articles-store');
const publicArticles = require('../services/public-articles');

const PUBLIC_ANTROPEDIA_TEMPLATE = fs.readFileSync(
  path.join(PUBLIC_DIR, 'site/antropedia.html'),
  'utf8'
);

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

function publicImageUrl(value, origin) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = value.startsWith('/uploads/')
      ? new URL(value, origin)
      : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch (err) {
    return '';
  }
}

function replaceMeta(html, selector, content) {
  const escapedContent = escapeHtmlAttribute(content);
  return html.replace(selector, (tag) =>
    tag.replace(/content="[^"]*"/, () => `content="${escapedContent}"`)
  );
}

function requestOrigin(request) {
  const host = (request.get('x-forwarded-host') || request.get('host') || '').split(',')[0].trim();
  const protocol = (request.get('x-forwarded-proto') || request.protocol).split(',')[0].trim();
  if (!host || !['http', 'https'].includes(protocol)) {
    throw new Error('Invalid public site origin');
  }
  const url = new URL(`${protocol}://${host}`);
  if (url.username || url.password) throw new Error('Invalid public site host');
  return url.origin;
}

function renderPublicArticlePage(article, request) {
  const origin = requestOrigin(request);
  const title = `${article.title || article.slug} — Antropedia`;
  const description = String(article.excerpt || 'Открытая статья Antropedia — энциклопедии AllTell.').trim().slice(0, 300);
  const canonical = new URL(`/antropedia/${encodeURIComponent(article.slug)}`, origin).href;
  const image = publicImageUrl(article.image, origin);
  let html = PUBLIC_ANTROPEDIA_TEMPLATE.replace(
    /<title>[^<]*<\/title>/i,
    () => `<title>${escapeHtmlAttribute(title)}</title>`
  );

  html = replaceMeta(html, /<meta name="description" content="[^"]*">/i, description);
  html = replaceMeta(html, /<meta property="og:title" content="[^"]*">/i, title);
  html = replaceMeta(html, /<meta property="og:description" content="[^"]*">/i, description);
  html = replaceMeta(html, /<meta property="og:url" content="[^"]*">/i, canonical);
  html = replaceMeta(html, /<meta property="og:image" content="[^"]*">/i, image);
  html = replaceMeta(html, /<meta name="twitter:title" content="[^"]*">/i, title);
  html = replaceMeta(html, /<meta name="twitter:description" content="[^"]*">/i, description);
  html = replaceMeta(html, /<meta name="twitter:image" content="[^"]*">/i, image);
  html = html.replace(/<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${escapeHtmlAttribute(canonical)}">`);
  return html;
}

function renderPublicListingPage(request) {
  const origin = requestOrigin(request);
  const canonical = new URL('/antropedia', origin).href;
  let html = replaceMeta(PUBLIC_ANTROPEDIA_TEMPLATE, /<meta property="og:url" content="[^"]*">/i, canonical);
  html = replaceMeta(html, /<meta property="og:type" content="[^"]*">/i, 'website');
  return html.replace(/<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${escapeHtmlAttribute(canonical)}">`);
}

function sendPage(file, status = 200) {
  return (req, res) => {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}

function createPagesRouter(articleStoreInstance = articleStore) {
  const router = express.Router();
  router.get('/', sendPage('site/index.html'));
  router.get('/profile', sendPage('site/profile.html'));
  router.get('/profile/:id', sendPage('site/profile.html'));
  router.get('/antropedia', (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPublicListingPage(req));
    } catch (err) {
      console.error('[public-pages] Failed to render Antropedia metadata:', err);
      res.status(500).send('Не удалось загрузить Antropedia');
    }
  });
  router.get('/antropedia/:slug', (req, res) => {
    try {
      const record = articleStoreInstance.getArticle(req.params.slug);
      const article = record && publicArticles.getPublicArticle(record);
      if (!article) return sendPage('site/antropedia.html', 404)(req, res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPublicArticlePage(article, req));
    } catch (err) {
      console.error('[public-pages] Failed to render article metadata:', err);
      res.status(500).send('Не удалось загрузить страницу статьи');
    }
  });
  router.get('/admin-panel', sendPage('index.html'));
  router.get('/admin-panel/antropedia', sendPage('index.html'));

  const LEGACY_ADMIN_PAGES = [
    '/test.html',
    '/admin-panel.html',
    '/dashboard.html',
    '/articles.html',
    '/tags.html',
    '/roles.html',
    '/settings.html'
  ];
  LEGACY_ADMIN_PAGES.forEach((route) => router.get(route, sendPage('index.html')));
  return router;
}

const router = createPagesRouter();

// Catch-all для остальных "красивых" путей SPA (например /server/:id) —
// должен быть подключён в server.js последним, после всех /api/* маршрутов
// и статики, иначе перехватит их на себя.
function spaCatchAll(req, res) {
  const isAsset = req.path.startsWith('/api/') ||
    req.path.startsWith('/uploads/') ||
    req.path.startsWith('/views/') ||
    /\.(js|css|png|jpe?g|gif|svg|ico)$/.test(req.path);

  if (isAsset) {
    res.status(404).send('File not found');
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
}

module.exports = { router, createPagesRouter, spaCatchAll };
