// site.js — поведение публичной витрины AllTell. Antropedia использует
// публичные API для гостей и авторизованные API для вошедших пользователей.

(function () {
  var PUBLIC_ARTICLES_API = '/api/public/articles';
  var PUBLIC_PAGE_SIZE = 30;
  var ARTICLE_LIST_RETURN_KEY = 'publicAntropediaListReturn';
  var ARTICLE_LIST_RETURN_HASH = '#publicArticleListReturn';
  var currentRouteCleanup = null;
  var currentMountedPage = null;

  function saveArticleListPosition(articleSlug, scrollY) {
    try {
      var saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(ARTICLE_LIST_RETURN_KEY) || 'null'); } catch (error) { /* ignore invalid saved state */ }
      var currentPath = window.location.pathname;
      if (/^\/antropedia\/[^/]+\/?$/.test(currentPath)) {
        if (saved) {
          saved.currentSlug = articleSlug;
          saved.savedAt = Date.now();
          sessionStorage.setItem(ARTICLE_LIST_RETURN_KEY, JSON.stringify(saved));
        }
        return;
      }
      if (currentPath !== '/antropedia') return;
      sessionStorage.setItem(ARTICLE_LIST_RETURN_KEY, JSON.stringify({
        url: currentPath + window.location.search,
        scrollY: Number.isFinite(scrollY) ? scrollY : window.scrollY,
        currentSlug: articleSlug,
        savedAt: Date.now()
      }));
    } catch (error) {
      console.warn('Не удалось сохранить позицию списка статей:', error);
    }
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function makePublicMessage(text, className) {
    var message = document.createElement('p');
    message.className = className || 'public-article-message';
    message.textContent = text;
    return message;
  }

  function safePublicImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    var src = value.trim();
    if (src.startsWith('/uploads/')) return src;
    try {
      var url = new URL(src, window.location.origin);
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function updateAdminLinks(slug) {
    var destination = slug ? '/admin-panel?editArticle=' + encodeURIComponent(slug) : '/admin-panel';
    document.querySelectorAll('.site-admin-toggle').forEach(function (link) {
      link.href = destination;
    });
  }

  function initSiteUserMenu() {
    var root = document.getElementById('siteUserMenu');
    var guestActions = document.getElementById('siteGuestActions');
    var trigger = document.getElementById('siteUserTrigger');
    var avatar = document.getElementById('siteUserAvatar');
    var name = document.getElementById('siteUserName');
    var dropdown = document.getElementById('siteUserDropdown');
    if (!root || !guestActions || !trigger || !avatar || !name || !dropdown) return;

    var auth = window.authManager;

    function closeDropdown() {
      dropdown.classList.remove('show');
      trigger.setAttribute('aria-expanded', 'false');
    }

    function renderUser(user) {
      var isLoggedIn = !!(auth && user && auth.isAuthenticated());
      root.hidden = !isLoggedIn;
      guestActions.hidden = isLoggedIn;
      closeDropdown();
      if (!isLoggedIn) return;

      var displayName = user.display_name || user.username || 'Пользователь';
      name.textContent = displayName;
      avatar.replaceChildren();
      var avatarUrl = safePublicImageUrl(user.avatar);
      if (avatarUrl) {
        var image = document.createElement('img');
        image.src = avatarUrl;
        image.alt = '';
        image.onerror = function () {
          avatar.classList.remove('has-image');
          avatar.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
        };
        avatar.classList.add('has-image');
        avatar.appendChild(image);
      } else {
        avatar.classList.remove('has-image');
        avatar.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
      }
    }

    function refreshUser() {
      if (!auth || !auth.getToken()) {
        renderUser(null);
        return;
      }
      renderUser(auth.getCurrentUser());
      auth.validateToken().then(function (isValid) {
        renderUser(isValid || auth.isAuthenticated() ? auth.getUser() : null);
      }).catch(function (error) {
        console.error('Не удалось проверить профиль пользователя:', error);
      });
    }

    trigger.addEventListener('click', function (event) {
      event.stopPropagation();
      var isOpen = dropdown.classList.toggle('show');
      trigger.setAttribute('aria-expanded', String(isOpen));
    });
    document.addEventListener('click', closeDropdown);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && dropdown.classList.contains('show')) {
        closeDropdown();
        trigger.focus();
      }
    });

    guestActions.querySelectorAll('[data-auth-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (typeof window.showModalLogin === 'function') {
          window.showModalLogin(button.dataset.authTab);
        } else {
          window.location.href = '/admin-panel';
        }
      });
    });

    var logoutButton = document.getElementById('siteLogout');
    if (logoutButton) {
      logoutButton.addEventListener('click', function () {
        closeDropdown();
        if (auth) auth.logout();
        renderUser(null);
        window.location.reload();
      });
    }

    if (auth) {
      window.addEventListener('authChanged', function () {
        renderUser(auth.getCurrentUser());
      });
      window.addEventListener('storage', function (event) {
        if (event.key === auth.tokenKey || event.key === auth.userKey) refreshUser();
      });
    }
    refreshUser();
  }

  function setMetaContent(selector, attribute, content) {
    var meta = document.head.querySelector(selector);
    if (meta) meta.setAttribute(attribute, content);
  }

  function updateArticleMetadata(article) {
    var title = (article.title || article.slug) + ' — Antropedia';
    var description = String(article.excerpt || 'Открытая статья Antropedia — энциклопедии AllTell.').slice(0, 300);
    var canonical = new URL('/antropedia/' + encodeURIComponent(article.slug), window.location.origin).href;
    var image = safePublicImageUrl(article.image);
    document.title = title;
    setMetaContent('meta[name="description"]', 'content', description);
    setMetaContent('meta[property="og:title"]', 'content', title);
    setMetaContent('meta[property="og:description"]', 'content', description);
    setMetaContent('meta[property="og:url"]', 'content', canonical);
    setMetaContent('meta[property="og:image"]', 'content', image);
    setMetaContent('meta[name="twitter:title"]', 'content', title);
    setMetaContent('meta[name="twitter:description"]', 'content', description);
    setMetaContent('meta[name="twitter:image"]', 'content', image);
    var canonicalLink = document.head.querySelector('link[rel="canonical"]');
    if (canonicalLink) canonicalLink.href = canonical;
  }

  // Градиенты обложек из исходного макета — карточка без картинки берёт один из
  // них по хэшу slug, чтобы каталог не превращался в одинаковые серые плитки.
  var COVER_GRADIENTS = [
    'linear-gradient(135deg,#5865f2,#8b93f8)',
    'linear-gradient(135deg,#a78bfa,#ff5d8f)',
    'linear-gradient(135deg,#2dd4bf,#5865f2)',
    'linear-gradient(135deg,#ff9f5a,#ff5d8f)',
    'linear-gradient(135deg,#5865f2,#2dd4bf)',
    'linear-gradient(135deg,#ff5d8f,#a78bfa)',
    'linear-gradient(135deg,#2dd4bf,#ff9f5a)',
    'linear-gradient(135deg,#a78bfa,#5865f2)'
  ];

  function coverGradient(slug) {
    var hash = 0;
    String(slug || '').split('').forEach(function (ch) { hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; });
    return COVER_GRADIENTS[hash % COVER_GRADIENTS.length];
  }

  // 5100 -> «5.1k», как в макете.
  function formatCount(value) {
    var n = Number(value) || 0;
    if (n < 1000) return String(n);
    if (n < 10000) return (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k';
    if (n < 1000000) return Math.round(n / 1000) + 'k';
    return (Math.round(n / 100000) / 10).toString().replace(/\.0$/, '') + 'M';
  }

  function formatDate(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function initPublicAntropedia() {
    if (document.body.getAttribute('data-page') !== 'antropedia') return;
    var main = document.querySelector('.site-main');
    var hero = document.querySelector('.site-hero');
    var listView = document.getElementById('publicArticleListView');
    var detail = document.getElementById('publicArticleDetail');
    var input = document.getElementById('publicArticleSearch');
    if (!main || !listView || !detail || !input) return;
    main.hidden = false;

    var grid = document.getElementById('publicArticleGrid');
    var status = document.getElementById('publicArticleStatus');
    var emptyEl = document.getElementById('pubEmpty');
    var loadingMoreEl = document.getElementById('pubLoadingMore');
    var sentinel = document.getElementById('pubSentinel');
    var loadMore = document.getElementById('pubLoadMore');
    var sortEl = document.getElementById('pubSort');
    var dateFromEl = document.getElementById('pubDateFrom');
    var dateToEl = document.getElementById('pubDateTo');
    var filtersToggle = document.getElementById('pubFiltersToggle');
    var filtersPanel = document.getElementById('pubFiltersPanel');
    var filtersCountEl = document.getElementById('pubFiltersCount');
    var SORTS = ['newest', 'oldest', 'updated', 'views', 'alpha'];

    var params = new URLSearchParams(window.location.search);
    var state = {
      offset: 0,
      total: 0,
      generation: 0,
      loading: false,
      hasMore: true,
      controller: null,
      disposed: false,
      slug: null,
      view: 'grid',
      tagField: null
    };
    try { state.view = localStorage.getItem('publicAntropediaView') === 'list' ? 'list' : 'grid'; } catch (error) { /* приватный режим */ }

    input.value = params.get('q') || '';
    if (SORTS.indexOf(params.get('sort')) !== -1) sortEl.value = params.get('sort');
    dateFromEl.value = params.get('from') || '';
    dateToEl.value = params.get('to') || '';

    var pathMatch = window.location.pathname.match(/^\/antropedia\/([^/]+)\/?$/);
    if (pathMatch) {
      try {
        state.slug = decodeURIComponent(pathMatch[1]);
      } catch (error) {
        state.slug = pathMatch[1];
      }
    }
    if (hero) hero.hidden = !!state.slug;

    function readListReturn() {
      try {
        var saved = JSON.parse(sessionStorage.getItem(ARTICLE_LIST_RETURN_KEY) || 'null');
        if (!saved || typeof saved.url !== 'string' || !Number.isFinite(saved.scrollY) ||
            !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > 30 * 60 * 1000) return null;
        return saved;
      } catch (error) {
        return null;
      }
    }

    function writeListReturn(saved) {
      try {
        sessionStorage.setItem(ARTICLE_LIST_RETURN_KEY, JSON.stringify(saved));
      } catch (error) {
        console.warn('Не удалось сохранить позицию списка статей:', error);
      }
    }

    function clearListReturn() {
      try {
        sessionStorage.removeItem(ARTICLE_LIST_RETURN_KEY);
      } catch (error) {
        console.warn('Не удалось очистить сохранённую позицию списка статей:', error);
      }
    }

    var pendingListRestore = null;
    if (!state.slug && window.location.hash === ARTICLE_LIST_RETURN_HASH) {
      var savedListPosition = readListReturn();
      var currentListUrl = window.location.pathname + window.location.search;
      if (savedListPosition && savedListPosition.url === currentListUrl) {
        pendingListRestore = savedListPosition;
      } else {
        clearListReturn();
      }
      history.replaceState(history.state || {}, '', currentListUrl);
    } else if (!state.slug && window.history.state && Number.isFinite(window.history.state.publicSiteScrollY)) {
      pendingListRestore = {
        url: window.location.pathname + window.location.search,
        scrollY: window.history.state.publicSiteScrollY
      };
    }

    function restoreArticleListPosition() {
      if (!pendingListRestore) return;
      var maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (maxScroll < pendingListRestore.scrollY && state.hasMore) {
        setTimeout(function () { loadArticles(true); }, 0);
        return;
      }
      window.scrollTo({
        top: Math.min(pendingListRestore.scrollY, maxScroll),
        left: 0,
        behavior: 'instant'
      });
      pendingListRestore = null;
      clearListReturn();
    }

    updateAdminLinks(state.slug);

    // ---------- Фильтры ----------

    function getFilters() {
      return {
        q: input.value.trim(),
        tags: state.tagField ? state.tagField.getValues() : [],
        sort: sortEl.value || 'newest',
        from: dateFromEl.value,
        to: dateToEl.value
      };
    }

    function hasActiveFilters() {
      var f = getFilters();
      return !!(f.q || f.tags.length || f.from || f.to || f.sort !== 'newest');
    }

    function updateSearchUrl() {
      var f = getFilters();
      var next = new URL(window.location.href);
      function put(key, value) {
        if (value) next.searchParams.set(key, value);
        else next.searchParams.delete(key);
      }
      put('q', f.q);
      put('tag', f.tags.join(','));
      put('sort', f.sort !== 'newest' ? f.sort : '');
      put('from', f.from);
      put('to', f.to);
      window.history.replaceState(window.history.state || {}, '', next.pathname + next.search);
    }

    // Счётчик на кнопке «Фильтры · N» — сколько полей панели заполнено
    // (диапазон дат считается одним полем; поиск и сортировка вне панели).
    function updateFiltersCount() {
      var f = getFilters();
      var n = 0;
      if (f.tags.length) n++;
      if (f.from || f.to) n++;
      filtersCountEl.hidden = n === 0;
      filtersCountEl.textContent = String(n);
    }

    function setFiltersOpen(open) {
      filtersPanel.classList.toggle('is-open', open);
      filtersToggle.classList.toggle('is-open', open);
      filtersToggle.setAttribute('aria-expanded', String(open));
    }
    // На телефоне панель по умолчанию свёрнута; на планшете/десктопе кнопки нет,
    // панель всегда видна (см. site.css).
    setFiltersOpen(!window.matchMedia('(max-width: 640px)').matches);
    filtersToggle.addEventListener('click', function () {
      setFiltersOpen(!filtersPanel.classList.contains('is-open'));
    });

    function applyView() {
      grid.classList.toggle('is-list', state.view === 'list');
      document.querySelectorAll('.pub-view-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === state.view);
      });
    }
    applyView();
    document.querySelectorAll('.pub-view-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.getAttribute('data-view') === 'list' ? 'list' : 'grid';
        try { localStorage.setItem('publicAntropediaView', state.view); } catch (error) { /* не запомнится */ }
        applyView();
      });
    });

    // ---------- Карточки ----------

    function makeStat(iconClass, count, label, extraClass) {
      var item = document.createElement('span');
      item.className = 'engage-item' + (extraClass ? ' ' + extraClass : '');
      item.title = label;
      var icon = document.createElement('i');
      icon.className = iconClass;
      icon.setAttribute('aria-hidden', 'true');
      var value = document.createElement('span');
      value.textContent = formatCount(count);
      item.append(icon, value);
      return item;
    }

    function makeEngageButton(iconClass, count, label, extraClass) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'engage-item' + (extraClass ? ' ' + extraClass : '');
      item.title = label;
      item.setAttribute('aria-label', label);
      var icon = document.createElement('i');
      icon.className = iconClass;
      icon.setAttribute('aria-hidden', 'true');
      var value = document.createElement('span');
      value.textContent = formatCount(count);
      item.append(icon, value);
      return item;
    }

    function createCardReactionBar(article, user) {
      var bar = createReactionBar(article.slug, 'article', article.slug, article.reactions || [], user, function (reactions) {
        article.reactions = reactions;
        var replacement = createCardReactionBar(article, user);
        bar.replaceWith(replacement);
        bar = replacement;
      });
      bar.classList.add('public-card-reactions');
      return bar;
    }

    function createArticleCard(article) {
      var href = '/antropedia/' + encodeURIComponent(article.slug);
      var card = document.createElement('article');
      card.className = 'wiki-card public-wiki-card';

      var cover = document.createElement('a');
      cover.className = 'wiki-card-cover';
      cover.href = href;
      cover.tabIndex = -1;
      cover.setAttribute('aria-hidden', 'true');
      var imageUrl = safePublicImageUrl(article.image);
      if (imageUrl) {
        var image = document.createElement('img');
        image.src = imageUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', function () {
          image.remove();
          cover.classList.add('is-empty');
          cover.style.setProperty('--cover-grad', coverGradient(article.slug));
          var fallback = document.createElement('i');
          fallback.className = 'fas fa-book-open';
          cover.appendChild(fallback);
        });
        cover.appendChild(image);
      } else {
        cover.classList.add('is-empty');
        cover.style.setProperty('--cover-grad', coverGradient(article.slug));
        var icon = document.createElement('i');
        icon.className = 'fas fa-book-open';
        icon.setAttribute('aria-hidden', 'true');
        cover.appendChild(icon);
      }
      card.appendChild(cover);

      var body = document.createElement('div');
      body.className = 'wiki-card-body';

      // Заголовок — ссылка, растянутая на всю карточку (см. .public-card-link::after):
      // карточка кликабельна целиком, а кнопки тегов лежат поверх неё.
      var link = document.createElement('a');
      link.className = 'public-card-link';
      link.href = href;
      var title = document.createElement('div');
      title.className = 'wiki-card-title';
      title.textContent = article.title || article.slug;
      link.appendChild(title);
      body.appendChild(link);

      if (article.excerpt) {
        var excerpt = document.createElement('div');
        excerpt.className = 'wiki-card-excerpt';
        excerpt.textContent = article.excerpt;
        body.appendChild(excerpt);
      }

      if (Array.isArray(article.tags) && article.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'wiki-card-tags public-wiki-card-tags';
        article.tags.forEach(function (tag) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'wiki-tag';
          button.textContent = '#' + tag;
          button.title = 'Показать статьи с тегом «' + tag + '»';
          button.addEventListener('click', function () {
            if (state.tagField) {
              state.tagField.addValue(tag);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          });
          tags.appendChild(button);
        });
        body.appendChild(tags);
      }

      var date = formatDate(article.created_at);
      if ((article.author && article.author.display_name) || date) {
        var meta = document.createElement('div');
        meta.className = 'public-card-meta public-card-details';
        if (article.author && article.author.display_name) {
          var author = article.author;
          var authorImage = safePublicImageUrl(author.avatar);
          var authorLink = author.id != null ? document.createElement('a') : document.createElement('span');
          authorLink.className = 'public-card-author';
          if (author.id != null) {
            authorLink.href = '/profile/' + encodeURIComponent(author.id);
            authorLink.setAttribute('aria-label', 'Профиль: ' + author.display_name);
          }
          if (authorImage) {
            var avatar = document.createElement('img');
            avatar.src = authorImage;
            avatar.alt = '';
            avatar.width = 28;
            avatar.height = 28;
            avatar.loading = 'lazy';
            avatar.decoding = 'async';
            authorLink.appendChild(avatar);
          } else {
            authorLink.appendChild(makeEl('span', 'public-card-author-avatar', author.display_name.trim().charAt(0).toUpperCase() || '?'));
          }
          authorLink.appendChild(makeEl('span', 'public-card-author-name', author.display_name));
          meta.appendChild(authorLink);
        }
        if (date) {
          var dateMeta = makeEl('span', 'public-card-date');
          var calendar = document.createElement('i');
          calendar.className = 'far fa-calendar';
          calendar.setAttribute('aria-hidden', 'true');
          dateMeta.append(calendar, document.createTextNode(' ' + date));
          meta.appendChild(dateMeta);
        }
        body.appendChild(meta);
      }

      var foot = document.createElement('div');
      foot.className = 'wiki-card-foot';
      var group = document.createElement('div');
      group.className = 'engage-group';
      var likeButton = makeEngageButton('far fa-heart', article.likesCount, 'Нравится', 'is-like');
      likeButton.classList.toggle('active', !!article.liked);
      likeButton.querySelector('i').className = article.liked ? 'fas fa-heart' : 'far fa-heart';
      likeButton.addEventListener('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!getAuthToken()) {
          openLogin();
          return;
        }
        likeButton.disabled = true;
        try {
          var result = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/likes/toggle', 'POST');
          likeButton.classList.toggle('active', !!result.liked);
          likeButton.querySelector('i').className = result.liked ? 'fas fa-heart' : 'far fa-heart';
          likeButton.querySelector('span').textContent = formatCount(result.count);
        } catch (error) {
          window.alert(error.message || 'Не удалось поставить лайк');
        } finally {
          likeButton.disabled = false;
        }
      });
      var commentsLink = document.createElement('a');
      commentsLink.className = 'engage-item is-comment';
      commentsLink.href = '/antropedia/' + encodeURIComponent(article.slug) + '#publicArticleComments';
      commentsLink.title = 'Открыть комментарии';
      commentsLink.append(
        makeEl('i', 'far fa-comment'),
        makeEl('span', null, formatCount(article.commentsCount))
      );
      group.append(likeButton, commentsLink);
      foot.append(group, makeStat('far fa-eye', article.viewsCount, 'Просмотры'));
      body.appendChild(foot);
      body.appendChild(createCardReactionBar(article, getAuthToken() ? {} : null));

      card.appendChild(body);
      return card;
    }

    function renderSkeletons() {
      for (var i = 0; i < 6; i++) {
        var el = document.createElement('div');
        el.className = 'pub-skeleton';
        grid.appendChild(el);
      }
    }

    // ---------- Загрузка списка ----------

    function updateStatus() {
      if (state.loading && state.offset === 0) {
        status.textContent = 'Загружаем открытые статьи…';
      } else if (state.total > 0) {
        var shown = grid.querySelectorAll('.public-wiki-card').length;
        status.textContent = 'Показано ' + shown + ' из ' + state.total;
      } else {
        status.textContent = '';
      }
    }

    async function loadArticles(append) {
      if (state.disposed) return;
      if (append && (state.loading || !state.hasMore)) return;
      if (!append && state.controller) state.controller.abort();
      state.loading = true;
      var generation = ++state.generation;
      var controller = new AbortController();
      state.controller = controller;

      if (!append) {
        state.offset = 0;
        state.hasMore = true;
        state.total = 0;
        grid.replaceChildren();
        emptyEl.hidden = true;
        renderSkeletons();
      } else {
        loadingMoreEl.hidden = false;
      }
      updateStatus();
      loadMore.disabled = true;

      var f = getFilters();
      var query = new URLSearchParams({
        limit: String(PUBLIC_PAGE_SIZE),
        offset: String(append ? state.offset : 0),
        sort: f.sort
      });
      if (f.q) query.set('q', f.q);
      if (f.tags.length) query.set('tag', f.tags.join(','));
      if (f.from) query.set('dateFrom', f.from);
      if (f.to) query.set('dateTo', f.to);
      var token = getAuthToken();
      var authenticated = !!token;
      var endpoint = authenticated ? '/api/articles/browse?' : PUBLIC_ARTICLES_API + '?';

      try {
        var response = await fetch(endpoint + query.toString(), {
          credentials: 'omit',
          headers: authenticated ? { Authorization: 'Bearer ' + token } : {},
          signal: controller.signal
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
        if (state.disposed || generation !== state.generation) return;
        var articles = Array.isArray(result.data) ? result.data : [];
        if (!append) grid.replaceChildren();
        grid.querySelectorAll('.pub-skeleton').forEach(function (el) { el.remove(); });
        articles.forEach(function (article) {
          grid.appendChild(createArticleCard(article));
        });
        state.offset = (append ? state.offset : 0) + articles.length;
        state.total = Number(result.total) || 0;
        state.hasMore = articles.length > 0 && state.offset < state.total;
        loadMore.hidden = !state.hasMore || 'IntersectionObserver' in window;

        var isEmpty = state.total === 0;
        emptyEl.hidden = !isEmpty;
        if (isEmpty) {
          var filtered = hasActiveFilters();
          emptyEl.querySelector('p').textContent = filtered
            ? 'Ничего не найдено по текущим фильтрам.'
            : (authenticated ? 'Доступных статей пока нет.' : 'Публичных статей пока нет.');
          document.getElementById('pubEmptyReset').hidden = !filtered;
        }
        restoreArticleListPosition();
      } catch (error) {
        if (state.disposed) return;
        if (error && error.name === 'AbortError') return;
        if (generation !== state.generation) return;
        if (!append) grid.replaceChildren();
        grid.querySelectorAll('.pub-skeleton').forEach(function (el) { el.remove(); });
        grid.appendChild(makePublicMessage('Не удалось загрузить статьи. Проверьте соединение и попробуйте ещё раз.'));
        state.hasMore = false;
        loadMore.hidden = true;
        if (pendingListRestore) {
          pendingListRestore.scrollY = Math.min(
            pendingListRestore.scrollY,
            Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
          );
          restoreArticleListPosition();
        }
      } finally {
        if (!state.disposed && generation === state.generation) {
          state.loading = false;
          loadMore.disabled = false;
          loadingMoreEl.hidden = true;
          updateStatus();
          // Если после загрузки метка конца списка всё ещё на виду (мало
          // карточек / высокий экран) — IntersectionObserver сам не сработает.
          if (!pendingListRestore && state.hasMore && sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
            setTimeout(function () { loadArticles(true); }, 0);
          }
        }
      }
    }

    // Любое изменение поиска/фильтров/сортировки — перезагрузка с первой страницы.
    function applyFilters() {
      updateFiltersCount();
      updateSearchUrl();
      loadArticles(false);
    }

    function resetFilters() {
      if (state.tagField) state.tagField.setValues([]);
      dateFromEl.value = '';
      dateToEl.value = '';
      sortEl.value = 'newest';
      input.value = '';
      applyFilters();
    }

    async function openRandomArticle() {
      var button = document.getElementById('pubRandomBtn');
      if (!state.total || button.disabled) return;
      button.disabled = true;
      try {
        var f = getFilters();
        var query = new URLSearchParams({
          limit: '1',
          offset: String(Math.floor(Math.random() * state.total)),
          sort: f.sort
        });
        if (f.q) query.set('q', f.q);
        if (f.tags.length) query.set('tag', f.tags.join(','));
        if (f.from) query.set('dateFrom', f.from);
        if (f.to) query.set('dateTo', f.to);
        var token = getAuthToken();
        var response = await fetch((token ? '/api/articles/browse?' : PUBLIC_ARTICLES_API + '?') + query.toString(), {
          credentials: 'omit',
          headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
        var pick = Array.isArray(result.data) && result.data[0];
        if (pick) {
          saveArticleListPosition(pick.slug);
          window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(pick.slug));
        }
      } catch (error) {
        status.textContent = 'Не удалось выбрать случайную статью — попробуйте ещё раз.';
      } finally {
        button.disabled = false;
      }
    }

    async function loadTagOptions() {
      try {
        var token = getAuthToken();
        var response = await fetch(token ? '/api/tags' : '/api/public/tags', {
          credentials: 'omit',
          headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (!response.ok) return;
        var result = await response.json();
        var tags = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : [];
        if (state.tagField) {
          state.tagField.setOptions(tags.map(function (item) { return { value: item.tag, label: item.tag }; }));
        }
      } catch (error) {
        // Фильтр по тегам останется без подсказок — не критично.
      }
    }

    // ---------- Просмотр статьи ----------

    async function loadPublicIndex(article) {
      var index = new Map([[article.slug, { slug: article.slug, title: article.title || article.slug, tags: article.tags || [] }]]);
      var restrictedSlugs = new Set();
      try {
        var token = getAuthToken();
        var response = await fetch(token ? '/api/articles-index' : '/api/public/articles-index', {
          credentials: 'omit',
          headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (response.ok) {
          var result = await response.json();
          var items = token ? result.accessible : result.data;
          (Array.isArray(items) ? items : []).forEach(function (item) {
            if (item && item.slug && item.slug !== article.slug) index.set(item.slug, item);
          });
          if (token && Array.isArray(result.restrictedSlugs)) restrictedSlugs = new Set(result.restrictedSlugs);
        }
      } catch (error) {
        // Без индекса ссылки покажутся как «Недоступно» — текст статьи не страдает.
      }
      return { index: index, restrictedSlugs: restrictedSlugs, authenticated: !!getAuthToken() };
    }

    function createReactionBar(slug, targetType, targetId, reactions, user, onChange) {
      var bar = makeEl('div', 'pub-reactions');
      (reactions || []).forEach(function (reaction) {
        var button = makeEl('button', 'pub-reaction-pill' + (reaction.reacted ? ' active' : ''));
        button.type = 'button';
        button.title = reaction.packTitle || reaction.shortcode;
        button.setAttribute('aria-label', 'Реакция ' + (reaction.packTitle || reaction.shortcode) + ', ' + reaction.count);
        var image = document.createElement('img');
        var imageUrl = safePublicImageUrl(reaction.url);
        if (!imageUrl) return;
        image.src = imageUrl;
        image.alt = '';
        image.loading = 'lazy';
        button.append(image, makeEl('span', null, String(reaction.count || 0)));
        button.addEventListener('click', function () {
          if (!user) { openLogin(); return; }
          changeReaction(reaction.shortcode);
        });
        bar.appendChild(button);
      });

      var add = makeEl('button', 'pub-reaction-add');
      add.type = 'button';
      add.title = 'Добавить реакцию';
      add.setAttribute('aria-label', 'Добавить реакцию');
      add.innerHTML = '<i class="far fa-face-smile" aria-hidden="true"></i>';
      add.addEventListener('click', function () {
        if (!user) { openLogin(); return; }
        if (window.PublicStickerPicker) {
          window.PublicStickerPicker.open(add, function (shortcode) {
            changeReaction(shortcode.replace(/^:+|:+$/g, ''));
          });
        }
      });
      bar.appendChild(add);

      async function changeReaction(shortcode) {
        var code = String(shortcode || '').trim().replace(/^:+|:+$/g, '').toLowerCase();
        if (!/^[a-z0-9-]{1,80}:[a-z0-9-]{1,80}$/.test(code)) {
          window.alert('Не удалось определить стикер. Выберите его из набора ещё раз.');
          return;
        }
        try {
          var path = '/api/articles/' + encodeURIComponent(slug);
          if (targetType === 'comment') path += '/comments/' + encodeURIComponent(targetId);
          var result = await authenticatedRequest(path + '/reactions/toggle', 'POST', { shortcode: code });
          if (onChange) onChange(result.reactions || []);
        } catch (error) {
          window.alert(error.message || 'Не удалось изменить реакцию');
        }
      }
      return bar;
    }

    function initArticleEngagement(article, container, userPromise) {
      var panel = makeEl('div', 'pub-article-engagement');
      var actions = makeEl('div', 'pub-article-engagement-actions');
      var like = makeEngageButton('far fa-heart', article.likesCount, 'Нравится', 'is-like');
      var comments = makeEngageButton('far fa-comment', article.commentsCount, 'Комментарии', 'is-comment');
      var currentUser = null;
      var reactionBar;

      like.addEventListener('click', async function () {
        if (!currentUser) { openLogin(); return; }
        like.disabled = true;
        try {
          var result = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/likes/toggle', 'POST');
          like.classList.toggle('active', !!result.liked);
          like.querySelector('i').className = result.liked ? 'fas fa-heart' : 'far fa-heart';
          like.querySelector('span').textContent = String(result.count || 0);
        } catch (error) {
          window.alert(error.message || 'Не удалось поставить лайк');
        } finally {
          like.disabled = false;
        }
      });
      comments.addEventListener('click', function () {
        var section = document.getElementById('publicArticleComments');
        if (!section) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (currentUser) {
          var input = section.querySelector('.pub-comment-input');
          if (input) input.focus({ preventScroll: true });
        }
      });
      function updateReactions(updated) {
        var replacement = createReactionBar(article.slug, 'article', article.slug, updated, currentUser, updateReactions);
        if (reactionBar) reactionBar.replaceWith(replacement);
        else actions.appendChild(replacement);
        reactionBar = replacement;
      }

      actions.appendChild(like);
      updateReactions([]);
      actions.appendChild(comments);
      panel.appendChild(actions);
      container.appendChild(panel);
      userPromise.then(async function (user) {
        currentUser = user;
        updateReactions([]);
        if (!user) return;
        try {
          var summary = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/likes');
          like.classList.toggle('active', !!summary.liked);
          like.querySelector('i').className = summary.liked ? 'fas fa-heart' : 'far fa-heart';
          like.querySelector('span').textContent = String(summary.count || 0);
        } catch (error) {
          console.error('Не удалось загрузить лайк статьи:', error);
        }
        try {
          var result = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/reactions');
          updateReactions(result.reactions || []);
        } catch (error) {
          console.error('Не удалось загрузить реакции статьи:', error);
        }
      });
    }

    function renderDetail(article) {
      listView.hidden = true;
      detail.hidden = false;
      detail.replaceChildren();
      updateAdminLinks(article.slug);

      var back = document.createElement('a');
      back.className = 'public-article-back';
      back.href = '/antropedia';
      back.textContent = '← Все статьи';
      var toolbar = makeEl('div', 'public-article-detail-toolbar');
      toolbar.appendChild(back);
      var listReturn = readListReturn();
      if (listReturn && listReturn.currentSlug === article.slug) {
        back.href = listReturn.url + ARTICLE_LIST_RETURN_HASH;
      }
      if (article.can_edit) {
        var adminLink = makeEl('a', 'public-article-admin-link');
        adminLink.href = '/admin-panel/antropedia/' + encodeURIComponent(article.slug);
        adminLink.appendChild(makeEl('i', 'fas fa-arrow-up-right-from-square'));
        adminLink.appendChild(document.createTextNode('Открыть в админ панели'));
        toolbar.appendChild(adminLink);
      }
      detail.appendChild(toolbar);

      var coverUrl = safePublicImageUrl(article.image);
      if (coverUrl) {
        var cover = makeEl('figure', 'public-article-cover');
        var coverImage = document.createElement('img');
        coverImage.src = coverUrl;
        coverImage.alt = '';
        coverImage.addEventListener('error', function () { cover.remove(); });
        cover.appendChild(coverImage);
        detail.appendChild(cover);
      }

      var title = document.createElement('h1');
      title.className = 'public-article-title';
      title.textContent = article.title || article.slug;
      detail.appendChild(title);
      var meta = makeEl('div', 'public-article-meta');
      if (article.author && article.author.display_name) {
        var author = article.author;
        var authorLabel = makeEl('span', 'public-article-author');
        var authorImage = safePublicImageUrl(author.avatar);
        if (author.id != null) {
          var authorLink = document.createElement('a');
          authorLink.className = 'public-article-author-link';
          authorLink.href = '/profile/' + encodeURIComponent(author.id);
          if (authorImage) {
            var avatar = document.createElement('img');
            avatar.src = authorImage;
            avatar.alt = '';
            avatar.width = 44;
            avatar.height = 44;
            avatar.loading = 'lazy';
            avatar.decoding = 'async';
            authorLink.appendChild(avatar);
          } else {
            authorLink.appendChild(makeEl('span', 'public-article-author-avatar', author.display_name.trim().charAt(0).toUpperCase() || '?'));
          }
          authorLink.appendChild(makeEl('span', null, author.display_name));
          authorLabel.appendChild(authorLink);
        } else {
          authorLabel.appendChild(makeEl('span', 'public-article-author-name', author.display_name));
        }
        meta.appendChild(authorLabel);
      }
      var created = formatDate(article.created_at);
      if (created) meta.appendChild(makeEl('span', 'public-article-date', created));
      if (meta.childNodes.length) detail.appendChild(meta);
      if (article.excerpt) {
        var excerpt = document.createElement('p');
        excerpt.className = 'public-article-excerpt';
        excerpt.textContent = article.excerpt;
        detail.appendChild(excerpt);
      }
      if (Array.isArray(article.tags) && article.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'wiki-card-tags public-article-tags';
        article.tags.forEach(function (tag) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'wiki-tag';
          button.textContent = tag;
          button.addEventListener('click', function () {
            window.PublicSite.navigateTo('/antropedia?tag=' + encodeURIComponent(tag));
          });
          tags.appendChild(button);
        });
        detail.appendChild(tags);
      }

      var userPromise = loadCurrentUser();
      initArticleEngagement(article, detail, userPromise);

      var content = document.createElement('div');
      content.className = 'preview-pane public-article-content';
      detail.appendChild(content);
      // Индекс открытых статей — по нему рендерер узнаёт цели вики-ссылок.
      // Без него каждая ссылка на другую статью выглядела как «создать».
      // Остальные цели (закрытые/несуществующие) для гостя одинаково
      // «Недоступно», без приглашения создавать статью и без раскрытия
      // того, существует ли она.
      loadPublicIndex(article).then(function (indexData) {
        if (typeof window.renderArticleBlocks !== 'function') throw new Error('Block renderer is unavailable');
        var restricted = indexData.authenticated ? indexData.restrictedSlugs : { has: function () { return true; } };
        return window.renderArticleBlocks(article.content, indexData.index, restricted);
      }).then(function (html) {
        content.innerHTML = html;
        content.querySelectorAll('a[data-slug]').forEach(function (link) {
          link.href = '/antropedia/' + encodeURIComponent(link.dataset.slug);
        });
        content.addEventListener('click', function (event) {
          var wikiLink = event.target.closest('a[data-slug]');
          if (wikiLink) return;
          var tagLink = event.target.closest('[data-tag]');
          if (tagLink) {
            window.PublicSite.navigateTo('/antropedia?tag=' + encodeURIComponent(tagLink.dataset.tag));
          }
        });
      }).catch(function () {
        content.replaceChildren(makePublicMessage('Не удалось отобразить содержимое статьи.'));
      });
      initComments(article, detail, userPromise).catch(function () { /* комментарии не критичны для чтения статьи */ });
      updateArticleMetadata(article);
    }

    // ---------- Комментарии ----------
    // Читать комментарии открытой статьи может любой (гостевой endpoint).
    // Поле ввода, «Ответить» и удаление появляются только у залогиненного
    // пользователя: токен берётся из localStorage (тот же, что у админ-панели) и
    // проверяется запросом /api/profile. Сами записи идут через авторизованные
    // /api/articles/:slug/comments — права, мут и доступ проверяет сервер.

    var AUTH_TOKEN_KEY = 'alltell_auth_token';
    var COMMENT_MAX_LEN = 2000;
    var STICKER_RE = /:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):/g;
    var STICKER_SOLO_RE = /^:([a-zA-Z0-9-]{1,80}):([a-zA-Z0-9-]{1,80}):$/;

    function getAuthToken() {
      try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (error) { return ''; }
    }

    // Возвращает пользователя или null (нет токена / токен просрочен / не одобрен).
    async function loadCurrentUser() {
      var token = getAuthToken();
      if (!token) return null;
      try {
        var response = await fetch('/api/profile', { headers: { Authorization: 'Bearer ' + token } });
        if (!response.ok) return null;
        var data = await response.json();
        return (data && data.user) || null;
      } catch (error) {
        return null;
      }
    }

    function openLogin() {
      if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
      else window.location.href = '/admin-panel';
    }

    async function authenticatedRequest(path, method, body) {
      var headers = { Authorization: 'Bearer ' + getAuthToken() };
      var options = { method: method || 'GET', headers: headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      var response = await fetch(path, options);
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || 'Ошибка запроса (' + response.status + ')');
      return data;
    }

    function makeEl(tag, className, text) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      if (text != null) el.textContent = text;
      return el;
    }

    function makeStickerImg(sticker, code, solo) {
      var src = sticker && safePublicImageUrl(sticker.url);
      if (!src) return null;
      var img = document.createElement('img');
      img.className = solo ? 'pub-comment-sticker-solo' : 'pub-comment-sticker';
      img.src = src;
      img.alt = code;
      img.title = code;
      img.loading = 'lazy';
      return img;
    }

    // Текст комментария: только textContent и <img> стикеров — HTML из комментария
    // никогда не вставляется. Шорткод без найденного стикера остаётся текстом.
    function renderCommentBody(comment) {
      var body = makeEl('div', 'pub-comment-body');
      var raw = String(comment.content || '');
      var stickers = comment.stickers || {};
      var solo = raw.trim().match(STICKER_SOLO_RE);
      if (solo) {
        var soloCode = solo[1].toLowerCase() + ':' + solo[2].toLowerCase();
        var soloImg = makeStickerImg(stickers[soloCode], soloCode, true);
        if (soloImg) { body.appendChild(soloImg); return body; }
      }
      var last = 0;
      raw.replace(STICKER_RE, function (match, pack, alias, offset) {
        var code = pack.toLowerCase() + ':' + alias.toLowerCase();
        var img = makeStickerImg(stickers[code], code, false);
        if (!img) return match;
        if (offset > last) body.appendChild(document.createTextNode(raw.slice(last, offset)));
        body.appendChild(img);
        last = offset + match.length;
        return match;
      });
      if (last < raw.length) body.appendChild(document.createTextNode(raw.slice(last)));
      return body;
    }

    function makeAvatar(comment, size) {
      var wrap = makeEl('span', 'pub-comment-avatar');
      wrap.style.width = size + 'px';
      wrap.style.height = size + 'px';
      var src = comment.authorAvatar && safePublicImageUrl(comment.authorAvatar);
      if (src) {
        var img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.width = size;
        img.height = size;
        img.loading = 'lazy';
        img.decoding = 'async';
        wrap.appendChild(img);
      } else {
        wrap.textContent = String(comment.authorName || '?').trim().charAt(0).toUpperCase() || '?';
      }
      return wrap;
    }

    function serializeComposerInput(root) {
      function serializeNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        if (node.tagName === 'BR') return '\n';
        if (node.tagName === 'IMG') return node.getAttribute('data-shortcode') || '';
        var text = Array.from(node.childNodes).map(serializeNode).join('');
        if (node.tagName === 'DIV' || node.tagName === 'P') return text + '\n';
        return text;
      }
      return Array.from(root.childNodes).map(serializeNode).join('').replace(/\n+$/, '');
    }

    function insertComposerSticker(input, shortcode, imageUrl) {
      var code = String(shortcode || '').trim();
      if (!code) return;
      code = code.replace(/^:+|:+$/g, '').toLowerCase();
      if (!/^[a-z0-9-]{1,80}:[a-z0-9-]{1,80}$/.test(code)) {
        console.error('Некорректный шорткод стикера:', shortcode);
        return;
      }
      code = ':' + code + ':';
      var selection = window.getSelection();
      var range = input._savedRange && input.contains(input._savedRange.startContainer)
        ? input._savedRange.cloneRange()
        : null;
      if (!range && selection && selection.rangeCount && input.contains(selection.anchorNode)) {
        range = selection.getRangeAt(0).cloneRange();
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
      }
      range.deleteContents();
      var image = document.createElement('img');
      image.className = 'pub-comment-sticker-chip';
      image.src = imageUrl;
      image.alt = code;
      image.title = code;
      image.setAttribute('data-shortcode', code);
      image.setAttribute('contenteditable', 'false');
      range.insertNode(image);
      var spacer = document.createTextNode('\u00a0');
      image.parentNode.insertBefore(spacer, image.nextSibling);
      range.setStartAfter(spacer);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      input._savedRange = range.cloneRange();
      input.focus();
    }

    // Редактируемое поле показывает выбранные стикеры картинками; перед
    // отправкой изображения сериализуются обратно в поддерживаемый сервером шорткод.
    function createComposer(placeholder, onSubmit, onCancel) {
      var form = makeEl('form', 'pub-comment-form');
      var input = makeEl('div', 'pub-comment-input');
      input.contentEditable = 'true';
      input.setAttribute('role', 'textbox');
      input.setAttribute('aria-multiline', 'true');
      input.className = 'pub-comment-input';
      input.dataset.placeholder = placeholder;
      input.setAttribute('aria-label', placeholder);
      input.addEventListener('blur', function () {
        var selection = window.getSelection();
        if (selection && selection.rangeCount && input.contains(selection.anchorNode)) {
          input._savedRange = selection.getRangeAt(0).cloneRange();
        }
      });
      var actions = makeEl('div', 'pub-comment-form-actions');
      var error = makeEl('span', 'pub-comment-error');
      error.setAttribute('role', 'alert');
      actions.appendChild(error);
      var stickerButton = makeEl('button', 'btn btn-secondary btn-sm pub-comment-sticker-trigger');
      stickerButton.type = 'button';
      stickerButton.title = 'Добавить стикер';
      stickerButton.setAttribute('aria-label', 'Добавить стикер');
      stickerButton.innerHTML = '<i class="far fa-face-smile" aria-hidden="true"></i>';
      stickerButton.addEventListener('mousedown', function (event) { event.preventDefault(); });
      stickerButton.addEventListener('click', function () {
        if (!window.PublicStickerPicker) return;
        window.PublicStickerPicker.open(stickerButton, function (shortcode, imageUrl) {
          insertComposerSticker(input, shortcode, imageUrl);
        });
      });
      actions.appendChild(stickerButton);
      if (onCancel) {
        var cancel = makeEl('button', 'btn btn-secondary btn-sm', 'Отмена');
        cancel.type = 'button';
        cancel.addEventListener('click', onCancel);
        actions.appendChild(cancel);
      }
      var submit = makeEl('button', 'btn btn-primary btn-sm', 'Отправить');
      submit.type = 'submit';
      actions.appendChild(submit);
      form.appendChild(input);
      form.appendChild(actions);

      var busy = false;
      async function send() {
        var text = serializeComposerInput(input).trim();
        if (!text || busy) return;
        busy = true;
        submit.disabled = true;
        error.textContent = '';
        if (text.length > COMMENT_MAX_LEN) {
          error.textContent = 'Комментарий не должен превышать ' + COMMENT_MAX_LEN + ' символов';
          busy = false;
          submit.disabled = false;
          return;
        }
        var result = await onSubmit(text);
        busy = false;
        submit.disabled = false;
        if (result && result.ok) input.replaceChildren();
        else error.textContent = (result && result.message) || 'Не удалось отправить комментарий';
      }
      form.addEventListener('submit', function (event) { event.preventDefault(); send(); });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
      });
      return { form: form, input: input };
    }

    async function initComments(article, container, userPromise) {
      var slug = article.slug;
      var section = makeEl('section', 'pub-comments');
      section.id = 'publicArticleComments';
      var heading = makeEl('h2', 'pub-comments-title');
      var headingCount = makeEl('span', 'pub-comments-count');
      heading.appendChild(document.createTextNode('Комментарии '));
      heading.appendChild(headingCount);
      section.appendChild(heading);

      var composerMount = makeEl('div', 'pub-comments-compose');
      var list = makeEl('div', 'pub-comments-list');
      var empty = makeEl('p', 'pub-comments-empty', 'Комментариев пока нет.');
      empty.hidden = true;
      section.appendChild(composerMount);
      section.appendChild(list);
      section.appendChild(empty);
      container.appendChild(section);

      var state = { user: null, comments: [], replyTo: null, expanded: {} };
      var apiBase = '/api/articles/' + encodeURIComponent(slug) + '/comments';

      function authHeaders() {
        return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() };
      }

      function canModerate() {
        var u = state.user;
        return !!(u && (u.is_root || (u.admin_level || 0) > 0));
      }

      async function fetchComments() {
        // Залогиненному — авторизованный список (в нём есть userId автора для «удалить
        // свой»); если он недоступен — публичный, он есть у всех.
        if (state.user) {
          try {
            var own = await fetch(apiBase, { headers: authHeaders() });
            if (own.ok) return await own.json();
          } catch (error) { /* упадём на публичный список */ }
        }
        var response = await fetch(PUBLIC_ARTICLES_API + '/' + encodeURIComponent(slug) + '/comments', { credentials: 'omit' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var payload = await response.json();
        return Array.isArray(payload.data) ? payload.data : [];
      }

      async function load() {
        try {
          state.comments = await fetchComments();
        } catch (error) {
          list.replaceChildren(makePublicMessage('Не удалось загрузить комментарии.'));
          empty.hidden = true;
          return;
        }
        render();
        var commentsCountButton = container.querySelector('.pub-article-engagement-actions .is-comment span');
        if (commentsCountButton) commentsCountButton.textContent = String(state.comments.length);
      }

      async function post(text, parentId) {
        try {
          var response = await fetch(apiBase, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ content: text, parentId: parentId || null })
          });
          if (response.ok) {
            if (parentId) state.expanded[parentId] = true;
            state.replyTo = null;
            await load();
            return { ok: true };
          }
          if (response.status === 401) {
            state.user = null;
            renderComposer();
            render();
            return { ok: false, message: 'Сессия истекла — войдите снова.' };
          }
          var data = await response.json().catch(function () { return {}; });
          return { ok: false, message: data.error || 'Не удалось отправить комментарий' };
        } catch (error) {
          return { ok: false, message: 'Нет соединения с сервером' };
        }
      }

      async function remove(id) {
        if (!window.confirm('Удалить комментарий? Ответы на него удалятся вместе с ним.')) return;
        try {
          var response = await fetch(apiBase + '/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
          if (!response.ok) {
            var data = await response.json().catch(function () { return {}; });
            window.alert(data.error || 'Не удалось удалить комментарий');
            return;
          }
          await load();
        } catch (error) {
          window.alert('Нет соединения с сервером');
        }
      }

      function renderComment(comment, isReply, threadId) {
        var item = makeEl('div', 'pub-comment' + (isReply ? ' pub-comment-reply' : ''));
        item.dataset.id = comment.id;
        var head = makeEl('div', 'pub-comment-head');
        var authorId = comment.authorId != null ? comment.authorId : comment.userId;
        var person = authorId != null ? makeEl('a', 'pub-comment-person') : makeEl('span', 'pub-comment-person');
        if (authorId != null) person.href = '/profile/' + encodeURIComponent(authorId);
        person.appendChild(makeAvatar(comment, isReply ? 32 : 40));
        person.appendChild(makeEl('span', 'pub-comment-author', comment.authorName || 'Аноним'));
        head.appendChild(person);
        head.appendChild(makeEl('span', 'pub-comment-date', formatDate(comment.createdAt)));
        var me = state.user;
        if (me && (canModerate() || (comment.userId != null && comment.userId === me.id))) {
          var del = makeEl('button', 'pub-comment-delete');
          del.type = 'button';
          del.title = 'Удалить комментарий';
          del.setAttribute('aria-label', 'Удалить комментарий');
          del.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
          del.addEventListener('click', function () { remove(comment.id); });
          head.appendChild(del);
        }
        item.appendChild(head);
        item.appendChild(renderCommentBody(comment));
        var reactionBar = createReactionBar(slug, 'comment', comment.id, comment.reactions, state.user, function (updated) {
          var current = state.comments.find(function (entry) { return String(entry.id) === String(comment.id); });
          if (current) current.reactions = updated;
          render();
        });
        reactionBar.classList.add('pub-comment-reactions');
        item.appendChild(reactionBar);
        if (me) {
          var reply = makeEl('button', 'pub-comment-reply-btn');
          reply.type = 'button';
          reply.innerHTML = '<i class="far fa-message" aria-hidden="true"></i> Ответить';
          reply.addEventListener('click', function () {
            state.replyTo = { threadId: threadId, mention: isReply ? comment.authorName : '' };
            render();
          });
          item.appendChild(reply);
        }
        return item;
      }

      function render() {
        var top = state.comments.filter(function (c) { return !c.parentId; });
        var repliesBy = {};
        state.comments.forEach(function (c) {
          if (!c.parentId) return;
          (repliesBy[c.parentId] = repliesBy[c.parentId] || []).push(c);
        });
        headingCount.textContent = state.comments.length ? '(' + state.comments.length + ')' : '';
        empty.hidden = state.comments.length > 0;
        list.replaceChildren();

        top.forEach(function (comment) {
          var thread = makeEl('div', 'pub-comment-thread');
          thread.appendChild(renderComment(comment, false, comment.id));
          var replies = repliesBy[comment.id] || [];
          if (replies.length) {
            var box = makeEl('div', 'pub-comment-replies');
            var limit = 2;
            var showAll = state.expanded[comment.id] || replies.length <= limit;
            (showAll ? replies : replies.slice(0, limit)).forEach(function (r) {
              box.appendChild(renderComment(r, true, comment.id));
            });
            if (!showAll) {
              var more = makeEl('button', 'pub-comment-more', 'Показать ещё ответы (' + (replies.length - limit) + ')');
              more.type = 'button';
              more.addEventListener('click', function () { state.expanded[comment.id] = true; render(); });
              box.appendChild(more);
            }
            thread.appendChild(box);
          }
          if (state.user && state.replyTo && state.replyTo.threadId === comment.id) {
            var mention = state.replyTo.mention;
            var composer = createComposer('Ответить…', function (text) { return post(text, comment.id); }, function () {
              state.replyTo = null;
              render();
            });
            if (mention) composer.input.textContent = (/\s/.test(mention) ? '@[' + mention + ']' : '@' + mention) + ' ';
            composer.form.classList.add('pub-reply-form');
            thread.appendChild(composer.form);
            setTimeout(function () { composer.input.focus(); }, 0);
          }
          list.appendChild(thread);
        });
      }

      // Строка ввода есть только у залогиненного; гость видит приглашение войти.
      function renderComposer() {
        composerMount.replaceChildren();
        if (state.user) {
          composerMount.appendChild(createComposer('Написать комментарий…', function (text) {
            return post(text, null);
          }).form);
        } else {
          var note = makeEl('p', 'pub-comments-login');
          note.appendChild(document.createTextNode('Чтобы оставить комментарий, '));
          var link = makeEl('button', 'pub-login-link', 'войдите в аккаунт');
          link.type = 'button';
          link.addEventListener('click', openLogin);
          note.appendChild(link);
          note.appendChild(document.createTextNode('.'));
          composerMount.appendChild(note);
        }
      }

      renderComposer();
      list.appendChild(makePublicMessage('Загружаем комментарии…'));
      state.user = await userPromise;
      renderComposer();
      await load();
      if (window.location.hash === '#publicArticleComments') {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    async function loadDetail() {
      listView.hidden = true;
      detail.hidden = false;
      detail.replaceChildren(makePublicMessage('Загружаем статью…'));
      try {
        var token = getAuthToken();
        var response = await fetch(
          (token ? '/api/articles/' : PUBLIC_ARTICLES_API + '/') + encodeURIComponent(state.slug),
          {
            credentials: 'omit',
            headers: token ? { Authorization: 'Bearer ' + token } : {}
          }
        );
        if (response.status === 404) {
          if (state.disposed) return;
          detail.replaceChildren(makePublicMessage('Статья не найдена или недоступна для публичного чтения.'));
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (state.disposed) return;
        var article = await response.json();
        if (state.disposed) return;
        renderDetail(article);
      } catch (error) {
        if (state.disposed) return;
        detail.replaceChildren(makePublicMessage('Не удалось загрузить статью. Попробуйте обновить страницу.'));
      }
    }

    // ---------- Подключение ----------

    // Поиск в шапке работает на обеих страницах: в каталоге — живой (через
    // 300 мс после ввода), в статье Enter уводит в каталог с запросом.
    var searchDebounce = null;
    input.addEventListener('input', function () {
      if (state.slug) return;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(applyFilters, 300);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (state.slug) {
        window.PublicSite.navigateTo('/antropedia' + (input.value.trim() ? '?q=' + encodeURIComponent(input.value.trim()) : ''));
        return;
      }
      clearTimeout(searchDebounce);
      applyFilters();
    });
    // «/» фокусирует поиск, если фокус не в поле ввода.
    function onSearchShortcut(event) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      input.focus();
    }
    document.addEventListener('keydown', onSearchShortcut);

    if (state.slug) {
      var detailLoad = loadDetail();
      var detailCleanup = function cleanup() {
        state.disposed = true;
        if (state.controller) state.controller.abort();
        document.removeEventListener('keydown', onSearchShortcut);
      };
      detailCleanup.ready = detailLoad;
      return detailCleanup;
    }

    var tagRoot = document.getElementById('pubTagField');
    if (tagRoot && typeof window.ChipField === 'function') {
      state.tagField = new window.ChipField(tagRoot, {
        freeText: false,
        placeholder: 'Все теги...',
        emptyText: 'Теги не найдены',
        onChange: applyFilters
      });
      var initialTags = (params.get('tag') || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      state.tagField.setValues(initialTags);
      loadTagOptions();
    } else if (tagRoot) {
      tagRoot.closest('.pub-filter').hidden = true;
    }

    sortEl.addEventListener('change', applyFilters);
    dateFromEl.addEventListener('change', applyFilters);
    dateToEl.addEventListener('change', applyFilters);
    document.getElementById('pubResetFilters').addEventListener('click', resetFilters);
    document.getElementById('pubEmptyReset').addEventListener('click', resetFilters);
    document.getElementById('pubRandomBtn').addEventListener('click', openRandomArticle);
    loadMore.addEventListener('click', function () { loadArticles(true); });

    // Подгрузка при прокрутке, как в админке; кнопка «Загрузить ещё» — только
    // запасной вариант для браузеров без IntersectionObserver.
    if ('IntersectionObserver' in window) {
      state.observer = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) loadArticles(true);
      }, { rootMargin: '400px' });
      state.observer.observe(sentinel);
    }

    updateFiltersCount();
    var initialLoad = loadArticles(false);
    var listCleanup = function cleanup() {
      state.disposed = true;
      if (state.controller) state.controller.abort();
      if (state.observer) state.observer.disconnect();
      clearTimeout(searchDebounce);
      document.removeEventListener('keydown', onSearchShortcut);
    };
    listCleanup.ready = initialLoad;
    return listCleanup;
  }

  function initStaticDemos() {
    document.querySelectorAll('.chip-row').forEach(function (row) {
      row.addEventListener('click', function (event) {
        var chip = event.target.closest('.filter-chip');
        if (!chip) return;
        row.querySelectorAll('.filter-chip').forEach(function (item) { item.classList.remove('active'); });
        chip.classList.add('active');
      });
    });
    document.querySelectorAll('.engage-item.is-like').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var icon = button.querySelector('i');
        var count = button.querySelector('span');
        var active = button.classList.toggle('active');
        if (icon) {
          icon.classList.toggle('fas', active);
          icon.classList.toggle('far', !active);
        }
        if (count) {
          var value = parseInt(count.textContent, 10) || 0;
          count.textContent = String(active ? value + 1 : value - 1);
        }
      });
    });
    document.querySelectorAll('.pin-save').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var saved = button.classList.toggle('is-saved');
        button.textContent = saved ? 'Сохранено' : 'Сохранить';
      });
    });
    document.querySelectorAll('[data-fake-load-more]').forEach(function (button) {
      button.addEventListener('click', function () {
        button.innerHTML = '<i class="fas fa-check"></i> Это демо-макет — здесь пока нечего подгружать';
        button.disabled = true;
      });
    });
  }

  function mountPublicPage() {
    cleanupPublicPage();
    var page = document.body.getAttribute('data-page');
    if (page === 'antropedia') currentRouteCleanup = initPublicAntropedia();
    if (page === 'gallery' && window.SiteGallery) currentRouteCleanup = window.SiteGallery.init();
    var articleMatch = page === 'antropedia' && window.location.pathname.match(/^\/antropedia\/([^/]+)\/?$/);
    var articleSlug = null;
    if (articleMatch) {
      try { articleSlug = decodeURIComponent(articleMatch[1]); }
      catch (error) { articleSlug = articleMatch[1]; }
    }
    updateAdminLinks(articleSlug);
    var readyPromise = Promise.resolve();
    if (page === 'profile' && window.PublicProfile) readyPromise = window.PublicProfile.init();
    if (currentRouteCleanup && currentRouteCleanup.ready) readyPromise = currentRouteCleanup.ready;
    currentMountedPage = page;
    document.querySelectorAll('.site-nav-link[data-page]').forEach(function (link) {
      link.classList.toggle('active', link.dataset.page === page);
    });
    initStaticDemos();
    return readyPromise;
  }

  function cleanupPublicPage() {
    if (currentRouteCleanup) {
      currentRouteCleanup();
      currentRouteCleanup = null;
    }
    if (currentMountedPage === 'profile' && window.PublicProfile) window.PublicProfile.cleanup();
    currentMountedPage = null;
  }

  window.PublicSite = {
    mountPage: mountPublicPage,
    cleanupPage: cleanupPublicPage,
    saveArticleListPosition: saveArticleListPosition,
    navigateTo: function (url) {
      if (window.PublicSiteRouter) window.PublicSiteRouter.navigate(url);
      else window.location.href = url;
    }
  };

  ready(function () {
    initSiteUserMenu();

    // --- Мобильное меню ---
    var burger = document.getElementById('siteBurger');
    var nav = document.getElementById('siteNav');
    var overlay = document.getElementById('siteNavOverlay');

    function closeNav() {
      if (nav) nav.classList.remove('open');
      if (overlay) overlay.classList.remove('show');
    }

    if (burger && nav) {
      burger.addEventListener('click', function () {
        nav.classList.toggle('open');
        if (overlay) overlay.classList.toggle('show', nav.classList.contains('open'));
      });
    }
    if (overlay) overlay.addEventListener('click', closeNav);
    if (nav) {
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', closeNav);
      });
    }

    window.setTimeout(mountPublicPage, 0);
  });
})();
