# Чек-лист выравнивания функционала: Публичная основа vs Админка AllTell

> Файл для Obsidian с интерактивными задачами. Отмечайте чекбоксы `- [ ]` по мере выполнения.

---

## 1. Шапка и навигация

- [ ] **Колокольчик уведомлений на публичном сайте**
  - **Что делать:** Добавить иконку колокольчика с индикатором непрочитанных, дропдауном списка уведомлений и кнопкой «Прочитать все».
  - **Где чинить:**
    - `public/site/index.html`, `public/site/antropedia.html`, `public/site/alltell.html`, `public/site/gallery.html`, `public/site/profile.html`: добавить разметку `.notif-bell` в `.site-header-actions` по аналогии с `public/index.html` (строки 30–40).
    - `public/site/site-header.js`: в метод `render()` добавить разметку `#notif-bell`, в `bindUserMenu()` или отдельный метод `bindNotifications()` инициализировать контроллер.
    - Подключить скрипт `/user-notifications.js` и стили `/user-notifications.css` в `<head>` всех страниц `public/site/*.html`.
    - `public/user-notifications.js`: убедиться, что базовый путь API `/api/notifications` корректно работает с гостевым/авторизованным токеном (`window.authManager.getToken()`).

- [ ] **Глобальный поиск в шапке админ-панели**
  - **Что делать:** Добавить поле ввода глобального поиска в шапку админки, перенаправляющее по `Enter` на поиск статей.
  - **Где чинить:**
    - `public/index.html`: в `.header-right` (перед `#public-site-toggle`) добавить `<div class="site-search"><input id="adminSearchInput" placeholder="Поиск статей..."></div>`.
    - `public/app.js`: повесить обработчик `keydown Enter` на `#adminSearchInput`, вызывающий `window.spaRouter.navigateTo('/admin-panel/antropedia?q=' + encodeURIComponent(query))`.
    - `public/global-styles.css`: добавить стили инпута поиска для хедера админки.

---

## 2. Главная страница (`/`) vs Дашборд (`/dashboard`)

- [ ] **Панель управления графом лора на Главной странице**
  - **Что делать:** Добавить тулбар с кнопками «Во весь экран», поиском по узлам/#тегам, экспортом PNG и фильтрами.
  - **Где чинить:**
    - `public/site/index.html`: в секцию `.home-graph-section` над `#homeGraphContainer` скопировать разметку тулбара из `public/views/dashboard.html` (строки 7–46: `#graphSearchInput`, `#graphHideIsolated`, `#graphFullscreenToggle`, `#graphExportPng`).
    - `public/site/site.js`: в функции `loadGraph()` (строки 2572–2600) передать селекторы тулбара в `window.GraphView.renderGraph(graphRoot, data, options)` и повесить обработчики кликов на полноэкранный режим и PNG-экспорт аналогично `public/spa-router.js` (метод `initDashboardGraph`).

- [ ] **Счётчик работ галереи на дашборде админки**
  - **Что делать:** Добавить плитку «Работ в галерее» в общую полосу статистики.
  - **Где чинить:**
    - `public/views/dashboard.html`: в контейнер `.stat-strip` (строки 53–120) добавить чип `<div class="stat-chip"><span id="total-gallery">0</span>...</div>`.
    - `public/spa-router.js`: в функции загрузки статистики дашборда (`loadDashboardStats` / вызов `/api/dashboard/stats` или `/api/public/site-summary`) заполнять элемент `#total-gallery`.

- [ ] **Превью популярных статей и свежих артов на дашборде админки**
  - **Что делать:** Вывести компактные блоки свежих артов и топовых статей под дашбордом.
  - **Где чинить:**
    - `public/views/dashboard.html`: под `.activity-container` добавить контейнеры `#dashboardPopularArticles` и `#dashboardRecentGallery`.
    - `public/spa-router.js`: при открытии `/dashboard` вызывать эндпоинты `/api/public/articles?surface=home&sort=views&limit=3` и `/api/public/gallery/works?sort=newest&limit=3`.

---

## 3. Чтение статей Antropedia (`/antropedia/:slug`)

- [ ] **Оглавление статьи (Table of Contents / TOC)**
  - **Что делать:** Добавить боковую панель оглавления со списком заголовков H1–H3 и автоподсветкой текущего раздела при скролле.
  - **Где чинить:**
    - `public/site/antropedia.html`: в детальный просмотр статьи `#publicArticleDetail` добавить разметку сайдбара `<aside id="antropediaViewSidebar"><div id="antropediaTocPanel"></div></aside>` из `public/views/antropedia.html` (строки 199–207).
    - `public/site/site.js`: портировать функцию `renderToc()` из `public/antropedia.js` (парсит `content.querySelectorAll('h1, h2, h3')`, генерирует ссылки со скроллом и вешает `IntersectionObserver`).
    - `public/site/site.css`: подключить классы `.antropedia-view-layout`, `.antropedia-view-sidebar`, `.antropedia-toc-panel`.

- [ ] **Инлайн-поиск по тексту открытой статьи**
  - **Что делать:** Добавить в тулбар открытой статьи инпут поиска слова в тексте со стрелками след./пред. и подсветкой совпадений.
  - **Где чинить:**
    - `public/site/site.js`: в тулбар статьи (строки 1259–1290) добавить контейнер `.antropedia-inline-search` (инпут, счётчик, кнопки вверх/вниз/очистить) из `public/views/antropedia.html` (строки 122–129).
    - `public/site/site.js`: перенести логику функций `runInArticleSearch()`, `gotoSearchHit()`, `clearInArticleSearch()` из `public/antropedia.js`.
    - Добавить CSS-классы подсветок `.search-hit` и `.search-hit-active` в `public/site/site.css`.

- [ ] **Переключатель слоёв лора (`layerSwitcher`)**
  - **Что делать:** Отображать кнопки переключения слоёв секретности для авторизованных пользователей с соответствующими ролями.
  - **Где чинить:**
    - `public/site/site.js`: в методе рендера статьи перед `content` добавить контейнер `.antropedia-layer-switcher`.
    - `public/site/site.js`: проверять наличие `article.layerOptions` (массив доступных читателю слоёв). Если слоёв > 1, отрисовывать табы слоёв и при клике подменять `article.title`, `article.content` через `window.renderArticleBlocks()` без полной перезагрузки (по аналогии с `switchArticleLayer` в `public/antropedia.js`).

- [ ] **Закладки на блоках статьи и желоб закладок (`bookmark-gutter`)**
  - **Что делать:** Разрешить ставить цветные закладки на абзацы и отображать цветные маркеры на левом поле статьи.
  - **Где чинить:**
    - `public/site/site.js`: при рендере блоков вешать обработчик клика на маркер закладки блока.
    - Портировать методы `openBookmarkPopover()`, `saveBlockBookmark()`, `renderBookmarkGutter()` из `public/antropedia.js`.
    - Запросы отправлять на существующий API `/api/bookmarks` (`src/routes/bookmarks.routes.js`).
    - Стилизировать `.antropedia-bookmark-gutter` и `.antropedia-bookmark-tag` в `public/site/site.css`.

- [ ] **Обратные ссылки (Backlinks) под статьёй**
  - **Что делать:** Выводить блок «На эту статью ссылаются...» со списком упоминающих статей.
  - **Где чинить:**
    - `public/site/site.js`: в конец рендера статьи (`detail.appendChild`) добавить блок `<div id="publicArticleBacklinks" class="backlinks-panel">`.
    - Выполнять запрос `GET /api/articles/:slug/backlinks` (эндпоинт в `src/routes/articles.routes.js`) и рендерить карточки-ссылки.

- [ ] **Полоса связанных артов галереи под статьёй**
  - **Что делать:** Показывать прикреплённые к статье арты и концепты внизу страницы.
  - **Где чинить:**
    - `public/site/site.js`: вызывать `GET /api/public/gallery/works?articleSlug=` + `encodeURIComponent(article.slug)` (из `src/routes/gallery.routes.js`).
    - Рендерить превью изображений с кликом, открывающим просмотрщик `window.galleryViewer.openWork(work.id)`.

- [ ] **Кнопка жалобы на статью (Report)**
  - **Что делать:** Добавить флажок ⚑ в блок реакций под статьёй для отправки жалобы модераторам.
  - **Где чинить:**
    - `public/site/site.js`: в тулбар реакций (`initArticleEngagement`) добавить кнопку `#publicArticleReportBtn` рядом с лайком и комментариями.
    - По клику открывать модалку с текстом жалобы и отправлять `POST /api/feedback` с телом `{ category: 'complaint', target_type: 'article', target_slug: article.slug, text }`.

---

## 4. Каталог Antropedia (`/antropedia`)

- [ ] **Фильтр по серверам (франшизам) и статусу в публичном каталоге**
  - **Что делать:** Добавить выпадающие списки выбора франшизы и статуса статьи (🔓 открытая / 🔒 закрытая по ролям).
  - **Где чинить:**
    - `public/site/antropedia.html`: в панель `#pubFiltersPanel` добавить селекты `#pubServerFilter` и `#pubStatusFilter`.
    - `public/site/site.js`: заполнять `#pubServerFilter` из `/api/public/franchises` и передавать `serverId` и `locked` параметрами в запрос `/api/public/articles`.

- [ ] **Полоса быстрых тегов в админском каталоге**
  - **Что делать:** Добавить кликабельные теги в тулбар над сеткой админских статей.
  - **Где чинить:**
    - `public/views/antropedia.html`: под строкой поиска вставить контейнер `<div id="antropediaQuickTags" class="antropedia-quick-tags"></div>`.
    - `public/antropedia.js`: при инициализации каталога запрашивать `/api/tags` и рендерить топ-10 тегов; клик по тегу подставляет его в `antropediaTagField` и перезагружает статьи.

---

## 5. Сообщества AllTell и Франшизы (`/alltell` vs `/servers`)

- [ ] **Социальная лента публикаций (Feed) в админ-панели**
  - **Что делать:** Дать администратору возможность просматривать ленту постов франшиз прямо из админки.
  - **Где чинить:**
    - `public/index.html`: в сайдбар в группу «Сообщество» (строки 88–105) добавить пункт `<div class="sidebar-item" data-nav="/feed"><i>📰</i><span>Лента AllTell</span></div>`.
    - `public/spa-router.js`: зарегистрировать маршрут `/feed`, монтирующий разметку ленты и вызывающий метод `window.AllTellClient.renderFeed()`.
    - Либо в `public/views/servers.html` добавить переключатель табов «Каталог франшиз / Лента публикаций».

- [ ] **Форма создания публикации во франшизу из админки**
  - **Что делать:** Встроить форму публикации с каруселью картинок в админский воркспейс франшизы.
  - **Где чинить:**
    - `public/views/servers.html`: в таб «Обзор» воркспейса (`data-server-tab="overview"`) вставить компонент создания записи `#server-post-composer` из `public/site/alltell-client.js`.
    - `public/spa-router.js`: подключить отправку `POST /api/franchises/:id/posts` с `FormData`.

- [ ] **Модерация предложенных постов (Proposals) в админке**
  - **Что делать:** Вывести очередь предложений от участников во вкладку франшизы в админке.
  - **Где чинить:**
    - `public/views/servers.html`: добавить бейдж и секцию «Предложенные записи» во вкладку «Обзор».
    - `public/spa-router.js`: опрашивать `GET /api/franchises/:id/proposals` и отрисовывать кнопки «Одобрить» / «Отклонить».

---

## 6. Профиль пользователя (`/profile`)

- [ ] **Смена пароля в профиле пользователя**
  - **Что делать:** Добавить форму «Смена пароля» (старый пароль, новый пароль, подтверждение).
  - **Где чинить:**
    - **Сервер:** в `src/routes/auth.routes.js` создать эндпоинт `POST /api/profile/change-password` (проверка `bcrypt.compare(oldPassword)`, хеширование нового, сохранение в `users.db`).
    - **Админка:** в `public/views/profile.html` под блоком «О себе» добавить секцию `#profile-password-section` с полями ввода и кнопкой «Обновить пароль».
    - **Основа:** в `public/site/profile.html` добавить аналогичную карточку `.site-profile-section`.
    - **JS:** обработать отправку в `public/spa-router.js` (метод `setupProfilePassword`) и `public/site/profile.js`.

- [ ] **Кнопка «Выложить работу» на публичной вкладке «Арты»**
  - **Что делать:** Добавить кнопку выкладывания работы прямо на странице своего профиля во вкладке артов.
  - **Где чинить:**
    - `public/site/profile.html`: в заголовок панели `#publicProfileMedia` для вкладки `arts` добавить кнопку `#profileArtsUploadBtn`.
    - `public/site/profile.js`: по клику вызывать модалку `window.galleryEditor.open()` из `public/gallery.js`.

---

## 7. Специализированные разделы на публичном сайте

- [ ] **Публичная страница интерактивных карт (`/maps`)**
  - **Что делать:** Создать отдельный публичный экран для исследования открытых карт вселенной AllTell.
  - **Где чинить:**
    - Создать `public/site/maps.html` с контейнером карты Leaflet и селектором миров.
    - В `src/routes/pages.routes.js` зарегистрировать маршрут `GET /maps` -> отдача `public/site/maps.html`.
    - Добавить ссылку «Карты» в навигацию `public/site/site-header.js` и в шапку всех страниц.
    - Инициализировать ядро `public/maps/map-core.js` с опцией `readOnly: true`, загружая миры через `GET /api/public/maps` (или `maps-store.js`).

- [ ] **Рабочая форма обратной связи в футере**
  - **Что делать:** Заменить некликабельную ссылку `href="#"` в футере на модальное окно подачи обращения в техподдержку.
  - **Где чинить:**
    - `public/site/index.html`, `antropedia.html`, `alltell.html`, `gallery.html`, `profile.html`: в футере заменить `<a href="#">Обратная связь</a>` на `<button type="button" class="site-footer-link" id="footerFeedbackBtn">Обратная связь</button>`.
    - `public/site/site.js`: создать модалку тикета (категория: ошибка, идея, жалоба, вопрос; текст; контакт/email) и отправлять `POST /api/feedback`.

- [ ] **Публичный каталог стикеров (`/stickers`)**
  - **Что делать:** Дать пользователям витрины возможность искать и добавлять стикерпаки сообщества.
  - **Где чинить:**
    - Добавить страницу `public/site/stickers.html` (роут `/stickers` в `src/routes/pages.routes.js`).
    - Подключить модуль `public/sticker-store.js` и `public/sticker-pack-view.js` для предпросмотра паков и кнопки «Добавить себе».
    - Добавить ссылку «Стикеры» в меню профиля или футер публичного сайта.

- [ ] **Панель назначения авторов Root (`authorsAdmin`) в клиентском редакторе**
  - **Что делать:** Разрешить суперпользователю передавать авторство статьи из клиентского редактора.
  - **Где чинить:**
    - `public/site/antropedia-editor-client.js`: проверить `window.authManager.getUser()?.is_root`.
    - При `is_root === true` отображать блок `#authorsAdmin` с поиском пользователя по `GET /api/users/search` и кнопкой смены основного автора (портировать логику из `public/editor-manager.js`).
