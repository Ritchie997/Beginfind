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
    backup.js                 — создание/восстановление/список бэкапов (ZIP)
    backup-settings.json       — настройки автобэкапа (создаётся автоматически)
    backup-settings.js         — чтение/запись backup-settings.json
    scheduled-cleanup.js       — очистка неиспользуемых файлов в uploads/ (cron, сейчас выключен)
    server-permissions.js      — проверка прав/иерархии ролей на сервере
    server-system-logic.js     — CRUD для серверов, ролей, участников
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

public/                     — статические файлы веб-интерфейса (SPA)
backups/                    — сохранённые ZIP-бэкапы баз данных (создаётся автоматически)
articles.db, messenger.db, servers.db, users.db — базы данных SQLite (создаются автоматически)
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
- `GET /api/articles` — список статей (закрытые по ролям статьи видны только тем, у кого есть доступ)
- `GET /api/articles/:id` — статья по ID
- `POST /api/articles` — создать статью
- `PUT /api/articles/:id` — обновить статью
- `DELETE /api/articles/:id` — удалить статью
- `GET /api/search-articles?q=...` — полнотекстовый поиск
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

## Базы данных

Сервер использует SQLite для хранения данных:

1. **messenger.db** — сообщения мессенджера
2. **users.db** — пользователи и роли
3. **articles.db** — статьи и категории Ibripedia
4. **servers.db** — серверы, роли на серверах и участники

## Веб-интерфейс

Сервер обслуживает статические файлы из папки `public/` (одностраничное приложение).

## Разработка

- Node.js + Express.js
- SQLite3
- JWT (jsonwebtoken) + bcryptjs для аутентификации
- Multer для загрузки файлов, adm-zip для бэкапов
- Nodemon для автоматической перезагрузки при изменениях

## Лицензия

ISC
