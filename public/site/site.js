// site.js — поведение публичной витрины AllTell. Antropedia использует
// только гостевые read-only endpoints; остальные разделы остаются макетами.

(function () {
  var PUBLIC_ARTICLES_API = '/api/public/articles';
  var PUBLIC_PAGE_SIZE = 30;

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

    function updateAdminLinks(slug) {
      var destination = '/admin-panel';
      if (slug) {
        destination += '?editArticle=' + encodeURIComponent(slug);
      }
      document.querySelectorAll('[data-mode-switch]').forEach(function (link) {
        link.href = destination;
      });
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
      if (date) {
        var meta = document.createElement('div');
        meta.className = 'public-card-meta';
        var calendar = document.createElement('i');
        calendar.className = 'far fa-calendar';
        calendar.setAttribute('aria-hidden', 'true');
        meta.append(calendar, document.createTextNode(' ' + date));
        body.appendChild(meta);
      }

      // Лайки/комментарии/просмотры — только числа, для гостя без действий.
      var foot = document.createElement('div');
      foot.className = 'wiki-card-foot';
      var group = document.createElement('div');
      group.className = 'engage-group';
      group.append(
        makeStat('far fa-heart', article.likesCount, 'Нравится'),
        makeStat('far fa-comment', article.commentsCount, 'Комментарии')
      );
      foot.append(group, makeStat('far fa-eye', article.viewsCount, 'Просмотры'));
      body.appendChild(foot);

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

      try {
        var response = await fetch(PUBLIC_ARTICLES_API + '?' + query.toString(), {
          credentials: 'omit',
          signal: controller.signal
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
        if (generation !== state.generation) return;
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
            : 'Публичных статей пока нет.';
          document.getElementById('pubEmptyReset').hidden = !filtered;
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (generation !== state.generation) return;
        if (!append) grid.replaceChildren();
        grid.querySelectorAll('.pub-skeleton').forEach(function (el) { el.remove(); });
        grid.appendChild(makePublicMessage('Не удалось загрузить статьи. Проверьте соединение и попробуйте ещё раз.'));
        state.hasMore = false;
        loadMore.hidden = true;
      } finally {
        if (generation === state.generation) {
          state.loading = false;
          loadMore.disabled = false;
          loadingMoreEl.hidden = true;
          updateStatus();
          // Если после загрузки метка конца списка всё ещё на виду (мало
          // карточек / высокий экран) — IntersectionObserver сам не сработает.
          if (state.hasMore && sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
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
        var response = await fetch(PUBLIC_ARTICLES_API + '?' + query.toString(), { credentials: 'omit' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
        var pick = Array.isArray(result.data) && result.data[0];
        if (pick) window.location.href = '/antropedia/' + encodeURIComponent(pick.slug);
      } catch (error) {
        status.textContent = 'Не удалось выбрать случайную статью — попробуйте ещё раз.';
      } finally {
        button.disabled = false;
      }
    }

    async function loadTagOptions() {
      try {
        var response = await fetch('/api/public/tags', { credentials: 'omit' });
        if (!response.ok) return;
        var result = await response.json();
        var tags = Array.isArray(result.data) ? result.data : [];
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
      try {
        var response = await fetch('/api/public/articles-index', { credentials: 'omit' });
        if (response.ok) {
          var result = await response.json();
          (Array.isArray(result.data) ? result.data : []).forEach(function (item) {
            if (item && item.slug && item.slug !== article.slug) index.set(item.slug, item);
          });
        }
      } catch (error) {
        // Без индекса ссылки покажутся как «Недоступно» — текст статьи не страдает.
      }
      return index;
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
      detail.appendChild(back);

      var title = document.createElement('h1');
      title.className = 'public-article-title';
      title.textContent = article.title || article.slug;
      detail.appendChild(title);
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
            window.location.href = '/antropedia?tag=' + encodeURIComponent(tag);
          });
          tags.appendChild(button);
        });
        detail.appendChild(tags);
      }

      var content = document.createElement('div');
      content.className = 'preview-pane public-article-content';
      detail.appendChild(content);
      // Индекс открытых статей — по нему рендерер узнаёт цели вики-ссылок.
      // Без него каждая ссылка на другую статью выглядела как «создать».
      // Остальные цели (закрытые/несуществующие) для гостя одинаково
      // «Недоступно», без приглашения создавать статью и без раскрытия
      // того, существует ли она.
      var allUnavailable = { has: function () { return true; } };
      loadPublicIndex(article).then(function (index) {
        if (typeof window.renderArticleBlocks !== 'function') throw new Error('Block renderer is unavailable');
        return window.renderArticleBlocks(article.content, index, allUnavailable);
      }).then(function (html) {
        content.innerHTML = html;
        content.querySelectorAll('a[data-slug]').forEach(function (link) {
          link.href = '/antropedia/' + encodeURIComponent(link.dataset.slug);
        });
        content.addEventListener('click', function (event) {
          var wikiLink = event.target.closest('a[data-slug]');
          if (wikiLink) {
            event.preventDefault();
            window.location.href = '/antropedia/' + encodeURIComponent(wikiLink.dataset.slug);
            return;
          }
          var tagLink = event.target.closest('[data-tag]');
          if (tagLink) {
            window.location.href = '/antropedia?tag=' + encodeURIComponent(tagLink.dataset.tag);
          }
        });
      }).catch(function () {
        content.replaceChildren(makePublicMessage('Не удалось отобразить содержимое статьи.'));
      });
      initComments(article, detail).catch(function () { /* комментарии не критичны для чтения статьи */ });
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
        img.loading = 'lazy';
        wrap.appendChild(img);
      } else {
        wrap.textContent = String(comment.authorName || '?').trim().charAt(0).toUpperCase() || '?';
      }
      return wrap;
    }

    // Форма ввода: textarea + «Отправить». onSubmit(text) возвращает Promise<boolean>
    // (true — отправлено, поле очищается). Ctrl/⌘+Enter отправляет.
    function createComposer(placeholder, onSubmit, onCancel) {
      var form = makeEl('form', 'pub-comment-form');
      var input = document.createElement('textarea');
      input.className = 'pub-comment-input';
      input.rows = 2;
      input.maxLength = COMMENT_MAX_LEN;
      input.placeholder = placeholder;
      input.setAttribute('aria-label', placeholder);
      var actions = makeEl('div', 'pub-comment-form-actions');
      var error = makeEl('span', 'pub-comment-error');
      error.setAttribute('role', 'alert');
      actions.appendChild(error);
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
        var text = input.value.trim();
        if (!text || busy) return;
        busy = true;
        submit.disabled = true;
        error.textContent = '';
        var result = await onSubmit(text);
        busy = false;
        submit.disabled = false;
        if (result && result.ok) input.value = '';
        else error.textContent = (result && result.message) || 'Не удалось отправить комментарий';
      }
      form.addEventListener('submit', function (event) { event.preventDefault(); send(); });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
      });
      return { form: form, input: input };
    }

    async function initComments(article, container) {
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
        head.appendChild(makeAvatar(comment, isReply ? 24 : 32));
        head.appendChild(makeEl('span', 'pub-comment-author', comment.authorName || 'Аноним'));
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
            if (mention) composer.input.value = (/\s/.test(mention) ? '@[' + mention + ']' : '@' + mention) + ' ';
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
          var link = makeEl('a', null, 'войдите в аккаунт');
          link.href = '/admin-panel';
          note.appendChild(link);
          note.appendChild(document.createTextNode('.'));
          composerMount.appendChild(note);
        }
      }

      renderComposer();
      list.appendChild(makePublicMessage('Загружаем комментарии…'));
      state.user = await loadCurrentUser();
      renderComposer();
      await load();
    }

    async function loadDetail() {
      listView.hidden = true;
      detail.hidden = false;
      detail.replaceChildren(makePublicMessage('Загружаем статью…'));
      try {
        var response = await fetch(PUBLIC_ARTICLES_API + '/' + encodeURIComponent(state.slug), { credentials: 'omit' });
        if (response.status === 404) {
          detail.replaceChildren(makePublicMessage('Статья не найдена или недоступна для публичного чтения.'));
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        renderDetail(await response.json());
      } catch (error) {
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
        window.location.href = '/antropedia' + (input.value.trim() ? '?q=' + encodeURIComponent(input.value.trim()) : '');
        return;
      }
      clearTimeout(searchDebounce);
      applyFilters();
    });
    // «/» фокусирует поиск, если фокус не в поле ввода.
    document.addEventListener('keydown', function (event) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      input.focus();
    });

    if (state.slug) {
      loadDetail();
      return;
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
      new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) loadArticles(true);
      }, { rootMargin: '400px' }).observe(sentinel);
    }

    updateFiltersCount();
    loadArticles(false);
  }

  ready(function () {
    initPublicAntropedia();
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

    // --- Подсветка активного пункта меню по текущему файлу ---
    var page = document.body.getAttribute('data-page');
    if (page) {
      document.querySelectorAll('.site-nav-link[data-page="' + page + '"]').forEach(function (el) {
        el.classList.add('active');
      });
    }

    // --- Чипы-фильтры: чисто визуальное переключение active ---
    document.querySelectorAll('.chip-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var chip = e.target.closest('.filter-chip');
        if (!chip) return;
        row.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
      });
    });

    // --- Лайк: локальный визуальный тоггл, без сохранения и запросов ---
    document.querySelectorAll('.engage-item.is-like').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var icon = btn.querySelector('i');
        var countEl = btn.querySelector('span');
        var active = btn.classList.toggle('active');
        if (icon) {
          icon.classList.toggle('fas', active);
          icon.classList.toggle('far', !active);
        }
        if (countEl) {
          var n = parseInt(countEl.textContent, 10) || 0;
          countEl.textContent = active ? n + 1 : n - 1;
        }
      });
    });

    // --- Сохранить (галерея): визуальный тоггл кнопки ---
    document.querySelectorAll('.pin-save').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var saved = btn.classList.toggle('is-saved');
        btn.textContent = saved ? 'Сохранено' : 'Сохранить';
      });
    });

    // --- "Загрузить ещё": просто показывает, что кнопка кликабельна ---
    document.querySelectorAll('[data-fake-load-more]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.innerHTML = '<i class="fas fa-check"></i> Это демо-макет — здесь пока нечего подгружать';
        btn.disabled = true;
      });
    });
  });
})();
