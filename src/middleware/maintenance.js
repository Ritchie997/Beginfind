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
  <link rel="stylesheet" href="/global-styles.css">
  <link rel="stylesheet" href="/site/site.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body data-page="maintenance" data-maintenance-page="true" data-maintenance-target="${page}">
  <header class="site-header">
    <div class="site-header-inner">
      <button class="site-burger" id="siteBurger" aria-label="Открыть меню"><span></span><span></span><span></span></button>
      <a href="/" class="site-logo"><span class="site-logo-mark">✶</span> AllTell</a>
      <nav class="site-nav" id="siteNav">
        <a href="/" class="site-nav-link" data-page="home">Главная</a>
        <a href="/antropedia" class="site-nav-link" data-page="antropedia">Antropedia</a>
        <a href="/site/alltell.html" class="site-nav-link" data-page="alltell">AllTell</a>
        <a href="/site/gallery.html" class="site-nav-link" data-page="gallery">Галерея</a>
      </nav>
      <div class="site-header-actions">
        <div class="site-user" id="siteUserMenu" hidden>
          <button type="button" class="site-user-trigger" id="siteUserTrigger" aria-haspopup="true" aria-expanded="false" aria-controls="siteUserDropdown">
            <span class="site-user-avatar" id="siteUserAvatar"></span>
            <span class="site-user-name" id="siteUserName"></span>
            <i class="fas fa-chevron-down site-user-chevron" aria-hidden="true"></i>
          </button>
          <div class="site-user-dropdown" id="siteUserDropdown" role="menu">
            <a href="/profile" role="menuitem"><i class="fas fa-user"></i> Профиль</a>
            <button type="button" id="siteLogout" role="menuitem"><i class="fas fa-right-from-bracket"></i> Выход</button>
          </div>
        </div>
        <div class="site-auth-actions" id="siteGuestActions">
          <button type="button" class="site-auth-button" data-auth-tab="login">Войти</button>
        </div>
      </div>
    </div>
  </header>
  <div class="site-nav-overlay" id="siteNavOverlay"></div>
  <main class="site-main site-maintenance">
    <section class="site-maintenance-card">
      <span class="site-hero-badge"><i class="fas fa-screwdriver-wrench"></i> Техническое обслуживание</span>
      <h1>Раздел временно недоступен</h1>
      <p>${escapeHtml(message)}</p>
      <p>Продолжить могут владелец и администраторы.</p>
      <div class="site-maintenance-actions">
        <a class="btn btn-primary btn-lg" href="/"><i class="fas fa-arrow-left"></i> Вернуться на основу</a>
        <button class="btn btn-ghost btn-lg" id="maintenanceContinue" type="button">Продолжить?</button>
      </div>
      <p id="maintenanceError" class="site-maintenance-error" role="status" aria-live="polite"></p>
    </section>
  </main>
  <script src="/auth-system.js"></script>
  <script src="/site/site.js"></script>
  <script src="/site/router.js"></script>
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
