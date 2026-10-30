# Frontend: загрузка, экраны и источники логики

Фронтенд — статические файлы без сборочного шага. Главный entry point —
`public/index.html`; скрипты загружаются в том же документе и используют
глобальные объекты/DOM. При перестановке подключений проверяйте зависимости,
а не только имена файлов.

## Загрузка приложения

В `public/index.html` подключены базовые стили, затем Chart.js и клиентские
скрипты: `request-guard.js`, `auth-system.js`, `app.js`, `chip-field.js`,
`spa-router.js`, `sidebar-manager.js`, `blocks-renderer.js`,
`editor-manager.js`, `graph-view.js`, `antropedia.js`, `gallery.js`,
`user-notifications.js`, `stickers-manager.js`, `feedback-manager.js`,
`confirm-dialog.js`, `sticker-pack-view.js`, `sticker-store.js`, `backup-ui.js`,
`cleanup-ui.js`, `article-migration-ui.js`; после них — Leaflet и клиентские
модули карт. Порядок фактических `<script>` — в `index.html`.

Некоторые библиотеки загружаются во время работы из CDN: Markdown/санитайзер,
CodeMirror, D3 и геометрические библиотеки. Ищите URL в исходнике перед
добавлением зависимости или предположением, что пакет локально установлен.

## Модули интерфейса

| Файлы | Ответственность |
| --- | --- |
| `public/app.js`, `auth-system.js`, `request-guard.js` | Инициализация, auth/client state, общие запросы |
| `public/spa-router.js` | Навигация, загрузка экранов и крупная часть UI/операций SPA, включая каталог франшиз/хабов и выбор франшизы/хаба в редакторе |
| `public/views/*.html` | HTML-фрагменты экранов, подгружаемые приложением |
| `src/routes/pages.routes.js`, `public/site/*.html`, `public/site/site.js`, `public/site/router.js`, `public/site/site.css` | Публичная витрина; клиентская SPA-навигация между публичными страницами, сервер рендерит article metadata для preview |
| `public/site/alltell-client.js` | Каталог опубликованных франшиз, создание и воркспейс управления франшизами, роли, каналы, хабы, членство и лента AllTell |
| `public/editor-manager.js`, `blocks-renderer.js`, `editor-blocks.css` | Редактор и отображение документов статей-блоков |
| `public/antropedia.js`, `antropedia.css`, `editor-obsidian.css` | Вики-экран и оформление Antropedia |
| `public/graph-view.js` | Граф статей |
| `public/maps/*.js`, `maps.css` | Ядро карт, календарь, редактор, UI; см. `map-core.js` |
| `public/gallery.js`, `gallery.css`, `public/site/gallery-client.js`, `public/site/gallery.css` | Галерея в админке и публичной витрине; публичный клиент подключает существующий просмотрщик/редактор и управляет его lifecycle |
| `public/stickers-manager.js`, `sticker-store.js`, `sticker-pack-view.js` | Каталог и просмотр стикеров |
| `public/feedback-manager.js` | Обращения и связанные UI-действия |
| `public/user-notifications.js`, `.css` | Панель уведомлений |
| `public/backup-ui.js`, `cleanup-ui.js`, `article-migration-ui.js` | Административные операции |
| `public/sidebar-manager.js`, `mobile-menu.css`, `global-styles.css` | Навигация, адаптивная и общая стилизация |

## Как быстро найти экран

1. Найти имя страницы/элемента в `public/views/` или `public/index.html`.
2. Найти JS-обработчик по id, `data-*` атрибуту, имени функции или API-пути.
3. Проверить, загружается ли экран через `spa-router.js` и есть ли lifecycle
   очистки (повторное открытие экрана не должно копить listeners/timers).
4. Проследить API вызов до `API_INDEX.md` и серверного route.
5. Проверить состояние loading/empty/error и права пользователя, а не только
   happy path.

`spa-router.js` и некоторые редакторы очень велики: используйте точечный поиск
по идентификатору/функции и читайте диапазон вокруг результата. Не переносите
логику из существующего доменного модуля в router без причины.

## Практические оговорки

- Клиентская проверка доступа улучшает UX, но сервер обязан повторить её.
- Формы могут иметь офлайн/локальные черновики; сохраняйте совместимость и
  поведение конфликтов/повторной отправки.
- Скрипт может ожидать библиотеку из CDN или глобальный объект, загруженный
  ранее. Проверяйте порядок `<script>` и динамическую загрузку.
- Статические JS выдаются с политикой no-cache из `src/server.js`; изменение
  cache/version-поведения требует проверить развёртывание и клиентский кэш.
