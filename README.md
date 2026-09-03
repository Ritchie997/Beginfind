# BeginFind Server

Серверная часть приложения BeginFind: мессенджер, система "серверов" (каналы/роли/участники, по образцу Discord) и Ibripedia — вики-модуль со статьями.

## Структура проекта

```
src/
  server.js                 — точка входа: создаёт Express-приложение, монтирует
                               мидлвары и маршруты, поднимает автобэкап
  config/
    env.js                  — читает .env (PORT, HOST, JWT_* и т.д.)
    paths.js                 — единая точка правды для путей проекта (БД, uploads, backups)
  db/
    connections.js           — общие подключения к messenger.db / articles.db / servers.db
  middleware/
    auth.js                  — регистрация, вход, JWT, middleware authenticateToken/
                               checkApproved/checkRoot
  services/
    articles-store.js          — файловое хранилище статей (Markdown + frontmatter, см. ниже)
    slugify.js                  — транслитерация заголовка в slug (имя файла статьи)
    backup.js                   — создание/восстановление/список бэкапов (ZIP, включает content/)
    backup-settings.json        — настройки автобэкапа (создаётся автоматически)
    backup-settings.js          — чтение/запись backup-settings.json
    scheduled-cleanup.js        — очистка неиспользуемых файлов в uploads/ (cron, сейчас выключен)
    server-permissions.js       — проверка прав/иерархии ролей на сервере
    server-system-logic.js      — CRUD для серверов, ролей, участников
  uploads/
    multer-config.js           — конфигурация загрузки изображений и ZIP-бэкапов
  routes/
    pages.routes.js            — раздача index.html для "красивых" URL SPA
    auth.routes.js              — /api/register, /api/login, /api/profile, заявки на вход
    messages.routes.js          — /api/messages
    articles.routes.js          — /api/articles*, /api/search-articles (Ibripedia)
    taxonomy.routes.js          — /api/categories, /api/roles
    servers.routes.js           — /api/servers*, /api/users
    uploads.routes.js           — /api/upload-image
    backups.routes.js           — /api/backups*

scripts/
  migrate-articles-to-markdown.js — одноразовая миграция articles.db -> content/*.md

public/                     — статические файлы веб-интерфейса (SPA)
backups/                    — сохранённые ZIP-бэкапы (создаётся автоматически, не в git)
content/                    — статьи в формате Markdown (см. раздел "Хранение статей", не в git)
messenger.db, servers.db, users.db, articles.db — базы данных SQLite (создаются автоматически, не в git;
                               articles.db с Этапа 3 хранит только категории, не тексты статей)
```

## Установка зависимостей

```bash
npm install
```

## Переменные окружения

Перед запуском сервера создайте файл `.env` в корне проекта на основе `.env.example`:

```bash
cp .env.example .env
```

Доступные переменные:
- `PORT` — порт для сервера (по умолчанию: 3002)
- `HOST` — хост для сервера (по умолчанию: 0.0.0.0)
  - Для локальной разработки: `localhost`
  - Для доступа из локальной сети или деплоя (Render.com и т.п.): `0.0.0.0`
- `JWT_SECRET` — **обязателен**. Сервер не запустится без него (раньше был небезопасный дефолт).
  Сгенерировать: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` — время жизни токенов
- `ROOT_USERNAME`, `ROOT_PASSWORD` — использовались для создания root-аккаунта одноразовым
  скриптом (уже выполнен и удалён из репозитория); можно убрать из `.env` после создания root-аккаунта

## Запуск сервера

### В режиме разработки
```bash
npm run dev
```

### В продакшен режиме
```bash
npm start
```

Оба скрипта запускают `src/server.js`. Сервер будет доступен по адресу: http://localhost:3002

## API Endpoints

### Аутентификация
- `POST /api/register` — регистрация (статус `pending` до подтверждения)
- `POST /api/login` — вход
- `GET /api/profile` — профиль текущего пользователя
- `GET /api/pending-users`, `PUT /api/pending-users/:id/approve|reject`, `GET /api/all-users` — управление заявками (root only)

### Мессенджер
- `GET /api/messages` — получить все сообщения
- `POST /api/messages` — отправить сообщение (имя отправителя берётся из токена)

### Ibripedia (вики)
- `GET /api/articles` — список статей (закрытые по ролям статьи видны только тем, у кого есть доступ);
  фильтры `?since=`, `?server=`, `?tag=`
- `GET /api/articles/:slug` — статья по slug (раньше был числовой id, см. "Хранение статей")
- `POST /api/articles` — создать статью
- `PUT /api/articles/:slug` — обновить статью
- `PUT /api/articles/:slug/rename` — переименовать (меняет title и slug, обновляет
  `[[wiki-ссылки]]` на неё во всех остальных статьях)
- `DELETE /api/articles/:slug` — удалить статью (перемещается в content/.trash/, не стирается)
- `GET /api/articles/:slug/backlinks` — статьи, ссылающиеся на данную через `[[wiki-ссылку]]`
- `GET /api/articles-index` — облегчённый список {slug, title, tags} для автодополнения `[[` в редакторе
- `GET /api/articles-graph` — узлы+рёбра для графа связей
- `GET /api/search-articles?q=...` — поиск по заголовку/содержимому
- `GET/POST/DELETE /api/categories` — категории статей (изменение — root only)
- `GET/POST/DELETE /api/roles` — глобальный справочник ролей (изменение — root only)

### Серверы (каналы/роли/участники)
- `GET/POST/PUT/DELETE /api/servers[/:id]` — CRUD серверов (обновление/удаление — владелец или root)
- `GET /api/servers/:id/users`, `GET/POST /api/servers/:id/roles`
- `POST /api/servers/:serverId/users/:userId` — вступление (себя) или добавление участника (админ сервера)
- `POST/DELETE /api/servers/:serverId/users/:userId/roles/:roleId` — назначение/снятие роли
- `PUT/DELETE /api/servers/:serverId/roles/:roleId` — изменение/удаление кастомной роли
- `PUT /api/servers/:serverId/owner` — смена владельца сервера (root only)
- `GET /api/users` — список пользователей для выбора нового владельца (root only)

### Загрузка файлов
- `POST /api/upload-image` — загрузка изображения (jpg/jpeg/png/gif/webp, до 5MB)

### Бэкапы (root only)
- `GET /api/backups`, `POST /api/backups/create`, `POST /api/backups/upload`,
  `POST /api/backups/restore/:fileName`, `GET /api/backups/download/:fileName`,
  `DELETE /api/backups/:fileName`, `GET/PUT /api/backups/auto/settings`, `POST /api/backups/auto/run`

## Хранение статей (content/)

С Этапа 3 статьи Ibripedia хранятся не в БД, а как Markdown-файлы:
`content/<slug>.md`, где `slug` — транслитерированный заголовок
(`src/services/slugify.js`), он же id статьи в URL и цель wiki-ссылок
`[[slug]]`. Каждый файл — YAML-frontmatter + тело в Markdown:

```markdown
---
title: Заголовок статьи
date: '2026-04-09T15:19:39.000Z'
updated: '2026-04-09T15:19:51.000Z'
author: ''
tags: []
category: ''
excerpt: ''
server: null       # id или имя "сервера", к которому привязана статья
locked: false       # если true — видна только по ролям ниже
roles: []           # id ролей сервера, у кого есть доступ при locked=true
image: null         # обложка
attachments: []
views: 0
---
Текст статьи в Markdown.
```

- Удаление перемещает файл в `content/.trash/` (не безвозвратно).
- Список статей кэшируется в памяти (`src/services/articles-store.js`) и
  инвалидируется при любой записи через API или восстановлении бэкапа.
- `scripts/migrate-articles-to-markdown.js` — миграция из старого
  `articles.db` (HTML в SQLite) в `content/*.md` (HTML конвертируется в
  Markdown через `turndown`). Безопасно запускать повторно — уже
  смигрированные статьи (по `legacyId` в frontmatter) пропускаются.
- Резервные копии (`/api/backups/*`) включают `content/` целиком.

## Редактор статей (в стиле Obsidian)

С Этапа 4 форма статьи (`public/views/articles.html`, логика — `public/editor-manager.js`)
использует CodeMirror 6 вместо старого contenteditable-редактора:

- **Markdown**: заголовки, списки (в т.ч. чек-листы `- [ ]`), цитаты, код
  (строчный и блоки), таблицы, горизонтальные линии — через тулбар или
  напрямую руками.
- **Режимы**: "Редактирование" / "Просмотр" / "Разделить" (слева редактор,
  справа live-превью) — переключаются кнопками над редактором.
- **Wiki-ссылки** `[[Название статьи]]` или `[[slug|текст]]`: подсвечиваются
  синим (статья существует) или красным (не существует, при клике в превью —
  предложение создать); автодополнение по вводу `[[` в редакторе.
  В самом CodeMirror переход по ссылке — Ctrl/Cmd+клик (чтобы не мешать
  редактированию текста), в панели "Просмотр" — обычный клик.
- **Теги** `#тег` прямо в тексте (плюс теги из формы/frontmatter) —
  подсвечиваются, клик открывает список статей с этим тегом.
- **Backlinks**: под формой статьи, при редактировании существующей —
  список статей, ссылающихся на неё.
- **Горячие клавиши**: Ctrl+B (жирный), Ctrl+I (курсив), Ctrl+K (ссылка),
  Ctrl+S (сохранить), Ctrl+Shift+F (перейти к поиску по статьям).
- Переименование статьи со сменой slug и автоматическим обновлением ссылок —
  через `PUT /api/articles/:slug/rename` (см. выше; UI-кнопка переименования
  использует этот эндпоинт).

CodeMirror 6, `marked` (рендер Markdown в превью) и `DOMPurify` (санитайзинг
HTML превью) подключаются во время выполнения из CDN (esm.sh/jsDelivr) через
динамический `import()` — в проекте нет сборщика фронтенда, поэтому пакеты
не лежат в `node_modules` браузерной части и не требуют build-шага. Версии
`@codemirror/*` пакетов зафиксированы точно и явно согласованы через параметр
`?deps=` у esm.sh, чтобы все части CodeMirror ссылались на один и тот же
экземпляр `@codemirror/state`/`@codemirror/view` (иначе бросает ошибки
несовместимых расширений).

## Базы данных

Сервер использует SQLite для остальных данных:

1. **messenger.db** — сообщения мессенджера
2. **users.db** — пользователи и роли
3. **articles.db** — только категории статей (сами статьи — в `content/`, см. выше)
4. **servers.db** — серверы, роли на серверах и участники

## Веб-интерфейс

Сервер обслуживает статические файлы из папки `public/` (одностраничное приложение).

## Разработка

- Node.js + Express.js
- SQLite3 (мессенджер, серверы, пользователи, категории)
- gray-matter для чтения/записи Markdown-frontmatter статей, turndown — для миграции HTML в Markdown
- JWT (jsonwebtoken) + bcryptjs для аутентификации
- Multer для загрузки файлов, adm-zip для бэкапов
- Nodemon для автоматической перезагрузки при изменениях

## Лицензия

ISC
