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

  function initPublicAntropedia() {
    if (document.body.getAttribute('data-page') !== 'antropedia') return;
    var section = document.querySelector('.site-main .site-section');
    var heroSearch = document.querySelector('.site-hero .site-search');
    if (!section || !heroSearch) return;

    section.replaceChildren();
    document.querySelector('.site-main').hidden = false;
    var listView = document.createElement('div');
    listView.id = 'publicArticleListView';
    var toolbar = document.createElement('div');
    toolbar.className = 'public-article-toolbar';
    var status = makePublicMessage('Загружаем открытые статьи…');
    status.id = 'publicArticleStatus';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'btn btn-ghost btn-sm';
    resetButton.textContent = 'Сбросить фильтр';
    resetButton.hidden = true;
    toolbar.append(status, resetButton);

    var grid = document.createElement('div');
    grid.className = 'article-grid';
    var loadMore = document.createElement('button');
    loadMore.type = 'button';
    loadMore.className = 'btn btn-secondary btn-lg';
    loadMore.textContent = 'Загрузить ещё';
    loadMore.hidden = true;
    var loadMoreWrap = document.createElement('div');
    loadMoreWrap.className = 'load-more-wrap';
    loadMoreWrap.appendChild(loadMore);
    listView.append(toolbar, grid, loadMoreWrap);

    var detail = document.createElement('article');
    detail.className = 'public-article-detail';
    detail.hidden = true;
    section.append(listView, detail);

    var input = heroSearch.querySelector('input');
    input.type = 'search';
    input.id = 'publicArticleSearch';
    input.setAttribute('aria-label', 'Поиск по открытым статьям');
    input.placeholder = 'Искать открытую статью…';
    heroSearch.setAttribute('role', 'search');
    var searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.textContent = 'Найти';
    heroSearch.appendChild(searchButton);

    var params = new URLSearchParams(window.location.search);
    var state = {
      query: params.get('q') || '',
      tag: params.get('tag') || '',
      offset: 0,
      total: 0,
      generation: 0,
      loading: false,
      controller: null,
      slug: null
    };
    input.value = state.query;
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

    function updateSearchUrl() {
      var next = new URL(window.location.href);
      if (state.query) next.searchParams.set('q', state.query);
      else next.searchParams.delete('q');
      if (state.tag) next.searchParams.set('tag', state.tag);
      else next.searchParams.delete('tag');
      window.history.replaceState(window.history.state || {}, '', next.pathname + next.search);
    }

    function createArticleCard(article) {
      var card = document.createElement('div');
      card.className = 'public-wiki-card';
      var link = document.createElement('a');
      link.className = 'wiki-card';
      link.href = '/antropedia/' + encodeURIComponent(article.slug);
      var cover = document.createElement('div');
      cover.className = 'wiki-card-cover';
      var imageUrl = safePublicImageUrl(article.image);
      if (imageUrl) {
        var image = document.createElement('img');
        image.src = imageUrl;
        image.alt = '';
        image.loading = 'lazy';
        cover.appendChild(image);
      } else {
        var icon = document.createElement('i');
        icon.className = 'fas fa-book-open';
        icon.setAttribute('aria-hidden', 'true');
        cover.appendChild(icon);
      }
      link.appendChild(cover);

      var body = document.createElement('div');
      body.className = 'wiki-card-body';
      var title = document.createElement('div');
      title.className = 'wiki-card-title';
      title.textContent = article.title || article.slug;
      body.appendChild(title);
      if (article.excerpt) {
        var excerpt = document.createElement('div');
        excerpt.className = 'wiki-card-excerpt';
        excerpt.textContent = article.excerpt;
        body.appendChild(excerpt);
      }
      link.appendChild(body);
      card.appendChild(link);

      if (Array.isArray(article.tags) && article.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'wiki-card-tags public-wiki-card-tags';
        article.tags.forEach(function (tag) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'wiki-tag';
          button.textContent = tag;
          button.addEventListener('click', function () {
            state.tag = tag;
            state.offset = 0;
            updateSearchUrl();
            loadArticles(false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
          tags.appendChild(button);
        });
        card.appendChild(tags);
      }
      return card;
    }

    function updateStatus() {
      if (state.loading) {
        status.textContent = 'Загружаем открытые статьи…';
      } else if (state.tag) {
        status.textContent = 'Фильтр: ' + state.tag + ' · найдено: ' + state.total;
      } else if (state.query) {
        status.textContent = 'По запросу «' + state.query + '» найдено: ' + state.total;
      } else {
        status.textContent = 'Открытых статей: ' + state.total;
      }
      resetButton.hidden = !state.tag && !state.query;
    }

    async function loadArticles(append) {
      if (append && state.loading) return;
      if (!append && state.controller) state.controller.abort();
      state.loading = true;
      var generation = ++state.generation;
      var controller = new AbortController();
      state.controller = controller;
      updateStatus();
      loadMore.disabled = true;
      var query = new URLSearchParams({
        limit: String(PUBLIC_PAGE_SIZE),
        offset: String(append ? state.offset : 0)
      });
      if (state.query) query.set('q', state.query);
      if (state.tag) query.set('tag', state.tag);

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
        articles.forEach(function (article) {
          grid.appendChild(createArticleCard(article));
        });
        if (!append && articles.length === 0) {
          grid.appendChild(makePublicMessage(
            state.query || state.tag
              ? 'По этим условиям открытых статей не найдено.'
              : 'Публичных статей пока нет.'
          ));
        }
        state.offset = (append ? state.offset : 0) + articles.length;
        state.total = Number(result.total) || 0;
        loadMore.hidden = state.offset >= state.total;
      } catch (error) {
        if (generation !== state.generation) return;
        if (!append) grid.replaceChildren();
        grid.appendChild(makePublicMessage('Не удалось загрузить статьи. Проверьте соединение и попробуйте ещё раз.'));
        loadMore.hidden = true;
      } finally {
        if (generation === state.generation) {
          state.loading = false;
          loadMore.disabled = false;
          updateStatus();
        }
      }
    }

    function applySearch() {
      state.query = input.value.trim();
      state.offset = 0;
      updateSearchUrl();
      loadArticles(false);
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
      var index = new Map([[article.slug, { slug: article.slug, title: article.title || article.slug, tags: article.tags || [] }]]);
      Promise.resolve().then(function () {
        if (typeof window.renderArticleBlocks !== 'function') throw new Error('Block renderer is unavailable');
        return window.renderArticleBlocks(article.content, index);
      }).then(function (html) {
        content.innerHTML = html;
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
      document.title = (article.title || article.slug) + ' — Antropedia';
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

    searchButton.addEventListener('click', applySearch);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applySearch();
      }
    });
    loadMore.addEventListener('click', function () { loadArticles(true); });
    resetButton.addEventListener('click', function () {
      state.query = '';
      state.tag = '';
      input.value = '';
      state.offset = 0;
      updateSearchUrl();
      loadArticles(false);
    });

    if (state.slug) loadDetail();
    else loadArticles(false);
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
