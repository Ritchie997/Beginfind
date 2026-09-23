// ibripedia.js — витрина статей (страница Ibripedia): фильтры + сортировка +
// сетка/список карточек с бесконечной подгрузкой, и отдельный экран
// просмотра одной статьи (редактирование открывается по кнопке, а не по
// клику на карточку — см. public/views/ibripedia.html).
//
// Раньше это был раздел "Управление статьями" под формой редактора —
// один плоский список БЕЗ пагинации (GET /api/articles отдавал все статьи
// разом). При росте числа статей до сотен тысяч это стало бы неюзабельным,
// поэтому здесь — постраничная подгрузка через GET /api/articles/browse
// (см. src/routes/articles.routes.js) вместо загрузки всего сразу.
//
// Статья (дерево блоков, см. src/services/blocks.js) рендерится общим
// модулем public/blocks-renderer.js — тем же, что использует панель
// "Просмотр" в редакторе — картинки/колонки/инфобоксы/wiki-ссылки/#теги
// выглядят и ведут себя одинаково в обоих местах. editor-manager.js для
// одного лишь чтения статьи не требуется — ibripedia.js от него не зависит.

(function () {
  'use strict';

  const PAGE_SIZE = 24;

  // Палитра цветов для закладок (попап "Установить закладку?") — те же
  // discord-подобные акцентные цвета, что и в остальном интерфейсе
  // (--blurple/--green/--red/--yellow из global-styles.css), плюс ещё
  // несколько для различимости, если закладок на статью много.
  const BOOKMARK_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#eb459e', '#00b0f4', '#f0791f'];

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // Шорткод стикера ":slug:alias:" — тот же формат и тот же алфавит
  // (латиница/цифры/дефис), что и SHORTCODE_RE в src/services/stickers-store.js,
  // включая заглавные буквы в классе символов: многие пришли из Discord и
  // печатают шорткод руками в произвольном регистре — сам slug/alias в БД
  // всегда строчный (см. slugify), но набирать его пользователь может как
  // угодно. Ключ в stickersMap — всегда строчный, поэтому ниже, при поиске
  // соответствия, обе части приводятся к нижнему регистру (см. .toLowerCase()
  // в formatCommentContent).
  const STICKER_SHORTCODE_RE = /:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):/g;
  const STICKER_SOLO_RE = /^:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):$/;

  // Рендерит текст комментария с учётом шорткодов стикеров — `stickersMap`
  // приходит с сервера вместе с комментарием (см. attachStickersToItems в
  // src/services/stickers-store.js), ключ — "slug:alias".
  //   - комментарий, ЦЕЛИКОМ состоящий из одного шорткода (после trim) —
  //     отдельный крупный "стикер" (см. .ibripedia-comment-sticker-only);
  //   - шорткод(ы) среди прочего текста — маленькая инлайн-картинка;
  //   - шорткод без соответствия в stickersMap (набор удалён/отклонён после
  //     публикации комментария) — остаётся как обычный текст.
  function formatCommentContent(content, stickersMap) {
    const raw = String(content || '');
    const soloMatch = raw.trim().match(STICKER_SOLO_RE);
    if (soloMatch) {
      const code = `${soloMatch[1].toLowerCase()}:${soloMatch[2].toLowerCase()}`;
      const sticker = stickersMap && stickersMap[code];
      if (sticker) {
        // data-pack-id — по клику на стикер открываем его набор целиком
        // (просмотр + добавить/убрать себе), см. public/sticker-pack-view.js
        // и обработчик клика в initEngagement() ниже.
        return {
          standalone: true,
          html: `<img class="ibripedia-standalone-sticker" data-pack-id="${escapeHtml(sticker.packId)}" src="${escapeHtml(sticker.url)}" alt="${escapeHtml(code)}" title="${escapeHtml(code)}">`
        };
      }
    }

    const html = escapeHtml(raw).replace(STICKER_SHORTCODE_RE, (match, pack, alias) => {
      const code = `${pack.toLowerCase()}:${alias.toLowerCase()}`;
      const sticker = stickersMap && stickersMap[code];
      if (!sticker) return match;
      return `<img class="ibripedia-inline-sticker" data-pack-id="${escapeHtml(sticker.packId)}" src="${escapeHtml(sticker.url)}" alt="${escapeHtml(code)}" title="${escapeHtml(code)}">`;
    });
    return { standalone: false, html };
  }

  // ---------- Rich-ввод комментария/ответа — CONTENTEDITABLE вместо
  // textarea, чтобы вставленный стикер было видно картинкой сразу при
  // наборе, а не текстом шорткода (см. wireComposer() в классе ниже). ----------

  // Собирает те же ":slug:alias:" + перенос строки обратно в plain-текст,
  // который ожидает сервер (см. SHORTCODE_RE в src/services/stickers-store.js) —
  // обходом дерева contenteditable-узлов: картинка стикера → её шорткод из
  // data-shortcode, <br>/блочный элемент → перенос строки, остальное — как
  // обычный текст.
  function serializeRichInput(el) {
    let out = '';
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { out += node.textContent; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'IMG' && node.dataset.shortcode) { out += node.dataset.shortcode; return; }
      if (node.tagName === 'BR') { out += '\n'; return; }
      const isBlock = node.tagName === 'DIV' || node.tagName === 'P';
      const lenBefore = out.length;
      Array.from(node.childNodes).forEach(walk);
      if (isBlock && out.length > lenBefore && !out.endsWith('\n')) out += '\n';
    }
    Array.from(el.childNodes).forEach(walk);
    return out.replace(/ /g, ' ').trim();
  }

  // Текущая позиция курсора в поле — а если фокус успел уйти (например, на
  // кнопку пикера стикеров), последняя сохранённая на 'blur' (см.
  // wireComposer()) или, если её вообще ещё не было, конец поля.
  function getEditableRange(el) {
    const sel = window.getSelection();
    if (sel.rangeCount && el.contains(sel.anchorNode)) return sel.getRangeAt(0).cloneRange();
    if (el._savedRange && el.contains(el._savedRange.startContainer)) return el._savedRange.cloneRange();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    return r;
  }

  // Вставляет стикер КАРТИНКОЙ на месте курсора — задача "видно сразу, без
  // текста шорткода". contentEditable="false" на самой картинке — курсор не
  // может зайти внутрь нередактируемого узла, только вокруг него; следом —
  // неразрывный пробел, чтобы можно было продолжать печатать и вставить
  // подряд ещё один стикер, не склеивая их в один шорткод.
  function insertStickerChip(el, shortcode, thumbUrl) {
    const range = getEditableRange(el);
    range.deleteContents();
    const img = document.createElement('img');
    img.className = 'ibripedia-inline-sticker-chip';
    img.src = thumbUrl;
    img.alt = shortcode;
    img.contentEditable = 'false';
    img.dataset.shortcode = shortcode;
    range.insertNode(img);
    const space = document.createTextNode(' ');
    img.after(space);
    const newRange = document.createRange();
    newRange.setStartAfter(space);
    newRange.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(newRange);
    el._savedRange = newRange.cloneRange();
    el.focus();
  }

  // ---------- Реакции (эмодзи/стикером) — общая полоска "пилюль" под
  // статьёй и под каждым комментарием/ответом, см. handleReactionsClick() и
  // toggleReaction() в классе ниже. ----------

  function reactionsBarInnerHtml(reactions) {
    const pills = (reactions || []).map((r) => `
      <button type="button" class="ibripedia-reaction-pill${r.reacted ? ' active' : ''}" data-shortcode="${escapeHtml(r.shortcode)}" title="${escapeHtml(r.packTitle || r.shortcode)}">
        <img src="${escapeHtml(r.url)}" alt=""><span>${r.count}</span>
      </button>`).join('');
    // data-sticker-picker-trigger — тот же общий маркер "это кнопка-триггер
    // пикера стикеров", что и .ibripedia-sticker-picker-btn у формы
    // комментария (см. STICKER_PICKER_MARKUP/closeAllStickerPickers ниже) —
    // пикер реакции переиспользует ТОТ ЖЕ компонент, а не отдельную модалку.
    return `${pills}<button type="button" class="ibripedia-reaction-add" data-sticker-picker-trigger title="Добавить реакцию"><i class="far fa-face-smile"></i></button>`;
  }

  // Разметка пикера стикеров — общая для формы комментария/ответа (см.
  // wireComposer()) и для полоски реакций (см. openReactionPicker()): один и
  // тот же компонент, а не два разных, чтобы не плодить дублирующиеся (и
  // рассинхронизирующиеся) реализации одного и того же выпадающего списка.
  //
  // Структура по аналогии с VK: лента вкладок-наборов сверху (плюс отдельная
  // вкладка-звёздочка для избранного — см. renderStickerPickerTabs), под ней
  // строка с названием/описанием активной вкладки, а сама прокручиваемая
  // сетка стикеров — только для НЕЁ (не все наборы разом, как было раньше).
  const STICKER_PICKER_MARKUP = `
    <div class="ibripedia-sticker-picker" hidden>
      <div class="ibripedia-sticker-picker-header">
        Стикеры
        <span class="ibripedia-sticker-picker-links">
          <a href="#" data-nav="/stickers">управлять наборами</a> ·
          <a href="#" data-role="open-store">магазин наборов</a>
        </span>
      </div>
      <div class="ibripedia-sticker-picker-tabs"></div>
      <div class="ibripedia-sticker-picker-subtitle"></div>
      <div class="ibripedia-sticker-picker-body"></div>
    </div>`;

  // position: fixed (см. CSS) — top/left считаем сами, а не полагаемся на
  // bottom/right относительно родителя: якорем бывает как широкая форма
  // комментария, так и узкая полоска реакций, которая может стоять не у
  // самого края своего контейнера — position:absolute в таком случае обрезал
  // бы popup ближайшим overflow:hidden предком (см. .ibripedia-view-article).
  // По умолчанию показываем НАД кнопкой (справа выровняв правый край с её
  // правым краем — привычно для выпадающих меню), но если сверху не хватает
  // места — под кнопкой; и зажимаем в границы окна по горизонтали.
  // STICKER_PICKER_MAX_HEIGHT — держим в JS ровно то же число, что и
  // max-height у .ibripedia-sticker-picker в ibripedia.css: эта функция сама
  // не умеет читать CSS max-height (offsetHeight/scrollHeight ещё не
  // финальны на первом рендере с пустым телом), поэтому число задано здесь
  // явно — при изменении высоты в CSS поменяйте и это.
  const STICKER_PICKER_MAX_HEIGHT = 480;

  // Порог "долгого нажатия" на стикер (увеличенное превью, см.
  // wireStickerPickerGestures) — короче обычных ~500-600мс у мобильных ОС,
  // потому что здесь это не системный контекст-меню, а собственный жест:
  // отзывчивее и не конфликтует с обычным тапом при чуть менее твёрдой руке.
  const STICKER_LONG_PRESS_MS = 450;

  // Тот же брейкпоинт, что и у донного листа в ibripedia.css (@media
  // max-width:640px) — единое место, откуда JS решает "мобильная раскладка
  // пикера или нет": донный лист снизу (см. positionStickerPicker) и то,
  // остаётся ли пикер открытым после выбора стикера (см. onSelect в
  // wireComposer/openReactionPicker — на телефоне закрывается, на ПК нет).
  function isMobilePickerLayout() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function positionStickerPicker(pickerEl, triggerEl) {
    if (isMobilePickerLayout()) {
      // Донный лист — целиком на CSS (left/right/bottom/width, см.
      // ibripedia.css), инлайн top/left тут не нужны и перебили бы его —
      // на всякий случай снимаем, если остались от десктопного расчёта
      // (например, окно растянули/сжали, пока пикер уже был открыт).
      pickerEl.style.left = '';
      pickerEl.style.top = '';
      return;
    }

    const rect = triggerEl.getBoundingClientRect();

    // window.innerHeight/innerWidth — это ПОЛНЫЙ layout-вьюпорт, который на
    // мобильном не сжимается вместе с открытой клавиатурой (в отличие от
    // window.visualViewport — именно он знает, что РЕАЛЬНО видно сейчас).
    // Раньше расчёт высоты попапа шёл от innerHeight, поэтому мог вылезти
    // под клавиатуру или (что и жаловались) оставить под собой пустую
    // полосу там, где раньше была клавиатура. Теперь клавиатуру у поля
    // ввода мы вообще не даём закрыть при работе с пикером (см. preventDefault
    // на mousedown в wireComposer/renderStickerPicker/wireStickerPickerGestures),
    // но сам расчёт границ всё равно делаем по видимой, а не номинальной области.
    const vv = window.visualViewport;
    const viewportWidth = vv ? vv.width : window.innerWidth;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    const viewportLeft = vv ? vv.offsetLeft : 0;
    const viewportTop = vv ? vv.offsetTop : 0;

    const width = pickerEl.offsetWidth || 380;
    let left = rect.right - width;
    if (left < viewportLeft + 8) left = viewportLeft + 8;
    if (left + width > viewportLeft + viewportWidth - 8) left = viewportLeft + viewportWidth - width - 8;

    const height = Math.min(STICKER_PICKER_MAX_HEIGHT, pickerEl.scrollHeight || STICKER_PICKER_MAX_HEIGHT);
    let top = rect.top - height - 8;
    if (top < viewportTop + 8) top = rect.bottom + 8;
    // Не даём уехать НИЖЕ видимой области (высокий попап на низкой кнопке в
    // короткой вьюпорте — например, над клавиатурой) — прижимаем к низу с
    // тем же отступом 8px, что и слева/справа/сверху.
    if (top + height > viewportTop + viewportHeight - 8) top = Math.max(viewportTop + 8, viewportTop + viewportHeight - height - 8);

    pickerEl.style.left = `${left}px`;
    pickerEl.style.top = `${top}px`;
  }

  // Русское склонение "N ответ/ответа/ответов" для кнопки "Показать ещё N…".
  function pluralizeReplies(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'ответ';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ответа';
    return 'ответов';
  }

  // Краткий текст для карточки — явный excerpt из формы статьи, а если его
  // не заполнили, вытаскиваем текст из дерева блоков (см.
  // window.blocksToExcerptText в blocks-renderer.js). articlesIndexBySlug
  // передаём дальше — нужен, чтобы вики-ссылка в начале текста показывала
  // резолвленное для ЭТОГО читателя название цели (в т.ч. правильный вариант
  // подписи по слою), а не сырой синтаксис [подпись]((статья)).
  function makeExcerpt(article, articlesIndexBySlug) {
    const explicit = article.excerpt && article.excerpt.trim();
    if (explicit) return explicit.length <= 180 ? explicit : explicit.slice(0, 180).replace(/\s+\S*$/, '') + '…';
    return window.blocksToExcerptText ? window.blocksToExcerptText(article.content, 180, articlesIndexBySlug) : '';
  }

  class IbripediaManager {
    constructor() {
      this.tagField = null;
      this.articlesIndex = [];
      this.articlesIndexBySlug = new Map();
      this.viewMode = 'grid';
      this.offset = 0;
      this.total = 0;
      this.loading = false;
      this.hasMore = true;
      this.currentSlug = null;
      this._observer = null;
      this._searchDebounce = null;
      this._keydownHandler = null;
      this._docClickHandler = null;

      // Лайки/реакции/комментарии открытой статьи
      this.currentLiked = false;
      this.currentReactions = [];
      this._commentsLoaded = false;
      this._commentsById = new Map();
      this._activeReplyParentId = null;
      // Треды ответов, развёрнутые пользователем (см. renderRepliesHtml) —
      // сбрасывается только при заходе в статью заново (resetEngagementUI),
      // не при каждой перерисовке списка комментариев (см. задачу "такое
      // поведение только по факту захода в комментарии").
      this._expandedReplyThreads = new Set();
      this.mainComposer = null;

      // Пикер стикеров в форме комментария — наборы, добавленные себе (см.
      // "Стикеры" в админ-панели), кэшируются на время открытой статьи.
      this._subscribedStickerPacks = null;
      // Избранные стикеры (звёздочка в пикере) — тот же принцип кэша, что и
      // выше; id'шники отдельно (Set) для быстрой проверки "уже в избранном"
      // при рендере звёздочки на превью. См. openStickerPickerPanel/
      // refreshOpenStickerPickers.
      this._favoriteStickers = null;
      this._favoriteStickerIds = null;
      // Какая вкладка пикера была открыта последней (slug набора или
      // 'favorites') — переживает закрытие/открытие пикера (как в VK),
      // сбрасывается только если этой вкладки больше не существует.
      this._activeStickerTab = null;

      // Закладки/оглавление/поиск по открытой статье
      this.currentArticleBookmarks = [];
      this._tocHeadings = [];
      this._tocObserver = null;
      this._searchHits = [];
      this._searchIndex = -1;
      this._inlineSearchDebounce = null;
      this._bmGutterResizeHandler = null;
      this._bmGutterResizeDebounce = null;
      this._bmWideMode = false;
      this._bmHoverCapable = false;
      this._bmBlocks = [];
      this._bmHoverMoveScheduled = false;
      this.bookmarkGhostEl = null;
      this.bookmarkGutterHoverEl = null;
      this.bookmarkCompactHoverEl = null;

      // Прокрутка витрины на момент открытия статьи — чтобы кнопка "Назад"
      // (closeArticleView) возвращала не наверх списка, а туда же, откуда
      // читатель ушёл в статью. Запоминается только при переходе ИЗ витрины
      // (см. openArticleView) — переходы между статьями по wiki-ссылкам/
      // бэклинкам, пока витрина и так скрыта, это значение не трогают, чтобы
      // "Назад" всегда возвращал к исходному месту в библиотеке.
      this._libraryScrollY = 0;
    }

    async init() {
      this.cleanup();

      this.browseEl = document.getElementById('ibripediaBrowse');
      this.viewEl = document.getElementById('ibripediaView');
      this.gridEl = document.getElementById('ibripediaGrid');
      this.emptyEl = document.getElementById('ibripediaEmpty');
      this.loadingMoreEl = document.getElementById('ibripediaLoadingMore');
      this.sentinelEl = document.getElementById('ibripediaSentinel');
      this.countEl = document.getElementById('ibripediaCount');
      this.searchEl = document.getElementById('ibripediaSearch');
      this.serverFilterEl = document.getElementById('ibripediaServerFilter');
      this.statusFilterEl = document.getElementById('ibripediaStatusFilter');
      this.dateFromEl = document.getElementById('ibripediaDateFrom');
      this.dateToEl = document.getElementById('ibripediaDateTo');
      this.sortEl = document.getElementById('ibripediaSort');
      this.filtersToggleBtn = document.getElementById('ibripediaFiltersToggleBtn');
      this.filtersPanelEl = document.getElementById('ibripediaFiltersPanel');
      this.filtersCountEl = document.getElementById('ibripediaFiltersCount');

      // Просмотр статьи: оглавление/закладки/поиск по тексту
      this.contentEl = document.getElementById('ibripediaViewContent');
      this.viewArticleEl = document.getElementById('ibripediaViewArticle');
      this.bookmarkGutterEl = document.getElementById('ibripediaBookmarkGutter');
      this.sidebarEl = document.getElementById('ibripediaViewSidebar');
      this.tocPanelEl = document.getElementById('ibripediaTocPanel');
      this.bookmarksPanelEl = document.getElementById('ibripediaBookmarksPanel');
      this.sidebarToggleBtn = document.getElementById('ibripediaSidebarToggleBtn');
      this.inlineSearchEl = document.getElementById('ibripediaInlineSearch');
      this.inlineSearchCountEl = document.getElementById('ibripediaInlineSearchCount');
      this.inlineSearchPrevBtn = document.getElementById('ibripediaInlineSearchPrev');
      this.inlineSearchNextBtn = document.getElementById('ibripediaInlineSearchNext');
      this.inlineSearchClearBtn = document.getElementById('ibripediaInlineSearchClear');
      this.bookmarkPopoverEl = document.getElementById('ibripediaBookmarkPopover');
      this.bookmarkPopoverNameEl = document.getElementById('ibripediaBookmarkPopoverName');
      this.bookmarkPopoverColorsEl = document.getElementById('ibripediaBookmarkPopoverColors');
      this.bookmarkPopoverDeleteBtn = document.getElementById('ibripediaBookmarkPopoverDelete');
      this.bookmarkPopoverCloseBtn = document.getElementById('ibripediaBookmarkPopoverClose');
      this.bookmarkModalBackdropEl = document.getElementById('ibripediaBookmarkModalBackdrop');

      // Лайк + комментарии под статьёй
      this.likeBtn = document.getElementById('ibripediaLikeBtn');
      this.likeCountEl = document.getElementById('ibripediaLikeCount');
      this.commentsBtn = document.getElementById('ibripediaCommentsBtn');
      this.commentsCountEl = document.getElementById('ibripediaCommentsCount');
      this.commentsSectionEl = document.getElementById('ibripediaViewComments');
      this.commentsHeaderCountEl = document.getElementById('ibripediaCommentsHeaderCount');
      this.commentsListEl = document.getElementById('ibripediaCommentsList');
      this.commentsEmptyEl = document.getElementById('ibripediaCommentsEmpty');
      this.commentFormEl = document.getElementById('ibripediaCommentForm');
      this.commentInputEl = document.getElementById('ibripediaCommentInput');
      this.reactionsBarEl = document.getElementById('ibripediaReactionsBar');

      if (!this.browseEl || !this.gridEl) return; // партиал ещё не в DOM

      this.initFiltersCollapse();

      this.viewMode = (() => {
        try { return localStorage.getItem('ibripediaViewMode') === 'list' ? 'list' : 'grid'; }
        catch (e) { return 'grid'; }
      })();
      this.applyViewMode();

      this.initChipFields();

      await Promise.all([
        this.loadServerOptions(),
        this.loadArticlesIndex()
      ]);

      this.bindEvents();
      this.setupInfiniteScroll();
      this.initSidebarTabs();
      this.initInlineSearch();
      this.initBookmarkGutter();
      this.initEngagement();

      await this.resetAndLoad();
    }

    // Вызывается перед каждой новой инициализацией (повторный заход на
    // /ibripedia) — партиал перезагружается через fetch, старые DOM-узлы
    // заменяются новыми, но document-level слушатели (keydown, клик "мимо
    // меню") и IntersectionObserver сами не исчезают, если их не снять явно.
    cleanup() {
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      if (this._tocObserver) { this._tocObserver.disconnect(); this._tocObserver = null; }
      if (this._keydownHandler) { document.removeEventListener('keydown', this._keydownHandler); this._keydownHandler = null; }
      if (this._docClickHandler) { document.removeEventListener('click', this._docClickHandler); this._docClickHandler = null; }
      if (this._bmGutterResizeHandler) { window.removeEventListener('resize', this._bmGutterResizeHandler); this._bmGutterResizeHandler = null; }
      clearTimeout(this._searchDebounce);
      clearTimeout(this._inlineSearchDebounce);
      clearTimeout(this._bmGutterResizeDebounce);
    }

    initChipFields() {
      const tagRoot = document.getElementById('ibripediaTagField');
      this.tagField = tagRoot ? new ChipField(tagRoot, {
        freeText: false,
        placeholder: 'Все теги...',
        emptyText: 'Теги не найдены',
        onChange: () => this.resetAndLoad()
      }) : null;
    }

    async loadServerOptions() {
      if (!this.serverFilterEl) return;
      try {
        const result = await window.apiClient.getServers();
        if (!result.success) return;
        result.data.forEach((server) => {
          const opt = document.createElement('option');
          opt.value = server.id;
          opt.textContent = server.name;
          this.serverFilterEl.appendChild(opt);
        });
      } catch (e) { /* фильтр по серверу останется с одним вариантом "Все" */ }
    }

    // Индекс статей (slug/title/tags) — нужен для: списка тегов в фильтре,
    // подсветки "существует/не существует/недоступно" у wiki-ссылок в
    // просмотре статьи, и подписи для отсутствующей статьи в диалоге
    // "создать?". restrictedSlugs — статьи, которые существуют, но не
    // открыты этому читателю ни на одном слое (см. /api/articles-index на
    // сервере) — рендерятся как "Недоступно", а не как "статьи ещё нет".
    async loadArticlesIndex() {
      try {
        const result = await window.apiClient.makeAuthenticatedRequest('/api/articles-index');
        const data = (result.success && result.data) || {};
        this.articlesIndex = Array.isArray(data.accessible) ? data.accessible : [];
        this.restrictedSlugs = new Set(Array.isArray(data.restrictedSlugs) ? data.restrictedSlugs : []);
      } catch (e) {
        this.articlesIndex = [];
        this.restrictedSlugs = new Set();
      }
      this.articlesIndexBySlug = new Map(this.articlesIndex.map((a) => [a.slug, a]));

      // Подсказки фильтра по тегам — глобальный список тегов без дублей (тот
      // же, что во вкладке "Теги"): и теги из поля "Теги", и #хэштеги из
      // текста статей, чтобы по любому из них можно было отфильтровать витрину.
      try {
        const tagsResult = await window.apiClient.getTags();
        const tags = (tagsResult.success && Array.isArray(tagsResult.data)) ? tagsResult.data : [];
        this.tagField?.setOptions(tags.map((t) => ({ value: t.tag, label: t.tag })));
      } catch (e) {
        // Фильтр по тегам просто останется без подсказок — не критично
      }
    }

    bindEvents() {
      this.searchEl?.addEventListener('input', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.resetAndLoad(), 300);
      });

      this.serverFilterEl?.addEventListener('change', () => this.resetAndLoad());
      this.statusFilterEl?.addEventListener('change', () => this.resetAndLoad());
      this.sortEl?.addEventListener('change', () => this.resetAndLoad());
      this.dateFromEl?.addEventListener('change', () => this.resetAndLoad());
      this.dateToEl?.addEventListener('change', () => this.resetAndLoad());

      document.getElementById('ibripediaResetFiltersBtn')?.addEventListener('click', () => this.resetFilters());
      document.getElementById('ibripediaEmptyResetBtn')?.addEventListener('click', () => this.resetFilters());

      document.getElementById('ibripediaNewBtn')?.addEventListener('click', () => window.spaRouter?.navigateTo('/articles'));
      document.getElementById('ibripediaRandomBtn')?.addEventListener('click', () => this.openRandomArticle());

      document.querySelectorAll('.ibripedia-view-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.setViewMode(btn.getAttribute('data-view')));
      });

      document.getElementById('ibripediaBackBtn')?.addEventListener('click', () => this.closeArticleView());
      document.getElementById('ibripediaEditBtn')?.addEventListener('click', () => this.editCurrentArticle());
      document.getElementById('ibripediaDeleteBtn')?.addEventListener('click', () => this.deleteArticle(this.currentSlug));

      this.gridEl?.addEventListener('click', (e) => this.handleGridClick(e));
      document.getElementById('ibripediaViewContent')?.addEventListener('click', (e) => this.handleViewContentClick(e));
      // Переключатель слоя — отдельный элемент СНАРУЖИ #ibripediaViewContent
      // (см. renderLayerSwitcher), поэтому его клики туда не всплывают и
      // нужен свой обработчик; handleViewContentClick сам проверяет
      // .ibripedia-layer-btn первым делом, переиспользуем ту же функцию.
      document.getElementById('ibripediaViewLayerSwitcher')?.addEventListener('click', (e) => this.handleViewContentClick(e));
      document.getElementById('ibripediaViewMeta')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="open-profile"]');
        if (!btn) return;
        window.spaRouter?.navigateTo(`/profile/${btn.getAttribute('data-value')}`);
      });

      // "/" фокусирует поиск — обычный для вики/поисковых интерфейсов
      // шорткат, не мешает, если фокус уже в каком-то текстовом поле.
      this._keydownHandler = (e) => {
        if (e.key !== '/' || (this.viewEl && !this.viewEl.hidden)) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.searchEl?.focus();
      };
      document.addEventListener('keydown', this._keydownHandler);

      // Закрывает открытое меню "⋮" карточки при клике мимо него, а также
      // попап закладки — клик вне попапа и вне стикера/значка, который его
      // открыл (у самих стикеров свой обработчик toggleBookmarkPopover,
      // который уже вызывает stopPropagation — сюда их клик и так не
      // доходит; проверка ниже — просто подстраховка), закрывает попап. НА
      // ТАЧ-УСТРОЙСТВАХ ПОПАП НЕ ЗАКРЫВАЕТСЯ КЛИКОМ МИМО ВООБЩЕ (там это
      // уже модальное окно, см. openBookmarkPopover) — случайный тап рядом
      // не должен сбрасывать начатую закладку, закрыть можно только явно
      // (Сохранить/Отмена/×).
      this._docClickHandler = (e) => {
        // Увеличенное превью стикера (см. openStickerPreviewOverlay) —
        // клик по его подложке (пустому месту) не должен закрывать НИЧЕГО,
        // включая пикер под ним: без этой проверки пикер посчитал бы такой
        // клик "снаружи себя" (оверлей превью — отдельный элемент в
        // document.body, а не внутри самого пикера) и закрылся бы сам, даже
        // не трогая видимый на экране оверлей. Закрыть превью — явно,
        // крестиком (см. ensureStickerPreviewOverlay).
        if (e.target.closest('.ibripedia-sticker-preview-overlay')) return;

        document.querySelectorAll('.ibripedia-card-menu-dropdown').forEach((dd) => {
          if (!dd.hidden && !dd.parentElement.contains(e.target)) dd.hidden = true;
        });
        if (this._bmHoverCapable && this.bookmarkPopoverEl && !this.bookmarkPopoverEl.hidden && !this.bookmarkPopoverEl.contains(e.target) && !e.target.closest('.ibripedia-bm-toggle, .ibripedia-bm-tab')) {
          this.closeBookmarkPopover();
        }
        // Пикеры стикеров (форма комментария/ответа И полоска реакций — один
        // и тот же компонент, см. STICKER_PICKER_MARKUP) — общий обработчик.
        // Триггер: у "отвязанных" (см. openReactionPicker) — прямая ссылка
        // pickerEl._triggerEl (они лежат в document.body, у их родителя
        // искать нечего); у встроенных в форму — сосед по [data-sticker-
        // picker-trigger], как раньше.
        // e.composedPath(), а не только picker.contains(e.target) — клик по
        // вкладке набора (см. renderStickerPicker) синхронно заменяет
        // tabsEl.innerHTML ДО того, как этот клик долетит по всплытию сюда:
        // сам кликнутый <button> к этому моменту уже отсоединён от DOM
        // (отрисован заново), и picker.contains(e.target) на отсоединённом
        // узле всегда false — пикер закрывался бы сам на себе при каждом
        // переключении вкладки. composedPath() — снимок пути на момент
        // диспатча, до всех этих мутаций, поэтому не подвержен ошибке.
        document.querySelectorAll('.ibripedia-sticker-picker').forEach((picker) => {
          if (picker.hidden) return;
          const trigger = picker._triggerEl || picker.parentElement?.querySelector('[data-sticker-picker-trigger]');
          const path = e.composedPath ? e.composedPath() : [];
          const insidePicker = path.includes(picker) || picker.contains(e.target);
          const onTrigger = e.target === trigger || trigger?.contains(e.target) || (trigger && path.includes(trigger));
          if (!insidePicker && !onTrigger) {
            if (picker.dataset.detached) picker.remove(); else picker.hidden = true;
            trigger?.classList.remove('active');
          }
        });
      };
      document.addEventListener('click', this._docClickHandler);

      // Клавиатуру у поля ввода мы теперь стараемся не закрывать, пока
      // открыт пикер стикеров (см. preventDefault на mousedown в
      // wireComposer/renderStickerPicker/wireStickerPickerGestures), но если
      // она всё же откроется/закроется сама (например, пользователь скрыл
      // её системной кнопкой) или экран повернётся — пересчитываем позицию
      // и высоту попапа под актуальную видимую область (см.
      // positionStickerPicker — использует window.visualViewport).
      if (window.visualViewport && !this._vvResizeHandlerBound) {
        this._vvResizeHandlerBound = true;
        window.visualViewport.addEventListener('resize', () => {
          const openPicker = document.querySelector('.ibripedia-sticker-picker:not([hidden])');
          if (openPicker && openPicker._triggerEl) positionStickerPicker(openPicker, openPicker._triggerEl);
        });
      }
    }

    // Кнопка "Фильтры" видна только на телефоне (см. ibripedia.css) — на
    // планшете/десктопе панель всегда показана независимо от this.filtersOpen.
    // Начальное состояние — открыто везде, кроме телефона; дальше человек
    // сам решает кликом по кнопке. Проверяем ширину только при заходе на
    // страницу — при последующем ресайзе окна ничего не трогаем (мог сам
    // раскрыть/свернуть, не хотим спорить с этим выбором).
    initFiltersCollapse() {
      if (!this.filtersToggleBtn || !this.filtersPanelEl) return;
      this.filtersOpen = !window.matchMedia('(max-width: 640px)').matches;
      this.applyFiltersOpenState();
      this.filtersToggleBtn.addEventListener('click', () => {
        this.filtersOpen = !this.filtersOpen;
        this.applyFiltersOpenState();
      });
    }

    applyFiltersOpenState() {
      this.filtersPanelEl.classList.toggle('is-open', this.filtersOpen);
      this.filtersToggleBtn.classList.toggle('is-open', this.filtersOpen);
      this.filtersToggleBtn.setAttribute('aria-expanded', String(this.filtersOpen));
    }

    // Счётчик на кнопке "Фильтры · N" — сколько ПОЛЕЙ фильтра сейчас
    // непустые (не считая поисковую строку и сортировку — они не в этой
    // сворачиваемой панели). Диапазон дат — одно логическое поле, даже если
    // заполнены обе границы.
    updateFiltersCount() {
      if (!this.filtersCountEl) return;
      const f = this.getFilters();
      let n = 0;
      if (f.tag.length) n++;
      if (f.server) n++;
      if (f.locked) n++;
      if (f.dateFrom || f.dateTo) n++;
      this.filtersCountEl.hidden = n === 0;
      this.filtersCountEl.textContent = String(n);
    }

    resetFilters() {
      this.tagField?.setValues([]);
      if (this.serverFilterEl) this.serverFilterEl.value = '';
      if (this.statusFilterEl) this.statusFilterEl.value = '';
      if (this.dateFromEl) this.dateFromEl.value = '';
      if (this.dateToEl) this.dateToEl.value = '';
      if (this.sortEl) this.sortEl.value = 'newest';
      if (this.searchEl) this.searchEl.value = '';
      this.resetAndLoad();
    }

    setViewMode(mode) {
      this.viewMode = mode === 'list' ? 'list' : 'grid';
      try { localStorage.setItem('ibripediaViewMode', this.viewMode); } catch (e) { /* приватный режим и т.п. — просто не запомнится */ }
      this.applyViewMode();
    }

    applyViewMode() {
      document.querySelectorAll('.ibripedia-view-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === this.viewMode);
      });
      this.gridEl?.classList.toggle('ibripedia-grid--list', this.viewMode === 'list');
    }

    getFilters() {
      return {
        q: this.searchEl?.value.trim() || '',
        tag: this.tagField?.getValues() || [],
        server: this.serverFilterEl?.value || '',
        locked: this.statusFilterEl?.value || '',
        dateFrom: this.dateFromEl?.value || '',
        dateTo: this.dateToEl?.value || '',
        sort: this.sortEl?.value || 'newest'
      };
    }

    async resetAndLoad() {
      this.updateFiltersCount();
      this.offset = 0;
      this.hasMore = true;
      this.total = 0;
      if (this.gridEl) this.gridEl.innerHTML = '';
      if (this.emptyEl) this.emptyEl.hidden = true;
      this.renderSkeletons();
      await this.loadMore();
    }

    renderSkeletons() {
      for (let i = 0; i < 6; i++) {
        const el = document.createElement('div');
        el.className = 'ibripedia-skeleton-card ibripedia-skeleton-placeholder';
        this.gridEl.appendChild(el);
      }
    }

    clearSkeletons() {
      this.gridEl.querySelectorAll('.ibripedia-skeleton-placeholder').forEach((el) => el.remove());
    }

    async loadMore() {
      if (this.loading || !this.hasMore || !this.gridEl) return;
      this.loading = true;
      if (this.offset > 0 && this.loadingMoreEl) this.loadingMoreEl.hidden = false;

      try {
        const result = await window.apiClient.getArticlesBrowse(this.getFilters(), PAGE_SIZE, this.offset);
        this.clearSkeletons();

        if (!result.success) {
          showMessage(`Ошибка загрузки статей: ${result.data?.error || result.error || ''}`, 'error');
          this.hasMore = false;
          return;
        }

        const payload = result.data || {};
        const articles = Array.isArray(payload.data) ? payload.data : [];
        this.total = payload.total || 0;

        articles.forEach((a) => this.gridEl.appendChild(this.buildCard(a)));
        this.offset += articles.length;
        this.hasMore = articles.length > 0 && this.offset < this.total;

        this.renderCount();
        if (this.emptyEl) this.emptyEl.hidden = this.total > 0;
      } catch (e) {
        this.clearSkeletons();
        showMessage('Неожиданная ошибка при загрузке статей', 'error');
        this.hasMore = false;
      } finally {
        this.loading = false;
        if (this.loadingMoreEl) this.loadingMoreEl.hidden = true;
      }
    }

    renderCount() {
      if (!this.countEl) return;
      const shown = this.gridEl.querySelectorAll('.ibripedia-card').length;
      this.countEl.textContent = this.total > 0 ? `Показано ${shown} из ${this.total}` : '';
    }

    setupInfiniteScroll() {
      if (!this.sentinelEl || !('IntersectionObserver' in window)) return;
      this._observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) this.loadMore();
      }, { rootMargin: '400px' });
      this._observer.observe(this.sentinelEl);
    }

    buildCard(article) {
      const el = document.createElement('article');
      el.className = 'ibripedia-card';
      el.dataset.slug = article.slug || article.id;

      const tags = article.tags || [];
      const authorName = article.author ? article.author.display_name : 'Не указан';

      el.innerHTML = `
        ${article.image
          ? `<div class="ibripedia-card-cover"><img src="${escapeHtml(article.image)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('ibripedia-card-cover-empty');this.remove()"></div>`
          : `<div class="ibripedia-card-cover ibripedia-card-cover-empty"><i class="fas fa-file-alt"></i></div>`}
        ${article.locked ? `<div class="ibripedia-card-lock" title="Закрытая статья"><i class="fas fa-lock"></i></div>` : ''}
        ${article.can_edit || article.can_delete ? `<div class="ibripedia-card-menu">
          <button type="button" class="ibripedia-card-menu-btn" title="Действия">&#8942;</button>
          <div class="ibripedia-card-menu-dropdown" hidden>
            ${article.can_edit ? `<button type="button" data-action="edit"><i class="fas fa-pen"></i> Редактировать</button>` : ''}
            ${article.can_delete ? `<button type="button" data-action="delete" class="ibripedia-danger"><i class="fas fa-trash"></i> Удалить</button>` : ''}
          </div>
        </div>` : ''}
        <div class="ibripedia-card-body">
          <h3 class="ibripedia-card-title">${escapeHtml(article.title)}</h3>
          <p class="ibripedia-card-excerpt">${escapeHtml(makeExcerpt(article, this.articlesIndexBySlug))}</p>
          ${tags.length ? `<div class="ibripedia-card-tags">${tags.map((t) =>
            `<span class="ibripedia-tag-pill" data-action="filter-tag" data-value="${escapeHtml(t)}">#${escapeHtml(t)}</span>`
          ).join('')}</div>` : ''}
          <div class="ibripedia-card-meta">
            <span${article.author && article.author.id ? ` data-action="open-profile" data-value="${article.author.id}" style="cursor:pointer" title="Открыть профиль"` : ''}><i class="fas fa-user"></i> ${escapeHtml(authorName)}</span>
            <span><i class="fas fa-calendar"></i> ${formatDate(article.created_at)}</span>
          </div>
          <!-- Тот же язык "пилюль", что и панель лайка/комментариев внутри
               открытой статьи (см. .ibripedia-engagement-btn) — на карточке
               витрины раньше это были голые мелкие иконки вперемешку с
               автором/датой, визуально терялись. -->
          <div class="ibripedia-card-engagement">
            <span class="ibripedia-card-pill" title="Просмотров"><i class="fas fa-eye"></i> ${article.viewsCount ?? article.views ?? 0}</span>
            <button type="button" class="ibripedia-card-pill${article.liked ? ' is-liked' : ''}" data-action="toggle-like" title="Нравится">
              <i class="${article.liked ? 'fas' : 'far'} fa-heart"></i> <span class="ibripedia-card-pill-count">${article.likesCount || 0}</span>
            </button>
            <!-- Реакции эмодзи/стикером — сразу рядом с лайком (тот же
                 компонент, что и под открытой статьёй, см.
                 reactionsBarInnerHtml()/handleReactionsClick() выше): лайк
                 ведь тоже своего рода реакция, комментарии между ними не
                 нужны. -->
            <div class="ibripedia-reactions" data-target-type="article" data-target-id="${escapeHtml(article.slug || article.id)}">${reactionsBarInnerHtml(article.reactions)}</div>
            <button type="button" class="ibripedia-card-pill" data-action="goto-comments" title="Перейти к комментариям">
              <i class="far fa-comment"></i> <span class="ibripedia-card-pill-count">${article.commentsCount || 0}</span>
            </button>
          </div>
        </div>
      `;
      return el;
    }

    handleGridClick(e) {
      const menuBtn = e.target.closest('.ibripedia-card-menu-btn');
      if (menuBtn) {
        e.stopPropagation();
        const dropdown = menuBtn.nextElementSibling;
        document.querySelectorAll('.ibripedia-card-menu-dropdown').forEach((dd) => { if (dd !== dropdown) dd.hidden = true; });
        dropdown.hidden = !dropdown.hidden;
        return;
      }

      const card = e.target.closest('.ibripedia-card');
      if (!card) return;
      const slug = card.dataset.slug;

      // Реакции эмодзи/стикером прямо на карточке (пилюля/кнопка "+"/уже
      // открытый пикер стикеров внутри — см. handleReactionsClick,
      // переиспользуется тот же обработчик, что и внутри статьи) — клик
      // здесь не должен открывать статью, поэтому проверяем ДО общего
      // fallthrough в конец метода.
      if (e.target.closest('.ibripedia-reactions')) {
        this.handleReactionsClick(e);
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.getAttribute('data-action');
        if (action === 'edit') { this.editArticleBySlug(slug); return; }
        if (action === 'delete') { this.deleteArticle(slug); return; }
        if (action === 'filter-tag') { this.filterByTag(actionBtn.getAttribute('data-value')); return; }
        if (action === 'open-profile') { window.spaRouter?.navigateTo(`/profile/${actionBtn.getAttribute('data-value')}`); return; }
        if (action === 'toggle-like') { this.toggleCardLike(actionBtn, slug); return; }
        if (action === 'goto-comments') { this.openArticleView(slug, { jumpToComments: true }); return; }
        return;
      }

      this.openArticleView(slug);
    }

    filterByTag(name) { this.tagField?.addValue(name); }

    // Лайк прямо с карточки витрины — без открытия статьи (см. кнопку
    // .ibripedia-card-pill[data-action="toggle-like"] в buildCard).
    // Обновляет только эту карточку, не весь список.
    async toggleCardLike(btn, slug) {
      if (!slug || btn.disabled) return;
      btn.disabled = true;
      try {
        const result = await window.apiClient.toggleArticleLike(slug);
        if (result.success) {
          const liked = !!result.data.liked;
          btn.classList.toggle('is-liked', liked);
          const icon = btn.querySelector('i');
          if (icon) icon.className = liked ? 'fas fa-heart' : 'far fa-heart';
          const countEl = btn.querySelector('.ibripedia-card-pill-count');
          if (countEl) countEl.textContent = String(result.data.count || 0);
        } else {
          showMessage(`Не удалось поставить лайк: ${result.data?.error || result.error || ''}`, 'error');
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при попытке поставить лайк', 'error');
      } finally {
        btn.disabled = false;
      }
    }

    async editArticleBySlug(slug) {
      if (!slug) return;
      await window.spaRouter?.navigateTo('/articles');
      window.spaRouter?.editArticle(slug);
    }

    // Открывает редактор с уже вписанным заголовком — для "создать статью"
    // по клику на несуществующую wiki-ссылку (см. handleViewContentClick).
    async createArticleWithTitle(title) {
      await window.spaRouter?.navigateTo('/articles');
      const titleInput = document.getElementById('articleTitle');
      if (titleInput) titleInput.value = title;
    }

    editCurrentArticle() {
      if (this.currentSlug) this.editArticleBySlug(this.currentSlug);
    }

    async deleteArticle(slug) {
      if (!slug) return;
      document.querySelectorAll('.ibripedia-card-menu-dropdown').forEach((dd) => dd.hidden = true);
      if (!confirm('Вы уверены, что хотите удалить эту статью?')) return;

      try {
        const result = await window.apiClient.deleteArticle(slug);
        if (result.success) {
          showMessage('Статья успешно удалена!', 'success');
          if (this.currentSlug === slug) this.closeArticleView();
          await this.resetAndLoad();
        } else {
          showMessage(`Ошибка удаления статьи: ${result.error}`, 'error');
        }
      } catch (e) {
        showMessage('Ошибка при удалении статьи', 'error');
      }
    }

    // "Случайная статья" — учитывает текущие фильтры (this.total — от
    // последней загруженной страницы с теми же фильтрами), поэтому кнопка
    // предлагает случайную статью ИЗ уже отфильтрованной подборки.
    async openRandomArticle() {
      if (!this.total) {
        showMessage('Нет статей, подходящих под текущие фильтры', 'info');
        return;
      }
      const offset = Math.floor(Math.random() * this.total);
      try {
        const result = await window.apiClient.getArticlesBrowse(this.getFilters(), 1, offset);
        const article = result.success && result.data?.data?.[0];
        if (article) {
          this.openArticleView(article.slug || article.id);
        } else {
          showMessage('Не удалось найти случайную статью', 'error');
        }
      } catch (e) {
        showMessage('Не удалось найти случайную статью', 'error');
      }
    }

    async openArticleView(slug, { jumpToComments = false, layer } = {}) {
      if (!slug) return;
      try {
        const result = await window.apiClient.getArticle(slug, layer != null ? { layer } : undefined);
        if (!result.success) {
          showMessage(`Не удалось открыть статью: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        const article = result.data;
        this.currentSlug = article.slug || article.id;
        this.resetEngagementUI();

        // Кнопки прав приходят с сервера (can_edit/can_delete, см.
        // getArticlePermissions в articles.routes.js) — нет права, нет кнопки.
        const editBtn = document.getElementById('ibripediaEditBtn');
        const deleteBtn = document.getElementById('ibripediaDeleteBtn');
        if (editBtn) editBtn.hidden = !article.can_edit;
        if (deleteBtn) deleteBtn.hidden = !article.can_delete;
        const actionsEl = document.querySelector('.ibripedia-view-actions');
        if (actionsEl) actionsEl.hidden = !article.can_edit && !article.can_delete;

        await this.renderArticleView(article);
        this.resetInlineSearchUI();
        this.buildToc();
        this.switchSidebarTab('toc');
        this.closeSidebarOnMobile();

        if (!this.browseEl.hidden) this._libraryScrollY = window.scrollY;
        this.browseEl.hidden = true;
        this.viewEl.hidden = false;
        window.scrollTo(0, 0);
        this.renderBookmarkGutter();

        await this.renderBacklinksView(this.currentSlug);
        await this.loadArticleBookmarks();
        await this.loadEngagement();
        // Не await — засчитать просмотр не должно задерживать открытие
        // статьи, а сбой тут не критичен (см. recordArticleView() ниже).
        this.recordArticleView(this.currentSlug);

        // Клик по значку комментария на карточке витрины (см.
        // handleGridClick/buildCard) — статья уже открыта, докручиваем до
        // комментариев в самом низу, как и по клику на значок внутри статьи.
        if (jumpToComments) this.scrollToComments();
      } catch (e) {
        showMessage('Неожиданная ошибка при открытии статьи', 'error');
      }
    }

    // Реальная статистика просмотров — один просмотр на пользователя (см.
    // src/services/social-store.js), засчитывается отдельным запросом
    // ПОСЛЕ открытия статьи (не блокирует показ), а не при каждом GET
    // статьи — иначе открытие в редакторе тоже накручивало бы счётчик.
    // Обновляем счётчик на экране только если статья с тех пор не сменилась
    // (пользователь мог успеть открыть другую, пока запрос летел).
    async recordArticleView(slug) {
      try {
        const result = await window.apiClient.recordArticleView(slug);
        if (result.success && this.currentSlug === slug) {
          const viewsEl = document.getElementById('ibripediaViewViewsCount');
          if (viewsEl) viewsEl.textContent = String(result.data.viewsCount ?? 0);
        }
      } catch (e) {
        // Не критично — статья и так уже открыта и видна.
      }
    }

    async renderArticleView(article) {
      const coverEl = document.getElementById('ibripediaViewCover');
      const coverImg = document.getElementById('ibripediaViewCoverImg');
      if (article.image && coverEl && coverImg) {
        coverImg.src = article.image;
        coverEl.hidden = false;
      } else if (coverEl) {
        coverEl.hidden = true;
      }

      const titleEl = document.getElementById('ibripediaViewTitle');
      if (titleEl) titleEl.textContent = article.title;

      const authorName = article.author ? article.author.display_name : 'Не указан';
      const coAuthors = (article.co_authors || []).map((c) => c.display_name);
      const metaParts = [
        `<span${article.author && article.author.id ? ` data-action="open-profile" data-value="${article.author.id}" style="cursor:pointer" title="Открыть профиль"` : ''}><i class="fas fa-user"></i> ${escapeHtml(authorName)}${coAuthors.length ? ' + ' + escapeHtml(coAuthors.join(', ')) : ''}</span>`,
        `<span><i class="fas fa-calendar"></i> ${formatDate(article.created_at)}</span>`,
        `<span><i class="fas fa-eye"></i> <span id="ibripediaViewViewsCount">${article.viewsCount ?? 0}</span> просмотров</span>`
      ];
      if (article.server) metaParts.push(`<span><i class="fas fa-server"></i> ${escapeHtml(article.server)}</span>`);
      const metaEl = document.getElementById('ibripediaViewMeta');
      if (metaEl) metaEl.innerHTML = metaParts.join('');

      const badges = [];
      if (article.locked) badges.push('<span class="ibripedia-badge" style="background:var(--yellow-hover)"><i class="fas fa-lock"></i> Закрытая</span>');
      const badgesEl = document.getElementById('ibripediaViewBadges');
      if (badgesEl) badgesEl.innerHTML = badges.join('');

      this.renderLayerSwitcher(article);

      const contentEl = document.getElementById('ibripediaViewContent');
      if (!contentEl) return;
      if (window.renderArticleBlocks) {
        contentEl.innerHTML = await window.renderArticleBlocks(article.content, this.articlesIndexBySlug, this.restrictedSlugs);
        window.attachBlocksInteractions?.(contentEl);
      } else {
        contentEl.textContent = '';
      }
      // Хвостики закладок не строим здесь — .ibripedia-view ещё hidden
      // (viewEl.hidden снимается позже в openArticleView), у скрытых
      // элементов getBoundingClientRect() нулевой, координаты были бы
      // неверными. Строятся после показа секции — см. openArticleView.

      // Картинки грузятся асинхронно и могут сдвинуть блоки ниже себя по
      // высоте уже ПОСЛЕ первого расчёта позиций хвостиков — пересчитываем,
      // когда догрузятся.
      contentEl.querySelectorAll('img').forEach((img) => {
        if (!img.complete) img.addEventListener('load', () => this.scheduleBookmarkGutterRefresh(), { once: true });
      });
    }

    // Переключатель слоя многослойной статьи (см. обсуждение "многослойные
    // статьи", пункт D): показывается только когда читателю доступно больше
    // одного слоя (layerOptions приходят уже отфильтрованными сервером —
    // только те, до которых читатель "дотягивается", каскадом вниз от его
    // максимума). Достигнув верхнего слоя, читатель может свободно смотреть
    // и любой более нижний — сама кнопка просто перезапрашивает статью с
    // ?layer=N, сервер сам не пустит выше положенного.
    renderLayerSwitcher(article) {
      const el = document.getElementById('ibripediaViewLayerSwitcher');
      if (!el) return;
      const options = Array.isArray(article.layerOptions) ? article.layerOptions : [];
      if (options.length < 2) { el.hidden = true; el.innerHTML = ''; return; }

      el.hidden = false;
      el.innerHTML = `<i class="fas fa-layer-group" title="Слои статьи"></i>` + options.map((opt) => (
        `<button type="button" class="ibripedia-layer-btn${opt.index === article.layerIndex ? ' active' : ''}" data-layer-index="${opt.index}">${escapeHtml(opt.title)}</button>`
      )).join('');
    }

    async switchArticleLayer(index) {
      if (!this.currentSlug) return;
      try {
        const result = await window.apiClient.getArticle(this.currentSlug, { layer: index });
        if (!result.success) {
          showMessage('Не удалось переключить слой статьи', 'error');
          return;
        }
        await this.renderArticleView(result.data);
        this.buildToc();
        this.scheduleBookmarkGutterRefresh();
      } catch (e) {
        showMessage('Не удалось переключить слой статьи', 'error');
      }
    }

    handleViewContentClick(e) {
      const layerBtn = e.target.closest('.ibripedia-layer-btn');
      if (layerBtn) {
        e.preventDefault();
        this.switchArticleLayer(parseInt(layerBtn.dataset.layerIndex, 10));
        return;
      }

      const wikiEl = e.target.closest('.wiki-link, .wiki-link-missing, .wiki-link-restricted');
      if (wikiEl) {
        e.preventDefault();
        const slug = wikiEl.dataset.slug;
        if (wikiEl.classList.contains('wiki-link')) {
          this.openArticleView(slug);
        } else if (wikiEl.classList.contains('wiki-link-restricted')) {
          // Статья существует, но ни один её слой этому читателю не открыт —
          // ничего похожего на "создать новую?" здесь предлагать нельзя.
          showMessage('Эта статья недоступна вашей роли', 'info');
        } else {
          const article = this.articlesIndexBySlug.get(slug);
          const title = article ? article.title : wikiEl.textContent;
          if (confirm(`Статьи «${title}» ещё нет. Создать новую?`)) {
            this.createArticleWithTitle(title);
          }
        }
        return;
      }

      const tagEl = e.target.closest('.hashtag');
      if (tagEl) {
        e.preventDefault();
        this.closeArticleView();
        this.filterByTag(tagEl.dataset.tag);
      }
    }

    async renderBacklinksView(slug) {
      const panel = document.getElementById('ibripediaViewBacklinks');
      if (!panel) return;
      panel.hidden = false;
      panel.innerHTML = '<h3>Ссылки на эту статью</h3><div class="backlinks-empty">Загрузка…</div>';

      try {
        const result = await window.apiClient.makeAuthenticatedRequest(`/api/articles/${slug}/backlinks`);
        const backlinks = (result.success && Array.isArray(result.data)) ? result.data : [];
        panel.innerHTML = '<h3>Ссылки на эту статью</h3>' + (
          backlinks.length
            ? `<ul>${backlinks.map((b) => `<li><a href="javascript:void(0)" data-slug="${escapeHtml(b.slug)}">${escapeHtml(b.title)}</a></li>`).join('')}</ul>`
            : '<div class="backlinks-empty">Пока никто не сослался на эту статью через wiki-ссылку [текст]((статья))</div>'
        );
        panel.querySelectorAll('a[data-slug]').forEach((a) => {
          a.addEventListener('click', () => this.openArticleView(a.getAttribute('data-slug')));
        });
      } catch (e) {
        panel.innerHTML = '<h3>Ссылки на эту статью</h3><div class="backlinks-empty">Не удалось загрузить</div>';
      }
    }

    // ========================================
    // Лайк + комментарии под статьёй — панель ibripediaViewEngagement (счётчик
    // лайков + переход к комментариям) и секция ibripediaViewComments в самом
    // низу статьи (см. public/views/ibripedia.html). Комментарии — публичные
    // данные (видит любой, кому доступна сама статья), в отличие от закладок.
    // ========================================

    initEngagement() {
      this.likeBtn?.addEventListener('click', () => this.toggleLike());
      this.commentsBtn?.addEventListener('click', () => this.scrollToComments());
      this.reactionsBarEl?.addEventListener('click', (e) => this.handleReactionsClick(e));

      this.mainComposer = this.wireComposer(this.commentFormEl, {
        onSubmit: (content) => this.submitComment(content)
      });

      this.commentsListEl?.addEventListener('click', (e) => this.handleCommentsListClick(e));
    }

    resetEngagementUI() {
      this.currentLiked = false;
      this._commentsLoaded = false;
      this._activeReplyParentId = null;
      this._commentsById = new Map();
      this._expandedReplyThreads = new Set();
      if (this.likeCountEl) this.likeCountEl.textContent = '0';
      this.likeBtn?.classList.remove('is-active');
      const heartIcon = this.likeBtn?.querySelector('i');
      if (heartIcon) heartIcon.className = 'far fa-heart';
      if (this.commentsCountEl) this.commentsCountEl.textContent = '0';
      if (this.commentsHeaderCountEl) this.commentsHeaderCountEl.textContent = '';
      if (this.commentsListEl) this.commentsListEl.innerHTML = '';
      if (this.commentsEmptyEl) this.commentsEmptyEl.hidden = true;
      if (this.reactionsBarEl) this.reactionsBarEl.innerHTML = '';
      this.mainComposer?.clear();
      this.closeAllStickerPickers();
    }

    // ========================================
    // Compose — общая разметка+логика для основной формы комментария И для
    // формы "Ответить" (генерится динамически, см. toggleReplyComposer()):
    // rich-поле ввода (contenteditable, см. serializeRichInput() выше) +
    // кнопка "Стикеры" со своим пикером + кнопка отправки/отмены. Стикер
    // вставляется КАРТИНКОЙ прямо в поле (см. insertStickerChip) — задача
    // "видно сразу, без текста шорткода".
    // ========================================

    // rootEl — либо this.commentFormEl (реальный <form>, есть событие
    // submit), либо динамически созданный <div> формы ответа (тогда шлём по
    // клику на кнопку с data-role="submit"). Оба варианта используют один и
    // тот же набор классов/data-role, см. разметку в public/views/ibripedia.html
    // и toggleReplyComposer().
    wireComposer(rootEl, { onSubmit, onCancel }) {
      if (!rootEl) return null;
      const inputEl = rootEl.querySelector('.ibripedia-comment-input');
      const pickerBtn = rootEl.querySelector('.ibripedia-sticker-picker-btn');
      const pickerEl = rootEl.querySelector('.ibripedia-sticker-picker');
      const submitBtn = rootEl.querySelector('[data-role="submit"]');
      const cancelBtn = rootEl.querySelector('[data-role="cancel"]');
      const storeLink = rootEl.querySelector('[data-role="open-store"]');

      // Сохраняем позицию курсора на blur — после клика по кнопке пикера
      // фокус уходит с поля, но вставлять стикер нужно туда, где стоял
      // курсор до этого (см. getEditableRange()).
      inputEl.addEventListener('blur', () => {
        const sel = window.getSelection();
        if (sel.rangeCount && inputEl.contains(sel.anchorNode)) inputEl._savedRange = sel.getRangeAt(0).cloneRange();
      });
      // Убираем висящий <br>, который contenteditable оставляет после
      // удаления всего текста — иначе :empty (плейсхолдер) не сработает.
      inputEl.addEventListener('input', () => {
        if (!inputEl.textContent.trim() && !inputEl.querySelector('img')) inputEl.innerHTML = '';
      });

      // onSelect — что делает короткий клик по стикеру (или "Отправить" в
      // увеличенном превью, см. wireStickerPickerGestures) в ЭТОМ пикере:
      // здесь — вставить в поле комментария; у полоски реакций
      // (openReactionPicker) тот же параметр означает "поставить реакцию".
      //
      // На ПК пикер после вставки НЕ закрываем — можно подряд вставить
      // несколько стикеров без лишних открытий (см. requirement "сделать
      // много нажатий без лишних нажатий"). На телефоне — как раньше,
      // закрывается сразу: донный лист (см. позиционирование выше) и так
      // занимает изрядную часть экрана, задерживать его на месте после
      // явного выбора там скорее мешает, чем помогает.
      const onSelect = (shortcode, fileUrl) => {
        insertStickerChip(inputEl, shortcode, fileUrl);
        if (isMobilePickerLayout()) {
          pickerEl.hidden = true;
          pickerBtn?.classList.remove('active');
        }
      };

      // preventDefault на mousedown (НЕ touchstart — это заблокировало бы
      // сам клик на тач-устройствах, см. комментарий у wireStickerPickerGestures)
      // — открытие пикера иначе снимает фокус с поля ввода и на мобильном
      // прячет клавиатуру: место под ней остаётся пустым до следующего
      // тапа по полю (см. requirement "клавиатура пропадает").
      pickerBtn?.addEventListener('mousedown', (e) => e.preventDefault());
      pickerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = pickerEl.hidden;
        this.closeAllStickerPickers();
        if (willOpen) this.openStickerPickerPanel(pickerEl, pickerBtn, onSelect);
      });

      storeLink?.addEventListener('click', (e) => {
        e.preventDefault();
        pickerEl.hidden = true;
        pickerBtn?.classList.remove('active');
        window.stickerStore?.open(() => this.refreshOpenStickerPickers());
      });

      const doSubmit = async () => {
        const content = serializeRichInput(inputEl);
        if (!content) return;
        if (submitBtn) submitBtn.disabled = true;
        try {
          await onSubmit(content);
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };

      if (rootEl.tagName === 'FORM') {
        rootEl.addEventListener('submit', (e) => { e.preventDefault(); doSubmit(); });
      } else {
        submitBtn?.addEventListener('click', doSubmit);
      }
      cancelBtn?.addEventListener('click', () => onCancel && onCancel());

      return {
        inputEl,
        clear: () => { inputEl.innerHTML = ''; },
        focus: () => inputEl.focus()
      };
    }

    // Наполняется наборами, добавленными себе ("Добавить себе" — теперь и во
    // вкладке "Стикеры" админ-панели, и в "Магазине наборов" из самого
    // пикера, см. ссылку data-role="open-store"), и избранными стикерами —
    // оба списка кэшируются на время открытой статьи (см.
    // refreshOpenStickerPickers()). onSelect — что делает выбор стикера
    // (короткий клик ИЛИ "Отправить" в увеличенном превью) в ЭТОМ пикере:
    // разный для формы комментария (вставить) и полоски реакций (поставить
    // реакцию) — см. wireComposer()/openReactionPicker().
    async openStickerPickerPanel(pickerEl, pickerBtn, onSelect) {
      pickerEl.hidden = false;
      pickerEl._triggerEl = pickerBtn; // для перепозиционирования при смене вкладки и для click-outside (см. ниже)
      pickerEl._onSelect = onSelect; // для toggleStickerFavoriteFromPreview — перерисовать открытый пикер без повторной передачи колбэка
      pickerBtn?.classList.add('active');
      if (pickerBtn) positionStickerPicker(pickerEl, pickerBtn);
      this.wireStickerPickerGestures(pickerEl, onSelect);

      if (this._subscribedStickerPacks && this._favoriteStickers) {
        this.renderStickerPicker(pickerEl, onSelect);
        if (pickerBtn) positionStickerPicker(pickerEl, pickerBtn);
        return;
      }

      pickerEl.querySelector('.ibripedia-sticker-picker-body').innerHTML = `<div class="ibripedia-sticker-picker-empty">Загрузка…</div>`;
      await this.loadStickerPickerData();
      this.renderStickerPicker(pickerEl, onSelect);
      // Реальная высота стала известна только после наполнения — пересчитываем
      // позицию (иначе при показе "снизу вверх" короткий/длинный список
      // сдвинул бы верхний край мимо расчёта, сделанного для пустого попапа).
      if (pickerBtn) positionStickerPicker(pickerEl, pickerBtn);
    }

    async loadStickerPickerData() {
      try {
        const [packsResult, favResult] = await Promise.all([
          window.apiClient.getSubscribedStickerPacks(),
          window.apiClient.getFavoriteStickers()
        ]);
        this._subscribedStickerPacks = packsResult.success ? (packsResult.data || []) : [];
        this._favoriteStickers = favResult.success ? (favResult.data || []) : [];
      } catch (e) {
        this._subscribedStickerPacks = this._subscribedStickerPacks || [];
        this._favoriteStickers = this._favoriteStickers || [];
      }
      this._favoriteStickerIds = new Set(this._favoriteStickers.map((s) => String(s.id)));
    }

    // Лента вкладок сверху (звёздочка избранного + один таб на набор, превью —
    // первый стикер набора) плюс сетка стикеров АКТИВНОЙ вкладки — аналог VK
    // (см. requirement). Активная вкладка запоминается между открытиями
    // (this._activeStickerTab), пока сам набор/избранное ещё существует.
    renderStickerPicker(pickerEl, onSelect) {
      const tabsEl = pickerEl.querySelector('.ibripedia-sticker-picker-tabs');
      const subtitleEl = pickerEl.querySelector('.ibripedia-sticker-picker-subtitle');
      const bodyEl = pickerEl.querySelector('.ibripedia-sticker-picker-body');
      const packs = (this._subscribedStickerPacks || []).filter((p) => (p.stickers || []).length);
      const favorites = this._favoriteStickers || [];

      if (!packs.length) {
        tabsEl.innerHTML = '';
        subtitleEl.textContent = '';
        bodyEl.innerHTML = `<div class="ibripedia-sticker-picker-empty">Нет добавленных наборов стикеров. Откройте «Магазин наборов», чтобы добавить себе одобренный набор.</div>`;
        return;
      }

      const validTabs = new Set(['favorites', ...packs.map((p) => p.slug)]);
      if (!this._activeStickerTab || !validTabs.has(this._activeStickerTab)) {
        this._activeStickerTab = favorites.length ? 'favorites' : packs[0].slug;
      }

      tabsEl.innerHTML = `
        <button type="button" class="ibripedia-sticker-picker-tab ibripedia-sticker-picker-tab-fav${this._activeStickerTab === 'favorites' ? ' active' : ''}" data-tab="favorites" title="Избранное">
          <i class="fas fa-star"></i>
        </button>
        ${packs.map((p) => `
          <button type="button" class="ibripedia-sticker-picker-tab${this._activeStickerTab === p.slug ? ' active' : ''}" data-tab="${escapeHtml(p.slug)}" title="${escapeHtml(p.title)}${p.description ? ' — ' + escapeHtml(p.description) : ''}">
            <img src="${escapeHtml(p.stickers[0].fileUrl)}" alt="">
          </button>
        `).join('')}
      `;
      tabsEl.querySelectorAll('[data-tab]').forEach((tabBtn) => {
        // См. комментарий у pickerBtn в wireComposer — то же самое: клик по
        // вкладке не должен снимать фокус с поля ввода/прятать клавиатуру.
        tabBtn.addEventListener('mousedown', (e) => e.preventDefault());
        tabBtn.addEventListener('click', () => {
          this._activeStickerTab = tabBtn.dataset.tab;
          this.renderStickerPicker(pickerEl, onSelect);
          if (pickerEl._triggerEl) positionStickerPicker(pickerEl, pickerEl._triggerEl);
        });
      });

      if (this._activeStickerTab === 'favorites') {
        subtitleEl.textContent = favorites.length ? 'Избранное' : '';
        bodyEl.innerHTML = favorites.length
          ? `<div class="ibripedia-sticker-picker-grid">${favorites.map((s) => this.renderStickerPickerItem(s.packSlug, s)).join('')}</div>`
          : `<div class="ibripedia-sticker-picker-empty">Пока нет избранных стикеров — зажмите стикер в любом наборе, чтобы добавить.</div>`;
      } else {
        const pack = packs.find((p) => p.slug === this._activeStickerTab);
        subtitleEl.textContent = pack ? (pack.description ? `${pack.title} — ${pack.description}` : pack.title) : '';
        bodyEl.innerHTML = pack
          ? `<div class="ibripedia-sticker-picker-grid">${pack.stickers.map((s) => this.renderStickerPickerItem(pack.slug, s)).join('')}</div>`
          : '';
      }
    }

    renderStickerPickerItem(packSlug, s) {
      const isFav = this._favoriteStickerIds && this._favoriteStickerIds.has(String(s.id));
      return `
        <button type="button" class="ibripedia-sticker-picker-item${isFav ? ' is-favorite' : ''}" data-shortcode=":${packSlug}:${s.alias}:" data-file-url="${escapeHtml(s.fileUrl)}" data-sticker-id="${s.id}" title="${escapeHtml(s.alias)}">
          <img src="${escapeHtml(s.fileUrl)}" alt="${escapeHtml(s.alias)}">
        </button>`;
    }

    // Короткий клик/тап — как раньше, сразу onSelect; зажатие (mousedown/
    // touchstart дольше STICKER_LONG_PRESS_MS без отпускания) — открывает
    // увеличенное превью (аналог VK, см. openStickerPreviewOverlay), а
    // последующий click (mouseup после долгого зажатия тоже его генерит)
    // подавляется suppressClick — иначе стикер сразу вставился бы/стал
    // реакцией ВМЕСТО открытия превью. Вешаем один раз на весь срок жизни
    // pickerEl (dataset-флаг) — тело перерисовывается (смена вкладки)
    // через innerHTML, но сам bodyEl как узел не пересоздаётся, так что
    // делегированный обработчик переживает любые перерисовки.
    wireStickerPickerGestures(pickerEl, onSelect) {
      const bodyEl = pickerEl.querySelector('.ibripedia-sticker-picker-body');
      if (!bodyEl || bodyEl.dataset.gesturesWired) return;
      bodyEl.dataset.gesturesWired = '1';

      let timer = null;
      let suppressClick = false;
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

      bodyEl.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.ibripedia-sticker-picker-item');
        if (!item) return;
        // См. комментарий у pickerBtn в wireComposer — иначе выбор стикера
        // (даже коротким тапом) снимает фокус с поля ввода и на мобильном
        // прячет клавиатуру. Только mousedown (не touchstart) — touchstart
        // с preventDefault подавил бы и сам синтетический click на тач.
        e.preventDefault();
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 400);
          this.openStickerPreviewOverlay(item, onSelect);
        }, STICKER_LONG_PRESS_MS);
      });
      bodyEl.addEventListener('touchstart', (e) => {
        const item = e.target.closest('.ibripedia-sticker-picker-item');
        if (!item) return;
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 400);
          this.openStickerPreviewOverlay(item, onSelect);
        }, STICKER_LONG_PRESS_MS);
      }, { passive: true });
      ['mouseup', 'mouseleave', 'touchend', 'touchcancel', 'touchmove'].forEach((evt) => {
        bodyEl.addEventListener(evt, clearTimer);
      });

      bodyEl.addEventListener('click', (e) => {
        if (suppressClick) { suppressClick = false; return; }
        const item = e.target.closest('[data-shortcode]');
        if (!item) return;
        onSelect(item.dataset.shortcode, item.dataset.fileUrl, item.dataset.stickerId);
      });
    }

    // Увеличенное превью по долгому нажатию — одна и та же плашка на весь
    // сайт (лениво создаётся при первом использовании), а не по одной на
    // каждый пикер: одновременно открыт максимум один пикер, поэтому и
    // превью не может понадобиться больше одного разом.
    ensureStickerPreviewOverlay() {
      if (this._stickerPreviewEls) return this._stickerPreviewEls;
      const overlay = document.createElement('div');
      overlay.className = 'ibripedia-sticker-preview-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="ibripedia-sticker-preview-box">
          <button type="button" class="modal-close ibripedia-sticker-preview-close">&times;</button>
          <img class="ibripedia-sticker-preview-img" src="" alt="">
          <div class="ibripedia-sticker-preview-actions">
            <button type="button" class="btn btn-secondary ibripedia-sticker-preview-fav"><i class="far fa-star"></i> <span>В избранное</span></button>
            <button type="button" class="btn btn-primary" data-role="send">Отправить</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      // Клик по пустому месту (по подложке) — ничего не закрывает, ни само
      // превью, ни пикер под ним (см. requirement "нажатие в пустое место
      // не закрывает окно"); закрыть можно только явно — крестиком или
      // отправкой стикера. См. также исключение для .ibripedia-sticker-
      // preview-overlay в глобальном обработчике клика вне пикера (иначе ТОТ
      // обработчик закрыл бы пикер под превью, даже не трогая сам оверлей).
      overlay.querySelector('.ibripedia-sticker-preview-close').addEventListener('click', () => this.closeStickerPreviewOverlay());
      // См. комментарий у pickerBtn в wireComposer — кнопки превью тоже не
      // должны снимать фокус с поля ввода на мобильном.
      overlay.querySelectorAll('button').forEach((btn) => btn.addEventListener('mousedown', (e) => e.preventDefault()));
      this._stickerPreviewEls = {
        overlay,
        img: overlay.querySelector('.ibripedia-sticker-preview-img'),
        favBtn: overlay.querySelector('.ibripedia-sticker-preview-fav'),
        favIcon: overlay.querySelector('.ibripedia-sticker-preview-fav i'),
        favLabel: overlay.querySelector('.ibripedia-sticker-preview-fav span'),
        sendBtn: overlay.querySelector('[data-role="send"]')
      };
      return this._stickerPreviewEls;
    }

    openStickerPreviewOverlay(item, onSelect) {
      const els = this.ensureStickerPreviewOverlay();
      const { stickerId, shortcode, fileUrl } = item.dataset;

      els.img.src = fileUrl;
      els.img.alt = item.title || '';
      els.overlay.hidden = false;
      this.updateStickerPreviewFavButton(els, !!(this._favoriteStickerIds && this._favoriteStickerIds.has(String(stickerId))));

      els.sendBtn.onclick = () => {
        this.closeStickerPreviewOverlay();
        onSelect(shortcode, fileUrl, stickerId);
      };
      els.favBtn.onclick = () => this.toggleStickerFavoriteFromPreview(item, els);
    }

    updateStickerPreviewFavButton(els, isFav) {
      els.favBtn.classList.toggle('is-active', isFav);
      els.favIcon.className = isFav ? 'fas fa-star' : 'far fa-star';
      els.favLabel.textContent = isFav ? 'В избранном' : 'В избранное';
    }

    closeStickerPreviewOverlay() {
      if (this._stickerPreviewEls) this._stickerPreviewEls.overlay.hidden = true;
    }

    async toggleStickerFavoriteFromPreview(item, els) {
      const stickerId = item.dataset.stickerId;
      const isFav = !!(this._favoriteStickerIds && this._favoriteStickerIds.has(String(stickerId)));
      els.favBtn.disabled = true;
      try {
        if (isFav) {
          await window.apiClient.removeFavoriteSticker(stickerId);
        } else {
          const result = await window.apiClient.addFavoriteSticker(stickerId);
          if (!result.success) {
            showMessage(`Не удалось добавить в избранное: ${result.data?.error || result.error || ''}`, 'error');
            return;
          }
        }
        this.updateStickerPreviewFavButton(els, !isFav);

        // Кэш списка избранного протух — перечитываем (наборы не трогаем,
        // loadStickerPickerData всё равно перезапросит оба списка разом) и,
        // если пикер, из которого зажали этот стикер, всё ещё открыт,
        // перерисовываем его — чтобы звёздочка на самом стикере и вкладка
        // "Избранное" сразу отразили изменение, а не только кнопка в превью.
        this._favoriteStickers = null;
        this._favoriteStickerIds = null;
        await this.loadStickerPickerData();
        const openPicker = item.closest('.ibripedia-sticker-picker');
        if (openPicker && !openPicker.hidden) this.renderStickerPicker(openPicker, openPicker._onSelect);
      } catch (e) {
        showMessage('Неожиданная ошибка при изменении избранного', 'error');
      } finally {
        els.favBtn.disabled = false;
      }
    }

    closeAllStickerPickers() {
      // "Отвязанные" (data-detached, см. openReactionPicker) удаляются из
      // DOM целиком — они создаются заново на каждое открытие; встроенные в
      // форму комментария/ответа — просто прячутся (та же форма ещё
      // пригодится, пересоздавать её незачем).
      document.querySelectorAll('.ibripedia-sticker-picker').forEach((el) => {
        if (el.dataset.detached) el.remove(); else el.hidden = true;
      });
      document.querySelectorAll('[data-sticker-picker-trigger].active').forEach((btn) => btn.classList.remove('active'));
      this.closeStickerPreviewOverlay();
    }

    // После добавления/удаления набора в "Магазине наборов" (см.
    // public/sticker-store.js) кэш подписок и избранного протух —
    // перезагружаем и перерисовываем уже открытый пикер, если он есть.
    async refreshOpenStickerPickers() {
      this._subscribedStickerPacks = null;
      this._favoriteStickers = null;
      this._favoriteStickerIds = null;
      const openPicker = document.querySelector('.ibripedia-sticker-picker:not([hidden])');
      if (!openPicker) return;
      await this.loadStickerPickerData();
      this.renderStickerPicker(openPicker, openPicker._onSelect);
      if (openPicker._triggerEl) positionStickerPicker(openPicker, openPicker._triggerEl);
    }

    // ========================================
    // Реакции (эмодзи/стикером) — под статьёй (this.reactionsBarEl) и под
    // каждым комментарием/ответом (делегирование через commentsListEl, см.
    // handleCommentsListClick()). Разные шорткоды от одного пользователя на
    // одну цель сосуществуют (не взаимоисключающий выбор, как лайк) — см.
    // toggleReaction в social-store.js.
    // ========================================

    handleReactionsClick(e) {
      const addBtn = e.target.closest('.ibripedia-reaction-add');
      const pill = e.target.closest('.ibripedia-reaction-pill');
      if (!addBtn && !pill) return;
      const bar = e.target.closest('[data-target-type]');
      if (!bar) return;
      const targetType = bar.dataset.targetType;
      const targetId = bar.dataset.targetId;
      if (addBtn) this.openReactionPicker(addBtn, targetType, targetId);
      else if (pill) this.toggleReaction(targetType, targetId, pill.dataset.shortcode);
    }

    // Переиспользует ТОТ ЖЕ компонент пикера, что и форма комментария/ответа
    // (см. STICKER_PICKER_MARKUP/wireComposer выше), а не отдельную модалку.
    // В отличие от пикера формы (который живёт внутри самой формы), этот
    // ВСЕГДА создаётся заново и кладётся прямо в document.body, а при
    // закрытии удаляется из DOM целиком (см. closeAllStickerPickers) —
    // причины две: во-первых, полоска реакций на карточке витрины лежит
    // внутри .ibripedia-card, у которого есть transform при :hover — а
    // transform на предке делает ЕГО контейнером для position:fixed
    // потомков (см. CSS-спеку), тогда left/top считались бы от карточки, а
    // не от окна; во-вторых, .innerHTML полоски реакций целиком
    // перерисовывается при каждом тоггле (см. toggleReaction) — держать
    // живую ссылку на пикер как на ребёнка этой полоски было бы некуда.
    //
    // Клик по стикеру здесь не вставляет его в текст, а ставит реакцию —
    // поэтому шорткод берём БЕЗ обрамляющих двоеточий (":slug:alias:" →
    // "slug:alias"): именно в таком виде его ждёт canUseShortcode/
    // toggleReaction на сервере (см. getSubscribedAliasSet в
    // src/services/stickers-store.js) — в отличие от вставки в текст
    // комментария, где двоеточия — часть самого шорткода.
    async openReactionPicker(triggerEl, targetType, targetId) {
      // Повторный клик по уже открытому — просто закрыть, не пересоздавать.
      const alreadyOpen = triggerEl.classList.contains('active');
      this.closeAllStickerPickers();
      if (alreadyOpen) return;

      const wrapper = document.createElement('div');
      wrapper.innerHTML = STICKER_PICKER_MARKUP;
      const pickerEl = wrapper.firstElementChild;
      pickerEl.dataset.detached = '1';
      document.body.appendChild(pickerEl);

      // onSelect тут — "поставить реакцию" (а не вставить в текст, как у
      // wireComposer): shortcode приходит с обрамляющими двоеточиями
      // (":slug:alias:", формат data-shortcode у элемента стикера), toggleReaction
      // ждёт их без обрамления. На ПК пикер остаётся открытым после выбора —
      // как и у wireComposer, можно подряд поставить несколько реакций; на
      // телефоне закрывается сразу же (донный лист).
      const onSelect = (shortcode) => {
        const code = shortcode.replace(/^:+|:+$/g, '');
        if (isMobilePickerLayout()) this.closeAllStickerPickers();
        this.toggleReaction(targetType, targetId, code);
      };

      pickerEl.querySelector('[data-role="open-store"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeAllStickerPickers();
        window.stickerStore?.open(() => this.refreshOpenStickerPickers());
      });

      await this.openStickerPickerPanel(pickerEl, triggerEl, onSelect);
    }

    // targetId для статьи — её slug, а НЕ обязательно this.currentSlug: та
    // же реакция теперь ставится и с карточки на витрине (см. buildCard),
    // где никакая статья ещё не открыта, поэтому шлём и ищем строго по
    // targetId, а не по "текущей открытой" статье.
    async toggleReaction(targetType, targetId, shortcode) {
      try {
        const result = targetType === 'article'
          ? await window.apiClient.toggleArticleReaction(targetId, shortcode)
          : await window.apiClient.toggleCommentReaction(this.currentSlug, targetId, shortcode);
        if (!result.success) {
          showMessage(`Не удалось изменить реакцию: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        const reactions = result.data.reactions || [];
        if (targetType === 'article') {
          if (String(targetId) === String(this.currentSlug)) {
            this.currentReactions = reactions;
            if (this.reactionsBarEl) this.reactionsBarEl.innerHTML = reactionsBarInnerHtml(reactions);
          }
          // Карточка той же статьи на витрине (сетка/список) — если сейчас
          // видна именно она (а не открытая статья).
          const cardBar = this.gridEl?.querySelector(`.ibripedia-card[data-slug="${targetId}"] .ibripedia-reactions`);
          if (cardBar) cardBar.innerHTML = reactionsBarInnerHtml(reactions);
        } else {
          const comment = this._commentsById.get(Number(targetId));
          if (comment) comment.reactions = reactions;
          const bar = this.commentsListEl?.querySelector(`.ibripedia-reactions[data-target-type="comment"][data-target-id="${targetId}"]`);
          if (bar) bar.innerHTML = reactionsBarInnerHtml(reactions);
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при изменении реакции', 'error');
      }
    }

    // Лайки, комментарии и реакции статьи грузятся независимо друг от друга
    // (как закладки и обратные ссылки выше) — сбой одного не должен
    // блокировать другое.
    async loadEngagement() {
      await Promise.all([this.loadLikeSummary(), this.loadComments(), this.loadArticleReactions()]);
    }

    async loadArticleReactions() {
      if (!this.currentSlug || !this.reactionsBarEl) return;
      this.reactionsBarEl.dataset.targetId = this.currentSlug;
      try {
        const result = await window.apiClient.getArticleReactions(this.currentSlug);
        this.currentReactions = result.success ? (result.data.reactions || []) : [];
      } catch (e) {
        this.currentReactions = [];
      }
      this.reactionsBarEl.innerHTML = reactionsBarInnerHtml(this.currentReactions);
    }

    async loadLikeSummary() {
      if (!this.currentSlug) return;
      try {
        const result = await window.apiClient.getArticleLikes(this.currentSlug);
        if (result.success) this.renderLikeSummary(result.data);
      } catch (e) {
        // Панель лайка просто останется на нулях — не критично для чтения статьи
      }
    }

    renderLikeSummary(summary) {
      this.currentLiked = !!(summary && summary.liked);
      if (this.likeCountEl) this.likeCountEl.textContent = String((summary && summary.count) || 0);
      this.likeBtn?.classList.toggle('is-active', this.currentLiked);
      const heartIcon = this.likeBtn?.querySelector('i');
      if (heartIcon) heartIcon.className = this.currentLiked ? 'fas fa-heart' : 'far fa-heart';
    }

    async toggleLike() {
      if (!this.currentSlug || !this.likeBtn) return;
      this.likeBtn.disabled = true;
      try {
        const result = await window.apiClient.toggleArticleLike(this.currentSlug);
        if (result.success) {
          this.renderLikeSummary(result.data);
        } else {
          showMessage(`Не удалось поставить лайк: ${result.data?.error || result.error || ''}`, 'error');
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при попытке поставить лайк', 'error');
      } finally {
        this.likeBtn.disabled = false;
      }
    }

    // Клик по значку комментария (в панели лайка/комментариев ИЛИ в шапке
    // секции) — плавно докручивает статью до комментариев в самом низу.
    scrollToComments() {
      this.commentsSectionEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.commentInputEl?.focus();
    }

    async loadComments() {
      if (!this.currentSlug) return;
      try {
        const result = await window.apiClient.getArticleComments(this.currentSlug);
        this._commentsLoaded = true;
        this.renderComments(result.success && Array.isArray(result.data) ? result.data : []);
      } catch (e) {
        this.renderComments([]);
      }
    }

    // parentId группирует плоский список сервера в дерево "комментарий +
    // ответы" (один уровень, как в YouTube — см. комментарий у
    // article_comments в src/db/connections.js). this._commentsById нужен
    // toggleReaction() выше, чтобы обновить локальную копию после тоггла
    // реакции без перезагрузки всего списка.
    renderComments(comments) {
      this._commentsById = new Map(comments.map((c) => [c.id, c]));

      if (this.commentsCountEl) this.commentsCountEl.textContent = String(comments.length);
      if (this.commentsHeaderCountEl) this.commentsHeaderCountEl.textContent = comments.length ? `(${comments.length})` : '';
      if (this.commentsEmptyEl) this.commentsEmptyEl.hidden = comments.length > 0;
      if (!this.commentsListEl) return;

      const top = comments.filter((c) => !c.parentId);
      const repliesByParent = new Map();
      comments.forEach((c) => {
        if (!c.parentId) return;
        if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
        repliesByParent.get(c.parentId).push(c);
      });

      const me = window.authManager?.getCurrentUser?.();
      const canModerate = !!(me && (me.is_root || (me.admin_level || 0) > 0));

      this.commentsListEl.innerHTML = top
        .map((c) => this.renderCommentHtml(c, repliesByParent.get(c.id) || [], me, canModerate, false, c.id))
        .join('');
    }

    // topParentId — id ВЕРХНЕГО комментария треда (для самого верхнего
    // комментария это его же id, для ответа — id родителя): именно туда
    // монтируется форма "Ответить" (см. toggleReplyComposer) — ответ на
    // ответ подшивается к тому же треду, а не плодит новый уровень
    // вложенности (сервер и так уплощает это в POST .../comments, но так
    // кнопка "Ответить" есть и у самих ответов — см. задачу "нет
    // возможности отвечать на комментарии под комментариями").
    renderCommentHtml(comment, replies, me, canModerate, isReply, topParentId) {
      const canDelete = canModerate || (me && me.id === comment.userId);
      const { html, standalone } = formatCommentContent(comment.content, comment.stickers);
      const reactionsBar = `<div class="ibripedia-reactions" data-target-type="comment" data-target-id="${comment.id}">${reactionsBarInnerHtml(comment.reactions)}</div>`;

      return `
        <div class="ibripedia-comment${isReply ? ' ibripedia-comment-reply' : ''}" data-id="${comment.id}">
          <div class="ibripedia-comment-head">
            <span class="ibripedia-comment-author">${escapeHtml(comment.authorName)}</span>
            <span class="ibripedia-comment-date">${formatDate(comment.createdAt)}</span>
            ${canDelete ? `<button type="button" class="ibripedia-comment-delete" data-action="delete-comment" data-id="${comment.id}" title="Удалить комментарий"><i class="fas fa-trash"></i></button>` : ''}
          </div>
          <div class="ibripedia-comment-body${standalone ? ' ibripedia-comment-sticker-only' : ''}">${html}</div>
          <div class="ibripedia-comment-actions">
            ${reactionsBar}
            <button type="button" class="ibripedia-comment-reply-btn" data-action="reply" data-id="${topParentId}" data-mention="${escapeHtml(comment.authorName)}"><i class="far fa-message"></i> Ответить</button>
          </div>
          ${isReply ? '' : this.renderRepliesHtml(comment.id, replies, me, canModerate)}
          ${isReply ? '' : `<div class="ibripedia-reply-compose-mount" data-reply-mount="${comment.id}"></div>`}
        </div>
      `;
    }

    // "видно первое сообщение ответа, если их больше двух" — до двух ответов
    // показываем целиком, от трёх и выше показываем только первый + кнопку
    // "Показать ещё N ответов", разворачивающую остальные на месте. Кроме
    // самого первого захода в комментарии (this._expandedReplyThreads пуст,
    // см. resetEngagementUI) состояние "развёрнуто/свёрнуто" переживает
    // перерисовку списка — иначе собственный ответ пользователя схлопывал бы
    // назад уже открытую им же ветку (см. toggleReplies()/submitReply()).
    renderRepliesHtml(parentId, replies, me, canModerate) {
      if (!replies.length) return '';
      // Второй ключ сортировки (id) — подстраховка на случай двух ответов в
      // рамках одной секунды: created_at в SQLite с точностью до секунды, а
      // id всегда строго по порядку добавления.
      const sorted = replies.slice().sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || (a.id - b.id));
      const hasExtra = sorted.length > 2;
      const expanded = this._expandedReplyThreads.has(String(parentId));
      const shown = hasExtra ? [sorted[0]] : sorted;
      const extra = hasExtra ? sorted.slice(1) : [];
      const shownHtml = shown.map((r) => this.renderCommentHtml(r, [], me, canModerate, true, parentId)).join('');
      const extraHtml = extra.map((r) => this.renderCommentHtml(r, [], me, canModerate, true, parentId)).join('');
      const toggle = extra.length
        ? `<button type="button" class="ibripedia-replies-toggle" data-action="toggle-replies" data-id="${parentId}">
             ${expanded
               ? `<i class="fas fa-caret-up"></i> Скрыть ответы`
               : `<i class="fas fa-caret-down"></i> Показать ещё ${extra.length} ${pluralizeReplies(extra.length)}`}
           </button>`
        : '';
      return `
        <div class="ibripedia-replies" data-replies-for="${parentId}">
          ${shownHtml}
          ${extra.length ? `<div class="ibripedia-replies-extra"${expanded ? '' : ' hidden'}>${extraHtml}</div>` : ''}
          ${toggle}
        </div>`;
    }

    // Единый делегированный обработчик кликов по списку комментариев —
    // стикер (открыть его набор), реакции, "Ответить", "Показать ещё
    // ответов", удаление. Каждая ветка завершается своим "return", поэтому
    // порядок проверок друг другу не мешает.
    handleCommentsListClick(e) {
      const stickerImg = e.target.closest('[data-pack-id]');
      if (stickerImg) {
        window.stickerPackView?.open(stickerImg.getAttribute('data-pack-id'));
        return;
      }

      const toggleBtn = e.target.closest('[data-action="toggle-replies"]');
      if (toggleBtn) { this.toggleReplies(toggleBtn); return; }

      const replyBtn = e.target.closest('[data-action="reply"]');
      if (replyBtn) { this.toggleReplyComposer(replyBtn.getAttribute('data-id'), replyBtn.getAttribute('data-mention')); return; }

      const deleteBtn = e.target.closest('[data-action="delete-comment"]');
      if (deleteBtn) { this.deleteComment(deleteBtn.getAttribute('data-id')); return; }

      this.handleReactionsClick(e);
    }

    toggleReplies(btn) {
      const wrap = btn.closest('.ibripedia-replies');
      const extra = wrap?.querySelector('.ibripedia-replies-extra');
      if (!extra) return;
      const parentId = btn.getAttribute('data-id');
      const expand = extra.hidden;
      extra.hidden = !expand;
      if (expand) {
        this._expandedReplyThreads.add(String(parentId));
        btn.innerHTML = `<i class="fas fa-caret-up"></i> Скрыть ответы`;
      } else {
        this._expandedReplyThreads.delete(String(parentId));
        const n = extra.children.length;
        btn.innerHTML = `<i class="fas fa-caret-down"></i> Показать ещё ${n} ${pluralizeReplies(n)}`;
      }
    }

    // Одна открытая форма ответа зараз на ТРЕД (parentId — id верхнего
    // комментария, см. topParentId в renderCommentHtml) — открытие ответа на
    // другой тред закрывает предыдущую форму, но повторный клик "Ответить"
    // внутри уже открытого треда (в том числе на другой его ответ) НЕ
    // закрывает и не сбрасывает набранный черновик — просто переносит фокус,
    // чтобы случайный повторный клик не стирал начатый ответ.
    toggleReplyComposer(parentId, mentionName) {
      const mount = this.commentsListEl?.querySelector(`[data-reply-mount="${parentId}"]`);
      if (!mount) return;

      if (this._activeReplyParentId === String(parentId)) {
        mount.querySelector('.ibripedia-comment-input')?.focus();
        return;
      }
      if (this._activeReplyParentId) {
        const prevMount = this.commentsListEl.querySelector(`[data-reply-mount="${this._activeReplyParentId}"]`);
        if (prevMount) prevMount.innerHTML = '';
      }
      this._activeReplyParentId = String(parentId);

      mount.innerHTML = `
        <div class="ibripedia-comment-form ibripedia-reply-form">
          <div class="ibripedia-comment-input" contenteditable="true" data-placeholder="Ответить…"></div>
          <div class="ibripedia-comment-form-actions">
            <button type="button" class="ibripedia-sticker-picker-btn" data-sticker-picker-trigger title="Стикеры"><i class="far fa-face-smile"></i></button>
            <button type="button" class="btn btn-secondary btn-sm" data-role="cancel">Отмена</button>
            <button type="button" class="btn btn-primary btn-sm" data-role="submit">Ответить</button>
          </div>
          ${STICKER_PICKER_MARKUP}
        </div>
      `;

      const composer = this.wireComposer(mount.firstElementChild, {
        onSubmit: (content) => this.submitReply(parentId, content),
        onCancel: () => { mount.innerHTML = ''; this._activeReplyParentId = null; }
      });

      // "@Имя " — как в YouTube, чтобы было видно, кому именно отвечаешь,
      // если это ответ не на самый первый (видимый) комментарий треда.
      if (mentionName && composer) {
        composer.inputEl.textContent = `@${mentionName} `;
        const range = document.createRange();
        range.selectNodeContents(composer.inputEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      composer?.focus();
    }

    async submitReply(parentId, content) {
      if (!content || !this.currentSlug) return;
      try {
        const result = await window.apiClient.addArticleComment(this.currentSlug, content, parentId);
        if (result.success) {
          this._activeReplyParentId = null;
          // Свой же ответ не должен схлопнуть только что открытую ветку
          // (см. renderRepliesHtml) — помечаем тред развёрнутым ДО
          // перерисовки, а не только по клику на "Показать ещё ответов".
          this._expandedReplyThreads.add(String(parentId));
          await this.loadComments();
        } else {
          showMessage(`Не удалось отправить ответ: ${result.data?.error || result.error || ''}`, 'error');
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при отправке ответа', 'error');
      }
    }

    async submitComment(content) {
      if (!content || !this.currentSlug) return;
      try {
        const result = await window.apiClient.addArticleComment(this.currentSlug, content);
        if (result.success) {
          this.mainComposer?.clear();
          await this.loadComments();
        } else {
          showMessage(`Не удалось отправить комментарий: ${result.data?.error || result.error || ''}`, 'error');
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при отправке комментария', 'error');
      }
    }

    async deleteComment(id) {
      if (!id || !this.currentSlug) return;
      const ok = await window.confirmDialog.open({
        title: 'Удалить комментарий?',
        message: 'Ответы на него удалятся вместе с ним. Это действие необратимо.',
        confirmLabel: 'Удалить'
      });
      if (!ok) return;

      try {
        const result = await window.apiClient.deleteArticleComment(this.currentSlug, id);
        if (result.success) {
          await this.loadComments();
        } else {
          showMessage(`Не удалось удалить комментарий: ${result.data?.error || result.error || ''}`, 'error');
        }
      } catch (e) {
        showMessage('Неожиданная ошибка при удалении комментария', 'error');
      }
    }

    closeArticleView() {
      this.currentSlug = null;
      this.currentArticleBookmarks = [];
      this.resetEngagementUI();
      this.closeBookmarkPopover();
      this.resetInlineSearchUI();
      if (this._tocObserver) { this._tocObserver.disconnect(); this._tocObserver = null; }
      if (this.viewEl) this.viewEl.hidden = true;
      if (this.browseEl) this.browseEl.hidden = false;
      // Витрина только что снова видима — hidden=false выше уже обновил
      // раскладку синхронно, так что scrollHeight/scrollTo для неё доступны
      // сразу же, без ожидания кадра (см. комментарий у _libraryScrollY в
      // конструкторе). behavior: 'instant' обязателен — на html стоит
      // scroll-behavior: smooth (см. global-styles.css), а scrollTo(x, y)/
      // behavior:'auto' его наследует и едет к цели плавно, из-за чего сразу
      // после вызова scrollY ещё не совпадает с целью.
      window.scrollTo({ top: this._libraryScrollY || 0, left: 0, behavior: 'instant' });
    }

    // ========================================
    // Оглавление статьи (как панель "Навигация" в Word) — список
    // заголовков h1-h3 из отрендеренного контента, клик — плавный скролл.
    // ========================================

    buildToc() {
      const panel = this.tocPanelEl;
      if (!panel || !this.contentEl) return;

      const headings = Array.from(this.contentEl.querySelectorAll('h1[data-block-id], h2[data-block-id], h3[data-block-id]'));
      this._tocHeadings = headings;

      if (!headings.length) {
        panel.innerHTML = '<div class="ibripedia-sidebar-empty">В этой статье нет заголовков.</div>';
        if (this._tocObserver) { this._tocObserver.disconnect(); this._tocObserver = null; }
        return;
      }

      panel.innerHTML = `<ul class="ibripedia-toc-list">${headings.map((h) => {
        const level = parseInt(h.tagName.slice(1), 10) || 2;
        const blockId = h.getAttribute('data-block-id');
        return `<li class="ibripedia-toc-item ibripedia-toc-level-${level}"><a href="javascript:void(0)" data-block-id="${escapeHtml(blockId)}">${escapeHtml(h.textContent)}</a></li>`;
      }).join('')}</ul>`;

      this.setupTocScrollSpy();
    }

    // Подсвечивает в оглавлении заголовок раздела, который сейчас виден в
    // верхней части экрана — тот же приём, что и "активный пункт" в
    // Навигации Word при скролле по документу.
    setupTocScrollSpy() {
      if (this._tocObserver) { this._tocObserver.disconnect(); this._tocObserver = null; }
      if (!('IntersectionObserver' in window) || !this._tocHeadings.length) return;

      this._tocObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const blockId = entry.target.getAttribute('data-block-id');
          this.tocPanelEl?.querySelectorAll('a[data-block-id]').forEach((a) => {
            a.classList.toggle('active', a.getAttribute('data-block-id') === blockId);
          });
        });
      }, { rootMargin: '-10% 0px -75% 0px' });

      this._tocHeadings.forEach((h) => this._tocObserver.observe(h));
    }

    scrollToBlock(blockId) {
      if (!blockId || !this.contentEl) return;
      let el;
      try { el = this.contentEl.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`); } catch (e) { el = null; }
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('ibripedia-block-flash');
      // reflow — чтобы анимация переиграла, если кликнули по тому же блоку второй раз подряд
      void el.offsetWidth;
      el.classList.add('ibripedia-block-flash');
      setTimeout(() => el.classList.remove('ibripedia-block-flash'), 1600);
    }

    // ========================================
    // Вкладки боковой панели (Оглавление / Закладки) + сворачивание панели
    // на телефоне/планшете (кнопка ibripediaSidebarToggleBtn).
    // ========================================

    initSidebarTabs() {
      document.querySelectorAll('.ibripedia-sidebar-tab').forEach((btn) => {
        btn.addEventListener('click', () => this.switchSidebarTab(btn.getAttribute('data-sidebar-tab')));
      });
      this.tocPanelEl?.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-block-id]');
        if (!a) return;
        e.preventDefault();
        this.scrollToBlock(a.getAttribute('data-block-id'));
      });
      this.bookmarksPanelEl?.addEventListener('click', (e) => this.handleBookmarksPanelClick(e));
      this.bookmarksPanelEl?.addEventListener('dblclick', (e) => this.handleBookmarksPanelDblClick(e));
      this.sidebarToggleBtn?.addEventListener('click', () => {
        const open = this.sidebarEl?.classList.toggle('is-open');
        this.sidebarToggleBtn.classList.toggle('is-open', !!open);
        this.sidebarToggleBtn.setAttribute('aria-expanded', String(!!open));
      });
    }

    switchSidebarTab(tab) {
      document.querySelectorAll('.ibripedia-sidebar-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-sidebar-tab') === tab);
      });
      if (this.tocPanelEl) this.tocPanelEl.hidden = tab !== 'toc';
      if (this.bookmarksPanelEl) this.bookmarksPanelEl.hidden = tab !== 'bookmarks';
    }

    closeSidebarOnMobile() {
      this.sidebarEl?.classList.remove('is-open');
      this.sidebarToggleBtn?.classList.remove('is-open');
      this.sidebarToggleBtn?.setAttribute('aria-expanded', 'false');
    }

    // ========================================
    // Поиск по тексту открытой статьи — подсвечивает совпадения прямо в
    // рендере и листает по ним (Enter/Shift+Enter или кнопки-стрелки).
    // ========================================

    initInlineSearch() {
      this.inlineSearchEl?.addEventListener('input', () => {
        clearTimeout(this._inlineSearchDebounce);
        this._inlineSearchDebounce = setTimeout(() => this.runInArticleSearch(this.inlineSearchEl.value), 250);
      });
      this.inlineSearchEl?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        this.gotoSearchHit(e.shiftKey ? -1 : 1);
      });
      this.inlineSearchPrevBtn?.addEventListener('click', () => this.gotoSearchHit(-1));
      this.inlineSearchNextBtn?.addEventListener('click', () => this.gotoSearchHit(1));
      this.inlineSearchClearBtn?.addEventListener('click', () => {
        if (this.inlineSearchEl) this.inlineSearchEl.value = '';
        this.runInArticleSearch('');
        this.inlineSearchEl?.focus();
      });
    }

    resetInlineSearchUI() {
      if (this.inlineSearchEl) this.inlineSearchEl.value = '';
      this.clearSearchHighlights();
      this.updateSearchCount();
    }

    runInArticleSearch(query) {
      this.clearSearchHighlights();
      const q = query.trim();
      if (!q || !this.contentEl) { this.updateSearchCount(); return; }

      const qLower = q.toLowerCase();
      const walker = document.createTreeWalker(this.contentEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
          return node.nodeValue.toLowerCase().includes(qLower) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);

      nodes.forEach((node) => {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        let idx = lower.indexOf(qLower);
        while (idx !== -1) {
          if (idx > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
          const mark = document.createElement('mark');
          mark.className = 'ibripedia-search-hit';
          mark.textContent = text.slice(idx, idx + q.length);
          frag.appendChild(mark);
          lastIndex = idx + q.length;
          idx = lower.indexOf(qLower, lastIndex);
        }
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.parentNode.replaceChild(frag, node);
      });

      this._searchHits = Array.from(this.contentEl.querySelectorAll('mark.ibripedia-search-hit'));
      this._searchIndex = -1;
      this.updateSearchCount();
      if (this._searchHits.length) this.gotoSearchHit(1);
    }

    // Снимает подсветку поиска, не трогая другую разметку (например
    // mark.mk-hl — постоянное выделение из markdown ==текст==).
    clearSearchHighlights() {
      if (!this.contentEl) return;
      this.contentEl.querySelectorAll('mark.ibripedia-search-hit').forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
      this._searchHits = [];
      this._searchIndex = -1;
    }

    updateSearchCount() {
      const hasQuery = !!this.inlineSearchEl?.value.trim();
      if (this.inlineSearchCountEl) {
        this.inlineSearchCountEl.hidden = !hasQuery;
        this.inlineSearchCountEl.textContent = this._searchHits.length
          ? `${this._searchIndex + 1}/${this._searchHits.length}`
          : (hasQuery ? '0/0' : '');
      }
      const showNav = hasQuery && this._searchHits.length > 0;
      if (this.inlineSearchPrevBtn) this.inlineSearchPrevBtn.hidden = !showNav;
      if (this.inlineSearchNextBtn) this.inlineSearchNextBtn.hidden = !showNav;
      if (this.inlineSearchClearBtn) this.inlineSearchClearBtn.hidden = !hasQuery;
    }

    gotoSearchHit(dir) {
      if (!this._searchHits.length) return;
      if (this._searchIndex >= 0) this._searchHits[this._searchIndex].classList.remove('ibripedia-search-hit-current');
      this._searchIndex = (this._searchIndex + dir + this._searchHits.length) % this._searchHits.length;
      const hit = this._searchHits[this._searchIndex];
      hit.classList.add('ibripedia-search-hit-current');
      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.updateSearchCount();
    }

    // ========================================
    // Закладки: хвостик-переключатель слева от блока (см. .ibripedia-bm-toggle
    // в ibripedia.css и renderBookmarkGutter ниже) -> попап "название + цвет"
    // -> POST/PUT /api/bookmarks. Одна закладка на блок — повторный клик по
    // хвостику уже отмеченного блока открывает попап на РЕДАКТИРОВАНИЕ
    // существующей закладки, а не создаёт вторую. Привязка к профилю —
    // сервер сам берёт user_id из токена (см. src/routes/bookmarks.routes.js),
    // поэтому закладки видит и правит только сам пользователь.
    // ========================================

    // Минимальная ширина поля страницы слева от карточки статьи (px), при
    // которой стикеру-флажку (.ibripedia-bm-tab, ~150-170px + отступ) есть
    // где торчать, не наезжая на сайдбар/край окна — см. hasWideGutterSpace.
    static get BOOKMARK_TAB_MIN_SPACE() { return 190; }

    initBookmarkGutter() {
      // (hover: hover) — у мыши/трекпада, в отличие от пальца, наведение
      // без клика в принципе существует: только там приглашение "поставить
      // закладку" показываем ПО НАВЕДЕНИЮ (см. showBookmarkGhost), не
      // захламляя статью значком на каждом абзаце. На тач-экранах наведения
      // не бывает вообще — там вместо него двойной тап по абзацу (см.
      // handleContentDblClick), открывающий попап как модальное окно
      // (см. openBookmarkPopover/ibripedia.css). Постоянного значка-
      // приглашения на неотмеченных блоках там больше нет — только
      // цветной значок у уже поставленных закладок.
      this._bmHoverCapable = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

      // Один переиспользуемый элемент-"призрак" вместо кнопки на каждом
      // абзаце — показывается/переносится под курсор наведения (см.
      // showBookmarkGhost/hideBookmarkGhost), а не создаётся заново на
      // каждый ховер.
      this.bookmarkGhostEl = document.createElement('button');
      this.bookmarkGhostEl.type = 'button';
      this.bookmarkGhostEl.hidden = true;

      this.contentEl?.addEventListener('click', (e) => {
        const toggle = e.target.closest('.ibripedia-bm-toggle');
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        this.toggleBookmarkPopover(toggle);
      });
      this.bookmarkGutterEl?.addEventListener('click', (e) => {
        const tab = e.target.closest('.ibripedia-bm-tab');
        if (!tab) return;
        e.preventDefault();
        e.stopPropagation();
        this.toggleBookmarkPopover(tab);
      });

      if (this._bmHoverCapable) {
        // Призрак прячем, когда курсор ушёл и из зоны наведения, и с самого
        // призрака (например, при переходе с зоны прямо на него) — иначе
        // мигал бы в момент, когда мышь движется от текста к самому
        // стикеру, чтобы на него нажать.
        this.bookmarkGhostEl.addEventListener('mouseleave', (e) => {
          const toEl = e.relatedTarget;
          if (toEl && (this.bookmarkGutterHoverEl?.contains(toEl) || this.bookmarkCompactHoverEl?.contains(toEl))) return;
          this.hideBookmarkGhost();
        });
      } else {
        // Тач-устройство — двойной тап по абзацу открывает попап (как
        // модальное окно, см. ibripedia.css) сразу на редактирование, если
        // на блоке уже есть закладка, или на создание новой.
        this.contentEl?.addEventListener('dblclick', (e) => this.handleContentDblClick(e));
      }

      document.getElementById('ibripediaBookmarkPopoverCancel')?.addEventListener('click', () => this.closeBookmarkPopover());
      document.getElementById('ibripediaBookmarkPopoverSave')?.addEventListener('click', () => this.saveBookmarkFromPopover());
      this.bookmarkPopoverDeleteBtn?.addEventListener('click', () => this.deleteBookmarkFromPopover());
      this.bookmarkPopoverCloseBtn?.addEventListener('click', () => this.closeBookmarkPopover());
      this.bookmarkPopoverNameEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.saveBookmarkFromPopover(); }
        if (e.key === 'Escape') { e.preventDefault(); this.closeBookmarkPopover(); }
      });

      // Стикеры позиционируются в пикселях (см. renderBookmarkGutter) — при
      // изменении ширины окна текст переносится по-другому, блоки меняют
      // высоту, а поле слева от карточки может стать шире/уже (переключение
      // между "торчит за краем" и компактным режимом) — координаты и режим
      // нужно пересчитать.
      this._bmGutterResizeHandler = () => this.scheduleBookmarkGutterRefresh();
      window.addEventListener('resize', this._bmGutterResizeHandler);
    }

    scheduleBookmarkGutterRefresh() {
      clearTimeout(this._bmGutterResizeDebounce);
      this._bmGutterResizeDebounce = setTimeout(() => this.renderBookmarkGutter(), 150);
    }

    // Есть ли слева от карточки статьи достаточно места для стикера,
    // торчащего ЗА её краем (см. .ibripedia-bm-tab в ibripedia.css) — само
    // поле уже учитывает сайдбар приложения слева и центрирование карточки,
    // т.к. измеряется её реальное положение на экране, а не ширина окна.
    hasWideGutterSpace() {
      if (!this.viewArticleEl) return false;
      return this.viewArticleEl.getBoundingClientRect().left >= IbripediaManager.BOOKMARK_TAB_MIN_SPACE;
    }

    // Стикеры закладок: у каждого отмеченного блока — свой (всегда виден,
    // в любом режиме). Приглашение на ещё не отмеченный блок — БЕЗ
    // постоянного значка: на устройствах с мышью по наведению на пустое
    // поле слева от статьи, НЕ на сам текст (иначе всплывало бы при обычном
    // чтении) — см. createHoverZone/handleGutterHoverMove; на
    // тач-устройствах — двойной тап прямо по абзацу (см.
    // handleContentDblClick в initBookmarkGutter).
    renderBookmarkGutter() {
      if (!this.contentEl) return;
      this.hideBookmarkGhost();
      this.contentEl.querySelectorAll('.ibripedia-bm-toggle, .ibripedia-bm-hover-zone').forEach((el) => el.remove());
      if (this.bookmarkGutterEl) this.bookmarkGutterEl.innerHTML = '';
      this.bookmarkGutterHoverEl = null;
      this.bookmarkCompactHoverEl = null;

      const blocks = Array.from(this.contentEl.querySelectorAll('[data-block-id]'));
      if (!blocks.length) { this._bmBlocks = []; return; }

      this._bmWideMode = this.hasWideGutterSpace();
      const byBlock = new Map(this.currentArticleBookmarks.filter((b) => b.blockId).map((b) => [b.blockId, b]));
      const contentRect = this.contentEl.getBoundingClientRect();
      const layoutRect = (this._bmWideMode && this.bookmarkGutterEl) ? this.bookmarkGutterEl.parentElement.getBoundingClientRect() : null;

      // Кэш координат блоков + зона наведения нужны только на устройствах с
      // мышью (см. handleGutterHoverMove) — на тач-устройствах приглашение
      // открывается двойным тапом прямо по блоку (см. handleContentDblClick),
      // без наведения, мерить тут нечего.
      if (this._bmHoverCapable) {
        // Координаты блоков в той же системе отсчёта, что и зона наведения
        // (layoutRect в широком режиме, contentRect в компактном) — кэш для
        // handleGutterHoverMove, чтобы не мерить весь DOM на каждое движение
        // мыши.
        this._bmBlocks = blocks.map((blockEl) => {
          const blockRect = blockEl.getBoundingClientRect();
          const originTop = this._bmWideMode ? layoutRect.top : contentRect.top;
          return {
            blockId: blockEl.getAttribute('data-block-id'),
            el: blockEl,
            top: blockRect.top - originTop,
            bottom: blockRect.bottom - originTop
          };
        });

        // Зона наведения — ДО стикеров/значков в DOM, чтобы те красились
        // поверх неё и оставались кликабельными там, где перекрываются с ней.
        if (this._bmWideMode && this.bookmarkGutterEl) {
          this.bookmarkGutterHoverEl = this.createHoverZone('ibripedia-bm-hover-zone');
          this.bookmarkGutterHoverEl.style.top = `${this._bmBlocks[0].top}px`;
          this.bookmarkGutterHoverEl.style.height = `${Math.max(...this._bmBlocks.map((b) => b.bottom)) - this._bmBlocks[0].top}px`;
          this.bookmarkGutterEl.appendChild(this.bookmarkGutterHoverEl);
        } else {
          this.bookmarkCompactHoverEl = this.createHoverZone('ibripedia-bm-hover-zone ibripedia-bm-hover-zone-compact');
          this.contentEl.appendChild(this.bookmarkCompactHoverEl);
        }
      }

      blocks.forEach((blockEl) => {
        const blockId = blockEl.getAttribute('data-block-id');
        const bookmark = byBlock.get(blockId);

        // Стикер только у уже поставленной закладки — постоянного значка-
        // приглашения на неотмеченных блоках больше нет ни в одном режиме:
        // на устройствах с мышью это зона наведения (см. выше), на
        // тач-устройствах — двойной тап прямо по абзацу (см.
        // handleContentDblClick в initBookmarkGutter).
        if (!bookmark) return;
        if (this._bmWideMode) {
          this.bookmarkGutterEl.appendChild(this.createBookmarkTab(blockEl, blockId, bookmark, layoutRect));
        } else {
          this.contentEl.appendChild(this.createCompactToggle(blockEl, blockId, bookmark, contentRect));
        }
      });
    }

    // Прозрачная область для наведения — пустое поле слева от карточки
    // (широкий режим) или зарезервированная под значки полоса внутри
    // самого начала карточки (компактный режим), НЕ сам текст статьи. Сама
    // ничего не рисует — только ловит mousemove/mouseleave.
    createHoverZone(className) {
      const zone = document.createElement('div');
      zone.className = className;
      zone.addEventListener('mousemove', (e) => this.handleGutterHoverMove(e, zone));
      zone.addEventListener('mouseleave', (e) => {
        const toEl = e.relatedTarget;
        if (toEl && this.bookmarkGhostEl?.contains(toEl)) return; // ушли на сам призрак, чтобы на него нажать
        this.hideBookmarkGhost();
      });
      return zone;
    }

    // Курсор двигается внутри зоны наведения — показываем призрак напротив
    // ближайшего ещё не отмеченного блока. Троттлинг через rAF — mousemove
    // стреляет очень часто, а тут на каждый вызов пересчёт геометрии.
    handleGutterHoverMove(e, zoneEl) {
      this._bmLastHoverY = e.clientY;
      if (this._bmHoverMoveScheduled) return;
      this._bmHoverMoveScheduled = true;
      requestAnimationFrame(() => {
        this._bmHoverMoveScheduled = false;
        if (!zoneEl.isConnected) return; // зону успели перестроить (resize/новая статья) — событие устарело
        // Точка отсчёта та же, что и у координат в this._bmBlocks (см.
        // renderBookmarkGutter) — НЕ сама зона: у неё в широком режиме есть
        // свой сдвиг (top: this._bmBlocks[0].top), а не 0. Мерим заново
        // (не берём готовый layoutRect/contentRect из рендера) — страница
        // могла проскроллиться с момента построения кэша.
        const originEl = this._bmWideMode ? this.bookmarkGutterEl?.parentElement : this.contentEl;
        if (!originEl) return;
        const localY = this._bmLastHoverY - originEl.getBoundingClientRect().top;
        const block = this.findNearestBlock(localY);
        if (!block || this.currentArticleBookmarks.some((b) => b.blockId === block.blockId)) {
          this.hideBookmarkGhost();
          return;
        }
        if (!this.bookmarkGhostEl.hidden && this.bookmarkGhostEl.getAttribute('data-block-id') === block.blockId) return;
        this.showBookmarkGhost(block.el, block.blockId);
      });
    }

    // Ближайший к localY блок среди закэшированных в renderBookmarkGutter
    // (this._bmBlocks) — точное попадание в диапазон [top, bottom], а между
    // абзацами — тот, что ближе по вертикали.
    findNearestBlock(localY) {
      if (!this._bmBlocks || !this._bmBlocks.length) return null;
      let best = null;
      let bestDist = Infinity;
      for (const b of this._bmBlocks) {
        if (localY >= b.top && localY <= b.bottom) return b;
        const dist = localY < b.top ? b.top - localY : localY - b.bottom;
        if (dist < bestDist) { bestDist = dist; best = b; }
      }
      return best;
    }

    // Флажок за левым краем карточки, с именем закладки текстом (см.
    // .ibripedia-bm-tab в ibripedia.css) — широкий режим.
    createBookmarkTab(blockEl, blockId, bookmark, layoutRect) {
      const blockRect = blockEl.getBoundingClientRect();
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ibripedia-bm-tab';
      tab.style.top = `${blockRect.top - layoutRect.top}px`;
      tab.style.setProperty('--bm-color', bookmark.color);
      tab.setAttribute('data-block-id', blockId);
      tab.title = bookmark.name;
      tab.textContent = bookmark.name;
      return tab;
    }

    // Компактный значок внутри поля статьи (см. .ibripedia-bm-toggle в
    // ibripedia.css) — узкий экран/нет места справа ИЛИ приглашение на
    // тач-устройстве, где показать флажок только по ховеру нельзя.
    createCompactToggle(blockEl, blockId, bookmark, contentRect) {
      const blockRect = blockEl.getBoundingClientRect();
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ibripedia-bm-toggle' + (bookmark ? ' is-active' : '');
      toggle.style.top = `${blockRect.top - contentRect.top}px`;
      toggle.setAttribute('data-block-id', blockId);
      toggle.title = bookmark ? bookmark.name : 'Добавить закладку';
      if (bookmark) toggle.style.setProperty('--bm-color', bookmark.color);
      toggle.innerHTML = '<i class="fas fa-bookmark"></i>';
      return toggle;
    }

    // Показывает переиспользуемый "призрак" (см. initBookmarkGutter) на
    // месте блока — вызывается из handleGutterHoverMove, когда курсор в
    // зоне наведения оказался напротив ещё не отмеченного блока.
    showBookmarkGhost(blockEl, blockId) {
      if (!this.bookmarkGhostEl) return;
      this.bookmarkGhostEl.setAttribute('data-block-id', blockId);
      const blockRect = blockEl.getBoundingClientRect();

      if (this._bmWideMode && this.bookmarkGutterEl) {
        this.bookmarkGhostEl.className = 'ibripedia-bm-tab is-ghost';
        this.bookmarkGhostEl.style.removeProperty('--bm-color');
        this.bookmarkGhostEl.title = '';
        this.bookmarkGhostEl.innerHTML = '<i class="fas fa-bookmark"></i> Добавить';
        const layoutRect = this.bookmarkGutterEl.parentElement.getBoundingClientRect();
        this.bookmarkGhostEl.style.top = `${blockRect.top - layoutRect.top}px`;
        this.bookmarkGutterEl.appendChild(this.bookmarkGhostEl);
      } else if (this.contentEl) {
        this.bookmarkGhostEl.className = 'ibripedia-bm-toggle is-ghost';
        this.bookmarkGhostEl.title = 'Добавить закладку';
        this.bookmarkGhostEl.innerHTML = '<i class="fas fa-bookmark"></i>';
        const contentRect = this.contentEl.getBoundingClientRect();
        this.bookmarkGhostEl.style.top = `${blockRect.top - contentRect.top}px`;
        this.contentEl.appendChild(this.bookmarkGhostEl);
      }
      this.bookmarkGhostEl.hidden = false;
    }

    hideBookmarkGhost() {
      if (!this.bookmarkGhostEl || this.bookmarkGhostEl.hidden) return;
      this.bookmarkGhostEl.hidden = true;
      this.bookmarkGhostEl.remove();
    }

    toggleBookmarkPopover(toggleEl) {
      const blockId = toggleEl.getAttribute('data-block-id');
      // Повторный клик по тому же хвостику, пока попап на него уже открыт — закрыть.
      if (this._pendingBookmark && this._pendingBookmark.blockId === blockId && this.bookmarkPopoverEl && !this.bookmarkPopoverEl.hidden) {
        this.closeBookmarkPopover();
        return;
      }
      this.openBookmarkPopover(blockId, toggleEl);
    }

    // Тач-устройство, двойной тап по абзацу (см. initBookmarkGutter) —
    // пропускаем ссылки/хэштеги/значок закладки: у них своя реакция на тап,
    // не нужно, чтобы двойной тап по ним ЕЩЁ и открывал попап закладки.
    handleContentDblClick(e) {
      if (e.target.closest('a, .wiki-link, .wiki-link-missing, .wiki-link-restricted, .hashtag, .ibripedia-bm-toggle')) return;
      const blockEl = e.target.closest('[data-block-id]');
      if (!blockEl) return;
      e.preventDefault();
      this.openBookmarkPopover(blockEl.getAttribute('data-block-id'), blockEl);
    }

    openBookmarkPopover(blockId, anchorEl) {
      const existing = this.currentArticleBookmarks.find((b) => b.blockId === blockId);
      this._pendingBookmark = { blockId, id: existing ? existing.id : null };

      if (this.bookmarkPopoverNameEl) this.bookmarkPopoverNameEl.value = existing ? existing.name : '';
      this.selectedBookmarkColor = existing ? existing.color : BOOKMARK_COLORS[0];
      this.renderBookmarkColorSwatches();
      if (this.bookmarkPopoverDeleteBtn) this.bookmarkPopoverDeleteBtn.hidden = !existing;

      if (this.bookmarkPopoverEl) {
        this.bookmarkPopoverEl.hidden = false;
        if (this._bmHoverCapable && anchorEl) {
          // Устройство с мышью — обычная всплывающая панель у хвостика.
          const rect = anchorEl.getBoundingClientRect();
          this.positionFloating(this.bookmarkPopoverEl, rect.left + rect.width / 2, rect.bottom + 8, 280, 220);
        } else {
          // Тач-устройство — модальное окно по центру экрана (см. @media
          // (hover:none) в ibripedia.css) — свои inline-координаты только
          // мешали бы, а подложка явно показывает, что это модалка, а не
          // всплывающая панель, которая пропадёт от любого тапа мимо.
          this.bookmarkPopoverEl.style.removeProperty('left');
          this.bookmarkPopoverEl.style.removeProperty('top');
          if (this.bookmarkModalBackdropEl) this.bookmarkModalBackdropEl.hidden = false;
        }
      }
      this.bookmarkPopoverNameEl?.focus();
      this.bookmarkPopoverNameEl?.select();
    }

    // Ставит попап в фиксированных координатах рядом с точкой (cx, cy), не
    // давая ему вылезти за края экрана.
    positionFloating(el, cx, cy, width, height) {
      if (!el) return;
      const margin = 8;
      const left = Math.min(Math.max(margin, cx - width / 2), window.innerWidth - width - margin);
      const top = Math.min(Math.max(margin, cy), window.innerHeight - height - margin);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    }

    renderBookmarkColorSwatches() {
      if (!this.bookmarkPopoverColorsEl) return;
      this.bookmarkPopoverColorsEl.innerHTML = BOOKMARK_COLORS.map((c) =>
        `<button type="button" class="ibripedia-bookmark-swatch${c === this.selectedBookmarkColor ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
      ).join('');
      this.bookmarkPopoverColorsEl.querySelectorAll('.ibripedia-bookmark-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.selectedBookmarkColor = btn.getAttribute('data-color');
          this.bookmarkPopoverColorsEl.querySelectorAll('.ibripedia-bookmark-swatch').forEach((b) => b.classList.toggle('active', b === btn));
        });
      });
    }

    closeBookmarkPopover() {
      if (this.bookmarkPopoverEl) this.bookmarkPopoverEl.hidden = true;
      if (this.bookmarkModalBackdropEl) this.bookmarkModalBackdropEl.hidden = true;
      this._pendingBookmark = null;
    }

    async saveBookmarkFromPopover() {
      if (!this._pendingBookmark || !this.currentSlug) return;
      const name = this.bookmarkPopoverNameEl?.value.trim();
      if (!name) {
        showMessage('Введите название закладки', 'error');
        this.bookmarkPopoverNameEl?.focus();
        return;
      }
      const color = this.selectedBookmarkColor || BOOKMARK_COLORS[0];

      try {
        let result;
        if (this._pendingBookmark.id) {
          result = await window.apiClient.updateBookmark(this._pendingBookmark.id, { name, color });
        } else {
          const titleEl = document.getElementById('ibripediaViewTitle');
          let blockEl;
          try { blockEl = this.contentEl?.querySelector(`[data-block-id="${CSS.escape(this._pendingBookmark.blockId)}"]`); } catch (e) { blockEl = null; }
          result = await window.apiClient.createBookmark({
            slug: this.currentSlug,
            title: titleEl ? titleEl.textContent : '',
            blockId: this._pendingBookmark.blockId,
            quote: blockEl ? blockEl.textContent.trim().slice(0, 140) : '',
            name,
            color
          });
        }
        if (!result.success) {
          showMessage(`Не удалось сохранить закладку: ${result.data?.error || result.error || ''}`, 'error');
          return;
        }
        showMessage('Закладка сохранена', 'success');
        this.closeBookmarkPopover();
        await this.loadArticleBookmarks();
      } catch (e) {
        showMessage('Не удалось сохранить закладку', 'error');
      }
    }

    async deleteBookmarkFromPopover() {
      if (!this._pendingBookmark?.id) return;
      await this.deleteBookmarkById(this._pendingBookmark.id);
      this.closeBookmarkPopover();
    }

    // ========================================
    // Список закладок текущей статьи (панель) + хвостики в тексте
    // ========================================

    async loadArticleBookmarks() {
      if (!this.currentSlug) return;
      try {
        const result = await window.apiClient.getBookmarks(this.currentSlug);
        this.currentArticleBookmarks = (result.success && Array.isArray(result.data)) ? result.data : [];
      } catch (e) {
        this.currentArticleBookmarks = [];
      }
      this.renderBookmarksPanel();
      this.renderBookmarkGutter();
    }

    renderBookmarksPanel() {
      const panel = this.bookmarksPanelEl;
      if (!panel) return;

      if (!this.currentArticleBookmarks.length) {
        panel.innerHTML = '<div class="ibripedia-sidebar-empty">Закладок пока нет — нажмите на хвостик закладки слева от нужного абзаца, чтобы добавить.</div>';
        return;
      }

      panel.innerHTML = this.currentArticleBookmarks.map((b) => `
        <div class="ibripedia-bookmark-item" data-id="${b.id}" data-block-id="${escapeHtml(b.blockId || '')}">
          <span class="ibripedia-bookmark-dot" style="background:${escapeHtml(b.color)}"></span>
          <div class="ibripedia-bookmark-item-body">
            <div class="ibripedia-bookmark-item-name">${escapeHtml(b.name)}</div>
            ${b.quote ? `<div class="ibripedia-bookmark-item-quote">${escapeHtml(b.quote)}</div>` : ''}
          </div>
          <button type="button" class="ibripedia-bookmark-item-del" data-action="delete-bookmark" title="Удалить закладку"><i class="fas fa-trash"></i></button>
        </div>
      `).join('');
    }

    handleBookmarksPanelClick(e) {
      const delBtn = e.target.closest('[data-action="delete-bookmark"]');
      const item = e.target.closest('.ibripedia-bookmark-item');
      if (!item) return;
      const id = item.getAttribute('data-id');

      if (delBtn) {
        e.stopPropagation();
        this.deleteBookmarkById(id);
        return;
      }

      // Прыжок к блоку закладки + подсветка строки — тот же scrollToBlock,
      // что и у пунктов оглавления (см. initSidebarTabs), поэтому подсветка
      // при переходе по закладке выглядит и работает одинаково с прыжком по
      // заголовку.
      const blockId = item.getAttribute('data-block-id');
      if (blockId) this.scrollToBlock(blockId);
    }

    handleBookmarksPanelDblClick(e) {
      const nameEl = e.target.closest('.ibripedia-bookmark-item-name');
      if (!nameEl) return;
      const item = nameEl.closest('.ibripedia-bookmark-item');
      const id = item?.getAttribute('data-id');
      const bookmark = this.currentArticleBookmarks.find((b) => String(b.id) === String(id));
      if (!bookmark) return;

      const newName = prompt('Новое название закладки:', bookmark.name);
      if (newName == null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === bookmark.name) return;
      this.renameBookmark(id, trimmed);
    }

    async renameBookmark(id, name) {
      try {
        const result = await window.apiClient.updateBookmark(id, { name });
        if (!result.success) { showMessage('Не удалось переименовать закладку', 'error'); return; }
        this.currentArticleBookmarks = this.currentArticleBookmarks.map((b) => (String(b.id) === String(id) ? { ...b, name } : b));
        this.renderBookmarksPanel();
        this.renderBookmarkGutter();
      } catch (e) {
        showMessage('Не удалось переименовать закладку', 'error');
      }
    }

    async deleteBookmarkById(id) {
      try {
        const result = await window.apiClient.deleteBookmark(id);
        if (!result.success) { showMessage('Не удалось удалить закладку', 'error'); return; }
        this.currentArticleBookmarks = this.currentArticleBookmarks.filter((b) => String(b.id) !== String(id));
        this.renderBookmarksPanel();
        this.renderBookmarkGutter();
      } catch (e) {
        showMessage('Не удалось удалить закладку', 'error');
      }
    }
  }

  window.ibripediaManager = new IbripediaManager();
})();
