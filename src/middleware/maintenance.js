// Защита публичных страниц и read-only API на время их обслуживания.

const crypto = require('crypto');
const { JWT_SECRET } = require('./auth');
const { MAINTENANCE_PAGE_KEYS, readSettings } = require('../services/system-settings');

const BYPASS_COOKIE = 'alltell_maintenance_bypass';
const BYPASS_TTL_SECONDS = 2 * 60 * 60;
const ALWAYS_ALLOWED_API = new Set([
  '/api/login',
  '/api/maintenance-status',
  '/api/maintenance-continue'
]);

function maintenancePageForPath(pathname) {
  if (pathname === '/' || pathname === '/site/index.html') return 'home';
  if (pathname === '/site/alltell.html') return 'alltell';
  if (pathname === '/site/gallery.html') return 'gallery';
  if (
    pathname === '/antropedia' ||
    pathname === '/site/antropedia.html' ||
    /^\/antropedia\/[^/]+\/?$/.test(pathname)
  ) return 'antropedia';
  return null;
}

function maintenancePageForApi(req) {
  const pathname = req.originalUrl.split('?')[0];
  if (
    pathname === '/api/public/site-summary' ||
    pathname === '/api/public/articles-graph'
  ) return 'home';
  if (pathname.startsWith('/api/public/gallery/')) return 'gallery';
  if (pathname === '/api/public/articles') {
    const surface = new URL(req.originalUrl, 'http://localhost').searchParams.get('surface');
    return surface === 'home' ? 'home' : 'antropedia';
  }
  if (
    pathname.startsWith('/api/public/articles/') ||
    pathname === '/api/public/articles-index' ||
    pathname === '/api/public/tags'
  ) return 'antropedia';
  return null;
}

function cookieValue(req, name) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (error) {
      return '';
    }
  }
  return '';
}

function bypassSignature(value) {
  return crypto.createHmac('sha256', JWT_SECRET).update(value).digest('hex');
}

function hasMaintenanceBypass(req, page) {
  const token = cookieValue(req, BYPASS_COOKIE);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== page || !MAINTENANCE_PAGE_KEYS.includes(parts[0])) return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(bypassSignature(`${parts[0]}.${parts[1]}`), 'hex');
  let supplied;
  try {
    supplied = Buffer.from(parts[2], 'hex');
  } catch (error) {
    return false;
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function setMaintenanceBypassCookie(req, res, page) {
  const expires = Math.floor(Date.now() / 1000) + BYPASS_TTL_SECONDS;
  const value = `${page}.${expires}`;
  const token = `${value}.${bypassSignature(value)}`;
  const forwardedProto = req.get('x-forwarded-proto');
  const secure = req.secure || forwardedProto === 'https' ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${BYPASS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${BYPASS_TTL_SECONDS}${secure}`
  );
}

function maintenanceMessage(settings) {
  return settings.maintenanceMessage || 'Сайт временно на техническом обслуживании.';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function maintenancePageHtml(page, message) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Техническое обслуживание — AllTell</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#202225;color:#dcddde;font:16px system-ui,sans-serif}
    main{width:min(480px,calc(100% - 40px));box-sizing:border-box;padding:32px;border:1px solid #40444b;border-radius:14px;background:#2f3136;text-align:center}
    h1{margin:0 0 12px;color:#fff;font-size:24px}p{line-height:1.6;color:#b9bbbe}
    button,a{display:inline-block;margin:8px 4px 0;padding:10px 16px;border:0;border-radius:7px;background:#5865f2;color:#fff;font:inherit;text-decoration:none;cursor:pointer}
    a{background:#4f545c}.error{min-height:1.5em;color:#faa81a}
  </style>
</head>
<body>
  <main>
    <h1>Страница временно недоступна</h1>
    <p>${escapeHtml(message)}</p>
    <p>Владелец и администраторы могут продолжить работу.</p>
    <button id="maintenanceContinue" type="button">Продолжить?</button>
    <a href="/admin-panel">Войти в админ-панель</a>
    <p id="maintenanceError" class="error" role="status"></p>
  </main>
  <script>
    document.getElementById('maintenanceContinue').addEventListener('click', async function () {
      if (!window.confirm('Страница находится на техническом обслуживании. Продолжить?')) return;
      var token = '';
      try { token = localStorage.getItem('alltell_auth_token') || ''; } catch (error) {}
      if (!token) {
        document.getElementById('maintenanceError').textContent = 'Сначала войдите в админ-панель.';
        return;
      }
      try {
        var response = await fetch('/api/maintenance-continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ page: '${page}' })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось продолжить');
        window.location.reload();
      } catch (error) {
        document.getElementById('maintenanceError').textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

function maintenancePageGate(req, res, next) {
  const page = maintenancePageForPath(req.path);
  if (!page) return next();

  let settings;
  try {
    settings = readSettings();
  } catch (error) {
    return next(error);
  }
  if (!settings.maintenancePages[page] || hasMaintenanceBypass(req, page)) return next();

  res.status(503).type('html').send(maintenancePageHtml(page, maintenanceMessage(settings)));
}

function maintenanceGate(req, res, next) {
  const pathname = req.originalUrl.split('?')[0];
  if (ALWAYS_ALLOWED_API.has(pathname)) return next();
  const page = maintenancePageForApi(req);
  if (!page) return next();

  let settings;
  try {
    settings = readSettings();
  } catch (error) {
    return next(error);
  }
  if (!settings.maintenancePages[page] || hasMaintenanceBypass(req, page)) return next();

  res.status(503).json({
    error: maintenanceMessage(settings),
    maintenance: true,
    page
  });
}

module.exports = {
  maintenanceGate,
  maintenancePageGate,
  maintenancePageForPath,
  setMaintenanceBypassCookie,
  MAINTENANCE_PAGE_KEYS
};
