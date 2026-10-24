(function () {
  'use strict';

  var navigationId = 0;
  var activeRequest = null;
  var scriptLoads = new Map();
  var originalTitle = document.title;
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
    if (/\/editor-obsidian\.css(?:\?|$)/.test(link.href)) link.dataset.publicSpaResource = 'true';
  });

  function isPublicPath(pathname) {
    return pathname === '/' ||
      pathname === '/antropedia' ||
      /^\/antropedia\/[^/]+\/?$/.test(pathname) ||
      pathname === '/profile' ||
      /^\/profile\/[^/]+\/?$/.test(pathname) ||
      pathname === '/site/alltell.html' ||
      pathname === '/site/gallery.html';
  }

  function syncHead(parsedDocument) {
    document.title = parsedDocument.title || originalTitle;
    var description = parsedDocument.head.querySelector('meta[name="description"]');
    var currentDescription = document.head.querySelector('meta[name="description"]');
    if (description) {
      if (!currentDescription) {
        currentDescription = document.createElement('meta');
        currentDescription.name = 'description';
        document.head.appendChild(currentDescription);
      }
      currentDescription.content = description.content;
    } else if (currentDescription) currentDescription.remove();
    var canonical = parsedDocument.head.querySelector('link[rel="canonical"]');
    var currentCanonical = document.head.querySelector('link[rel="canonical"]');
    if (canonical && !currentCanonical) {
      currentCanonical = document.createElement('link');
      currentCanonical.rel = 'canonical';
      document.head.appendChild(currentCanonical);
    }
    if (canonical && currentCanonical) currentCanonical.href = canonical.href;
    else if (currentCanonical) currentCanonical.remove();

    ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach(function (name) {
      var selector = 'meta[property="' + name + '"], meta[name="' + name + '"]';
      var source = parsedDocument.head.querySelector(selector);
      var target = document.head.querySelector(selector);
      if (source && !target) {
        target = document.createElement('meta');
        if (source.hasAttribute('property')) target.setAttribute('property', name);
        else target.name = name;
        document.head.appendChild(target);
      }
      if (source && target) target.content = source.content;
      else if (target) target.remove();
    });
  }

  function syncStyles(parsedDocument) {
    var required = new Set(Array.from(parsedDocument.head.querySelectorAll('link[rel="stylesheet"]'), function (link) {
      return new URL(link.href, window.location.href).href;
    }));
    document.head.querySelectorAll('link[rel="stylesheet"][data-public-spa-resource]').forEach(function (link) {
      link.disabled = !required.has(link.href);
    });
    parsedDocument.head.querySelectorAll('link[rel="stylesheet"]').forEach(function (source) {
      var href = new URL(source.href, window.location.href).href;
      var existing = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).find(function (link) {
        return link.href === href;
      });
      if (existing) {
        if (existing.dataset.publicSpaResource) existing.disabled = false;
        return;
      }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.publicSpaResource = 'true';
      document.head.appendChild(link);
    });
  }

  function loadScript(source) {
    var src = new URL(source.src, window.location.href).href;
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    var existing = Array.from(document.scripts).find(function (script) {
      return script.src === src;
    });
    if (existing && (!existing.dataset.publicSpaScript || existing.dataset.publicSpaLoaded === 'true')) return Promise.resolve();
    var loading = new Promise(function (resolve, reject) {
      var script = existing || document.createElement('script');
      if (!existing) {
        script.src = src;
        script.dataset.publicSpaScript = 'true';
      }
      script.onload = function () {
        script.dataset.publicSpaLoaded = 'true';
        resolve();
      };
      script.onerror = function () {
        scriptLoads.delete(src);
        reject(new Error('Не удалось загрузить модуль страницы: ' + src));
      };
      if (!existing) document.body.appendChild(script);
    });
    scriptLoads.set(src, loading);
    return loading;
  }

  async function loadPageScripts(parsedDocument) {
    var scripts = Array.from(parsedDocument.body.querySelectorAll('script[src]'));
    for (var i = 0; i < scripts.length; i++) await loadScript(scripts[i]);
  }

  function replacePageSections(parsedDocument) {
    var currentMain = document.querySelector('.site-main');
    var nextMain = parsedDocument.querySelector('.site-main');
    if (!currentMain || !nextMain) throw new Error('Страница публичного сайта не содержит основной области.');
    var currentHero = document.querySelector('.site-hero');
    var nextHero = parsedDocument.querySelector('.site-hero');
    var currentFooter = document.querySelector('.site-footer');
    var nextFooter = parsedDocument.querySelector('.site-footer');

    if (currentHero && nextHero) currentHero.replaceWith(document.importNode(nextHero, true));
    else if (currentHero) currentHero.remove();
    else if (nextHero) currentMain.before(document.importNode(nextHero, true));
    currentMain.replaceWith(document.importNode(nextMain, true));

    if (currentFooter && nextFooter) currentFooter.replaceWith(document.importNode(nextFooter, true));
    else if (currentFooter) currentFooter.remove();
    else if (nextFooter) document.body.appendChild(document.importNode(nextFooter, true));
    document.body.dataset.page = parsedDocument.body.dataset.page || '';
  }

  async function navigate(target, options) {
    var url = target instanceof URL ? target : new URL(target, window.location.href);
    if (url.origin !== window.location.origin || !isPublicPath(url.pathname)) return false;
    if (url.pathname + url.search === window.location.pathname + window.location.search && url.hash !== '#publicArticleListReturn') {
      if (url.hash) window.location.hash = url.hash;
      return true;
    }

    var id = ++navigationId;
    var previousScrollY = window.scrollY;
    var targetArticle = url.pathname.match(/^\/antropedia\/([^/]+)\/?$/);
    if (targetArticle && window.PublicSite) {
      var slug;
      try { slug = decodeURIComponent(targetArticle[1]); }
      catch (error) { slug = targetArticle[1]; }
      window.PublicSite.saveArticleListPosition(slug, previousScrollY);
    }
    if (activeRequest) activeRequest.abort();
    activeRequest = new AbortController();
    document.body.setAttribute('aria-busy', 'true');

    try {
      var response = await fetch(url.href, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'PublicSiteNavigation' },
        signal: activeRequest.signal
      });
      if (response.status === 503 && response.headers.get('content-type')?.includes('text/html')) {
        window.location.assign(url.href);
        return false;
      }
      var articleNotFound = response.status === 404 && /^\/antropedia\/[^/]+\/?$/.test(url.pathname);
      if (!response.ok && !articleNotFound) throw new Error('HTTP ' + response.status);
      var parsedDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (id !== navigationId) return false;
      if (!parsedDocument.body.dataset.page) throw new Error('Не удалось определить публичную страницу.');

      if (!options || (options.history !== false && options.history !== 'pop')) {
        history.replaceState(Object.assign({}, history.state, { publicSiteScrollY: previousScrollY }), '', window.location.pathname + window.location.search + window.location.hash);
        history.pushState({ publicSiteScrollY: 0 }, '', url.pathname + url.search + url.hash);
      }

      if (window.PublicSite && typeof window.PublicSite.cleanupPage === 'function') window.PublicSite.cleanupPage();
      replacePageSections(parsedDocument);
      syncHead(parsedDocument);
      syncStyles(parsedDocument);
      await loadPageScripts(parsedDocument);
      if (id !== navigationId) return false;
      var ready = window.PublicSite ? window.PublicSite.mountPage() : Promise.resolve();
      await ready;
      if (id !== navigationId) return false;

      if (url.hash && url.hash !== '#publicArticleListReturn') {
        var hashTarget = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (hashTarget) hashTarget.scrollIntoView();
      } else if (options && Number.isFinite(options.scrollY)) {
        window.scrollTo({ top: options.scrollY, left: 0, behavior: 'instant' });
      } else if (url.hash !== '#publicArticleListReturn') {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      }
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return false;
      console.error('Не удалось выполнить переход без перезагрузки:', error);
      if (id === navigationId) window.location.assign(url.href);
      return false;
    } finally {
      if (id === navigationId) {
        document.body.removeAttribute('aria-busy');
        activeRequest = null;
      }
    }
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    var url;
    try { url = new URL(link.href, window.location.href); }
    catch (error) { return; }
    if (url.origin !== window.location.origin || !isPublicPath(url.pathname)) return;
    if (url.pathname + url.search === window.location.pathname + window.location.search && url.hash !== '#publicArticleListReturn') return;
    event.preventDefault();
    navigate(url);
  });

  window.addEventListener('popstate', function (event) {
    var url = new URL(window.location.href);
    navigate(url, { history: 'pop', scrollY: event.state && event.state.publicSiteScrollY });
  });

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.PublicSiteRouter = { navigate: navigate };
})();
