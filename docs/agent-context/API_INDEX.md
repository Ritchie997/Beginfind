# Индекс API

Пути указаны относительно `/api`: все перечисленные router-модули монтируются
в `src/server.js` под этим префиксом. Это индекс объявленных маршрутов, а не
спецификация запросов, ответов или доступа.

Параметры `:id`, `:slug` и т. п. — path parameters. Авторизация и права
проверяются на уровне отдельных обработчиков: перед изменением endpoint
прочитайте middleware и handler в указанном файле, не делайте вывод по
соседнему маршруту.

Сгенерировано из строковых `router.get/post/put/patch/delete` объявлений
командой `npm run docs:api-index`. `pages.routes.js` исключён: он обслуживает
страницы SPA и fallback, а не API. Маршруты, заданные динамически, необходимо
документировать отдельно.

## `article-migration.routes.js`

- `GET /articles-migration/preview`
- `POST /articles-migration/run`

## `articles.routes.js`

- `GET /articles`
- `GET /articles/browse`
- `GET /articles/:id`
- `GET /articles/:id/layers`
- `POST /articles/:id/view`
- `POST /articles`
- `PUT /articles/:id`
- `DELETE /articles/:id`
- `GET /search-articles`
- `GET /articles/:id/backlinks`
- `GET /articles/:id/map-refs`
- `GET /articles/:id/likes`
- `POST /articles/:id/likes/toggle`
- `GET /articles/:id/reactions`
- `POST /articles/:id/reactions/toggle`
- `GET /articles/:id/comments`
- `POST /articles/:id/comments`
- `POST /articles/:id/comments/:commentId/reactions/toggle`
- `DELETE /articles/:id/comments/:commentId`
- `GET /articles-index`
- `GET /tags`
- `PUT /tags/color`
- `GET /articles-graph`
- `GET /dashboard-summary`
- `PUT /articles/:id/rename`

## `auth.routes.js`

- `POST /register`
- `POST /login`
- `POST /refresh-token`
- `GET /profile`
- `PUT /profile`
- `POST /profile/avatar`
- `DELETE /profile/avatar`
- `GET /users/:id/profile`
- `PUT /users/:id/note`
- `GET /profile/observer-status`
- `GET /pending-users`
- `PUT /pending-users/:id/approve`
- `PUT /pending-users/:id/reject`
- `GET /all-users`
- `GET /archived-users`
- `GET /admin-roles`
- `POST /admin-roles`
- `PUT /admin-roles/:id`
- `DELETE /admin-roles/:id`
- `PUT /users/:id/role-manager`
- `PUT /users/:id/role`
- `DELETE /users/:id`
- `POST /archived-users/:id/transfer-content`
- `PUT /users/:id/rename`
- `PUT /users/:id/block`
- `PUT /users/:id/unblock`
- `PUT /users/:id/mute`
- `PUT /users/:id/unmute`

## `backups.routes.js`

- `POST /backups/create`
- `POST /backups/restore/:fileName`
- `POST /backups/upload`
- `GET /backups`
- `DELETE /backups/:fileName`
- `GET /backups/download/:fileName`
- `GET /backups/auto/settings`
- `PUT /backups/auto/settings`
- `POST /backups/auto/run`

## `bookmarks.routes.js`

- `GET /bookmarks`
- `POST /bookmarks`
- `PUT /bookmarks/:id`
- `DELETE /bookmarks/:id`

## `cleanup.routes.js`

- `GET /cleanup/settings`
- `PUT /cleanup/settings`
- `GET /cleanup/preview`
- `POST /cleanup/run`

## `drafts.routes.js`

- `GET /drafts`
- `POST /drafts/move`
- `GET /draft-folders`
- `POST /draft-folders`
- `PATCH /draft-folders/:id`
- `DELETE /draft-folders/:id`
- `GET /drafts/:id`
- `PUT /drafts/:id`
- `DELETE /drafts/:id`

## `feedback.routes.js`

- `POST /feedback/reports`
- `GET /feedback/reports/mine`
- `GET /feedback/reports/:id/comments`
- `POST /feedback/reports/:id/comments`
- `DELETE /feedback/reports/:id/comments/:commentId`
- `PUT /feedback/reports/:id`
- `POST /feedback/reports/:id/withdraw`
- `GET /feedback/reports`
- `POST /feedback/reports/:id/accept`
- `POST /feedback/reports/:id/reject`
- `POST /feedback/reports/:id/restore`
- `GET /feedback/queue`
- `GET /feedback/cases`
- `GET /feedback/cases/:id`
- `POST /feedback/cases`
- `PUT /feedback/cases/:id`
- `POST /feedback/cases/:id/reports`
- `DELETE /feedback/cases/:id/reports/:reportId`
- `POST /feedback/cases/:id/escalate`
- `POST /feedback/cases/:id/archive`
- `POST /feedback/cases/:id/decide`
- `POST /feedback/cases/:id/complete`
- `POST /feedback/cases/:id/return`

## `franchises.routes.js`

- `GET /public/franchises`
- `GET /public/franchises/:id`
- `GET /franchises/mine`
- `GET /franchises/feed`
- `POST /franchises/feed/read`
- `GET /franchises/:id/posts/:postId/likes`
- `POST /franchises/:id/posts/:postId/likes/toggle`
- `GET /franchises/:id/posts/:postId/comments`
- `POST /franchises/:id/posts/:postId/comments`
- `DELETE /franchises/:id/posts/:postId/comments/:commentId`
- `GET /franchises/:id/posts/:postId/reactions`
- `POST /franchises/:id/posts/:postId/reactions/toggle`
- `POST /franchises/:id/posts/:postId/comments/:commentId/reactions/toggle`
- `POST /franchises/:id/feed/read`
- `POST /franchises/:id/posts`
- `PUT /franchises/:id/posts/:postId`
- `DELETE /franchises/:id/posts/:postId`
- `POST /franchises/:id/posts/:postId/approve`
- `POST /franchises/:id/posts/:postId/reject`

## `gallery.routes.js`

- `GET /public/gallery/works`
- `GET /public/gallery/tags`
- `GET /public/gallery/works/:id`
- `GET /public/gallery/works/:id/likes`
- `GET /public/gallery/works/:id/reactions`
- `GET /public/gallery/works/:id/comments`
- `GET /gallery/folders`
- `POST /gallery/folders`
- `PUT /gallery/folders/:id`
- `PATCH /gallery/folders/:id`
- `DELETE /gallery/folders/:id`
- `PUT /gallery/works/:id/folder`
- `POST /gallery/works/move-to-folder`
- `GET /gallery/works`
- `GET /gallery/tags`
- `GET /gallery/by-article/:slug`
- `GET /gallery/works/:id`
- `POST /gallery/works`
- `PUT /gallery/works/:id`
- `DELETE /gallery/works/:id`
- `POST /gallery/works/:id/images`
- `POST /gallery/works/:id/view`
- `GET /gallery/works/:id/likes`
- `POST /gallery/works/:id/likes/toggle`
- `GET /gallery/works/:id/reactions`
- `POST /gallery/works/:id/reactions/toggle`
- `GET /gallery/works/:id/comments`
- `POST /gallery/works/:id/comments`
- `POST /gallery/works/:id/comments/:commentId/reactions/toggle`
- `DELETE /gallery/works/:id/comments/:commentId`

## `maps.routes.js`

- `GET /servers/:id/world`
- `PUT /servers/:id/world`
- `PUT /servers/:id/world/calendar`
- `GET /maps`
- `POST /maps`
- `GET /maps/:id`
- `PUT /maps/:id`
- `DELETE /maps/:id`
- `POST /maps/:id/basemaps`
- `PUT /maps/:id/basemaps/:bid/chunk`
- `POST /maps/:id/basemaps/:bid/complete`
- `POST /maps/:id/basemaps/:bid/retile`
- `POST /maps/:id/basemaps/:bid/align`
- `POST /maps/:id/basemaps/:bid/replace`
- `PUT /maps/:id/basemaps/:bid/replace/chunk`
- `POST /maps/:id/basemaps/:bid/replace/complete`
- `DELETE /maps/:id/basemaps/:bid/replace`
- `DELETE /maps/:id/basemaps/:bid`

## `messages.routes.js`

- `GET /messages`
- `POST /messages`

## `notifications.routes.js`

- `GET /notifications/summary`
- `GET /notifications`
- `POST /notifications/read`

## `public-articles.routes.js`

- `GET /public/site-summary`
- `GET /public/articles-graph`
- `GET /public/articles`
- `GET /public/tags`
- `GET /public/articles-index`
- `GET /public/articles/:slug`
- `GET /public/articles/:slug/comments`

## `servers.routes.js`

- `GET /servers`
- `GET /servers/:id/hubs`
- `POST /servers/:id/hubs`
- `PUT /servers/:id/hubs/:hubId`
- `PUT /servers/:id/hubs/:hubId/status`
- `DELETE /servers/:id/hubs/:hubId`
- `GET /servers/:id`
- `POST /servers`
- `PUT /servers/:id`
- `DELETE /servers/:id`
- `GET /servers/:id/users`
- `GET /servers/:id/roles`
- `POST /servers/:id/roles`
- `POST /servers/:serverId/users/:userId`
- `DELETE /servers/:serverId/users/:userId`
- `POST /servers/:serverId/users/:userId/roles/:roleId`
- `DELETE /servers/:serverId/users/:userId/roles/:roleId`
- `DELETE /servers/:serverId/roles/:roleId`
- `PUT /servers/:serverId/roles/:roleId`
- `GET /servers/:id/channels`
- `POST /servers/:id/channels`
- `PUT /servers/:serverId/channels/:channelId`
- `DELETE /servers/:serverId/channels/:channelId`
- `PUT /servers/:serverId/owner`
- `GET /users`
- `GET /users/search`
- `GET /servers/:id/audit-log`

## `settings.routes.js`

- `GET /system-settings`
- `PUT /system-settings`
- `GET /maintenance-status`
- `POST /maintenance-continue`
- `POST /maintenance-logout`

## `stickers.routes.js`

- `GET /stickers/mine`
- `GET /stickers/by-user/:userId`
- `GET /stickers/catalog`
- `GET /stickers/subscribed`
- `GET /stickers/packs/:id`
- `POST /stickers/packs`
- `PUT /stickers/packs/:id`
- `DELETE /stickers/packs/:id`
- `POST /stickers/packs/:id/stickers`
- `DELETE /stickers/stickers/:id`
- `POST /stickers/packs/:id/collab/stickers`
- `DELETE /stickers/collab/stickers/:id`
- `POST /stickers/packs/:id/collab/submit`
- `POST /stickers/collab/:id/cancel`
- `GET /stickers/collab/incoming`
- `GET /stickers/collab/outgoing`
- `POST /stickers/collab/:id/accept`
- `POST /stickers/collab/:id/decline`
- `GET /stickers/favorites`
- `POST /stickers/stickers/:id/favorite`
- `DELETE /stickers/stickers/:id/favorite`
- `POST /stickers/packs/:id/subscribe`
- `DELETE /stickers/packs/:id/subscribe`
- `POST /stickers/packs/:id/publish`
- `POST /stickers/packs/:id/unpublish`
- `POST /stickers/packs/:id/resubmit`
- `GET /stickers/pending`
- `POST /stickers/packs/:id/approve`
- `POST /stickers/packs/:id/reject`
- `POST /stickers/packs/:id/revoke`

## `taxonomy.routes.js`

- `GET /roles`
- `POST /roles`
- `DELETE /roles/:id`

## `uploads.routes.js`

- `POST /upload-image`
- `POST /upload-images`
