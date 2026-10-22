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
      var index = new Map([[article.slug, { slug: article.slug, title: article.title || article.slug, tags: article.tags || [] }]]);
      Promise.resolve().then(function () {
        if (typeof window.renderArticleBlocks !== 'function') throw new Error('Block renderer is unavailable');
        return window.renderArticleBlocks(article.content, index);
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
      updateArticleMetadata(article);
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

    // --- Дропдаун профиля ---
    var userBtn = document.getElementById('siteUser');
    var userDropdown = document.getElementById('siteUserDropdown');
    if (userBtn && userDropdown) {
      userBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        userDropdown.classList.toggle('show');
      });
      document.addEventListener('click', function () {
        userDropdown.classList.remove('show');
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
