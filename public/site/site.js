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

  window.avatarSrcSet = function (value) {
    var match = String(value || '').match(/^(\/uploads\/avatar\/[1-9][0-9]*\/)\d+\.webp(\?.*)?$/);
    if (!match) return '';
    return [104, 208, 312].map(function (size, index) {
      return match[1] + size + '.webp' + (match[2] || '') + ' ' + (index + 1) + 'x';
    }).join(', ');
  };

  function updateAdminLinks(slug) {
    if (window.SiteHeader) {
      window.SiteHeader.updateAdminLink(slug);
      return;
    }
    var destination = slug ? '/admin-panel?editArticle=' + encodeURIComponent(slug) : '/admin-panel';
    document.querySelectorAll('.site-admin-toggle').forEach(function (link) {
      link.href = destination;
      var icon = link.querySelector('i');
      if (icon && !icon.classList.contains('fa-shield-halved')) {
        link.innerHTML = '<i class="fas fa-shield-halved"></i><span>Админ-панель</span>';
      }
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
        image.srcset = window.avatarSrcSet(avatarUrl);
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

  // Обложкам без изображения назначается градиент, зависящий от slug.
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

  // Форматирование больших чисел для счётчиков.
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

  function makeEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function initPublicAntropedia() {
    if (document.body.getAttribute('data-page') !== 'antropedia') return;
    var main = document.querySelector('.site-main');
    var hero = document.querySelector('.site-hero');
    var listView = document.getElementById('publicArticleListView');
    var detailContainer = document.getElementById('publicArticleContainer');
    var detail = document.getElementById('publicArticleDetail');
    var sidebar = document.getElementById('antropediaViewSidebar');
    var editorView = document.getElementById('publicArticleEditor');
    var heroWriteBtn = document.getElementById('antropediaHeroWriteBtn');
    var toolbarWriteBtn = document.getElementById('antropediaToolbarWriteBtn');
    var bannerWriteBtn = document.getElementById('antropediaBannerWriteBtn');
    var input = document.getElementById('publicArticleSearch');
    if (!main || !listView || !detail || !input) return;
    main.hidden = false;

    var grid = document.getElementById('publicArticleGrid');
    var status = document.getElementById('publicArticleStatus');
    var emptyEl = document.getElementById('pubEmpty');
    var loadingMoreEl = document.getElementById('pubLoadingMore');
    var sentinel = document.getElementById('pubSentinel');
    var sortEl = document.getElementById('pubSort');
    var serverFilterEl = document.getElementById('pubServerFilter');
    var statusFilterEl = document.getElementById('pubStatusFilter');
    var dateFromEl = document.getElementById('pubDateFrom');
    var dateToEl = document.getElementById('pubDateTo');
    var filtersToggle = document.getElementById('pubFiltersToggle');
    var filtersPanel = document.getElementById('pubFiltersPanel');
    var filtersCountEl = document.getElementById('pubFiltersCount');
    var countBadgeEl = document.getElementById('publicArticleCountBadge');
    var searchClearBtn = document.getElementById('publicArticleSearchClear');
    var quickTagsEl = document.getElementById('pubQuickTags');
    var heroExploreBtn = document.getElementById('antropediaHeroExploreBtn');
    var SORTS = ['newest', 'oldest', 'updated', 'views', 'alpha'];

    function formatArticleWord(count) {
      var n = Math.abs(count) % 100;
      var n1 = n % 10;
      if (n > 10 && n < 20) return 'статей';
      if (n1 > 1 && n1 < 5) return 'статьи';
      if (n1 === 1) return 'статья';
      return 'статей';
    }

    function updateArticleCount(total) {
      if (!countBadgeEl) return;
      if (state.loading && state.offset === 0) {
        countBadgeEl.textContent = '';
      } else if (total != null) {
        countBadgeEl.textContent = total + ' ' + formatArticleWord(total);
      }
    }

    function updateSearchClear() {
      if (searchClearBtn) {
        searchClearBtn.hidden = !input.value.trim();
      }
    }

    function renderQuickTags(tags) {
      if (!quickTagsEl) return;
      quickTagsEl.replaceChildren();
      var activeTags = state.tagField ? state.tagField.getValues() : [];
      tags.slice(0, 16).forEach(function (tagItem) {
        var tagName = typeof tagItem === 'string' ? tagItem : (tagItem && tagItem.tag);
        if (!tagName) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'antropedia-tag-chip' + (activeTags.includes(tagName) ? ' active' : '');
        btn.textContent = '#' + tagName;
        btn.title = 'Фильтр по тегу «' + tagName + '»';
        btn.addEventListener('click', function () {
          if (!state.tagField) return;
          var cur = state.tagField.getValues();
          if (cur.includes(tagName)) {
            state.tagField.setValues(cur.filter(function (t) { return t !== tagName; }));
          } else {
            state.tagField.addValue(tagName);
          }
          syncQuickTagsActive();
          applyFilters();
        });
        quickTagsEl.appendChild(btn);
      });
    }

    function syncQuickTagsActive() {
      if (!quickTagsEl) return;
      var activeTags = state.tagField ? state.tagField.getValues() : [];
      quickTagsEl.querySelectorAll('.antropedia-tag-chip').forEach(function (btn) {
        var name = btn.textContent.replace(/^#/, '');
        btn.classList.toggle('active', activeTags.includes(name));
      });
    }

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
    var initialServer = params.get('server') || params.get('serverId') || '';
    if (serverFilterEl && initialServer) {
      var tempOpt = document.createElement('option');
      tempOpt.value = initialServer;
      tempOpt.textContent = 'Франшиза #' + initialServer;
      tempOpt.selected = true;
      serverFilterEl.appendChild(tempOpt);
      serverFilterEl.value = initialServer;
    }
    var initialLocked = params.get('locked');
    if (statusFilterEl && initialLocked !== null && initialLocked !== '') {
      statusFilterEl.value = initialLocked;
    }

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
        server: serverFilterEl ? serverFilterEl.value : '',
        locked: statusFilterEl ? statusFilterEl.value : '',
        from: dateFromEl.value,
        to: dateToEl.value
      };
    }

    function hasActiveFilters() {
      var f = getFilters();
      return !!(f.q || f.tags.length || f.server || f.locked !== '' || f.from || f.to || f.sort !== 'newest');
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
      put('server', f.server);
      put('locked', f.locked);
      put('from', f.from);
      put('to', f.to);
      window.history.replaceState(window.history.state || {}, '', next.pathname + next.search);
    }

    // Счётчик на кнопке «Фильтры · N» — сколько полей панели заполнено
    // (диапазон дат считается одним полем; поиск и сортировка вне панели).
    function updateFiltersCount() {
      var f = getFilters();
      var n = 0;
      if (f.server) n++;
      if (f.locked !== '') n++;
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
    var hasActivePanelFilters = !!(
      (serverFilterEl && serverFilterEl.value) ||
      (statusFilterEl && statusFilterEl.value) ||
      dateFromEl.value ||
      dateToEl.value ||
      (params.get('tag') && params.get('tag').includes(','))
    );
    setFiltersOpen(hasActivePanelFilters);
    filtersToggle.addEventListener('click', function () {
      setFiltersOpen(!filtersPanel.classList.contains('is-open'));
    });
    if (heroExploreBtn) {
      heroExploreBtn.addEventListener('click', function (e) {
        e.preventDefault();
        listView.scrollIntoView({ behavior: 'smooth' });
        input.focus();
      });
    }

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

    // ---------- Переключение экранов (Каталог / Статья / Редактор) ----------

    function showEditorView(options) {
      options = options || {};
      if (hero) hero.hidden = true;
      listView.hidden = true;
      if (detailContainer) detailContainer.hidden = true;
      detail.hidden = true;
      if (sidebar) sidebar.hidden = true;
      if (editorView) editorView.hidden = false;

      window.scrollTo({ top: 0, behavior: 'instant' });

      if (window.antropediaEditor && typeof window.antropediaEditor.openEditor === 'function') {
        window.antropediaEditor.openEditor({
          draftId: options.draftId || null,
          articleSlug: options.articleSlug || null
        });
      }

      var curParams = new URLSearchParams(window.location.search);
      var curView = curParams.get('view');
      var curDraft = curParams.get('draft');
      var curEdit = curParams.get('edit');
      var targetDraft = options.draftId || null;
      var targetEdit = options.articleSlug || null;

      if (curView !== 'write' || curDraft !== targetDraft || curEdit !== targetEdit) {
        var queryParts = ['view=write'];
        if (targetDraft) queryParts.push('draft=' + encodeURIComponent(targetDraft));
        if (targetEdit) queryParts.push('edit=' + encodeURIComponent(targetEdit));
        var nextUrl = '/antropedia?' + queryParts.join('&');
        window.history.pushState({ antropediaView: 'write', draftId: targetDraft, articleSlug: targetEdit }, '', nextUrl);
      }
    }

    function showListView() {
      if (hero && !state.slug) hero.hidden = false;
      if (editorView) editorView.hidden = true;
      if (window.antropediaEditor && typeof window.antropediaEditor.closeEditor === 'function') {
        window.antropediaEditor.closeEditor();
      }

      if (state.slug) {
        window.PublicSite.navigateTo('/antropedia');
        return;
      }

      if (tocCleanup) {
        tocCleanup();
        tocCleanup = null;
      }
      if (tocObserver) {
        tocObserver.disconnect();
        tocObserver = null;
      }
      clearTimeout(inlineSearchDebounce);
      closeInArticleSearch();
      hideSelectionUI();
      currentContentEl = null;
      listView.hidden = false;
      if (detailContainer) detailContainer.hidden = true;
      detail.hidden = true;
      if (sidebar) sidebar.hidden = true;

      var curParams = new URLSearchParams(window.location.search);
      if (curParams.get('view') === 'write' || curParams.get('draft') || curParams.get('edit')) {
        window.history.pushState({ antropediaView: 'list' }, '', '/antropedia');
      }

      if (!state.offset && !state.total && !state.loading) {
        loadArticles(false);
      }
    }

    function showDetailView(slug) {
      if (hero) hero.hidden = true;
      listView.hidden = true;
      if (editorView) editorView.hidden = true;
      if (detailContainer) detailContainer.hidden = false;
      detail.hidden = false;
      if (window.antropediaEditor && typeof window.antropediaEditor.closeEditor === 'function') {
        window.antropediaEditor.closeEditor();
      }
    }

    window.PublicAntropedia = {
      showEditorView: showEditorView,
      showListView: showListView,
      showDetailView: showDetailView,
      openEditor: showEditorView,
      openInArticleSearch: openInArticleSearch,
      closeInArticleSearch: closeInArticleSearch,
      runInArticleSearch: runInArticleSearch,
      gotoSearchHit: gotoSearchHit,
      clearInArticleSearch: clearInArticleSearch
    };
    window.openInArticleSearch = openInArticleSearch;
    window.closeInArticleSearch = closeInArticleSearch;
    window.runInArticleSearch = runInArticleSearch;
    window.gotoSearchHit = gotoSearchHit;
    window.clearInArticleSearch = clearInArticleSearch;

    function onWriteClick(e) {
      if (e) e.preventDefault();
      var token = getAuthToken();
      if (!token) {
        openLogin();
        return;
      }
      showEditorView();
    }

    if (heroWriteBtn) heroWriteBtn.addEventListener('click', onWriteClick);
    if (toolbarWriteBtn) toolbarWriteBtn.addEventListener('click', onWriteClick);
    if (bannerWriteBtn) bannerWriteBtn.addEventListener('click', onWriteClick);

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

    
  function computeOptimisticReactions(reactions, shortcode, imageUrl) {
    var list = Array.isArray(reactions) ? reactions.map(function (r) { return Object.assign({}, r); }) : [];
    var cleanCode = String(shortcode || '').replace(/^:+|:+$/g, '').toLowerCase();
    if (!cleanCode) return list;

    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].shortcode || '').replace(/^:+|:+$/g, '').toLowerCase() === cleanCode) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      var item = list[idx];
      if (item.reacted) {
        if (item.count <= 1) {
          list.splice(idx, 1);
        } else {
          item.count = item.count - 1;
          item.reacted = false;
        }
      } else {
        item.count = item.count + 1;
        item.reacted = true;
      }
    } else {
      list.push({
        shortcode: cleanCode,
        count: 1,
        reacted: true,
        url: imageUrl || ''
      });
    }
    return list;
  }

  function syncArticleLikesUI(slug, liked, count) {
    if (!slug) return;
    var slugStr = String(slug);
    document.querySelectorAll('.wiki-card[data-slug="' + slugStr + '"], .antropedia-card[data-slug="' + slugStr + '"]').forEach(function (card) {
      var btn = card.querySelector('.engage-item.is-like, [data-action="toggle-like"]');
      if (!btn) return;
      btn.classList.toggle('active', liked);
      btn.classList.toggle('is-liked', liked);
      var icon = btn.querySelector('i');
      if (icon) icon.className = (liked ? 'fas' : 'far') + ' fa-heart';
      var span = btn.querySelector('span, .antropedia-card-pill-count');
      if (span) span.textContent = formatCount(count);
    });
    var detailLike = document.querySelector('.pub-article-engagement-actions .is-like');
    if (detailLike) {
      detailLike.classList.toggle('active', liked);
      var detailIcon = detailLike.querySelector('i');
      if (detailIcon) detailIcon.className = (liked ? 'fas' : 'far') + ' fa-heart';
      var detailSpan = detailLike.querySelector('span');
      if (detailSpan) detailSpan.textContent = String(count);
    }
  }

  function syncArticleCommentsUI(slug, count) {
    if (!slug) return;
    var slugStr = String(slug);
    document.querySelectorAll('.wiki-card[data-slug="' + slugStr + '"] .engage-item.is-comment span, .antropedia-card[data-slug="' + slugStr + '"] [data-action="goto-comments"] .antropedia-card-pill-count').forEach(function (span) {
      span.textContent = formatCount(count);
    });
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
      card.className = 'wiki-card public-wiki-card antropedia-card';
      card.dataset.slug = article.slug;

      var coverWrap = document.createElement('div');
      coverWrap.className = 'antropedia-card-cover-wrap';

      var cover = document.createElement('a');
      cover.className = 'wiki-card-cover antropedia-card-cover';
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
      coverWrap.appendChild(cover);
      if (article.locked) {
        var lockBadge = document.createElement('div');
        lockBadge.className = 'antropedia-card-lock';
        lockBadge.title = 'Доступ по ролям';
        var lockIcon = document.createElement('i');
        lockIcon.className = 'fas fa-lock';
        lockBadge.appendChild(lockIcon);
        coverWrap.appendChild(lockBadge);
      }
      card.appendChild(coverWrap);

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

      var meta = document.createElement('div');
      meta.className = 'public-card-meta public-card-details';

      var metaLeft = document.createElement('div');
      metaLeft.className = 'public-card-meta-left';

      var date = formatDate(article.created_at);
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
          avatar.srcset = window.avatarSrcSet(authorImage);
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
        metaLeft.appendChild(authorLink);
      }
      if (date) {
        var dateMeta = makeEl('span', 'public-card-date');
        var calendar = document.createElement('i');
        calendar.className = 'far fa-calendar';
        calendar.setAttribute('aria-hidden', 'true');
        dateMeta.append(calendar, document.createTextNode(' ' + date));
        metaLeft.appendChild(dateMeta);
      }
      meta.appendChild(metaLeft);

      var metaStats = document.createElement('div');
      metaStats.className = 'public-card-meta-stats';
      var commentsLink = document.createElement('a');
      commentsLink.className = 'engage-item is-comment';
      commentsLink.href = '/antropedia/' + encodeURIComponent(article.slug) + '#publicArticleComments';
      commentsLink.title = 'Открыть комментарии';
      commentsLink.append(
        makeEl('i', 'far fa-comment'),
        makeEl('span', null, formatCount(article.commentsCount))
      );
      metaStats.append(commentsLink, makeStat('far fa-eye', article.viewsCount, 'Просмотры'));
      meta.appendChild(metaStats);

      body.appendChild(meta);

      var foot = document.createElement('div');
      foot.className = 'wiki-card-foot antropedia-card-foot';

      var reactionsTrack = document.createElement('div');
      reactionsTrack.className = 'antropedia-card-reactions-track';

      var likeButton = makeEngageButton('far fa-heart', article.likesCount, 'Нравится', 'is-like antropedia-reaction-chip');
      likeButton.classList.toggle('active', !!article.liked);
      likeButton.querySelector('i').className = article.liked ? 'fas fa-heart' : 'far fa-heart';
      likeButton.addEventListener('click', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!getAuthToken()) {
          openLogin();
          return;
        }
        var wasLiked = likeButton.classList.contains('active');
        var prevCount = parseInt(likeButton.querySelector('span').textContent.replace(/\D/g, ''), 10) || 0;
        var nextLiked = !wasLiked;
        var nextCount = Math.max(0, prevCount + (nextLiked ? 1 : -1));

        // Instant optimistic update
        article.liked = nextLiked;
        article.likesCount = nextCount;
        syncArticleLikesUI(article.slug, nextLiked, nextCount);

        try {
          var result = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/likes/toggle', 'POST');
          if (result && typeof result.count === 'number') {
            article.liked = !!result.liked;
            article.likesCount = result.count;
            syncArticleLikesUI(article.slug, article.liked, article.likesCount);
          }
        } catch (error) {
          article.liked = wasLiked;
          article.likesCount = prevCount;
          syncArticleLikesUI(article.slug, wasLiked, prevCount);
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Лайк', message: error.message || 'Не удалось поставить лайк' });
          }
        }
      });

      reactionsTrack.appendChild(likeButton);
      reactionsTrack.appendChild(createCardReactionBar(article, getAuthToken() ? {} : null));
      foot.appendChild(reactionsTrack);
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
      status.textContent = state.loading && state.offset === 0 ? 'Загружаем открытые статьи…' : '';
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
      if (f.server) {
        query.set('server', f.server);
        query.set('serverId', f.server);
      }
      if (f.locked !== '') {
        query.set('locked', f.locked);
      }
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
        updateArticleCount(state.total);

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
      updateSearchClear();
      syncQuickTagsActive();
      updateSearchUrl();
      loadArticles(false);
    }

    function resetFilters() {
      if (state.tagField) state.tagField.setValues([]);
      if (serverFilterEl) serverFilterEl.value = '';
      if (statusFilterEl) statusFilterEl.value = '';
      dateFromEl.value = '';
      dateToEl.value = '';
      sortEl.value = 'newest';
      input.value = '';
      updateSearchClear();
      syncQuickTagsActive();
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
        if (f.server) {
          query.set('server', f.server);
          query.set('serverId', f.server);
        }
        if (f.locked !== '') {
          query.set('locked', f.locked);
        }
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
        if (quickTagsEl && tags.length) {
          renderQuickTags(tags);
        }
      } catch (error) {
        // Фильтр по тегам останется без подсказок — не критично.
      }
    }

    async function loadServerOptions() {
      if (!serverFilterEl) return;
      try {
        var token = getAuthToken();
        var response = await fetch('/api/public/franchises', {
          credentials: 'omit',
          headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (!response.ok) return;
        var franchises = await response.json();
        if (Array.isArray(franchises)) {
          var targetVal = params.get('server') || params.get('serverId') || serverFilterEl.value || '';
          var firstOpt = serverFilterEl.options && serverFilterEl.options[0];
          serverFilterEl.replaceChildren();
          if (firstOpt) {
            firstOpt.value = '';
            firstOpt.textContent = 'Все франшизы';
            serverFilterEl.appendChild(firstOpt);
          } else {
            var defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = 'Все франшизы';
            serverFilterEl.appendChild(defaultOpt);
          }
          franchises.forEach(function (f) {
            var opt = document.createElement('option');
            opt.value = String(f.id);
            opt.textContent = f.name;
            serverFilterEl.appendChild(opt);
          });
          if (targetVal) {
            serverFilterEl.value = targetVal;
          }
        }
      } catch (error) {
        console.warn('Не удалось загрузить список франшиз:', error);
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
      bar.dataset.targetId = targetId;
      (reactions || []).forEach(function (reaction) {
        var button = makeEl('button', 'pub-reaction-pill antropedia-reaction-chip' + (reaction.reacted ? ' active' : ''));
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
        button.addEventListener('click', function (event) {
          if (event) { event.preventDefault(); event.stopPropagation(); }
          if (!user) { openLogin(); return; }
          var img = button.querySelector('img');
          changeReaction(reaction.shortcode, img ? img.src : null);
        });
        bar.appendChild(button);
      });

      var add = makeEl('button', 'pub-reaction-add antropedia-reaction-chip');
      add.type = 'button';
      add.title = 'Добавить реакцию';
      add.setAttribute('aria-label', 'Добавить реакцию');
      add.innerHTML = '<i class="far fa-face-smile" aria-hidden="true"></i>';
      add.addEventListener('click', function (event) {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        if (!user) { openLogin(); return; }
        if (window.PublicStickerPicker) {
          window.PublicStickerPicker.open(add, function (shortcode, pickedUrl) {
            changeReaction(shortcode.replace(/^:+|:+$/g, ''), pickedUrl);
          });
        }
      });
      bar.appendChild(add);

      async function changeReaction(shortcode, imageUrl) {
        var code = String(shortcode || '').trim().replace(/^:+|:+$/g, '').toLowerCase();
        if (!/^[a-z0-9-]{1,80}:[a-z0-9-]{1,80}$/.test(code)) {
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Реакция', message: 'Не удалось определить стикер. Выберите его из набора ещё раз.' });
          }
          return;
        }

        var prevReactions = (reactions || []).map(function (r) { return Object.assign({}, r); });
        if (!imageUrl) {
          var existingPill = bar.querySelector('.pub-reaction-pill img');
          if (existingPill) imageUrl = existingPill.src;
        }
        var optimistic = computeOptimisticReactions(prevReactions, code, imageUrl);
        if (onChange) onChange(optimistic);

        try {
          var path = '/api/articles/' + encodeURIComponent(slug);
          if (targetType === 'comment') path += '/comments/' + encodeURIComponent(targetId);
          var result = await authenticatedRequest(path + '/reactions/toggle', 'POST', { shortcode: code });
          if (result && Array.isArray(result.reactions)) {
            if (onChange) onChange(result.reactions);
          }
        } catch (error) {
          if (onChange) onChange(prevReactions);
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Реакция', message: error.message || 'Не удалось изменить реакцию' });
          }
        }
      }
      return bar;
    }

    function ensureArticleReportModal() {
      var modal = document.getElementById('antropediaReportModal');
      if (modal) {
        modal.querySelectorAll('[data-close-report-modal]').forEach(function (btn) {
          btn.onclick = function () { modal.hidden = true; };
        });
        modal.onclick = function (e) {
          if (e.target === modal) modal.hidden = true;
        };
        return modal;
      }
      modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'antropediaReportModal';
      modal.hidden = true;
      modal.style.zIndex = '3000';
      modal.innerHTML = 
        '<div class="modal-box" style="max-width: 480px; width: 100%;">' +
          '<div class="modal-header">' +
            '<h3>Пожаловаться на статью</h3>' +
            '<button type="button" class="modal-close" data-close-report-modal aria-label="Закрыть">&times;</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<p class="modal-hint" style="margin-bottom: 12px; font-size: 13px; color: var(--text-muted, #72767d);">' +
              '<i class="fas fa-circle-info"></i> <span>Жалоба на «<b id="antropediaReportArticleTitle"></b>» попадёт модераторам проекта.</span>' +
            '</p>' +
            '<div class="form-group" style="margin-bottom: 12px;">' +
              '<label class="form-label" for="antropediaReportReason">Причина *</label>' +
              '<select id="antropediaReportReason" class="form-select" style="width: 100%;">' +
                '<option value="">— выберите —</option>' +
                '<option value="inaccurate">Недостоверная информация</option>' +
                '<option value="outdated">Устарело</option>' +
                '<option value="offensive">Оскорбления / нарушение правил</option>' +
                '<option value="plagiarism">Плагиат</option>' +
                '<option value="spam">Спам / реклама</option>' +
                '<option value="other">Другое</option>' +
              '</select>' +
            '</div>' +
            '<div class="form-group" style="margin-bottom: 12px;">' +
              '<label class="form-label" for="antropediaReportDescription">Что не так со статьёй *</label>' +
              '<textarea id="antropediaReportDescription" class="form-textarea" maxlength="5000" placeholder="Какой фрагмент, что в нём неверно, как должно быть" rows="4" style="width: 100%; resize: vertical;"></textarea>' +
            '</div>' +
          '</div>' +
          '<div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px;">' +
            '<button type="button" class="btn btn-secondary" data-close-report-modal>Отмена</button>' +
            '<button type="button" class="btn btn-primary" id="antropediaReportSubmitBtn">Отправить</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      modal.querySelectorAll('[data-close-report-modal]').forEach(function (btn) {
        btn.onclick = function () { modal.hidden = true; };
      });
      modal.onclick = function (e) {
        if (e.target === modal) modal.hidden = true;
      };
      return modal;
    }

    function openArticleReportModal(article) {
      if (!article) return;
      var token = getAuthToken();
      if (!token) {
        openLogin();
        return;
      }
      var modal = ensureArticleReportModal();
      var titleEl = modal.querySelector('#antropediaReportArticleTitle');
      var reasonEl = modal.querySelector('#antropediaReportReason');
      var descEl = modal.querySelector('#antropediaReportDescription');
      var submitBtn = modal.querySelector('#antropediaReportSubmitBtn');

      if (titleEl) titleEl.textContent = article.title || article.slug;
      if (reasonEl) reasonEl.value = '';
      if (descEl) descEl.value = '';
      modal.hidden = false;
      if (reasonEl) reasonEl.focus();

      submitBtn.onclick = async function () {
        var reason = reasonEl ? reasonEl.value : '';
        var text = descEl ? descEl.value.trim() : '';
        if (!reason) {
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Жалоба', message: 'Выберите причину жалобы' });
          } else {
            alert('Выберите причину жалобы');
          }
          if (reasonEl) reasonEl.focus();
          return;
        }
        if (!text) {
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Жалоба', message: 'Опишите, что не так со статьёй' });
          } else {
            alert('Опишите, что не так со статьёй');
          }
          if (descEl) descEl.focus();
          return;
        }

        submitBtn.disabled = true;
        try {
          var payload = {
            category: 'complaint',
            target_type: 'article',
            target_slug: article.slug,
            reason: reason,
            text: text
          };
          var res = await authenticatedRequest('/api/feedback', 'POST', payload);
          modal.hidden = true;
          var msg = (res && res.id)
            ? 'Жалоба #' + res.id + ' отправлена модераторам'
            : 'Жалоба отправлена модераторам';
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Успешно', message: msg });
          } else {
            alert(msg);
          }
        } catch (err) {
          console.error('Ошибка отправки жалобы:', err);
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Ошибка', message: err.message || 'Не удалось отправить жалобу' });
          } else {
            alert(err.message || 'Не удалось отправить жалобу');
          }
        } finally {
          submitBtn.disabled = false;
        }
      };
    }

    function initArticleEngagement(article, container, userPromise) {
      var panel = makeEl('div', 'pub-article-engagement');
      var actions = makeEl('div', 'pub-article-engagement-actions');
      var like = makeEngageButton('far fa-heart', article.likesCount, 'Нравится', 'is-like');
      var comments = makeEngageButton('far fa-comment', article.commentsCount, 'Комментарии', 'is-comment');
      var report = makeEl('button', 'engage-item is-report');
      report.type = 'button';
      report.id = 'publicArticleReportBtn';
      report.title = 'Пожаловаться на статью';
      report.setAttribute('aria-label', 'Пожаловаться на статью');
      report.innerHTML = '<i class="far fa-flag" aria-hidden="true"></i>';

      report.addEventListener('click', function () {
        if (!currentUser && !getAuthToken()) {
          openLogin();
          return;
        }
        openArticleReportModal(article);
      });
      var currentUser = null;
      var reactionBar;

      like.addEventListener('click', async function () {
        if (!currentUser) { openLogin(); return; }
        var wasLiked = like.classList.contains('active');
        var prevCount = parseInt(like.querySelector('span').textContent.replace(/\D/g, ''), 10) || 0;
        var nextLiked = !wasLiked;
        var nextCount = Math.max(0, prevCount + (nextLiked ? 1 : -1));

        // Instant optimistic update
        article.liked = nextLiked;
        article.likesCount = nextCount;
        syncArticleLikesUI(article.slug, nextLiked, nextCount);

        try {
          var result = await authenticatedRequest('/api/articles/' + encodeURIComponent(article.slug) + '/likes/toggle', 'POST');
          if (result && typeof result.count === 'number') {
            article.liked = !!result.liked;
            article.likesCount = result.count;
            syncArticleLikesUI(article.slug, article.liked, article.likesCount);
          }
        } catch (error) {
          article.liked = wasLiked;
          article.likesCount = prevCount;
          syncArticleLikesUI(article.slug, wasLiked, prevCount);
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Лайк', message: error.message || 'Не удалось поставить лайк' });
          }
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

        var card = document.querySelector('.wiki-card[data-slug="' + article.slug + '"]');
        if (card) {
          var cardBar = card.querySelector('.public-card-reactions');
          if (cardBar) {
            article.reactions = updated;
            var rep = createCardReactionBar(article, currentUser);
            cardBar.replaceWith(rep);
          }
        }
      }

      actions.appendChild(like);
      updateReactions([]);
      actions.appendChild(comments);
      actions.appendChild(report);
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

    // ========================================
    // Поиск по тексту открытой статьи (инлайн-поиск)
    // ========================================
    var searchWidgetEl = document.getElementById('antropediaTocSearch');
    var searchTriggerBtn = document.getElementById('antropediaTocSearchIconBtn');
    var inlineSearchWrap = document.getElementById('antropediaTocSearchBody');
    var inlineSearchEl = document.getElementById('antropediaInlineSearch');
    var inlineSearchCountEl = document.getElementById('antropediaInlineSearchCount');
    var inlineSearchPrevBtn = document.getElementById('antropediaInlineSearchPrev');
    var inlineSearchNextBtn = document.getElementById('antropediaInlineSearchNext');
    var inlineSearchClearBtn = document.getElementById('antropediaInlineSearchClear');
    var currentContentEl = null;
    var searchHits = [];
    var searchIndex = -1;
    var inlineSearchDebounce = null;

    function openMobileSearch() {
      var bar = document.getElementById('antropediaMobileSearchBar');
      var input = document.getElementById('antropediaMobileSearchInput');
      var toggleBtn = document.getElementById('antropediaMobileSearchToggleBtn');
      if (!bar) return;
      bar.hidden = false;
      if (toggleBtn) toggleBtn.classList.add('active');
      if (!input) input = bar.querySelector('input');
      if (inlineSearchEl && inlineSearchEl.value.trim() && input) {
        input.value = inlineSearchEl.value;
      }
      if (input) {
        setTimeout(function () {
          input.focus();
          input.select();
        }, 60);
        if (input.value.trim()) {
          runInArticleSearch(input.value, { autoScroll: false });
        }
      }
    }

    function closeMobileSearch() {
      var bar = document.getElementById('antropediaMobileSearchBar');
      if (bar) bar.hidden = true;
      var toggleBtn = document.getElementById('antropediaMobileSearchToggleBtn');
      if (toggleBtn) toggleBtn.classList.remove('active');
      var input = document.getElementById('antropediaMobileSearchInput');
      if (input) input.value = '';
      closeInArticleSearch();
    }

    function openInArticleSearch() {
      if (window.innerWidth <= 1024) {
        openMobileSearch();
        return;
      }
      if (!searchWidgetEl) {
        searchWidgetEl = document.getElementById('antropediaTocSearch');
      }
      var sb = document.getElementById('antropediaViewSidebar');
      if (sb) {
        sb.hidden = false;
      }
      if (searchWidgetEl) {
        searchWidgetEl.classList.add('is-open');
      }
      if (!inlineSearchEl) {
        inlineSearchEl = document.getElementById('antropediaInlineSearch');
      }
      if (inlineSearchEl) {
        setTimeout(function () {
          inlineSearchEl.focus();
          inlineSearchEl.select();
        }, 60);
        if (inlineSearchEl.value.trim()) {
          runInArticleSearch(inlineSearchEl.value, { autoScroll: false });
        }
      }
    }

    function closeInArticleSearch() {
      clearInArticleSearch();
      if (!searchWidgetEl) {
        searchWidgetEl = document.getElementById('antropediaTocSearch');
      }
      if (searchWidgetEl) {
        searchWidgetEl.classList.remove('is-open');
      }
      if (inlineSearchEl) inlineSearchEl.blur();
      var bar = document.getElementById('antropediaMobileSearchBar');
      if (bar) bar.hidden = true;
      var mobileInput = document.getElementById('antropediaMobileSearchInput');
      if (mobileInput) {
        mobileInput.value = '';
        mobileInput.blur();
      }
    }

    function toggleInArticleSearch(e) {
      if (e) e.stopPropagation();
      if (!searchWidgetEl) {
        searchWidgetEl = document.getElementById('antropediaTocSearch');
      }
      if (searchWidgetEl && searchWidgetEl.classList.contains('is-open')) {
        closeInArticleSearch();
      } else {
        openInArticleSearch();
      }
    }

    function onArticleSearchOutsideClick(e) {
      if (!searchWidgetEl || !searchWidgetEl.classList.contains('is-open')) return;
      if (searchWidgetEl.contains(e.target)) return;
      var inputEl = inlineSearchEl || (detail && detail.querySelector('#antropediaInlineSearch'));
      if (!inputEl || !inputEl.value.trim()) {
        closeInArticleSearch();
      }
    }

    function updateSearchCount() {
      var inputEl = inlineSearchEl || (detail && detail.querySelector('#antropediaInlineSearch'));
      var mobileInputEl = document.getElementById('antropediaMobileSearchInput');
      var countEl = inlineSearchCountEl || (detail && detail.querySelector('#antropediaInlineSearchCount'));
      var mobileCountEl = document.getElementById('antropediaMobileSearchCount');
      var prevBtn = inlineSearchPrevBtn || (detail && detail.querySelector('#antropediaInlineSearchPrev'));
      var nextBtn = inlineSearchNextBtn || (detail && detail.querySelector('#antropediaInlineSearchNext'));
      var clearBtn = inlineSearchClearBtn || (detail && detail.querySelector('#antropediaInlineSearchClear'));
      var mobilePrevBtn = document.getElementById('antropediaMobileSearchPrev');
      var mobileNextBtn = document.getElementById('antropediaMobileSearchNext');

      var query = (mobileInputEl && mobileInputEl.value.trim()) || (inputEl ? inputEl.value.trim() : '');
      var hasQuery = !!query;
      var countText = searchHits.length
        ? (searchIndex + 1) + '/' + searchHits.length
        : (hasQuery ? '0/0' : '');

      if (countEl) {
        countEl.hidden = !hasQuery;
        countEl.textContent = countText;
      }
      if (mobileCountEl) {
        mobileCountEl.hidden = !hasQuery;
        mobileCountEl.textContent = countText;
      }

      var showNav = hasQuery && searchHits.length > 0;
      if (prevBtn) prevBtn.hidden = !showNav;
      if (nextBtn) nextBtn.hidden = !showNav;
      if (clearBtn) clearBtn.hidden = false;
      if (mobilePrevBtn) mobilePrevBtn.hidden = !showNav;
      if (mobileNextBtn) mobileNextBtn.hidden = !showNav;
    }

    function clearSearchHighlights() {
      var content = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (content) {
        content.querySelectorAll('mark.search-hit, mark.antropedia-search-hit').forEach(function (mark) {
          var parent = mark.parentNode;
          if (!parent) return;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        });
      }
      searchHits = [];
      searchIndex = -1;
    }

    function clearInArticleSearch() {
      var inputEl = inlineSearchEl || (detail && detail.querySelector('#antropediaInlineSearch'));
      if (inputEl) inputEl.value = '';
      var mobileInputEl = document.getElementById('antropediaMobileSearchInput');
      if (mobileInputEl) mobileInputEl.value = '';
      clearSearchHighlights();
      updateSearchCount();
    }

    function gotoSearchHit(dir) {
      if (!searchHits.length) return;
      if (searchIndex >= 0 && searchHits[searchIndex]) {
        searchHits[searchIndex].classList.remove('search-hit-active', 'antropedia-search-hit-current');
      }
      searchIndex = (searchIndex + dir + searchHits.length) % searchHits.length;
      var hit = searchHits[searchIndex];
      if (!hit) return;
      var infobox = hit.closest('.blk-infobox.is-collapsed');
      if (infobox) {
        var moreBtn = infobox.querySelector('.blk-infobox-more');
        if (moreBtn) moreBtn.click();
      }
      hit.classList.add('search-hit-active', 'antropedia-search-hit-current');
      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateSearchCount();
    }

    function runInArticleSearch(query, options) {
      clearSearchHighlights();
      var inputEl = inlineSearchEl || (detail && detail.querySelector('#antropediaInlineSearch'));
      var q = (query != null ? String(query) : (inputEl ? inputEl.value : '')).trim();
      if (inputEl && query != null && inputEl.value !== query) {
        inputEl.value = query;
      }
      var content = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!q || !content) {
        updateSearchCount();
        return;
      }

      var qLower = q.toLowerCase();
      var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
          var tag = node.parentElement.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
          return node.nodeValue.toLowerCase().indexOf(qLower) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var nodes = [];
      var n;
      while ((n = walker.nextNode())) nodes.push(n);

      nodes.forEach(function (node) {
        var text = node.nodeValue;
        var lower = text.toLowerCase();
        var frag = document.createDocumentFragment();
        var lastIndex = 0;
        var idx = lower.indexOf(qLower);
        while (idx !== -1) {
          if (idx > lastIndex) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
          }
          var mark = document.createElement('mark');
          mark.className = 'search-hit antropedia-search-hit';
          mark.textContent = text.slice(idx, idx + q.length);
          frag.appendChild(mark);
          lastIndex = idx + q.length;
          idx = lower.indexOf(qLower, lastIndex);
        }
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        if (node.parentNode) {
          node.parentNode.replaceChild(frag, node);
        }
      });

      searchHits = Array.from(content.querySelectorAll('mark.search-hit, mark.antropedia-search-hit'));
      searchIndex = -1;
      updateSearchCount();

      var opts = options || {};
      if (searchHits.length) {
        if (opts.autoScroll) {
          gotoSearchHit(1);
        } else {
          // Подсвечиваем первое совпадение активным, но не сдвигаем экран при наборе
          searchIndex = 0;
          var firstHit = searchHits[0];
          firstHit.classList.add('search-hit-active', 'antropedia-search-hit-current');
          var infobox = firstHit.closest('.blk-infobox.is-collapsed');
          if (infobox) {
            var moreBtn = infobox.querySelector('.blk-infobox-more');
            if (moreBtn) moreBtn.click();
          }
          updateSearchCount();
        }
      }
    }

    function initArticleSearchListeners() {
      if (!searchWidgetEl) {
        searchWidgetEl = document.getElementById('antropediaTocSearch');
      }
      if (!searchTriggerBtn) {
        searchTriggerBtn = document.getElementById('antropediaTocSearchIconBtn');
      }
      if (!inlineSearchWrap) {
        inlineSearchWrap = document.getElementById('antropediaTocSearchBody');
      }
      if (!inlineSearchEl) {
        inlineSearchEl = document.getElementById('antropediaInlineSearch');
      }
      if (!inlineSearchCountEl) {
        inlineSearchCountEl = document.getElementById('antropediaInlineSearchCount');
      }
      if (!inlineSearchPrevBtn) {
        inlineSearchPrevBtn = document.getElementById('antropediaInlineSearchPrev');
      }
      if (!inlineSearchNextBtn) {
        inlineSearchNextBtn = document.getElementById('antropediaInlineSearchNext');
      }
      if (!inlineSearchClearBtn) {
        inlineSearchClearBtn = document.getElementById('antropediaInlineSearchClear');
      }

      if (searchTriggerBtn) {
        searchTriggerBtn.addEventListener('click', toggleInArticleSearch);
      }
      if (inlineSearchEl) {
        inlineSearchEl.addEventListener('input', function () {
          clearTimeout(inlineSearchDebounce);
          inlineSearchDebounce = setTimeout(function () {
            runInArticleSearch(inlineSearchEl.value, { autoScroll: false });
          }, 200);
        });
        inlineSearchEl.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeInArticleSearch();
            return;
          }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!searchHits.length && inlineSearchEl.value.trim()) {
            runInArticleSearch(inlineSearchEl.value, { autoScroll: true });
          } else {
            gotoSearchHit(e.shiftKey ? -1 : 1);
          }
        });
      }
      if (inlineSearchPrevBtn) {
        inlineSearchPrevBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          gotoSearchHit(-1);
        });
      }
      if (inlineSearchNextBtn) {
        inlineSearchNextBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          gotoSearchHit(1);
        });
      }
      if (inlineSearchClearBtn) {
        inlineSearchClearBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          closeInArticleSearch();
        });
      }
      document.addEventListener('click', onArticleSearchOutsideClick);
    }
    initArticleSearchListeners();
    // ========================================
    // Селектор слоёв открытой статьи
    // ========================================
    var layerSwitcherEl = document.getElementById('antropediaViewLayerSwitcher');
    var layerBtnEl = document.getElementById('antropediaViewLayerBtn');
    var layerLabelEl = document.getElementById('antropediaViewLayerLabel');
    var layerMenuEl = document.getElementById('antropediaViewLayerMenu');
    var currentArticleSwitcherHandler = null;

    function getLayerSwitcherElements() {
      if (!layerSwitcherEl) layerSwitcherEl = document.getElementById('antropediaViewLayerSwitcher');
      if (!layerBtnEl) layerBtnEl = document.getElementById('antropediaViewLayerBtn');
      if (!layerLabelEl) layerLabelEl = document.getElementById('antropediaViewLayerLabel');
      if (!layerMenuEl) layerMenuEl = document.getElementById('antropediaViewLayerMenu');
      return {
        switcher: layerSwitcherEl,
        btn: layerBtnEl,
        label: layerLabelEl,
        menu: layerMenuEl
      };
    }

    function openLayerDropdown() {
      var els = getLayerSwitcherElements();
      if (!els.switcher || !els.menu) return;
      els.switcher.classList.add('is-open');
      els.menu.hidden = false;
      if (els.btn) els.btn.setAttribute('aria-expanded', 'true');
    }

    function closeLayerDropdown() {
      var els = getLayerSwitcherElements();
      if (!els.switcher || !els.menu) return;
      els.switcher.classList.remove('is-open');
      els.menu.hidden = true;
      if (els.btn) els.btn.setAttribute('aria-expanded', 'false');
    }

    function toggleLayerDropdown(e) {
      if (e) e.stopPropagation();
      var els = getLayerSwitcherElements();
      if (!els.switcher) return;
      if (els.switcher.classList.contains('is-open')) {
        closeLayerDropdown();
      } else {
        openLayerDropdown();
      }
    }

    function onLayerDropdownOutsideClick(e) {
      var els = getLayerSwitcherElements();
      if (!els.switcher || !els.switcher.classList.contains('is-open')) return;
      if (els.switcher.contains(e.target)) return;
      closeLayerDropdown();
    }

    function initLayerDropdownListeners() {
      var els = getLayerSwitcherElements();
      if (els.btn) {
        els.btn.addEventListener('click', toggleLayerDropdown);
      }
      if (els.menu) {
        els.menu.addEventListener('click', function (e) {
          var item = e.target.closest('.antropedia-layer-dropdown-item');
          if (!item) return;
          e.preventDefault();
          var targetIndex = parseInt(item.dataset.layerIndex, 10);
          closeLayerDropdown();
          if (typeof currentArticleSwitcherHandler === 'function') {
            currentArticleSwitcherHandler(targetIndex);
          }
        });
      }
      document.addEventListener('click', onLayerDropdownOutsideClick);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          closeLayerDropdown();
        }
      });
    }
    initLayerDropdownListeners();

    // ========================================
    // Закладки на блоках статьи и желоб закладок (bookmark-gutter)
    // ========================================
    var BOOKMARK_COLORS = ['#5865f2', '#3ba55d', '#ed4245', '#faa81a', '#9b59b6', '#eb459e', '#00b0f4', '#f0791f'];
    var BOOKMARK_TAB_MIN_SPACE = 190;
    var currentArticleBookmarks = [];
    var currentArticleSlug = null;
    var currentArticleTitle = null;
    var pendingBookmark = null;
    var selectedBookmarkColor = BOOKMARK_COLORS[0];
    var bmHoverCapable = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    var bmWideMode = false;
    var bmBlocks = [];
    var bmLastHoverY = 0;
    var bmHoverMoveScheduled = false;
    var bmGutterResizeDebounce = null;
    var bookmarkGhostEl = null;
    var bookmarkGutterHoverEl = null;
    var bookmarkCompactHoverEl = null;
    var currentSelectedRangeInfo = null;
    var lastSelectedRangeInfo = null;
    var selectionDebounce = null;

    function hasWideGutterSpace() {
      var art = detail || document.getElementById('publicArticleDetail');
      if (!art) return false;
      return art.getBoundingClientRect().left >= BOOKMARK_TAB_MIN_SPACE;
    }

    function updateBookmarksBadge(count) {
      var btn = document.querySelector('.antropedia-sidebar-tab[data-sidebar-tab="bookmarks"]');
      if (!btn) return;
      var badge = btn.querySelector('.antropedia-tab-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'antropedia-tab-badge';
          btn.appendChild(badge);
        }
        badge.textContent = count;
      } else if (badge) {
        badge.remove();
      }
    }

    function escapeRegExp(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function findQuoteRange(containerEl, quote) {
      if (!containerEl || !quote || typeof quote !== 'string') return null;
      var targetText = quote.trim();
      if (!targetText) return null;

      var walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, null, false);
      var textNodes = [];
      var fullText = '';
      var nodeOffsets = [];
      var node;
      while ((node = walker.nextNode())) {
        textNodes.push(node);
        nodeOffsets.push(fullText.length);
        fullText += node.nodeValue;
      }

      var matchIdx = fullText.indexOf(targetText);
      var matchLen = targetText.length;

      if (matchIdx === -1) {
        var cleanTarget = targetText.replace(/[\s\u00A0\u1680\u180e\u2000-\u200b\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
        var words = cleanTarget.split(' ').filter(Boolean);
        if (words.length > 0) {
          var wsPattern = '[\\s\\u00A0\\u1680\\u180e\\u2000-\\u200b\\u202f\\u205f\\u3000\\ufeff]+';
          var rxPattern = words.map(escapeRegExp).join(wsPattern);
          try {
            var rx = new RegExp(rxPattern, 'i');
            var match = rx.exec(fullText);
            if (match) {
              matchIdx = match.index;
              matchLen = match[0].length;
            } else if (words.length > 2) {
              for (var wCount = words.length - 1; wCount >= Math.max(2, words.length - 3); wCount--) {
                var subPattern = words.slice(0, wCount).map(escapeRegExp).join(wsPattern);
                var subMatch = new RegExp(subPattern, 'i').exec(fullText);
                if (subMatch) {
                  matchIdx = subMatch.index;
                  matchLen = subMatch[0].length;
                  break;
                }
              }
            }
          } catch (_) {}
        }
      }

      if (matchIdx === -1) return null;

      var endIdx = matchIdx + matchLen;
      var startNode = null;
      var startOffset = 0;
      var endNode = null;
      var endOffset = 0;

      for (var i = 0; i < textNodes.length; i++) {
        var nStart = nodeOffsets[i];
        var nEnd = nStart + textNodes[i].nodeValue.length;
        if (!startNode && matchIdx >= nStart && (matchIdx < nEnd || (i === textNodes.length - 1 && matchIdx === nEnd))) {
          startNode = textNodes[i];
          startOffset = matchIdx - nStart;
        }
        if (endIdx >= nStart && endIdx <= nEnd) {
          endNode = textNodes[i];
          endOffset = endIdx - nStart;
          break;
        }
      }

      if (startNode && endNode) {
        try {
          var range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          return range;
        } catch (_) {
          return null;
        }
      }
      return null;
    }

    function highlightRange(range, color) {
      if (!range) return false;
      var flashColor = color || '#5865f2';
      var marks = [];

      try {
        var startNode = range.startContainer;
        var startOffset = range.startOffset;
        var endNode = range.endContainer;
        var endOffset = range.endOffset;

        if (startNode === endNode && startNode.nodeType === 3) {
          var textVal = startNode.nodeValue;
          var beforeText = textVal.slice(0, startOffset);
          var highlightText = textVal.slice(startOffset, endOffset);
          var afterText = textVal.slice(endOffset);

          var parent = startNode.parentNode;
          if (!parent) return false;

          var frag = document.createDocumentFragment();
          if (beforeText) frag.appendChild(document.createTextNode(beforeText));
          var mark = document.createElement('mark');
          mark.className = 'antropedia-line-flash';
          mark.style.setProperty('--bm-color', flashColor);
          mark.textContent = highlightText;
          marks.push(mark);
          frag.appendChild(mark);
          if (afterText) frag.appendChild(document.createTextNode(afterText));

          parent.replaceChild(frag, startNode);

          setTimeout(function () {
            if (mark.parentNode) {
              var p = mark.parentNode;
              while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
              mark.remove();
              p.normalize();
            }
          }, 1900);
          return true;
        }

        var common = range.commonAncestorContainer;
        var rootEl = common.nodeType === 3 ? common.parentNode : common;
        var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
        var textNodes = [];
        var inRange = false;
        var currNode;
        while ((currNode = walker.nextNode())) {
          if (currNode === startNode) inRange = true;
          if (inRange) textNodes.push(currNode);
          if (currNode === endNode) break;
        }

        if (!textNodes.length) return false;

        for (var i = textNodes.length - 1; i >= 0; i--) {
          var node = textNodes[i];
          var s = (node === startNode) ? startOffset : 0;
          var e = (node === endNode) ? endOffset : node.nodeValue.length;
          if (s >= e) continue;

          var t = node.nodeValue;
          var b = t.slice(0, s);
          var h = t.slice(s, e);
          var a = t.slice(e);

          var pNode = node.parentNode;
          if (!pNode) continue;

          var f = document.createDocumentFragment();
          if (b) f.appendChild(document.createTextNode(b));
          var m = document.createElement('mark');
          m.className = 'antropedia-line-flash';
          m.style.setProperty('--bm-color', flashColor);
          m.textContent = h;
          marks.push(m);
          f.appendChild(m);
          if (a) f.appendChild(document.createTextNode(a));

          pNode.replaceChild(f, node);
        }

        setTimeout(function () {
          marks.forEach(function (m) {
            if (m.parentNode) {
              var p = m.parentNode;
              while (m.firstChild) p.insertBefore(m.firstChild, m);
              m.remove();
              p.normalize();
            }
          });
        }, 1900);

        return marks.length > 0;
      } catch (_) {
        return false;
      }
    }

    function jumpToBookmark(bookmark) {
      if (!bookmark) return;
      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;

      var blockEl = null;
      if (bookmark.blockId) {
        try {
          blockEl = contentEl.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(bookmark.blockId) : bookmark.blockId) + '"]');
        } catch (_) {}
        if (!blockEl) blockEl = document.getElementById(bookmark.blockId);
      }

      var range = (blockEl && bookmark.quote) ? findQuoteRange(blockEl, bookmark.quote) : null;
      if (!range && bookmark.quote && contentEl) {
        range = findQuoteRange(contentEl, bookmark.quote);
      }
      var headerOffset = 90;
      var currentScroll = window.pageYOffset || document.documentElement.scrollTop || 0;
      var targetTop = 0;

      if (range) {
        var rangeRect = range.getBoundingClientRect();
        if (rangeRect && rangeRect.height > 0) {
          targetTop = rangeRect.top + currentScroll - headerOffset;
        }
      }
      if (!targetTop && blockEl) {
        var blockRect = blockEl.getBoundingClientRect();
        targetTop = blockRect.top + currentScroll - headerOffset;
      }

      if (targetTop) {
        window.scrollTo({
          top: Math.max(0, Math.round(targetTop)),
          behavior: 'smooth'
        });
      }

      var flashed = highlightRange(range, bookmark.color);
      if (!flashed && blockEl) {
        blockEl.classList.remove('antropedia-block-flash');
        void blockEl.offsetWidth;
        blockEl.classList.add('antropedia-block-flash');
        setTimeout(function () {
          blockEl.classList.remove('antropedia-block-flash');
        }, 1600);
      }

      closeSidebarOnMobile();
    }

    function scrollToBlock(blockId) {
      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;
      var target = null;
      try {
        target = contentEl.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(blockId) : blockId) + '"]');
      } catch (_) {
        target = null;
      }
      if (!target) target = document.getElementById(blockId);
      if (!target) return;

      var headerOffset = 88;
      var targetRect = target.getBoundingClientRect();
      var currentScroll = window.pageYOffset || document.documentElement.scrollTop || 0;
      var targetTop = targetRect.top + currentScroll - headerOffset;
      window.scrollTo({
        top: Math.max(0, Math.round(targetTop)),
        behavior: 'smooth'
      });

      target.classList.remove('antropedia-block-flash');
      void target.offsetWidth;
      target.classList.add('antropedia-block-flash');
      setTimeout(function () {
        target.classList.remove('antropedia-block-flash');
      }, 1600);

      closeSidebarOnMobile();
    }

    function renderBookmarkColorSwatches() {
      var colorsEl = document.getElementById('antropediaBookmarkPopoverColors');
      if (!colorsEl) return;
      colorsEl.innerHTML = BOOKMARK_COLORS.map(function (c) {
        var activeClass = c === selectedBookmarkColor ? ' active' : '';
        return '<button type="button" class="antropedia-bookmark-swatch' + activeClass + '" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
      }).join('');
      colorsEl.querySelectorAll('.antropedia-bookmark-swatch').forEach(function (btn) {
        btn.addEventListener('click', function () {
          selectedBookmarkColor = btn.getAttribute('data-color');
          colorsEl.querySelectorAll('.antropedia-bookmark-swatch').forEach(function (b) {
            b.classList.toggle('active', b === btn);
          });
        });
      });
    }

    function positionFloating(el, cx, cy, width, height) {
      if (!el) return;
      var margin = 8;
      var left = Math.min(Math.max(margin, cx - width / 2), window.innerWidth - width - margin);
      var top = cy;
      if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, cy - height - 16);
      }
      top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(top) + 'px';
    }

    function openBookmarkPopover(blockId, anchorEl, selectedQuote, existingBookmarkId) {
      var token = getAuthToken();
      if (!token) {
        openLogin();
        return;
      }

      var existing = null;
      if (existingBookmarkId) {
        existing = currentArticleBookmarks.find(function (b) { return String(b.id) === String(existingBookmarkId); });
      }

      if (!existing) {
        var countForBlock = currentArticleBookmarks.filter(function (b) { return b.blockId === blockId; }).length;
        if (countForBlock >= 3) {
          if (window.confirmDialog) {
            window.confirmDialog.alert({ title: 'Лимит закладок', message: 'На один абзац можно добавить не более 3 закладок.' });
          } else {
            alert('На один абзац можно добавить не более 3 закладок.');
          }
          return;
        }
      }

      pendingBookmark = {
        blockId: blockId,
        id: existing ? existing.id : null,
        quote: selectedQuote || (existing ? existing.quote : null)
      };

      var nameEl = document.getElementById('antropediaBookmarkPopoverName');
      var delBtn = document.getElementById('antropediaBookmarkPopoverDelete');
      var popoverEl = document.getElementById('antropediaBookmarkPopover');
      var backdropEl = document.getElementById('antropediaBookmarkModalBackdrop');

      if (nameEl) {
        if (existing) {
          nameEl.value = existing.name;
        } else if (selectedQuote) {
          nameEl.value = selectedQuote.slice(0, 35).trim();
        } else {
          nameEl.value = '';
        }
      }
      selectedBookmarkColor = existing ? existing.color : BOOKMARK_COLORS[0];
      renderBookmarkColorSwatches();
      if (delBtn) delBtn.hidden = !existing;

      if (popoverEl) {
        popoverEl.hidden = false;
        var isMobile = window.innerWidth <= 768 || !bmHoverCapable;
        if (!isMobile && anchorEl) {
          var rect = anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
          if (rect && (rect.width > 0 || rect.height > 0)) {
            positionFloating(popoverEl, rect.left + rect.width / 2, rect.bottom + 8, 280, 220);
          } else {
            var blockEl = null;
            try {
              var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
              blockEl = contentEl ? contentEl.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(blockId) : blockId) + '"]') : null;
            } catch (_) {}
            var bRect = blockEl ? blockEl.getBoundingClientRect() : null;
            if (bRect && (bRect.width > 0 || bRect.height > 0)) {
              positionFloating(popoverEl, bRect.left + 40, bRect.top + 8, 280, 220);
            } else {
              positionFloating(popoverEl, window.innerWidth / 2, window.innerHeight / 2 - 110, 280, 220);
            }
          }
        } else {
          popoverEl.style.removeProperty('left');
          popoverEl.style.removeProperty('top');
          if (backdropEl) backdropEl.hidden = false;
        }
      }
      if (nameEl) {
        nameEl.focus();
        nameEl.select();
      }
    }

    function closeBookmarkPopover() {
      var popoverEl = document.getElementById('antropediaBookmarkPopover');
      var backdropEl = document.getElementById('antropediaBookmarkModalBackdrop');
      if (popoverEl) popoverEl.hidden = true;
      if (backdropEl) backdropEl.hidden = true;
      pendingBookmark = null;
      hideSelectionUI();
    }

    async function saveBookmarkFromPopover() {
      if (!pendingBookmark || !currentArticleSlug) return;
      var nameEl = document.getElementById('antropediaBookmarkPopoverName');
      var name = (nameEl ? nameEl.value : '').trim();
      if (!name) {
        if (nameEl) nameEl.focus();
        return;
      }
      var color = selectedBookmarkColor || BOOKMARK_COLORS[0];
      var token = getAuthToken();
      if (!token) {
        openLogin();
        return;
      }

      try {
        if (pendingBookmark.id) {
          var res = await fetch('/api/bookmarks/' + encodeURIComponent(pendingBookmark.id), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ name: name, color: color })
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
        } else {
          var quoteText = pendingBookmark.quote || '';
          if (!quoteText) {
            var blockEl = null;
            try {
              var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
              blockEl = contentEl?.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(pendingBookmark.blockId) : pendingBookmark.blockId) + '"]');
            } catch (_) {
              blockEl = null;
            }
            quoteText = blockEl ? blockEl.textContent.trim().slice(0, 2000) : '';
          }
          var res = await fetch('/api/bookmarks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
              slug: currentArticleSlug,
              title: currentArticleTitle || currentArticleSlug,
              blockId: pendingBookmark.blockId,
              quote: quoteText,
              name: name,
              color: color
            })
          });
          if (!res.ok) {
            var errData = {};
            try { errData = await res.json(); } catch (_) {}
            throw new Error(errData.error || ('HTTP ' + res.status));
          }
        }
        closeBookmarkPopover();
        await loadArticleBookmarks();
      } catch (e) {
        console.error('Не удалось сохранить закладку:', e);
        if (window.confirmDialog) {
          window.confirmDialog.alert({ title: 'Ошибка', message: e.message || 'Не удалось сохранить закладку' });
        } else {
          alert(e.message || 'Не удалось сохранить закладку');
        }
      }
    }

    async function renameBookmark(id, name) {
      try {
        var token = getAuthToken();
        var res = await fetch('/api/bookmarks/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ name: name })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        currentArticleBookmarks = currentArticleBookmarks.map(function (b) {
          return String(b.id) === String(id) ? Object.assign({}, b, { name: name }) : b;
        });
        updateBookmarksBadge(currentArticleBookmarks.length);
        renderBookmarksPanel();
        renderBookmarkGutter();
      } catch (e) {
        console.error('Не удалось переименовать закладку:', e);
      }
    }

    async function deleteBookmarkById(id) {
      try {
        var token = getAuthToken();
        var res = await fetch('/api/bookmarks/' + encodeURIComponent(id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        currentArticleBookmarks = currentArticleBookmarks.filter(function (b) {
          return String(b.id) !== String(id);
        });
        updateBookmarksBadge(currentArticleBookmarks.length);
        renderBookmarksPanel();
        renderBookmarkGutter();
      } catch (e) {
        console.error('Не удалось удалить закладку:', e);
      }
    }

    async function loadArticleBookmarks() {
      var slug = currentArticleSlug;
      if (!slug) return;
      var token = getAuthToken();
      if (!token) {
        currentArticleBookmarks = [];
        updateBookmarksBadge(0);
        renderBookmarksPanel();
        renderBookmarkGutter();
        return;
      }
      try {
        var res = await fetch('/api/bookmarks?slug=' + encodeURIComponent(slug), {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (res.ok) {
          var data = await res.json();
          currentArticleBookmarks = Array.isArray(data) ? data : [];
        } else {
          currentArticleBookmarks = [];
        }
      } catch (_) {
        currentArticleBookmarks = [];
      }
      var isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
      if (isMobile) {
        bmAllHighlightsActive = true;
      }
      updateBookmarksBadge(currentArticleBookmarks.length);
      renderBookmarksPanel();
      renderBookmarkGutter();
      if (bmAllHighlightsActive) {
        renderAllBookmarkHighlights();
      }
    }

    var bmAllHighlightsActive = false;

    function hexToRgba(hex, alpha) {
      if (!hex) return 'rgba(88, 101, 242, ' + alpha + ')';
      if (hex.charAt(0) === '#' && hex.length === 7) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
      }
      return hex;
    }

    function getStripeBackground(colors) {
      if (!colors || !colors.length) return 'transparent';
      if (colors.length === 1) {
        return hexToRgba(colors[0], 0.32);
      }
      if (colors.length === 2) {
        var c1 = hexToRgba(colors[0], 0.36);
        var c2 = hexToRgba(colors[1], 0.36);
        return 'repeating-linear-gradient(135deg, ' +
          c1 + ' 0px, ' + c1 + ' 6px, ' +
          c2 + ' 6px, ' + c2 + ' 12px)';
      }
      var c1 = hexToRgba(colors[0], 0.40);
      var c2 = hexToRgba(colors[1], 0.40);
      var c3 = hexToRgba(colors[2], 0.40);
      return 'repeating-linear-gradient(135deg, ' +
        c1 + ' 0px, ' + c1 + ' 6px, ' +
        c2 + ' 6px, ' + c2 + ' 12px, ' +
        c3 + ' 12px, ' + c3 + ' 18px)';
    }

    function decomposeIntervals(intervals, fullLength) {
      var cutPoints = new Set([0, fullLength]);
      intervals.forEach(function (it) {
        cutPoints.add(Math.max(0, Math.min(fullLength, it.start)));
        cutPoints.add(Math.max(0, Math.min(fullLength, it.end)));
      });

      var sortedPoints = Array.from(cutPoints).sort(function (a, b) { return a - b; });
      var segments = [];

      for (var i = 0; i < sortedPoints.length - 1; i++) {
        var s = sortedPoints[i];
        var e = sortedPoints[i + 1];
        if (s >= e) continue;

        var active = intervals.filter(function (it) { return it.start <= s && it.end >= e; });
        if (!active.length) continue;

        var colors = active.map(function (it) { return it.color; });
        var uniqueColors = Array.from(new Set(colors)).slice(0, 3);
        var ids = active.map(function (it) { return it.id; });

        segments.push({
          start: s,
          end: e,
          colors: uniqueColors,
          ids: ids
        });
      }

      return segments;
    }

    function getRangeOffsetsInBlock(blockEl, range) {
      try {
        var preRange = document.createRange();
        preRange.selectNodeContents(blockEl);
        preRange.setEnd(range.startContainer, range.startOffset);
        var start = preRange.toString().length;
        var len = range.toString().length;
        return { start: start, end: start + len };
      } catch (_) {
        return null;
      }
    }

    function createRangeFromOffsets(containerEl, startOffset, endOffset) {
      var walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, null, false);
      var currentPos = 0;
      var startNode = null;
      var startNodeOffset = 0;
      var endNode = null;
      var endNodeOffset = 0;
      var node;

      while ((node = walker.nextNode())) {
        var len = node.nodeValue.length;
        var nextPos = currentPos + len;

        if (!startNode && startOffset >= currentPos && startOffset <= nextPos) {
          startNode = node;
          startNodeOffset = startOffset - currentPos;
        }
        if (!endNode && endOffset >= currentPos && endOffset <= nextPos) {
          endNode = node;
          endNodeOffset = endOffset - currentPos;
          break;
        }
        currentPos = nextPos;
      }

      if (!startNode || !endNode) return null;

      var range = document.createRange();
      try {
        range.setStart(startNode, startNodeOffset);
        range.setEnd(endNode, endNodeOffset);
        return range;
      } catch (_) {
        return null;
      }
    }

    function clearAllBookmarkHighlights() {
      var overlay = document.getElementById('antropediaBmHighlightsOverlay');
      if (overlay) overlay.remove();
    }

    function renderAllBookmarkHighlights() {
      clearAllBookmarkHighlights();
      if (!bmAllHighlightsActive || !currentArticleBookmarks || !currentArticleBookmarks.length) return;

      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;

      var contentRect = contentEl.getBoundingClientRect();
      if (contentRect.width <= 0) return;

      var overlay = document.createElement('div');
      overlay.id = 'antropediaBmHighlightsOverlay';
      overlay.className = 'antropedia-bm-highlights-overlay';

      var blocks = Array.from(contentEl.querySelectorAll('[data-block-id]'));
      if (!blocks.length) return;

      var byBlock = new Map();
      currentArticleBookmarks.forEach(function (b) {
        if (!b.blockId) return;
        if (!byBlock.has(b.blockId)) byBlock.set(b.blockId, []);
        byBlock.get(b.blockId).push(b);
      });

      var scrollY = contentEl.scrollTop || 0;
      var scrollX = contentEl.scrollLeft || 0;

      blocks.forEach(function (blockEl) {
        var blockId = blockEl.getAttribute('data-block-id');
        var bookmarks = byBlock.get(blockId);
        if (!bookmarks || !bookmarks.length) return;

        var fullText = blockEl.textContent || '';
        if (!fullText.length) return;

        var intervals = [];
        bookmarks.forEach(function (bm) {
          var range = null;
          if (bm.quote) {
            range = findQuoteRange(blockEl, bm.quote);
            if (!range) range = findQuoteRange(contentEl, bm.quote);
          }
          var offsets = null;
          if (range) {
            offsets = getRangeOffsetsInBlock(blockEl, range);
          }
          if (!offsets) {
            offsets = { start: 0, end: fullText.length };
          }
          intervals.push({
            id: bm.id,
            start: offsets.start,
            end: offsets.end,
            color: bm.color || '#5865f2'
          });
        });

        var segments = decomposeIntervals(intervals, fullText.length);
        segments.forEach(function (seg) {
          var subRange = createRangeFromOffsets(blockEl, seg.start, seg.end);
          if (!subRange) return;

          var clientRects = subRange.getClientRects();
          if (!clientRects || !clientRects.length) return;

          var bg = getStripeBackground(seg.colors);

          for (var i = 0; i < clientRects.length; i++) {
            var r = clientRects[i];
            if (r.width <= 0 || r.height <= 0) continue;

            var rectEl = document.createElement('div');
            rectEl.className = 'antropedia-bm-highlight-rect';
            rectEl.style.left = Math.round(r.left - contentRect.left + scrollX) + 'px';
            rectEl.style.top = Math.round(r.top - contentRect.top + scrollY - 1) + 'px';
            rectEl.style.width = Math.round(r.width) + 'px';
            rectEl.style.height = Math.round(r.height + 2) + 'px';
            rectEl.style.background = bg;
            rectEl.setAttribute('data-bm-ids', seg.ids.join(','));

            overlay.appendChild(rectEl);
          }
        });
      });

      overlay.addEventListener('click', function (e) {
        var rectEl = e.target.closest('.antropedia-bm-highlight-rect');
        if (!rectEl) return;
        var idsStr = rectEl.getAttribute('data-bm-ids');
        if (!idsStr) return;
        var ids = idsStr.split(',').filter(Boolean);
        if (!ids.length) return;
        var bm = currentArticleBookmarks.find(function (b) { return String(b.id) === String(ids[0]); });
        if (bm) {
          e.preventDefault();
          e.stopPropagation();
          openBookmarkPopover(bm.blockId, rectEl, bm.quote, bm.id);
        }
      });

      contentEl.appendChild(overlay);
    }

    function setBookmarkHighlight(bookmark) {
      clearBookmarkHighlight();
      if (!bookmark) return;

      var overlay = document.getElementById('antropediaBmHighlightsOverlay');
      if (overlay && bmAllHighlightsActive) {
        overlay.classList.add('has-focus');
        overlay.querySelectorAll('.antropedia-bm-highlight-rect').forEach(function (r) {
          var ids = (r.getAttribute('data-bm-ids') || '').split(',');
          r.classList.toggle('is-focused', ids.indexOf(String(bookmark.id)) !== -1);
        });
      }

      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;
      var blockEl = null;
      if (bookmark.blockId) {
        try {
          blockEl = contentEl.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(bookmark.blockId) : bookmark.blockId) + '"]');
        } catch (_) {}
        if (!blockEl) blockEl = document.getElementById(bookmark.blockId);
      }
      if (!blockEl) return;

      var color = bookmark.color || '#5865f2';
      var hoverColor = (color && color.length === 7 && color.charAt(0) === '#') ? (color + '55') : color;

      if (!bmAllHighlightsActive && typeof Highlight !== 'undefined' && CSS.highlights) {
        try {
          var range = null;
          if (bookmark.quote) {
            range = findQuoteRange(blockEl, bookmark.quote);
            if (!range) range = findQuoteRange(contentEl, bookmark.quote);
          }
          if (!range) {
            range = document.createRange();
            range.selectNodeContents(blockEl);
          }
          if (range) {
            var h = new Highlight(range);
            CSS.highlights.set('antropedia-bm-hover', h);
            document.documentElement.style.setProperty('--bm-hover-color', hoverColor);
          }
        } catch (_) {}
      }
    }

    function clearBookmarkHighlight() {
      var overlay = document.getElementById('antropediaBmHighlightsOverlay');
      if (overlay) {
        overlay.classList.remove('has-focus');
        overlay.querySelectorAll('.is-focused').forEach(function (r) {
          r.classList.remove('is-focused');
        });
      }
      if (typeof Highlight !== 'undefined' && CSS.highlights) {
        try { CSS.highlights.delete('antropedia-bm-hover'); } catch (_) {}
      }
    }

    function renderBookmarksPanel() {
      var panel = document.getElementById('antropediaBookmarksPanel');
      if (!panel) return;
      if (!panel._hoverInit) {
        panel._hoverInit = true;
        panel.addEventListener('mouseover', function (e) {
          var item = e.target.closest('.antropedia-bookmark-item');
          if (!item) return;
          var id = item.getAttribute('data-id');
          var bm = currentArticleBookmarks.find(function (b) { return String(b.id) === String(id); });
          if (bm) setBookmarkHighlight(bm);
        });
        panel.addEventListener('mouseout', function (e) {
          var item = e.target.closest('.antropedia-bookmark-item');
          if (item) clearBookmarkHighlight();
        });
      }

      var headerHtml = '<div class="antropedia-bookmarks-panel-header">' +
        '<span class="antropedia-bookmarks-panel-title"><i class="fas fa-bookmark"></i> Закладки (' + currentArticleBookmarks.length + ')</span>' +
        '<button type="button" class="antropedia-bm-highlight-toggle' + (bmAllHighlightsActive ? ' is-active' : '') + '" data-action="toggle-highlights" title="' + (bmAllHighlightsActive ? 'Выключить подсветку в тексте' : 'Включить подсветку в тексте') + '">' +
          '<i class="fas fa-highlighter"></i>' +
        '</button>' +
      '</div>';

      if (!currentArticleBookmarks.length) {
        panel.innerHTML = headerHtml + '<div class="antropedia-sidebar-empty">Закладок пока нет — выделите текст или нажмите на хвостик закладки, чтобы добавить.</div>';
        return;
      }
      var listHtml = currentArticleBookmarks.map(function (b) {
        return '<div class="antropedia-bookmark-item" data-id="' + escapeHtml(b.id) + '" data-block-id="' + escapeHtml(b.blockId || '') + '">' +
          '<span class="antropedia-bookmark-dot" style="background:' + escapeHtml(b.color || '#5865f2') + '"></span>' +
          '<div class="antropedia-bookmark-item-body">' +
            '<div class="antropedia-bookmark-item-name">' + escapeHtml(b.name || 'Закладка') + '</div>' +
            (b.quote ? '<div class="antropedia-bookmark-item-quote">' + escapeHtml(b.quote) + '</div>' : '') +
          '</div>' +
          '<button type="button" class="antropedia-bookmark-item-del" data-action="delete-bookmark" title="Удалить закладку"><i class="fas fa-trash"></i></button>' +
        '</div>';
      }).join('');

      panel.innerHTML = headerHtml + listHtml;
    }

    function createBookmarkTab(blockEl, blockId, bookmark) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'antropedia-bm-tab';
      tab.style.setProperty('--bm-color', bookmark.color);
      tab.setAttribute('data-block-id', blockId);
      tab.setAttribute('data-id', bookmark.id);
      tab.setAttribute('aria-label', bookmark.name);
      tab.innerHTML = '<i class="fas fa-bookmark antropedia-bm-tab-icon" aria-hidden="true"></i>' +
        '<span class="antropedia-bm-tooltip">' + escapeHtml(bookmark.name) + '</span>';

      tab.addEventListener('mouseenter', function () {
        setBookmarkHighlight(bookmark);
      });
      tab.addEventListener('mouseleave', function () {
        clearBookmarkHighlight();
      });

      return tab;
    }

    function createCompactToggle(blockEl, blockId, bookmark, contentRect, targetTop) {
      var topPos = (typeof targetTop === 'number') ? targetTop : blockEl.getBoundingClientRect().top;
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'antropedia-bm-toggle' + (bookmark ? ' is-active' : '');
      toggle.style.top = Math.round(topPos - contentRect.top) + 'px';
      toggle.setAttribute('data-block-id', blockId);
      if (bookmark) {
        toggle.setAttribute('data-id', bookmark.id);
        toggle.style.setProperty('--bm-color', bookmark.color);
      }
      toggle.title = bookmark ? bookmark.name : 'Добавить закладку';
      toggle.innerHTML = '<i class="fas fa-bookmark"></i>';
      return toggle;
    }

    function createHoverZone(className) {
      var zone = document.createElement('div');
      zone.className = className;
      zone.addEventListener('mousemove', function (e) {
        handleGutterHoverMove(e, zone);
      });
      zone.addEventListener('mouseleave', function (e) {
        var toEl = e.relatedTarget;
        if (toEl && bookmarkGhostEl && bookmarkGhostEl.contains(toEl)) return;
        hideBookmarkGhost();
      });
      return zone;
    }

    function handleGutterHoverMove(e, zoneEl) {
      bmLastHoverY = e.clientY;
      if (bmHoverMoveScheduled) return;
      bmHoverMoveScheduled = true;
      requestAnimationFrame(function () {
        bmHoverMoveScheduled = false;
        if (!zoneEl.isConnected) return;
        var gutterEl = document.getElementById('antropediaBookmarkGutter');
        var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
        var originEl = (bmWideMode && gutterEl && gutterEl.parentElement) ? gutterEl.parentElement : contentEl;
        if (!originEl) return;
        var localY = bmLastHoverY - originEl.getBoundingClientRect().top;
        var block = findNearestBlock(localY);
        if (!block) {
          hideBookmarkGhost();
          return;
        }
        var count = currentArticleBookmarks.filter(function (b) { return b.blockId === block.blockId; }).length;
        if (count > 0) {
          hideBookmarkGhost();
          return;
        }
        if (bookmarkGhostEl && !bookmarkGhostEl.hidden && bookmarkGhostEl.getAttribute('data-block-id') === block.blockId) return;
        showBookmarkGhost(block.el, block.blockId);
      });
    }

    function findNearestBlock(localY) {
      if (!bmBlocks || !bmBlocks.length) return null;
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < bmBlocks.length; i++) {
        var b = bmBlocks[i];
        if (localY >= b.top && localY <= b.bottom) return b;
        var dist = localY < b.top ? b.top - localY : localY - b.bottom;
        if (dist < bestDist) {
          bestDist = dist;
          best = b;
        }
      }
      return best;
    }

    function showBookmarkGhost(blockEl, blockId) {
      if (!bookmarkGhostEl) return;
      bookmarkGhostEl.setAttribute('data-block-id', blockId);
      bookmarkGhostEl.removeAttribute('data-id');
      var blockRect = blockEl.getBoundingClientRect();
      var gutterEl = document.getElementById('antropediaBookmarkGutter');
      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      var count = currentArticleBookmarks.filter(function (b) { return b.blockId === blockId; }).length;

      if (bmWideMode && gutterEl && gutterEl.parentElement) {
        bookmarkGhostEl.className = 'antropedia-bm-tab is-ghost';
        bookmarkGhostEl.style.removeProperty('--bm-color');
        bookmarkGhostEl.title = 'Добавить закладку';
        bookmarkGhostEl.innerHTML = '<i class="fas fa-bookmark antropedia-bm-tab-icon" aria-hidden="true"></i>';
        var layoutRect = gutterEl.parentElement.getBoundingClientRect();
        bookmarkGhostEl.style.top = Math.round(blockRect.top - layoutRect.top) + 'px';
        bookmarkGhostEl.style.zIndex = 5;
        gutterEl.appendChild(bookmarkGhostEl);
      } else if (contentEl) {
        bookmarkGhostEl.className = 'antropedia-bm-toggle is-ghost';
        bookmarkGhostEl.title = 'Добавить закладку';
        bookmarkGhostEl.innerHTML = '<i class="fas fa-bookmark"></i>';
        var contentRect = contentEl.getBoundingClientRect();
        bookmarkGhostEl.style.top = Math.round(blockRect.top - contentRect.top) + 'px';
        contentEl.appendChild(bookmarkGhostEl);
      }
      bookmarkGhostEl.hidden = false;
    }

    function hideBookmarkGhost() {
      if (!bookmarkGhostEl || bookmarkGhostEl.hidden) return;
      bookmarkGhostEl.hidden = true;
      bookmarkGhostEl.remove();
    }

    function toggleBookmarkPopover(toggleEl) {
      var blockId = toggleEl.getAttribute('data-block-id');
      var bmId = toggleEl.getAttribute('data-id');
      var popoverEl = document.getElementById('antropediaBookmarkPopover');
      if (pendingBookmark && pendingBookmark.blockId === blockId && (bmId ? String(pendingBookmark.id) === String(bmId) : !pendingBookmark.id) && popoverEl && !popoverEl.hidden) {
        closeBookmarkPopover();
        return;
      }
      openBookmarkPopover(blockId, toggleEl, null, bmId || null);
    }

    function handleContentDblClick(e) {
      if (e.target.closest('a, .wiki-link, .wiki-link-missing, .wiki-link-restricted, .hashtag, .antropedia-bm-toggle, .antropedia-bm-tab')) return;
      var blockEl = e.target.closest('[data-block-id]');
      if (!blockEl) return;
      var blockId = blockEl.getAttribute('data-block-id');
      var count = currentArticleBookmarks.filter(function (b) { return b.blockId === blockId; }).length;
      if (count >= 3) {
        if (window.confirmDialog) {
          window.confirmDialog.alert({ title: 'Лимит закладок', message: 'На один абзац можно добавить не более 3 закладок.' });
        } else {
          alert('На один абзац можно добавить не более 3 закладок.');
        }
        return;
      }
      e.preventDefault();
      openBookmarkPopover(blockId, blockEl);
    }

    function processTextSelection() {
      var sel = window.getSelection();
      var tooltipEl = document.getElementById('antropediaSelectionTooltip');
      var mobileBarEl = document.getElementById('antropediaMobileBookmarkBar');
      var mobileQuoteEl = document.getElementById('antropediaMobileBmQuote');

      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (tooltipEl) tooltipEl.hidden = true;
        if (mobileBarEl) mobileBarEl.hidden = true;
        currentSelectedRangeInfo = null;
        return;
      }

      var text = sel.toString().trim();
      if (!text || text.length < 2) {
        if (tooltipEl) tooltipEl.hidden = true;
        if (mobileBarEl) mobileBarEl.hidden = true;
        currentSelectedRangeInfo = null;
        return;
      }

      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;

      var range = sel.getRangeAt(0);
      var startParent = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      if (!startParent || !contentEl.contains(startParent)) {
        if (tooltipEl) tooltipEl.hidden = true;
        if (mobileBarEl) mobileBarEl.hidden = true;
        currentSelectedRangeInfo = null;
        return;
      }

      var blockEl = startParent.closest('[data-block-id]');
      if (!blockEl) {
        if (tooltipEl) tooltipEl.hidden = true;
        if (mobileBarEl) mobileBarEl.hidden = true;
        currentSelectedRangeInfo = null;
        return;
      }

      var blockId = blockEl.getAttribute('data-block-id');
      currentSelectedRangeInfo = {
        blockId: blockId,
        blockEl: blockEl,
        quote: text.slice(0, 2000),
        range: range.cloneRange()
      };
      lastSelectedRangeInfo = currentSelectedRangeInfo;

      var isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);

      if (isMobile) {
        if (tooltipEl) tooltipEl.hidden = true;
        if (mobileBarEl && mobileQuoteEl) {
          mobileQuoteEl.textContent = '«' + (text.length > 50 ? text.slice(0, 50) + '…' : text) + '»';
          mobileBarEl.hidden = false;
        }
      } else {
        if (mobileBarEl) mobileBarEl.hidden = true;
        if (tooltipEl) {
          var rect = range.getBoundingClientRect();
          if (rect && rect.width > 0) {
            tooltipEl.hidden = false;
            var cx = rect.left + rect.width / 2;
            var cy = rect.top - 8;
            cx = Math.max(70, Math.min(window.innerWidth - 70, cx));
            cy = Math.max(30, cy);
            tooltipEl.style.left = Math.round(cx) + 'px';
            tooltipEl.style.top = Math.round(cy) + 'px';
          }
        }
      }
    }

    function checkSelection() {
      clearTimeout(selectionDebounce);
      selectionDebounce = setTimeout(processTextSelection, 80);
    }

    function hideSelectionUI() {
      var tooltipEl = document.getElementById('antropediaSelectionTooltip');
      var mobileBarEl = document.getElementById('antropediaMobileBookmarkBar');
      if (tooltipEl) tooltipEl.hidden = true;
      if (mobileBarEl) mobileBarEl.hidden = true;
      currentSelectedRangeInfo = null;
      lastSelectedRangeInfo = null;
    }

    function renderBookmarkGutter() {
      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (!contentEl) return;
      hideBookmarkGhost();
      contentEl.querySelectorAll('.antropedia-bm-toggle, .antropedia-bm-hover-zone').forEach(function (el) { el.remove(); });
      var gutterEl = document.getElementById('antropediaBookmarkGutter');
      if (gutterEl) gutterEl.innerHTML = '';
      bookmarkGutterHoverEl = null;
      bookmarkCompactHoverEl = null;

      var blocks = Array.from(contentEl.querySelectorAll('[data-block-id]'));
      if (!blocks.length) {
        bmBlocks = [];
        return;
      }

      var isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
      bmWideMode = hasWideGutterSpace();
      var byBlock = new Map();
      currentArticleBookmarks.forEach(function (b) {
        if (!b.blockId) return;
        if (!byBlock.has(b.blockId)) byBlock.set(b.blockId, []);
        byBlock.get(b.blockId).push(b);
      });

      var articleEl = detail || document.getElementById('publicArticleDetail');
      var containerEl = document.getElementById('publicArticleContainer');
      if (gutterEl && articleEl && containerEl) {
        var artRect = articleEl.getBoundingClientRect();
        var contRect = containerEl.getBoundingClientRect();
        gutterEl.style.left = Math.round(artRect.left - contRect.left) + 'px';
      }

      var contentRect = contentEl.getBoundingClientRect();
      var layoutRect = (bmWideMode && gutterEl && gutterEl.parentElement)
        ? gutterEl.parentElement.getBoundingClientRect()
        : null;

      if (bmHoverCapable) {
        var originTop = bmWideMode && layoutRect ? layoutRect.top : contentRect.top;
        bmBlocks = blocks.map(function (blockEl) {
          var bRect = blockEl.getBoundingClientRect();
          return {
            blockId: blockEl.getAttribute('data-block-id'),
            el: blockEl,
            top: bRect.top - originTop,
            bottom: bRect.bottom - originTop
          };
        });

        if (bmWideMode && gutterEl) {
          bookmarkGutterHoverEl = createHoverZone('antropedia-bm-hover-zone');
          bookmarkGutterHoverEl.style.top = bmBlocks[0].top + 'px';
          var maxBottom = Math.max.apply(Math, bmBlocks.map(function (b) { return b.bottom; }));
          bookmarkGutterHoverEl.style.height = (maxBottom - bmBlocks[0].top) + 'px';
          gutterEl.appendChild(bookmarkGutterHoverEl);
        } else {
          bookmarkCompactHoverEl = createHoverZone('antropedia-bm-hover-zone antropedia-bm-hover-zone-compact');
          contentEl.appendChild(bookmarkCompactHoverEl);
        }
      }

      blocks.forEach(function (blockEl) {
        var blockId = blockEl.getAttribute('data-block-id');
        blockEl.classList.remove('antropedia-bm-block-marked');
        blockEl.style.removeProperty('--bm-block-color');
        blockEl.removeAttribute('data-bm-id');
        var bookmarks = byBlock.get(blockId);
        if (!bookmarks || !bookmarks.length) return;

        if (isMobile) {
          // На мобильных устройствах закладки отображаются постоянной подсветкой цитат в тексте.
          // Если на абзац поставлена закладка без цитаты — помечаем его цветной полоской слева.
          var nonQuoteBm = bookmarks.find(function (b) { return !b.quote; });
          if (nonQuoteBm) {
            blockEl.classList.add('antropedia-bm-block-marked');
            blockEl.style.setProperty('--bm-block-color', nonQuoteBm.color || '#5865f2');
            blockEl.setAttribute('data-bm-id', nonQuoteBm.id);
          }
          return; // Не вставляем накладывающиеся флажки .antropedia-bm-toggle на смартфонах!
        }

        var targetTop = null;
        var firstWithQuote = bookmarks.find(function (b) { return !!b.quote; });
        if (firstWithQuote && firstWithQuote.quote) {
          var range = findQuoteRange(blockEl, firstWithQuote.quote);
          if (!range && contentEl) {
            range = findQuoteRange(contentEl, firstWithQuote.quote);
          }
          if (range) {
            var rRect = range.getBoundingClientRect();
            if (rRect && rRect.height > 0) {
              targetTop = rRect.top;
            }
          }
        }
        if (targetTop === null) {
          targetTop = blockEl.getBoundingClientRect().top;
        }

        if (bmWideMode && gutterEl && layoutRect) {
          var groupEl = document.createElement('div');
          groupEl.className = 'antropedia-bm-group' + (bookmarks.length > 1 ? ' is-stacked' : '');
          groupEl.style.top = Math.round(targetTop - layoutRect.top) + 'px';
          groupEl.setAttribute('data-block-id', blockId);

          bookmarks.forEach(function (bm) {
            groupEl.appendChild(createBookmarkTab(blockEl, blockId, bm));
          });

          gutterEl.appendChild(groupEl);
        } else {
          contentEl.appendChild(createCompactToggle(blockEl, blockId, bookmarks[0], contentRect, targetTop));
        }
      });
    }

    function initBookmarkGutter() {
      bookmarkGhostEl = document.createElement('button');
      bookmarkGhostEl.type = 'button';
      bookmarkGhostEl.hidden = true;

      var gutterEl = document.getElementById('antropediaBookmarkGutter');
      if (gutterEl) {
        gutterEl.addEventListener('click', function (e) {
          var tab = e.target.closest('.antropedia-bm-tab');
          if (!tab) return;
          e.preventDefault();
          e.stopPropagation();
          toggleBookmarkPopover(tab);
        });
      }

      var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
      if (contentEl) {
        contentEl.addEventListener('click', function (e) {
          var markedBlock = e.target.closest('.antropedia-bm-block-marked');
          if (!markedBlock) return;
          var rect = markedBlock.getBoundingClientRect();
          if (e.clientX <= rect.left + 35) {
            var bmId = markedBlock.getAttribute('data-bm-id');
            var blockId = markedBlock.getAttribute('data-block-id');
            if (bmId && blockId) {
              e.preventDefault();
              e.stopPropagation();
              openBookmarkPopover(blockId, markedBlock, null, bmId);
            }
          }
        });
      }

      if (bmHoverCapable) {
        bookmarkGhostEl.addEventListener('mouseleave', function (e) {
          var toEl = e.relatedTarget;
          if (toEl && (bookmarkGutterHoverEl?.contains(toEl) || bookmarkCompactHoverEl?.contains(toEl))) return;
          hideBookmarkGhost();
        });
      } else {
        var contentEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
        if (contentEl) {
          contentEl.addEventListener('dblclick', handleContentDblClick);
        }
      }

      // Selection listeners
      document.addEventListener('selectionchange', checkSelection);
      document.addEventListener('mouseup', checkSelection);
      document.addEventListener('touchend', checkSelection);

      var selBtn = document.getElementById('antropediaSelectionBookmarkBtn');
      if (selBtn) {
        selBtn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
        selBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var info = currentSelectedRangeInfo || lastSelectedRangeInfo;
          if (!info) return;
          var countForBlock = currentArticleBookmarks.filter(function (b) { return b.blockId === info.blockId; }).length;
          if (countForBlock >= 3) {
            hideSelectionUI();
            if (window.confirmDialog) {
              window.confirmDialog.alert({ title: 'Лимит закладок', message: 'На один абзац можно добавить не более 3 закладок.' });
            } else {
              alert('На один абзац можно добавить не более 3 закладок.');
            }
            return;
          }
          hideSelectionUI();
          openBookmarkPopover(info.blockId, info.blockEl || info.range, info.quote);
        });
      }

      var mobileAddBtn = document.getElementById('antropediaMobileBmAddBtn');
      if (mobileAddBtn) {
        mobileAddBtn.addEventListener('touchstart', function (e) {
          e.stopPropagation();
          if (currentSelectedRangeInfo) {
            lastSelectedRangeInfo = currentSelectedRangeInfo;
          }
        }, { passive: true });
        mobileAddBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var info = currentSelectedRangeInfo || lastSelectedRangeInfo;
          if (!info) return;
          var countForBlock = currentArticleBookmarks.filter(function (b) { return b.blockId === info.blockId; }).length;
          if (countForBlock >= 3) {
            hideSelectionUI();
            if (window.confirmDialog) {
              window.confirmDialog.alert({ title: 'Лимит закладок', message: 'На один абзац можно добавить не более 3 закладок.' });
            } else {
              alert('На один абзац можно добавить не более 3 закладок.');
            }
            return;
          }
          hideSelectionUI();
          openBookmarkPopover(info.blockId, info.blockEl || info.range, info.quote);
        });
      }

      var mobileCloseBtn = document.getElementById('antropediaMobileBmCloseBtn');
      if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', function () {
          hideSelectionUI();
        });
      }

      document.addEventListener('mousedown', function (e) {
        var tooltipEl = document.getElementById('antropediaSelectionTooltip');
        var mobileBarEl = document.getElementById('antropediaMobileBookmarkBar');
        if (tooltipEl && !tooltipEl.hidden && !tooltipEl.contains(e.target)) {
          var cEl = currentContentEl || (detail && detail.querySelector('.public-article-content'));
          if (!cEl || !cEl.contains(e.target)) {
            hideSelectionUI();
          }
        }
      });

      var cancelBtn = document.getElementById('antropediaBookmarkPopoverCancel');
      if (cancelBtn) cancelBtn.addEventListener('click', closeBookmarkPopover);

      var saveBtn = document.getElementById('antropediaBookmarkPopoverSave');
      if (saveBtn) saveBtn.addEventListener('click', saveBookmarkFromPopover);

      var delBtn = document.getElementById('antropediaBookmarkPopoverDelete');
      if (delBtn) delBtn.addEventListener('click', function () {
        if (!pendingBookmark?.id) return;
        deleteBookmarkById(pendingBookmark.id);
        closeBookmarkPopover();
      });

      var closeBtn = document.getElementById('antropediaBookmarkPopoverClose');
      if (closeBtn) closeBtn.addEventListener('click', closeBookmarkPopover);

      var backdropEl = document.getElementById('antropediaBookmarkModalBackdrop');
      if (backdropEl) backdropEl.addEventListener('click', closeBookmarkPopover);

      var nameInput = document.getElementById('antropediaBookmarkPopoverName');
      if (nameInput) {
        nameInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveBookmarkFromPopover();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            closeBookmarkPopover();
          }
        });
      }

      window.addEventListener('resize', function () {
        clearTimeout(bmGutterResizeDebounce);
        bmGutterResizeDebounce = setTimeout(function () {
          var isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
          if (isMobile) {
            bmAllHighlightsActive = true;
          }
          renderBookmarkGutter();
          if (bmAllHighlightsActive) {
            renderAllBookmarkHighlights();
          }
        }, 150);
      });
    }
    initBookmarkGutter();

    function openSidebarOnMobile() {
      var sb = document.getElementById('antropediaViewSidebar');
      var btn = document.getElementById('antropediaSidebarToggleBtn');
      var backdrop = document.getElementById('antropediaSidebarBackdrop');
      if (sb) sb.classList.add('is-open');
      if (btn) {
        btn.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
      if (backdrop && window.innerWidth <= 1024) {
        backdrop.hidden = false;
        backdrop.classList.add('is-open');
        document.body.classList.add('antropedia-sheet-locked');
      }
    }

    function closeSidebarOnMobile() {
      var sb = document.getElementById('antropediaViewSidebar');
      var btn = document.getElementById('antropediaSidebarToggleBtn');
      var backdrop = document.getElementById('antropediaSidebarBackdrop');
      if (sb) sb.classList.remove('is-open');
      if (btn) {
        btn.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      }
      if (backdrop) {
        backdrop.classList.remove('is-open');
        backdrop.hidden = true;
      }
      document.body.classList.remove('antropedia-sheet-locked');
    }

    function toggleSidebarOnMobile() {
      var sb = document.getElementById('antropediaViewSidebar');
      if (!sb) return;
      if (sb.classList.contains('is-open')) {
        closeSidebarOnMobile();
      } else {
        openSidebarOnMobile();
      }
    }

    function makeSheetSwipeable(handleEl, closeFn) {
      if (!handleEl) return;
      var startY = 0;
      handleEl.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches.length === 1) {
          startY = e.touches[0].clientY;
        }
      }, { passive: true });
      handleEl.addEventListener('touchend', function (e) {
        if (e.changedTouches && e.changedTouches.length === 1) {
          var diffY = e.changedTouches[0].clientY - startY;
          if (diffY > 50) {
            closeFn();
          }
        }
      }, { passive: true });
      handleEl.addEventListener('click', function () {
        closeFn();
      });
    }

    function openLayerPickerModal() {
      var modal = document.getElementById('antropediaLayerPickerModal');
      if (!modal) return;
      modal.hidden = false;
      document.body.classList.add('antropedia-sheet-locked');
    }

    function closeLayerPickerModal() {
      var modal = document.getElementById('antropediaLayerPickerModal');
      if (!modal) return;
      modal.hidden = true;
      document.body.classList.remove('antropedia-sheet-locked');
    }

    function initSmartHeaderScroll(headerEl) {
      if (!headerEl || headerEl._smartHeaderInit) return;
      headerEl._smartHeaderInit = true;

      var lastScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
      var ticking = false;

      function onScroll() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          var currentScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
          var diff = currentScrollY - lastScrollY;

          if (window.innerWidth <= 1024) {
            var searchBar = headerEl.querySelector('.antropedia-mobile-search-bar');
            var searchOpen = searchBar && !searchBar.hidden;
            var moreMenu = headerEl.querySelector('.antropedia-more-dropdown-menu');
            var moreOpen = moreMenu && !moreMenu.hidden;

            if (searchOpen || moreOpen) {
              headerEl.classList.remove('is-hidden');
            } else if (currentScrollY < 60) {
              headerEl.classList.remove('is-hidden');
            } else if (diff > 8) {
              headerEl.classList.add('is-hidden');
            } else if (diff < -6) {
              headerEl.classList.remove('is-hidden');
            }
          } else {
            headerEl.classList.remove('is-hidden');
          }

          lastScrollY = currentScrollY;
          ticking = false;
        });
      }

      window.addEventListener('scroll', onScroll, { passive: true });
    }

    async function shareCurrentArticle(article) {
      var slug = article.slug || state.slug;
      var title = article.title || 'Статья';
      var url = window.location.origin + '/antropedia/' + encodeURIComponent(slug);
      try {
        if (navigator.share && window.matchMedia('(hover: none)').matches) {
          await navigator.share({ title: title, url: url });
          return;
        }
        await navigator.clipboard.writeText(url);
        if (window.confirmDialog) {
          window.confirmDialog.alert({ title: 'Поделиться', message: 'Ссылка на статью скопирована в буфер обмена.' });
        } else {
          alert('Ссылка на статью скопирована в буфер обмена');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        window.prompt('Ссылка на статью:', url);
      }
    }

    function initSidebarTabs() {
      document.querySelectorAll('.antropedia-sidebar-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          switchSidebarTab(btn.getAttribute('data-sidebar-tab'));
        });
      });

      var sidebarBackdrop = document.getElementById('antropediaSidebarBackdrop');
      if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', closeSidebarOnMobile);
      }

      var sidebarHandle = document.querySelector('#antropediaViewSidebar .antropedia-sheet-handle-bar');
      if (sidebarHandle) {
        makeSheetSwipeable(sidebarHandle, closeSidebarOnMobile);
      }

      var layerModal = document.getElementById('antropediaLayerPickerModal');
      if (layerModal) {
        var layerBackdrop = document.getElementById('antropediaLayerPickerBackdrop');
        var layerClose = document.getElementById('antropediaLayerPickerClose');
        var layerHandle = layerModal.querySelector('.antropedia-sheet-handle-bar');
        var layerList = document.getElementById('antropediaLayerPickerList');

        if (layerBackdrop) layerBackdrop.addEventListener('click', closeLayerPickerModal);
        if (layerClose) layerClose.addEventListener('click', closeLayerPickerModal);
        if (layerHandle) makeSheetSwipeable(layerHandle, closeLayerPickerModal);
        if (layerList) {
          layerList.addEventListener('click', function (e) {
            var item = e.target.closest('.antropedia-layer-sheet-item');
            if (!item) return;
            var targetIndex = parseInt(item.getAttribute('data-layer-index'), 10);
            closeLayerPickerModal();
            if (typeof currentArticleSwitcherHandler === 'function') {
              currentArticleSwitcherHandler(targetIndex);
            }
          });
        }
      }

      var bookmarksPanel = document.getElementById('antropediaBookmarksPanel');
      if (bookmarksPanel) {
        bookmarksPanel.addEventListener('click', function (e) {
          var toggleBtn = e.target.closest('[data-action="toggle-highlights"]');
          if (toggleBtn) {
            e.stopPropagation();
            bmAllHighlightsActive = !bmAllHighlightsActive;
            if (bmAllHighlightsActive) {
              renderAllBookmarkHighlights();
            } else {
              clearAllBookmarkHighlights();
            }
            renderBookmarksPanel();
            return;
          }
          var delBtn = e.target.closest('[data-action="delete-bookmark"]');
          var item = e.target.closest('.antropedia-bookmark-item');
          if (!item) return;
          var id = item.getAttribute('data-id');
          if (delBtn) {
            e.stopPropagation();
            deleteBookmarkById(id);
            return;
          }
          var bookmark = currentArticleBookmarks.find(function (b) { return String(b.id) === String(id); });
          if (bookmark) {
            jumpToBookmark(bookmark);
          } else {
            var blockId = item.getAttribute('data-block-id');
            if (blockId) scrollToBlock(blockId);
          }
          if (window.innerWidth <= 1024) closeSidebarOnMobile();
        });

        bookmarksPanel.addEventListener('dblclick', function (e) {
          var nameEl = e.target.closest('.antropedia-bookmark-item-name');
          if (!nameEl) return;
          var item = nameEl.closest('.antropedia-bookmark-item');
          var id = item?.getAttribute('data-id');
          var bookmark = currentArticleBookmarks.find(function (b) { return String(b.id) === String(id); });
          if (!bookmark) return;
          var newName = prompt('Новое название закладки:', bookmark.name);
          if (newName == null) return;
          var trimmed = newName.trim();
          if (!trimmed || trimmed === bookmark.name) return;
          renameBookmark(id, trimmed);
        });
      }
    }
    initSidebarTabs();

    function switchSidebarTab(tab) {
      document.querySelectorAll('.antropedia-sidebar-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-sidebar-tab') === tab);
      });
      var tocPanel = document.getElementById('antropediaTocPanel');
      var bmPanel = document.getElementById('antropediaBookmarksPanel');
      if (tocPanel) tocPanel.hidden = tab !== 'toc';
      if (bmPanel) bmPanel.hidden = tab !== 'bookmarks';

      var isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
      if (tab === 'bookmarks' || isMobile) {
        bmAllHighlightsActive = true;
        renderAllBookmarkHighlights();
      } else {
        bmAllHighlightsActive = false;
        clearAllBookmarkHighlights();
      }
      renderBookmarksPanel();
    }

    var tocObserver = null;
    var tocCleanup = null;

    function renderToc(contentEl) {
      if (tocCleanup) {
        tocCleanup();
        tocCleanup = null;
      }
      if (tocObserver) {
        tocObserver.disconnect();
        tocObserver = null;
      }
      var panel = document.getElementById('antropediaTocPanel');
      var sb = document.getElementById('antropediaViewSidebar');
      var toggleBtn = document.getElementById('antropediaSidebarToggleBtn');
      if (!panel || !contentEl) {
        if (sb) sb.hidden = true;
        if (toggleBtn) toggleBtn.hidden = true;
        return;
      }

      var headings = Array.from(contentEl.querySelectorAll('h1, h2, h3'));
      if (!headings.length) {
        if (sb) sb.hidden = false;
        if (toggleBtn) toggleBtn.hidden = false;
        panel.innerHTML = '<div class="antropedia-sidebar-empty">В этой статье нет заголовков.</div>';
        return;
      }

      if (sb) sb.hidden = false;
      if (toggleBtn) toggleBtn.hidden = false;

      panel.innerHTML = '<ul class="antropedia-toc-list">' + headings.map(function (h, idx) {
        var level = parseInt(h.tagName.slice(1), 10) || 2;
        var blockId = h.getAttribute('data-block-id') || h.id;
        if (!blockId) {
          blockId = 'heading-' + idx;
          h.setAttribute('data-block-id', blockId);
        }
        return '<li class="antropedia-toc-item antropedia-toc-level-' + level + '">' +
          '<a href="javascript:void(0)" data-block-id="' + escapeHtml(blockId) + '">' +
          escapeHtml(h.textContent.trim()) + '</a></li>';
      }).join('') + '</ul>';

      function setActiveHeading(blockId) {
        if (!panel) return;
        panel.querySelectorAll('a[data-block-id]').forEach(function (a) {
          var match = a.getAttribute('data-block-id') === blockId;
          a.classList.toggle('active', match);
          if (match && a.scrollIntoView) {
            a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        });
      }

      var isClickLocked = false;
      var lockedBlockId = null;
      var clickLockTimer = null;

      panel.querySelectorAll('a[data-block-id]').forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var blockId = link.getAttribute('data-block-id');
          var target = null;
          try {
            target = contentEl.querySelector('[data-block-id="' + (CSS && CSS.escape ? CSS.escape(blockId) : blockId) + '"]');
          } catch (_) {
            target = null;
          }
          if (!target) target = document.getElementById(blockId);
          if (!target) return;

          // Мгновенная подсветка выбранного пункта в блоке оглавления с безусловным приоритетом над скроллом
          setActiveHeading(blockId);
          isClickLocked = true;
          lockedBlockId = blockId;
          clearTimeout(clickLockTimer);
          clickLockTimer = setTimeout(function () {
            isClickLocked = false;
          }, 1500);

          var headerOffset = 88;
          var targetRect = target.getBoundingClientRect();
          var currentScroll = window.pageYOffset || document.documentElement.scrollTop || 0;
          var targetTop = targetRect.top + currentScroll - headerOffset;
          window.scrollTo({
            top: Math.max(0, Math.round(targetTop)),
            behavior: 'smooth'
          });

          target.classList.remove('antropedia-block-flash');
          void target.offsetWidth;
          target.classList.add('antropedia-block-flash');
          setTimeout(function () {
            target.classList.remove('antropedia-block-flash');
          }, 1600);

          closeSidebarOnMobile();
        });
      });

      function updateScrollSpy() {
        if (isClickLocked) return;
        if (!headings.length) return;

        var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
        var windowHeight = window.innerHeight || document.documentElement.clientHeight;
        var docHeight = document.documentElement.scrollHeight;

        if (scrollY + windowHeight >= docHeight - 40) {
          var lastH = headings[headings.length - 1];
          var lastId = lastH.getAttribute('data-block-id') || lastH.id;
          setActiveHeading(lastId);
          return;
        }

        var topThreshold = 100;
        var activeId = null;

        for (var i = 0; i < headings.length; i++) {
          var rect = headings[i].getBoundingClientRect();
          if (rect.top <= topThreshold) {
            activeId = headings[i].getAttribute('data-block-id') || headings[i].id;
          } else {
            break;
          }
        }

        if (!activeId && headings.length) {
          var firstRect = headings[0].getBoundingClientRect();
          if (firstRect.top < windowHeight * 0.7) {
            activeId = headings[0].getAttribute('data-block-id') || headings[0].id;
          }
        }

        if (activeId) {
          setActiveHeading(activeId);
        }
      }

      var ticking = false;
      function onScroll() {
        if (isClickLocked) return;
        if (!ticking) {
          window.requestAnimationFrame(function () {
            updateScrollSpy();
            ticking = false;
          });
          ticking = true;
        }
      }

      function onUserScroll(e) {
        if (e.type === 'keydown') {
          var keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '];
          if (keys.indexOf(e.key) === -1) return;
        }
        if (isClickLocked) {
          isClickLocked = false;
          clearTimeout(clickLockTimer);
        }
      }

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('wheel', onUserScroll, { passive: true });
      window.addEventListener('touchmove', onUserScroll, { passive: true });
      window.addEventListener('keydown', onUserScroll, { passive: true });

      tocCleanup = function () {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('wheel', onUserScroll);
        window.removeEventListener('touchmove', onUserScroll);
        window.removeEventListener('keydown', onUserScroll);
        clearTimeout(clickLockTimer);
      };

      updateScrollSpy();
    }
    window.renderToc = renderToc;

    document.addEventListener('click', function (e) {
      var sb = document.getElementById('antropediaViewSidebar');
      var btn = document.getElementById('antropediaSidebarToggleBtn');
      if (sb && sb.classList.contains('is-open') && window.innerWidth <= 1024) {
        if (!sb.contains(e.target) && (!btn || !btn.contains(e.target))) {
          closeSidebarOnMobile();
        }
      }
      var moreMenu = document.getElementById('antropediaMoreActionsMenu');
      var moreBtn = document.getElementById('antropediaMoreActionsBtn');
      if (moreMenu && !moreMenu.hidden) {
        if (!moreMenu.contains(e.target) && (!moreBtn || !moreBtn.contains(e.target))) {
          moreMenu.hidden = true;
          if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
        }
      }
    });

    function renderDetail(article) {
      currentArticleSlug = article.slug || state.slug;
      currentArticleTitle = article.title || article.slug;
      switchSidebarTab('toc');
      closeBookmarkPopover();
      hideSelectionUI();
      loadArticleBookmarks();
      listView.hidden = true;
      if (detailContainer) detailContainer.hidden = false;
      detail.hidden = false;
      detail.replaceChildren();
      updateAdminLinks(article.slug);

      clearTimeout(inlineSearchDebounce);
      searchHits = [];
      searchIndex = -1;

      var toolbar = makeEl('div', 'public-article-detail-toolbar');
      toolbar.id = 'publicArticleDetailToolbar';

      var back = document.createElement('a');
      back.className = 'btn btn-secondary btn-sm antropedia-topbar-btn antropedia-back-btn public-article-back';
      back.href = '/antropedia';
      back.title = 'Все статьи';
      back.setAttribute('aria-label', 'Все статьи');
      var backIcon = document.createElement('i');
      backIcon.className = 'fas fa-arrow-left';
      backIcon.setAttribute('aria-hidden', 'true');
      var backLabel = makeEl('span', 'antropedia-btn-label', ' Все статьи');
      back.append(backIcon, backLabel);
      var listReturn = readListReturn();
      if (listReturn && listReturn.currentSlug === article.slug) {
        back.href = listReturn.url + ARTICLE_LIST_RETURN_HASH;
      }
      back.addEventListener('click', function () {
        closeSidebarOnMobile();
        closeLayerPickerModal();
        closeMobileSearch();
      });
      toolbar.appendChild(back);

      var actions = makeEl('div', 'antropedia-topbar-actions');

      // 1. Поиск по статье (на мобильных)
      var mobileSearchToggleBtn = makeEl('button', 'btn btn-secondary btn-sm antropedia-topbar-btn antropedia-mobile-search-btn');
      mobileSearchToggleBtn.type = 'button';
      mobileSearchToggleBtn.id = 'antropediaMobileSearchToggleBtn';
      mobileSearchToggleBtn.title = 'Поиск по статье';
      mobileSearchToggleBtn.setAttribute('aria-label', 'Поиск по статье');
      mobileSearchToggleBtn.innerHTML = '<i class="fas fa-search" aria-hidden="true"></i>';
      mobileSearchToggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var bar = document.getElementById('antropediaMobileSearchBar');
        if (bar && !bar.hidden) {
          closeMobileSearch();
        } else {
          openMobileSearch();
        }
      });
      actions.appendChild(mobileSearchToggleBtn);

      // 2. Кнопка Оглавление и закладки
      var sidebarToggleBtn = makeEl('button', 'btn btn-secondary btn-sm antropedia-topbar-btn antropedia-sidebar-toggle');
      sidebarToggleBtn.type = 'button';
      sidebarToggleBtn.id = 'antropediaSidebarToggleBtn';
      sidebarToggleBtn.title = 'Оглавление и закладки';
      sidebarToggleBtn.setAttribute('aria-expanded', 'false');
      sidebarToggleBtn.setAttribute('aria-controls', 'antropediaViewSidebar');
      sidebarToggleBtn.innerHTML = '<i class="fas fa-list-ul" aria-hidden="true"></i> <span class="antropedia-btn-label">Оглавление и закладки</span>';
      sidebarToggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleSidebarOnMobile();
      });
      actions.appendChild(sidebarToggleBtn);

      // 3. Меню дополнительных действий [ ⋯ ]
      var moreContainer = makeEl('div', 'antropedia-more-menu-wrapper antropedia-more-dropdown-container');
      var moreBtn = makeEl('button', 'btn btn-secondary btn-sm antropedia-topbar-btn antropedia-more-btn');
      moreBtn.type = 'button';
      moreBtn.id = 'antropediaMoreActionsBtn';
      moreBtn.title = 'Действия';
      moreBtn.setAttribute('aria-label', 'Действия');
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.innerHTML = '<i class="fas fa-ellipsis-vertical" aria-hidden="true"></i>';
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = !moreMenu.hidden;
        moreMenu.hidden = isOpen;
        moreBtn.setAttribute('aria-expanded', String(!isOpen));
      });
      moreContainer.appendChild(moreBtn);

      var moreMenu = makeEl('div', 'antropedia-more-dropdown-menu');
      moreMenu.id = 'antropediaMoreActionsMenu';
      moreMenu.hidden = true;

      // Слой лора в меню
      var moreLayerBtn = makeEl('button', 'antropedia-more-item');
      moreLayerBtn.type = 'button';
      moreLayerBtn.id = 'antropediaMoreLayerItem';
      moreLayerBtn.setAttribute('data-action', 'layer');
      moreLayerBtn.innerHTML = '<i class="fas fa-layer-group"></i> <span>Сменить слой лора</span>';
      var hasMultiLayers = Array.isArray(article.layerOptions) && article.layerOptions.length >= 2;
      moreLayerBtn.hidden = !hasMultiLayers || (window.innerWidth > 1024);
      moreLayerBtn.addEventListener('click', function () {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        openLayerPickerModal();
      });
      moreMenu.appendChild(moreLayerBtn);

      // Редактировать и Админ-панель
      if (article.can_edit) {
        var moreEditBtn = makeEl('button', 'antropedia-more-item');
        moreEditBtn.type = 'button';
        moreEditBtn.id = 'antropediaMoreEditItem';
        moreEditBtn.setAttribute('data-action', 'edit');
        moreEditBtn.innerHTML = '<i class="fas fa-pen-to-square"></i> <span>Редактировать</span>';
        moreEditBtn.addEventListener('click', function () {
          moreMenu.hidden = true;
          moreBtn.setAttribute('aria-expanded', 'false');
          showEditorView({ articleSlug: article.slug });
        });
        moreMenu.appendChild(moreEditBtn);

        var moreAdminLink = makeEl('a', 'antropedia-more-item');
        moreAdminLink.id = 'antropediaMoreAdminItem';
        moreAdminLink.href = '/admin-panel?editArticle=' + encodeURIComponent(article.slug);
        moreAdminLink.innerHTML = '<i class="fas fa-arrow-up-right-from-square"></i> <span>Открыть в админ панели</span>';
        moreAdminLink.addEventListener('click', function () {
          moreMenu.hidden = true;
          moreBtn.setAttribute('aria-expanded', 'false');
        });
        moreMenu.appendChild(moreAdminLink);
      }

      // Поделиться
      var moreShareBtn = makeEl('button', 'antropedia-more-item');
      moreShareBtn.type = 'button';
      moreShareBtn.id = 'antropediaMoreShareItem';
      moreShareBtn.setAttribute('data-action', 'share');
      moreShareBtn.innerHTML = '<i class="fas fa-link"></i> <span>Поделиться</span>';
      moreShareBtn.addEventListener('click', function () {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        shareCurrentArticle(article);
      });
      moreMenu.appendChild(moreShareBtn);

      // Пожаловаться
      var moreReportBtn = makeEl('button', 'antropedia-more-item');
      moreReportBtn.type = 'button';
      moreReportBtn.id = 'antropediaMoreReportItem';
      moreReportBtn.setAttribute('data-action', 'report');
      moreReportBtn.innerHTML = '<i class="fas fa-flag"></i> <span>Пожаловаться</span>';
      moreReportBtn.addEventListener('click', function () {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        if (!getAuthToken()) {
          openLogin();
          return;
        }
        openArticleReportModal(article);
      });
      moreMenu.appendChild(moreReportBtn);

      moreContainer.appendChild(moreMenu);
      actions.appendChild(moreContainer);
      toolbar.appendChild(actions);

      // 4. Выдвижная мобильная панель поиска
      var mobileSearchBar = makeEl('div', 'antropedia-mobile-search-bar');
      mobileSearchBar.id = 'antropediaMobileSearchBar';
      mobileSearchBar.hidden = true;
      mobileSearchBar.innerHTML = '<div class="antropedia-mobile-search-inner">' +
        '<i class="fas fa-search antropedia-mobile-search-icon" aria-hidden="true"></i>' +
        '<input type="text" id="antropediaMobileSearchInput" class="antropedia-mobile-search-input" placeholder="Поиск по статье…" autocomplete="off" spellcheck="false">' +
        '<span id="antropediaMobileSearchCount" class="antropedia-mobile-search-count" hidden></span>' +
        '<button type="button" id="antropediaMobileSearchPrev" class="antropedia-mobile-search-nav" title="Предыдущее" hidden><i class="fas fa-chevron-up"></i></button>' +
        '<button type="button" id="antropediaMobileSearchNext" class="antropedia-mobile-search-nav" title="Следующее" hidden><i class="fas fa-chevron-down"></i></button>' +
        '<button type="button" id="antropediaMobileSearchClose" class="antropedia-mobile-search-close" title="Закрыть поиск"><i class="fas fa-times"></i></button>' +
      '</div>';

      var mobInput = mobileSearchBar.querySelector('#antropediaMobileSearchInput');
      var mobPrev = mobileSearchBar.querySelector('#antropediaMobileSearchPrev');
      var mobNext = mobileSearchBar.querySelector('#antropediaMobileSearchNext');
      var mobClose = mobileSearchBar.querySelector('#antropediaMobileSearchClose');

      if (mobInput) {
        mobInput.addEventListener('input', function () {
          clearTimeout(inlineSearchDebounce);
          inlineSearchDebounce = setTimeout(function () {
            runInArticleSearch(mobInput.value, { autoScroll: false });
          }, 200);
        });
        mobInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeMobileSearch();
            return;
          }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!searchHits.length && mobInput.value.trim()) {
            runInArticleSearch(mobInput.value, { autoScroll: true });
          } else {
            gotoSearchHit(e.shiftKey ? -1 : 1);
          }
        });
      }
      if (mobPrev) {
        mobPrev.addEventListener('click', function (e) {
          e.stopPropagation();
          gotoSearchHit(-1);
        });
      }
      if (mobNext) {
        mobNext.addEventListener('click', function (e) {
          e.stopPropagation();
          gotoSearchHit(1);
        });
      }
      if (mobClose) {
        mobClose.addEventListener('click', function (e) {
          e.stopPropagation();
          closeMobileSearch();
        });
      }

      toolbar.appendChild(mobileSearchBar);
      initSmartHeaderScroll(toolbar);

      closeInArticleSearch();

      if (Array.isArray(article.pending_collab_requests) && article.pending_collab_requests.length > 0) {
        var collabBanner = makeEl('div', 'article-collab-banner');
        var bannerHeader = makeEl('div', 'article-collab-header');
        var bannerHeaderIcon = document.createElement('i');
        bannerHeaderIcon.className = 'fas fa-user-pen';
        bannerHeader.append(bannerHeaderIcon, document.createTextNode(' Заявки на соавторство и обновление статьи (' + article.pending_collab_requests.length + ')'));
        collabBanner.appendChild(bannerHeader);

        var bannerList = makeEl('div', 'article-collab-list');
        article.pending_collab_requests.forEach(function (reqItem) {
          var item = makeEl('div', 'article-collab-item');
          var info = makeEl('div', 'article-collab-info');
          var userLine = makeEl('div', 'article-collab-user-line');
          var strong = document.createElement('strong');
          strong.textContent = reqItem.proposer_name || 'Пользователь';
          userLine.append(strong, document.createTextNode(' предложил(а) правки к статье и добавление себя в соавторы'));
          info.appendChild(userLine);
          if (reqItem.comment) {
            var cEl = makeEl('p', 'article-collab-comment', reqItem.comment);
            info.appendChild(cEl);
          }
          item.appendChild(info);

          var actions = makeEl('div', 'article-collab-actions');
          var approveBtn = makeEl('button', 'btn btn-primary btn-sm article-collab-approve-btn');
          approveBtn.type = 'button';
          approveBtn.innerHTML = '<i class="fas fa-check"></i><span> Принять и обновить</span>';
          approveBtn.addEventListener('click', async function () {
            approveBtn.disabled = true;
            try {
              var token = getAuthToken();
              var res = await fetch('/api/articles/' + encodeURIComponent(article.slug) + '/collab-requests/' + encodeURIComponent(reqItem.id) + '/approve', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + token
                }
              });
              var data = await res.json().catch(function () { return {}; });
              if (!res.ok) throw new Error(data.error || 'Не удалось подтвердить заявку');
              if (window.confirmDialog) {
                await window.confirmDialog.alert({ title: 'Соавторство', message: 'Обновление статьи утверждено, соавтор добавлен!' });
              } else {
                alert('Обновление статьи утверждено, соавтор добавлен!');
              }
              window.location.reload();
            } catch (err) {
              approveBtn.disabled = false;
              if (window.confirmDialog) {
                await window.confirmDialog.alert({ title: 'Ошибка', message: err.message });
              } else {
                alert('Ошибка: ' + err.message);
              }
            }
          });

          var declineBtn = makeEl('button', 'btn btn-secondary btn-sm article-collab-decline-btn');
          declineBtn.type = 'button';
          declineBtn.innerHTML = '<i class="fas fa-times"></i><span> Отклонить</span>';
          declineBtn.addEventListener('click', async function () {
            var confirmed = window.confirmDialog
              ? await window.confirmDialog.open({
                  title: 'Отклонить заявку?',
                  message: 'Отклонить предложенные изменения статьи от пользователя ' + (reqItem.proposer_name || 'соавтора') + '?',
                  confirmLabel: 'Отклонить',
                  cancelLabel: 'Отмена',
                  danger: true
                })
              : confirm('Отклонить предложенные изменения статьи?');
            if (!confirmed) return;
            declineBtn.disabled = true;
            try {
              var token = getAuthToken();
              var res = await fetch('/api/articles/' + encodeURIComponent(article.slug) + '/collab-requests/' + encodeURIComponent(reqItem.id) + '/decline', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + token
                }
              });
              var data = await res.json().catch(function () { return {}; });
              if (!res.ok) throw new Error(data.error || 'Не удалось отклонить заявку');
              item.remove();
              if (bannerList.children.length === 0) collabBanner.remove();
            } catch (err) {
              declineBtn.disabled = false;
              if (window.confirmDialog) {
                await window.confirmDialog.alert({ title: 'Ошибка', message: err.message });
              } else {
                alert('Ошибка: ' + err.message);
              }
            }
          });

          actions.append(approveBtn, declineBtn);
          item.appendChild(actions);
          bannerList.appendChild(item);
        });
        collabBanner.appendChild(bannerList);
      }

      detail.appendChild(toolbar);
      if (typeof collabBanner !== 'undefined' && collabBanner) {
        detail.appendChild(collabBanner);
      }



      var cover = null;
      var coverImage = null;
      var initialCoverUrl = safePublicImageUrl(article.image);
      if (initialCoverUrl) {
        cover = makeEl('figure', 'public-article-cover');
        coverImage = document.createElement('img');
        coverImage.src = initialCoverUrl;
        coverImage.alt = article.title || 'Обложка статьи';
        coverImage.style.cursor = 'zoom-in';
        coverImage.addEventListener('error', function () { if (cover) { cover.remove(); cover = null; coverImage = null; } });
        coverImage.addEventListener('click', function () {
          window.imageLightbox?.open([{ src: coverImage ? coverImage.src : initialCoverUrl, alt: article.title || 'Обложка статьи' }]);
        });
        cover.appendChild(coverImage);
        detail.appendChild(cover);
      }

      var title = document.createElement('h1');
      title.className = 'public-article-title';
      title.textContent = article.title || article.slug;
      detail.appendChild(title);

      // Пилюля слоя лора под заголовком
      var titleLayerPill = makeEl('button', 'antropedia-title-layer-pill');
      titleLayerPill.type = 'button';
      titleLayerPill.id = 'antropediaTitleLayerPill';
      titleLayerPill.setAttribute('aria-haspopup', 'listbox');
      titleLayerPill.setAttribute('aria-expanded', 'false');
      titleLayerPill.title = 'Выбор слоя статьи';
      titleLayerPill.innerHTML = '<i class="fas fa-layer-group" aria-hidden="true"></i> ' +
        '<span>Слой: <strong id="antropediaTitleLayerName">Общий</strong></span> ' +
        '<i class="fas fa-chevron-down antropedia-pill-arrow" aria-hidden="true"></i>';
      titleLayerPill.addEventListener('click', function (e) {
        e.stopPropagation();
        openLayerPickerModal();
      });
      detail.appendChild(titleLayerPill);

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
            avatar.srcset = window.avatarSrcSet(authorImage);
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
      if (Array.isArray(article.co_authors) && article.co_authors.length) {
        var coAuthorsLabel = makeEl('span', 'public-article-coauthors');
        var coAuthorsIcon = document.createElement('i');
        coAuthorsIcon.className = 'fas fa-user-group';
        coAuthorsIcon.style.marginRight = '4px';
        coAuthorsIcon.style.opacity = '0.7';
        coAuthorsIcon.append(coAuthorsIcon, document.createTextNode('Соавторы: '));
        article.co_authors.forEach(function (ca, idx) {
          if (idx > 0) coAuthorsLabel.append(document.createTextNode(', '));
          if (ca.id != null) {
            var caLink = document.createElement('a');
            caLink.className = 'public-article-coauthor-link';
            caLink.href = '/profile/' + encodeURIComponent(ca.id);
            caLink.textContent = ca.display_name || ca.username || 'Соавтор';
            coAuthorsLabel.appendChild(caLink);
          } else {
            var caSpan = document.createElement('span');
            caSpan.textContent = ca.display_name || ca.username || 'Соавтор';
            coAuthorsLabel.appendChild(caSpan);
          }
        });
        meta.appendChild(coAuthorsLabel);
      }
      var created = formatDate(article.created_at);
      if (created) {
        var dateEl = makeEl('span', 'public-article-date');
        var cal = document.createElement('i');
        cal.className = 'far fa-calendar';
        cal.setAttribute('aria-hidden', 'true');
        dateEl.append(cal, document.createTextNode(' ' + created));
        meta.appendChild(dateEl);
      }
      if (article.viewsCount) {
        var viewsEl = makeEl('span', 'public-article-views');
        var eye = document.createElement('i');
        eye.className = 'far fa-eye';
        eye.setAttribute('aria-hidden', 'true');
        viewsEl.append(eye, document.createTextNode(' ' + formatCount(article.viewsCount)));
        meta.appendChild(viewsEl);
      }
      if (meta.childNodes.length) detail.appendChild(meta);
      var excerpt = null;
      if (article.excerpt) {
        excerpt = document.createElement('p');
        excerpt.className = 'public-article-excerpt';
        excerpt.textContent = article.excerpt;
        detail.appendChild(excerpt);
      }

      var tagsContainer = null;
      function renderTags(tagList) {
        if (!tagsContainer) {
          tagsContainer = document.createElement('div');
          tagsContainer.className = 'wiki-card-tags public-article-tags';
          detail.appendChild(tagsContainer);
        }
        tagsContainer.innerHTML = '';
        if (Array.isArray(tagList) && tagList.length) {
          tagsContainer.hidden = false;
          tagList.forEach(function (tag) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'wiki-tag';
            button.textContent = tag;
            button.addEventListener('click', function () {
              window.PublicSite.navigateTo('/antropedia?tag=' + encodeURIComponent(tag));
            });
            tagsContainer.appendChild(button);
          });
        } else {
          tagsContainer.hidden = true;
        }
      }
      if (Array.isArray(article.tags) && article.tags.length) {
        renderTags(article.tags);
      }

      var userPromise = loadCurrentUser();
      initArticleEngagement(article, detail, userPromise);

      userPromise.then(function (currentUser) {
        if (!currentUser) return;
        var isAuthor = article.author && (article.author.id === currentUser.id || article.author.id == currentUser.id);
        var canEdit = article.can_edit || currentUser.is_root || currentUser.is_admin || currentUser.role === 'admin' || isAuthor;
        if (canEdit && !document.getElementById('antropediaMoreEditItem')) {
          var menu = document.getElementById('antropediaMoreActionsMenu');
          var mBtn = document.getElementById('antropediaMoreActionsBtn');
          if (menu) {
            var editBtn = makeEl('button', 'antropedia-more-item');
            editBtn.type = 'button';
            editBtn.id = 'antropediaMoreEditItem';
            editBtn.setAttribute('data-action', 'edit');
            editBtn.innerHTML = '<i class="fas fa-pen-to-square"></i> <span>Редактировать</span>';
            editBtn.addEventListener('click', function () {
              menu.hidden = true;
              if (mBtn) mBtn.setAttribute('aria-expanded', 'false');
              showEditorView({ articleSlug: article.slug });
            });

            var adminLink = makeEl('a', 'antropedia-more-item');
            adminLink.id = 'antropediaMoreAdminItem';
            adminLink.href = '/admin-panel?editArticle=' + encodeURIComponent(article.slug);
            adminLink.innerHTML = '<i class="fas fa-arrow-up-right-from-square"></i> <span>Открыть в админ панели</span>';
            adminLink.addEventListener('click', function () {
              menu.hidden = true;
              if (mBtn) mBtn.setAttribute('aria-expanded', 'false');
            });

            var shareItem = document.getElementById('antropediaMoreShareItem');
            if (shareItem) {
              menu.insertBefore(editBtn, shareItem);
              menu.insertBefore(adminLink, shareItem);
            } else {
              menu.appendChild(editBtn);
              menu.appendChild(adminLink);
            }
          }
        }
      }).catch(function () {});

      function renderLayerSwitcher() {
        var els = getLayerSwitcherElements();
        var options = Array.isArray(article.layerOptions) ? article.layerOptions : [];
        var hasMulti = options.length > 1;

        if (els.switcher) {
          if (!hasMulti) {
            els.switcher.hidden = true;
            closeLayerDropdown();
          } else {
            els.switcher.hidden = false;
            var currentOpt = options.find(function (opt) { return opt.index === article.layerIndex; }) || options[0];
            if (els.label) {
              els.label.textContent = currentOpt ? currentOpt.title : 'Слой статьи';
            }
            if (els.menu) {
              els.menu.innerHTML = options.map(function (opt) {
                var activeClass = opt.index === article.layerIndex ? ' active' : '';
                return '<button type="button" class="antropedia-layer-dropdown-item' + activeClass + '" data-layer-index="' + opt.index + '">' +
                  '<span class="antropedia-layer-dropdown-item-title">' + escapeHtml(opt.title) + '</span>' +
                  '<i class="fas fa-check" aria-hidden="true"></i>' +
                  '</button>';
              }).join('');
            }
          }
        }

        // Пилюля под заголовком
        if (titleLayerPill) {
          if (!hasMulti) {
            titleLayerPill.hidden = true;
          } else {
            titleLayerPill.hidden = false;
            var curOpt = options.find(function (opt) { return opt.index === article.layerIndex; }) || options[0];
            var nameEl = titleLayerPill.querySelector('#antropediaTitleLayerName');
            if (nameEl && curOpt) nameEl.textContent = curOpt.title;
          }
        }

        // Пункт в меню [ ⋯ ]
        var moreLayerItem = document.getElementById('antropediaMoreLayerItem');
        if (moreLayerItem) {
          moreLayerItem.hidden = !hasMulti || (window.innerWidth > 1024);
        }

        // Список в Bottom Sheet модалке
        var pickerList = document.getElementById('antropediaLayerPickerList');
        if (pickerList && hasMulti) {
          pickerList.innerHTML = options.map(function (opt) {
            var isActive = opt.index === article.layerIndex;
            return '<button type="button" class="antropedia-layer-sheet-item' + (isActive ? ' is-active' : '') + '" data-layer-index="' + opt.index + '">' +
              '<span>' + escapeHtml(opt.title) + '</span>' +
              (isActive ? '<i class="fas fa-check is-active-check" aria-hidden="true"></i>' : '') +
              '</button>';
          }).join('');
        }
      }

      var isSwitchingLayer = false;
      async function switchArticleLayer(targetIndex) {
        if (isSwitchingLayer) return;
        var slug = article.slug || state.slug;
        if (!slug) return;
        isSwitchingLayer = true;
        try {
          var token = getAuthToken();
          var url = (token ? '/api/articles/' : PUBLIC_ARTICLES_API + '/') +
                    encodeURIComponent(slug) + '?layer=' + encodeURIComponent(targetIndex);
          var res = await fetch(url, {
            credentials: 'omit',
            headers: token ? { Authorization: 'Bearer ' + token } : {}
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var updated = await res.json();
          if (state.slug && state.slug !== slug) return;
          article.title = updated.title;
          article.content = updated.content;
          article.layerIndex = updated.layerIndex;
          if (Array.isArray(updated.layerOptions)) {
            article.layerOptions = updated.layerOptions;
          }
          if (Array.isArray(updated.tags)) {
            article.tags = updated.tags;
          }
          if (title) {
            title.textContent = updated.title || updated.slug;
          }
          var newCoverUrl = safePublicImageUrl(updated.image);
          if (newCoverUrl) {
            if (!cover) {
              cover = makeEl('figure', 'public-article-cover');
              coverImage = document.createElement('img');
              coverImage.style.cursor = 'zoom-in';
              coverImage.addEventListener('error', function () { if (cover) { cover.remove(); cover = null; coverImage = null; } });
              coverImage.addEventListener('click', function () {
                window.imageLightbox?.open([{ src: coverImage ? coverImage.src : newCoverUrl, alt: article.title || 'Обложка статьи' }]);
              });
              cover.appendChild(coverImage);
              detail.insertBefore(cover, title);
            }
            if (coverImage) {
              coverImage.src = newCoverUrl;
              coverImage.alt = article.title || 'Обложка статьи';
            }
            cover.hidden = false;
          } else if (cover) {
            cover.hidden = true;
          }
          if (updated.excerpt) {
            if (!excerpt) {
              excerpt = document.createElement('p');
              excerpt.className = 'public-article-excerpt';
              detail.insertBefore(excerpt, tagsContainer);
            }
            excerpt.textContent = updated.excerpt;
            excerpt.hidden = false;
          } else if (excerpt) {
            excerpt.hidden = true;
          }
          if (tagsContainer || (Array.isArray(article.tags) && article.tags.length)) {
            renderTags(article.tags);
          }
          renderLayerSwitcher();
          updateArticleMetadata(article);
          await renderContentBlocks(article.content);
        } catch (err) {
          console.error('Не удалось переключить слой статьи:', err);
        } finally {
          isSwitchingLayer = false;
        }
      }

      currentArticleSwitcherHandler = switchArticleLayer;
      closeLayerDropdown();
      renderLayerSwitcher();

      var content = document.createElement('div');
      content.className = 'preview-pane public-article-content';
      detail.appendChild(content);
      currentContentEl = content;

      content.addEventListener('dblclick', handleContentDblClick);
      content.addEventListener('click', function (event) {
        var bmToggle = event.target.closest('.antropedia-bm-toggle');
        if (bmToggle) {
          event.preventDefault();
          event.stopPropagation();
          toggleBookmarkPopover(bmToggle);
          return;
        }
        var wikiLink = event.target.closest('a[data-slug]');
        if (wikiLink) return;
        var tagLink = event.target.closest('[data-tag]');
        if (tagLink) {
          window.PublicSite.navigateTo('/antropedia?tag=' + encodeURIComponent(tagLink.dataset.tag));
          return;
        }
        var galleryFig = event.target.closest('[data-gallery-work]');
        if (galleryFig && !event.target.closest('a:not([data-gallery-open])')) {
          event.preventDefault();
          var gwWorkId = galleryFig.dataset.galleryWork;
          var gwImgId = galleryFig.dataset.galleryImage || null;
          if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
            window.galleryViewer.openWork(gwWorkId, { imageId: gwImgId });
          } else {
            ensureGalleryViewerLoaded().then(function (viewer) {
              if (viewer && typeof viewer.openWork === 'function') {
                viewer.openWork(gwWorkId, { imageId: gwImgId });
              } else {
                window.location.href = '/site/gallery.html?work=' + encodeURIComponent(gwWorkId);
              }
            });
          }
          return;
        }
        var imgEl = event.target.closest('.blk-image:not(.blk-image-gallery-locked) img, .blk-infobox-art img');
        if (imgEl && window.imageLightbox && !event.target.closest('a') && !galleryFig) {
          event.preventDefault();
          var allImgs = Array.from(content.querySelectorAll('.blk-image:not([data-gallery-work]):not(.blk-image-gallery-locked) img, .blk-infobox-art img'))
            .filter(function (img) { return Boolean(img.src); });
          var clickedIdx = Math.max(0, allImgs.indexOf(imgEl));
          var items = (allImgs.length ? allImgs : [imgEl]).map(function (img) {
            var fig = img.closest('.blk-image');
            var caption = fig ? fig.querySelector('figcaption')?.textContent?.trim() : '';
            return {
              src: img.src,
              alt: img.alt || '',
              caption: caption || img.alt || ''
            };
          });
          window.imageLightbox.open(items, clickedIdx);
          return;
        }
      });

      var publicIndexPromise = loadPublicIndex(article);

      async function renderContentBlocks(articleContent) {
        clearSearchHighlights();
        updateSearchCount();
        try {
          var indexData = await publicIndexPromise;
          if (typeof window.renderArticleBlocks !== 'function') throw new Error('Block renderer is unavailable');
          var restricted = indexData.authenticated ? indexData.restrictedSlugs : { has: function () { return true; } };
          var html = await window.renderArticleBlocks(articleContent, indexData.index, restricted);
          content.innerHTML = html;
          window.attachBlocksInteractions?.(content);
          content.querySelectorAll('a[data-slug]').forEach(function (link) {
            link.href = '/antropedia/' + encodeURIComponent(link.dataset.slug);
          });
          renderToc(content);
          renderBookmarkGutter();
          if (inlineSearchEl && inlineSearchEl.value.trim()) {
            runInArticleSearch(inlineSearchEl.value);
          }
        } catch (_) {
          content.replaceChildren(makePublicMessage('Не удалось отобразить содержимое статьи.'));
          renderToc(content);
        }
      }

      renderContentBlocks(article.content);

      var galleryPanel = makeEl('div', 'antropedia-view-gallery');
      galleryPanel.id = 'publicArticleGallery';
      galleryPanel.hidden = true;
      detail.appendChild(galleryPanel);
      initArticleGallery(article, galleryPanel);

      var backlinksPanel = makeEl('div', 'backlinks-panel');
      backlinksPanel.id = 'publicArticleBacklinks';
      backlinksPanel.hidden = true;
      detail.appendChild(backlinksPanel);
      initBacklinks(article.slug, backlinksPanel);

      initComments(article, detail, userPromise).catch(function () { /* комментарии не критичны для чтения статьи */ });
      updateArticleMetadata(article);
    }

    async function initBacklinks(slug, panel) {
      if (!panel || !slug) return;
      panel.hidden = true;
      panel.replaceChildren();

      try {
        var token = getAuthToken();
        var headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var res = await fetch('/api/articles/' + encodeURIComponent(slug) + '/backlinks', {
          credentials: 'omit',
          headers: headers
        });
        if (currentArticleSlug !== slug) return;
        if (!res.ok) {
          if (res.status === 404 || res.status === 403) {
            panel.hidden = true;
            return;
          }
          throw new Error('HTTP ' + res.status);
        }
        var backlinks = await res.json();
        if (currentArticleSlug !== slug) return;
        if (!Array.isArray(backlinks)) backlinks = [];

        panel.hidden = false;
        var header = makeEl('h3', 'backlinks-title');
        var linkIcon = document.createElement('i');
        linkIcon.className = 'fas fa-link';
        linkIcon.setAttribute('aria-hidden', 'true');
        header.append(linkIcon, document.createTextNode(' На эту статью ссылаются:'));
        panel.appendChild(header);

        if (!backlinks.length) {
          panel.classList.add('is-empty');
          var empty = makeEl('div', 'backlinks-empty', 'Пока никто не сослался на эту статью через wiki-ссылку.');
          panel.appendChild(empty);
          return;
        }

        panel.classList.remove('is-empty');
        var list = makeEl('div', 'backlinks-grid');
        backlinks.forEach(function (b) {
          if (!b || !b.slug) return;
          var card = makeEl('a', 'backlink-card');
          card.href = '/antropedia/' + encodeURIComponent(b.slug);
          card.setAttribute('data-slug', b.slug);

          var icon = document.createElement('i');
          icon.className = 'fas fa-file-lines backlink-card-icon';
          icon.setAttribute('aria-hidden', 'true');

          var titleSpan = makeEl('span', 'backlink-card-title', b.title || b.slug);

          var arrow = document.createElement('i');
          arrow.className = 'fas fa-arrow-right backlink-card-arrow';
          arrow.setAttribute('aria-hidden', 'true');

          card.append(icon, titleSpan, arrow);

          card.addEventListener('click', function (e) {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            window.PublicSite?.navigateTo('/antropedia/' + encodeURIComponent(b.slug));
          });

          list.appendChild(card);
        });

        panel.appendChild(list);
      } catch (err) {
        console.warn('Не удалось загрузить обратные ссылки:', err);
        panel.hidden = true;
      }
    }

    // ---------- Полоса связанных артов галереи под статьёй ----------

    function ensureGalleryViewerLoaded() {
      if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
        return Promise.resolve(window.galleryViewer);
      }
      return new Promise(function (resolve) {
        if (!document.querySelector('link[href*="gallery.css"]')) {
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/gallery.css';
          document.head.appendChild(link);
        }
        function loadGallery() {
          if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
            return resolve(window.galleryViewer);
          }
          var script = document.createElement('script');
          script.src = '/gallery.js';
          script.onload = function () {
            resolve(window.galleryViewer || null);
          };
          script.onerror = function () {
            resolve(null);
          };
          document.body.appendChild(script);
        }
        function loadAntropedia() {
          if (window.AntropediaManager) {
            loadGallery();
            return;
          }
          var script = document.createElement('script');
          script.src = '/antropedia.js';
          script.onload = loadGallery;
          script.onerror = loadGallery;
          document.body.appendChild(script);
        }
        if (!window.apiClient) {
          var clientScript = document.createElement('script');
          clientScript.src = '/site/gallery-client.js';
          clientScript.onload = loadAntropedia;
          clientScript.onerror = loadAntropedia;
          document.body.appendChild(clientScript);
        } else {
          loadAntropedia();
        }
      });
    }

    function renderGalleryCardHtml(work) {
      if (typeof window.galleryCardHtml === 'function') {
        return window.galleryCardHtml(work, { compact: true });
      }
      var cover = work.cover;
      var ratio = cover && cover.width && cover.height ? (cover.width + ' / ' + cover.height) : '1 / 1';
      var badges = [];
      if (work.restricted) badges.push('<span class="gallery-badge" title="Видна не всем — доступ по ролям"><i class="fas fa-lock"></i></span>');
      if (cover && (cover.animated || (cover.url && /\.gif$/i.test(cover.url)))) badges.push('<span class="gallery-badge">GIF</span>');
      if (work.pagesCount > 1) badges.push('<span class="gallery-badge" title="Страниц"><i class="far fa-images"></i> ' + work.pagesCount + '</span>');
      if (work.hasVariations) badges.push('<span class="gallery-badge" title="У страниц есть вариации"><i class="fas fa-layer-group"></i></span>');
      var badgesHtml = badges.length ? '<div class="gallery-card-badges">' + badges.join('') + '</div>' : '';
      var media = cover
        ? '<img src="' + escapeHtml(cover.thumb || cover.url) + '" alt="' + escapeHtml(work.title) + '" loading="lazy" decoding="async">'
        : '<div class="gallery-card-empty"><i class="far fa-image"></i><span>Нет страниц</span></div>';
      return '<article class="gallery-card gallery-card-compact" data-work-id="' + escapeHtml(work.id) + '" tabindex="0" title="' + escapeHtml(work.title) + '">' +
        '<div class="gallery-card-media" style="aspect-ratio:' + ratio + '">' +
          media +
          badgesHtml +
        '</div>' +
        '<div class="gallery-card-caption">' +
          '<div class="gallery-card-title">' + escapeHtml(work.title) + '</div>' +
        '</div>' +
      '</article>';
    }

    async function initArticleGallery(article, panel) {
      if (!panel || !article || !article.slug) return;
      panel.hidden = true;
      panel.replaceChildren();

      var slug = article.slug;
      try {
        var token = getAuthToken();
        var headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var res = await fetch('/api/public/gallery/works?articleSlug=' + encodeURIComponent(slug), {
          credentials: 'omit',
          headers: headers
        });
        if (currentArticleSlug !== slug) return;
        if (!res.ok) {
          panel.hidden = true;
          return;
        }
        var payload = await res.json();
        if (currentArticleSlug !== slug) return;
        var list = Array.isArray(payload) ? payload : (Array.isArray(payload.data) ? payload.data : []);
        var works = list.filter(function (w) { return w && w.id && (w.cover || w.pagesCount); });
        if (!works.length) {
          panel.hidden = true;
          return;
        }

        panel.hidden = false;
        var header = makeEl('h3', 'antropedia-gallery-title');
        var icon = document.createElement('i');
        icon.className = 'fas fa-images';
        icon.setAttribute('aria-hidden', 'true');
        header.append(icon, document.createTextNode(' Из галереи'));
        panel.appendChild(header);

        var strip = makeEl('div', 'gallery-strip');
        strip.innerHTML = works.map(function (w) {
          return renderGalleryCardHtml(w);
        }).join('');
        panel.appendChild(strip);

        if (!panel._galleryBound) {
          panel._galleryBound = true;
          panel.addEventListener('click', async function (e) {
            var card = e.target.closest('[data-work-id]');
            if (!card) return;
            var workId = card.dataset.workId;
            if (!workId) return;
            if (window.galleryViewer && typeof window.galleryViewer.openWork === 'function') {
              window.galleryViewer.openWork(workId);
            } else {
              var viewer = await ensureGalleryViewerLoaded();
              if (viewer && typeof viewer.openWork === 'function') {
                viewer.openWork(workId);
              } else {
                window.location.href = '/site/gallery.html?work=' + encodeURIComponent(workId);
              }
            }
          });
          panel.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var card = e.target.closest('[data-work-id]');
            if (!card) return;
            e.preventDefault();
            card.click();
          });
        }
      } catch (err) {
        console.warn('Не удалось загрузить связанные арты галереи:', err);
        panel.hidden = true;
      }
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
    var MENTION_HTML_RE = /(^|[^\p{L}\p{N}_@])@(?:\[([^\]\n<]{1,64})\]|([\p{L}\p{N}_.-]{1,64}))/gu;

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function unescapeHtml(str) {
      return String(str || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }

    function linkMentions(html, mentions) {
      if (!mentions || !Object.keys(mentions).length) return html;
      return html.replace(MENTION_HTML_RE, function (full, pre, bracketed, plain) {
        var name = bracketed || plain;
        var tail = '';
        if (plain) {
          var trimmed = plain.replace(/[.-]+$/, '');
          tail = plain.slice(trimmed.length);
          name = trimmed;
        }
        var key = unescapeHtml(name).trim().toLowerCase();
        var id = mentions[key];
        if (!id) return full;
        return pre + '<a href="/profile/' + encodeURIComponent(id) + '" class="comment-mention" title="Открыть профиль">@' + escapeHtml(name) + '</a>' + tail;
      });
    }

    function repliesCountLabel(count) {
      var remainder = count % 100;
      if (remainder >= 11 && remainder <= 14) return 'ответов';
      var last = count % 10;
      if (last === 1) return 'ответ';
      if (last >= 2 && last <= 4) return 'ответа';
      return 'ответов';
    }

    function getAuthToken() {
      try { return localStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem('token') || localStorage.getItem('authToken') || ''; } catch (error) { return ''; }
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

    function makeStickerImg(sticker, code, solo) {
      var src = sticker && safePublicImageUrl(sticker.url);
      if (!src) return null;
      var img = document.createElement('img');
      img.className = solo ? 'pub-comment-sticker-solo' : 'pub-comment-sticker';
      img.src = src;
      img.srcset = window.avatarSrcSet(src);
      img.alt = code;
      img.title = code;
      img.loading = 'lazy';
      if (sticker && sticker.packId != null) {
        img.dataset.packId = String(sticker.packId);
        img.style.cursor = 'pointer';
      }
      return img;
    }

    // Текст комментария: безопасный HTML со ссылками на профили упомянутых и <img> стикеров.
    function renderCommentBody(comment) {
      var body = makeEl('div', 'pub-comment-body');
      var raw = String(comment.content || '');
      var stickers = comment.stickers || {};
      var mentions = comment.mentions || {};
      var solo = raw.trim().match(STICKER_SOLO_RE);
      if (solo) {
        var soloCode = solo[1].toLowerCase() + ':' + solo[2].toLowerCase();
        var soloImg = makeStickerImg(stickers[soloCode], soloCode, true);
        if (soloImg) { body.appendChild(soloImg); return body; }
      }
      var escaped = escapeHtml(raw);
      var withMentions = linkMentions(escaped, mentions);
      var parsedHtml = withMentions.replace(STICKER_RE, function (match, pack, alias) {
        var code = pack.toLowerCase() + ':' + alias.toLowerCase();
        var sticker = stickers[code];
        if (!sticker) return match;
        var src = safePublicImageUrl(sticker.url);
        if (!src) return match;
        var pId = sticker.packId != null ? ' data-pack-id="' + Number(sticker.packId) + '"' : '';
        return '<img class="pub-comment-sticker"' + pId + ' src="' + escapeHtml(src) + '" srcset="' + escapeHtml(window.avatarSrcSet(src)) + '" alt="' + escapeHtml(code) + '" title="' + escapeHtml(code) + '" loading="lazy" style="cursor:pointer">';
      });
      body.innerHTML = parsedHtml;
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
      list.addEventListener('click', function (e) {
        var stickerImg = e.target.closest('[data-pack-id]');
        if (stickerImg && stickerImg.dataset.packId) {
          window.stickerPackView?.open(stickerImg.dataset.packId);
        }
      });
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
        headingCount.textContent = state.comments.length ? ' (' + state.comments.length + ')' : '';
        syncArticleCommentsUI(slug, state.comments.length);
      }

      async function post(text, parentId) {
        var prevCount = state.comments ? state.comments.length : 0;
        var nextCount = prevCount + 1;
        headingCount.textContent = ' (' + nextCount + ')';
        var commentsCountButton = container.querySelector('.pub-article-engagement-actions .is-comment span');
        if (commentsCountButton) commentsCountButton.textContent = String(nextCount);
        syncArticleCommentsUI(slug, nextCount);

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
          headingCount.textContent = prevCount ? ' (' + prevCount + ')' : '';
          if (commentsCountButton) commentsCountButton.textContent = String(prevCount);
          syncArticleCommentsUI(slug, prevCount);
          if (response.status === 401) {
            state.user = null;
            renderComposer();
            render();
            return { ok: false, message: 'Сессия истекла — войдите снова.' };
          }
          var data = await response.json().catch(function () { return {}; });
          return { ok: false, message: data.error || 'Не удалось отправить комментарий' };
        } catch (error) {
          headingCount.textContent = prevCount ? ' (' + prevCount + ')' : '';
          if (commentsCountButton) commentsCountButton.textContent = String(prevCount);
          syncArticleCommentsUI(slug, prevCount);
          return { ok: false, message: 'Нет соединения с сервером' };
        }
      }

      async function remove(id) {
        var ok = window.confirmDialog
          ? await window.confirmDialog.open({
              title: 'Удалить комментарий?',
              message: 'Удалить комментарий? Ответы на него удалятся вместе с ним.',
              confirmLabel: 'Удалить',
              cancelLabel: 'Отмена',
              danger: true
            })
          : true;
        if (!ok) return;

        var prevCount = state.comments ? state.comments.length : 0;
        var childCount = (state.comments || []).filter(function (c) { return String(c.parentId) === String(id); }).length;
        var nextCount = Math.max(0, prevCount - 1 - childCount);
        headingCount.textContent = nextCount ? ' (' + nextCount + ')' : '';
        var commentsCountButton = container.querySelector('.pub-article-engagement-actions .is-comment span');
        if (commentsCountButton) commentsCountButton.textContent = String(nextCount);
        syncArticleCommentsUI(slug, nextCount);

        try {
          var response = await fetch(apiBase + '/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
          if (!response.ok) {
            headingCount.textContent = prevCount ? ' (' + prevCount + ')' : '';
            if (commentsCountButton) commentsCountButton.textContent = String(prevCount);
            syncArticleCommentsUI(slug, prevCount);
            var data = await response.json().catch(function () { return {}; });
            if (window.confirmDialog) {
              await window.confirmDialog.alert({ title: 'Ошибка удаления', message: data.error || 'Не удалось удалить комментарий' });
            }
            return;
          }
          await load();
        } catch (error) {
          headingCount.textContent = prevCount ? ' (' + prevCount + ')' : '';
          if (commentsCountButton) commentsCountButton.textContent = String(prevCount);
          syncArticleCommentsUI(slug, prevCount);
          if (window.confirmDialog) {
            await window.confirmDialog.alert({ title: 'Ошибка связи', message: 'Нет соединения с сервером' });
          }
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
            var hasExtra = replies.length > 2;
            var isExpanded = !!state.expanded[comment.id];
            var shownReplies = (hasExtra && !isExpanded) ? [replies[0]] : replies;
            var extraCount = replies.length - 1;

            shownReplies.forEach(function (r) {
              box.appendChild(renderComment(r, true, comment.id));
            });
            if (hasExtra) {
              var toggle = makeEl('button', 'pub-comment-more', isExpanded
                ? 'Скрыть ответы'
                : 'Показать ещё ' + extraCount + ' ' + repliesCountLabel(extraCount));
              toggle.type = 'button';
              toggle.addEventListener('click', function () {
                state.expanded[comment.id] = !state.expanded[comment.id];
                render();
              });
              box.appendChild(toggle);
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
      if (editorView) editorView.hidden = true;
      if (detailContainer) detailContainer.hidden = false;
      detail.hidden = false;
      if (sidebar) sidebar.hidden = true;
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
          if (sidebar) sidebar.hidden = true;
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
        if (sidebar) sidebar.hidden = true;
        detail.replaceChildren(makePublicMessage('Не удалось загрузить статью. Попробуйте обновить страницу.'));
      }
    }

    // ---------- Подключение ----------

    // Поиск в шапке работает на обеих страницах: в каталоге — живой (через
    // 300 мс после ввода), в статье Enter уводит в каталог с запросом.
    var searchDebounce = null;
    input.addEventListener('input', function () {
      updateSearchClear();
      if (state.slug) return;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(applyFilters, 300);
    });
    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', function () {
        input.value = '';
        updateSearchClear();
        clearTimeout(searchDebounce);
        applyFilters();
        input.focus();
      });
    }
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
    // Поиск по статье (Ctrl+F, Cmd+F или «/»)
    function onSearchShortcut(event) {
      var isCtrlF = (event.key === 'f' || event.key === 'а' || event.code === 'KeyF') && (event.ctrlKey || event.metaKey);
      if (isCtrlF && state.slug) {
        event.preventDefault();
        openInArticleSearch();
        return;
      }

      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        event.preventDefault();
        if (state.slug) {
          openInArticleSearch();
        } else {
          input.focus();
        }
      }
    }
    document.addEventListener('keydown', onSearchShortcut);

    function onPopState() {
      var currentParams = new URLSearchParams(window.location.search);
      if (currentParams.get('view') === 'write' || currentParams.get('draft') || currentParams.get('edit')) {
        showEditorView({ draftId: currentParams.get('draft'), articleSlug: currentParams.get('edit') });
      } else if (!state.slug) {
        showListView();
      }
    }
    window.addEventListener('popstate', onPopState);

    if (state.slug) {
      var detailLoad = loadDetail();
      var detailCleanup = function cleanup() {
        state.disposed = true;
        clearTimeout(inlineSearchDebounce);
        closeInArticleSearch();
        document.removeEventListener('click', onArticleSearchOutsideClick);
        currentContentEl = null;
        if (searchWidgetEl) searchWidgetEl.remove();
        if (tocCleanup) {
          tocCleanup();
          tocCleanup = null;
        }
        if (tocObserver) {
          tocObserver.disconnect();
          tocObserver = null;
        }
        if (state.controller) state.controller.abort();
        document.removeEventListener('keydown', onSearchShortcut);
        window.removeEventListener('popstate', onPopState);
        if (window.antropediaEditor && typeof window.antropediaEditor.closeEditor === 'function') {
          window.antropediaEditor.closeEditor();
        }
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
    } else if (tagRoot) {
      tagRoot.closest('.pub-filter').hidden = true;
    }
    loadTagOptions();
    loadServerOptions();
    updateSearchClear();

    sortEl.addEventListener('change', applyFilters);
    if (serverFilterEl) serverFilterEl.addEventListener('change', applyFilters);
    if (statusFilterEl) statusFilterEl.addEventListener('change', applyFilters);
    dateFromEl.addEventListener('change', applyFilters);
    dateToEl.addEventListener('change', applyFilters);
    document.getElementById('pubResetFilters').addEventListener('click', resetFilters);
    document.getElementById('pubEmptyReset').addEventListener('click', resetFilters);
    document.getElementById('pubRandomBtn').addEventListener('click', openRandomArticle);

    if ('IntersectionObserver' in window) {
      state.observer = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) loadArticles(true);
      }, { rootMargin: '400px' });
      state.observer.observe(sentinel);
    }

    updateFiltersCount();

    var initialViewParam = params.get('view');
    var initialDraftParam = params.get('draft');
    var initialEditParam = params.get('edit');
    var isInitialWrite = initialViewParam === 'write' || !!initialDraftParam || !!initialEditParam;

    var initialLoad = null;
    if (isInitialWrite) {
      showEditorView({ draftId: initialDraftParam, articleSlug: initialEditParam });
    } else {
      initialLoad = loadArticles(false);
    }

    var listCleanup = function cleanup() {
      state.disposed = true;
      clearTimeout(inlineSearchDebounce);
      closeInArticleSearch();
      currentContentEl = null;
      if (state.controller) state.controller.abort();
      if (state.observer) state.observer.disconnect();
      clearTimeout(searchDebounce);
      document.removeEventListener('keydown', onSearchShortcut);
      window.removeEventListener('popstate', onPopState);
      if (window.antropediaEditor && typeof window.antropediaEditor.closeEditor === 'function') {
        window.antropediaEditor.closeEditor();
      }
    };
    listCleanup.ready = initialLoad;
    return listCleanup;
  }

  function createHomeArticleCard(article) {
    var href = '/antropedia/' + encodeURIComponent(article.slug);
    var card = document.createElement('article');
    card.className = 'wiki-card public-wiki-card antropedia-card';

    var coverWrap = document.createElement('div');
    coverWrap.className = 'antropedia-card-cover-wrap';

    var cover = document.createElement('a');
    cover.className = 'wiki-card-cover antropedia-card-cover';
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
    coverWrap.appendChild(cover);
    card.appendChild(coverWrap);

    var body = document.createElement('div');
    body.className = 'wiki-card-body';
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
      tags.className = 'wiki-card-tags';
      article.tags.slice(0, 4).forEach(function (tag) {
        var item = document.createElement('span');
        item.className = 'wiki-tag';
        item.textContent = '#' + tag;
        tags.appendChild(item);
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
          var avatarImg = document.createElement('img');
          avatarImg.src = authorImage;
          avatarImg.srcset = window.avatarSrcSet(authorImage);
          avatarImg.alt = '';
          avatarImg.width = 26;
          avatarImg.height = 26;
          avatarImg.loading = 'lazy';
          authorLink.appendChild(avatarImg);
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
    var engagement = document.createElement('div');
    engagement.className = 'engage-group';
    [
      ['far fa-heart', article.likesCount, 'Лайки', 'likes'],
      ['far fa-comment', article.commentsCount, 'Комментарии', 'comments']
    ].forEach(function (entry) {
      var item = document.createElement('span');
      var isLiked = entry[3] === 'likes' && !!article.liked;
      item.className = 'engage-item' + (isLiked ? ' is-like active' : '');
      item.title = entry[2];
      var icon = document.createElement('i');
      icon.className = isLiked ? 'fas fa-heart' : entry[0];
      icon.setAttribute('aria-hidden', 'true');
      var count = document.createElement('span');
      count.textContent = formatCount(entry[1]);
      item.append(icon, count);
      engagement.appendChild(item);
    });
    var views = document.createElement('span');
    var viewsIcon = document.createElement('i');
    viewsIcon.className = 'far fa-eye';
    viewsIcon.setAttribute('aria-hidden', 'true');
    views.append(viewsIcon, document.createTextNode(' ' + formatCount(article.viewsCount)));
    foot.append(engagement, views);
    body.append(foot);
    card.appendChild(body);
    return card;
  }

  function createHomeGalleryCard(work) {
    var card = document.createElement('a');
    card.className = 'pin-card home-gallery-card gallery-card';
    card.href = '/site/gallery.html?work=' + encodeURIComponent(work.id);
    card.setAttribute('aria-label', (work.title || 'Работа галереи') + ' — открыть галерею');
    card.style.setProperty('--pin-h', String(180 + (Number(work.id) % 3) * 35) + 'px');

    var media = document.createElement('div');
    media.className = 'pin-media gallery-card-media';
    var cover = work.cover || {};
    var imageUrl = safePublicImageUrl(cover.thumb || cover.url);
    if (imageUrl) {
      var image = document.createElement('img');
      image.src = imageUrl;
      image.alt = work.title || '';
      image.loading = 'lazy';
      image.addEventListener('error', function () {
        image.remove();
        media.classList.add('is-empty');
        var fallback = document.createElement('i');
        fallback.className = 'fas fa-images';
        fallback.setAttribute('aria-hidden', 'true');
        media.appendChild(fallback);
      });
      media.appendChild(image);
    } else {
      media.classList.add('is-empty');
      var icon = document.createElement('i');
      icon.className = 'fas fa-images';
      icon.setAttribute('aria-hidden', 'true');
      media.appendChild(icon);
    }
    card.appendChild(media);

    var caption = document.createElement('div');
    caption.className = 'pin-caption gallery-card-caption';
    var avatar = document.createElement('div');
    avatar.className = 'pin-avatar';
    var authorName = work.author && work.author.display_name || 'Автор';
    avatar.textContent = authorName.trim().charAt(0).toLocaleUpperCase() || 'А';
    var text = document.createElement('div');
    text.className = 'pin-caption-text';
    var titleEl = document.createElement('div');
    titleEl.className = 'gallery-card-title';
    titleEl.textContent = work.title || 'Работа без названия';
    var author = document.createElement('div');
    author.className = 'pin-caption-author gallery-card-author';
    author.textContent = authorName;
    text.append(titleEl, author);
    caption.append(avatar, text);
    card.appendChild(caption);
    return card;
  }

  function initPublicHome() {
    var statsError = document.getElementById('homeStatsError');
    var articlesRoot = document.getElementById('homePopularArticles');
    var galleryRoot = document.getElementById('homeRecentGallery');
    var graphRoot = document.getElementById('homeGraphContainer');
    if (!articlesRoot || !galleryRoot || !graphRoot) return null;

    var controller = new AbortController();
    var mounted = true;
    var graphInstance = null;

    function setError(root, message) {
      root.replaceChildren(makePublicMessage(message));
    }

    async function request(path) {
      var response = await fetch(path, { signal: controller.signal });
      var data = await response.json();
      if (!response.ok) throw new Error(data && data.error || 'Ошибка запроса: ' + response.status);
      return data;
    }

    async function loadStats() {
      try {
        var stats = await request('/api/public/site-summary');
        if (!mounted) return;
        Object.keys(stats).forEach(function (key) {
          var value = document.querySelector('[data-home-stat="' + key + '"]');
          if (value) value.textContent = formatCount(stats[key]);
        });
        if (statsError) statsError.hidden = true;
      } catch (error) {
        if (error.name === 'AbortError' || !mounted) return;
        console.error('Не удалось загрузить статистику главной страницы:', error);
        document.querySelectorAll('[data-home-stat]').forEach(function (value) {
          value.textContent = '—';
        });
        if (statsError) {
          statsError.textContent = 'Не удалось загрузить статистику. Попробуйте обновить страницу.';
          statsError.hidden = false;
        }
      }
    }

    async function loadArticles() {
      try {
        var result = await request('/api/public/articles?surface=home&sort=views&limit=4');
        if (!mounted) return;
        articlesRoot.replaceChildren();
        if (!Array.isArray(result.data) || !result.data.length) {
          setError(articlesRoot, 'Пока нет открытых статей для показа.');
          return;
        }
        var token = window.authManager && window.authManager.getToken();
        var articles = result.data;
        if (token) {
          articles = await Promise.all(result.data.map(async function (article) {
            try {
              var response = await fetch('/api/articles/' + encodeURIComponent(article.slug) + '/likes', {
                headers: { Authorization: 'Bearer ' + token },
                signal: controller.signal
              });
              if (!response.ok) throw new Error('HTTP ' + response.status);
              var likes = await response.json();
              return Object.assign({}, article, { liked: !!likes.liked });
            } catch (error) {
              if (error.name !== 'AbortError') {
                console.warn('Не удалось загрузить состояние лайка статьи:', article.slug, error);
              }
              return Object.assign({}, article, { liked: false });
            }
          }));
        }
        if (!mounted) return;
        articles.forEach(function (article) {
          articlesRoot.appendChild(createHomeArticleCard(article));
        });
      } catch (error) {
        if (error.name === 'AbortError' || !mounted) return;
        console.error('Не удалось загрузить популярные статьи:', error);
        setError(articlesRoot, 'Не удалось загрузить статьи. Попробуйте обновить страницу.');
      }
    }

    async function loadGallery() {
      try {
        var result = await request('/api/public/gallery/works?sort=newest&limit=4');
        if (!mounted) return;
        galleryRoot.replaceChildren();
        if (!Array.isArray(result.data) || !result.data.length) {
          setError(galleryRoot, 'Пока нет доступных работ в галерее.');
          return;
        }
        result.data.forEach(function (work) {
          galleryRoot.appendChild(createHomeGalleryCard(work));
        });
      } catch (error) {
        if (error.name === 'AbortError' || !mounted) return;
        console.error('Не удалось загрузить свежие работы галереи:', error);
        setError(galleryRoot, 'Не удалось загрузить галерею. Попробуйте обновить страницу.');
      }
    }

    var graphKeydownHandler = null;

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    async function loadGraph() {
      try {
        var fullData = await request('/api/public/articles-graph');
        if (!mounted || !graphRoot) return;

        var serverSelect = document.getElementById('graphServerFilter');
        var hideIsolatedEl = document.getElementById('graphHideIsolated');
        var hideLabelsEl = document.getElementById('graphHideLabels');
        var uniformSizeEl = document.getElementById('graphUniformSize');
        var clustersEl = document.getElementById('graphClusters');
        var cosmosEl = document.getElementById('graphCosmos');
        var countEl = document.getElementById('homeGraphCount') || document.getElementById('graphNodeCount');
        var searchInput = document.getElementById('graphSearchInput');
        var searchClearBtn = document.getElementById('graphSearchClear');
        var fullscreenBtn = document.getElementById('graphFullscreenToggle');
        var exportBtn = document.getElementById('graphExportPng');
        var controlsToggleBtn = document.getElementById('graphControlsToggle');
        var focusBar = document.getElementById('graphFocusBar');
        var cardEl = graphRoot.closest('.graph-card-top') || graphRoot.parentElement;

        var COSMOS_STORAGE_KEY = 'alltell.graphCosmos';
        if (cosmosEl) {
          try {
            cosmosEl.checked = localStorage.getItem(COSMOS_STORAGE_KEY) !== '0';
          } catch (_) {}
        }

        if (hideLabelsEl) {
          hideLabelsEl.checked = fullData.nodes.length > 50;
          graphRoot.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
          hideLabelsEl.addEventListener('change', function () {
            graphRoot.classList.toggle('graph-hide-labels', hideLabelsEl.checked);
          });
        }

        if (serverSelect) {
          try {
            var serversResult = await request('/api/public/franchises').catch(function () { return null; });
            var servers = (serversResult && Array.isArray(serversResult.data)) ? serversResult.data : [];
            if (servers.length) {
              serverSelect.innerHTML = '<option value="">Все серверы</option>' +
                servers.map(function (s) {
                  return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>';
                }).join('');
            }
          } catch (_) {}
          serverSelect.addEventListener('change', rerender);
        }

        var focusSlug = null;
        var focusDepth = 1;

        function visibleData() {
          var serverVal = serverSelect ? serverSelect.value : '';
          var nodes = fullData.nodes;
          if (serverVal) {
            nodes = nodes.filter(function (n) { return String(n.server ?? '') === serverVal; });
          }
          var slugSet = new Set(nodes.map(function (n) { return n.slug; }));
          var edges = fullData.edges.filter(function (e) { return slugSet.has(e.from) && slugSet.has(e.to); });

          if (focusSlug && !slugSet.has(focusSlug)) focusSlug = null;
          if (focusSlug) {
            var adjacency = new Map();
            edges.forEach(function (e) {
              if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
              if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
              adjacency.get(e.from).add(e.to);
              adjacency.get(e.to).add(e.from);
            });
            var near = new Set([focusSlug]);
            var frontier = [focusSlug];
            for (var step = 0; step < focusDepth; step++) {
              var next = [];
              frontier.forEach(function (s) {
                var neighbors = adjacency.get(s);
                if (neighbors) {
                  neighbors.forEach(function (t) {
                    if (!near.has(t)) {
                      near.add(t);
                      next.push(t);
                    }
                  });
                }
              });
              frontier = next;
            }
            nodes = nodes.filter(function (n) { return near.has(n.slug); });
            slugSet = near;
            edges = edges.filter(function (e) { return slugSet.has(e.from) && slugSet.has(e.to); });
          }

          if (hideIsolatedEl && hideIsolatedEl.checked) {
            var connected = new Set();
            edges.forEach(function (e) { connected.add(e.from); connected.add(e.to); });
            nodes = nodes.filter(function (n) { return connected.has(n.slug); });
            slugSet = new Set(nodes.map(function (n) { return n.slug; }));
            edges = edges.filter(function (e) { return slugSet.has(e.from) && slugSet.has(e.to); });
          }
          return { nodes: nodes, edges: edges, tagColors: fullData.tagColors };
        }

        function renderFocusBar() {
          if (!focusBar) return;
          focusBar.hidden = !focusSlug;
          if (!focusSlug) {
            focusBar.innerHTML = '';
            return;
          }
          var n = fullData.nodes.find(function (x) { return x.slug === focusSlug; });
          var title = n ? (n.title || n.slug) : focusSlug;
          function depthBtn(d, text) {
            return '<button type="button" class="btn btn-sm ' + (focusDepth === d ? 'btn-primary' : 'btn-secondary') + '" data-depth="' + d + '">' + text + '</button>';
          }
          focusBar.innerHTML =
            '<span class="graph-focus-title"><i class="fas fa-crosshairs"></i> Окрестность статьи «' + escapeHtml(title) + '»</span>' +
            depthBtn(1, '1 шаг') + depthBtn(2, '2 шага') +
            '<button type="button" class="btn btn-sm btn-secondary" data-focus-reset><i class="fas fa-times"></i> Весь граф</button>';

          focusBar.querySelectorAll('[data-depth]').forEach(function (b) {
            b.addEventListener('click', function () {
              setFocus(focusSlug, Number(b.dataset.depth));
            });
          });
          var resetBtn = focusBar.querySelector('[data-focus-reset]');
          if (resetBtn) {
            resetBtn.addEventListener('click', function () {
              setFocus(null);
            });
          }
        }

        function setFocus(slug, depth) {
          focusSlug = slug || null;
          if (depth) focusDepth = depth;
          rerender();
        }

        async function rerender() {
          if (graphInstance) {
            graphInstance.destroy();
            graphInstance = null;
          }
          if (!mounted) return;
          var curData = visibleData();
          var pairs = new Set();
          curData.edges.forEach(function (e) {
            if (e.from !== e.to) {
              pairs.add(e.from < e.to ? e.from + '\u0000' + e.to : e.to + '\u0000' + e.from);
            }
          });
          var mapCount = curData.nodes.filter(function (n) { return n.kind === 'map'; }).length;
          if (countEl) {
            countEl.textContent = 'Статей: ' + (curData.nodes.length - mapCount) + (mapCount ? ' · Карт: ' + mapCount : '') + ' · Связей: ' + pairs.size;
          }
          renderFocusBar();

          graphInstance = await window.GraphView.renderGraph(graphRoot, curData, {
            onNodeClick: function (slug) {
              if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
                window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(slug));
              } else {
                window.location.href = '/antropedia/' + encodeURIComponent(slug);
              }
            },
            onNodeFocus: setFocus,
            centerSlug: focusSlug || undefined,
            colorByTag: true,
            tagColors: fullData.tagColors,
            uniformSize: !!(uniformSizeEl && uniformSizeEl.checked),
            cosmos: cosmosEl ? cosmosEl.checked : true,
            clusters: clustersEl ? clustersEl.checked : true
          });

          if (searchInput && searchInput.value.trim() && graphInstance) {
            graphInstance.setSearchHighlight(searchInput.value);
          }
          if (curData.nodes.length && window.GraphView && typeof window.GraphView.renderGraphLegend === 'function') {
            window.GraphView.renderGraphLegend(graphRoot, curData.nodes, fullData.tagColors);
          }
          if (!mounted && graphInstance) {
            graphInstance.destroy();
            graphInstance = null;
          }
        }

        hideIsolatedEl?.addEventListener('change', rerender);
        clustersEl?.addEventListener('change', rerender);
        uniformSizeEl?.addEventListener('change', function () {
          graphInstance?.setUniformSize(uniformSizeEl.checked);
        });
        cosmosEl?.addEventListener('change', function () {
          try {
            localStorage.setItem(COSMOS_STORAGE_KEY, cosmosEl.checked ? '1' : '0');
          } catch (_) {}
          graphInstance?.setCosmos(cosmosEl.checked);
        });

        if (searchInput) {
          searchInput.addEventListener('input', function () {
            var q = searchInput.value.trim();
            if (searchClearBtn) searchClearBtn.hidden = !q;
            graphInstance?.setSearchHighlight(q);
          });
          searchInput.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var slug = graphInstance?.firstSearchMatch();
            if (!slug) return;
            e.preventDefault();
            setFocus(slug);
          });
        }
        if (searchClearBtn) {
          searchClearBtn.addEventListener('click', function () {
            if (!searchInput) return;
            searchInput.value = '';
            searchClearBtn.hidden = true;
            graphInstance?.setSearchHighlight('');
            searchInput.focus();
          });
        }

        if (exportBtn) {
          exportBtn.addEventListener('click', function () {
            if (window.GraphView && typeof window.GraphView.exportGraphPng === 'function') {
              window.GraphView.exportGraphPng(graphRoot);
            }
          });
        }

        function setGraphFullscreen(on) {
          if (!cardEl) return;
          cardEl.classList.toggle('graph-fullscreen', on);
          cardEl.classList.remove('graph-controls-open');
          if (fullscreenBtn) {
            fullscreenBtn.innerHTML = on
              ? '<i class="fas fa-compress"></i> Свернуть'
              : '<i class="fas fa-expand"></i> Во весь экран';
            fullscreenBtn.title = on ? 'Свернуть граф' : 'Открыть граф на весь экран';
          }
          rerender();
        }

        if (fullscreenBtn) {
          fullscreenBtn.addEventListener('click', function () {
            setGraphFullscreen(!cardEl.classList.contains('graph-fullscreen'));
          });
        }

        if (controlsToggleBtn) {
          controlsToggleBtn.addEventListener('click', function () {
            cardEl.classList.toggle('graph-controls-open');
          });
        }

        graphKeydownHandler = function (e) {
          if (e.key === 'Escape' && cardEl && cardEl.classList.contains('graph-fullscreen')) {
            setGraphFullscreen(false);
          }
        };
        document.addEventListener('keydown', graphKeydownHandler);

        await rerender();
      } catch (error) {
        if (error.name === 'AbortError' || !mounted) return;
        console.error('Не удалось загрузить граф связей:', error);
        graphRoot.replaceChildren(makePublicMessage('Не удалось загрузить граф связей. Попробуйте обновить страницу.', 'graph-empty'));
      }
    }

    var cleanup = function () {
      mounted = false;
      controller.abort();
      if (graphKeydownHandler) {
        document.removeEventListener('keydown', graphKeydownHandler);
        graphKeydownHandler = null;
      }
      var cardEl = graphRoot ? (graphRoot.closest('.graph-card-top') || graphRoot.parentElement) : null;
      if (cardEl && cardEl.classList.contains('graph-fullscreen')) {
        cardEl.classList.remove('graph-fullscreen');
      }
      if (graphInstance) {
        graphInstance.destroy();
        graphInstance = null;
      }
    };
    cleanup.ready = Promise.all([loadStats(), loadArticles(), loadGallery(), loadGraph()]);
    return cleanup;
  }

  function initPageControls() {
    document.querySelectorAll('.chip-row').forEach(function (row) {
      row.addEventListener('click', function (event) {
        var chip = event.target.closest('.filter-chip');
        if (!chip) return;
        row.querySelectorAll('.filter-chip').forEach(function (item) { item.classList.remove('active'); });
        chip.classList.add('active');
      });
    });
  }

  function initMaintenancePage() {
    var button = document.getElementById('maintenanceContinue');
    var adminNotice = document.getElementById('maintenanceAdminNotice');
    var errorMessage = document.getElementById('maintenanceError');
    var page = document.body.dataset.maintenanceTarget;
    if (!button || !adminNotice || !errorMessage || !page) return null;
    var requestId = 0;

    async function updateContinueAvailability() {
      var currentRequest = ++requestId;
      button.hidden = true;
      adminNotice.hidden = true;
      errorMessage.textContent = '';
      var token = window.authManager && window.authManager.getToken();
      if (!token) return;

      try {
        var response = await fetch('/api/profile', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (!response.ok) {
          if (response.status !== 401 && response.status !== 403) {
            throw new Error('Не удалось проверить права доступа');
          }
          return;
        }
        var result = await response.json();
        if (currentRequest !== requestId ||
            !window.authManager ||
            window.authManager.getToken() !== token) return;
        var user = result.user;
        var canContinue = !!(user && (user.is_root || user.admin_level > 0));
        button.hidden = !canContinue;
        adminNotice.hidden = !canContinue;
      } catch (error) {
        if (currentRequest === requestId) {
          console.error('Не удалось проверить права на обход техобслуживания:', error);
        }
      }
    }

    async function continueToPage() {
      var token = window.authManager && window.authManager.getToken();
      if (!token) {
        button.hidden = true;
        adminNotice.hidden = true;
        return;
      }

      button.disabled = true;
      errorMessage.textContent = '';
      try {
        var response = await fetch('/api/maintenance-continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ page: page })
        });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось продолжить');
        if (window.PublicSiteRouter) {
          await window.PublicSiteRouter.navigate(window.location.href, { force: true, history: false });
        } else {
          window.location.reload();
        }
      } catch (error) {
        errorMessage.textContent = error.message || 'Не удалось продолжить';
      } finally {
        button.disabled = false;
      }
    }

    button.addEventListener('click', continueToPage);
    window.addEventListener('authChanged', updateContinueAvailability);
    updateContinueAvailability();
    return function () {
      requestId++;
      button.removeEventListener('click', continueToPage);
      window.removeEventListener('authChanged', updateContinueAvailability);
    };
  }

  function mountPublicPage() {
    cleanupPublicPage();
    var page = document.body.getAttribute('data-page');
    if (page === 'home') currentRouteCleanup = initPublicHome();
    if (page === 'antropedia') currentRouteCleanup = initPublicAntropedia();
    if (page === 'alltell' && window.AllTellClient) currentRouteCleanup = window.AllTellClient.init();
    if (page === 'gallery' && window.SiteGallery) currentRouteCleanup = window.SiteGallery.init();
    if (page === 'maintenance') currentRouteCleanup = initMaintenancePage();
    var articleMatch = page === 'antropedia' && window.location.pathname.match(/^\/antropedia\/([^/]+)\/?$/);
    var articleSlug = null;
    if (articleMatch) {
      try { articleSlug = decodeURIComponent(articleMatch[1]); }
      catch (error) { articleSlug = articleMatch[1]; }
    }
    var readyPromise = Promise.resolve();
    if (page === 'profile' && window.PublicProfile) readyPromise = window.PublicProfile.init();
    if (currentRouteCleanup && currentRouteCleanup.ready) readyPromise = currentRouteCleanup.ready;
    currentMountedPage = page;
    var activePage = document.body.dataset.maintenanceTarget || page;
    if (window.SiteHeader) {
      window.SiteHeader.update({ page: activePage, slug: articleSlug });
    } else {
      updateAdminLinks(articleSlug);
      document.querySelectorAll('.site-nav-link[data-page]').forEach(function (link) {
        link.classList.toggle('active', link.dataset.page === activePage);
      });
    }
    initPageControls();
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
    if (window.SiteHeader) {
      window.SiteHeader.init();
    } else {
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
    }

    window.setTimeout(mountPublicPage, 0);
  });
})();
