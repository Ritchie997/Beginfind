# Карта проекта AllTell

Этот документ — навигационный индекс для разработчика и ИИ-агента. Он отражает
структуру репозитория на момент последнего обновления; детали поведения всегда
проверяйте в коде.

## Слои приложения

```text
Браузер: public/index.html + клиентские JS/CSS
    │ запросы /api/*
    ▼
src/server.js
    ├─ middleware: auth / maintenance / dedupe / обработка загрузок
    ├─ src/routes/* — HTTP, проверка входа/прав, ответы
    ├─ src/services/* — бизнес-правила, доступ и работа с данными
    ├─ src/db/* — общие SQLite-соединения и миграции схем
    └─ content/, *.db, public/uploads/, map-sources/ — состояние и файлы
```

Фронтенд не собирается отдельным build-инструментом: `public/index.html`
подключает скрипты, CSS и внешние библиотеки. Для новой функции проследите
цепочку UI → API → service/store → хранилище, включая проверки доступа.

## Точка входа и общие модули

| Область | Файлы | Ответственность |
| --- | --- | --- |
| Запуск | `src/server.js` | Express, порядок middleware, подключение всех маршрутов, cron и обработчик ошибок |
| Конфигурация | `src/config/env.js`, `src/config/paths.js` | Переменные окружения и единые абсолютные пути |
| Базы | `src/db/connections.js`, `src/db/migrate-*.js` | Общие SQLite-соединения, создание и миграция таблиц |
| Аутентификация | `src/middleware/auth.js` | JWT, учётные записи и middleware авторизации |
| Общие middleware | `src/middleware/maintenance.js`, `dedupe-requests.js` | Техобслуживание и защита изменяющих запросов от повторного выполнения |
| Загрузки | `src/uploads/multer-config.js`, `src/routes/uploads.routes.js` | Приём и ограничения файлов |
| API | `src/routes/*.routes.js` | Границы HTTP API по доменным областям |
| Клиентская оболочка | `public/index.html`, `public/app.js`, `public/spa-router.js` | Загрузка приложения, состояние и переключение экранов |
| Разметка экранов | `public/views/*.html` | Фрагменты страниц SPA |

Порядок middleware в `src/server.js` значим: middleware API и маршруты нельзя
переносить за catch-all SPA без проверки поведения.

## Куда идти по задаче

| Функция | Сервер: маршрут → логика | Клиент / разметка |
| --- | --- | --- |
| Вход, профиль, пользователи | `auth.routes.js`, `middleware/auth.js` | `auth-system.js`, `spa-router.js`, `views/profile.html`, `views/pending-users.html`, `views/users-list.html` |
| Сообщения и серверы | `messages.routes.js`, `servers.routes.js`, `server-system-logic.js`, `server-permissions.js` | `app.js`, `spa-router.js`, `views/servers.html` |
| Статьи Antropedia | `articles.routes.js`, `articles-store.js`, `blocks.js`, `article-layers.js`, `mentions.js` | `editor-manager.js`, `blocks-renderer.js`, `antropedia.js`, `spa-router.js`, `views/articles.html`, `views/antropedia.html` |
| Граф статей и теги | `articles.routes.js`, `tag-colors.js` | `graph-view.js`, `antropedia.js`, `views/tags.html`, `views/dashboard.html` |
| Карты и миры | `maps.routes.js`, `maps-store.js`, `worlds-store.js`, `map-access.js`, `map-tiler.js` | `maps/map-core.js`, `map-editor.js`, `maps-ui.js`, `map-calendar.js` |
| Галерея | `gallery.routes.js`, `gallery-store.js` | `gallery.js`, `gallery.css`, `views/gallery.html` |
| Стикеры | `stickers.routes.js`, `stickers-store.js` | `stickers-manager.js`, `sticker-store.js`, `sticker-pack-view.js`, `views/stickers.html` |
| Черновики статей | `drafts.routes.js`, `drafts-store.js` | `spa-router.js`, `editor-manager.js` |
| Закладки и социальные действия | `bookmarks.routes.js`, `bookmarks-store.js`, `social-store.js` | `spa-router.js`, `antropedia.js` |
| Обращения и уведомления | `feedback.routes.js`, `feedback-store.js`, `notifications.routes.js`, `user-notifications.js` | `feedback-manager.js`, `user-notifications.js`, `views/feedback.html` |
| Бэкапы и администрирование | `backups.routes.js`, `backup.js`, `backup-settings.js`, `cleanup.routes.js`, `cleanup.js`, `settings.routes.js` | `backup-ui.js`, `cleanup-ui.js`, `views/settings.html` |
| Миграция статей | `article-migration.routes.js`, `article-migrate.js` | `article-migration-ui.js` |
| Вёрстка и общие стили | — | `global-styles.css`, `mobile-menu.css`, `editor-blocks.css`, `editor-obsidian.css`, доменные CSS в `public/` |

Если название файла или связь вызывает сомнение, подтвердите её импортами и
маршрутами в коде. `spa-router.js` — крупный файл; при работе с ним сначала
найдите конкретный обработчик/экран поиском, а не загружайте весь файл в
контекст.

## Данные и их источники истины

Пути централизованы в `src/config/paths.js`; состав бэкапа определён в
`src/services/backup.js`. Не путайте исходный код с локальным состоянием
развёрнутого сервера.

| Данные | Хранилище | Основные владельцы кода |
| --- | --- | --- |
| Статьи Antropedia | `content/<slug>.json`: метаданные и документ `{ version, blocks }`; корзина — `content/.trash/` | `articles-store.js`, `blocks.js` |
| Карты и настройки миров | `content/maps/*.json`, `content/worlds/*.json` | `maps-store.js`, `worlds-store.js` |
| Исходные изображения карт | `map-sources/` | `map-tiler.js`, `maps.routes.js` |
| Тайлы карт и пользовательские файлы | `public/uploads/` | `map-tiler.js`, доменные services/routes |
| Сообщения, пользователи, серверы и прочие домены | SQLite в корне проекта: `messenger.db`, `users.db`, `servers.db`, `articles.db`, `bookmarks.db`, `drafts.db`, `social.db`, `stickers.db`, `feedback.db`, `gallery.db` | `src/db/connections.js`, миграции, соответствующие stores/routes |
| Настройки сервера | JSON-файлы в корне, создаваемые по необходимости | соответствующие `*-settings.js` и `src/server.js` |
| Резервные копии | `backups/` | `src/services/backup.js` |

`articles.db` — историческая база, не источник документов статей; в ней остаётся
часть вспомогательных данных, например цвета тегов. Таблицы и миграции не
перечислены здесь исчерпывающе: смотрите `connections.js` и доменный код.

Папки баз, контента, исходников карт, бэкапов и загрузок не являются частью
репозитория. `.gitignore` исключает пользовательские данные, но конкретный
файл может находиться на машине локально — проверяйте Git-состояние перед
операциями с ним. Восстановление бэкапа и миграции могут менять рабочие данные.

## Запросы и проверки

- API монтируется в `src/server.js` под `/api`; названия маршрутов сгруппированы
  по файлам в `src/routes/`.
- Авторизация и доступ проверяются на сервере. Клиентское скрытие элементов не
  заменяет серверную проверку.
- npm-скрипты перечислены в `package.json`; тестовые, lint- и build-скрипты
  сейчас не настроены.
- Для правки UI проверяйте соответствующий экран в браузере; для API —
  успешный сценарий, отказ доступа и обработку ошибочного ввода, если это
  относится к изменению. Не запускайте миграции/восстановление без понимания
  воздействия на локальные данные.

## Документы рядом

- Корневая [`AGENTS.md`](../AGENTS.md) — краткий рабочий протокол для агента.
- [`agent-context/README.md`](agent-context/README.md) — индекс подробного
  контекста, разбитого по задачам, чтобы не загружать всё сразу.
- [`agent-context/DOMAINS.md`](agent-context/DOMAINS.md) — feature → route →
  service/store → frontend.
- [`agent-context/API_INDEX.md`](agent-context/API_INDEX.md) — маршруты API,
  сгруппированные по router-файлам.
- [`agent-context/DATA_AND_FLOWS.md`](agent-context/DATA_AND_FLOWS.md) — форматы,
  хранилища и важные циклы записи/восстановления.
- [`agent-context/FRONTEND.md`](agent-context/FRONTEND.md) — загрузка скриптов,
  экраны SPA и клиентские модули.
- [`agent-context/CLIENT_SITE_PLAN.md`](agent-context/CLIENT_SITE_PLAN.md) —
  план публичной основы, гостевого чтения статей и переключения с админкой.
- [`README.md`](../README.md) — установка, команды и ориентиры пользователя.
- [`DEVLOG.md`](../DEVLOG.md) — отобранные вехи истории коммитов.
