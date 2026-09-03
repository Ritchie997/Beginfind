// pages.routes.js — отдаёт index.html для всех "красивых" путей SPA.
// Сама SPA (public/spa-router.js) разбирает URL на клиенте, серверу тут
// достаточно всегда отдавать одну и ту же страницу с нужным заголовком.

const express = require('express');
const path = require('path');
const { PUBLIC_DIR } = require('../config/paths');

const router = express.Router();

const SPA_PAGES = [
  '/',
  '/test.html',
  '/admin-panel.html',
  '/dashboard.html',
  '/articles.html',
  '/categories.html',
  '/roles.html',
  '/settings.html'
];

SPA_PAGES.forEach((route) => {
  router.get(route, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
});

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
