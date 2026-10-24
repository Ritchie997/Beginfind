# Домены и владельцы кода

Карта ownership по текущей структуре. Для точного поведения проверяйте
перечисленные исходники: перечисление не означает, что каждый вызов обязательно
проходит через все эти слои.

| Домен | HTTP / серверная логика | Клиент |
| --- | --- | --- |
| Запуск, SPA fallback | `src/server.js`, `src/routes/pages.routes.js` | `public/index.html`, `public/app.js`, `public/spa-router.js` |
| Аутентификация, профили, root и заявки | `src/routes/auth.routes.js`, `src/middleware/auth.js`, `src/services/avatars.js` | `public/auth-system.js`, `public/spa-router.js`, `public/views/profile.html`, `pending-users.html`, `users-list.html` |
| Сообщения | `src/routes/messages.routes.js` | `public/app.js`, `public/spa-router.js` |
| Франшизы (серверы), хабы, роли, каналы, членство | `src/routes/servers.routes.js`, `src/services/server-system-logic.js`, `server-permissions.js` | `public/spa-router.js`, `public/views/servers.html` |
| Глобальная таксономия | `src/routes/taxonomy.routes.js` | `public/spa-router.js` |
| Статьи Antropedia | `src/routes/articles.routes.js`, `src/services/articles-store.js`, `blocks.js`, `article-layers.js`, `slugify.js`, `mentions.js` | `public/editor-manager.js`, `blocks-renderer.js`, `antropedia.js`, `spa-router.js`, `public/views/articles.html`, `antropedia.html` |
| Поиск, граф и цвета тегов | `articles.routes.js`, `articles-store.js`, `tag-colors.js` | `public/graph-view.js`, `antropedia.js`, `public/views/tags.html`, `dashboard.html` |
| Закладки статей | `src/routes/bookmarks.routes.js`, `src/services/bookmarks-store.js` | `public/spa-router.js`, `antropedia.js` |
| Социальные действия и уведомления | `src/services/social-store.js`, `notification-seen.js`, `user-notifications.js`, `src/routes/notifications.routes.js` | `public/user-notifications.js`, `spa-router.js`, `antropedia.js` |
| Черновики и папки черновиков | `src/routes/drafts.routes.js`, `src/services/drafts-store.js` | `public/spa-router.js`, `editor-manager.js` |
| Интерактивные карты и миры | `src/routes/maps.routes.js`, `src/services/maps-store.js`, `worlds-store.js`, `map-access.js`, `map-tiler.js` | `public/maps/map-core.js`, `map-editor.js`, `maps-ui.js`, `map-calendar.js` |
| Галерея | `src/routes/gallery.routes.js`, `src/services/gallery-store.js` | Админка: `public/gallery.js`, `public/gallery.css`, `public/views/gallery.html`; витрина: `public/site/gallery.html`, `public/site/gallery-client.js`, `public/site/gallery.css` |
| Стикеры | `src/routes/stickers.routes.js`, `src/services/stickers-store.js` | `public/stickers-manager.js`, `sticker-store.js`, `sticker-pack-view.js`, `public/views/stickers.html` |
| Обращения и модерация кейсов | `src/routes/feedback.routes.js`, `src/services/feedback-store.js` | `public/feedback-manager.js`, `public/views/feedback.html` |
| Бэкапы | `src/routes/backups.routes.js`, `src/services/backup.js`, `backup-settings.js` | `public/backup-ui.js`, `public/views/settings.html` |
| Очистка загрузок | `src/routes/cleanup.routes.js`, `src/services/cleanup.js`, `cleanup-settings.js` | `public/cleanup-ui.js`, `public/views/settings.html` |
| Настройки приложения | `src/routes/settings.routes.js`, `src/services/system-settings.js` | `public/spa-router.js`, `public/views/settings.html` |
| Миграция старых статей | `src/routes/article-migration.routes.js`, `src/services/article-migrate.js` | `public/article-migration-ui.js` |
| Аналитика | `src/services/dashboard-stats.js`, endpoint в `src/routes/articles.routes.js` | `public/views/dashboard.html`, `public/spa-router.js`, `public/graph-view.js` |
| Загрузка изображений | `src/routes/uploads.routes.js`, `src/uploads/multer-config.js` | `public/editor-manager.js`, `public/spa-router.js` |

План реализации пользовательской (публичной) версии и правила для гостевого
доступа к Antropedia: [`CLIENT_SITE_PLAN.md`](CLIENT_SITE_PLAN.md).

## Междоменные связи

- Пользовательский id используется в статьях, черновиках, закладках, социальной
  активности, галерее, стикерах и обращениях. Имена могут разрешаться динамически;
  перед переименованием пользователя ищите все store и сериализаторы.
- Доступ к статьям/картам/галерее может зависеть от сервера, ролей или авторства.
  Изменение API должно сохранять серверную проверку для всех путей чтения и записи.
- Статья может ссылаться на карту и галерейную работу; миграция/удаление
  содержимого требует искать ссылки и обратные ссылки.
- Тайлы карт находятся в публичной uploads-папке, а карты и исходники — в разных
  местах; работа с картой затрагивает и файловые операции, и JSON-состояние.
- Бэкап объединяет базы, контент и пользовательские файлы. Изменение любого
  доменного формата — повод проверить `src/services/backup.js` и восстановление.
