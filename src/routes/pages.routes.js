// pages.routes.js — публичные страницы и совместимые входы в SPA админ-панели.
// Конкретные маршруты регистрируются до общего SPA fallback в server.js.

const express = require('express');
const path = require('path');
const { PUBLIC_DIR } = require('../config/paths');

const router = express.Router();

function sendPage(file) {
  return (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}

router.get('/', sendPage('site/index.html'));
router.get('/antropedia', sendPage('site/antropedia.html'));
router.get('/antropedia/:slug', sendPage('site/antropedia.html'));
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

module.exports = { router, spaCatchAll };
