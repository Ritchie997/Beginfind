// maintenance.js — шлагбаум режима технического обслуживания
// (Настройки → "Режим технического обслуживания", только владелец).
//
// Пока settings.maintenanceMode включён, весь /api/* (кроме двух исключений
// ниже) отвечает 503 всем, кроме владельца (is_root) — обычные пользователи
// и админы не могут ничего делать на сайте, что бы у них ни было открыто.
//
// Исключения (ALWAYS_ALLOWED):
//   /api/login              — иначе владелец, зашедший с чистого браузера
//                              (или у которого истёк токен) во время
//                              техобслуживания, не смог бы залогиниться и
//                              снять его самостоятельно — самозапирание.
//   /api/maintenance-status — публичный статус (см. settings.routes.js),
//                              клиент обязан суметь его проверить ДО того,
//                              как у него вообще может быть токен.
//
// Проверка "не владелец ли" — мягкая: невалидный/просроченный/отсутствующий
// токен просто означает "не владелец" (503, а не 401/403 — посетителю нужно
// увидеть "идут работы", а не ошибку авторизации). is_root проверяется
// свежим запросом к БД (getUserFull), а не только по значению внутри самого
// JWT — тот же принцип, что и у checkApproved в auth.js: права должны
// действовать/сниматься мгновенно, а не только после перевыпуска токена.

const jwt = require('jsonwebtoken');
const { JWT_SECRET, getUserFull } = require('./auth');
const { readSettings } = require('../services/system-settings');

const ALWAYS_ALLOWED = new Set(['/api/login', '/api/maintenance-status']);

async function maintenanceGate(req, res, next) {
  let settings;
  try {
    settings = readSettings();
  } catch (e) {
    return next(); // не смогли прочитать настройки — не блокируем сайт из-за этого
  }

  if (!settings.maintenanceMode || ALWAYS_ALLOWED.has(req.path)) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await getUserFull(decoded.id);
      if (user && user.is_root) return next();
    } catch (e) {
      // невалидный/просроченный токен — обрабатываем как обычного посетителя ниже
    }
  }

  res.status(503).json({
    error: settings.maintenanceMessage || 'Сайт временно на техническом обслуживании',
    maintenance: true
  });
}

module.exports = { maintenanceGate };
